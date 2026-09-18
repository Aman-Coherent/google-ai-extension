/**
 * background.js - orchestrates the automated search loop across named
 * "projects" (each project = one company list + its own results, kept
 * fully separate from other projects).
 *
 * This is the AI-answer-focused sibling of the other "Company Website
 * Finder" extension, and it searches in BATCHES, not one company per
 * search: each worker claims up to `project.batchSize` pending companies
 * at once and asks about all of them in a single Google search query -
 * see buildBatchPrompt() below (and buildSearchUrl() on why that query
 * must NOT ask for &udm=50 any more). That's a direct,
 * deliberate trade-off for throughput: batchSize=5 means 5x fewer Google
 * searches for the same list, which means faster completion AND lower
 * CAPTCHA/block risk (fewer requests from this IP), at the cost of a
 * batched answer being slightly less reliable per-company than asking
 * about just one. That reliability gap is closed, not ignored: any
 * company a batch answer doesn't clearly resolve is never silently lost -
 * see "forceSingle" below.
 *
 * SOLO SEARCHES ARE DISABLED. Companies a batch answer doesn't cover used
 * to be pulled out and searched one at a time ("forceSingle"). That was
 * correct but ruinously slow - one missing line in a five-company answer
 * cost five extra searches - so throughput now wins: content.js reloads a
 * completely empty search once, then records whatever is still unresolved
 * as not_found and the run moves on to the next batch. Those rows stay
 * recoverable through the popup's "Retry not-found rows". The forceSingle
 * flag is no longer set, and any left over from an older run is ignored
 * when claiming (see processNext).
 *
 * Only ONE project can be actively running at a time, but a running
 * project can use several concurrent tabs ("workers", configurable per
 * project, 1 to MAX_CONCURRENCY - independent of batchSize: concurrency is
 * how many tabs run in parallel, batchSize is how many companies each tab
 * asks about per search). Running two DIFFERENT projects through the
 * engine at once is still rejected - that's what would actually corrupt
 * which result belongs to which company. Multiple workers on the SAME
 * project's queue is safe because every read-modify-write of the shared
 * engine state goes through mutateEngine(), which serializes them (see
 * "Concurrency safety" below) - two workers finishing at nearly the same
 * instant can't claim the same item or clobber each other's write.
 *
 * Storage layout (chrome.storage.local):
 *   aimProjectIndex        -> { [id]: { name, createdAt, total, counts } }
 *                              lightweight, always small - safe to read on
 *                              every poll for the project list.
 *   aimProject_<id>         -> full project record (including its queue) -
 *                              read/written per-project, not all at once,
 *                              so one large project doesn't make every
 *                              write touch every other project's data too.
 *   aimEngine               -> the single shared run-state: which project
 *                              is active, running/paused, and one entry
 *                              per worker (its tab + claimed item IDs).
 *
 * IMPORTANT / non-negotiable behaviour:
 *   On a CAPTCHA/block page, this PAUSES the whole run and brings that tab
 *   to the front so you can solve it by hand - it never attempts to solve,
 *   click through, or otherwise bypass one itself. See content.js's
 *   isBlockedPage() / waitForCaptchaSolved(). Once solved, the search that
 *   was interrupted continues and the run resumes automatically - no
 *   button to click. If nobody solves it within CAPTCHA_WATCHDOG_MS, the
 *   whole in-flight batch is marked "blocked" for manual review and the
 *   run stays paused (Resume is a manual click at that point). More
 *   concurrent tabs means more simultaneous traffic from one IP, which
 *   raises block risk - that trade-off is the user's to make via the
 *   per-project setting, not silently maximized here.
 */

const PROJECT_INDEX_KEY = "aimProjectIndex";
const PROJECT_KEY_PREFIX = "aimProject_";
const ENGINE_KEY = "aimEngine";

const ALARM_PREFIX = "aim-next-";
// A worker's tab is expected to report a RESULT well within this window -
// see computeWatchdogMs() below, which scales this up for larger batches
// (a 5-company AI Mode answer legitimately takes longer to stream in than
// a 1-company one). If it doesn't report back in time - a page layout the
// content script didn't expect, a crash, a tab that failed to load - this
// fires and frees the worker anyway, so one stuck tab can never freeze the
// whole run. See content.js's run()/runInner() split for the matching
// guard on that side.
const WATCHDOG_PREFIX = "aim-watchdog-";
// These MUST stay comfortably above content.js's longest possible answer
// wait (ANSWER_WAIT_MS / BATCH_ANSWER_* over there) plus page-load time.
// If the watchdog fires first it marks the whole in-flight batch not_found
// even though the content script was still legitimately waiting for AI
// Mode to finish researching - and a not_found is final, so those
// companies are never revisited. From outside that looks exactly like
// "the extension can't extract anything", with correct answers rendering
// on screen right as the tab gets navigated away. content.js caps a
// 5-company batch at 65s and a 10-company one at 90s, so this leaves
// roughly a 2x margin on top of that.
const BASE_WATCHDOG_MS = 150000;
const PER_ITEM_WATCHDOG_MS = 30000;
function computeWatchdogMs(batchLength) {
  return BASE_WATCHDOG_MS + PER_ITEM_WATCHDOG_MS * Math.max(batchLength - 1, 0);
}
// The same watchdog alarm gets re-armed with this much longer leash the
// moment a worker reports a CAPTCHA (see handleCaptchaDetected) - a person
// solving one by hand needs far more than a batch's normal answer window.
// If this fires, nobody came back in time: the whole in-flight batch is
// marked "blocked" for manual review and the run stays paused. See
// handleWatchdogTimeout.
const CAPTCHA_WATCHDOG_MS = 10 * 60 * 1000;
// Extra time granted to a worker that turned out to still be mid-wait when its
// watchdog fired, after being asked to report immediately - see the nudge in
// handleWatchdogTimeout.
const NUDGE_GRACE_MS = 20000;
const COMPLETION_LOG_SIZE = 30;
const MAX_CONCURRENCY = 20;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 10; // higher risks the query getting too long / the AI dropping companies from a longer list
const DEFAULT_BATCH_SIZE = 5;

const ALLOWED_STATUSES = new Set(["found", "not_found", "blocked"]);
const ALLOWED_SOURCES = new Set(["knowledge_panel", "ai_mode", "organic"]);
// "ai_mode_unverified" is deliberately excluded from being an accepted
// value for a *website* source - an AI-Mode-sourced email is treated as a
// lead, but we still only ever trust a website that was actually found on
// the page, never invented.
const ALLOWED_EMAIL_SOURCES = new Set(["knowledge_panel", "ai_mode_unverified"]);

// Caps for the AI-only free-text fields. Generous enough for three
// certifications or a long German job title, short enough that a runaway
// answer cannot bloat every stored item (chrome.storage is shared by every
// project, and a queue can run to thousands of rows).
const MAX_CERTIFICATIONS_LEN = 200;
const MAX_CONTACT_NAME_LEN = 80;
const MAX_CONTACT_ROLE_LEN = 80;

