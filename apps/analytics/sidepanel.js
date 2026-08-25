/*
 * sidepanel.js - Zoost for Zoho Analytics.
 *
 * Mirrors a Zoho Analytics workspace into plain local files, then lets you navigate what came back:
 * every view with its type and folder, the columns of every table and query table, the SQL that
 * builds each query table, and the lineage between them.
 *
 * Read-only towards Zoho, always. The only thing it writes is your own working folder.
 *
 * Two rules carried over from the CRM panel, for the same reasons:
 *  - The workspace is whichever one the active tab is in. Leave that tab, or move to a different
 *    workspace, and every Zoho-bound action goes dead rather than acting on the wrong one.
 *  - A workspace's identity is the id inside .zoost.json, never the folder name. Renaming the
 *    folder, or renaming the workspace in Zoho, must not orphan what is on disk.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Attribute-safe: `&`, `<`, `>`, and **both** quote characters. esc() does not escape quotes, and a
// quote inside an attribute closes it early. Escaping both styles means a reader never has to work
// out which one an attribute used - the same definition as the CRM panel and both graph windows.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Already through `escHtml`, so `& < >` are encoded; what is left is the delimiter that decides
// where an attribute ends. `escA` cannot be used here - it encodes `&` too, and this value has been
// encoded once already, so the query string of every link the assistant writes would come out as
// `&amp;amp;`. Named rather than inline, because `tools/htmlcheck.py` reads the name to know an
// attribute is safe, and a check that cannot see the escaping is a check that will be argued with.
// The two delimiters written as escapes, not as themselves: a regex literal containing a quote is
// the trap this repository already records against `sliceConst`, and it bites every scanner that
// reads JavaScript without parsing it - the duplicate-message check and the slicer both lost their
// place on the first version of this line.
const escQ = (s) => String(s).replace(/[\u0022\u0027]/g, (c) => (c === '\u0022' ? '&quot;' : '&#39;'));

const PRODUCT_NAME = chrome.runtime.getManifest().name;   // single source of truth: rename in manifest.json only
// Built from the manifest: the hosts this extension is allowed to read are exactly the hosts it
// should recognise, and a second list is a list that goes out of date. Zoho has more data centres
// than the six that were written here - zoho.sa, zoho.uk and zoho.ae, each with a current
// certificate and a live accounts service.
// The suite shells are in it too. Inside Zoho One - and Zoho CRM Plus the same way - a workspace is
// an ordinary Analytics page in a frame of its own and the *tab* is the shell, so a panel that only
// recognises `analytics.*` refuses the tab before it can look inside it. The shells declare no
// content script: they are named so the tab is recognised and its frames can be enumerated, and
// everything after that happens in the Analytics document, as it does on a plain Analytics tab.
const HOST_RE = new RegExp('^(' + (chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => /^https:\/\/(analytics|one|crmplus)\./.test(h))
  .map((h) => h.replace(/\/\*$/, '').replace(/\./g, '\\.')).join('|') + ')\\/');
// The Analytics application's own origin, which is where the bridge lives and the only thing this
// panel ever speaks to. `HOST_RE` says «this tab is Zoho»; this says «this document is the app».
const APP_HOST_RE = /^https:\/\/analytics\.zoho/;

const PULL_TITLE = 'Pull all - views, structure, relations, SQL and lineage';
const APP_DIR = 'analytics';                  // this app's subfolder inside the working folder
const APP_DIRS = ['crm', 'analytics'];        // known product folders - not "foreign" content
const CFG = '.zoost.json';
// **The blast radius, said once.** It was written three times in the CRM and nowhere at all in
// Analytics, and the three did not agree: one said the permission lasts «permanently», which is
// not true of a stored handle - Chrome drops it between sessions, which is why both panels have a
// re-grant path. A warning that overstates is read once and discounted afterwards. Same sentence
// in both products and on the settings page, held by a test that strips the markup and compares.
const BLAST_RADIUS = 'Zoost will hold read and write access to everything inside that folder, for as long '
  + 'as the browser keeps the permission. A dedicated folder is strongly recommended - not your home or '
  + 'Documents.';

// The pull's own commit marker: `writing` from the first byte of a full pull to its last, `complete`
// after. A mirror mid-write is five files from two moments; the loader refuses it rather than
// presenting it as one. Partial writers (a single re-read, a retry) do not touch it - they replace
// one file, which is atomic enough on its own.
const PULL_STATE = '.pull-state.json';
// The data centre to fall back on when the panel knows neither a workspace nor a tab. A
// display-only copy of a setting: read into a URL, never written from here.
let zohoDc = 'zoho.com';
// Pull schema version: bump it when the pull starts capturing something it did not before.
//
// **It has to be read somewhere, or bumping it does nothing.** It was written into every config
// and by nothing else, so a mirror from an older schema would have been published as current with
// the new fields quietly missing - the version was decoration. `mirrorIsOlderThanSchema()` is what
// reads it; what it does is *say so*, not refuse, because a mirror written by an older Zoost is
// still every fact it captured and the reader decides whether that is enough. The twin marks the
// rows it can re-fetch and re-fetches them; this mirror has no per-row granularity to mark.
const PULL_SV = 1;

// Every sentence this panel says in more than one place, plus the one it shares with the CRM panel.
// A message written out twice is two messages the moment somebody edits one of them - so a literal
// that appears once stays where it is used, and `folder` is the declared exception: requirePerm()
// exists in both apps and must throw the *same* sentence, or the same lapsed permission arrives
// worded one way in Zoost CRM and another in Zoost Analytics. ↻ Refresh is the control that re-asks.
// tests/panel.test.mjs enforces the rule in the other direction, over every shipped script.
const MSG = {
  mismatchRefused: 'The active tab is a different workspace from this one - nothing here reads Zoho Analytics until they match.',
  folder: 'Folder access needs re-granting - click ↻ Refresh.',
  narrow: 'Use a longer substring to narrow.',
  narrowNav: 'No step here matches that. Clear the box to see the whole chain.',
  copyFailed: 'Could not copy: ',
  navGone: 'That step is not in this workspace any more.',
  errPrefix: 'Error: ',
};

// Identity and legal text, worded as in the CRM panel - the two are one product to the reader.
const PRODUCT_URL = 'https://zoost.it';

// Anything that is not Zoho opens in its own window, never a tab.
//
// chrome.tabs.create *activates* the new tab, so the panel suddenly finds itself looking at a
// non-Zoho page: the environment guard fires, the interface empties and the mismatch overlay
// appears. That behaviour is right when it means what it says, and here it meant nothing at all -
// the user clicked Help and the workbench looked like it had lost its place.
//
// Derived rather than listed: every link in the panel goes through here, and the only ones let
// through to a tab are Zoho's own, which are meant to land in the Zoho tab. A link added tomorrow
// is covered without anyone remembering.
// Zoho's own hosts, with or without a subdomain, and nothing that merely contains the word:
// `notzoho.com` and `evil.com/zoho.x` are not Zoho, and treating them as such would send them to
// the Zoho tab where the guard would then complain about a mismatch it did not cause.
// Zoho's own pages belong in the Zoho tab. It stays a rule about the domain rather than a list of
// granted hosts - a link to a Zoho page we do not read is still a Zoho page - and it had one
// blind spot: the Canadian data centre is `zohocloud.ca`, which is not literally «zoho.something»,
// so those links were opening in a window of their own.
function isZohoUrl(u) {
  return /^https?:\/\/(?:[^./?#]+\.)*(?:zoho\.com|zoho\.eu|zoho\.in|zoho\.com\.au|zoho\.jp|zohocloud\.ca|zoho\.sa|zoho\.uk|zoho\.ae)(?::\d+)?(?:[/?#]|$)/i.test(String(u || ''));
}

function openExternal(url) {
  try {
    chrome.tabs.query({ url }, (found) => {
      const t = found && found[0];
      // Best-effort and said so: focusing or opening a window is a courtesy, the outer catch
      // already falls back, and a rejection here costs the reader nothing. Declared with a
      // `.catch()` because an unhandled rejection is an omission and a written one is a
      // decision - the `try` around this could never have caught it, being a callback.
      if (t) { void chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        void chrome.tabs.update(t.id, { active: true }).catch(() => {}); return; }
      void chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 }).catch(() => {});
    });
  } catch (_) {
    void chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 }).catch(() => {});
  }
}
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href^="http"]');
  if (!a) return;
  if (isZohoUrl(a.href)) return;   // Zoho's own pages belong in the Zoho tab
  e.preventDefault();
  openExternal(a.href);
});

// Settings live in one window, and only ever one.
//
// `openOptionsPage()` opens a tab, and only de-duplicates within the *current* browser window -
// while the side panel is per window. Two browser windows, two settings tabs; over a working day,
// ten. That is not a tidiness problem: every one of them is a form holding a snapshot of the
// settings from the moment it opened, and saving an old one silently overwrites a newer one with
// stale values. It is the same trap as having the same Deluge function open in two tabs and being
// invited to "save your work" by the older of them.
//
// So: find any existing settings tab across all windows, focus it, and open a dedicated popup
// window only if there is none. Existing duplicates are focused, never closed - one of them may
// hold edits, and discarding those to enforce uniqueness would be committing the very mistake this
// prevents. They disappear as they are closed.
//
// Uniqueness by construction is still not enough on its own, which is why options.js also refuses to
// save over a value that changed underneath it. A window can be closed and reopened, the extension
// reloaded, and the panel itself writes some of these keys.
// `where` is a fragment - '#ai' from the assistant - so a reader sent to change one thing lands on
// it instead of at the top of a page about eight. An already-open settings window is focused *and*
// moved, because otherwise the second ask does nothing visible and reads as a broken button.
async function openSettings(where) {
  const url = chrome.runtime.getURL('options.html') + (where || '');
  try {
    const open = await chrome.tabs.query({ url: chrome.runtime.getURL('options.html') });
    if (open && open.length) {
      await chrome.windows.update(open[0].windowId, { focused: true });
      await chrome.tabs.update(open[0].id, { active: true, url });
      return;
    }
    await chrome.windows.create({ url, type: 'popup', width: 880, height: 900 });
  } catch (_) {
    chrome.runtime.openOptionsPage();   // whatever went wrong, the settings must still be reachable
  }
}

// Each app points at *its own* pages. Analytics shipped with the Help link hard-coded to the CRM
// guide, which is the kind of thing that only ever gets found by a user - so both are named here,
// once, and every surface derives from them instead of writing a path inline.
const PAGE_URL = PRODUCT_URL + '/analytics.html';
const DOCS_URL = PRODUCT_URL + '/docs-analytics.html';
const STORE_URL = 'https://chromewebstore.google.com/detail/gmelnigbgklfjgceldicakkomhgplgge';
const CONTACT_EMAIL = 'ivan@zoost.it';
const REPO_URL = 'https://github.com/ivannot/zoost';
const SPONSOR_URL = 'https://github.com/sponsors/ivannot';
const KOFI_URL = 'https://ko-fi.com/ivannot';
const PRODUCT_AUTHOR = 'Ivan Notaristefano';
const PRODUCT_LICENSE = 'Apache License 2.0';
const LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';
const LEGAL_DISCLAIMER = 'Independent, unofficial tool. Not affiliated with, endorsed by, sponsored by or supported by Zoho Corporation. '
  + '"Zoho" and "Zoho Analytics" are trademarks of Zoho Corporation, used here in a nominative sense only, to indicate compatibility. '
  + 'Licensed under the Apache License 2.0 and provided AS IS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. '
  + 'The author accepts no liability for any loss, damage or data issue arising from its use, and is under no obligation to provide support or maintenance. '
  + 'Deciding what may be extracted from Zoho Analytics, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';

// ---------- state ----------
let root = null;            // the working folder handle
let rootGranted = false;
let dir = null;             // the active workspace folder handle
let bound = null;           // { workspace, name, origin } of the active workspace, from its .zoost.json
let ctx = null;             // { origin, workspace, view } of the active tab
let busy = false;
let pullDepth = 0, pullBusy = false;

let wsList = [];            // workspaces found on disk, cached like the CRM panel's
let views = [], folders = [], schema = {}, relations = [], sqls = {}, deps = null, pullFailed = [];
// When the views were last read, out of `views.json` where the pull wrote it. The report's
// freshness line asked `bound.lastPull` and `deps.pulledAt`, and neither exists: `bound` is built
// from five fields of the config and `deps` is the id-to-dependency map. So every export said
// «never read» about a workspace pulled a minute earlier, which is the half-truth this project
// refuses - and the date was on disk the whole time.
let viewsPulledAt = null;
const ORPHANS = '__orphans__';
let typeFilter = null, sortKey = 'name', sortDir = 1, selectedId = null, detailTab = 'cols';
let detailLoad = 0;
const detailCurrent = (mine, op) => mine === detailLoad && op.current();

// ---------- status ----------
function status(text, kind) { noteStep(text); $('statustext').textContent = text; $('status').className = kind || ''; showEmergency(false); }

// ---------- problem reports ----------
//
// Nothing here is sent by the extension. It builds a text, shows it to the reader in full, and -
// only on a click - opens zoost.it/report and writes the text **into that page**, through the DOM.
// It used to travel in the URL fragment, on the reasoning that a fragment is never transmitted to a
// server: true, and not the whole question, because the navigation itself is written to the
// browser's history and syncs with it. Nothing about the report is in any address now. The page
// shows it again, and the reader is the one who submits it. So «no telemetry, nothing automatic»
// stays true in the strong sense, and the report that does travel has been read twice by the person
// sending it.
//
// Two defences, because one is a promise and the other is a mechanism. The mechanism: what goes in
// comes from a **whitelist of known fields**, never from a sweep of state - a field added tomorrow
// is a decision, not an accident. The promise, kept honest by a test: free text passes `redact()`.

// Everything that is never collected. It was dead - declared here, read by nothing, while the
// comment claimed a test enforced it: a decoration wearing the clothes of a mechanism, found by an
// audit. `tests/panel.test.mjs` now reads this very array out of the source and checks that neither
// `reportFacts` nor `buildReport` mentions any of it, so the list and the check cannot drift.
const REPORT_NEVER = ['apiKey', 'apiKeyEnc', 'source', 'sql', 'code', 'name', 'displayName',
  'folderName', 'owner', 'org', 'instance', 'path', 'root'];

// Free text - an error message, a status line - with everything that could name your business
// taken out of it. Aggressive on purpose: a message can embed an org id, an instance, a function
// name in quotes. What it keeps is the *shape* of the sentence, which is what diagnoses.
// It cannot be proven exhaustive, and it is not the only defence: the whitelist above decides what
// is offered at all, the reader sees the result before sending, and the Worker redacts again.
// A declaration, byte-identical in both panels and in the report page: one text, one meaning.
function redact(text) {
  if (text == null) return { text: '', n: 0 };
  let n = 0;
  const out = String(text)
    // Ours, and the whole diagnostic value of a stack: kept, minus the extension id, which is noise.
    .replace(/chrome-extension:\/\/[a-z]+\//gi, '')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, () => { n++; return '<email>'; })
    .replace(/https?:\/\/[^\s)"']+/gi, () => { n++; return '<url>'; })
    .replace(/\b\d{8,}\b/g, () => { n++; return '<id>'; })
    .replace(/«[^»]*»/g, () => { n++; return '«…»'; })
    .replace(/"[^"]*"/g, () => { n++; return '"…"'; });
  return { text: out, n };
}

// Free text that this panel *interpolated names into*, treated as hostile. `redact()` is not enough
// for it and an audit proved it: the status line says `Synced: functions/Commissions/Recalc_Fees.dg`
// and `Working folder: <a client's name>`, and none of that is an email, a URL or a long number. The
// call sites are ~150 and nothing can constrain what one written tomorrow will interpolate, so this
// takes the opposite approach: anything shaped like an identifier, a path or a host goes, and what
// survives is the sentence around it - which is what actually diagnoses.
// It cannot be proven exhaustive. That is why the reader is shown the result and asked to read it,
// and why the wording on the site says «what it recognises», never «never».
function redactHard(text) {
  if (text == null) return { text: '', n: 0 };
  let n = 0;
  const hit = (mark) => () => { n++; return mark; };
  const out = String(text)
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, hit('<email>'))
    .replace(/https?:\/\/[^\s)"']+/gi, hit('<url>'))
    .replace(/[a-z]:\\[^\s"']*/gi, hit('<path>'))
    // A path, or a Zoho namespace: anything with a slash joining two names.
    .replace(/[\w.-]+(?:\/[\w.-]+)+/g, hit('<path>'))
    // Quoted, in every style the panels and the platform actually use - Chrome's own DOMException
    // messages quote with apostrophes, which the first version did not touch.
    .replace(/«[^»]*»|"[^"]*"|'[^']*'|[‘“][^’”]*[’”]|`[^`]*`/g, hit('«…»'))
    // No word boundary: an id glued to a prefix - `zcrm_349725000131663089` - kept its digits.
    .replace(/\d{6,}/g, hit('<id>'))
    // A host without a scheme, which the URL rule above never saw: `crm.zoho.eu`.
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi, hit('<host>'))
    // What is left of an identifier: dotted or underscored, which is what a function, a module api
    // name and a mirror filename all look like.
    .replace(/\b\w+[._]\w[\w._]*\b/g, hit('<name>'));
  return { text: out, n };
}

// The report as the reader will see it and as the page will re-render it: a pure function of an
// object nobody had to be trusted about. Every value it prints is either a number, a boolean, one
// of a fixed set of words, or free text that has been through `redact()`.
function buildReport(r) {
  const L = [];
  const red = { n: 0 };
  // Two levels, because the two kinds of text are not alike. The stack is ours by construction -
  // chrome-extension://<id>/sidepanel.js - so it keeps its file and line, which is the whole of its
  // value. Everything else was built by interpolating whatever was to hand, and is treated as such.
  const clean = (s) => { const o = redactHard(s); red.n += o.n; return o.text; };
  const ours = (s) => { const o = redact(s); red.n += o.n; return o.text; };
  L.push(`${r.product} ${r.version} · ${clean(r.browser)}`);
  L.push('');
  L.push('what happened');
  L.push(`  ${clean(r.message) || '(no message)'}`);
  if (r.stack) ours(r.stack).split('\n').slice(0, 12).forEach((s) => L.push(`  ${s.trim()}`));
  L.push('');
  L.push('state');
  L.push(`  tab: ${r.tab} · search: ${r.search} · pull: ${r.pullActive ? 'running' : 'idle'}`);
  L.push(`  workspace: ${r.sample ? 'the sample - invented data' : 'a real one'} · assistant: ${r.ai || 'not configured'}`);
  if (r.counts && Object.keys(r.counts).length) {
    L.push(`  counts: ${Object.entries(r.counts).map(([k, v]) => `${k} ${Number(v)}`).join(' · ')}`);
  }
  if (r.refused && r.refused.length) L.push(`  areas your Zoho role refused: ${r.refused.join(', ')}`);
  if (r.steps && r.steps.length) {
    L.push('');
    L.push('last steps, oldest first');
    r.steps.forEach((s) => L.push(`  ${clean(s)}`));
  }
  L.push('');
  L.push(`redactions: ${red.n} · no source, no SQL, no keys, and no file of yours was read to build this.`);
  L.push('Names, paths and ids are stripped where they are recognised - which is why you are being shown it.');
  return L.join('\n');
}

// The last lines the status bar said, in memory only - never written to disk, gone when the panel
// closes. Thirty because a failure is usually three or four steps after the thing that caused it,
// and a reader has to be able to read the whole buffer before deciding to publish it.
const REPORT_STEPS_MAX = 30;
const reportSteps = [];
function noteStep(text) {
  if (!text) return;
  const t = String(text);
  if (reportSteps[reportSteps.length - 1] === t) return;   // a progress line repeating itself
  reportSteps.push(t);
  if (reportSteps.length > REPORT_STEPS_MAX) reportSteps.shift();
}


// The pointer to zoost.it/emergency: a link that lives in the markup and is only ever shown or
// hidden. Nothing here is ever built from what Zoho answered, which is what keeps the status line
// safe to print a platform error into - it stays textContent, and the link stays static.
//
// Cleared by every status write and set again by the one failure path that should carry it, so it
// cannot linger over a later success. One place to clear, one place to set.
function showEmergency(on) { for (const id of ['emerg', 'repopen', 'repdismiss']) { const e = $(id); if (e) e.classList.toggle('on', !!on); } }

// ---------- filesystem ----------
async function ensurePerm(h) { const o = { mode: 'readwrite' }; if ((await h.queryPermission(o)) === 'granted') return true; return (await h.requestPermission(o)) === 'granted'; }
async function hasPerm(h) {
  return (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
}
// Chrome drops the folder permission between sessions, so anything that is about to write has to
// ask first - under a real click, which every caller of this is. Without it the first write throws
// `NotAllowedError: The request is not allowed by the user agent…`, which names neither the folder
// nor the remedy and reads as the extension being broken. The CRM panel guards all fifteen of its
// mirror-writing entry points; this one guarded two of five, and pullAll, pullOne and retryFailed
// wrote straight to disk. Same wording as the twin, so one message covers both products.
async function requirePerm(h) { if (!(await ensurePerm(h))) throw new Error(MSG.folder); }
// The folders, remembered. Every read and every write resolved `functions/<namespace>/` from the
// root again - two calls to the browser's file system before the one that does the work - so half of
// what a pull and a load spend is asking for the same directory over and over. Measured: writing a
// function cost 8 calls, of which 4 were this.
//
// Handles are per working folder, so the cache is dropped whenever that changes; a stale handle is
// worse than a slow one, and this is the kind of cache that has to be given up eagerly rather than
// checked. `removeEntry` drops it too, since a folder that has just been deleted must not be handed
// back by us.
// Keyed on the root, not one map for whichever folder is current. It walked from `dir`, awaited each
// step, and then wrote what it found into the *global* cache - so a resolution that started in one
// workspace and finished after a switch filled the new workspace's cache with the old one's handles,
// and the next lookup there answered without ever asking that folder. Reproduced in both panels: a
// path resolved in B came back holding A's handle with zero calls to B.
//
// A cache per root cannot say the wrong thing about the other one: the entry goes where it was read
// from. Handles still have to be given up eagerly rather than checked - a stale one is worse than a
// slow one - so a switch drops everything and `removeEntry` drops everything, since a folder that
// has just been deleted must not be handed back by us.
let _dirCaches = new WeakMap();
const forgetDirs = (root) => { if (root) _dirCaches.delete(root); else _dirCaches = new WeakMap(); };
async function dirFor(parts, create, root = dir) {
  if (!root) throw new Error('No workspace folder is open.');
  let cache = _dirCaches.get(root);
  if (!cache) _dirCaches.set(root, (cache = new Map()));
  const key = parts.join('/');
  // The cache answers for writes too: a folder that has been created once exists, and asking the
  // browser to create it again is the call this exists to avoid. Skipping the cache when `create`
  // was set left a pull paying full price for every file it wrote - half of the eight calls each.
  if (cache.has(key)) return cache.get(key);
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, create ? { create: true } : undefined);
  cache.set(key, d);
  return d;
}

/** What a write means for what is still held in memory from that file. The CRM panel's `noteWrite`,
 *  with one entry, because this product has one cache of file contents.
 *
 *  `in: SQL` reads every query once and keeps it for the session, and it was dropped in
 *  `loadFromDisk()` alone - which a pull passes through and a *re-read* does not. So «Re-read this
 *  view» and «Retry the failures» replaced the SQL in memory, wrote it out, and left the search
 *  matching the query as it used to be: the mirror right and the panel confidently wrong about it,
 *  the same defect the CRM had in `syncOne`. Deriving it from the write means the next path that
 *  writes a query inherits this without knowing it exists. */
function noteWrite(rel) {
  if (rel.startsWith('sql/') && rel.endsWith('.sql')) {
    sqlCache = null;
    // A successful rewrite may have repaired any file that previously refused to open. The path
    // does not carry the view id, so discard the small negative cache whole rather than risk
    // leaving one repaired query described as unreadable.
    sqlDiskUnread.clear();
  }
}
// The workspace an operation belongs to, taken once and carried - not read out of a global after
// every await. A pull reads from Zoho, waits, and then writes: `dir` at that moment is whatever the
// panel is showing *now*, so a switch part-way through wrote one workspace's views, schema and SQL
// into another workspace's folder - and put its ids into the other one's memory. Measured.
//
// The root is a parameter of the I/O and the refusal lives in the one place every write passes
// through. `current()` is what a caller asks before spending effort or touching what is in memory;
// the writer refuses regardless, which is what makes the class impossible rather than unlikely.
const WS_MOVED = 'The workspace changed while this was running - nothing further was written to it.';
function beginWorkspaceOp() {
  const gen = wsGen, root = dir;
  const current = () => gen === wsGen && root === dir;
  // See the CRM twin: a handle is not an identity through time. Leave a workspace and come back and
  // the same object is current again, so an operation from before the round trip passed a check that
  // compares handles while `current()` said false. Asked on both sides of the await.
  const guard = () => { if (!current()) throw new Error(WS_MOVED); };
  async function through(fn) { guard(); const v = await fn(); guard(); return v; }
  return {
    root, gen, current,
    read: (p) => through(() => readFileAt(root, p)),
    write: (p, body) => through(() => writeFileAt(root, p, body)),
    remove: (p) => through(() => removeFileAt(root, p)),
    // Progress belongs to a workspace as much as a write does. Reported on the CRM side: a pull kept
    // counting into the panel after the user had opened another workspace, so the work looked like it
    // was happening there. Here the counting arrives as a message from the bridge, which is the same
    // thing one layer out. It says nothing once it is not there.
    say: (msg, kind) => { if (current()) status(msg, kind); },
  };
}
async function writeFileAt(root, rel, content) {
  if (root !== dir) throw new Error(WS_MOVED);
  const parts = rel.split('/');
  const d = await dirFor(parts.slice(0, -1), true, root);
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable(); await w.write(content); await w.close();
  noteWrite(rel);
}
async function readFileAt(root, rel) {
  const parts = rel.split('/');
  const d = await dirFor(parts.slice(0, -1), false, root);
  const fh = await d.getFileHandle(parts[parts.length - 1]);
  return (await fh.getFile()).text();
}
// The shorthands every render path uses: they read and write the workspace on screen, which is the
// one they mean. A path that survives an await must take an op instead.
async function removeFileAt(root, path) {
  if (root !== dir) throw new Error(WS_MOVED);
  const parts = path.split('/'); const name = parts.pop();
  let d = root; for (const q of parts) d = await d.getDirectoryHandle(q);
  await d.removeEntry(name); noteWrite(path);
}
const writeFile = (rel, content) => writeFileAt(dir, rel, content);
const readFile = (rel) => readFileAt(dir, rel);
// Every file in a workspace, path first. The twin of the CRM panel's, and it was *called* here
// before it existed: `pruneSql` walks the tree to find the .sql files the new index no longer names,
// and the line was written from the CRM side where the helper is. Nothing said so - `node --check`
// is happy with a free variable, no test runs a pull, and the ReferenceError landed inside the one
// try block that marks the mirror incomplete, so a pull that had written every byte correctly ended
// as «the last pull was interrupted mid-write» and the repair ran into the same wall.
async function* walk(d, prefix = '') {
  for await (const [name, h] of d.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') yield* walk(h, prefix + name + '/'); else yield prefix + name;
  }
}
// «Not there» and «could not be read» are different facts, and this returned the same fallback for
// both - so a workspace whose files were all on disk was announced as never pulled, and the reader
// was sent to press Pull all over a folder that had simply gone unreadable. Reported. The file three
// screens down carries the same lesson about empty vs unreadable *inside* a file; this is the same
// mistake one level up, about the file itself.
//
// The fallback stays, because most callers genuinely want «use this when there is nothing». What is
// added is that a failure which is not «no such file» leaves a trace, so whoever asks can say which
// of the two happened.
async function readJson(rel, fallback, op, onFailure) {
  try { return JSON.parse(await (op ? op.read(rel) : readFile(rel))); } catch (e) {
    // A late read belongs to the workspace it started in. In particular it must not revoke the
    // permission verdict, or leave an unreadable-file reason, in the workspace that replaced it.
    if (op && !op.current()) return fallback;
    // `NotAllowedError` is Chrome saying the folder permission has lapsed, and it is proof that the
    // cached verdict in `rootGranted` is wrong. Leaving that verdict alone is what made the state
    // circular: the panel only re-requests permission while it believes it has none, so believing it
    // has some meant no click - Refresh included - ever asked for it back. Reported exactly that way:
    // «the message is clearer but pressing Refresh changes nothing».
    if (e && e.name === 'NotAllowedError') rootGranted = false;
    // Losing permission is also a failed read. The global verdict and the caller-local reason are
    // two different effects; making them an either/or let a partial SQL refresh replace an index
    // it was not allowed to read with the empty fallback.
    if (e && e.name !== 'NotFoundError' && onFailure) onFailure({ rel, name: (e && e.name) || 'Error' });
    return fallback;
  }
}
// What the last load off disk ran into, and the only thing the empty state is allowed to speak about:
// a stray failure from some unrelated read must not turn into a sentence about this workspace.
let diskUnreadable = null;
// Set by the one branch of `loadFromDisk` that refuses a mirror outright, and cleared by every other
// path through it, so the empty state can name that refusal instead of falling through to «nothing
// pulled yet» - which is what a reader was told about a folder full of files.
let pullInterrupted = false;
const writeJson = (rel, o, op) => (op ? op.write(rel, JSON.stringify(o, null, 2)) : writeFile(rel, JSON.stringify(o, null, 2)));
// Merge rather than replace. `.zoost.json` holds more than the binding - the workspace's own name
// lives there too - and a whole-object write from any one writer silently drops what the others put
// in it. The CRM learnt this twice; this side inherits the lesson rather than the bug.
// The op reaches here because `.zoost.json` is the file that says which workspace this folder
// mirrors. Optional, so the render paths that mean the folder on screen are unchanged.
async function patchCfg(o, op) {
  return writeJson(CFG, Object.assign({}, await readJson(CFG, {}, op), o), op);
}
// Filenames are derived from Zoho's names, so anything a filesystem dislikes has to go. The id is
// appended because two views in different folders may legitimately share a name.
const sanitize = (s) => String(s).replace(/[^\w.\-]/g, '_');
const stemOf = (name, id) => (String(name || 'unnamed').replace(/[^\w.\- ]/g, '_').trim().slice(0, 80) || 'unnamed') + '-' + id;

async function appRoot(create) {
  if (!root) return null;
  try { return await root.getDirectoryHandle(APP_DIR, { create: !!create }); } catch (_) { return null; }
}

// ---------- working folder ----------
async function pickRoot() {
  if (workspaceChangeRefuse()) return;
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'zoost-root' });
    if (!(await ensurePerm(h))) { status('Permission to the folder was not granted.', 'bad'); return; }
    // The count the CRM twin has always made and this side never did: a folder full of things that
    // are not workspaces is almost always somebody's Documents, and the permission covers all of it.
    // Capped at 80 entries because the answer is «this looks like the wrong folder», not a census.
    let foreign = 0, seen = 0;
    for await (const e of h.values()) {
      if (++seen > 80) break;
      if (e.kind !== 'directory') { foreign++; continue; }
      if (APP_DIRS.includes(e.name)) continue;                      // a product folder - our own layout
      try { await e.getFileHandle(CFG); } catch (_) { foreign++; }  // a workspace from the older flat layout
    }
    if (foreign > 6 && !confirm(`\u00ab${h.name}\u00bb already contains ${foreign} items that are not Zoost workspaces.\n\n`
      + `${BLAST_RADIUS}\n\nUse this folder anyway?`)) return;
    root = h; rootGranted = true; await window.idbHandle.set('rootDir', h);
    // **Said before the folder is read, not after it.** `refreshWorkspaces` is what diagnoses the
    // folder, and its diagnosis was overwritten one line later by a green «Working folder: X» -
    // every time, whatever it found. Two of those messages exist nowhere else: «N workspace folders
    // sit directly in X - move the Zoho Analytics ones into X/analytics/», which is the only place
    // the old flat layout is explained, and «Could not read X/analytics», after which
    // `rootGranted` is false while the status line says success and the list underneath says access
    // is not granted. The CRM twin has this order and does not have the defect.
    status(`Working folder: \u00ab${h.name}\u00bb`, 'ok');
    await refreshWorkspaces();
  } catch (e) {
    if (e && e.name === 'AbortError') return;         // the user closed the picker - not an error
    status('Could not open that folder: ' + (e.message || e), 'bad');
  }
}
// A stored handle whose permission lapsed needs *authorisation*, not re-selection. Asking for the
// folder again is what made this panel more annoying than the CRM one: showDirectoryPicker() makes
// the user navigate the filesystem, requestPermission() is a one-click prompt.
async function grantRoot() {
  if (!root) { await pickRoot(); return; }
  try {
    if (!(await ensurePerm(root))) { status('Access denied - Zoost cannot read the working folder.', 'bad'); return; }
    rootGranted = true;
    status(`Access granted to \u00ab${root.name}\u00bb.`, 'ok');
    await refreshWorkspaces();
  } catch (e) { status('Grant failed: ' + (e.message || e), 'bad'); }
}
async function restoreRoot() {
  if (!root) root = await window.idbHandle.get('rootDir');
  if (!root) return;
  rootGranted = await hasPerm(root);
  await refreshWorkspaces();
}

