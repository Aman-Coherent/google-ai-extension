# Changelog

## Multiple tabs now actually run concurrently (Concurrent tabs setting)

The engine already had per-worker state, alarms, watchdogs and race-safe
claiming, so `Concurrent tabs` was half-built. Four things stood between
that and it working:

- **`active: true` collided with itself.** Only one tab per window can be
  the active one, so N workers sharing a window left N-1 permanently
  hidden - and Chrome throttles timers in hidden tabs (harshly after ~5
  minutes hidden, which a long run passes immediately), so those tabs never
  finished receiving Google's answer and their companies were retried for
  nothing. **Now:** concurrency > 1 gives each worker **its own unfocused
  window**, making its tab that window's active tab, which counts as
  visible even while the window sits behind others. Windows are cascaded by
  44px rather than stacked, because Chrome treats a *fully* covered window
  as occluded and throttles it like a hidden tab. Concurrency 1 keeps the
  proven single-tab-in-your-window behaviour unchanged.
- **Thundering herd on start.** `START`/`RESUME` woke every worker on the
  same instant - N simultaneous requests from one IP, which is exactly the
  pattern abuse detection watches for, and if it trips it trips for all of
  them at once. **Now:** `wakeAllWorkers()` staggers them by 4s each.
- **Stale claim snapshot.** `processNext()` read the project *before*
  taking the engine lock, so with several workers one could re-claim
  companies another had already finished and saved in the meantime - no
  data corruption, but wasted searches, and the waste grew with the worker
  count. **Now:** the project is re-read inside the locked transaction.
- **No cleanup.** A stopped run left its windows open (8 of them at
  concurrency 8). **Now:** `closeWorkerSurfaces()` closes them on Stop and
  on project delete - and closes **only** what the extension created, which
  is why workers carry an explicit `ownsWindow` flag rather than inferring
  it from a window id. A window you opened yourself is never touched.

**Verified** by running the real `background.js` against stubbed Chrome APIs
with simulated content scripts, 400 companies at batch size 5:

| concurrency | resolved | double-claims | windows | searches |
|---|---|---|---|---|
| 1 | 400/400 | 0 | 0 (your window) | 80 |
| 2 | 400/400 | 0 | 2 | 80 |
| 4 | 400/400 | 0 | 4 | 80 |
| 8 | 400/400 | 0 | 8 | 80 |

Every company resolved exactly once at every level, with no company ever
claimed by two workers - the property that would actually corrupt results.

## Bug fix (regression, self-inflicted): the tree-walker shredded answer lines

**Symptom:** with everything else fixed and the current code confirmed
loaded (`watchdog 270s` in the log), a batch would still come back entirely
`forceSingle` while the page showed five clean answer lines - the run
dropping to one-company-at-a-time again.

**Root cause:** an earlier entry below replaced `document.body.innerText`
with a hand-rolled `deepText()` tree-walker, to cover text composed inside
shadow roots. That swap was a regression, and this is why:

`innerText` is **CSS-aware** - it breaks lines the way the page actually
renders. A hand-rolled walker can only guess from tag names, and `deepText`
broke a line after every block-ish tag including `<div>`. Google composes a
single rendered answer line out of several **nested `<div>`s styled
`display:inline`**, so the walker inserted newlines *inside* an answer line:

    innerText:  WEBSITE: rs-rittel.de | EMAIL: info@rs-rittel.de | PHONE: ...
    walker:     WEBSITE:
                rs-rittel.de
                | EMAIL: info@rs-rittel.de
                ...

`extractAllTriples()` requires all three fields on ONE line, so the walker
matched **nothing at all** on a perfectly good answer, and every company in
the batch was bounced to a solo search. Measured on that exact markup:
innerText parses 5 of 5 lines, the walker parses 0.

The evidence had been there all along and was misread: a manual console
test on the real page reported `raw matches: 7 | kept after filter: 5` -
from `document.body.innerText`. innerText was already working. The shadow
DOM theory came from a `chrome://contextual-tasks` page (which returned an
empty `innerText`), and that page is no longer used at all - so the swap
fixed a problem that had stopped existing, and broke the thing that worked.