// Message types that must come from our content script running on an
// actual Google search results tab, vs. types that only the popup should
// ever send (it has no sender.tab).
const CONTENT_SCRIPT_TYPES = new Set([
  "GET_CURRENT", "RESULT", "CAPTCHA_DETECTED", "RETRY_PLAIN_SEARCH", "RETRY_SEARCH",
]);
const POPUP_TYPES = new Set([
  "CREATE_PROJECT", "UPDATE_PROJECT_SETTINGS", "RETRY_MISSING_EMAILS", "RETRY_NOT_FOUND", "DELETE_PROJECT",
  "START", "STOP", "RESUME", "GET_STATE", "GET_PROJECT",
]);

const DEFAULT_ENGINE = {
  activeProjectId: null,
  isRunning: false,
  isPaused: false,
  pauseReason: null,
  // tabIds of workers currently sitting on an unsolved CAPTCHA - non-empty
  // implies isPaused. See handleCaptchaDetected/handleResult.
  captchaTabIds: [],
  // [{ tabId, windowId, ownsWindow, currentItemIds, batchToken }, ...] -
  // length === the active project's concurrency. `ownsWindow` records whether
  // THIS extension created that window (concurrency > 1 gives each worker its
  // own window - see ensureWorkerTab). It exists so cleanup can close what we
  // opened without ever closing a window the user opened themselves.
  workers: [],
};

// How long to leave between waking each worker for the first time. Starting
// N workers on the same instant means N simultaneous requests to Google from
// one IP, which is the exact pattern abuse detection looks for - and if it
// trips, it trips for every worker at once.
const WORKER_STAGGER_MS = 4000;


// Set to false to silence these. They print in the extension's SERVICE
// WORKER console (chrome://extensions -> this extension -> "Inspect views:
// service worker"), which is the one place that shows the whole loop
// regardless of which tab is which: what got claimed, which tab was
// navigated where, whether the content script ever called back, what it
// reported, and whether a watchdog gave up. See content.js's own DEBUG for
// the page-side half.
const DEBUG = true;
function debug(...args) {
  if (DEBUG) console.log("[CompanyFinder AI]", ...args);
}

function projectKey(id) {
  return PROJECT_KEY_PREFIX + id;
}

function newProjectId() {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function newBatchToken() {
  return `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampConcurrency(n) {
  const v = Math.round(Number(n) || 1);
  return Math.max(1, Math.min(v, MAX_CONCURRENCY));
}

function clampBatchSize(n) {
  const v = Math.round(Number(n) || DEFAULT_BATCH_SIZE);
  return Math.max(MIN_BATCH_SIZE, Math.min(v, MAX_BATCH_SIZE));
}

function countsOf(queue) {
  const counts = { pending: 0, found: 0, blocked: 0, not_found: 0 };
  for (const c of queue) counts[c.status] = (counts[c.status] || 0) + 1;
  return counts;
}

function makeProject(name, companies, delayMinSec, delayMaxSec, concurrency, batchSize) {
  return {
    id: newProjectId(),
    name: String(name || "Untitled project").trim().slice(0, 120) || "Untitled project",
    createdAt: Date.now(),
    queue: companies.map((c) => ({
      id: String(c.id),
      native_id: c.native_id || "",
      company_name: c.company_name,
      city: c.city || "",
      country: c.country || "",
      status: "pending",
      // Set when a batch answer didn't clearly cover this company - its
      // next claim will be solo instead of joining another batch. See the
      // file-level comment above and processNext().
      forceSingle: false,
      website: null,
      source: null,
      phone: null,
      email: null,
      emailSource: null,
      // Secondary, AI-only fields. Unlike website/email these are never
      // corroborated by a Knowledge Panel or an organic result - AI Mode is
      // the only thing that ever produces them - so they are leads to verify,
      // not facts. They also never affect an item's status: "found" still
      // means "a website was found", exactly as before.
      certifications: null,
      contactName: null,
      contactRole: null,
    })),
    delayMinSec: delayMinSec || 8,
    delayMaxSec: delayMaxSec || 15,
    // How many tabs run this project's queue at once. More = faster, but
    // more simultaneous traffic from one IP = higher block risk - a
    // deliberate per-project trade-off, not maximized by default.
    concurrency: clampConcurrency(concurrency),
    // How many companies get bundled into one AI Mode search. More = fewer
    // total searches (faster, lower block risk) but a longer, harder-for-
    // the-AI-to-fully-comply-with query - see the file-level comment.
    batchSize: clampBatchSize(batchSize),
    completionLog: [],
  };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getProjectIndex() {
  const data = await chrome.storage.local.get(PROJECT_INDEX_KEY);
  return data[PROJECT_INDEX_KEY] || {};
}

async function saveProjectIndex(index) {
  await chrome.storage.local.set({ [PROJECT_INDEX_KEY]: index });
}

async function getProject(id) {
  if (!id) return null;
  const data = await chrome.storage.local.get(projectKey(id));
  return data[projectKey(id)] || null;
}

async function saveProject(project) {
  await chrome.storage.local.set({ [projectKey(project.id)]: project });
}

async function deleteProjectStorage(id) {
  await chrome.storage.local.remove(projectKey(id));
}

async function updateIndexCounts(project) {
  const index = await getProjectIndex();
  if (!index[project.id]) return;
  index[project.id] = { ...index[project.id], total: project.queue.length, counts: countsOf(project.queue) };
  await saveProjectIndex(index);
}

// ---------------------------------------------------------------------------
// Concurrency safety: every read-modify-write of the shared engine state
// goes through mutateEngine(), which chains onto a single promise so the
// (read -> compute -> write) sequence for one call can never interleave
// with another. Without this, two workers finishing at nearly the same
// moment could both read the same stale `workers` array, each compute a
// change based on it, and the second write would silently erase the
// first's update (a classic lost-update race) - e.g. two tabs claiming
// the same "pending" item, or one worker's completion vanishing because
// another worker's write clobbered it a moment later.
// ---------------------------------------------------------------------------

let engineLock = Promise.resolve();

function withEngineLock(fn) {
  const result = engineLock.then(fn, fn);
  // Keep the chain alive even if this step throws, so one failure doesn't
  // permanently wedge every future engine update behind a rejected promise.
  engineLock = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function getEngine() {
  const data = await chrome.storage.local.get(ENGINE_KEY);
  return { ...DEFAULT_ENGINE, ...(data[ENGINE_KEY] || {}) };
}

// updater(engine) returns a partial patch to shallow-merge onto the
// freshly-read engine, or a Promise of one. Runs inside the lock.
function mutateEngine(updater) {
  return withEngineLock(async () => {
    const engine = await getEngine();
    const patch = (await updater(engine)) || {};
    const next = { ...engine, ...patch };
    await chrome.storage.local.set({ [ENGINE_KEY]: next });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function randomDelayMs(project) {
  const min = project.delayMinSec * 1000;
  const max = Math.max(project.delayMaxSec * 1000, min + 1000);
  return min + Math.random() * (max - min);
}

// The one-company prompt, used whenever a "batch" is really just one item -
// either because project.batchSize is 1, or because this item was flagged
// forceSingle after a batch answer didn't clearly cover it. Demanding a
// strict machine-parseable reply and telling it to answer NONE instead of
// guessing both matter here: without the strict format, content.js can't
// reliably extract anything; without "say NONE", a generative answer will
// happily invent a plausible-looking but wrong contact rather than admit
// it doesn't know.
function buildPrompt(item) {
  const address = [item.city, item.country].filter(Boolean).join(", ");
  const who = address ? `"${item.company_name}" located at ${address}` : `"${item.company_name}"`;
  return (
    `Identify the company ${who}. Find its OFFICIAL website (not a directory, ` +
    `marketplace, or social media profile - not LinkedIn, Facebook, Yellow Pages, ` +
    `Crunchbase, IndiaMART, Justdial, Glassdoor, Indeed, ZoomInfo, D&B, Yelp, or ` +
    `similar), a genuine public contact email address for it, a phone number, the ` +
    `certifications it publicly states it holds, and ONE named senior contact ` +
    `person at that company.\n\n` +
    `Reply with ONLY these five lines, in exactly this format, and nothing else - ` +
    `no greeting, no explanation, no markdown:\n` +
    `WEBSITE: <official website URL, or NONE if you can't find one>\n` +
    `EMAIL: <public contact email address, or NONE if you can't find one>\n` +
    `PHONE: <phone number, or NONE if you can't find one>\n` +
    `CERTIFICATIONS: <up to 3 formal certifications or standards the company ` +
    `states it holds, semicolon-separated, e.g. ISO 9001; ISO 14001; IATF 16949 - ` +
    `not awards, memberships or partner badges - or NONE>\n` +
    `CONTACT: <one named person publicly listed for THIS company, written as ` +
    `Full Name (Job Title) - prefer owner, managing director or head of sales - ` +
    `or NONE>\n\n` +
    `Never write the "|" character inside a value. If you are not confident a ` +
    `value is correct, write NONE for that field instead of guessing - never ` +
    `invent a person, a job title, or a certification.`
  );
}

