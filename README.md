# Company Finder - AI Mode (Chrome extension)

Automates Google Search to find a company's
official website, a contact email, and a phone number from just its name +
city/country. This is a separate, standalone sibling of the other
`chrome-extension/` tool in this repo, not a replacement for it - see
**How this differs from the other extension** below.

## How it works

This extension searches **in batches**, not one company per search: each
worker claims several pending companies at once (`batchSize`,
configurable per project, default 5) and asks about all of them in a
single Google AI Mode query. On one of the project's tabs (see
**Concurrency** below for running several batches in parallel):

1. Searches Google with a plain `https://www.google.com/search` URL (plus
   `&hl=en&pws=0`) using
   **one carefully structured question listing every company in the
   batch** - not just names. See **The prompt** below for exactly what's
   asked and why it's worded that way.
2. Waits for AI Mode's answer to stream in (longer for a bigger batch -
   up to ~40s), and reads it by finding every `WEBSITE: ... | EMAIL: ... |
   PHONE: ...` block on the page and matching them to companies **by the
   order they appear in**, not by scanning loosely for "any URL/email/
   phone it can find" anywhere. Deliberately NOT anchored to the numbered
   line the prompt asks for, even though it asks for one - see **Batching,
   and why it can't lose data** below for why that specific choice matters.
3. **Any company whose numbered line doesn't parse cleanly is never
   guessed at or silently dropped.** It's flagged internally and
   automatically retried **alone**, next round, with the full one-company
   treatment described below - see **Batching, and why it can't lose
   data** for the details. This is what makes batching safe to turn up:
   it can only ever trade a little per-company reliability for speed, it
   can't cost you a company.