**Fix** (`content.js`): `pageText()` reads `innerText` again as the primary
source. `deepText()` survives only as an explicit fallback, applied through
`deepenIfEmpty()` when the normal read yields nothing parseable - and only
adopted if it genuinely finds more. Both paths are covered by tests:
nested-inline-div markup (innerText path) and a shadow-root answer
(fallback path) both extract 5 of 5 with zero solo retries.

## Bug fix: CSV rows with a comma inside a quoted field were silently mangled

**Symptom:** spotted in a live run log - a worker claimed the company
`"Wilkes Kunststoffe GmbH` (note the stray leading quote and the cut-off
name). Affected rows were searched under a broken name, so their results
were poor or absent for reasons nothing to do with searching or parsing.

**Root cause:** `parseCsv()` split every line on every comma with no notion
of quoting, on the stated assumption that company names rarely contain a
comma. German B2B names exported with quoting break that assumption
constantly (`GmbH & Co. KG` and friends). The damage was not a tidy
truncation - splitting inside a quoted field also **shifted every column
after it by one**:

    DE000000031,"Wilkes Kunststoffe GmbH, Co KG",Bergkamen,Germany

    before:  company_name = '"Wilkes Kunststoffe GmbH'
             city         = ' Co KG"'      <- should be Bergkamen
             country      = 'Bergkamen'    <- should be Germany
             prompt: Identify the company ""Wilkes Kunststoffe GmbH"
                     located at  Co KG", Bergkamen.

    after:   prompt: Identify the company "Wilkes Kunststoffe GmbH, Co KG"
                     located at Bergkamen, Germany.

**Fix** (`popup.js`): `parseCsvRows()` implements RFC 4180 quoting -
quoted fields may contain commas, `""` is a literal quote, and the file is
tokenized in a single pass rather than split on newlines first (a quoted
field may contain newlines too, which line-splitting would corrupt before
quoting was ever considered). Verified against quoted commas, escaped
quotes, and a field spanning a newline; columns stay aligned in all cases.

**If you imported a CSV before this fix:** rows whose name/city contained a
quoted comma were searched wrongly, and re-running them won't help because
the *stored* name is already mangled. Those projects need re-importing from
the original CSV to be trustworthy.

## Bug fix: a mid-answer pause was mistaken for "answer finished"

**Symptom:** the first batch of a run would extract all 5 companies fine,
then a later batch would visibly produce its answer on screen and still not
get extracted - the run dropping to one-company-at-a-time again.

**Root cause:** Google does not stream a multi-company answer in one go. It
writes a couple of lines, goes **completely silent** while it researches the
rest, then writes the remainder - and during that pause it does not
necessarily show a "Searching..." indicator either. Measured: ~28 seconds of
total page silence between line 2 and line 3 of a five-company answer.

The wait treated any quiet period as "generation finished", so it accepted a
2-of-5 answer and sent the other 3 companies off for solo searches, seconds
before their answers rendered. Raising the quiet window doesn't fix this -
Google's pause length is unknown and unbounded, so any fixed value is a
guess that loses eventually.

**Fix** (`content.js`): how long silence has to last before an answer counts
as finished now depends on whether an answer is already partly present -
because the two cases mean opposite things.

- **Nothing parseable yet** (`ANSWER_QUIET_MS`, 12s): this query probably
  isn't getting an answer panel at all. Give up on silence quickly rather
  than burning minutes per batch.
- **A partial answer present** (`PARTIAL_QUIET_MS`, 45s): Google is
  mid-answer and more is coming. Keep waiting.
- Either way the wait still returns the *instant* every expected line is
  present, so a fast answer is never delayed, and the hard cap (60s solo,
  60s + 12s per company up to 180s for a batch) still bounds the worst case.

Because those caps are longer, `background.js`'s watchdog was raised in step
to 150s + 30s per company (270s for five) - the invariant that the watchdog
must stay well above content.js's longest wait is verified across batch
sizes 1-10.

**Verified** by reproducing the exact failure: an answer where 2 of 5 lines
land at t+20s, nothing at all happens for 28s, then the remaining 3 land at
t+48s. Before: `settled` at 32s with `triplesFound: 2` → 3 companies sent to
solo. After: `ready` at 48s with `triplesFound: 5` → **0 solo retries**.

## Throughput: a batch answer missing one line no longer costs 5 solo searches