// The batch prompt: the same question asked about several companies at
// once, with a strict numbered reply format. Numbering is requested for
// the model's own benefit (helps it keep each answer matched to the right
// company) but content.js does NOT rely on parsing that number back out -
// Google's AI Mode often renders a numbered reply as a real HTML list,
// and list-marker numbers are never part of the page's actual text (see
// extractAllTriples in content.js) - it instead matches every answer
// triple in the page and lines them up with companies purely by the order
// they appear in. The instructional part stays fixed-size regardless of
// batch length (one example line, not one per company) so the whole query
// scales linearly with just the company list itself, not the instructions
// around it.
function buildBatchPrompt(items) {
  const listLines = items
    .map((it, i) => {
      const address = [it.city, it.country].filter(Boolean).join(", ");
      return `${i + 1}. "${it.company_name}"${address ? ` - ${address}` : ""}`;
    })
    .join("\n");
  return (
    `I will list ${items.length} companies. For EACH one, in the exact order given, ` +
    `find its OFFICIAL website (not a directory, marketplace, or social media ` +
    `profile - not LinkedIn, Facebook, Yellow Pages, Crunchbase, IndiaMART, ` +
    `Justdial, Glassdoor, Indeed, ZoomInfo, D&B, Yelp, or similar), a genuine ` +
    `public contact email address, a phone number, its published certifications, ` +
    `and ONE named senior contact person.\n\n` +
    `Companies:\n${listLines}\n\n` +
    `Reply with exactly ${items.length} lines, one per company, in the SAME order ` +
    `and numbering as above, and nothing else - no greeting, no explanation, no ` +
    `markdown. Use exactly this format for every line, repeating all five fields ` +
    `for every numbered company - do not skip any field, do not omit any company, ` +
    `and do not merge two companies onto one line:\n` +
    `<number>. WEBSITE: <official website URL, or NONE> | ` +
    `EMAIL: <public contact email address, or NONE> | ` +
    `PHONE: <phone number, or NONE> | ` +
    `CERTIFICATIONS: <up to 3 certifications the company states it holds, ` +
    `semicolon-separated, e.g. ISO 9001; IATF 16949 - not awards or memberships - ` +
    `or NONE> | ` +
    `CONTACT: <one named person at this company as Full Name (Job Title), or NONE>\n\n` +
    `Never write the "|" character inside a value - use a semicolon to separate ` +
    `certifications. If you are not confident a value is correct, write NONE for ` +
    `that field instead of guessing - never invent a person, a job title, or a ` +
    `certification.`
  );
}

// IMPORTANT (Chrome 2025+): `&udm=50` ("AI Mode") must NOT be used here any
// more. Chrome now intercepts a udm=50 navigation and renders it on its own
// internal `chrome://contextual-tasks/...` page instead of loading google.com
// as a normal web page - and extensions are forbidden from injecting into or
// reading any chrome:// page. The symptom is brutal and silent: the engine
// navigates the tab, no content script ever runs, nothing reports back, the
// watchdog eventually fires, and every company in the batch is written off as
// not_found while a perfectly good answer sits rendered on screen.
//
// Staying on a plain https://www.google.com/search URL keeps the page
// scriptable. Google still renders its AI answer panel ("AI Overview") on the
// normal results page for many queries, and the passive Knowledge-Panel and
// organic-result reads in content.js work there too - which udm=50 never
// offered at all.
//   &hl=en  - keep the answer's language (and so its labels) predictable
//   &pws=0  - no personalized results, so what's scraped doesn't depend on
//             this browser profile's search history
function buildSearchUrl(items) {
  const prompt = items.length === 1 ? buildPrompt(items[0]) : buildBatchPrompt(items);
  return `https://www.google.com/search?q=${encodeURIComponent(prompt)}&hl=en&pws=0`;
}

function isContextualTasksUrl(url) {
  return /^chrome:\/\/contextual-tasks\b/i.test(url || "");
}

// If Chrome hijacked a search into its native AI Mode surface anyway, the
// query is still sitting in that URL's `q` param - rebuild the equivalent
// plain https search so the tab can be bounced back onto a page that can
// actually be read. Returns null if there's no query to recover.
function httpsSearchFromContextualTasks(url) {
  try {
    const raw = url || "";
    const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    const q = new URLSearchParams(qs).get("q") || "";
    return q ? `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&pws=0` : null;
  } catch {
    return null;
  }
}

function isGoogleSearchTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    const u = new URL(tab.url);
    return u.origin === "https://www.google.com" && u.pathname === "/search";
  } catch {
    return false;
  }
}

function isSafeHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function sanitizePhone(phone) {
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim().slice(0, 40); // cap length - defensive, not a real phone validator
  return trimmed || null;
}

// Free text straight out of a third-party-rendered page, so it gets capped
// and stripped rather than trusted: "|" would corrupt the batch format if it
// ever round-tripped, and control characters have no business in a CSV cell.
// (Formula-injection in the export is handled separately by sanitizeCsvCell
// in popup.js.) Deliberately NOT validated against a list of known
// certifications - a whitelist would silently drop legitimate industry-
// specific ones, and these values are presented as unverified anyway.
function sanitizeFreeText(value, maxLen) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\|/g, ";")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function sanitizeEmail(email, emailSource) {
  if (typeof email !== "string" || !ALLOWED_EMAIL_SOURCES.has(emailSource)) return { email: null, emailSource: null };
  const trimmed = email.trim().slice(0, 254).toLowerCase();
  return EMAIL_RE.test(trimmed) ? { email: trimmed, emailSource } : { email: null, emailSource: null };
}