4. For a company claimed **alone** (`batchSize` set to 1, or a straggler
   from step 3), the one-company AI Mode prompt also gets a passive,
   zero-cost Knowledge-Panel-style read on the side (a "Website"
   button/link, a `tel:`/`mailto:` link, or a labeled "Phone:"/"Email:"
   line) - Google sometimes still renders one of these alongside an AI
   Mode answer. If AI Mode comes back with *nothing at all* for that one
   company (website, email, and phone all empty - it either errored with
   "Something went wrong..." or genuinely didn't know), it makes one
   extra attempt: a plain search (no AI Mode) in the same tab, which at
   minimum offers the Knowledge Panel + first organic result a normal
   search would show. This only ever happens once per company.
5. Waits a random delay (configurable, default 8-15s) before the next
   search.

## The prompt

The batch version (`buildBatchPrompt` in `background.js`) lists every
company in the batch and demands one numbered reply line per company:

> I will list 5 companies. For EACH one, in the exact order given, find
> its OFFICIAL website (not a directory, marketplace, or social media
> profile - not LinkedIn, Facebook, Yellow Pages, Crunchbase, IndiaMART,
> Justdial, Glassdoor, Indeed, ZoomInfo, D&B, Yelp, or similar), a genuine
> public contact email address, and a phone number.
>
> Companies:
> 1. "`<company_name>`" - `<city, country>`
> 2. "`<company_name>`" - `<city, country>`
> ... (one line per company)
>
> Reply with exactly 5 lines, one per company, in the SAME order and
> numbering as above, and nothing else - no greeting, no explanation, no
> markdown. Use exactly this format for every line, repeating it for
> every numbered company - do not skip any, and do not merge two
> companies onto one line:
> `<number>. WEBSITE: <url or NONE> | EMAIL: <email or NONE> | PHONE: <phone or NONE>`
>
> If you are not confident a value is correct, write NONE for that field
> instead of guessing.

A company claimed alone (`batchSize` 1, or a retried straggler) gets the
simpler one-company version (`buildPrompt`) instead - the same idea
without the numbering, since there's only one answer to demand:

> Identify the company "`<company_name>`" located at `<city, country>`.
> Find its OFFICIAL website (...same exclusions as above...), a genuine
> public contact email address for it, and a phone number.
>
> Reply with ONLY these three lines, in exactly this format, and nothing
> else - no greeting, no explanation, no markdown:
> `WEBSITE: <url or NONE>` / `EMAIL: <email or NONE>` / `PHONE: <phone or NONE>`
>
> If you are not confident a value is correct, write NONE for that field
> instead of guessing.

Three things about this are deliberate, not incidental:

- **The exact reply format** is what makes `extractAllTriples()`/
  `extractLabeled()` in `content.js` reliable - they don't need to
  understand prose, just find `WEBSITE:`/`EMAIL:`/`PHONE:` and read to the
  end of that line, tolerating markdown emphasis Google sometimes adds
  despite being told not to. Note the batch parser does NOT rely on the
  requested numbering actually surviving into the page text - see
  **Batching, and why it can't lose data** below for why.
- **Naming known directories/marketplaces to exclude** steers the AI away
  from the single most common wrong answer (a LinkedIn or Yellow Pages
  listing instead of the company's own site) *before* it even generates
  a response - `isUsableUrl()` in the code still double-checks this
  independently afterward, so it's enforced twice, not just asked for once.
- **"Write NONE instead of guessing"** matters because a generative model
  asked "what's their email?" will often produce a plausible-looking
  address rather than admit it doesn't know. This is the single biggest
  lever against fabricated contact data - it's explicitly why an
  AI-sourced email is still tagged `emailSource: ai_mode_unverified` (a
  lead to spot-check, not a verified address) rather than trusted outright.

If AI Mode's replies for your data start drifting from this format (Google
changes AI Mode's behavior without notice - this is unofficial, undocumented
territory, same caveat as the other extension's AI Overview step),
`extractAllTriples`/`extractLabeled` in `content.js` are the first place to
adjust, and the prompt templates above are the second.

## Batching, and why it can't lose data

Asking about 5 companies in one search instead of 5 separate searches is
the main efficiency win here: for the same company list, that's 5x fewer
Google requests, which means both a faster run and lower CAPTCHA/block
risk (fewer requests from your one IP is exactly what Google's abuse
detection watches for). The trade-off is that a longer, multi-part answer
is inherently a little less reliable per company than a focused
one-company answer - AI Mode can occasionally skip a company, merge two
together, or drift from the requested format on a long list.

That trade-off is handled, not just accepted, in two ways:

- **Parsing never depends on the requested numbering actually surviving
  into the page.** Google's AI Mode very often renders a numbered reply as
  a real HTML list, and a list's auto-generated item numbers ("1.", "2.",
  ...) are rendering-only - the browser never includes them in the page's
  actual text at all, with or without markdown asked against. An earlier
  version of this extension anchored parsing on that exact leading digit
  and so found nothing for any company the moment Google rendered its
  reply that way (see `CHANGELOG.md`). The fix: match every answer block
  in the page regardless of what precedes it, and line them up with
  companies purely by the order they appear in - it works whether Google
  renders "1.", "-", nothing, or a real list marker in front of each one.
- **A company is only ever marked found/not_found/blocked once something
  has definitively resolved it.** The prompt's own echoed example line
  (see `extractAllTriples` in `content.js`) is recognized and filtered out
  directly, by the literal `<...>` placeholder brackets it still contains -
  not by assuming it always adds exactly one extra match, since a long
  query is often shown collapsed/truncated rather than echoed in full (see
  `CHANGELOG.md`), which means that echo can just as easily contribute zero
  matches as one. If what's left over doesn't come out to exactly one
  answer block per company, positional matching can no longer be trusted,
  since a single skipped or merged company would silently shift every one
  after it out of alignment. Rather than risk attributing company B's data
  to company A, the whole batch is left `pending` and flagged internally
  (`forceSingle`) so every company in it gets retried **solo** next round -
  the exact same one-company AI Mode prompt + plain-search fallback used
  when `batchSize` is 1, which is proven to always reach a definitive
  answer.

In other words: batching can only ever add speed. A batch answer that
comes back garbled or miscounted just costs its companies one extra
round-trip to resolve properly - it never costs you their data, and it
never risks attributing one company's answer to a different one.

## CAPTCHA policy - read this

**If Google shows a CAPTCHA/"unusual traffic" page, this extension pauses
the whole run and brings that tab to the front so you can solve it
yourself. It never attempts to solve, click through, or bypass a CAPTCHA.**

What actually happens:
1. The tab that hit it is brought to the front (worker tabs normally run
   hidden in the background). The popup shows a banner naming which
   company it's stuck on.
2. **Solve it in that tab, same as you would browsing normally.** Nothing
   else runs while you do - other tabs are paused too, since one CAPTCHA
   usually means the risk is up for all of them, not just that one.
3. Once solved, the search that got interrupted picks back up right where
   it left off and the whole run **resumes automatically** - nothing to
   click.
4. If nobody solves it within 10 minutes, it gives up: every company in
   that tab's in-flight batch is marked "blocked" (shows up in
   `needs_review.csv`) and the run stays paused - click **Resume**
   yourself once you're back to continue with the rest.