// Workspaces are found by reading each folder's .zoost.json, never by parsing folder names - that is
// what lets a folder be renamed without orphaning it.
async function listWorkspaces() {
  const base = await appRoot(false);
  if (!base) return [];
  const out = [];
  // The enumeration itself can fail - a handle whose permission lapsed, a folder moved or removed
  // since the browser stored it. Unguarded, that threw out of here and left the panel with no
  // workspace list and no explanation. A folder we cannot read is a state to report, not a crash.
  try {
    for await (const e of base.values()) {
      if (e.kind !== 'directory' || e.name.startsWith('.')) continue;
      try {
        const fh = await e.getFileHandle(CFG);
        const cfg = JSON.parse(await (await fh.getFile()).text());
        if (cfg && cfg.workspace) out.push({ id: String(cfg.workspace), name: cfg.name || '', folder: e.name, handle: e, cfg });
      } catch (_) { /* a folder without a config is not a workspace; silently skipped */ }
    }
  } catch (e) {
    rootGranted = false;                       // most often this is a lapsed permission
    status(`Could not read «${root ? root.name : '?'}/${APP_DIR}»: ${e.message || e}. Click the folder button to grant access again.`, 'warn');
    return out;                                // whatever was read before the failure is still true
  }
  return out.sort((a, b) => String(a.name || a.folder || '').localeCompare(String(b.name || b.folder || '')));
}

async function refreshWorkspaces() {
  const sel = $('ws');
  // Word for word the CRM's, including the glyphs and the titles: it is the same control, and it read
  // as a different product for showing «Zoost/analytics» where the other side shows «📁 Zoost». The
  // subfolder is an implementation detail of where workspaces live, not the folder the user picked.
  const rt = $('wsroot');
  const needsGrant = !!root && !rootGranted;
  rt.classList.toggle('needgrant', needsGrant);
  rt.textContent = !root ? '\u{1F4C1} Set working folder\u2026'
    : needsGrant ? `\u{1F513} Grant access to ${root.name}`
    : `\u{1F4C1} ${root.name}`;
  rt.title = !root ? 'Pick the folder that will contain all Zoost workspaces'
    : needsGrant ? 'Chrome dropped the file-system permission for this folder. One click restores it - no folder picker.'
    : `Working folder: ${root.name} - click to choose a different one`;
  if (root && !rootGranted) {
    sel.innerHTML = '<option value="">access not granted</option>';
    dir = null; bound = null; forgetDirs();
    // Word for word the CRM's. The blocker is one click, and saying nothing here left the status line
    // reading "Ready." while nothing could be read at all.
    status('Click \u00abGrant access\u00bb above, or anywhere in this panel - one click, no folder picker.', 'warn');
    render(); return updateButtons();
  }
  if (!root) { sel.innerHTML = '<option value="">no working folder yet</option>'; dir = null; bound = null; render(); return updateButtons(); }

  const list = (await listWorkspaces()).sort(byWsLabel);
  wsList = list;
  // Folders sitting directly in the working folder are the older flat layout. This is not a
  // compatibility fallback - nothing keeps working the old way - it is an empty state that says
  // what it sees instead of reporting "no workspaces" while the folders are plainly there.
  let stray = 0;
  try {
    for await (const e of root.values()) {   // same exposure as above; the catch below covers it
      if (e.kind !== 'directory' || APP_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
      try { await e.getFileHandle(CFG); stray++; } catch (_) {}
    }
  } catch (_) {}

  if (!list.length) {
    sel.innerHTML = `<option value="">${esc(root.name)}/${APP_DIR} - no workspaces yet</option>`;
    if (stray) status(`${stray} workspace folder(s) sit directly in «${root.name}». Each Zoost product keeps its own - move the Zoho Analytics ones into «${root.name}/${APP_DIR}/» and reopen the panel.`, 'warn');
    // The remembered sample id is refreshed from the list below - «including to null, which is how
    // deleting the sample stops the button offering to open one that is gone». This return is the one
    // path that never reaches it: delete the sample when it is the *only* workspace and the id stays
    // in storage, so `updateSampleButtons()` hides «+ Sample» for good - while the empty state two
    // lines down is telling the reader to press it. It survives a reload, because the stale id is
    // restored from storage on start.
    // Only when the folder was actually read. `listWorkspaces()` returns an empty array *both* when
    // there are no workspaces and when the enumeration failed - a lapsed permission, a folder that
    // moved - and forgetting the sample on the second is the regression this line caused the day it
    // was added: the remembered id exists precisely because an unreadable folder cannot tell a
    // sample apart from no sample, which is what its own comment says, from four reports.
    if (rootGranted) noteSampleWs(null);
    // **And the workspace that is gone goes with it.** `dir` and `bound` were cleared and the model
    // was not, so the list went on drawing all 39 views of a folder the panel could no longer read -
    // with the diagram, the audit, the assistant and both exports still enabled, because they gate on
    // `views.length`. You could export a workspace that is not there. The twin blanks its tree and
    // switches its six local controls off in this same state.
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; viewsPulledAt = null;
    dir = null; bound = null; forgetDirs(); render(); return updateButtons();
  }
  sel.innerHTML = list.map((w) => `<option value="${escA(w.id)}" title="${escA(wsOptionTitle(w))}">${esc(wsOptionText(w))}</option>`).join('');
  // The list is real now, so the remembered answer is refreshed from it - including to null,
  // which is how deleting the sample stops the button offering to open one that is gone.
  noteSampleWs((wsList.find((w) => w.cfg && w.cfg.sample) || {}).id || null);
  const active = await window.idbHandle.get('activeWsAnalytics');
  const pick = list.find((w) => w.id === active) || list[0];
  sel.value = pick.id;
  await selectWorkspace(pick);
}

/** Everything that belongs to the workspace you were in, dropped when you leave it.
 *
 * The conversation stayed on screen across a workspace switch: the assistant's own replies name
 * views, columns and query tables from the workspace you have just left, sitting above a question
 * about the new one, and the whole thread is re-sent with every message - so the model is asked to
 * reason about two workspaces at once and told nothing about the boundary.
 *
 * Byte for byte the CRM panel's, minus the caches it has and this one does not: here `loadFromDisk()`
 * replaces `views`, `schema` and `lineage` wholesale on every switch, so there is nothing else to drop.
 */
function dropWorkspaceState() {
  const had = aiMessages.length;
  aiGen++;
  aiMessages = []; aiSeedWarned = false; aiBusy = false;
  const send = $('aisend'); if (send) send.disabled = false;
  aiRenderMessages();
  return had;
}
/** What is on *screen* when a different workspace is opened - the other half of the above.
 *
 *  Reported on the CRM panel and true here for the same reason: switch workspace with the Health
 *  view open and nothing changes, because what the switch rebuilds is the list underneath an overlay
 *  covering it. A search term typed for one workspace silently narrows the next one too.
 *
 *  Two functions rather than one, and the split is not cosmetic: `dropWorkspaceState()` is what
 *  **Clear** in the chat calls, and Clear must not empty the reader's search box. The selection and
 *  the detail pane are not here because `loadFromDisk()` already drops them on every load. */
function resetView() {
  $('find').value = '';
  if ($('healthview').classList.contains('show')) renderHealth();
  if ($('aiview').classList.contains('show')) aiContextLabel();
}

// Which workspace the panel should reopen on, remembered in IndexedDB. Two selections overlapping -
// a slow one, then a fast one - resolved in the order the browser finished them, so the panel showed
// the second and reopened on the first. The write is queued and the queued work asks whether it is
// still the current selection: what is persisted is what is on screen, not what finished last.
let _activeWsWrites = Promise.resolve();
// The queued work is a declaration and not a `.then(cb)`, because a callback is a scope the race
// checker cannot enter - and this one is *about* a race: it asks, after the queue has drained, whether
// the selection it was queued for is still the one on screen. A check like that is exactly what has
// to be readable.
async function writeActiveWhenStillCurrent(key, id, gen, after) {
  await after;
  if (gen !== wsGen) return;                     // another selection overtook this one; it owns the key
  await window.idbHandle.set(key, id);
}
function rememberActive(key, id, gen) {
  _activeWsWrites = writeActiveWhenStillCurrent(key, id, gen, _activeWsWrites);
  return _activeWsWrites;
}
async function selectWorkspace(w) {
  if (pullBusy && bound && String(w.id) !== String(bound.workspace)) {
    $('ws').value = bound.workspace;
    status('Pull in progress - wait for it to finish before changing workspace.', 'warn');
    updateButtons();
    return false;
  }
  const sameWs = bound && bound.workspace === w.id;
  // The generation moves **here**, before the handle does and before anything awaits: an operation
  // still running belongs to the workspace it started in, and it must be able to tell. It used to
  // move inside `dropWorkspaceState()`, which is also what Clear calls - so clearing a conversation
  // interrupted a pull, and in Analytics the line sat after a `return` and never ran at all, which
  // made every guard in that file always true. Both reported.
  const gen = ++wsGen;
  dir = w.handle; forgetDirs();
  bound = { workspace: w.id, name: w.cfg.name || '', origin: w.cfg.origin || '', label: w.cfg.label || '',
            sample: !!w.cfg.sample, lastPull: w.cfg.lastPull || null,
            sv: Number(w.cfg.sv || 0) };
  const op = beginWorkspaceOp();
  await rememberActive('activeWsAnalytics', w.id, gen);
  if (!op.current()) return;   // a second selection overtook this one while IndexedDB was writing
  // Not on a re-selection of the workspace already open - regranting a folder must not throw
  // away a conversation about the workspace you are still in.
  if (!sameWs) {
    const n = dropWorkspaceState();
    if (n) status(`Workspace changed - the assistant's ${n}-message conversation was cleared: it was about the other workspace.`, 'warn');
    // The selection and the back/forward chain belong to the workspace being left: every step in the
    // chain is a view id of that one. `loadFromDisk` drops them, and only on its *successful* path -
    // three returns come first, one of them the mirror it refuses for being interrupted mid-write.
    // Take that route and the panel stands in the new workspace with the old one's view still in the
    // detail pane and ◂ ready to open ids that mean nothing here.
    //
    // Here rather than there, because `loadFromDisk` also runs for ↻ Refresh on the workspace you
    // are already in, and forgetting where you were would be a defect of its own. This is the one
    // place that knows the workspace actually changed.
    selectedId = null; navClear();
    $('detail').classList.remove('show'); $('resizer').classList.remove('show');
  }
  if (!(await loadFromDisk(op))) return;
  if (!sameWs) resetView();   // after the load: Health is rendered from what is now in memory
  if (!op.current()) return;
  await refreshContext();
}

async function addWorkspace() {
  if (workspaceChangeRefuse()) return;
  if (!root) return status('Pick a working folder first.', 'warn');
  if (!ctx || !ctx.workspace) return status('Open a Zoho Analytics workspace in the active tab first.', 'warn');
  setBusy(true, 'Creating the workspace folder…');
  try {
    const info = await toBridge({ cmd: 'workspaceInfo', aboutTab: true });
    const base = await appRoot(true);
    if (!base) throw new Error(`could not create the ${APP_DIR}/ folder`);
    const folder = stemOf(info.name || 'workspace', info.workspace);
    const h = await base.getDirectoryHandle(folder, { create: true });
    dir = h; forgetDirs();
    await patchCfg({ workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV, lastPull: null });
    // Remembered before the list is rebuilt, because rebuilding it selects the remembered one - and
    // the remembered one was still the workspace you were in. So «Create workspace for X» created X
    // and then put you back where you were, with the mismatch bar still up and the new folder empty
    // behind it. The CRM twin has always done this; this is the half that was missing here.
    await window.idbHandle.set('activeWsAnalytics', info.workspace);
    // Zoho Analytics does not always give a workspace a name this endpoint can read, and the panel
    // then had nothing to show but the id - «I import a new org and the dropdown tells me nothing».
    // A missing name is said once, beside the control that fixes it, instead of being rendered as a
    // number and left for the reader to work out.
    setBusy(false, info.name
      ? `Workspace «${info.name}» created. Press Pull all.`
      : `Workspace ${info.workspace} created - Zoho Analytics gave it no name. Press ✎ to name it, then Pull all.`);
    $('status').className = 'ok';
    await refreshWorkspaces();
  } catch (e) {
    setBusy(false, 'Could not create the workspace: ' + (e.message || e));
    $('status').className = 'bad';
  }
}

// Deleting the local mirror only. The confirmation says so explicitly, because "Remove workspace"
// next to a tool that talks to Zoho is exactly the phrase someone reads as "delete it in Zoho".
async function delWorkspace() {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value);
  if (!w || !root) return;
  if (!confirm(`Delete the folder «${w.folder}» and everything in it?\n\nThis removes the local mirror only - nothing in Zoho Analytics is touched. You can pull it again at any time.`)) return;
  try {
    if (!(await ensurePerm(root))) { status(MSG.folder, 'warn'); return; }
    const base = await appRoot(false);
    if (!base) { status('Could not open the workspace folder.', 'warn'); return; }
    await base.removeEntry(w.folder, { recursive: true });   // delete inside analytics/, never at the root
    await window.idbHandle.set('activeWsAnalytics', null);
    dir = null; bound = null; forgetDirs();
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; viewsPulledAt = null;
    $('detail').classList.remove('show'); $('resizer').classList.remove('show'); selectedId = null; navClear();
    status(`Removed \u00ab${w.folder}\u00bb.`, 'ok');
    await refreshWorkspaces();
    render();
  } catch (e) { status('Remove failed: ' + (e.message || e), 'warn'); }
}

// ---------- tab / bridge ----------
async function analyticsTabId() {
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  return a && HOST_RE.test(a.url || '') ? a.id : null;
}
/** Which of a tab's frames is the Analytics application, decided by asking them.
 *
 * A plain Analytics tab has one document and it is the app. A suite shell has several, and more than
 * one can be on `analytics.zoho.<dc>` - so the frame is not chosen by position, it is **the one that
 * answers**: the bridge replies only from that origin and only with a workspace resolved out of the
 * page's own URL, so it selects itself. The CRM panel learnt this the expensive way, on a tab with
 * thirteen frames and two candidates, where taking the first the enumeration returned meant being
 * refused in a millisecond on every tick.
 *
 * `null` means «no Analytics document in this tab», which is a different fact from «it has one and
 * our bridge is not in it yet» - `_afCandidates` carries that, because conflating the two is what
 * stops the repair from ever running.
 */
let _afCandidates = { tabId: null, ids: [] };
let _afFrame = { tabId: null, frameId: 0, ts: 0 };
async function askFrame(tabId, frameId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { cmd: 'context' }, { frameId });
    return { frameId, ok: !!(r && r.ok && r.workspace), why: !r ? 'declined' : r.ok ? 'ok' : 'refused' };
  } catch (_) {
    return { frameId, ok: false, why: 'no-listener' };
  }
}
async function analyticsFrameId(tabId) {
  const now = Date.now();
  // Only a *found* frame is remembered. Recording a miss makes a transient absence last as long as
  // the memo, and a shell rebuilding its iframe is exactly a transient absence.
  if (_afFrame.tabId === tabId && _afFrame.frameId !== null && now - _afFrame.ts < 6000) return _afFrame.frameId;
  let fid = null;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true },
                                                       func: () => ({ href: location.href, top: window === window.top }) });
    const seen = (res || []).map((r) => ({ frameId: r.frameId, ...(r.result || {}) }));
    const app = seen.filter((x) => APP_HOST_RE.test(x.href || ''));
    _afCandidates = { tabId, ids: app.map((x) => x.frameId) };
    const top = app.find((x) => x.top);
    if (top) fid = top.frameId;
    else if (app.length === 1) fid = app[0].frameId;
    else if (app.length) {
      const asked = await Promise.all(_afCandidates.ids.map((f) => askFrame(tabId, f)));
      console.info(`[zoost] frames asked [${asked.map((x) => x.frameId + ':' + x.why).join(' ')}]`);
      fid = (asked.find((x) => x.ok) || {}).frameId ?? null;
    }
  } catch (_) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (APP_HOST_RE.test((t && t.url) || '')) fid = 0;
    } catch (_) {}
  }
  if (fid !== null) _afFrame = { tabId, frameId: fid, ts: now };
  return fid;
}
async function ensureBridge(tabId) {
  const fid = await analyticsFrameId(tabId);
  const to = fid === null ? {} : { frameId: fid };
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'context' }, to); return true; }
  catch {
    // Every Analytics-origin frame this tab has, not one of them: a shell builds several and only one
    // is the application, so injecting into whichever came first leaves the one that *would* answer
    // without a bridge. They are all on a host this extension declares a content script for.
    const ids = _afCandidates.tabId === tabId ? _afCandidates.ids : (fid === null ? [] : [fid]);
    if (!ids.length) return false;
    // The one recovery the "never click-and-hope" rule allows: re-inject a script we own, once.
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: ids }, files: ['content-bridge.js'] });
      console.info(`[zoost] bridge injected into [${ids.join(' ')}]`);
      await sleep(60);
      _afFrame = { tabId: null, frameId: 0, ts: 0 };   // the lookup ran before any of this existed
      return true;
    } catch (e) {
      console.info(`[zoost] bridge injection REFUSED for [${ids.join(' ')}]: ${(e && e.message) || e}`);
      return false;
    }
  }
}
async function toBridge(msg) {
  // The last line, below every disabled control and every guard above it. The panel speaks to the
  // tab that is open, so a command that is not the context probe must not travel while that tab is a
  // different workspace from the one this panel is bound to - whatever removed the `disabled`, and
  // whoever called the function directly. `context` is how the mismatch is detected in the first
  // place, so it is the one thing that always goes; and a panel with nothing bound yet is creating
  // its first workspace, which is not a mismatch.
  // `aboutTab` is the exception, and it is one command wide. «Create workspace for <id>» is the
  // control this panel *offers* to resolve a mismatch, and it needs the tab's workspace name to name
  // the folder - which is a bridge call, which this line refused. So the way out of the state was
  // refused by the guard on that state: press it and you got «nothing here reads Zoho Analytics until
  // they match», about the very act of making them match. Found by the author on the first manual
  // check of a release, in the first minute of it.
  //
  // What makes it safe to let through is not that it is a create: it is that `workspaceInfo` in the
  // bridge resolves its id from the **page's own URL** and takes nothing from the message, so it can
  // only ever describe the workspace the tab is on. There is no parameter through which another
  // workspace could be named, and a test holds both halves of that.
  const aboutTab = !!(msg && msg.aboutTab);
  if (msg && msg.cmd !== 'context' && !aboutTab && bound && !guardOk()) throw new Error(MSG.mismatchRefused);
  const id = await analyticsTabId();
  if (id == null) throw new Error('The active tab is not Zoho Analytics.');
  await ensureBridge(id);
  // The identity travels with the command and is checked *in the page that will run it* - see the
  // note in the CRM twin. Everything above is a check against a memory of which workspace the tab
  // was showing, with three awaits between reading it and arriving.
  // The same exception, one layer down: the page refuses a command whose `__zoostExpected` does not
  // match it, and the whole point here is that it does not - we are asking a tab about itself while
  // bound elsewhere. Sending the binding would have the page refuse what the panel just allowed.
  const expected = (msg && msg.cmd !== 'context' && !aboutTab && bound)
    ? { workspace: bound.workspace, origin: bound.origin } : null;
  // The Analytics frame, like the context probe. A command addressed to the whole tab reaches the
  // shell as well, and the bridge is not the only listener a page may have.
  const afid = await analyticsFrameId(id);
  const r = await chrome.tabs.sendMessage(id, expected ? { ...msg, __zoostExpected: expected } : msg,
                                          afid === null ? {} : { frameId: afid });
  if (!r) throw new Error('No answer from the Zoho Analytics page.');
  // Rebuild the Error with the two fields the reply carries, or the classification made in the
  // bridge is thrown away one line after crossing the boundary - which is how "your role does not
  // allow this" would end up displayed as a bare status code again.
  if (r.ok === false) {
    const e = new Error(r.error || 'unknown error');
    e.status = r.status || 0; e.forbidden = !!r.forbidden;
    throw e;
  }
  return r;
}

// ---------- context bar + environment guard ----------
// A workspace of invented data, written by «+ Sample» rather than pulled. It is an ordinary
// workspace in every other respect - the same list, the same walks, the same exports - and there is
// no demo *mode* anywhere: an `if (demo)` branch in rendering code is how invented data eventually
// gets shown as somebody's own. This flag exists so nothing talks to Zoho Analytics about it.
const isSample = () => !!(bound && bound.sample);
// Everything platform-bound funnels through here, so this is the one place a sample has to be
// refused - rather than a condition repeated at each button, where one is eventually forgotten.
const guardOk = () => !isSample() && !!(bound && ctx && ctx.workspace && String(ctx.workspace) === String(bound.workspace));
// The one refusal every «open this in Zoho Analytics» navigation makes. A sample workspace has no
// Zoho Analytics workspace behind it, so a link built from its id would open a URL that does not
// exist: refused with a reason rather than left to 404, because «nothing talks to the platform» has
// to be true of the navigations too, or it is not the claim the guide makes. It reads as
// `if (sampleRefuse()) return;` at each site, instead of the same string copied at both of them.
// Everything that reads or writes through Zoho asks this first, at the moment it would act. It used
// to be enough that the control was disabled or covered - which is protection by position on screen,
// and it held only until somebody put a Zoho-bound action somewhere nobody had thought about. One
// had already got out: a click on a row of the tree that is not downloaded yet fetches that function
// from Zoho, and nothing but the mismatch overlay stood in front of it. Reported as a rule rather
// than as a bug: «since Pull is disabled, everything that talks to Zoho should be».
function mismatchRefuse() {
  if (guardOk()) return false;
  status(MSG.mismatchRefused, 'warn');
  return true;
}
function sampleRefuse() {
  if (!isSample()) return false;
  status('This is the sample workspace - there is no Zoho Analytics workspace to open.', 'warn');
  return true;
}

let contextLoad = 0;
let _ctxErr = null;
async function refreshContext() {
  const mine = ++contextLoad;
  const current = () => mine === contextLoad;
  const el = $('ctx'), who = $('who'), bnd = $('bound');
  const id = await analyticsTabId();
  if (!current()) return;
  const localLbl = bound
    ? `<span class="rlbl local">Workspace</span>«${esc(bound.name || bound.workspace)}» ${esc(bound.workspace)}`
    : '<span class="rlbl local">Workspace</span><span>not bound yet</span>';

  if (id == null) {                                  // the ACTIVE tab is not Analytics
    ctx = null;
    // Not over a sample - see the note in the CRM panel: a Zoho Analytics tab is not a
    // precondition for reading invented data.
    // `sampleBusy` belongs here and not only at the click. This panel re-derives its whole state on
    // a five-second poll, so anything set imperatively on top of that is undone by the next tick -
    // reported as the overlay coming back in the middle of writing the sample and then leaving
    // again. A state that has to hold across time is a term in the condition, never an assignment.
    $('offoverlay').classList.toggle('show', !isSample() && !sampleBusy);
    $('mmbar').classList.remove('show');
    el.className = 'offzoho'; who.innerHTML = 'Not on a Zoho Analytics tab'; bnd.innerHTML = localLbl;
    return updateButtons();
  }
  $('offoverlay').classList.remove('show');
  await ensureBridge(id);
  if (!current()) return;
  const afid = await analyticsFrameId(id);
  if (!current()) return;
  try {
    // The frame, when we know which one. Broadcasting to the tab worked while there was one document
    // per tab; inside a shell it asks the shell as well, and «nobody answered» is then a statement
    // about the wrong document.
    const r = await chrome.tabs.sendMessage(id, { cmd: 'context' }, afid === null ? {} : { frameId: afid });
    if (!current()) return;
    ctx = r && r.ok ? r : null;
  } catch (e) { if (!current()) return; ctx = null; _ctxErr = (e && e.message) || String(e); }

  // The sequence, one line per tick, in the order things happened - the same record the CRM panel
  // keeps. «Not ready» is a state the panel *arrives at*, and the only account of arriving at it was
  // the words on screen, which say that it happened and nothing about why. No path is printed: a
  // path carries a workspace name and this line ends up pasted into a chat.
  console.info(`[zoost] ctx tab=${id} -> ${ctx ? (ctx.workspace ? 'ok' : 'ok, no workspace open') : 'NOT READY'
    + (_ctxErr ? ' (' + _ctxErr + ')' : '')}`);
  _ctxErr = null;

  if (!ctx) { el.className = 'offzoho'; who.innerHTML = 'Zoho Analytics tab (not ready - reload it)'; bnd.innerHTML = localLbl; }
  else if (!ctx.workspace) { el.className = 'offzoho'; who.innerHTML = '<span class="rlbl remote">Zoho Analytics tab</span><span>no workspace open</span>'; bnd.innerHTML = localLbl; }
  else {
    // True and irrelevant on a sample: the tab really is on that workspace, and this folder has
    // nothing to do with it. Two halves side by side otherwise imply a relationship there is not.
    who.innerHTML = `<span class="rlbl remote">Zoho Analytics tab</span><b>${esc(ctx.workspace)}</b>${isSample() ? '<span> · not related to the sample</span>' : ''}`;
    if (!bound) { el.className = 'unbound'; bnd.innerHTML = localLbl; }
    else if (guardOk()) { el.className = 'match'; bnd.innerHTML = localLbl + ' ✓'; }
    // Not a mismatch: the mismatch bar is for two workspaces that could match, and this one never
    // will. It says what it is instead.
    else if (isSample()) { el.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">sample - generated, never pulled</span>'; }
    else { el.className = 'mismatch'; bnd.innerHTML = localLbl + ' ✗'; }
  }

  // The mismatch bar offers the one action that resolves it, and the overlay makes it impossible to
  // browse one workspace's mirror while looking at another. Same guarantee as the CRM panel's.
  // The discrepancy is stated in both cases, the sample included: reading invented data while
  // looking at a real workspace is exactly what this bar is for. What differs is the **blocking**,
  // and only that - a real mismatch can be resolved, a sample never will be, everything
  // platform-bound is already refused for it, and blocking would make it unusable the whole time an
  // Analytics tab is open. Say it, do not stop it.
  const sampleMm = !!(bound && ctx && ctx.workspace && isSample());
  const mm = !!(bound && ctx && ctx.workspace && !guardOk() && !isSample());
  $('mmbar').classList.toggle('show', mm || sampleMm);
  $('mmbar').classList.toggle('soft', sampleMm);
  if (mm || sampleMm) {
  // **The sample is a state the user chose, and it was being announced like an accident.** Three
  // sentences on one screen said the same fact - the status line's «not related to the sample», the
  // workspace chip's «sample - generated, never pulled», and a full paragraph in the bar - and the
  // bar then offered a full-width «Create workspace for ...», which is the control the workspace row
  // already carries and has enabled in exactly this state. One fact three times, one action twice.
  //
  // What the bar alone was carrying is the *reason*: `guardOk()` is false for a sample, so Pull is
  // disabled, and nothing else on screen says why. So it keeps that and loses the rest - one line,
  // no call to action. A real mismatch is unchanged: that one is accidental, it can be resolved, and
  // the two buttons are how.
    $('mmtext').textContent = sampleMm
      ? `Sample workspace - invented data. Pulling is off: nothing here comes from workspace ${ctx.workspace}, and nothing here can reach it.`
      : `The tab is workspace ${ctx.workspace}; this folder mirrors \u00ab${wsShown(bound)}\u00bb (${bound.workspace}). Pulling is off until they match; what is already mirrored stays readable.`;
    // Two ways out, as the CRM offers: take the tab to the bound workspace, or move this panel to
    // the workspace the tab is already in - switching to it if it exists locally, creating it if not.
    // The first is meaningless for a sample: there is no Zoho Analytics workspace to switch to.
    $('mmgo').style.display = sampleMm ? 'none' : '';
    $('mmgo').textContent = `Switch tab \u2192 \u00ab${wsShown(bound)}\u00bb \u2197`;
    $('mmgo').onclick = () => switchTab();
    const match = (wsList || []).find((w) => w.id === String(ctx.workspace) && w.id !== bound.workspace);
    const sw = $('mmsw'); sw.className = 'znav'; sw.style.display = sampleMm ? 'none' : '';
    if (match) { sw.textContent = `Switch workspace \u2192 \u00ab${wsShown(match) || match.folder}\u00bb`; sw.onclick = () => { $('ws').value = match.id; selectWorkspace(match); }; }
    else { sw.textContent = `Create workspace for \u00ab${ctx.workspace}\u00bb`; sw.onclick = () => addWorkspace(); }
  }
  updateButtons();
}

// Both are a plain navigation to a URL we construct ourselves - no clicking through Zoho's UI, and
// nothing that depends on what the page happens to look like.
// Two intentions, and one helper was serving both. «Switch tab» means *this workspace's* org, where
// the workspace path is exactly right; «Go to Zoho Analytics» means the platform, and sending it to
// a workspace id is the CRM's own bug one product over - log out to sign in elsewhere and the button
// returns you to the account you just left. The host is derived from what is known and the setting
// is consulted only when nothing is.
/** The data centres, and the choice offered where the link is.
 *
 *  The destination used to be derived from whichever workspace happened to be open, on the reasoning
 *  that a data centre is a property of an account and signing out does not move it. True of one
 *  account, and false for the reader this product is most for: a consultant with clients on .eu,
 *  .com and .jp cannot have it deduced, because after signing out the next org is a choice nobody
 *  but them has made yet. Reported, and the earlier reasoning was mine and wrong.
 *
 *  So the picklist is beside the button and is always there, offering every data centre rather than
 *  the ones already mirrored - wanting to open .jp while the default is .eu is exactly the case, and
 *  a control that only offers what you have been to before cannot serve it. What it opens on is what
 *  is known: the workspace, then the tab, then the default in Settings. */
/** The data centres, derived from the manifest instead of typed.
 *
 *  It was a literal list in two places - here and the Settings form - held together by a test,
 *  which is a checker standing in for a source of truth. The manifest already *is* that source:
 *  a host this extension cannot reach is not a destination it may offer, and one it can reach is.
 *  Adding a data centre is then one edit, in the file that has to change anyway.
 *
 *  Measured while asking whether the list was complete, and it is not: Zoho answers on
 *  zoho.sa, zoho.uk, zoho.ae and zoho.com.cn with the same shape as the six here, and neither
 *  manifest grants them. That is a permissions change and is not made in passing. */
const DCS = [...new Set((chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => h.startsWith('https://analytics.'))
  .map((h) => h.slice('https://analytics.'.length).replace(/\/.*$/, '')))].sort();
const dcOf = (origin) => (String(origin || '').match(/^https:\/\/[^.]+\.(.+)$/) || [])[1] || null;
function renderGoDc() {
  const sel = $('gozohodc'); if (!sel) return;
  const want = sel.dataset.touched ? sel.value
    : (dcOf(bound && bound.origin) || dcOf(ctx && ctx.origin) || zohoDc);
  if (sel.options.length !== DCS.length) {
    sel.innerHTML = DCS.map((d) => `<option value="${escA(d)}">${esc(d)}</option>`).join('');
  }
  sel.value = DCS.includes(want) ? want : DCS[0];
}
const homeUrl = () => {
  const dc = ($('gozohodc') && $('gozohodc').value)
    || dcOf(bound && bound.origin) || dcOf(ctx && ctx.origin) || zohoDc;
  return `https://analytics.${dc}/`;
};
// Where a view lives in Zoho Analytics. One shape for everything - a table, a query table, a report,
// a dashboard - read out of the address bar rather than guessed at:
//   https://analytics.<dc>/workspace/<workspace id>/view/<view id>
// Built from what the mirror already knows, which is what makes it a navigation and not a search:
// no synthetic clicks, nothing that depends on Zoho's markup or on the interface language. The
// origin is the workspace's own, so a panel bound to one workspace opens that one's views even while
// the tab is somewhere else.
function viewUrl(id) {
  if (!bound || !bound.origin || !bound.workspace || !id) return null;
  return `${bound.origin}/workspace/${bound.workspace}/view/${encodeURIComponent(String(id))}`;
}
const workspaceUrl = () => (bound && bound.origin && bound.workspace
  ? `${bound.origin}/workspace/${bound.workspace}` : homeUrl());
/** Take the reader to a page of their Zoho Analytics, without taking their shell away.
 *
 * A tab is a tree of documents. On a plain Analytics tab there is one and it is the app; inside a
 * suite shell the app is a frame and the *tab* is the shell, so navigating the tab throws away the
 * shell the reader was working in. Frame 0 is the tab's own document, so this navigates the tab
 * there and one path serves both. A refused injection falls back to the tab, which is where this
 * started.
 */
// **Nothing navigates anywhere this extension is not allowed to be.** «Open in Zoho» builds its URL
// from `bound.origin`, and `bound` is `.zoost.json` - a file on disk, in a folder the user may have
// been given rather than made. The pull compares that origin against the tab; no navigation asked
// anything, so a workspace received from somebody else could point a control labelled with Zoho's
// name at any origin, inside the user's own Zoho frame. Written the same way in the twin.
//
// The check is here and not at the call sites, so one added tomorrow inherits it. `APP_HOST_RE` is
// the application's own origin: a workspace URL that is not on it is not a workspace URL.
// The application's own hosts, exactly, out of `host_permissions` - not a prefix. A prefix test lets
// `https://analytics.zoho.eu.evil.com/` through, which is the whole point of the check.
const APP_HOSTS = new Set((chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => /^https:\/\/analytics\./.test(h))
  .map((h) => { try { return new URL(h.replace(/\*$/, '')).host; } catch (_) { return null; } })
  .filter(Boolean));
function zohoUrlOk(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && APP_HOSTS.has(u.host);
  } catch (_) { return false; }
}
async function goToZoho(url) {
  if (!zohoUrlOk(url)) {
    status('This workspace points at ' + (((url || '').match(/^https?:\/\/[^/]+/) || [])[0] || 'somewhere')
      + ', which is not a Zoho Analytics address. Nothing was opened - check where this workspace folder came from.', 'bad');
    return null;
  }
  const id = await analyticsTabId();
  if (!id) { const t = await chrome.tabs.create({ url, active: true }); return t.id; }
  const fid = await analyticsFrameId(id);
  if (fid) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [fid] },
                                             func: (u) => { location.href = u; }, args: [url] });
      await chrome.tabs.update(id, { active: true });
      return id;
    } catch (_) { /* fall through to the tab */ }
  }
  await chrome.tabs.update(id, { url, active: true });
  return id;
}
async function switchTab() {
  if (sampleRefuse()) return;
  await goToZoho(workspaceUrl());
}
/** The way *in*, and deliberately the tab rather than a frame: this is the control for when there is
 *  no context at all, and a reader who presses it is asking to go to Zoho Analytics, not to move a
 *  frame inside a page they may not be on. The CRM's own home button is the same. */