// Re-validate whatever the content script reported before trusting it - a
// different trust boundary than content.js, which runs inside a live,
// third-party-rendered Google page. Returns null for a forceSingle entry
// (nothing to sanitize - it isn't a final status yet) or a malformed one.
function sanitizeResultEntry(entry) {
  if (!entry || typeof entry.itemId !== "string") return null;
  if (entry.forceSingle) return { itemId: entry.itemId, forceSingle: true };
  if (!ALLOWED_STATUSES.has(entry.status)) return null;
  const phone = sanitizePhone(entry.phone);
  const { email, emailSource } = sanitizeEmail(entry.email, entry.emailSource);
  const certifications = sanitizeFreeText(entry.certifications, MAX_CERTIFICATIONS_LEN);
  const contactName = sanitizeFreeText(entry.contactName, MAX_CONTACT_NAME_LEN);
  // A role with no name attached is meaningless on its own ("Managing
  // Director" of whom?) and would read in the export as if a person had been
  // identified when none was, so it is dropped. A name with no role is still
  // useful and is kept.
  const contactRole = contactName ? sanitizeFreeText(entry.contactRole, MAX_CONTACT_ROLE_LEN) : null;
  const extras = { certifications, contactName, contactRole };
  if (entry.status !== "found") {
    return { itemId: entry.itemId, status: entry.status, phone, email, emailSource, ...extras };
  }
  if (typeof entry.website !== "string" || !isSafeHttpUrl(entry.website)) return null;
  if (!ALLOWED_SOURCES.has(entry.source)) return null;
  return { itemId: entry.itemId, status: "found", website: entry.website, source: entry.source, phone, email, emailSource, ...extras };
}

// A raw pending count gets silently truncated by Chrome's small badge area
// and isn't very informative anyway. A percentage always fits, and color
// makes "is this actually running" visible without opening the popup.
function updateBadge(engine, project) {
  const total = project ? project.queue.length : 0;
  if (!total || (!engine.isRunning && !engine.isPaused)) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const done = total - project.queue.filter((c) => c.status === "pending").length;
  chrome.action.setBadgeText({ text: `${Math.round((done / total) * 100)}%` });
  chrome.action.setBadgeBackgroundColor({ color: engine.isPaused ? "#f9a825" : "#0a8043" });
}

// Builds the pause banner text shown while one or more tabs are sitting on
// an unsolved CAPTCHA. `engine` supplies the tabId -> worker -> items
// lookup; `project` is always the single currently-active project. A
// captcha'd tab may have several companies in flight (a whole batch), all
// named here.
function buildCaptchaPauseReason(captchaTabIds, engine, project) {
  const names = captchaTabIds.flatMap((tabId) => {
    const worker = engine.workers.find((w) => w.tabId === tabId);
    if (!worker) return [];
    return (worker.currentItemIds || [])
      .map((id) => project.queue.find((c) => c.id === id))
      .filter(Boolean)
      .map((item) => item.company_name);
  });
  const who = names.length ? names.join(", ") : "a company";
  return (
    `CAPTCHA showing for: ${who}. Solve it in the highlighted tab - the run ` +
    `continues automatically once solved. Nothing else runs while this is up.`
  );
}

function alarmNameForWorker(idx) {
  return `${ALARM_PREFIX}${idx}`;
}

function watchdogNameForWorker(idx) {
  return `${WATCHDOG_PREFIX}${idx}`;
}

function scheduleNext(workerIndex, delayMs) {
  chrome.alarms.create(alarmNameForWorker(workerIndex), { delayInMinutes: Math.max(delayMs / 60000, 0.01) });
}

function armWatchdog(workerIndex, ms) {
  // Creating an alarm with a name that already exists replaces it - this is
  // how handleCaptchaDetected extends an in-flight worker's normal
  // batch-scaled watchdog into the much longer CAPTCHA_WATCHDOG_MS leash
  // (and how a plain-search fallback pass gets a fresh window of its own).
  chrome.alarms.create(watchdogNameForWorker(workerIndex), { delayInMinutes: ms / 60000 });
}

function disarmWatchdog(workerIndex) {
  chrome.alarms.clear(watchdogNameForWorker(workerIndex));
}

function clearAllWorkerAlarms(count) {
  for (let i = 0; i < count; i++) {
    chrome.alarms.clear(alarmNameForWorker(i));
    disarmWatchdog(i);
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

// Ensures worker[workerIndex] has a live tab, creating one if needed. Runs
// the "is the existing tab still alive" check and the "create a new one"
// fallback inside the SAME locked transaction as the write, so two workers
// can't both decide their (identical, stale) tabId is dead and each spin
// up a redundant tab in a race.
async function ensureWorkerTab(workerIndex) {
  const engine = await mutateEngine(async (engine) => {
    const worker = engine.workers[workerIndex];
    if (worker && worker.tabId) {
      try {
        await chrome.tabs.get(worker.tabId);
        return {}; // still alive, nothing to change
      } catch {
        // fall through - tab was closed, need a new one
      }
    }
    const workers = engine.workers.slice();

    // Plain background tabs in whatever window is already open: never
    // activated, never focused, so a run doesn't fight you for the foreground
    // and keeps working with the window minimised or while you're in another
    // app.
    //
    // Chrome does throttle TIMERS in hidden tabs (to ~1/s, then ~1/min once a
    // tab has been hidden a few minutes), which is why content.js's answer
    // wait is driven by a MutationObserver rather than a polling loop - DOM
    // mutations are delivered to hidden tabs normally. REPORT_NOW in
    // handleWatchdogTimeout covers the remaining case of a tab whose timers
    // stalled before it ended its own wait.
    const tab = await chrome.tabs.create({ active: false, url: "about:blank" });
    workers[workerIndex] = {
      ...workers[workerIndex],
      tabId: tab.id,
      windowId: tab.windowId,
      ownsWindow: false, // that window is the user's - cleanup closes the tab only
    };
    return { workers };
  });
  return engine.workers[workerIndex].tabId;
}

// Closes only what this extension opened: a worker's own window if we created
// it, otherwise just its tab. Never closes a window the user opened - hence
// the ownsWindow flag rather than inferring it from windowId.
async function closeWorkerSurfaces(workers) {
  for (const w of workers || []) {
    if (w.ownsWindow && w.windowId != null) {
      try {
        await chrome.windows.remove(w.windowId);
        continue;
      } catch {
        // Already gone - fall through and try the tab directly.
      }
    }
    if (w.tabId != null) {
      try {
        await chrome.tabs.remove(w.tabId);
      } catch {
        // Already closed - nothing to do.
      }
    }
  }
}

// Wakes every worker, spaced out by WORKER_STAGGER_MS. Used by START and
// RESUME (and after the last CAPTCHA clears), all of which otherwise fire N
// simultaneous searches.
function wakeAllWorkers(count) {
  for (let i = 0; i < count; i++) {
    if (i === 0) processNext(0);
    else setTimeout(() => processNext(i), i * WORKER_STAGGER_MS);
  }
}

// Verifies that the URL which actually COMMITTED in a worker's tab is a
// readable https google.com/search page, and repairs it if it isn't.
//
// Two things make this necessary rather than paranoid:
//   1. Chrome can intercept an AI-Mode-ish search and render it on its own
//      chrome://contextual-tasks surface, where no content script may run.
//      The query survives in that URL, so the tab gets bounced straight back
//      onto a plain https search instead of the batch silently dying.
//   2. A declarative content_scripts registration can miss a page that
//      arrives via a client-side (soft) navigation, so content.js is
//      re-injected once the tab finishes loading. Injecting twice is
//      harmless - content.js's own guard makes the second run a no-op.
function watchCommittedUrl(workerIndex, tabId) {
  let bounced = false;
  const check = async () => {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return true; // tab is gone - stop checking
    }
    const url = tab.url || tab.pendingUrl || "";
    if (isContextualTasksUrl(url) && !bounced) {
      const httpsUrl = httpsSearchFromContextualTasks(url);
      console.warn(
        `[CompanyFinder AI] worker ${workerIndex}: Chrome hijacked this search onto ${url.slice(0, 60)}... ` +
          `(its native AI Mode page, which extensions cannot read)` +
          (httpsUrl ? " - bouncing the tab back to a plain google.com search" : " - and the query isn't recoverable from it")
      );
      if (httpsUrl) {
        bounced = true;
        // No `active: true` here: with several workers running, each already
        // owns its window and is the active tab in it, so forcing activation
        // only starts a focus fight between workers.
        await chrome.tabs.update(tabId, { url: httpsUrl });
      }
      return false;
    }
    if (!/^https:\/\/([^/]*\.)?google\.[^/]+\/search/i.test(url)) return false; // still loading - look again
    debug(`worker ${workerIndex}: tab ${tabId} is on a readable page (${tab.status})`);
    // Re-inject in case the declarative registration missed this navigation.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch {
      // Already injected, or the page went away mid-injection - either is fine.
    }
    return true;
  };
  let attempts = 0;
  const tick = async () => {
    attempts++;
    if (await check()) return;
    if (attempts < 12) setTimeout(tick, 1500);
  };
  setTimeout(tick, 2500);
}