This applies engine-wide, not per-tab - a CAPTCHA on any one concurrent
tab pauses everything, since it's the same signal (Google has flagged this
session) regardless of which tab hit it.

## How this differs from the other extension

Both live in this repo and can be loaded as separate unpacked extensions
at the same time (they're independent Chrome extensions with their own
storage - no shared state, no conflicts). Use whichever fits a given batch,
or compare results between them:

|                        | `chrome-extension/`                          | `ai-mode-scraper/` (this one)             |
|------------------------|-----------------------------------------------|--------------------------------------------|
| Search style           | Plain search; Knowledge Panel first, optional "Ask anything" follow-up only if needed | Plain search too (see the `udm=50` note below); one structured question per **batch** of companies |
| Companies per search   | Always 1                                       | Configurable (`batchSize`, default 5) |
| Answer parsing         | Scans the whole page for the first URL/email/phone-looking text | Anchors on each company's exact numbered `WEBSITE:`/`EMAIL:`/`PHONE:` line |
| Fallback if AI has nothing | N/A (AI step is optional, off doesn't fail anything) | One retry with a plain search in the same tab (solo companies only) |
| CAPTCHA handling        | Pauses, waits for you to solve it, resumes automatically | Same |

## Concurrency and batching

Two independent settings control throughput, and both trade speed for
block risk in different ways:

- **Concurrent tabs** (1-20): how many batches run in parallel. 4 tabs x 5
  companies per search works through 20 companies per round instead of 5.
  More tabs also means more simultaneous automated traffic from your one IP
  address - exactly the pattern Google's abuse detection is built to catch.
  2-4 is a sensible starting point.

  **Set this above 1 and each worker gets its own separate browser
  window**, opened unfocused and cascaded slightly. That is a requirement,
  not a cosmetic choice: only one tab per window can be the active one, and
  Chrome throttles timers in hidden tabs (severely once a tab has been
  hidden ~5 minutes, which a long run reaches immediately). A throttled tab
  often never finishes receiving Google's answer, so its companies get
  retried for nothing. A tab that is the active tab of its own window
  counts as visible even while that window sits behind others - so leave
  the windows on screen (don't minimise them) while a run works. They close
  themselves when you press Stop.

  Workers are woken 4 seconds apart rather than all at once, so a run
  doesn't open with N simultaneous hits on Google. Concurrency can only be
  changed while the project is stopped.
- **Companies per search** (1-10, i.e. `batchSize`): how many companies
  each individual search asks about at once (see **Batching, and why it
  can't lose data** above). Higher means fewer total searches for the
  same list - both faster and lower block risk, per the same "fewer
  requests from this IP" logic - at the cost of slightly more per-company
  answers needing a one-time solo retry.

There's no "safe" number for either - it's a genuine trade-off, and both
are yours to set per project (new projects default to 1 concurrent tab,
5 companies per search).

## Setup

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**, select this `ai-mode-scraper` folder.
4. Pin the extension icon for easy access.

## Projects

Work is organized into named **projects** - each one is its own CSV-derived
company list with its own results, kept completely separate. You can hold
several at once and switch between them freely.

**Only one project can run at a time.** They all share a single background
engine, so running two automations through it simultaneously would corrupt
which result belongs to which company - starting a second project while
one is already running is rejected with a clear message. Stop the current
one first if you need to switch.

## Usage

1. Click the extension icon, click **+ New**, and give the project a name.
2. Choose a CSV. Columns are matched by meaning, not exact spelling:
   - Your own ID: `native_id`, `id`, `record id`, `reference id`, `customer id`, `lead id`, etc. (optional, but recommended - see below)
   - Company name: `company_name`, `company`, `business name`, `organization`, `firm`, `name`, etc.
   - City: `city` or `town`
   - Country: `country` or `nation`
   - Or a single combined column: `location`, `address`, `region` (e.g. "Mumbai, India" - split automatically)

   If you have your own ID column, it's carried straight through to every
   exported CSV as `native_id`, so you can join results back to your
   original data reliably instead of matching on company name.

   City/country (however they're detected) are strongly recommended - they
   disambiguate companies with generic names and go directly into the
   prompt.

   The Delay min/max, Concurrent tabs, and Companies per search fields
   above the file picker apply to this project only.
3. The new project is created (not started) and selected in the dropdown.
   Pick it (or any other project) from the dropdown at any time to view its
   progress. **Update settings for this project** lets you change delay/
   concurrency/batch size later too, as long as that project isn't
   currently running.
4. Click **Start**. It runs in the background - you can close the popup and
   keep using Chrome normally; reopen the popup any time to check progress.
   The toolbar icon shows a live percentage badge (green while running,
   orange while paused). The popup shows a banner naming which project is
   running/paused, a progress bar, which company it's currently on, and a
   real rate/ETA computed from actual recent completions.
5. If a CAPTCHA shows up, the run pauses itself and brings that tab to the
   front - solve it there and the run picks back up on its own (see
   **CAPTCHA policy** above). If it ever gives up waiting on one, or pauses
   for some other reason, click **Resume**, or export `needs_review.csv`
   and look those up yourself.
6. When done (or whenever you want a snapshot), select the project in the
   dropdown and use the **Download** buttons to get:
   - `found_websites.csv` - native_id, company_name, city, country, website,
     phone, email, emailSource, source (website source: `knowledge_panel`,
     `ai_mode`, or `organic`), certifications, contactName, contactRole
   - `needs_review.csv` - blocked, needs a manual look (may still have
     phone/email captured before the block happened)
   - `not_found.csv` - searched successfully but no usable site found
     (may still have a phone number/email even without a website)

**About the `email` column:** it only ever comes from one of two places -
a `mailto:` link actually present on the page (`emailSource:
knowledge_panel`, reliable), or the AI Mode answer's `EMAIL:` line
(`emailSource: ai_mode_unverified`). The second kind is a **lead, not a
verified address** - treat it as a hint to spot-check, not a confirmed
contact. Your main `email_scraper.py` pipeline, which actually fetches and
parses the company's own site, remains the authoritative source for
verified emails.

**About the `certifications`, `contactName` and `contactRole` columns:**
these are weaker than everything else in the file, and deliberately so.
A website or an email can be corroborated by a Knowledge Panel or an
organic result; a certification list and a named employee cannot - AI Mode
is the only thing that ever produces them, so there is no second source to
agree or disagree. That makes them the most likely fields to be wrong or
invented, and the prompt leans hard on answering NONE rather than guessing
for exactly that reason. **Verify a name before you address anyone by it.**
Note also that a named individual plus their job title is personal data in
a way a company's `info@` address is not - the same B2B use is fine, but it
is a different category of data from the rest of this file, so handle and
retain it accordingly.

If these two fields turn out to hurt more than they help for your queries,
they cost nothing to drop: the parser treats them as optional (see
`extractAllTriples` in `content.js`), so removing them from the prompt
leaves every other field working exactly as before.

## Feeding results back into the main scraper

This extension doesn't call `email_scraper.py` directly. Take
`found_websites.csv`, fill the `website` column of your Python project's
`input.csv` for the matching companies (matched on `native_id` if you
provided one, otherwise `company_name`), then run the scraper on that
project as usual.

## Security

- **Least-privilege permissions.** `host_permissions` is scoped to
  `google.com` only. `tabs` is required to programmatically navigate the
  one background tab it manages; `storage`/`alarms`/`downloads` are
  required for saving progress, scheduling delays reliably, and exporting
  CSVs.
- **No remote code.** Every script is bundled locally and loaded via
  Manifest V3, which forbids executing remotely-hosted code. An explicit
  `content_security_policy` (`script-src 'self'`) is set as well.
- **No data leaves your machine.** The only network activity is your own
  browser navigating to google.com and the native "Save As" download
  dialog. Everything else lives in `chrome.storage.local`.
- **Message-sender verification.** The background script only accepts
  `RESULT`/`GET_CURRENT`/`CAPTCHA_DETECTED`/`RETRY_PLAIN_SEARCH` messages
  from its own content script running on an actual `google.com/search`
  tab, and only accepts project-management messages from the popup.
- **Re-validated results.** Any "website" the content script reports is
  re-checked in the background script (must be a well-formed `http(s)://`
  URL from an allowed source) before it's stored or exported.
- **CSV export is formula-injection safe.** Cell values that start with
  `=`, `+`, `-`, or `@` are neutralized before being written to CSVs.
- **Loaded unpacked, not from the Web Store**, so there's no third-party
  auto-update channel that could silently change its code later.

## Why this no longer requests `udm=50`

This extension originally forced Google's full-page **AI Mode** with
`&udm=50`. That no longer works from an extension, and the failure is
silent and total:

**Chrome now intercepts a `udm=50` navigation and renders it on its own
internal `chrome://contextual-tasks/...` page instead of loading
google.com as a normal web page.** Extensions are forbidden from injecting
into, or reading, any `chrome://` page. So `content.js` never ran, nothing
ever reported back, and the per-batch watchdog eventually wrote every
company off as `not_found` - while a perfectly good answer sat rendered on
screen. Nothing about the parsing was wrong; the parser was never reached.

What's done about it now:

- Searches use a plain `https://www.google.com/search?q=...&hl=en&pws=0`
  URL, which stays scriptable. Google still renders its AI answer panel on
  the normal results page for many queries, and the Knowledge-Panel and
  organic-result reads work there too - which `udm=50` never offered.
- If Chrome hijacks a search onto `chrome://contextual-tasks` anyway, the
  engine detects it, recovers the query from that URL, and **bounces the
  tab back** to a plain search (`watchCommittedUrl` in `background.js`).
- Worker tabs are opened **active**, not hidden. Chrome throttles
  background tabs, and a throttled tab often never finishes streaming
  Google's answer at all. A visible tab is the price of the answer
  arriving. (With `Concurrent tabs` at 1 this is one tab at a time, but it
  does take focus - expect that.)
- The page is read with a shadow-DOM-piercing walker
  (`deepText`/`pageText` in `content.js`), never `document.body.innerText`.
  Google composes parts of the answer inside web components, and text in a
  shadow root is invisible to `innerText` - which alone could return an
  empty string for a page full of visible answers.
- `content.js` is also re-injected via `chrome.scripting` once a tab
  finishes loading, because a declarative `content_scripts` registration
  can miss a client-side (soft) navigation. The script guards against
  running twice.

Credit where due: these are the same conclusions the `google-ai-scraper`
project reached independently, and its source was the reference for this
round of fixes.

## Known limitations

- **Google's AI Mode markup and behavior are undocumented and change over
  time.** Matching relies on the AI's answer following the requested
  format closely enough for label-anchored extraction to work; a Google
  update to how AI Mode renders or behaves could require adjusting the
  prompt templates or `extractAllTriples`/`extractLabeled` in `content.js`.
- **A larger batch size means more per-company retries.** The AI is more
  likely to skip/merge a line the longer the numbered list gets - those
  companies aren't lost (see **Batching, and why it can't lose data**),
  but they do cost one extra solo round-trip each. If a project's data
  seems to need a lot of solo retries, try lowering "Companies per search".
- **Not every query gets a full AI Mode answer** - if a solo company's
  query errors or comes back empty, the one-time plain-search fallback
  (see above) is the safety net, not a guarantee.
- **This queries Google directly and can get itself blocked**, regardless
  of delay settings, at high volume. There is no proxy/IP rotation built
  in on purpose.
- Everything runs and stays in your browser (`chrome.storage.local`) -
  nothing is sent to any third-party server.