**Symptom:** batches were extracting correctly (`Found: 5`, `Not found: 0`),
but the run then ground along one company at a time at `~32/hr` - an ETA of
63 days for a 47,870-company project.

**Cause:** `runBatch()` treated a batch as all-or-nothing. If the answer
didn't contain *exactly* one parseable line per company, the whole batch was
discarded and every company in it re-queued for its own solo search. The
reasoning was sound as far as it went - once a line is skipped or merged,
position is no longer trustworthy, and matching by position would file one
company's data under another - but the cost is severe: one missing line out
of five throws away four perfectly good answers and buys five slow solo
searches.

**Fix** (`content.js`): position is no longer the only evidence used. A
line whose website or email contains a distinctive chunk of a company's own
name (`igema.com` for "IGEMA GmbH", `kkt-kall.de` for "KKT Kall") is strong
evidence of ownership that doesn't depend on ordering at all. So:

- Exactly one line per company: pair by position, as before.
- Otherwise: pair by name (`pairTriplesByName`), strongest name match
  claimed first, at most one line per company. Legal-form and generic
  industry words ("GmbH", "Technik", "Vertrieb", "Niederlassung", ...) are
  excluded as evidence, since they match nearly every German B2B name.
- A company with no name evidence is still never guessed at - it goes for a
  solo retry exactly as before.

Verified with a batch that was BOTH short a line and deliberately shuffled
out of order: 4 of 5 companies were resolved and each attributed to the
correct company, while the fifth (no name evidence) went solo. Positional
matching would have misfiled all four.

## Bug fix: THE one that mattered - `udm=50` made the page unreadable to extensions, so nothing ever ran

**Symptom:** `Found: 0`, a climbing `Not found` count, and a service-worker
log showing the engine claim a batch and navigate its tab - then *silence*.
No `GET_CURRENT` from the content script, ever, followed by a watchdog
timeout writing off all 5 companies. Meanwhile a clean, correctly formatted
answer was plainly visible on screen.

**Root cause:** **Chrome now intercepts a `&udm=50` ("AI Mode") navigation
and renders it on its own internal `chrome://contextual-tasks/...` page
instead of loading google.com as a normal web page.** Extensions may not
inject into or read any `chrome://` page, so `content.js` was never
executed at all. Every parsing fix in the entries below was therefore
irrelevant to the actual failure - correct code that was never reached.
This was confirmed from the service-worker log (`claimed ... navigating
tab` with no matching `GET_CURRENT`) and from the hijacked URL in the tab's
address bar.

**Fixes** (all cross-checked against the `google-ai-scraper` project, which
had independently hit and solved the same wall):

- **Dropped `udm=50`.** Searches now use a plain
  `https://www.google.com/search?q=...&hl=en&pws=0`, which stays
  scriptable. Google still renders an AI answer panel on the normal results
  page for many queries, and the Knowledge-Panel/organic reads work there
  too - which `udm=50` never offered.
- **Bounce-back guard** (`watchCommittedUrl` in `background.js`): verifies
  the URL that actually *committed* in the worker tab, and if Chrome
  hijacked it to `chrome://contextual-tasks`, recovers the query from that
  URL and navigates the tab back to a plain search.
- **Worker tabs open `active: true`.** Chrome throttles background tabs and
  a throttled tab often never finishes streaming Google's answer, so the
  content script had nothing to read. Previously they were created
  `active: false`. (Trade-off: the tab takes focus while running.)
- **`all_frames: true`** and broader `matches` in the manifest, plus
  re-injection of `content.js` through `chrome.scripting` once a tab
  finishes loading - a declarative registration can miss a client-side
  (soft) navigation. `content.js` now guards against running twice.
- **Shadow-DOM-piercing page reads.** `document.body.innerText` is gone;
  everything goes through `deepText()`/`pageText()`, which walks into open
  shadow roots. Text inside a shadow root is invisible to `innerText`,
  which can return an empty string for a page full of visible answers.
  Verified end-to-end: an answer inside a shadow root that `innerText`
  parses as **0** triples is read as **5/5** with website+email+phone.
  `deepText` breaks lines only at real block boundaries, so a value Google
  renders as an `<a>` link stays on the same line as its `WEBSITE:` label
  (splitting there would defeat `extractAllTriples`).