async function openZohoHome() {
  if (sampleRefuse()) return;
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = homeUrl();
  if (a && HOST_RE.test(a.url || '')) await chrome.tabs.update(a.id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
}

function updateButtons() {
  renderGoDc();                      // the list it offers is the workspaces, so it moves with them
  $('ws').disabled = pullBusy;
  $('wsroot').disabled = pullBusy;
  // Same rule as the CRM panel, and the same reason. Analytics had no such check at all: it left
  // the button offering to "create" a workspace that already existed, and reopened the same folder.
  // Harmless, and still a control saying it will do something it will not.
  const known = (wsList || []).some((w) => ctx && ctx.workspace && String(w.id) === String(ctx.workspace));
  $('wsadd').hidden = known;
  // Absent once one exists, and the overlay's copy says which of the two it will do. Both are
  // decided in one place, because they were decided in two and disagreed.
  updateSampleButtons();
  $('wsadd').disabled = pullBusy || busy || !root || !rootGranted || !ctx || !ctx.workspace;
  $('wsdel').disabled = pullBusy || busy || !dir || !wsList.length;
  $('wsrename').disabled = pullBusy || busy || !dir || !wsList.length;
  // Why each is grey, in the order the states block each other - the same order `emptyReason()`
  // walks, because a control and the empty state under it must not name different blockers. `Pull`
  // has said this since it was written; these three went grey with nothing on them, which is a dead
  // end the reader cannot act on. The strip of detail tabs learnt the same thing this morning.
  // The reasons, once. Six controls in this function are switched off by the same two facts, and
  // writing them out per control is how a message drifts from its twin - the duplicate-message check
  // caught exactly that here, on the pair I had just written.
  const BUSY = 'the panel is busy';
  const UNREAD = 'nothing has been read from this workspace yet - press Pull all';
  const wsWhy = pullBusy ? 'a pull is running'
    : busy ? 'the panel is busy'
      : !root ? 'no working folder yet - press the folder button'
        : !rootGranted ? 'folder access is not granted - press Grant access'
          : null;
  $('wsadd').title = !$('wsadd').disabled ? 'Create a workspace for the one in the active tab'
    : `Cannot create a workspace: ${wsWhy || 'the active tab is not on a Zoho Analytics workspace'}`;
  // Written out rather than looped: the check that holds this rule reads `$('id').title`, and a loop
  // over the ids hides it from the one thing that keeps it true. Two buttons, two lines.
  $('wsdel').title = !$('wsdel').disabled ? 'Remove this workspace from the folder'
    : `Cannot remove a workspace: ${wsWhy || 'none is selected'}`;
  $('wsrename').title = !$('wsrename').disabled ? 'Give this workspace a name of your own'
    : `Cannot name a workspace: ${wsWhy || 'none is selected'}`;
  $('pull').disabled = busy || !dir || !guardOk();
  // Absent, not disabled, when there is nothing to retry - the CRM's equivalent does the same.
  // A greyed button still says "there is something here you cannot have", which is misleading
  // when there is no something. The label carries the count, so the button is self-explaining.
  const rb = $('retry');
  rb.style.display = pullFailed.length ? '' : 'none';
  rb.textContent = `Retry ${pullFailed.length} failed`;
  rb.disabled = busy || !dir || !guardOk();
  $('refresh').disabled = busy || (!dir && !(root && !rootGranted));
  $('refresh').title = !$('refresh').disabled ? 'Read every file in this workspace again'
    : busy ? 'Cannot refresh: the panel is busy'
      : 'Cannot refresh: no workspace is open, and the folder access is not waiting to be granted';
  const loaded = views.length > 0;
  $('export').disabled = busy || !loaded;
  $('export').title = !$('export').disabled ? 'Export this workspace as a self-contained file'
    : `Cannot export: ${busy ? BUSY : UNREAD}`;
  $('exportmd').disabled = busy || !loaded;
  $('exportmd').title = !$('exportmd').disabled ? 'Export this workspace as context for an AI tool'
    : `Cannot export: ${busy ? BUSY : UNREAD}`;
  $('graph').disabled = busy || !Object.keys(schema).length;
  $('graph').title = !$('graph').disabled ? 'Open the ER diagram in its own window'
    : `Cannot draw: ${busy ? BUSY : 'no table structure has been read yet - press Pull all'}`;
  $('health').disabled = busy || !loaded;
  $('health').title = !$('health').disabled ? 'What nothing depends on, and what is unused'
    : `Cannot audit: ${busy ? BUSY : UNREAD}`;
  $('askai').disabled = busy || !loaded;
  $('askai').title = !$('askai').disabled ? 'Ask about this workspace'
    : `Cannot ask: ${busy ? BUSY : UNREAD}`;
  // Back to the button's own title, never to nothing. This wrote '' on every state refresh, which
  // was survivable while the button said "Pull all" and is not now that it is a mark: the tooltip is
  // where the name lives. A control that loses its name on the first repaint has no name.
  $('pull').title = $('pull').disabled && dir && ctx && ctx.workspace && !guardOk()
    ? 'The active tab is a different workspace from the one selected here.'
    : PULL_TITLE;
}
function setBusy(on, text) {
  busy = on;
  // `null` means «leave the status line alone»: the caller has already put the right sentence there
  // and «Ready.» would be a lie over it. One path did exactly that - see refreshLocal().
  if (text !== null) status(text || (on ? 'Working…' : 'Ready.'), on ? 'busy' : '');
  updateButtons();
}
function setPullBusy(on) {
  pullDepth = Math.max(0, pullDepth + (on ? 1 : -1));
  pullBusy = pullDepth > 0;
  updateButtons();
}
function workspaceChangeRefuse() {
  if (!pullBusy) return false;
  $('ws').value = bound ? bound.workspace : '';
  status('Pull in progress - workspace unchanged.', 'warn');
  updateButtons();
  return true;
}

// An operation that has been overtaken stops - and stopping must not leave the panel it is no longer
// in looking like something is running there. It says nothing: the workspace on screen has just been
// loaded and has already said what it has to say, and a sentence about the org you left is noise at
// best. Only the busy state, which is what greys the buttons, is put down.
function endBusyElsewhere() { busy = false; updateButtons(); }

function refuseIncompleteSnapshot() {
  views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; viewsPulledAt = null; pullFailed = [];
  sqlCache = null; sqlUnread = 0; sqlDiskUnread.clear();
  // The same state `loadFromDisk` sets when it finds the marker on disk, and it was set there only:
  // three catch blocks reach this function, and after them the empty list fell through to «Nothing
  // pulled yet. Press Pull all» while the status line one row above said the pull had been
  // interrupted mid-write. Two surfaces, two explanations, and the list's was the false one.
  //
  // Wiring one of four call sites is the defect this repository asks about in its own second
  // question - «who else owns this flag?» - applied to a flag I had just added.
  pullInterrupted = true;
  diskUnreadable = null;   // it is not an unreadable file; naming one would send the reader to fix it
  render();
}

// ---------- pull ----------
async function pullAll() {
  if (pullBusy) return;
  const op = beginWorkspaceOp();   // the workspace this pull belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  const onProgress = (m) => { if (m?.type === 'pullProgress') op.say(`Pulling ${m.stage}… ${m.done} / ${m.total}`, 'busy'); };
  chrome.runtime.onMessage.addListener(onProgress);
  setPullBusy(true);
  setBusy(true, 'Pulling…');
  try {
    await requirePerm(op.root);
    setBusy(true, 'Reading the workspace…');
    const info = await toBridge({ cmd: 'workspaceInfo' });

    // Built whole, published whole. The four stages used to land in the globals one by one, so a
    // stage that failed left the panel holding the new views over the old schema - a photograph of
    // two different moments, on screen and in every export until the next successful pull.
    // Reproduced by an outside scan with `workspaceErd` failing after `listViews`.
    setBusy(true, 'Reading the view list…');
    const vl = await toBridge({ cmd: 'listViews' });
    if (!op.current()) return endBusyElsewhere();   // the answer describes the workspace we were in, not this one

    setBusy(true, 'Reading structure and relations…');
    const sc = await toBridge({ cmd: 'workspaceErd' });
    if (!op.current()) return endBusyElsewhere();

    const nextViews = vl.views || [];
    const qIds = nextViews.filter((v) => v.type === 'QueryTable').map((v) => v.id);
    setBusy(true, `Reading SQL… 0 / ${qIds.length}`);
    const sq = await toBridge({ cmd: 'pullSql', ids: qIds });
    if (!op.current()) return endBusyElsewhere();

    const allIds = nextViews.map((v) => v.id);
    setBusy(true, `Reading lineage… 0 / ${allIds.length}`);
    const dp = await toBridge({ cmd: 'scanDependencies', ids: allIds });
    if (!op.current()) return endBusyElsewhere();

    // The stage travels with each failure: «could not read» means nothing actionable until it says
    // which half - and sqlState() tells an unread query from an absent one by exactly this field.
    const next = {
      views: nextViews, folders: vl.folders || [],
      schema: sc.tables || {}, relations: sc.relations || [],
      sqls: sq.sql || {}, deps: dp.deps || {},
      pullFailed: [].concat((sq.failed || []).map((f) => ({ ...f, stage: 'sql' })),
                            (dp.failed || []).map((f) => ({ ...f, stage: 'lineage' }))),
    };
    if (!(await writeToDisk(info, op, next))) return endBusyElsewhere();
    ({ views, folders, schema, relations, sqls, deps, pullFailed } = next);
    mergeSchemaIntoViews();

    const orphans = views.filter(isOrphanCandidate).length;
    const cols = Object.values(schema).reduce((n, t) => n + t.columns.length, 0);
    setBusy(false, `${views.length} views · ${Object.keys(schema).length} tables · ${cols} columns · ${relations.length} relations · ${qIds.length} SQL · ${orphans} nothing depends on`
      + (pullFailed.length ? ` · ${pullFailed.length} could not be read` : '')
      + (next.cleanupFailed ? ` · ${next.cleanupFailed} old SQL file(s) could not be removed - the next pull retries` : ''));
    $('status').className = (pullFailed.length || next.cleanupFailed) ? 'warn' : 'ok';
    render();
  } catch (e) {
    // Once the `writing` marker landed, the files on disk may be from two moments. Keeping the old
    // globals alive in this same panel let exports and the assistant combine that old snapshot with
    // whichever SQL files had already been replaced. Refuse it immediately, not only after reopen.
    const interrupted = !!(e && e.mirrorIncomplete && op.current());
    if (interrupted) refuseIncompleteSnapshot();
    // A refusal is not a fault, and saying "Pull failed: 403" for one sends the user looking for a
    // bug in Zoost instead of to whoever administers their Analytics roles.
    setBusy(false, interrupted
      ? 'Pull was interrupted while writing. The mirror is blocked because its files describe two different moments - run Pull all to repair it.'
      : e && e.forbidden
      ? `Your Zoho Analytics role does not grant access to this workspace${e.status ? ` (Zoho Analytics answered ${e.status})` : ''}. Nothing was written - what is on disk is unchanged.`
      // Through `friendlyError`, which exists for exactly this and was used on three paths, none of
      // them the one that runs longest. A pull is minutes of network work, and Chrome lets the
      // folder permission lapse while it runs: the last stage then threw
      // `NotAllowedError: The request is not allowed by the user agent…` and the panel printed it
      // whole - a platform sentence naming neither the folder nor the button that fixes it, at the
      // end of a long wait. Reported from a real workspace, which is the only place the wait is
      // long enough. Nothing was written when it happens here: the marker is the first thing the
      // write stage does, so a refusal at that moment leaves the previous snapshot intact.
      : 'Pull failed: ' + friendlyError(e));
    $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
    setPullBusy(false);
  }
}

// A pull has two very different kinds of failure, and conflating them would be dishonest.
//
//   - **A stage fails.** The view list, the structure or the ER model is one call each: if it does
//     not answer there is no partial answer to keep, so the pull stops and nothing is written. What
//     was on disk before is left exactly as it was.
//   - **An item fails.** SQL and lineage are one call per view. One unreadable view must not cost
//     the other four hundred, so those are collected into `pullFailed`, the pull finishes, and the
//     panel says how many were missed. The mirror is written *with the gap declared* rather than
//     silently short.
//
// Both are recoverable without re-downloading the workspace: `retryFailed()` re-reads exactly the
// items that failed, and `pullOne()` re-reads a single view from its detail pane.
async function pullOne(id) {
  if (pullBusy) return;
  const op = beginWorkspaceOp();   // the workspace this re-read belongs to
  // `pullSql` reports a *per-item* failure in `failed` and does not throw: this read the ids it had
  // asked for out of `pullFailed` regardless and finished ««Q1» re-read.», so a view whose SQL is
  // still the old file - or absent - stopped being marked as incomplete. The panel, the export and
  // the assistant then treat it as whole. Same shape as every «did not read» in the CRM: an answer
  // that did not arrive is not an answer that says nothing is there.
  const still = [];
  if (mismatchRefuse()) return;
  const v = viewById().get(id);
  if (!v) return;
  setPullBusy(true);
  setBusy(true, `Re-reading «${v.name}»…`);
  try {
    await requirePerm(op.root);
    const nextSqls = { ...sqls };
    const nextDeps = { ...(deps || {}) };
    if (v.type === 'QueryTable') {
      const r = await toBridge({ cmd: 'pullSql', ids: [id] });
      if (!op.current()) return endBusyElsewhere();
      if (r.sql && r.sql[id]) nextSqls[id] = r.sql[id];
      still.push(...(r.failed || []).map((f) => ({ ...f, stage: 'sql' })));
    }
    const d = await toBridge({ cmd: 'viewDependencies', id });
    if (!op.current()) return endBusyElsewhere();
    nextDeps[id] = { id: d.id, parents: d.parents, children: d.children, dashboards: d.dashboards };
    // Only this item's old report goes, and only if this pull actually replaced it.
    const nextFailed = pullFailed.filter((f) => String(f.id) !== String(id)).concat(still);
    await writePartialSnapshot(op, { sqls: nextSqls, deps: nextDeps, pullFailed: nextFailed });
    if (!op.current()) return endBusyElsewhere();
    ({ sqls, deps, pullFailed } = { sqls: nextSqls, deps: nextDeps, pullFailed: nextFailed });
    setBusy(false, still.length ? `«${v.name}»: lineage re-read, its SQL still could not be.` : `«${v.name}» re-read.`);
    $('status').className = still.length ? 'warn' : 'ok';
    render(); await openDetail(id);
  } catch (e) {
    const interrupted = !!(e && e.mirrorIncomplete && op.current());
    if (interrupted) refuseIncompleteSnapshot();
    setBusy(false, interrupted
      ? `Could not finish writing «${v.name}». The mirror is blocked because its files describe two different moments - run Pull all to repair it.`
      : `Could not re-read «${v.name}»: ` + friendlyError(e));
    $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
  } finally { setPullBusy(false); }
}

async function retryFailed() {
  if (pullBusy) return;
  const op = beginWorkspaceOp();   // the workspace these items belong to
  if (mismatchRefuse()) return;
  const ids = [...new Set(pullFailed.map((f) => f.id))];
  if (!ids.length) return;
  const onProgress = (m) => { if (m?.type === 'pullProgress') op.say(`Retrying ${m.stage}… ${m.done} / ${m.total}`, 'busy'); };
  chrome.runtime.onMessage.addListener(onProgress);
  setPullBusy(true);
  setBusy(true, `Retrying ${ids.length} item(s)…`);
  try {
    await requirePerm(op.root);
    const nextSqls = { ...sqls };
    const nextDeps = { ...(deps || {}) };
    const qIds = ids.filter((i) => { const v = viewById().get(i); return v && v.type === 'QueryTable'; });
    const still = [];
    if (qIds.length) {
      const r = await toBridge({ cmd: 'pullSql', ids: qIds });
      // The sibling branch below said `return endBusyElsewhere()` and this one said `return`, so a
      // switch during the SQL half left Pull, Refresh, export, the diagram, Health and the assistant
      // disabled until the panel was reopened. The `finally` removes the listener and knows nothing
      // about `busy`.
      if (!op.current()) return endBusyElsewhere();
      Object.assign(nextSqls, r.sql || {});
      still.push(...(r.failed || []).map((f) => ({ ...f, stage: 'sql' })));
    }
    const r2 = await toBridge({ cmd: 'scanDependencies', ids });
    // Before the model is touched, not only before the disk is: these ids belong to the workspace
    // this retry started in, and merging them into another one's memory is the same defect indoors.
    if (!op.current()) return endBusyElsewhere();
    Object.assign(nextDeps, r2.deps || {}); still.push(...(r2.failed || []).map((f) => ({ ...f, stage: 'lineage' })));
    await writePartialSnapshot(op, { sqls: nextSqls, deps: nextDeps, pullFailed: still });
    if (!op.current()) return endBusyElsewhere();
    ({ sqls, deps, pullFailed } = { sqls: nextSqls, deps: nextDeps, pullFailed: still });
    mergeSchemaIntoViews();
    setBusy(false, pullFailed.length ? `${pullFailed.length} still unreadable.` : 'All previously failed items are now in.');
    $('status').className = pullFailed.length ? 'warn' : 'ok';
    render();
  } catch (e) {
    const interrupted = !!(e && e.mirrorIncomplete && op.current());
    if (interrupted) refuseIncompleteSnapshot();
    setBusy(false, interrupted
      ? 'Retry could not finish writing. The mirror is blocked because its files describe two different moments - run Pull all to repair it.'
      : 'Retry failed: ' + friendlyError(e)); $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
  } finally { chrome.runtime.onMessage.removeListener(onProgress); setPullBusy(false); }
}

// Split out so a single-item refresh rewrites only what it touched, instead of the whole mirror.
async function writeLineage(op, nextDeps = deps, nextFailed = pullFailed) {
  if (!op || !op.current()) return;
  await writeJson('lineage.json', { workspace: bound && bound.workspace, deps: nextDeps, failed: nextFailed }, op);
}
async function writeSql(op, nextSqls = sqls) {
  if (!op || !op.current()) return;
  let unreadable = null;
  const index = await readJson('sql/index.json', {}, op, (failure) => { unreadable = failure; });
  if (unreadable) throw new Error(`Could not read ${unreadable.rel} (${unreadable.name}).`);
  for (const [id, q] of Object.entries(nextSqls)) {
    if (typeof q.sql !== 'string') continue;              // not re-read this session; its file is current
    const v = viewById().get(id);
    const stem = q.stem || stemOf(v ? v.name : id, id);
    await op.write(`sql/${stem}.sql`, q.sql);
    index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
  }
  await writeJson('sql/index.json', index, op);
}

/** A one-view refresh still changes several files. Keep the old in-memory model until all of them
 *  are durable, and bracket the disk writes with the same marker as Pull all. If any write fails,
 *  loadFromDisk() and this live panel both refuse the hybrid instead of presenting it as a snapshot. */
async function writePartialSnapshot(op, next) {
  await op.write(PULL_STATE, JSON.stringify({ state: 'writing', startedAt: new Date().toISOString() }));
  try {
    await writeLineage(op, next.deps, next.pullFailed);
    await writeSql(op, next.sqls);
    await op.write(PULL_STATE, JSON.stringify({ state: 'complete', completedAt: new Date().toISOString() }));
  } catch (e) {
    try { e.mirrorIncomplete = true; } catch (_) {}
    throw e;
  }
}

/** Remove the .sql files the new index no longer names - a deleted query's file, and the old stem
 *  of a renamed one. Without this they accumulated silently, and once the index was replaced there
 *  was no map left to even say which were residue. Runs only after the new files and the new index
 *  are written; a removal that fails stays for the next pull, which derives the same keep-set and
 *  retries for free. */
async function pruneSql(index, op, census) {
  // **What the workspace has, not what this pull could read.** The keep-set was the new index alone,
  // and a query table is only in that index if its SQL came back *this time* - so a workspace where
  // 60 of 200 queries answered 429 lost 60 previously-good .sql files in one pull, in the folder the
  // reader keeps under git. «Could not be read» is not «no longer exists», and this is the one place
  // in the product where confusing them destroys something. Found by a review of this file, under
  // the fifth of the six questions: does partial data authorise a destructive act?
  //
  // The CRM twin has always drawn the line here - it prunes from the census `listFunctions` returns,
  // and refuses to prune at all when that list came back capped - and this is the same rule: a view
  // that is still a query table in the workspace keeps its file, whatever happened to it today. Its
  // *index row* is still absent, so nothing serves yesterday's SQL as if it were current: the panel
  // says «not read», which is true, and the file survives for the next pull and for the diff.
  // Required, and it used to carry `= []`. An empty default turns the whole argument above into a
  // suggestion: drop it at the one call site and the keep-set is the index alone again, which is the
  // data loss this parameter exists to prevent - proven by doing exactly that and watching every
  // test and every checker stay green. Refusing is the only safe direction: a prune that cannot say
  // what the workspace still has must not decide what it no longer has.
  if (!Array.isArray(census)) {
    throw new Error('pruneSql needs the census of query tables the workspace still has - without it '
                    + 'the keep-set is only what was read this time, and a query whose SQL failed '
                    + 'would lose its file.');
  }
  const keep = new Set(Object.values(index).map((e) => `sql/${e.stem}.sql`));
  for (const v of census) keep.add(`sql/${stemOf(v.name, v.id)}.sql`);
  let failed = 0;
  for await (const p of walk(op.root)) {
    if (!/^sql\/[^/]+\.sql$/.test(p) || keep.has(p)) continue;
    try { await op.remove(p); }
    catch (e) {
      if ((e && e.message) === WS_MOVED) throw e;
      failed++;
    }
  }
  if (failed) op.say(`${failed} old .sql file(s) could not be removed - the next pull will retry.`, 'warn');
  return failed;
}
async function writeToDisk(info, op, next) {
  // The snapshot arrives as an argument and the globals are untouched until every write has landed:
  // this used to read the globals, which pullAll had already replaced stage by stage.
  //
  // The marker brackets the writes. Five files written in sequence cannot be atomic on this API, so
  // the next best thing is a mirror that *knows* it is mid-write: `.pull-state.json` says `writing`
  // until the last byte is out, and a load that finds it still saying so refuses the snapshot
  // instead of presenting files from two different moments as one. An interrupted pull is repaired
  // by running Pull all again, and the message says exactly that.
  const { views, folders, schema, relations, sqls, deps, pullFailed } = next;
  // Everything below this line is disk, and disk was the one stage of a pull that said nothing. The
  // reading stages each announce themselves and count; then the last one closed with «Reading
  // lineage... 50 / 50» and that line sat there through three JSON files, one .sql per query table
  // and a prune - which on a real workspace is hundreds of writes and takes long enough to read as a
  // hang. Reported as: the process looks stuck, so show what else is going on. A stage that is silent
  // is indistinguishable from a stage that is stuck - which is a rule this repository already holds
  // for its own tools, and had not applied to the one place the panel spends the longest.
  op.say('Writing the mirror\u2026', 'busy');
  await op.write(PULL_STATE, JSON.stringify({ state: 'writing', startedAt: new Date().toISOString() }));
  try {
    await writeJson('views.json', { workspace: info.workspace, pulledAt: new Date().toISOString(), folders, views }, op);
    await writeJson('schema.json', { workspace: info.workspace, tables: schema, relations }, op);
    await writeJson('lineage.json', { workspace: info.workspace, deps, failed: pullFailed }, op);
    // One .sql per query table, so the workspace is diffable in git - that is the whole point of the
    // mirror. The index keeps the id-to-file mapping and the column-level lineage beside it.
    const index = {};
    // Counted like every reading stage, and for the same reason: one file per query table is the
    // longest thing this function does, and «0 / 240» moving is the difference between working and
    // hung. Said every ten so the line does not flicker on a small workspace.
    const total = Object.keys(sqls).length;
    let written = 0;
    for (const [id, q] of Object.entries(sqls)) {
      const v = views.find((x) => x.id === id);
      const stem = stemOf(v ? v.name : id, id);
      await op.write(`sql/${stem}.sql`, typeof q.sql === 'string' ? q.sql : '');
      index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
      if (++written % 10 === 0 || written === total) op.say(`Writing SQL files\u2026 ${written} / ${total}`, 'busy');
    }
    await writeJson('sql/index.json', index, op);
    op.say('Removing what the workspace no longer has\u2026', 'busy');
    next.cleanupFailed = await pruneSql(index, op, views.filter((v) => v.type === 'QueryTable'));
    op.say('Finishing the mirror\u2026', 'busy');
    await op.write(PULL_STATE, JSON.stringify({ state: 'complete', completedAt: new Date().toISOString() }));
  } catch (e) {
    // The marker was written successfully, so any failure from here to `complete` means the disk is
    // not a snapshot. Carry that fact to pullAll; an ordinary Error message cannot distinguish it
    // from an API failure that happened before the first byte was touched.
    try { e.mirrorIncomplete = true; } catch (_) {}
    throw e;
  }
  await patchCfg({
    workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV,
    lastPull: new Date().toISOString(),
    counts: { views: views.length, folders: folders.length, tables: Object.keys(schema).length, relations: relations.length, sql: Object.keys(sqls).length },
  }, op);
  // Read once, through the op, and asked again before publishing: this is the panel's memory of which
  // workspace it is showing. Reproduced as a binding half from each - `workspace: A, label: B` - by
  // switching during the last write, which is the shape a mirror can never recover from by itself.
  // The two reads were also two reads of the same file for two fields.
  const cfg = await readJson(CFG, {}, op);
  if (!op.current()) return false;
  bound = { workspace: info.workspace, name: info.name, origin: info.origin,
            label: cfg.label || '', sample: !!cfg.sample, lastPull: cfg.lastPull || null,
            sv: Number(cfg.sv || 0) };
  return true;
}

// Which workspace we are in, as a number that only moves forward. Same reason as the CRM panel: an
// operation captures it once and every effect after an `await` asks whether it is still where it
// started. Reported there and reproduced here - a re-read begun in one workspace wrote its lineage
// and its SQL into the next.
let wsGen = 0;

// Four files, read one after another, each resolved against whatever folder was current at that
// moment - and published into the globals as they arrived. Two selections overlapping produced a
// panel bound to one workspace, showing the other's view list, with the first one's schema: a state
// no single file on disk can explain and nothing on screen can reveal. One operation, one snapshot,
// one publication.
async function loadFromDisk(op = beginWorkspaceOp()) {
  // A mirror whose last full pull never finished is five files from two moments. The marker is the
  // only thing that can say so; without this check the loader presented the hybrid as one snapshot.
  const ps = await readJson(PULL_STATE, null, op);
  if (ps && ps.state === 'writing') {
    if (!op.current()) return false;
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; viewsPulledAt = null; pullFailed = [];
    pullInterrupted = true;
    render();
    status('The last pull was interrupted mid-write, so the files on disk describe two different moments - run Pull all to repair the mirror.', 'warn');
    return false;
  }
  let failed = null;
  const noteFailure = (f) => { failed = failed || f; };
  const readOne = (rel) => readJson(rel, null, op, noteFailure);
  const v = await readOne('views.json');
  viewsPulledAt = (v && v.pulledAt) || null;
  const s = await readOne('schema.json');
  const l = await readOne('lineage.json');
  const index = await readOne('sql/index.json');
  if (!op.current()) return false;
  views = (v && v.views) || []; folders = (v && v.folders) || [];
  schema = (s && s.tables) || {}; relations = (s && s.relations) || [];
  deps = l && l.deps ? l.deps : null; pullFailed = (l && l.failed) || [];
  sqls = {};
  sqlCache = null; sqlUnread = 0; sqlDiskUnread.clear();
  if (searchMode === 'sql') {
    searchMode = 'name';
    $('smode').textContent = 'in: names';
    $('smode').classList.remove('on');
    $('find').placeholder = 'Find\u2026';
    $('rxmode').style.display = $('rxpick').style.display = 'none';
    $('rxmenu').classList.remove('show');
  }
  if (regexMode) { regexMode = false; $('rxmode').classList.remove('on'); }
  if (index) for (const [id, e] of Object.entries(index)) sqls[id] = { id, sql: null, stem: e.stem, parents: e.parents || [], sources: e.sources || {} };
  mergeSchemaIntoViews();
  diskUnreadable = views.length ? null : failed;
  pullInterrupted = false;
  // Another workspace on disk: the chain is dropped, because every step in it is a view id that
  // belongs to the one being left. This and the removal below are the only places that forget.
  selectedId = null; navClear(); $('detail').classList.remove('show'); $('resizer').classList.remove('show');
  render();
  // And whether the schema that wrote it is the one this build reads - stated, not acted on: a mirror
  // from an older Zoost is still every fact it captured, and what to do about that is the reader's.
  if (views.length) status(`${views.length} views loaded from disk${v && v.pulledAt ? ' · pulled ' + v.pulledAt.slice(0, 10) : ''}`
    + `${mirrorIsOlderThanSchema() ? ' · written by an older Zoost - Pull all captures what this one reads' : ''}.`, '');
  return true;
}

// "Empty" and "unreadable" are different facts and were the same message: every surface wrote
// `body || 'could not be read'`, and an empty string is falsy. So a query Analytics returned empty -
// or one whose file was written empty by the bug above - was reported as never having been read,
// which sent the assistant off reconstructing SQL it could simply have been told was absent.
//   null  → the file is not there or could not be opened
//   ''    → Analytics answered with an empty query
const SQL_UNREADABLE = '(the .sql file could not be read - use Pull on this view to fetch it again)';
const SQL_EMPTY = '(Zoho Analytics returned this query table with no SQL text at all)';
const sqlText = (body) => (body == null ? SQL_UNREADABLE : (body.trim() ? body : SQL_EMPTY));

// SQL bodies are not held in memory after a reload - they are read from their file on demand, which
// is also what keeps a large workspace from sitting in the panel's heap.
async function sqlBodyOf(id, op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  const q = sqls[id];
  if (!q) return null;
  if (typeof q.sql === 'string') { sqlDiskUnread.delete(String(id)); return q.sql; }
  let body = null, failed = false;
  try { body = await op.read(`sql/${q.stem}.sql`); } catch (_) { failed = true; }
  if (!op.current() || sqls[id] !== q) return null;
  if (failed) sqlDiskUnread.add(String(id)); else sqlDiskUnread.delete(String(id));
  q.sql = body;
  return body;
}

/** Resolve the state that needs the file as well as the index. `sqlState()` can say that a query
 *  is represented in `sql/index.json`; only this asynchronous half can say that the represented
 *  `.sql` file still opens. Keeping the distinction in one helper prevents search, exports and the
 *  assistant from each inventing a different meaning for `q.sql === null`. */
async function sqlReadState(id, op = beginWorkspaceOp()) {
  const st = sqlState(id);
  // A disk error is an observation, not a permanent verdict: permissions, a cloud-backed folder or
  // an external repair may make the same file readable on the next request. Pull failures and a
  // genuinely absent index entry cannot be repaired by opening the old file, so only the former is
  // retried here.
  const retryDisk = st.kind === 'unread' && sqlDiskUnread.has(String(id)) && !!sqls[id];
  if (st.kind !== 'read' && !retryDisk) return st;
  const body = await sqlBodyOf(id, op);
  if (body == null) return { kind: 'unread', error: 'the .sql file could not be read' };
  return { kind: 'read', query: sqls[id], body };
}

// ---------- derived ----------
// A candidate, not a verdict. Analytics knows what its own views read from each other; it does not
// know about a shared link someone bookmarked, a scheduled export, an embedded report or an API
// consumer. Every surface says "candidate" for that reason.
function isOrphanCandidate(v) {
  if (!deps) return false;
  const d = deps[v.id];
  if (!d) return false;                        // unread → not claimed either way
  if (v.type === 'Dashboard') return false;    // a dashboard is consumed by people, not by views
  return d.children.length === 0 && d.dashboards.length === 0;
}
// The ER endpoint carries `lastModTime`, epoch milliseconds, which matched LAST_DESIGN_MODIFY on
// every one of the 135 objects it describes. It is copied onto the views so the Design column can
// sort - but only Tables and QueryTables have it. Presentation views still only have Zoho's
// localized text, which is shown verbatim and never parsed, so they sort last and the note says so.
function mergeSchemaIntoViews() {
  for (const v of views) {
    const t = schema[v.id];
    v.designModifiedAt = t ? t.designModifiedAt : null;
    v.system = t ? !!t.system : false;
  }
}

// Foreign keys, per column, derived from the ER model's links. Not inferred: the bridge resolves
// each link's column indices to names, and rebuilding "(A.col)=(B.col)" from the pair reproduces
// Zoho's own `relationstring` exactly, on every link in the workspace this was measured on.
//
//   out - this column points at another table  (the classic foreign key)
//   in  - another table's column points at this one
//
// Returned keyed by column name so the columns table can annotate a row without searching.
function foreignKeys(viewId) {
  const out = new Map(), inc = new Map();
  for (const r of relations) {
    if (r.source === viewId) {
      r.sourceColumns.forEach((c, i) => {
        if (!out.has(c)) out.set(c, []);
        out.get(c).push({ id: r.target, name: r.targetName, column: r.targetColumns[i] || r.targetColumns[0] || '' });
      });
    }
    if (r.target === viewId) {
      r.targetColumns.forEach((c, i) => {
        if (!inc.has(c)) inc.set(c, []);
        inc.get(c).push({ id: r.source, name: r.sourceName, column: r.sourceColumns[i] || r.sourceColumns[0] || '' });
      });
    }
  }
  return { out, inc };
}

// Every relation this view takes part in, either end. Relations are stored once, not per side.
const relationsOf = (id) => relations.filter((r) => r.source === id || r.target === id);

const viewById = () => { const m = new Map(); for (const v of views) m.set(v.id, v); return m; };
// A view we cannot resolve is shown by its id - which is at least true. Returning the raw
// `.name` was how `undefined` reached the diagram as if it were a table's name.
const nameOf = (id, m) => (m.get(id) && m.get(id).name) || String(id == null ? '?' : id);

// Walk PARENT_ID up to the first view that actually has columns. Only Tables and QueryTables carry
// structure; a Pivot or a Report is a presentation of one of them, sometimes several steps removed.
// Following the chain is what lets the panel answer "what is the structure of this report" instead
// of shrugging - and it costs nothing, because PARENT_ID is already in the view list.
// Returns the chain from the view down to the data-bearing root, or null if it dangles.
function structureChain(v, m) {
  const chain = []; const seen = new Set();
  let cur = v;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id); chain.push(cur);
    if (schema[cur.id]) return chain;
    cur = cur.parent ? m.get(cur.parent) : null;
  }
  return null;               // no data source reachable - say so rather than showing an empty table
}