async function processNext(workerIndex) {
  const snapshot = await getEngine();
  if (!snapshot.isRunning || snapshot.isPaused || !snapshot.activeProjectId) return;
  if (!snapshot.workers[workerIndex] || (snapshot.workers[workerIndex].currentItemIds || []).length) return;

  const project = await getProject(snapshot.activeProjectId);
  if (!project) {
    await mutateEngine(() => ({ isRunning: false, isPaused: false, activeProjectId: null, workers: [] }));
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  // Claim the next batch of unclaimed pending items for this worker
  // atomically - the check-for-available-items and the claim happen inside
  // one locked transaction, so two workers racing here can never claim the
  // same item.
  let claimed = null;
  const engineAfterClaim = await mutateEngine(async (engine) => {
    if (!engine.isRunning || engine.isPaused) return {}; // stopped/paused since we last checked
    const worker = engine.workers[workerIndex];
    if (!worker || (worker.currentItemIds || []).length) return {}; // already claimed by a previous call
    // Re-read the project INSIDE the lock rather than reusing the snapshot
    // taken above. With several workers running, another one can finish a
    // batch and save its results in between - and against the stale snapshot
    // those companies still look "pending", so this worker would re-claim
    // and re-search work that is already done. Harmless to the data, pure
    // waste of the run's throughput, and it grows with the worker count.
    const fresh = (await getProject(engine.activeProjectId)) || project;
    const inFlightIds = new Set(engine.workers.flatMap((w) => w.currentItemIds || []));
    const pending = fresh.queue.filter((c) => c.status === "pending" && !inFlightIds.has(c.id));
    if (!pending.length) return {};
    // Solo retries are disabled: everything is claimed in normal batches of
    // project.batchSize. A company a batch answer doesn't cover is recorded
    // not_found by content.js after one reload of that search, rather than
    // being pulled out for a one-at-a-time search - that path was correct but
    // ruinously slow, and throughput is the priority here. Any leftover
    // forceSingle flag from an older run is simply ignored (it is also no
    // longer ever set), so such companies just join the next batch.
    claimed = pending.slice(0, project.batchSize || DEFAULT_BATCH_SIZE);
    const workers = engine.workers.slice();
    workers[workerIndex] = {
      ...workers[workerIndex],
      currentItemIds: claimed.map((c) => c.id),
      batchToken: newBatchToken(),
      nudged: false, // one REPORT_NOW nudge is allowed per batch
    };
    return { workers };
  });

  if (!claimed) {
    // Nothing left for this worker right now. If no worker anywhere has
    // anything in flight either, the whole run is done.
    const anyInFlight = (engineAfterClaim.workers || []).some((w) => (w.currentItemIds || []).length);
    if (!anyInFlight) {
      const finished = await mutateEngine(() => ({ isRunning: false }));
      updateBadge(finished, project);
    }
    return;
  }

  const concurrency = clampConcurrency(project.concurrency || 1);
  armWatchdog(workerIndex, computeWatchdogMs(claimed.length));
  const tabId = await ensureWorkerTab(workerIndex);
  const url = buildSearchUrl(claimed);
  debug(
    `worker ${workerIndex}: claimed ${claimed.length} company(ies), navigating tab ${tabId} ` +
      `(watchdog ${Math.round(computeWatchdogMs(claimed.length) / 1000)}s)`,
    claimed.map((c) => c.company_name)
  );
  // Deliberately no `active: true`: worker tabs stay in the background so the
  // run never steals focus and keeps working while the window is minimised.
  chrome.tabs.update(tabId, { url });
  watchCommittedUrl(workerIndex, tabId);
}

// Fires (after computeWatchdogMs(), or CAPTCHA_WATCHDOG_MS for a worker
// that's been sitting on a CAPTCHA - see handleCaptchaDetected) if a
// worker never reported a RESULT for its claimed batch in the meantime,
// and frees the worker so the run keeps moving instead of hanging on it
// forever. A plain stuck tab (bad layout, crash, page never loaded) marks
// every still-pending item in that batch not_found, same as always. A
// CAPTCHA nobody solved in time marks them blocked instead - they
// genuinely do need a manual look - and leaves the run paused rather than
// quietly continuing, since giving up is not the same as solving it.
async function handleWatchdogTimeout(workerIndex) {
  const engine = await getEngine();
  const worker = engine.workers[workerIndex];
  const stuckItemIds = (worker && worker.currentItemIds) || [];
  if (!stuckItemIds.length || !engine.activeProjectId) return; // already resolved normally - nothing to do

  // Last chance before writing this batch off. Worker tabs run hidden, and
  // Chrome throttles a hidden tab's timers hard (roughly once a minute once
  // it's been hidden a few minutes). A tab in that state can be sitting on a
  // complete, perfectly readable answer and simply not have gotten around to
  // ending its own wait. Message delivery is NOT throttled, so asking it
  // directly works where its own timers don't - and a real answer here beats
  // marking five companies not_found, which is final.
  //
  // One attempt per batch (nudged flag), and never for a CAPTCHA stall: that
  // needs a person, not a nudge.
  const isCaptchaStall = worker.tabId != null && engine.captchaTabIds.includes(worker.tabId);
  if (!isCaptchaStall && !worker.nudged && worker.tabId != null) {
    const stuckToken = worker.batchToken;
    let stillWaiting = false;
    try {
      const reply = await chrome.tabs.sendMessage(worker.tabId, { type: "REPORT_NOW" });
      stillWaiting = !!(reply && reply.waiting);
    } catch {
      stillWaiting = false; // nothing listening - the tab really is stuck
    }
    await mutateEngine((e) => {
      const workers = e.workers.slice();
      if (workers[workerIndex] && workers[workerIndex].batchToken === stuckToken) {
        workers[workerIndex] = { ...workers[workerIndex], nudged: true };
      }
      return { workers };
    });
    if (stillWaiting) {
      console.warn(
        `[CompanyFinder AI] worker ${workerIndex}: watchdog reached but the tab was still waiting ` +
          `(throttled hidden tab) - told it to report now, allowing ${Math.round(NUDGE_GRACE_MS / 1000)}s more`
      );
      armWatchdog(workerIndex, NUDGE_GRACE_MS);
      return;
    }
  }

  const project = await getProject(engine.activeProjectId);
  if (!project) return;
  const wasAwaitingCaptcha = worker.tabId != null && engine.captchaTabIds.includes(worker.tabId);
  let anyStillPending = false;
  let sampleCompanyName = null;
  for (const id of stuckItemIds) {
    const item = project.queue.find((c) => c.id === id);
    if (!item || item.status !== "pending") continue; // already resolved normally - nothing to do for this one
    anyStillPending = true;
    sampleCompanyName = sampleCompanyName || item.company_name;
    item.status = wasAwaitingCaptcha ? "blocked" : "not_found";
  }
  if (!anyStillPending) return;

  console.warn(
    `[CompanyFinder AI] watchdog fired for worker ${workerIndex} after ` +
      `${wasAwaitingCaptcha ? Math.round(CAPTCHA_WATCHDOG_MS / 1000) : "the normal"}s - ` +
      `${stuckItemIds.length} company(ies) marked ${wasAwaitingCaptcha ? "blocked" : "not_found"} ` +
      `(no RESULT came back in time; e.g. "${sampleCompanyName}")`
  );

  project.completionLog = [...(project.completionLog || []), Date.now()].slice(-COMPLETION_LOG_SIZE);
  await saveProject(project);
  await updateIndexCounts(project);

  const stuckBatchToken = worker.batchToken;
  const newEngine = await mutateEngine((e) => {
    const workers = e.workers.slice();
    if (workers[workerIndex] && workers[workerIndex].batchToken === stuckBatchToken) {
      workers[workerIndex] = { ...workers[workerIndex], currentItemIds: [], batchToken: null };
    }
    if (!wasAwaitingCaptcha || worker.tabId == null) return { workers };
    const captchaTabIds = e.captchaTabIds.filter((id) => id !== worker.tabId);
    const pauseReason =
      captchaTabIds.length > 0
        ? buildCaptchaPauseReason(captchaTabIds, e, project)
        : `Gave up waiting for a CAPTCHA to be solved (no response after ` +
          `${Math.round(CAPTCHA_WATCHDOG_MS / 60000)} min) on "${sampleCompanyName}"` +
          `${stuckItemIds.length > 1 ? ` and ${stuckItemIds.length - 1} more` : ""} - marked as blocked for ` +
          `manual review. Click Resume to continue with the rest.`;
    return { workers, captchaTabIds, isPaused: true, pauseReason };
  });
  updateBadge(newEngine, project);

  // A plain stuck tab isn't necessarily Google blocking us, so let the run
  // carry on. A CAPTCHA give-up, though, always leaves the run paused
  // (set above) - never auto-resume from giving up.
  if (!wasAwaitingCaptcha && newEngine.isRunning && !newEngine.isPaused) {
    scheduleNext(workerIndex, randomDelayMs(project));
  }
}

// A worker's tab hit a CAPTCHA. Rather than failing that batch of
// companies, this pauses the whole run (other tabs shouldn't keep
// hammering Google while one of them just got challenged) and brings the
// tab to front so it's actually visible to solve - these worker tabs run
// hidden (`active: false`) by design otherwise. The long
// CAPTCHA_WATCHDOG_MS leash (armed here, in place of the normal
// batch-scaled watchdog) is the backstop if nobody ever comes back to it;
// see handleWatchdogTimeout.
async function handleCaptchaDetected(rawMessage, tabId) {
  const engine = await getEngine();
  const workerIndex = engine.workers.findIndex((w) => w.tabId === tabId);
  if (workerIndex === -1) return;
  const worker = engine.workers[workerIndex];
  if (!engine.activeProjectId || !(worker.currentItemIds || []).length) return; // stale/unexpected - ignore
  if (rawMessage.batchToken !== worker.batchToken) return; // this worker has already moved on - ignore

  armWatchdog(workerIndex, CAPTCHA_WATCHDOG_MS);

  const project = await getProject(engine.activeProjectId);
  if (!project) return;

  const newEngine = await mutateEngine((e) => {
    if (e.captchaTabIds.includes(tabId)) return {}; // already flagged - e.g. re-detected after a failed solve attempt
    const captchaTabIds = [...e.captchaTabIds, tabId];
    return { isPaused: true, pauseReason: buildCaptchaPauseReason(captchaTabIds, e, project), captchaTabIds };
  });
  updateBadge(newEngine, project);

  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Tab/window closed out from under us - nothing more to do here; the
    // watchdog armed above still catches this case if nobody comes back.
  }
}