- **"Still generating" is never mistaken for an answer.** A page showing
  Searching/Thinking/Generating/Loading no longer counts as settled;
  verified that such a page leaves every company pending for retry instead
  of recording not_found.

**If you ran this before the fix:** every `not_found` row is suspect - the
page was likely never even read. Reload the extension and click **Retry
not-found rows** to re-queue all of them.

## Bug fix: gave up waiting before AI Mode had finished answering, then recorded not_found

**Symptom:** a run would go through search after search with `Found: 0` and
a steadily climbing `Not found` count, while the AI Mode tab visibly sat on
its "Searching..." indicator - i.e. companies were being written off as
not_found *before AI Mode had even produced an answer to read*. Observed
live with `Found: 0 / Not found: 5` on a fresh run whose visible tab was
still mid-generation.

**Root cause:** two timeouts, both too short, compounding.

1. `content.js` waited a fixed, optimistic window for the answer to appear -
   30s for a 5-company batch, 18s for a solo company. AI Mode does real
   multi-step web research before it writes anything, which for obscure
   B2B companies routinely takes longer than that. On timeout a batch sent
   every company back for a solo retry; a solo company whose answer hadn't
   rendered looked "completely empty," fell through to the one-shot
   plain-search fallback, and when that turned up no *usable* website
   (directories and social profiles are correctly filtered out) it was
   recorded **not_found** - a final status that is never revisited.
2. `background.js`'s per-batch watchdog (45s + 8s/item, so 77s for five
   companies) sat only ~47s above content.js's own wait. Any page that
   loaded slowly, or any attempt to let content.js wait longer, would trip
   the watchdog first - and the watchdog marks the entire in-flight batch
   `not_found` too. So the "obvious" fix of just waiting longer would have
   silently made things worse rather than better.

**Fix:**
- `content.js` now waits on *evidence* instead of a guess
  (`waitForAnswer`): it returns as soon as every expected answer line is
  present, or as soon as the page text has stopped growing for 6s with
  something parseable already there (generation finished early), or on an
  AI Mode error - and only falls back to a hard cap if none of those
  happen. Caps were raised to 45s solo / 25s + 8s per company (90s max)
  for a batch, so a slow answer is waited out rather than written off,
  while a fast one still finishes in a few seconds.
- `background.js`'s watchdog was raised to 75s + 15s/item (135s for five
  companies), restoring roughly a 2x margin over content.js's longest
  wait. Both constants now carry an explicit comment about the constraint
  between them, since violating it silently converts "still waiting" into
  a permanent `not_found`.
- Added `[CompanyFinder AI]` diagnostic logging (`DEBUG` in `content.js`,
  plus a watchdog warning in `background.js`) reporting how long each
  search waited, why it stopped, how many answer lines were on the page,
  and what it recorded - so a future failure of this kind is readable
  from the worker tab's console instead of having to be inferred.

**If you ran this before the fix:** any row marked `not_found` may well
have been a company AI Mode could have answered fine, given a few more
seconds. Click **Retry not-found rows** in the popup after reloading the
extension to re-queue every one of them.

## Bug fix: batch (and solo) AI Mode answers rejected even though the page showed a clean, correctly formatted answer

**Symptom:** a batch search would render a perfectly clean, correctly
numbered answer on the page - exactly the requested
`WEBSITE: ... | EMAIL: ... | PHONE: ...` format, real domains/emails/phone
numbers, nothing garbled - and every company in it would still get flagged
`forceSingle` and pushed through the slower solo-retry path instead of
being recorded straight away, no matter how many times it ran. Reproduced
with a real 5-company batch answer where the page showed five clean,
fully-populated lines and the extension still treated all five as
unparseable.