// ---------- render ----------
// From epoch milliseconds, formatted from *local* calendar parts. Going through toISOString() looked
// right and was wrong: it converts to UTC first, so anywhere east of Greenwich a local midnight
// lands on the previous day and every date silently reads one day early.
function shortDate(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// One line, not two rows of chips: the CRM made this call already and wrote down why - seven
// filters wrapped, and the list below needs the vertical space more than the filter does. The counts
// move into the option labels so nothing is lost by dropping the chips.
function renderTypeFilter() {
  const sel = $('typesel');
  if (!views.length) { sel.innerHTML = '<option value="">—</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const counts = new Map();
  for (const v of views) counts.set(v.type, (counts.get(v.type) || 0) + 1);
  const opts = [`<option value="">All (${views.length})</option>`];
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
    opts.push(`<option value="${escA(t)}">${esc(t)} (${n})</option>`);
  });
  if (deps) opts.push(`<option value="${escA(ORPHANS)}">Nothing depends on (${views.filter(isOrphanCandidate).length})</option>`);
  sel.innerHTML = opts.join('');
  // A filter this workspace has no option for is dropped rather than kept invisibly. `typeFilter` is
  // module state and survives a change of workspace, which is right while the choice still applies -
  // «Table» means the same thing in both. It stops applying when the new workspace has none of that
  // type, or when its lineage was never pulled and «Nothing depends on» is not offered: the select
  // then falls to selectedIndex -1 and shows nothing, while `visibleViews()` goes on filtering. The
  // reader sees a full workspace collapsed to «No view matches» under a control showing no filter.
  if (typeFilter && ![...sel.options].some((o) => o.value === typeFilter)) typeFilter = null;
  sel.value = typeFilter || '';
}

// ---- searching inside the SQL ------------------------------------------------------------------
// `in: names` looks at what the list already shows - name, folder, column names. `in: SQL` looks
// inside the queries themselves, which is what «search across every query at once» has always meant
// to a reader and what this panel could not do: the text is not in memory, it is read per view when
// you open one. So the first search of a session reads every .sql file once and keeps it.
let searchMode = 'name';        // 'name' | 'sql'
let regexMode = false;          // the .* toggle: the search text read as a pattern, full-text mode only
let sqlCache = null;            // Map(id -> text), built once per workspace
let sqlUnread = 0;              // files that would not open, reported rather than counted as misses
const sqlDiskUnread = new Set();// ids whose index entry exists but whose last .sql open failed
let _sqlSearchT = null;


// Where a pattern matches inside one text, as [start, end) pairs - the pure half of the detail
// highlighter, lifted alone by tests/slice.mjs. Zero-length matches are stepped over, the same
// guard as everywhere else a user pattern runs.
function matchSpans(text, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex > text.length) break; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Paint every match of the active full-text search inside `root`, through the CSS Custom Highlight
// API: ranges over the rendered text nodes, no DOM mutation - so the syntax colouring underneath is
// untouched, and a match that crosses its token boundaries still paints whole. Byte-identical in
// both panels; the ::highlight(zoost-find) rule in each page gives the marks their colour.
function paintFindMarks(root, re) {
  if (!('highlights' in CSS)) return;   // without the API the search still works, unpainted
  CSS.highlights.delete('zoost-find');
  if (!root || !re) return;
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ n, at: text.length }); text += n.nodeValue; }
  const spans = matchSpans(text, re);
  if (!spans.length) return;
  const ranges = [];
  let i = 0;
  for (const [a, b] of spans) {
    while (i + 1 < nodes.length && nodes[i + 1].at <= a) i++;
    let j = i;
    while (j + 1 < nodes.length && nodes[j + 1].at < b) j++;
    const r = new Range();
    r.setStart(nodes[i].n, a - nodes[i].at);
    r.setEnd(nodes[j].n, b - nodes[j].at);
    ranges.push(r);
  }
  CSS.highlights.set('zoost-find', new Highlight(...ranges));
}

// The active full-text search as a compiled pattern, or null when there is nothing to paint: name
// mode, an empty box, or a pattern that does not parse.
function findMarkRe() {
  if (searchMode !== 'sql') return null;
  const q = $('find').value.trim();
  if (!q) return null;
  if (!regexMode) return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
  return rxCompile(q).re || null;
}

// The search text as a pattern, or the reason it is not one. Case-insensitive like the plain
// search, and `m` so ^ and $ mean "at a line edge", which is what a reader of code or SQL expects.
// A declaration rather than an arrow because `tests/slice.mjs` lifts it out and runs it alone, and
// byte-identical in both panels: a test holds the twins to the same source.
function rxCompile(term) {
  try { return { re: new RegExp(term, 'gim') }; } catch (e) { return { error: String((e && e.message) || e) }; }
}

// One line with every match wrapped in <mark>, escaped piece by piece - escaping first and then
// matching the escaped text would miss any pattern that touches `<` or `&`. A zero-length match is
// stepped over rather than marked: `x*` matches the empty string everywhere, and the escaper is a
// parameter because the two panels name theirs differently.
function markLine(line, re, escFn) {
  let out = '';
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(line))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex > line.length) break; continue; }
    out += escFn(line.slice(last, m.index)) + '<mark>' + escFn(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escFn(line.slice(last));
}

// What a term does inside one query: how many times, and the first line it is on. A declaration
// rather than an arrow because `tests/slice.mjs` lifts it out and runs it alone.
function sqlHit(text, term, re) {
  if (!text || !term) return null;
  if (re) {
    re.lastIndex = 0;
    let count = 0, first = -1, m2;
    while ((m2 = re.exec(text))) {
      if (!m2[0]) { re.lastIndex++; if (re.lastIndex > text.length) break; continue; }
      if (first < 0) first = m2.index;
      count++;
    }
    // A pattern whose only matches are empty matches nothing: there is no text to show a reader.
    if (first < 0) return null;
    const s2 = text.lastIndexOf('\n', first) + 1;
    let e2 = text.indexOf('\n', first);
    if (e2 < 0) e2 = text.length;
    return { count, line: text.slice(s2, e2).trim().slice(0, 160), lineNo: text.slice(0, first).split('\n').length };
  }
  const lc = text.toLowerCase(), t = term.toLowerCase();
  let idx = lc.indexOf(t);
  if (idx < 0) return null;
  let count = 0, i = idx;
  while (i >= 0) { count++; i = lc.indexOf(t, i + t.length); }
  const start = text.lastIndexOf('\n', idx) + 1;
  let end = text.indexOf('\n', idx);
  if (end < 0) end = text.length;
  return { count, line: text.slice(start, end).trim().slice(0, 160), lineNo: text.slice(0, idx).split('\n').length };
}

// Read every query's file once. A view whose file will not open is counted, never silently dropped:
// «no match» and «never read» are the distinction this panel exists to keep.
async function ensureSqlCache(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (sqlCache) return sqlCache;
  // A stem **or** a body already in memory. The stem is the name of the `.sql` file on disk and is
  // only needed to go and read one - which the loop below decides for itself, three lines down,
  // with `typeof q.sql === 'string'`.
  //
  // It was `q.stem` alone, and a pull publishes `sqls` straight from the bridge, whose answer has no
  // stem in it. So after every Pull all this filtered out **every** query, `entries` was empty, and
  // the search reported «no query matches» over queries it had never opened - while `sqlUnread`
  // stayed 0, because `sqlState` sees an entry and calls it read, so the "absence here is not
  // exhaustive" caveat was suppressed too. The one sentence written to stop this said the opposite.
  // Fixed by reopening the panel, which is why it survived: `loadFromDisk` puts the stems back.
  const entries = Object.entries(sqls).filter(([, q]) => q && (q.stem || typeof q.sql === 'string'));
  if (entries.length) op.say(`Reading the SQL of ${entries.length} quer${entries.length === 1 ? 'y' : 'ies'}\u2026`, 'busy');
  const m = new Map();
  const loaded = new Map();
  const readable = new Set();
  const failedOpen = new Map();
  // A query whose *pull* failed has no entry in `sqls` at all, so counting only files that refused
  // to open under-reported the gap: the search said «searched everything» over queries it never had.
  // Count structural/pull gaps here. Disk failures represented in `entries` are retried below and
  // counted exactly once only if that attempt fails too.
  let unread = views.filter((v) => v.type === 'QueryTable'
    && sqlState(v.id).kind === 'unread' && !sqlDiskUnread.has(String(v.id))).length;
  for (const [id, q] of entries) {
    // An explicit failed pull wins over an older indexed body: serving the old SQL as current would
    // turn a visible coverage gap into a plausible but stale answer.
    if (sqlState(id).kind === 'unread' && !sqlDiskUnread.has(String(id))) continue;
    if (typeof q.sql === 'string') { readable.add(String(id)); m.set(id, q.sql); continue; }
    try {
      const body = await op.read(`sql/${q.stem}.sql`);
      loaded.set(id, { q, body }); readable.add(String(id)); m.set(id, body);
    } catch (_) { failedOpen.set(String(id), q); unread++; }
  }
  if (!op.current()) return null;
  loaded.forEach(({ q, body }, id) => { if (sqls[id] === q) q.sql = body; });
  readable.forEach((id) => sqlDiskUnread.delete(id));
  failedOpen.forEach((q, id) => { if (sqls[id] === q) sqlDiskUnread.add(id); });
  sqlUnread = unread;
  sqlCache = m;
  if (entries.length) op.say(`${m.size} quer${m.size === 1 ? 'y' : 'ies'} read${sqlUnread ? ` \u00b7 ${sqlUnread} could not be opened` : ''}.`, sqlUnread ? 'warn' : '');
  return sqlCache;
}

function visibleViews() {
  const q = $('find').value.trim().toLowerCase();
  let out = views;
  if (typeFilter === ORPHANS) out = out.filter(isOrphanCandidate);
  else if (typeFilter) out = out.filter((v) => v.type === typeFilter);
  if (q && searchMode === 'sql') {
    // Only what has SQL can match, and only what has been read: a query whose file would not open is
    // counted by ensureSqlCache() and reported, not quietly turned into «no match».
    const rx = regexMode ? rxCompile($('find').value.trim()) : null;
    // A broken pattern searched nothing, so it matches nothing: render() names the error, and this
    // empties the list so the keyboard cannot step onto rows the reader was just told do not exist.
    out = rx && rx.error ? [] : out.filter((v) => sqlCache && sqlHit(sqlCache.get(v.id), q, rx && rx.re));
  } else if (q) {
    out = out.filter((v) => {
      if ((v.name || '').toLowerCase().includes(q) || (v.folderName || '').toLowerCase().includes(q)) return true;
      const t = schema[v.id];                  // searching a column name finds the tables that have it
      return !!(t && t.columns.some((c) => c.name.toLowerCase().includes(q)));
    });
  }
  return out.slice().sort((a, b) => {
    if (sortKey === 'readBy') {
      // Absent lineage sorts last in both directions, like an absent timestamp: "not pulled" is not
      // the same as "nothing reads it", and putting them at zero would say it was.
      const cnt = (v) => { const d = deps && deps[v.id]; return d ? d.children.length + d.dashboards.length : null; };
      const x = cnt(a), y = cnt(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * sortDir;
    }
    if (sortKey === 'dataModifiedAt' || sortKey === 'designModifiedAt') {
      // Views with no timestamp sort last in both directions - an absent value is not "oldest".
      const x = a[sortKey], y = b[sortKey];
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return (x - y) * sortDir;
    }
    const x = a[sortKey] ?? '', y = b[sortKey] ?? '';
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * sortDir;
  });
}

/** Why the list is empty, in the order the states actually block each other.
 *
 * An empty state is never silent here: it says what is missing and what to do about it. Saying the
 * *wrong* missing thing is worse than silence, because the reader goes and does it and nothing
 * changes - which is what happened when a folder whose permission had lapsed was told to pick a
 * folder, create a workspace and pull.
 */
function emptyReason() {
  if (!root) {
    return '<b>No working folder yet.</b> Press <b>\u{1F4C1} Set working folder\u2026</b> above and pick a '
      + 'dedicated, empty folder. Every workspace lives inside it.';
  }
  if (!rootGranted) {
    // Deliberately no explanation of *why* the access is missing: on a first install nothing expired,
    // it was never given, and a stated cause that may not apply is one the reader has to discount.
    return '<b>Folder access is not granted.</b> Press <b>\u{1F513} Grant access</b> above - or simply '
      + 'click anywhere in this panel, which does the same. One click, no folder picker.';
  }
  if (!wsList.length) {
    return '<b>No workspace here yet.</b> Open a Zoho Analytics workspace in the active tab - its URL '
      + 'looks like <code>/workspace/&lt;id&gt;</code> - then press <b>+ Workspace</b>. Or press '
      + '<b>+ Sample</b> to write one of invented data and look around first: it never contacts '
      + 'Zoho Analytics, and it is deleted like any other workspace.';
  }
  if (isSample()) {
    // A sample workspace is written by «+ Sample» and never pulled, so «Press Pull all» names a
    // control that is refused for it by design - the reader goes to press it, finds it grey, and
    // learns nothing. Reported on the Actions tab, which arrived after the sample generator did:
    // an older sample folder simply has no actions/ in it, and rewriting the sample is the only
    // thing that puts one there.
    return '<b>Nothing of this kind in the sample workspace.</b> It is invented data written by '
      + '<b>+ Sample</b> and never pulled, so <b>Pull all</b> does not apply to it. If this list '
      + 'should not be empty, the sample was written before this part existed: delete the workspace '
      + 'and press <b>+ Sample</b> again.';
  }
  // The mirror is there and is refused: `loadFromDisk` found `.pull-state.json` still saying
  // `writing`. Without this the list fell through to «Nothing pulled yet», which sends the reader to
  // press Pull all - right by accident - while telling them something false about their own folder.
  if (pullInterrupted) {
    return '<b>The last pull was interrupted while it was writing.</b> The files on disk describe two '
      + 'different moments, so nothing here is shown rather than a mixture of them. Press '
      + '<b>Pull all</b> to repair the mirror.';
  }
  if (diskUnreadable) {
    // The one state where the files are there and the panel cannot see them. Naming the file and what
    // the browser called it, because the cause is outside this extension - a folder that moved, a
    // drive that went offline, a permission that lapsed between sessions - and the reader is the only
    // one who can tell which.
    return '<b>This workspace is on disk and could not be read.</b> <code>' + esc(diskUnreadable.rel)
      + '</code> is there and the read failed (' + esc(diskUnreadable.name) + '). Press <b>\u21bb Refresh</b>. '
      + 'If it happens again, the folder may have moved, or the drive it lives on may be offline.';
  }
  return '<b>Nothing pulled yet.</b> Press <b>Pull all</b> to read this workspace into the folder: the '
    + 'view list, the columns of every table, the relations and the SQL of each query table.';
}

function render() {
  renderTypeFilter();
  const list = $('list');
  if (!views.length) {
    // "Nothing here" plus **the** reason, not a reason. Reciting the whole sequence while the only
    // thing in the way is a lapsed folder permission sends the reader to do four things when one
    // click would do - and it is the step they have already done that gets repeated at them.
    list.innerHTML = `<div class="empty">${emptyReason()}</div>`;
    return;
  }
  // The detail pane shows the same search: matches painted in the open SQL, cleared when the
  // search empties, changes mode or stops parsing - one call, because null clears.
  paintFindMarks(document.querySelector('#detail pre.sql'), findMarkRe());
  const rawQ = $('find').value.trim();
  if (searchMode === 'sql' && regexMode && rawQ) {
    const rxErr = rxCompile(rawQ).error;
    if (rxErr) {
      // «No matches» for a pattern that never ran would be the lie this panel exists to refuse.
      list.innerHTML = `<div class="empty"><b>The pattern does not parse.</b> ${esc(rxErr)}. Nothing was searched - fix the pattern or switch .* off.</div>`;
      return;
    }
  }
  const rows = visibleViews();
  if (!rows.length) {
    // Written for `in: names`, and it was the only one. In SQL mode all three of its statements were
    // wrong: column names are not searched (that is the other branch), only query tables can match so
    // `views.length` is not the denominator, and - the one that matters - it says nothing about the
    // .sql files that would not open. `sqlUnread` is computed carefully by `ensureSqlCache` and was
    // used in exactly one place, a status line the next message overwrites. So a reader whose
    // workspace has three unreadable queries was told the search covered everything, on the one
    // surface where «no matches» is the whole answer. The assistant one screen over carries its
    // coverage with the answer; this is the same fact, said in the same voice.
    const qts = views.filter((v) => v.type === 'QueryTable').length;
    const narrowing = typeFilter ? 'The type filter and the' : 'The';
    list.innerHTML = searchMode === 'sql'
      ? `<div class="empty"><b>No query matches.</b>
      ${narrowing} search box are narrowing ${qts} quer${qts === 1 ? 'y' : 'ies'} down to none;
      the other ${views.length - qts} view(s) have no SQL to search.
      ${sqlUnread ? `<b>${sqlUnread} of them could not be opened</b>, so absence here is not exhaustive. ` : ''}Clear the box to see them all again.</div>`
      : `<div class="empty"><b>No view matches.</b>
      ${narrowing} search box are narrowing ${views.length} views down to none.
      The search also looks inside column names. Clear it to see them all again.</div>`;
    return;
  }
  // The number is the answer's headline; clicking it opens the breakdown. Naming the same fact
  // "Used by" in the list and "Read by" in the detail is how a reader ends up unsure they are
  // looking at the same thing - so it is one name now, and one click away from its detail.
  const usedBy = (v) => {
    if (!deps) return '';
    const d = deps[v.id];
    if (!d) return '<span class="orphan" title="This view could not be read during the pull">?</span>';
    const n = d.children.length + d.dashboards.length;
    return n
      ? `<a class="fk" data-lin="${escA(v.id)}" title="Show what reads from it">${n}</a>`
      : '<span class="orphan">none</span>';
  };
  // Own columns plain; inherited ones marked, because attributing a parent's structure to a report
  // without saying so would be a quiet lie about whose columns those are.
  const m0 = viewById();
  const colCount = (v) => {
    if (schema[v.id]) return String(schema[v.id].columns.length);
    const chain = structureChain(v, m0);
    if (!chain) return '—';
    const src = chain[chain.length - 1];
    // In brackets, never with a glyph in front. `↳19` sat flush against the digits in a column of
    // numbers and read as «419» - a mark that changes how a number reads is worse than no mark, and
    // this one is in the one column where the reader is scanning figures. Brackets cannot be mistaken
    // for a digit, the muted colour still separates it from an own count, and the tooltip still names
    // the view the structure comes from.
    return `<span title="${escA('columns inherited from ' + src.name + ' - this view has none of its own')}" style="color:var(--muted)">(${schema[src.id].columns.length})</span>`;
  };
  // In SQL mode the row says where the term is, the way the CRM's search results do: the line, its
  // number, and how many times the term appears in that query.
  const hlRe = rawQ && searchMode === 'sql'
    ? (regexMode ? rxCompile(rawQ).re : new RegExp(rawQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim'))
    : null;
  const sqlLine = (v) => {
    if (searchMode !== 'sql' || !sqlCache || !hlRe) return '';
    const h = sqlHit(sqlCache.get(v.id), rawQ, regexMode ? hlRe : null);
    if (!h) return '';
    return `<div class="sqlhit"><span class="n">${h.lineNo}</span>${markLine(h.line, hlRe, esc)}`
      + (h.count > 1 ? ` <span class="n">\u00d7${h.count}</span>` : '') + '</div>';
  };
  list.innerHTML = `<table class="vtbl">
    <thead><tr>
      <th>View</th><th>Type</th><th class="num" title="Columns. A number in brackets is inherited: the view has none of its own, and the count is the view it is built on.">Cols</th>
      <th class="num" title="As Zoho words it, in your interface language - not sortable, see the note below">Design</th>
      <th class="num">Data</th>${deps ? '<th class="num" title="How many views read from it, plus the dashboards it appears on - the Lineage tab breaks the same figure down">Read by</th>' : ''}
    </tr></thead><tbody>${rows.map((v) => `<tr data-id="${escA(v.id)}"${v.id === selectedId ? ' class="sel"' : ''}>
      <td><div class="vname">${esc(v.name)}</div>${sqlLine(v)}<div class="vsub">${esc(v.folderName || '—')}${v.owner ? ' · ' + esc(v.owner) : ''}${v.system ? ' · <span class="sysflag" title="Zoho Analytics flags this as a system table - it came from a connected source, you did not build it">system</span>' : ''}</div></td>
      <td><span class="vtype">${esc(v.type)}</span></td>
      <td class="num">${colCount(v)}</td>
      ${v.designModifiedAt
        ? `<td class="num" title="${escA(v.designModifiedBy ? 'by ' + v.designModifiedBy : '')}">${esc(shortDate(v.designModifiedAt))}</td>`
        : `<td class="num verbatim" title="${escA('Zoho gives no machine-readable value for this one - shown as it sends it' + (v.designModifiedBy ? ', by ' + v.designModifiedBy : ''))}">${esc(v.designModifiedText || '—')}</td>`}
      <td class="num">${esc(shortDate(v.dataModifiedAt))}</td>
      ${deps ? `<td class="num">${usedBy(v)}</td>` : ''}
    </tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = () => {
      // A row opened from an SQL search opens on the SQL tab: that is where the match the reader
      // clicked for lives, painted. The same pattern as the lineage links one block down.
      if (searchMode === 'sql' && $('find').value.trim()) detailTab = 'sql';
      openDetail(tr.dataset.id);
    };
  });
  list.querySelectorAll('a.fk[data-lin]').forEach((a2) => {
    a2.onclick = (ev) => { ev.stopPropagation(); detailTab = 'lin'; openDetail(a2.dataset.lin); };
  });
}

// ---------- detail ----------
// Every time the pane shows something else, it shows it from the top. Without this the scrollbar
// stays where the previous item left it and the reader is looking at row 40 of a table they have
// never seen. Run twice - once now, once after layout - because content rendered on the next frame
// would otherwise restore the old offset. Straight from the CRM panel, which has always done it.
function resetDetailScroll() {
  const doIt = () => {
    const e = $('dbody'); if (e) { e.scrollTop = 0; e.scrollLeft = 0; }
    const d = $('detail');
    if (d) d.querySelectorAll('pre,table,[style*="overflow"]').forEach((x) => { x.scrollTop = 0; x.scrollLeft = 0; });
  };
  doIt(); requestAnimationFrame(doIt);
}

async function openDetail(id) {
  const mine = ++detailLoad;
  const op = beginWorkspaceOp();
  // After the guard, not before it. Selecting an id this workspace does not have left the panel
  // marked on a view that does not exist - no row lit, the previous item still in the pane, nothing
  // said - and `selectedId` then fed the assistant's CURRENT FOCUS. Every caller guards the id today,
  // so this is a trap rather than a live defect; it costs one line not to leave it armed.
  const v = viewById().get(id);
  if (!v) return;
  selectedId = id;
  // Every way in passes through here - a row click, an arrow key, a foreign key, a lineage entry -
  // so the history is complete without any of them knowing it exists. The kind is carried too, so
  // the chain reads «query table Funnel» rather than a bare name.
  navHere(id, v.name); { const e = navHist[navPos]; if (e) e.kind = v.type; }
  $('detail').classList.add('show'); $('resizer').classList.add('show');
  $('dtitle').textContent = v.name;
  // A Zoho read, so it is worded and coloured like every other Zoho read: "Pull", .zbtn. The ↻ glyph
  // means "reload from disk / re-grant folder access" in the CRM panel and must keep meaning only
  // that here - a symbol that fetches from Zoho in one app and reads the disk in the other is worse
  // than no symbol.
  $('dpull').disabled = busy || !guardOk();
  $('dpull').title = guardOk()
    ? 'Pull - this view only, its SQL and its lineage; «Pull all» does every view'
    : 'The active tab is a different workspace, so nothing can be pulled';
  $('dpull').onclick = () => pullOne(v.id);
  // Focused ER, exactly as the CRM opens a module's relations: the window takes it from here and
  // the depth stays adjustable there.
  const chain = structureChain(v, viewById());
  const srcId = chain ? chain[chain.length - 1].id : null;
  // Two different «no»s, and they were one. A table can be in the diagram and take part in no
  // relation - then there is nothing to draw around it. A view can be absent from the diagram
  // altogether, because `schema` is built from the ER model Zoho Analytics returns and that model
  // does not carry every view: asking to centre on one of those opened an empty window, which is
  // what was reported. Neither is offered, and each says which it is.
  // Offered whenever the diagram contains the view, relations or not. «No relation» was treated as
  // «nothing to show» and the button was greyed out - but the entity is the answer: the window draws
  // it alone and says that nothing links to it, which is a finding rather than an absence. Reported
  // twice in one session: first as an empty sheet, then as a button that would not open it.
  const inDiagram = !!(srcId && schema[srcId]);
  $('dgraph').disabled = !inDiagram;
  $('dgraph').title = !srcId
    ? 'ER diagram - nothing here has a structure to draw'
    : !inDiagram
      ? 'ER diagram - this view is not in the ER model Zoho Analytics returns, so the diagram does not contain it'
      : relationsOf(srcId).length
        ? 'ER diagram - opened on this table, in its own window'
        : 'ER diagram - opened on this table; it takes part in no relation, so it is drawn on its own';
  $('dgraph').onclick = () => openSchemaGraph(srcId, 2);
  // Absent on a sample: there is no Zoho Analytics view behind invented data, and a button that
  // opens a 404 is worse than one that is not there. Everywhere else it is an address, so it works
  // whether or not the tab is on this workspace.
  const zurl = isSample() ? null : viewUrl(v.id);
  $('dzoho').style.display = zurl ? '' : 'none';
  // Through `goToZoho`, like every other way this panel takes the reader to Zoho. It opened a new
  // tab unconditionally - so from inside a suite shell «Open in Zoho» left the shell *and* the tab
  // the reader was in, while the CRM's own «Open in Zoho» has always moved the tab they are on.
  // Reported: «Analytics behaves differently from CRM». One of a set that did not do what its
  // siblings do, which is the miss this repository asks to be caught by diffing against them.
  $('dzoho').onclick = () => { if (zurl) goToZoho(zurl); };
  $('dtitle').title = `${v.type} · ${v.folderName || 'no folder'} · id ${v.id}`;
  // A tab that cannot say anything about this view is disabled, not shown and silently empty - and
  // it says which silence it is, in a title, the way the ER button beside it has always done.
  //
  // `!sqls[id]` was two different facts under one grey tab. A view that is not a query table has no
  // SQL and never will; a query table whose SQL the pull could not read *has* one, and this product
  // states that everywhere else - in the search coverage line, in both exports, in the assistant's
  // answers. Here it turned the tab off and said nothing, which is the reading of «not read» as
  // «does not exist» that the rest of the release removed. The tab stays on and the pane gives the
  // reason Zoho or the disk gave.
  const sqlSt = sqlState(id);
  $('tab_sql').disabled = sqlSt.kind === 'not-query';
  $('tab_sql').title = sqlSt.kind === 'not-query' ? 'SQL - only a query table has any'
    : sqlSt.kind === 'unread' ? `SQL - not read: ${sqlSt.error}`
      : 'SQL - the query this view is built from';
  const rels = relationsOf(id).length;
  $('tab_rel').disabled = !rels;
  $('tab_rel').title = rels ? `Relations - ${rels} foreign key(s)`
    : 'Relations - nothing in the ER model links to or from this view';
  $('tab_lin').disabled = !deps;
  $('tab_lin').title = deps ? 'Lineage - what this reads, and what reads it'
    : 'Lineage - not pulled for this workspace; use Pull above';
  if (detailTab === 'sql' && sqlSt.kind === 'not-query') detailTab = 'cols';
  if (detailTab === 'rel' && !rels) detailTab = 'cols';
  if (detailTab === 'lin' && !deps) detailTab = 'cols';
  document.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === detailTab));
  await renderDetail(v, mine, op);
  if (!detailCurrent(mine, op)) return;
  resetDetailScroll();
  render();
  // And the list follows: opening a view from a foreign key or from the lineage marks its row, and a
  // mark nobody can see is not a selection. The twin's tree does the same thing when a call in the
  // code takes you to another function.
  const row = [...$('list').querySelectorAll('tr[data-id]')].find((r) => r.dataset.id === String(id));
  revealRow(row, $('list'), 'thead');
}