// AI Mode came up completely empty for a solo (single-item) claim (see
// content.js) and is about to retry with one plain search in the same
// tab. That whole second pass needs its own room to run - re-arm a fresh
// watchdog rather than letting the original one (already most of the way
// through its window) cut it off mid-fallback.
async function handleRetryPlainSearch(rawMessage, tabId) {
  const engine = await getEngine();
  const workerIndex = engine.workers.findIndex((w) => w.tabId === tabId);
  if (workerIndex === -1) return;
  const worker = engine.workers[workerIndex];
  if (!engine.activeProjectId || !(worker.currentItemIds || []).length) return;
  if (rawMessage.batchToken !== worker.batchToken) return; // stale - ignore
  armWatchdog(workerIndex, computeWatchdogMs(worker.currentItemIds.length));
}

// Applies one worker's full batch result (every company it was claiming,
// resolved together) in a single pass: some entries finalize a status,
// others (forceSingle) just leave the item pending for a future solo
// claim. See the file-level comment on forceSingle.
async function handleResult(rawMessage, tabId) {
  if (!rawMessage || !Array.isArray(rawMessage.results)) return; // malformed - drop it

  const engine = await getEngine();
  const workerIndex = engine.workers.findIndex((w) => w.tabId === tabId);
  if (workerIndex === -1) return; // not a recognized worker tab
  const worker = engine.workers[workerIndex];
  if (!engine.activeProjectId || !(worker.currentItemIds || []).length) return; // stale/unexpected - ignore
  if (rawMessage.batchToken !== worker.batchToken) return; // this worker has already moved on to a different batch - a late report from the old one, ignore it

  disarmWatchdog(workerIndex); // got a real result - cancel the stuck-detector for this worker

  debug(
    `RESULT from worker ${workerIndex} (tab ${tabId}):`,
    rawMessage.results.map((r) =>
      r && r.forceSingle
        ? { itemId: r.itemId, forceSingle: true }
        : { itemId: r && r.itemId, status: r && r.status, website: (r && r.website) || null }
    )
  );

  const project = await getProject(engine.activeProjectId);
  if (!project) return;

  const claimedIds = new Set(worker.currentItemIds);
  let anyResolved = false;
  let anyBlocked = false;
  for (const raw of rawMessage.results) {
    if (!raw || !claimedIds.has(raw.itemId)) continue; // not part of this worker's claimed batch - ignore
    const entry = sanitizeResultEntry(raw);
    if (!entry) continue; // malformed/failed re-validation - drop just this entry
    const item = project.queue.find((c) => c.id === entry.itemId);
    if (!item) continue;
    anyResolved = true;

    if (entry.forceSingle) {
      // A batch answer didn't clearly cover this one - stays "pending",
      // flagged so its next claim is a solo attempt instead of another
      // batch. Not a final result yet.
      item.forceSingle = true;
      continue;
    }
    item.forceSingle = false;
    item.status = entry.status; // "found" | "not_found" | "blocked"
    if (entry.status === "blocked") anyBlocked = true;
    item.phone = entry.phone || item.phone || null;
    item.email = entry.email || item.email || null;
    item.emailSource = entry.email ? entry.emailSource : item.emailSource || null;
    // Same never-overwrite-something-with-nothing rule as the fields above,
    // so a re-run (RETRY_MISSING_EMAILS re-runs the whole lookup, not just the
    // gap) can only ever add these, never blank out what an earlier pass found.
    item.certifications = entry.certifications || item.certifications || null;
    if (entry.contactName) {
      // Replaced as a pair: a newly-found person's name must never be left
      // sitting next to the previous person's job title.
      item.contactName = entry.contactName;
      item.contactRole = entry.contactRole || null;
    }
    if (entry.status === "found") {
      item.website = entry.website;
      item.source = entry.source; // "knowledge_panel" | "ai_mode" | "organic"
    }
  }

  if (anyResolved) {
    project.completionLog = [...(project.completionLog || []), Date.now()].slice(-COMPLETION_LOG_SIZE);
    await saveProject(project);
    await updateIndexCounts(project);
  }

  const claimedBatchToken = worker.batchToken;
  // Any real result at all - even not_found/forceSingle - means this tab
  // made it past whatever CAPTCHA it was showing (content.js's own
  // last-resort give-up, status "blocked" on every entry, doesn't count as
  // solved). If this was the last outstanding CAPTCHA, the run can resume
  // on its own - that's the whole point of pausing on CAPTCHA instead of
  // just failing the batch.
  const clearedCaptcha = !anyBlocked;
  let resolvingLastCaptcha = false;

  const newEngine = await mutateEngine((e) => {
    const workers = e.workers.slice();
    // Only clear if this worker still points at the same batch - defends
    // against any unexpected reordering of concurrent messages.
    if (workers[workerIndex] && workers[workerIndex].batchToken === claimedBatchToken) {
      workers[workerIndex] = { ...workers[workerIndex], currentItemIds: [], batchToken: null };
    }
    const wasCaptchaTab = e.captchaTabIds.includes(tabId);
    if (!wasCaptchaTab) return { workers };
    const captchaTabIds = e.captchaTabIds.filter((id) => id !== tabId);
    resolvingLastCaptcha = clearedCaptcha && e.isPaused && captchaTabIds.length === 0;
    return {
      workers,
      captchaTabIds,
      ...(resolvingLastCaptcha
        ? { isPaused: false, pauseReason: null }
        : captchaTabIds.length > 0
        ? { pauseReason: buildCaptchaPauseReason(captchaTabIds, e, project) }
        : {}),
    };
  });
  updateBadge(newEngine, project);

  if (resolvingLastCaptcha) {
    // Same as clicking Resume by hand - wake every worker, not just this
    // one, since their scheduled alarms already fired-and-no-opped while
    // paused (see the "RESUME" message handler below for the same pattern).
    wakeAllWorkers(newEngine.workers.length);
    return;
  }

  if (newEngine.isRunning && !newEngine.isPaused) {
    scheduleNext(workerIndex, randomDelayMs(project));
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(WATCHDOG_PREFIX)) {
    const idx = Number(alarm.name.slice(WATCHDOG_PREFIX.length));
    if (Number.isInteger(idx)) handleWatchdogTimeout(idx);
    return;
  }
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    const idx = Number(alarm.name.slice(ALARM_PREFIX.length));
    if (Number.isInteger(idx)) processNext(idx);
  }
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Defense in depth: Chrome already blocks other extensions/web pages
  // from reaching us here (we don't declare externally_connectable), but
  // verify explicitly anyway, and make sure each message type only comes
  // from the context it's supposed to (content script on an actual Google
  // search tab, vs. the popup).
  if (sender.id !== chrome.runtime.id) return false;
  if (CONTENT_SCRIPT_TYPES.has(message?.type) && !isGoogleSearchTab(sender.tab)) return false;
  if (POPUP_TYPES.has(message?.type) && sender.tab) return false;

  (async () => {
    switch (message.type) {
      case "GET_CURRENT": {
        const engine = await getEngine();
        const workerIndex = engine.workers.findIndex((w) => w.tabId === sender.tab.id);
        if (workerIndex === -1 || !engine.activeProjectId) {
          debug(`GET_CURRENT from tab ${sender.tab.id}: not a worker tab of an active run - leaving that page alone`);
          sendResponse(null);
          return;
        }
        const worker = engine.workers[workerIndex];
        if (!(worker.currentItemIds || []).length) {
          debug(`GET_CURRENT from worker ${workerIndex} (tab ${sender.tab.id}): nothing claimed right now`);
          sendResponse(null);
          return;
        }
        const project = await getProject(engine.activeProjectId);
        const items = project
          ? worker.currentItemIds.map((id) => project.queue.find((c) => c.id === id)).filter(Boolean)
          : [];
        debug(
          `GET_CURRENT -> worker ${workerIndex} (tab ${sender.tab.id}) handed ${items.length} company(ies) - ` +
            `content script is running on that page`
        );
        sendResponse(
          items.length
            ? {
                // Echoed back on every RESULT/CAPTCHA_DETECTED/
                // RETRY_PLAIN_SEARCH this content script sends, so a late/
                // stale message from a batch this worker has since moved
                // on from can be told apart and dropped instead of
                // misfiled against the wrong companies.
                batchToken: worker.batchToken,
                items: items.map((item) => ({
                  itemId: item.id,
                  company_name: item.company_name,
                  city: item.city,
                  country: item.country,
                })),
              }
            : null
        );
        return;
      }
      case "RESULT": {
        await handleResult(message, sender.tab.id);
        sendResponse({ ok: true });
        return;
      }
      case "CAPTCHA_DETECTED": {
        await handleCaptchaDetected(message, sender.tab.id);
        sendResponse({ ok: true });
        return;
      }
      case "RETRY_PLAIN_SEARCH":
      case "RETRY_SEARCH": {
        // Both mean "I'm starting another full pass in this same tab" - the
        // in-flight batch needs a fresh watchdog window or the one armed for
        // the first pass fires mid-retry and writes the batch off.
        await handleRetryPlainSearch(message, sender.tab.id);
        sendResponse({ ok: true });
        return;
      }
      case "CREATE_PROJECT": {
        if (!message.name || !Array.isArray(message.companies) || !message.companies.length) {
          sendResponse({ ok: false, error: "A project name and at least one company are required." });
          return;
        }
        const project = makeProject(
          message.name, message.companies, message.delayMinSec, message.delayMaxSec,
          message.concurrency, message.batchSize
        );
        await saveProject(project);
        const index = await getProjectIndex();
        index[project.id] = {
          name: project.name,
          createdAt: project.createdAt,
          total: project.queue.length,
          counts: countsOf(project.queue),
        };
        await saveProjectIndex(index);
        sendResponse({ ok: true, projectId: project.id });
        return;
      }
      case "UPDATE_PROJECT_SETTINGS": {
        // Delay/concurrency/batch size used to be fixable only at creation,
        // which meant the popup's fields could show a value that didn't
        // match the actually-selected project at all. Now they're editable
        // for an existing project too, just not while it's the one
        // currently running (changing a running engine's worker count
        // isn't supported - stop it first).
        const engineNow = await getEngine();
        if (engineNow.activeProjectId === message.projectId && (engineNow.isRunning || engineNow.isPaused)) {
          sendResponse({ ok: false, error: "Stop this project before changing its settings." });
          return;
        }
        const project = await getProject(message.projectId);
        if (!project) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        project.delayMinSec = message.delayMinSec || project.delayMinSec;
        project.delayMaxSec = message.delayMaxSec || project.delayMaxSec;
        project.concurrency = clampConcurrency(message.concurrency || project.concurrency);
        project.batchSize = clampBatchSize(message.batchSize || project.batchSize);
        await saveProject(project);
        sendResponse({ ok: true });
        return;
      }
      case "RETRY_MISSING_EMAILS": {
        // Items already marked "found" are otherwise never revisited -
        // re-queues just rows with a website but no email, so a fresh pass
        // only pursues what's actually missing. Note: unlike the plain
        // single-item extension, this re-runs the full lookup (website +
        // email + phone) rather than resuming from just the gap - a
        // deliberate simplification for the batch path (see README) that
        // may occasionally re-label an already-correct website's `source`,
        // but never loses data.
        const engineNow = await getEngine();
        if (engineNow.activeProjectId === message.projectId && (engineNow.isRunning || engineNow.isPaused)) {
          sendResponse({ ok: false, error: "Stop this project before retrying." });
          return;
        }
        const project = await getProject(message.projectId);
        if (!project) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        let count = 0;
        for (const item of project.queue) {
          if (item.status === "found" && !item.email) {
            item.status = "pending";
            item.forceSingle = false;
            count++;
          }
        }
        if (count > 0) {
          await saveProject(project);
          await updateIndexCounts(project);
        }
        sendResponse({ ok: true, count });
        return;
      }
      case "RETRY_NOT_FOUND": {
        // Recovery path for a fixed content.js bug (see CHANGELOG.md): an
        // earlier version could misread a solo AI Mode answer and record
        // "not_found" even when the real answer was on the page. Those
        // rows are otherwise never revisited - re-queues every "not_found"
        // row so a corrected run gets a real second look at them.
        const engineNow = await getEngine();
        if (engineNow.activeProjectId === message.projectId && (engineNow.isRunning || engineNow.isPaused)) {
          sendResponse({ ok: false, error: "Stop this project before retrying." });
          return;
        }
        const project = await getProject(message.projectId);
        if (!project) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        let count = 0;
        for (const item of project.queue) {
          if (item.status === "not_found") {
            item.status = "pending";
            item.forceSingle = false;
            count++;
          }
        }
        if (count > 0) {
          await saveProject(project);
          await updateIndexCounts(project);
        }
        sendResponse({ ok: true, count });
        return;
      }
      case "DELETE_PROJECT": {
        const index = await getProjectIndex();
        if (!index[message.projectId]) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        const engineBefore = await getEngine();
        if (engineBefore.activeProjectId === message.projectId && (engineBefore.isRunning || engineBefore.isPaused)) {
          clearAllWorkerAlarms(engineBefore.workers.length);
          await closeWorkerSurfaces(engineBefore.workers);
          await mutateEngine(() => ({
            isRunning: false,
            isPaused: false,
            pauseReason: null,
            activeProjectId: null,
            captchaTabIds: [],
            workers: [],
          }));
          chrome.action.setBadgeText({ text: "" });
        }
        delete index[message.projectId];
        await saveProjectIndex(index);
        await deleteProjectStorage(message.projectId);
        sendResponse({ ok: true });
        return;
      }
      case "START": {
        const engineBefore = await getEngine();
        if (engineBefore.isRunning && engineBefore.activeProjectId && engineBefore.activeProjectId !== message.projectId) {
          sendResponse({ ok: false, error: "Another project is currently running - stop it first." });
          return;
        }
        const project = await getProject(message.projectId);
        if (!project) {
          sendResponse({ ok: false, error: "Project not found." });
          return;
        }
        const concurrency = clampConcurrency(project.concurrency || 1);
        const started = await mutateEngine((engine) => {
          // Reuse existing workers/tabs if resuming the SAME project with
          // the same concurrency, instead of opening fresh tabs every time.
          const reuse = engine.activeProjectId === message.projectId && engine.workers.length === concurrency;
          const workers = reuse
            ? engine.workers
            : Array.from({ length: concurrency }, () => ({
                tabId: null,
                windowId: null,
                ownsWindow: false,
                currentItemIds: [],
                batchToken: null,
              }));
          return {
            activeProjectId: message.projectId,
            isRunning: true,
            isPaused: false,
            pauseReason: null,
            captchaTabIds: [],
            workers,
          };
        });
        updateBadge(started, project);
        wakeAllWorkers(started.workers.length);
        sendResponse({ ok: true });
        return;
      }
      case "STOP": {
        const before = await getEngine();
        clearAllWorkerAlarms(before.workers.length);
        // Close the windows/tabs this run opened. At concurrency 1 that's one
        // tab; at 8 it's eight windows, and leaving those lying around after
        // Stop is its own kind of mess. closeWorkerSurfaces only ever closes
        // what the extension itself created (see ownsWindow).
        await closeWorkerSurfaces(before.workers);
        const stopped = await mutateEngine((engine) => ({
          isRunning: false,
          isPaused: false,
          captchaTabIds: [],
          workers: engine.workers.map((w) => ({
            ...w,
            tabId: null,
            windowId: null,
            ownsWindow: false,
            currentItemIds: [],
            batchToken: null,
          })),
        }));
        const project = stopped.activeProjectId ? await getProject(stopped.activeProjectId) : null;
        updateBadge(stopped, project);
        sendResponse({ ok: true });
        return;
      }
      case "RESUME": {
        const engineBefore = await getEngine();
        const project = engineBefore.activeProjectId ? await getProject(engineBefore.activeProjectId) : null;
        if (!project) {
          sendResponse({ ok: false, error: "That project no longer exists." });
          return;
        }
        const resumed = await mutateEngine(() => ({
          isRunning: true,
          isPaused: false,
          pauseReason: null,
        }));
        updateBadge(resumed, project);
        wakeAllWorkers(resumed.workers.length);
        sendResponse({ ok: true });
        return;
      }
      case "GET_STATE": {
        const [engine, index] = await Promise.all([getEngine(), getProjectIndex()]);
        const summaries = Object.entries(index)
          .map(([id, meta]) => ({ id, ...meta }))
          .sort((a, b) => b.createdAt - a.createdAt);
        sendResponse({ engine, summaries });
        return;
      }
      case "GET_PROJECT": {
        sendResponse(await getProject(message.projectId));
        return;
      }
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async work above
});
