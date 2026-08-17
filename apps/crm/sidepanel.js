/*
 * sidepanel.js - IDE orchestrator (multi-workspace).
 */
// Which tabs count as Zoho, taken from the manifest rather than copied out of it. It was eighteen
// patterns typed here as well, so adding a data centre meant remembering this file - and Zoho has
// more of them than either list had: zoho.sa, zoho.uk and zoho.ae answer exactly as the six did,
// with current certificates and a live accounts service each.
const ZOHO_MATCHES = (chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => /^https:\/\/(crm|crmsandbox|one)\./.test(h));
const ZOHO_HOST_RE = /^https:\/\/(crm(sandbox)?|one)\.zoho/;
const envOf = (origin) => /crmsandbox\./.test(origin || '') ? 'sandbox' : 'prod';
const CFG = '.zoost.json';
const NS = ['standalone', 'automation', 'button', 'schedule', 'validation_rule'];
// Zoho writes both. Counted in a real org's mirror: 149 actions of type `functions` and **2** of
// type `function`, same three fields, same meaning - and nine readers here compared against the
// plural only, so those two fired a function that no graph edge, no «broken automation» and no
// action count ever knew about. Silent, because a filter that matches nothing is indistinguishable
// from an org that has nothing. One predicate rather than nine comparisons, so the next form Zoho
// invents is a one-line change instead of a hunt.
const isFnAction = (a) => a && (a.type === 'functions' || a.type === 'function');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir = null, index = new Map(), bound = null, lastCtx = null;
let wsList = [], activeWsId = null;
const zohoReady = () => !!(lastCtx && guardOk());
const FN_NAMES = ['api_name', 'display_name', 'name'];   // every name a function answers to
// Which toolbar controls read from Zoho and which only read the disk. Declared here, above every
// reader, because `refreshContext` runs on a five-second poll and used to name `pull` by hand while
// this list already knew there were two: the per-type Pull stayed enabled through an environment
// mismatch and failed at the click instead, which is the one-of-a-set miss this repository keeps
// recording. Anything Zoho-bound goes in ZOHO_BTNS and is disabled in one place.
const LOCAL_BTNS = ['graph', 'refresh', 'export', 'exportmd', 'health', 'askai'];
const ZOHO_BTNS = ['pull', 'pullone'];
// A workspace of invented data, written by «+ Sample» rather than pulled. It is an ordinary
// workspace in every other respect - the same list, the same walks, the same exports - and there is
// no demo *mode* anywhere: an `if (demo)` branch in rendering code is how invented data eventually
// gets shown as somebody's own. This flag exists so nothing talks to Zoho about it, and to say so.
const isSample = () => !!(bound && bound.sample);
// The one refusal every «open this in Zoho» navigation makes. A sample workspace has no Zoho org
// behind it, so a link built from its instance would open a URL that does not exist: refused with a
// reason rather than left to 404, because «nothing talks to the platform» has to be true of the
// navigations too, or it is not the claim the guide makes. It reads as `if (sampleRefuse()) return;`
// at each site - one sentence, in one place, instead of the same string copied at seven of them.
// Everything that reads or writes through Zoho asks this first, at the moment it would act. It used
// to be enough that the control was disabled or covered - which is protection by position on screen,
// and it held only until somebody put a Zoho-bound action somewhere nobody had thought about. One
// had already got out: a click on a row of the tree that is not downloaded yet fetches that function
// from Zoho, and nothing but the mismatch overlay stood in front of it. Reported as a rule rather
// than as a bug: «since Pull is disabled, everything that talks to Zoho should be».
function mismatchRefuse() {
  if (zohoReady()) return false;
  setStatus(MSG.mismatchRefused, 'warn');
  return true;
}
function sampleRefuse() {
  if (!isSample()) return false;
  setStatus(MSG.sampleNoOrg, 'warn');
  return true;
}
let treeData = [], nameMode = 'display', typeFilter = 'all', graphCache = null;
// The data centre to fall back on when the panel knows neither a workspace nor a tab. It is a
// display-only copy of a setting, so it is read into a URL and never written from here.
let zohoDc = 'zoho.com';
let connectionFilter = null, connFilterSet = null;   // when set, the functions tree shows only functions using that connection
let treeSort = 'name';        // 'name' keeps the namespace grouping; any other key sorts flat
let treeSortDir = 'asc';      // 'asc' | 'desc' - defaults per sort: A→Z for names, biggest-first for numbers
let currentPath = null;
// `viewMode` opens on whatever tab the user put first, decided once in renderTabs() the first time
// the row is drawn. It used to be hard-coded to 'functions', so reordering the tabs moved the
// segments and left the panel showing the same one it always had - the preference was honoured in
// the strip and ignored by the thing the strip is for. Null until that first render, never after.
let viewMode = null, moduleData = [], moduleFilter = 'all', moduleNameMode = 'display';
let searchMode = 'name', codeCache = null, _searchT = null;
let workflowData = [], workflowFilter = 'all', wfIndex = new Map();
let scheduleData = [], scheduleFilter = 'all';
const collapsed = new Set();
const expandedMods = new Set();
let pullActive = false, pullBusy = false;

const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = '') => { $('stxt').textContent = t; $('status').className = cls; showEmergency(false); };

// The pointer to zoost.it/emergency: a link that lives in the markup and is only ever shown or
// hidden. Nothing here is ever built from what Zoho answered, which is what keeps the status line
// safe to print a platform error into - it stays textContent, and the link stays static.
//
// Cleared by every status write and set again by the one failure path that should carry it, so it
// cannot linger over a later success. One place to clear, one place to set.
function showEmergency(on) { const a = $('emerg'); if (a) a.classList.toggle('on', !!on); }
// Every sentence this panel says in more than one place. Not a translation layer and not a habit to
// extend to one-off wording: a message written out twice is two messages the moment somebody edits
// one of them, and that had already happened here - the same lapsed folder permission was reported
// as «needs re-granting», «denied» and «not granted» across ten sites, so the reader met three
// different problems where there was one. Naming the button is the point of the surviving wording:
// ↻ Refresh is the control that re-asks, and «denied» named a state with no action in it.
// A literal that appears once stays where it is used - a constant read by one caller is indirection
// with nothing to hold together. tests/panel.test.mjs enforces the rule in the other direction.
const MSG = {
  actNotHere: 'That action is not in this mirror - it may have been renamed or deleted in Zoho. Press Pull on Actions.',
  actNotPulled: 'Actions have not been pulled into this workspace yet - press Pull here first.',
  modNotHere: 'That module is not in this mirror - it may have been renamed or deleted in Zoho. Press Pull on Modules.',
  modNotPulled: 'Modules have not been pulled into this workspace yet - press Pull here first.',
  openInZoho: 'Open in Zoho \u2197',
  narrowNav: 'No step here matches that. Clear the box to see the whole chain.',
  copyFailed: 'Could not copy: ',
  loadingTree: 'Loading tree\u2026',
  navGone: 'That step is not in this workspace any more.',
  wfNotHere: 'That workflow is not in this mirror - it may have been renamed or deleted in Zoho. Press Pull on Workflows.',
  wfNotPulled: 'Workflows have not been pulled into this workspace yet - press Pull here first.',
  schNotHere: 'That schedule is not in this mirror - it may have been renamed or deleted in Zoho. Press Pull on Schedules.',
  schNotPulled: 'Schedules have not been pulled into this workspace yet - press Pull here first.',
  openThis: 'Open this ',   // two places compose their own ending onto it
  mismatchRefused: 'The active tab is a different org from this workspace - nothing here reads Zoho until they match.',
  noTab: 'No Zoho CRM tab open.',
  folder: 'Folder access needs re-granting - click ↻ Refresh.',
  wrongTab: 'Active Zoho tab does not match this workspace.',
  lastModified: 'Last modified',
  sampleNoOrg: 'This is the sample workspace - there is no Zoho org to open.',
  noModuleTarget: 'Unknown module target - pull once, or open Zoho first.',
  noActionTarget: 'Zoho has no page for this kind that Zoost knows of - open it from the automation list.',
  staleBridge: 'The Zoho tab is still running an older copy of this extension - reload that tab, then pull again.',
  // The three status-dot tooltips, which say what a click will do rather than what the mark is.
  notHere: 'Not in workspace - click to download',
  hereRepull: 'In workspace - click to re-download from Zoho',
  failed: 'Failed: ',
  clickRetry: ' - click to retry',
  // Prefixes, each concatenated with the platform's own sentence rather than replacing it.
  noFn: 'Function not found: ',
  readFailed: 'Read failed: ',
  graphErr: 'Graph error: ',
  exportErr: 'Export error: ',
  refreshErr: 'Refresh error: ',
  rereadErr: 'Could not re-read: ',
  namePrefix: 'Name: ',
  openingFns: 'Opening Functions list…',
  findByName: 'Find by name…',
  // The health audit is drawn twice - the panel's view and the HTML export - and the titles are the
  // only part that has to agree word for word, because a reader moves between the two. The section
  // descriptions are deliberately shorter in the export and stay separate; this one is shared
  // because it carries the «length is verbosity» caveat, which may not be dropped from either.
  hBiggest: 'Largest functions',
  hChattiest: 'Most outbound calls',
  // Said by both groups that read from the platform: neither can distinguish «nothing to report»
  // from «never asked», so both refuse to imply the first.
  notReadYet: 'Nothing has been read yet - run Pull all, and this fills in.',
  hOrphan: 'Orphan candidates',
  hUnresolved: 'Unresolved calls',
  hAmbiguous: 'Ambiguous calls',
  hBroken: 'Broken automations',
  hMissingRefs: 'Missing module references',
  hBiggestDesc: 'By line count, longest first. Length is verbosity, not complexity - a long function is worth a look, not necessarily a problem.',
};
// A comparator over one field, with the `|| ''` the sites all carried: `.sort(byField('name'))`.
const byField = (k) => (a, b) => (a[k] || '').localeCompare(b[k] || '');
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// escHtml is NOT attribute-safe (it leaves " alone). Use escA inside an attribute value, or a
// double quote in the data closes it early and truncates - the trap that halved the getRelated snippet.
// Attribute-safe: `&`, `<`, `>`, and **both** quote characters. escHtml() does not escape quotes, and
// a quote inside an attribute closes it early - that is what cut the getRelatedRecords snippet in
// half. Escaping both quote styles means a reader never has to work out which one the attribute
// used, and the two graph windows already did it this way.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sanitize = (s) => String(s).replace(/[^\w.\-]/g, '_');
// What the pull leaves so the next open does not have to read every meta. A cache beside the
// index, checked against the folder walk on every load - see rebuildTree().
const META_INDEX = 'functions/meta-index.json';
// The shape *and the reading* behind the summary. It goes up when what is written down stops being
// comparable with what this version would produce - and a mismatch discards the file wholesale,
// which is the cheapest honest answer: one slow open, then back to one read. It moved to 2 when the
// call extractor stopped counting names inside comments and strings, because every `refs` on disk
// was the previous reader's answer and nothing else would ever have said so.
const SUMMARY_V = 3;
const META_SV = 2;   // current function-meta schema version; functions on disk below this are "stale" and get re-fetched
// A deletion is a write: what was read from that path is no longer what is there. It goes through
// the same knowledge, so pruning a function Zoho no longer has drops it from the search and the
// diagram without the pull having to remember.
async function removeFile(path) { const parts = path.split('/'); const name = parts.pop(); let d = dir; for (const p of parts) d = await d.getDirectoryHandle(p); await d.removeEntry(name); noteWrite(path); }
// --- Attribution (set PRODUCT_URL to the Chrome Web Store URL once available) ---
const PRODUCT_NAME = chrome.runtime.getManifest().name;   // single source of truth: rename in manifest.json only
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
function isZohoUrl(u) { return /^https?:\/\/([^/]*\.)?zoho(cloud)?\.[a-z.]+(\/|$)/i.test(String(u || '')); }

function openExternal(url) {
  try {
    chrome.tabs.query({ url }, (found) => {
      const t = found && found[0];
      if (t) { chrome.windows.update(t.windowId, { focused: true }); chrome.tabs.update(t.id, { active: true }); return; }
      chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 });
    });
  } catch (_) {
    try { chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 }); } catch (__) {}
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
const PAGE_URL = PRODUCT_URL + '/crm.html';
const DOCS_URL = PRODUCT_URL + '/docs-crm.html';
const STORE_URL = 'https://chromewebstore.google.com/detail/flffecjpbmjfonhoojaiemgjanbjkmpj';
const CONTACT_EMAIL = 'ivan@zoost.it';
const REPO_URL = 'https://github.com/ivannot/zoost';
const OPENAI_BASE = 'https://api.openai.com/v1';
const SPONSOR_URL = 'https://github.com/sponsors/ivannot';
const KOFI_URL = 'https://ko-fi.com/ivannot';
const PRODUCT_AUTHOR = 'Ivan Notaristefano';
const PRODUCT_LICENSE = 'Apache License 2.0';
const LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';
const LEGAL_DISCLAIMER = 'Independent, unofficial tool. Not affiliated with, endorsed by, sponsored by or supported by Zoho Corporation. '
  + '"Zoho", "Zoho CRM" and "Deluge" are trademarks of Zoho Corporation, used here in a nominative sense only, to indicate compatibility. '
  + 'Licensed under the Apache License 2.0 and provided AS IS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. '
  + 'The author accepts no liability for any loss, damage or data issue arising from its use, and is under no obligation to provide support or maintenance. '
  + 'Deciding what may be extracted from Zoho CRM, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';

// ---------- export scope ----------
// Coarse on purpose: sections, never single modules. A per-module allow-list would be a
// permission system, and a permission system that is not enforced anywhere is theatre.
const SCOPE_KEYS = ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules', 'actions', 'addresses', 'connections', 'failures', 'health'];
// `addresses` is off in both, and that is the one default here that is a decision rather than a
// convenience: an export is a file you hand to somebody, and an address is the one thing in this
// mirror that belongs to a person rather than to a configuration. It is one tick away, and the
// report says how many it withheld so nobody reads a blank as an absence.
const SCOPE_FULL = { functions: true, code: true, modules: true, layouts: true, relations: true, workflows: true, schedules: true, actions: true, addresses: false, connections: true, health: true };
const SCOPE_SAFE = { functions: true, code: false, modules: true, layouts: true, relations: true, workflows: false, schedules: false, actions: true, addresses: false, connections: true, health: false };
// **The sensitive section starts unticked, and that is a promise being kept rather than a taste.**
// The site, the README and §4.3 of the privacy policy all say the same thing - «the sensitive part is
// opt-in and flagged when selected» - and this line said the opposite: the first export a person ever
// made arrived with the whole Deluge source in it unless they noticed and cleared it. Found by an
// assistant reading the repository against the site, which is the check the front page now hands out.
// Everything else stays on: what is being defended is the source code, not the export's usefulness.
const SCOPE_DEFAULT = Object.assign({}, SCOPE_FULL, { code: false });
let expScope = Object.assign({}, SCOPE_DEFAULT);
// What the dialog is editing right now, and which of its boxes were cleared *for* the user because
// the data behind them is behind. Kept apart from expScope for one reason: the export dialog saves
// what you leave it with, so mutating the defaults to warn about staleness rewrote them - one
// export and the settings had silently lost Functions and Workflows. A transient warning must never
// become a stored preference. Same lost-update shape as two copies of the settings page.
let dlgScope = Object.assign({}, SCOPE_DEFAULT);
let dlgAutoCleared = new Set();
// **A preference saved before the default was fixed is cleared once, and only once.** The dialog used
// to open with the source ticked, so «code: true» in somebody's stored scope is at least as likely to
// be the old default as a decision - and the promise the site, the README and the privacy policy all
// make is that including it is a decision. So a scope with no `sv` has the sensitive section turned
// off, is written back stamped, and is never touched again: whatever the user chooses from then on
// stands, including turning it straight back on.
//
// Migration that deletes itself, as this repository asks: when nobody can still be carrying an
// unstamped scope, the three lines go and nothing else has to change.
const SCOPE_SV = 2;
async function loadScope() {
  try {
    const st = await chrome.storage.local.get('exportScope');
    if (!st || !st.exportScope) return;
    const saved = st.exportScope;
    if (saved.sv !== SCOPE_SV) {
      saved.code = false;
      saved.sv = SCOPE_SV;
      await chrome.storage.local.set({ exportScope: saved });
    }
    expScope = Object.assign({}, SCOPE_DEFAULT, saved);
  } catch (_) {}
}
// The tab preference, and the access verdicts recorded for the workspace that is open. Two sources
// because they are two different kinds of fact: what you chose (per install) and what Zoho allows
// (per org). Reading either must never throw the panel - a missing or malformed value just means
// "show everything", which is the state a first run is in anyway.
async function loadZohoDc() {
  try { const r = await chrome.storage.local.get('zohoDc'); if (r.zohoDc) zohoDc = r.zohoDc; } catch (_) {}
}
async function loadTabPrefs() {
  try {
    const st = await chrome.storage.local.get('tabPrefs');
    const p = st && st.tabPrefs;
    if (p && Array.isArray(p.order) && Array.isArray(p.hidden)) {
      tabPrefs = {
        order: p.order.filter((id) => TAB[id]),
        hidden: p.hidden.filter((id) => TAB[id]),
        // Absent in preferences saved before this existed: those said nothing about pulling, so the
        // honest reading is "pull everything", not "skip whatever happens to be hidden today".
        nopull: (Array.isArray(p.nopull) ? p.nopull : []).filter((id) => TAB[id]),
      };
    }
  } catch (_) {}
}
async function loadAccess() {
  tabAccess = {}; wsLastPull = null;
  try {
    const cfg = await readCfg();
    if (cfg && cfg.access && typeof cfg.access === 'object') tabAccess = cfg.access;
    if (cfg && typeof cfg.lastPull === 'string') wsLastPull = cfg.lastPull;
  } catch (_) {}
  publishAccess();
}
// The settings page cannot read the workspace's `.zoost.json` - it has no folder handle and no
// business acquiring one - but it has to be able to say *why* a tab is off, or "hidden" becomes the
// silent state this whole change exists to avoid. So the panel publishes a copy for display.
//
// `.zoost.json` stays the authority: this is never read back into a decision, only into a sentence.
// It carries the workspace's name so the settings page can say which org the verdicts belong to,
// rather than implying they are universal.
function publishAccess() {
  try {
    const w = (wsList || []).find((x) => x.id === activeWsId);
    chrome.storage.local.set({ tabAccessView: { ws: (w && w.name) || null, access: tabAccess } });
  } catch (_) {}
}

// A bridge reply is a plain object, so rebuilding an Error from it drops `forbidden` unless it is
// carried across explicitly. Same boundary, same trap, third place it could have been lost: the
// content script raises it, the message channel flattens it, and this is where it becomes an Error
// again. Every `if (!r?.ok) throw …` in the pulls goes through here.
function bridgeError(r, fallback) {
  const e = new Error((r && r.error) || fallback);
  e.status = (r && r.status) || 0;
  e.forbidden = !!(r && r.forbidden);
  return e;
}

// Record what Zoho answered for one area, in the workspace's own config. Per workspace, because a
// role is a property of an org: the same person can be an administrator in one and read-only in
// another, and a verdict carried between them would be a guess.
//
// The date is stored with it and shown, because "forbidden" is not a permanent truth - roles change,
// and a verdict from three months ago is a record of what was asked, not a fact about today. That is
// also why nothing here ever hides an area *without* an answer: no measurement means visible.
async function noteAccess(area, err) {
  if (!TAB[area]) return;
  const state = !err ? 'ok' : err.forbidden ? 'forbidden' : 'failed';
  const before = accessOf(area);
  const prev = tabAccess[area] || {};
  tabAccess = Object.assign({}, tabAccess, { [area]: {
    state, status: (err && err.status) || 0,
    at: new Date().toISOString(),
    // `at` is when we asked; `pulledAt` is when we last actually got the data. They diverge the
    // moment an area stops being pulled, and that gap is the whole point: it is what makes a stale
    // section detectable instead of silently old.
    pulledAt: err ? (prev.pulledAt || null) : new Date().toISOString(),
  } });
  try { await patchCfg({ access: tabAccess }); } catch (_) {}
  publishAccess();
  if (before !== state && (before === 'forbidden' || state === 'forbidden')) renderTabs();   // the set of tabs just changed
}

// What the user reads when an area is refused. Never the status line on its own: "403 on
// /crm/v2/settings/functions" reads as Zoost being broken, which is both alarming and wrong.
function pullFailMessage(area, e) {
  if (e && e.forbidden) {
    return `${tabLabel(area)}: your Zoho role does not grant access${e.status ? ` (Zoho answered ${e.status})` : ''}. `
      + 'Nothing was pulled for it, and the tab is hidden - Settings says why, and lets you check again.';
  }
  return `${tabLabel(area)} pull error: ${(e && e.message) || 'unknown'}`;
}

// The two halves of a failed pull, always taken together: record what Zoho answered for the area,
// then say it. Recording without saying leaves the user with a tab that vanished and no reason;
// saying without recording loses the verdict the next pull skips on. Six sites did both by hand.
async function notePullFailure(area, e) {
  await noteAccess(area, e);
  setStatus(pullFailMessage(area, e), 'bad');
  // A role refusal is not a platform change and no release will fix it, so the pointer would be
  // sending the reader somewhere that cannot help. Everything else is «Zoho did not answer the way
  // this expects», which is exactly the case /emergency exists for.
  showEmergency(!(e && e.forbidden));
}

// After a full pull: one line naming the areas that were refused. Said once, plainly, rather than
// five separate alarms - and it has to be said, because the tabs have just silently gone away.
function forbiddenNote() {
  const off = TABS.map((t) => t.id).filter(isForbidden);
  if (!off.length) return '';
  return ` · ${off.length} area${off.length > 1 ? 's' : ''} not granted to your Zoho role (${off.map(tabLabel).join(', ')}) - hidden`;
}
function scopeToUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.checked = !!dlgScope[k]; });
  const e = $('sc_code'); if (e) e.disabled = !dlgScope.functions;
  const l = $('sc_layouts'); if (l) l.disabled = !dlgScope.modules;
  $('scwarn').textContent = dlgScope.code ? '\u26a0 includes full source code' : '';
}
function scopeFromUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) { if (!!e.checked !== !!dlgScope[k]) dlgAutoCleared.delete(k); dlgScope[k] = !!e.checked; } });
  if (!dlgScope.functions) dlgScope.code = false;
  if (!dlgScope.modules) { dlgScope.layouts = false; dlgScope.relations = false; }
  scopeToUI();
}
// Which export sections come from which pulled area. Not a lookup for its own sake: it is what lets
// the dialog say "this box is off because that data is four months old" instead of quietly offering
// a report whose Connections chapter is from February and looks exactly as current as the rest.
const AREA_SCOPE = {
  functions: ['functions', 'code'],
  modules: ['modules', 'layouts', 'relations'],
  workflows: ['workflows'],
  schedules: ['schedules'],
  actions: ['actions', 'addresses'],
  connections: ['connections'],
  failures: ['failures'],
};

// Sections whose data is behind are cleared when the dialog opens, and why is written next to them.
// Cleared rather than removed: an old chapter is sometimes exactly what you want, so the choice
// stays yours - but it has to be a choice, and the default has to be the safe one. If you tick it
// back on, the report carries that section's own date, so the reader is told too.
//
// This makes the export follow the pull settings without a second set of switches to keep in step.
// Two lists that must agree are two lists that will not.
function scopeStaleNote() {
  const behind = TABS.map((t) => t.id).filter(areaStale);
  const box = $('scstale');
  if (!box) return;
  if (!behind.length) { box.textContent = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = behind.map((id) =>
    `<div><b>${escHtml(tabLabel(id))}</b> - ${escHtml(areaAsOf(id))}, because ${escHtml(staleReason(id))}. `
    + 'Unticked; tick it to include it anyway and the report will carry that date.</div>').join('');
}
let _scopeResolve = null;
function askScope() {
  return new Promise((resolve) => {
    _scopeResolve = resolve;
    dlgScope = Object.assign({}, expScope);
    dlgAutoCleared = new Set();
    TABS.forEach((t) => { if (areaStale(t.id)) (AREA_SCOPE[t.id] || []).forEach((k) => { if (dlgScope[k]) { dlgScope[k] = false; dlgAutoCleared.add(k); } }); });
    scopeToUI();
    scopeStaleNote();
    $('scrim').classList.add('on'); $('expscope').classList.add('on');
  });
}
function closeScope(ok) {
  $('scrim').classList.remove('on'); $('expscope').classList.remove('on');
  const r = _scopeResolve; _scopeResolve = null;
  if (r) r(ok ? Object.assign({}, dlgScope) : null);
}
function showAbout() {
  $('aboutbody').innerHTML =
    `<div><b>${escHtml(PRODUCT_NAME)}</b> \u00b7 v${escHtml(chrome.runtime.getManifest().version)}</div>`
    + `<div style="color:var(--muted)">Created by ${escHtml(PRODUCT_AUTHOR)} (with the support of Claudio)</div>`
    + `<h4>Links</h4><div><a href="${escA(PRODUCT_URL)}" target="_blank" rel="noopener">zoost.it</a> \u00b7 <a href="${escA(PAGE_URL)}" target="_blank" rel="noopener">What it does</a> \u00b7 <a href="${escA(DOCS_URL)}" target="_blank" rel="noopener">How to use</a> \u00b7 <a href="${escHtml(PRODUCT_URL)}/privacy.html" target="_blank" rel="noopener">Privacy</a> \u00b7 <a href="${escA(STORE_URL)}" target="_blank" rel="noopener">Web Store</a> \u00b7 <a href="${escA(REPO_URL)}" target="_blank" rel="noopener">Source</a> \u00b7 <a href="mailto:${escHtml(CONTACT_EMAIL)}">${escHtml(CONTACT_EMAIL)}</a></div>`
    + `<h4>Support</h4><div>${SPONSOR_URL ? `<a href="${escA(SPONSOR_URL)}" target="_blank" rel="noopener">GitHub Sponsors</a>` : ''}${SPONSOR_URL && KOFI_URL ? ' \u00b7 ' : ''}${KOFI_URL ? `<a href="${escA(KOFI_URL)}" target="_blank" rel="noopener">\u2615 Ko-fi</a>` : ''}</div>`
    + `<h4>Licence</h4><div><a href="${escA(LICENSE_URL)}" target="_blank" rel="noopener">${escHtml(PRODUCT_LICENSE)}</a> \u00b7 \u00a9 2026 ${escHtml(PRODUCT_AUTHOR)}</div>`
    + `<h4>Legal</h4><div class="legal">${escHtml(LEGAL_DISCLAIMER)}</div>`
    + `<h4>Your data</h4><div class="legal">Everything stays between your browser, your Zoho session and the local folder you picked. `
    + `The extension has no server of its own and sends nothing anywhere. Exports are written to your workspace folder - what happens to them afterwards is up to you.</div>`;
  $('scrim').classList.add('on'); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); $('aboutdlg').classList.remove('on'); }

// ---------- filesystem ----------
// Which function files this panel has rewritten since the summary was last trusted.
//
// `functions/meta-index.json` describes files *by path*, and the folder walk that checks it sees
// paths appearing and disappearing - not a file whose bytes changed while its name stayed the same.
// So a pull that refreshes a function in place, or a save picked up from Zoho, would leave the
// summary describing the previous source: the tree would show the old date, and the diagram the old
// calls. Found by a review that asked for the invariant to be *proved* rather than assumed, and it
// did not hold.
//
// The fix is where the review put it first: at the point where we write. Every write through here
// marks its function, the next load re-reads exactly those and writes the summary out again, and the
// set is cleared when it has. No fingerprint, no second read to check a first one - we know what we
// wrote, because we wrote it.
//
// What this cannot see is somebody else's write: an editor, a `git checkout`, a file copied in. That
// is what ↻ Refresh is for, and it now drops the summary entirely rather than trusting it.
// Two readings, two writers, two sets. `.meta.json` is described by `saveMetaIndex()` and `.dg` by
// `saveGraphFacts()`, and they finish at different moments - one is a single write at the end of the
// tree load, the other happens whenever the diagram is built. One set for both meant the first
// writer declared the second one's work done: `saveMetaIndex()` cleared the mark while the graph
// build, started and deliberately not awaited, was still walking the folder. The ordering happened
// to be favourable, which is not the same as being correct - and an outside review said exactly
// that. Each set is now cleared by the writer that actually refreshed it, path by path, so a file
// rewritten *during* a build stays marked.
let _dirtyMeta = new Set();
let _dirtySource = new Set();
/** ↻ Refresh: read every file again.
 *
 *  It is the answer to the write this panel cannot see - an editor, a `git checkout`, a folder
 *  synced from another machine - and it is what lets the summary be cheap the rest of the time.
 *
 *  It marks rather than raising a flag. A flag would have needed a moment to be lowered, and the
 *  only honest moment is «when every file has been read again», which is two different events for
 *  the metas and the sources - and would never arrive at all on a workspace where the diagram is
 *  never built. Marking every known path uses the machinery that already exists, and each writer
 *  gives up its own marks as it describes them. One mechanism, no lifetime to reason about. */
function distrustEverything() {
  treeData.forEach((r) => { if (r.path) { _dirtyMeta.add(r.path); _dirtySource.add(r.path); } });
}
/** What a write means for everything read from that file and still held in memory.
 *
 *  This used to mark the summary and nothing else, and the six things made out of mirror files and
 *  kept in memory were each dropped by whoever remembered to at the call site. Counted rather than
 *  assumed: two were right and **four were not**. `syncOne` - the panel following a save made in
 *  Zoho - cleared the diagram and left `in: code` searching the text from before the edit;
 *  `resyncModule` left the assistant holding the field list it had replaced a second earlier; the
 *  actions pull rebuilt «which rule fires this» and forgot the catalogue beside it; the workflows
 *  pull changed the answer to «which rule fires this» and rebuilt nothing at all. None of them is a
 *  bug you can see: the mirror on disk is right in every case, and the panel is confidently out of
 *  date about it. The two that were right were right by luck - nothing would have said otherwise.
 *
 *  So the mapping from «what was written» to «what must be forgotten» lives here, at the one point
 *  every write and every deletion passes through, and a new write path inherits it without knowing
 *  it exists. `tests/panel.test.mjs` holds the shape - no cache of file contents may be cleared
 *  anywhere else - and `tools/probe.py` proves them in a browser, each one red on the defect put
 *  back. */
const noteWrite = (rel) => {
  if (isModuleFile(rel)) { graphCache = null; moduleFilesCache = null; return; }
  // The index is what says which names are modules of this org, so a pull that rewrites it changes
  // every module reading the panel is about to resolve.
  if (rel === 'modules/index.json') { modNamesCache = null; graphCache = null; return; }
  if (rel === 'connections/index.json') { aiConnCache = null; return; }
  if (rel === 'actions/index.json') { aiActCache = null; return; }
  // Which rule uses which action is read out of the rules themselves, so a workflows pull changes
  // the answer - and the actions pull was the only one that rebuilt it.
  if (rel.startsWith('workflows/')) { actionUsers = null; aiActCache = null; return; }
  if (!rel.startsWith('functions/')) return;
  if (rel.endsWith('.meta.json')) _dirtyMeta.add(rel.replace(/\.meta\.json$/, '.dg'));
  else if (rel.endsWith('.dg')) { _dirtySource.add(rel); _dirtyMeta.add(rel); codeCache = null; graphCache = null; }
};
// The folders, remembered. Every read and every write resolved `functions/<namespace>/` from the
// root again - two calls to the browser's file system before the one that does the work - so half of
// what a pull and a load spend is asking for the same directory over and over. Measured: writing a
// function cost 8 calls, of which 4 were this.
//
// Handles are per working folder, so the cache is dropped whenever that changes; a stale handle is
// worse than a slow one, and this is the kind of cache that has to be given up eagerly rather than
// checked. `removeEntry` drops it too, since a folder that has just been deleted must not be handed
// back by us.
let _dirCache = new Map();
const forgetDirs = () => { _dirCache = new Map(); };
async function dirFor(parts, create) {
  const key = parts.join('/');
  // The cache answers for writes too: a folder that has been created once exists, and asking the
  // browser to create it again is the call this exists to avoid. Skipping the cache when `create`
  // was set left a pull paying full price for every file it wrote - half of the eight calls each.
  if (_dirCache.has(key)) return _dirCache.get(key);
  let d = dir;
  for (const p of parts) d = await d.getDirectoryHandle(p, create ? { create: true } : undefined);
  _dirCache.set(key, d);
  return d;
}
async function ensurePerm(h) { const o = { mode: 'readwrite' }; if ((await h.queryPermission(o)) === 'granted') return true; return (await h.requestPermission(o)) === 'granted'; }
const hasPerm = async (h) => (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
// The guard every pull, graph and export opens with. It throws rather than returning false, so the
// caller's own `catch` writes the message: the nine sites that used it were already a `try` block
// each, and a helper that returned a boolean would have left the `throw` copied at all nine.
// Callers that instead want to report and carry on keep their own `ensurePerm`, and say MSG.folder:
// the wording no longer varies by call site, so a wrapper like «Export error: …» is the only thing
// that differs between one report of a lapsed permission and another.
async function requirePerm(h) { if (!(await ensurePerm(h))) throw new Error(MSG.folder); }
async function writeFile(rel, content) {
  const parts = rel.split('/');
  const d = await dirFor(parts.slice(0, -1), true);
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable(); await w.write(content); await w.close();
  noteWrite(rel);
}
async function readFile(rel) {
  const parts = rel.split('/');
  const d = await dirFor(parts.slice(0, -1), false);
  const fh = await d.getFileHandle(parts[parts.length - 1]);
  return (await fh.getFile()).text();
}
async function* walk(d, prefix = '') {
  for await (const [name, h] of d.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') yield* walk(h, prefix + name + '/'); else yield prefix + name;
  }
}
const readCfg = async () => { try { return JSON.parse(await readFile(CFG)); } catch { return null; } };
const writeCfg = async (o) => writeFile(CFG, JSON.stringify(o, null, 2));
// Merge rather than replace. `.zoost.json` now holds more than the binding - the access verdicts
// below live there too - and a whole-object write from any one writer silently drops what the others
// put in it. This is the `cacheBinding` trap in CLAUDE.md, arriving a second time with a new field.
const patchCfg = async (o) => writeCfg(Object.assign({}, (await readCfg()) || {}, o));

// ---------- tabs ----------
//
// One registry. The five tabs used to be spelled out in the markup, in five `.active` toggles, in
// five click handlers and in two label maps - which is why they could never be reordered and why a
// sixth would have to be remembered in eight places. Everything that varies per tab is here; the
// segment row is built from it.
//
// `area` is what a pull and a permission verdict are keyed on. It matches the tab id today, and is
// kept as its own field because the two are different ideas: a tab is a thing you look at, an area
// is a thing Zoho may refuse.
// The registry lives in tabs.js, which the settings page reads too - it was written twice and the
// second copy did not learn about Actions. Actions is one tab with a Kind filter rather than four,
// because notifications, field updates, tasks and webhooks answer one question and share one shape:
// the same decision the Analytics panel takes for its seven view types.
const TABS = window.ZOOST_TABS;
const TAB = Object.fromEntries(TABS.map((t) => [t.id, t]));
const tabLabel = (id) => (TAB[id] ? TAB[id].label : id);

// What the user chose: which tabs to show and in what order. A preference, stored per install and
// not per workspace - unlike the access verdicts, which are a property of one org's roles.
let tabPrefs = { order: TABS.map((t) => t.id), hidden: [], nopull: [] };
// What Zoho answered, for the workspace currently open: area -> { state, status, at }.
// 'ok' | 'forbidden' | 'failed'. Empty until a pull has actually asked.
let tabAccess = {};

const accessOf = (id) => (tabAccess[id] && tabAccess[id].state) || null;
// When an area was last read. Falls back to the workspace's own `lastPull` for anything mirrored
// before per-area dates existed: those folders hold real, current data and simply carry no record.
// Reading "no measurement" as "behind" is the inversion this project forbids everywhere else, and
// here it had teeth - it silently unticked Functions and Workflows in the export dialog, so a report
// quietly came out smaller than the user asked for.
//
// Where it must err, it errs towards *not* flagging: an over-stated freshness is visible, because
// both reports print the per-area dates whether or not anything is behind. A section dropped from a
// report is not.
let wsLastPull = null;
const pulledAt = (id) => (tabAccess[id] && tabAccess[id].pulledAt) || wsLastPull || null;

// Staleness is derived, never declared. An area is behind if the mirror holds newer data for
// something else - which is true whether it was excluded from the pull, refused by Zoho, or simply
// failed, and stays true without anyone having to remember to set a flag. The margin exists because
// a full pull writes its areas seconds apart and that is not a difference worth reporting.
const STALE_MARGIN_MS = 6 * 60 * 60 * 1000;
function newestPull() {
  return TABS.map((t) => pulledAt(t.id)).filter(Boolean).sort().slice(-1)[0] || null;
}
function areaStale(id) {
  const newest = newestPull(); if (!newest) return false;      // nothing pulled yet: nothing is behind
  const mine = pulledAt(id);
  if (!mine) return true;                                       // never pulled, while others have been
  return Date.parse(newest) - Date.parse(mine) > STALE_MARGIN_MS;
}
// The words a user reads. Never "stale" on its own - a date they can act on, and the reason.
function areaAsOf(id) {
  const mine = pulledAt(id);
  if (!mine) return 'never pulled';
  const d = new Date(mine);
  return 'as of ' + (isNaN(d) ? mine : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
}
function staleReason(id) {
  if (isForbidden(id)) return 'your Zoho role no longer grants it';
  if (!isPulled(id)) return 'you excluded it from Pull all';
  return 'the last pull did not refresh it';
}
const isForbidden = (id) => accessOf(id) === 'forbidden';
const isHiddenByUser = (id) => tabPrefs.hidden.includes(id);
// Hiding a tab and skipping its pull are separate on purpose, but they are not equally likely: most
// people who turn a tab off do it because they cannot read that area anyway, and leaving it in the
// pull chain then buys nothing but an error per pull. So the flag exists and it defaults to
// following the tab - hide one and its pull goes with it unless you say otherwise, because the
// alternative is a setting that is right for the ninth user out of ten and silently wrong for the
// other nine.
const isPulled = (id) => !tabPrefs.nopull.includes(id);
// The order is the preference's, with anything the preference has never heard of appended - so a
// tab added in a later version appears instead of vanishing for everyone who has saved a setting.
function tabOrder() {
  const known = tabPrefs.order.filter((id) => TAB[id]);
  return known.concat(TABS.map((t) => t.id).filter((id) => !known.includes(id)));
}
// A tab is shown unless the user hid it or Zoho refused the area. Both make it *absent*, not
// disabled: a control that can never do anything is noise, and a greyed one claims there is
// something here you cannot have. The reason is never lost - it is stated after a pull and again in
// Settings, which is where hiding stops being silent.
const visibleTabs = () => tabOrder().filter((id) => !isHiddenByUser(id) && !isForbidden(id));

// ---------- Zoho tab / bridge ----------
async function tabHasCrmFrame(id) { try { const r = await chrome.tabs.sendMessage(id, { cmd: 'context' }); return !!(r && r.ok && r.origin); } catch (_) { return false; } }
async function zohoTabId() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && ZOHO_HOST_RE.test(active.url || '')) return active.id;
  if (active && (await tabHasCrmFrame(active.id))) return active.id;   // wrapper (e.g. Zoho One) with a CRM iframe
  const tabs = await chrome.tabs.query({ url: ZOHO_MATCHES });
  return tabs[0]?.id ?? null;
}
async function activeZohoTabId() {
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!a) return null;
  if (ZOHO_HOST_RE.test(a.url || '')) return a.id;
  return (await tabHasCrmFrame(a.id)) ? a.id : null;                   // wrapper-agnostic detection
}
let _crmFrame = { tabId: null, frameId: 0, ts: 0 };
async function crmFrameId(tabId) {
  const now = Date.now();
  if (_crmFrame.tabId === tabId && now - _crmFrame.ts < 6000) return _crmFrame.frameId;
  let fid = 0;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => ({ href: location.href, top: window === window.top }) });
    const crm = (res || []).map((r) => ({ frameId: r.frameId, ...(r.result || {}) })).filter((x) => /^https:\/\/crm(sandbox)?\.zoho/.test(x.href || ''));
    if (crm.length) { const top = crm.find((x) => x.top); fid = (top || crm[0]).frameId; }
  } catch (_) {}
  _crmFrame = { tabId, frameId: fid, ts: now };
  return fid;
}
async function ensureBridge(tabId) {
  const fid = await crmFrameId(tabId);
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'context' }, { frameId: fid }); return true; }
  catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [fid] }, world: 'MAIN', files: ['hook.js'] });
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [fid] }, files: ['content-bridge.js'] });
      await sleep(60); return true;
    } catch { return false; }
  }
}
async function toBridge(msg) {
  // The last line, below every disabled control and every guard above it. The panel speaks to the
  // tab that is open, so a command that is not the context probe must not travel while that tab is a
  // different org from the workspace this panel is bound to - whatever removed the `disabled`, and
  // whoever called the function directly. `context` is how the mismatch is detected in the first
  // place, so it is the one thing that always goes; and a panel with nothing bound yet is creating
  // its first workspace, which is not a mismatch.
  if (msg && msg.cmd !== 'context' && bound && !guardOk()) throw new Error(MSG.mismatchRefused);
  const id = await zohoTabId(); if (!id) throw new Error(MSG.noTab);
  await ensureBridge(id); const fid = await crmFrameId(id); return chrome.tabs.sendMessage(id, msg, { frameId: fid });
}
async function getContext() { try { const r = await toBridge({ cmd: 'context' }); return r?.ok ? r : null; } catch { return null; } }
async function waitTabComplete(id, timeout = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { const t = await chrome.tabs.get(id); if (t.status === 'complete') return true; } catch { return false; } await sleep(200); }
  return false;
}

// ---------- context bar + off-zoho overlay ----------
async function refreshContext() {
  const ctxEl = $('ctx'), who = $('who'), bnd = $('bound');
  const activeId = await activeZohoTabId();
  if (!activeId) {                         // the ACTIVE tab is not Zoho
    lastCtx = null; $('mmbar').classList.remove('show'); updateWsButtons();
    // Not over a sample. A sample has nothing to say to Zoho, so a Zoho tab is not a precondition
    // for reading it - and covering the panel there would mean the one workspace anybody can open
    // without an account is the one you cannot open without one. Reported.
    // `sampleBusy` belongs here and not only at the click. This panel re-derives its whole state on
    // a five-second poll, so anything set imperatively on top of that is undone by the next tick -
    // reported as the overlay coming back in the middle of writing the sample and then leaving
    // again. A state that has to hold across time is a term in the condition, never an assignment.
    $('offoverlay').classList.toggle('show', !isSample() && !sampleBusy);
    ctxEl.className = 'offzoho'; who.innerHTML = 'Not on a Zoho tab';
    bnd.innerHTML = bound ? `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)}` : '';
    document.body.classList.add('zoho-blocked'); ZOHO_BTNS.forEach((b) => ($(b).disabled = true));
    return;
  }
  $('offoverlay').classList.remove('show');
  await ensureBridge(activeId);
  const cfid = await crmFrameId(activeId);
  try { const r = await chrome.tabs.sendMessage(activeId, { cmd: 'context' }, { frameId: cfid }); lastCtx = r?.ok ? r : null; } catch { lastCtx = null; }
  if (!lastCtx) { ctxEl.className = 'offzoho'; who.innerHTML = 'Zoho tab (not ready)'; bnd.textContent = ''; document.body.classList.add('zoho-blocked'); ZOHO_BTNS.forEach((b) => ($(b).disabled = true)); updateWsButtons(); return; }
  // On a sample workspace the tab half is true and irrelevant: the tab really is on that org, and
  // this folder has nothing to do with it. Saying so is better than leaving the two halves side by
  // side implying a relationship - reported as «switching to the test org leaves ZOHO TAB on the
  // previous one», which it does, correctly, and read as a bug because nothing said it did not matter.
  who.innerHTML = `<span class="rlbl remote">Zoho tab</span><b>${escHtml(lastCtx.instance || '?')}</b> <span>· org ${escHtml(lastCtx.org || '?')} · ${envOf(lastCtx.origin)}${isSample() ? ' · not related to the sample' : ''}</span>`;
  if (!bound) { ctxEl.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">not bound yet</span>'; }
  else if (guardOk()) { ctxEl.className = 'match'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✓`; }
  else if (isSample()) { ctxEl.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">sample - generated, never pulled</span>'; }
  else { ctxEl.className = 'mismatch'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>≠ ${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✗`; }
  // The discrepancy is stated in both cases, and the sample is one of them. Suppressing the bar for
  // it was wrong: reading invented data while looking at a real org is exactly what this bar is for,
  // and one muted line in the workspace half is too quiet to carry it. Reported.
  //
  // What differs is the **blocking**, and only that. A real mismatch can be resolved - one of the
  // two is wrong - and browsing until it is would mean reading org A's mirror while looking at org
  // B. A sample is never going to match anything, everything Zoho-bound is already refused for it,
  // and blocking it would make it unusable the whole time a Zoho tab is open - which is always.
  // So: say it, do not stop it.
  const sampleMm = !!(bound && lastCtx && isSample());
  const mm = !!(bound && lastCtx && !guardOk() && !isSample());
  const mmbar = $('mmbar');
  mmbar.classList.toggle('show', mm || sampleMm);
  mmbar.classList.toggle('soft', sampleMm);
  if (mm) { $('preview').classList.remove('show'); $('resizer').classList.remove('show'); }
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
      ? `Sample workspace - invented data. Pulling is off: nothing here comes from \u00ab${lastCtx.instance || '?'}\u00bb (org ${lastCtx.org}), and nothing here can reach it.`
      : `Zoho tab \u00ab${lastCtx.instance || '?'}\u00bb (org ${lastCtx.org}) \u2260 local workspace \u00ab${bound.instance || '?'}\u00bb (org ${bound.org}). Pulling is off until they match; what is already mirrored stays readable.`;
    // «Switch tab» is meaningless for a sample: there is no Zoho org to switch to.
    $('mmgo').style.display = sampleMm ? 'none' : '';
    $('mmgo').textContent = `Switch tab \u2192 \u00ab${bound.instance || '?'}\u00bb \u2197`;
    $('mmgo').onclick = () => switchTab();
    const match = (wsList || []).find((w) => w.id !== activeWsId && w.binding && w.binding.org === lastCtx.org && (!w.binding.base || !lastCtx.origin || w.binding.base === lastCtx.origin));
    const sw = $('mmsw'); sw.style.display = sampleMm ? 'none' : '';
    if (match) { sw.textContent = `Switch workspace \u2192 \u00ab${match.name}\u00bb`; sw.onclick = () => { $('ws').value = match.id; activate(match, true); }; }
    else { sw.textContent = `Create workspace for \u00ab${lastCtx.instance || '?'}\u00bb`; sw.onclick = () => addWorkspaceForTab(); }
  }
  // inhibit all Zoho-bound operations unless the active tab matches the workspace (tab-navigation stays allowed)
  document.body.classList.toggle('zoho-blocked', !zohoReady());
  ZOHO_BTNS.forEach((b) => ($(b).disabled = pullBusy || !zohoReady() || !dir || navOpenNow()));   // a pull in progress - or the history view - keeps them disabled even as the 5s refresh runs
  updateWsButtons();
}
function guardOk() {
  // Everything Zoho-bound funnels through here, so this is the one place a sample workspace has to
  // be refused - rather than a condition repeated at each button, where one of them is eventually
  // forgotten. It is not a mismatch, though, and refreshContext keeps the two apart: the mismatch
  // bar and its overlay are for two environments that could match, and this one never will.
  if (isSample()) return false;
  if (!bound || !lastCtx) return true;
  if (bound.org !== lastCtx.org) return false;                                   // different org
  if ((bound.base || '') !== (lastCtx.origin || '')) return false;               // different host/env
  if (bound.instance && lastCtx.instance && bound.instance !== lastCtx.instance) return false; // different specific (sandbox) instance
  return true;
}

// ---------- tree ----------
const labelOf = (e) => (nameMode === 'display' ? (e.display_name || e.api_name) : (e.api_name || e.display_name));
// Filter the functions tree to those that use a given connection (built from the pulled function
// metadata). This is the "which/how many functions use connection X" answer, reusing the tree.
async function filterByConnection(name) {
  const g = await ensureGraph();
  connFilterSet = new Set(Object.values(g.nodes).filter((n) => (n.connections || []).some((c) => c.name === name)).map((n) => n.file));
  connectionFilter = name;
  if (viewMode !== 'functions') setMode('functions'); else renderTree();
}
function clearConnectionFilter() { connectionFilter = null; connFilterSet = null; renderTree(); }
// One row builder, shared by the grouped and the sorted-flat rendering, so the two cannot drift.
function fnRowEl(e) {
  const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path; el.dataset.id = e.id || '';
  el.setAttribute('aria-selected', e.path === currentPath);
  const stCls = e.error ? 'st-err' : e.stale ? 'st-stale' : e.downloaded ? 'st-ok' : 'st-no';
  const stCh = e.error ? '⟳' : e.stale ? '◐' : e.downloaded ? '●' : '○';
  const stTitle = e.error ? (MSG.failed + (e.errorMsg || 'unknown') + MSG.clickRetry) : e.stale ? 'Older data (no connections / author) - click to refresh' : e.downloaded ? MSG.hereRepull : MSG.notHere;
  // Every trailing slot is always emitted, empty when it has nothing to say. A slot that disappears
  // lets the next one slide into its place, and then the numbers stop lining up down the list -
  // which is the whole point of having them there.
  const st = e.stats;
  const restSlot = `<span class="rest rr">${e.rest ? 'REST' : ''}</span>`;
  const nsSlot = treeSort !== 'name'   // flat sorting drops the namespace headers, so the row carries it
    ? `<span class="rest rn" title="${escA(e.namespace || '')}">${escHtml((e.namespace || '').slice(0, 4))}</span>` : '';
  const lineSlot = `<span class="rest rfl"${st ? ` title="${st.lines} lines · ${st.codeLines} code lines · ${(st.chars / 1024).toFixed(1)} KB"` : ''}>${st ? st.lines + 'L' : ''}</span>`;
  const callSlot = `<span class="rest rc"${st && st.apiCalls ? ` title="${st.apiCalls} outbound call(s): ${st.invokeurl} invokeurl · ${st.crm} zoho.crm · ${st.zoho} other Zoho service${st.sendmail ? ' · ' + st.sendmail + ' sendmail' : ''}"` : ''}>${st && st.apiCalls ? st.apiCalls + '↗' : ''}</span>`;
  el.innerHTML = `<span class="st ${stCls}" title="${escA(stTitle)}">${stCh}</span><span class="fname">${escHtml(labelOf(e))}</span>${restSlot}${nsSlot}${lineSlot}${callSlot}`;
  el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); downloadOne(e).then(() => { updateRow(e); updateMissingButton(); }); };
  el.onclick = () => { if (e.downloaded) openFromTree(e.path); else downloadOne(e).then(() => { updateRow(e); updateMissingButton(); }); };
  return el;
}
// Sorting by a number answers a different question from browsing by namespace, so a numeric sort
// drops the grouping and goes flat, highest first. Descending only: these are "which are the big
// ones" questions, and an ascending list of the smallest functions answers nothing anyone asks.
const TREE_SORTS = {
  name: null,
  lines: { label: 'lines', get: (e) => (e.stats ? e.stats.lines : -1) },
  calls: { label: 'outbound calls', get: (e) => (e.stats ? e.stats.apiCalls : -1) },
  size: { label: 'size in bytes', get: (e) => (e.stats ? e.stats.chars : -1) },
  modified: { label: 'last modified', get: (e) => (e.updatedTime ? (Date.parse(String(e.updatedTime).replace(' ', 'T')) || 0) : -1) },
};
function renderTree() {
  if (viewMode !== 'functions') return;
  const term = $('find').value.trim().toLowerCase();
  const shown = treeData
    .filter((e) => typeFilter === 'all' || (typeFilter === 'rest' ? e.rest : e.namespace === typeFilter))
    .filter((e) => !connFilterSet || connFilterSet.has(e.path))
  // A function carries **three** names and Zoho means a different thing by each: `display_name`
  // («LearningObjects - Upsert User DELETE»), `api_name` (a lowercased slug), and `name` - the
  // CamelCase one you actually write in Deluge as `namespace.Name(...)`. The filter checked two of
  // them, so searching for the name you had just copied out of a call found nothing. Reported.
  // Which one is *shown* is the reader's choice (Name: display / api); which ones are *searched* is
  // not a choice at all - all of them, or the box lies about what is in the workspace.
    .filter((e) => !term || FN_NAMES.some((k) => String(e[k] || '').toLowerCase().includes(term)));
  const tree = $('tree'); tree.innerHTML = '';
  if (connectionFilter) {
    const b = document.createElement('div'); b.className = 'connbanner';
    b.innerHTML = `<span><b>${shown.length}</b> function(s) use <b>${escHtml(connectionFilter)}</b></span><span class="connclear" title="Clear filter">✕</span>`;
    b.querySelector('.connclear').onclick = clearConnectionFilter;
    tree.appendChild(b);
  }
  // "No matches." is right only when there was something to match. With nothing pulled - or with the
  // folder access lapsed - it is the least useful sentence available.
  if (!shown.length) {
    const m = document.createElement('div'); m.className = 'empty';
    m.innerHTML = treeData.length ? '<b>No matches.</b>'
      : (emptyReason() || '<b>Nothing pulled yet.</b> Press <b>Pull all</b> to mirror this org.');
    tree.appendChild(m); return;
  }
  const sorter = TREE_SORTS[treeSort];
  if (sorter) {
    const dir = treeSortDir === 'asc' ? 1 : -1;
    const list = shown.slice().sort((a, b) => {
      const va = sorter.get(a), vb = sorter.get(b);
      // Rows with no data yet stay at the bottom whichever way we sort: ascending would otherwise
      // open the list with the functions we know nothing about.
      if ((va < 0) !== (vb < 0)) return va < 0 ? 1 : -1;
      if (va !== vb) return dir * (va - vb);
      return labelOf(a).localeCompare(labelOf(b));
    });
    const noData = list.filter((e) => sorter.get(e) < 0).length;
    const hdr = document.createElement('div'); hdr.className = 'srhdr';
    hdr.textContent = `${list.length} function(s) by ${sorter.label}, ${treeSortDir === 'asc' ? 'lowest' : 'highest'} first`
      + (noData ? ` · ${noData} without data (not downloaded yet)` : '');
    tree.appendChild(hdr);
    list.forEach((e) => tree.appendChild(fnRowEl(e)));
    return;
  }
  const byNs = {}; shown.forEach((e) => { (byNs[e.namespace] ||= []).push(e); });
  Object.keys(byNs).sort().forEach((ns) => {
    const list = byNs[ns].sort((a, b) => (treeSortDir === 'asc' ? 1 : -1) * labelOf(a).localeCompare(labelOf(b)));
    const isCol = collapsed.has(ns);
    const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
    g.innerHTML = `<span class="chev">▾</span><span>${escHtml(ns)}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete(ns) : collapsed.add(ns); renderTree(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => tree.appendChild(fnRowEl(e)));
  });
}
// Which load is the current one. A refresh, a change of workspace or a pull can overtake one that
// is still reading tranches; without a token the two interleave and the older one writes its rows
// over the newer one's.
let treeLoad = 0;

async function rebuildTree() {
  // Before anything that can yield. Whether another task could actually clear these marks in the
  // window between the permission check and here is the sort of question nobody should have to
  // answer while reading: the snapshot goes first, and then there is nothing to answer.
  const dirtyMeta = new Set(_dirtyMeta);
  if (!dir) return;
  if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'warn'); return; }
  const mine = ++treeLoad;
  const current = () => mine === treeLoad;
  setStatus(MSG.loadingTree, 'busy');
  graphCache = null; moduleFilesCache = null; aiConnCache = null;
  const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
  if (!current()) return;

  // ---- 1. the index draws the tree ---------------------------------------------------------------
  // One read. It lists every function, downloaded or not, with the fields a row shows - so the panel
  // is usable before a single meta has been opened.
  let idx = null; try { idx = JSON.parse(await readFile('functions/index.json')); } catch (_) {}
  if (!current()) return;
  index = new Map();
  const byPath = new Map(), byId = new Map();
  if (idx && idx.length) {
    treeData = idx.map((e) => {
      const id = String(e.id);
      const path = `functions/${sanitize(e.namespace)}/${sanitize(e.api_name)}.dg`;
      index.set(id, { path, category: e.category, source: e.source, name: e.name, rest: e.rest });
      const row = { path, api_name: e.api_name, display_name: e.display_name || e.api_name,
                    namespace: e.namespace, rest: e.rest, id, category: e.category, source: e.source,
                    downloaded: false, stale: false, error: false, updatedTime: null };
      byPath.set(path, row); byId.set(id, row);
      return row;
    });
    renderTree();
    setStatus(`${treeData.length} functions - reading what is on disk\u2026`, 'busy');
  } else {
    treeData = [];
  }

  // ---- 2. the walk says what is on disk -----------------------------------------------------------
  // Names only: `walk()` yields paths and opens nothing. A function the index does not know about is
  // still shown - a workspace pulled by an older version, or one the index has fallen behind.
  const metaPaths = [];
  for await (const p of walk(dir)) {
    if (!p.startsWith('functions/') || !p.endsWith('.meta.json')) continue;
    metaPaths.push(p);
    const dg = p.replace(/\.meta\.json$/, '.dg');
    const row = byPath.get(dg);
    if (row) row.downloaded = true;
  }
  if (!current()) return;
  if (!treeData.length) {
    // No index: a legacy workspace, or one whose index could not be read. The tree is what is on
    // disk, and the metas below are the only source for it - so it stays empty until they arrive.
    metaPaths.forEach((p) => {
      const dg = p.replace(/\.meta\.json$/, '.dg');
      const row = { path: dg, api_name: dg.split('/').pop().replace(/\.dg$/, ''),
                    display_name: dg.split('/').pop().replace(/\.dg$/, ''), namespace: dg.split('/')[1],
                    rest: false, id: dg, category: '', source: '', downloaded: true, stale: false,
                    error: false, updatedTime: null };
      byPath.set(dg, row); treeData.push(row);
    });
  }
  renderTree(); updateMissingButton();

  // ---- 3. what only the metas know, from the summary the pull leaves behind ----------------------
  // `functions/meta-index.json` holds the stale mark, the modified date, the namespace and the
  // display name, keyed by source path. One read instead of one per function - and it is checked
  // against the walk rather than believed: anything it does not describe is read from its own meta,
  // which is what makes a hand-pulled function, an older mirror and a file copied in by somebody
  // else all come out right.
  let summary = null;
  try { summary = JSON.parse(await readFile(META_INDEX)); } catch (_) {}
  if (!current()) return;
  const known = (summary && summary.v === SUMMARY_V && summary.files) ? summary.files : {};
  const missing = [];
  for (const mp of metaPaths) {
    const dg = mp.replace(/\.meta\.json$/, '.dg');
    const s = known[dg];
    const row = byPath.get(dg);
    if (!s || !row || dirtyMeta.has(dg)) { missing.push(mp); continue; }
    row.downloaded = true;
    row.stale = (s.sv || 0) < META_SV;
    row.updatedTime = s.updatedTime || null;
    if (s.namespace) row.namespace = s.namespace;
    if (s.display_name) row.display_name = s.display_name;
  }
  // The summary is only worth rewriting when it is wrong: something new to describe, or something it
  // still describes that has gone. Otherwise opening the panel would write to the workspace every
  // time, which is a change to a folder the reader has under version control.
  let stale_summary = missing.length > 0 || Object.keys(known).length !== metaPaths.length;
  if (missing.length) setStatus(`${treeData.length} functions - reading ${missing.length} detail(s)\u2026`, 'busy');
  renderTree();

  const TRANCHE = 120;
  let done = 0, lastPaint = 0;
  const metaPathsToRead = missing;
  for (let i = 0; i < metaPathsToRead.length; i += TRANCHE) {
    if (!current()) return;
    const batch = metaPathsToRead.slice(i, i + TRANCHE);
    await Promise.all(batch.map(async (mp) => {
      try {
        const meta = JSON.parse(await readFile(mp));
        const dg = mp.replace(/\.meta\.json$/, '.dg');
        // By path, then by id - both from a Map. The second lookup used to be a `treeData.find()`,
        // which is linear, and it fires exactly when the two disagree: a file whose name the index
        // does not predict. On a workspace of five thousand that turned the load into twenty-five
        // million comparisons - forty seconds of them - while a hundred functions never noticed.
        // Measured on a generated org, which is the only place a cliff like that shows up before a
        // user finds it.
        const row = byPath.get(dg) || byId.get(String(meta.id));
        if (!row) return;
        row.downloaded = true;
        row.stale = (meta.sv || 0) < META_SV;
        row.updatedTime = meta.updatedTime || null;
        row.namespace = meta.nameSpace || row.namespace;
        if (meta.display_name) row.display_name = meta.display_name;
        const known = index.get(String(meta.id));
        if (known) { known.category = meta.category; known.source = meta.source; known.name = meta.name; }
      } catch (_) { /* a meta that will not parse leaves its row as the index described it */ }
    }));
    done += batch.length;
    if (!current()) return;
    // Redrawing after every tranche is what a first version did, and on five thousand rows it cost
    // more than the reading: forty-two redraws of the whole tree, about a second each. The rows are
    // refined in place; the picture catches up four times a second, which is faster than anyone
    // reads a badge. The last redraw happens below, unconditionally, so nothing is left half-drawn.
    const now = Date.now();
    if (now - lastPaint > 250 && viewMode === 'functions') { renderTree(); lastPaint = now; }
    if (done < metaPathsToRead.length) setStatus(`${treeData.length} functions - reading details ${done}/${metaPathsToRead.length}\u2026`, 'busy');
    await new Promise((r) => setTimeout(r, 0));   // let the panel answer whatever the reader is doing
  }
  if (!current()) return;
  renderTree(); updateMissingButton(); attachFnStats();
  if (stale_summary) await saveMetaIndex(metaPaths);
  const dl = treeData.filter((e) => e.downloaded).length;
  setStatus(`${treeData.length} functions (${dl} downloaded).`, 'ok');
  await refreshContext();
}

/** Write the summary the load above reads. Built from the rows in memory, which have just been
 *  brought up to date, so it costs no reading - and it is written at the end of the load rather than
 *  at the end of each pull, because every pull ends by rebuilding the tree. One hook instead of
 *  three, and no path where a pull updates the mirror and forgets the summary.
 *
 *  A failure here is not worth a message: the summary is a cache, the next load simply reads the
 *  metas again. What would be worth a message is the panel appearing to work while the mirror is
 *  wrong, which is why nothing else depends on this file. */
/** The one writer of `functions/meta-index.json`.
 *
 *  Two producers put facts in this file - what a `.meta.json` says, and what a `.dg` says - and both
 *  did read-modify-write on it. That is the oldest race there is: each reads version X, each merges
 *  its own half into X, and whoever writes second restores the fields the other had just changed.
 *  Proved rather than argued: marking a function stale and running the two savers together left the
 *  file saying it was fresh, because the graph writer's merge base predated the mark - and it does
 *  not even write that field.
 *
 *  So the file has one writer and two producers. A mutator is queued behind whatever is already in
 *  flight, and the read happens *inside* the queue, so every merge base is the file as it stands.
 *  No lock, no version field, no retry: a promise chain is enough because the contention is between
 *  two known callers in one document, not between processes.
 */
let _metaIndexWrites = Promise.resolve();
function updateMetaIndex(mutate) {
  _metaIndexWrites = _metaIndexWrites.then(async () => {
    let files = {};
    try {
      const prev = JSON.parse(await readFile(META_INDEX));
      if (prev && prev.v === SUMMARY_V && prev.files) files = prev.files;
    } catch (_) {}
    await mutate(files);
    await writeFile(META_INDEX, JSON.stringify({ v: SUMMARY_V, sv: META_SV, files }, null, 2));
  }).catch(() => {});   // a summary that cannot be written is a cache that will be rebuilt, not a failure
  return _metaIndexWrites;
}

async function saveMetaIndex(metaPaths) {
  const onDisk = new Set(metaPaths.map((p) => p.replace(/\.meta\.json$/, '.dg')));
  await updateMetaIndex((files) => {
    Object.keys(files).forEach((k) => { if (!onDisk.has(k)) delete files[k]; });   // sparito dal disco
    treeData.forEach((r) => {
      if (!onDisk.has(r.path)) return;
      const e = files[r.path] || (files[r.path] = {});
      e.id = String(r.id); e.sv = r.stale ? 1 : META_SV; e.updatedTime = r.updatedTime || null;
      e.namespace = r.namespace || ''; e.display_name = r.display_name || '';
    });
  });
  // Only the metas this pass actually described, and only the meta half: the source-derived facts
  // belong to `saveGraphFacts()` and are not this writer's to declare done.
  metaPaths.forEach((mp) => _dirtyMeta.delete(mp.replace(/\.meta\.json$/, '.dg')));
}

// The tree is built from .meta.json alone; the stats need the sources. Fill them in after the first
// render instead of blocking it - the graph gets built anyway the moment a function is opened.
// Above this many functions the badges wait to be asked for. Measured on a generated org: building
// the call graph reads every source - 40,000 file-system calls on five thousand functions - and it
// used to happen on every open, for two numbers in a badge nobody had asked to see. It still happens
// the moment anything actually needs the graph: the diagram, the audit, the assistant, a search
// through the sources. What is refused here is doing it *speculatively* on a workspace where it is
// expensive.
const STATS_LIMIT = 1200;

async function attachFnStats() {
  if (treeData.length > STATS_LIMIT && !graphCache) {
    // Said rather than left to be noticed: a missing badge with no explanation reads as a defect.
    setStatus(`${treeData.length} functions - size and call counts appear when the diagram, the audit or a code search builds the map.`, 'ok');
    return;
  }
  try {
    const g = await ensureGraph();
    const byFile = {}; Object.values(g.nodes).forEach((n) => { if (n.file) byFile[n.file] = n.stats; });
    let any = false;
    treeData.forEach((e) => { const s = byFile[e.path]; if (s) { e.stats = s; any = true; } });
    if (any && viewMode === 'functions') renderTree();
  } catch (_) {}   // stats are an enrichment: if the graph cannot be built, the tree still works
}

// ---------- function statistics ----------
// Derived from the source we already hold in memory, never written to disk: a stored copy could
// disagree with the .dg next to it, and would cost a schema bump plus a re-pull of every function
// for a number that is free to recompute.
//
// These are counts, not a score. Length measures verbosity, not complexity, and the call counts say
// how much a function talks to the outside - how to read that is the reader's call, not ours.
// Zoho's own list of Deluge integration namespaces: zoho.com/deluge/help/integration-tasks.html
const ZOHO_SERVICES = 'crm|creator|books|invoice|inventory|billing|subscriptions|desk|projects|people|recruit|mail|calendar|sheet|writer|cliq|connect|sign|analytics|bookings|salesiq|workdrive|map|notebook';
const RE_ZOHO_ANY = new RegExp('\\bzoho\\.(?:' + ZOHO_SERVICES + ')\\.\\w+', 'gi');
const RE_ZOHO_CRM = /\bzoho\.crm\.\w+/gi;
const RE_INVOKEURL = /\binvokeurl\b/gi;
const RE_SENDMAIL = /\bsendmail\b/gi;
// Comments and string literals are removed before any of these are counted, by the one reader that
// does it - `stripNonCode()` in graph-core.js, which the call extractor uses too. Two readers of the
// same thing is the shape this repository has been bitten by; this used to be two.
const _count = (s, re) => { const m = s.match(re); return m ? m.length : 0; };
function fnStats(src) {
  const code = String(src || '');
  const bare = stripNonCode(code);
  const crm = _count(bare, RE_ZOHO_CRM);
  const zohoAny = _count(bare, RE_ZOHO_ANY);
  const invokeurl = _count(bare, RE_INVOKEURL);
  return {
    lines: code ? code.split('\n').length : 0,
    codeLines: bare.split('\n').filter((l) => l.trim() !== '').length,
    chars: code.length,
    invokeurl, sendmail: _count(bare, RE_SENDMAIL),
    crm, zoho: zohoAny - crm,          // other Zoho services
    apiCalls: invokeurl + zohoAny,     // outbound calls; each one is work Zoho meters
  };
}

// ---------- graph cache ----------
// What the diagram window is given, which is less than what the panel holds. `source_code` is put
// back onto the graph nodes by loadGraph() for the assistant and the Markdown export - both of which
// read it from memory - and the window has never touched it: it draws names, kinds and arrows. So it
// is stripped here rather than shipped and forgotten, because the payload crosses into storage and
// what crosses a boundary is what has to be justified.
//
// And it goes to `chrome.storage.session`: this is a hand-off to a window opening in a moment, not a
// setting. Session storage is memory - it goes when the browser does, instead of a copy of the org's
// structure resting on disk until the next diagram replaces it.
function graphForWindow(g) {
  const out = Object.assign({}, g, { nodes: {} });
  for (const [id, n] of Object.entries(g.nodes || {})) {
    const copy = Object.assign({}, n);
    delete copy.source_code;
    out.nodes[id] = copy;
  }
  return out;
}

/** The call graph, from what was written down when the sources were last read.
 *
 *  It used to read every `.dg` and every `.meta.json` - two files per function, 40,000 file-system
 *  calls on an org of five thousand - and parse the sources again each time. What the parse produces
 *  per function is now kept in `functions/meta-index.json`: the references the parser saw and the
 *  size counts. Both are *readings* of one file, so they age exactly when that file changes - and
 *  what detects that is **not** the folder walk, which sees paths appearing and disappearing and
 *  nothing about the bytes behind them. This comment used to claim the walk was enough; a review
 *  asked for the proof, the first test written for it failed, and the answer is `_dirtySource`:
 *  every write this panel makes marks the file it touched, and ↻ Refresh marks all of them for the
 *  writes it cannot see. The resolution of a reference into an edge still happens on every build,
 *  because it depends on the whole workspace.
 *
 *  A source the summary does not describe is read and parsed as before, and the summary is brought
 *  up to date afterwards. So a hand-pulled function, an older mirror or a file somebody dropped in
 *  all produce the same graph as a full read - proven in the suite by building it both ways.
 */
async function loadGraph() {
  const nodes = [];
  const dirtySrc = new Set(_dirtySource);   // snapshot, as the tree load does
  let summary = null;
  try { summary = JSON.parse(await readFile(META_INDEX)); } catch (_) {}
  const known = (summary && summary.v === SUMMARY_V && summary.files) ? summary.files : {};
  let read = 0;
  for await (const p of walk(dir)) {
    if (!p.endsWith('.dg')) continue;
    const cached = dirtySrc.has(p) ? null : known[p];
    if (cached && Array.isArray(cached.refs) && cached.stats) {
      nodes.push({ namespace: cached.namespace || p.split('/')[0],
                   name: cached.name || p.split('/').pop().replace(/\.dg$/, ''),
                   api_name: cached.api_name || p.split('/').pop().replace(/\.dg$/, ''),
                   display_name: cached.display_name, category: cached.category, source: cached.source,
                   description: cached.description || '', rest: !!cached.rest,
                   associated_place: cached.associated_place || null, file: p,
                   return_type: cached.return_type || '', params: cached.params || [],
                   connections: cached.connections || [], updatedTime: cached.updatedTime || null,
                   modified_by: cached.modified_by || null,
                   refs: cached.refs, stats: cached.stats,
                   _modules: Array.isArray(cached.modules) ? { modules: cached.modules, unknown: cached.modulesUnknown || 0 } : null,
                   dg: '' });
      continue;
    }
    read++;
    const dg = await readFile(p); let meta = {}; try { meta = JSON.parse(await readFile(p.replace(/\.dg$/, '.meta.json'))); } catch {}
    nodes.push({ namespace: meta.nameSpace || p.split('/')[0], name: meta.name || p.split('/').pop().replace(/\.dg$/, ''), api_name: meta.api_name, category: meta.category, source: meta.source, display_name: meta.display_name, description: meta.description || '', rest: (meta.rest_api || []).some((r) => r.active), associated_place: meta.associated_place || null, return_type: meta.return_type, params: meta.params || [], connections: meta.connections || [], modified_by: meta.modified_by || null, updatedTime: meta.updatedTime || null, dg, stats: fnStats(dg), file: p });
  }
  const g = window.buildGraph(nodes.map((n) => (n.refs ? { ...n, _refs: n.refs, _modules: n._modules } : n)));
  // What the parser saw, written down for the next build. Only when something had to be read: a
  // graph built entirely from the summary has nothing new to say, and rewriting the file on every
  // open would touch a folder the reader may have under version control.
  if (read) await saveGraphFacts(nodes, g);
  nodes.forEach((nd) => { const id = nd.namespace + '.' + nd.name; if (g.nodes[id]) { g.nodes[id].return_type = nd.return_type; g.nodes[id].params = nd.params; g.nodes[id].source_code = nd.dg; g.nodes[id].connections = nd.connections; g.nodes[id].modified_by = nd.modified_by; g.nodes[id].updatedTime = nd.updatedTime; // The counts come from the source when it was read, and from the summary when it was not -
  // the same numbers either way, since `fnStats()` is a pure reading of that text and what the
  // summary holds is the result of having run it.
  g.nodes[id].stats = nd.stats || fnStats(nd.dg); } });
  g.workspace = { instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null, label: bound?.label || null };
  return g;
}
/** Keep, per function, exactly what a source read produced: the references the parser found and the
 *  size counts. Everything else in the graph is computed from those two and from the workspace as a
 *  whole, so nothing here is a stored judgement - only a stored reading. */
async function saveGraphFacts(nodes, g) {
  await updateMetaIndex((files) => {
    nodes.forEach((nd) => {
      if (!nd.file) return;
      const node = g.nodes[nd.namespace + '.' + nd.name];
      const entry = files[nd.file] || (files[nd.file] = {});
      entry.namespace = nd.namespace; entry.name = nd.name; entry.api_name = nd.api_name;
      entry.display_name = nd.display_name; entry.category = nd.category; entry.source = nd.source;
      entry.rest = !!nd.rest; entry.associated_place = nd.associated_place || null;
      entry.return_type = nd.return_type || ''; entry.params = nd.params || [];
      entry.connections = nd.connections || []; entry.modified_by = nd.modified_by || null;
      entry.description = nd.description || '';
      entry.refs = (node && node.refs) ? node.refs : (nd.refs || []);
      // The module candidates, beside the references and for the same reason: a reading of one
      // source, never a resolution against the workspace.
      entry.modules = (node && node.modules) ? node.modules : (nd.modules || []);
      entry.modulesUnknown = (node && node.modulesUnknown) || 0;
      entry.stats = nd.stats || (node && node.stats) || null;
      // `sv` and `updatedTime` belong to the meta writer: this one has read a `.dg`, which says
      // nothing about either. Writing them here is how a merge base becomes a lost update.
    });
  });
  // The sources this pass read are now described, and only those - a file rewritten while this
  // build was walking the folder keeps its mark and is read by the next one.
  nodes.forEach((nd) => { if (nd.file) _dirtySource.delete(nd.file); });
}
async function ensureGraph() { if (!graphCache) graphCache = await loadGraph(); return graphCache; }
function makeCallResolver(g) {
  const nodes = g.nodes || {}, byName = {};
  Object.values(nodes).forEach((n) => { (byName[n.name] ||= []).push(n); });
  return (ns, name) => {
    const exact = nodes[ns + '.' + name];
    if (exact) return { file: exact.file, label: exact.display_name || exact.name };
    const hits = byName[name] || [];
    if (hits.length === 1) return { file: hits[0].file, label: hits[0].display_name || hits[0].name };
    return null;   // ambiguous / unresolved -> not linked
  };
}

// ---------- preview ----------
// The preview header, written in one place so the five tabs cannot say different things.
//
// Reported: selecting a function showed `functions/<namespace>/<name>.dg` in a 400px header, so the
// ellipsis ate the file name - the one part worth reading - and left the folder. And no other tab
// named a file at all, which reads as five products rather than five tabs. So: the item's own name,
// then the file, then the whole workspace-relative path in the tooltip, which is where a long string
// belongs.
//
// Schedules and connections carry a synthetic path (`schedules/<id>`, `connections/<name>`): there is
// no such file, they are rows inside one index. Naming a file that is not there would be worse than
// naming none, so those name the file that does hold them and say what they are inside it.
function pvFileOf(path) {
  if (!path) return null;
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  if (/\.[a-z0-9]+$/i.test(last)) return { name: last, title: path };
  return { name: 'index.json', title: `${parts.slice(0, -1).join('/')}/index.json - one row inside it` };
}
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
    setStatus(MSG.copyFailed + friendlyError(e), 'warn');
  }
}
function setPvName(label, path) {
  navLabel(label);   // the chain shows what the header shows - one name, decided in one place
  const f = pvFileOf(path);
  // A function's name *is* its file name, so printing both would say it twice. Derived from the two
  // strings rather than decided per tab, which is how the tabs drifted apart in the first place.
  const same = !!f && label === f.name;
  $('pvname').textContent = label;
  $('pvname').title = same ? f.title : label;
  $('pvfile').textContent = f && !same ? f.name : '';
  $('pvfile').title = f && !same ? f.title : '';
}

// The list follows whatever the preview is showing. Marking the row was already here; what was
// missing is everything a reader needs for that mark to *mean* anything - it was reported as the
// selection staying uncoordinated after jumping from one function to another through a call in the
// code.
//
// Three things, and each was its own small lie: a group closed over the target stays closed and the
// row does not exist to be marked, so the tree shows nothing selected; a row far down the list is
// marked where nobody can see it; and the keyboard went on stepping from where *it* had been, so
// the next arrow jumped back to the previous function.
function syncTreeTo(path) {
  const e = treeData.find((x) => x.path === path);
  // `ns`, spelled the way the tree spells it: `collapsed` is shared with the modules list, which
  // prefixes its keys, and a test holds that difference. Same key, same name for it.
  const ns = e && e.namespace;
  if (ns && treeSort === 'name' && collapsed.has(ns)) {
    collapsed.delete(ns);                 // opened, because you asked to look at what is inside it
    renderTree();
  }
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
  stepAnchor = path;                      // the arrows carry on from what you are looking at
  const row = [...$('tree').querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === path);
  revealRow(row, $('tree'), '.grp');
}

function openFromTree(path) { openFile(path); }
async function openFile(path, line = null) {
  if (!(await ensurePerm(dir))) { setStatus('File access denied - click Refresh to grant.', 'bad'); return; }
  // The `push` flag is gone with the back stack it fed: whether a step is remembered is no longer
  // something each caller decides - every arrival is a step, which is what made the old one useless
  // the moment the reader changed tab.
  currentPath = path; navHere(path.split('/').pop()); if ($('status').className) setStatus('', '');
  $('pvreveal').style.display = 'none';   // "Go to" (auto-open in the editor) removed: it drove Zoho's localized DOM. Find is the deterministic way in.
  $('pvfind').style.display = ''; $('pvfind').textContent = 'Find in Zoho \u2197'; $('pvfind').title = 'Filter the Zoho functions list to this function - then open it from Zoho\'s own \u22ef menu (Edit / Delete / Duplicate\u2026)'; $('pvtable').style.display = 'none';
  syncTreeTo(path);
  const trow = treeData.find((x) => x.path === path);
  if (trow) navNames({ display: trow.display_name, api: trow.api_name });
  setPvName(path.split('/').pop(), path); $('pvcallers').className = ''; $('pvcallers').textContent = '';
  pvTabsFor('function');
  let code; try { code = await readFile(path); } catch (e) { setStatus(MSG.readFailed + e.message, 'bad'); return; }
  const lines = code.split('\n').length;
  $('pvgutter').textContent = Array.from({ length: lines }, (_, k) => k + 1).join('\n');
  const _g = await ensureGraph().catch(() => null);
  const _resolve = _g ? makeCallResolver(_g) : null;
  // The module named inside a call is a link too, on the same principle as the call itself: a name
  // that identifies something this panel can show is hypertext. Resolved against the module index,
  // so a string that merely looks like a module stays a string.
  const _known = await moduleNames().catch(() => new Map());
  // A related-list name identifies the module at the *other* end of the relation - which is what
  // the reader means by it - so it is resolved inside its parent module's own catalogue of related
  // lists, where Zoost already holds `api_name` beside the module it points at. The same name can
  // exist on two modules, which is why the parent is part of the question and not a guess.
  const _mfiles = await loadModuleFiles().catch(() => ({}));
  const _linkFor = (name, kind, parent) => {
    if (kind === 'mod') return _known.has(name) ? name : null;
    const p = parent && _mfiles[parent];
    const rl = p && (p.related_lists || []).find((r) => (r.api_name || '') === name);
    const target = rl && (rl.module || rl.connected_module);
    return target && _known.has(target) ? target : null;
  };
  $('pvcode').innerHTML = window.highlightDeluge
    ? window.highlightDeluge(code, _resolve, _linkFor)
    : escHtml(code);
  $('pvcode').querySelectorAll('a.c-link[data-file]').forEach((a) => { a.onclick = () => openFile(a.dataset.file); });
  $('pvcode').querySelectorAll('a.c-link[data-mod]').forEach((a) => { a.onclick = () => healthOpenModule(a.dataset.mod); });
  showPreview();
  if (line) { const lh = parseFloat(getComputedStyle($('pvcode')).lineHeight) || 16; $('pvbody').scrollTop = Math.max(0, (line - 3) * lh); }
  showCallers(path);
}
/** Two tabs rather than one long column, for the two kinds of item whose detail is crowded.
 *
 *  The first tab is *the thing you opened the item for* - the source of a function, the fields of a
 *  module - and the second is everything else, which is what had grown to seven blocks stacked above
 *  a 400px-wide pane. The first tab is therefore also the default, and the choice is not remembered:
 *  it is one click, and a remembered mode that opens on Details would hide what you came for.
 *
 *  Which panes belong to which tab is declared here rather than assigned at each opener, because the
 *  strip is one control and an opener that forgot half of it is how the module detail ended up
 *  showing a function's tabs. */
let pvTab = 'code', pvKind = null;
const PV_KINDS = {
  function: { first: 'Code', panes: { code: [['pvbody', 'flex']], info: [['pvcallers', '']] } },
  // `pvcallers` is on both kinds now: on a function it is what calls it, on a module it is what
  // reads and writes it. Same pane, same question - what relates to the thing on screen.
  module: { first: 'Fields', panes: { code: [['pvfields', '']], info: [['pvdetails', ''], ['pvcallers', '']] } },
};
function setPvTab(which) {
  pvTab = which === 'info' ? 'info' : 'code';
  $('pvtab_code').classList.toggle('active', pvTab === 'code');
  $('pvtab_info').classList.toggle('active', pvTab === 'info');
  // The copy control belongs to the pane that holds code, so it follows the strip like every other
  // pane rather than being switched on by the opener: set there, it stayed lit on «Details» and on a
  // module, where there is no code at all - visible in a picture published on the site. It is the
  // defect the comment above `PV_KINDS` describes, made once more by the same route.
  $('codecopy').style.display = (pvKind === 'function' && pvTab === 'code') ? '' : 'none';
  const k = PV_KINDS[pvKind]; if (!k) return;
  Object.entries(k.panes).forEach(([tab, panes]) => panes.forEach(([id, shown]) => {
    const el = $(id); if (el) el.style.display = tab === pvTab ? shown : 'none';
  }));
}
/** Showing the strip resets it to the first tab - opening a second item and landing on the tab the
 *  previous one was left on is the stale-projection problem in miniature. Called with anything else
 *  (a workflow, a schedule, a connection) it takes the strip away: those have one pane and no
 *  choice to make. `openModule` not calling it at all is what let a module show `Code | Details`. */
function pvTabsFor(kind) {
  pvKind = PV_KINDS[kind] ? kind : null;
  $('pvtabs').hidden = !pvKind;
  if (!pvKind) $('codecopy').style.display = 'none';   // a workflow, a schedule, a connection: no code
  $('pvtabsr').innerHTML = '';        // the diagram control belongs to the item being left
  if (pvKind) { $('pvtab_code').textContent = PV_KINDS[pvKind].first; setPvTab('code'); }
  else { $('pvcallers').style.display = ''; }
}

/** The modules this org actually has, by api_name, read once per workspace.
 *
 *  A module *candidate* out of a source becomes a fact only here: `graph-core` reads names out of
 *  the text and knows nothing about which of them exist, so a COQL query selecting from a word that
 *  is not a module of this org says nothing rather than drawing a box. Measured on two production
 *  orgs before this was written: three and four such names each, every one correctly refused.
 */
let modNamesCache = null;
async function moduleNames() {
  if (modNamesCache) return modNamesCache;
  let idx = []; try { idx = JSON.parse(await readFile('modules/index.json')); } catch (_) {}
  const list = Array.isArray(idx) ? idx : (idx && idx.modules) || [];
  const m = new Map();
  list.forEach((x) => { const a = x.api_name || x.module_name || x.name; if (a) m.set(a, x); });
  modNamesCache = m; return m;
}

/** What this function does to the modules of this org: read, written, or reached by a url whose
 *  method we have not looked at. Sorted, deduplicated, and with the count of the calls whose module
 *  is computed at run time - which is shown rather than dropped, because the answer is a lower
 *  bound and a reader deciding whether a field is safe to change has to be told so. */
async function modulesOf(node) {
  const known = await moduleNames();
  const out = { read: [], write: [], touch: [], unknown: (node && node.modulesUnknown) || 0 };
  for (const m of (node && node.modules) || []) {
    if (!known.has(m.name)) continue;
    const b = out[m.mode] || out.touch;
    if (!b.includes(m.name)) b.push(m.name);
  }
  // A module both read and written is a write as far as «is this safe to change» goes, but both
  // facts are true and the panel shows both - interpreting them is the reader's business.
  ['read', 'write', 'touch'].forEach((k) => out[k].sort());
  return out;
}
/** Which functions read this module, and which write it - the reading turned round.
 *
 *  This is the question the platform cannot answer at all: Zoho will show you a module's fields and
 *  its layouts, and nothing that says «this Deluge writes here». It fills the same pane a function's
 *  callers use, because it is the same kind of fact - what relates to the thing on screen - and it
 *  is drawn after the pane rather than blocking it, since it needs the call graph.
 *
 *  It is a lower bound and says so. A call whose module is computed at run time cannot be attributed
 *  to any module, so «nothing writes here» is «nothing that could be read», and the line under the
 *  lists carries that instead of leaving the reader to assume otherwise.
 */
async function showModuleUsage(api) {
  const box = $('pvcallers'); box.textContent = 'reading what the code does with it\u2026'; box.className = 'show';
  try {
    const g = await ensureGraph();
    if (!currentPath || !currentPath.startsWith('modules/')) return;
    const read = [], write = [], touch = [];
    let blind = 0;
    for (const n of Object.values(g.nodes)) {
      if (!n.file) continue;
      blind += n.modulesUnknown || 0;
      for (const m of n.modules || []) {
        if (m.name !== api) continue;
        const b = m.mode === 'write' ? write : m.mode === 'read' ? read : touch;
        if (!b.some((x) => x.id === n.id)) b.push(n);
      }
    }
    const nm = (n) => nameMode === 'display' ? (n.display_name || n.name) : (n.api_name || n.name);
    const chips = (list) => '<div class="fnchips">' + list
      .sort((a, b) => nm(a).localeCompare(nm(b)))
      .map((n) => `<a class="wf-fn" data-file="${escA(n.file)}" title="${escA(n.namespace + '.' + n.name)}">\u0192 ${escHtml(nm(n))}</a>`)
      .join('') + '</div>';
    let html = '';
    if (read.length) html += `<b>Read by (${read.length}):</b>${chips(read)}`;
    if (write.length) html += `<b>Written by (${write.length}):</b>${chips(write)}`;
    if (touch.length) html += `<b>Reached by URL from (${touch.length}):</b>${chips(touch)}`;
    if (!html) html = '<b>No function reads or writes it</b> - as far as the code can be read';
    html += `<div class="modline">From the module names written in your Deluge`
      + (blind ? ` \u00b7 ${blind} call(s) across the org name the module in a variable and cannot be attributed` : '')
      + '</div>';
    box.innerHTML = html;
    box.querySelectorAll('a[data-file]').forEach((a) => (a.onclick = () => openFile(a.dataset.file)));
  } catch (_) { box.className = ''; }
}
async function showCallers(path) {
  const box = $('pvcallers'); box.textContent = 'computing references…'; box.className = 'show';
  try {
    const g = await ensureGraph(); if (currentPath !== path) return;
    const node = Object.values(g.nodes).find((n) => n.file === path); if (!node) { box.className = ''; return; }
    const callers = node.called_by;
    const nm = (id) => nameMode === 'display' ? (g.nodes[id].display_name || g.nodes[id].name) : (g.nodes[id].api_name || g.nodes[id].name);
    // Chips, not a sentence. A comma-separated list of seven names reads as prose while the reader
    // is scanning for one of them, and this panel already has a shape for «a link to a function» -
    // the `.wf-fn` chip that workflows, schedules and connections use. Asked for by name: the same
    // layout for every function link. Not inside the code pane, where a chip would deform the line
    // it sits in; there a call stays an inline link.
    let html = callers.length
      ? `<b>Called by (${callers.length}):</b><div class="fnchips">`
        + callers.map((id) => `<a class="wf-fn" data-file="${escA(g.nodes[id].file)}" title="${escA(g.nodes[id].display_name || g.nodes[id].name || '')}">\u0192 ${escHtml(nm(id))}</a>`).join('')
        + '</div>'
      : '<b>Called by</b> - none';
    const ap = node.associated_place || [];
    if (ap.length) {
      const byType = {};
      // The whole entry is kept, not just its name: the id is what makes the name a link.
      ap.forEach((p) => (byType[p._type || 'other'] ||= []).push(p));
      // The names of the things that fire this function are links when this panel has somewhere to
      // take you: a workflow rule opens in the Workflows tab, a schedule in Schedules. `HEALTH_OPEN`
      // already maps a kind to its opener - it exists so that a group naming a new kind gets one
      // rather than silently rendering an unclickable name - and this is that map used a second
      // time. A kind with no opener stays plain, because a link that leads nowhere is worse.
      html += '<div class="apwrap">' + Object.keys(byType).sort().map((t) => `<b>Used in ${escHtml(t)} (${byType[t].length}):</b> ${byType[t].map((p) => apLink(t, p)).join(', ')}`).join('<br>') + '</div>';
    } else if (!callers.length && !node.rest) {
      html += ' <span class="orphan">\u00b7 no known usage (orphan candidate)</span>';
    }
    // What Zoho says about this function at runtime, next to what the mirror says about it
    // statically. Nothing is inferred: if it is not in the last reading, nothing is shown - «no
    // failures recorded» would be a claim about a measurement that may never have been taken.
    try {
      const fx = await failuresIndex();
      // Zoho reports the display name; the mirror knows three names for the same function and which
      // one matches is not ours to assume. Try them all rather than picking one and finding nothing.
      const mine = [node.display_name, node.name, node.api_name]
        .map((k) => fx.byName.get(String(k || '').toLowerCase())).find((v) => v && v.length) || [];
      if (mine.length) {
        const total = mine.reduce((n, f) => n + (f.count || 0), 0);
        const last = mine.map((f) => f.lastFailedAt).filter(Boolean).sort().pop();
        html += `<div class="failwrap"><b>Failing in Zoho:</b> ${escHtml(String(total))}\u00d7`
          + (last ? ` \u00b7 last ${escHtml(fmtDate(last))}` : '')
          + ` \u00b7 as read on ${escHtml(fmtDate(fx.at))}`
          // One line per distinct reason. Zoho returns a row per failing invocation, so a function
          // that broke the same way twice came back with the same sentence printed twice - which
          // reads as two problems and is one. The count above already says how many times.
          + [...new Map(mine.map((f) => [`${f.componentType}|${f.reason}`, f])).values()]
              .map((f) => `<div class="failrow">${escHtml(f.componentType || '?')} \u00b7 ${escHtml(f.reason || '')}</div>`).join('')
          + '</div>';
      }
    } catch (_) { /* no reading yet: say nothing rather than claim none */ }
    // Which modules this function touches, and how. The nearest sibling on this pane is the
    // connections row - a set of things outside the function that it reaches - so it is built the
    // same way, and the chips carry the module's api_name because that is what the code wrote.
    const mods = await modulesOf(node);
    if (mods.read.length || mods.write.length || mods.touch.length || mods.unknown) {
      const chips = (names, kind) => names.map((n) =>
        `<span class="mod ${kind}" data-mod="${escA(n)}" title="${escA(n + ' - click to open the module')}">${escHtml(n)}</span>`).join(' ');
      html += '<div class="modwrap">';
      if (mods.read.length) html += `<b>Reads (${mods.read.length}):</b> ${chips(mods.read, 'r')}<br>`;
      if (mods.write.length) html += `<b>Writes (${mods.write.length}):</b> ${chips(mods.write, 'w')}<br>`;
      if (mods.touch.length) html += `<b>Reached by URL (${mods.touch.length}):</b> ${chips(mods.touch, 't')}<br>`;
      // Never folded into the counts above: a number that quietly excludes what it could not read
      // is the kind of half-answer this panel exists to refuse.
      if (mods.unknown) html += `<span class="orphan">${mods.unknown} call(s) name the module in a variable - not determinable</span>`;
      html += '</div>';
    }
    const conns = node.connections || [];
    if (conns.length) {
      html += '<div class="connwrap"><b>Connections (' + conns.length + '):</b> '
        + conns.map((c) => `<span class="conn" data-conn="${escA(c.name)}" title="${escA((c.label || c.name) + (c.service ? ' \u00b7 ' + c.service : '') + ' - click to list every function that uses it')}">${escHtml(c.name)}</span>`).join(' ')
        + '</div>';
    }
    const st = node.stats;
    if (st) {
      const parts = [];
      if (st.invokeurl) parts.push(`${st.invokeurl} invokeurl`);
      if (st.crm) parts.push(`${st.crm} zoho.crm`);
      if (st.zoho) parts.push(`${st.zoho} other Zoho`);
      if (st.sendmail) parts.push(`${st.sendmail} sendmail`);
      // The caveat about what these counts mean lives in the Health audit's "Size & calls" tab and in
      // the docs: worth stating once where there is room, not on every preview in a 400px panel.
      html += `<div class="statline"><b>Size:</b> ${st.lines} lines (${st.codeLines} code) \u00b7 ${(st.chars / 1024).toFixed(1)} KB`
        + ` &nbsp;\u00b7&nbsp; <b>Outbound calls:</b> ${st.apiCalls ? escHtml(parts.join(', ')) : 'none'}</div>`;
    }
    const modBits = [];
    if (node.modified_by) modBits.push('by ' + escHtml(node.modified_by));
    if (node.updatedTime) modBits.push(escHtml(String(node.updatedTime).slice(0, 16)));
    if (modBits.length) html += `<div class="modline">Last modified ${modBits.join(' \u00b7 ')}</div>`;
    box.innerHTML = html;
    box.querySelectorAll('a[data-file]').forEach((a) => (a.onclick = () => openFile(a.dataset.file)));
    box.querySelectorAll('.conn[data-conn]').forEach((c) => (c.onclick = () => filterByConnection(c.dataset.conn)));
    // A module chip opens the module, the way a function chip opens the function. It is the whole
    // point of the reading: the two halves of the mirror are one click apart instead of two lists.
    box.querySelectorAll('.mod[data-mod]').forEach((c) => (c.onclick = () => healthOpenModule(c.dataset.mod)));
    // «Used in …»: the rule or the schedule that fires this function, opened where it lives.
    box.querySelectorAll('a.aplink[data-ap]').forEach((a) => (a.onclick = () => {
      const open = HEALTH_OPEN[a.dataset.ap];
      if (open) open(a.dataset.apid, a.dataset.apname);
    }));
    // The same control the Modules preview carries, next to the same kind of fact: the references
    // are listed above it, this draws them. Absent when there is nothing to draw - a function
    // nobody calls and that calls nothing is a single box and no arrows.
    //
    // It sits on the tab strip rather than inside Details, and that is the rule the diagram window
    // already learnt about its focus: a control that acts on the item belongs to the item's chrome,
    // not to one of the views of it. Behind the second tab it was unreachable from Code - the tab
    // people open a function for. The depth travels with it, or the tooltip would name a control
    // that is on the other tab. The Modules preview keeps its own bar, because that detail has no
    // strip to move to and nothing is hiding it.
    const slot = $('pvtabsr'); slot.innerHTML = '';
    if (callers.length || (node.calls || []).length) {
      slot.innerHTML = `depth <select id="calldepth"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select><button id="callopen" class="laylocal icon" aria-label="Wiring" title="Wiring - opened on this function at the depth chosen here, in its own window"><svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5" rx="1"/><rect x="9" y="9" width="5.5" height="5" rx="1"/><path d="M7 4h3.5a1.2 1.2 0 0 1 1.2 1.2V9"/></svg></button>`;
      slot.querySelector('#callopen').onclick = () => openCallFocus(node.namespace + '.' + node.name, parseInt(slot.querySelector('#calldepth').value, 10) || 2);
    }
  } catch { box.className = ''; }
}

// Closing the pane does not forget where you have been - reopening anything continues the same
// chain, the way shutting a window does not clear a browser's history. Only leaving the workspace
// does, below, because there the steps would point at another org's files.
$('pvx').onclick = () => { $('preview').classList.remove('show'); $('resizer').classList.remove('show'); currentPath = null; updateNav(); };

// resizable split
let dragY = false;
$('resizer').addEventListener('mousedown', () => { dragY = true; document.body.style.userSelect = 'none'; });
window.addEventListener('mousemove', (e) => {
  if (!dragY) return; const r = $('main').getBoundingClientRect();
  let h = Math.max(120, Math.min(r.height - 80, r.bottom - e.clientY)); $('preview').style.height = h + 'px';
});
window.addEventListener('mouseup', () => { if (dragY) { dragY = false; document.body.style.userSelect = ''; chrome.storage.local.set({ previewH: $('preview').style.height }); } });

// ---------- reveal (auto-navigate to Functions page, then filter) ----------
function functionsUrl() {
  const base = bound?.base || lastCtx?.origin; const inst = bound?.instance || lastCtx?.instance;
  return base && inst ? `${base}/crm/${inst}/settings/functions/myFunctions` : null;
}
/** «Go to Zoho CRM» is about the platform, not about this workspace's org - and it was
 *  `${base}/crm/${instance}/`, which is a claim about which org you will land in. Reported: log out
 *  of one org to sign into another and the button takes you back to the one you just left.
 *  `ShowHomePage.do` is the account's own CRM home and resolves to whatever org the session has.
 *
 *  The host is still derived from what is known - the open workspace first, then the tab - because a
 *  data centre is a property of the account and logging out does not move it. The setting is only
 *  consulted when neither exists, which is a fresh install with nothing pulled: there the old code
 *  guessed `crm.zoho.com`, and a guess about somebody else's data centre is wrong five times out of
 *  six. */
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
  .filter((h) => h.startsWith('https://crm.'))
  .map((h) => h.slice('https://crm.'.length).replace(/\/.*$/, '')))].sort();
const dcOf = (origin) => (String(origin || '').match(/^https:\/\/[^.]+\.(.+)$/) || [])[1] || null;
function renderGoDc() {
  const sel = $('gozohodc'); if (!sel) return;
  const want = sel.dataset.touched ? sel.value
    : (dcOf(bound?.base) || dcOf(lastCtx?.origin) || zohoDc);
  if (sel.options.length !== DCS.length) {
    sel.innerHTML = DCS.map((d) => `<option value="${escA(d)}">${escHtml(d)}</option>`).join('');
  }
  sel.value = DCS.includes(want) ? want : DCS[0];
}
function homeUrl() {
  const dc = ($('gozohodc') && $('gozohodc').value) || dcOf(bound?.base) || dcOf(lastCtx?.origin) || zohoDc;
  // Production, never the sandbox: this is the way *in*, and a sandbox host is a place you arrive at
  // from a workspace that already knows it is one.
  return `https://crm.${dc}/crm/ShowHomePage.do`;
}
async function openZohoHome() {
  if (sampleRefuse()) return;
  const url = homeUrl();
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url, active: true });
}
// Zoho's own page for one automation action. The paths were read off the address bar rather than
// guessed - `settings/alerts/<id>`, `settings/field-updates/<id>`, `settings/tasks/<id>`,
// `settings/webhooks/<id>` - which is the only way this project is allowed to build a URL: a
// certain path or nothing. The webhook one arrived last and was absent until it did, rather than
// being guessed from the pattern of the other three.
const ACTION_PATH = { email_notifications: 'alerts', field_updates: 'field-updates', tasks: 'tasks', webhooks: 'webhooks' };
function actionUrl(a) {
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  const seg = a && ACTION_PATH[a.kind];
  return (base && inst && seg && a.id) ? `${base}/crm/${inst}/settings/${seg}/${a.id}` : null;
}
// The template a notification sends is a page of its own, and the notification only names it -
// so the name is the link. A query string rather than a path, which is Zoho's shape here and not a
// pattern to extrapolate from the other three.
function templateUrl(a) {
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  const id = a && a.template && a.template.id;
  return (base && inst && id) ? `${base}/crm/${inst}/settings/templates?type=email&templateId=${encodeURIComponent(id)}` : null;
}
async function openZohoAt(url, what) {
  if (sampleRefuse()) return;
  if (!url) { setStatus(MSG.noActionTarget, 'warn'); return; }
  const id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url });
  setStatus(`Opened \u00ab${what}\u00bb in Zoho.`, 'ok');
}
async function openActionInZoho(a) { await openZohoAt(actionUrl(a), a.name || a.id); }
async function openModulePage(genName, navigable, label) {
  if (sampleRefuse()) return;
  if (navigable === false) { setStatus(`\u00ab${label || genName}\u00bb has no records tab (linking/subform or no access).`, 'warn'); return; }
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !genName) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  const url = `${base}/crm/${inst}/tab/${genName}`;
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url });
  setStatus(`Opened ${genName} in Zoho.`, 'ok');
}
async function openModuleLayouts(gen) {
  if (sampleRefuse()) return;
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !gen) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  const url = `${base}/crm/${inst}/settings/modules/${gen}/layouts`;
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url });
  setStatus(`Opened ${gen} layouts in Zoho.`, 'ok');
}
async function openModuleLayout(gen, layoutId) {
  if (sampleRefuse()) return;
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !gen) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  const url = layoutId ? `${base}/crm/${inst}/settings/modules/${gen}/layouts/${layoutId}` : `${base}/crm/${inst}/settings/modules/${gen}/layouts`;
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url });
  setStatus(layoutId ? 'Opened the layout in Zoho.' : `Opened ${gen} layouts in Zoho.`, 'ok');
}
function moduleNavigable(m) {
  const gen = m.module_name || '', api = m.api_name || '';
  if (/^LinkingModule\d+$/i.test(gen)) return false;   // junction (many-to-many) modules
  if (/__s$/i.test(api)) return false;                  // system modules (e.g. Approval_Action_Logs__s) have no records tab
  if (['linking', 'subform'].includes(m.generated_type)) return false;
  if (m.viewable === false || m.visible === false || m.api_supported === false) return false;
  return true;
}
async function switchTab() {
  if (sampleRefuse()) return;
  if (!bound || !bound.base || !bound.instance) { setStatus('Unknown target - pull that workspace once from its own tab.', 'warn'); return; }
  const targetHome = `${bound.base}/crm/${bound.instance}/`;
  const curBase = (lastCtx && lastCtx.origin) || bound.base;
  const id = await activeZohoTabId();
  // Same Zoho account (prod <-> sandbox on the same data center) shares an SSO session: just navigate, no logout.
  const dc = (b) => (b || '').replace(/:\/\/(crm|crmsandbox)\./, '://');
  const sameAccount = dc(curBase) === dc(bound.base) && envOf(curBase) !== envOf(bound.base);
  if (sameAccount) {
    if (id) await chrome.tabs.update(id, { url: targetHome, active: true }); else await chrome.tabs.create({ url: targetHome, active: true });
    return;
  }
  // Different account: a clean logout + re-login is required. Confirm first, since it ends the current Zoho session.
  const ok = window.confirm(`Switch to «${bound.instance}» (org ${bound.org})?\n\nThis logs you out of the current Zoho session «${lastCtx?.instance || '?'}» (org ${lastCtx?.org || '?'}) and takes this tab to the login for the target org.`);
  if (!ok) return;
  const accounts = curBase.replace(/:\/\/[^.]+\./, '://accounts.');   // crm./crmsandbox. -> accounts.
  const url = `${accounts}/logout?servicename=ZohoCRM&serviceurl=${encodeURIComponent(targetHome)}`;
  if (id) await chrome.tabs.update(id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
}
async function openTargetZoho(newTab) {
  if (sampleRefuse()) return null;   // null, not undefined: the caller reads it as "no tab id"
  const url = functionsUrl();                       // prefers the ACTIVE workspace's base+instance
  if (!url) { setStatus('Unknown target - pull this workspace once, or open Zoho manually.', 'warn'); return null; }
  if (newTab) { const t = await chrome.tabs.create({ url, active: true }); return t.id; }
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else { const t = await chrome.tabs.create({ url }); id = t.id; }
  return id;
}
$('funcs').onclick = () => openTargetZoho(false);
// Touched by hand, so the next repaint leaves it alone: this control is redrawn on every
// workspace change, and a choice that is reset while you are looking at it is not a choice.
$('gozohodc').onchange = () => { $('gozohodc').dataset.touched = '1'; };
$('gozoho').onclick = () => openZohoHome();
$('mmgo').onclick = () => switchTab();   // mismatch: log out current session and land on the workspace's org (current tab)
async function listReady(id) {
  try { await ensureBridge(id); const r = await chrome.tabs.sendMessage(id, { cmd: 'listReady' }); return !!(r && r.ready); } catch { return false; }
}
let _revealListener = null;
async function listReadyWait(id, tries = 24) { for (let k = 0; k < tries && !(await listReady(id)); k++) await sleep(250); }
// Find = fill the Zoho functions-list search box with this function's name. We wait (bounded, in
// reveal) for the search box to exist - a known, language-independent element - then fill it ONCE.
// If it is not there, we STOP and say exactly that, instead of retrying an action we are not sure of.
async function doFilter(id, fn, nice) {
  await ensureBridge(id);
  if (!(await listReady(id))) { setStatus('Couldn\'t find the Zoho functions search box - is the Functions list open?', 'warn'); return; }
  try {
    const r = await chrome.tabs.sendMessage(id, { cmd: 'fillSearch', name: fn.name || fn.apiName });
    if (r && r.ok) { setStatus(`Filtered "${r.term}\u2026" - open "${nice}" from Zoho\'s \u22ef menu.`, 'ok'); return; }
    setStatus('Couldn\'t fill the Zoho search box.', 'warn');
  } catch (e) { setStatus('Couldn\'t reach the Zoho functions list: ' + e.message, 'warn'); }
}
// Navigate to the Zoho Functions list (deterministic URL) and pre-filter it to `fn` (Find). The
// only DOM touch left is filling the class-selected search box; there is no click-and-hope here.
async function reveal(fn) {
  if (sampleRefuse()) return;
  const nice = fn.displayName || fn.name || fn.apiName;
  let id = await zohoTabId();
  if (!id) { id = await openTargetZoho(false); if (!id) return; }
  if (_revealListener) { chrome.tabs.onUpdated.removeListener(_revealListener); _revealListener = null; }
  const url = functionsUrl();
  let tab = null; try { tab = await chrome.tabs.get(id); } catch (_) {}
  const same = url && tab && (tab.url || '').split('#')[0].split('?')[0] === url.split('#')[0].split('?')[0];
  if (!same) {
    setStatus(MSG.openingFns, 'busy');
    if (url) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.reload(id);
    await sleep(400); await waitTabComplete(id); await listReadyWait(id); await doFilter(id, fn, nice); return;
  }
  // Same URL -> reload the list, but open the target only AFTER a real reload completes.
  // Handles Zoho's native "unsaved changes" dialog: if the user picks "Reload" (even seconds
  // later) we still open the function; if they "Cancel", nothing is forced.
  setStatus(MSG.openingFns, 'busy');
  let sawLoading = false, handled = false;
  const listener = async (tid, info) => {
    if (tid !== id || handled) return;
    if (info.status === 'loading') sawLoading = true;
    if (info.status === 'complete' && sawLoading) {
      handled = true; chrome.tabs.onUpdated.removeListener(listener); _revealListener = null;
      await listReadyWait(id); await doFilter(id, fn, nice);
    }
  };
  _revealListener = listener;
  chrome.tabs.onUpdated.addListener(listener);
  chrome.tabs.reload(id).catch(() => {});
  setTimeout(() => {
    if (!sawLoading && !handled) {
      const msg = 'If you kept unsaved changes, save them and click Go to again.';
      setStatus(msg, 'warn');
      setTimeout(() => { if ($('stxt').textContent === msg) setStatus('', ''); }, 5000);
    }
  }, 3500);
  setTimeout(() => { if (!handled) { handled = true; chrome.tabs.onUpdated.removeListener(listener); if (_revealListener === listener) _revealListener = null; } }, 60000);
}
async function revealFromPreview(action) {
  if (currentPath && currentPath.startsWith('workflows/')) { await openWorkflowInZoho(currentPath.split('/').pop().replace(/\.json$/, '')); return; }
  if (currentPath && currentPath.startsWith('actions/')) { const a = actionData.find((x) => x.path === currentPath); if (a) await openActionInZoho(a); return; }
  if (currentPath && currentPath.startsWith('modules/')) {
    const m = moduleData.find((x) => x.path === currentPath); if (!m) return; if (action === 'filter') await openModuleLayouts(m.gen); else await openModulePage(m.gen, m.navigable, m.label); return;
  }
  const e = treeData.find((x) => x.path === currentPath); if (!e) return;
  const info = index.get(e.id);
  try { await reveal({ id: e.id, name: info?.name || e.api_name, displayName: e.display_name, apiName: e.api_name }); }
  catch (err) { setStatus('Find failed: ' + err.message, 'warn'); }
}
$('pvreveal').onclick = () => revealFromPreview('edit');
$('pvfind').onclick = () => revealFromPreview('filter');

// ---------- controls ----------
function buildTypeChips() {
  const wrap = $('typechips'); wrap.innerHTML = '';
  const defs = viewMode === 'functions'
    ? [['all', 'All'], ...NS.map((n) => [n, n === 'validation_rule' ? 'validation' : n]), ['rest', 'REST']]
    : viewMode === 'modules'
    ? [['all', 'All'], ['standard', 'Standard'], ['custom', 'Custom']]
    : viewMode === 'connections'
    ? [['all', 'All'], ['used', 'Used'], ['unused', 'Unused'], ['disconnected', 'Disconnected']]
    : viewMode === 'actions'
    // Derived from what is on disk, never a written list: `whatsapp`, `assign_owner` and
    // `create_record` all turned up in one real org and none of them was in anybody's list. A kind
    // Zoho adds tomorrow gets a filter without anyone remembering, and a kind with nothing in it
    // gets none - a value nothing lists is a value nothing can filter.
    ? [['all', 'All'], ...[...new Set(actionData.map((a) => a.kind))].sort().map((k) => [k, actionKindLabel(k)]), ['unused', 'Attached to nothing']]
    : viewMode === 'workflows'
    ? [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive'], ['scheduled', 'Has scheduled actions']]
    : [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive']];
  if (viewMode === 'functions') typeFilter = 'all'; else if (viewMode === 'modules') moduleFilter = 'all'; else if (viewMode === 'workflows') workflowFilter = 'all'; else if (viewMode === 'schedules') scheduleFilter = 'all'; else if (viewMode === 'actions') actionFilter = 'all'; else connCatFilter = 'all';
  // A one-line dropdown, not chips: in Functions mode there are 7 filters and they wrapped to a
  // second row, eating vertical space the tree/preview below needs more than the filter does.
  const lbl = document.createElement('span'); lbl.className = 'fsellbl';
  lbl.textContent = viewMode === 'functions' ? 'Type' : (viewMode === 'modules' || viewMode === 'actions') ? 'Kind' : viewMode === 'connections' ? 'Filter' : 'Status';
  const sel = document.createElement('select'); sel.className = 'filtersel'; sel.setAttribute('aria-label', lbl.textContent + ' filter');
  defs.forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; sel.appendChild(o); });
  sel.value = 'all';
  sel.onchange = () => {
    const k = sel.value;
    if (viewMode === 'functions') typeFilter = k; else if (viewMode === 'modules') moduleFilter = k; else if (viewMode === 'workflows') workflowFilter = k; else if (viewMode === 'schedules') scheduleFilter = k; else if (viewMode === 'actions') actionFilter = k; else connCatFilter = k;
    (viewMode === 'functions' ? runSearch() : viewMode === 'modules' ? renderModules() : viewMode === 'workflows' ? renderWorkflows() : viewMode === 'schedules' ? renderSchedules() : viewMode === 'actions' ? renderActions() : renderConnections());
  };
  wrap.appendChild(lbl); wrap.appendChild(sel);
  // Two lists have columns worth sorting by, and they get the same control - one built here rather
  // than a second one written beside it, or the two would drift the way every duplicated thing in
  // this panel has. What differs is the keys and the state each list keeps.
  if (viewMode === 'functions' || viewMode === 'actions') {
    const acts = viewMode === 'actions';
    const sl = document.createElement('span'); sl.className = 'fsellbl'; sl.textContent = 'Sort';
    const ss = document.createElement('select'); ss.className = 'filtersel';
    ss.setAttribute('aria-label', acts ? 'Sort actions' : 'Sort functions');
    (acts
      ? [['name', 'Kind, then name'], ['rules', 'Rules that fire it'], ['module', 'Module'], ['modified', MSG.lastModified]]
      : [['name', 'Name (grouped)'], ['lines', 'Lines'], ['calls', 'API calls'], ['size', 'Size'], ['modified', MSG.lastModified]])
      .forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; ss.appendChild(o); });
    ss.value = acts ? actionSort : treeSort;
    const dirBtn = document.createElement('button'); dirBtn.className = 'sortdir';
    const paintDir = () => {
      const asc = (acts ? actionSortDir : treeSortDir) === 'asc';
      dirBtn.textContent = asc ? '↑' : '↓';
      const byName = acts ? (actionSort === 'name' || actionSort === 'module') : treeSort === 'name';
      dirBtn.title = byName
        ? (asc ? 'A to Z - click for Z to A' : 'Z to A - click for A to Z')
        : (asc ? 'Lowest first - click for highest first' : 'Highest first - click for lowest first');
      dirBtn.setAttribute('aria-label', dirBtn.title);
    };
    // Changing what you sort by resets the direction to the one that is almost always wanted:
    // names read A→Z, numbers read biggest-first.
    ss.onchange = () => {
      if (acts) { actionSort = ss.value; actionSortDir = (actionSort === 'name' || actionSort === 'module') ? 'asc' : 'desc'; }
      else { treeSort = ss.value; treeSortDir = treeSort === 'name' ? 'asc' : 'desc'; }
      paintDir(); (acts ? renderActions() : renderTree());
    };
    dirBtn.onclick = () => {
      if (acts) actionSortDir = actionSortDir === 'asc' ? 'desc' : 'asc';
      else treeSortDir = treeSortDir === 'asc' ? 'desc' : 'asc';
      paintDir(); (acts ? renderActions() : renderTree());
    };
    paintDir();
    wrap.appendChild(sl); wrap.appendChild(ss); wrap.appendChild(dirBtn);
  }
}
$('nameToggle').onclick = () => {
  if (viewMode === 'functions') {
    nameMode = nameMode === 'internal' ? 'display' : 'internal';
    $('nameToggle').textContent = MSG.namePrefix + nameMode;
    renderTree(); if (currentPath) showCallers(currentPath); redrawNavMenu();
  } else {
    moduleNameMode = moduleNameMode === 'api' ? 'display' : moduleNameMode === 'display' ? 'generated' : 'api';
    $('nameToggle').textContent = MSG.namePrefix + moduleNameMode;
    renderModules(); redrawNavMenu();
  }
};
// ---- keyboard: the selection follows the arrows ------------------------------------------------
// The twin of the Analytics panel's, against the tree instead of a table: up and down used to
// scroll, and what a reader wants is the next function *open*. Only rows that are on screen take
// part - a collapsed group's children are not there to be stepped onto, and neither is anything the
// search or the type filter has taken away.
let stepAnchor = null;      // where the keyboard is, which the DOM learns a tick later
// Bring a row fully into view, under whatever is stuck to the top of the list. `scrollIntoView`
// with `block: 'nearest'` aligns to the container's edge and knows nothing about a sticky header -
// so stepping upwards parked the selected row exactly underneath it, half visible. Reported after
// the arrows landed: the movement was right and the row was not all there.
//
// The header is measured rather than assumed: it is a column row in one product and a group label
// in the other, both `position: sticky`, and both change height with the font a reader has set.
/** Mark a row as the selected one **and bring it into view** - one act, which was five.
 *
 *  Every list here had the first half; only the functions tree had the second, so a jump from a
 *  health row, a link in the code or a step of the history selected a module, a workflow or a
 *  connection that the reader then had to scroll to find. Reported exactly that way: «l'item
 *  evidenziato deve sempre essere visibile». `openFile()` keeps its own two lines because it also
 *  moves the arrow anchor; everything else calls this, so the next list inherits both halves.
 */
/** Move the view to the current item. Called when the geometry is final, never by whoever opened it.
 *
 *  Measured rather than guessed, after five attempts that were not. The recorded sequence of one
 *  jump reads: the list is drawn, the reveal runs and finds the row **inside** a 376px box so it
 *  correctly does nothing, and only *then* the detail pane opens and the box becomes 68px. Nothing
 *  reveals after that, so whether the row is still on screen depends on where the scroll happened to
 *  be - which is exactly what «random» looks like from the outside.
 *
 *  So the event is not «the list has been drawn»: it is «the pane has opened», which is what changes
 *  the height. Reading the row's rect here forces the pending layout, so this sees the new geometry
 *  and not the old.
 */
function applySelection() {
  if (!currentPath) return;
  const box = $('tree'); if (!box) return;
  const row = [...box.querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === currentPath);
  if (row) revealRow(row, box, '.grp');
}

/** Open the detail pane - one function, because opening it is what shrinks the list, and the six
 *  places that used to do it by hand each left the selected row wherever it happened to be. */
function showPreview() {
  $('preview').classList.add('show');
  $('resizer').classList.add('show');
  resetPreviewScroll();
  applySelection();
}

function selectRow(path) {
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
  const find = () => [...$('tree').querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === path);
  let row = find();
  // Not there yet, for one of two reasons, and both were reported. The row may be inside a **closed
  // group** - every list here groups its rows and `collapsed` is shared, with a different key prefix
  // per list - or the list may not have been drawn yet, because arriving here changes tab and the
  // rebuild lands a tick later. Neither is worth teaching this function about: the group headers
  // already carry the code that opens them, so the ones that are closed are *clicked*, which is what
  // the reader would have done, and each list re-renders itself its own way. Then we look again on
  // the next frame, which is also the answer to the second reason.
  if (!row) {
    $('tree').querySelectorAll('.grp.collapsed').forEach((g) => g.click());
    row = find();
  }
  if (row) { revealRow(row, $('tree'), '.grp'); return; }
  requestAnimationFrame(() => {
    document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
    revealRow(find(), $('tree'), '.grp');
  });
}

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
  const rows = [...$('tree').querySelectorAll('.f[data-path]')].filter((el) => el.offsetParent !== null);
  if (!rows.length) return;
  // The anchor is remembered here, not read back from the tree. Opening a function reads its file,
  // so `aria-selected` lands a tick later: holding the arrow down asked the DOM where it was before
  // the DOM knew, found nothing, and started from the top again - every press selecting the first
  // row. Measured by pressing twice and landing on row one. The attribute is still the truth for a
  // screen reader; this is just what the keyboard steps from.
  const cur = rows.find((r) => r.dataset.path === stepAnchor)
    || $('tree').querySelector('.f[data-path][aria-selected="true"]');
  let i;
  if (edge === 'first') i = 0;
  else if (edge === 'last') i = rows.length - 1;
  else {
    const at = cur ? rows.indexOf(cur) : -1;
    i = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
  }
  const el = rows[i];
  if (!el || el === cur) return;
  stepAnchor = el.dataset.path;
  // **The row is clicked, not opened as a function.** This list is the functions tree in one mode
  // and modules, workflows, schedules, actions or connections in the others, and each row already
  // carries what opening it means. Calling openFromTree() on all of them read an action's row as a
  // path to a .dg file and answered «A requested file or directory could not be found» - reported
  // from the Actions tab. A click is the one thing every row knows how to be.
  el.click();
  // The group header is sticky here, and it is the previous group's label that covers the row you
  // have just stepped up onto.
  revealRow(el, $('tree'), '.grp');
}

// ---------- history: the chain you have walked, and the way back up it ----------
// A browser's three: back, forward, and the list itself, because «back» alone only reaches the step
// before - the author asked to be able to «risalire la catena», which is the list.
//
// Keyed by `currentPath`, which every opener in this panel sets and whose prefix says what kind of
// thing it is; `navOpen()` is that discrimination once, in the order `aiFocusLabel()` already uses.
// A new tab joins the history by setting `currentPath` like its siblings, with nothing to add here.
const NAV_MAX = 50;
let navHist = [], navPos = -1, navReplaying = false, navSeq = 0;

/** Record where we have just arrived. Called by the openers, so every way in is covered - a click in
 *  the tree, an arrow key, a search result, a link in a code pane or in «Used in». A step onto the
 *  item already showing is not a step: re-opening after a pull would otherwise fill the chain with
 *  the same name. `n` is the unique runtime id - the menu's key, and the reason a place visited
 *  twice stays two rows rather than collapsing into one. */
function navHere(label) {
  if (navReplaying || !currentPath) return;
  const cur = navHist[navPos];
  if (cur && cur.path === currentPath) { if (label) cur.label = label; updateNav(); return; }
  // Stepping somewhere new drops what was ahead, exactly as a browser does: the forward arrow means
  // «where I came back from», and after a turn there is no such place any more.
  navHist = navHist.slice(0, navPos + 1);
  navHist.push({ n: ++navSeq, path: currentPath, label: label || currentPath.split('/').pop(), at: Date.now() });
  if (navHist.length > NAV_MAX) navHist.shift();
  navPos = navHist.length - 1;
  updateNav();
}
/** The name the header ended up showing is the name the chain shows. Openers know their item's real
 *  name at different moments - some after reading the file - so the label is taken from the one
 *  funnel they all pass through rather than from six call sites that could each forget. */
function navLabel(name) {
  const cur = navHist[navPos];
  if (cur && name) { cur.label = name; updateNav(); }
}
/** The names this item is known by, kept on the step itself.
 *
 *  Deriving them at draw time from `treeData` worked only while the reader was on the tab that holds
 *  them: in Workflows, `treeData` is the rules, so every function in the chain fell back to its file
 *  name and the panel showed `alertcompito....dg`. Reported with a picture. Recorded here instead,
 *  where the opener has just read the row, so which tab is open afterwards cannot change what a step
 *  is called.
 */
function navNames(names) {
  const cur = navHist[navPos];
  if (cur && names) { cur.names = names; updateNav(); }
}
function navClear() { navHist = []; navPos = -1; closeNavMenu(); updateNav(); }

async function navOpen(p) {
  const find = (arr) => (arr || []).find((x) => x.path === p);
  const gone = () => setStatus(MSG.navGone, 'warn');
  // Only when the tab actually changes. `setMode()` closes the detail pane - it has to, the pane is
  // showing something from the tab being left - so calling it for a step that is already on this tab
  // made every «back» close the pane, select the row and reopen it. Reported as a flicker, and it is
  // one: the reader is looking at the pane, and the pane is what blinked.
  const goMode = (m) => { if (viewMode !== m) setMode(m); };
  // A step can point into an area the role has stopped granting - the mirror still has the files,
  // the tab is gone. Same refusal as every other jump, from the one guard.
  if (!tabReachable(navKind(p) === 'function' ? 'functions' : navKind(p) + 's')) return;
  if (p.startsWith('workflows/')) { goMode('workflows'); await rebuildWorkflows(); const e = find(workflowData); return e ? openWorkflow(e) : gone(); }
  if (p.startsWith('schedules/')) { goMode('schedules'); await rebuildSchedules(); const e = find(scheduleData); return e ? openSchedule(e) : gone(); }
  if (p.startsWith('connections/')) { goMode('connections'); await rebuildConnections(); const e = find(connectionData); return e ? openConnection(e) : gone(); }
  if (p.startsWith('actions/')) { goMode('actions'); await rebuildActions(); const e = find(actionData); return e ? openAction(e) : gone(); }
  if (p.startsWith('modules/')) { goMode('modules'); await rebuildModules(); return openModule(p); }
  goMode('functions'); return openFile(p);
}

/** Go to step `i`. The position moves even when the item turns out not to be there any more - the
 *  same thing a browser does with a page that has since 404'd, and the status line says which it
 *  was. Pretending the step never existed would be worse: the chain is a record of where the reader
 *  went, not a claim that all of it still exists. */
async function navTo(i) {
  if (i < 0 || i >= navHist.length || i === navPos) return;
  const e = navHist[i];
  navPos = i; navShow(false); updateNav();
  navReplaying = true;
  try { await navOpen(e.path); } finally { navReplaying = false; }
}

// Each control is there only when it can do something, which is this panel's rule for the retry
// button, for Clear and for Forget. An arrow greyed out is a control saying «not now» in a place
// where nothing is ever going to make it work except walking somewhere first.
function updateNav() {
  $('pvback').classList.toggle('show', navPos > 0);
  $('pvfwd').classList.toggle('show', navPos >= 0 && navPos < navHist.length - 1);
  const seg = $('navtab');
  if (seg) seg.style.display = navHist.length ? '' : 'none';   // nowhere to go, nothing to offer
}
function closeNavMenu() { navShow(false); }
// Open it, or draw it again where it already is - the second is what the name toggle needs, and
// without it the chain kept the old names until it was closed and reopened.
function redrawNavMenu() { if (navOpenNow()) renderNav(); }
const navOpenNow = () => $('navview').classList.contains('show');
function navShow(on) {
  $('navview').classList.toggle('show', on);
  // The same class the health and AI views set, driving the same rules: while this is up, every
  // other control in the toolbar is dimmed and inert. Three views of the workspace, one behaviour.
  document.body.classList.toggle('nav-open', on);
  if (on) $('navname').textContent = MSG.namePrefix + nameMode;
  const seg = $('navtab');
  if (seg) { seg.classList.toggle('on', on); seg.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  if (on) renderNav();
}
function toggleNavMenu() { navShow(!navOpenNow()); }
/** The chain, drawn full width. Newest first - the reader is looking for where they were a moment
 *  ago, not for where they started - and the step they are on is marked rather than left out. */
function renderNav() {
  const body = $('navbody');
  // The same search box as every other tab, filtering the same way: by the name on screen, which is
  // the one `navLabelNow()` decides. A history that ignored the box while sitting in its place would
  // be a list that looks like the others and does not behave like them.
  const q = ($('navfind').value || '').trim().toLowerCase();
  const rows = navHist.map((e, i) => ({ e, i }))
    .filter(({ e }) => !q || navLabelNow(e).toLowerCase().includes(q) || navKind(e.path).includes(q));
  $('navcount').textContent = navHist.length
    ? `${rows.length === navHist.length ? navHist.length : rows.length + ' of ' + navHist.length} step${navHist.length > 1 ? 's' : ''}`
    : '';
  if (!navHist.length) {
    body.innerHTML = '<div class="nvnone">Nothing yet. Open a function, a rule or a module and every '
      + 'step you take is listed here - click one to go back to it.</div>';
    return;
  }
  if (!rows.length) { body.innerHTML = `<div class="nvnone">${escHtml(MSG.narrowNav)}</div>`; return; }
  body.innerHTML = rows.map(({ e, i }) => `<div class="nvrow${i === navPos ? ' at' : ''}" data-n="${escA(String(e.n))}" data-i="${escA(String(i))}" title="${escA(e.path)}">`
    + `<span class="nvk">${escHtml(navKind(e.path))}</span><span class="nvl">${escHtml(navLabelNow(e))}</span>`
    + `<span class="nvw">${escHtml(navWhen(e.at))}</span></div>`).reverse().join('');
  body.querySelectorAll('.nvrow').forEach((r) => { r.onclick = () => navTo(Number(r.dataset.i)); });
}
// What kind of thing a step was, from the same prefix navOpen() dispatches on - so the chain reads
// «workflow Invoice overdue» rather than a bare name that could be any of six things.
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
/** What to call a step *now*.
 *
 * The label captured when the step was taken is a fallback, not the answer: this panel lets the
 * reader switch between a function's display name and its api name, and between three names for a
 * module, and a chain still reading «Build invoice» while the tree reads `buildInvoice` is two lists
 * disagreeing about the same item. Reported. So the name is derived at draw time from the same rows
 * the tree and the module list derive theirs from - one source, so they cannot drift - and the
 * stored label is used only for something no longer in the mirror.
 */
function navLabelNow(e) {
  const n = e.names;
  if (e.path.startsWith('modules/')) {
    if (n) return (moduleNameMode === 'display' ? n.display : moduleNameMode === 'generated' ? n.gen : n.api) || e.label;
    const m = moduleData.find((x) => x.path === e.path);
    return m ? (moduleNameMode === 'display' ? m.label : moduleNameMode === 'generated' ? m.gen : m.api_name) : e.label;
  }
  if (e.path.startsWith('functions/')) {
    if (n) return (nameMode === 'display' ? n.display : n.api) || e.label;
    const f = treeData.find((x) => x.path === e.path);
    return f ? labelOf(f) : e.label;
  }
  return e.label;   // a rule, a schedule, an action, a connection: one name each, and it was recorded
}
function navKind(p) {
  if (p.startsWith('workflows/')) return 'workflow';
  if (p.startsWith('schedules/')) return 'schedule';
  if (p.startsWith('connections/')) return 'connection';
  if (p.startsWith('actions/')) return 'action';
  if (p.startsWith('modules/')) return 'module';
  // `.dg` is the extension Zoho gives a Deluge function's source, so every function in the chain
  // was labelled «diagram». Reported. The kinds here are the ones `navOpen()` dispatches on, and
  // functions are its default: nothing else in this panel opens a file that is not one of the five
  // above.
  return 'function';
}

// Emptying the chain does not close what is open: the reader asked to forget where they have been,
// not to lose the thing they are reading. The step they are on is kept as the only entry, so the
// next link still has something to come back to.
$('navtab').onclick = () => toggleNavMenu();
$('codecopy').onclick = () => copyCode($('pvcode').textContent);
$('navfind').oninput = renderNav;
// The history's own Name. It moves *both* namings: it used to move the functions and leave the
// modules on whatever the Modules tab was set to, so half the chain answered the button - reported.
// A module has three names and a function two, so «internal» here is the api name for both, which is
// the pair a reader is switching between. A rule, a schedule, an action and a connection have one
// name each and cannot follow; that is Zoho's doing and is said in the guide rather than hidden.
// The lists underneath are redrawn as well: there is one naming, and coming out of the history onto
// a tree still labelled the old way is two lists disagreeing about the same item.
$('navname').onclick = () => {
  nameMode = nameMode === 'internal' ? 'display' : 'internal';
  moduleNameMode = nameMode === 'internal' ? 'api' : 'display';
  $('navname').textContent = MSG.namePrefix + nameMode;
  renderNav(); renderTree(); renderModules();
};
$('navclear').onclick = () => {
  const here = navHist[navPos];
  navHist = here ? [here] : []; navPos = navHist.length - 1;
  updateNav(); renderNav();
};
$('navx').onclick = () => navShow(false);
$('pvback').onclick = () => navTo(navPos - 1);
$('pvfwd').onclick = () => navTo(navPos + 1);
// Alt+arrows, because that is what a browser answers to and the hands already know it. Left alone
// inside a field, where the arrows belong to the text.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navOpenNow()) { navShow(false); return; }
  if (!e.altKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navTo(navPos - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navTo(navPos + 1); }
});

$('tree').addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  const edge = { Home: 'first', End: 'last' }[e.key];
  if (!step && !edge) return;
  e.preventDefault();
  stepSelection(step || 0, edge);
});

$('find').oninput = runSearch;
$('findx').onclick = () => { $('find').value = ''; runSearch(); $('find').focus(); };
$('smode').onclick = () => {
  if (viewMode !== 'functions') return;   // full-text search applies to function code only
  searchMode = searchMode === 'name' ? 'content' : 'name';
  $('smode').textContent = searchMode === 'name' ? 'in: names' : 'in: code';
  $('smode').classList.toggle('on', searchMode === 'content');
  $('find').placeholder = searchMode === 'name' ? MSG.findByName : 'Find inside the code\u2026';
  runSearch();
};
function runSearch() {
  if (viewMode === 'modules') { renderModules(); return; }
  if (viewMode === 'workflows') { renderWorkflows(); return; }
  if (viewMode === 'schedules') { renderSchedules(); return; }
  if (viewMode === 'actions') { renderActions(); return; }
  if (viewMode === 'connections') { renderConnections(); return; }
  if (searchMode === 'content') { clearTimeout(_searchT); _searchT = setTimeout(contentSearch, 220); }
  else renderTree();
}
/** Every source, once. Searching text means having read it - there is no index that spares this, and
 *  writing one would be a second answer to «what does this function say» that could disagree with the
 *  file. What can be spared is the *waiting*: the reads happen in tranches with a yield between them,
 *  the status line counts them off, and the cache is kept for the rest of the session, so this is
 *  paid once per workspace and never again until a pull changes something.
 *
 *  Measured on a generated org of 5,000 functions: 20,000 file-system calls the first time, none
 *  after. Before this, the panel simply stopped answering for the whole of it.
 */
async function getCodeCache() {
  if (codeCache) return codeCache;
  const m = new Map();
  const rows = treeData.filter((e) => e.downloaded);
  const TRANCHE = 120;
  for (let i = 0; i < rows.length; i += TRANCHE) {
    await Promise.all(rows.slice(i, i + TRANCHE).map(async (e) => {
      try { m.set(e.id, await readFile(e.path)); } catch (_) {}
    }));
    if (rows.length > TRANCHE) {
      setStatus(`Reading sources ${Math.min(i + TRANCHE, rows.length)}/${rows.length}\u2026`, 'busy');
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  codeCache = m; return m;
}
async function contentSearch() {
  const term = $('find').value.trim(); const tree = $('tree');
  if (!term) { renderTree(); return; }
  tree.innerHTML = '<div class="treemsg">Searching\u2026</div>';
  const cache = await getCodeCache(); const tl = term.toLowerCase();
  const results = [];
  const passType = (e) => typeFilter === 'all' || (typeFilter === 'rest' ? e.rest : e.namespace === typeFilter);
  for (const e of treeData) {
    if (!e.downloaded || !passType(e)) continue;
    const code = cache.get(e.id); if (!code) continue;
    const lc = code.toLowerCase(); let idx = lc.indexOf(tl); if (idx < 0) continue;
    let count = 0, i = idx; while (i >= 0) { count++; i = lc.indexOf(tl, i + tl.length); }
    const ls = code.lastIndexOf('\n', idx) + 1; let le = code.indexOf('\n', idx); if (le < 0) le = code.length;
    const lineNo = code.slice(0, idx).split('\n').length;
    results.push({ e, count, lineNo, line: code.slice(ls, le).trim().slice(0, 140) });
  }
  results.sort((a, b) => b.count - a.count || labelOf(a.e).localeCompare(labelOf(b.e)));
  tree.innerHTML = '';
  if (!results.length) { tree.innerHTML = `<div class="treemsg">No matches for "${escHtml(term)}".</div>`; return; }
  const total = results.reduce((n, r) => n + r.count, 0);
  const hdr = document.createElement('div'); hdr.className = 'srhdr'; hdr.textContent = `${total} match(es) in ${results.length} file(s)`; tree.appendChild(hdr);
  const reTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  results.forEach((r) => {
    const el = document.createElement('div'); el.className = 'sr'; el.dataset.path = r.e.path;
    const hi = escHtml(r.line).replace(new RegExp('(' + reTerm + ')', 'ig'), '<mark>$1</mark>');
    el.innerHTML = `<div class="srname">${escHtml(labelOf(r.e))} <span class="srcount">${r.count}</span></div><div class="srline"><span class="srln">${r.lineNo}</span> ${hi}</div>`;
    el.onclick = () => openFromTree(r.e.path);
    tree.appendChild(el);
  });
}

// ---------- pull / graph ----------
async function pullAll() {
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    await requirePerm(dir);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing to avoid cross-environment mix-ups.`);
    setStatus('Listing functions…', 'busy');
    const r = await toBridge({ cmd: 'listFunctions' }); if (!r?.ok) throw bridgeError(r, 'list failed');
    await writeFile('functions/index.json', JSON.stringify(r.entries, null, 2));
    // reflect deletions: remove local files for functions no longer in Zoho
    const liveIds = new Set(r.entries.map((e) => String(e.id))); const rmF = [];
    for await (const p of walk(dir)) {
      if (!p.startsWith('functions/')) continue;   // only a function has a .meta.json to prune by
      if (p.endsWith('.meta.json')) { try { const mm = JSON.parse(await readFile(p)); if (!liveIds.has(String(mm.id))) { rmF.push(p); rmF.push(p.replace(/\.meta\.json$/, '.dg')); } } catch (_) {} }
    }
    let prunedF = 0; for (const p of rmF) { try { await removeFile(p); if (p.endsWith('.dg')) prunedF++; } catch (_) {} }
    // patchCfg, not writeCfg: this file also holds the access verdicts and the workspace's own
    // name, and a whole-object write here drops both. The trap arriving a third time.
    await patchCfg({ org: ctx.org, instance: ctx.instance, base: ctx.origin, lastPull: new Date().toISOString() });
    // Every field the binding carries, or the guard that reads one of them silently stops firing.
    // A pull cannot run on a sample - guardOk refuses it - so this can only ever be false here, and
    // writing it out is what stops the next field added to .zoost.json being dropped in this line.
    const _c = (await readCfg()) || {};
    bound = { org: ctx.org, base: ctx.origin, instance: ctx.instance, label: _c.label || '', sample: !!_c.sample };
    await cacheBinding(bound);
    await rebuildTree();
    await downloadMissing();   // fetch each function's code, resiliently (partials stay; failures can be retried)
    if (prunedF) setStatus($('stxt').textContent + ` \u00b7 ${prunedF} deleted removed`, 'ok');
    // The page loop has a ceiling like every other one here, and unlike every other one it was not
    // being said: the bridge returned `capped` and nothing read it, so a list that stopped early
    // looked exactly like a census. That is the one thing a mirror may never do, and it was
    // introduced the day the ceiling was - reported by an assistant reading the repository.
    if (r.capped) setStatus($('stxt').textContent + ` \u00b7 list stopped at ${r.total} - there are more functions in Zoho`, 'warn');
    await noteAccess('functions', null);
  } catch (e) { await notePullFailure('functions', e); } finally { pullActive = false; }
}
// The call graph with everything around it: what fires the code, and what the code reaches out to.
//
// A separate function on purpose. `ensureGraph()` has eleven other readers - the health audit, the
// exports, the AI index, the connection usage counts - and every one of them assumes each node is a
// Deluge function. Widening that shape would have made all eleven quietly wrong, so the enrichment
// lives here and only the diagram window sees it.
//
// Everything it adds is already on disk. Nothing is fetched, and nothing is inferred: a workflow
// fires a function because its own JSON says so, a schedule because its index row names it, a
// connection because the function's captured meta lists it.
const CTX_ID = { wf: (id) => 'wf:' + id, sch: (id) => 'sch:' + id, conn: (name) => 'conn:' + name,
                 act: (kind, id) => 'act:' + kind + ':' + id, mod: (api) => 'mod:' + api };
/** A node that is not a Deluge function.
 *
 *  `entity` is what kind of *thing* it is and `category` is what kind of that thing: a function is
 *  `functions` + its Deluge category, an action is `actions` + `email_notifications`. The two were
 *  one field while every non-function entity had exactly one category, and the moment actions
 *  arrived - four kinds under one entity - the graph window's chips put them among the Deluge
 *  categories, which is a dimension error of the sort this file already records twice. Splitting the
 *  field is what lets the chips have an Actions box with four chips in it, the same shape as the
 *  Functions box, without anything being enumerated in the window. */
function ctxNode(id, name, category, namespace, file, extra) {
  return Object.assign({
    id, name, api_name: name, display_name: name, namespace: namespace || '', category,
    calls: [], called_by: [], rest: false, dead_suspect: false, unresolved: [], ambiguous: [],
    associated_place: null, file: file || '', source_code: '', params: [], stats: null,
    description: '', connections: [], entity: category,
  }, extra || {});
}
async function callGraphWithContext() {
  const g = await ensureGraph();
  const nodes = {};
  for (const [id, n] of Object.entries(g.nodes)) {
    nodes[id] = Object.assign({}, n, { calls: n.calls.slice(), called_by: n.called_by.slice(), entity: 'functions' });
  }
  // The same resolution the health audit uses, and for the same reason: an action names a function
  // by id when Zoho gives one and by name when it does not.
  const byId = {}, byName = {};
  Object.values(nodes).forEach((n) => { if (n.id) byId[String(n.id)] = n; [n.name, n.api_name, n.display_name].forEach((k) => { if (k) byName[String(k).toLowerCase()] = n; }); });
  const link = (from, to) => { if (!from.calls.includes(to.id)) from.calls.push(to.id); if (!to.called_by.includes(from.id)) to.called_by.push(from.id); };
  const resolveFn = (a) => byId[String(a.id)] || byName[String(a.name || '').toLowerCase()] || null;

  // The actions index, so a rule can be linked to the thing it fires rather than to a name.
  const actIndex = new Map();
  let actRows = [];
  try {
    const rows = JSON.parse(await readFile('actions/index.json'));
    if (Array.isArray(rows)) { actRows = rows; rows.forEach((r) => actIndex.set(r.kind + ':' + String(r.id), r)); }
  } catch (_) { /* not pulled: the rules still draw, with fewer edges */ }

  // A module is a node only when something names it - a workflow it fires on, an action that writes
  // to it. Drawing every module in the mirror would put forty boxes with no arrow into a diagram
  // whose whole subject is what connects to what, and «nothing automates this module» is a
  // measurement the health view already makes. The label comes from the modules index when it is on
  // disk; without it the API name is what there is, and that is what it says.
  let modIdx = []; try { modIdx = JSON.parse(await readFile('modules/index.json')); } catch (_) {}
  const modLabel = {};
  (Array.isArray(modIdx) ? modIdx : []).forEach((m) => { if (m && m.api_name) modLabel[m.api_name] = m.plural_label || m.label || m.api_name; });
  const modOf = (api) => {
    if (!api) return null;
    const id = CTX_ID.mod(api);
    if (!nodes[id]) nodes[id] = ctxNode(id, modLabel[api] || api, 'modules', '', 'modules/index.json',
      { entity: 'modules', api_name: api });
    return nodes[id];
  };

  // Every action, not only the ones a rule was found to fire. Measured on a real org, roughly half
  // are attached to nothing - and an action nothing fires is exactly the kind of thing a diagram of
  // the wiring should show as a box on its own, rather than leave out and call the picture complete.
  actRows.forEach((r) => {
    if (!r || !r.kind) return;
    const id = CTX_ID.act(r.kind, r.id);
    if (!nodes[id]) nodes[id] = ctxNode(id, r.name || String(r.id), r.kind, '', 'actions/index.json',
      { entity: 'actions', _kind: r.kind });
    const m = modOf(r.module);
    if (m) link(nodes[id], m);
  });

  // ---- workflows: their own file says which functions each condition fires -------------------
  let wfIdx = []; try { wfIdx = JSON.parse(await readFile('workflows/index.json')); } catch (_) {}
  for (const w of wfIdx) {
    let d = null; try { d = JSON.parse(await readFile(`workflows/${w.id}.json`)); } catch (_) {}
    const node = ctxNode(CTX_ID.wf(w.id), w.name || String(w.id), 'workflows', w.module || '',
      `workflows/${w.id}.json`, { entity: 'workflows', _downloaded: !!d, _active: w.status !== 'inactive' });
    nodes[node.id] = node;
    // The module a rule fires on is a different fact from the module an action writes to, and both
    // are drawn: this one is «records of this kind are what set it off».
    { const m = modOf(w.module); if (m) link(node, m); }
    if (!d) continue;   // not pulled yet: it is a node with no measured actions, never a node with none
    (d.conditions || []).forEach((c) => {
      const acts = [];
      if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions);
      (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || [])));
      acts.filter(isFnAction).forEach((a) => { const fn = resolveFn(a); if (fn) link(node, fn); });
      // What else the rule fires. Until now the chain stopped at Deluge, which in a real org is the
      // smaller half - 275 notification actions against 149 function ones - so a diagram of «what
      // happens when this fires» was missing most of what happens. The nodes come from the actions
      // index, so an action nobody pulled is not invented here.
      acts.filter((a) => a && a.type && !isFnAction(a)).forEach((a) => {
        const row = actIndex.get(a.type + ':' + String(a.id));
        if (!row) return;
        const id = CTX_ID.act(row.kind, row.id);
        if (!nodes[id]) nodes[id] = ctxNode(id, row.name || String(row.id), row.kind, '',
          'actions/index.json', { entity: 'actions', _kind: row.kind });
        link(node, nodes[id]);
      });
    });
  }

  // ---- schedules: the index row carries the function it runs ---------------------------------
  let scheds = []; try { scheds = JSON.parse(await readFile('schedules/index.json')); } catch (_) {}
  scheds.forEach((sc) => {
    const node = ctxNode(CTX_ID.sch(sc.id), sc.name || String(sc.id), 'schedules', sc.frequency || '',
      'schedules/index.json', { entity: 'schedules', _active: sc.status !== 'inactive' });
    nodes[node.id] = node;
    const fn = resolveFn({ id: sc.function_id, name: sc.function_name });
    if (fn) link(node, fn);
  });

  // ---- connections: the join key is the name inside invokeurl [...connection:"..."] ------------
  let cat = []; try { cat = JSON.parse(await readFile('connections/index.json')); } catch (_) {}
  const conn = {};
  const ensureConn = (name, meta) => {
    const id = CTX_ID.conn(name);
    if (!conn[id]) { conn[id] = ctxNode(id, (meta && meta.label) || name, 'connections', (meta && meta.service) || '', 'connections/index.json', { entity: 'connections' }); nodes[id] = conn[id]; }
    return conn[id];
  };
  cat.forEach((c) => { if (c && c.name) ensureConn(c.name, c); });
  Object.values(nodes).forEach((n) => {
    if (n.entity !== 'functions') return;
    (n.connections || []).forEach((c) => { if (c && c.name) link(n, ensureConn(c.name, c)); });
  });

  // ---- and the counts follow the graph that is actually drawn ---------------------------------
  // "Nothing calls this" is now a stronger statement than it was, because a workflow and a schedule
  // are callers. A connection with no caller is a connection nothing uses - which is the same
  // candidate, never a verdict, that the panel already states with its coverage gap beside it.
  let dead = 0;
  Object.values(nodes).forEach((n) => {
    n.calls.sort(); n.called_by.sort();
    n.dead_suspect = !n.called_by.length && !n.rest && !(n.associated_place && n.associated_place.length);
    if (n.dead_suspect) dead++;
  });
  const edges = new Set();
  Object.values(nodes).forEach((n) => n.calls.forEach((c) => edges.add(n.id + '\u0000' + c)));
  return Object.assign({}, g, {
    nodes,
    counts: Object.assign({}, g.counts, { nodes: Object.keys(nodes).length, edges: edges.size, dead_suspects: dead }),
  });
}
async function openGraph() {
  if (!dir) return;
  try {
    await requirePerm(dir);
    setStatus('Building graph…', 'busy'); await refreshContext(); const g = await callGraphWithContext();
    g.workspace = { instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null, label: bound?.label || null };
    await chrome.storage.session.set({ graphData: graphForWindow(g) });
    await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html'), type: 'normal', width: 1240, height: 840 });
    setStatus(`Graph: ${g.counts.nodes} nodes, ${g.counts.edges} edges.`, 'ok');
  } catch (e) { setStatus(MSG.graphErr + e.message, 'bad'); }
}

// ---------- health / audit ----------
let healthData = null, healthTab = 'functions';
function nmNode(n) { return escHtml(nameMode === 'display' ? (n.display_name || n.name) : (n.api_name || n.name)); }
async function buildHealth() {
  const g = await ensureGraph();
  const nodes = Object.values(g.nodes);
  const fnById = {}, fnByName = {};
  nodes.forEach((n) => { if (n.id) fnById[String(n.id)] = n; [n.name, n.api_name, n.display_name].forEach((k) => { if (k) fnByName[String(k).toLowerCase()] = n; }); });
  const byName = (a, b) => (a.display_name || a.name || '').localeCompare(b.display_name || b.name || '');
  const fnLink = (n) => `<a data-file="${escA(n.file)}">${nmNode(n)}</a>`;
  const orphan = nodes.filter((n) => n.dead_suspect).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">${escHtml(n.namespace || '')}</span>` }));
  const unresolved = nodes.filter((n) => n.unresolved && n.unresolved.length).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">calls: ${escHtml(n.unresolved.join(', '))}</span>` }));
  const ambiguous = nodes.filter((n) => n.ambiguous && n.ambiguous.length).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">ambiguous: ${escHtml(n.ambiguous.join(', '))}</span>` }));
  const broken = [];
  let wfIdx = []; try { wfIdx = JSON.parse(await readFile('workflows/index.json')); } catch (_) {}
  for (const w of wfIdx) { let d = null; try { d = JSON.parse(await readFile(`workflows/${w.id}.json`)); } catch (_) {} if (!d) continue; (d.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter(isFnAction).forEach((a) => { if (!(fnById[String(a.id)] || fnByName[(a.name || '').toLowerCase()])) broken.push({ kind: 'workflow', id: w.id, name: w.name, fn: a.name }); }); }); }
  let scheds = []; try { scheds = JSON.parse(await readFile('schedules/index.json')); } catch (_) {}
  scheds.forEach((sc) => { if (!(fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()])) broken.push({ kind: 'schedule', id: sc.id, name: sc.name, fn: sc.function_name }); });
  const brokenItems = broken.map((b) => ({ html: `<span>${escHtml(b.kind)}</span> <a data-kind="${escA(b.kind)}" data-id="${escA(String(b.id || ''))}">${escHtml(b.name || '?')}</a> <span class="meta">\u2192 missing function \u00ab${escHtml(b.fn || '?')}\u00bb</span>` }));
  const missingFK = []; const modApis = new Set(); const modObjs = [];
  for await (const p of walk(dir)) { if (isModuleFile(p)) { try { const m = JSON.parse(await readFile(p)); modObjs.push(m); modApis.add(m.api_name); } catch (_) {} } }
  modObjs.forEach((m) => { if (/__s$/.test(m.api_name || '')) return; (m.fields || []).forEach((fl) => { let t = fl.lookup; if (t && typeof t === 'object') t = t.api_name || (typeof t.module === 'string' ? t.module : (t.module && t.module.api_name)) || null; if (!t || typeof t !== 'string') return; if (/__s$/.test(t)) return; if (!modApis.has(t)) missingFK.push({ module: m.api_name, field: fl.api_name || fl.label, target: t }); }); });
  // The module named here *is* in the workspace - it is its lookup's target that is not - so it
  // opens, and the target stays plain text because there is nothing to open.
  const fkItems = missingFK.map((r) => ({ html: `<a data-kind="module" data-id="${escA(r.module)}">${escHtml(r.module)}</a>.<span>${escHtml(r.field)}</span> <span class="meta">\u2192 ${escHtml(r.target)} (not in workspace)</span>` }));
  const coverage = `<b>Coverage.</b> Analyzed: function\u2192function calls, workflows, schedules, and each function's <i>associated_place</i> (blueprint, button, \u2026). <b>Not</b> analyzed: custom client scripts, approval/assignment/scoring rules, and anything Zoho doesn't report. Every item is a <b>candidate to review</b> - never an automatic deletion. <b>Size &amp; calls</b> are plain counts with no threshold and no verdict: they show where length and outbound calls concentrate, and you decide what that means. Based on ${nodes.length} functions, ${modObjs.length} modules in this workspace.`;
  // Everything read from the platform rather than computed from the mirror, fetched once: both
  // groups below need it. It sits above them because moving one of them up put a use of `fx`
  // before its declaration - a temporal dead zone that `node --check` waves through and only
  // running the function finds, which is the trap this repository has already recorded twice.
  const fx = await failuresIndex();
  // Measured cost, beside the static proxies that were the only thing here before. «180 lines and
  // five outbound calls» is a guess about what a function costs; «it ran 239 times yesterday» is
  // what it cost. Both stay: the proxy covers every function, the measurement covers the busiest
  // few, and neither is a verdict.
  const runsById = new Map(), runsByName = new Map();
  (fx.runs || []).forEach((r) => { if (r.id) runsById.set(String(r.id), r.count); if (r.name) runsByName.set(String(r.name).toLowerCase(), r.count); });
  const runsOf = (n) => runsById.get(String(n.id || ''))
    ?? [n.display_name, n.name, n.api_name].map((k) => runsByName.get(String(k || '').toLowerCase())).find((v) => v != null);
  const mostRun = (fx.runs || []).map((r) => {
    const n = fnById[String(r.id || '')] || fnByName[String(r.name || '').toLowerCase()];
    const who = n ? fnLink(n) : `<b>${escHtml(r.name || '?')}</b>`;
    const st = n && n.stats ? ` \u00b7 ${n.stats.lines} lines, ${n.stats.apiCalls} outbound call(s)` : '';
    return { html: `${who} <span class="meta">${escHtml(String(r.count))} run(s) in 24h${st}</span>` };
  });
  const runsDesc = fx.runs
    ? `The busiest ${fx.runs.length} functions in the 24 hours before ${escHtml(fmtDate(fx.at))}, as Zoho counted them - not every function, and not a ranking of anything but frequency.`
      + (fx.credits && (fx.credits.used != null || fx.credits.limit != null)
          ? ` Over the same period Zoho counted ${escHtml(String(fx.credits.used ?? 'unknown'))} against a ceiling of ${escHtml(String(fx.credits.limit ?? 'unknown'))}.` : '')
      + ' Zoho reports how often, not how long: a function that runs often is not automatically the expensive one.'
    : MSG.notReadYet;
  // Size and outbound-call counts, shown as plain rankings with no threshold and no verdict: a long
  // function is worth a look, not automatically wrong, and the reader decides what the numbers mean.
  const withStats = nodes.filter((n) => n.stats && n.stats.lines);
  const ranNote = (n) => { const r = runsOf(n); return r == null ? '' : ` \u00b7 ran ${r}\u00d7 in 24h`; };
  const biggest = withStats.slice().sort((a, b) => b.stats.lines - a.stats.lines).slice(0, 15)
    .map((n) => ({ html: `${fnLink(n)} <span class="meta">${n.stats.lines} lines · ${n.stats.codeLines} code · ${(n.stats.chars / 1024).toFixed(1)} KB${ranNote(n)}</span>` }));
  const chattiest = withStats.filter((n) => n.stats.apiCalls > 0).sort((a, b) => b.stats.apiCalls - a.stats.apiCalls).slice(0, 15)
    .map((n) => ({ html: `${fnLink(n)} <span class="meta">${n.stats.apiCalls} calls - ${n.stats.invokeurl} invokeurl · ${n.stats.crm} zoho.crm · ${n.stats.zoho} other${n.stats.sendmail ? ' · ' + n.stats.sendmail + ' sendmail' : ''}${ranNote(n)}</span>` }));
  // What Zoho reports as failing. Unlike every other group here it is not computed from the mirror:
  // it is a reading of a runtime, taken at a moment, so it says the moment. The counts beside it are
  // aggregates - a run count and a failure count for the 24 hours before that reading - and they
  // carry no verdict, like every other number in this view.
  const failing = (fx.all || []).slice().sort((a, b) => b.count - a.count).map((f) => {
    const n = fnByName[String(f.name || '').toLowerCase()];
    const who = n ? fnLink(n) : `<b>${escHtml(f.name || '?')}</b>`;
    return { html: `${who} <span class="meta">${escHtml(String(f.count))}\u00d7 \u00b7 ${escHtml(f.componentType || '?')} \u00b7 ${escHtml(f.reason || '')}</span>` };
  });
  const failDesc = fx.at
    ? `Read from Zoho on ${escHtml(fmtDate(fx.at))}.`
      + (fx.usage ? ` In the 24 hours before that Zoho counted ${escHtml(String(fx.usage.success ?? 'unknown'))} run(s) and ${escHtml(String(fx.usage.failure ?? 'unknown'))} failure(s).` : '')
      + ' This is the only thing here read from the platform rather than computed from the mirror, so it is as old as that date and no older. The input of a failed run stays in Zoho.'
    : MSG.notReadYet;
  // Automation actions nothing fires. The same statement this view already makes about a function
  // nobody calls, on the objects nobody ever prunes - and the same care: it is a **candidate**.
  // Two sources disagree politely and both are shown: Zoho's own «in use» flag, and whether any rule
  // in this workspace names it. A rule that was never pulled cannot name anything, so «no rule here
  // names it» is not «nothing uses it», and the description says which is which.
  let actIdx = []; try { const a = JSON.parse(await readFile('actions/index.json')); if (Array.isArray(a)) actIdx = a; } catch (_) {}
  const actUse = actionUsers || await buildActionUsers();
  const unattached = actIdx
    .filter((a) => !a.associated && !(actUse.get(a.kind + ':' + String(a.id)) || []).length)
    .sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || byField('name')(a, b))
    .map((a) => ({ html: `<a data-kind="action" data-id="${escA(a.kind + ':' + a.id)}">${escHtml(a.name || a.id)}</a>`
      + ` <span class="meta">${escHtml(actionKindLabel(a.kind))}${a.module ? ' \u00b7 ' + escHtml(a.module) : ''}</span>` }));
  const actDesc = actIdx.length
    ? 'Zoho reports these as attached to no rule, and no rule in this workspace names them either. A candidate to review, not a verdict: a rule that has not been pulled cannot name anything, and Zoho answers only for the automations it knows about.'
    : MSG.notReadYet;

  const groups = [
    { id: 'mostrun', tab: 'size', title: 'Most run, measured', desc: runsDesc, bad: false, items: mostRun },
    { id: 'failing', tab: 'functions', title: 'Failing in Zoho', desc: failDesc, bad: true, items: failing },
    { id: 'biggest', tab: 'size', title: MSG.hBiggest, desc: MSG.hBiggestDesc, bad: false, items: biggest },
    { id: 'chattiest', tab: 'size', title: MSG.hChattiest, desc: 'invokeurl, zoho.crm and other Zoho service tasks, counted outside comments and strings. Each call is work Zoho meters, so this is where execution cost concentrates.', bad: false, items: chattiest },
    { id: 'orphan', tab: 'functions', title: MSG.hOrphan, desc: 'No caller in code, not exposed as REST, and no associated_place.', bad: false, items: orphan },
    { id: 'unresolved', tab: 'functions', title: MSG.hUnresolved, desc: 'Calls a function that does not resolve to anything in this workspace.', bad: true, items: unresolved },
    { id: 'ambiguous', tab: 'functions', title: MSG.hAmbiguous, desc: 'A call matches more than one function (name collision across namespaces).', bad: false, items: ambiguous },
    { id: 'unattached', tab: 'wiring', title: 'Automation actions nothing fires', desc: actDesc, bad: false, items: unattached },
    { id: 'broken', tab: 'wiring', title: MSG.hBroken, desc: 'A workflow or schedule references a function not in this workspace.', bad: true, items: brokenItems },
    { id: 'fk', tab: 'wiring', title: MSG.hMissingRefs, desc: 'A lookup field points to a module not in this workspace (may be a system module).', bad: false, items: fkItems },
  ];
  return { groups, coverage };
}
async function openHealth() {
  if (!dir) return;
  closeAI();   // one panel at a time
  $('healthview').classList.add('show'); $('health').classList.add('on'); document.body.classList.add('health-open');   // lit button + violet frame + covers the tabs, mirroring Ask AI
  $('healthbody').innerHTML = '<div class="hd">Analyzing\u2026</div>';
  healthSay('');                             // a verdict from the last time this was open is not one about now
  // Health reads the workspace files directly. Chrome lets the folder's File System Access
  // permission lapse after inactivity; without re-requesting it first (like every other file
  // operation does) the reads throw a generic "not allowed" DOMException. This click is a user
  // gesture, so requesting here re-grants it - and if the user declines, we say so plainly.
  if (!(await ensurePerm(dir))) { $('healthbody').innerHTML = '<div class="hd">Folder access is not granted - click Refresh, then open Health again.</div>'; return; }
  try { healthData = await buildHealth(); } catch (e) { $('healthbody').innerHTML = `<div class="hd">Could not analyze: ${escHtml(e.message)}</div>`; return; }
  renderHealthView();
}
function renderHealthView() {
  if (!healthData) return;
  const groups = healthData.groups;
  const tabCount = (tab) => groups.filter((g) => g.tab === tab).reduce((a, g) => a + g.items.length, 0);
  let html = `<div class="htabs">`
    + `<button class="htab ${healthTab === 'functions' ? 'on' : ''}" data-tab="functions">Functions <span class="htn">${tabCount('functions')}</span></button>`
    + `<button class="htab ${healthTab === 'wiring' ? 'on' : ''}" data-tab="wiring">Wiring <span class="htn">${tabCount('wiring')}</span></button>`
    + `<button class="htab ${healthTab === 'size' ? 'on' : ''}" data-tab="size">Size &amp; calls</button>`
    + `</div>`;
  html += `<div class="hcov">${healthData.coverage}</div>`;
  groups.filter((g) => g.tab === healthTab).forEach((g) => {
    html += `<div class="hsec"><div class="ht">${escHtml(g.title)} <span class="n ${g.items.length ? (g.bad ? 'bad' : 'warn') : 'ok'}">${g.items.length}</span></div>`
      + (g.desc ? `<div class="hd">${g.desc}</div>` : '')
      + (g.items.length ? g.items.map((it) => `<div class="hrow"><div class="hcontent">${it.html}</div></div>`).join('') : '<div class="hnone">None \u2713</div>')
      + `</div>`;
  });
  $('healthbody').innerHTML = html;
  $('healthbody').querySelectorAll('.htab').forEach((b) => (b.onclick = () => { healthTab = b.dataset.tab; renderHealthView(); }));
  $('healthbody').querySelectorAll('a[data-file]').forEach((a) => (a.onclick = () => healthOpenFn(a.dataset.file, a.dataset.line ? parseInt(a.dataset.line, 10) : null)));
  // A map, not a ternary. Two kinds fitted in a conditional and the third and fourth did not: the
  // «Automation actions nothing fires» list rendered as plain text for exactly as long as it has
  // existed, because adding a row to a health group and adding a way to open it were two separate
  // things to remember. Reported. Now the finding names its kind and the opener is looked up.
  $('healthbody').querySelectorAll('a[data-kind]').forEach((a) => (a.onclick = () => {
    const open = HEALTH_OPEN[a.dataset.kind];
    if (open) open(a.dataset.id); else setStatus(`Nothing to open for a ${a.dataset.kind}.`, 'warn');
  }));
}
function healthOpenFn(file, line) { closeHealth(); if (!tabReachable('functions')) return; if (viewMode !== 'functions') { setMode('functions'); } openFile(file, line || null); }
async function healthOpenAction(key, name) {
  closeHealth(); if (!tabReachable('actions')) return; setMode('actions'); await rebuildActions();
  const [kind, ...rest] = String(key).split(':'); const id = rest.join(':');
  // Same two ways in as the rules above: an «used in» entry keys itself Zoho's way, and the name is
  // what the reader clicked. `key` may be a bare id when it comes from there rather than kind:id.
  const e = actionData.find((a) => a.kind === kind && String(a.id) === id)
    || actionData.find((a) => String(a.id) === String(key))
    || (name && actionData.find((a) => (a.name || '') === name));
  if (e) openAction(e); else setStatus(actionData.length ? MSG.actNotHere : MSG.actNotPulled, 'warn');
}
async function healthOpenModule(api, name) {
  closeHealth(); if (!tabReachable('modules')) return; setMode('modules'); await rebuildModules();
  // `label` is the localized plural Zoho puts in an «used in» entry - «Contatti» for `Contacts` -
  // and `gen` is the generated name. The fallback used to read `m.name`, which no row of moduleData
  // has, so every by-name attempt compared against undefined and failed silently.
  const key = String(api == null ? '' : api);
  const e = moduleData.find((m) => m.api_name === key)
    || moduleData.find((m) => (m.label || '') === key) || moduleData.find((m) => (m.gen || '') === key)
    || (name && moduleData.find((m) => (m.label || m.api_name || '') === name));
  if (e) openModule(e.path); else setStatus(moduleData.length ? MSG.modNotHere : MSG.modNotPulled, 'warn');
}
// By id, then by name. Zoho keys a function's «used in» entry its own way, and a rule that is
// plainly in the mirror was being reported as absent because the two keys did not match - a true
// sentence about the wrong question. The name is what the reader clicked, so it is what the second
// attempt uses, and the message says which of the two things is actually missing.
async function healthOpenWorkflow(id, name) {
  closeHealth(); if (!tabReachable('workflows')) return; setMode('workflows'); await rebuildWorkflows();
  // Measured on a real org rather than assumed: of 77 «used in» references to workflow rules, **none**
  // matched the rules index by id and every one matched by name - Zoho's id there is not the rule's.
  // For schedules the same field is the schedule's own id, and both of the two references matched. So
  // the id is tried first, because where it is right it is exact, and the name second.
  //
  // And only when the name identifies one rule. Names were unique in that org - 106 of 106 - but that
  // is a fact about one workspace, not a guarantee: with two rules sharing a name, opening either
  // would be a guess, so the list is filtered to that name instead and the reader picks.
  const e = workflowData.find((w) => String(w.id) === String(id));
  const byName = name ? workflowData.filter((w) => (w.name || '') === name) : [];
  if (e || byName.length === 1) { openWorkflow(e || byName[0]); return; }
  if (byName.length > 1) {
    $('find').value = name; runSearch();
    setStatus(`${byName.length} workflows are called «${name}» - listed, so you can pick the one you meant.`, 'warn');
    return;
  }
  setStatus(workflowData.length ? MSG.wfNotHere : MSG.wfNotPulled, 'warn');
}
async function healthOpenSchedule(id, name) {
  closeHealth(); if (!tabReachable('schedules')) return; setMode('schedules'); await rebuildSchedules();
  const e = scheduleData.find((x) => String(x.id) === String(id))
    || (name && scheduleData.find((x) => (x.name || '') === name));
  if (e) openSchedule(e);
  else setStatus(scheduleData.length ? MSG.schNotHere : MSG.schNotPulled, 'warn');
}
// Which finding opens what. One entry per kind a health row can name, so a group that starts
// naming a new kind gets its opener here rather than silently rendering an unclickable name.
// One entry of «Used in …»: a link when this panel can open that kind of thing, plain text when it
// cannot. The kind Zoho writes is plural and its own - `workflow_rules`, `schedules` - so it is
// mapped here rather than matched loosely, and an unknown kind falls through to text.
// Which tab each opener lands on. Deliberately a map beside AP_OPEN rather than a string inside each
// opener: the two lists have to stay in step, and side by side a missing row is visible.
const AP_TAB = { workflow: 'workflows', schedule: 'schedules', action: 'actions', module: 'modules' };
/** Whether a jump into `tab` can land. An area the Zoho role forbids has no segment and can never be
 *  pulled, so arriving there shows an empty list with no way back to it - the panel looking lost
 *  instead of saying what happened. Hiding a tab in Settings is *not* this: `renderTabs()` puts that
 *  segment back for as long as the reader is on it, which is the case this used to be confused with.
 */
function tabReachable(tab, quiet) {
  if (!tab || !isForbidden(tab)) return true;
  if (!quiet) setStatus(`${tabLabel(tab)}: your Zoho role does not grant access to that area, so it cannot be opened.`, 'warn');
  return false;
}
const AP_OPEN = { workflow_rules: 'workflow', workflow: 'workflow', schedules: 'schedule',
                  schedule: 'schedule', actions: 'action', module: 'module', modules: 'module' };
function apLink(kind, p) {
  const opener = AP_OPEN[kind];
  const id = p && (p.id != null ? String(p.id) : '');
  const label = (p && (p.name || p.label)) || '(unnamed)';
  const name = (p && p.name) || '';
  // The name is passed per call, never closed over: on the module link below the name in scope is
  // the *button's*, and sending it as the module's would have the opener look for a module called
  // «Sincronizza licenze Microsoft» - a fallback that cannot match, which is the same defect this
  // change fixes one function down.
  const link = (op, key, text, why, nm) => `<a class="aplink" data-ap="${escA(op)}" data-apid="${escA(String(key))}"`
    + `${nm ? ` data-apname="${escA(nm)}"` : ''} title="${escA(why)}">${escHtml(text)}</a>`;
  // The name travels beside the id, because the id is Zoho's and not necessarily the one the rules
  // index is keyed by. Measured: of 77 references to workflow rules in a real org, none matched by
  // id and every one matched by name.
  //
  // A tab the org's role forbids is not offered at all: refusing after the click would be a control
  // saying «no» for a reason nothing on screen shows.
  if (opener && id && HEALTH_OPEN[opener] && tabReachable(AP_TAB[opener], true)) {
    return link(opener, id, label, MSG.openThis + opener, name);
  }
  // No page for this kind of thing - a custom button is the measured case, 18 of them in that org
  // and nothing in this panel that shows one. Its module *is* here, so that is what is offered, and
  // the link's text is the module's name and not the button's: a link says where it goes.
  const mod = (p && p.module) || '';
  if (mod && tabReachable('modules', true)) {
    return `${escHtml(label)} <span class="apin">in</span> `
      + link('module', mod, mod, `Zoost has no page for a ${kind.replace(/s$/, '').replace(/_/g, ' ')} - this opens its module`, mod);
  }
  return escHtml(label);
}
const HEALTH_OPEN = { workflow: healthOpenWorkflow, schedule: healthOpenSchedule,
                      action: healthOpenAction, module: healthOpenModule };
function toggleHealth() { if ($('healthview').classList.contains('show')) closeHealth(); else openHealth(); }
function closeHealth() { $('healthview').classList.remove('show'); $('health').classList.remove('on'); document.body.classList.remove('health-open'); }

// ---------- AI assistant (BYOK, provider-agnostic; Phase A: context chat) ----------
let aiMessages = [], moduleFilesCache = null, aiConnCache = null, aiSeedTruncated = false, aiSeedWarned = false;
async function aiGetCfg() {
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  const cfg = { active: c.active || 'anthropic', anthropic: Object.assign({ model: '', apiKey: '' }, c.anthropic || {}), openai: Object.assign({ model: '', apiKey: '' }, c.openai || {}), maxIter: c.maxIter || 20, seedCap: c.seedCap || AI_SEED_CAP_DEFAULT };
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
    if (on) { $('ailockpass').value = ''; aiLockMsg(''); $('ailockpass').focus(); }
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
      + 'Press \u21bb Refresh in the toolbar to grant it again, then ask once more. Nothing was lost.';
  }
  return 'Error: ' + m;
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
    setStatus('Wrong passphrase.', 'warn');
    $('ailockpass').select(); return;
  }
  await window.ZOOST_KEYVAULT.remember(prov, key);
  aiLockMsg(''); aiShowLock(false); setStatus('API key unlocked for this browser session.', 'ok');
}
function aiTrunc(x, n) { const s = x || ''; return s.length > n ? s.slice(0, n) + '\n\u2026 (truncated)' : s; }
async function loadModuleFiles() {
  if (moduleFilesCache) return moduleFilesCache;
  const map = {};
  for await (const p of walk(dir)) { if (isModuleFile(p)) { try { const m = JSON.parse(await readFile(p)); map[m.api_name] = m; } catch (_) {} } }
  moduleFilesCache = map; return map;
}
// Connections catalogue for the AI, joined with the functions that use each (same join key as the
// Connections tab: meta.connections[].name, the string in invokeurl [...connection:"..."]).
let aiActCache = null;
/** The automation actions and who fires them, for the assistant.
 *
 *  `addresses` decides whether the sender address travels with the answer, and it is a *setting*
 *  rather than a scope tick, because a chat has no dialog to tick: the export asks per file, this
 *  asks once. Off unless the user turned it on - the mirror keeps the address either way, and what
 *  is at stake here is whether it leaves the machine. */
async function aiLoadActions() {
  if (aiActCache) return aiActCache;
  let list = []; try { const a = JSON.parse(await readFile('actions/index.json')); if (Array.isArray(a)) list = a; } catch (_) {}
  const users = actionUsers || await buildActionUsers();
  let addresses = false;
  try { const c = await chrome.storage.local.get('aicfg'); addresses = !!(c.aicfg && c.aicfg.shareAddresses); } catch (_) {}
  aiActCache = { list, users, addresses };
  return aiActCache;
}
async function aiLoadConnections() {
  if (aiConnCache) return aiConnCache;
  let cat = []; try { cat = JSON.parse(await readFile('connections/index.json')); } catch (_) {}
  if (!Array.isArray(cat)) cat = [];
  const g = await ensureGraph().catch(() => null);
  const used = {};
  if (g) Object.values(g.nodes).forEach((n) => (n.connections || []).forEach((c) => { if (c && c.name) (used[c.name] ||= []).push(n.namespace + '.' + n.name); }));
  const list = cat.map((c) => ({ ...c, uses: (used[c.name] || []).slice() }));
  const known = new Set(cat.map((c) => c.name));
  Object.keys(used).forEach((nm) => { if (!known.has(nm)) list.push({ name: nm, label: nm, connector: null, connected: null, missing: true, uses: used[nm].slice() }); });
  aiConnCache = list; return list;
}
function aiModuleText(m) {
  // Told before the empty table, not after: an assistant handed "Module Invoices" with no fields
  // will reason about why a module has none, and the answer is that nobody was ever allowed to look.
  const ref = moduleRefusal(m.unreadable);
  if (ref) return `Module ${m.api_name}\nNOT DESCRIBED BY ZOHO. ${ref.text}\nDo not infer its fields, layouts or relations from anywhere else - they were never read.\n`;
  let s = `Module ${m.api_name}\n| Field | API name | Type | Lookup | Picklist |\n`;
  (m.fields || []).forEach((f) => { s += `| ${f.label || f.api_name} | ${f.api_name} | ${(f.data_type || '') + (f.length ? ' (' + f.length + ')' : '')} | ${f.lookup ? '\u2192 ' + f.lookup : ''} | ${_pick(f.picklist, 15, (x) => x)} |\n`; });
  return s;
}
// The org, stated as compactly as it can be, in layers of decreasing importance.
//
// The index goes with *every* message, so its size is what a question costs before it has been
// asked. A large org does not fit, and the question is then not "how big a cap" but "what gets
// dropped". Cutting the tail is the wrong answer: it removes an arbitrary half and the model cannot
// tell it is missing, which is how an assistant ends up asserting a function does not exist.
//
// Functions are the vocabulary here - nothing can be answered without knowing what exists - so they
// are never dropped. Modules and connections are short and go last. Whatever is left out is named as
// left out, with the tool that finds it, so a partial index is honest rather than silently short.
const AI_SEED_CAP_DEFAULT = 72000;
let aiSeedSize = 0, aiSeedOmitted = [];

async function aiBuildSeed(cap) {
  cap = Math.max(4000, Number(cap) || AI_SEED_CAP_DEFAULT);
  const g = await ensureGraph();
  const nodes = Object.values(g.nodes).sort((a, b) => (a.namespace + '.' + a.name).localeCompare(b.namespace + '.' + b.name));
  let funcs = `## Function index (${nodes.length})\n(NNNL = source lines, Nc = outbound API calls: invokeurl + Zoho service tasks)\n`;
  nodes.forEach((n) => { const used = [...new Set((n.associated_place || []).map((p) => p._type).filter(Boolean))]; funcs += `- ${n.namespace}.${n.name}${n.rest ? ' [REST]' : ''}${used.length ? ' [' + used.join('/') + ']' : ''}${n.stats ? ` ${n.stats.lines}L ${n.stats.apiCalls}c` : ''}\n`; });

  const mods = await loadModuleFiles(); const mk = Object.keys(mods).sort();
  // Marked in the index too, so a module Zoho refused is known to be unknowable before it is asked
  // about, rather than at the moment the answer would already have been guessed.
  const modules = `\n## Modules (${mk.length})\n` + mk.map((k) => '- ' + k + (mods[k] && mods[k].unreadable ? ' [not described by Zoho - fields, layouts and relations were never read]' : '')).join('\n') + '\n';

  const conns = await aiLoadConnections();
  const connections = conns.length
    ? `\n## Connections (${conns.length})\n` + conns.slice().sort((a, b) => b.uses.length - a.uses.length).map((c) => `- ${c.name}${c.connector ? ' [' + c.connector + ']' : ''} \u00b7 used by ${c.uses.length} function(s)${c.connected === false ? ' \u00b7 NOT CONNECTED' : ''}${c.missing ? ' \u00b7 not in catalogue' : ''}`).join('\n') + '\n'
    : '';

  // The actions are a vocabulary too: without their names the model cannot answer «which rule sends
  // the renewal notice» except by opening rules one at a time. Counts by kind, not the whole list -
  // an org can have hundreds, and `list_actions` is one call away.
  const acts = await aiLoadActions();
  const byKind = {};
  acts.list.forEach((a) => (byKind[a.kind] = (byKind[a.kind] || 0) + 1));
  const unattached = acts.list.filter((a) => !a.associated && !(acts.users.get(a.kind + ':' + String(a.id)) || []).length).length;
  const actions = acts.list.length
    ? `\n## Automation actions (${acts.list.length})\n`
      + Object.keys(byKind).sort().map((k) => `- ${actionKindLabel(k)}: ${byKind[k]}`).join('\n')
      + (unattached ? `\n- attached to no rule: ${unattached} (a candidate, not a verdict - Zoho answers for the rules it knows)` : '')
      + '\nUse `list_actions` for names, what each writes or sends, and which rules fire it.\n'
    : '';

  const omitted = [];
  let out = funcs;
  if (out.length + modules.length <= cap) out += modules; else omitted.push(`the ${mk.length} module names`);
  if (out.length + actions.length <= cap) out += actions; else if (actions) omitted.push(`the ${acts.list.length} automation actions`);
  if (out.length + connections.length <= cap) out += connections; else if (connections) omitted.push(`the ${conns.length} connections`);
  aiSeedOmitted = omitted;
  if (out.length > cap) {                 // even the function list alone overflows
    aiSeedOmitted = ['part of the function index - this org is larger than the index can hold'];
    out = aiTrunc(out, cap);
  }
  aiSeedTruncated = omitted.length > 0 || out.length >= cap;
  if (omitted.length) {
    out += `\nNOT LISTED ABOVE: ${omitted.join(' and ')}. They exist and can be fetched by name`
      + ` (list_functions, get_module, get_connection) - do not assume something is absent because`
      + ` it is not in this index.\n`;
  }
  aiSeedSize = out.length;
  return out;
}

// What the user is looking at, whatever kind of thing it is.
//
// This existed for Deluge functions only. Select a workflow, open the assistant, ask "what does this
// do?" and it answered that it had no reference and asked for details - while the same question
// about a function worked. `currentPath` was already being set by every tab; only this read it for
// one of them. Adding a tab and not extending the focus is the "one of a set" miss the conventions
// warn about, and it is invisible until someone asks the obvious question.
//
// The non-function kinds are serialised from the data actually captured rather than described field
// by field. Naming fields here would be a second description of each shape, free to drift from the
// pull that produces it - and inventing one that does not exist is how an assistant ends up
// confidently discussing something that was never there.
async function aiFocus() {
  const p = currentPath;
  if (!p) return '';
  const block = (what, body, lang) =>
    `\n# CURRENT FOCUS\nThe user is looking at ${what}. Answer about this unless they say otherwise.\n`
    + '```' + (lang || 'json') + '\n' + body + '\n```\n';
  try {
    if (p.endsWith('.dg')) {
      const g = await ensureGraph();
      const n = Object.values(g.nodes).find((x) => x.file === p);
      if (n) return block(`the Deluge function ${n.namespace}.${n.name}`, aiTrunc(n.source_code || '', 5000), 'deluge');
      return '';
    }
    if (p.startsWith('workflows/')) {
      const e = workflowData.find((x) => x.path === p);
      // The list entry is the index - name, module, type. What the workflow *does* is its conditions
      // and actions, and those live in the file, which is exactly what "what does this do?" asks for.
      let detail = null;
      try { detail = JSON.parse(await readFile(p)); } catch (_) {}
      if (detail || e) {
        return block(`the workflow «${(e && e.name) || (detail && detail.name) || '?'}»`,
          aiTrunc(JSON.stringify(detail || e, null, 2), 6000))
          + (detail ? '' : '\nOnly the index entry is on disk for this workflow; its conditions and actions have not been pulled.\n');
      }
    }
    if (p.startsWith('schedules/')) {
      const e = scheduleData.find((x) => x.path === p);
      if (e) return block(`the schedule «${e.name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 3000));
    }
    if (p.startsWith('connections/')) {
      const e = connectionData.find((x) => x.path === p);
      if (e) return block(`the connection «${e.label || e.name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 3000));
    }
    // The «one of a set» miss, again: every other kind had a branch here and this one did not, so
    // selecting an action and asking «what does this do?» got «I have no reference» while the same
    // question about a function worked. What fires it is the half of the answer that is not in the
    // row itself, so it travels with it.
    if (p.startsWith('actions/')) {
      const e = actionData.find((x) => x.path === p);
      if (e) {
        if (!actionUsers) actionUsers = await buildActionUsers();   // the chat may be the first thing opened
        const fired = actionFiredBy(e);
        // The sender address obeys the same setting here as in the index and in both exports. A
        // focus block that carried it regardless would let the address out through the one door
        // nobody thought to close - and the whole point of that switch is that it has one meaning.
        const { addresses } = await aiLoadActions();
        const shown = { ...e, fired_by: fired.map((r) => r.name || r.id) };
        if (!addresses && shown.from_address) shown.from_address = '(withheld - Settings can let the assistant see sender addresses)';
        return block(`the ${actionKindLabel(e.kind).toLowerCase().replace(/s$/, '')} \u00ab${e.name || e.id}\u00bb`,
          aiTrunc(JSON.stringify(shown, null, 2), 4000))
          + (fired.length ? '' : (e.associated
            ? '\nZoho reports it as in use, but no rule on disk names it - the rule that uses it may not have been pulled.\n'
            : '\nNo workflow rule on disk fires this action.\n'));
      }
    }
    if (p.startsWith('modules/')) {
      const e = moduleData.find((x) => x.path === p);
      if (e) {
        const ref = moduleRefusal(e.unreadable);
        return block(`the module «${e.label || e.api_name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 6000))
          + (ref ? `\n${ref.text} Its fields, layouts and relations are absent because they were never read, not because there are none.\n` : '');
      }
    }
  } catch (_) { /* a focus that cannot be built is simply absent: never a reason to fail the chat */ }
  return '';
}

// The extension's own help, so "how do I export this?" is answered where the user already is
// rather than by sending them to a website - which would move the question rather than answer it.
// Guarded: a missing script must cost the product primer, never the whole assistant.
function productHelp() {
  try { return '\n' + window.ZOOST_PRODUCT_HELP.text() + '\n'; } catch (_) { return ''; }
}

async function aiSystemPromptB(withTools, cap) {
  const seed = await aiBuildSeed(cap);
  const focus = await aiFocus();
  const toolsLine = withTools
    ? 'You have READ-ONLY tools to explore the real org: list_functions, get_function, who_calls, get_callees, search_code, get_module, list_workflows, get_workflow, get_connection, list_failures. Use them to fetch exact code/schema instead of guessing or inventing. The ORG INDEX lists what exists - call tools for the details you need.'
    : 'Answer from the ORG INDEX and CURRENT FOCUS below. If you need code that is not shown, say which function/module you would need rather than inventing it.';
  return `You are an expert assistant for Zoho CRM Deluge scripting and Zoho CRM architecture, working on the user\'s real org.\n${toolsLine}\nBe precise, reference real function/module names, and follow Deluge best practices (avoid API calls in loops, guard null access, avoid hardcoded IDs).\n${productHelp()}${focus}\n# ORG INDEX\n${seed}`;
}
const AI_TOOLS = [
  // The one tool that reads a runtime rather than a structure, so its answer carries the date it was
  // read. It cannot return the input of a failed execution: that never reaches the panel.
  { name: 'list_failures', description: 'What Zoho reports as failing: the function, what invoked it (Rest API, Workflow, Button, Schedule), the reason with its line number, how many times, and when it last failed - plus how many runs and failures Zoho counted in the 24 hours before the reading, how often the busiest functions ran, and what the org spent against its ceiling. The run counts are a top list, not a census: a function absent from it was not in the busiest few, which is not the same as never having run. Says the date it was read, because this changes hourly. It cannot return the input of a failed execution: Zoost does not read it.', input_schema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'list_functions', description: 'List workspace functions with their size and outbound-call counts. Optionally filter by a substring of "namespace.name", and/or by thresholds (min_lines, min_calls) - use the thresholds to answer "how many functions are longer than N lines" exactly, instead of counting by hand. Sorted by lines, longest first.', input_schema: { type: 'object', properties: { filter: { type: 'string' }, min_lines: { type: 'number' }, min_calls: { type: 'number' } } } },
  { name: 'get_function', description: 'Full Deluge source and metadata of a function identified by "namespace.name" (or just its name).', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'who_calls', description: 'List functions that call the given function.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_callees', description: 'List functions called by the given function.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'search_code', description: 'Full-text search across all function sources; returns "namespace.name:line" matches.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_module', description: 'Field schema of a module by api_name.', input_schema: { type: 'object', properties: { api_name: { type: 'string' } }, required: ['api_name'] } },
  { name: 'get_connection', description: 'A connection by name (the string used in invokeurl [...connection:"..."]): its connector, status, scopes, and every function that uses it.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_workflow', description: 'A workflow by id or name: trigger, status, last execution, how many instant and scheduled actions it has and after how long, and the functions it calls.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'list_actions', description: 'List what workflow rules fire: email notifications, field updates, tasks and webhooks. Each is an object of its own in Zoho, reused across rules. Filter by kind, by module, and by unused - use unused to answer "what is attached to nothing" exactly, which is the question this list exists for. A field update says which field it writes and what value.', input_schema: { type: 'object', properties: { kind: { type: 'string' }, module: { type: 'string' }, unused: { type: 'boolean' } } } },
  { name: 'list_workflows', description: 'List workflow rules with their instant/scheduled action counts and last execution. Filter by module, by active, and by has_scheduled_actions - use that last one to answer "which and how many workflows have actions that do not run immediately" exactly, instead of opening them one by one.', input_schema: { type: 'object', properties: { module: { type: 'string' }, active: { type: 'boolean' }, has_scheduled_actions: { type: 'boolean' } } } },
];
// A tool that answers with nine hundred lines has not answered. Cap the list, say how many there
// were, and say how to narrow - the model can then ask a better question instead of drowning in the
// first one.
function aiCap(lines, total, how, limit = 120) {
  if (lines.length <= limit) return lines.join('\n');
  return lines.slice(0, limit).join('\n')
    + `\n… and ${total - limit} more (${total} in all). ${how}`;
}

async function aiExecTool(name, input) {
  const g = await ensureGraph(); const nodes = g.nodes; input = input || {};
  const findFn = (q) => { if (!q) return null; if (nodes[q]) return nodes[q]; const low = String(q).toLowerCase(); return Object.values(nodes).find((n) => (n.namespace + '.' + n.name).toLowerCase() === low || (n.name || '').toLowerCase() === low || (n.api_name || '').toLowerCase() === low); };
  if (name === 'list_functions') {
    const flt = (input.filter || '').toLowerCase();
    const minL = Number(input.min_lines) || 0, minC = Number(input.min_calls) || 0;
    const rows = Object.values(nodes)
      .map((n) => ({ id: n.namespace + '.' + n.name, s: n.stats || { lines: 0, apiCalls: 0 } }))
      .filter((r) => (!flt || r.id.toLowerCase().includes(flt)) && r.s.lines >= minL && r.s.apiCalls >= minC)
      .sort((a, b) => b.s.lines - a.s.lines || a.id.localeCompare(b.id));
    const crit = [flt ? `name contains "${input.filter}"` : '', minL ? `>= ${minL} lines` : '', minC ? `>= ${minC} outbound calls` : ''].filter(Boolean).join(', ') || 'all';
    if (!rows.length) return `0 functions match (${crit}). Total in workspace: ${Object.keys(nodes).length}.`;
    return `${rows.length} function(s) match (${crit}); ${Object.keys(nodes).length} in the workspace.\n`
      + rows.map((r) => `${r.id} - ${r.s.lines} lines, ${r.s.apiCalls} calls`).join('\n');
  }
  if (name === 'get_function') { const n = findFn(input.name); if (!n) return MSG.noFn + input.name; return `namespace.name: ${n.namespace}.${n.name}\napi_name: ${n.api_name || ''}\nreturns: ${n.return_type || ''}  REST: ${!!n.rest}\ncalls: ${(n.calls || []).join(', ') || '(none)'}\ncalled_by: ${(n.called_by || []).join(', ') || '(none)'}\nused_in: ${(n.associated_place || []).map((p) => p._type).join(', ') || '(none)'}\nconnections: ${(n.connections || []).map((c) => c.name).join(', ') || '(none)'}\nreads_modules: ${(n.modules || []).filter((m) => m.mode === 'read').map((m) => m.name).join(', ') || '(none)'}\nwrites_modules: ${(n.modules || []).filter((m) => m.mode === 'write').map((m) => m.name).join(', ') || '(none)'}${n.modulesUnknown ? `\nmodule_not_determinable_in: ${n.modulesUnknown} call(s)` : ''}\n${n.stats ? `size: ${n.stats.lines} lines (${n.stats.codeLines} code), ${n.stats.chars} chars\noutbound_calls: ${n.stats.apiCalls} (invokeurl ${n.stats.invokeurl}, zoho.crm ${n.stats.crm}, other Zoho ${n.stats.zoho}, sendmail ${n.stats.sendmail})\n` : ''}last_modified: ${n.modified_by ? 'by ' + n.modified_by : ''}${n.updatedTime ? ' ' + String(n.updatedTime).slice(0, 16) : ''}\n\n${n.source_code || ''}`; }
  if (name === 'who_calls') { const n = findFn(input.name); return n ? ((n.called_by || []).join('\n') || '(no callers)') : MSG.noFn + input.name; }
  if (name === 'get_callees') { const n = findFn(input.name); return n ? ((n.calls || []).join('\n') || '(no callees)') : MSG.noFn + input.name; }
  if (name === 'search_code') { const q = (input.query || '').toLowerCase(); if (!q) return '(empty query)'; const hits = []; Object.values(nodes).forEach((n) => { const src = n.source_code || ''; const i = src.toLowerCase().indexOf(q); if (i >= 0) hits.push(`${n.namespace}.${n.name}:${src.slice(0, i).split('\n').length}`); }); return hits.length ? aiCap(hits, hits.length, 'Use a longer or more specific substring.', 60) : '(no matches)'; }
  if (name === 'get_module') { const mods = await loadModuleFiles(); const m = mods[input.api_name] || Object.values(mods).find((x) => (x.api_name || '').toLowerCase() === String(input.api_name).toLowerCase()); return m ? aiModuleText(m) : 'Module not found: ' + input.api_name; }
  if (name === 'list_failures') {
    let d = null; try { d = JSON.parse(await readFile('failures/index.json')); } catch (_) {}
    if (!d || !Array.isArray(d.failures)) return 'No failures have been read yet - the user runs "Pull all" or the Failures tab to fetch them.';
    const q = String(input.filter || '').toLowerCase();
    const rows = d.failures.filter((f) => !q || (f.name || '').toLowerCase().includes(q) || (f.reason || '').toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count);
    const head = `read from Zoho on ${d.at || '(unknown date)'}`
      + (d.usage ? `; in the 24 hours before that: ${d.usage.success ?? 'unknown'} run(s), ${d.usage.failure ?? 'unknown'} failed` : '')
      + (d.credits ? `; ${d.credits.used ?? 'unknown'} counted against a ceiling of ${d.credits.limit ?? 'unknown'}` : '')
      + (Array.isArray(d.runs) && d.runs.length
          ? `. Busiest in that window (a top list, not every function): ${d.runs.slice(0, 8).map((r) => `${r.name} ${r.count}\u00d7`).join(', ')}` : '')
      + '. The input of each failed run stays in Zoho and is not available here.';
    if (!rows.length) return head + '\nNothing matched.';
    return head + '\n' + aiCap(rows.map((f) => `${f.name} \u00b7 ${f.componentType || '?'} \u00b7 ${f.count}\u00d7 \u00b7 last ${f.lastFailedAt || '?'} \u00b7 ${f.reason || ''}`),
      rows.length, 'Pass a filter to narrow by function name or reason.');
  }
  if (name === 'get_connection') {
    const list = await aiLoadConnections();
    const q = String(input.name || '').toLowerCase();
    const c = list.find((x) => (x.name || '').toLowerCase() === q) || list.find((x) => (x.label || '').toLowerCase() === q);
    if (!c) return 'Connection not found: ' + input.name + (list.length ? '\nKnown: ' + list.map((x) => x.name).join(', ') : '\n(no connections pulled - run Pull all)');
    return `connection: ${c.name}\nlabel: ${c.label || ''}\nconnector: ${c.connector || '(unknown)'}\n`
      + `status: ${c.missing ? 'referenced by functions but NOT in the catalogue' : c.connected === false ? 'configured but NOT connected' : 'connected'}\n`
      + `created_by: ${c.createdBy || ''}\nscopes: ${(c.scopes || []).join(', ') || '(none)'}\n`
      + `used_by (${c.uses.length}): ${c.uses.join(', ') || '(none - unused by the functions in this workspace; Flow, widgets and client scripts are not visible to Zoost)'}`;
  }
  if (name === 'list_workflows' || name === 'get_workflow') {
    // Both read the rules on disk rather than the index alone: the list endpoint returns neither the
    // scheduled actions nor the last execution, so an answer built from `workflows/index.json` would have been
    // confidently wrong about exactly the question this exists to answer.
    let idx = []; try { idx = JSON.parse(await readFile('workflows/index.json')); } catch (_) {}
    if (!idx.length) return '(no workflows in this workspace - run Pull all)';
    const rows = [];
    let unread = 0;
    for (const w of idx) {
      let det = null; try { det = JSON.parse(await readFile(`workflows/${w.id}.json`)); } catch (_) {}
      if (!det) unread++;
      const s = wfScheduled(det);
      const fns = []; const instant = [];
      ((det && det.conditions) || []).forEach((c) => {
        const ia = (c.instant_actions && c.instant_actions.actions) || [];
        ia.forEach((a) => { instant.push(a); if (isFnAction(a)) fns.push(a.name); });
        (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) =>
          (sa.actions || []).forEach((a) => { if (isFnAction(a)) fns.push(a.name); }));
      });
      rows.push({ w, det, read: !!det, sched: s.count, delays: s.delays, instant: instant.length,
                  fns: [...new Set(fns)], last: (det && det.last_executed_time) || null });
    }
    if (name === 'get_workflow') {
      const q = String(input.query || '').toLowerCase();
      const r = rows.find((x) => String(x.w.id) === input.query || (x.w.name || '').toLowerCase() === q)
             || rows.find((x) => (x.w.name || '').toLowerCase().includes(q));
      if (!r) return 'Workflow not found: ' + input.query;
      return `Workflow: ${r.w.name}\nmodule: ${r.w.module || ''}\ntrigger: ${r.w.type || ''}\n`
        + `status: ${r.w.active ? 'active' : 'inactive'}\n`
        + `last_executed: ${r.last || '(never, or not reported by Zoho)'}\n`
        + `instant_actions: ${r.instant}\n`
        + `scheduled_actions: ${r.sched}${r.sched && r.delays.length ? ' - after ' + r.delays.join(', ') : ''}\n`
        + `functions: ${r.fns.join(', ') || '(none)'}`
        + (r.read ? '' : '\nNOTE: this rule has not been downloaded, so the action and execution figures above are absent, not zero.');
    }
    const want = input.has_scheduled_actions;
    const act = input.active;
    const mod = String(input.module || '').toLowerCase();
    let sel = rows;
    if (want === true) sel = sel.filter((r) => r.sched > 0);
    if (want === false) sel = sel.filter((r) => r.read && r.sched === 0);
    if (act === true) sel = sel.filter((r) => r.w.active);
    if (act === false) sel = sel.filter((r) => !r.w.active);
    if (mod) sel = sel.filter((r) => (r.w.module || '').toLowerCase() === mod);
    const crit = [want === true ? 'with scheduled actions' : want === false ? 'without scheduled actions' : '',
                  act === true ? 'active' : act === false ? 'inactive' : '',
                  mod ? `module ${input.module}` : ''].filter(Boolean).join(', ') || 'all';
    const head = `${sel.length} workflow(s) match (${crit}); ${idx.length} in the workspace.`
      + (unread ? ` ${unread} rule(s) have not been downloaded, so they are counted as unknown rather than as zero - press «Complete missing» in the panel.` : '');
    if (!sel.length) return head;
    const lines = sel.map((r) =>
      `${r.w.name}${r.w.module ? ' [' + r.w.module + ']' : ''}${r.w.active ? '' : ' (inactive)'}`
      + ` - ${r.sched} scheduled${r.sched && r.delays.length ? ' (' + r.delays.join(', ') + ')' : ''}`
      + `, ${r.instant} instant${r.last ? ', last run ' + String(r.last).slice(0, 16) : ''}`);
    return head + '\n' + aiCap(lines, sel.length, 'Narrow with `module`, `active` or `has_scheduled_actions`.');
  }
  if (name === 'list_actions') {
    const acts = await aiLoadActions();
    if (!acts.list.length) return 'No automation actions in this workspace - they are pulled with «Pull all» or from the Actions tab.';
    const kind = String(input.kind || '').toLowerCase().replace(/[\s-]/g, '_');
    let sel = acts.list;
    if (kind) sel = sel.filter((a) => a.kind === kind || actionKindLabel(a.kind).toLowerCase() === String(input.kind).toLowerCase());
    if (input.module) sel = sel.filter((a) => (a.module || '').toLowerCase() === String(input.module).toLowerCase());
    if (input.unused === true) sel = sel.filter((a) => !(acts.users.get(a.kind + ':' + String(a.id)) || []).length && !a.associated);
    if (input.unused === false) sel = sel.filter((a) => (acts.users.get(a.kind + ':' + String(a.id)) || []).length || a.associated);
    const crit = [kind ? 'kind ' + kind : '', input.module ? 'module ' + input.module : '',
                  input.unused === true ? 'attached to nothing' : input.unused === false ? 'in use' : ''].filter(Boolean).join(', ') || 'all';
    const head = `${sel.length} action(s) match (${crit}); ${acts.list.length} in the workspace.`;
    if (!sel.length) return head;
    // The sender address is deliberately absent unless the user turned it on: this text is sent to a
    // provider, and «which address» is a fact about a person in a way «a user address» is not.
    const lines = sel.map((a) => {
      const users = acts.users.get(a.kind + ':' + String(a.id)) || [];
      const extra = a.kind === 'field_updates'
        ? ` writes ${a.field || '?'} <- ${actStale(a) ? 'not read by this pull' : (a.value === null || a.value === undefined) ? 'cleared' : a.value}`
        : a.kind === 'email_notifications'
          ? ` template ${(a.template && a.template.name) || '?'}${acts.addresses && a.from_address ? ', from ' + a.from_address : a.from_type ? ', from ' + (a.from_type === 'user' ? 'a user address' : 'an organisation address') : ''}`
          : a.kind === 'webhooks' ? ` ${a.method || ''} ${a.url || ''}` : '';
      return `${a.name} [${a.kind}]${a.module ? ' on ' + a.module : ''} - fired by ${users.length} rule(s)${users.length ? ': ' + users.map((w) => w.name).join(', ') : ''}${extra}`;
    });
    return head + '\n' + aiCap(lines, sel.length, 'Narrow with `kind`, `module` or `unused`.');
  }
  return 'Unknown tool: ' + name;
}
function aiMarkdown(src) {
  const codes = [];
  let t = escHtml(src == null ? '' : src);
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => { codes.push('<pre class="aicode">' + code.replace(/\n+$/, '') + '</pre>'); return '\uE000' + (codes.length - 1) + '\uE001'; });
  t = t.replace(/`([^`\n]+)`/g, (m, c) => { codes.push('<code>' + c + '</code>'); return '\uE000' + (codes.length - 1) + '\uE001'; });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>');
  t = t.replace(/^\s*[-*]\s+(.*)$/gm, '\u2022 $1');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\n/g, '<br>');
  t = t.replace(/\uE000(\d+)\uE001/g, (m, i) => codes[+i]);
  return t;
}
function aiToolArg(input) { try { const s = JSON.stringify(input || {}); return s.length > 60 ? s.slice(0, 57) + '\u2026' : s; } catch (_) { return ''; } }
function aiToolEvent(name, input) { aiMessages.push({ role: 'tool', content: `\ud83d\udd27 ${name}(${aiToolArg(input)})` }); aiRenderMessages(); }
async function aiStreamAnthropic(a, msgs, system, tools, onText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': a.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: a.model, max_tokens: 4096, system, tools, messages: msgs, stream: true }) });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${aiTrunc(await res.text(), 300)}`);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const blocks = []; let stop_reason = null;
  const handle = (evt, data) => {
    if (evt === 'content_block_start') { blocks[data.index] = data.content_block.type === 'tool_use' ? { type: 'tool_use', id: data.content_block.id, name: data.content_block.name, _json: '' } : { type: 'text', text: '' }; }
    else if (evt === 'content_block_delta') { const b = blocks[data.index]; if (!b) return; if (data.delta.type === 'text_delta') { b.text += data.delta.text; onText && onText(data.delta.text); } else if (data.delta.type === 'input_json_delta') { b._json += data.delta.partial_json || ''; } }
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
  const content = blocks.filter(Boolean).map((b) => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : { type: 'text', text: b.text }).filter((b) => b.type !== 'text' || (b.text && b.text.trim() !== ''));
  return { content, stop_reason };
}
async function aiRunAnthropicAgent(a, apiMessages, system, tools, maxIter) {
  const msgs = apiMessages.slice();
  for (let iter = 0; iter < maxIter; iter++) {
    let bubble = null, el = null;
    const onText = (t) => {
      if (!bubble) { bubble = { role: 'assistant', content: '' }; aiMessages.push(bubble); aiRenderMessages(); const ns = $('aimsgs').querySelectorAll('.aimsg.assistant .aitext'); el = ns[ns.length - 1]; }
      bubble.content += t; if (el) { el.innerHTML = aiMarkdown(bubble.content); $('aimsgs').scrollTop = $('aimsgs').scrollHeight; }
    };
    const { content, stop_reason } = await aiStreamAnthropic(a, msgs, system, tools, onText);
    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (stop_reason !== 'tool_use' || !toolUses.length) {
      if (!bubble) { const txt = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); aiMessages.push({ role: 'assistant', content: txt || '(empty response)' }); aiRenderMessages(); }
      return;
    }
    msgs.push({ role: 'assistant', content });
    const results = [];
    for (const tu of toolUses) { aiToolEvent(tu.name, tu.input); let out; try { out = await aiExecTool(tu.name, tu.input); } catch (e) { out = 'Error: ' + e.message; } results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) }); }
    msgs.push({ role: 'user', content: results });
  }
  aiMessages.push({ role: 'assistant', content: `(Reached the tool-step limit of ${maxIter}. Raise it in Settings or ask something more specific.)` }); aiRenderMessages();
}

async function aiCall(cfg, messages, system) {
  const o = cfg.openai;
  const base = OPENAI_BASE;   // fixed: the manifest only grants host access to this endpoint
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const post = async (limitField) => fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
    body: JSON.stringify({ model: o.model, messages: msgs, [limitField]: 4096 }),
  });
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
  return txt;
}
let aiBusy = false;
function aiRenderMessages() {
  const box = $('aimsgs');
  // **Absent, not present-and-pointless, when there is nothing to clear.** Every other control here
  // disappears rather than sitting there greyed: the retry button, the per-mode rows. This one stayed
  // on an empty conversation, offering to remove nothing. Reported by the author, who had written the
  // convention it was breaking.
  $('aiclear').style.display = aiMessages.length ? '' : 'none';

  if (!aiMessages.length && !aiBusy) { box.innerHTML = '<div class="aimsg assistant"><div class="aitext">Ask me anything about this org\'s Deluge - I can open functions, trace callers, read module schemas, and search the code.</div></div>'; return; }
  box.innerHTML = aiMessages.map((m) => m.role === 'tool' ? `<div class="aitool">${escHtml(m.content)}</div>` : `<div class="aimsg ${m.role}"><div class="airole">${m.role === 'user' ? 'You' : 'AI'}</div><div class="aitext">${m.role === 'assistant' ? aiMarkdown(m.content) : escHtml(m.content).replace(/\n/g, '<br>')}</div></div>`).join('')
    + (aiBusy ? '<div class="aiwait"><i></i><i></i><i></i> thinking\u2026</div>' : '');
  box.scrollTop = box.scrollHeight;
}
async function aiSend() {
  const cfg = await aiGetCfg();
  aiEngineChrome();
  if (aiLocked(cfg)) { aiShowLock(true); return; }
  if (!(await aiEnsureFiles())) { setStatus('Folder access needs re-granting - press \u21bb Refresh, then ask again.', 'warn'); return; }
  if (!aiActiveReady(cfg)) { aiOpenSettings(); setStatus('Set the model and API key in Settings (just opened), then try again.', 'warn'); return; }
  const inp = $('aiinput'); const text = inp.value.trim(); if (!text) return;
  inp.value = ''; aiMessages.push({ role: 'user', content: text });
  aiBusy = true; $('aisend').disabled = true; aiRenderMessages(); setStatus('AI thinking\u2026', 'busy');
  try {
    const apiMessages = aiMessages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim() !== '').map((m) => ({ role: m.role, content: m.content }));
    const withTools = cfg.active === 'anthropic';
    const system = await aiSystemPromptB(withTools, cfg.seedCap);
    // The org index sent to the model is capped. If it was cut, say so once - don't let the user
    // assume the model saw everything. Claude can still look things up; OpenAI (single-shot) cannot.
    if (aiSeedTruncated && !aiSeedWarned) {
      aiSeedWarned = true;
      const what = aiSeedOmitted.length ? aiSeedOmitted.join(' and ') : 'part of the index';
      aiMessages.push({ role: 'tool', content: `ℹ️ Large org: ${what} could not fit in the index sent with each message. `
        + (withTools ? 'Claude can still find them by name with its tools - the function list is always included in full.' : 'OpenAI answers in one pass and cannot look them up, so ask about specific functions by name.') });
      aiRenderMessages();
    }
    if (withTools) { await aiRunAnthropicAgent(cfg.anthropic, apiMessages, system, AI_TOOLS, cfg.maxIter || 20); }
    else { const reply = await aiCall(cfg, apiMessages, system); aiMessages.push({ role: 'assistant', content: reply || '(empty response)' }); }
    setStatus('', '');
  } catch (e) { aiMessages.push({ role: 'assistant', content: friendlyError(e) }); setStatus('AI error', 'warn'); }
  aiBusy = false; $('aisend').disabled = false;
  aiRenderMessages();
}
async function aiEngineChrome() {
  const b = $('aiengbadge'), note = $('ainote');
  if (!b || !note) return;
  const cfg = await aiGetCfg();
  aiShowLock(aiLocked(cfg));      // the chrome refresh is the one place that already re-reads the config
  if (cfg.active === 'anthropic') {
    b.textContent = 'Claude \u00b7 agent'; b.className = 'agent';
    note.className = 'ainote';
  } else {
    b.textContent = 'OpenAI \u00b7 single-shot'; b.className = 'single';
    $('ainotetxt').innerHTML = 'OpenAI answers in <b>one pass</b>: it sees the org index plus the function you have open, '
      + 'and cannot go and read other files by itself - so it will ask you for what it is missing. '
      + 'Switch to Claude in Settings for an agent that explores the whole workspace on its own.';
    note.className = 'ainote show';
  }
}
// The index is sent with *every* message, so its size is what each question costs before it has been
// asked. Showing it is the only way the setting that caps it can be a real choice rather than a
// number in a form: build it once, measure, and say so.
/** What the line above the chat says is focused. It read `.dg` and nothing else, so with a workflow,
 *  a module or an action open it announced that nothing was focused while aiFocus() was sending that
 *  item's detail with every message - the label contradicting the prompt, which is worse than a
 *  label that says nothing. Same one-of-a-set miss as the branches in aiFocus() itself, one line up.
 *  The name comes from the list that drew the row, so it is the name on screen. */
function aiFocusLabel() {
  const p = currentPath;
  if (!p) return null;
  if (p.endsWith('.dg')) return p.split('/').pop();
  const at = (arr, name) => { const e = (arr || []).find((x) => x.path === p); return e ? `${name} \u00ab${e.name || e.label || e.api_name || e.id}\u00bb` : null; };
  if (p.startsWith('workflows/')) return at(workflowData, 'workflow');
  if (p.startsWith('schedules/')) return at(scheduleData, 'schedule');
  if (p.startsWith('connections/')) return at(connectionData, 'connection');
  if (p.startsWith('modules/')) return at(moduleData, 'module');
  if (p.startsWith('actions/')) {
    const e = actionData.find((x) => x.path === p);
    return e ? `${actionKindLabel(e.kind).toLowerCase().replace(/s$/, '')} \u00ab${e.name || e.id}\u00bb` : null;
  }
  return null;
}
async function aiContextLabel() {
  const el = $('aictx'); if (!el) return;
  const what = aiFocusLabel();
  const focus = what ? 'Focus: ' + what
    : 'Nothing focused - open a function, a rule or an action to give the assistant its detail';
  let cost = '';
  try {
    const cfg = await aiGetCfg();
    await aiBuildSeed(cfg.seedCap);
    cost = ` \u00b7 sent with every message: ${((aiSeedSize + productHelp().length) / 1000).toFixed(0)}k characters, ~${Math.round((aiSeedSize + productHelp().length) / 4).toLocaleString()} tokens`
      + (aiSeedOmitted.length ? ` \u00b7 ${aiSeedOmitted.join(' and ')} left out` : '');
  } catch (_) {}
  el.textContent = focus + cost;
}
function toggleAI() {
  if ($('aiview').classList.contains('show')) { closeAI(); return; }
  if (!dir) return;
  closeHealth();   // one panel at a time
  $('aiview').classList.add('show'); $('askai').classList.add('on'); document.body.classList.add('ai-open'); aiEngineChrome(); aiRenderMessages();
  aiEnsureFiles().then(() => aiContextLabel());   // the label reads the mirror too, and fills in when its measurement lands
}
function closeAI() { $('aiview').classList.remove('show'); $('askai').classList.remove('on'); document.body.classList.remove('ai-open'); }
function aiClear() { if (!aiMessages.length) return; if (!window.confirm('Clear this conversation? Only you can clear it - switching workspace does it too, because the old thread was about another org.')) return; dropWorkspaceState(); }
// AI configuration lives in the options page now: the side panel is 400px wide and these are
// set-once fields. openSettings() focuses the one settings window; the panel picks the change up via
// chrome.storage.onChanged.
function aiOpenSettings() { openSettings('#ai'); }   // sent from the assistant, so land on its section

// ---------- save-sync ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'saved') syncOne(msg.id);
  if (msg?.type === 'pullProgress' && pullActive) setStatus(`Pulling… ${msg.done}/${msg.total}`, 'busy');
  // The diagram window asking for the other drawing. It has no folder access of its own - by design,
  // and it stays that way - so the graph is built here and left in storage for it to reload from.
  if (msg?.type === 'graphSwitch') { buildGraphFor(msg.kind).then(sendResponse); return true; }
});
async function buildGraphFor(kind) {
  try {
    if (!dir) throw new Error('no working folder is open in the panel');
    // ensurePerm only *asks* when the permission has lapsed, and asking needs a user gesture the
    // panel does not have here. If it has lapsed the switch stops and says so, rather than throwing
    // a DOMException whose message names neither the folder nor the remedy.
    if (!(await hasPerm(dir))) throw new Error('the working folder needs re-granting - click once in the panel');
    const g = kind === 'schema' ? await buildSchemaGraph() : await callGraphWithContext();
    if (!g.counts.nodes) throw new Error(kind === 'schema' ? 'no modules pulled yet' : 'no functions pulled yet');
    g.workspace = { instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null, label: bound?.label || null };
    await chrome.storage.session.set({ graphData: graphForWindow(g) });
    setStatus(`Diagram switched to ${kind === 'schema' ? 'modules' : 'functions'}.`, 'ok');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}
async function syncOne(id) {
  if (mismatchRefuse()) return;
  if (!dir || !(await hasPerm(dir))) return;
  await refreshContext();
  if (!guardOk()) { setStatus(`Save ignored: active ${envOf(lastCtx?.origin)}/org ${lastCtx?.org} ≠ workspace ${envOf(bound?.base)}/org ${bound?.org}.`, 'warn'); return; }
  const info = index.get(String(id));
  try {
    setStatus(`Save detected (${id}), syncing…`, 'busy');
    const r = await toBridge({ cmd: 'fetchOne', id, category: info?.category, source: info?.source });
    if (!r?.ok || !r.file) throw new Error(r?.error || 'detail not found');
    const f = r.file;
    await writeFile(`functions/${f.folder}/${f.stem}.dg`, f.dg); await writeFile(`functions/${f.folder}/${f.stem}.meta.json`, JSON.stringify(f.meta, null, 2));
    const ent = treeData.find((x) => x.id === String(id));
    if (ent) { ent.path = `functions/${f.folder}/${f.stem}.dg`; ent.downloaded = true; ent.error = false; updateRow(ent); updateMissingButton(); } else { await rebuildTree(); }
    if (currentPath === `functions/${f.folder}/${f.stem}.dg`) await openFile(currentPath);
    setStatus(`Synced: functions/${f.folder}/${f.stem}.dg`, 'ok');
  } catch (e) { setStatus(`Sync failed for ${id}: ${e.message}`, 'warn'); }
}

// ---------- workspaces ----------
// One "working folder" is picked once. Inside it, each Zoost product keeps its own subfolder, and
// each workspace lives one level below that:
//
//   <working folder>/crm/<instance>[-sandbox]-<orgid>/
//   <working folder>/analytics/<project>/
//
// One folder can therefore serve every Zoost product without the two ever colliding, and the root
// says what it holds at a glance. The folder NAME is only a label: identity is the org id inside
// each `.zoost.json`, so renaming a Zoho portal (or the folder) never orphans a workspace.
const APP_DIR = 'crm';                       // this app's subfolder
const APP_DIRS = ['crm', 'analytics'];       // known product folders - not "foreign" content
let root = null, rootGranted = false;
// True when the workspace on screen still has the pre-1.13 folders. Nothing reads them - it is
// there so the empty state can name the real reason instead of saying «nothing pulled yet» about
// a folder that is visibly full.
let oldLayout = false;
/** Why a list is empty, in the order the states actually block each other.
 *
 * An empty state is never silent here: it says what is missing and what to do. Saying the *wrong*
 * missing thing is worse than silence, because the reader goes and does it and nothing changes - and
 * it is usually the step they have already done that gets repeated at them. Returns null when the
 * blocker really is that nothing has been pulled, so each tab can name its own thing.
 *
 * Word for word the Analytics panel's, because the first three states are the same product.
 */
/** Put the blocker on screen. Called from every early return in loadWorkspaces, because that is
 *  exactly where the panel used to leave whatever the previous state had drawn - and with a lapsed
 *  permission it drew nothing at all, so the CRM said in the status line what Analytics said in the
 *  list and the two looked like different products. */
function renderBlocked() {
  const t = $('tree'); if (!t) return;
  const why = emptyReason();
  t.innerHTML = why ? `<div class="empty">${why}</div>` : '';
}

function emptyReason() {
  if (!root) {
    return '<b>No working folder yet.</b> Press <b>\u{1F4C1} Set working folder\u2026</b> above and pick a '
      + 'dedicated, empty folder. Every workspace lives inside it.';
  }
  if (!rootGranted) {
    return '<b>Folder access is not granted.</b> Press <b>\u{1F513} Grant access</b> above - or simply '
      + 'click anywhere in this panel, which does the same. One click, no folder picker.';
  }
  if (!wsList.length) {
    return '<b>No workspace here yet.</b> Open a Zoho CRM tab and press <b>+</b> to create the workspace '
      + 'for that org - or press <b>+ Sample</b> to write one of invented data and look around first. '
      + 'The sample never contacts Zoho, and it is deleted like any other workspace.';
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
  if (oldLayout) {
    // Not a migration and not a fallback: nothing here reads the old paths. It is an empty state
    // telling the truth, the same way the older flat working-folder layout is reported rather than
    // adopted - «nothing pulled yet» would be a lie about a folder that is plainly full.
    return '<b>This workspace uses the old folder layout.</b> Functions now live under '
      + '<b>functions/</b> and the other folders lost their leading underscore. Press <b>Pull all</b> '
      + 'to write it again in the new shape - nothing is fetched twice that you already have '
      + '- then delete the old <b>_index</b>, <b>_modules</b>, <b>_layouts</b>, <b>_workflows</b>, '
      + '<b>_schedules</b> and <b>_connections</b> folders, and the namespace folders sitting beside '
      + 'them. Zoost never deletes files it did not just write.';
  }
  return null;
}
/** Does this workspace still carry the folders from before the layout was regularised?
 *
 * Only the names are looked at, and only at the top level: a workspace written by 1.13 or later has
 * none of them, and one written before has several. It is deliberately not a fallback - no reader
 * anywhere knows the old paths - and there is no automatic migration: a re-pull writes the new shape
 * and the old folders are the user's to delete, because Zoost does not remove files it did not write.
 */
const OLD_DIRS = ['_index', '_modules', '_layouts', '_workflows', '_schedules', '_connections'];
async function hasOldLayout(h) {
  if (!h) return false;
  try {
    for await (const e of h.values()) if (e.kind === 'directory' && OLD_DIRS.includes(e.name)) return true;
  } catch (_) { /* unreadable: not a claim either way */ }
  return false;
}

// Resolved on demand rather than cached: the handle must stay valid across permission lapses.
async function appRoot(create) {
  if (!root) return null;
  try { return await root.getDirectoryHandle(APP_DIR, { create: !!create }); } catch (_) { return null; }
}
const wsFolderName = (ctx) => `${sanitize(ctx.instance || 'workspace')}${envOf(ctx.origin) === 'sandbox' ? '-sandbox' : ''}-${sanitize(ctx.org || 'org')}`;
async function readJsonIn(h, name) { const fh = await h.getFileHandle(name); return JSON.parse(await (await fh.getFile()).text()); }

// Two groups, because they answer different questions. The local ones work on what is already on
// disk and are fine on a sample workspace; the two that read from Zoho are not, and were left
// enabled - reported. `pull` is also disabled by refreshContext on every state change, and
// `pullone` was the one nothing else covered.
function setEnabled(on) {
  LOCAL_BTNS.forEach((b) => ($(b).disabled = !on));
  ZOHO_BTNS.forEach((b) => ($(b).disabled = !on || isSample()));
}

// Re-granting access to a folder we already know must NOT reopen the file picker: a lapsed
// permission is not a request to choose a different folder. This is one click, no OS dialog.
async function grantRoot() {
  if (!root) { await pickRoot(); return; }
  try {
    if (!(await ensurePerm(root))) { setStatus('Access denied - Zoost cannot read the working folder.', 'bad'); return; }
    rootGranted = true;
    setStatus(`Access granted to ${root.name}.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Grant failed: ' + e.message, 'bad'); }
}
async function pickRoot() {
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'zoost-root' });
    if (!(await ensurePerm(h))) return;
    // Blast radius: granting readwrite covers everything below this folder, permanently.
    let foreign = 0, seen = 0;
    for await (const e of h.values()) {
      if (++seen > 80) break;
      if (e.kind !== 'directory') { foreign++; continue; }
      if (APP_DIRS.includes(e.name)) continue;              // a product folder - this is our own layout
      try { await e.getFileHandle(CFG); } catch (_) { foreign++; }   // a workspace from the older flat layout
    }
    if (foreign > 6 && !confirm(`\u00ab${h.name}\u00bb already contains ${foreign} items that are not Zoost workspaces.\n\n`
      + `Zoost will hold read/write access to everything inside it, permanently. A dedicated folder is strongly recommended.\n\nUse this folder anyway?`)) return;
    root = h; rootGranted = true; await window.idbHandle.set('rootDir', h);
    setStatus(`Working folder: ${h.name}`, 'ok');
    await loadWorkspaces();
  } catch (e) { if (e?.name !== 'AbortError') setStatus('Working folder: ' + e.message, 'warn'); }
}

/** Write the sample workspace into the working folder, then open it.
 *
 * It goes through the same code every other workspace does - the files land on disk and the ordinary
 * list picks them up - so nothing downstream has to know it exists. `sample: true` in .zoost.json is
 * the whole mechanism.
 */
// Whether a sample workspace exists, kept where it can be read **without the folder handle**.
//
// This is the bug that took three reports to find, and the diagnosis was mine to make. Until the
// folder permission is granted, loadWorkspaces() returns before it enumerates anything, so `wsList`
// is empty and the panel cannot tell a sample apart from no sample - it offered to create one that
// was sitting right there. Chrome drops that permission between sessions, so the state right after
// the panel opens is exactly the state where the question is asked.
//
// Same shape as `tabAccessView`, and for the same reason: a display-only copy of a fact, in
// chrome.storage.local, for a surface that cannot reach the folder. The folder stays the authority -
// this is only ever read into a label, and the *action* re-checks after granting.
let sampleWsKnown = null;
try { chrome.storage.local.get('sampleWs').then((v) => { sampleWsKnown = (v && v.sampleWs) || null; updateSampleButtons(); }); } catch (_) {}
function noteSampleWs(id) {
  sampleWsKnown = id || null;
  try { chrome.storage.local.set({ sampleWs: sampleWsKnown }); } catch (_) {}
}
/** The one the panel can act on, or - when the folder is not readable yet - the one it remembers. */
function knownSample() {
  const w = (wsList || []).find((x) => x.binding && x.binding.sample);
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
  // The overlay's copy covers the workspace list, so hiding it there would leave a sample on disk
  // unreachable. It changes what it says instead.
  const ob = $('offsample');
  if (ob) {
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
  if (sampleBusy) return;
  if (!root) { await pickRoot(); return; }
  // **Grant first, then decide.** A click is the only context in which the permission can be
  // re-requested, and until it is granted the panel cannot see what is in the folder - so deciding
  // before this line means deciding on a list that is empty for a reason unrelated to the question.
  if (!(await ensurePerm(root))) return;
  if (!rootGranted) { rootGranted = true; await loadWorkspaces(); }
  const have = (wsList || []).find((w) => w.binding && w.binding.sample);
  if (have) { $('ws').value = have.id; $('offoverlay').classList.remove('show'); return activate(have, true); }
  sampleBusy = true;
  // The overlay is opaque and covers the status line, so it comes down before the writing starts -
  // otherwise the progress is written where nobody can read it, which is what made pressing again
  // look like the reasonable thing to do.
  $('offoverlay').classList.remove('show');
  ['wssample', 'offsample'].forEach((b) => { const e = $(b); if (e) e.disabled = true; });
  try { await writeSampleWorkspace(); }
  finally {
    sampleBusy = false;
    ['wssample', 'offsample'].forEach((b) => { const e = $(b); if (e) e.disabled = false; });
  }
}
async function writeSampleWorkspace() {
  try {
    const gen = window.SAMPLE_ORG;
    if (!gen) { setStatus('The sample generator is not loaded.', 'bad'); return; }
    const base = await appRoot(true);
    if (!base) { setStatus(`Could not create the ${APP_DIR}/ folder inside the working folder.`, 'bad'); return; }
    const h = await base.getDirectoryHandle(gen.folderName(), { create: true });
    const files = gen.files({});
    const all = Object.entries(files);
    // Three hundred files through the File System Access API take long enough to look like a hang -
    // reported as exactly that. The count is what says it is working, so it is written often enough
    // to move and rarely enough not to be the cost itself.
    setStatus(`Writing the sample workspace - 0 of ${all.length} files\u2026`, 'busy');
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
        setStatus(`Writing the sample workspace - ${i + 1} of ${all.length} files \u00b7 ${rel.split('/')[0]}\u2026`, 'busy');
        await new Promise((r) => setTimeout(r, 0));   // let the status line actually paint
      }
    }
    await window.idbHandle.set('activeWs', 'org:' + gen.org);
    setStatus(`Sample workspace written - ${Object.keys(files).length} files in ${gen.folderName()}. Nothing was fetched from Zoho.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Could not write the sample: ' + e.message, 'bad'); }
}

async function addWorkspaceForTab() {
  if (!root) { await pickRoot(); return; }
  if (!(await ensurePerm(root))) return;
  const ctx = lastCtx && lastCtx.org ? lastCtx : await getContext();
  if (!ctx || !ctx.org) { setStatus('Open a Zoho CRM tab first - the workspace is created for the org you are signed in to.', 'warn'); return; }
  try {
    const name = wsFolderName(ctx);
    const base = await appRoot(true);
    if (!base) { setStatus(`Could not create the ${APP_DIR}/ folder inside the working folder.`, 'bad'); return; }
    const h = await base.getDirectoryHandle(name, { create: true });
    const fh = await h.getFileHandle(CFG, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify({ org: ctx.org, base: ctx.origin, instance: ctx.instance }, null, 2));
    await w.close();
    await window.idbHandle.set('activeWs', 'org:' + ctx.org);
    setStatus(`Workspace ready: ${name} - Pull to fill it.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Add failed: ' + e.message, 'warn'); }
}

/** Everything that belongs to the workspace you were in, dropped when you leave it.
 *
 * Two things were surviving a workspace switch, and the second is worse than the first.
 *
 * The **conversation** stayed on screen: the assistant's own replies name functions, modules and
 * connections from the org you have just left, sitting above a question about the new one, and the
 * whole thread is re-sent with every message - so the model is asked to reason about two orgs at
 * once and told nothing about the boundary.
 *
 * The **caches** stayed too, which is not confusing but wrong. `graphCache`, `moduleFilesCache` and
 * `aiConnCache` were cleared in `rebuildTree()` - which only runs if you happen to be on the
 * Functions tab. Switch workspace while looking at Workflows and the assistant answered from the
 * previous org's functions and schema, with no sign of it anywhere.
 *
 * Both are per-workspace state, so both are dropped in one place, called from the one line that
 * changes workspace. The Analytics panel has the same function, doing the same thing.
 */
function dropWorkspaceState() {
  const had = aiMessages.length;
  aiMessages = []; aiSeedWarned = false;
  graphCache = null; moduleFilesCache = null; aiConnCache = null; aiActCache = null; actionUsers = null; failIndex = null;
  healthData = null;   // an audit is about one workspace, and it was the one thing left off this list
  aiRenderMessages();
  return had;
}
/** What is on *screen* when a different workspace is opened - the other half of the above.
 *
 *  Reported: switch workspace while the Health view is open and nothing changes, because rebuilding
 *  «the active view» rebuilds the list under an overlay covering it. The same is true of everything
 *  else that outlives a switch: a search term typed for one org silently filters another, and the
 *  connection filter is a set of *file paths* from the workspace being left, so the functions list
 *  can come back empty for a reason nothing on screen explains.
 *
 *  Two functions rather than one, and the split is not cosmetic: `dropWorkspaceState()` is what
 *  **Clear** in the chat calls, and Clear must not close the reader's preview or empty their search
 *  box. Data belongs to the workspace; the view belongs to the reader - until the workspace changes
 *  underneath it, which is this. */
function resetView() {
  $('find').value = '';
  connectionFilter = null; connFilterSet = null;
  currentPath = null; navClear();
  $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  // An overlay is a view of the workspace too. Health is rebuilt rather than closed, because
  // closing it would answer «what is wrong here» by taking the question away; the assistant's
  // context line is re-measured, since the index it reports is the new org's.
  if ($('healthview').classList.contains('show')) openHealth();
  if ($('aiview').classList.contains('show')) aiContextLabel();
}

async function activate(w, viaGesture) {
  const sameWs = activeWsId === w.id;
  // The binding is set with the handle, not four lines later. It used to be read after
  // setEnabled(true), so `isSample()` was still answering about the *previous* workspace and the
  // per-type Pull came back on - «fields first, state second», which this repository already
  // records in its mirror image. The two are one fact about one workspace; they move together.
  dir = w.handle; forgetDirs(); activeWsId = w.id; bound = w.binding || null;
  await window.idbHandle.set('activeWs', w.id); setEnabled(true);
  oldLayout = await hasOldLayout(w.handle);
  // Not on a re-activation of the workspace already open - regranting a folder must not throw
  // away a conversation about the org you are still in.
  if (!sameWs) {
    const n = dropWorkspaceState();
    resetView();
    if (n) setStatus(`Workspace changed - the assistant's ${n}-message conversation was cleared: it was about the other org.`, 'warn');
  }
  // A different workspace: the chain is dropped, because every step in it names a file in the org
  // the reader has just left. This is the one place that forgets.
  currentPath = null; navClear(); $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  // Access verdicts belong to this workspace, so they are re-read here and the tab row rebuilt.
  // Carrying the previous org's answers over would hide a tab in an org that grants it - the same
  // class of mistake the environment guard exists to prevent, one field further in.
  await loadAccess(); renderTabs();
  const ok = viaGesture ? await ensurePerm(dir) : await hasPerm(dir);
  if (ok) await rebuildActive(); else { setStatus('Workspace found - click Refresh to grant access.', 'warn'); await refreshContext(); }
}

// In-memory only. `.zoost.json` is written when a workspace is created and on pull; rewriting
// it here would clobber fields this function does not carry (lastPull).
async function cacheBinding(b) {
  if (!b || !b.org) return;
  // `sample` travels with the rest. This function rebuilds `bound` from a listed subset, so every
  // field that lands in .zoost.json has to be added here too - the trap this repository already
  // records, and one that would have quietly re-enabled every Zoho action on a sample workspace.
  bound = { org: b.org, base: b.base, instance: b.instance, label: b.label || '', sample: !!b.sample };
  const w = (wsList || []).find((x) => x.id === activeWsId); if (w) w.binding = bound;
}

function updateWsButtons() {
  const add = $('wsadd'), rt = $('wsroot');
  // Both are temporarily unavailable, never permanently: pick a workspace and they work. Analytics
  // has disabled its Remove this way from the start; this side never did, and the two buttons sat
  // beside each other behaving differently.
  renderGoDc();                      // the list it offers is the workspaces, so it moves with them
  $('wsrename').disabled = !dir || !wsList.length;
  $('wsdel').disabled = !dir || !wsList.length;
  const needsGrant = !!root && !rootGranted;
  rt.classList.toggle('needgrant', needsGrant);
  rt.textContent = !root ? '\u{1F4C1} Set working folder\u2026'
    : needsGrant ? `\u{1F513} Grant access to ${root.name}`
    : `\u{1F4C1} ${root.name}`;
  rt.title = !root ? 'Pick the folder that will contain all Zoost workspaces'
    : needsGrant ? 'Chrome dropped the file-system permission for this folder. One click restores it - no folder picker.'
    : `Working folder: ${root.name} - click to choose a different one`;
  // Absent when there is nothing to do, disabled only while it is *temporarily* unavailable.
  // A workspace already exists for this org and never will not: that is not a wait, it is a
  // permanent no, and a greyed button there reads as something broken. The other three reasons -
  // no working folder, no Zoho tab, no org on the tab - all clear on their own, so the button
  // stays visible and says what is missing.
  const known = (wsList || []).some((w) => lastCtx && w.binding && w.binding.org === lastCtx.org);
  add.hidden = known;
  add.disabled = !root || !lastCtx || !lastCtx.org;
  add.textContent = (lastCtx && lastCtx.instance) ? `+ ${lastCtx.instance}` : '+ Workspace';
  add.title = !root ? 'Set the working folder first'
    : !lastCtx ? 'Open a Zoho CRM tab first'
    : `Create a workspace folder for \u00ab${lastCtx.instance}\u00bb inside ${root.name}`;
  // Absent once one exists, and the overlay's copy says which of the two it will do. Both are
  // decided in one place, because they were decided in two and disagreed.
  updateSampleButtons();
}

async function loadWorkspaces() {
  if (!root) root = await window.idbHandle.get('rootDir');
  const sel = $('ws'); sel.innerHTML = '';
  wsList = [];
  if (!root) {
    sel.innerHTML = '<option value="">No working folder</option>';
    dir = null; forgetDirs(); setEnabled(false); updateWsButtons();
    setStatus('Pick a working folder to start - every workspace lives inside it.', 'warn');
    renderBlocked(); await refreshContext(); return;
  }
  rootGranted = await hasPerm(root);
  if (!rootGranted) {
    sel.innerHTML = `<option value="">${root.name} - access not granted</option>`;
    dir = null; forgetDirs(); setEnabled(false); updateWsButtons();
    setStatus('Click \u00abGrant access\u00bb above, or anywhere in this panel - one click, no folder picker.', 'warn');
    renderBlocked(); await refreshContext(); return;
  }
  const base = await appRoot(false);
  // The enumeration itself can fail - a handle whose permission lapsed, a folder moved or removed
  // since the browser stored it. Unguarded, that threw out of here and left the panel with no
  // workspace list and no explanation. A folder we cannot read is a state to report, not a crash.
  if (base) {
    try {
      for await (const e of base.values()) {
        if (e.kind !== 'directory' || e.name.startsWith('.')) continue;
        let cfg = null; try { cfg = await readJsonIn(e, CFG); } catch (_) { continue; }   // not one of ours
        if (!cfg || !cfg.org) continue;
        wsList.push({ id: 'org:' + cfg.org, name: e.name, handle: e, cfg, binding: { org: cfg.org, base: cfg.base, instance: cfg.instance, sample: !!cfg.sample } });
      }
    } catch (e) {
      rootGranted = false;
      setStatus(`Could not read \u00ab${root ? root.name : '?'}/${APP_DIR}\u00bb: ${e.message || e}. Click the folder button to grant access again.`, 'warn');
    }
  }
  wsList.sort(byWsLabel);
  if (!wsList.length) {
    // Workspaces sitting directly in the working folder are the older flat layout. Say so precisely
    // instead of reporting an empty list: the folders are there, Zoost is simply not looking at that
    // level any more now that each product has its own.
    let stray = 0;
    try {
      for await (const e of root.values()) {
        if (e.kind !== 'directory' || APP_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
        try { await e.getFileHandle(CFG); stray++; } catch (_) {}
      }
    } catch (_) {}
    sel.innerHTML = `<option value="">${root.name}/${APP_DIR} - no workspaces yet</option>`;
    dir = null; forgetDirs(); setEnabled(false); updateWsButtons();
    setStatus(stray
      ? `${stray} workspace folder(s) sit directly in \u00ab${root.name}\u00bb. Each Zoost product now keeps its own - move them into \u00ab${root.name}/${APP_DIR}/\u00bb and click Refresh.`
      : 'Open your Zoho CRM tab, then click + to create its workspace.', 'warn');
    renderBlocked(); await refreshContext(); return;
  }
  // The list is real now, so the remembered answer is refreshed from it - including to null,
  // which is how deleting the sample stops the button offering to open one that is gone.
  noteSampleWs((wsList.find((w) => w.binding && w.binding.sample) || {}).id || null);
  const active = await window.idbHandle.get('activeWs');
  wsList.forEach((w) => {
    const o = document.createElement('option');
    o.value = w.id; o.textContent = wsOptionText(w); o.title = wsOptionTitle(w);
    sel.appendChild(o);
  });
  const act = wsList.find((w) => w.id === active) || wsList[0];
  sel.value = act.id; activeWsId = act.id; updateWsButtons();
  await activate(act, false);
}

$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
// A stored folder handle loses its permission between sessions and can only be re-granted from a
// user gesture. Any click in the panel counts, so the first thing the user does restores access -
// except on the controls that would themselves ask, on a dialog, on the mismatch overlay, or in the
// chat. The two panels excluded different subsets of those and neither list was wrong, which is how
// a divergence survives: both looked deliberate. It is the union now, and the same on both sides.
document.addEventListener('click', async (e) => {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('#pfoot') || t.closest('.dlg') || t.closest('#aiview') || t.closest('#offoverlay'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await loadWorkspaces(); } } catch (_) {}
}, true);
/** What the workspace list shows, and what it must never stop showing.
 *
 * The label is a convenience; the identity is the org or workspace id. So the label is displayed and
 * the derived name is kept - in the option's tooltip, always, whether or not a label is set. A list
 * that showed only the user's name for something would be a list you cannot check against the
 * platform.
 */
function wsOptionText(w) { return ((w.cfg && w.cfg.label) || '').trim() || w.name; }
/** The workspace list is ordered by what the reader actually sees. Sorting by the derived name
 *  while displaying the user's own label produces a list that looks unsorted - «Acme» in a folder
 *  called «zzz-1234» lands at the end - and this bar is where a consultant with four clients open
 *  spends the day. Numeric, so «Client 2» comes before «Client 10»; base sensitivity, so case and
 *  accents do not split the order. */
function byWsLabel(a, b) { return wsOptionText(a).localeCompare(wsOptionText(b), undefined, { numeric: true, sensitivity: 'base' }); }
function wsOptionTitle(w) {
  const label = ((w.cfg && w.cfg.label) || '').trim();
  return label ? `${label} - folder ${w.name}` : w.name;
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
    if (!(await ensurePerm(dir))) { setStatus('Folder access needs re-granting - press ↻ Refresh, then try again.', 'warn'); return; }
    await patchCfg({ label });
    setStatus(label ? `Workspace named \u00ab${label}\u00bb.` : 'Workspace name cleared - back to the folder name.', 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Could not save the name. ' + friendlyError(e), 'bad'); }
}
$('wsrename').onclick = renameWorkspace;
$('wsadd').onclick = () => addWorkspaceForTab();
$('wssample').onclick = () => addSampleWorkspace();
// The same action from the off-Zoho overlay, which is where somebody who has just installed
// Zoost and is not signed in to anything actually is.
// One call for both copies of the button: addSampleWorkspace() decides whether there is one to
// open or one to write, so the two cannot disagree and neither can act on a stale label.
$('offsample').onclick = () => addSampleWorkspace();
$('ws').onchange = async () => { const w = wsList.find((x) => x.id === $('ws').value); if (w) await activate(w, true); };
$('wsdel').onclick = async () => {
  const w = wsList.find((x) => x.id === $('ws').value); if (!w || !root) return;
  if (!confirm(`Delete the folder \u00ab${w.name}\u00bb and everything in it?\n\nThis removes the local mirror only - nothing in Zoho CRM is touched. You can pull it again at any time.`)) return;
  try {
    if (!(await ensurePerm(root))) return;
      const base = await appRoot(false);
      if (!base) { setStatus('Could not open the workspace folder.', 'warn'); return; }
      await base.removeEntry(w.name, { recursive: true });   // delete inside crm/, never at the root
      forgetDirs();   // the folders we remembered are gone with it
    await window.idbHandle.set('activeWs', null);
    currentPath = null; $('preview').classList.remove('show');
    setStatus(`Removed ${w.name}.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Remove failed: ' + e.message, 'warn'); }
};

// ---------- view mode (Functions / Modules) ----------
function setMode(mode) {
  viewMode = mode;
  if (mode !== 'functions') { connectionFilter = null; connFilterSet = null; }   // the connection filter is functions-only
  if (mode !== 'functions' && searchMode === 'content') { searchMode = 'name'; $('smode').textContent = 'in: names'; $('smode').classList.remove('on'); $('find').placeholder = MSG.findByName; }
  $('smode').style.display = mode === 'functions' ? '' : 'none';
  $('modebar').querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
  // A jump can land on a tab the reader hid in Settings - a health row, an «Used in» link, a step of
  // the history. `renderTabs()` gives the tab you are *on* a segment even when it is hidden, and
  // that promise was written in its comment while nothing here called it: the row kept the old set,
  // so the panel showed a list with no segment lit and read as having lost its place. Only when the
  // segment is actually missing, so an ordinary switch does not rebuild the row. Walked rather than
  // selected, because a selector built from a value is what the markup checker exists to refuse.
  if (![...$('modebar').querySelectorAll('.seg')].some((b) => b.dataset.tab === mode)) renderTabs();
  const _typeLabel = tabLabel(mode).toLowerCase();
  // The label is in the markup and stays there - writing textContent here replaced the mark with
  // the word on every mode change, so the button reverted the moment anyone touched a segment.
  // Only the title varies, because only the type does.
  $('pullone').title = `Pull only ${_typeLabel} into the local mirror - "Pull all" pulls every type`;
  buildTypeChips();
  $('funcs').style.display = mode === 'functions' ? '' : 'none';
  // It lives in the workspace bar now, beside Export and Health, so it no longer comes and goes with
  // the tab - the diagram window can switch between the two drawings by itself, so there is always
  // something for it to open. Only *which* one it opens follows the tab.
  $('nameToggle').style.display = (mode === 'functions' || mode === 'modules') ? '' : 'none';
  // The mark stays; only what it opens changes. Writing textContent here wiped it on the first
  // mode switch - the same defect as #pullone, and the general shape: a control whose label lives
  // in the markup must not have that label rebuilt by whatever updates its state.
  // Two names, because two different drawings: one is how the org is wired, the other is how it is
  // shaped. Everything else that opens this window uses one of these two and no third word -
  // «Schema», «Graph ↗» and «Open ER» were four names for one thing and the author could not keep
  // them apart. It was «Graph» until that drawing stopped being only functions: it holds workflows,
  // schedules, connections, every automation action and the modules they touch, and a name that
  // says «functions» about a picture of six kinds of thing is the label lying about its subject.
  $('graph').setAttribute('aria-label', mode === 'modules' ? 'ER diagram' : 'Wiring');
  $('graph').title = mode === 'modules'
    ? 'ER diagram - modules and the relations between them, in its own window'
    : 'Wiring - what fires what across the org: functions, workflows, schedules, actions, connections and the modules they touch, in its own window';
  $('nameToggle').textContent = MSG.namePrefix + (mode === 'functions' ? nameMode : moduleNameMode);
  // Changing tab closes the pane and keeps the chain: the whole point of a history that spans the
  // tabs is that a workflow reached from a function is one step away from it, not a fresh start.
  currentPath = null; updateNav(); $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  rebuildActive();
}
// Rebuild the segment row from the registry. Called whenever the set can have changed: at start-up,
// when the settings page saves, and after a pull has learned what the org's roles allow.
//
// If the active tab is no longer among the visible ones - the user just hid it, or a pull discovered
// it is refused - the panel moves to the first that is left, rather than showing an empty view whose
// segment is gone. With every tab hidden it says so instead of rendering a bare strip.
function renderTabs() {
  const bar = $('modebar');
  const vis = visibleTabs();
  // The tab you are actually looking at always has a segment, even if you hid it. Health links jump
  // straight to a workflow or a schedule, and landing on a list whose segment is not in the row
  // reads as the panel having lost its place. It disappears again as soon as you leave.
  if (viewMode && TAB[viewMode] && !vis.includes(viewMode) && !isForbidden(viewMode)) {
    vis.splice(tabOrder().filter((id) => vis.includes(id) || id === viewMode).indexOf(viewMode), 0, viewMode);
  }
  bar.innerHTML = vis.map((id) =>
    `<button class="seg${id === viewMode ? ' active' : ''}" data-tab="${escA(id)}">${escHtml(tabLabel(id))}</button>`).join('')
    || '<span class="segnone">Every tab is hidden - turn one back on in Settings.</span>';
  bar.querySelectorAll('.seg').forEach((b) => (b.onclick = () => setMode(b.dataset.tab)));
  // First draw: open on the first tab the user ordered, not on a name written into the source.
  // Afterwards, only move when the tab being shown has gone away.
  if (vis.length && (viewMode === null || !vis.includes(viewMode))) setMode(vis[0]);
  fitTabs();
}
/** One row of segments or two, decided by measuring rather than by a width typed here.
 *
 *  The panel's width is Chrome's: `chrome.sidePanel` has no say in it - `getLayout()` reports which
 *  side it is on and nothing else - so a minimum width is not ours to set, and the sixth tab pushed
 *  the row onto two lines at the width the user happens to have. A threshold in a media query would
 *  not do either: the set of tabs is the user's, hidden and reordered in Settings, so the width the
 *  labels need is not a constant - measured, six need 380px and five need 300.
 *
 *  So: ask. The class comes off before measuring, so the decision is always taken from the same
 *  state and cannot oscillate; below about 330px six labels do not fit at any size worth reading and
 *  it wraps, which is the honest end of it. */
function fitTabs() {
  const bar = $('modebar');
  const segs = [...bar.querySelectorAll('.seg')];
  const wrapped = () => segs.length > 1 && segs.some((c) => c.offsetTop !== segs[0].offsetTop);
  // Two steps rather than one, and in this order: the spacing is worth less than the type size, so
  // it goes first and the labels only get smaller when closing the gaps was not enough. Measured on
  // the six shipped tabs: 400px as authored, 380 with the spacing closed, 330 at 10px.
  bar.classList.remove('tight', 'tighter');
  if (!wrapped()) return;
  bar.classList.add('tight');
  if (wrapped()) bar.classList.add('tighter');
}
// The panel is resized by dragging its edge, which fires resize continuously - debounced for the
// same reason the diagram window debounces its re-fit.
let fitTimer = null;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTabs, 120); });
/** Is this path one module's file?
 *
 * Eight walks used to spell this out, each re-stating «a .json under modules/ that is not the index»
 * - which is why nesting anything else under modules/ looked dangerous, and why the first attempt at
 * the layout rename broke three of them at once. The shape of the folders should answer to what a
 * layout *is* (a property of a module), not to how many places repeat a condition. One predicate, and
 * the objection goes away.
 */
const isModuleFile = (p) => p.startsWith('modules/') && p.endsWith('.json')
  && !p.startsWith('modules/layouts/') && p !== 'modules/index.json';
const isLayoutFile = (p) => p.startsWith('modules/layouts/') && p.endsWith('.json')
  && p !== 'modules/layouts/index.json';

async function rebuildActive() { return viewMode === 'functions' ? rebuildTree() : viewMode === 'modules' ? rebuildModules() : viewMode === 'workflows' ? rebuildWorkflows() : viewMode === 'schedules' ? rebuildSchedules() : viewMode === 'actions' ? rebuildActions() : rebuildConnections(); }
// While a pull runs, BOTH pull buttons (global "Pull all" and the per-type "Pull \u2026") stay disabled,
// so switching tabs and clicking a second pull cannot start an overlapping one. They come back only
// when the current pull has finished - success or error.
function setPullBusy(b) {
  pullBusy = b;
  // Both read from Zoho, so both are also off on a sample workspace - and this function is what
  // *re-enables* them when a pull ends, which is how #pullone came back on after setEnabled had
  // already turned it off. A state that is restored somewhere else has to know every reason for it.
  ZOHO_BTNS.forEach((x) => ($(x).disabled = b || !zohoReady() || !dir || navOpenNow()));
}
async function pullCurrent() {
  if (pullBusy) return;
  const label = tabLabel(viewMode || 'functions').toLowerCase();   // the registry is the only list of these
  setPullBusy(true); setStatus('Pulling ' + label + '\u2026', 'busy');   // immediate feedback (underlying pull sets its own progress next)
  try {
    if (viewMode === 'modules') await pullModules();
    else if (viewMode === 'workflows') await pullWorkflows();
    else if (viewMode === 'schedules') await pullSchedules();
    else if (viewMode === 'actions') await pullActions();
    else if (viewMode === 'connections') await pullConnections();
    else await pullAll();
    if ($('status').className === 'busy') { try { await rebuildActive(); } catch (_) { setStatus('Pull complete.', 'ok'); } }
  } catch (e) { setStatus('Pull error: ' + e.message, 'bad'); }
  finally { setPullBusy(false); }
}
// "Pull all" means every area this user can actually reach. An area Zoho refused last time is
// skipped rather than re-tried on every pull: re-asking a question already answered turns each pull
// into a list of failures nobody can act on. It is not written off either - Settings has "Check
// again" for exactly that, because a role can change and this verdict carries the date it was given.
//
// A hidden-by-choice area is still pulled. Hiding is about the panel being crowded, not about the
// mirror being incomplete: the export and the AI index read from disk, and quietly leaving a type
// out of them because a tab was tidied away would be a mirror that lies by omission.
async function pullEverything() {
  if (pullBusy) return;
  setPullBusy(true);
  const runners = { functions: pullAll, modules: pullModules, workflows: pullWorkflows, schedules: pullSchedules, actions: pullActions, connections: pullConnections, failures: pullFailures };
  const skipped = [];
  for (const t of TABS) {
    if (isForbidden(t.id)) continue;
    if (!isPulled(t.id)) { skipped.push(t.id); continue; }
    try { await runners[t.id](); } catch (_) { /* each records its own verdict and states its own message */ }
  }
  try { await rebuildActive(); } catch (_) {}
  renderTabs();                                   // a refusal discovered just now changes the set
  // Both notes, because they are different facts and neither may be swallowed: one is what Zoho
  // refused, the other is what you told it not to ask for. A pull that quietly covered less than the
  // whole org without saying so is a mirror you cannot trust.
  const note = forbiddenNote()
    + (skipped.length ? ` · ${skipped.map(tabLabel).join(', ')} skipped by your settings` : '');
  if (note) setStatus($('stxt').textContent + note, 'warn');
  setPullBusy(false);
}

// ---------- modules: pull ----------
async function pullModules() {
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    await requirePerm(dir);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing.`);
    setStatus('Pulling modules…', 'busy');
    const r = await toBridge({ cmd: 'pullModules' }); if (!r?.ok) throw bridgeError(r, 'pull failed');
    setStatus(`Writing ${r.modules.length} modules…`, 'busy');
    const liveLayoutFiles = new Set(); const index = []; const layIndex = [];
    let mw = 0, lw = 0;
    for (const m of r.modules) {
      const fullLayouts = Array.isArray(m.layouts) ? m.layouts : [];
      if (fullLayouts.length) {
        const lf = `modules/layouts/${sanitize(m.api_name || 'unknown')}.json`;
        try { await writeFile(lf, JSON.stringify(fullLayouts, null, 2)); liveLayoutFiles.add(lf); lw++; } catch (_) {}
      }
      // keep a compact summary inside the module JSON (drives the preview line + index)
      m.layouts = fullLayouts.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false, status: l.status || null, sections: (l.sections || []).length }));
      index.push({ api_name: m.api_name, module_name: m.module_name, generated_type: m.generated_type, fields: (m.fields || []).length, layouts: m.layouts.length, related_lists: (m.related_lists || []).length });
      layIndex.push({ module: m.api_name, generated: m.module_name, layouts: m.layouts });
      try { await writeFile(`modules/${sanitize(m.api_name || 'unknown')}.json`, JSON.stringify(m, null, 2)); mw++; } catch (_) {}
    }
    await writeFile('modules/index.json', JSON.stringify(index, null, 2));
    await writeFile('modules/layouts/index.json', JSON.stringify(layIndex, null, 2));
    const liveFiles = new Set(r.modules.map((m) => `modules/${sanitize(m.api_name || 'unknown')}.json`));
    let prunedM = 0;
    for await (const p of walk(dir)) { if (isModuleFile(p) && !liveFiles.has(p)) { try { await removeFile(p); prunedM++; } catch (_) {} } }
    for await (const p of walk(dir)) { if (isLayoutFile(p) && !liveLayoutFiles.has(p)) { try { await removeFile(p); } catch (_) {} } }
    await rebuildModules();
    setStatus(`Modules pull complete: ${mw}/${r.modules.length} modules, ${lw} layout sets${prunedM ? `, ${prunedM} removed` : ''}.`, 'ok');
    await noteAccess('modules', null);
  } catch (e) { await notePullFailure('modules', e); } finally { pullActive = false; }
}

// ---------- modules: tree ----------
// Which module load is the current one. `rebuildModules()` empties `moduleData` and then fills it a
// file at a time, so two of them running together is not two lists - it is one list written by two
// writers: the second empties what the first has put in and both keep pushing, and every module
// comes out twice. Reported from a jump that arrives while the tab is already loading, which is
// exactly the window a jump lands in. The tree has carried this token since the phased load; the
// other lists were left with the hazard and no token, which is the «one of a set» miss this project
// keeps recording.
let moduleLoad = 0;

async function rebuildModules() {
  if (!dir) return;
  if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'warn'); return; }
  const mine = ++moduleLoad;
  const current = () => mine === moduleLoad;
  setStatus('Loading modules…', 'busy'); const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
  if (!current()) return;
  const names = [];
  for await (const p of walk(dir)) if (isModuleFile(p)) names.push(p);
  names.sort();
  if (!current()) return;
  const rows = [];
  for (const p of names) {
    try {
      const m = JSON.parse(await readFile(p));
      rows.push({ path: p, api_name: m.api_name, gen: m.module_name || m.api_name, label: m.plural_label || m.singular_label || m.module_name || m.api_name, custom: m.generated_type === 'custom', generated_type: m.generated_type || '', fieldCount: (m.fields || []).length, lookupCount: (m.fields || []).filter((f) => f.lookup).length, layoutCount: (m.layouts || []).length, layouts: (m.layouts || []), viewable: (m.viewable !== false && m.visible !== false), navigable: moduleNavigable(m), unreadable: m.unreadable || null });
    } catch (_) {}
  }
  if (!current()) return;
  moduleData = rows;          // published once, whole - never a list two loads are both writing into
  renderModules();
  setStatus(moduleData.length ? `${moduleData.length} modules in workspace.` : (emptyReason() || 'No modules yet - click Pull.'), moduleData.length ? 'ok' : 'warn');
  await refreshContext();
}
// What Zoho said when it refused to describe a module, in one sentence, in one place - the row, the
// detail pane and both exports all ask this. Zoho's own words are quoted rather than reworded: the
// fact is the product, and our paraphrase of it would be an interpretation.
// Zoho understood and said no (4xx), as against everything else - a dropped connection, a 5xx, a
// tab that went away - which is a failure and stays retryable. A blip written to disk as a dated
// refusal would be a measurement that was never taken, presented as a settled one.
function isRefusal(status) { return Number(status) >= 400 && Number(status) < 500; }
function moduleRefusal(u) {
  if (!u) return null;
  const when = u.at ? new Date(u.at) : null;
  const day = when && !isNaN(when) ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}` : null;
  const said = u.message || u.code || `HTTP ${u.status || '?'}`;
  return {
    short: u.code === 'INVALID_MODULE' ? 'not described' : 'refused',
    text: `Zoho would not describe this module, so its fields, layouts and related lists were never read. `
        + `It answered ${u.status || '?'}${u.code ? ' ' + u.code : ''}: \u00ab${said}\u00bb${day ? `, asked on ${day}` : ''}. `
        + `Pulling again will not change that by itself - the answer has to change in Zoho first.`,
  };
}
function renderModules() {
  if (viewMode !== 'modules') return;
  const term = $('find').value.trim().toLowerCase();
  const relsHtmlFor = (m) => {
    const rl = scope.relations ? (m.related_lists || []) : []; if (!rl.length) return '';
    return `<div style="font-weight:700;margin:12px 0 4px;color:#d97706">Related lists (${rl.length}) <span class="none" style="font-weight:400">- API name for zoho.crm.getRelatedRecords()</span></div>`
      + `<table class="ftbl"><thead><tr><th>Relation API</th><th>Label</th><th>Returns</th><th>Type</th></tr></thead><tbody>`
      + rl.map((r) => `<tr><td class="mono"><b>${esc(r.api_name)}</b></td><td>${esc(r.label || '')}</td><td class="mono">${r.module ? modLink(r.module) : esc(r.connected_module || '')}${r.linking_module ? ` <span class="none">via ${esc(r.linking_module)}</span>` : ''}</td><td>${esc(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td></tr>`).join('')
      + `</tbody></table>`;
  };
  const groups = { Standard: [], Custom: [] };
  moduleData
    .filter((m) => moduleFilter === 'all' || (moduleFilter === 'custom' ? m.custom : !m.custom))
    .filter((m) => !term || (m.api_name || '').toLowerCase().includes(term) || (m.label || '').toLowerCase().includes(term))
    .forEach((m) => (m.custom ? groups.Custom : groups.Standard).push(m));
  const tree = $('tree'); tree.innerHTML = '';
  if (!groups.Standard.length && !groups.Custom.length) { tree.innerHTML = '<div class="empty">' + (moduleData.length ? '<b>No modules match.</b>' : (emptyReason() || '<b>No modules yet.</b> Press <b>Pull</b> to read them.')) + '</div>'; return; }
  for (const g of ['Standard', 'Custom']) {
    const list = groups[g]; if (!list.length) continue;
    const isCol = collapsed.has('mod:' + g);
    const gh = document.createElement('div'); gh.className = 'grp' + (isCol ? ' collapsed' : '');
    gh.innerHTML = `<span class="chev">\u25be</span><span>${g}</span><span class="cnt">${list.length}</span>`;
    gh.onclick = () => { isCol ? collapsed.delete('mod:' + g) : collapsed.add('mod:' + g); renderModules(); };
    tree.appendChild(gh);
    if (isCol) continue;
    const nm = (m) => moduleNameMode === 'display' ? m.label : moduleNameMode === 'generated' ? m.gen : m.api_name;
    list.sort((a, b) => nm(a).localeCompare(nm(b)));
    list.forEach((m) => {
      const el = document.createElement('div'); el.className = 'f'; el.dataset.path = m.path; el.dataset.api = m.api_name;
      el.setAttribute('aria-selected', m.path === currentPath);
      const multi = (m.layoutCount || 0) > 1; const exp = expandedMods.has(m.path);
      // The layouts chevron lives on the RIGHT (next to the layout count), not between dot and name,
      // so module names line up with the other tabs' dot\u2192name spacing.
      //
      // And its slot is **always there**, empty on a module with one layout. It used to be absent,
      // which meant a row with several layouts was 12px wider on the right than its neighbours and
      // pushed its own field and layout counts left - so the one column a reader scans as figures
      // stopped being a column. Reported. A control that comes and goes may not move what is beside
      // it: reserve the space, do not reflow around it.
      const chev = `<span class="laychev${multi ? '' : ' none'}"${multi ? ' title="Show / hide layouts"' : ' aria-hidden="true"'}>${multi ? (exp ? '\u25be' : '\u25b8') : ''}</span>`;
      // The refusal wins over `error`: it is the more specific answer, and it is the one that says
      // whether doing anything again is worth it.
      //
      // \u2298, and grey. It wore \u27f3 in amber - the panel's "failed, click to retry" - which
      // advertised an action that changes nothing, and he said so. The vocabulary now runs
      // \u25cf here \u00b7 \u25cb not here yet \u00b7 \u25d0 partial \u00b7 \u27f3 failed \u00b7 \u2298 refused, and only the last
      // means "no" rather than "not yet". Reusing \u25cb would have been worse than a new glyph: in the
      // functions list it means "click to download", which is the opposite claim.
      const ref = moduleRefusal(m.unreadable);
      const stTitle = ref ? ref.text : m.error ? 'Failed - click to retry' : 'In workspace - click to resync fields from Zoho';
      el.innerHTML = `<span class="st ${ref ? 'st-none' : m.error ? 'st-err' : 'st-ok'}" title="${escA(stTitle)}">${ref ? '\u2298' : m.error ? '\u27f3' : '\u25cf'}</span><span class="fname">${escHtml(nm(m))}</span>`
        + (ref ? `<span class="rest rx" title="${escA(ref.text)}">${escHtml(ref.short)}</span>` : '')
        + `<span class="rest rf" title="${m.fieldCount} field(s)">${m.fieldCount ? m.fieldCount + 'f' : ''}</span>`
        + `<span class="rest rl" title="${m.layoutCount} layout(s)">${m.layoutCount ? m.layoutCount + 'L' : ''}</span>${chev}`;
      el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); resyncModule(m); };
      const ch = el.querySelector('.laychev');
      if (ch) ch.onclick = (ev) => { ev.stopPropagation(); exp ? expandedMods.delete(m.path) : expandedMods.add(m.path); renderModules(); };
      el.onclick = () => openModule(m.path); tree.appendChild(el);
      if (multi && exp) {
        (m.layouts || []).forEach((L) => {
          const sub = document.createElement('div'); sub.className = 'f fsub';
          sub.innerHTML = `<span class="laysub">\u21b3</span><span>${escHtml(L.name || String(L.id))}</span>${L.visible === false ? '<span class="rest" style="color:#6b7688">hidden</span>' : ''}${L.sections ? `<span class="rest" style="color:#8ea0bb">${L.sections} sections</span>` : ''}`;
          sub.onclick = () => openModule(m.path, String(L.id));
          tree.appendChild(sub);
        });
      }
    });
  }
}
async function resyncModule(m) {
  if (mismatchRefuse()) return;
  if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'bad'); return; }
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  setStatus(`Resyncing ${m.api_name}…`, 'busy');
  const r = await toBridge({ cmd: 'fetchModuleFields', apiName: m.api_name });
  let mod = {}; try { mod = JSON.parse(await readFile(m.path)); } catch (_) {}
  // Re-asking is the whole point of this dot, so the answer is recorded either way - a refusal
  // dated today, or its removal. Leaving a stale `unreadable` behind would keep the banner up on a
  // module Zoho has just described, which is the same class of lie in the other direction.
  if (!r?.ok) {
    if (isRefusal(r?.status)) {
      mod.unreadable = { status: r.status, code: r.code || null, message: r.detail || r.error || 'no answer', at: new Date().toISOString() };
      try { await writeFile(m.path, JSON.stringify(mod, null, 2)); } catch (_) {}
      m.unreadable = mod.unreadable; m.error = false;
      renderModules(); if (currentPath === m.path) openModule(m.path);
      setStatus(`${m.api_name}: ${moduleRefusal(m.unreadable).text}`, 'warn');
      return;
    }
    m.error = true; renderModules();
    setStatus(`Resync of ${m.api_name} failed: ${r?.error || 'no answer'}`, 'warn');
    return;
  }
  mod.fields = r.fields; delete mod.unreadable;
  try { await writeFile(m.path, JSON.stringify(mod, null, 2)); } catch (_) {}
  m.fieldCount = r.fields.length; m.lookupCount = r.fields.filter((f) => f.lookup).length; m.error = false; m.unreadable = null;
  renderModules(); if (currentPath === m.path) openModule(m.path);
  setStatus(`Resynced ${m.api_name} (${m.fieldCount} fields).`, 'ok');
}
/** The values of a picklist, on request and downwards. Laid out on one line - eight of them, then
 *  «…(+31)» - a module with long options made the fields table scroll sideways with no end, and a
 *  horizontal scrollbar in a 400px panel hides the columns somebody came for. The count is the
 *  summary, because a number is a fact and «many» is not, and the list opens under it one value per
 *  line. Reported. */
function pickCell(values) {
  const v = values || []; if (!v.length) return '';
  return `<button class="plbtn" data-n="${escA(String(v.length))}" aria-expanded="false" title="Show the values">\u25b8 ${v.length} value${v.length === 1 ? '' : 's'}</button>`;
}
/** The values, in a row of their own that spans the table.
 *
 *  They were put inside the picklist cell first, and that was the wrong place twice over: it is the
 *  last of six columns in a 400px pane, so «WhatsApp/SMS» came out broken across two lines at about
 *  ninety pixels wide, with a scrollbar inside a scrollbar and no line between one value and the
 *  next. Reported, with a picture, and the report was that it had become worse than the sideways
 *  scroll it replaced - which it had. A cell cannot be widened; a row can, so the values get the
 *  whole width, and each one wears a border because a list of names needs a boundary, not a newline. */
function pickRow(values, cols) {
  const v = values || []; if (!v.length) return '';
  return `<tr class="plrow" hidden><td colspan="${escA(String(cols))}"><div class="plvals">`
    + v.map((x) => `<span class="plv">${escHtml(x)}</span>`).join('')
    + '</div></td></tr>';
}
/** Every report cuts a long picklist, and none of them said so: twelve values printed and the rest
 *  gone, which makes the report quietly wrong rather than merely shorter. It states what it dropped
 *  now, the way the panel always did. */
function _pick(values, cap, esc) {
  const v = values || []; if (!v.length) return '';
  return esc(v.slice(0, cap).join(', ')) + (v.length > cap ? ` \u2026(+${v.length - cap} more)` : '');
}
function renderFieldsTable(m) {
  const rows = (m.fields || []).map((f) => `<tr>
    <td>${escHtml(f.label || f.api_name)}${f.custom ? ' <span style="color:#a78bfa">*</span>' : ''}</td>
    <td class="mono">${escHtml(f.api_name)}</td>
    <td>${escHtml(f.data_type || '')}${f.length ? ` (${f.length})` : ''} ${pickCell(f.picklist)}</td>
    <td style="text-align:center">${f.mandatory ? '\u25cf' : ''}</td>
    <td class="mono">${f.lookup ? '\u2192 ' + escHtml(typeof f.lookup === 'string' ? f.lookup : (f.lookup.api_name || (f.lookup.module && (f.lookup.module.api_name || f.lookup.module)) || '')) : ''}</td>
  </tr>${pickRow(f.picklist, 5)}`).join('');
  if (!rows) {
    // The refusal is stated once, in the banner directly above this. Repeating it here and again
    // under Related lists put the same sixty words on screen three times.
    return `<div class="empty" style="padding:12px 10px">${m.unreadable ? '<b>No fields were read.</b>'
      : (emptyReason() || '<b>No fields recorded.</b> Press <b>Pull</b> above to read them from Zoho.')}</div>`;
  }
  // Five columns, not six. The values used to have one of their own, which is what made the table
  // scroll sideways - and once they moved to a row of their own the column left behind held only the
  // button that opens it, in the last position, off screen at 400px. It sits in Type, where the word
  // «picklist» already is and where the reader is already looking.
  return `<table class="ftbl"><thead><tr><th>Field</th><th>API name</th><th>Type</th><th>Req</th><th>Lookup</th></tr></thead><tbody>${rows}</tbody></table>`;
}
// Selecting a different item must start the reader at the top of the new content;
// keeping the previous scroll offset lands you in the middle of an unrelated document.
function resetPreviewScroll() {
  const doIt = () => {
    ['pvtable', 'pvbody', 'pvcode', 'pvwrap'].forEach((id) => { const e = $(id); if (e) { e.scrollTop = 0; e.scrollLeft = 0; } });
    const p = $('preview');
    if (p) p.querySelectorAll('pre,.code,.scroll,[style*="overflow"]').forEach((e) => { e.scrollTop = 0; e.scrollLeft = 0; });
  };
  doIt(); requestAnimationFrame(doIt);   // again after layout, for content rendered on the next frame
}
function renderLayoutView(layout) {
  const secs = layout.sections || [];
  if (!secs.length) return '<div style="padding:10px;color:var(--muted)">This layout has no section detail (re-pull modules).</div>';
  return secs.map((sec) => {
    const flds = sec.fields || [];
    const rows = flds.map((f) => `<tr>
      <td>${escHtml(f.field_label || f.display_label || f.api_name)}</td>
      <td class="mono">${escHtml(f.api_name || '')}</td>
      <td>${escHtml(f.data_type || '')}</td>
      <td style="text-align:center">${f.required ? '\u25cf' : ''}</td>
    </tr>`).join('');
    return `<div class="secttl">${escHtml(sec.display_label || sec.name || 'Section')} <span style="color:var(--muted)">(${flds.length})</span></div>`
      + `<table class="ftbl"><thead><tr><th>Field</th><th>API name</th><th>Type</th><th>Req</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
}
async function openModule(path, layoutId) {
  if (!(await ensurePerm(dir))) { setStatus('File access denied - click Refresh.', 'bad'); return; }
  currentPath = path; navHere(); if ($('status').className) setStatus('', '');
  selectRow(path);
  let m; try { m = JSON.parse(await readFile(path)); } catch (e) { setStatus(MSG.readFailed + e.message, 'bad'); return; }
  navNames({ display: m.plural_label || m.singular_label || m.module_name || m.api_name,
             gen: m.module_name || m.api_name, api: m.api_name });
  const nav = moduleNavigable(m);
  const refusal = moduleRefusal(m.unreadable);
  setPvName(`${m.plural_label || m.singular_label || m.module_name || m.api_name} \u00b7 ${m.api_name} \u00b7 ${(m.fields || []).length} fields${nav ? '' : ' \u00b7 no records tab'}`, path);
  $('pvreveal').style.display = nav ? '' : 'none'; $('pvreveal').textContent = 'Records \u2197'; $('pvreveal').title = 'Open the module\'s records list in Zoho';
  $('pvfind').style.display = nav ? '' : 'none'; $('pvfind').textContent = 'Layouts \u2197'; $('pvfind').title = 'Open the module\'s layouts (add/edit fields & layout) in Zoho';
  $('pvcallers').className = ''; $('pvcallers').textContent = '';
  showModuleUsage(m.api_name);   // not awaited: it needs the graph, and the fields must not wait for it
  const gen = m.module_name || m.api_name;
  const namesBlock = `<div style="padding:8px 10px;font:11px var(--mono);border-bottom:1px solid var(--border);background:#141b29;line-height:1.7">`
    + `<div style="color:#8ea0bb">display: <span style="color:#e7edf6">${escHtml(m.plural_label || m.singular_label || m.module_name || m.api_name)}</span></div>`
    + `<div style="color:#8ea0bb">api_name: <span style="color:#82d2ff">${escHtml(m.api_name)}</span></div>`
    + `<div style="color:#8ea0bb">generated: <span style="color:#a78bfa">${escHtml(gen)}</span>${nav ? '' : ' <span style=\"color:#fbbf24\">(no records tab)</span>'}</div>`
    + `<div style="color:#8ea0bb">layouts: <span style="color:#e7edf6">${(m.layouts || []).length}</span>${(m.layouts || []).length ? ' <span style=\"color:#8ea0bb\">(' + (m.layouts || []).map((l) => escHtml(l.name)).join(', ') + ')</span>' : ''}</div>`
    + `</div>`;
  const lays = m.layouts || [];
  const selector = lays.length
    ? `<div class="laybar">Layout: <select id="laysel"><option value="__all__">All fields (flat, ${(m.fields || []).length})</option>`
      + lays.map((l) => `<option value="${escA(String(l.id))}">${escHtml(l.name || l.id)}${l.visible === false ? ' \u00b7 hidden' : ''}${l.sections ? ` \u00b7 ${l.sections} sections` : ''}</option>`).join('')
      + `</select> <button id="laymod" class="laymod" title="Open the selected layout in Zoho - Zoost shows it, Zoho is where it is changed">View \u2197</button></div>`
    : '';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  // Absent, not disabled, and not left to open an empty window: with no fields there is no box to
  // draw and no lookup to follow, so the depth control and the ER button have nothing to act on.
  const relBar = refusal ? '' : `depth <select id="reldepth"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select><button id="relopen" class="laylocal icon" aria-label="ER diagram" title="ER diagram - opened on this module at the depth chosen here, in its own window"><svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5" rx="1"/><rect x="9" y="9" width="5.5" height="5" rx="1"/><path d="M7 4h3.5a1.2 1.2 0 0 1 1.2 1.2V9"/></svg></button>`;
  const rls = m.related_lists || [];
  const rlBlock = rls.length
    ? `<div class="secttl">Related lists (${rls.length}) <span style="color:var(--muted);font-weight:400">- API name for zoho.crm.getRelatedRecords(); click to copy</span></div>`
      + `<table class="ftbl"><thead><tr><th>API name</th><th>Label</th><th>Target module</th><th>Type</th></tr></thead><tbody>`
      + rls.map((r) => `<tr><td class="mono rlcopy" data-c="${escA(r.api_name)}" title="Click to copy">${escHtml(r.api_name)}</td>`
        + `<td>${escHtml(r.label || '')}</td>`
        + `<td class="mono">${escHtml(r.module || r.connected_module || '')}${r.linking_module ? ` <span style="color:var(--muted)">via ${escHtml(r.linking_module)}</span>` : ''}</td>`
        + `<td>${escHtml(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td></tr>`).join('')
      + `</tbody></table>`
    : `<div class="secttl">Related lists</div><div style="padding:8px 10px;color:var(--muted)">${
        refusal ? 'Not read either - Zoho would not describe this module.' : 'None recorded - re-run <b>Pull Modules</b> to fetch them.'}</div>`;
  const refBanner = refusal
    ? `<div class="box warn" style="margin:8px 10px;padding:8px 10px;font:11px var(--sans);line-height:1.5;color:#f7c66b;background:rgba(217,119,6,.12);border:1px solid #8a6321;border-radius:6px">${escHtml(refusal.text)}</div>`
    : '';
  // Fields on one tab, everything else on the other - the same split as a function's, for the same
  // reason: this pane held the names, the banner, the relations bar, the layout picker, the fields
  // table and the related lists, stacked in 400px. The fields are what a module is opened for, so
  // they are the first tab; the related-list API names are the most valuable thing here and sit at
  // the top of the second, not at the bottom of a column nobody reaches.
  $('pvtable').innerHTML = `<div id="pvfields">${selector}<div id="laybody">${renderFieldsTable(m)}</div></div>`
    + `<div id="pvdetails">${refBanner}${namesBlock}${rlBlock}</div>`;
  pvTabsFor('module');                 // clears the slot, so the bar goes in after it, never before
  $('pvtabsr').innerHTML = relBar;
  $('pvtable').querySelectorAll('.rlcopy').forEach((c) => (c.onclick = () => {
    navigator.clipboard.writeText(c.dataset.c).then(() => setStatus(`Copied \u00ab${c.dataset.c}\u00bb`, 'ok')).catch(() => {});
  }));
  const relOpen = $('pvtabsr').querySelector('#relopen');
  if (relOpen) relOpen.onclick = () => openSchemaFocus(m.api_name, parseInt(document.getElementById('reldepth').value, 10) || 2);
  const sel = document.getElementById('laysel');
  if (sel) sel.onchange = async () => {
    const body = document.getElementById('laybody'); const v = sel.value;
    if (v === '__all__') { body.innerHTML = renderFieldsTable(m); return; }
    body.innerHTML = '<div style="padding:10px;color:var(--muted)">Loading layout\u2026</div>';
    let full = []; try { full = JSON.parse(await readFile(`modules/layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
    const L = (full || []).find((x) => String(x.id) === String(v));
    body.innerHTML = L ? renderLayoutView(L) : '<div style="padding:10px;color:var(--muted)">Layout detail not found - re-pull modules.</div>';
  };
  const mod = document.getElementById('laymod');
  if (mod) mod.onclick = () => { const v = sel ? sel.value : '__all__'; openModuleLayout(m.module_name || m.api_name, v === '__all__' ? null : v); };
  if (layoutId && sel) { sel.value = String(layoutId); if (sel.value === String(layoutId)) await sel.onchange(); }
  showPreview();
}

// ---------- modules: schema graph (modules as nodes, lookups as edges) + function bridge ----------
async function buildSchemaGraph(focusApi, depth) {
  // modules
  const modPaths = [];
  for await (const p of walk(dir)) if (isModuleFile(p)) modPaths.push(p);
  const mods = [];
  for (const p of modPaths) { try { const m = JSON.parse(await readFile(p)); m._path = p; mods.push(m); } catch (_) {} }
  // Field -> layout membership. The module JSON only carries a layout summary; the full
  // sections/fields structure lives in modules/layouts/<Module>.json (written by Pull Modules).
  for (const m of mods) {
    let full = [];
    try { full = JSON.parse(await readFile(`modules/layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
    if (!Array.isArray(full) || !full.length) continue;
    m._layList = full.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false }));
    const memb = {};
    full.forEach((l, i) => (l.sections || []).forEach((sec) => (sec.fields || []).forEach((fl) => {
      const k = fl.api_name; if (!k) return;
      const e = memb[k] || (memb[k] = { lay: [], req: [] });
      if (!e.lay.includes(i)) e.lay.push(i);
      if (fl.required && !e.req.includes(i)) e.req.push(i);
    })));
    m._layMap = memb;
  }
  // functions (for the code<->module bridge)
  const funcs = [];
  for await (const p of walk(dir)) {
    if (!p.endsWith('.dg')) continue;
    try {
      const dg = await readFile(p); let meta = {}; try { meta = JSON.parse(await readFile(p.replace(/\.dg$/, '.meta.json'))); } catch (_) {}
      funcs.push({ file: p, api_name: meta.api_name || p.split('/').pop().replace(/\.dg$/, ''), name: meta.name, ns: meta.nameSpace || p.split('/')[0], dg });
    } catch (_) {}
  }
  const nodes = {};
  mods.forEach((m) => {
    nodes[m.api_name] = {
      id: m.api_name, namespace: (m.generated_type === 'custom' ? 'custom' : 'standard'),
      name: m.api_name, api_name: m.api_name, display_name: m.plural_label || m.singular_label || m.module_name || m.api_name,
      called_by: [], calls: [], rest: false, dead_suspect: false, unresolved: [], ambiguous: [],
      category: m.generated_type || 'module', description: '', return_type: null, params: [],
      associated_place: null, file: m._path, source_code: '',
      // Zoho would not describe this module, so it has no fields, no lookups and no relations *that
      // anyone has read*. Carried into the graph because a box with nothing in it and a node with no
      // edges are both claims, and neither is one we are entitled to make.
      unreadable: m.unreadable || null,
      fields: (m.fields || []).map((fl) => {
        const e = (m._layMap || {})[fl.api_name];
        return e ? Object.assign({}, fl, { _lay: e.lay, _req: e.req }) : fl;
      }),
      layouts: (m._layList && m._layList.length) ? m._layList : (m.layouts || []),
      related_lists: m.related_lists || [],
      layoutDetail: !!(m._layMap), touched_by: [],
    };
  });
  // lookup edges (only to known modules)
  const edgeSet = new Set();
  mods.forEach((m) => (m.fields || []).forEach((fld) => {
    if (fld.lookup && nodes[fld.lookup] && fld.lookup !== m.api_name) {
      nodes[m.api_name].calls.push(fld.lookup); nodes[fld.lookup].called_by.push(m.api_name);
      edgeSet.add(m.api_name + '\u0000' + fld.lookup);
    }
  }));
  // "Nothing references this" is a measurement, and on a module Zoho refused it was never taken:
  // its own fields were not read either, so both directions are unknown rather than empty. Same rule
  // as a workflow that has not been downloaded having no scheduled-action count instead of zero.
  Object.values(nodes).forEach((n) => { n.calls = [...new Set(n.calls)]; n.called_by = [...new Set(n.called_by)]; n.dead_suspect = !n.unreadable && n.called_by.length === 0; });
  // function bridge: a function "touches" a module if its code contains the module api_name as a string literal
  funcs.forEach((fn) => mods.forEach((m) => {
    const dq = '"' + m.api_name + '"', sq = "'" + m.api_name + "'";
    if (fn.dg.indexOf(dq) >= 0 || fn.dg.indexOf(sq) >= 0) nodes[m.api_name].touched_by.push({ api_name: fn.api_name, ns: fn.ns, file: fn.file });
  }));
  // Optional ego-graph: keep only modules within `depth` lookup-hops of the focus module (undirected).
  let outNodes = nodes, keepEdges = [...edgeSet];
  if (focusApi && nodes[focusApi]) {
    const adj = {}; Object.keys(nodes).forEach((k) => (adj[k] = new Set()));
    [...edgeSet].forEach((e) => { const [a, b] = e.split('\u0000'); adj[a].add(b); adj[b].add(a); });
    const keep = new Set([focusApi]); let frontier = [focusApi]; const D = Math.max(1, depth || 2);
    for (let d = 0; d < D; d++) { const next = []; frontier.forEach((k) => adj[k].forEach((nb) => { if (!keep.has(nb)) { keep.add(nb); next.push(nb); } })); frontier = next; if (!frontier.length) break; }
    outNodes = {}; keep.forEach((k) => { outNodes[k] = nodes[k]; });
    keepEdges = [...edgeSet].filter((e) => { const [a, b] = e.split('\u0000'); return keep.has(a) && keep.has(b); });
    Object.values(outNodes).forEach((n) => { n.calls = n.calls.filter((x) => keep.has(x)); n.called_by = n.called_by.filter((x) => keep.has(x)); n.focus = (n.api_name === focusApi); });
  }
  const edges = keepEdges.map((e) => { const [a, b] = e.split('\u0000'); return [a, b]; });
  const dead = Object.values(outNodes).filter((n) => n.dead_suspect).length;
  return { kind: 'schema', nodes: outNodes, edges, focus: (focusApi && nodes[focusApi]) ? focusApi : null, depth: (focusApi && nodes[focusApi]) ? Math.max(1, depth || 2) : null, counts: { nodes: Object.keys(outNodes).length, edges: edges.length, dead_suspects: dead, unresolved: 0 }, workspace: { instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null } };
}
// Open the call graph centred on one function, at a depth. The same shape as openSchemaFocus for
// modules, and deliberately so: the window, the controls and the wording are the ones already there.
async function openCallFocus(id, depth) {
  try {
    await requirePerm(dir);
    setStatus(`Building the graph for ${id}\u2026`, 'busy');
    const g = await callGraphWithContext();
    if (!g.counts.nodes) throw new Error('No functions pulled yet - press Pull all.');
    if (!g.nodes[id]) throw new Error(`${id} is not in the graph.`);
    const gg = Object.assign({}, g, { focus: id, depth: Math.max(1, depth || 2) });
    gg.workspace = { instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null, label: bound?.label || null };
    await chrome.storage.session.set({ graphData: graphForWindow(gg) });
    await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html'), type: 'normal', width: 1240, height: 840 });
    const n = g.nodes[id];
    setStatus(`Graph of ${id} (depth ${gg.depth}): calls ${n.calls.length}, called by ${n.called_by.length}.`, 'ok');
  } catch (e) { setStatus(MSG.graphErr + e.message, 'bad'); }
}
async function openSchemaFocus(apiName, depth) {
  try {
    await requirePerm(dir);
    setStatus(`Building relations graph for ${apiName}\u2026`, 'busy');
    const g = await buildSchemaGraph();   // full graph; the ER window filters by focus + depth client-side (adjustable there)
    if (!g.counts.nodes) throw new Error('No modules pulled yet - pull in Modules mode.');
    if (!g.nodes[apiName]) throw new Error(`Module ${apiName} not found in the schema.`);
    if (g.nodes[apiName].unreadable) throw new Error(`Zoho would not describe ${apiName}, so it has no fields and no relations to draw.`);
    g.focus = apiName; g.depth = Math.max(1, depth || 2);
    await chrome.storage.session.set({ graphData: graphForWindow(g) });
    await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html'), type: 'normal', width: 1240, height: 840 });
    setStatus(`Relations of ${apiName} (depth ${g.depth}): ${g.counts.nodes} modules, ${g.counts.edges} lookups.`, 'ok');
  } catch (e) { setStatus('Relations graph error: ' + e.message, 'bad'); }
}
async function openSchemaGraph() {
  try {
    await requirePerm(dir);
    setStatus('Building schema graph…', 'busy'); await refreshContext();
    const g = await buildSchemaGraph();
    if (!g.counts.nodes) throw new Error((emptyReason() || 'No modules pulled yet - click Pull in Modules mode.'));
    await chrome.storage.session.set({ graphData: graphForWindow(g) });
    await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html'), type: 'normal', width: 1240, height: 840 });
    setStatus(`Schema: ${g.counts.nodes} modules, ${g.counts.edges} lookups.`, 'ok');
  } catch (e) { setStatus('Schema graph error: ' + e.message, 'bad'); }
}

// ---------- resilient per-function download ----------
// A 400/401/403/404 is deterministic: retrying repeats the same failure, so we do not. Only a
// network blip or a 429/5xx is worth one retry. Matches the principle: retry what might change,
// not what we already know will fail the same way.
function isTransient(msg) {
  const m = String(msg || '').match(/\b([45]\d\d)\b/);
  if (!m) return true;                 // no HTTP status → network/unknown: a single retry is fair
  const code = +m[1];
  return code === 429 || code >= 500;
}
const errText = (e) => String((e && e.message) || e || 'unknown').replace(/["'<>]/g, '').slice(0, 140);
async function downloadOne(entry) {
  if (mismatchRefuse()) return false;
  if (!dir) return false;
  if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'bad'); return false; }
  const info = index.get(entry.id) || {};
  try {
    const r = await toBridge({ cmd: 'fetchOne', id: entry.id, category: entry.category || info.category, source: entry.source || info.source });
    if (!r?.ok || !r.file) throw new Error(r?.error || 'not found');
    const f = r.file;
    await writeFile(`functions/${f.folder}/${f.stem}.dg`, f.dg);
    await writeFile(`functions/${f.folder}/${f.stem}.meta.json`, JSON.stringify(f.meta, null, 2));
    entry.path = `functions/${f.folder}/${f.stem}.dg`; entry.namespace = f.folder;
    entry.display_name = f.meta.display_name || entry.display_name; entry.downloaded = true; entry.stale = false; entry.error = false; entry.errorMsg = '';
    index.set(entry.id, { path: entry.path, category: f.meta.category, source: f.meta.source, name: f.meta.name, rest: (f.meta.rest_api || []).some((x) => x.active) });
    return true;
  } catch (e) { entry.error = true; entry.downloaded = false; entry.errorMsg = errText(e); return false; }
}
async function downloadMissing() {
  // It downloads, so it is refused on the wrong tab like every other pull. A guard rather than a
  // disabled button: the button is `display:none` unless something is missing, and disabling it
  // from `updateMissingButton` would be an assignment on top of the five-second re-render - set
  // once, never revisited, which measured as «still off after the tab came back into line».
  if (!zohoReady()) { setStatus(MSG.wrongTab, 'warn'); return; }
  const pending = treeData.filter((e) => !e.downloaded || e.stale);   // stale = older schema (before connections/author); re-fetch to backfill
  if (!pending.length) { setStatus('All functions downloaded.', 'ok'); updateMissingButton(); return; }
  setPullBusy(true); $('missing').disabled = true;   // both Pull buttons, and pullCurrent refuses to start on top
  let ok = 0, fail = 0;
  for (let i = 0; i < pending.length; i++) {
    const e = pending[i];
    setStatus(`Downloading ${i + 1}/${pending.length}\u2026${fail ? ' (' + fail + ' failed)' : ''}`, 'busy');
    let done = await downloadOne(e);
    if (!done && isTransient(e.errorMsg)) { await sleep(700); done = await downloadOne(e); }   // one backoff retry, transient failures only
    done ? ok++ : fail++;
    updateRow(e);
    await sleep(140);
  }
  updateMissingButton();
  setStatus(fail ? `Downloaded ${ok}, ${fail} still missing - use "Complete missing".` : `All ${ok} functions downloaded.`, fail ? 'warn' : 'ok');
  setPullBusy(false); $('missing').disabled = false;
}
function updateRow(e) {
  const row = document.querySelector(`.f[data-id="${escA((window.CSS && CSS.escape) ? CSS.escape(e.id) : e.id)}"]`); if (!row) return;
  row.dataset.path = e.path;
  const st = row.querySelector('.st'); if (!st) return;
  const ok = e.downloaded || e.scanned;
  st.className = 'st ' + (e.error ? 'st-err' : ok ? 'st-ok' : 'st-no');
  st.textContent = e.error ? '\u27f3' : ok ? '\u25cf' : '\u25cb';
  st.title = e.error ? (MSG.failed + (e.errorMsg || 'unknown') + MSG.clickRetry) : ok ? 'In workspace - click to refresh' : MSG.notHere;
}
function updateMissingButton() {
  const b = $('missing'); if (!b) return;
  if (viewMode === 'modules' || viewMode === 'schedules' || viewMode === 'connections' || viewMode === 'actions') { b.style.display = 'none'; return; }
  const arr = viewMode === 'workflows' ? workflowData : treeData;
  const miss = arr.filter((e) => !e.downloaded).length;
  const stale = viewMode === 'functions' ? treeData.filter((e) => e.downloaded && e.stale).length : 0;
  const n = miss + stale;
  // It downloads from Zoho, so on a sample there is nothing it could do. Absent rather than
  // disabled: a greyed button says «there is something here you cannot have», and there is not.
  b.style.display = (n > 0 && !isSample()) ? '' : 'none';
  b.textContent = (stale && !miss) ? `Refresh ${stale} outdated` : `Complete missing (${n})`;
}

// ---------- export a self-contained, shareable HTML report ----------
const EXPORT_CSS = `
:root{--ink:#1f2937;--muted:#6b7280;--accent:#2563eb;--line:#e5e7eb}
*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;z-index:5}
header h1{margin:0 0 4px;font-size:20px}.meta{color:var(--muted);font-size:13px;font-family:ui-monospace,monospace}
.credit{margin-top:6px;color:#94a3b8;font-size:12px}.credit a{color:var(--accent)}
#q{margin-top:10px;width:100%;max-width:520px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px}
main{max-width:1000px;margin:0 auto;padding:24px 20px 80px}
h2{font-size:16px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);border-bottom:2px solid var(--line);padding-bottom:6px;margin:36px 0 10px}
h3.grp{font:12px ui-monospace,monospace;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:22px 0 8px}
h3.grp .cnt{color:#9aa4b2}
.item{border:1px solid var(--line);border-radius:10px;background:#fff;margin:10px 0;overflow:hidden}
.ih{padding:9px 12px;border-bottom:1px solid var(--line);background:#fbfcfe;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ih b{font-size:14px}.ih code{background:#eef1f5;padding:1px 6px;border-radius:5px;font-size:12px;color:#2563eb}
.ih .gen{color:#8b5cf6;font:12px ui-monospace,monospace}
.item{scroll-margin-top:120px}
.refs{padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;display:flex;flex-direction:column;gap:3px;background:#fcfdff}
.refs a,.ftbl td.mono a{color:var(--accent);text-decoration:none}.refs a:hover,.ftbl td.mono a:hover{text-decoration:underline}
.refs .none{color:#9aa4b2}
.badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;text-transform:uppercase}
.badge.rest{background:#ede9fe;color:#6d28d9}.badge.no{background:#fef3c7;color:#92400e}
pre.code{margin:0;padding:12px 14px;background:#0f1622;color:#cbd5e1;font:12.5px/1.55 ui-monospace,monospace;white-space:pre;overflow:auto}
.c-com{color:#5b6b82;font-style:italic}.c-str{color:#7ee0a6}.c-num{color:#e0a86b}.c-kw{color:#7aa2f7;font-weight:600}.c-type{color:#c792ea}.c-fn{color:#82d2ff}
table.ftbl{width:100%;border-collapse:collapse;font:12.5px ui-monospace,monospace}
.ftbl th{background:#f6f8fb;color:var(--muted);text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase}
.ftbl td{padding:5px 10px;border-bottom:1px solid var(--line)}.ftbl td.mono{color:#2563eb}
.toc{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:16px 0}
.toc>h2{margin:0 0 8px;border:0;padding:0}
.toch{font-size:13px;margin:14px 0 6px;color:var(--ink);text-transform:none;letter-spacing:0}
.toctbl{width:100%;border-collapse:collapse;font:12.5px system-ui,-apple-system,sans-serif}
.toctbl th{text-align:left;padding:5px 8px;border-bottom:2px solid var(--line);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.3px}
.toctbl td{padding:4px 8px;border-bottom:1px solid var(--line)}
.toctbl td.mono{font-family:ui-monospace,monospace;color:var(--muted);font-size:11.5px}
.toctbl td.ct{text-align:center}
.toctbl a{color:var(--accent);text-decoration:none}.toctbl a:hover{text-decoration:underline}
.toctbl tbody tr:hover{background:#f6f8fb}
.toctbl .none{color:#9aa4b2;text-align:center}
.wfxcond{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0;background:#fbfcff}
.wfxc{color:#2563eb;font-size:11px;font-weight:600;margin-bottom:4px}
.wfxcrit{font:12px ui-monospace,monospace;color:var(--ink);margin-bottom:4px}.wfxcrit i{color:var(--muted)}
.wfxact{font-size:12px;margin:3px 0}.wfxact b{color:var(--muted);font-weight:600;margin-right:4px}
.wfxact a{color:var(--accent);text-decoration:none}.wfxact a:hover{text-decoration:underline}
.wfact-x{display:inline-block;background:#eef1f5;color:var(--muted);border-radius:5px;padding:1px 6px;margin:1px 3px 0 0;font-size:11px}
.hxcov{font-size:12px;color:var(--muted);line-height:1.6;background:#f6f8fc;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0 14px}
.hxsec{margin:12px 0}.hxsec h3{font-size:13px;margin:0 0 3px;display:flex;align-items:center;gap:8px}
.hxn{font:11px ui-monospace,monospace;padding:1px 8px;border-radius:10px}
.hxn.warn{background:#fdf0d5;color:#8a5a12}.hxn.bad{background:#fbe0e0;color:#b42318}.hxn.ok{background:#d9f3e6;color:#177a4a}
.hxd{font-size:11.5px;color:var(--muted);margin:0 0 6px}
.hxrow{padding:3px 8px;border:1px solid var(--line);border-radius:6px;margin:2px 0;font:12px ui-monospace,monospace}
.hxrow .hxm{color:var(--muted);font-size:11px}
.hxnone{font-size:11.5px;color:#177a4a;margin:0}
.tochx{font-size:12px;margin:2px 0 6px}.tochx a{color:var(--accent);text-decoration:none}
.empty{color:var(--muted)}footer{max-width:1000px;margin:0 auto;padding:0 20px 40px;color:var(--muted);font-size:12px}

tr.relrow.sys td{color:#9aa4b2;background:#fbfbfc}

footer .legal{margin-top:6px;font-size:11px;line-height:1.5;opacity:.75;max-width:70ch}
`;
// The per-area dates, for the reports. A report that says "generated today" while a third of it is
// four months old is the misleading half-truth this whole thread is about - so every report states
// when each part was last read, whether or not anything is behind. The reader gets the fact; nobody
// here decides for them what it means.
function freshnessLine() {
  const parts = TABS.map((t) => {
    const behind = areaStale(t.id) ? ' (behind)' : '';
    return `${tabLabel(t.id)} ${areaAsOf(t.id)}${behind}`;
  });
  return parts.join(' \u00b7 ');
}

function buildExportHtml(fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers, scope) {
  scope = Object.assign({}, SCOPE_DEFAULT, scope || {});
  if (!scope.functions) fns = [];
  if (!scope.modules) mods = [];
  wfs = scope.workflows ? (wfs || []) : []; scheds = scope.schedules ? (scheds || []) : [];
  conns = scope.connections ? (conns || []) : [];
  acts = scope.actions ? (acts || []) : [];
  fails = scope.failures ? (fails || { failures: [] }) : { at: null, usage: null, failures: [] };
  const esc = escHtml;
  const ws = bound || {};
  const now = new Date().toLocaleString();

  // function cross-references (uses / used by), navigable via anchors
  const fnAnchor = (api) => 'fn-' + sanitize(api || '');
  const connAnchor = (name) => 'conn-' + sanitize(name || '');
  const connApiSet = new Set((conns || []).map((c) => c.name));
  const _hByName = {}; Object.values(g.nodes || {}).forEach((n) => (_hByName[n.name] ||= []).push(n));
  const codeResolve = (ns, name) => {
    const nodes = g.nodes || {};
    const t = nodes[ns + '.' + name] || ((_hByName[name] || []).length === 1 ? _hByName[name][0] : null);
    return t ? { href: '#' + fnAnchor(t.api_name), label: t.display_name || t.name } : null;
  };
  const hl = (c) => (window.highlightDeluge ? window.highlightDeluge(c, codeResolve) : esc(c));
  const fnApiSet = new Set(fns.map((f) => f.api_name));
  const fnLink = (api) => (api && fnApiSet.has(api)) ? `<a href="#${fnAnchor(api)}">${esc(api)}</a>` : esc(api || '?');
  const nodeByApi = {}; if (g && g.nodes) Object.values(g.nodes).forEach((n) => { if (n.api_name) nodeByApi[n.api_name] = n; });
  const apiOf = (id) => (g && g.nodes[id] && g.nodes[id].api_name) || null;
  // workflow <-> function wiring
  const fnById = {}, fnByName = {};
  fns.forEach((f) => { fnById[f.id] = f; if (f.name) fnByName[f.name.toLowerCase()] = f; if (f.display_name) fnByName[f.display_name.toLowerCase()] = f; });
  const wfFnActions = (w) => { const acts = []; ((w.detail && w.detail.conditions) || []).forEach((c) => ['instant_actions', 'scheduled_actions'].forEach((bk) => { const b = c[bk]; if (b && b.actions) b.actions.forEach((a) => { if (isFnAction(a)) acts.push(a); }); })); return acts; };
  const resolveFn = (a) => fnById[String(a.id)] || fnByName[(a.name || '').toLowerCase()];
  const triggeredBy = {};
  wfs.forEach((w) => wfFnActions(w).forEach((a) => { const fn = resolveFn(a); if (fn) (triggeredBy[fn.api_name] ||= []).push({ id: w.id, name: w.name }); }));
  const wfAnchor = (id) => 'wf-' + sanitize(String(id));
  const schAnchor = (id) => 'sch-' + sanitize(String(id));
  const scheduledBy = {};
  scheds.forEach((sc) => { const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()]; if (fn) (scheduledBy[fn.api_name] ||= []).push(sc); });
  const assocText = (f) => {
    const ap = f.associated_place || [];
    if (!ap.length) return '';
    const byType = {};
    ap.forEach((p) => { const t = p._type || 'other'; if (t === 'workflow' || t === 'schedule') return; (byType[t] ||= []).push(p.name || '(unnamed)'); });
    const keys = Object.keys(byType).sort();
    return keys.map((t) => `<span><b>Used in ${esc(t)} (${byType[t].length}):</b> ${byType[t].map(esc).join(', ')}</span>`).join('');
  };

  const byNs = {}; fns.forEach((f) => (byNs[f.namespace || 'misc'] ||= []).push(f));
  let fnHtml = '';
  Object.keys(byNs).sort().forEach((ns) => {
    fnHtml += `<h3 class="grp">${esc(ns)} <span class="cnt">${byNs[ns].length}</span></h3>`;
    byNs[ns].sort(byField('api_name')).forEach((f) => {
      const node = nodeByApi[f.api_name];
      const uses = node ? node.calls.map(apiOf).filter(Boolean) : [];
      const usedBy = node ? node.called_by.map(apiOf).filter(Boolean) : [];
      const trig = triggeredBy[f.api_name] || [];
      const refs = f.downloaded ? `<div class="refs">`
        + `<span><b>Uses (${uses.length}):</b> ${uses.length ? uses.map(fnLink).join(', ') : '<span class=\'none\'>none</span>'}</span>`
        + `<span><b>Used by (${usedBy.length}):</b> ${usedBy.length ? usedBy.map(fnLink).join(', ') : '<span class=\'none\'>none (entry point or unused)</span>'}</span>`
        + (trig.length ? `<span><b>Triggered by (${trig.length}):</b> ${trig.map((w) => `<a href="#${wfAnchor(w.id)}">${esc(w.name)}</a>`).join(', ')}</span>` : '')
        + ((scheduledBy[f.api_name] || []).length ? `<span><b>Scheduled by (${scheduledBy[f.api_name].length}):</b> ${scheduledBy[f.api_name].map((sc) => `<a href="#${schAnchor(sc.id)}">${esc(sc.name)}</a>`).join(', ')}</span>` : '')
        + assocText(f)
        + ((f.modulesR || []).length ? `<span><b>Reads (${f.modulesR.length}):</b> ${f.modulesR.map(esc).join(', ')}</span>` : '')
        + ((f.modulesW || []).length ? `<span><b>Writes (${f.modulesW.length}):</b> ${f.modulesW.map(esc).join(', ')}</span>` : '')
        + ((f.modulesT || []).length ? `<span><b>Reached by URL (${f.modulesT.length}):</b> ${f.modulesT.map(esc).join(', ')}</span>` : '')
        + (f.modulesUnknown ? `<span><b>Module not determinable:</b> ${f.modulesUnknown} call(s)</span>` : '')
        + ((scope.connections && (f.connections || []).length) ? `<span><b>Connections (${f.connections.length}):</b> ${f.connections.map((c) => (c.name && connApiSet.has(c.name)) ? `<a href="#${connAnchor(c.name)}">${esc(c.name)}</a>` : esc(c.name)).join(', ')}</span>` : '')
        + (f.stats ? `<span><b>Size:</b> ${f.stats.lines} lines (${f.stats.codeLines} code) · ${(f.stats.chars / 1024).toFixed(1)} KB · <b>outbound calls:</b> ${f.stats.apiCalls || 'none'}${f.stats.apiCalls ? ` (${f.stats.invokeurl} invokeurl, ${f.stats.crm} zoho.crm, ${f.stats.zoho} other${f.stats.sendmail ? ', ' + f.stats.sendmail + ' sendmail' : ''})` : ''}</span>` : '')
        + ((f.modified_by || f.updatedTime) ? `<span><b>Modified:</b> ${f.modified_by ? 'by ' + esc(f.modified_by) : ''}${f.updatedTime ? ' · ' + esc(String(f.updatedTime).slice(0, 16)) : ''}</span>` : '')
        + `</div>` : '';
      fnHtml += `<section class="item" id="${escA(fnAnchor(f.api_name))}" data-name="${escA(((f.api_name || '') + ' ' + (f.display_name || '')).toLowerCase())}">`
        + `<div class="ih"><b>${esc(f.display_name || f.api_name)}</b> <code>${esc(f.api_name)}</code>`
        + `${f.rest ? '<span class="badge rest">REST</span>' : ''}${f.downloaded ? '' : '<span class="badge no">not downloaded</span>'}</div>`
        + `${refs}${(scope.code && f.code) ? `<pre class="code">${hl(f.code)}</pre>` : ''}</section>`;
    });
  });

  // module cross-references (FK links + referenced-by), navigable via anchors
  const modAnchor = (api) => 'mod-' + sanitize(api || '');
  const modApiSet = new Set(mods.map((m) => m.api_name));
  const modLink = (api) => (api && modApiSet.has(api)) ? `<a href="#${modAnchor(api)}">${esc(api)}</a>` : esc(api || '');
  const relsHtmlFor = (m) => {
    const rl = scope.relations ? (m.related_lists || []) : []; if (!rl.length) return '';
    return `<div style="font-weight:700;margin:12px 0 4px;color:#d97706">Related lists (${rl.length}) <span class="none" style="font-weight:400">- API name for zoho.crm.getRelatedRecords()</span></div>`
      + `<table class="ftbl"><thead><tr><th>Relation API</th><th>Label</th><th>Returns</th><th>Type</th></tr></thead><tbody>`
      + rl.map((r) => `<tr><td class="mono"><b>${esc(r.api_name)}</b></td><td>${esc(r.label || '')}</td><td class="mono">${r.module ? modLink(r.module) : esc(r.connected_module || '')}${r.linking_module ? ` <span class="none">via ${esc(r.linking_module)}</span>` : ''}</td><td>${esc(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td></tr>`).join('')
      + `</tbody></table>`;
  };
  const groups = { Standard: [], Custom: [] }; mods.forEach((m) => (m.generated_type === 'custom' ? groups.Custom : groups.Standard).push(m));
  let modHtml = '';
  for (const g2 of ['Standard', 'Custom']) {
    const list = groups[g2]; if (!list.length) continue;
    modHtml += `<h3 class="grp">${g2} <span class="cnt">${list.length}</span></h3>`;
    list.sort(byField('api_name')).forEach((m) => {
      const rows = (m.fields || []).map((fl) => `<tr><td>${esc(fl.label || fl.api_name)}</td><td class="mono">${esc(fl.api_name)}</td><td>${esc(fl.data_type || '')}${fl.length ? ` (${fl.length})` : ''}</td><td style="text-align:center">${fl.mandatory ? '●' : ''}</td><td class="mono">${fl.lookup ? '→ ' + modLink(fl.lookup) : ''}</td><td>${_pick(fl.picklist, 12, esc)}</td></tr>`).join('');
      const inbound = (modRefs && modRefs[m.api_name]) || [];
      const refBy = inbound.length ? `<div class="refs"><span><b>Referenced by (${inbound.length}):</b> ${inbound.map((r) => `${modLink(r.module)} <span class="none">(${esc(r.field)})</span>`).join(', ')}</span></div>` : '';
      const laySrc = !scope.layouts ? [] : ((m._layouts && m._layouts.length) ? m._layouts : (m.layouts || []));
      const layoutsHtml = laySrc.length ? `<div style="font-weight:700;margin:12px 0 4px;color:#7c5cff">Layouts (${laySrc.length})</div>` + laySrc.map((L) => {
        const secArr = Array.isArray(L.sections) ? L.sections : [];
        const secs = secArr.map((sec) => {
          const frows = (sec.fields || []).map((fl) => `<tr><td>${esc(fl.field_label || fl.display_label || fl.api_name)}</td><td class="mono">${esc(fl.api_name || '')}</td><td>${esc(fl.data_type || '')}</td><td style="text-align:center">${fl.required ? '●' : ''}</td></tr>`).join('');
          return `<div style="font-weight:600;margin:8px 0 3px;font-size:12px">${esc(sec.display_label || sec.name || 'Section')} <span class="none">(${(sec.fields || []).length})</span></div><table class="ftbl"><thead><tr><th>Field</th><th>API</th><th>Type</th><th>Req</th></tr></thead><tbody>${frows}</tbody></table>`;
        }).join('');
        const secCount = secArr.length || (typeof L.sections === 'number' ? L.sections : 0);
        return `<details open style="margin-top:6px"><summary style="cursor:pointer"><b>${esc(L.name || String(L.id))}</b>${L.visible === false ? ' <span class=\"none\">(hidden)</span>' : ''} <span class=\"none\">\u00b7 ${secCount} sections</span></summary>${secs || '<div class=\"none\" style=\"padding:4px 0\">Section detail not in this export - re-pull modules for full layout fields.</div>'}</details>`;
      }).join('') : '';
      // A section with three empty tables and no reason reads as a module with nothing in it. The
      // reader of an export cannot ask the panel, which is the whole point of the export.
      const mref = moduleRefusal(m.unreadable);
      modHtml += `<section class="item" id="${escA(modAnchor(m.api_name))}" data-name="${escA(((m.api_name || '') + ' ' + (m.plural_label || m.module_name || '')).toLowerCase())}">`
        + `<div class="ih"><b>${esc(m.plural_label || m.singular_label || m.module_name || m.api_name)}</b> <code>${esc(m.api_name)}</code> <span class="gen">${esc(m.module_name || '')}</span>${laySrc.length ? ` <span class="none">\u00b7 ${laySrc.length} layout(s)</span>` : ''}</div>`
        + (mref ? `<div class="refs"><span><b>Not described by Zoho.</b> ${esc(mref.text)}</span></div>` : '')
        + `${refBy}<table class="ftbl"><thead><tr><th>Field</th><th>API</th><th>Type</th><th>Req</th><th>Lookup</th><th>Picklist</th></tr></thead><tbody>${rows}</tbody></table>${relsHtmlFor(m)}${layoutsHtml}</section>`;
    });
  }

  // Relations: a relation-first catalogue. The ER puts modules first; here the related-list
  // API name is the subject, because that is the string Deluge actually needs.
  const SYS_REL_X = /^(Notes|Attachments|Emails|Tasks|Calls|Events|Tasks_History|Calls_History|Events_History|CheckLists|Activities.*|Zoho_Support|Social|Campaigns_Sent|Invited_Events|Cadences|Timeline|Approvals?)$/i;
  const allRels = [];
  (scope.relations ? mods : []).forEach((m) => (m.related_lists || []).forEach((r) => {
    const child = r.module || r.connected_module || null;
    let via = r.linking_module ? `linking: ${r.linking_module}` : '';
    if (!via && child) {
      const cm = mods.find((x) => x.api_name === child);
      if (cm) { const ff = (cm.fields || []).filter((x) => x.lookup === m.api_name).map((x) => x.api_name); if (ff.length) via = ff.join(' / '); }
    }
    allRels.push({ api: r.api_name, label: r.label || '', parent: m.api_name, child, via, type: r.type || 'default', visible: r.visible !== false, sys: SYS_REL_X.test(r.api_name) || !child });
  }));
  allRels.sort((a, b) => (a.sys - b.sys) || a.parent.localeCompare(b.parent) || a.api.localeCompare(b.api));
  const relRowHtml = (r) => `<tr class="relrow${r.sys ? ' sys' : ''}" data-name="${escA(((r.api || '') + ' ' + (r.label || '') + ' ' + (r.parent || '') + ' ' + (r.child || '')).toLowerCase())}">`
    + `<td class="mono"><b>${esc(r.api)}</b></td><td>${esc(r.label)}</td>`
    + `<td class="mono">${modLink(r.parent)}</td><td class="mono">${r.child ? modLink(r.child) : ''}</td>`
    + `<td class="mono">${esc(r.via || '')}</td><td class="ct">${esc(r.type)}${r.visible ? '' : ' \u00b7 hidden'}</td>`
    + `<td class="mono">zoho.crm.getRelatedRecords("${esc(r.api)}", "${esc(r.parent)}", recordId)</td></tr>`;
  const relHtml = allRels.length
    ? `<p class="hxd">One row per relation. To read a related list in Deluge you need the <b>relation API name</b> - it is not the api_name of either module.</p>`
      + `<table class="ftbl"><thead><tr><th>Relation API name</th><th>Label</th><th>On module</th><th>Returns</th><th>Via</th><th>Type</th><th>Deluge</th></tr></thead><tbody>${allRels.map(relRowHtml).join('')}</tbody></table>`
    : '<p class="empty">No related lists in this export - re-run Pull Modules.</p>';

  // workflows grouped by trigger module
  const wfByMod = {}; wfs.forEach((w) => (wfByMod[w.module || '(no module)'] ||= []).push(w));
  // rich workflow rendering (mirrors the panel detail)
  const wfValOf = (g) => { const v = g.value; if (g.type === 'field' && v && v.api_name) return v.api_name; if (v === '${EMPTY}' || v === '${empty}') return 'empty'; return v == null ? '' : String(v); };
  const wfOne = (g) => `${(g.field && g.field.api_name) || '?'} ${g.comparator || ''} ${wfValOf(g)}`;
  const wfCrit = (crit) => { if (!crit) return ''; if (crit.group && crit.group.length) { const op = crit.group_operator || 'AND'; return crit.group.map((g) => (g.group ? '(' + wfCrit(g) + ')' : wfOne(g))).join(` ${op} `); } if (crit.comparator) return wfOne(crit); return ''; };
  const wfTiming = (bk) => { const ea = bk.execute_after; return (ea && ea.unit != null) ? `after ${ea.unit} ${ea.period || ''}`.trim() : ''; };
  const wfActionHtml = (a) => { if (isFnAction(a)) { const fn = resolveFn(a); return fn ? `<a href="#${fnAnchor(fn.api_name)}">\u0192 ${esc(fn.display_name || fn.api_name)}</a>` : `<span class="none">\u0192 ${esc(a.name)}</span>`; } return `<span class="wfact-x">${esc(a.type)}: ${esc(a.name)}</span>`; };
  let wfHtml = '';
  Object.keys(wfByMod).sort().forEach((mod) => {
    wfHtml += `<h3 class="grp">${esc(mod)} <span class="cnt">${wfByMod[mod].length}</span></h3>`;
    wfByMod[mod].slice().sort(byField('name')).forEach((w) => {
      const d = w.detail;
      const modl = mods.some((m) => m.api_name === w.module) ? `<a href="#${modAnchor(w.module)}">${esc(w.module)}</a>` : esc(w.module || '');
      const head = `<section class="item" id="${escA(wfAnchor(w.id))}" data-name="${escA(((w.name || '') + ' ' + (w.module || '')).toLowerCase())}">`
        + `<div class="ih"><b>${esc(w.name)}</b> <code>${esc(w.type || '')}</code> ${modl}${w.active ? '' : '<span class="badge no">inactive</span>'}</div>`;
      if (!d) { wfHtml += head + `<div class="refs"><span class="none">not downloaded</span></div></section>`; return; }
      const ew = d.execute_when || {}, det = ew.details || {};
      const trigParts = [esc(w.type || ew.type || '')];
      if (det.repeat != null) trigParts.push(`repeat: ${det.repeat ? 'yes' : 'no'}`);
      if (Array.isArray(det.fields) && det.fields.length) trigParts.push(`fields: ${det.fields.map((fl) => esc((fl.field && fl.field.api_name) || fl.api_name || String(fl))).join(', ')}`);
      const ewCrit = wfCrit(det.criteria || ew.criteria);
      let meta = `<div class="refs"><span><b>Trigger:</b> ${trigParts.join(' \u00b7 ')}</span>`;
      if (ewCrit) meta += `<span><b>When:</b> ${esc(ewCrit)}</span>`;
      if (d.description) meta += `<span><b>Description:</b> ${esc(d.description)}</span>`;
      meta += `</div>`;
      let condHtml = '';
      (d.conditions || []).forEach((c, i) => {
        const cd = c.criteria_details || {};
        const ct = wfCrit(cd.criteria);
        const rel = cd.relational_criteria;
        let actsHtml = '';
        const inst = (c.instant_actions && c.instant_actions.actions) || [];
        if (inst.length) actsHtml += `<div class="wfxact"><b>Instant:</b> ${inst.map(wfActionHtml).join(' ')}</div>`;
        const sched = Array.isArray(c.scheduled_actions) ? c.scheduled_actions : (c.scheduled_actions && c.scheduled_actions.actions ? [c.scheduled_actions] : []);
        sched.forEach((bk) => { const acts = bk.actions || []; const tim = wfTiming(bk); if (acts.length) actsHtml += `<div class="wfxact"><b>Scheduled${tim ? ` (${tim})` : ''}:</b> ${acts.map(wfActionHtml).join(' ')}</div>`; });
        condHtml += `<div class="wfxcond"><div class="wfxc">Condition ${c.sequence_number || i + 1}</div>`
          + (ct ? `<div class="wfxcrit">${esc(ct)}</div>` : '')
          + (rel && (rel.module || rel.criteria) ? `<div class="wfxcrit"><i>related:</i> ${esc((rel.module && rel.module.api_name) || rel.module || '')} ${esc(wfCrit(rel.criteria))}</div>` : '')
          + actsHtml + `</div>`;
      });
      wfHtml += head + meta + condHtml + `</section>`;
    });
  });
  const wfRows = [];
  Object.keys(wfByMod).sort().forEach((mod) => wfByMod[mod].slice().sort(byField('name')).forEach((w) => {
    const wsc = wfScheduled(w.detail);
    wfRows.push(`<tr><td><a href="#${wfAnchor(w.id)}">${esc(w.name)}</a></td><td class="mono">${esc(w.module || '')}</td><td class="ct">${esc(w.type || '')}</td><td class="ct">${w.active ? '\u25cf' : ''}</td><td class="ct">${wfFnActions(w).length}</td><td class="ct">${wsc.count || ''}</td><td class="ct">${esc(((w.detail && w.detail.last_executed_time) || '').slice(0, 16))}</td></tr>`);
  }));

  // schedules
  let schHtml = '';
  scheds.slice().sort(byField('name')).forEach((sc) => {
    const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()];
    const fl = fn ? `<a href="#${fnAnchor(fn.api_name)}">${esc(fn.display_name || fn.api_name)}</a>` : `<span class="none">${esc(sc.function_name || '?')}</span>`;
    schHtml += `<section class="item" id="${escA(schAnchor(sc.id))}" data-name="${escA(((sc.name || '') + ' ' + (sc.function_name || '')).toLowerCase())}">`
      + `<div class="ih"><b>${esc(sc.name)}</b> <code>${esc(sc.frequency || '')}</code>${sc.status !== 'active' ? `<span class="badge no">${esc(sc.status || '')}</span>` : ''}</div>`
      + `<div class="refs"><span><b>Runs function:</b> ${fl}</span>${sc.next ? `<span><b>Next:</b> ${esc(sc.next)}</span>` : ''}</div></section>`;
  });
  const schRows = scheds.slice().sort(byField('name')).map((sc) => {
    const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()];
    const fl = fn ? `<a href="#${fnAnchor(fn.api_name)}">${esc(fn.display_name || fn.api_name)}</a>` : esc(sc.function_name || '?');
    return `<tr><td><a href="#${schAnchor(sc.id)}">${esc(sc.name)}</a></td><td>${fl}</td><td class="ct">${esc(sc.frequency || '')}</td><td class="ct">${sc.status === 'active' ? '\u25cf' : esc(sc.status || '')}</td></tr>`;
  });

  // health / audit (same checks as the panel, rendered statically with links to #fn anchors)
  const hNodes = Object.values(g.nodes || {});
  const hById = {}, hByAny = {};
  hNodes.forEach((n) => { if (n.id) hById[String(n.id)] = n; [n.name, n.api_name, n.display_name].forEach((k) => { if (k) hByAny[String(k).toLowerCase()] = n; }); });
  const hLink = (n) => `<a href="#${fnAnchor(n.api_name)}">${esc(n.display_name || n.name)}</a>`;
  const hOrph = hNodes.filter((n) => n.dead_suspect).sort((a, b) => (a.display_name || a.name || '').localeCompare(b.display_name || b.name || ''));
  const hUnres = hNodes.filter((n) => n.unresolved && n.unresolved.length);
  const hAmbig = hNodes.filter((n) => n.ambiguous && n.ambiguous.length);
  // Informational rankings, deliberately kept out of the issue total below: they are not defects.
  const hStat = hNodes.filter((n) => n.stats && n.stats.lines);
  const hBig = hStat.slice().sort((a, b) => b.stats.lines - a.stats.lines).slice(0, 15);
  const hChatty = hStat.filter((n) => n.stats.apiCalls > 0).sort((a, b) => b.stats.apiCalls - a.stats.apiCalls).slice(0, 15);
  const hBroken = [];
  wfs.forEach((w) => { if (!w.detail) return; (w.detail.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter(isFnAction).forEach((a) => { if (!(hById[String(a.id)] || hByAny[(a.name || '').toLowerCase()])) hBroken.push({ kind: 'workflow', id: w.id, name: w.name, fn: a.name }); }); }); });
  scheds.forEach((sc) => { if (!(hById[String(sc.function_id)] || hByAny[(sc.function_name || '').toLowerCase()])) hBroken.push({ kind: 'schedule', id: sc.id, name: sc.name, fn: sc.function_name }); });
  const hModSet = new Set(mods.map((m) => m.api_name));
  const hFK = [];
  mods.forEach((m) => { if (/__s$/.test(m.api_name || '')) return; (m.fields || []).forEach((fl) => { let t = fl.lookup; if (t && typeof t === 'object') t = t.api_name || (t.module && (t.module.api_name || t.module)) || null; if (!t || typeof t !== 'string') return; if (/__s$/.test(t)) return; if (!hModSet.has(t)) hFK.push({ module: m.api_name, field: fl.api_name || fl.label, target: t }); }); });
  const hSec = (title, count, desc, rows, bad) => `<div class="hxsec"><h3>${esc(title)} <span class="hxn ${count ? (bad ? 'bad' : 'warn') : 'ok'}">${count}</span></h3>${desc ? `<p class="hxd">${desc}</p>` : ''}${count ? rows : '<p class="hxnone">None</p>'}</div>`;
  const healthHtml =
    `<div class="hxcov"><b>Coverage.</b> Analyzed: function\u2192function calls, workflows, schedules, and each function's <i>associated_place</i> (blueprint, button, \u2026). <b>Not</b> analyzed: custom client scripts, approval/assignment/scoring rules. Items are <b>candidates to review</b>, never automatic deletions.</div>`
    + hSec(MSG.hOrphan, hOrph.length, 'No caller in code, not REST, no associated_place.', hOrph.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.namespace || '')}</span></div>`).join(''))
    + hSec(MSG.hUnresolved, hUnres.length, 'Calls a function that does not resolve in this workspace.', hUnres.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.unresolved.join(', '))}</span></div>`).join(''), true)
    + hSec(MSG.hAmbiguous, hAmbig.length, 'A call matches more than one function.', hAmbig.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.ambiguous.join(', '))}</span></div>`).join(''))
    + hSec(MSG.hBroken, hBroken.length, 'A workflow/schedule references a function not in this workspace.', hBroken.map((b) => `<div class="hxrow">${esc(b.kind)} <a href="#${b.kind === 'workflow' ? wfAnchor(b.id) : schAnchor(b.id)}">${esc(b.name || '?')}</a> <span class="hxm">\u2192 missing \u00ab${esc(b.fn || '?')}\u00bb</span></div>`).join(''), true)
    + hSec(MSG.hMissingRefs, hFK.length, 'A lookup points to a module not in this workspace.', hFK.map((r) => `<div class="hxrow"><b>${esc(r.module)}</b>.${esc(r.field)} <span class="hxm">\u2192 ${esc(r.target)}</span></div>`).join(''))
    + hSec(MSG.hBiggest, hBig.length, MSG.hBiggestDesc, hBig.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${n.stats.lines} lines \u00b7 ${n.stats.codeLines} code \u00b7 ${(n.stats.chars / 1024).toFixed(1)} KB</span></div>`).join(''))
    + hSec(MSG.hChattiest, hChatty.length, 'invokeurl, zoho.crm and other Zoho service tasks, counted outside comments and strings.', hChatty.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${n.stats.apiCalls} calls - ${n.stats.invokeurl} invokeurl \u00b7 ${n.stats.crm} zoho.crm \u00b7 ${n.stats.zoho} other${n.stats.sendmail ? ' \u00b7 ' + n.stats.sendmail + ' sendmail' : ''}</span></div>`).join(''))
    ;
  const healthTotal = hOrph.length + hUnres.length + hAmbig.length + hBroken.length + hFK.length;

  // Contents index: informative tables (one row per item) for functions and modules
  const fnRows = [];
  Object.keys(byNs).sort().forEach((ns) => {
    byNs[ns].slice().sort(byField('api_name')).forEach((f) => {
      const n = nodeByApi[f.api_name];
      fnRows.push(`<tr><td><a href="#${fnAnchor(f.api_name)}">${esc(f.display_name || f.api_name)}</a></td>`
        + `<td class="mono">${esc(f.api_name)}</td><td class="mono">${esc(ns)}</td>`
        + `<td class="ct">${f.rest ? '\u25cf' : ''}</td><td class="ct">${f.downloaded ? '' : '\u2014'}</td>`
        + `<td class="ct">${n ? n.calls.length : 0}</td><td class="ct">${n ? n.called_by.length : 0}</td>`
        + `<td class="ct">${f.stats ? f.stats.lines : ''}</td><td class="ct">${f.stats ? f.stats.apiCalls : ''}</td></tr>`);
    });
  });
  const modRows = [];
  ['Standard', 'Custom'].forEach((k) => groups[k].slice().sort(byField('api_name')).forEach((m) => {
    const rb = (modRefs && modRefs[m.api_name]) ? modRefs[m.api_name].length : 0;
    modRows.push(`<tr><td><a href="#${modAnchor(m.api_name)}">${esc(m.plural_label || m.singular_label || m.module_name || m.api_name)}</a></td>`
      + `<td class="mono">${esc(m.api_name)}</td><td class="mono">${esc(m.module_name || '')}</td>`
      + `<td class="ct">${k}</td><td class="ct">${(m.fields || []).length ? (m.fields || []).length : (m.unreadable ? `<span title="${escA(moduleRefusal(m.unreadable).text)}">not described</span>` : 0)}</td><td class="ct">${rb}</td></tr>`);
  }));
  // Connections: catalogue + which functions use each
  const connRows = (conns || []).slice().sort((a, b) => (b.uses.length - a.uses.length) || byField('name')(a, b)).map((c) => {
    const usesLinks = c.uses.length ? c.uses.map(fnLink).join(', ') : '<span class="none">none</span>';
    const status = c.missing ? '<span style="color:#b45309">not in catalogue</span>' : c.connected === false ? '<span style="color:#b45309">not connected</span>' : 'connected';
    return `<tr id="${escA(connAnchor(c.name))}"><td class="mono"><b>${esc(c.name)}</b></td><td>${esc(c.label || '')}</td><td class="mono">${esc(c.connector || '')}</td><td class="ct">${status}</td><td class="ct">${c.uses.length}</td><td>${usesLinks}</td></tr>`;
  });
  // Automation actions. The count of rules that fire each is the column the chapter exists for, and
  // the sender address is the one field a reader may not be allowed to receive - so it has a scope of
  // its own, off by default, and what was withheld is stated rather than left blank.
  const actWithheld = acts.filter((a) => a.from_address).length;
  const actRows = acts.slice().sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || byField('name')(a, b))
    .map((a) => {
      const users = (actUsers && actUsers.get(a.kind + ':' + String(a.id))) || [];
      const detail = a.kind === 'email_notifications'
        ? [a.template ? 'template: ' + esc(a.template.name || a.template.id) : '',
           a.from_type ? 'from: ' + (scope.addresses && a.from_address ? esc(a.from_address) : esc(a.from_type === 'user' ? 'a user address' : 'an organisation address')) : '',
           a.recipient_count != null ? esc(String(a.recipient_count)) + ' recipient(s)' : ''].filter(Boolean).join(' \u00b7 ')
        : a.kind === 'field_updates' ? (a.field ? esc(a.field) + (a.field_type ? ' (' + esc(a.field_type) + ')' : '')
            + ' \u2190 ' + (actStale(a) ? 'not read by this pull' : (a.value === null || a.value === undefined) ? 'cleared' : esc(String(a.value))) : '')
        : a.kind === 'webhooks' ? [esc(a.method || ''), esc(a.url || '')].filter(Boolean).join(' ')
        : a.notify === true ? 'notifies' : '';
      return '<tr><td>' + esc(a.name || a.id) + '</td><td>' + esc(actionKindLabel(a.kind)) + '</td><td>' + esc(a.module || '') + '</td>'
        + '<td class="num">' + users.length + '</td><td>' + users.map((w) => esc(w.name || w.id)).join(', ') + '</td><td>' + detail + '</td></tr>';
    });
  const actHtml = acts.length
    ? '<p class="hxd">What a workflow rule fires, and which rules fire it. \u00abFired by\u00bb is read from the rules in this workspace, so a rule that was never pulled cannot appear in it.</p>'
      + ((actWithheld && !scope.addresses) ? `<p class="note">${actWithheld} sender address(es) withheld - that section was left off. Nothing else about those notifications is missing.</p>` : '')
      + `<table class="ftbl"><thead><tr><th>Action</th><th>Kind</th><th>Module</th><th>Rules</th><th>Fired by</th><th>Detail</th></tr></thead><tbody>${actRows.join('')}</tbody></table>`
    : '';
  const connHtml = conns.length
    ? `<p class="hxd">The org's connections and the functions that use each - the join key is the name in <code>invokeurl […connection:"…"]</code>.</p><table class="ftbl"><thead><tr><th>Connection</th><th>Label</th><th>Connector</th><th>Status</th><th>Uses</th><th>Used by functions</th></tr></thead><tbody>${connRows.join('')}</tbody></table>`
    : '<p class="empty">No connections in this export.</p>';
  // Failures. A chapter that says *when it was read* in its own heading, because unlike every other
  // one here it is a reading of a runtime rather than of a structure - a report that presented it as
  // durable would be claiming something the data cannot support.
  const failRows = (fails.failures || []).slice().sort((a, b) => (b.count - a.count) || String(b.lastFailedAt || '').localeCompare(String(a.lastFailedAt || '')));
  const failHtml = failRows.length || fails.usage ? (
    `<p class="note">Read from Zoho on ${esc(fails.at ? new Date(fails.at).toLocaleString() : 'an unknown date')}. `
    + (fails.usage
        ? `In the 24 hours before that: ${esc(String(fails.usage.success ?? 'unknown'))} run(s), ${esc(String(fails.usage.failure ?? 'unknown'))} failed. `
        : '')
    + 'The input of each failed execution stays in Zoho - Zoost does not read it.</p>'
    + (failRows.length
        ? '<table><thead><tr><th>Function</th><th>Invoked by</th><th>Times</th><th>Last failure</th><th>Reason</th></tr></thead><tbody>'
          + failRows.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.componentType || '')}</td><td>${esc(String(f.count))}</td>`
              + `<td>${esc(f.lastFailedAt ? new Date(f.lastFailedAt).toLocaleString() : '')}</td><td>${esc(f.reason || '')}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p class="empty">Nothing had failed when this was read.</p>')
  ) : '';
  const toc = `<nav class="toc"><h2>Contents</h2>`
    + `<h3 class="toch">Functions (${fns.length})</h3>`
    + `<table class="toctbl"><thead><tr><th>Function</th><th>API name</th><th>Namespace</th><th>REST</th><th>DL</th><th>Uses</th><th>Used by</th><th title="source lines">Lines</th><th title="invokeurl + Zoho service tasks">Calls</th></tr></thead><tbody>${fnRows.join('') || '<tr><td colspan="9" class="none">none</td></tr>'}</tbody></table>`
    + `<h3 class="toch">Modules (${mods.length})</h3>`
    + `<table class="toctbl"><thead><tr><th>Module</th><th>API name</th><th>Generated</th><th>Kind</th><th>Fields</th><th>Ref by</th></tr></thead><tbody>${modRows.join('') || '<tr><td colspan="6" class="none">none</td></tr>'}</tbody></table>`
    + (wfs.length ? `<h3 class="toch">Workflows (${wfs.length})</h3><table class="toctbl"><thead><tr><th>Workflow</th><th>Module</th><th>Trigger</th><th>Active</th><th>Fn calls</th><th title="Actions that do not run immediately">Scheduled</th><th>Last run</th></tr></thead><tbody>${wfRows.join('')}</tbody></table>` : '')
    + (scheds.length ? `<h3 class="toch">Schedules (${scheds.length})</h3><table class="toctbl"><thead><tr><th>Schedule</th><th>Function</th><th>Frequency</th><th>Status</th></tr></thead><tbody>${schRows.join('')}</tbody></table>` : '')
    + (allRels.length ? `<h3 class="toch">Relations (${allRels.length})</h3><div class="tochx"><a href="#relations">Relation-first catalogue - related-list API names for Deluge</a></div>` : '')
    + (acts.length ? `<h3 class="toch">Actions (${acts.length})</h3><div class="tochx"><a href="#actions">Notifications, field updates, tasks and webhooks - and which rules fire each</a></div>` : '')
    + (acts.length ? `<h3 class="toch">Actions (${acts.length})</h3><div class="tochx"><a href="#actions">Notifications, field updates, tasks and webhooks - and which rules fire each</a></div>` : '')
    + (conns.length ? `<h3 class="toch">Connections (${conns.length})</h3><div class="tochx"><a href="#connections">Catalogue - connectors, status, and which functions use each</a></div>` : '')
    + (failRows.length ? `<h3 class="toch">Failures (${failRows.length})</h3><div class="tochx"><a href="#failures">What is breaking, as read on ${esc(fails.at ? new Date(fails.at).toLocaleDateString() : 'an unknown date')}</a></div>` : '')
    + (scope.health ? `<h3 class="toch">Health <span class="cnt">${healthTotal}</span></h3><div class="tochx"><a href="#health">Orphans ${hOrph.length} \u00b7 Unresolved ${hUnres.length} \u00b7 Ambiguous ${hAmbig.length} \u00b7 Broken ${hBroken.length} \u00b7 Missing FK ${hFK.length}</a></div>` : '')
    + `</nav>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(PRODUCT_NAME)} - ${esc(ws.label || ws.instance || 'Export')}</title>`
    + `<meta name="author" content="${escA(PRODUCT_AUTHOR)}"><meta name="generator" content="${escA(PRODUCT_NAME)}"><meta name="description" content="Export of Zoho CRM Deluge functions and module schema.">${PRODUCT_URL ? `<link rel="canonical" href="${escA(PRODUCT_URL)}">` : ''}`
    + `<style>${EXPORT_CSS}</style></head><body>`
    + `<header><h1>${esc(PRODUCT_NAME)} - Export</h1>`
    + `<div class="meta">${ws.label ? `${esc(ws.label)} · ` : ''}${esc(ws.instance || '')} · org ${esc(ws.org || '')} · ${esc(envOf(ws.base))} · ${esc(now)} · ${fns.length} functions · ${mods.length} modules · contents: ${esc(SCOPE_KEYS.filter((k) => scope[k]).join(', ') || 'nothing')}${scope.code ? '' : ' · source code excluded'}</div>`
    + `<div class="meta">Data read from Zoho: ${esc(freshnessLine())}</div>`
    + `<input id="q" placeholder="Filter functions & modules…" oninput="filt()"></header>`
    + `<main>${toc}<h2 id="functions">Functions</h2>${fnHtml || '<p class="empty">No functions.</p>'}<h2 id="modules">Modules</h2>${modHtml || '<p class="empty">No modules.</p>'}<h2 id="relations">Relations</h2>${relHtml}${wfs.length ? `<h2 id="workflows">Workflows</h2>${wfHtml}` : ''}${scheds.length ? `<h2 id="schedules">Schedules</h2>${schHtml}` : ''}${acts.length ? `<h2 id="actions">Actions</h2>${actHtml}` : ''}${acts.length ? `<h2 id="actions">Actions</h2>${actHtml}` : ''}${conns.length ? `<h2 id="connections">Connections</h2>${connHtml}` : ''}${failHtml ? `<h2 id="failures">Failures</h2>${failHtml}` : ''}${scope.health ? `<h2 id="health">Health</h2>${healthHtml}` : ''}</main>`
    + `<footer><div>Generated by ${PRODUCT_URL ? `<a href="${escA(PRODUCT_URL)}">${esc(PRODUCT_NAME)}</a>` : esc(PRODUCT_NAME)} · Created by ${esc(PRODUCT_AUTHOR)}${SPONSOR_URL ? ` · <a href="${escA(SPONSOR_URL)}">Sponsor</a>` : ''}${KOFI_URL ? ` · <a href="${escA(KOFI_URL)}">\u2615 Ko-fi</a>` : ''}</div><div class="legal">${esc(LEGAL_DISCLAIMER)}</div></footer>`
    + `<script>function filt(){var q=document.getElementById('q').value.trim().toLowerCase();document.querySelectorAll('.item').forEach(function(s){s.style.display=(!q||s.dataset.name.indexOf(q)>=0)?'':'none';});document.querySelectorAll('tr.relrow').forEach(function(r){r.style.display=(!q||r.dataset.name.indexOf(q)>=0)?'':'none';});}<\/script></body></html>`;
}

async function loadExportData() {
    const metaById = new Map();
  for await (const p of walk(dir)) {
    if (p.endsWith('.meta.json')) { try { const m = JSON.parse(await readFile(p)); metaById.set(String(m.id), { meta: m, dg: p.replace(/\.meta\.json$/, '.dg') }); } catch (_) {} }
  }
  let idx = null; try { idx = JSON.parse(await readFile('functions/index.json')); } catch (_) {}
  const entries = (idx && idx.length) ? idx : [...metaById.values()].map((v) => ({ id: v.meta.id, api_name: v.meta.api_name, display_name: v.meta.display_name, namespace: v.meta.nameSpace, category: v.meta.category, source: v.meta.source, rest: (v.meta.rest_api || []).some((r) => r.active) }));
  const fns = [];
  for (const e of entries) {
    const d = metaById.get(String(e.id)); let code = '';
    if (d) { try { code = await readFile(d.dg); } catch (_) {} }
    fns.push({ api_name: e.api_name, display_name: e.display_name || e.api_name, namespace: (d && (d.meta.nameSpace)) || e.namespace, rest: e.rest, code, downloaded: !!d, associated_place: (d && d.meta && d.meta.associated_place) || null, modified_by: (d && d.meta.modified_by) || null, updatedTime: (d && d.meta.updatedTime) || null, connections: (d && d.meta.connections) || [], stats: d ? fnStats(code) : null });
  }
  const mods = [];
  for await (const p of walk(dir)) { if (isModuleFile(p)) { try { const m = JSON.parse(await readFile(p)); try { m._layouts = JSON.parse(await readFile(`modules/layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) { m._layouts = []; } mods.push(m); } catch (_) {} } }
  let g = null; try { g = await ensureGraph(); } catch (_) {}
  // The module reading, resolved once for both reports. It is done here rather than in each builder
  // because the two must not be able to disagree - a reader moves between the HTML and the Markdown
  // and a number that differs between them is worse than a number missing from one.
  if (g) {
    const known = await moduleNames();
    const byKey = new Map();
    for (const n of Object.values(g.nodes)) {
      if (!n.file) continue;
      const r = [], w = [], tc = [];
      for (const m of n.modules || []) {
        if (!known.has(m.name)) continue;
        const b = m.mode === 'write' ? w : m.mode === 'read' ? r : tc;
        if (!b.includes(m.name)) b.push(m.name);
      }
      n.modulesR = r.sort(); n.modulesW = w.sort(); n.modulesT = tc.sort();
      byKey.set((n.namespace || '') + '.' + (n.api_name || n.name), n);
    }
    fns.forEach((f) => {
      const n = byKey.get((f.namespace || '') + '.' + (f.api_name || ''));
      if (!n) return;
      f.modulesR = n.modulesR; f.modulesW = n.modulesW; f.modulesT = n.modulesT;
      f.modulesUnknown = n.modulesUnknown || 0;
    });
  }
  const modRefs = {};
  mods.forEach((m) => (m.fields || []).forEach((fl) => { if (fl.lookup) (modRefs[fl.lookup] ||= []).push({ module: m.api_name, field: fl.api_name }); }));
  const wfs = [];
  let wfIdx = []; try { wfIdx = JSON.parse(await readFile('workflows/index.json')); } catch (_) {}
  for (const w of wfIdx) { let detail = null; try { detail = JSON.parse(await readFile(`workflows/${w.id}.json`)); } catch (_) {} wfs.push({ ...w, id: String(w.id), detail }); }
  let scheds = []; try { scheds = JSON.parse(await readFile('schedules/index.json')); } catch (_) {}
  // connections catalogue + usage (which functions reference each), joined on connectionLinkName
  let connCat = []; try { connCat = JSON.parse(await readFile('connections/index.json')); } catch (_) {}
  if (!Array.isArray(connCat)) connCat = [];
  const connUse = {};
  fns.forEach((f) => (f.connections || []).forEach((c) => { if (c && c.name) (connUse[c.name] ||= []).push(f.api_name); }));
  const conns = connCat.map((c) => ({ ...c, uses: (connUse[c.name] || []).slice() }));
  const catNames = new Set(connCat.map((c) => c.name));
  Object.keys(connUse).forEach((name) => { if (!catNames.has(name)) conns.push({ name, label: name, connector: null, connected: null, missing: true, uses: connUse[name].slice() }); });
  // The failures index is one file that says when it was read - not a folder - so it is loaded
  // whole and carries its own date into the report. `params` is not in it: the bridge never sent it.
  let fails = { at: null, usage: null, failures: [] };
  try { const d = JSON.parse(await readFile('failures/index.json')); if (d && Array.isArray(d.failures)) fails = d; } catch (_) {}
  // The automation actions, and the map of which rules fire each - built from the rules that were
  // just read rather than from the panel's cache, because an export must not depend on which tab
  // the reader happened to open.
  let acts = []; try { const a = JSON.parse(await readFile('actions/index.json')); if (Array.isArray(a)) acts = a; } catch (_) {}
  const actUsers = new Map();
  wfs.forEach((w) => ((w.detail && w.detail.conditions) || []).forEach((c) => {
    const list = [];
    if (c.instant_actions && c.instant_actions.actions) list.push(...c.instant_actions.actions);
    (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => list.push(...(sa.actions || [])));
    list.forEach((a) => { if (!a || !a.type) return; const k = a.type + ':' + String(a.id);
      if (!actUsers.has(k)) actUsers.set(k, []);
      if (!actUsers.get(k).some((x) => String(x.id) === String(w.id))) actUsers.get(k).push({ id: w.id, name: w.name }); });
  }));
  return { fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers };
}
function _mdCell(x) { return String(x == null ? '' : x).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function buildExportMarkdown(d, scope) {
  scope = Object.assign({}, SCOPE_DEFAULT, scope || {});
  let { mods, g, wfs, scheds, conns, fails, acts } = d;
  if (!scope.modules) mods = [];
  if (!scope.workflows) wfs = [];
  if (!scope.schedules) scheds = [];
  conns = scope.connections ? (conns || []) : [];
  acts = scope.actions ? (acts || []) : [];
  fails = scope.failures ? (fails || { failures: [] }) : { at: null, usage: null, failures: [] };
  const nodes = scope.functions ? ((g && g.nodes) || {}) : {};
  const fnList = Object.values(nodes).sort((a, b) => (a.namespace + '.' + a.name).localeCompare(b.namespace + '.' + b.name));
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const inst = (bound && bound.instance) || 'workspace', org = (bound && bound.org) || '?', env = bound ? envOf(bound.base) : '?';
  const first = (t) => (t || '').split('\n')[0].slice(0, 120);
  const params = (n) => '(' + ((n.params || []).map((p) => (p && (p.name || p.param_name)) || p).filter(Boolean).join(', ')) + ')';
  const wfFns = (w) => { const out = []; const det = w.detail; if (det) (det.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter(isFnAction).forEach((a) => out.push(a.name)); }); return [...new Set(out)]; };
  let md = '# Zoho CRM Deluge - Workspace export (AI context)\n\n';
  if (bound && bound.label) md += `- Workspace: ${bound.label}\n`;
  md += `- Instance: ${inst}\n- Org: ${org}\n- Environment: ${env}\n- Generated: ${now}\n- Functions: ${fnList.length} \u00b7 Modules: ${mods.length} \u00b7 Workflows: ${wfs.length} \u00b7 Schedules: ${scheds.length}\n`;
  md += `- Data read from Zoho: ${freshnessLine()}\n\n`;
  md += `- Contents: ${SCOPE_KEYS.filter((k) => scope[k]).join(', ') || 'nothing'}\n\n`;
  md += '> Self-contained, read-only snapshot of this Zoho CRM org\'s Deluge functions, module schema, and automations. Intended as context for an AI assistant used outside the extension.\n\n';
  md += '## Index\n\n### Functions\n';
  fnList.forEach((n) => { const used = [...new Set((n.associated_place || []).map((p) => p._type).filter(Boolean))]; md += `- \`${n.namespace}.${n.name}\`${params(n)}${n.return_type ? ' \u2192 ' + n.return_type : ''}${n.rest ? ' \u00b7 REST' : ''}${used.length ? ' \u00b7 used in ' + used.join('/') : ''}${n.stats ? ` \u00b7 ${n.stats.lines} lines \u00b7 ${n.stats.apiCalls} API call(s)` : ''}${n.description ? ' - ' + first(n.description) : ''}\n`; });
  md += '\n### Modules\n';
  mods.slice().sort(byField('api_name')).forEach((m) => { md += `- \`${m.api_name}\` - ${m.unreadable ? 'not described by Zoho' : `${(m.fields || []).length} fields`}\n`; });
  if (wfs.length) {
    md += '\n### Workflows\n';
    wfs.forEach((w) => {
      const fl = wfFns(w); const wsc = wfScheduled(w.detail);
      const last = (w.detail && w.detail.last_executed_time) || '';
      md += `- ${w.name}${w.module ? ' (' + w.module + ')' : ''}${fl.length ? ' \u2192 ' + fl.join(', ') : ''}`
        + `${wsc.count ? ` \u00b7 ${wsc.count} scheduled${wsc.delays.length ? ' after ' + wsc.delays.join(', ') : ''}` : ''}`
        + `${last ? ' \u00b7 last run ' + String(last).slice(0, 16) : ''}\n`;
    });
  }
  if (scheds.length) { md += '\n### Schedules\n'; scheds.forEach((sc) => { md += `- ${sc.name} \u2192 ${sc.function_name || '?'}${sc.frequency ? ' (' + sc.frequency + ')' : ''}\n`; }); }
  if (fnList.length) md += `\n---\n\n## Functions${scope.code ? ' (full source)' : ' (signatures only - source code excluded from this export)'}\n\n`;
  fnList.forEach((n) => {
    md += `### ${n.namespace}.${n.name}\n\n`;
    md += `- api_name: \`${n.api_name || ''}\`${n.return_type ? ` \u00b7 returns ${n.return_type}` : ''}${n.rest ? ' \u00b7 REST-enabled' : ''}\n`;
    if (n.calls && n.calls.length) md += `- calls: ${n.calls.join(', ')}\n`;
    if (n.called_by && n.called_by.length) md += `- called by: ${n.called_by.join(', ')}\n`;
    if (n.associated_place && n.associated_place.length) md += `- used in: ${n.associated_place.map((p) => `${p._type}${p.name ? ' ' + p.name : ''}`).join('; ')}\n`;
    if (n.stats) md += `- size: ${n.stats.lines} lines (${n.stats.codeLines} code) · ${(n.stats.chars / 1024).toFixed(1)} KB\n- outbound calls: ${n.stats.apiCalls || 'none'}${n.stats.apiCalls ? ` (${n.stats.invokeurl} invokeurl, ${n.stats.crm} zoho.crm, ${n.stats.zoho} other Zoho${n.stats.sendmail ? `, ${n.stats.sendmail} sendmail` : ''})` : ''}\n`;
    if (scope.connections && n.connections && n.connections.length) md += `- connections: ${n.connections.map((c) => c.name).join(', ')}\n`;
    // What the code does to the org's modules. Read and write are kept apart here as on screen, and
    // the calls whose module is computed are stated rather than dropped - a report that quietly
    // omits what it could not read is a lesser copy of the panel, which is the one thing an export
    // must never be.
    if (n.modulesR && n.modulesR.length) md += `- reads modules: ${n.modulesR.join(', ')}\n`;
    if (n.modulesW && n.modulesW.length) md += `- writes modules: ${n.modulesW.join(', ')}\n`;
    if (n.modulesT && n.modulesT.length) md += `- reaches by URL: ${n.modulesT.join(', ')}\n`;
    if (n.modulesUnknown) md += `- module not determinable in ${n.modulesUnknown} call(s)\n`;
    if (n.modified_by || n.updatedTime) md += `- modified: ${n.modified_by ? 'by ' + n.modified_by : ''}${n.updatedTime ? ' · ' + String(n.updatedTime).slice(0, 16) : ''}\n`;
    md += scope.code ? ('\n```deluge\n' + String(n.source_code || '').replace(/```/g, '`\u200b``') + '\n```\n\n') : '\n';
  });
  // Relation-first catalogue: this is the section an LLM should hit when asked
  // \"how do I read the related data of a contact?\"
  const SYS_REL_M = /^(Notes|Attachments|Emails|Tasks|Calls|Events|Tasks_History|Calls_History|Events_History|CheckLists|Activities.*|Zoho_Support|Social|Campaigns_Sent|Invited_Events|Cadences|Timeline|Approvals?)$/i;
  const rels = [];
  mods.forEach((m) => (m.related_lists || []).forEach((r) => {
    const child = r.module || r.connected_module || null;
    let via = r.linking_module ? `linking module ${r.linking_module}` : '';
    if (!via && child) {
      const cm = mods.find((x) => x.api_name === child);
      if (cm) { const ff = (cm.fields || []).filter((x) => x.lookup === m.api_name).map((x) => x.api_name); if (ff.length) via = `lookup ${ff.join(' / ')}`; }
    }
    rels.push({ api: r.api_name, label: r.label || '', parent: m.api_name, child, via, type: r.type || 'default', sys: SYS_REL_M.test(r.api_name) || !child });
  }));
  if (rels.length && scope.relations) {
    md += '---\n\n## Relations (related lists)\n\n';
    md += 'To read a related list in Deluge you need the **relation API name**. It is not the api_name of the parent module, nor of the target module. Call:\n\n';
    md += '```deluge\nrows = zoho.crm.getRelatedRecords("<relation API name>", "<module the record belongs to>", recordId);\n```\n\n';
    const emit = (list, title) => {
      if (!list.length) return;
      md += `### ${title}\n\n| Relation API name | Label | On module | Returns | Via | Type | Deluge |\n|---|---|---|---|---|---|---|\n`;
      list.sort((a, b) => a.parent.localeCompare(b.parent) || a.api.localeCompare(b.api)).forEach((r) => {
        md += `| \`${_mdCell(r.api)}\` | ${_mdCell(r.label)} | \`${_mdCell(r.parent)}\` | ${r.child ? '`' + _mdCell(r.child) + '`' : ''} | ${_mdCell(r.via || '')} | ${_mdCell(r.type)} | \`zoho.crm.getRelatedRecords("${_mdCell(r.api)}", "${_mdCell(r.parent)}", recordId)\` |\n`;
      });
      md += '\n';
    };
    emit(rels.filter((r) => !r.sys), 'Module-to-module relations');
    emit(rels.filter((r) => r.sys), 'System related lists (notes, attachments, activities\u2026)');
  }
  if (mods.length) md += '---\n\n## Modules (schema)\n\n';
  mods.slice().sort(byField('api_name')).forEach((m) => {
    md += `### ${m.api_name}${(m._layouts && m._layouts.length) ? ` \u00b7 ${m._layouts.length} layout(s)` : ''}\n\n`;
    const mref = moduleRefusal(m.unreadable);
    if (mref) md += `> **Not described by Zoho.** ${mref.text}\n\n`;
    md += `#### All fields (flat)\n\n| Field | API name | Type | Lookup | Picklist |\n|---|---|---|---|---|\n`;
    (m.fields || []).forEach((f) => { md += `| ${_mdCell(f.label || f.api_name)} | \`${_mdCell(f.api_name)}\` | ${_mdCell((f.data_type || '') + (f.length ? ' (' + f.length + ')' : ''))} | ${f.lookup ? '\u2192 ' + _mdCell(f.lookup) : ''} | ${_pick(f.picklist, 12, _mdCell)} |\n`; });
    md += '\n';
    if (scope.relations && (m.related_lists || []).length) {
      md += `#### Related lists (use the API name in zoho.crm.getRelatedRecords)\n\n| API name | Label | Target module | Type |\n|---|---|---|---|\n`;
      m.related_lists.forEach((r) => { md += `| \`${_mdCell(r.api_name)}\` | ${_mdCell(r.label || '')} | ${_mdCell(r.module || r.connected_module || '')}${r.linking_module ? ' via ' + _mdCell(r.linking_module) : ''} | ${_mdCell(r.type || '')}${r.visible === false ? ' (hidden)' : ''} |\n`; });
      md += '\n';
    }
    (scope.layouts ? (m._layouts || []) : []).forEach((L) => {
      md += `#### Layout: ${_mdCell(L.name || String(L.id))}${L.visible === false ? ' (hidden)' : ''} - ${(L.sections || []).length} sections\n\n`;
      (L.sections || []).forEach((sec) => {
        md += `**${_mdCell(sec.display_label || sec.name || 'Section')}** (${(sec.fields || []).length})\n\n| Field | API name | Type | Req |\n|---|---|---|---|\n`;
        (sec.fields || []).forEach((fl) => { md += `| ${_mdCell(fl.field_label || fl.display_label || fl.api_name)} | \`${_mdCell(fl.api_name || '')}\` | ${_mdCell(fl.data_type || '')} | ${fl.required ? '\u25cf' : ''} |\n`; });
        md += '\n';
      });
    });
  });
  const mdStat = fnList.filter((n) => n.stats && n.stats.lines);
  if (mdStat.length) {
    md += '---\n\n## Size and outbound calls\n\nPlain counts, no threshold and no verdict: length is verbosity, not complexity, and each outbound call is work Zoho meters. Calls are counted outside comments and string literals. Interpretation is the reader\'s.\n\n';
    md += '| Function | Lines | Code lines | KB | invokeurl | zoho.crm | Other Zoho | sendmail | Total calls |\n|---|---|---|---|---|---|---|---|---|\n';
    mdStat.slice().sort((a, b) => b.stats.lines - a.stats.lines).forEach((n) => {
      const s = n.stats;
      md += `| \`${_mdCell(n.namespace + '.' + n.name)}\` | ${s.lines} | ${s.codeLines} | ${(s.chars / 1024).toFixed(1)} | ${s.invokeurl} | ${s.crm} | ${s.zoho} | ${s.sendmail} | ${s.apiCalls} |\n`;
    });
    md += '\n';
  }
  // The actions a rule fires, for a reader who has the file and not the panel. This is the chapter
  // an external model is most likely to be asked about - «what happens when a deal is won» - so the
  // rules that fire each are in the row rather than a section away.
  if (acts.length) {
    const withheld = acts.filter((a) => a.from_address).length;
    md += '---\n\n## Actions\n\nWhat a workflow rule fires: notifications, field updates, tasks and webhooks. Each exists on its own in Zoho and is reused across rules. "Fired by" is read from the rules in this workspace.\n\n';
    if (withheld && !scope.addresses) md += `> ${withheld} sender address(es) withheld - that section was left off. Nothing else about those notifications is missing.\n\n`;
    md += '| Action | Kind | Module | Rules | Fired by | Detail |\n|---|---|---|---|---|---|\n';
    acts.slice().sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || byField('name')(a, b)).forEach((a) => {
      const users = (d.actUsers && d.actUsers.get(a.kind + ':' + String(a.id))) || [];
      const detail = a.kind === 'email_notifications'
        ? [a.template ? 'template ' + (a.template.name || a.template.id) : '',
           a.from_type ? 'from ' + ((scope.addresses && a.from_address) || (a.from_type === 'user' ? 'a user address' : 'an organisation address')) : '',
           a.recipient_count != null ? a.recipient_count + ' recipient(s)' : ''].filter(Boolean).join(' - ')
        : a.kind === 'field_updates' ? (a.field ? `${a.field}${a.field_type ? ' (' + a.field_type + ')' : ''} <- ${actStale(a) ? 'not read by this pull' : (a.value === null || a.value === undefined) ? 'cleared' : a.value}` : '')
        : a.kind === 'webhooks' ? [a.method || '', a.url || ''].filter(Boolean).join(' ')
        : a.notify === true ? 'notifies' : '';
      md += `| ${_mdCell(a.name || a.id)} | ${_mdCell(actionKindLabel(a.kind))} | ${_mdCell(a.module || '')} | ${users.length} | ${_mdCell(users.map((w) => w.name || w.id).join(', '))} | ${_mdCell(detail)} |\n`;
    });
    md += '\n';
  }
  if (conns.length) {
    md += '---\n\n## Connections\n\nThe org\'s connections and which functions use each. The join key is the name in `invokeurl [...connection:"..."]`.\n\n';
    md += '| Connection | Label | Connector | Status | Uses | Used by |\n|---|---|---|---|---|---|\n';
    conns.slice().sort((a, b) => (b.uses.length - a.uses.length) || byField('name')(a, b)).forEach((c) => {
      const status = c.missing ? 'not in catalogue' : c.connected === false ? 'not connected' : 'connected';
      md += `| \`${_mdCell(c.name)}\` | ${_mdCell(c.label || '')} | ${_mdCell(c.connector || '')} | ${status} | ${c.uses.length} | ${_mdCell(c.uses.join(', '))} |\n`;
    });
    md += '\n';
  }
  // Failures, for the reader who has the file and not the panel. It states the date it was read in
  // the section itself: this is the one chapter that is a reading of a runtime rather than of a
  // structure, and a report that hid that would be claiming more than the data can carry.
  const failRows = (fails.failures || []).slice().sort((a, b) => (b.count - a.count));
  if (failRows.length || fails.usage) {
    md += '---\n\n## Failures\n\n';
    md += `Read from Zoho on ${fails.at || 'an unknown date'}.`;
    if (fails.usage) md += ` In the 24 hours before that: ${fails.usage.success ?? 'unknown'} run(s), ${fails.usage.failure ?? 'unknown'} failed.`;
    md += ' The input of each failed execution stays in Zoho - Zoost does not read it.\n\n';
    if (failRows.length) {
      md += '| function | invoked by | times | last failure | reason |\n|---|---|---|---|---|\n';
      md += failRows.map((f) => `| ${_mdCell(f.name)} | ${_mdCell(f.componentType)} | ${f.count} | ${_mdCell(f.lastFailedAt)} | ${_mdCell(f.reason)} |`).join('\n') + '\n\n';
    } else {
      md += 'Nothing had failed when this was read.\n\n';
    }
    md += '| Connection | Label | Connector | Status | Uses | Used by |\n|---|---|---|---|---|---|\n';
    conns.slice().sort((a, b) => (b.uses.length - a.uses.length) || byField('name')(a, b)).forEach((c) => {
      const status = c.missing ? 'not in catalogue' : c.connected === false ? 'not connected' : 'connected';
      md += `| \`${_mdCell(c.name)}\` | ${_mdCell(c.label || '')} | ${_mdCell(c.connector || '')} | ${status} | ${c.uses.length} | ${_mdCell(c.uses.join(', '))} |\n`;
    });
    md += '\n';
  }
  md += `\n---\n\n## About this file\n\nGenerated by **${PRODUCT_NAME}**${PRODUCT_URL ? ` (${PRODUCT_URL})` : ''}, created by ${PRODUCT_AUTHOR}.\n\n${LEGAL_DISCLAIMER}\n`;
  return md;
}
async function exportMarkdown() {
  if (!dir) return;
  const scope = await askScope(); if (!scope) return;
  try {
    await requirePerm(dir);
    setStatus('Building AI (Markdown) export\u2026', 'busy');
    const data = await loadExportData();
    const md = buildExportMarkdown(data, scope);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && bound.instance) || 'workspace')}-${stamp}.md`;
    await writeFile(name, md);
    setStatus(`Exported \u2192 ${name} (in your workspace folder).`, 'ok');
  } catch (e) { setStatus(MSG.exportErr + e.message, 'bad'); }
}
async function exportHtml() {
  if (!dir) return;
  const scope = await askScope(); if (!scope) return;
  try {
    await requirePerm(dir);
    setStatus('Building HTML export\u2026', 'busy');
    const { fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers } = await loadExportData();
    const html = buildExportHtml(fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers, scope);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && bound.instance) || 'workspace')}-${stamp}.html`;
    await writeFile(name, html);
    setStatus(`Exported \u2192 ${name} (in your workspace folder).`, 'ok');
  } catch (e) { setStatus(MSG.exportErr + e.message, 'bad'); }
}

// ---------- schedules ----------
async function loadScheduleIndex() {
  let idx = []; try { idx = JSON.parse(await readFile('schedules/index.json')); } catch (_) {}
  scheduleData = idx.map((e) => ({ ...e, id: String(e.id), path: 'schedules/' + String(e.id) }));
}
async function rebuildSchedules() {
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'warn'); return; }
    setStatus('Reading schedules\u2026', 'busy');
    const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
    await loadScheduleIndex();
    renderSchedules();
    setStatus(scheduleData.length ? `${scheduleData.length} schedules.` : 'No schedules pulled yet - use Pull all.', 'ok');
  } catch (e) { setStatus(MSG.refreshErr + e.message, 'bad'); }
  await refreshContext();
}
function renderSchedules() {
  if (viewMode !== 'schedules') return;
  const term = $('find').value.trim().toLowerCase();
  const byStatus = {};
  scheduleData
    .filter((e) => scheduleFilter === 'all' || (scheduleFilter === 'active' ? e.status === 'active' : e.status !== 'active'))
    .filter((e) => !term || (e.name || '').toLowerCase().includes(term) || (e.function_name || '').toLowerCase().includes(term))
    .forEach((e) => (byStatus[e.status === 'active' ? 'Active' : 'Inactive'] ||= []).push(e));
  const tree = $('tree'); tree.innerHTML = '';
  const keys = Object.keys(byStatus).sort();
  if (!keys.length) { tree.innerHTML = '<div class="empty">' + (scheduleData.length ? '<b>No matches.</b>' : (emptyReason() || '<b>No schedules yet.</b> Press <b>Pull all</b> to read them.')) + '</div>'; return; }
  keys.forEach((st) => {
    const list = byStatus[st].sort(byField('name'));
    const isCol = collapsed.has('sc:' + st);
    const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
    g.innerHTML = `<span class="chev">\u25be</span><span>${st}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete('sc:' + st) : collapsed.add('sc:' + st); renderSchedules(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => {
      const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path;
      el.setAttribute('aria-selected', e.path === currentPath);
      el.innerHTML = `<span class="st st-ok" title="In workspace - click to refresh schedules from Zoho">\u25cf</span><span>${escHtml(e.name)}</span><span class="wftype">${escHtml(e.frequency || '')}</span>${e.status === 'active' ? '' : '<span class="wfoff">off</span>'}`;
      el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); refreshSchedules(); };
      el.onclick = () => openSchedule(e);
      tree.appendChild(el);
    });
  });
}
async function refreshSchedules() {
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  setStatus('Refreshing schedules…', 'busy');
  await pullSchedules();
  setStatus(`${scheduleData.length} schedules.`, 'ok');
}
async function openSchedule(e) {
  currentPath = e.path; navHere(e.name);
  selectRow(e.path);
  setPvName(e.name, e.path);
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);   // else the last function's callers/connections bar lingers
  $('pvreveal').style.display = 'none'; $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  const fnLink = `<span class="wf-fn" data-fnid="${escA(e.function_id || '')}" data-fnname="${escA(e.function_name || '')}" title="Open the function">\u0192 ${escHtml(e.function_name || '?')}</span>`;
  $('pvtable').innerHTML = `<div class="wfd">`
    + `<div class="wfrow"><span class="wk">Function</span> ${fnLink}</div>`
    + `<div class="wfrow"><span class="wk">Frequency</span> ${escHtml(e.frequency || '')}</div>`
    + `<div class="wfrow"><span class="wk">Status</span> ${escHtml(e.status || '')}</div>`
    + (e.next ? `<div class="wfrow"><span class="wk">Next run</span> ${escHtml(e.next)}</div>` : '')
    + (e.last ? `<div class="wfrow"><span class="wk">Last run</span> ${escHtml(e.last)}</div>` : '')
    + `</div>`;
  showPreview();
  $('pvtable').querySelectorAll('.wf-fn').forEach((sp) => { sp.onclick = () => openFunctionFromWorkflow(sp.dataset.fnid, sp.dataset.fnname); });
}

// ---------- workflows ----------

/** The scheduled-action facts of one rule, read from the rule we already have on disk.
 *
 * "How many workflows have actions that do not run immediately" had no answer anywhere: the list
 * endpoint does not carry it, so `workflows/index.json` does not either, and the fact was sitting unread in
 * every `workflows/<id>.json` - one level down, inside `conditions[].scheduled_actions[]`.
 *
 * Derived rather than captured, deliberately. Adding it to the index would mean a field that older
 * workspaces lack and a re-pull to acquire, for something already on the disk: this reads what the
 * pull wrote, which is the same rule the graph and the health audit follow.
 */
function wfScheduled(rule) {
  let count = 0; const delays = [];
  ((rule && rule.conditions) || []).forEach((c) => {
    (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => {
      count += (sa.actions || []).length;
      const ea = sa.execute_after;
      if (ea && ea.unit != null && ea.period) delays.push(`${ea.unit} ${ea.period}`);
    });
  });
  return { count, delays: [...new Set(delays)] };
}

async function loadWorkflowIndex() {
  wfIndex = new Map();
  let idx = []; try { idx = JSON.parse(await readFile('workflows/index.json')); } catch (_) {}
  const have = new Set();
  for await (const p of walk(dir)) { if (p.startsWith('workflows/') && p.endsWith('.json') && !p.endsWith('/index.json')) have.add(p.split('/').pop().replace(/\.json$/, '')); }
  workflowData = idx.map((e) => ({ ...e, id: String(e.id), path: `workflows/${String(e.id)}.json`, downloaded: have.has(String(e.id)), error: false }));
  // One pass over the rules on disk for the two facts the list endpoint does not return. A rule not
  // downloaded yet has neither, and says so as absence rather than as a zero - «0 scheduled» about a
  // workflow nobody has read is a measurement that was never taken.
  for (const e of workflowData) {
    if (!e.downloaded) continue;
    try {
      const rule = JSON.parse(await readFile(e.path));
      const s = wfScheduled(rule);
      e.sched = s.count; e.schedDelays = s.delays;
      e.lastRun = rule.last_executed_time || null;
    } catch (_) { /* unreadable here is the same as not downloaded: no fact, not a false zero */ }
  }
  workflowData.forEach((e) => wfIndex.set(e.id, e));
}
async function rebuildWorkflows() {
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'warn'); return; }
    setStatus('Reading workflows\u2026', 'busy');
    const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
    await loadWorkflowIndex();
    renderWorkflows(); updateMissingButton();
    const dl = workflowData.filter((e) => e.downloaded).length;
    setStatus(`${workflowData.length} workflows (${dl} downloaded).`, 'ok');
  } catch (e) { setStatus(MSG.refreshErr + e.message, 'bad'); }
  await refreshContext();
}
function renderWorkflows() {
  if (viewMode !== 'workflows') return;
  const term = $('find').value.trim().toLowerCase();
  const byMod = {};
  workflowData
    .filter((e) => workflowFilter === 'all'
      || (workflowFilter === 'scheduled' ? e.sched > 0 : workflowFilter === 'active' ? e.active : !e.active))
    .filter((e) => !term || (e.name || '').toLowerCase().includes(term) || (e.module || '').toLowerCase().includes(term))
    .forEach((e) => (byMod[e.module || '(no module)'] ||= []).push(e));
  const tree = $('tree'); tree.innerHTML = '';
  const keys = Object.keys(byMod).sort();
  if (!keys.length) { tree.innerHTML = '<div class="empty">' + (workflowData.length ? '<b>No matches.</b>' : (emptyReason() || '<b>No workflows yet.</b> Press <b>Pull all</b> to read them.')) + '</div>'; return; }
  // The scheduled-action count comes from the rule on disk, so a rule not downloaded yet has no
  // count - it is not a zero. Filtering on it therefore answers about part of the org, and the
  // figure states its own gap rather than letting the list look complete.
  if (workflowFilter === 'scheduled') {
    const unread = workflowData.filter((e) => !e.downloaded).length;
    if (unread) {
      const n = document.createElement('div'); n.className = 'wfnote';
      n.innerHTML = `${unread} workflow(s) have not been downloaded, so they are not counted here either way.`
        + ' Press <b>Complete missing</b> above to read them.';
      tree.appendChild(n);
    }
  }
  keys.forEach((mod) => {
    const list = byMod[mod].sort(byField('name'));
    const isCol = collapsed.has('wf:' + mod);
    const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
    g.innerHTML = `<span class="chev">\u25be</span><span>${escHtml(mod)}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete('wf:' + mod) : collapsed.add('wf:' + mod); renderWorkflows(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => {
      const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path; el.dataset.id = e.id;
      el.setAttribute('aria-selected', e.path === currentPath);
      const stCls = e.error ? 'st-err' : e.downloaded ? 'st-ok' : 'st-no';
      const stCh = e.error ? '\u27f3' : e.downloaded ? '\u25cf' : '\u25cb';
      const wfTitle = e.error ? (MSG.failed + (e.errorMsg || 'unknown') + MSG.clickRetry) : e.downloaded ? MSG.hereRepull : MSG.notHere;
      // The delay is part of the fact: "2 scheduled" and "2 scheduled, 30 minutes later" are
      // different things to know before touching a rule, and the second costs a tooltip.
      const schedBadge = e.sched > 0
        ? `<span class="wfsched" title="${escA(e.sched + ' action(s) that do not run immediately'
            + (e.schedDelays && e.schedDelays.length ? ' - after ' + e.schedDelays.join(', ') : ''))}">⏱ ${e.sched}</span>`
        : '';
      el.innerHTML = `<span class="st ${stCls}" title="${escA(wfTitle)}">${stCh}</span><span>${escHtml(e.name)}</span><span class="wftype">${escHtml(e.type)}</span>${schedBadge}${e.active ? '' : '<span class="wfoff">off</span>'}`;
      el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); downloadOneWf(e).then(() => { updateRow(e); updateMissingButton(); }); };
      el.onclick = () => openWorkflow(e);
      tree.appendChild(el);
    });
  });
}
async function downloadOneWf(entry) {
  if (mismatchRefuse()) return false;
  if (!dir) return false;
  if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'bad'); return false; }
  try {
    const r = await toBridge({ cmd: 'fetchWorkflow', id: entry.id });
    if (!r?.ok || !r.rule) throw new Error(r?.error || 'not found');
    await writeFile(entry.path, JSON.stringify(r.rule, null, 2));
    entry.downloaded = true; entry.error = false; entry.errorMsg = '';
    return true;
  } catch (e) { entry.error = true; entry.downloaded = false; entry.errorMsg = errText(e); return false; }
}
async function downloadMissingWf() {
  const pending = workflowData.filter((e) => !e.downloaded);
  if (!pending.length) { setStatus('All workflows downloaded.', 'ok'); updateMissingButton(); return; }
  setPullBusy(true); $('missing').disabled = true;   // both Pull buttons, and pullCurrent refuses to start on top
  let ok = 0, fail = 0;
  for (let i = 0; i < pending.length; i++) {
    const e = pending[i];
    setStatus(`Downloading workflow ${i + 1}/${pending.length}\u2026${fail ? ' (' + fail + ' failed)' : ''}`, 'busy');
    let done = await downloadOneWf(e);
    if (!done && isTransient(e.errorMsg)) { await sleep(700); done = await downloadOneWf(e); }
    done ? ok++ : fail++;
    if (viewMode === 'workflows') updateRow(e);
    await sleep(120);
  }
  updateMissingButton();
  setStatus(fail ? `Downloaded ${ok}, ${fail} still missing - use "Complete missing".` : `All ${ok} workflows downloaded.`, fail ? 'warn' : 'ok');
  setPullBusy(false); $('missing').disabled = false;
}
async function pullSchedules() {
  if (mismatchRefuse()) return;
  try {
    if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'warn'); return; }
    const ctx = await getContext(); if (!ctx) { setStatus(MSG.noTab, 'warn'); return; }
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus('Environment mismatch - refusing.', 'warn'); return; }
    setStatus('Pulling schedules\u2026', 'busy');
    const r = await toBridge({ cmd: 'listSchedules' }); if (!r?.ok) { const e = bridgeError(r, 'unknown'); await notePullFailure('schedules', e); return; }
    await writeFile('schedules/index.json', JSON.stringify(r.entries, null, 2));
    await loadScheduleIndex(); if (viewMode === 'schedules') renderSchedules();
    setStatus(`Schedules pull complete: ${(r.entries || []).length} schedules.${r.capped ? ' · capped at 4000 - some may be missing' : ''}`, r.capped ? 'warn' : 'ok');
    await noteAccess('schedules', null);
  } catch (e) { await notePullFailure('schedules', e); }
}
// Org-wide connections catalogue → connections/index.json. Written once per "Pull all".
async function pullConnections() {
  if (mismatchRefuse()) return;
  try {
    if (!(await ensurePerm(dir))) return;
    const ctx = await getContext(); if (!ctx) { setStatus(MSG.noTab, 'warn'); return; }
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus('Connections: environment mismatch - refusing.', 'warn'); return; }
    setStatus('Pulling connections…', 'busy');
    const r = await toBridge({ cmd: 'pullConnections' });
    if (!r?.ok) { setStatus('Connections pull failed: ' + (r?.error || 'unknown'), 'warn'); return; }
    await writeFile('connections/index.json', JSON.stringify(r.connections || [], null, 2));
    if (viewMode === 'connections') await rebuildConnections();   // reflect it immediately, like the other pulls do
    else setStatus(`Connections pulled: ${(r.connections || []).length}.`, 'ok');
    await noteAccess('connections', null);
  } catch (e) { await notePullFailure('connections', e); }
}
// ---------- automation actions (what a workflow fires) ----------
//
// Four kinds of object, one list. They are what a workflow rule points at - a notification, a field
// update, a task, a webhook - and Zoost mirrored the rules while resolving only the function ones,
// which in a real org is the smaller half: 275 notification actions against 149 function ones.
//
// The measurement that pays for the area is `associated`: in that same org, 85 notifications of 200,
// 50 field updates of 97 and 27 tasks of 56 are attached to nothing. It is the same statement this
// product already makes about a function nobody calls, on objects nobody ever prunes - and it is a
// candidate, never a verdict, because Zoho answers for the automations it knows about.
let actionData = [], actionFilter = 'all', actionUsers = null;
let actionSort = 'name', actionSortDir = 'asc';
// `null` means «nothing measured», never zero: an action whose module Zoho does not report is not an
// action in a module called nothing, and it sorts to the bottom rather than to the top of A-Z.
const ACTION_SORTS = {
  name: null,                       // the default: grouped by kind, names inside it
  rules: { label: 'rules that fire it', get: (a) => actionFiredBy(a).length },
  module: { label: 'module', get: (a) => a.module || null },
  modified: { label: MSG.lastModified, get: (a) => (a.modified_time ? (Date.parse(String(a.modified_time)) || null) : null) },
};
// The schema version the bridge writes. A row below it was captured before some of the fields
// existed - the field a rule writes and the value it writes were added after the first version -
// and «this pull did not read it» is not «Zoho says it is empty». Same mechanism, and same reason,
// as META_SV on a function's meta.
const ACT_SV = 4;
const actStale = (a) => (Number(a && a.sv) || 0) < ACT_SV;
/** Which rules fire each action, read from the workflow files already on disk.
 *
 *  This is the join the whole area rests on, and it costs nothing: `fetchWorkflow` has always
 *  written `conditions[].instant_actions.actions[]` and `conditions[].scheduled_actions[].actions[]`,
 *  every one of them carrying `{type, id, name}`. The panel resolved the `functions` ones and threw
 *  the rest away at the filter, so the id needed to answer «who sends this notification» was on disk
 *  the whole time. Keyed on kind+id, with the name as a fallback the way resolveFn() does it,
 *  because Zoho gives an id it knows and a name it displays. */
async function buildActionUsers() {
  const map = new Map();
  let wfIdx = []; try { wfIdx = JSON.parse(await readFile('workflows/index.json')); } catch (_) {}
  for (const w of Array.isArray(wfIdx) ? wfIdx : []) {
    let d = null; try { d = JSON.parse(await readFile(`workflows/${w.id}.json`)); } catch (_) {}
    if (!d) continue;   // not pulled: it is a rule with no measured actions, never a rule with none
    (d.conditions || []).forEach((c) => {
      const acts = [];
      if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions);
      (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || [])));
      acts.forEach((a) => {
        if (!a || !a.type) return;
        for (const key of [`${a.type}:${String(a.id)}`, `${a.type}:name:${String(a.name || '').toLowerCase()}`]) {
          if (!map.has(key)) map.set(key, []);
          if (!map.get(key).some((x) => String(x.id) === String(w.id))) map.get(key).push({ id: w.id, name: w.name });
        }
      });
    });
  }
  return map;
}
function actionFiredBy(a) {
  if (!actionUsers) return [];
  return actionUsers.get(`${a.kind}:${String(a.id)}`)
      || actionUsers.get(`${a.kind}:name:${String(a.name || '').toLowerCase()}`) || [];
}
const ACTION_LABEL = { email_notifications: 'Email notifications', field_updates: 'Field updates',
                       tasks: 'Tasks', webhooks: 'Webhooks' };
// A kind Zoho invents tomorrow gets a readable label without anyone editing this: underscores out,
// first letter up. Declared ones win, the rest are derived - the same rule the diagram window uses
// for category colours.
const actionKindLabel = (k) => ACTION_LABEL[k] || String(k || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
// The column form, for the flat sorts where the group headers are gone. Cutting the label to four
// characters - which is what the functions rows do to a namespace - gave «Emai», «Fiel», «Webh»:
// a namespace truncates into something still recognisable and a sentence does not.
const ACTION_SHORT = { email_notifications: 'Email', field_updates: 'Field', tasks: 'Task', webhooks: 'Webhook' };
const actionKindShort = (k) => ACTION_SHORT[k] || actionKindLabel(k).split(' ')[0];
async function loadActionsIndex() {
  let idx = []; try { idx = JSON.parse(await readFile('actions/index.json')); } catch (_) {}
  return Array.isArray(idx) ? idx : [];
}
async function pullActions() {
  if (mismatchRefuse()) return;
  try {
    if (!(await ensurePerm(dir))) return;
    const ctx = await getContext(); if (!ctx) { setStatus(MSG.noTab, 'warn'); return; }
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus(MSG.wrongTab, 'warn'); return; }
    setStatus('Pulling automation actions\u2026', 'busy');
    const r = await toBridge({ cmd: 'pullActions' });
    if (!r?.ok) { setStatus('Actions pull failed: ' + (r?.error || 'unknown'), 'warn'); return; }
    await writeFile('actions/index.json', JSON.stringify(r.actions || [], null, 2));
    // A kind that refused is stated rather than folded into the total: an org without webhooks and
    // an org whose role cannot read them look identical in a count.
    const missed = (r.missed || []).filter((m) => m && m.kind);
    const capped = r.capped || [];
    // The tab keeps the content script it was loaded with: reloading the extension does not replace
    // it. So a pull can be answered by the previous version, write rows without the newest fields,
    // and the panel then says «not read by the pull that wrote this» about a pull that just ran -
    // true, and impossible to act on unless somebody says which copy is old.
    if ((Number(r.sv) || 0) < ACT_SV) {
      setStatus(MSG.staleBridge, 'warn');
      await writeFile('actions/index.json', JSON.stringify(r.actions || [], null, 2));
      if (viewMode === 'actions') await rebuildActions();
      return;
    }
    // Both are stated rather than folded into the count: a kind that refused and a kind that was cut
    // short are two different reasons for a number to be smaller than the org.
    const note = (missed.length ? ` ${missed.length} kind(s) could not be read.` : '')
      + (capped.length ? ` ${capped.join(', ')} stopped at 4000 - there are more in Zoho.` : '');
    if (viewMode === 'actions') { await rebuildActions(); if (note) setStatus(`${(r.actions || []).length} action(s).` + note, 'warn'); }
    else setStatus(`${(r.actions || []).length} action(s) pulled.` + note, (missed.length || capped.length) ? 'warn' : 'ok');
    await noteAccess('actions', null);
  } catch (e) { await notePullFailure('actions', e); }
}
async function rebuildActions() {
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'warn'); return; }
    setStatus('Reading automation actions\u2026', 'busy');
    const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
    const idx = await loadActionsIndex();
    actionUsers = await buildActionUsers();   // one walk of the rules, not one per item opened
    actionData = idx.map((a) => ({ ...a, path: 'actions/' + a.kind + '/' + a.id }));
    buildTypeChips();          // the kinds come from the data, so the filter is built after it loads
    renderActions();
    setStatus(actionData.length ? `${actionData.length} automation action(s).` : (emptyReason() || 'No automation actions pulled yet - click Pull all.'), actionData.length ? 'ok' : 'warn');
  } catch (e) { setStatus('Actions error: ' + e.message, 'bad'); }
  await refreshContext();
}
function renderActions() {
  if (viewMode !== 'actions') return;
  const term = $('find').value.trim().toLowerCase();
  const pass = (a) => {
    if (actionFilter === 'unused' && a.associated) return false;
    if (actionFilter !== 'all' && actionFilter !== 'unused' && a.kind !== actionFilter) return false;
    return !term || (a.name || '').toLowerCase().includes(term) || (a.module || '').toLowerCase().includes(term)
      || (a.field || '').toLowerCase().includes(term) || ((a.template && a.template.name) || '').toLowerCase().includes(term);
  };
  // Sorting by a column answers a different question from browsing by kind, so - exactly as the
  // functions list does - any sort other than the default drops the group headers and goes flat,
  // with the sorted value carried on each row instead.
  const sorter = ACTION_SORTS[actionSort];
  const dir = actionSortDir === 'asc' ? 1 : -1;
  const list = actionData.filter(pass).sort(sorter
    ? (a, b) => {
      const va = sorter.get(a), vb = sorter.get(b);
      // A row with nothing measured stays at the bottom whichever way we sort: an ascending list
      // must not open with the actions we know least about.
      if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
      if (va === null) return byField('name')(a, b);
      if (va !== vb) return dir * (typeof va === 'string' ? String(va).localeCompare(String(vb)) : va - vb);
      return byField('name')(a, b);
    }
    : (a, b) => (a.kind || '').localeCompare(b.kind || '') || dir * byField('name')(a, b));
  const tree = $('tree'); tree.innerHTML = '';
  if (!list.length) {
    // Three reasons for an empty list and they are different advice - the rule this panel applies
    // everywhere: say *the* reason, not *a* reason.
    tree.innerHTML = '<div class="empty">' + (actionData.length ? '<b>No matches.</b>' : (emptyReason() || '<b>No automation actions yet.</b> Press <b>Pull all</b> to read them.')) + '</div>';
    return;
  }
  if (sorter) {
    const noData = list.filter((a) => sorter.get(a) === null).length;
    const hdr = document.createElement('div'); hdr.className = 'srhdr';
    hdr.textContent = `${list.length} action(s) by ${sorter.label}, ${actionSortDir === 'asc' ? 'lowest' : 'highest'} first`
      + (noData ? ` \u00b7 ${noData} without one` : '');
    tree.appendChild(hdr);
  }
  let group = null;
  // Whether the group being emitted is folded away. The other four lists build their groups in an
  // outer loop and can `return` out of one; this one walks a flat sorted list and starts a group when
  // the kind changes, so the state has to be carried across iterations rather than scoped to a group.
  let groupCollapsed = false;
  list.forEach((a) => {
    if (sorter) { group = a.kind; groupCollapsed = false; }   // flat: no headers, and the kind rides on the row instead
    else if (a.kind !== group) {
      group = a.kind;
      // Prefixed, like `mod:` `sc:` `wf:`, because `collapsed` is one Set shared by every list: a
      // bare key here would fold a namespace on the Functions tab that happened to share the name.
      //
      // `kind` is a block-scoped copy and the handler below closes over *it*, never over `group`.
      // The other four lists take their key from a forEach parameter, which is a fresh binding per
      // call and safe by construction; this one walks a flat list and mutates one outer `let`, so a
      // handler reading `group` would run long after the loop had left it on the last kind - every
      // header folding the same group, and nothing about the code looking wrong.
      const kind = group;
      const isCol = collapsed.has('act:' + kind);
      groupCollapsed = isCol;
      const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
      const n = list.filter((x) => x.kind === group).length;
      g.innerHTML = `<span class="chev">\u25be</span><span>${escHtml(actionKindLabel(group).toUpperCase())}</span><span class="cnt">${n}</span>`;
      g.onclick = () => { isCol ? collapsed.delete('act:' + kind) : collapsed.add('act:' + kind); renderActions(); };
      tree.appendChild(g);
    }
    if (groupCollapsed) return;
    const el = document.createElement('div'); el.className = 'f'; el.dataset.path = a.path;
    el.setAttribute('aria-selected', a.path === currentPath);
    // The dot is the mirror state and nothing else - «this is on your disk» - because that is what
    // it means on every other tab: ● here · ○ not here yet · ◐ partial · ⟳ failed · ⊘ refused. It
    // was ◐ for «no rule uses it», which reads as «downloaded incompletely»: a glyph that means two
    // things is worse than none, and this panel has already paid for that once with ↺ against ↻.
    //
    // «Attached to nothing» is a fact about the object, so it is a badge, and it is a **count** -
    // the same one the Connections tab shows for the functions using a connection. A number and no
    // verdict: zero says it by itself, and the filter is how you list them.
    const used = actionFiredBy(a).length;
    // Every trailing slot is always emitted, empty when it has nothing to say - the same rule as the
    // functions rows, and for the same reason: a slot that disappears lets the next one slide into
    // its place and the columns stop lining up down the list.
    const kindSlot = sorter ? `<span class="rest rk" title="${escA(actionKindLabel(a.kind))}">${escHtml(actionKindShort(a.kind))}</span>` : '';
    el.innerHTML = `<span class="st st-ok" title="In the local mirror - click to re-read from Zoho">\u25cf</span>`
      + `<span class="fname">${escHtml(a.name || a.id)}</span>`
      + `<span class="rest rm" title="${escA(a.module_label || a.module || 'no module')}">${escHtml(a.module || '')}</span>`
      + kindSlot
      + `<span class="rest rs" title="${escA('Pulled before this version captured everything about it - press Pull to complete it')}">${actStale(a) ? '\u25d0' : ''}</span>`
      + `<span class="rest ru${used || a.associated ? '' : ' none'}" title="${escA(used ? 'rules that fire it, read from the rules on disk' : a.associated ? 'Zoho reports it as in use; no rule on disk names it' : 'no rule uses it, as far as Zoho reports')}">${used}\u00d7</span>`;
    el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); refreshActions(); };
    el.onclick = () => openAction(a);
    tree.appendChild(el);
  });
}
async function refreshActions() {
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  setStatus('Refreshing automation actions\u2026', 'busy');
  await pullActions();
}
/** One mapped field of a task, rendered from what it is rather than from what Zoho called it.
 *
 *  `value` is the configuration and is language-neutral: 'Not Started', 'High', {id,name} for an
 *  owner, {sign, unit, period, trigger_field} for a date, plus {time, notify_type} for a reminder.
 *  `display` is Zoho's own rendering in the org's language and is used only where the structure is a
 *  shape nobody here has seen - which is the honest fallback, and it says so by staying in italics. */
function mappingHtml(m) {
  const v = m && m.value;
  const rel = (o) => `${escHtml(String(o.unit || '?'))} ${escHtml(String(o.period || ''))} `
    + `${o.sign === 'minus' ? 'before' : 'after'} <span class="mono">${escHtml(prettyTrigger(o.trigger_field))}</span>`
    + (o.time ? ` at ${escHtml(String(o.time))}` : '')
    + (o.notify_type ? ` <span style="color:var(--muted)">by ${escHtml(String(o.notify_type).replace(/and/g, ' and '))}</span>` : '');
  if (v && typeof v === 'object' && (v.sign || v.period || v.unit)) return rel(v);
  if (v && typeof v === 'object' && (v.name || v.id)) return escHtml(v.name || v.id);
  if (typeof v === 'string' && v !== '') return escHtml(v);
  if (typeof v === 'boolean' || typeof v === 'number') return escHtml(String(v));
  return m && m.display ? `<i>${escHtml(m.display)}</i>` : '';
}
// `${CURRENTTIME}` and `${!Tasks.Due_Date}` are how Zoho names what a delay is measured from. They
// are shown as they are, minus the punctuation that only means «this is a placeholder».
const prettyTrigger = (t) => String(t || '').replace(/^\$\{!?/, '').replace(/\}$/, '') || 'the trigger';
function openAction(a) {
  currentPath = a.path; navHere(a.name || a.id);
  selectRow(a.path);
  setPvName(a.name || a.id, 'actions/index.json');
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);
  // Absent rather than disabled, which is this panel's rule: for a webhook there is no page anyone
  // has shown me, and a greyed button says «there is something here you cannot have» about a page
  // that may not exist.
  const canOpen = !!actionUrl(a);
  $('pvreveal').style.display = canOpen ? '' : 'none';
  $('pvreveal').textContent = MSG.openInZoho;
  $('pvreveal').title = MSG.openThis + actionKindLabel(a.kind).toLowerCase().replace(/s$/, '') + ' in Zoho';
  $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  const row = (k, v) => v == null || v === '' ? '' : `<div class="wfrow"><span class="wk">${escHtml(k)}</span> ${v}</div>`;
  const fires = actionFiredBy(a);
  let h = '<div class="wfd">'
    + row('Kind', escHtml(actionKindLabel(a.kind)))
    + row('Module', escHtml(a.module_label || a.module))
    + row('Used by', fires.length
        ? `<b>${fires.length}</b> rule(s)`
        : (a.associated ? 'Zoho reports it as in use, and no pulled rule names it' : '<span style="color:#f59e0b">no rule uses it</span>'))
    + (a.template ? row('Template', templateUrl(a)
        ? `<a class="wf-fn" data-tpl="1" title="${escA('Open this template in Zoho')}">${escHtml(a.template.name || a.template.id)} \u2197</a>`
        : escHtml(a.template.name || a.template.id)) : '')
    // The sender, not a category. «From: a user's address» answers a question nobody asked - and
    // withholding it *here* makes no sense at all: the mirror is on this machine, and the two
    // switches are about what leaves it, in an export or in a chat. Reported, and the reasoning is
    // his: sharing a fact with a model while hiding it from the reader is the wrong way round.
    // The kind stays, muted and second, because «is this a person or the org» is worth a glance.
    + (a.from_address || a.from_name || a.from_type
        ? row('From', [a.from_name ? `<b>${escHtml(a.from_name)}</b>` : '',
                       a.from_address ? `<span class="mono">${escHtml(a.from_address)}</span>` : '',
                       a.from_type ? `<span style="color:var(--muted)">${escHtml(a.from_type === 'user' ? 'a user' : 'an organisation address')}</span>` : '']
              .filter(Boolean).join(' \u00b7 ')
            + (!a.from_address && actStale(a)
                ? ' <span style="color:var(--warn)">- the address was not read by the pull that wrote this</span>' : ''))
        : '')
    + (a.recipient_count != null ? row('Recipients', `${escHtml(String(a.recipient_count))} \u00b7 <span style="color:var(--muted)">a count; Zoost never reads who they are</span>`) : '')
    + (a.field ? row('Field', `<span class="mono">${escHtml(a.field)}</span>`
        + (a.field_label && a.field_label !== a.field ? ` \u00b7 ${escHtml(a.field_label)}` : '')
        + (a.field_type ? ` <span style="color:var(--muted)">${escHtml(a.field_type)}</span>` : '')) : '')
    // «Set stage to Won» does not say which value, and on a picklist of nine that is the whole
    // question. Three states, not two: a value, «clears the field» when Zoho answered with none,
    // and «this pull did not read it» when the row predates the field - which is what every row
    // looked like after the first version shipped, and it read as an org where nothing writes
    // anything.
    + (a.kind === 'field_updates' ? row('Writes', actStale(a)
        ? '<span style="color:var(--warn)">not read by the pull that wrote this - press Pull to read it</span>'
        : (a.value === null || a.value === undefined)
          ? '<span style="color:var(--muted)">clears the field</span>'
          : `<b>${escHtml(String(a.value))}</b>`) : '')
    + (a.method ? row('Method', escHtml(a.method)) : '')
    + (a.url ? row('URL', `<span class="mono">${escHtml(a.url)}</span>`) : '')
    // Built from the configuration rather than from Zoho's rendered sentence: «Data trigger più 7
    // giorni» is the same rule as «7 days after the trigger», in the language of whoever pulled it,
    // and a mirror that changes with the reader's locale is not a mirror. Zoho's own words are the
    // fallback for a shape this code has not met.
    + ((a.mappings || []).map((m) => row(m.field.replace(/_/g, ' '), mappingHtml(m))).join(''))
    + (a.kind === 'tasks' && !(a.mappings || []).length && actStale(a)
        ? row('Detail', '<span style="color:var(--warn)">not read by the pull that wrote this - press Pull to read it</span>') : '')
    + (a.notify === true ? row('Notify', 'yes') : '')
    + (a.modified_by ? row(MSG.lastModified, escHtml(a.modified_by) + (a.modified_time ? ' \u00b7 ' + escHtml(String(a.modified_time).slice(0, 16)) : '')) : '')
    + (a.locked ? row('Locked', 'yes') : '');
  if (fires.length) {
    h += '<div class="connfns">' + fires.map((w) => `<a class="wf-fn" data-wf="${escA(String(w.id))}" title="${escA(w.name || '')}">\u2699 ${escHtml(w.name || w.id)}</a>`).join('') + '</div>';
  }
  h += '</div>';
  $('pvtable').innerHTML = h;
  $('pvtable').querySelectorAll('a[data-wf]').forEach((el) => (el.onclick = () => healthOpenWorkflow(el.dataset.wf)));
  $('pvtable').querySelectorAll('a[data-tpl]').forEach((el) => (el.onclick = () => openZohoAt(templateUrl(a), (a.template && a.template.name) || 'template')));
  showPreview();
}

// ---------- connections view (org-wide catalogue + usage) ----------
let connectionData = [], connCatFilter = 'all';
async function loadConnectionsIndex() {
  let idx = []; try { idx = JSON.parse(await readFile('connections/index.json')); } catch (_) {}
  return Array.isArray(idx) ? idx : [];
}
async function rebuildConnections() {
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { setStatus(MSG.folder, 'warn'); return; }
    setStatus('Reading connections…', 'busy');
    const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
    const cat = await loadConnectionsIndex();
    // usage: which functions reference each connection (join meta.connections[].name)
    const g = await ensureGraph().catch(() => null);
    const usedBy = {};
    if (g) Object.values(g.nodes).forEach((n) => (n.connections || []).forEach((c) => { if (c && c.name) (usedBy[c.name] ||= []).push(n); }));
    connectionData = cat.map((c) => ({ ...c, path: 'connections/' + c.name, uses: (usedBy[c.name] || []).slice() }));
    // connections a function references but that are NOT in the catalogue (renamed / removed)
    const catNames = new Set(cat.map((c) => c.name));
    Object.keys(usedBy).forEach((name) => { if (!catNames.has(name)) connectionData.push({ name, label: name, connector: null, connected: null, createdBy: null, scopes: [], missing: true, path: 'connections/' + name, uses: usedBy[name].slice() }); });
    renderConnections();
    setStatus(connectionData.length ? `${connectionData.length} connections.` : (emptyReason() || 'No connections pulled yet - click Pull all.'), connectionData.length ? 'ok' : 'warn');
  } catch (e) { setStatus('Connections error: ' + e.message, 'bad'); }
  await refreshContext();
}
function renderConnections() {
  if (viewMode !== 'connections') return;
  const term = $('find').value.trim().toLowerCase();
  const pass = (c) => {
    if (connCatFilter === 'used' && !c.uses.length) return false;
    if (connCatFilter === 'unused' && c.uses.length) return false;
    if (connCatFilter === 'disconnected' && c.connected !== false) return false;
    return !term || (c.name || '').toLowerCase().includes(term) || (c.label || '').toLowerCase().includes(term) || (c.connector || '').toLowerCase().includes(term);
  };
  const list = connectionData.filter(pass).sort((a, b) => (b.uses.length - a.uses.length) || byField('label')(a, b));
  const tree = $('tree'); tree.innerHTML = '';
  if (!list.length) { tree.innerHTML = '<div class="empty">' + (connectionData.length ? '<b>No matches.</b>' : (emptyReason() || '<b>No connections yet.</b> Press <b>Pull all</b> to read them.')) + '</div>'; return; }
  list.forEach((c) => {
    const el = document.createElement('div'); el.className = 'f'; el.dataset.path = c.path;
    el.setAttribute('aria-selected', c.path === currentPath);
    // The dot is the mirror state, here as everywhere else: ● here · ○ not here yet · ◐ partial ·
    // ⟳ failed · ⊘ refused. It was carrying the *connection's* own status - ◐ for «configured but
    // not connected» - which reads as «downloaded incompletely», and that is the same collision the
    // Actions list had. Reported, and it is the older of the two.
    //
    // A fact about the connection is a badge, beside the count of functions that use it. «Not in the
    // catalogue» stays amber, because that one is worth acting on: a function names a connection the
    // org does not have.
    const inMirror = !c.missing;
    const dt = (inMirror ? 'In the local mirror' : 'Named by a function and not in the pulled catalogue')
      + ' - click to re-read the catalogue from Zoho';
    el.innerHTML = `<span class="st ${inMirror ? 'st-ok' : 'st-no'}" title="${escA(dt)}">${inMirror ? '●' : '○'}</span>`
      + `<span class="fname">${escHtml(c.label || c.name)}</span>`
      + `<span class="rest ${c.uses.length ? 'rf' : 'rc'}" title="functions using it">${c.uses.length}×</span>`
      + (c.missing ? '<span class="rest rc" title="a function names it and the pulled catalogue does not have it">not in catalogue</span>'
         : c.connected === false ? '<span class="rest rc" title="configured in Zoho but not connected">not connected</span>' : '')
      + (c.connector ? `<span class="rest rl" style="color:#a78bfa" title="connector">${escHtml(c.connector)}</span>` : '');
    el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); refreshConnections(); };   // the status dot acts, like every other tab's does (here: re-pull the catalogue)
    el.onclick = () => openConnection(c);
    tree.appendChild(el);
  });
}
async function refreshConnections() {
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  setStatus('Refreshing connections…', 'busy');
  await pullConnections();   // re-pulls the whole catalogue and rebuilds the view (like the schedules dot)
}
function openConnection(c) {
  currentPath = c.path; navHere(c.label || c.name);
  selectRow(c.path);
  setPvName(c.label || c.name, c.path);
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);   // else the last function's callers/connections bar lingers
  $('pvreveal').style.display = 'none'; $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  const nm = (n) => nameMode === 'display' ? (n.display_name || n.name) : (n.api_name || n.name);
  const uses = c.uses.slice().sort((a, b) => (nm(a) || '').localeCompare(nm(b) || ''));
  let h = '<div class="wfd">'
    + `<div class="wfrow"><span class="wk">Name</span> <b>${escHtml(c.name)}</b></div>`
    + (c.connector ? `<div class="wfrow"><span class="wk">Connector</span> ${escHtml(c.connectorLabel || c.connector)}</div>` : '')
    + (c.connected === false ? '<div class="wfrow"><span class="wk">Status</span> <span style="color:#f59e0b">not connected</span></div>' : c.connected === true ? '<div class="wfrow"><span class="wk">Status</span> connected</div>' : '')
    + (c.createdBy ? `<div class="wfrow"><span class="wk">Created by</span> ${escHtml(c.createdBy)}</div>` : '')
    + (c.missing ? '<div class="wfrow"><span class="wk">Note</span> <span style="color:#f59e0b">used by functions but not in the pulled catalogue (renamed or removed?)</span></div>' : '')
    + `<div class="wfrow"><span class="wk">Used by</span> <b>${uses.length}</b> function(s)</div>`;
  if (uses.length) h += '<div class="connfns">' + uses.map((n) => `<a class="wf-fn" data-file="${escA(n.file)}" title="${escA(n.namespace + '.' + n.name)}">ƒ ${escHtml(nm(n))}</a>`).join('') + '</div>';
  if (c.scopes && c.scopes.length) h += `<details class="wfraw"><summary>Scopes (${c.scopes.length})</summary><pre>${escHtml(c.scopes.join('\n'))}</pre></details>`;
  h += '</div>';
  $('pvtable').innerHTML = h;
  $('pvtable').querySelectorAll('a[data-file]').forEach((a) => (a.onclick = () => { setMode('functions'); openFile(a.dataset.file); }));
  showPreview();
}
/** A timestamp the reader can act on. The failures endpoint answers with two forms of the same
 *  moment - `last_failed_time` already localized into the user's own format, and an ISO one beside
 *  it. Only the ISO is ever parsed: reading a localized date is the same mistake as matching a
 *  localized button label, and it fails on the first user whose interface is not English. */
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '');
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- execution failures (and the last 24 hours of run counts) ----------
//
// There is no Failures tab. A failure is not a kind of object - the tabs are functions, modules,
// workflows, schedules, connections - it is an *event about a function*, and giving it a sibling
// tab put it a level too high. It shows in the two places that dimension belongs: on the function
// itself, and in the health view, which already answers «what is wrong across this org».
let failIndex = null;   // {at, usage, byName:Map} - built once per read, dropped when a pull replaces it
async function failuresIndex() {
  if (failIndex) return failIndex;
  let d = null; try { d = JSON.parse(await readFile('failures/index.json')); } catch (_) {}
  const byName = new Map();
  if (d && Array.isArray(d.failures)) {
    d.failures.forEach((f) => { const k = String(f.name || '').toLowerCase(); if (k) (byName.get(k) || byName.set(k, []).get(k)).push(f); });
  }
  failIndex = { at: (d && d.at) || null, usage: (d && d.usage) || null, runs: (d && d.runs) || null,
                credits: (d && d.credits) || null, byName, all: (d && d.failures) || [] };
  return failIndex;
}

//
// The rest of the mirror is a photograph of a structure that changes rarely, and its point is that
// `git diff` answers «what changed». This is not that: failures change hourly, and a diff of them is
// noise rather than history. It is written to disk all the same - so the export, the assistant and
// an offline read all see it - but as **one file that says when it was read**, not as a folder of
// items pretending to be durable.
//
// `params` - the input of the failed execution - is dropped in the bridge and never arrives here.
// See the comment there for why: for a REST API failure it carries a real person's name and email,
// and Zoost says on three surfaces that it does not read records.

/** «8 failing» beside a Pull reads as eight failed downloads - the opposite of what it means, since
 *  the pull worked and the number is functions Zoho reports failing at *runtime*. Reported, and the
 *  green did not save it: a colour cannot name a subject. One sentence for both readers of it, the
 *  status line and the health view's own line, so the two cannot drift. */
function runtimeSummary(n) {
  return n ? `Read from Zoho \u00b7 ${n} function(s) failing there`
           : 'Read from Zoho \u00b7 nothing failing there';
}
async function pullFailures() {
  if (mismatchRefuse()) return;
  try {
    pullActive = true;
    await requirePerm(dir);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(MSG.wrongTab);
    setStatus('Reading failures\u2026', 'busy');
    const r = await toBridge({ cmd: 'pullFailures' }); if (!r?.ok) throw new Error(r?.error || 'failures read failed');
    // One file for everything Zoho knows about how this org *runs*: what failed, how much ran, and
    // what it cost. It keeps the `failures/` name because that is what a reader looks for, and the
    // shape says the rest.
    await writeFile('failures/index.json', JSON.stringify({ at: r.at, usage: r.usage || null,
      runs: r.runs || null, credits: r.credits || null, failures: r.failures || [] }, null, 2));
    await noteAccess('failures', null);
    // No view of its own: a failure is a property of a function, not a kind of object, so it shows
    // where that dimension belongs - in the function's own detail, and in the health view, which is
    // already the place that answers «what is wrong across this org».
    setStatus(runtimeSummary((r.failures || []).length), 'ok');
    if (viewMode === 'functions') { failIndex = null; await rebuildTree(); }
  } catch (e) { await notePullFailure('failures', e); }
  finally { pullActive = false; }
}

async function pullWorkflows() {
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    await requirePerm(dir);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing.`);
    setStatus('Listing workflows\u2026', 'busy');
    const r = await toBridge({ cmd: 'listWorkflows' }); if (!r?.ok) throw new Error(r?.error || 'list failed');
    await writeFile('workflows/index.json', JSON.stringify(r.entries, null, 2));
    const liveIds = new Set(r.entries.map((e) => String(e.id)));
    let prunedW = 0;
    for await (const p of walk(dir)) { if (p.startsWith('workflows/') && p.endsWith('.json') && !p.endsWith('/index.json')) { const wid = p.split('/').pop().replace(/\.json$/, ''); if (!liveIds.has(wid)) { try { await removeFile(p); prunedW++; } catch (_) {} } } }
    await loadWorkflowIndex();
    if (viewMode === 'workflows') { renderWorkflows(); updateMissingButton(); }
    await downloadMissingWf();
    // The writes above dropped \u00abwhich rule fires this action\u00bb - it is read out of these very rules.
    // Dropping it is the write's business; rebuilding it has to happen where there is an await, and
    // this is that place: `actionFiredBy()` is called while a row is being drawn and cannot read a
    // file, so a map that is merely absent would be drawn as \u00abno rule fires this\u00bb, which is a
    // stronger claim than the stale one it replaced.
    if (actionUsers === null) actionUsers = await buildActionUsers();
    if (viewMode === 'actions') renderActions();
    if (prunedW) setStatus($('stxt').textContent + ` \u00b7 ${prunedW} deleted removed`, 'ok');
    if (r.capped) setStatus($('stxt').textContent + ' \u00b7 list capped at 4000 - some workflows may be missing', 'warn');
    await noteAccess('workflows', null);
  } catch (e) { await notePullFailure('workflows', e); } finally { pullActive = false; }
}
async function openWorkflowInZoho(id) {
  if (sampleRefuse()) return;
  const ws = bound || {};
  if (!ws.base || !ws.instance) { setStatus('Unknown workspace binding - pull first.', 'warn'); return; }
  const url = `${ws.base}/crm/${ws.instance}/settings/workflow-rules/${id}`;
  let tid = await zohoTabId();
  try { if (tid) await chrome.tabs.update(tid, { url, active: true }); else await chrome.tabs.create({ url }); setStatus('Opened workflow in Zoho.', 'ok'); }
  catch (e) { setStatus('Could not open: ' + e.message, 'warn'); }
}
async function openWorkflow(e) {
  if (!e.downloaded) { const ok = await downloadOneWf(e); updateRow(e); updateMissingButton(); if (!ok) { setStatus('Could not download this workflow.', 'warn'); return; } }
  let rule; try { rule = JSON.parse(await readFile(e.path)); } catch (err) { setStatus(MSG.readFailed + err.message, 'bad'); return; }
  currentPath = e.path; navHere(e.name);
  selectRow(e.path);
  setPvName(e.name, e.path);
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);   // else the last function's callers/connections bar lingers
  $('pvreveal').style.display = ''; $('pvreveal').textContent = MSG.openInZoho; $('pvreveal').title = 'Open the workflow in Zoho'; $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  $('pvtable').innerHTML = renderWorkflowDetail(rule);
  showPreview();
  $('pvtable').querySelectorAll('.wf-fn').forEach((sp) => { sp.onclick = () => openFunctionFromWorkflow(sp.dataset.fnid, sp.dataset.fnname); });
  const _ub = $('pvtable').querySelector('.wfusage'); if (_ub) _ub.onclick = () => loadWorkflowUsage(_ub.dataset.wfid, $('pvtable').querySelector('.wfusage-out'), _ub);
}
function renderWorkflowDetail(rule) {
  const esc = escHtml;
  const trig = (rule.execute_when && rule.execute_when.type) || '?';
  const mod = (rule.module && rule.module.api_name) || '?';
  // recursive criteria (handles nested groups)
  const valOf = (g) => {
    const v = g.value;
    if (g.type === 'field' && v && v.api_name) return v.api_name;
    if (v === '${EMPTY}' || v === '${empty}') return 'empty';
    return v == null ? '' : String(v);
  };
  const one = (g) => `${(g.field && g.field.api_name) || '?'} ${g.comparator || ''} ${valOf(g)}`;
  const critText = (crit) => {
    if (!crit) return '';
    if (crit.group && crit.group.length) { const op = crit.group_operator || 'AND'; return crit.group.map((g) => (g.group ? '(' + critText(g) + ')' : one(g))).join(` ${op} `); }
    if (crit.comparator) return one(crit);
    return '';
  };
  const timingText = (bk) => {
    const ea = bk.execute_after;
    if (ea && ea.unit != null) return `after ${ea.unit} ${ea.period || ''}`.trim();
    const t = bk.execution_details || bk.interval || bk.schedule || bk.time || null;
    if (!t) return '';
    if (typeof t === 'object') {
      if (t.days != null) return `after ${t.days} day(s)`;
      if (t.hours != null) return `after ${t.hours} hour(s)`;
      if (t.field || t.date_field) return `based on ${esc((t.field && t.field.api_name) || t.date_field || 'a date field')}`;
      return esc(JSON.stringify(t));
    }
    return esc(String(t));
  };
  const actionSpan = (a) => isFnAction(a)
    ? `<span class="wf-fn" data-fnid="${escA(a.id)}" data-fnname="${escA(a.name)}" title="Open the function">\u0192 ${esc(a.name)}</span>`
    : `<span class="wfact">${esc(a.type)}: ${esc(a.name)}</span>`;
  const bucketHtml = (bucket, label) => {
    if (!bucket) return '';
    const buckets = Array.isArray(bucket) ? bucket : [bucket];
    let out = '';
    buckets.forEach((bk) => {
      const acts = (bk && bk.actions) || [];
      const tim = bk && typeof bk === 'object' ? timingText(bk) : '';
      if (!acts.length && !tim) return;
      out += `<div class="wfacts"><span class="wk">${label}${tim ? ` <i>(${tim})</i>` : ''}</span>${acts.map(actionSpan).join('')}</div>`;
    });
    return out;
  };
  let h = `<div class="wfd">`;
  h += `<div class="wfrow"><span class="wk">Module</span> <b>${esc(mod)}</b></div>`;
  const ew = rule.execute_when || {}, det = ew.details || {};
  const trigParts = [esc(ew.type || '?')];
  if (det.repeat != null) trigParts.push(`repeat: ${det.repeat ? 'yes' : 'no'}`);
  if (Array.isArray(det.fields) && det.fields.length) trigParts.push(`fields: ${det.fields.map((fl) => esc((fl.field && fl.field.api_name) || fl.api_name || String(fl))).join(', ')}`);
  Object.keys(det).forEach((k) => { if (['trigger_module', 'repeat', 'fields'].includes(k)) return; const v = det[k]; if (v != null && typeof v !== 'object') trigParts.push(`${esc(k)}: ${esc(String(v))}`); });
  h += `<div class="wfrow"><span class="wk">Trigger</span> ${trigParts.join(' \u00b7 ')}</div>`;
  if (rule.category && rule.category !== 'default') h += `<div class="wfrow"><span class="wk">Category</span> ${esc(rule.category)}</div>`;
  const ewCrit = critText(det.criteria || ew.criteria);
  if (ewCrit) h += `<div class="wfrow"><span class="wk">When</span> ${esc(ewCrit)}</div>`;
  h += `<div class="wfrow"><span class="wk">Status</span> ${rule.status && rule.status.active ? 'active' : 'inactive'}</div>`;
  // Same row, same words as the Schedules preview: "Last run" is one fact and must not be two names.
  if (rule.last_executed_time) h += `<div class="wfrow"><span class="wk">Last run</span> ${esc(rule.last_executed_time)}</div>`;
  if (rule.description) h += `<div class="wfrow"><span class="wk">Description</span> ${esc(rule.description)}</div>`;
  (rule.conditions || []).forEach((c, i) => {
    h += `<div class="wfcond"><div class="wfch">Condition ${c.sequence_number || i + 1}</div>`;
    const cd = c.criteria_details || {};
    const ct = critText(cd.criteria);
    if (ct) h += `<div class="wfcrit">${esc(ct)}</div>`;
    const rel = cd.relational_criteria;
    if (rel && (rel.module || rel.criteria)) h += `<div class="wfcrit"><i>related:</i> ${esc((rel.module && rel.module.api_name) || rel.module || '')} ${esc(critText(rel.criteria))}</div>`;
    h += bucketHtml(c.instant_actions, 'Instant');
    h += bucketHtml(c.scheduled_actions, 'Scheduled');
    h += `</div>`;
  });
  h += `<div class="wfusage-wrap"><button class="wfusage" data-wfid="${escA(rule.id)}">Show executions (last 30 days)</button><div class="wfusage-out"></div></div>`;
  h += `<details class="wfraw"><summary>Raw JSON</summary><pre>${esc(JSON.stringify(rule, null, 2))}</pre></details>`;
  return h + `</div>`;
}
async function loadWorkflowUsage(id, outEl, btn) {
  if (mismatchRefuse()) return;
  btn.disabled = true; outEl.textContent = 'Loading executions\u2026';
  const fmt = (d) => d.toISOString().slice(0, 10);
  const till = new Date(), from = new Date(Date.now() - 30 * 864e5);
  try {
    const r = await toBridge({ cmd: 'workflowUsage', id, from: fmt(from), till: fmt(till) });
    if (!r?.ok || !r.usage) throw new Error(r?.error || 'no data');
    outEl.innerHTML = renderUsage(r.usage); btn.style.display = 'none';
  } catch (e) { outEl.textContent = 'Could not load executions: ' + e.message; btn.disabled = false; }
}
function renderUsage(u) {
  const esc = escHtml;
  let h = `<div class="wfu"><div class="wfrow"><span class="wk">Triggered</span> <b>${u.trigger_count == null ? 0 : u.trigger_count}</b> times (last 30 days)</div>`;
  (u.conditions || []).forEach((c) => ['instant_actions', 'scheduled_actions'].forEach((bk) => {
    const bucket = c[bk]; const buckets = Array.isArray(bucket) ? bucket : (bucket && bucket.actions ? [bucket] : []);
    buckets.forEach((bb) => (bb.actions || []).forEach((a) => {
      h += `<div class="wfustat"><span class="an">${esc(a.name)}</span> <span class="ok">${a.success_count || 0} ok</span> \u00b7 <span class="fail">${a.failure_count || 0} fail</span> \u00b7 ${a.queue_count || 0} queued</div>`;
    }));
  }));
  return h + `</div>`;
}
function openFunctionFromWorkflow(id, name) {
  const nid = String(id || ''); const nm = (name || '').toLowerCase();
  let ent = treeData.find((x) => x.id === nid) || treeData.find((x) => (x.display_name || '').toLowerCase() === nm || (x.api_name || '').toLowerCase() === nm);
  if (!ent) { setStatus(`Function "${name}" not in workspace - pull functions first.`, 'warn'); return; }
  setMode('functions'); openFromTree(ent.path);
}

// ---------- boot + tab reactivity ----------
$('opts').onclick = () => openSettings();
$('help').href = DOCS_URL;
// The options page is a separate document: pick up its changes without a manual refresh.
try {
  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area !== 'local') return;
    if (ch.aicfg) aiEngineChrome();            // engine/model changed: refresh the badge and the notice
    if (ch.tabPrefs) { await loadTabPrefs(); renderTabs(); }
    if (ch.zohoDc) zohoDc = ch.zohoDc.newValue || zohoDc;
    if (!ch.settingsStamp) return;
    await loadScope();
    aiEngineChrome();
    const prevRoot = root; root = await window.idbHandle.get('rootDir');
    if (root !== prevRoot || !dir) await loadWorkspaces(); else updateWsButtons();
  });
  // Belt and braces: the options page lives in another tab, so re-read on focus as well.
  window.addEventListener('focus', () => { aiEngineChrome(); });
} catch (_) {}
$('about').onclick = showAbout; $('aboutx').onclick = closeAbout; $('aboutok').onclick = closeAbout;
$('expx').onclick = () => closeScope(false); $('expcancel').onclick = () => closeScope(false);
// Persist what the user chose, not what staleness cleared on their behalf. A box they left
// untouched keeps whatever Settings said; one they re-ticked is theirs and is remembered.
$('expgo').onclick = () => {
  scopeFromUI();
  const keep = Object.assign({}, dlgScope);
  dlgAutoCleared.forEach((k) => { keep[k] = expScope[k]; });
  expScope = keep;
  try { chrome.storage.local.set({ exportScope: expScope }); } catch (_) {}
  closeScope(true);
};
$('pspFull').onclick = () => { dlgScope = Object.assign({}, SCOPE_FULL); dlgAutoCleared.clear(); scopeToUI(); };
$('pspSafe').onclick = () => { dlgScope = Object.assign({}, SCOPE_SAFE); dlgAutoCleared.clear(); scopeToUI(); };
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('scrim').onclick = () => { if ($('expscope').classList.contains('on')) closeScope(false); else closeAbout(); };
loadScope();
loadZohoDc();
// The tab set is a preference plus a per-workspace measurement, so it is built once at start-up and
// again whenever either can have moved: a workspace opening (different org, different roles) and a
// pull learning something new both call renderTabs themselves.
loadTabPrefs().then(renderTabs);
// One listener for every fields table there will ever be. The picklist cells are rebuilt by each
// module and again by the layout picker, so a handler attached after an innerHTML is one somebody
// forgets to re-attach - which is how a control ends up dead on the second render only.
$('pvtable').addEventListener('click', (e) => {
  const b = e.target.closest('.plbtn'); if (!b) return;
  const box = b.closest('tr') && b.closest('tr').nextElementSibling; if (!box || !box.classList.contains('plrow')) return;
  const opening = box.hidden;
  box.hidden = !opening;
  b.setAttribute('aria-expanded', String(opening));
  const n = b.dataset.n;
  b.textContent = `${opening ? '\u25be' : '\u25b8'} ${n} value${n === '1' ? '' : 's'}`;
});
document.querySelectorAll('#pvtabs .dtab').forEach((b) => (b.onclick = () => setPvTab(b.dataset.pv)));
$('pull').onclick = pullEverything; $('pullone').onclick = pullCurrent; // One group in the health view is read from Zoho; the rest is computed from the mirror. Before this
// existed the only way to refresh that group was «Pull all» - the whole org re-downloaded to update
// one reading, which he pointed out. It refuses on the wrong tab and on a sample like every other
// Zoho-bound control, and it rebuilds the view in place rather than closing it.
/** Beside the control, because #status is inside #belowbar and this view covers it: every
 *  setStatus() made while the health view is open is written where nobody can see it - which is why
 *  pressing Pull runtime looked as though nothing happened at all, refusal included. */
function healthSay(text, cls) { const el = $('healthmsg'); if (el) { el.textContent = text || ''; el.className = cls || ''; } }
async function pullHealthRuntime() {
  // A sample is not a mismatch, and saying so is the difference between an explanation and a wrong
  // answer: there is no org behind it to re-read, and «the tab does not match» would send somebody
  // switching tabs to fix something no tab can fix.
  if (isSample()) { sampleRefuse(); healthSay(MSG.sampleNoOrg, 'warn'); return; }
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); healthSay(MSG.wrongTab, 'warn'); return; }
  const b = $('healthpull'); b.disabled = true;
  healthSay('Reading from Zoho\u2026');
  try {
    await pullFailures();
    failIndex = null;                       // the file changed under it
    healthData = await buildHealth();
    renderHealthView();
    const fx = await failuresIndex();
    healthSay(runtimeSummary(fx.all.length), 'ok');
  } catch (e) { setStatus(MSG.rereadErr + e.message, 'bad'); healthSay(MSG.rereadErr + e.message, 'bad'); }
  finally { b.disabled = false; }
}
$('healthpull').onclick = pullHealthRuntime;
$('health').onclick = toggleHealth; $('healthx').onclick = closeHealth; $('missing').onclick = () => (viewMode === 'workflows' ? downloadMissingWf() : downloadMissing()); $('export').onclick = exportHtml; $('exportmd').onclick = exportMarkdown; $('graph').onclick = () => (viewMode === 'modules' ? openSchemaGraph() : openGraph()); $('refresh').onclick = async () => { if (root && !rootGranted) { await grantRoot(); return; } distrustEverything(); graphCache = null; codeCache = null; await rebuildActive(); };
$('ainotex').onclick = () => $('ainote').classList.remove('show');   // hidden for this session of the chat, back on next open
$('ailockgo').onclick = aiUnlock; $('ailockpass').onkeydown = (e) => { if (e.key === 'Enter') aiUnlock(); };
$('askai').onclick = toggleAI; $('aix').onclick = closeAI; $('aiclear').onclick = aiClear; $('aisend').onclick = aiSend; $('aigear').onclick = aiOpenSettings;
$('aiinput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiSend(); } });
buildTypeChips();
chrome.storage.local.get('previewH').then((r) => { if (r?.previewH) $('preview').style.height = r.previewH; });
chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_t, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
loadWorkspaces();
setInterval(refreshContext, 5000);