async function renderDetail(v, mine = detailLoad, op = beginWorkspaceOp()) {
  const body = $('dbody');
  const m = viewById();
  // Off unless this tab is showing code, decided once here rather than in each branch: it lingered
  // over the columns because only the SQL branch had an opinion about it - a control that is turned
  // on in one place and never off in the others.
  $('codecopy').style.display = 'none';
  if (detailTab === 'cols') {
    const chain = structureChain(v, m);
    if (!chain) {
      body.innerHTML = `<div class="dpad"><div class="empty" style="padding:0"><b>No structure to show.</b>
        A ${esc(v.type)} has no columns of its own, and Zoho Analytics does not tell us which view it is
        built on - so there is nothing here that would be true.</div></div>`;
      return;
    }
    const src = chain[chain.length - 1];
    const t = schema[src.id];
    // When the structure is inherited, say whose it is and through what - a column list attributed
    // to the wrong object is worse than no column list.
    const via = chain.length > 1
      ? `<div class="vsub" style="margin:0">Structure of <b>${esc(src.name)}</b> (${esc(t.kind)}), inherited through ${chain.slice(0, -1).map((c) => esc(c.name)).join(' → ')} → <b>${esc(src.name)}</b></div>`
      : '';
    const { out, inc } = foreignKeys(src.id);
    const anyFk = out.size || inc.size;
    const ref = (c) => {
      const bits = [];
      for (const f of out.get(c.name) || []) bits.push(`<a class="fk" data-go="${escA(f.id)}" title="${escA('Foreign key → ' + f.name + '.' + f.column)}">→ ${esc(f.name)}<span class="fkc">.${esc(f.column)}</span></a>`);
      for (const f of inc.get(c.name) || []) bits.push(`<a class="fk in" data-go="${escA(f.id)}" title="${escA(f.name + '.' + f.column + ' points here')}">← ${esc(f.name)}<span class="fkc">.${esc(f.column)}</span></a>`);
      return bits.join('<br>');
    };
    body.innerHTML = (via ? `<div class="dpad" style="padding-bottom:0">${via}</div>` : '')
      + `<table class="ctbl"><thead><tr><th>Column</th><th>Type</th>${anyFk ? '<th>References</th>' : ''}</tr></thead><tbody>${
        t.columns.map((c) => `<tr><td>${esc(c.name)}</td><td class="t">${esc(c.type)}</td>${anyFk ? `<td>${ref(c)}</td>` : ''}</tr>`).join('')
      }</tbody></table>`;
    // The links are real navigation, as the CRM's function cross-references are: they open the other
    // table's structure rather than merely naming it.
    body.querySelectorAll('a.fk[data-go]').forEach((a2) => { a2.onclick = () => openDetail(a2.dataset.go); });
    return;
  }
  if (detailTab === 'rel') {
    const rs = relationsOf(v.id);
    // Zoho's own `relationstring` is shown as it writes it - "(A.col)=(B.col)". Re-rendering the
    // join in our own words would be an interpretation, and the point here is the fact, not our
    // phrasing of it. The direction is stated because a lookup is not symmetric.
    body.innerHTML = '<div class="dpad">' + rs.map((r) => {
      const out = r.source === v.id;
      return `<div class="rel"><b>${esc(out ? '→ ' + r.targetName : '← ' + r.sourceName)}</b><br>${esc(r.relation)}</div>`;
    }).join('') + '</div>';
    return;
  }
  if (detailTab === 'sql') {
    // `sqlReadState`, not `sqlBodyOf`. The raw reader answers from `sqls[id].sql`, which is a string
    // for anything read this session or straight after a pull - so a query whose SQL failed *this
    // time* still had a body in memory, and this pane painted it, highlighted, with the copy button
    // on. Meanwhile the tab's own title said «not read: HTTP 429», the search said so, both exports
    // said so and the assistant refused to conclude anything. Six surfaces telling the truth and the
    // one showing the text serving yesterday's, with nothing marking it as old.
    //
    // `sqlReadState` is where that precedence already lives: «an explicit failed pull wins over an
    // older indexed body - serving the old SQL as current would turn a visible coverage gap into a
    // plausible but stale answer». It was written and then not asked here.
    const st = await sqlReadState(v.id, op);
    const sql = st.kind === 'read' ? st.body : null;
    if (!detailCurrent(mine, op)) return false;
    // Only where there is code to take: this is the one tab of the four that shows any.
    $('codecopy').style.display = (sql && sql.trim()) ? '' : 'none';
    body.innerHTML = '<div class="dpad">' + (sql && sql.trim()
      // Highlighted, and still escaped: `highlightSql` tokenises the raw text and escapes every
      // piece itself, which is the only reason it may be handed to innerHTML at all.
      ? `<pre class="sql">${window.highlightSql ? window.highlightSql(sql) : esc(sql)}</pre>`
      // The reason, not a reason: `sqlState` knows whether the pull failed (and what Zoho said),
      // whether the file refused to open, or whether the mirror never had it. A single «could not be
      // read» over all three sends the reader to fix the wrong thing.
      : `<div class="empty" style="padding:0"><b>${sql == null ? 'The SQL was not read.' : 'No SQL text.'}</b> ${esc(sql == null ? st.error || SQL_UNREADABLE : sqlText(sql))}</div>`) + '</div>';
    paintFindMarks(body.querySelector('pre.sql'), findMarkRe());
    return;
  }
  // lineage
  const d = deps ? deps[v.id] : null;
  if (!d) { body.innerHTML = '<div class="dpad"><div class="empty" style="padding:0"><b>No lineage for this view.</b> Use Pull above to fetch just this one.</div></div>'; return; }
  // Every name that is a view in this workspace is a link to it - what reads from this, what it
  // reads, the dashboards it appears on. The Relations tab has worked this way since it was written
  // and the lineage did not, so the one box that answers «what depends on this» could not take you
  // to any of it. A name the panel cannot open stays plain: a link that leads nowhere is worse than
  // text.
  const goTo = (id, label) => (m.has(String(id))
    ? `<a class="fk" data-go="${escA(String(id))}" title="Open ${escA(label)}">${esc(label)}</a>`
    : esc(label));
  const li = (arr) => arr.length
    ? `<ul>${arr.map((x) => `<li>${goTo(x.id, nameOf(x.id, m))} <span class="lv">level ${x.level}</span></li>`).join('')}</ul>`
    : '<div class="none">none</div>';
  const dash = d.dashboards.length
    ? `<ul>${d.dashboards.map((x) => `<li>${goTo(x, nameOf(x, m))}</li>`).join('')}</ul>`
    : '<div class="none">none</div>';
  const q = sqls[v.id];
  const _sqlSt = await sqlReadState(v.id, op);
  const cols = q && q.sources
    // `s.columns` rather than `s.columns.length` straight: a pull always writes the list, and a
    // detail pane that throws half-drawn is not the place to find out that something did not. The
    // count is omitted rather than shown as zero - «0 columns involved» is a measurement, and this
    // would be the absence of one.
    ? Object.entries(q.sources).map(([tid, s]) => `<li>${goTo(tid, (s && s.name) || nameOf(tid, m))}${s && Array.isArray(s.columns) ? ` <span class="lv">${s.columns.length} columns involved</span>` : ''}</li>`).join('')
    : '';
  body.innerHTML = '<div class="dpad">'
    + `<div class="lin"><h5>Reads from</h5>${li(d.parents)}</div>`
    + `<div class="lin"><h5>Read by <span class="lv">- the same count the list shows</span></h5>${li(d.children)}</div>`
    + `<div class="lin"><h5>On dashboards</h5>${dash}</div>`
    + (cols ? `<div class="lin"><h5>Source columns involved</h5><ul>${cols}</ul></div>` : '')
    + (_sqlSt.kind === 'unread' ? `<div class="lin"><h5>SQL</h5><div class="none">not read - ${esc(_sqlSt.error)}. Retry failed / Pull all fetches it.</div></div>` : '')
    + '</div>';
  // Wired like the Relations tab's: naming a view and not taking you to it is the half a reader
  // notices. Reported for this box, in its general form - it should read like any hypertext.
  body.querySelectorAll('a.fk[data-go]').forEach((a2) => { a2.onclick = () => openDetail(a2.dataset.go); });
}

// Local only. Re-reads the mirror from disk, or takes the chance to re-grant a lapsed folder
// permission - it never talks to Zoho. Same meaning, same glyph and same title as the CRM panel's.
async function refreshLocal() {
  if (root && !rootGranted) { await grantRoot(); return; }
  if (!dir) return;
  setBusy(true, 'Reloading from disk…');
  // `loadFromDisk` returns false when it has *already* said why, and the one case that matters is a
  // mirror whose last pull was interrupted mid-write: it is refused, with the repair named. This was
  // the only caller that ignored the answer, so `setBusy(false)` wrote «Ready.» over the warning -
  // and the empty list underneath then blamed «Nothing pulled yet. Press Pull all», because the
  // writing branch returns before `diskUnreadable` is assigned. A blocked mirror, reported as an
  // empty one, under the word Ready.
  const ok = await loadFromDisk();
  setBusy(false, ok ? undefined : null);
}

// ---------- schema graph ----------
// The graph window is the CRM one, unchanged in its engine: same ER layout with the concentric and
// force branches, the same depth control and the same layout sliders. It consumes a generic
// node/edge shape, so the job here is to express the Analytics workspace in that shape rather than
// to write a second diagram - which is also why the two windows behave identically for anyone who
// uses both.
//
//   node   = a table or query table          (the only things with columns)
//   field  = a column, `lookup` set when it is a foreign key
//   edge   = a relation from the ER model
//   joins  = the same relations with Zoho's own join string, for the edge card and the table
//   reads  = the views that read from this table, from the lineage
function buildSchemaGraph() {
  const m = viewById();
  const nodes = {};
  for (const [id, t] of Object.entries(schema)) {
    const { out, inc } = foreignKeys(id);
    const joins = [];
    for (const [col, list] of out) for (const f of list) joins.push({ direction: 'out', other: f.id, otherName: f.name, column: col, otherColumn: f.column, relation: (relations.find((r) => r.source === id && r.target === f.id && r.sourceColumns.includes(col)) || {}).relation || '' });
    for (const [col, list] of inc) for (const f of list) joins.push({ direction: 'in', other: f.id, otherName: f.name, column: col, otherColumn: f.column, relation: (relations.find((r) => r.target === id && r.source === f.id && r.targetColumns.includes(col)) || {}).relation || '' });
    // Which views read from this table, so the diagram can answer "what breaks if I change it".
    const d = deps && deps[id];
    const reads = d ? d.children.map((x) => nameOf(x.id, m)) : [];
    nodes[id] = {
      id, name: t.name, api_name: t.name, display_name: t.name,
      namespace: t.kind === 'QueryTable' ? 'query' : 'table',
      system: !!t.system, category: t.kind, description: t.description || '',
      calls: [], called_by: [], rest: false, dead_suspect: false, unresolved: [], ambiguous: [],
      associated_place: null, file: null, source_code: '', params: [], return_type: null,
      fields: t.columns.map((c) => {
        const fk = (out.get(c.name) || [])[0];
        return { api_name: c.name, label: c.name, data_type: c.type, mandatory: false, lookup: fk ? fk.id : null };
      }),
      joins, reads,
      layouts: [], related_lists: [], layoutDetail: false, touched_by: [],
    };
  }
  const edgeSet = new Set();
  for (const r of relations) {
    if (!nodes[r.source] || !nodes[r.target] || r.source === r.target) continue;
    nodes[r.source].calls.push(r.target); nodes[r.target].called_by.push(r.source);
    edgeSet.add(r.source + '\u0000' + r.target);
  }
  Object.values(nodes).forEach((n) => {
    n.calls = [...new Set(n.calls)]; n.called_by = [...new Set(n.called_by)];
    n.dead_suspect = n.calls.length === 0 && n.called_by.length === 0;   // in no relation at all
  });
  const edges = [...edgeSet].map((e) => { const [a2, b2] = e.split('\u0000'); return [a2, b2]; });
  return {
    kind: 'schema', nodes, edges, focus: null, depth: null,
    counts: { nodes: Object.keys(nodes).length, edges: edges.length, dead_suspects: Object.values(nodes).filter((n) => n.dead_suspect).length, unresolved: 0 },
    // `label` travels too: without it the window has nothing to show and falls back to the derived
    // name, which is exactly the case the label exists for - Zoho Analytics calls the first
    // workspace of every account the same thing.
    // `idWord` because the header is drawn by a file both products share: the number below is a
    // workspace id, and without this the window called it an org - the other product's noun.
    workspace: { idWord: 'workspace', instance: bound ? (bound.name || bound.workspace) : null, org: bound ? bound.workspace : null,
                 label: (bound && bound.label) || null },
  };
}

// What the diagram window is given, which is less than what the panel holds. **This product's graph
// nodes never carry source at all** - a workspace has views, columns and relations, and the `''` the
// node builder writes is a shape the two products share, not a value. The sentence here used to be
// the other product's, copied whole: it told the next reader that Deluge sits in memory and is
// stripped at this line, which is a claim about a data flow that does not exist. A privacy comment is
// part of the security model, so it says what is true and nothing more.
//
// The strip stays, and it is the point of this function: the payload crosses into storage, and a
// field added to a node tomorrow has to be admitted here deliberately rather than arriving by
// default. It is a filter on the boundary, not a remedy for something known to be in the payload.
//
// And it goes to `chrome.storage.session`: this is a hand-off to a window opening in a moment, not a
// setting. Session storage is memory - it goes when the browser does, instead of a copy of the org's
// structure resting on disk until the next diagram replaces it.
/** Hand a graph to its own window: one key per window, not one slot for all of them - see the CRM
 *  twin for the race this closes. The identity is stamped by buildSchemaGraph() itself, which is
 *  synchronous and runs at the entry - so unlike the CRM there is no second photograph to take;
 *  what the op guards here is the two awaits between the build and the window. Returns false when
 *  the workspace moved before the window opened. */
async function publishGraph(g, op) {
  const token = crypto.randomUUID();
  const key = 'graphData:' + token;
  if (op && !op.current()) return false;
  await chrome.storage.session.set({ [key]: graphForWindow(g) });
  if (op && !op.current()) { try { await chrome.storage.session.remove(key); } catch (_) {} return false; }
  // A window that cannot open leaves nobody to consume the key, so it goes at once - otherwise the
  // payload sat in session storage until the browser closed, which is longer than the privacy page
  // is allowed to promise.
  try { await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html?graph=' + token), type: 'normal', width: 1240, height: 840 }); }
  catch (e) { try { await chrome.storage.session.remove(key); } catch (_) {} throw e; }
  return true;
}
function graphForWindow(g) {
  const out = Object.assign({}, g, { nodes: {} });
  for (const [id, n] of Object.entries(g.nodes || {})) {
    const copy = Object.assign({}, n);
    delete copy.source_code;
    out.nodes[id] = copy;
  }
  return out;
}

async function openSchemaGraph(focusId, depth) {
  const op = beginWorkspaceOp();
  try {
    if (!Object.keys(schema).length) throw new Error('nothing pulled yet - run Pull all first');
    const g = buildSchemaGraph();
    if (!g.counts.nodes) throw new Error('no tables in this workspace');
    if (focusId && g.nodes[focusId]) { g.focus = focusId; g.depth = Math.max(1, depth || 2); }
    // The name travels with the id, because the window can only report what it was handed: asked to
    // centre on a view the diagram does not contain, it would otherwise have to name a number.
    else if (focusId) { g.focus = focusId; g.focusName = nameOf(focusId, viewById()); }
    if (!(await publishGraph(g, op))) return;
    status(`Schema: ${g.counts.nodes} tables, ${g.counts.edges} relations.`, 'ok');
  } catch (e) { status('Schema graph error: ' + (e.message || e), 'bad'); }
}

// ---------- AI ----------
// Ported from the CRM panel: same config shape, same storage key, same streaming agent loop, same
// single-shot OpenAI path with the max_tokens/max_completion_tokens retry. What differs is what the
// tools read - views, columns, relations, SQL and lineage instead of functions and modules - and the
// SQL guardrail, which is the one thing here not derived from the user's own workspace.
let aiMessages = [];
let aiBusy = false, aiSeedTruncated = false, aiSeedWarned = false, aiSeedOmitted = [];
let aiGen = 0;

async function aiGetCfg() {
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  const cfg = { active: c.active || 'anthropic', anthropic: Object.assign({ model: '', apiKey: '' }, c.anthropic || {}), openai: Object.assign({ model: '', apiKey: '' }, c.openai || {}), maxIter: c.maxIter || 20, seedCap: c.seedCap || AI_SEED_CAP_DEFAULT, maxTokens: c.maxTokens || AI_MAX_TOKENS_DEFAULT };
  // A protected key is on disk as ciphertext only. The plaintext lives in chrome.storage.session for
  // as long as the browser runs, and is put back here so every caller downstream sees an ordinary key
  // and nothing else has to learn about the passphrase.
  for (const prov of ['anthropic', 'openai']) {
    if (cfg[prov].apiKeyEnc && !cfg[prov].apiKey) cfg[prov].apiKey = (await window.ZOOST_KEYVAULT.recall(prov)) || '';
  }
  return cfg;
}
/** Locked = there is a key, it is encrypted, and this session has not unlocked it yet. Distinct from
 *  not-configured: the remedy is a passphrase here, not a trip to Settings. */
function aiLocked(cfg) { const p = cfg[cfg.active] || {}; return !!(p.apiKeyEnc && !p.apiKey); }
function aiActiveReady(cfg) { const p = cfg[cfg.active] || {}; return !!(p.apiKey && p.model); }

// ---------- unlocking a protected API key ----------
// The passphrase is never stored and never leaves this function: it decrypts once, the plaintext goes
// to chrome.storage.session, and the field is cleared. Forgetting it is recoverable only by entering
// the API key again - stated in Settings, and not softened here.
function aiShowLock(on) {
  const row = $('ailockrow'); if (!row) return;
  // Idempotent on purpose: this runs on every window focus and every settings change, and re-showing
  // a row that is already showing would clear a half-typed passphrase and steal the caret back.
  if (row.hidden !== !on) {
    row.hidden = !on;
    // Cleared on **both** branches. The docstring above says the passphrase «is cleared», and that
    // was true of one path: the success of `aiUnlock`. Two others left it in the DOM for the life of
    // the panel - the protection removed in Settings between showing this row and pressing Unlock,
    // which returns through `aiShowLock(false)`; and `aiEngineChrome()`, which runs on every window
    // focus and every settings change and hides the row whenever the key is no longer locked.
    //
    // It does not leave the machine and nothing reads that node. It is a sentence about a secret,
    // and it was not true of the code.
    $('ailockpass').value = '';
    if (on) { aiLockMsg(''); $('ailockpass').focus(); }
  }
}
/** A DOMException's message names the symptom and never the remedy.
 *
 * "The request is not allowed by the user agent or the platform in the current context." is what a
 * lapsed folder permission looks like from anywhere that touches the disk, and it reads as a bug in
 * the extension. It has surfaced three times now - the agent loop, and renaming a workspace - so this
 * is deliberately not AI-specific. Translated where it surfaces, so a user who meets it once more is told which button to
 * press. Nothing branches on the class name - it is matched, not parsed, and anything unrecognised is
 * passed through untouched rather than dressed up.
 */
function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/not allowed by the user agent|NotAllowedError/i.test(m)) {
    return 'The working folder is no longer readable - Chrome lets that permission lapse after a while. '
      + 'Press \u21bb Refresh in the toolbar to grant it again, then run it again. Nothing was written.';
  }
  return MSG.errPrefix + m;
}

/** Re-grant the working folder before the assistant touches it.
 *
 * Chrome lets a File System Access permission lapse after inactivity, and every read then throws
 * `NotAllowedError: The request is not allowed by the user agent or the platform in the current
 * context.` - a message that names neither the folder nor the remedy. The AI path reads the mirror
 * directly (the seed index, the tools, the graph) and was the one path that never asked first, so it
 * surfaced as "the chat is broken until I click an item and come back": clicking an item runs
 * ensurePerm() under a real gesture and fixes it as a side effect.
 *
 * It has to happen *here*, at the click. requestPermission() needs transient user activation, so the
 * same call made inside the agent loop - after a network round trip to the model - is refused for want
 * of a gesture, which is the very error being reported. Same fix the Health view already carries.
 */
async function aiEnsureFiles() {
  if (!dir) return true;
  try { return await ensurePerm(dir); } catch (_) { return false; }
}

/** The verdict on a passphrase goes beside the field, because that is where the eye is - and because
 *  in the CRM panel the AI view covers the status bar completely, so a warning sent there while the
 *  chat is open is written to an element nobody can see. Same code on both sides regardless. */
function aiLockMsg(text) {
  const el = $('ailockmsg'); if (!el) return;
  el.textContent = text; el.hidden = !text;
}
async function aiUnlock() {
  const pass = $('ailockpass').value;
  if (!pass) { aiLockMsg('Type the passphrase you chose in Settings.'); $('ailockpass').focus(); return; }
  const cfg = await aiGetCfg();
  const prov = cfg.active; const box = (cfg[prov] || {}).apiKeyEnc;
  if (!box) { aiShowLock(false); return; }
  const key = await window.ZOOST_KEYVAULT.unlock(box, pass);
  // AES-GCM authenticates, so failure means the passphrase is wrong or the stored value is damaged.
  // Which of the two cannot be told apart, and the message says so rather than picking one.
  if (!key) {
    aiLockMsg('That passphrase did not open the key. Either it is wrong, or the stored key is damaged - the two cannot be told apart. If it is lost, open Settings and use «Remove the protection», then enter the API key again.');
    status('Wrong passphrase.', 'warn');
    $('ailockpass').select(); return;
  }
  await window.ZOOST_KEYVAULT.remember(prov, key);
  // Cleared here, on success, as the docstring has always said. It was not: `aiShowLock` empties the
  // input only on the branch that *shows* the row, so the passphrase sat in the DOM for the life of
  // the panel. Found by a review of the boundary; the CRM twin had it too.
  $('ailockpass').value = '';
  aiLockMsg(''); aiShowLock(false); status('API key unlocked for this browser session.', 'ok');
}
function aiTrunc(x, n) { const t = x || ''; return t.length > n ? t.slice(0, n) + '\n… (truncated)' : t; }

// A `function`, not a multi-line arrow: the slicer lifts declarations, and an arrow-const is cut at
// its first line - the rule slice.mjs already states, met here by the registry-derived tool test.
/** What is known about one view's SQL - one answer, four values, used by every surface.
 *  «Not read» and «absent» were one fact: a QueryTable whose pull failed was missing from `sqls`,
 *  so get_sql said it was «not a query table», searches said «no matches» over queries they never
 *  opened, and the exports skipped it whole. Reproduced by an outside scan.
 *    not-query   - the view is not a QueryTable at all
 *    read        - the SQL is here (an *empty* query is still `read`; emptiness is Zoho's answer)
 *    unread      - the pull failed for this one, or the mirror lost the file; `error` says which */
function sqlState(id) {
  const v = viewById().get(id);
  if (!v || v.type !== 'QueryTable') return { kind: 'not-query' };
  const failure = (pullFailed || []).find((f) => String(f.id) === String(id) && f.stage === 'sql');
  if (failure) return { kind: 'unread', error: failure.error || 'the pull could not read it' };
  if (sqlDiskUnread.has(String(id))) return { kind: 'unread', error: 'the .sql file could not be read' };
  const q = sqls[id];
  if (!q) return { kind: 'unread', error: 'its SQL is missing from the mirror' };
  return { kind: 'read', query: q };
}
function aiFindView(q) {
  if (!q) return null;
  const low = String(q).toLowerCase();
  return views.find((v) => v.id === String(q)) || views.find((v) => (v.name || '').toLowerCase() === low)
    || views.find((v) => (v.name || '').toLowerCase().includes(low)) || null;
}
function aiStructureText(v) {
  const m = viewById();
  const chain = structureChain(v, m);
  if (!chain) return `${v.name} (${v.type}) has no columns and no reachable source.`;
  const src = chain[chain.length - 1], t = schema[src.id];
  const { out, inc } = foreignKeys(src.id);
  let s2 = `${src.name} (${t.kind}${t.system ? ', system table - synced by Zoho, not built by the user' : ''})`;
  if (chain.length > 1) s2 += `\n(structure inherited by ${v.name} through ${chain.slice(0, -1).map((c) => c.name).join(' → ')})`;
  s2 += '\n| Column | Type | References |\n';
  t.columns.forEach((c) => {
    const refs = [].concat((out.get(c.name) || []).map((f) => `→ ${f.name}.${f.column}`), (inc.get(c.name) || []).map((f) => `← ${f.name}.${f.column}`)).join(', ');
    s2 += `| ${c.name} | ${c.type} | ${refs} |\n`;
  });
  return s2;
}

// The workspace, stated as compactly as it can be, in layers of decreasing importance.
//
// A workspace of a thousand views does not fit in a system prompt sent with every message, so the
// question is not "how big a cap" but "what gets dropped when it does not fit". Dropping the tail is
// the wrong answer: it cuts an arbitrary half and the model cannot tell it is missing.
//
// The order below is the answer. Data objects are the vocabulary - you cannot write a query, follow
// a foreign key or judge whether something already exists without knowing the tables, so they are
// never dropped. Reports and dashboards are findable by name through list_views, so they go first if
// something must. Whatever is left out is *named as left out*, in the prompt itself, with what to
// call instead - an index that is silently short is worse than one that is honestly partial.
const AI_SEED_CAP_DEFAULT = 72000;
// What one answer may cost, and it is the reader's to set. It was 4096, written here when a model
// answered straight away - and a model that reasons first spends this on the reasoning: measured
// from a real question, 4,096 output tokens, **every one of them thinking**, `stop_reason:
// max_tokens`, and not a character of answer. The panel then said «(empty response)».
//
// 16384 because the failure is silent and the cost of the ceiling being too low is a wasted call,
// while the cost of it being too high is only the tokens actually used. The number itself has not
// been measured against a real workload here - it is a starting point, and it is in Settings.
const AI_MAX_TOKENS_DEFAULT = 16384;
let aiSeedSize = 0;                     // what the last index actually came to, shown in the chat

async function aiBuildSeed(cap, op = beginWorkspaceOp()) {
  if (!op.current()) throw new Error(WS_MOVED);
  cap = Math.max(4000, Number(cap) || AI_SEED_CAP_DEFAULT);
  const m = viewById();
  const byType = new Map();
  for (const v of views) byType.set(v.type, (byType.get(v.type) || 0) + 1);
  const cols = Object.values(schema).reduce((n, t) => n + t.columns.length, 0);

  const header = `Workspace: ${bound ? (bound.name || bound.workspace) : '?'} (id ${bound ? bound.workspace : '?'})\n`
    + `${views.length} views - ` + [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') + '\n'
    + `${Object.keys(schema).length} data objects, ${cols} columns, ${relations.length} relations`
    + (deps ? `, ${views.filter(isOrphanCandidate).length} nothing depends on` : ', lineage not pulled') + '\n'
    + '\nKey: [T] table, [Q] query table, sys = put there by Zoho not by the user, Nc = columns.\n'
    + 'Report types: [A] AnalysisView, [P] Pivot, [R] Report, [S] SummaryView.\n';

  const tables = `\n## Tables and query tables (${Object.keys(schema).length})\n`
    + Object.entries(schema).sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([, t]) => `${t.name} [${t.kind === 'QueryTable' ? 'Q' : 'T'}${t.system ? ',sys' : ''}] ${t.columns.length}c`).join('\n') + '\n';

  const pres = views.filter((v) => !schema[v.id] && v.type !== 'Dashboard');
  let reports = '';
  if (pres.length) {
    const byParent = new Map();
    for (const v of pres) {
      const p = v.parent && m.get(v.parent) ? m.get(v.parent).name : '(unknown source)';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(`${v.name} [${v.type[0]}]`);
    }
    reports = `\n## Reports and pivots (${pres.length}), grouped by what they are built on\n`
      + [...byParent.entries()].sort((a, b) => b[1].length - a[1].length)
        .map(([p, list]) => `${p} → ${list.join(', ')}`).join('\n') + '\n';
  }
  const dashList = views.filter((v) => v.type === 'Dashboard');
  const dashboards = dashList.length ? `\n## Dashboards (${dashList.length})\n` + dashList.map((v) => v.name).join(', ') + '\n' : '';

  // Assemble in priority order, and record what did not fit rather than letting it vanish.
  const omitted = [];
  let out = header + tables;
  if (out.length + reports.length <= cap) out += reports;
  else if (reports) omitted.push(`the ${pres.length} reports and pivots`);
  if (out.length + dashboards.length <= cap) out += dashboards;
  else if (dashboards) omitted.push(`the ${dashList.length} dashboards`);

  if (!op.current()) throw new Error(WS_MOVED);
  // One list, read by both readers, and the note counted against the ceiling. This used to
  // **replace** `aiSeedOmitted` when the table list alone overflowed, while the note inside the
  // index went on naming only what had been dropped before that - so the panel said «part of the
  // table list» and the index said «the 30 reports and pivots», and the model was never told the one
  // absence that changes its answers. It also appended the note *after* truncating, which put the
  // seed back over the cap: measured at 4,222 against 4,000, with 700 tables.
  //
  // The CRM twin was corrected first and this was not, in a session about fixes that reach one half
  // of a pair. Reported from outside, with that number.
  if (out.length > cap) omitted.unshift('part of the table list - this workspace is larger than the index can hold');
  aiSeedOmitted = omitted;
  const note = omitted.length
    ? `\nNOT LISTED ABOVE: ${omitted.join(' and ')}. They exist and you can find them by name`
      + ` with list_views (it takes a name substring and a type) - do not assume a view is absent`
      + ` because it is not in this index.\n`
    : '';
  // `aiTrunc` adds its own «(truncated)» marker, so the room to leave is the note and that.
  const MARK = '\n\u2026 (truncated)'.length;
  if (out.length + note.length > cap) out = aiTrunc(out, Math.max(0, cap - note.length - MARK));
  out += note;
  aiSeedTruncated = omitted.length > 0 || out.length >= cap;
  aiSeedSize = out.length;
  return out;
}

// The extension's own help, so "how do I export this?" is answered where the user already is
// rather than by sending them to a website - which would move the question rather than answer it.
// Guarded: a missing script must cost the product primer, never the whole assistant.
function productHelp() {
  try { return '\n' + window.ZOOST_PRODUCT_HELP.text() + '\n'; } catch (_) { return ''; }
}