**Root cause:** `extractAllTriples()` assumed Google's AI Mode always
echoes the full query text back as a "chat bubble" above its answer,
contributing *exactly one* extra `WEBSITE: <placeholder> | EMAIL:
<placeholder> | PHONE: <placeholder>` match (the prompt's own instructional
example line) - so it required the total match count to be exactly
`items.length + 1` before trusting positional matching, then sliced off
the first match as "the echo." That assumption no longer holds: Google's
AI Mode often shows a long query (any batch prompt, and sometimes even a
solo one) collapsed behind a "show more" toggle instead of echoing it in
full, so the echo just as easily contributes **zero** extra matches as
one. The total was then permanently stuck at `items.length` - one short of
what the code demanded - so `realTriples` was always `null` and every
company in every batch was flagged `forceSingle`, regardless of how clean
the real answer was. This is the same class of bug as the two entries
below (a fragile assumption about exactly how Google renders something it
doesn't document or guarantee), just in a different spot.

**Fix** (`content.js`): stop counting matches and guessing which one is
the echo. Any match is now recognized directly as the prompt's own
instructional template - not a real answer - if its captured value still
contains a literal `<` or `>` placeholder bracket (e.g. `<official website
URL, or NONE if you can't find one>`); a real website/email/phone can never
legitimately contain either character, so this has no false-positive risk.
`extractAllTriples()` filters these out unconditionally, so `runBatch()`
only ever needs to check the simple, real invariant - exactly one leftover
triple per company - regardless of whether Google's echo rendered in full,
partially, or not at all. The same filtering was applied to the solo
path's `extractLabeled()`, replacing the old "wait for each label to
appear twice" heuristic (`labelOccurrences`, now removed) - that heuristic
had the identical blind spot, it just silently degraded to always waiting
the full answer timeout instead of finishing early, rather than losing
data outright the way the batch path did.

**If you ran a batch project before this fix:** as with the two entries
below, no data was silently corrupted (every affected company was still
retried solo via `forceSingle`, just far slower - one search per company
instead of `batchSize` per search), but effective throughput on any batch
size above 1 was no better than `batchSize: 1`. No CSV recovery action is
needed specifically for this bug (nothing was ever mis-recorded), but a
run that looked "stuck" or unusually slow before this fix should behave
normally - and much faster - now.

## Bug fix: website (and occasionally email) rejected even in a clean answer

**Symptom:** a batch answer would render with a perfectly clean, correctly
formatted numbered list - real domains, real emails, real phone numbers,
exactly matching the requested format - and every company would still end
up `not_found`. Unlike the two bugs below, this one didn't depend on how
Google rendered the numbering; it affected the VALUE extraction itself,
for both the batch and solo paths.

**Root cause:** `toWebsite()` and `toEmail()` required the *entire*
captured text between delimiters to already be, in full, a clean URL or
email address - `new URL(...)` had to succeed on the whole string, or the
whole string had to match the email pattern exactly, start to finish. Any
small artifact Google's rendering attaches to a cited value - a footnote/
citation marker glued on with no separating space, an invisible
zero-width formatting character, a trailing parenthetical annotation -
was then enough to fail the *entire* value, even though the real website
or email was sitting right there in the text. `toPhone()`, by contrast,
only checked whether a phone-*like substring* existed **anywhere** in the
captured text, not whether the whole thing was exactly a phone number -
which is exactly why phone numbers kept coming through fine while website
(and sometimes email) quietly failed on the very same lines. Reproduced
and confirmed with several realistic corruption scenarios (a trailing
`[1]`-style citation marker, a trailing parenthetical, a leading
zero-width character) - all of them broke the old `toWebsite`/`toEmail`
while a real value was clearly present.

**Fix** (`content.js`): all three (`toWebsite`, `toEmail`, `toPhone`) now
extract the target pattern as a **substring** out of the captured text,
the same lenient way phone numbers were already being checked, instead of
requiring the whole captured segment to already be exactly that value.
Invisible zero-width/formatting characters are also stripped first.

**If you ran a batch project before this fix:** as with the numbering bug
below, no data was silently corrupted (failed items still went through the
normal `not_found`/`forceSingle` paths), but real website/email data was
being missed. Use **Retry not-found rows** after updating.

## Bug fix: batch AI Mode answers were being missed entirely

**Symptom:** a batch search (several companies in one query) would come
back with a perfectly clean, correctly formatted numbered answer visible
on the page, but every company in it would still end up `not_found` (or
silently re-queued as a solo retry, `Found: 0` even after many batches
had run). Solo searches (`batchSize` 1, or a `forceSingle` retry) were not
affected by this specific bug.

**Root cause:** the batch prompt asks the AI to number its reply
(`1. WEBSITE: ... | EMAIL: ... | PHONE: ...`, `2. ...`, etc.), and the
parser required that literal leading digit to know which company a line
belonged to. But browsers do not include auto-generated list-item numbers
in `document.body.innerText` - if Google's AI Mode renders a numbered
reply as a real HTML ordered list (which it very often does), the visible
"1.", "2." on screen are CSS/browser-generated list markers, not part of
the page's actual text at all. The parser's regex, which required that
digit at the start of each line, then matched nothing for any company -
even a perfectly good, correctly formatted answer - because the digit it
was looking for was never really "there" as far as the DOM's text content
was concerned. Every batch was silently failing 100% of the time, which
also explains unexpectedly slow throughput even with a batch size larger
than 1: every company was quietly being forced through the slower solo
retry path instead.

**Fix** (`content.js`): parsing no longer depends on a leading number at
all. `extractAllTriples()` finds every `WEBSITE: ... | EMAIL: ... |
PHONE: ...` block anywhere in the page and lines them up with companies
purely by the **order they appear in** - it works whether Google renders
"1.", "-", nothing, or a real list marker in front of each one. The one
thing this still has to account for is the prompt's own echoed "chat
bubble" (see the fix below, and it applies here too) - the prompt's
instructions always contain exactly one example of that same
`WEBSITE: ... | EMAIL: ... | PHONE: ...` pattern, so the real per-company
answers are always every match *after* that first, guaranteed one. If the
total count doesn't work out exactly (one echo + exactly one real answer
per company), the whole batch falls back to solo retries rather than
risking a shifted, misattributed match.