async function aiSystemPrompt(withTools, cap, op = beginWorkspaceOp()) {
  const seed = await aiBuildSeed(cap, op);
  let focus = '';
  const cur = selectedId ? viewById().get(selectedId) : null;
  if (cur) {
    focus = `\n# CURRENT FOCUS\nThe user is looking at ${cur.name} (${cur.type}).\n${aiStructureText(cur)}\n`;
    const st = await sqlReadState(cur.id, op);
    if (st.kind === 'unread') focus += `\nIt is a query table whose SQL could not be read - do not conclude anything from its absence.`;
    if (st.kind === 'read') focus += `\nIts SQL:\n\u0060\u0060\u0060sql\n${aiTrunc(sqlText(st.body), 4000)}\n\u0060\u0060\u0060\n`;
  }
  const toolsLine = withTools
    // Named from the registry, never typed. This list is complete today by care alone, and the
    // CRM twin's was not: `list_actions` was added there and the sentence stayed at ten names.
    ? `You have READ-ONLY tools over the local mirror: ${AI_TOOLS.map((t) => t.name).join(', ')}. Use them to fetch exact structure and SQL instead of guessing. get_view returns the whole dossier for one view - structure, foreign keys, SQL and lineage - so prefer it over three narrower calls, and prefer search_columns or search_sql over opening views one at a time.`
    : 'Answer from the WORKSPACE INDEX and CURRENT FOCUS below. If you need a structure or a query that is not shown, say which view you would need rather than inventing it.';
  return `You are an expert assistant for Zoho Analytics, working on the user\'s real workspace.\n${toolsLine}\n`
    + `Reference real view and column names. Zoost is read-only: it never creates, edits or deletes anything in Zoho Analytics, and it never reads the rows in a table - so you know structure, relations and SQL, never data values. Never claim to know what is in the data.\n`+ `If a query table's SQL comes back as unreadable or empty, say so and stop there. Do not reconstruct what a query probably does from column names and lineage and present it as its logic - a plausible reconstruction of code the user cannot check is worse than \"I could not read it\".\n\n`
    + `${window.ZOHO_ANALYTICS_SQL.text()}\n`
    + `${productHelp()}${focus}\n# WORKSPACE INDEX\n${seed}`;
}

const AI_TOOLS = [
  { name: 'list_views', description: 'List views in the workspace. Optionally filter by a substring of the name, by type (Table, QueryTable, Pivot, AnalysisView, SummaryView, Report, Dashboard), and/or by a minimum column count.', input_schema: { type: 'object', properties: { filter: { type: 'string' }, type: { type: 'string' }, min_columns: { type: 'number' } } } },
  { name: 'get_view', description: 'THE DOSSIER for one view, in a single call: type, folder, owner, dates, what it is built on, its full column list with data types and foreign keys, its SQL if it is a query table, its relations, and what reads from it. Prefer this over calling get_structure, get_sql and who_uses separately.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_structure', description: 'Columns and Zoho data types of a table or query table, with each column\'s foreign keys in both directions. For a report or pivot, returns the structure it inherits and says so.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_sql', description: 'The SQL source of a query table, with the source tables and the columns it involves.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'search_sql', description: 'Full-text search across every query table\'s SQL. Returns the view names that match.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'search_columns', description: 'Find which tables have a column whose name matches. Use this to answer "where is this data" before writing a query.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_relations', description: 'Relations (joins) a table takes part in, in both directions, as Zoho writes them. Omit the name for the whole workspace.', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'who_uses', description: 'What reads from a view, transitively, plus the dashboards it appears on.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'orphans', description: 'Views that nothing in the workspace depends on. Candidates, not a verdict.', input_schema: { type: 'object', properties: {} } },
];

// A tool that answers with nine hundred lines has not answered. Cap the list, say how many there
// were, and say how to narrow - the model can then ask a better question instead of drowning in the
// first one.
function aiCap(lines, total, how, limit = 120) {
  if (lines.length <= limit) return lines.join('\n');
  return lines.slice(0, limit).join('\n')
    + `\n… and ${total - limit} more (${total} in all). ${how}`;
}

async function aiExecTool(name, input, op = beginWorkspaceOp()) {
  input = input || {};
  const m = viewById();
  if (name === 'list_views') {
    const f = (input.filter || '').toLowerCase(), ty = (input.type || '').toLowerCase(), minc = Number(input.min_columns) || 0;
    const rows = views.filter((v) => (!f || (v.name || '').toLowerCase().includes(f)) && (!ty || (v.type || '').toLowerCase() === ty)
      && (!minc || (schema[v.id] ? schema[v.id].columns.length : 0) >= minc));
    if (!rows.length) return `0 views match. ${views.length} in the workspace.`;
    const lines = rows.map((v) => `${v.name} [${v.type}]${schema[v.id] ? ' ' + schema[v.id].columns.length + ' cols' : ''}${v.folderName ? ' · ' + v.folderName : ''}`);
    return `${rows.length} of ${views.length} views:\n`
      + aiCap(lines, rows.length, 'Narrow with `filter` (a name substring), `type`, or `min_columns`.');
  }
  // Global tools take a `query`, not a view: resolving `input.name` first answered
  // «View not found: undefined» for both searches, so two tools the system prompt advertises had
  // never once run. Reproduced by an outside scan; a registry-derived test now runs every tool.
  const GLOBAL = name === 'orphans' || name === 'search_sql' || name === 'search_columns';
  const v = GLOBAL ? null : aiFindView(input.name);
  if (!v && !GLOBAL && !(name === 'get_relations' && !input.name)) return 'View not found: ' + input.name;
  if (name === 'get_view') {
    // Everything about one view in one step. It used to answer the metadata alone, so any real
    // question cost three or four calls - which is how a limit of eight ran out on a single
    // question. The tools are the expensive part of an agent loop; making each one answer more is
    // worth more than adding steps.
    const d = deps && deps[v.id];
    let out = `${v.name}\ntype: ${v.type}\nfolder: ${v.folderName || '(none)'}\nowner: ${v.owner || ''}\n`
      + `built_on: ${v.parent && m.get(v.parent) ? m.get(v.parent).name : '(nothing - it is a data object)'}\n`
      + `design_changed: ${v.designModifiedAt ? shortDate(v.designModifiedAt) : v.designModifiedText + ' (Zoho\'s own text, not machine-readable)'}\n`
      + `data_changed: ${shortDate(v.dataModifiedAt)}\n`
      + `system_table: ${!!v.system}\ndescription: ${v.description || '(none)'}\n`;
    out += '\n' + aiStructureText(v) + '\n';
    const rs = relationsOf(v.id);
    if (rs.length) out += `\nrelations (${rs.length}):\n` + rs.map((r) => `${r.sourceName} → ${r.targetName}   ${r.relation}`).join('\n') + '\n';
    const st = await sqlReadState(v.id, op);
    if (st.kind === 'unread') out += `\nSQL could not be read (${st.error}) - do not conclude anything from its absence.\n`;
    else if (st.kind === 'read') {
      const src = Object.entries(st.query.sources || {}).map(([, sd]) => `${sd.name} (${sd.columns.length} columns involved)`).join(', ');
      out += `\nsource tables: ${src || '(none recorded)'}\nSQL:\n${sqlText(st.body)}\n`;
    }
    out += d
      ? `\nreads_from: ${d.parents.map((x) => nameOf(x.id, m)).join(', ') || '(none)'}\nread_by: ${d.children.map((x) => nameOf(x.id, m)).join(', ') || '(none)'}\non_dashboards: ${d.dashboards.map((x) => nameOf(x, m)).join(', ') || '(none)'}\n`
        + 'Note: Zoho Analytics only knows what its own views read from each other - a shared link, a scheduled export or an API consumer is invisible to it.'
      : '\nlineage: not pulled';
    return out;
  }
  if (name === 'get_structure') return aiStructureText(v);
  if (name === 'get_sql') {
    const st = await sqlReadState(v.id, op);
    if (st.kind === 'not-query') return `${v.name} is a ${v.type}, not a query table - it has no SQL.`;
    if (st.kind === 'unread') return `${v.name} IS a query table, but its SQL could not be read (${st.error}). Retry failed / Pull all fetches it - do not conclude anything from its absence.`;
    const q = st.query;
    const src = Object.entries(q.sources || {}).map(([, sdef]) => `${sdef.name} (${sdef.columns.length} columns involved)`).join(', ');
    return `${v.name}\nsource tables: ${src || '(none recorded)'}\n\n${sqlText(st.body)}`;
  }
  if (name === 'search_sql') {
    // With the matching line beside each name the model can usually answer without opening the
    // query at all - a bare list of names made every hit cost another call.
    const q = String(input.query || '').toLowerCase(); if (!q) return '(empty query)';
    const hits = []; let searched = 0, unread = 0;
    const qts = views.filter((x) => x.type === 'QueryTable');
    for (const vv of qts) {
      const st = await sqlReadState(vv.id, op);
      if (st.kind === 'unread') { unread++; continue; }
      searched++;
      const body = st.body;
      if (!body || !body.toLowerCase().includes(q)) continue;
      const line = body.split('\n').find((l) => l.toLowerCase().includes(q)) || '';
      hits.push(`${vv.name}\n    ${line.trim().slice(0, 160)}`);
    }
    // Coverage travels with the answer: «no matches» over 47 of 50 queries is a different fact from
    // «no matches» over all of them, and only the search knows which it was.
    const cover = unread ? ` Searched ${searched}/${qts.length} query tables - ${unread} SQL source(s) were unreadable, so absence is not exhaustive.` : '';
    return hits.length ? `${hits.length} query table(s) contain "${input.query}":${cover}\n` + aiCap(hits, hits.length, MSG.narrow, 60)
                       : `(no matches)${cover}`;
  }
  if (name === 'search_columns') {
    const q = String(input.query || '').toLowerCase(); if (!q) return '(empty query)';
    const hits = [];
    for (const [id, t] of Object.entries(schema)) {
      const cols = t.columns.filter((c) => c.name.toLowerCase().includes(q));
      if (cols.length) hits.push(`${t.name} [${t.kind}]: ` + cols.map((c) => `${c.name} (${c.type})`).join(', '));
    }
    return hits.length ? `${hits.length} table(s) have a matching column:\n` + aiCap(hits, hits.length, MSG.narrow) : '(no matches)';
  }
  if (name === 'get_relations') {
    const list = v ? relationsOf(v.id) : relations;
    if (!list.length) return v ? `${v.name} takes part in no relation.` : 'No relations in this workspace.';
    return `${list.length} relation(s):\n` + aiCap(list.map((r) => `${r.sourceName} → ${r.targetName}   ${r.relation}`), list.length, 'Pass a table name to see only its relations.');
  }
  if (name === 'who_uses') {
    const d = deps && deps[v.id];
    if (!d) return `No lineage for ${v.name} - it was not pulled.`;
    return `${v.name} is read by ${d.children.length} view(s) and appears on ${d.dashboards.length} dashboard(s).\n`
      + (d.children.map((x) => `- ${nameOf(x.id, m)} (level ${x.level})`).join('\n') || '(nothing reads from it)')
      + `\nNote: Zoho Analytics only knows what its own views read from each other. A shared link, a scheduled export, an embedded report or an API consumer is invisible to it.`;
  }
  if (name === 'orphans') {
    if (!deps) return 'Lineage was not pulled, so this cannot be answered.';
    const o = views.filter(isOrphanCandidate);
    const byType = new Map();
    for (const x of o) byType.set(x.type, (byType.get(x.type) || 0) + 1);
    return `${o.length} candidate(s) that nothing in this workspace depends on - candidates, not a verdict.\n`
      + 'By type: ' + [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') + '\n'
      + aiCap(o.map((x) => `- ${x.name} [${x.type}]`), o.length, 'Use list_views with a type to see the rest.')
      + '\nAnalytics only knows what its own views read from each other: a shared link, a scheduled export, an embedded report or an API consumer is invisible to it.';
  }
  return 'Unknown tool: ' + name;
}

// Transport and rendering, ported verbatim in behaviour from the CRM panel: streaming Anthropic
// agent loop, single-shot OpenAI with the max_tokens → max_completion_tokens retry on that specific
// 400 (newer models reject the older field). Only the two engines the manifest grants host access to
// are supported, because those are the two that are tested.
function aiMarkdown(src) {
  const codes = [];
  let t = esc(src == null ? '' : src);
  t = t.replace(/\u0060\u0060\u0060(\w*)\n?([\s\S]*?)\u0060\u0060\u0060/g, (mm, lang, code) => { codes.push('<pre class="aicode">' + code.replace(/\n+$/, '') + '</pre>'); return '\uE000' + (codes.length - 1) + '\uE001'; });
  t = t.replace(/\u0060([^\u0060\n]+)\u0060/g, (mm, c) => { codes.push('<code>' + c + '</code>'); return '\uE000' + (codes.length - 1) + '\uE001'; });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>');
  t = t.replace(/^\s*[-*]\s+(.*)$/gm, '• $1');
  // `escHtml` escapes `& < >` and not `"`, and the URL pattern admits one - so a link the model
  // writes as `[x](https://a/"style="…)` closes the href and opens an attribute of its own. The
  // model reads Deluge source from the org, which is the prompt-injection path `docs/boundaries.md`
  // names, so this string is not ours. The CSP stops an inline handler; it does not stop a `style`
  // that covers the panel, nor an href that differs from the text shown. The quote is escaped in the
  // *replacement*, by function rather than by `$2`, so nothing else in the URL is touched twice -
  // `&` has already been through escHtml and must not be encoded again.
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, text, href) => `<a href="${escQ(href)}" target="_blank" rel="noopener">${text}</a>`);
  t = t.replace(/\n/g, '<br>');
  t = t.replace(/\uE000(\d+)\uE001/g, (mm, i) => codes[+i]);
  return t;
}
function aiToolArg(input) { try { const t = JSON.stringify(input || {}); return t.length > 60 ? t.slice(0, 57) + '…' : t; } catch (_) { return ''; } }
function aiToolEvent(name, input) { aiMessages.push({ role: 'tool', content: `🔧 ${name}(${aiToolArg(input)})` }); aiRenderMessages(); }

let AI_MAX_TOKENS = AI_MAX_TOKENS_DEFAULT;   // set from the saved config before each run
async function aiStreamAnthropic(a, msgs, system, tools, onText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': a.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: a.model, max_tokens: AI_MAX_TOKENS, system, tools, messages: msgs, stream: true }) });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${aiTrunc(await res.text(), 300)}`);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const blocks = []; let stop_reason = null;
  const handle = (evt, data) => {
    // A block is text, a tool call, or **thinking** - and the third was being read as the first.
    // A model that reasons before answering opens a `thinking` block, and this mapped every
    // non-tool block to `{ type: 'text', text: '' }`; its `thinking_delta`s then matched no
    // branch below, so the block stayed empty, was dropped as an empty text block, and the
    // panel said «(empty response)». Measured from a HAR of a real question: one block, type
    // `thinking`, deltas `thinking_delta` and `signature_delta`, no text and no tool_use.
    //
    // Kept rather than ignored, because what it costs is the thing to report: the whole answer
    // budget can go into it, and a reader who is told «empty» learns nothing about that.
    if (evt === 'content_block_start') {
      const t = data.content_block.type;
      blocks[data.index] = t === 'tool_use'
        ? { type: 'tool_use', id: data.content_block.id, name: data.content_block.name, _json: '' }
        : t === 'thinking' || t === 'redacted_thinking' ? { type: 'thinking' }
        : { type: 'text', text: '' };
    }
    else if (evt === 'content_block_delta') { const b = blocks[data.index]; if (!b || b.type === 'thinking') return; if (data.delta.type === 'text_delta') { b.text += data.delta.text; onText && onText(data.delta.text); } else if (data.delta.type === 'input_json_delta') { b._json += data.delta.partial_json || ''; } }
    else if (evt === 'content_block_stop') { const b = blocks[data.index]; if (b && b.type === 'tool_use') { try { b.input = JSON.parse(b._json || '{}'); } catch (_) { b.input = {}; } delete b._json; } }
    else if (evt === 'message_delta') { if (data.delta && data.delta.stop_reason) stop_reason = data.delta.stop_reason; }
  };
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let evt = null, dataStr = '';
      chunk.split('\n').forEach((ln) => { if (ln.startsWith('event:')) evt = ln.slice(6).trim(); else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim(); });
      if (evt && dataStr) { try { handle(evt, JSON.parse(dataStr)); } catch (_) {} }
    }
  }
  // Thinking is not shown and is not sent back, and the second half is measured rather than
  // assumed. The recorded conversation shows two assistant turns of `tool_use` with no
  // thinking block in what we sent, five messages deep, answered 200 - so the API accepts a
  // turn whose reasoning was dropped, at least while `thinking` is not requested, and this
  // panel never requests it.
  //
  // **What is not established**: Anthropic documents that with extended thinking *enabled*
  // over tool use the thinking blocks have to be passed back. We do not enable it and get
  // one anyway. Sending them back untested could break the thing that currently works, so it
  // is left as it is and written down here instead of being guessed at - the boundary this
  // rests on, in our own voice rather than found later in a stack trace.
  //
  // What it does carry out is *whether* there was any, because that is what explains a turn
  // that produced nothing else.
  const thought = blocks.some((b) => b && b.type === 'thinking');
  const content = blocks.filter(Boolean).filter((b) => b.type !== 'thinking').map((b) => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : { type: 'text', text: b.text }).filter((b) => b.type !== 'text' || (b.text && b.text.trim() !== ''));
  return { content, stop_reason, thought };
}

async function aiRunAnthropicAgent(a, apiMessages, system, tools, maxIter, current = () => true, op = beginWorkspaceOp()) {
  const msgs = apiMessages.slice();
  for (let iter = 0; iter < maxIter; iter++) {
    let bubble = null, el = null;
    const onText = (t) => {
      if (!current()) return;
      if (!bubble) { bubble = { role: 'assistant', content: '' }; aiMessages.push(bubble); aiRenderMessages(); const ns = $('aimsgs').querySelectorAll('.aimsg.assistant .aitext'); el = ns[ns.length - 1]; }
      bubble.content += t; if (el) { el.innerHTML = aiMarkdown(bubble.content); $('aimsgs').scrollTop = $('aimsgs').scrollHeight; }
    };
    const { content, stop_reason, thought } = await aiStreamAnthropic(a, msgs, system, tools, onText);
    if (!current()) return;
    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (stop_reason !== 'tool_use' || !toolUses.length) {
      // **A half answer is not an answer, and it looked exactly like one.** The explanation below
      // only fires when *nothing* was streamed; when the model starts writing and then reaches the
      // budget, the reader is left with a paragraph that stops mid-sentence and no way to tell that
      // from a model that had finished. Written the same way in the twin.
      if (bubble && stop_reason === 'max_tokens') {
        bubble.content += `\n\n---\n*Cut off here: the model reached its answer budget of ${AI_MAX_TOKENS} tokens.`
          + ' Ask a narrower question, or raise **Answer budget** in Settings.*';
        aiRenderMessages();
      }
      if (!bubble) {
        const txt = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        // «(empty response)» was what a turn that hit its answer budget looked like, and it names
        // neither the cause nor the remedy - on a call the reader has paid for. Measured from a
        // HAR: `stop_reason: max_tokens`, 4,096 output tokens, every one of them thinking, and
        // not one character of answer. The input was 40,120 tokens, so the index sent with each
        // message was nowhere near the problem, which is the first thing anyone would suspect.
        aiMessages.push({ role: 'assistant', content: txt || (stop_reason === 'max_tokens'
          ? `The model reached its answer budget of ${AI_MAX_TOKENS} tokens`
            + (thought ? ' while still reasoning, and never began the answer' : ' before finishing')
            + '. Nothing was lost and nothing was written. Ask again - a narrower question costs'
            + ' less of that budget - or raise **Answer budget** in Settings.'
          : '(the model returned nothing at all - no answer, no reasoning and no tool call)') });
        aiRenderMessages();
      }
      return;
    }
    msgs.push({ role: 'assistant', content });
    const results = [];
    for (const tu of toolUses) {
      if (!current()) return;
      aiToolEvent(tu.name, tu.input);
      let out; try { out = await aiExecTool(tu.name, tu.input, op); } catch (e) { out = MSG.errPrefix + e.message; }
      if (!current()) return;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
    }
    msgs.push({ role: 'user', content: results });
  }
  if (!current()) return;
  aiMessages.push({ role: 'assistant', content: `(Reached the tool-step limit of ${maxIter}. Raise it in Settings or ask something more specific.)` }); aiRenderMessages();
}

async function aiCall(cfg, messages, system) {
  const o = cfg.openai;
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  async function post(limitField) {
    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
      // **The budget the reader set, not a number written here.** Settings says «Tokens one answer
      // may cost» and names that box in the message the panel prints when a reply is cut - and this
      // engine ignored it and sent 4096, so raising it changed nothing and the explanation sent the
      // reader to change model for an output ceiling. The other engine has read it since it shipped.
      body: JSON.stringify({ model: o.model, messages: msgs, [limitField]: AI_MAX_TOKENS }),
    });
  }
  // Older chat models want `max_tokens`; newer OpenAI models reject it and require
  // `max_completion_tokens`. Try the classic field, then retry once on that specific complaint.
  let res = await post('max_tokens');
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && /max_completion_tokens/.test(body)) res = await post('max_completion_tokens');
    else throw new Error(`API ${res.status}: ${aiTrunc(body, 300)}`);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${aiTrunc(await res.text(), 300)}`);
  const d = await res.json();
  const c = d.choices && d.choices[0];
  const txt = (c && c.message && c.message.content) || '';
  if (!txt && c && c.finish_reason === 'length') return '(The model hit the output limit before writing anything - this usually means the workspace context is too large for it. Try a model with a bigger context window.)';
  // The same cut, the other engine: text *and* a length stop is a truncated answer, and it used to
  // be returned as if it were whole.
  if (txt && c && c.finish_reason === 'length')
    return txt + '\n\n---\n*Cut off here: the model reached its output limit. Ask a narrower question.*';
  return txt;
}

function aiRenderMessages() {
  const box = $('aimsgs');
  // **Absent, not present-and-pointless, when there is nothing to clear.** Every other control here
  // disappears rather than sitting there greyed: the retry button, the per-mode rows. This one stayed
  // on an empty conversation, offering to remove nothing. Reported by the author, who had written the
  // convention it was breaking.
  $('aiclear').style.display = aiMessages.length ? '' : 'none';

  if (!aiMessages.length && !aiBusy) { box.innerHTML = '<div class="aimsg assistant"><div class="aitext">Ask me anything about this workspace - I can read structures, follow foreign keys, open the SQL of a query table, search columns, and say what depends on what.</div></div>'; return; }
  box.innerHTML = aiMessages.map((m) => m.role === 'tool' ? `<div class="aitool">${esc(m.content)}</div>` : `<div class="aimsg ${m.role}"><div class="airole">${m.role === 'user' ? 'You' : 'AI'}</div><div class="aitext">${m.role === 'assistant' ? aiMarkdown(m.content) : esc(m.content).replace(/\n/g, '<br>')}</div></div>`).join('')
    + (aiBusy ? '<div class="aiwait"><i></i><i></i><i></i> thinking…</div>' : '');
  box.scrollTop = box.scrollHeight;
}

async function aiSend() {
  if (aiBusy) return;
  const op = beginWorkspaceOp(), gen = aiGen;
  const current = () => op.current() && gen === aiGen;
  const cfg = await aiGetCfg();
  if (!current()) return;
  aiEngineChrome();
  if (aiLocked(cfg)) { aiShowLock(true); return; }
  if (!(await aiEnsureFiles())) { status('Folder access needs re-granting - press \u21bb Refresh, then ask again.', 'warn'); return; }
  if (!current()) return;
  if (!aiActiveReady(cfg)) { openSettings('#ai'); status('Set the model and API key in Settings (just opened), then try again.', 'warn'); return; }
  const inp = $('aiinput'); const text = inp.value.trim(); if (!text) return;
  inp.value = ''; aiMessages.push({ role: 'user', content: text });
  aiBusy = true; $('aisend').disabled = true; aiRenderMessages(); status('AI thinking…', 'busy');
  // `finally`, not the last line. Everything from here on can exit through `if (!current())` - the
  // workspace was left, or the conversation was cleared - and each of those exits used to leave
  // `aiBusy` true and the Send button disabled *for the life of the panel*, with the «thinking…»
  // dots still on screen. Every later question then returned at the first line.
  //
  // It was reachable without changing workspace at all: `wsGen` is bumped by every selection,
  // including re-selecting the one already open (the ✎ rename, ↻ Refresh after a lapsed permission,
  // the capture-phase re-grant click), while `dropWorkspaceState` - the only other place that clears
  // this flag - runs only when the workspace actually differs. The flag is owned by the function
  // that sets it, so it is released here whatever happens. Same fix in the CRM twin.
  try {
    const apiMessages = aiMessages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim() !== '').map((m) => ({ role: m.role, content: m.content }));
    const withTools = cfg.active === 'anthropic';
    const system = await aiSystemPrompt(withTools, cfg.seedCap, op);
    if (!current()) return;
    // The workspace index sent to the model is capped. If it was cut, say so once - do not let the
    // user assume the model saw everything. Claude can still look things up; OpenAI cannot.
    if (aiSeedTruncated && !aiSeedWarned) {
      aiSeedWarned = true;
      const what = aiSeedOmitted.length ? aiSeedOmitted.join(' and ') : 'part of the index';
      aiMessages.push({ role: 'tool', content: `ℹ️ Large workspace: ${what} could not fit in the index sent with each message. `
        + (withTools ? 'Claude can still find them by name with its tools - the tables are always included in full.' : 'OpenAI answers in one pass and cannot look them up, so ask about specific views by name.') });
      aiRenderMessages();
    }
    // The reader's ceiling reaches the request here, once, before the loop that spends it.
    AI_MAX_TOKENS = cfg.maxTokens || AI_MAX_TOKENS_DEFAULT;
    if (withTools) await aiRunAnthropicAgent(cfg.anthropic, apiMessages, system, AI_TOOLS, cfg.maxIter || 20, current, op);
    else { const reply = await aiCall(cfg, apiMessages, system); if (!current()) return; aiMessages.push({ role: 'assistant', content: reply || '(empty response)' }); }
    if (!current()) return;
    status('', '');
  } catch (e) { if (!current()) return; aiMessages.push({ role: 'assistant', content: friendlyError(e) }); status('AI error', 'warn'); }
  finally {
    // `gen === aiGen`, not unconditionally. The first version of this released whatever it found,
    // and that is a different defect rather than a fix: press **Clear** during a send and
    // `clearConversationState()` bumps `aiGen`, clears the flag and enables Send - so the next
    // question starts a second `aiSend`, and when the *first* one finally returns its `finally`
    // releases the second one's flag. A third click then runs two agent loops into one conversation.
    //
    // The rule the fix was written for is «the flag is owned by the function that sets it», and
    // ownership is the generation: if `aiGen` has moved, somebody else has already taken the flag
    // and cleared it, and this send must not touch it. If it has not moved, this send owns it and
    // releases it however it ended - including when the workspace changed under it, which is the
    // wedge the fix was for.
    if (gen === aiGen) {
      aiBusy = false;
      const send = $('aisend'); if (send) send.disabled = false;
    }
  }
  if (!current()) return;
  aiRenderMessages();
}

async function aiEngineChrome() {
  const b = $('aiengbadge'), note = $('ainote');
  if (!b || !note) return;
  const cfg = await aiGetCfg();
  aiShowLock(aiLocked(cfg));      // the chrome refresh is the one place that already re-reads the config
  if (cfg.active === 'anthropic') { b.textContent = 'Claude · agent'; b.className = 'agent'; note.className = 'ainote'; }
  else {
    b.textContent = 'OpenAI · single-shot'; b.className = 'single';
    $('ainotetxt').innerHTML = 'OpenAI answers in <b>one pass</b>: it sees the workspace index plus the view you have open, '
      + 'and cannot go and read other structures by itself - so it will ask you for what it is missing. '
      + 'Switch to Claude in Settings for an agent that explores the whole workspace on its own.';
    note.className = 'ainote show';
  }
}
// The index is sent with *every* message, so its size is what each question costs before you have
// asked anything. Showing it is the only way the setting that caps it can be a real choice rather
// than a number in a form: build it once, measure, and say so.
async function aiContextLabel() {
  const op = beginWorkspaceOp();
  const el = $('aictx'); if (!el) return;
  const v = selectedId ? viewById().get(selectedId) : null;
  const focus = v ? `Focus: ${v.name}` : 'No view focused - open one to give structure-level context';
  let cost = '';
  try {
    const cfg = await aiGetCfg();
    await aiBuildSeed(cfg.seedCap, op);
    if (!op.current()) return;
    // Counts the product primer too. A figure reporting only the index would understate what is
    // actually billed, and this line exists precisely so the knob and its consequence sit in the
    // same sentence.
    const total = aiSeedSize + productHelp().length;
    const tok = Math.round(total / 4);
    cost = ` · sent with every message: ${(total / 1000).toFixed(0)}k characters, ~${tok.toLocaleString()} tokens`
      + (aiSeedOmitted.length ? ` · ${aiSeedOmitted.join(' and ')} left out` : '');
  } catch (_) {}
  el.textContent = focus + cost;
}
function toggleAI() {
  if ($('aiview').classList.contains('show')) { closeAI(); return; }
  if (!views.length) return;
  closeHealth();   // one panel at a time
  $('aiview').classList.add('show'); $('askai').classList.add('on'); document.body.classList.add('ai-open');
  aiEngineChrome(); aiRenderMessages();
  aiEnsureFiles().then(aiContextLabel);   // the label reads the mirror too, and fills in when its measurement lands
}
function closeAI() { $('aiview').classList.remove('show'); $('askai').classList.remove('on'); document.body.classList.remove('ai-open'); }
function aiClear() { if (!aiMessages.length) return; if (!window.confirm('Clear this conversation? Only you can clear it - switching workspace does it too, because the old thread was about another workspace.')) return; dropWorkspaceState(); }

// ---------- export ----------
// Coarse scope on purpose: sections, never single views. Kept in IndexedDB beside the folder handle
// rather than chrome.storage, so this build still needs no `storage` permission - the same choice,
// one fewer thing to justify.
const SCOPE_KEYS = ['views', 'structure', 'relations', 'sql', 'lineage', 'health'];
const SCOPE_FULL = { views: true, structure: true, relations: true, sql: true, lineage: true, health: true };
const SCOPE_SAFE = { views: true, structure: true, relations: true, sql: false, lineage: true, health: true };
// The same promise as the CRM's, kept the same way: §4.3 of the privacy policy names «the SQL of your
// query tables» as the sensitive half of an Analytics export, so it starts unticked. Everything else
// stays on.
// Which build wrote a stored preference - declared before the default that stamps itself with it,
// because a `const` used above its declaration throws at load. See the twin for the defect this
// closes: only the *reader* was writing the stamp, so ticking the sensitive section and exporting
// wrote a scope with none, and the next load read that as pre-migration and turned it back off.
const SCOPE_SV = 2;
const SCOPE_DEFAULT = Object.assign({}, SCOPE_FULL, { sql: false, sv: SCOPE_SV });
let expScope = Object.assign({}, SCOPE_DEFAULT);
// What the dialog is editing right now, kept apart from the stored preference for the reason the twin
// records: this dialog saves what you leave it with, so editing the stored value in place meant
// **Cancel did not cancel** - tick «Everything», press Cancel, and the SQL box was ticked when it
// reopened, and stored by the next export. That box is the one §4.3 of the privacy policy names as
// the sensitive half of an Analytics export, which is why it starts unticked and why a transient
// tick must never become a stored preference.
let dlgScope = Object.assign({}, SCOPE_DEFAULT);
async function loadScope() {
  // The twin of the CRM's, for the same reason and with the same one-shot stamp: a scope saved while
  // the dialog opened with the SQL ticked is not evidence that anybody chose it.
  try {
    const v = await window.idbHandle.get('exportScopeAnalytics');
    if (v) {
      if (v.sv !== SCOPE_SV) { v.sql = false; v.sv = SCOPE_SV; await window.idbHandle.set('exportScopeAnalytics', v); }
      expScope = Object.assign({}, SCOPE_DEFAULT, v);
    }
  } catch (_) {}
}
function scopeToUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.checked = !!dlgScope[k]; });
  const q = $('sc_sql'); if (q) q.disabled = !dlgScope.structure;
  $('scwarn').textContent = dlgScope.sql ? '\u26a0 includes the full SQL of every query table' : '';
}
function scopeFromUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) dlgScope[k] = !!e.checked; });
  if (!dlgScope.structure) dlgScope.sql = false;
  scopeToUI();
}
/** What the keyboard can reach while a dialog is up.
 *
 * The scrim is a painted div at z-index 85: it stops the pointer and nothing else. The dialog traps
 * no focus and the background was not inert, so Shift+Tab from an open «What goes into the export»
 * reaches **Export** behind it and Enter asks the same question again - which overwrites the one
 * resolver `askScope` has and abandons the first promise for the life of the panel.
 *
 * `inert` on the two roots rather than a focus trap: it is the platform's own answer, it covers
 * click, focus, Tab and the accessibility tree in one attribute, and it needs no bookkeeping to undo
 * beyond setting it back. The dialogs and the scrim sit outside `#wrap`, so nothing that has to stay
 * reachable is inside what is switched off.
 */
function panelInert(on) {
  // Derived, never named: everything the page is made of except the scrim and the dialogs
  // themselves. The first version listed two ids and **neither existed** - a helper written from
  // memory of a layout, which would have set `inert` on nothing at all and passed every check that
  // only reads the calls. Found by grepping the markup for the names it had invented.
  [...document.body.children].forEach((el) => {
    if (el.id === 'scrim' || el.classList.contains('dlg')) return;
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  });
}
let _scopeResolve = null;
function askScope() {
  return new Promise((resolve) => {
    // The slot holds one question. Overwriting it left whatever was waiting on the older one waiting
    // for the life of the panel, having shown nothing - it had not reached `op.say` yet, so there was
    // no status line to go stale and nothing at all on screen. Settled as «cancelled», which is what
    // it became.
    if (_scopeResolve) _scopeResolve(null);
    // The dialog opens on a copy of what is stored; nothing it does touches the stored value
    // until the reader presses Export.
    dlgScope = Object.assign({}, expScope);
    _scopeResolve = resolve; scopeToUI();
    $('scrim').classList.add('on'); panelInert(true); $('expscope').classList.add('on');
  });
}
function closeScope(ok) {
  $('scrim').classList.remove('on'); panelInert(false); $('expscope').classList.remove('on');
  const r = _scopeResolve; _scopeResolve = null;
  // Export takes what the dialog holds and *then* it becomes the preference; Cancel takes nothing.
  if (ok) expScope = Object.assign({}, dlgScope);
  if (r) r(ok ? Object.assign({}, expScope) : null);
}

// Both reports carry exactly what the panel shows, and nothing invented here: a figure that lives
// only on screen would make the report a quietly lesser copy, and the reader could not know it.
// Same facts as the panel's References column, as text. A report that omitted them would be a
// quietly lesser copy of what the reader saw on screen, and they could not know it.
function fkText(viewId, colName) {
  const { out, inc } = foreignKeys(viewId);
  return [].concat(
    (out.get(colName) || []).map((f) => `→ ${f.name}.${f.column}`),
    (inc.get(colName) || []).map((f) => `← ${f.name}.${f.column}`),
  ).join(', ');
}

/** When each part of this mirror was last read, per area - the line the other product's report has
 *  carried since it existed. A report that says «exported today» while a third of it is two weeks old
 *  is the half-truth this project refuses; the reader gets the fact and decides what it means.
 *
 *  The dates come from what the pull wrote beside the data, so an area nobody has pulled says so
 *  rather than borrowing the newest one. */
/** True when what is on disk was written by a pull older than the current capture schema. */
function mirrorIsOlderThanSchema() {
  return !!bound && !bound.sample && Number(bound.sv || 0) < PULL_SV;
}

function analyticsFreshness() {
  const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : 'never read');
  const parts = [
    // `views.json` carries its own date; the rest of the mirror is written by the same pull, so
    // the config's `lastPull` is what they can honestly claim. Nothing here invents a per-area date
    // the disk does not hold.
    ['Views', viewsPulledAt || (bound && bound.lastPull)],
    ['Structure', bound && bound.lastPull],
    ['Lineage', bound && bound.lastPull],
  ];
  return parts.map(([what, iso]) => `${what} as of ${day(iso)}`).join(' \u00b7 ');
}

function exportSections(sc) {
  const m = viewById();
  const h = healthFindings();
  const out = [];
  if (sc.views) out.push({ id: 'views', title: 'Views', rows: views.map((v) => [v.name, v.type, v.folderName || '—', v.owner || '—', v.designModifiedAt ? shortDate(v.designModifiedAt) : (v.designModifiedText || '—'), shortDate(v.dataModifiedAt), v.system ? 'system' : '']),
    head: ['View', 'Type', 'Folder', 'Owner', 'Design', 'Data', ''], links: [0] });
  if (sc.structure) out.push({ id: 'structure', title: 'Structure', tables: Object.entries(schema).map(([id, t]) => ({ id, ...t })) });
  if (sc.relations) out.push({ id: 'relations', title: 'Relations', rows: relations.map((r) => [r.sourceName, r.targetName, r.relation]), links: [0, 1], head: ['From', 'To', 'Join'] });
  if (sc.sql) out.push({ id: 'sql', title: 'Query table SQL' });
  if (sc.lineage && deps) out.push({ id: 'lineage', title: 'Lineage', rows: views.filter((v) => deps[v.id]).map((v) => [v.name, String(deps[v.id].parents.length), String(deps[v.id].children.length), String(deps[v.id].dashboards.length)]), head: ['View', 'Reads from', 'Read by', 'On dashboards'], links: [0] });
  if (sc.health) out.push({ id: 'health', title: 'Health', h });
  return out;
}

async function buildExportHtml(sc, op = beginWorkspaceOp()) {
  const secs = exportSections(sc);
  const esc2 = esc;
  // The contents the shell draws, which is the one the other product has had all along: a card
  // with a group per chapter and how much is in each. This was a flat two-column list of
  // titles - it said how many chapters there are and nothing about how much is in them, which
  // is the first question anybody opening somebody else's report actually has.
  const toc = reportToc(secs.map((x) => ({
    title: x.title,
    count: x.rows ? x.rows.length : x.tables ? x.tables.length : undefined,
    href: x.id,
    note: `Go to ${x.title}`,
  })));
  // **A report about lineage you cannot click through is not a report about lineage.** The other
  // product's report carries twenty internal anchors - a function to what it calls, to the module
  // it reads, to the rule that fires it - and this one carried exactly one, the contents. Every
  // view named anywhere in the document now points at where that view is described; a name that
  // belongs to no view in this export stays plain text rather than becoming a link to nothing.
  const vAnchor = (id) => 'v-' + String(id).replace(/[^\w.-]+/g, '_');
  const byName = new Map(views.map((v) => [v.name, v.id]));
  // **Which anchors this document will actually contain**, derived from `secs` - the same list the
  // loop below draws from - rather than from the org. The first version linked any name that was a
  // view, and a view is not a section: only tables and query tables get a heading of their own, so
  // every report and dashboard named in a table cell or in a health list became `#v-<id>` pointing
  // at nothing. Reported from a real workspace, with the dead link pasted in.
  //
  // It is the same shape as everything else today: one value stood for two things - «is in the org»
  // and «is in this report» - and they part company as soon as a chapter is unticked, which is a
  // second way to produce the identical defect. A link that goes nowhere is worse than plain text,
  // because the reader clicks it and concludes the document is broken.
  const anchored = new Set();
  for (const x of secs) {
    if (x.tables) for (const t of x.tables) anchored.add(vAnchor(t.id));
    else if (x.id === 'sql') for (const v of views) if (v.type === 'QueryTable') anchored.add(vAnchor(v.id));
  }
  const vLink = (name) => {
    const id = byName.get(name);
    const a = id === undefined ? null : vAnchor(id);
    return a && anchored.has(a) ? `<a href="#${escA(a)}">${esc2(name)}</a>` : esc2(name);
  };
  // `links` names the columns that hold a view's name, so those cells become links and every
  // other cell stays escaped text. Declared per table rather than guessed from the content: a
  // column of owners must not turn into links because somebody is named like a view.
  const tbl = (head, rows, links) => `<table class="ftbl"><thead><tr>${head.map((h2) => `<th>${esc2(h2)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr data-name="${escA(String(r[0] || '').toLowerCase())}">${r.map((c, i) => `<td${i ? '' : ' class="mono"'}>${links && links.includes(i) ? vLink(String(c)) : esc2(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  let body = '';
  for (const x of secs) {
    body += `<h2 id="${escA(x.id)}">${esc2(x.title)}</h2>`;
    if (x.rows) body += tbl(x.head, x.rows, x.links);
    else if (x.tables) body += x.tables.map((t) => `<h3 id="${escA(vAnchor(t.id))}">${esc2(t.name)} <small>${esc2(t.kind)}${t.system ? ' · system' : ''}</small></h3>` + tbl(['Column', 'Type', 'References'], t.columns.map((c) => [c.name, c.type, fkText(t.id, c.name)]))).join('');
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        // Skipping an unread query made the export silently smaller than the workspace: a reader
        // cannot tell a query that was dropped from one that never existed. The heading is always
        // there; what varies is whether the source or the reason sits under it.
        const st = await sqlReadState(v.id, op);
        if (st.kind === 'unread') { body += `<h3 id="${escA(vAnchor(v.id))}">${esc2(v.name)}</h3><p class="note">Its SQL could not be read (${esc2(st.error)}) - Retry failed / Pull all fetches it.</p>`; continue; }
        // Highlighted, like the panel and like the CRM's own report, which has coloured its Deluge
        // since it existed. This one printed plain escaped text: the same query, in two places, one
        // of them readable - and the report is the copy that goes to somebody without the extension,
        // so it is the one that could least afford to be the lesser of the two.
        // `highlightSql` tokenises the raw text and escapes every piece itself, which is the only
        // reason it may be handed to innerHTML at all; the placeholder for «not read» is not SQL and
        // stays on `esc2`.
        const has = st.body != null && st.body.trim();
        body += `<h3 id="${escA(vAnchor(v.id))}">${esc2(v.name)}</h3><pre class="${has ? 'code' : 'note'}">`
          + `${has && window.highlightSql ? window.highlightSql(st.body) : esc2(sqlText(st.body))}</pre>`;
      }
    } else if (x.h) {
      const H = x.h;
      body += `<p><b>${H.counts.views}</b> views · <b>${H.counts.tables}</b> tables · <b>${H.counts.columns}</b> columns · <b>${H.counts.relations}</b> relations · <b>${H.counts.sql}</b> SQL</p>`
        + `<p class="gap">Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.</p>`
        + `<h3>Nothing depends on them (${H.orphans ? H.orphans.length : '—'})</h3><p class="gap">Candidates, not a verdict - a shared link, a scheduled export, an embedded report or an API consumer is invisible to Zoho Analytics' own dependency graph.</p>`
        + (H.orphans ? `<ul>${H.orphans.map((v) => `<li>${vLink(v.name)}<span class="ty">${esc2(v.type)}</span></li>`).join('')}</ul>` : '')
        + `<h3>Tables in no relation (${H.islands.length})</h3><ul>${H.islands.map((t) => `<li>${vLink(t.name)}<span class="ty">${esc2(t.kind)}</span></li>`).join('')}</ul>`
        + `<h3>Put there by Zoho, not by you (${H.system.length})</h3><ul>${H.system.map((v) => `<li>${vLink(v.name)}</li>`).join('')}</ul>`
        + (H.unread.length ? `<h3>Could not be read (${H.unread.length})</h3><ul>${H.unread.map((f) => `<li>${esc2((viewById().get(f.id) || {}).name || f.id)} - ${esc2(f.error)}</li>`).join('')}</ul>` : '');
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Zoost - ${esc2(bound.label || bound.name || bound.workspace)}</title><style>${REPORT_CSS}
:root{--accent:#0e9488}
/* What only this report has. Everything else - the frame, the header, the index, the card, the
   tables, the empty state, the foot - is in reportshell.js, byte-identical in both products. This
   tail used to redefine table, th, td, pre and small as well, so the same tables were drawn by two
   stylesheets and the two documents did not look alike however much markup they shared. A rule here
   that the shell already has is a rule that makes them differ. */
.gap{color:var(--muted);font-size:12.5px;border-left:3px solid var(--line);padding-left:10px}
</style></head><body>
${reportHead(bound.label || bound.name || bound.workspace,
             [`${esc2(bound.label || bound.name || '')} \u00b7 ${esc2(bound.workspace)} \u00b7 ${views.length} views \u00b7 ${Object.keys(schema).length} tables \u00b7 ${relations.length} relations \u00b7 contents: ${esc2(SCOPE_KEYS.filter((k) => sc[k]).join(', ') || 'nothing')}${sc.sql ? '' : ' \u00b7 SQL excluded'}`,
              `Data read from Zoho Analytics: ${esc2(analyticsFreshness())}`],
             'Filter - hides any row, entry or card that does not match\u2026',
             // The tile of this product's own icon - see the CRM's report for why.
             { name: PRODUCT_NAME, version: chrome.runtime.getManifest().version, tile: '#be2a6b' })}
<main>${toc}
${body}</main>
${reportFoot(PRODUCT_NAME, PRODUCT_URL)}
<script>${REPORT_FILTER_JS}</script>
</body></html>`;
}

async function buildExportMarkdown(sc, op = beginWorkspaceOp()) {
  const secs = exportSections(sc);
  const row = (r) => '| ' + r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';
  let out = `# ${bound.label || bound.name || bound.workspace}\n\nZoho Analytics workspace ${bound.label && bound.name ? `${bound.name} ` : ''}\`${bound.workspace}\` · exported ${new Date().toISOString().slice(0, 10)} by ${PRODUCT_NAME} v${chrome.runtime.getManifest().version}\n\n`;
  out += '> Read-only mirror. Zoost never writes to Zoho Analytics and never reads record data.\n\n';
  // The dialect reference is written **before** the sections, so it is listed before them: the
  // contents used to name it last while the document put it first, which shifted every entry
  // after it by one. And its title is taken from the block itself rather than typed again here -
  // a heading and a contents entry that are two copies of one string is how they came apart.
  const sqlRef = window.ZOHO_ANALYTICS_SQL.markdown();
  const sqlTitle = (sqlRef.match(/^## (.+)$/m) || [, 'Zoho Analytics SQL'])[1];
  out += '## Contents\n\n' + [sqlTitle, ...secs.map((x) => x.title)].map((t) => `- ${t}`).join('\n') + '\n\n';
  // The dialect reference travels with the export on purpose: this file exists to be handed to an
  // agent that has never seen Analytics, and a workspace description without the tool's constraints
  // would get it writing SQL that cannot run.
  out += sqlRef + '\n';
  for (const x of secs) {
    out += `## ${x.title}\n\n`;
    if (x.rows) out += row(x.head) + '\n' + row(x.head.map(() => '---')) + '\n' + x.rows.map(row).join('\n') + '\n\n';
    else if (x.tables) for (const t of x.tables) out += `### ${t.name} (${t.kind}${t.system ? ', system' : ''})\n\n| Column | Type | References |\n| --- | --- | --- |\n` + t.columns.map((c) => row([c.name, c.type, fkText(t.id, c.name)])).join('\n') + '\n\n';
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        const st = await sqlReadState(v.id, op);
        if (st.kind === 'unread') { out += `### ${v.name}\n\n> Its SQL could not be read (${st.error}) - Retry failed / Pull all fetches it.\n\n`; continue; }
        const src = st.body;
        out += `### ${v.name}\n\n\u0060\u0060\u0060sql\n${src && src.trim() ? src : '-- ' + sqlText(src)}\n\u0060\u0060\u0060\n\n`;
      }
    } else if (x.h) {
      const H = x.h;
      out += `${H.counts.views} views · ${H.counts.tables} tables · ${H.counts.columns} columns · ${H.counts.relations} relations · ${H.counts.sql} SQL\n\n`;
      out += '> Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.\n\n';
      out += `### Nothing depends on them (${H.orphans ? H.orphans.length : '—'})\n\n> Candidates, not a verdict - a shared link, a scheduled export, an embedded report or an API consumer is invisible to Zoho Analytics' own dependency graph.\n\n`;
      if (H.orphans) out += H.orphans.map((v) => `- ${v.name} (${v.type})`).join('\n') + '\n\n';
      out += `### Tables in no relation (${H.islands.length})\n\n` + H.islands.map((t) => `- ${t.name} (${t.kind})`).join('\n') + '\n\n';
      out += `### Put there by Zoho, not by you (${H.system.length})\n\n` + H.system.map((v) => `- ${v.name}`).join('\n') + '\n\n';
      if (H.unread.length) out += `### Could not be read (${H.unread.length})\n\n` + H.unread.map((f) => `- ${(viewById().get(f.id) || {}).name || f.id} - ${f.error}`).join('\n') + '\n\n';
    }
  }
  // The same line the HTML report's foot carries, and the same the other product's Markdown
  // carries: what made this, and a link to it. One of the two used to say nothing at all.
  out += `\n---\n\nGenerated by [${PRODUCT_NAME}](${PRODUCT_URL})\n`;
  return out;
}

// Folder, filename shape, timestamp format, permission check and status wording are all the CRM
// panel's, deliberately: an export is the artefact a user collects from both apps, and finding it
// somewhere else in one of them is precisely the discontinuity the two are supposed to avoid.
// There is no "analytics" in the filename because the workspace already sits under analytics/, and
// the CRM does not put "crm" in its own.
async function doExport(kind) {
  const op = beginWorkspaceOp();   // the scope dialog and the build both await; the folder can move
  if (!dir) return;
  const sc = await askScope();
  if (!sc) return;
  await window.idbHandle.set('exportScopeAnalytics', sc);
  setBusy(true, kind === 'md' ? 'Building AI (Markdown) export…' : 'Building HTML export…');
  try {
    await requirePerm(op.root);
    const md = kind === 'md';
    const body = md ? await buildExportMarkdown(sc, op) : await buildExportHtml(sc, op);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && (bound.name || bound.workspace)) || 'workspace')}-${stamp}.${md ? 'md' : 'html'}`;
    await op.write(name, body);
    setBusy(false, `Exported → ${name} (in your workspace folder).`); $('status').className = 'ok';
  } catch (e) {
    if (!op.current()) { endBusyElsewhere(); return; }
    setBusy(false, 'Export error: ' + (e.message || e)); $('status').className = 'bad';
  }
}

// ---------- health ----------
// Counts and lists, never a verdict. No thresholds, no "too old", no score: a query table nobody
// reads may be a scheduled export's source, and a table with no relations may be deliberately
// standalone. Every figure states what it does not cover, right next to itself.
function healthFindings() {
  const m = viewById();
  const tables = Object.entries(schema);
  const related = new Set();
  for (const r of relations) { related.add(r.source); related.add(r.target); }
  const unread = pullFailed.slice();
  for (const id of sqlDiskUnread) {
    if (!unread.some((f) => String(f.id) === String(id) && f.stage === 'sql'))
      unread.push({ id, stage: 'sql', error: 'the .sql file could not be read' });
  }
  return {
    counts: {
      views: views.length, folders: folders.length,
      tables: tables.length, columns: tables.reduce((n, [, t]) => n + t.columns.length, 0),
      relations: relations.length, sql: Object.keys(sqls).length,
    },
    system: views.filter((v) => v.system),
    orphans: deps ? views.filter(isOrphanCandidate) : null,
    islands: tables.filter(([id]) => !related.has(id)).map(([id, t]) => ({ id, name: t.name, kind: t.kind })),
    undescribed: views.filter((v) => !v.description),
    unread,
    noStructure: views.filter((v) => v.type !== 'Dashboard' && !structureChain(v, m)),
  };
}
function renderHealth() {
  const h = healthFindings();
  const list = (arr, f) => arr.length ? `<ul>${arr.slice(0, 40).map(f).join('')}</ul>${arr.length > 40 ? `<div class="gap">…and ${arr.length - 40} more. The full list is in the exports.</div>` : ''}` : '';
  // A finding that names a view opens it. It was plain text in every one of these lists - reported
  // on the CRM panel, where one group of eight was unclickable; here it was all of them, which is
  // the same defect with nothing to compare it against. The id is what the row declares, and one
  // handler below reads it, so a list added tomorrow is clickable by writing `nm` and nothing else.
  const nm = (v) => `<li><a data-open="${escA(String(v.id))}">${esc(v.name)}</a> <span style="color:var(--muted)">${esc(v.type || v.kind || '')}</span></li>`;
  $('healthbody').innerHTML =
    `<h4>What was pulled</h4><div class="hnum">${h.counts.views} views · ${h.counts.folders} folders · ${h.counts.tables} tables · ${h.counts.columns} columns · ${h.counts.relations} relations · ${h.counts.sql} SQL</div>`
    + `<div class="gap">Report definitions - which columns a chart puts on which axis, and how it aggregates them - are <b>not</b> covered. The endpoint that carries them also carries the computed series, which is your data, so Zoost does not call it.</div>`

    + `<h4>Nothing depends on them <span class="hnum">${h.orphans ? h.orphans.length : '—'}</span></h4>`
    + (h.orphans ? list(h.orphans, nm) : '<div class="gap">Lineage was not pulled.</div>')
    + `<div class="gap">Candidates, not a verdict. Zoho Analytics only knows what its own views read from each other; a shared link, a scheduled export, an embedded report or an API consumer is invisible to it.</div>`

    + `<h4>Tables in no relation <span class="hnum">${h.islands.length}</span></h4>`
    + list(h.islands, nm)
    + `<div class="gap">They take part in no join in the ER model. That can be deliberate - a lookup list, a staging table - so this is a list to read, not a problem to fix.</div>`

    + `<h4>Put there by Zoho, not by you <span class="hnum">${h.system.length}</span></h4>`
    + list(h.system, nm)
    + `<div class="gap">Flagged <code>isSystemTable</code> by Zoho Analytics itself - typically synced from a connected source. The view list does not flag any of them, so this comes from the ER model alone.</div>`

    + `<h4>No description <span class="hnum">${h.undescribed.length}</span> of ${h.counts.views}</h4>`
    + `<div class="gap">A count, not a judgement. Plenty of views need no description.</div>`

    + (h.noStructure.length ? `<h4>No structure reachable <span class="hnum">${h.noStructure.length}</span></h4>` + list(h.noStructure, nm)
       + '<div class="gap">Neither their own columns nor a parent chain leading to any. Dashboards are excluded, since having none is correct for them.</div>' : '')

    + (h.unread.length ? `<h4 style="color:var(--warn)">Could not be read <span class="hnum">${h.unread.length}</span></h4>`
       + list(h.unread, (f) => `<li><a data-open="${escA(String(f.id))}">${esc((viewById().get(f.id) || {}).name || f.id)}</a> - <span style="color:var(--muted)">${esc(f.error)}</span></li>`)
       + '<div class="gap">Use <b>Retry failed</b>, or ↻ on a single view. Until then this mirror is short by exactly these.</div>' : '')

    + `<h4>Design and data dates</h4><div class="gap">Design is a real timestamp for tables and query tables, and Zoho\'s own text for everything else - shown exactly as it sends it, in your interface language, never parsed, and sorted last. Data is always a real timestamp.</div>`;
  $('healthbody').querySelectorAll('a[data-open]').forEach((a) => (a.onclick = () => {
    const id = a.dataset.open;
    if (!viewById().get(id)) { status('That view is no longer in this workspace.', 'warn'); return; }
    closeHealth(); openDetail(id);
  }));
}
// `#health.on` is in this panel's own stylesheet and nothing ever set it, so the audit button stayed
// unlit while the AI button beside it lights - the rule was dead CSS and the twin did it right.
function openHealth() { renderHealth(); document.body.classList.add('health-open'); $('healthview').classList.add('show'); $('health').classList.add('on'); }
function closeHealth() { document.body.classList.remove('health-open'); $('healthview').classList.remove('show'); $('health').classList.remove('on'); }

// ---------- about ----------
// The same dialog the CRM panel shows, with the same sections in the same order. A user who has both
// should recognise it immediately; that is the whole point of keeping them twins.
function showAbout() {
  const m = chrome.runtime.getManifest();
  $('aboutbody').innerHTML =
    `<div><b>${esc(PRODUCT_NAME)}</b> · v${esc(m.version)}</div>`
    + `<div style="color:var(--muted)">Created by ${esc(PRODUCT_AUTHOR)} (with the support of Claudio)</div>`
    + `<h4>Links</h4><div><a href="${escA(PRODUCT_URL)}" target="_blank" rel="noopener">zoost.it</a> · <a href="${escA(PAGE_URL)}" target="_blank" rel="noopener">What it does</a> · <a href="${escA(DOCS_URL)}" target="_blank" rel="noopener">How to use</a> · <a href="${escA(PRODUCT_URL)}/privacy.html" target="_blank" rel="noopener">Privacy</a> · <a href="${escA(STORE_URL)}" target="_blank" rel="noopener">Web Store</a> · <a href="${escA(REPO_URL)}" target="_blank" rel="noopener">Source</a> · <a href="mailto:${escA(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></div>`
    + `<h4>Support</h4><div><a href="${escA(SPONSOR_URL)}" target="_blank" rel="noopener">GitHub Sponsors</a> · <a href="${escA(KOFI_URL)}" target="_blank" rel="noopener">☕ Ko-fi</a></div>`
    + `<h4>Licence</h4><div><a href="${escA(LICENSE_URL)}" target="_blank" rel="noopener">${esc(PRODUCT_LICENSE)}</a> · © 2026 ${esc(PRODUCT_AUTHOR)}</div>`
    + `<h4>Legal</h4><div class="legal">${esc(LEGAL_DISCLAIMER)}</div>`
    + `<h4>Your data</h4><div class="legal">The mirror stays between your browser, your Zoho session and the local folder you picked. `
    + `Zoost has no server of its own. <b>The one exception is the AI assistant</b>: when you use it, the parts of the workspace it needs - the workspace's own name and its Zoho id, view names and what kind of view each is, the folder and description of a view, the name Zoho records as its owner, when its design and its data last changed, column names and their types, the relations between tables, what depends on what, and the SQL of your query tables - are sent directly from your browser to the provider you configured, and to no one else. `
    + `Rows are never sent, because Zoost never reads them. Leave the assistant unconfigured and nothing leaves this machine, except a problem report you write, read in full and send yourself.</div>`;
  $('scrim').classList.add('on'); panelInert(true); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); panelInert(false); $('aboutdlg').classList.remove('on'); }

// ---------- wiring ----------
$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
/** What the workspace list shows, and what it must never stop showing.
 *
 * The label is a convenience; the identity is the org or workspace id. So the label is displayed and
 * the derived name is kept - in the option's tooltip, always, whether or not a label is set. A list
 * that showed only the user's name for something would be a list you cannot check against the
 * platform.
 */
/** What to call a workspace on screen: the name its owner gave it, then the platform's, then its id.
 *
 *  The order is the point, and it was wrong wherever the *binding* was shown rather than the list. The
 *  mismatch bar said «this folder mirrors "Default Workspace" (99000001)» over a workspace the reader
 *  had named «Acme production» a minute earlier - the one word they would have recognised, dropped in
 *  the one sentence that exists to be recognised. Reported. The id stays beside it in the bar, because
 *  that is the fact nothing can be wrong about; here it is the last resort, not the subject. */
function wsShown(b) {
  if (!b) return '';
  // Two shapes reach here and both are «a workspace»: the binding this panel holds, which carries the
  // reader's own name as `label`, and a row of the workspace list, which carries it as `cfg.label`.
  // Reading only the first left «Switch workspace -> ...» naming the platform under a sentence that
  // had just stopped doing exactly that. Reported, after the first fix - and the test that held the
  // sentence stopped at the button, so it agreed with the bug.
  const own = ((b.label || (b.cfg && b.cfg.label) || '') + '').trim();
  return String(own || (b.name || '').trim() || b.workspace || b.id || '');
}
function wsOptionText(w) { return ((w.cfg && w.cfg.label) || '').trim() || `${w.name || w.folder} \u00b7 ${w.id}`; }
/** The workspace list is ordered by what the reader actually sees. Sorting by the derived name
 *  while displaying the user's own label produces a list that looks unsorted - «Acme» in a folder
 *  called «zzz-1234» lands at the end - and this bar is where a consultant with four clients open
 *  spends the day. Numeric, so «Client 2» comes before «Client 10»; base sensitivity, so case and
 *  accents do not split the order. */
function byWsLabel(a, b) { return wsOptionText(a).localeCompare(wsOptionText(b), undefined, { numeric: true, sensitivity: 'base' }); }
function wsOptionTitle(w) {
  const label = ((w.cfg && w.cfg.label) || '').trim();
  return label ? `${label} - folder ${`${w.name || w.folder} \u00b7 ${w.id}`}` : `${w.name || w.folder} \u00b7 ${w.id}`;
}

/** A name of the user's own for a workspace.
 *
 * The folder name is derived from the platform, and the platform is not always evocative: Zoho
 * Analytics names the first workspace of every account the same way, so three projects can arrive on
 * disk with the same label and nothing to tell them apart. Zoho CRM has the instance and the org id,
 * which are unambiguous and still not memorable.
 *
 * So the label is *displayed instead of* the derived name, and the derived name never disappears -
 * it stays in the option's tooltip and in the bar beneath, because the label is a convenience and the
 * identity is the org or workspace id. Storing it in `.zoost.json` (through `patchCfg`, never
 * `writeCfg`) keeps it with the workspace: it survives a re-pull, and it travels with the folder if
 * the folder does.
 */
async function renameWorkspace() {
  if (workspaceChangeRefuse()) return;
  const op = beginWorkspaceOp();   // the prompt and the permission both await; the folder can move
  const w = wsList.find((x) => x.id === $('ws').value);
  if (!w || !dir) return;
  const current = (w.cfg && w.cfg.label) || '';
  const typed = window.prompt(
    `Name for this workspace.\n\nShown in the list instead of \u00ab${w.name}\u00bb, which stays visible as the tooltip.\nLeave it empty to go back to that name.`,
    current);
  if (typed === null) return;                      // cancelled: not the same as cleared
  const label = typed.trim().slice(0, 60);         // it has to fit a 400px bar; longer is not a name
  if (label === current) return;
  try {
    // Chrome lets the folder permission lapse, and this writes to disk. Asked for here because here
    // there is a click to ask under: without it getFileHandle() throws the same bare "not allowed"
    // DOMException the AI path used to. Third time this shape has surfaced - a write reached from a
    // control is a write that must re-request first.
    if (!(await ensurePerm(op.root))) { status(MSG.folder, 'warn'); return; }
    if (!op.current()) return;
    await patchCfg({ label }, op);
    if (!op.current()) return;
    status(label ? `Workspace named \u00ab${label}\u00bb.` : 'Workspace name cleared - back to the folder name.', 'ok');
    await refreshWorkspaces();
  } catch (e) { if (op.current()) status('Could not save the name. ' + friendlyError(e), 'bad'); }
}
$('wsrename').onclick = renameWorkspace;
$('wsadd').onclick = addWorkspace;
$('wssample').onclick = () => addSampleWorkspace();
// The same action from the off-Zoho overlay, which is where somebody who has just installed
// Zoost and is not signed in to anything actually is.
// One call for both copies of the button: addSampleWorkspace() decides whether there is one to
// open or one to write, so the two cannot disagree and neither can act on a stale label.
$('offsample').onclick = () => addSampleWorkspace();
/** Write the sample workspace into the working folder, then open it.
 *
 * It goes through the same code every other workspace does - the files land on disk and the ordinary
 * list picks them up - so nothing downstream has to know it exists. `sample: true` in .zoost.json is
 * the whole mechanism.
 */
// Whether a sample workspace exists, kept where it can be read **without the folder handle**.
//
// This is the bug that took three reports to find, and the diagnosis was mine to make. Until the
// folder permission is granted, refreshWorkspaces() returns before it enumerates anything, so `wsList`
// is empty and the panel cannot tell a sample apart from no sample - it offered to create one that
// was sitting right there. Chrome drops that permission between sessions, so the state right after
// the panel opens is exactly the state where the question is asked.
//
// Same shape as `tabAccessView`, and for the same reason: a display-only copy of a fact, in
// chrome.storage.local, for a surface that cannot reach the folder. The folder stays the authority -
// this is only ever read into a label, and the *action* re-checks after granting.
let sampleWsKnown = null;
// Best-effort, and **declared** rather than wrapped in a `try` that cannot catch it: a synchronous
// try/catch around an un-awaited promise catches only a throw while the promise is being made,
// never its rejection. What is remembered here is a cache of a fact the folder already holds -
// `knownSample()` prefers the live workspace list and falls back to this - so losing it degrades
// to «not looked yet», which is a state the panel already draws honestly. Nothing to report.
// A declaration rather than a `.then(cb)`: the callback writes a module-level variable after an
// await, which is the one shape `tools/asynccheck.py` exists to look at - and inside a callback it
// could not look at it at all. Nothing guards it because nothing has to: the value is a cache of a
// fact the folder holds, and the startup read cannot be overtaken by anything that reads it.
async function readRememberedSample() {
  let v;
  try { v = await chrome.storage.local.get('sampleWs'); } catch (_) { return; }
  sampleWsKnown = (v && v.sampleWs) || null;
  updateSampleButtons();
}
void readRememberedSample();
function noteSampleWs(id) {
  sampleWsKnown = id || null;
  void chrome.storage.local.set({ sampleWs: sampleWsKnown }).catch(() => {});   // see the read above
}
/** The one the panel can act on, or - when the folder is not readable yet - the one it remembers. */
function knownSample() {
  const w = (wsList || []).find((x) => x.cfg && x.cfg.sample);
  return w || (sampleWsKnown ? { id: sampleWsKnown, remembered: true } : null);
}
/** Can the panel answer «is there a sample?» at all right now?
 *
 * Only if it has read the folder. Until the permission is granted the enumeration returns early, so
 * an empty list means «not looked», not «not there» - and the button was reading it as the second
 * and offering to create a sample that existed. Four reports.
 */
const sampleKnowable = () => !!(root && rootGranted) || !!sampleWsKnown;
function updateSampleButtons() {
  const have = knownSample();
  const sb = $('wssample');
  if (sb) sb.hidden = !!have || !root || !rootGranted;
  if (sb) sb.disabled = pullBusy || sampleBusy;
  // The overlay's copy covers the workspace list, so hiding it there would leave a sample on disk
  // unreachable. It changes what it says instead.
  const ob = $('offsample');
  if (ob) {
    ob.disabled = pullBusy || sampleBusy;
    // Three states, because «+» and «Open» are both claims and there is a moment when neither can be
    // made. `+` says «there is none» and `Open` says «there is one»; with the folder unread the
    // honest label asserts nothing and the tooltip says the click will find out. This project does
    // not state what it has not measured, and a button label is a statement like any other.
    ob.textContent = have ? 'Open sample workspace'
      : sampleKnowable() ? '+ Sample workspace' : 'Sample workspace';
    ob.title = have
      ? 'Open the sample workspace already in your working folder - invented data, nothing is fetched'
      : sampleKnowable()
        ? 'Write a workspace of invented data into the working folder and open it - nothing is fetched, and it can be deleted like any other'
        : 'Opens the sample workspace, or writes one if there is none. Clicking asks for access to the working folder first, which is what the panel needs before it can tell.';
  }
}

let sampleBusy = false;
async function addSampleWorkspace() {
  if (workspaceChangeRefuse()) return;
  if (sampleBusy) return;
  if (!root) { await pickRoot(); return; }
  // **Grant first, then decide.** A click is the only context in which the permission can be
  // re-requested, and until it is granted the panel cannot see what is in the folder - so deciding
  // before this line means deciding on a list that is empty for a reason unrelated to the question.
  if (!(await ensurePerm(root))) { status(MSG.folder, 'warn'); return; }
  if (!rootGranted) { rootGranted = true; await refreshWorkspaces(); }
  const have = (wsList || []).find((w) => w.cfg && w.cfg.sample);
  if (have) { $('ws').value = have.id; $('offoverlay').classList.remove('show'); return selectWorkspace(have); }
  sampleBusy = true;
  // The overlay is opaque and covers the status line, so it comes down before the writing starts -
  // otherwise the progress is written where nobody can read it, which is what made pressing again
  // look like the reasonable thing to do.
  $('offoverlay').classList.remove('show');
  ['wssample', 'offsample'].forEach((b) => { const e = $(b); if (e) e.disabled = true; });
  try { await writeSampleWorkspace(); }
  finally {
    sampleBusy = false;
    updateSampleButtons();
  }
}
async function writeSampleWorkspace() {
  try {
    const gen = window.SAMPLE_ORG;
    if (!gen) { status('The sample generator is not loaded.', 'bad'); return; }
    const base = await appRoot(true);
    if (!base) { status(`Could not create the ${APP_DIR}/ folder inside the working folder.`, 'bad'); return; }
    const h = await base.getDirectoryHandle(gen.folderName(), { create: true });
    const files = gen.files({});
    const all = Object.entries(files);
    // Three hundred files through the File System Access API take long enough to look like a hang -
    // reported as exactly that. The count is what says it is working, so it is written often enough
    // to move and rarely enough not to be the cost itself.
    status(`Writing the sample workspace - 0 of ${all.length} files\u2026`, 'busy');
    for (let i = 0; i < all.length; i++) {
      const [rel, text] = all[i];
      const parts = rel.split('/');
      let d = h;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      if (i % 10 === 9 || i === all.length - 1) {
        status(`Writing the sample workspace - ${i + 1} of ${all.length} files \u00b7 ${rel.split('/')[0]}\u2026`, 'busy');
        await new Promise((r) => setTimeout(r, 0));   // let the status line actually paint
      }
    }
    status(`Sample workspace written - ${Object.keys(files).length} files in \u00ab${gen.folderName()}\u00bb. Nothing was fetched from Zoho Analytics.`, 'ok');
    await refreshWorkspaces();
  } catch (e) { status('Could not write the sample: ' + e.message, 'bad'); }
}
$('wsdel').onclick = delWorkspace;
async function onWs() {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value); if (w) await selectWorkspace(w);
}
$('ws').onchange = onWs;
$('pull').onclick = pullAll;
// Touched by hand, so the next repaint leaves it alone: this control is redrawn on every
// workspace change, and a choice that is reset while you are looking at it is not a choice.
$('gozohodc').onchange = () => { $('gozohodc').dataset.touched = '1'; };
$('gozoho').onclick = openZohoHome;
// ---- keyboard: the selection follows the arrows ------------------------------------------------
// Up and down used to scroll the list, because that is what a browser does with a scrollable box.
// What a reader wants is the next view *open* - the same thing a click does - and the list is what
// the panel is for. Reported as missing.
//
// Only rows that are actually on screen take part: `visibleViews()` is what the filters and the
// search have left standing, and stepping onto something the reader has filtered away would be the
// list disagreeing with itself.
// Bring a row fully into view, under whatever is stuck to the top of the list. `scrollIntoView`
// with `block: 'nearest'` aligns to the container's edge and knows nothing about a sticky header -
// so stepping upwards parked the selected row exactly underneath it, half visible. Reported after
// the arrows landed: the movement was right and the row was not all there.
//
// The header is measured rather than assumed: it is a column row in one product and a group label
// in the other, both `position: sticky`, and both change height with the font a reader has set.
function revealRow(el, box, stickySel) {
  if (!el || !box) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const st = stickySel ? box.querySelector(stickySel) : null;
  const cover = st ? st.getBoundingClientRect().height : 0;
  const top = b.top + cover;              // the first line the reader can actually see
  if (r.top < top) box.scrollTop -= (top - r.top);
  else if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom);
}