**If you ran this extension with `batchSize` above 1 before this fix:**
functionally nothing was lost (every company was already being retried
solo, correctly, via `forceSingle`) but every batch was wasted, effective
throughput was close to `batchSize: 1` regardless of what it was set to.
No CSV recovery action is needed for this one specifically, but see the
next entry - the solo path had its own, separate bug.

## Bug fix: solo AI Mode answers were being misread as empty

**Symptom:** a company would search successfully, AI Mode would render a
perfectly clean answer on the page (`WEBSITE: ...` / `EMAIL: ...` /
`PHONE: ...`), but the extension would record it as `not_found` anyway (or
occasionally save garbage text in the `phone` column). This affected every
**solo** search - i.e. `batchSize` set to 1, or any company retried alone
after a batch answer didn't clearly cover it (`forceSingle`). Batch answers
(more than one company per search) were not affected.

**Root cause:** Google's AI Mode echoes your query back as a "chat bubble"
at the top of the page, and that echoed text is part of
`document.body.innerText` immediately on page load - before AI Mode has
generated anything. The one-company prompt (`buildPrompt` in
`background.js`) literally instructs the format using real labels, e.g.:

```
WEBSITE: <official website URL, or NONE if you can't find one>
EMAIL: <public contact email address, or NONE if you can't find one>
PHONE: <phone number, or NONE if you can't find one>
```

So the echoed query itself already contains one `WEBSITE:`/`EMAIL:`/
`PHONE:` line each - it's quoting our own instructions. Two bugs compounded
on top of that:

1. The "is the answer ready?" wait condition just checked whether the word
   `website:` appeared *anywhere* on the page - true instantly, from the
   echo alone, well before the real answer had streamed in.
2. Extraction used a plain (non-global) regex `.match()`, which returns
   the *first* occurrence in the page - always the echoed placeholder
   text, since it renders above the real answer.

The placeholder text (`<official website URL, or NONE if you can't find
one>`) correctly failed URL/email validation and came back `null` for
those two fields - which is why the practical symptom was "recorded as not
found" rather than a visible crash. `phone`, however, had no real
validation beyond "is it literally the word NONE", so the placeholder text
for that field could get saved outright as a fake "phone number".

**Fix** (`content.js`):
- The wait condition now requires each label to appear **twice** (the echo
  plus the real answer) before considering the answer ready, instead of
  once.
- Extraction now matches globally and takes the **last** occurrence, which
  is always the real answer (it renders after the echo, not before).
- `toPhone()` now requires the value to actually look like a phone number
  (a real run of digits), instead of accepting anything that isn't
  literally the word "NONE".

**If you ran this extension before this fix:** some rows in an existing
project may be marked `not_found` (or have a garbage `phone` value) even
though AI Mode actually knew the answer. Use **Retry not-found rows** in
the popup to re-queue and re-run them with the fix in place.