function stepSelection(delta, edge) {
  const rows = visibleViews();
  if (!rows.length) return;
  let i;
  if (edge === 'first') i = 0;
  else if (edge === 'last') i = rows.length - 1;
  else {
    const at = rows.findIndex((v) => v.id === selectedId);
    // Nothing selected yet: down starts at the top, up at the bottom - the two ends a reader means.
    i = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
  }
  const v = rows[i];
  if (!v || v.id === selectedId) return;
  openDetail(v.id);
  // Walked rather than selected: an id in a selector wants CSS.escape, which reads like the HTML
  // escaping used everywhere else here and is a different thing - and the checker was right to ask
  // which. Comparing the dataset removes the question.
  const el = [...$('list').querySelectorAll('tr[data-id]')].find((r) => r.dataset.id === String(v.id));
  revealRow(el, $('list'), 'thead');
}

// ---------- history: the chain you have walked, and the way back up it ----------
// The twin of the CRM panel's, and the same argument: the lineage tab and the foreign keys made this
// a hypertext, and a hypertext you cannot come back through is a set of trapdoors. Back, forward,
// and the chain itself - «back» alone reaches the previous step and the author asked to be able to
// climb the whole thing.
//
// The handle is the view id, because that is what this panel opens everything by. `n` is a runtime
// identifier minted here: it keys the menu's rows, so the same view visited twice stays two steps of
// a walk rather than collapsing into one.
const NAV_MAX = 50;
let navHist = [], navPos = -1, navReplaying = false, navSeq = 0;

function navHere(id, label) {
  if (navReplaying || !id) return;
  const cur = navHist[navPos];
  if (cur && String(cur.id) === String(id)) { if (label) cur.label = label; updateNav(); return; }
  // A new step drops what was ahead - the forward arrow means «where I came back from».
  navHist = navHist.slice(0, navPos + 1);
  navHist.push({ n: ++navSeq, id: String(id), label: label || String(id), kind: '', at: Date.now() });
  if (navHist.length > NAV_MAX) navHist.shift();
  navPos = navHist.length - 1;
  updateNav();
}
function navClear() { navHist = []; navPos = -1; closeNavMenu(); updateNav(); }

/** Go to step `i`. The position moves even when the view has gone - a workspace can be pulled again
 *  with one fewer query in it - and the status line says so, the same as the twin. */
async function navTo(i) {
  if (i < 0 || i >= navHist.length || i === navPos) return;
  const e = navHist[i];
  navPos = i; navShow(false); updateNav();
  navReplaying = true;
  try {
    if (viewById().get(e.id)) await openDetail(e.id);
    else status(MSG.navGone, 'warn');
  } finally { navReplaying = false; }
}

function updateNav() {
  $('dback').classList.toggle('show', navPos > 0);
  $('dfwd').classList.toggle('show', navPos >= 0 && navPos < navHist.length - 1);
  $('navtab').style.display = navHist.length ? '' : 'none';   // nowhere to go, nothing to offer
}
// When a step was taken. A real fact rather than something to fill a row with: with a chain that
// spans a session, «which of these two did I look at first» is a question the reader actually has,
// and the panel is the only thing that knows. Today's steps show the time alone - the date would be
// noise on every row - and anything older carries its day.
function navWhen(ms) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const sameDay = d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
    && d.getFullYear() === today.getFullYear();
  return sameDay ? t : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${t}`;
}
function closeNavMenu() { navShow(false); }
const navOpenNow = () => $('navview').classList.contains('show');
// Copy the code that is on screen. `textContent` rather than the source variable: what the reader is
// looking at is what lands in the clipboard, and the highlighting comes back off by itself. The mark
// becomes a tick for a moment, because a copy that says nothing is indistinguishable from a click
// that missed.
const COPY_MARK = '<svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V10a1.5 1.5 0 0 0 1.5 1.5h1.5"/></svg>';
const COPY_TICK = '<svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
async function copyCode(text) {
  const btn = $('codecopy');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.innerHTML = COPY_TICK;
    setTimeout(() => { btn.innerHTML = COPY_MARK; }, 1200);
  } catch (e) {
    status(MSG.copyFailed + friendlyError(e), 'warn');
  }
}

function navShow(on) {
  $('navview').classList.toggle('show', on);
  // The same class the health and AI views set, driving the same rules: while this is up, every
  // other control in the toolbar is dimmed and inert. Three views of the workspace, one behaviour.
  document.body.classList.toggle('nav-open', on);
  const seg = $('navtab');
  if (seg) { seg.classList.toggle('on', on); seg.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  if (on) renderNav();
}
function toggleNavMenu() { navShow(!navOpenNow()); }
/** The chain, drawn full width. Newest first - the reader is looking for where they were a moment
 *  ago, not for where they started - and the step they are on is marked rather than left out. */
function renderNav() {
  const body = $('navbody');
  // The same search box as the list it replaces - see the twin.
  const q = ($('navfind').value || '').trim().toLowerCase();
  const rows = navHist.map((e, i) => ({ e, i }))
    .filter(({ e }) => !q || String(e.label).toLowerCase().includes(q) || String(e.kind || 'view').toLowerCase().includes(q));
  $('navcount').textContent = navHist.length
    ? `${rows.length === navHist.length ? navHist.length : rows.length + ' of ' + navHist.length} step${navHist.length > 1 ? 's' : ''}`
    : '';
  if (!navHist.length) {
    body.innerHTML = '<div class="nvnone">Nothing yet. Open a view and every step you take is '
      + 'listed here - click one to go back to it.</div>';
    return;
  }
  if (!rows.length) { body.innerHTML = `<div class="nvnone">${esc(MSG.narrowNav)}</div>`; return; }
  body.innerHTML = rows.map(({ e, i }) => `<div class="nvrow${i === navPos ? ' at' : ''}" data-n="${escA(String(e.n))}" data-i="${escA(String(i))}" title="${escA(String(e.id))}">`
    + `<span class="nvk">${esc(e.kind || 'view')}</span><span class="nvl">${esc(e.label)}</span>`
    + `<span class="nvw">${esc(navWhen(e.at))}</span></div>`).reverse().join('');
  body.querySelectorAll('.nvrow').forEach((r) => { r.onclick = () => navTo(Number(r.dataset.i)); });
}

// Emptying the chain does not close what is open: the reader asked to forget where they have been,
// not to lose the thing they are reading. The step they are on is kept as the only entry, so the
// next link still has something to come back to.
$('navclear').onclick = () => {
  const here = navHist[navPos];
  navHist = here ? [here] : []; navPos = navHist.length - 1;
  updateNav(); renderNav();
};
$('navx').onclick = () => navShow(false);
$('dback').onclick = () => navTo(navPos - 1);
$('dfwd').onclick = () => navTo(navPos + 1);
$('navtab').onclick = () => toggleNavMenu();
$('codecopy').onclick = () => copyCode((document.querySelector('pre.sql') || {}).textContent || '');
$('navfind').oninput = renderNav;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navOpenNow()) { navShow(false); return; }
  if (!e.altKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navTo(navPos - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navTo(navPos + 1); }
});

$('list').addEventListener('keydown', (e) => {
  // A field wants its own arrows - the search box is one line above this, and Tab reaches it.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  const edge = { Home: 'first', End: 'last' }[e.key];
  if (!step && !edge) return;
  e.preventDefault();          // or the list scrolls under a selection that is already in view
  stepSelection(step || 0, edge);
});

$('find').oninput = () => {
  // Debounced in SQL mode only: a user-authored pattern runs over every cached query body, and
  // doing that on each keystroke means doing it on the half-typed patterns too.
  if (searchMode === 'sql') { clearTimeout(_sqlSearchT); _sqlSearchT = setTimeout(render, 220); }
  else render();
};
async function onSmode() {
  const op = beginWorkspaceOp();
  searchMode = searchMode === 'name' ? 'sql' : 'name';
  $('smode').textContent = searchMode === 'name' ? 'in: names' : 'in: SQL';
  $('smode').classList.toggle('on', searchMode === 'sql');
  $('rxmode').style.display = $('rxpick').style.display = searchMode === 'sql' ? '' : 'none';
  if (searchMode !== 'sql') $('rxmenu').classList.remove('show');
  // Leaving full-text with the pattern on takes the pattern with it, like the toggle going off:
  // a regex read as a name filter is a search for text that does not exist. Reported.
  if (searchMode !== 'sql' && regexMode) { regexMode = false; $('rxmode').classList.remove('on'); $('find').value = ''; }
  $('find').placeholder = searchMode === 'name' ? 'Find\u2026' : 'Find inside the SQL\u2026';
  if (searchMode === 'sql' && !(await ensureSqlCache(op))) return;
  if (!op.current()) return;
  render();
}
$('smode').onclick = onSmode;
$('rxmode').onclick = () => {
  regexMode = !regexMode;
  $('rxmode').classList.toggle('on', regexMode);
  // Switching the toggle off clears the box: a pattern read as a literal is a search for text
  // that does not exist, and the reader would be left staring at «no matches» for \b\d{18}\b.
  // Switching it on keeps what was typed - a literal is often the seed of the pattern.
  if (!regexMode) $('find').value = '';
  render();
};
// The saved patterns, offered where they are used. The background seeds the first two; the list
// itself lives in Settings, where it can be added to, edited and emptied; the menu reads it
// fresh on every open, and can append to it - its Save row, when there is a pattern to save.
async function loadRxShortcuts() {
  try {
    const st = await chrome.storage.local.get('rxShortcuts');
    return Array.isArray(st.rxShortcuts)
      ? st.rxShortcuts.filter((x) => x && typeof x.name === 'string' && typeof x.pattern === 'string' && x.name && x.pattern)
      : [];
  } catch (_) { return null; }   // null, not []: a read that failed is not an empty list
}
/** Save the pattern in the box under a name, or say why it cannot be saved.
 *
 * A declaration rather than an `= async () => {}`, which is a scope the race checker cannot enter -
 * and there is an await in the middle of it. `items` is carried in rather than read again: it is the
 * list the menu was drawn from, and the whole point of the two checks above the write is that they
 * are about *that* list. Written the same way in the other product.
 */
async function saveSearchPattern(items, rawQ) {
  const name = $('rxsavename').value.trim();
  // The same rules the Settings page enforces, refused with the reason in place.
  if (!name) { $('rxsaveerr').textContent = 'A pattern needs a name.'; return; }
  if (items.some((x) => x.name.trim().toLowerCase() === name.toLowerCase())) {
    $('rxsaveerr').textContent = `"${name}" is already taken - the menu could not tell them apart.`;
    return;
  }
  const dupP = items.find((x) => x.pattern === rawQ);
  if (dupP) { $('rxsaveerr').textContent = `This pattern is already saved as "${dupP.name}".`; return; }
  try { await chrome.storage.local.set({ rxShortcuts: [...items, { name, pattern: rawQ }] }); }
  catch (_) { $('rxsaveerr').textContent = 'Could not write the list - try from Settings.'; return; }
  openRxMenu();   // re-read and redraw: the new entry appearing in the list is the confirmation
}

async function openRxMenu() {
  const menu = $('rxmenu');
  const list = await loadRxShortcuts();
  // The read yielded: the tab, the mode or the workspace may have moved meanwhile, and every one of
  // those hides the button. A menu for a control that is no longer there is not opened.
  if ($('rxpick').style.display === 'none') return;
  // Alphabetical by name, the way a reader scans a menu - storage order is append order, which
  // says when a pattern was saved and nothing else. The Settings list keeps storage order: rows
  // being edited must not reshuffle under the hands renaming them.
  const items = (list || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const rawQ = $('find').value.trim();
  // The save row exists only when there is something it could do: a pattern in the box that parses,
  // regex mode on, and a list that was actually read - saving over one that was not would overwrite
  // entries nobody has seen. A control that can do nothing goes away rather than sitting there.
  const savable = list !== null && regexMode && rawQ && !!rxCompile(rawQ).re;
  // A pattern already in the list is named, not re-offered: a second copy would be two menu
  // entries that search identically, and the name is how the reader finds the one they have.
  const already = savable ? items.find((x) => x.pattern === rawQ) : null;
  menu.innerHTML = items.map((x, i) => `<button data-rx="${escA(i)}"><span>${esc(x.name)}</span><span class="rxpat">${esc(x.pattern)}</span></button>`).join('')
    + (already ? `<div class="rxsave"><span class="rxnote">This pattern is already saved as "${esc(already.name)}".</span></div>`
      : savable ? `<div class="rxsave"><input id="rxsavename" placeholder="Name this pattern\u2026" maxlength="60" aria-label="Name for the pattern in the search box"><button data-save="1" title="Save the pattern in the search box under this name">Save</button><div class="rxerr" id="rxsaveerr"></div></div>` : '')
    + `<button class="rxman" data-man="1">${list === null ? 'The saved patterns could not be read. ' : (items.length ? '' : 'No saved patterns yet. ')}Manage\u2026</button>`;
  menu.querySelectorAll('[data-rx]').forEach((b) => {
    b.onclick = () => {
      menu.classList.remove('show');
      // The same guard as above, one interaction later: a pattern applied into a view whose search
      // no longer offers regex would filter names by a literal `\\b\\d{18}\\b`.
      if ($('rxpick').style.display === 'none') return;
      const x = items[+b.dataset.rx];
      $('find').value = x.pattern;
      if (!regexMode) { regexMode = true; $('rxmode').classList.add('on'); }
      render();
    };
  });
  const sv = menu.querySelector('[data-save]');
  if (sv) {
    const doSave = () => saveSearchPattern(items, rawQ);
    sv.onclick = doSave;
    $('rxsavename').onkeydown = (e) => {
      // The panel's own shortcuts stay out of the input; Escape still bubbles to close the menu.
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key === 'Enter') doSave();
    };
  }
  menu.querySelector('[data-man]').onclick = () => { menu.classList.remove('show'); openSettings('#rx'); };
  const r = $('rxpick').getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.classList.add('show');
}
$('rxpick').onclick = (ev) => {
  ev.stopPropagation();
  const menu = $('rxmenu');
  if (menu.classList.contains('show')) { menu.classList.remove('show'); return; }
  openRxMenu();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#rxmenu') && !e.target.closest('#rxpick')) $('rxmenu').classList.remove('show');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('rxmenu').classList.remove('show'); });

$('findclear').onclick = () => { $('find').value = ''; render(); $('find').focus(); };
$('typesel').onchange = () => { typeFilter = $('typesel').value || null; render(); };
$('sort').onchange = () => { sortKey = $('sort').value; render(); };
$('sortdir').onclick = () => { sortDir = -sortDir; $('sortdir').innerHTML = sortDir === 1 ? '&#8593;' : '&#8595;'; render(); };
$('graph').onclick = () => openSchemaGraph();
$('export').onclick = () => doExport('html');
$('exportmd').onclick = () => doExport('md');
$('retry').onclick = retryFailed;
$('refresh').onclick = refreshLocal;
$('health').onclick = () => ($('healthview').classList.contains('show') ? closeHealth() : (closeAI(), openHealth()));
$('askai').onclick = toggleAI;
$('aix').onclick = closeAI;
$('aiclear').onclick = aiClear;
$('aigear').onclick = () => openSettings('#ai');
$('ainotex').onclick = () => $('ainote').classList.remove('show');
$('ailockgo').onclick = aiUnlock; $('ailockpass').onkeydown = (e) => { if (e.key === 'Enter') aiUnlock(); };
$('aisend').onclick = aiSend;
$('aiinput').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); aiSend(); } });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.aicfg) aiEngineChrome();
  if (ch.zohoDc) zohoDc = ch.zohoDc.newValue || zohoDc;
});
async function loadZohoDc() {
  try { const r = await chrome.storage.local.get('zohoDc'); if (r.zohoDc) zohoDc = r.zohoDc; } catch (_) {}
}
window.addEventListener('focus', () => aiEngineChrome());
$('healthx').onclick = closeHealth;
$('expx').onclick = () => closeScope(false);
$('expcancel').onclick = () => closeScope(false);
$('expgo').onclick = () => { scopeFromUI(); closeScope(true); };
// The presets set what the dialog holds, never the stored preference - see `dlgScope`.
$('pspFull').onclick = () => { dlgScope = Object.assign({}, SCOPE_FULL); scopeToUI(); };
$('pspSafe').onclick = () => { dlgScope = Object.assign({}, SCOPE_SAFE); scopeToUI(); };
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('opts').onclick = () => openSettings();
$('about').onclick = showAbout;
$('aboutx').onclick = closeAbout;
$('aboutok').onclick = closeAbout;
$('scrim').onclick = () => { closeAbout(); closeScope(false); };
// Closing the pane does not forget where you have been: reopening anything continues the chain.
$('dclose').onclick = () => { detailLoad++; $('detail').classList.remove('show'); $('resizer').classList.remove('show'); selectedId = null; updateNav(); render(); };
document.querySelectorAll('.dtab').forEach((b) => {
  b.onclick = () => void showDetailTab(b);
});

/** Switch the detail pane to the tab that was clicked, and draw it for the selected view.
 *
 * A declaration rather than an `= async () => {}`: the checker cannot enter one, and this awaits a
 * render and then touches the scroll position - which belongs to whatever is selected by then, which
 * is why `mine` and `op` are taken before the await and asked about after it.
 */
async function showDetailTab(b) {
  if (b.disabled) return;
  const mine = ++detailLoad, op = beginWorkspaceOp();
  detailTab = b.dataset.tab;
  document.querySelectorAll('.dtab').forEach((x) => x.classList.toggle('active', x === b));
  const v = viewById().get(selectedId);
  if (v) { await renderDetail(v, mine, op); if (detailCurrent(mine, op)) resetDetailScroll(); }   // a different tab is different content too
}

// A stored folder handle loses its permission between sessions and can only be re-granted from a
// user gesture. Any click in the panel counts, so the first thing the user does restores access -
// except on the controls that would themselves ask, on a dialog, on the mismatch overlay, or in the
// chat. The two panels excluded different subsets of those and neither list was wrong, which is how
// a divergence survives: both looked deliberate. It is the union now, and the same on both sides.
// Named, like every async scope this project ships: `tools/asynccheck.py` reads function
// declarations, so an inline callback is a scope nothing looks inside.
async function regrantOnAnyClick(e) {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('#pfoot') || t.closest('.dlg') || t.closest('#aiview') || t.closest('#offoverlay'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await refreshWorkspaces(); } } catch (_) {}
}
document.addEventListener('click', regrantOnAnyClick, true);

// resizable split - the CRM's, down to the stored height
let dragY = false;
$('resizer').addEventListener('mousedown', () => { dragY = true; document.body.style.userSelect = 'none'; });
window.addEventListener('mousemove', (e) => {
  if (!dragY) return;
  const r = $('main').getBoundingClientRect();
  const h = Math.max(120, Math.min(r.height - 80, r.bottom - e.clientY));
  $('detail').style.height = h + 'px';
});
window.addEventListener('mouseup', () => {
  if (!dragY) return;
  dragY = false; document.body.style.userSelect = '';
  // Cosmetic, and best-effort by declaration - see the CRM twin's note on the same write.
  void chrome.storage.local.set({ detailH: $('detail').style.height }).catch(() => {});
});

chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
window.addEventListener('focus', () => refreshContext());

/** Everything the panel has to read before it can draw itself, in the order it needs it.
 *
 * An async IIFE is a scope `tools/asynccheck.py` cannot enter, and this one is the whole startup:
 * four reads, each writing into the panel. A declaration, called on the next line.
 */
async function boot() {
  try { const r = await chrome.storage.local.get('detailH'); if (r && r.detailH) $('detail').style.height = r.detailH; } catch (_) {}
  await loadScope(); await loadZohoDc(); await restoreRoot(); await refreshContext();
}
void boot();
$('help').href = DOCS_URL;   // set here, not in the markup - same as the CRM panel

// What the report is allowed to know, gathered in one place so a reader can see the whole of it at
// once. Every value is a number, a boolean or one of a fixed set of words; the two free-text fields
// - the message and the stack - go through `redact()` inside buildReport. Nothing here reads the
// mirror, the sources, the SQL or any name.
function reportFacts(err, ai) {
  const m = chrome.runtime.getManifest();
  const ua = navigator.userAgent.match(/Chrome\/(\d+)/);
  return {
    product: m.name,
    version: m.version,
    browser: 'Chrome ' + (ua ? ua[1] : '?'),
    message: (err && (err.message || err)) || $('statustext').textContent,
    stack: (err && err.stack) || '',
    tab: 'views' + (detailTab ? '/' + detailTab : ''),
    search: searchMode === 'sql' ? (regexMode ? 'SQL, pattern' : 'SQL') : 'names',
    pullActive: !!pullBusy,
    sample: isSample(),
    counts: {
      views: (views || []).length,
      tables: Object.keys(schema || {}).length,
      queries: Object.keys(sqls || {}).length,
    },
    refused: [],
    ai,
    steps: reportSteps.slice(),
  };
}
// The last thing that actually threw. `openReport()` is opened from a button, so it has no error
// to hand - and without this the report was *only* the status buffer, which is the half that has to
// be redacted hardest and the half that says least. Two listeners, no call-site changes: an uncaught
// error and a rejected promise are exactly the failures worth a stack.
let lastThrown = null;
window.addEventListener('error', (e) => { if (e && e.error) lastThrown = e.error; });
window.addEventListener('unhandledrejection', (e) => { if (e && e.reason instanceof Error) lastThrown = e.reason; });
let reportText = '';
// Which engine is set, and nothing else about it: never the key, never the passphrase, not even
// whether one is stored - an AI failure is engine-shaped, and that is the whole of what helps.
async function aiEngineWord() {
  try {
    const r = await chrome.storage.local.get('aicfg');
    const c = (r && r.aicfg) || {};
    return c.active === 'anthropic' || c.active === 'openai' ? c.active : 'not configured';
  } catch (_) { return 'unknown'; }
}
// The report is handed to the page through the DOM, never through the address. It used to travel in
// the URL fragment, on the reasoning that a fragment is never transmitted to a server - true, and
// not the whole question: the navigation itself is written to Chrome's history and syncs with it, so
// the report would have left the machine with no click at all. Found by an audit of this feature.
//
// One click, one place to read it. The panel used to show the text in a dialog and call its button
// «Send…», which sent nothing: the reader read the same text twice and only the second copy had the
// button that mattered. What that step was defending - «read it before it leaves the machine» - is
// not what it did, because nothing leaves when the page opens: the text is written into a page in
// front of the reader and stays there until they press Send. So the reading happens once, where the
// sending is. The one thing it did cost is now stated on the site: opening the page is an ordinary
// visit to zoost.it, which a reader who changes their mind on the panel side never made.
$('repdismiss').onclick = () => showEmergency(false);
async function onRepopen() {
  reportText = buildReport(reportFacts(lastThrown, await aiEngineWord()));
  const text = reportText;
  try {
    // A **window**, not a tab. The side panel belongs to the window it is open in, so a new tab
    // opens with this panel still down the side of it - the reader is asked to read a report with
    // the thing that produced it sitting next to the text. A fresh window has no panel in it.
    // `chrome.windows` needs no permission of its own; the writing still does, and that is the
    // `zoost.it` host already declared.
    const win = await chrome.windows.create({ url: 'https://zoost.it/report', focused: true });
    const tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
    if (!tabId) { setReportFallback(); return; }
    const put = (t) => {
      const b = document.getElementById('body');
      if (b) { b.value = t; b.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    // Once, when that tab has finished loading - and only that tab.
    const onDone = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onDone);
      chrome.scripting.executeScript({ target: { tabId }, func: put, args: [text] })
        .catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(onDone);
  } catch (_) {
    setReportFallback();
  }
}
$('repopen').onclick = onRepopen;
// If the tab cannot be opened or written to, say so and leave the reader somewhere to go - a silent
// bail here is a button that looks like it worked.
function setReportFallback() {
  // The sentence below is a claim about the clipboard, so it waits to find out whether it is
  // true. It used to be printed unconditionally beside a `try` that could not catch the
  // write's rejection - so a refused clipboard was announced as a successful one, on the one
  // path whose whole purpose is to leave the reader somewhere to go.
  void sayWhereTheReportWent();
}
// Awaited rather than chained: a `.then(ok, no)` is two scopes nothing can read, and both of them
// write the line the reader acts on.
async function sayWhereTheReportWent() {
  try {
    await navigator.clipboard.writeText(reportText);
  } catch (_) {
    status('Could not open the report page, and the clipboard was refused too. The report is in the panel above - select it and copy it by hand.', 'bad');
    return;
  }
  status('Could not open the report page - the report is on your clipboard. Paste it at zoost.it/report.', 'warn');
}
