/*
 * sidepanel.js — IDE orchestrator (multi-workspace).
 */
const ZOHO_MATCHES = [
  'https://crm.zoho.eu/*', 'https://crm.zoho.com/*', 'https://crm.zoho.in/*',
  'https://crm.zoho.com.au/*', 'https://crm.zoho.jp/*', 'https://crm.zohocloud.ca/*',
  'https://crmsandbox.zoho.eu/*', 'https://crmsandbox.zoho.com/*', 'https://crmsandbox.zoho.in/*',
  'https://crmsandbox.zoho.com.au/*', 'https://crmsandbox.zoho.jp/*', 'https://crmsandbox.zohocloud.ca/*',
  'https://one.zoho.eu/*', 'https://one.zoho.com/*', 'https://one.zoho.in/*',
  'https://one.zoho.com.au/*', 'https://one.zoho.jp/*', 'https://one.zohocloud.ca/*',
];
const ZOHO_HOST_RE = /^https:\/\/(crm(sandbox)?|one)\.zoho/;
const envOf = (origin) => /crmsandbox\./.test(origin || '') ? 'sandbox' : 'prod';
const CFG = '.zoost.json';
const NS = ['standalone', 'automation', 'button', 'schedule', 'validation_rule'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir = null, index = new Map(), bound = null, lastCtx = null;
let wsList = [], activeWsId = null;
const zohoReady = () => !!(lastCtx && guardOk());
let treeData = [], nameMode = 'display', typeFilter = 'all', graphCache = null;
let connectionFilter = null, connFilterSet = null;   // when set, the functions tree shows only functions using that connection
let treeSort = 'name';        // 'name' keeps the namespace grouping; any other key sorts flat
let treeSortDir = 'asc';      // 'asc' | 'desc' — defaults per sort: A→Z for names, biggest-first for numbers
let currentPath = null, pvHist = [];
let viewMode = 'functions', moduleData = [], moduleFilter = 'all', moduleNameMode = 'display';
let searchMode = 'name', codeCache = null, _searchT = null;
let workflowData = [], workflowFilter = 'all', wfIndex = new Map();
let scheduleData = [], scheduleFilter = 'all';
const collapsed = new Set();
const expandedMods = new Set();
let pullActive = false, pullBusy = false;

const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = '') => { $('stxt').textContent = t; $('status').className = cls; };
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// escHtml is NOT attribute-safe (it leaves " alone). Use escA inside an attribute value, or a
// double quote in the data closes it early and truncates — the trap that halved the getRelated snippet.
const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const sanitize = (s) => String(s).replace(/[^\w.\-]/g, '_');
const META_SV = 2;   // current function-meta schema version; functions on disk below this are "stale" and get re-fetched
async function removeFile(path) { const parts = path.split('/'); const name = parts.pop(); let d = dir; for (const p of parts) d = await d.getDirectoryHandle(p); await d.removeEntry(name); }
// --- Attribution (set PRODUCT_URL to the Chrome Web Store URL once available) ---
const PRODUCT_NAME = chrome.runtime.getManifest().name;   // single source of truth: rename in manifest.json only
const PRODUCT_URL = 'https://zoost.it';

// Anything that is not Zoho opens in its own window, never a tab.
//
// chrome.tabs.create *activates* the new tab, so the panel suddenly finds itself looking at a
// non-Zoho page: the environment guard fires, the interface empties and the mismatch overlay
// appears. That behaviour is right when it means what it says, and here it meant nothing at all —
// the user clicked Help and the workbench looked like it had lost its place.
//
// Derived rather than listed: every link in the panel goes through here, and the only ones let
// through to a tab are Zoho's own, which are meant to land in the Zoho tab. A link added tomorrow
// is covered without anyone remembering.
// Zoho's own hosts, with or without a subdomain, and nothing that merely contains the word:
// `notzoho.com` and `evil.com/zoho.x` are not Zoho, and treating them as such would send them to
// the Zoho tab where the guard would then complain about a mismatch it did not cause.
function isZohoUrl(u) { return /^https?:\/\/([^/]*\.)?zoho\.[a-z.]+(\/|$)/i.test(String(u || '')); }

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
// `openOptionsPage()` opens a tab, and only de-duplicates within the *current* browser window —
// while the side panel is per window. Two browser windows, two settings tabs; over a working day,
// ten. That is not a tidiness problem: every one of them is a form holding a snapshot of the
// settings from the moment it opened, and saving an old one silently overwrites a newer one with
// stale values. It is the same trap as having the same Deluge function open in two tabs and being
// invited to "save your work" by the older of them.
//
// So: find any existing settings tab across all windows, focus it, and open a dedicated popup
// window only if there is none. Existing duplicates are focused, never closed — one of them may
// hold edits, and discarding those to enforce uniqueness would be committing the very mistake this
// prevents. They disappear as they are closed.
//
// Uniqueness by construction is still not enough on its own, which is why options.js also refuses to
// save over a value that changed underneath it. A window can be closed and reopened, the extension
// reloaded, and the panel itself writes some of these keys.
async function openSettings() {
  const url = chrome.runtime.getURL('options.html');
  try {
    const open = await chrome.tabs.query({ url });
    if (open && open.length) {
      await chrome.windows.update(open[0].windowId, { focused: true });
      await chrome.tabs.update(open[0].id, { active: true });
      return;
    }
    await chrome.windows.create({ url, type: 'popup', width: 880, height: 900 });
  } catch (_) {
    chrome.runtime.openOptionsPage();   // whatever went wrong, the settings must still be reachable
  }
}

// Each app points at *its own* pages. Analytics shipped with the Help link hard-coded to the CRM
// guide, which is the kind of thing that only ever gets found by a user — so both are named here,
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
  + 'Deciding what may be extracted from the CRM, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';
const LEGAL_LINE = `Created by ${PRODUCT_AUTHOR} \u00b7 ${PRODUCT_LICENSE} \u00b7 Independent, unofficial tool \u2014 not affiliated with Zoho Corporation.`;

// ---------- export scope ----------
// Coarse on purpose: sections, never single modules. A per-module allow-list would be a
// permission system, and a permission system that is not enforced anywhere is theatre.
const SCOPE_KEYS = ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules', 'connections', 'health'];
const SCOPE_FULL = { functions: true, code: true, modules: true, layouts: true, relations: true, workflows: true, schedules: true, connections: true, health: true };
const SCOPE_SAFE = { functions: true, code: false, modules: true, layouts: true, relations: true, workflows: false, schedules: false, connections: true, health: false };
let expScope = Object.assign({}, SCOPE_FULL);
// What the dialog is editing right now, and which of its boxes were cleared *for* the user because
// the data behind them is behind. Kept apart from expScope for one reason: the export dialog saves
// what you leave it with, so mutating the defaults to warn about staleness rewrote them — one
// export and the settings had silently lost Functions and Workflows. A transient warning must never
// become a stored preference. Same lost-update shape as two copies of the settings page.
let dlgScope = Object.assign({}, SCOPE_FULL);
let dlgAutoCleared = new Set();
async function loadScope() {
  try { const st = await chrome.storage.local.get('exportScope'); if (st && st.exportScope) expScope = Object.assign({}, SCOPE_FULL, st.exportScope); } catch (_) {}
}
// The tab preference, and the access verdicts recorded for the workspace that is open. Two sources
// because they are two different kinds of fact: what you chose (per install) and what Zoho allows
// (per org). Reading either must never throw the panel — a missing or malformed value just means
// "show everything", which is the state a first run is in anyway.
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
// The settings page cannot read the workspace's `.zoost.json` — it has no folder handle and no
// business acquiring one — but it has to be able to say *why* a tab is off, or "hidden" becomes the
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
// The date is stored with it and shown, because "forbidden" is not a permanent truth — roles change,
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
      + 'Nothing was pulled for it, and the tab is hidden — Settings says why, and lets you check again.';
  }
  return `${tabLabel(area)} pull error: ${(e && e.message) || 'unknown'}`;
}

// After a full pull: one line naming the areas that were refused. Said once, plainly, rather than
// five separate alarms — and it has to be said, because the tabs have just silently gone away.
function forbiddenNote() {
  const off = TABS.map((t) => t.id).filter(isForbidden);
  if (!off.length) return '';
  return ` · ${off.length} area${off.length > 1 ? 's' : ''} not granted to your Zoho role (${off.map(tabLabel).join(', ')}) — hidden`;
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
  connections: ['connections'],
};

// Sections whose data is behind are cleared when the dialog opens, and why is written next to them.
// Cleared rather than removed: an old chapter is sometimes exactly what you want, so the choice
// stays yours — but it has to be a choice, and the default has to be the safe one. If you tick it
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
    `<div><b>${escHtml(tabLabel(id))}</b> — ${escHtml(areaAsOf(id))}, because ${escHtml(staleReason(id))}. `
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
    + `<h4>Links</h4><div><a href="${escHtml(PRODUCT_URL)}" target="_blank" rel="noopener">zoost.it</a> \u00b7 <a href="${escHtml(PAGE_URL)}" target="_blank" rel="noopener">What it does</a> \u00b7 <a href="${escHtml(DOCS_URL)}" target="_blank" rel="noopener">How to use</a> \u00b7 <a href="${escHtml(PRODUCT_URL)}/privacy.html" target="_blank" rel="noopener">Privacy</a> \u00b7 <a href="${escHtml(STORE_URL)}" target="_blank" rel="noopener">Web Store</a> \u00b7 <a href="${escHtml(REPO_URL)}" target="_blank" rel="noopener">Source</a> \u00b7 <a href="mailto:${escHtml(CONTACT_EMAIL)}">${escHtml(CONTACT_EMAIL)}</a></div>`
    + `<h4>Support</h4><div>${SPONSOR_URL ? `<a href="${escHtml(SPONSOR_URL)}" target="_blank" rel="noopener">GitHub Sponsors</a>` : ''}${SPONSOR_URL && KOFI_URL ? ' \u00b7 ' : ''}${KOFI_URL ? `<a href="${escHtml(KOFI_URL)}" target="_blank" rel="noopener">\u2615 Ko-fi</a>` : ''}</div>`
    + `<h4>Licence</h4><div><a href="${escHtml(LICENSE_URL)}" target="_blank" rel="noopener">${escHtml(PRODUCT_LICENSE)}</a> \u00b7 \u00a9 2026 ${escHtml(PRODUCT_AUTHOR)}</div>`
    + `<h4>Legal</h4><div class="legal">${escHtml(LEGAL_DISCLAIMER)}</div>`
    + `<h4>Your data</h4><div class="legal">Everything stays between your browser, your Zoho session and the local folder you picked. `
    + `The extension has no server of its own and sends nothing anywhere. Exports are written to your workspace folder \u2014 what happens to them afterwards is up to you.</div>`;
  $('scrim').classList.add('on'); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); $('aboutdlg').classList.remove('on'); }

// ---------- filesystem ----------
async function ensurePerm(h) { const o = { mode: 'readwrite' }; if ((await h.queryPermission(o)) === 'granted') return true; return (await h.requestPermission(o)) === 'granted'; }
const hasPerm = async (h) => (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
async function writeFile(rel, content) {
  const parts = rel.split('/'); let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable(); await w.write(content); await w.close();
}
async function readFile(rel) {
  const parts = rel.split('/'); let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
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
// Merge rather than replace. `.zoost.json` now holds more than the binding — the access verdicts
// below live there too — and a whole-object write from any one writer silently drops what the others
// put in it. This is the `cacheBinding` trap in CLAUDE.md, arriving a second time with a new field.
const patchCfg = async (o) => writeCfg(Object.assign({}, (await readCfg()) || {}, o));

// ---------- tabs ----------
//
// One registry. The five tabs used to be spelled out in the markup, in five `.active` toggles, in
// five click handlers and in two label maps — which is why they could never be reordered and why a
// sixth would have to be remembered in eight places. Everything that varies per tab is here; the
// segment row is built from it.
//
// `area` is what a pull and a permission verdict are keyed on. It matches the tab id today, and is
// kept as its own field because the two are different ideas: a tab is a thing you look at, an area
// is a thing Zoho may refuse.
const TABS = [
  { id: 'functions',   label: 'Functions',   graph: 'Graph ↗',  names: true, search: true },
  { id: 'modules',     label: 'Modules',     graph: 'Schema ↗', names: true },
  { id: 'workflows',   label: 'Workflows' },
  { id: 'schedules',   label: 'Schedules' },
  { id: 'connections', label: 'Connections' },
];
const TAB = Object.fromEntries(TABS.map((t) => [t.id, t]));
const tabLabel = (id) => (TAB[id] ? TAB[id].label : id);

// What the user chose: which tabs to show and in what order. A preference, stored per install and
// not per workspace — unlike the access verdicts, which are a property of one org's roles.
let tabPrefs = { order: TABS.map((t) => t.id), hidden: [], nopull: [] };
// What Zoho answered, for the workspace currently open: area -> { state, status, at }.
// 'ok' | 'forbidden' | 'failed'. Empty until a pull has actually asked.
let tabAccess = {};

const accessOf = (id) => (tabAccess[id] && tabAccess[id].state) || null;
// When an area was last read. Falls back to the workspace's own `lastPull` for anything mirrored
// before per-area dates existed: those folders hold real, current data and simply carry no record.
// Reading "no measurement" as "behind" is the inversion this project forbids everywhere else, and
// here it had teeth — it silently unticked Functions and Workflows in the export dialog, so a report
// quietly came out smaller than the user asked for.
//
// Where it must err, it errs towards *not* flagging: an over-stated freshness is visible, because
// both reports print the per-area dates whether or not anything is behind. A section dropped from a
// report is not.
let wsLastPull = null;
const pulledAt = (id) => (tabAccess[id] && tabAccess[id].pulledAt) || wsLastPull || null;

// Staleness is derived, never declared. An area is behind if the mirror holds newer data for
// something else — which is true whether it was excluded from the pull, refused by Zoho, or simply
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
// The words a user reads. Never "stale" on its own — a date they can act on, and the reason.
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
// following the tab — hide one and its pull goes with it unless you say otherwise, because the
// alternative is a setting that is right for the ninth user out of ten and silently wrong for the
// other nine.
const isPulled = (id) => !tabPrefs.nopull.includes(id);
// The order is the preference's, with anything the preference has never heard of appended — so a
// tab added in a later version appears instead of vanishing for everyone who has saved a setting.
function tabOrder() {
  const known = tabPrefs.order.filter((id) => TAB[id]);
  return known.concat(TABS.map((t) => t.id).filter((id) => !known.includes(id)));
}
// A tab is shown unless the user hid it or Zoho refused the area. Both make it *absent*, not
// disabled: a control that can never do anything is noise, and a greyed one claims there is
// something here you cannot have. The reason is never lost — it is stated after a pull and again in
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
  const id = await zohoTabId(); if (!id) throw new Error('No Zoho CRM tab open.');
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
    $('offoverlay').classList.add('show');
    ctxEl.className = 'offzoho'; who.innerHTML = 'Not on a Zoho tab';
    bnd.innerHTML = bound ? `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)}` : '';
    document.body.classList.add('zoho-blocked'); $('pull').disabled = true;
    return;
  }
  $('offoverlay').classList.remove('show');
  await ensureBridge(activeId);
  const cfid = await crmFrameId(activeId);
  try { const r = await chrome.tabs.sendMessage(activeId, { cmd: 'context' }, { frameId: cfid }); lastCtx = r?.ok ? r : null; } catch { lastCtx = null; }
  if (!lastCtx) { ctxEl.className = 'offzoho'; who.innerHTML = 'Zoho tab (not ready)'; bnd.textContent = ''; document.body.classList.add('zoho-blocked'); $('pull').disabled = true; updateWsButtons(); return; }
  who.innerHTML = `<span class="rlbl remote">Zoho tab</span><b>${escHtml(lastCtx.instance || '?')}</b> <span>· org ${escHtml(lastCtx.org || '?')} · ${envOf(lastCtx.origin)}</span>`;
  if (!bound) { ctxEl.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">not bound yet</span>'; }
  else if (guardOk()) { ctxEl.className = 'match'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✓`; }
  else { ctxEl.className = 'mismatch'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>≠ ${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✗`; }
  // mismatch action bar: offer to jump to the ACTIVE workspace's Zoho URL (explicit)
  const mm = !!(bound && lastCtx && !guardOk());
  const mmbar = $('mmbar');
  mmbar.classList.toggle('show', mm);
  $('mmoverlay').classList.toggle('show', mm);
  if (mm) { $('preview').classList.remove('show'); $('resizer').classList.remove('show'); }
  if (mm) {
    $('mmtext').textContent = `Zoho tab «${lastCtx.instance || '?'}» (org ${lastCtx.org}) ≠ local workspace «${bound.instance || '?'}» (org ${bound.org}). Everything is disabled until they match.`;
    $('mmgo').textContent = `Switch tab → «${bound.instance || '?'}» ↗`;
    $('mmgo').onclick = () => switchTab();
    const match = (wsList || []).find((w) => w.id !== activeWsId && w.binding && w.binding.org === lastCtx.org && (!w.binding.base || !lastCtx.origin || w.binding.base === lastCtx.origin));
    const sw = $('mmsw'); sw.style.display = '';
    if (match) { sw.textContent = `Switch workspace → «${match.name}»`; sw.onclick = () => { $('ws').value = match.id; activate(match, true); }; }
    else { sw.textContent = `Create workspace for \u00ab${lastCtx.instance || '?'}\u00bb`; sw.onclick = () => addWorkspaceForTab(); }
  }
  // inhibit all Zoho-bound operations unless the active tab matches the workspace (tab-navigation stays allowed)
  document.body.classList.toggle('zoho-blocked', !zohoReady());
  $('pull').disabled = pullBusy || !zohoReady() || !dir;   // a pull in progress keeps it disabled even as the 5s refresh runs
  updateWsButtons();
}
function guardOk() {
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
  const stTitle = e.error ? ('Failed: ' + (e.errorMsg || 'unknown') + ' — click to retry') : e.stale ? 'Older data (no connections / author) — click to refresh' : e.downloaded ? 'In workspace — click to re-download from Zoho' : 'Not in workspace — click to download';
  // Every trailing slot is always emitted, empty when it has nothing to say. A slot that disappears
  // lets the next one slide into its place, and then the numbers stop lining up down the list —
  // which is the whole point of having them there.
  const st = e.stats;
  const restSlot = `<span class="rest rr">${e.rest ? 'REST' : ''}</span>`;
  const nsSlot = treeSort !== 'name'   // flat sorting drops the namespace headers, so the row carries it
    ? `<span class="rest rn" title="${escA(e.namespace || '')}">${escHtml((e.namespace || '').slice(0, 4))}</span>` : '';
  const lineSlot = `<span class="rest rfl"${st ? ` title="${st.lines} lines · ${st.codeLines} code lines · ${(st.chars / 1024).toFixed(1)} KB"` : ''}>${st ? st.lines + 'L' : ''}</span>`;
  const callSlot = `<span class="rest rc"${st && st.apiCalls ? ` title="${st.apiCalls} outbound call(s): ${st.invokeurl} invokeurl · ${st.crm} zoho.crm · ${st.zoho} other Zoho service${st.sendmail ? ' · ' + st.sendmail + ' sendmail' : ''}"` : ''}>${st && st.apiCalls ? st.apiCalls + '↗' : ''}</span>`;
  el.innerHTML = `<span class="st ${stCls}" title="${stTitle}">${stCh}</span><span class="fname">${escHtml(labelOf(e))}</span>${restSlot}${nsSlot}${lineSlot}${callSlot}`;
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
    .filter((e) => !term || (e.api_name || '').toLowerCase().includes(term) || (e.display_name || '').toLowerCase().includes(term));
  const tree = $('tree'); tree.innerHTML = '';
  if (connectionFilter) {
    const b = document.createElement('div'); b.className = 'connbanner';
    b.innerHTML = `<span><b>${shown.length}</b> function(s) use <b>${escHtml(connectionFilter)}</b></span><span class="connclear" title="Clear filter">✕</span>`;
    b.querySelector('.connclear').onclick = clearConnectionFilter;
    tree.appendChild(b);
  }
  if (!shown.length) { const m = document.createElement('div'); m.className = 'treemsg'; m.textContent = 'No matches.'; tree.appendChild(m); return; }
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
    g.innerHTML = `<span class="chev">▾</span><span>${ns}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete(ns) : collapsed.add(ns); renderTree(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => tree.appendChild(fnRowEl(e)));
  });
}
async function rebuildTree() {
  if (!dir) return;
  if (!(await ensurePerm(dir))) { setStatus('Folder access needs re-granting — click Refresh.', 'warn'); return; }
  setStatus('Loading tree…', 'busy'); graphCache = null; aiModCache = null; aiConnCache = null; const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
  // scan disk: which functions are already downloaded (have a .meta.json), keyed by id
  const downloadedById = new Map(); const metaPaths = [];
  for await (const p of walk(dir)) { if (p.startsWith('_index/')) continue; if (p.endsWith('.meta.json')) metaPaths.push(p); }
  for (const mp of metaPaths) {
    try {
      const meta = JSON.parse(await readFile(mp)); const dgPath = mp.replace(/\.meta\.json$/, '.dg');
      downloadedById.set(String(meta.id), { path: dgPath, category: meta.category, source: meta.source, name: meta.name, rest: (meta.rest_api || []).some((r) => r.active), namespace: meta.nameSpace || dgPath.split('/')[0], display_name: meta.display_name, sv: meta.sv || 0, updatedTime: meta.updatedTime || null });
    } catch (_) {}
  }
  // the list index shows ALL functions (including not-yet-downloaded); fall back to on-disk meta for legacy workspaces
  let idx = null; try { idx = JSON.parse(await readFile('_index/functions.json')); } catch {}
  index = new Map();
  if (idx && idx.length) {
    treeData = idx.map((e) => {
      const id = String(e.id); const d = downloadedById.get(id);
      const path = d ? d.path : `${sanitize(e.namespace)}/${sanitize(e.api_name)}.dg`;
      index.set(id, { path, category: e.category, source: e.source, name: e.name, rest: e.rest });
      return { path, api_name: e.api_name, display_name: e.display_name || e.api_name, namespace: (d && d.namespace) || e.namespace, rest: e.rest, id, category: e.category, source: e.source, downloaded: !!d, stale: !!d && (d.sv || 0) < META_SV, error: false, updatedTime: (d && d.updatedTime) || null };
    });
  } else {
    treeData = [...downloadedById.entries()].map(([id, d]) => {
      index.set(id, { path: d.path, category: d.category, source: d.source, name: d.name, rest: d.rest });
      return { path: d.path, api_name: d.path.split('/').pop().replace(/\.dg$/, ''), display_name: d.display_name || d.path.split('/').pop().replace(/\.dg$/, ''), namespace: d.namespace, rest: d.rest, id, category: d.category, source: d.source, downloaded: true, stale: (d.sv || 0) < META_SV, error: false, updatedTime: d.updatedTime || null };
    });
  }
  renderTree(); updateMissingButton(); attachFnStats();
  const dl = treeData.filter((e) => e.downloaded).length;
  setStatus(`${treeData.length} functions (${dl} downloaded).`, 'ok'); await refreshContext();
}

// The tree is built from .meta.json alone; the stats need the sources. Fill them in after the first
// render instead of blocking it — the graph gets built anyway the moment a function is opened.
async function attachFnStats() {
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
// how much a function talks to the outside — how to read that is the reader's call, not ours.
// Zoho's own list of Deluge integration namespaces: zoho.com/deluge/help/integration-tasks.html
const ZOHO_SERVICES = 'crm|creator|books|invoice|inventory|billing|subscriptions|desk|projects|people|recruit|mail|calendar|sheet|writer|cliq|connect|sign|analytics|bookings|salesiq|workdrive|map|notebook';
const RE_ZOHO_ANY = new RegExp('\\bzoho\\.(?:' + ZOHO_SERVICES + ')\\.\\w+', 'gi');
const RE_ZOHO_CRM = /\bzoho\.crm\.\w+/gi;
const RE_INVOKEURL = /\binvokeurl\b/gi;
const RE_SENDMAIL = /\bsendmail\b/gi;
// Comments and string literals are removed, so a task named in a comment or inside a message is not
// counted as a call. This is a single left-to-right scan on purpose: chained regexes get it wrong,
// because a URL literal ("https://x") contains "//" and a comment-first pass would cut the line and
// leave an unterminated quote that swallows the lines after it. Newlines are preserved so the line
// count stays meaningful.
function stripNonCode(src) {
  const s = String(src || '');
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); const seg = s.slice(i, e < 0 ? s.length : e + 2); out += seg.replace(/[^\n]/g, ' '); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '/' && d === '/') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; out += ' '; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; } i++; out += q + q; continue; }
    out += c; i++;
  }
  return out;
}
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
const statsLabel = (s) => `${s.lines} lines · ${(s.chars / 1024).toFixed(1)} KB · ${s.apiCalls} API call${s.apiCalls === 1 ? '' : 's'}`;

// ---------- graph cache ----------
async function loadGraph() {
  const nodes = [];
  for await (const p of walk(dir)) {
    if (!p.endsWith('.dg')) continue;
    const dg = await readFile(p); let meta = {}; try { meta = JSON.parse(await readFile(p.replace(/\.dg$/, '.meta.json'))); } catch {}
    nodes.push({ namespace: meta.nameSpace || p.split('/')[0], name: meta.name || p.split('/').pop().replace(/\.dg$/, ''), api_name: meta.api_name, category: meta.category, source: meta.source, display_name: meta.display_name, description: meta.description || '', rest: (meta.rest_api || []).some((r) => r.active), associated_place: meta.associated_place || null, return_type: meta.return_type, params: meta.params || [], connections: meta.connections || [], modified_by: meta.modified_by || null, updatedTime: meta.updatedTime || null, dg, file: p });
  }
  const g = window.buildGraph(nodes);
  nodes.forEach((nd) => { const id = nd.namespace + '.' + nd.name; if (g.nodes[id]) { g.nodes[id].return_type = nd.return_type; g.nodes[id].params = nd.params; g.nodes[id].source_code = nd.dg; g.nodes[id].connections = nd.connections; g.nodes[id].modified_by = nd.modified_by; g.nodes[id].updatedTime = nd.updatedTime; g.nodes[id].stats = fnStats(nd.dg); } });
  g.workspace = { instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null };
  return g;
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
function updateBack() { $('pvback').classList.toggle('show', pvHist.length > 0); }
function openFromTree(path) { pvHist = []; openFile(path); }
async function openFile(path, push = false, line = null) {
  if (!(await ensurePerm(dir))) { setStatus('File access denied — click Refresh to grant.', 'bad'); return; }
  if (push && currentPath && currentPath !== path) pvHist.push(currentPath);
  currentPath = path; updateBack(); if ($('status').className) setStatus('', '');
  $('pvreveal').style.display = 'none';   // "Go to" (auto-open in the editor) removed: it drove Zoho's localized DOM. Find is the deterministic way in.
  $('pvfind').style.display = ''; $('pvfind').textContent = 'Find in Zoho \u2197'; $('pvfind').title = 'Filter the Zoho functions list to this function \u2014 then open it from Zoho\u2019s own \u22ef menu (Edit / Delete / Duplicate\u2026)'; $('pvbody').style.display = 'flex'; $('pvtable').style.display = 'none';
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
  $('pvname').textContent = path; $('pvcallers').className = ''; $('pvcallers').textContent = '';
  let code; try { code = await readFile(path); } catch (e) { setStatus('Read failed: ' + e.message, 'bad'); return; }
  const lines = code.split('\n').length;
  $('pvgutter').textContent = Array.from({ length: lines }, (_, k) => k + 1).join('\n');
  const _g = await ensureGraph().catch(() => null);
  const _resolve = _g ? makeCallResolver(_g) : null;
  $('pvcode').innerHTML = window.highlightDeluge ? window.highlightDeluge(code, _resolve) : escHtml(code);
  $('pvcode').querySelectorAll('a.c-link').forEach((a) => { a.onclick = () => openFile(a.dataset.file, true); });
  $('preview').classList.add('show'); $('resizer').classList.add('show'); resetPreviewScroll();
  if (line) { const lh = parseFloat(getComputedStyle($('pvcode')).lineHeight) || 16; $('pvbody').scrollTop = Math.max(0, (line - 3) * lh); }
  showCallers(path);
}
async function showCallers(path) {
  const box = $('pvcallers'); box.textContent = 'computing references…'; box.className = 'show';
  try {
    const g = await ensureGraph(); if (currentPath !== path) return;
    const node = Object.values(g.nodes).find((n) => n.file === path); if (!node) { box.className = ''; return; }
    const callers = node.called_by;
    const nm = (id) => nameMode === 'display' ? (g.nodes[id].display_name || g.nodes[id].name) : (g.nodes[id].api_name || g.nodes[id].name);
    let html = callers.length
      ? `<b>Called by (${callers.length}):</b> ` + callers.map((id) => `<a data-file="${escA(g.nodes[id].file)}" title="${escA(g.nodes[id].display_name || g.nodes[id].name || '')}">${escHtml(nm(id))}</a>`).join(', ')
      : '<b>Called by</b> \u2014 none';
    const ap = node.associated_place || [];
    if (ap.length) {
      const byType = {};
      ap.forEach((p) => (byType[p._type || 'other'] ||= []).push(p.name || '(unnamed)'));
      html += '<div class="apwrap">' + Object.keys(byType).sort().map((t) => `<b>Used in ${escHtml(t)} (${byType[t].length}):</b> ${byType[t].map(escHtml).join(', ')}`).join('<br>') + '</div>';
    } else if (!callers.length && !node.rest) {
      html += ' <span class="orphan">\u00b7 no known usage (orphan candidate)</span>';
    }
    const conns = node.connections || [];
    if (conns.length) {
      html += '<div class="connwrap"><b>Connections (' + conns.length + '):</b> '
        + conns.map((c) => `<span class="conn" data-conn="${escA(c.name)}" title="${escA((c.label || c.name) + (c.service ? ' \u00b7 ' + c.service : '') + ' \u2014 click to list every function that uses it')}">${escHtml(c.name)}</span>`).join(' ')
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
    box.querySelectorAll('a[data-file]').forEach((a) => (a.onclick = () => openFile(a.dataset.file, true)));
    box.querySelectorAll('.conn[data-conn]').forEach((c) => (c.onclick = () => filterByConnection(c.dataset.conn)));
  } catch { box.className = ''; }
}
$('pvback').onclick = () => { const p = pvHist.pop(); updateBack(); if (p) openFile(p, false); };
$('pvx').onclick = () => { $('preview').classList.remove('show'); $('resizer').classList.remove('show'); currentPath = null; pvHist = []; updateBack(); };

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
function homeUrl() {
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  return base && inst ? `${base}/crm/${inst}/` : 'https://crm.zoho.com/';
}
async function openZohoHome() {
  const url = homeUrl();
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url, active: true });
}
async function openModulePage(genName, navigable, label) {
  if (navigable === false) { setStatus(`\u00ab${label || genName}\u00bb has no records tab (linking/subform or no access).`, 'warn'); return; }
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !genName) { setStatus('Unknown module target — pull once, or open Zoho first.', 'warn'); return; }
  const url = `${base}/crm/${inst}/tab/${genName}`;
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url });
  setStatus(`Opened ${genName} in Zoho.`, 'ok');
}
async function openModuleLayouts(gen) {
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !gen) { setStatus('Unknown module target — pull once, or open Zoho first.', 'warn'); return; }
  const url = `${base}/crm/${inst}/settings/modules/${gen}/layouts`;
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url });
  setStatus(`Opened ${gen} layouts in Zoho.`, 'ok');
}
async function openModuleLayoutEdit(gen, layoutId) {
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !gen) { setStatus('Unknown module target — pull once, or open Zoho first.', 'warn'); return; }
  const url = layoutId ? `${base}/crm/${inst}/settings/modules/${gen}/layouts/${layoutId}` : `${base}/crm/${inst}/settings/modules/${gen}/layouts`;
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url });
  setStatus(layoutId ? 'Opened layout for editing in Zoho.' : `Opened ${gen} layouts in Zoho.`, 'ok');
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
  if (!bound || !bound.base || !bound.instance) { setStatus('Unknown target \u2014 pull that workspace once from its own tab.', 'warn'); return; }
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
  const url = functionsUrl();                       // prefers the ACTIVE workspace's base+instance
  if (!url) { setStatus('Unknown target — pull this workspace once, or open Zoho manually.', 'warn'); return null; }
  if (newTab) { const t = await chrome.tabs.create({ url, active: true }); return t.id; }
  let id = await zohoTabId();
  if (id) await chrome.tabs.update(id, { url, active: true }); else { const t = await chrome.tabs.create({ url }); id = t.id; }
  return id;
}
$('funcs').onclick = () => openTargetZoho(false);
$('gozoho').onclick = () => openZohoHome();
$('mmgo').onclick = () => switchTab();   // mismatch: log out current session and land on the workspace's org (current tab)
async function listReady(id) {
  try { await ensureBridge(id); const r = await chrome.tabs.sendMessage(id, { cmd: 'listReady' }); return !!(r && r.ready); } catch { return false; }
}
let _revealListener = null;
async function listReadyWait(id, tries = 24) { for (let k = 0; k < tries && !(await listReady(id)); k++) await sleep(250); }
// Find = fill the Zoho functions-list search box with this function's name. We wait (bounded, in
// reveal) for the search box to exist \u2014 a known, language-independent element \u2014 then fill it ONCE.
// If it is not there, we STOP and say exactly that, instead of retrying an action we are not sure of.
async function doFilter(id, fn, nice) {
  await ensureBridge(id);
  if (!(await listReady(id))) { setStatus('Couldn\u2019t find the Zoho functions search box \u2014 is the Functions list open?', 'warn'); return; }
  try {
    const r = await chrome.tabs.sendMessage(id, { cmd: 'fillSearch', name: fn.name || fn.apiName });
    if (r && r.ok) { setStatus(`Filtered \u201c${r.term}\u2026\u201d \u2014 open \u201c${nice}\u201d from Zoho\u2019s \u22ef menu.`, 'ok'); return; }
    setStatus('Couldn\u2019t fill the Zoho search box.', 'warn');
  } catch (e) { setStatus('Couldn\u2019t reach the Zoho functions list: ' + e.message, 'warn'); }
}
// Navigate to the Zoho Functions list (deterministic URL) and pre-filter it to `fn` (Find). The
// only DOM touch left is filling the class-selected search box; there is no click-and-hope here.
async function reveal(fn) {
  const nice = fn.displayName || fn.name || fn.apiName;
  let id = await zohoTabId();
  if (!id) { id = await openTargetZoho(false); if (!id) return; }
  if (_revealListener) { chrome.tabs.onUpdated.removeListener(_revealListener); _revealListener = null; }
  const url = functionsUrl();
  let tab = null; try { tab = await chrome.tabs.get(id); } catch (_) {}
  const same = url && tab && (tab.url || '').split('#')[0].split('?')[0] === url.split('#')[0].split('?')[0];
  if (!same) {
    setStatus('Opening Functions list\u2026', 'busy');
    if (url) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.reload(id);
    await sleep(400); await waitTabComplete(id); await listReadyWait(id); await doFilter(id, fn, nice); return;
  }
  // Same URL -> reload the list, but open the target only AFTER a real reload completes.
  // Handles Zoho's native "unsaved changes" dialog: if the user picks "Reload" (even seconds
  // later) we still open the function; if they "Cancel", nothing is forced.
  setStatus('Opening Functions list\u2026', 'busy');
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
  if (currentPath && currentPath.startsWith('_workflows/')) { await openWorkflowInZoho(currentPath.split('/').pop().replace(/\.json$/, '')); return; }
  if (currentPath && currentPath.startsWith('_modules/')) {
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
    : [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive']];
  if (viewMode === 'functions') typeFilter = 'all'; else if (viewMode === 'modules') moduleFilter = 'all'; else if (viewMode === 'workflows') workflowFilter = 'all'; else if (viewMode === 'schedules') scheduleFilter = 'all'; else connCatFilter = 'all';
  // A one-line dropdown, not chips: in Functions mode there are 7 filters and they wrapped to a
  // second row, eating vertical space the tree/preview below needs more than the filter does.
  const lbl = document.createElement('span'); lbl.className = 'fsellbl';
  lbl.textContent = viewMode === 'functions' ? 'Type' : viewMode === 'modules' ? 'Kind' : viewMode === 'connections' ? 'Filter' : 'Status';
  const sel = document.createElement('select'); sel.className = 'filtersel'; sel.setAttribute('aria-label', lbl.textContent + ' filter');
  defs.forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; sel.appendChild(o); });
  sel.value = 'all';
  sel.onchange = () => {
    const k = sel.value;
    if (viewMode === 'functions') typeFilter = k; else if (viewMode === 'modules') moduleFilter = k; else if (viewMode === 'workflows') workflowFilter = k; else if (viewMode === 'schedules') scheduleFilter = k; else connCatFilter = k;
    (viewMode === 'functions' ? runSearch() : viewMode === 'modules' ? renderModules() : viewMode === 'workflows' ? renderWorkflows() : viewMode === 'schedules' ? renderSchedules() : renderConnections());
  };
  wrap.appendChild(lbl); wrap.appendChild(sel);
  // Functions only: the numeric columns are what you sort by, and only functions have them.
  if (viewMode === 'functions') {
    const sl = document.createElement('span'); sl.className = 'fsellbl'; sl.textContent = 'Sort';
    const ss = document.createElement('select'); ss.className = 'filtersel'; ss.setAttribute('aria-label', 'Sort functions');
    [['name', 'Name (grouped)'], ['lines', 'Lines'], ['calls', 'API calls'], ['size', 'Size'], ['modified', 'Last modified']]
      .forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; ss.appendChild(o); });
    ss.value = treeSort;
    const dirBtn = document.createElement('button'); dirBtn.className = 'sortdir';
    const paintDir = () => {
      const asc = treeSortDir === 'asc';
      dirBtn.textContent = asc ? '↑' : '↓';
      dirBtn.title = treeSort === 'name'
        ? (asc ? 'A to Z — click for Z to A' : 'Z to A — click for A to Z')
        : (asc ? 'Lowest first — click for highest first' : 'Highest first — click for lowest first');
      dirBtn.setAttribute('aria-label', dirBtn.title);
    };
    // Changing what you sort by resets the direction to the one that is almost always wanted:
    // names read A→Z, numbers read biggest-first.
    ss.onchange = () => { treeSort = ss.value; treeSortDir = treeSort === 'name' ? 'asc' : 'desc'; paintDir(); renderTree(); };
    dirBtn.onclick = () => { treeSortDir = treeSortDir === 'asc' ? 'desc' : 'asc'; paintDir(); renderTree(); };
    paintDir();
    wrap.appendChild(sl); wrap.appendChild(ss); wrap.appendChild(dirBtn);
  }
}
$('nameToggle').onclick = () => {
  if (viewMode === 'functions') {
    nameMode = nameMode === 'internal' ? 'display' : 'internal';
    $('nameToggle').textContent = 'Name: ' + nameMode;
    renderTree(); if (currentPath) showCallers(currentPath);
  } else {
    moduleNameMode = moduleNameMode === 'api' ? 'display' : moduleNameMode === 'display' ? 'generated' : 'api';
    $('nameToggle').textContent = 'Name: ' + moduleNameMode;
    renderModules();
  }
};
$('find').oninput = runSearch;
$('findx').onclick = () => { $('find').value = ''; runSearch(); $('find').focus(); };
$('smode').onclick = () => {
  if (viewMode !== 'functions') return;   // full-text search applies to function code only
  searchMode = searchMode === 'name' ? 'content' : 'name';
  $('smode').textContent = searchMode === 'name' ? 'in: names' : 'in: code';
  $('smode').classList.toggle('on', searchMode === 'content');
  $('find').placeholder = searchMode === 'name' ? 'Find by name\u2026' : 'Find inside the code\u2026';
  runSearch();
};
function runSearch() {
  if (viewMode === 'modules') { renderModules(); return; }
  if (viewMode === 'workflows') { renderWorkflows(); return; }
  if (viewMode === 'schedules') { renderSchedules(); return; }
  if (viewMode === 'connections') { renderConnections(); return; }
  if (searchMode === 'content') { clearTimeout(_searchT); _searchT = setTimeout(contentSearch, 220); }
  else renderTree();
}
async function getCodeCache() {
  if (codeCache) return codeCache;
  const m = new Map();
  for (const e of treeData) { if (!e.downloaded) continue; try { m.set(e.id, await readFile(e.path)); } catch (_) {} }
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
  if (!results.length) { tree.innerHTML = `<div class="treemsg">No matches for \u201c${escHtml(term)}\u201d.</div>`; return; }
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
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    const ctx = await getContext(); if (!ctx) throw new Error('No Zoho CRM tab open.');
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing to avoid cross-environment mix-ups.`);
    setStatus('Listing functions…', 'busy');
    const r = await toBridge({ cmd: 'listFunctions' }); if (!r?.ok) throw bridgeError(r, 'list failed');
    await writeFile('_index/functions.json', JSON.stringify(r.entries, null, 2));
    // reflect deletions: remove local files for functions no longer in Zoho
    const liveIds = new Set(r.entries.map((e) => String(e.id))); const rmF = [];
    for await (const p of walk(dir)) {
      if (p.startsWith('_index/') || p.startsWith('_modules/') || p.startsWith('export/')) continue;
      if (p.endsWith('.meta.json')) { try { const mm = JSON.parse(await readFile(p)); if (!liveIds.has(String(mm.id))) { rmF.push(p); rmF.push(p.replace(/\.meta\.json$/, '.dg')); } } catch (_) {} }
    }
    let prunedF = 0; for (const p of rmF) { try { await removeFile(p); if (p.endsWith('.dg')) prunedF++; } catch (_) {} }
    codeCache = null;
    await writeCfg({ org: ctx.org, instance: ctx.instance, base: ctx.origin, lastPull: new Date().toISOString() });
    bound = { org: ctx.org, base: ctx.origin, instance: ctx.instance }; await cacheBinding(bound);
    await rebuildTree();
    await downloadMissing();   // fetch each function's code, resiliently (partials stay; failures can be retried)
    if (prunedF) setStatus($('stxt').textContent + ` \u00b7 ${prunedF} deleted removed`, 'ok');
    await noteAccess('functions', null);
  } catch (e) { await noteAccess('functions', e); setStatus(pullFailMessage('functions', e), 'bad'); } finally { pullActive = false; }
}
async function openGraph() {
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    setStatus('Building graph…', 'busy'); await refreshContext(); const g = await ensureGraph();
    g.workspace = { instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null };
    await chrome.storage.local.set({ graphData: g });
    await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html'), type: 'normal', width: 1240, height: 840 });
    setStatus(`Graph: ${g.counts.nodes} nodes, ${g.counts.edges} edges.`, 'ok');
  } catch (e) { setStatus('Graph error: ' + e.message, 'bad'); }
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
  const fnLink = (n) => `<a data-file="${escHtml(n.file)}">${nmNode(n)}</a>`;
  const orphan = nodes.filter((n) => n.dead_suspect).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">${escHtml(n.namespace || '')}</span>` }));
  const unresolved = nodes.filter((n) => n.unresolved && n.unresolved.length).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">calls: ${escHtml(n.unresolved.join(', '))}</span>` }));
  const ambiguous = nodes.filter((n) => n.ambiguous && n.ambiguous.length).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">ambiguous: ${escHtml(n.ambiguous.join(', '))}</span>` }));
  const broken = [];
  let wfIdx = []; try { wfIdx = JSON.parse(await readFile('_workflows/_index.json')); } catch (_) {}
  for (const w of wfIdx) { let d = null; try { d = JSON.parse(await readFile(`_workflows/${w.id}.json`)); } catch (_) {} if (!d) continue; (d.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter((a) => a.type === 'functions').forEach((a) => { if (!(fnById[String(a.id)] || fnByName[(a.name || '').toLowerCase()])) broken.push({ kind: 'workflow', id: w.id, name: w.name, fn: a.name }); }); }); }
  let scheds = []; try { scheds = JSON.parse(await readFile('_schedules/_index.json')); } catch (_) {}
  scheds.forEach((sc) => { if (!(fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()])) broken.push({ kind: 'schedule', id: sc.id, name: sc.name, fn: sc.function_name }); });
  const brokenItems = broken.map((b) => ({ html: `<span>${escHtml(b.kind)}</span> <a data-kind="${escHtml(b.kind)}" data-id="${escHtml(String(b.id || ''))}">${escHtml(b.name || '?')}</a> <span class="meta">\u2192 missing function \u00ab${escHtml(b.fn || '?')}\u00bb</span>` }));
  const missingFK = []; const modApis = new Set(); const modObjs = [];
  for await (const p of walk(dir)) { if (p.startsWith('_modules/') && p.endsWith('.json') && !p.endsWith('_index.json')) { try { const m = JSON.parse(await readFile(p)); modObjs.push(m); modApis.add(m.api_name); } catch (_) {} } }
  modObjs.forEach((m) => { if (/__s$/.test(m.api_name || '')) return; (m.fields || []).forEach((fl) => { let t = fl.lookup; if (t && typeof t === 'object') t = t.api_name || (typeof t.module === 'string' ? t.module : (t.module && t.module.api_name)) || null; if (!t || typeof t !== 'string') return; if (/__s$/.test(t)) return; if (!modApis.has(t)) missingFK.push({ module: m.api_name, field: fl.api_name || fl.label, target: t }); }); });
  const fkItems = missingFK.map((r) => ({ html: `<b>${escHtml(r.module)}</b>.<span>${escHtml(r.field)}</span> <span class="meta">\u2192 ${escHtml(r.target)} (not in workspace)</span>` }));
  const coverage = `<b>Coverage.</b> Analyzed: function\u2192function calls, workflows, schedules, and each function's <i>associated_place</i> (blueprint, button, \u2026). <b>Not</b> analyzed: custom client scripts, approval/assignment/scoring rules, and anything Zoho doesn't report. Every item is a <b>candidate to review</b> \u2014 never an automatic deletion. <b>Size &amp; calls</b> are plain counts with no threshold and no verdict: they show where length and outbound calls concentrate, and you decide what that means. Based on ${nodes.length} functions, ${modObjs.length} modules in this workspace.`;
  // Size and outbound-call counts, shown as plain rankings with no threshold and no verdict: a long
  // function is worth a look, not automatically wrong, and the reader decides what the numbers mean.
  const withStats = nodes.filter((n) => n.stats && n.stats.lines);
  const biggest = withStats.slice().sort((a, b) => b.stats.lines - a.stats.lines).slice(0, 15)
    .map((n) => ({ html: `${fnLink(n)} <span class="meta">${n.stats.lines} lines · ${n.stats.codeLines} code · ${(n.stats.chars / 1024).toFixed(1)} KB</span>` }));
  const chattiest = withStats.filter((n) => n.stats.apiCalls > 0).sort((a, b) => b.stats.apiCalls - a.stats.apiCalls).slice(0, 15)
    .map((n) => ({ html: `${fnLink(n)} <span class="meta">${n.stats.apiCalls} calls — ${n.stats.invokeurl} invokeurl · ${n.stats.crm} zoho.crm · ${n.stats.zoho} other${n.stats.sendmail ? ' · ' + n.stats.sendmail + ' sendmail' : ''}</span>` }));
  const groups = [
    { id: 'biggest', tab: 'size', title: 'Largest functions', desc: 'By line count, longest first. Length is verbosity, not complexity — a long function is worth a look, not necessarily a problem.', bad: false, items: biggest },
    { id: 'chattiest', tab: 'size', title: 'Most outbound calls', desc: 'invokeurl, zoho.crm and other Zoho service tasks, counted outside comments and strings. Each call is work Zoho meters, so this is where execution cost concentrates.', bad: false, items: chattiest },
    { id: 'orphan', tab: 'functions', title: 'Orphan candidates', desc: 'No caller in code, not exposed as REST, and no associated_place.', bad: false, items: orphan },
    { id: 'unresolved', tab: 'functions', title: 'Unresolved calls', desc: 'Calls a function that does not resolve to anything in this workspace.', bad: true, items: unresolved },
    { id: 'ambiguous', tab: 'functions', title: 'Ambiguous calls', desc: 'A call matches more than one function (name collision across namespaces).', bad: false, items: ambiguous },
    { id: 'broken', tab: 'wiring', title: 'Broken automations', desc: 'A workflow or schedule references a function not in this workspace.', bad: true, items: brokenItems },
    { id: 'fk', tab: 'wiring', title: 'Missing module references', desc: 'A lookup field points to a module not in this workspace (may be a system module).', bad: false, items: fkItems },
  ];
  return { groups, coverage };
}
async function openHealth() {
  if (!dir) return;
  closeAI();   // one panel at a time
  $('healthview').classList.add('show'); $('health').classList.add('on'); document.body.classList.add('health-open');   // lit button + violet frame + covers the tabs, mirroring Ask AI
  $('healthbody').innerHTML = '<div class="hd">Analyzing\u2026</div>';
  // Health reads the workspace files directly. Chrome lets the folder's File System Access
  // permission lapse after inactivity; without re-requesting it first (like every other file
  // operation does) the reads throw a generic "not allowed" DOMException. This click is a user
  // gesture, so requesting here re-grants it \u2014 and if the user declines, we say so plainly.
  if (!(await ensurePerm(dir))) { $('healthbody').innerHTML = '<div class="hd">Folder access is not granted \u2014 click Refresh, then open Health again.</div>'; return; }
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
  $('healthbody').querySelectorAll('a[data-kind]').forEach((a) => (a.onclick = () => (a.dataset.kind === 'workflow' ? healthOpenWorkflow(a.dataset.id) : healthOpenSchedule(a.dataset.id))));
}
function healthOpenFn(file, line) { closeHealth(); if (viewMode !== 'functions') { setMode('functions'); } openFile(file, true, line || null); }
async function healthOpenWorkflow(id) { closeHealth(); setMode('workflows'); await rebuildWorkflows(); const e = workflowData.find((w) => String(w.id) === String(id)); if (e) openWorkflow(e); else setStatus('Workflow not found in this workspace.', 'warn'); }
async function healthOpenSchedule(id) { closeHealth(); setMode('schedules'); await rebuildSchedules(); const e = scheduleData.find((x) => String(x.id) === String(id)); if (e) openSchedule(e); else setStatus('Schedule not found in this workspace.', 'warn'); }
function toggleHealth() { if ($('healthview').classList.contains('show')) closeHealth(); else openHealth(); }
function closeHealth() { $('healthview').classList.remove('show'); $('health').classList.remove('on'); document.body.classList.remove('health-open'); }

// ---------- AI assistant (BYOK, provider-agnostic; Phase A: context chat) ----------
let aiMessages = [], aiModCache = null, aiConnCache = null, aiSeedTruncated = false, aiSeedWarned = false;
async function aiGetCfg() {
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  return { active: c.active || 'anthropic', anthropic: Object.assign({ model: '', apiKey: '' }, c.anthropic || {}), openai: Object.assign({ model: '', apiKey: '' }, c.openai || {}), maxIter: c.maxIter || 20, seedCap: c.seedCap || AI_SEED_CAP_DEFAULT };
}
function aiActiveReady(cfg) { const p = cfg[cfg.active] || {}; return !!(p.apiKey && p.model); }
async function aiSaveCfg(cfg) { try { await chrome.storage.local.set({ aicfg: cfg }); } catch (_) {} }
function aiTrunc(x, n) { const s = x || ''; return s.length > n ? s.slice(0, n) + '\n\u2026 (truncated)' : s; }
async function aiLoadModules() {
  if (aiModCache) return aiModCache;
  const map = {};
  for await (const p of walk(dir)) { if (p.startsWith('_modules/') && p.endsWith('.json') && !p.endsWith('_index.json')) { try { const m = JSON.parse(await readFile(p)); map[m.api_name] = m; } catch (_) {} } }
  aiModCache = map; return map;
}
// Connections catalogue for the AI, joined with the functions that use each (same join key as the
// Connections tab: meta.connections[].name, the string in invokeurl [...connection:"..."]).
async function aiLoadConnections() {
  if (aiConnCache) return aiConnCache;
  let cat = []; try { cat = JSON.parse(await readFile('_connections/_index.json')); } catch (_) {}
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
  let s = `Module ${m.api_name}\n| Field | API name | Type | Lookup | Picklist |\n`;
  (m.fields || []).forEach((f) => { s += `| ${f.label || f.api_name} | ${f.api_name} | ${(f.data_type || '') + (f.length ? ' (' + f.length + ')' : '')} | ${f.lookup ? '\u2192 ' + f.lookup : ''} | ${(f.picklist && f.picklist.length) ? f.picklist.slice(0, 15).join(', ') : ''} |\n`; });
  return s;
}
// The org, stated as compactly as it can be, in layers of decreasing importance.
//
// The index goes with *every* message, so its size is what a question costs before it has been
// asked. A large org does not fit, and the question is then not "how big a cap" but "what gets
// dropped". Cutting the tail is the wrong answer: it removes an arbitrary half and the model cannot
// tell it is missing, which is how an assistant ends up asserting a function does not exist.
//
// Functions are the vocabulary here — nothing can be answered without knowing what exists — so they
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

  const mods = await aiLoadModules(); const mk = Object.keys(mods).sort();
  const modules = `\n## Modules (${mk.length})\n` + mk.map((k) => '- ' + k).join('\n') + '\n';

  const conns = await aiLoadConnections();
  const connections = conns.length
    ? `\n## Connections (${conns.length})\n` + conns.slice().sort((a, b) => b.uses.length - a.uses.length).map((c) => `- ${c.name}${c.connector ? ' [' + c.connector + ']' : ''} \u00b7 used by ${c.uses.length} function(s)${c.connected === false ? ' \u00b7 NOT CONNECTED' : ''}${c.missing ? ' \u00b7 not in catalogue' : ''}`).join('\n') + '\n'
    : '';

  const omitted = [];
  let out = funcs;
  if (out.length + modules.length <= cap) out += modules; else omitted.push(`the ${mk.length} module names`);
  if (out.length + connections.length <= cap) out += connections; else if (connections) omitted.push(`the ${conns.length} connections`);
  aiSeedOmitted = omitted;
  if (out.length > cap) {                 // even the function list alone overflows
    aiSeedOmitted = ['part of the function index — this org is larger than the index can hold'];
    out = aiTrunc(out, cap);
  }
  aiSeedTruncated = omitted.length > 0 || out.length >= cap;
  if (omitted.length) {
    out += `\nNOT LISTED ABOVE: ${omitted.join(' and ')}. They exist and can be fetched by name`
      + ` (list_functions, get_module, get_connection) \u2014 do not assume something is absent because`
      + ` it is not in this index.\n`;
  }
  aiSeedSize = out.length;
  return out;
}

// What the user is looking at, whatever kind of thing it is.
//
// This existed for Deluge functions only. Select a workflow, open the assistant, ask "what does this
// do?" and it answered that it had no reference and asked for details — while the same question
// about a function worked. `currentPath` was already being set by every tab; only this read it for
// one of them. Adding a tab and not extending the focus is the "one of a set" miss the conventions
// warn about, and it is invisible until someone asks the obvious question.
//
// The non-function kinds are serialised from the data actually captured rather than described field
// by field. Naming fields here would be a second description of each shape, free to drift from the
// pull that produces it — and inventing one that does not exist is how an assistant ends up
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
    if (p.startsWith('_workflows/')) {
      const e = workflowData.find((x) => x.path === p);
      // The list entry is the index — name, module, type. What the workflow *does* is its conditions
      // and actions, and those live in the file, which is exactly what "what does this do?" asks for.
      let detail = null;
      try { detail = JSON.parse(await readFile(p)); } catch (_) {}
      if (detail || e) {
        return block(`the workflow «${(e && e.name) || (detail && detail.name) || '?'}»`,
          aiTrunc(JSON.stringify(detail || e, null, 2), 6000))
          + (detail ? '' : '\nOnly the index entry is on disk for this workflow; its conditions and actions have not been pulled.\n');
      }
    }
    if (p.startsWith('_schedules/')) {
      const e = scheduleData.find((x) => x.path === p);
      if (e) return block(`the schedule «${e.name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 3000));
    }
    if (p.startsWith('_connections/')) {
      const e = connectionData.find((x) => x.path === p);
      if (e) return block(`the connection «${e.label || e.name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 3000));
    }
    if (p.startsWith('_modules/')) {
      const e = moduleData.find((x) => x.path === p);
      if (e) return block(`the module «${e.label || e.api_name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 6000));
    }
  } catch (_) { /* a focus that cannot be built is simply absent: never a reason to fail the chat */ }
  return '';
}

// The extension's own help, so "how do I export this?" is answered where the user already is
// rather than by sending them to a website — which would move the question rather than answer it.
// Guarded: a missing script must cost the product primer, never the whole assistant.
function productHelp() {
  try { return '\n' + window.ZOOST_PRODUCT_HELP.text() + '\n'; } catch (_) { return ''; }
}

async function aiSystemPromptB(withTools, cap) {
  const seed = await aiBuildSeed(cap);
  const focus = await aiFocus();
  const toolsLine = withTools
    ? 'You have READ-ONLY tools to explore the real org: list_functions, get_function, who_calls, get_callees, search_code, get_module, get_workflow, get_connection. Use them to fetch exact code/schema instead of guessing or inventing. The ORG INDEX lists what exists \u2014 call tools for the details you need.'
    : 'Answer from the ORG INDEX and CURRENT FOCUS below. If you need code that is not shown, say which function/module you would need rather than inventing it.';
  return `You are an expert assistant for Zoho CRM Deluge scripting and CRM architecture, working on the user\u2019s real org.\n${toolsLine}\nBe precise, reference real function/module names, and follow Deluge best practices (avoid API calls in loops, guard null access, avoid hardcoded IDs).\n${productHelp()}${focus}\n# ORG INDEX\n${seed}`;
}
const AI_TOOLS = [
  { name: 'list_functions', description: 'List workspace functions with their size and outbound-call counts. Optionally filter by a substring of "namespace.name", and/or by thresholds (min_lines, min_calls) — use the thresholds to answer "how many functions are longer than N lines" exactly, instead of counting by hand. Sorted by lines, longest first.', input_schema: { type: 'object', properties: { filter: { type: 'string' }, min_lines: { type: 'number' }, min_calls: { type: 'number' } } } },
  { name: 'get_function', description: 'Full Deluge source and metadata of a function identified by "namespace.name" (or just its name).', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'who_calls', description: 'List functions that call the given function.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_callees', description: 'List functions called by the given function.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'search_code', description: 'Full-text search across all function sources; returns "namespace.name:line" matches.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_module', description: 'Field schema of a module by api_name.', input_schema: { type: 'object', properties: { api_name: { type: 'string' } }, required: ['api_name'] } },
  { name: 'get_connection', description: 'A connection by name (the string used in invokeurl [...connection:"..."]): its connector, status, scopes, and every function that uses it.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_workflow', description: 'A workflow by id or name, with trigger and function actions.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];
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
      + rows.map((r) => `${r.id} — ${r.s.lines} lines, ${r.s.apiCalls} calls`).join('\n');
  }
  if (name === 'get_function') { const n = findFn(input.name); if (!n) return 'Function not found: ' + input.name; return `namespace.name: ${n.namespace}.${n.name}\napi_name: ${n.api_name || ''}\nreturns: ${n.return_type || ''}  REST: ${!!n.rest}\ncalls: ${(n.calls || []).join(', ') || '(none)'}\ncalled_by: ${(n.called_by || []).join(', ') || '(none)'}\nused_in: ${(n.associated_place || []).map((p) => p._type).join(', ') || '(none)'}\nconnections: ${(n.connections || []).map((c) => c.name).join(', ') || '(none)'}\n${n.stats ? `size: ${n.stats.lines} lines (${n.stats.codeLines} code), ${n.stats.chars} chars\noutbound_calls: ${n.stats.apiCalls} (invokeurl ${n.stats.invokeurl}, zoho.crm ${n.stats.crm}, other Zoho ${n.stats.zoho}, sendmail ${n.stats.sendmail})\n` : ''}last_modified: ${n.modified_by ? 'by ' + n.modified_by : ''}${n.updatedTime ? ' ' + String(n.updatedTime).slice(0, 16) : ''}\n\n${n.source_code || ''}`; }
  if (name === 'who_calls') { const n = findFn(input.name); return n ? ((n.called_by || []).join('\n') || '(no callers)') : 'Function not found: ' + input.name; }
  if (name === 'get_callees') { const n = findFn(input.name); return n ? ((n.calls || []).join('\n') || '(no callees)') : 'Function not found: ' + input.name; }
  if (name === 'search_code') { const q = (input.query || '').toLowerCase(); if (!q) return '(empty query)'; const hits = []; Object.values(nodes).forEach((n) => { const src = n.source_code || ''; const i = src.toLowerCase().indexOf(q); if (i >= 0) hits.push(`${n.namespace}.${n.name}:${src.slice(0, i).split('\n').length}`); }); return hits.length ? hits.slice(0, 60).join('\n') : '(no matches)'; }
  if (name === 'get_module') { const mods = await aiLoadModules(); const m = mods[input.api_name] || Object.values(mods).find((x) => (x.api_name || '').toLowerCase() === String(input.api_name).toLowerCase()); return m ? aiModuleText(m) : 'Module not found: ' + input.api_name; }
  if (name === 'get_connection') {
    const list = await aiLoadConnections();
    const q = String(input.name || '').toLowerCase();
    const c = list.find((x) => (x.name || '').toLowerCase() === q) || list.find((x) => (x.label || '').toLowerCase() === q);
    if (!c) return 'Connection not found: ' + input.name + (list.length ? '\nKnown: ' + list.map((x) => x.name).join(', ') : '\n(no connections pulled — run Pull all)');
    return `connection: ${c.name}\nlabel: ${c.label || ''}\nconnector: ${c.connector || '(unknown)'}\n`
      + `status: ${c.missing ? 'referenced by functions but NOT in the catalogue' : c.connected === false ? 'configured but NOT connected' : 'connected'}\n`
      + `created_by: ${c.createdBy || ''}\nscopes: ${(c.scopes || []).join(', ') || '(none)'}\n`
      + `used_by (${c.uses.length}): ${c.uses.join(', ') || '(none — unused by the functions in this workspace; Flow, widgets and client scripts are not visible to Zoost)'}`;
  }
  if (name === 'get_workflow') { let idx = []; try { idx = JSON.parse(await readFile('_workflows/_index.json')); } catch (_) {} const q = String(input.query || '').toLowerCase(); const w = idx.find((x) => String(x.id) === input.query || (x.name || '').toLowerCase() === q || (x.name || '').toLowerCase().includes(q)); if (!w) return 'Workflow not found: ' + input.query; let det = null; try { det = JSON.parse(await readFile(`_workflows/${w.id}.json`)); } catch (_) {} const fns = []; if (det) (det.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter((a) => a.type === 'functions').forEach((a) => fns.push(a.name)); }); return `Workflow: ${w.name}\nmodule: ${w.module || ''}\nfunctions: ${[...new Set(fns)].join(', ') || '(none)'}`; }
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
  if (!txt && c && c.finish_reason === 'length') return '(The model hit the output limit before writing anything \u2014 this usually means the workspace context is too large for it. Try a model with a bigger context window.)';
  return txt;
}
let aiBusy = false;
function aiRenderMessages() {
  const box = $('aimsgs');
  if (!aiMessages.length && !aiBusy) { box.innerHTML = '<div class="aimsg assistant"><div class="aitext">Ask me anything about this org\u2019s Deluge \u2014 I can open functions, trace callers, read module schemas, and search the code.</div></div>'; return; }
  box.innerHTML = aiMessages.map((m) => m.role === 'tool' ? `<div class="aitool">${escHtml(m.content)}</div>` : `<div class="aimsg ${m.role}"><div class="airole">${m.role === 'user' ? 'You' : 'AI'}</div><div class="aitext">${m.role === 'assistant' ? aiMarkdown(m.content) : escHtml(m.content).replace(/\n/g, '<br>')}</div></div>`).join('')
    + (aiBusy ? '<div class="aiwait"><i></i><i></i><i></i> thinking\u2026</div>' : '');
  box.scrollTop = box.scrollHeight;
}
async function aiSend() {
  const cfg = await aiGetCfg();
  aiEngineChrome();
  if (!aiActiveReady(cfg)) { aiOpenSettings(); setStatus('Set the model and API key in Settings (just opened), then try again.', 'warn'); return; }
  const inp = $('aiinput'); const text = inp.value.trim(); if (!text) return;
  inp.value = ''; aiMessages.push({ role: 'user', content: text });
  aiBusy = true; $('aisend').disabled = true; aiRenderMessages(); setStatus('AI thinking\u2026', 'busy');
  try {
    const apiMessages = aiMessages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim() !== '').map((m) => ({ role: m.role, content: m.content }));
    const withTools = cfg.active === 'anthropic';
    const system = await aiSystemPromptB(withTools, cfg.seedCap);
    // The org index sent to the model is capped. If it was cut, say so once — don't let the user
    // assume the model saw everything. Claude can still look things up; OpenAI (single-shot) cannot.
    if (aiSeedTruncated && !aiSeedWarned) {
      aiSeedWarned = true;
      const what = aiSeedOmitted.length ? aiSeedOmitted.join(' and ') : 'part of the index';
      aiMessages.push({ role: 'tool', content: `ℹ️ Large org: ${what} could not fit in the index sent with each message. `
        + (withTools ? 'Claude can still find them by name with its tools — the function list is always included in full.' : 'OpenAI answers in one pass and cannot look them up, so ask about specific functions by name.') });
      aiRenderMessages();
    }
    if (withTools) { await aiRunAnthropicAgent(cfg.anthropic, apiMessages, system, AI_TOOLS, cfg.maxIter || 20); }
    else { const reply = await aiCall(cfg, apiMessages, system); aiMessages.push({ role: 'assistant', content: reply || '(empty response)' }); }
    setStatus('', '');
  } catch (e) { aiMessages.push({ role: 'assistant', content: 'Error: ' + e.message }); setStatus('AI error', 'warn'); }
  aiBusy = false; $('aisend').disabled = false;
  aiRenderMessages();
}
async function aiEngineChrome() {
  const b = $('aiengbadge'), note = $('ainote');
  if (!b || !note) return;
  const cfg = await aiGetCfg();
  if (cfg.active === 'anthropic') {
    b.textContent = 'Claude \u00b7 agent'; b.className = 'agent';
    note.className = 'ainote';
  } else {
    b.textContent = 'OpenAI \u00b7 single-shot'; b.className = 'single';
    $('ainotetxt').innerHTML = 'OpenAI answers in <b>one pass</b>: it sees the org index plus the function you have open, '
      + 'and cannot go and read other files by itself \u2014 so it will ask you for what it is missing. '
      + 'Switch to Claude in Settings for an agent that explores the whole workspace on its own.';
    note.className = 'ainote show';
  }
}
// The index is sent with *every* message, so its size is what each question costs before it has been
// asked. Showing it is the only way the setting that caps it can be a real choice rather than a
// number in a form: build it once, measure, and say so.
async function aiContextLabel() {
  const el = $('aictx'); if (!el) return;
  const focus = (currentPath && currentPath.endsWith('.dg'))
    ? 'Focus: ' + currentPath.split('/').pop()
    : 'No function focused \u2014 open one to give code-level context';
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
  $('aiview').classList.add('show'); $('askai').classList.add('on'); document.body.classList.add('ai-open'); aiContextLabel(); aiEngineChrome(); aiRenderMessages();
}
function closeAI() { $('aiview').classList.remove('show'); $('askai').classList.remove('on'); document.body.classList.remove('ai-open'); }
function aiClear() { if (!aiMessages.length) return; if (!window.confirm('Clear this conversation? Only you can clear it \u2014 switching functions no longer resets it.')) return; aiMessages = []; aiRenderMessages(); }
// AI configuration lives in the options page now: the side panel is 400px wide and these are
// set-once fields. openSettings() focuses the one settings window; the panel picks the change up via
// chrome.storage.onChanged.
function aiOpenSettings() { openSettings(); }


// ---------- save-sync ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'saved') syncOne(msg.id);
  if (msg?.type === 'pullProgress' && pullActive) setStatus(`Pulling… ${msg.done}/${msg.total}`, 'busy');
});
async function syncOne(id) {
  if (!dir || !(await hasPerm(dir))) return;
  await refreshContext();
  if (!guardOk()) { setStatus(`Save ignored: active ${envOf(lastCtx?.origin)}/org ${lastCtx?.org} ≠ workspace ${envOf(bound?.base)}/org ${bound?.org}.`, 'warn'); return; }
  const info = index.get(String(id));
  try {
    setStatus(`Save detected (${id}), syncing…`, 'busy');
    const r = await toBridge({ cmd: 'fetchOne', id, category: info?.category, source: info?.source });
    if (!r?.ok || !r.file) throw new Error(r?.error || 'detail not found');
    const f = r.file;
    await writeFile(`${f.folder}/${f.stem}.dg`, f.dg); await writeFile(`${f.folder}/${f.stem}.meta.json`, JSON.stringify(f.meta, null, 2));
    graphCache = null;
    const ent = treeData.find((x) => x.id === String(id));
    if (ent) { ent.path = `${f.folder}/${f.stem}.dg`; ent.downloaded = true; ent.error = false; updateRow(ent); updateMissingButton(); } else { await rebuildTree(); }
    if (currentPath === `${f.folder}/${f.stem}.dg`) await openFile(currentPath);
    setStatus(`Synced: ${f.folder}/${f.stem}.dg`, 'ok');
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
const APP_DIRS = ['crm', 'analytics'];       // known product folders — not "foreign" content
let root = null, rootGranted = false;
// Resolved on demand rather than cached: the handle must stay valid across permission lapses.
async function appRoot(create) {
  if (!root) return null;
  try { return await root.getDirectoryHandle(APP_DIR, { create: !!create }); } catch (_) { return null; }
}
const wsFolderName = (ctx) => `${sanitize(ctx.instance || 'workspace')}${envOf(ctx.origin) === 'sandbox' ? '-sandbox' : ''}-${sanitize(ctx.org || 'org')}`;
async function readJsonIn(h, name) { const fh = await h.getFileHandle(name); return JSON.parse(await (await fh.getFile()).text()); }

function setEnabled(on) { ['pull', 'pullone', 'graph', 'refresh', 'export', 'exportmd', 'health', 'askai'].forEach((b) => ($(b).disabled = !on)); }

// Re-granting access to a folder we already know must NOT reopen the file picker: a lapsed
// permission is not a request to choose a different folder. This is one click, no OS dialog.
async function grantRoot() {
  if (!root) { await pickRoot(); return; }
  try {
    if (!(await ensurePerm(root))) { setStatus('Access denied \u2014 Zoost cannot read the working folder.', 'bad'); return; }
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
      if (APP_DIRS.includes(e.name)) continue;              // a product folder — this is our own layout
      try { await e.getFileHandle(CFG); } catch (_) { foreign++; }   // a workspace from the older flat layout
    }
    if (foreign > 6 && !confirm(`\u00ab${h.name}\u00bb already contains ${foreign} items that are not Zoost workspaces.\n\n`
      + `Zoost will hold read/write access to everything inside it, permanently. A dedicated folder is strongly recommended.\n\nUse this folder anyway?`)) return;
    root = h; rootGranted = true; await window.idbHandle.set('rootDir', h);
    setStatus(`Working folder: ${h.name}`, 'ok');
    await loadWorkspaces();
  } catch (e) { if (e?.name !== 'AbortError') setStatus('Working folder: ' + e.message, 'warn'); }
}

async function addWorkspaceForTab() {
  if (!root) { await pickRoot(); return; }
  if (!(await ensurePerm(root))) return;
  const ctx = lastCtx && lastCtx.org ? lastCtx : await getContext();
  if (!ctx || !ctx.org) { setStatus('Open a Zoho CRM tab first \u2014 the workspace is created for the org you are signed in to.', 'warn'); return; }
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
    setStatus(`Workspace ready: ${name} \u2014 Pull to fill it.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Add failed: ' + e.message, 'warn'); }
}

async function activate(w, viaGesture) {
  dir = w.handle; activeWsId = w.id; await window.idbHandle.set('activeWs', w.id); setEnabled(true);
  currentPath = null; pvHist = []; updateBack(); $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  bound = w.binding || null;                         // read from the workspace's own .zoost.json
  // Access verdicts belong to this workspace, so they are re-read here and the tab row rebuilt.
  // Carrying the previous org's answers over would hide a tab in an org that grants it — the same
  // class of mistake the environment guard exists to prevent, one field further in.
  await loadAccess(); renderTabs();
  const ok = viaGesture ? await ensurePerm(dir) : await hasPerm(dir);
  if (ok) await rebuildActive(); else { setStatus('Workspace found \u2014 click Refresh to grant access.', 'warn'); await refreshContext(); }
}

// In-memory only. `.zoost.json` is written when a workspace is created and on pull; rewriting
// it here would clobber fields this function does not carry (lastPull).
async function cacheBinding(b) {
  if (!b || !b.org) return;
  bound = { org: b.org, base: b.base, instance: b.instance };
  const w = (wsList || []).find((x) => x.id === activeWsId); if (w) w.binding = bound;
}

function updateWsButtons() {
  const add = $('wsadd'), rt = $('wsroot');
  const needsGrant = !!root && !rootGranted;
  rt.classList.toggle('needgrant', needsGrant);
  rt.textContent = !root ? '\u{1F4C1} Set working folder\u2026'
    : needsGrant ? `\u{1F513} Grant access to ${root.name}`
    : `\u{1F4C1} ${root.name}`;
  rt.title = !root ? 'Pick the folder that will contain all Zoost workspaces'
    : needsGrant ? 'Chrome dropped the file-system permission for this folder. One click restores it \u2014 no folder picker.'
    : `Working folder: ${root.name} \u2014 click to choose a different one`;
  // Absent when there is nothing to do, disabled only while it is *temporarily* unavailable.
  // A workspace already exists for this org and never will not: that is not a wait, it is a
  // permanent no, and a greyed button there reads as something broken. The other three reasons —
  // no working folder, no Zoho tab, no org on the tab — all clear on their own, so the button
  // stays visible and says what is missing.
  const known = (wsList || []).some((w) => lastCtx && w.binding && w.binding.org === lastCtx.org);
  add.hidden = known;
  add.disabled = !root || !lastCtx || !lastCtx.org;
  add.textContent = (lastCtx && lastCtx.instance) ? `+ ${lastCtx.instance}` : '+ Workspace';
  add.title = !root ? 'Set the working folder first'
    : !lastCtx ? 'Open a Zoho CRM tab first'
    : `Create a workspace folder for \u00ab${lastCtx.instance}\u00bb inside ${root.name}`;
}

async function loadWorkspaces() {
  if (!root) root = await window.idbHandle.get('rootDir');
  const sel = $('ws'); sel.innerHTML = '';
  wsList = [];
  if (!root) {
    sel.innerHTML = '<option value="">No working folder</option>';
    dir = null; setEnabled(false); updateWsButtons();
    setStatus('Pick a working folder to start \u2014 every workspace lives inside it.', 'warn');
    await refreshContext(); return;
  }
  rootGranted = await hasPerm(root);
  if (!rootGranted) {
    sel.innerHTML = `<option value="">${root.name} \u2014 access not granted</option>`;
    dir = null; setEnabled(false); updateWsButtons();
    setStatus('Click \u00abGrant access\u00bb above \u2014 one click, no folder picker.', 'warn');
    await refreshContext(); return;
  }
  const base = await appRoot(false);
  // The enumeration itself can fail — a handle whose permission lapsed, a folder moved or removed
  // since the browser stored it. Unguarded, that threw out of here and left the panel with no
  // workspace list and no explanation. A folder we cannot read is a state to report, not a crash.
  if (base) {
    try {
      for await (const e of base.values()) {
        if (e.kind !== 'directory' || e.name.startsWith('.')) continue;
        let cfg = null; try { cfg = await readJsonIn(e, CFG); } catch (_) { continue; }   // not one of ours
        if (!cfg || !cfg.org) continue;
        wsList.push({ id: 'org:' + cfg.org, name: e.name, handle: e, binding: { org: cfg.org, base: cfg.base, instance: cfg.instance } });
      }
    } catch (e) {
      rootGranted = false;
      setStatus(`Could not read \u00ab${root ? root.name : '?'}/${APP_DIR}\u00bb: ${e.message || e}. Click the folder button to grant access again.`, 'warn');
    }
  }
  wsList.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
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
    sel.innerHTML = `<option value="">${root.name}/${APP_DIR} \u2014 no workspaces yet</option>`;
    dir = null; setEnabled(false); updateWsButtons();
    setStatus(stray
      ? `${stray} workspace folder(s) sit directly in \u00ab${root.name}\u00bb. Each Zoost product now keeps its own \u2014 move them into \u00ab${root.name}/${APP_DIR}/\u00bb and click Refresh.`
      : 'Open your Zoho CRM tab, then click + to create its workspace.', 'warn');
    await refreshContext(); return;
  }
  const active = await window.idbHandle.get('activeWs');
  wsList.forEach((w) => { const o = document.createElement('option'); o.value = w.id; o.textContent = w.name; sel.appendChild(o); });
  const act = wsList.find((w) => w.id === active) || wsList[0];
  sel.value = act.id; activeWsId = act.id; updateWsButtons();
  await activate(act, false);
}

$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
// A lapsed permission only needs user activation, not a dedicated click. Piggyback on the first
// click the user makes on a working surface, so in practice the amber button is never needed.
document.addEventListener('click', async (e) => {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('#pfoot') || t.closest('.dlg') || t.closest('#aiview'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await loadWorkspaces(); } } catch (_) {}
}, true);
$('wsadd').onclick = () => addWorkspaceForTab();
$('ws').onchange = async () => { const w = wsList.find((x) => x.id === $('ws').value); if (w) await activate(w, true); };
$('wsdel').onclick = async () => {
  const w = wsList.find((x) => x.id === $('ws').value); if (!w || !root) return;
  if (!confirm(`Delete the folder \u00ab${w.name}\u00bb and everything in it?\n\nThis removes the local mirror only \u2014 nothing in Zoho CRM is touched. You can pull it again at any time.`)) return;
  try {
    if (!(await ensurePerm(root))) return;
      const base = await appRoot(false);
      if (!base) { setStatus('Could not open the workspace folder.', 'warn'); return; }
      await base.removeEntry(w.name, { recursive: true });   // delete inside crm/, never at the root
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
  if (mode !== 'functions' && searchMode === 'content') { searchMode = 'name'; $('smode').textContent = 'in: names'; $('smode').classList.remove('on'); $('find').placeholder = 'Find by name\u2026'; }
  $('smode').style.display = mode === 'functions' ? '' : 'none';
  $('modebar').querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
  const _typeLabel = tabLabel(mode).toLowerCase();
  $('pullone').textContent = 'Pull';   // local: pulls only the current type; the type is given by the active mode segment above
  $('pullone').title = `Pull only ${_typeLabel} into the local mirror — “Pull all” pulls every type`;
  buildTypeChips();
  $('funcs').style.display = mode === 'functions' ? '' : 'none';
  $('graph').style.display = (mode === 'functions' || mode === 'modules') ? '' : 'none';
  $('nameToggle').style.display = (mode === 'functions' || mode === 'modules') ? '' : 'none';
  $('graph').textContent = mode === 'functions' ? 'Graph \u2197' : 'Schema \u2197';
  $('nameToggle').textContent = 'Name: ' + (mode === 'functions' ? nameMode : moduleNameMode);
  currentPath = null; pvHist = []; updateBack(); $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  rebuildActive();
}
// Rebuild the segment row from the registry. Called whenever the set can have changed: at start-up,
// when the settings page saves, and after a pull has learned what the org's roles allow.
//
// If the active tab is no longer among the visible ones — the user just hid it, or a pull discovered
// it is refused — the panel moves to the first that is left, rather than showing an empty view whose
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
    || '<span class="segnone">Every tab is hidden — turn one back on in Settings.</span>';
  bar.querySelectorAll('.seg').forEach((b) => (b.onclick = () => setMode(b.dataset.tab)));
  if (vis.length && !vis.includes(viewMode)) setMode(vis[0]);
}
async function rebuildActive() { return viewMode === 'functions' ? rebuildTree() : viewMode === 'modules' ? rebuildModules() : viewMode === 'workflows' ? rebuildWorkflows() : viewMode === 'schedules' ? rebuildSchedules() : rebuildConnections(); }
// While a pull runs, BOTH pull buttons (global "Pull all" and the per-type "Pull \u2026") stay disabled,
// so switching tabs and clicking a second pull cannot start an overlapping one. They come back only
// when the current pull has finished \u2014 success or error.
function setPullBusy(b) {
  pullBusy = b;
  $('pullone').disabled = b;
  $('pull').disabled = b || !zohoReady() || !dir;
}
async function pullCurrent() {
  if (pullBusy) return;
  const label = { functions: 'functions', modules: 'modules', workflows: 'workflows', schedules: 'schedules', connections: 'connections' }[viewMode] || 'functions';
  setPullBusy(true); setStatus('Pulling ' + label + '\u2026', 'busy');   // immediate feedback (underlying pull sets its own progress next)
  try {
    if (viewMode === 'modules') await pullModules();
    else if (viewMode === 'workflows') await pullWorkflows();
    else if (viewMode === 'schedules') await pullSchedules();
    else if (viewMode === 'connections') await pullConnections();
    else await pullAll();
    if ($('status').className === 'busy') { try { await rebuildActive(); } catch (_) { setStatus('Pull complete.', 'ok'); } }
  } catch (e) { setStatus('Pull error: ' + e.message, 'bad'); }
  finally { setPullBusy(false); }
}
// "Pull all" means every area this user can actually reach. An area Zoho refused last time is
// skipped rather than re-tried on every pull: re-asking a question already answered turns each pull
// into a list of failures nobody can act on. It is not written off either — Settings has "Check
// again" for exactly that, because a role can change and this verdict carries the date it was given.
//
// A hidden-by-choice area is still pulled. Hiding is about the panel being crowded, not about the
// mirror being incomplete: the export and the AI index read from disk, and quietly leaving a type
// out of them because a tab was tidied away would be a mirror that lies by omission.
async function pullEverything() {
  if (pullBusy) return;
  setPullBusy(true);
  const runners = { functions: pullAll, modules: pullModules, workflows: pullWorkflows, schedules: pullSchedules, connections: pullConnections };
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
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    const ctx = await getContext(); if (!ctx) throw new Error('No Zoho CRM tab open.');
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
        const lf = `_layouts/${sanitize(m.api_name || 'unknown')}.json`;
        try { await writeFile(lf, JSON.stringify(fullLayouts, null, 2)); liveLayoutFiles.add(lf); lw++; } catch (_) {}
      }
      // keep a compact summary inside the module JSON (drives the preview line + index)
      m.layouts = fullLayouts.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false, status: l.status || null, sections: (l.sections || []).length }));
      index.push({ api_name: m.api_name, module_name: m.module_name, generated_type: m.generated_type, fields: (m.fields || []).length, layouts: m.layouts.length, related_lists: (m.related_lists || []).length });
      layIndex.push({ module: m.api_name, generated: m.module_name, layouts: m.layouts });
      try { await writeFile(`_modules/${sanitize(m.api_name || 'unknown')}.json`, JSON.stringify(m, null, 2)); mw++; } catch (_) {}
    }
    await writeFile('_modules/_index.json', JSON.stringify(index, null, 2));
    await writeFile('_layouts/_index.json', JSON.stringify(layIndex, null, 2));
    const liveFiles = new Set(r.modules.map((m) => `_modules/${sanitize(m.api_name || 'unknown')}.json`));
    let prunedM = 0;
    for await (const p of walk(dir)) { if (p.startsWith('_modules/') && p.endsWith('.json') && !p.endsWith('_index.json') && !liveFiles.has(p)) { try { await removeFile(p); prunedM++; } catch (_) {} } }
    for await (const p of walk(dir)) { if (p.startsWith('_layouts/') && p.endsWith('.json') && !p.endsWith('_index.json') && !liveLayoutFiles.has(p)) { try { await removeFile(p); } catch (_) {} } }
    await rebuildModules();
    setStatus(`Modules pull complete: ${mw}/${r.modules.length} modules, ${lw} layout sets${prunedM ? `, ${prunedM} removed` : ''}.`, 'ok');
    await noteAccess('modules', null);
  } catch (e) { await noteAccess('modules', e); setStatus(pullFailMessage('modules', e), 'bad'); } finally { pullActive = false; }
}

// ---------- modules: tree ----------
async function rebuildModules() {
  if (!dir) return;
  if (!(await ensurePerm(dir))) { setStatus('Folder access needs re-granting — click Refresh.', 'warn'); return; }
  setStatus('Loading modules…', 'busy'); const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
  const names = [];
  for await (const p of walk(dir)) if (p.startsWith('_modules/') && p.endsWith('.json') && !p.endsWith('_index.json')) names.push(p);
  names.sort();
  moduleData = [];
  for (const p of names) {
    try {
      const m = JSON.parse(await readFile(p));
      moduleData.push({ path: p, api_name: m.api_name, gen: m.module_name || m.api_name, label: m.plural_label || m.singular_label || m.module_name || m.api_name, custom: m.generated_type === 'custom', generated_type: m.generated_type || '', fieldCount: (m.fields || []).length, lookupCount: (m.fields || []).filter((f) => f.lookup).length, layoutCount: (m.layouts || []).length, layouts: (m.layouts || []), viewable: (m.viewable !== false && m.visible !== false), navigable: moduleNavigable(m) });
    } catch (_) {}
  }
  renderModules();
  setStatus(moduleData.length ? `${moduleData.length} modules in workspace.` : 'No modules yet — click Pull.', moduleData.length ? 'ok' : 'warn');
  await refreshContext();
}
function renderModules() {
  if (viewMode !== 'modules') return;
  const term = $('find').value.trim().toLowerCase();
  const relsHtmlFor = (m) => {
    const rl = scope.relations ? (m.related_lists || []) : []; if (!rl.length) return '';
    return `<div style="font-weight:700;margin:12px 0 4px;color:#d97706">Related lists (${rl.length}) <span class="none" style="font-weight:400">\u2014 API name for zoho.crm.getRelatedRecords()</span></div>`
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
  if (!groups.Standard.length && !groups.Custom.length) { tree.innerHTML = '<div class="treemsg">' + (moduleData.length ? 'No modules match.' : 'No modules yet — click Pull.') + '</div>'; return; }
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
      const chev = multi ? `<span class="laychev" title="Show / hide layouts">${exp ? '\u25be' : '\u25b8'}</span>` : '';
      const stTitle = m.error ? 'Failed \u2014 click to retry' : 'In workspace \u2014 click to resync fields from Zoho';
      el.innerHTML = `<span class="st ${m.error ? 'st-err' : 'st-ok'}" title="${stTitle}">${m.error ? '\u27f3' : '\u25cf'}</span><span class="fname">${escHtml(nm(m))}</span>`
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
  if (!(await ensurePerm(dir))) { setStatus('Folder access denied — click Refresh.', 'bad'); return; }
  if (!guardOk()) { setStatus('Active Zoho tab does not match this workspace.', 'warn'); return; }
  setStatus(`Resyncing ${m.api_name}…`, 'busy');
  const r = await toBridge({ cmd: 'fetchModuleFields', apiName: m.api_name });
  if (!r?.ok) { m.error = true; renderModules(); setStatus(`Resync of ${m.api_name} failed.`, 'warn'); return; }
  let mod = {}; try { mod = JSON.parse(await readFile(m.path)); } catch (_) {}
  mod.fields = r.fields; try { await writeFile(m.path, JSON.stringify(mod, null, 2)); } catch (_) {}
  m.fieldCount = r.fields.length; m.lookupCount = r.fields.filter((f) => f.lookup).length; m.error = false;
  graphCache = null;
  renderModules(); if (currentPath === m.path) openModule(m.path);
  setStatus(`Resynced ${m.api_name} (${m.fieldCount} fields).`, 'ok');
}
function renderFieldsTable(m) {
  const rows = (m.fields || []).map((f) => `<tr>
    <td>${escHtml(f.label || f.api_name)}${f.custom ? ' <span style="color:#a78bfa">*</span>' : ''}</td>
    <td class="mono">${escHtml(f.api_name)}</td>
    <td>${escHtml(f.data_type || '')}${f.length ? ` (${f.length})` : ''}</td>
    <td style="text-align:center">${f.mandatory ? '\u25cf' : ''}</td>
    <td class="mono">${f.lookup ? '\u2192 ' + escHtml(typeof f.lookup === 'string' ? f.lookup : (f.lookup.api_name || (f.lookup.module && (f.lookup.module.api_name || f.lookup.module)) || '')) : ''}</td>
    <td>${f.picklist && f.picklist.length ? escHtml(f.picklist.slice(0, 8).join(', ')) + (f.picklist.length > 8 ? ` \u2026(+${f.picklist.length - 8})` : '') : ''}</td>
  </tr>`).join('');
  return `<table class="ftbl"><thead><tr><th>Field</th><th>API name</th><th>Type</th><th>Req</th><th>Lookup</th><th>Picklist</th></tr></thead><tbody>${rows}</tbody></table>`;
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
  if (!(await ensurePerm(dir))) { setStatus('File access denied — click Refresh.', 'bad'); return; }
  currentPath = path; pvHist = []; updateBack(); if ($('status').className) setStatus('', '');
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
  let m; try { m = JSON.parse(await readFile(path)); } catch (e) { setStatus('Read failed: ' + e.message, 'bad'); return; }
  const nav = moduleNavigable(m);
  $('pvname').textContent = `${m.plural_label || m.singular_label || m.module_name || m.api_name} \u00b7 ${m.api_name} \u00b7 ${(m.fields || []).length} fields${nav ? '' : ' \u00b7 no records tab'}`;
  $('pvreveal').style.display = nav ? '' : 'none'; $('pvreveal').textContent = 'Records \u2197'; $('pvreveal').title = 'Open the module\u2019s records list in Zoho';
  $('pvfind').style.display = nav ? '' : 'none'; $('pvfind').textContent = 'Layouts \u2197'; $('pvfind').title = 'Open the module\u2019s layouts (add/edit fields & layout) in Zoho';
  $('pvcallers').className = ''; $('pvcallers').textContent = '';
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
      + lays.map((l) => `<option value="${escHtml(String(l.id))}">${escHtml(l.name || l.id)}${l.visible === false ? ' \u00b7 hidden' : ''}${l.sections ? ` \u00b7 ${l.sections} sections` : ''}</option>`).join('')
      + `</select> <button id="laymod" class="laymod" title="Open the selected layout in the Zoho layout editor">Modify \u2197</button></div>`
    : '';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  const relBar = `<div class="laybar">Relations from this module \u00b7 depth <select id="reldepth"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select><button id="relopen" class="laylocal">Open ER \u2197</button></div>`;
  const rls = m.related_lists || [];
  const rlBlock = rls.length
    ? `<div class="secttl">Related lists (${rls.length}) <span style="color:var(--muted);font-weight:400">\u2014 API name for zoho.crm.getRelatedRecords(); click to copy</span></div>`
      + `<table class="ftbl"><thead><tr><th>API name</th><th>Label</th><th>Target module</th><th>Type</th></tr></thead><tbody>`
      + rls.map((r) => `<tr><td class="mono rlcopy" data-c="${escHtml(r.api_name)}" title="Click to copy">${escHtml(r.api_name)}</td>`
        + `<td>${escHtml(r.label || '')}</td>`
        + `<td class="mono">${escHtml(r.module || r.connected_module || '')}${r.linking_module ? ` <span style="color:var(--muted)">via ${escHtml(r.linking_module)}</span>` : ''}</td>`
        + `<td>${escHtml(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td></tr>`).join('')
      + `</tbody></table>`
    : `<div class="secttl">Related lists</div><div style="padding:8px 10px;color:var(--muted)">None recorded \u2014 re-run <b>Pull Modules</b> to fetch them.</div>`;
  $('pvtable').innerHTML = namesBlock + relBar + selector + `<div id="laybody">${renderFieldsTable(m)}</div>` + rlBlock;
  $('pvtable').querySelectorAll('.rlcopy').forEach((c) => (c.onclick = () => {
    navigator.clipboard.writeText(c.dataset.c).then(() => setStatus(`Copied \u00ab${c.dataset.c}\u00bb`, 'ok')).catch(() => {});
  }));
  const relOpen = document.getElementById('relopen');
  if (relOpen) relOpen.onclick = () => openSchemaFocus(m.api_name, parseInt(document.getElementById('reldepth').value, 10) || 2);
  const sel = document.getElementById('laysel');
  if (sel) sel.onchange = async () => {
    const body = document.getElementById('laybody'); const v = sel.value;
    if (v === '__all__') { body.innerHTML = renderFieldsTable(m); return; }
    body.innerHTML = '<div style="padding:10px;color:var(--muted)">Loading layout\u2026</div>';
    let full = []; try { full = JSON.parse(await readFile(`_layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
    const L = (full || []).find((x) => String(x.id) === String(v));
    body.innerHTML = L ? renderLayoutView(L) : '<div style="padding:10px;color:var(--muted)">Layout detail not found \u2014 re-pull modules.</div>';
  };
  const mod = document.getElementById('laymod');
  if (mod) mod.onclick = () => { const v = sel ? sel.value : '__all__'; openModuleLayoutEdit(m.module_name || m.api_name, v === '__all__' ? null : v); };
  if (layoutId && sel) { sel.value = String(layoutId); if (sel.value === String(layoutId)) await sel.onchange(); }
  $('preview').classList.add('show'); $('resizer').classList.add('show'); resetPreviewScroll();
}

// ---------- modules: schema graph (modules as nodes, lookups as edges) + function bridge ----------
async function buildSchemaGraph(focusApi, depth) {
  // modules
  const modPaths = [];
  for await (const p of walk(dir)) if (p.startsWith('_modules/') && p.endsWith('.json') && !p.endsWith('_index.json')) modPaths.push(p);
  const mods = [];
  for (const p of modPaths) { try { const m = JSON.parse(await readFile(p)); m._path = p; mods.push(m); } catch (_) {} }
  // Field -> layout membership. The module JSON only carries a layout summary; the full
  // sections/fields structure lives in _layouts/<Module>.json (written by Pull Modules).
  for (const m of mods) {
    let full = [];
    try { full = JSON.parse(await readFile(`_layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
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
  Object.values(nodes).forEach((n) => { n.calls = [...new Set(n.calls)]; n.called_by = [...new Set(n.called_by)]; n.dead_suspect = n.called_by.length === 0; });
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
async function openSchemaFocus(apiName, depth) {
  try {
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    setStatus(`Building relations graph for ${apiName}\u2026`, 'busy');
    const g = await buildSchemaGraph();   // full graph; the ER window filters by focus + depth client-side (adjustable there)
    if (!g.counts.nodes) throw new Error('No modules pulled yet \u2014 pull in Modules mode.');
    if (!g.nodes[apiName]) throw new Error(`Module ${apiName} not found in the schema.`);
    g.focus = apiName; g.depth = Math.max(1, depth || 2);
    await chrome.storage.local.set({ graphData: g });
    await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html'), type: 'normal', width: 1240, height: 840 });
    setStatus(`Relations of ${apiName} (depth ${g.depth}): ${g.counts.nodes} modules, ${g.counts.edges} lookups.`, 'ok');
  } catch (e) { setStatus('Relations graph error: ' + e.message, 'bad'); }
}
async function openSchemaGraph() {
  try {
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    setStatus('Building schema graph…', 'busy'); await refreshContext();
    const g = await buildSchemaGraph();
    if (!g.counts.nodes) throw new Error('No modules pulled yet — click Pull in Modules mode.');
    await chrome.storage.local.set({ graphData: g });
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
  if (!dir) return false;
  if (!(await ensurePerm(dir))) { setStatus('Folder access denied — click Refresh.', 'bad'); return false; }
  const info = index.get(entry.id) || {};
  try {
    const r = await toBridge({ cmd: 'fetchOne', id: entry.id, category: entry.category || info.category, source: entry.source || info.source });
    if (!r?.ok || !r.file) throw new Error(r?.error || 'not found');
    const f = r.file;
    await writeFile(`${f.folder}/${f.stem}.dg`, f.dg);
    await writeFile(`${f.folder}/${f.stem}.meta.json`, JSON.stringify(f.meta, null, 2));
    entry.path = `${f.folder}/${f.stem}.dg`; entry.namespace = f.folder;
    entry.display_name = f.meta.display_name || entry.display_name; entry.downloaded = true; entry.stale = false; entry.error = false; entry.errorMsg = '';
    index.set(entry.id, { path: entry.path, category: f.meta.category, source: f.meta.source, name: f.meta.name, rest: (f.meta.rest_api || []).some((x) => x.active) });
    graphCache = null; codeCache = null;
    return true;
  } catch (e) { entry.error = true; entry.downloaded = false; entry.errorMsg = errText(e); return false; }
}
async function downloadMissing() {
  const pending = treeData.filter((e) => !e.downloaded || e.stale);   // stale = older schema (before connections/author); re-fetch to backfill
  if (!pending.length) { setStatus('All functions downloaded.', 'ok'); updateMissingButton(); return; }
  $('pull').disabled = true; $('missing').disabled = true;
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
  setStatus(fail ? `Downloaded ${ok}, ${fail} still missing \u2014 use \u201cComplete missing\u201d.` : `All ${ok} functions downloaded.`, fail ? 'warn' : 'ok');
  $('pull').disabled = false; $('missing').disabled = false;
}
function updateRow(e) {
  const row = document.querySelector(`.f[data-id="${(window.CSS && CSS.escape) ? CSS.escape(e.id) : e.id}"]`); if (!row) return;
  row.dataset.path = e.path;
  const st = row.querySelector('.st'); if (!st) return;
  const ok = e.downloaded || e.scanned;
  st.className = 'st ' + (e.error ? 'st-err' : ok ? 'st-ok' : 'st-no');
  st.textContent = e.error ? '\u27f3' : ok ? '\u25cf' : '\u25cb';
  st.title = e.error ? ('Failed: ' + (e.errorMsg || 'unknown') + ' \u2014 click to retry') : ok ? 'In workspace \u2014 click to refresh' : 'Not in workspace \u2014 click to download';
}
function updateMissingButton() {
  const b = $('missing'); if (!b) return;
  if (viewMode === 'modules' || viewMode === 'schedules' || viewMode === 'connections') { b.style.display = 'none'; return; }
  const arr = viewMode === 'workflows' ? workflowData : treeData;
  const miss = arr.filter((e) => !e.downloaded).length;
  const stale = viewMode === 'functions' ? treeData.filter((e) => e.downloaded && e.stale).length : 0;
  const n = miss + stale;
  b.style.display = n > 0 ? '' : 'none';
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
// four months old is the misleading half-truth this whole thread is about — so every report states
// when each part was last read, whether or not anything is behind. The reader gets the fact; nobody
// here decides for them what it means.
function freshnessLine() {
  const parts = TABS.map((t) => {
    const behind = areaStale(t.id) ? ' (behind)' : '';
    return `${tabLabel(t.id)} ${areaAsOf(t.id)}${behind}`;
  });
  return parts.join(' \u00b7 ');
}

function buildExportHtml(fns, mods, g, modRefs, wfs, scheds, conns, scope) {
  scope = Object.assign({}, SCOPE_FULL, scope || {});
  if (!scope.functions) fns = [];
  if (!scope.modules) mods = [];
  wfs = scope.workflows ? (wfs || []) : []; scheds = scope.schedules ? (scheds || []) : [];
  conns = scope.connections ? (conns || []) : [];
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
  const wfFnActions = (w) => { const acts = []; ((w.detail && w.detail.conditions) || []).forEach((c) => ['instant_actions', 'scheduled_actions'].forEach((bk) => { const b = c[bk]; if (b && b.actions) b.actions.forEach((a) => { if (a.type === 'functions') acts.push(a); }); })); return acts; };
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
    byNs[ns].sort((a, b) => (a.api_name || '').localeCompare(b.api_name || '')).forEach((f) => {
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
        + ((scope.connections && (f.connections || []).length) ? `<span><b>Connections (${f.connections.length}):</b> ${f.connections.map((c) => (c.name && connApiSet.has(c.name)) ? `<a href="#${connAnchor(c.name)}">${esc(c.name)}</a>` : esc(c.name)).join(', ')}</span>` : '')
        + (f.stats ? `<span><b>Size:</b> ${f.stats.lines} lines (${f.stats.codeLines} code) · ${(f.stats.chars / 1024).toFixed(1)} KB · <b>outbound calls:</b> ${f.stats.apiCalls || 'none'}${f.stats.apiCalls ? ` (${f.stats.invokeurl} invokeurl, ${f.stats.crm} zoho.crm, ${f.stats.zoho} other${f.stats.sendmail ? ', ' + f.stats.sendmail + ' sendmail' : ''})` : ''}</span>` : '')
        + ((f.modified_by || f.updatedTime) ? `<span><b>Modified:</b> ${f.modified_by ? 'by ' + esc(f.modified_by) : ''}${f.updatedTime ? ' · ' + esc(String(f.updatedTime).slice(0, 16)) : ''}</span>` : '')
        + `</div>` : '';
      fnHtml += `<section class="item" id="${fnAnchor(f.api_name)}" data-name="${esc(((f.api_name || '') + ' ' + (f.display_name || '')).toLowerCase())}">`
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
    return `<div style="font-weight:700;margin:12px 0 4px;color:#d97706">Related lists (${rl.length}) <span class="none" style="font-weight:400">\u2014 API name for zoho.crm.getRelatedRecords()</span></div>`
      + `<table class="ftbl"><thead><tr><th>Relation API</th><th>Label</th><th>Returns</th><th>Type</th></tr></thead><tbody>`
      + rl.map((r) => `<tr><td class="mono"><b>${esc(r.api_name)}</b></td><td>${esc(r.label || '')}</td><td class="mono">${r.module ? modLink(r.module) : esc(r.connected_module || '')}${r.linking_module ? ` <span class="none">via ${esc(r.linking_module)}</span>` : ''}</td><td>${esc(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td></tr>`).join('')
      + `</tbody></table>`;
  };
  const groups = { Standard: [], Custom: [] }; mods.forEach((m) => (m.generated_type === 'custom' ? groups.Custom : groups.Standard).push(m));
  let modHtml = '';
  for (const g2 of ['Standard', 'Custom']) {
    const list = groups[g2]; if (!list.length) continue;
    modHtml += `<h3 class="grp">${g2} <span class="cnt">${list.length}</span></h3>`;
    list.sort((a, b) => (a.api_name || '').localeCompare(b.api_name || '')).forEach((m) => {
      const rows = (m.fields || []).map((fl) => `<tr><td>${esc(fl.label || fl.api_name)}</td><td class="mono">${esc(fl.api_name)}</td><td>${esc(fl.data_type || '')}${fl.length ? ` (${fl.length})` : ''}</td><td style="text-align:center">${fl.mandatory ? '●' : ''}</td><td class="mono">${fl.lookup ? '→ ' + modLink(fl.lookup) : ''}</td><td>${(fl.picklist || []).slice(0, 12).map(esc).join(', ')}</td></tr>`).join('');
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
        return `<details open style="margin-top:6px"><summary style="cursor:pointer"><b>${esc(L.name || String(L.id))}</b>${L.visible === false ? ' <span class=\"none\">(hidden)</span>' : ''} <span class=\"none\">\u00b7 ${secCount} sections</span></summary>${secs || '<div class=\"none\" style=\"padding:4px 0\">Section detail not in this export \u2014 re-pull modules for full layout fields.</div>'}</details>`;
      }).join('') : '';
      modHtml += `<section class="item" id="${modAnchor(m.api_name)}" data-name="${esc(((m.api_name || '') + ' ' + (m.plural_label || m.module_name || '')).toLowerCase())}">`
        + `<div class="ih"><b>${esc(m.plural_label || m.singular_label || m.module_name || m.api_name)}</b> <code>${esc(m.api_name)}</code> <span class="gen">${esc(m.module_name || '')}</span>${laySrc.length ? ` <span class="none">\u00b7 ${laySrc.length} layout(s)</span>` : ''}</div>`
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
  const relRowHtml = (r) => `<tr class="relrow${r.sys ? ' sys' : ''}" data-name="${esc(((r.api || '') + ' ' + (r.label || '') + ' ' + (r.parent || '') + ' ' + (r.child || '')).toLowerCase())}">`
    + `<td class="mono"><b>${esc(r.api)}</b></td><td>${esc(r.label)}</td>`
    + `<td class="mono">${modLink(r.parent)}</td><td class="mono">${r.child ? modLink(r.child) : ''}</td>`
    + `<td class="mono">${esc(r.via || '')}</td><td class="ct">${esc(r.type)}${r.visible ? '' : ' \u00b7 hidden'}</td>`
    + `<td class="mono">zoho.crm.getRelatedRecords("${esc(r.api)}", "${esc(r.parent)}", recordId)</td></tr>`;
  const relHtml = allRels.length
    ? `<p class="hxd">One row per relation. To read a related list in Deluge you need the <b>relation API name</b> \u2014 it is not the api_name of either module.</p>`
      + `<table class="ftbl"><thead><tr><th>Relation API name</th><th>Label</th><th>On module</th><th>Returns</th><th>Via</th><th>Type</th><th>Deluge</th></tr></thead><tbody>${allRels.map(relRowHtml).join('')}</tbody></table>`
    : '<p class="empty">No related lists in this export \u2014 re-run Pull Modules.</p>';

  // workflows grouped by trigger module
  const wfByMod = {}; wfs.forEach((w) => (wfByMod[w.module || '(no module)'] ||= []).push(w));
  // rich workflow rendering (mirrors the panel detail)
  const wfValOf = (g) => { const v = g.value; if (g.type === 'field' && v && v.api_name) return v.api_name; if (v === '${EMPTY}' || v === '${empty}') return 'empty'; return v == null ? '' : String(v); };
  const wfOne = (g) => `${(g.field && g.field.api_name) || '?'} ${g.comparator || ''} ${wfValOf(g)}`;
  const wfCrit = (crit) => { if (!crit) return ''; if (crit.group && crit.group.length) { const op = crit.group_operator || 'AND'; return crit.group.map((g) => (g.group ? '(' + wfCrit(g) + ')' : wfOne(g))).join(` ${op} `); } if (crit.comparator) return wfOne(crit); return ''; };
  const wfTiming = (bk) => { const ea = bk.execute_after; return (ea && ea.unit != null) ? `after ${ea.unit} ${ea.period || ''}`.trim() : ''; };
  const wfActionHtml = (a) => { if (a.type === 'functions') { const fn = resolveFn(a); return fn ? `<a href="#${fnAnchor(fn.api_name)}">\u0192 ${esc(fn.display_name || fn.api_name)}</a>` : `<span class="none">\u0192 ${esc(a.name)}</span>`; } return `<span class="wfact-x">${esc(a.type)}: ${esc(a.name)}</span>`; };
  let wfHtml = '';
  Object.keys(wfByMod).sort().forEach((mod) => {
    wfHtml += `<h3 class="grp">${esc(mod)} <span class="cnt">${wfByMod[mod].length}</span></h3>`;
    wfByMod[mod].slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach((w) => {
      const d = w.detail;
      const modl = mods.some((m) => m.api_name === w.module) ? `<a href="#${modAnchor(w.module)}">${esc(w.module)}</a>` : esc(w.module || '');
      const head = `<section class="item" id="${wfAnchor(w.id)}" data-name="${esc(((w.name || '') + ' ' + (w.module || '')).toLowerCase())}">`
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
  Object.keys(wfByMod).sort().forEach((mod) => wfByMod[mod].slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach((w) => {
    wfRows.push(`<tr><td><a href="#${wfAnchor(w.id)}">${esc(w.name)}</a></td><td class="mono">${esc(w.module || '')}</td><td class="ct">${esc(w.type || '')}</td><td class="ct">${w.active ? '\u25cf' : ''}</td><td class="ct">${wfFnActions(w).length}</td></tr>`);
  }));

  // schedules
  let schHtml = '';
  scheds.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach((sc) => {
    const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()];
    const fl = fn ? `<a href="#${fnAnchor(fn.api_name)}">${esc(fn.display_name || fn.api_name)}</a>` : `<span class="none">${esc(sc.function_name || '?')}</span>`;
    schHtml += `<section class="item" id="${schAnchor(sc.id)}" data-name="${esc(((sc.name || '') + ' ' + (sc.function_name || '')).toLowerCase())}">`
      + `<div class="ih"><b>${esc(sc.name)}</b> <code>${esc(sc.frequency || '')}</code>${sc.status !== 'active' ? `<span class="badge no">${esc(sc.status || '')}</span>` : ''}</div>`
      + `<div class="refs"><span><b>Runs function:</b> ${fl}</span>${sc.next ? `<span><b>Next:</b> ${esc(sc.next)}</span>` : ''}</div></section>`;
  });
  const schRows = scheds.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((sc) => {
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
  wfs.forEach((w) => { if (!w.detail) return; (w.detail.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter((a) => a.type === 'functions').forEach((a) => { if (!(hById[String(a.id)] || hByAny[(a.name || '').toLowerCase()])) hBroken.push({ kind: 'workflow', id: w.id, name: w.name, fn: a.name }); }); }); });
  scheds.forEach((sc) => { if (!(hById[String(sc.function_id)] || hByAny[(sc.function_name || '').toLowerCase()])) hBroken.push({ kind: 'schedule', id: sc.id, name: sc.name, fn: sc.function_name }); });
  const hModSet = new Set(mods.map((m) => m.api_name));
  const hFK = [];
  mods.forEach((m) => { if (/__s$/.test(m.api_name || '')) return; (m.fields || []).forEach((fl) => { let t = fl.lookup; if (t && typeof t === 'object') t = t.api_name || (t.module && (t.module.api_name || t.module)) || null; if (!t || typeof t !== 'string') return; if (/__s$/.test(t)) return; if (!hModSet.has(t)) hFK.push({ module: m.api_name, field: fl.api_name || fl.label, target: t }); }); });
  const hSec = (title, count, desc, rows, bad) => `<div class="hxsec"><h3>${esc(title)} <span class="hxn ${count ? (bad ? 'bad' : 'warn') : 'ok'}">${count}</span></h3>${desc ? `<p class="hxd">${desc}</p>` : ''}${count ? rows : '<p class="hxnone">None</p>'}</div>`;
  const healthHtml =
    `<div class="hxcov"><b>Coverage.</b> Analyzed: function\u2192function calls, workflows, schedules, and each function's <i>associated_place</i> (blueprint, button, \u2026). <b>Not</b> analyzed: custom client scripts, approval/assignment/scoring rules. Items are <b>candidates to review</b>, never automatic deletions.</div>`
    + hSec('Orphan candidates', hOrph.length, 'No caller in code, not REST, no associated_place.', hOrph.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.namespace || '')}</span></div>`).join(''))
    + hSec('Unresolved calls', hUnres.length, 'Calls a function that does not resolve in this workspace.', hUnres.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.unresolved.join(', '))}</span></div>`).join(''), true)
    + hSec('Ambiguous calls', hAmbig.length, 'A call matches more than one function.', hAmbig.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.ambiguous.join(', '))}</span></div>`).join(''))
    + hSec('Broken automations', hBroken.length, 'A workflow/schedule references a function not in this workspace.', hBroken.map((b) => `<div class="hxrow">${esc(b.kind)} <a href="#${b.kind === 'workflow' ? wfAnchor(b.id) : schAnchor(b.id)}">${esc(b.name || '?')}</a> <span class="hxm">\u2192 missing \u00ab${esc(b.fn || '?')}\u00bb</span></div>`).join(''), true)
    + hSec('Missing module references', hFK.length, 'A lookup points to a module not in this workspace.', hFK.map((r) => `<div class="hxrow"><b>${esc(r.module)}</b>.${esc(r.field)} <span class="hxm">\u2192 ${esc(r.target)}</span></div>`).join(''))
    + hSec('Largest functions', hBig.length, 'By line count, longest first. Length is verbosity, not complexity \u2014 a long function is worth a look, not necessarily a problem.', hBig.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${n.stats.lines} lines \u00b7 ${n.stats.codeLines} code \u00b7 ${(n.stats.chars / 1024).toFixed(1)} KB</span></div>`).join(''))
    + hSec('Most outbound calls', hChatty.length, 'invokeurl, zoho.crm and other Zoho service tasks, counted outside comments and strings.', hChatty.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${n.stats.apiCalls} calls \u2014 ${n.stats.invokeurl} invokeurl \u00b7 ${n.stats.crm} zoho.crm \u00b7 ${n.stats.zoho} other${n.stats.sendmail ? ' \u00b7 ' + n.stats.sendmail + ' sendmail' : ''}</span></div>`).join(''))
    ;
  const healthTotal = hOrph.length + hUnres.length + hAmbig.length + hBroken.length + hFK.length;

  // Contents index: informative tables (one row per item) for functions and modules
  const fnRows = [];
  Object.keys(byNs).sort().forEach((ns) => {
    byNs[ns].slice().sort((a, b) => (a.api_name || '').localeCompare(b.api_name || '')).forEach((f) => {
      const n = nodeByApi[f.api_name];
      fnRows.push(`<tr><td><a href="#${fnAnchor(f.api_name)}">${esc(f.display_name || f.api_name)}</a></td>`
        + `<td class="mono">${esc(f.api_name)}</td><td class="mono">${esc(ns)}</td>`
        + `<td class="ct">${f.rest ? '\u25cf' : ''}</td><td class="ct">${f.downloaded ? '' : '\u2014'}</td>`
        + `<td class="ct">${n ? n.calls.length : 0}</td><td class="ct">${n ? n.called_by.length : 0}</td>`
        + `<td class="ct">${f.stats ? f.stats.lines : ''}</td><td class="ct">${f.stats ? f.stats.apiCalls : ''}</td></tr>`);
    });
  });
  const modRows = [];
  ['Standard', 'Custom'].forEach((k) => groups[k].slice().sort((a, b) => (a.api_name || '').localeCompare(b.api_name || '')).forEach((m) => {
    const rb = (modRefs && modRefs[m.api_name]) ? modRefs[m.api_name].length : 0;
    modRows.push(`<tr><td><a href="#${modAnchor(m.api_name)}">${esc(m.plural_label || m.singular_label || m.module_name || m.api_name)}</a></td>`
      + `<td class="mono">${esc(m.api_name)}</td><td class="mono">${esc(m.module_name || '')}</td>`
      + `<td class="ct">${k}</td><td class="ct">${(m.fields || []).length}</td><td class="ct">${rb}</td></tr>`);
  }));
  // Connections: catalogue + which functions use each
  const connRows = (conns || []).slice().sort((a, b) => (b.uses.length - a.uses.length) || (a.name || '').localeCompare(b.name || '')).map((c) => {
    const usesLinks = c.uses.length ? c.uses.map(fnLink).join(', ') : '<span class="none">none</span>';
    const status = c.missing ? '<span style="color:#b45309">not in catalogue</span>' : c.connected === false ? '<span style="color:#b45309">not connected</span>' : 'connected';
    return `<tr id="${connAnchor(c.name)}"><td class="mono"><b>${esc(c.name)}</b></td><td>${esc(c.label || '')}</td><td class="mono">${esc(c.connector || '')}</td><td class="ct">${status}</td><td class="ct">${c.uses.length}</td><td>${usesLinks}</td></tr>`;
  });
  const connHtml = conns.length
    ? `<p class="hxd">The org's connections and the functions that use each — the join key is the name in <code>invokeurl […connection:"…"]</code>.</p><table class="ftbl"><thead><tr><th>Connection</th><th>Label</th><th>Connector</th><th>Status</th><th>Uses</th><th>Used by functions</th></tr></thead><tbody>${connRows.join('')}</tbody></table>`
    : '<p class="empty">No connections in this export.</p>';
  const toc = `<nav class="toc"><h2>Contents</h2>`
    + `<h3 class="toch">Functions (${fns.length})</h3>`
    + `<table class="toctbl"><thead><tr><th>Function</th><th>API name</th><th>Namespace</th><th>REST</th><th>DL</th><th>Uses</th><th>Used by</th><th title="source lines">Lines</th><th title="invokeurl + Zoho service tasks">Calls</th></tr></thead><tbody>${fnRows.join('') || '<tr><td colspan="9" class="none">none</td></tr>'}</tbody></table>`
    + `<h3 class="toch">Modules (${mods.length})</h3>`
    + `<table class="toctbl"><thead><tr><th>Module</th><th>API name</th><th>Generated</th><th>Kind</th><th>Fields</th><th>Ref by</th></tr></thead><tbody>${modRows.join('') || '<tr><td colspan="6" class="none">none</td></tr>'}</tbody></table>`
    + (wfs.length ? `<h3 class="toch">Workflows (${wfs.length})</h3><table class="toctbl"><thead><tr><th>Workflow</th><th>Module</th><th>Trigger</th><th>Active</th><th>Fn calls</th></tr></thead><tbody>${wfRows.join('')}</tbody></table>` : '')
    + (scheds.length ? `<h3 class="toch">Schedules (${scheds.length})</h3><table class="toctbl"><thead><tr><th>Schedule</th><th>Function</th><th>Frequency</th><th>Status</th></tr></thead><tbody>${schRows.join('')}</tbody></table>` : '')
    + (allRels.length ? `<h3 class="toch">Relations (${allRels.length})</h3><div class="tochx"><a href="#relations">Relation-first catalogue \u2014 related-list API names for Deluge</a></div>` : '')
    + (conns.length ? `<h3 class="toch">Connections (${conns.length})</h3><div class="tochx"><a href="#connections">Catalogue — connectors, status, and which functions use each</a></div>` : '')
    + (scope.health ? `<h3 class="toch">Health <span class="cnt">${healthTotal}</span></h3><div class="tochx"><a href="#health">Orphans ${hOrph.length} \u00b7 Unresolved ${hUnres.length} \u00b7 Ambiguous ${hAmbig.length} \u00b7 Broken ${hBroken.length} \u00b7 Missing FK ${hFK.length}</a></div>` : '')
    + `</nav>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(PRODUCT_NAME)} — ${esc(ws.instance || 'Export')}</title>`
    + `<meta name="author" content="${esc(PRODUCT_AUTHOR)}"><meta name="generator" content="${esc(PRODUCT_NAME)}"><meta name="description" content="Export of Zoho CRM Deluge functions and module schema.">${PRODUCT_URL ? `<link rel="canonical" href="${esc(PRODUCT_URL)}">` : ''}`
    + `<style>${EXPORT_CSS}</style></head><body>`
    + `<header><h1>${esc(PRODUCT_NAME)} — Export</h1>`
    + `<div class="meta">${esc(ws.instance || '')} · org ${esc(ws.org || '')} · ${esc(envOf(ws.base))} · ${esc(now)} · ${fns.length} functions · ${mods.length} modules · contents: ${esc(SCOPE_KEYS.filter((k) => scope[k]).join(', ') || 'nothing')}${scope.code ? '' : ' · source code excluded'}</div>`
    + `<div class="meta">Data read from Zoho: ${esc(freshnessLine())}</div>`
    + `<input id="q" placeholder="Filter functions & modules…" oninput="filt()"></header>`
    + `<main>${toc}<h2 id="functions">Functions</h2>${fnHtml || '<p class="empty">No functions.</p>'}<h2 id="modules">Modules</h2>${modHtml || '<p class="empty">No modules.</p>'}<h2 id="relations">Relations</h2>${relHtml}${wfs.length ? `<h2 id="workflows">Workflows</h2>${wfHtml}` : ''}${scheds.length ? `<h2 id="schedules">Schedules</h2>${schHtml}` : ''}${conns.length ? `<h2 id="connections">Connections</h2>${connHtml}` : ''}${scope.health ? `<h2 id="health">Health</h2>${healthHtml}` : ''}</main>`
    + `<footer><div>Generated by ${PRODUCT_URL ? `<a href="${esc(PRODUCT_URL)}">${esc(PRODUCT_NAME)}</a>` : esc(PRODUCT_NAME)} · Created by ${esc(PRODUCT_AUTHOR)}${SPONSOR_URL ? ` · <a href="${esc(SPONSOR_URL)}">Sponsor</a>` : ''}${KOFI_URL ? ` · <a href="${esc(KOFI_URL)}">\u2615 Ko-fi</a>` : ''}</div><div class="legal">${esc(LEGAL_DISCLAIMER)}</div></footer>`
    + `<script>function filt(){var q=document.getElementById('q').value.trim().toLowerCase();document.querySelectorAll('.item').forEach(function(s){s.style.display=(!q||s.dataset.name.indexOf(q)>=0)?'':'none';});document.querySelectorAll('tr.relrow').forEach(function(r){r.style.display=(!q||r.dataset.name.indexOf(q)>=0)?'':'none';});}<\/script></body></html>`;
}

async function loadExportData() {
    const metaById = new Map();
  for await (const p of walk(dir)) {
    if (p.startsWith('_index/')) continue;
    if (p.endsWith('.meta.json')) { try { const m = JSON.parse(await readFile(p)); metaById.set(String(m.id), { meta: m, dg: p.replace(/\.meta\.json$/, '.dg') }); } catch (_) {} }
  }
  let idx = null; try { idx = JSON.parse(await readFile('_index/functions.json')); } catch (_) {}
  const entries = (idx && idx.length) ? idx : [...metaById.values()].map((v) => ({ id: v.meta.id, api_name: v.meta.api_name, display_name: v.meta.display_name, namespace: v.meta.nameSpace, category: v.meta.category, source: v.meta.source, rest: (v.meta.rest_api || []).some((r) => r.active) }));
  const fns = [];
  for (const e of entries) {
    const d = metaById.get(String(e.id)); let code = '';
    if (d) { try { code = await readFile(d.dg); } catch (_) {} }
    fns.push({ api_name: e.api_name, display_name: e.display_name || e.api_name, namespace: (d && (d.meta.nameSpace)) || e.namespace, rest: e.rest, code, downloaded: !!d, associated_place: (d && d.meta && d.meta.associated_place) || null, modified_by: (d && d.meta.modified_by) || null, updatedTime: (d && d.meta.updatedTime) || null, connections: (d && d.meta.connections) || [], stats: d ? fnStats(code) : null });
  }
  const mods = [];
  for await (const p of walk(dir)) { if (p.startsWith('_modules/') && p.endsWith('.json') && !p.endsWith('_index.json')) { try { const m = JSON.parse(await readFile(p)); try { m._layouts = JSON.parse(await readFile(`_layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) { m._layouts = []; } mods.push(m); } catch (_) {} } }
  let g = null; try { g = await ensureGraph(); } catch (_) {}
  const modRefs = {};
  mods.forEach((m) => (m.fields || []).forEach((fl) => { if (fl.lookup) (modRefs[fl.lookup] ||= []).push({ module: m.api_name, field: fl.api_name }); }));
  const wfs = [];
  let wfIdx = []; try { wfIdx = JSON.parse(await readFile('_workflows/_index.json')); } catch (_) {}
  for (const w of wfIdx) { let detail = null; try { detail = JSON.parse(await readFile(`_workflows/${w.id}.json`)); } catch (_) {} wfs.push({ ...w, id: String(w.id), detail }); }
  let scheds = []; try { scheds = JSON.parse(await readFile('_schedules/_index.json')); } catch (_) {}
  // connections catalogue + usage (which functions reference each), joined on connectionLinkName
  let connCat = []; try { connCat = JSON.parse(await readFile('_connections/_index.json')); } catch (_) {}
  if (!Array.isArray(connCat)) connCat = [];
  const connUse = {};
  fns.forEach((f) => (f.connections || []).forEach((c) => { if (c && c.name) (connUse[c.name] ||= []).push(f.api_name); }));
  const conns = connCat.map((c) => ({ ...c, uses: (connUse[c.name] || []).slice() }));
  const catNames = new Set(connCat.map((c) => c.name));
  Object.keys(connUse).forEach((name) => { if (!catNames.has(name)) conns.push({ name, label: name, connector: null, connected: null, missing: true, uses: connUse[name].slice() }); });
  return { fns, mods, g, modRefs, wfs, scheds, conns };
}
function _mdCell(x) { return String(x == null ? '' : x).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function buildExportMarkdown(d, scope) {
  scope = Object.assign({}, SCOPE_FULL, scope || {});
  let { mods, g, wfs, scheds, conns } = d;
  if (!scope.modules) mods = [];
  if (!scope.workflows) wfs = [];
  if (!scope.schedules) scheds = [];
  conns = scope.connections ? (conns || []) : [];
  const nodes = scope.functions ? ((g && g.nodes) || {}) : {};
  const fnList = Object.values(nodes).sort((a, b) => (a.namespace + '.' + a.name).localeCompare(b.namespace + '.' + b.name));
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const inst = (bound && bound.instance) || 'workspace', org = (bound && bound.org) || '?', env = bound ? envOf(bound.base) : '?';
  const first = (t) => (t || '').split('\n')[0].slice(0, 120);
  const params = (n) => '(' + ((n.params || []).map((p) => (p && (p.name || p.param_name)) || p).filter(Boolean).join(', ')) + ')';
  const wfFns = (w) => { const out = []; const det = w.detail; if (det) (det.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter((a) => a.type === 'functions').forEach((a) => out.push(a.name)); }); return [...new Set(out)]; };
  let md = '# Zoho CRM Deluge \u2014 Workspace export (AI context)\n\n';
  md += `- Instance: ${inst}\n- Org: ${org}\n- Environment: ${env}\n- Generated: ${now}\n- Functions: ${fnList.length} \u00b7 Modules: ${mods.length} \u00b7 Workflows: ${wfs.length} \u00b7 Schedules: ${scheds.length}\n`;
  md += `- Data read from Zoho: ${freshnessLine()}\n\n`;
  md += `- Contents: ${SCOPE_KEYS.filter((k) => scope[k]).join(', ') || 'nothing'}\n\n`;
  md += '> Self-contained, read-only snapshot of this Zoho CRM org\u2019s Deluge functions, module schema, and automations. Intended as context for an AI assistant used outside the extension.\n\n';
  md += '## Index\n\n### Functions\n';
  fnList.forEach((n) => { const used = [...new Set((n.associated_place || []).map((p) => p._type).filter(Boolean))]; md += `- \`${n.namespace}.${n.name}\`${params(n)}${n.return_type ? ' \u2192 ' + n.return_type : ''}${n.rest ? ' \u00b7 REST' : ''}${used.length ? ' \u00b7 used in ' + used.join('/') : ''}${n.stats ? ` \u00b7 ${n.stats.lines} lines \u00b7 ${n.stats.apiCalls} API call(s)` : ''}${n.description ? ' \u2014 ' + first(n.description) : ''}\n`; });
  md += '\n### Modules\n';
  mods.slice().sort((a, b) => (a.api_name || '').localeCompare(b.api_name || '')).forEach((m) => { md += `- \`${m.api_name}\` \u2014 ${(m.fields || []).length} fields\n`; });
  if (wfs.length) { md += '\n### Workflows\n'; wfs.forEach((w) => { const fl = wfFns(w); md += `- ${w.name}${w.module ? ' (' + w.module + ')' : ''}${fl.length ? ' \u2192 ' + fl.join(', ') : ''}\n`; }); }
  if (scheds.length) { md += '\n### Schedules\n'; scheds.forEach((sc) => { md += `- ${sc.name} \u2192 ${sc.function_name || '?'}${sc.frequency ? ' (' + sc.frequency + ')' : ''}\n`; }); }
  if (fnList.length) md += `\n---\n\n## Functions${scope.code ? ' (full source)' : ' (signatures only \u2014 source code excluded from this export)'}\n\n`;
  fnList.forEach((n) => {
    md += `### ${n.namespace}.${n.name}\n\n`;
    md += `- api_name: \`${n.api_name || ''}\`${n.return_type ? ` \u00b7 returns ${n.return_type}` : ''}${n.rest ? ' \u00b7 REST-enabled' : ''}\n`;
    if (n.calls && n.calls.length) md += `- calls: ${n.calls.join(', ')}\n`;
    if (n.called_by && n.called_by.length) md += `- called by: ${n.called_by.join(', ')}\n`;
    if (n.associated_place && n.associated_place.length) md += `- used in: ${n.associated_place.map((p) => `${p._type}${p.name ? ' ' + p.name : ''}`).join('; ')}\n`;
    if (n.stats) md += `- size: ${n.stats.lines} lines (${n.stats.codeLines} code) · ${(n.stats.chars / 1024).toFixed(1)} KB\n- outbound calls: ${n.stats.apiCalls || 'none'}${n.stats.apiCalls ? ` (${n.stats.invokeurl} invokeurl, ${n.stats.crm} zoho.crm, ${n.stats.zoho} other Zoho${n.stats.sendmail ? `, ${n.stats.sendmail} sendmail` : ''})` : ''}\n`;
    if (scope.connections && n.connections && n.connections.length) md += `- connections: ${n.connections.map((c) => c.name).join(', ')}\n`;
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
  mods.slice().sort((a, b) => (a.api_name || '').localeCompare(b.api_name || '')).forEach((m) => {
    md += `### ${m.api_name}${(m._layouts && m._layouts.length) ? ` \u00b7 ${m._layouts.length} layout(s)` : ''}\n\n#### All fields (flat)\n\n| Field | API name | Type | Lookup | Picklist |\n|---|---|---|---|---|\n`;
    (m.fields || []).forEach((f) => { md += `| ${_mdCell(f.label || f.api_name)} | \`${_mdCell(f.api_name)}\` | ${_mdCell((f.data_type || '') + (f.length ? ' (' + f.length + ')' : ''))} | ${f.lookup ? '\u2192 ' + _mdCell(f.lookup) : ''} | ${(f.picklist && f.picklist.length) ? _mdCell(f.picklist.slice(0, 12).join(', ')) : ''} |\n`; });
    md += '\n';
    if (scope.relations && (m.related_lists || []).length) {
      md += `#### Related lists (use the API name in zoho.crm.getRelatedRecords)\n\n| API name | Label | Target module | Type |\n|---|---|---|---|\n`;
      m.related_lists.forEach((r) => { md += `| \`${_mdCell(r.api_name)}\` | ${_mdCell(r.label || '')} | ${_mdCell(r.module || r.connected_module || '')}${r.linking_module ? ' via ' + _mdCell(r.linking_module) : ''} | ${_mdCell(r.type || '')}${r.visible === false ? ' (hidden)' : ''} |\n`; });
      md += '\n';
    }
    (scope.layouts ? (m._layouts || []) : []).forEach((L) => {
      md += `#### Layout: ${_mdCell(L.name || String(L.id))}${L.visible === false ? ' (hidden)' : ''} \u2014 ${(L.sections || []).length} sections\n\n`;
      (L.sections || []).forEach((sec) => {
        md += `**${_mdCell(sec.display_label || sec.name || 'Section')}** (${(sec.fields || []).length})\n\n| Field | API name | Type | Req |\n|---|---|---|---|\n`;
        (sec.fields || []).forEach((fl) => { md += `| ${_mdCell(fl.field_label || fl.display_label || fl.api_name)} | \`${_mdCell(fl.api_name || '')}\` | ${_mdCell(fl.data_type || '')} | ${fl.required ? '\u25cf' : ''} |\n`; });
        md += '\n';
      });
    });
  });
  const mdStat = fnList.filter((n) => n.stats && n.stats.lines);
  if (mdStat.length) {
    md += '---\n\n## Size and outbound calls\n\nPlain counts, no threshold and no verdict: length is verbosity, not complexity, and each outbound call is work Zoho meters. Calls are counted outside comments and string literals. Interpretation is the reader’s.\n\n';
    md += '| Function | Lines | Code lines | KB | invokeurl | zoho.crm | Other Zoho | sendmail | Total calls |\n|---|---|---|---|---|---|---|---|---|\n';
    mdStat.slice().sort((a, b) => b.stats.lines - a.stats.lines).forEach((n) => {
      const s = n.stats;
      md += `| \`${_mdCell(n.namespace + '.' + n.name)}\` | ${s.lines} | ${s.codeLines} | ${(s.chars / 1024).toFixed(1)} | ${s.invokeurl} | ${s.crm} | ${s.zoho} | ${s.sendmail} | ${s.apiCalls} |\n`;
    });
    md += '\n';
  }
  if (conns.length) {
    md += '---\n\n## Connections\n\nThe org’s connections and which functions use each. The join key is the name in `invokeurl [...connection:"..."]`.\n\n';
    md += '| Connection | Label | Connector | Status | Uses | Used by |\n|---|---|---|---|---|---|\n';
    conns.slice().sort((a, b) => (b.uses.length - a.uses.length) || (a.name || '').localeCompare(b.name || '')).forEach((c) => {
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
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    setStatus('Building AI (Markdown) export\u2026', 'busy');
    const data = await loadExportData();
    const md = buildExportMarkdown(data, scope);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && bound.instance) || 'workspace')}-${stamp}.md`;
    await writeFile(name, md);
    setStatus(`Exported \u2192 ${name} (in your workspace folder).`, 'ok');
  } catch (e) { setStatus('Export error: ' + e.message, 'bad'); }
}
async function exportHtml() {
  if (!dir) return;
  const scope = await askScope(); if (!scope) return;
  try {
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    setStatus('Building HTML export\u2026', 'busy');
    const { fns, mods, g, modRefs, wfs, scheds, conns } = await loadExportData();
    const html = buildExportHtml(fns, mods, g, modRefs, wfs, scheds, conns, scope);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && bound.instance) || 'workspace')}-${stamp}.html`;
    await writeFile(name, html);
    setStatus(`Exported \u2192 ${name} (in your workspace folder).`, 'ok');
  } catch (e) { setStatus('Export error: ' + e.message, 'bad'); }
}

// ---------- schedules ----------
async function loadScheduleIndex() {
  let idx = []; try { idx = JSON.parse(await readFile('_schedules/_index.json')); } catch (_) {}
  scheduleData = idx.map((e) => ({ ...e, id: String(e.id), path: '_schedules/' + String(e.id) }));
}
async function rebuildSchedules() {
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { setStatus('Folder access needs re-granting \u2014 click Refresh.', 'warn'); return; }
    setStatus('Reading schedules\u2026', 'busy');
    const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
    await loadScheduleIndex();
    renderSchedules();
    setStatus(scheduleData.length ? `${scheduleData.length} schedules.` : 'No schedules pulled yet \u2014 use Pull all.', 'ok');
  } catch (e) { setStatus('Refresh error: ' + e.message, 'bad'); }
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
  if (!keys.length) { tree.innerHTML = '<div class="treemsg">No matches.</div>'; return; }
  keys.forEach((st) => {
    const list = byStatus[st].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const isCol = collapsed.has('sc:' + st);
    const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
    g.innerHTML = `<span class="chev">\u25be</span><span>${st}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete('sc:' + st) : collapsed.add('sc:' + st); renderSchedules(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => {
      const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path;
      el.setAttribute('aria-selected', e.path === currentPath);
      el.innerHTML = `<span class="st st-ok" title="In workspace \u2014 click to refresh schedules from Zoho">\u25cf</span><span>${escHtml(e.name)}</span><span class="wftype">${escHtml(e.frequency || '')}</span>${e.status === 'active' ? '' : '<span class="wfoff">off</span>'}`;
      el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); refreshSchedules(); };
      el.onclick = () => openSchedule(e);
      tree.appendChild(el);
    });
  });
}
async function refreshSchedules() {
  if (!guardOk()) { setStatus('Active Zoho tab does not match this workspace.', 'warn'); return; }
  setStatus('Refreshing schedules…', 'busy');
  await pullSchedules();
  setStatus(`${scheduleData.length} schedules.`, 'ok');
}
async function openSchedule(e) {
  currentPath = e.path; pvHist = []; updateBack();
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === e.path));
  $('pvname').textContent = e.name;
  $('pvcallers').className = ''; $('pvcallers').textContent = '';   // else the last function's callers/connections bar lingers
  $('pvreveal').style.display = 'none'; $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  const fnLink = `<span class="wf-fn" data-fnid="${escHtml(e.function_id || '')}" data-fnname="${escHtml(e.function_name || '')}" title="Open the function">\u0192 ${escHtml(e.function_name || '?')}</span>`;
  $('pvtable').innerHTML = `<div class="wfd">`
    + `<div class="wfrow"><span class="wk">Function</span> ${fnLink}</div>`
    + `<div class="wfrow"><span class="wk">Frequency</span> ${escHtml(e.frequency || '')}</div>`
    + `<div class="wfrow"><span class="wk">Status</span> ${escHtml(e.status || '')}</div>`
    + (e.next ? `<div class="wfrow"><span class="wk">Next run</span> ${escHtml(e.next)}</div>` : '')
    + (e.last ? `<div class="wfrow"><span class="wk">Last run</span> ${escHtml(e.last)}</div>` : '')
    + `</div>`;
  $('preview').classList.add('show'); $('resizer').classList.add('show'); resetPreviewScroll();
  $('pvtable').querySelectorAll('.wf-fn').forEach((sp) => { sp.onclick = () => openFunctionFromWorkflow(sp.dataset.fnid, sp.dataset.fnname); });
}

// ---------- workflows ----------
async function loadWorkflowIndex() {
  wfIndex = new Map();
  let idx = []; try { idx = JSON.parse(await readFile('_workflows/_index.json')); } catch (_) {}
  const have = new Set();
  for await (const p of walk(dir)) { if (p.startsWith('_workflows/') && p.endsWith('.json') && !p.endsWith('_index.json')) have.add(p.split('/').pop().replace(/\.json$/, '')); }
  workflowData = idx.map((e) => ({ ...e, id: String(e.id), path: `_workflows/${String(e.id)}.json`, downloaded: have.has(String(e.id)), error: false }));
  workflowData.forEach((e) => wfIndex.set(e.id, e));
}
async function rebuildWorkflows() {
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { setStatus('Folder access needs re-granting \u2014 click Refresh.', 'warn'); return; }
    setStatus('Reading workflows\u2026', 'busy');
    const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
    await loadWorkflowIndex();
    renderWorkflows(); updateMissingButton();
    const dl = workflowData.filter((e) => e.downloaded).length;
    setStatus(`${workflowData.length} workflows (${dl} downloaded).`, 'ok');
  } catch (e) { setStatus('Refresh error: ' + e.message, 'bad'); }
  await refreshContext();
}
function renderWorkflows() {
  if (viewMode !== 'workflows') return;
  const term = $('find').value.trim().toLowerCase();
  const byMod = {};
  workflowData
    .filter((e) => workflowFilter === 'all' || (workflowFilter === 'active' ? e.active : !e.active))
    .filter((e) => !term || (e.name || '').toLowerCase().includes(term) || (e.module || '').toLowerCase().includes(term))
    .forEach((e) => (byMod[e.module || '(no module)'] ||= []).push(e));
  const tree = $('tree'); tree.innerHTML = '';
  const keys = Object.keys(byMod).sort();
  if (!keys.length) { tree.innerHTML = '<div class="treemsg">No matches.</div>'; return; }
  keys.forEach((mod) => {
    const list = byMod[mod].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
      const wfTitle = e.error ? ('Failed: ' + (e.errorMsg || 'unknown') + ' \u2014 click to retry') : e.downloaded ? 'In workspace \u2014 click to re-download from Zoho' : 'Not in workspace \u2014 click to download';
      el.innerHTML = `<span class="st ${stCls}" title="${wfTitle}">${stCh}</span><span>${escHtml(e.name)}</span><span class="wftype">${escHtml(e.type)}</span>${e.active ? '' : '<span class="wfoff">off</span>'}`;
      el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); downloadOneWf(e).then(() => { updateRow(e); updateMissingButton(); }); };
      el.onclick = () => openWorkflow(e);
      tree.appendChild(el);
    });
  });
}
async function downloadOneWf(entry) {
  if (!dir) return false;
  if (!(await ensurePerm(dir))) { setStatus('Folder access denied \u2014 click Refresh.', 'bad'); return false; }
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
  $('pull').disabled = true; $('missing').disabled = true;
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
  setStatus(fail ? `Downloaded ${ok}, ${fail} still missing \u2014 use \u201cComplete missing\u201d.` : `All ${ok} workflows downloaded.`, fail ? 'warn' : 'ok');
  $('pull').disabled = false; $('missing').disabled = false;
}
async function pullSchedules() {
  try {
    if (!(await ensurePerm(dir))) { setStatus('Folder access not granted.', 'warn'); return; }
    const ctx = await getContext(); if (!ctx) { setStatus('No Zoho CRM tab open.', 'warn'); return; }
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus('Environment mismatch \u2014 refusing.', 'warn'); return; }
    setStatus('Pulling schedules\u2026', 'busy');
    const r = await toBridge({ cmd: 'listSchedules' }); if (!r?.ok) { const e = bridgeError(r, 'unknown'); await noteAccess('schedules', e); setStatus(pullFailMessage('schedules', e), 'bad'); return; }
    await writeFile('_schedules/_index.json', JSON.stringify(r.entries, null, 2));
    await loadScheduleIndex(); if (viewMode === 'schedules') renderSchedules();
    setStatus(`Schedules pull complete: ${(r.entries || []).length} schedules.${r.capped ? ' · capped at 4000 — some may be missing' : ''}`, r.capped ? 'warn' : 'ok');
    await noteAccess('schedules', null);
  } catch (e) { await noteAccess('schedules', e); setStatus(pullFailMessage('schedules', e), 'bad'); }
}
// Org-wide connections catalogue → _connections/_index.json. Written once per "Pull all".
async function pullConnections() {
  try {
    if (!(await ensurePerm(dir))) return;
    const ctx = await getContext(); if (!ctx) { setStatus('No Zoho CRM tab open.', 'warn'); return; }
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus('Connections: environment mismatch — refusing.', 'warn'); return; }
    setStatus('Pulling connections…', 'busy');
    const r = await toBridge({ cmd: 'pullConnections' });
    if (!r?.ok) { setStatus('Connections pull failed: ' + (r?.error || 'unknown'), 'warn'); return; }
    await writeFile('_connections/_index.json', JSON.stringify(r.connections || [], null, 2));
    aiConnCache = null;   // the AI's catalogue must not serve what we just replaced
    if (viewMode === 'connections') await rebuildConnections();   // reflect it immediately, like the other pulls do
    else setStatus(`Connections pulled: ${(r.connections || []).length}.`, 'ok');
    await noteAccess('connections', null);
  } catch (e) { await noteAccess('connections', e); setStatus(pullFailMessage('connections', e), 'bad'); }
}
// ---------- connections view (org-wide catalogue + usage) ----------
let connectionData = [], connCatFilter = 'all';
async function loadConnectionsIndex() {
  let idx = []; try { idx = JSON.parse(await readFile('_connections/_index.json')); } catch (_) {}
  return Array.isArray(idx) ? idx : [];
}
async function rebuildConnections() {
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { setStatus('Folder access needs re-granting — click Refresh.', 'warn'); return; }
    setStatus('Reading connections…', 'busy');
    const _cfg = await readCfg(); if (_cfg) bound = _cfg; await cacheBinding(bound);
    const cat = await loadConnectionsIndex();
    // usage: which functions reference each connection (join meta.connections[].name)
    const g = await ensureGraph().catch(() => null);
    const usedBy = {};
    if (g) Object.values(g.nodes).forEach((n) => (n.connections || []).forEach((c) => { if (c && c.name) (usedBy[c.name] ||= []).push(n); }));
    connectionData = cat.map((c) => ({ ...c, path: '_connections/' + c.name, uses: (usedBy[c.name] || []).slice() }));
    // connections a function references but that are NOT in the catalogue (renamed / removed)
    const catNames = new Set(cat.map((c) => c.name));
    Object.keys(usedBy).forEach((name) => { if (!catNames.has(name)) connectionData.push({ name, label: name, connector: null, connected: null, createdBy: null, scopes: [], missing: true, path: '_connections/' + name, uses: usedBy[name].slice() }); });
    renderConnections();
    setStatus(connectionData.length ? `${connectionData.length} connections.` : 'No connections pulled yet — click Pull all.', connectionData.length ? 'ok' : 'warn');
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
  const list = connectionData.filter(pass).sort((a, b) => (b.uses.length - a.uses.length) || (a.label || '').localeCompare(b.label || ''));
  const tree = $('tree'); tree.innerHTML = '';
  if (!list.length) { tree.innerHTML = '<div class="treemsg">' + (connectionData.length ? 'No matches.' : 'No connections yet — click Pull all.') + '</div>'; return; }
  list.forEach((c) => {
    const el = document.createElement('div'); el.className = 'f'; el.dataset.path = c.path;
    el.setAttribute('aria-selected', c.path === currentPath);
    const dc = c.missing ? 'st-err' : c.connected === false ? 'st-stale' : 'st-ok';
    const dch = c.missing ? '⟳' : c.connected === false ? '◐' : '●';
    const dt = (c.missing ? 'Used by a function but not in the pulled catalogue' : c.connected === false ? 'Configured but not connected' : 'Connected') + ' — click to refresh connections from Zoho';
    el.innerHTML = `<span class="st ${dc}" title="${dt}">${dch}</span><span class="fname">${escHtml(c.label || c.name)}</span>`
      + `<span class="rest rf" title="functions using it">${c.uses.length}×</span>`
      + (c.connector ? `<span class="rest rl" style="color:#a78bfa" title="connector">${escHtml(c.connector)}</span>` : '');
    el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); refreshConnections(); };   // the status dot acts, like every other tab's does (here: re-pull the catalogue)
    el.onclick = () => openConnection(c);
    tree.appendChild(el);
  });
}
async function refreshConnections() {
  if (!guardOk()) { setStatus('Active Zoho tab does not match this workspace.', 'warn'); return; }
  setStatus('Refreshing connections…', 'busy');
  await pullConnections();   // re-pulls the whole catalogue and rebuilds the view (like the schedules dot)
}
function openConnection(c) {
  currentPath = c.path; pvHist = []; updateBack();
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === c.path));
  $('pvname').textContent = c.label || c.name;
  $('pvcallers').className = ''; $('pvcallers').textContent = '';   // else the last function's callers/connections bar lingers
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
  $('pvtable').querySelectorAll('a[data-file]').forEach((a) => (a.onclick = () => { setMode('functions'); openFile(a.dataset.file, true); }));
  $('preview').classList.add('show'); $('resizer').classList.add('show'); resetPreviewScroll();
}
async function pullWorkflows() {
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    const ctx = await getContext(); if (!ctx) throw new Error('No Zoho CRM tab open.');
    const cfg = await readCfg();
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing.`);
    setStatus('Listing workflows\u2026', 'busy');
    const r = await toBridge({ cmd: 'listWorkflows' }); if (!r?.ok) throw new Error(r?.error || 'list failed');
    await writeFile('_workflows/_index.json', JSON.stringify(r.entries, null, 2));
    const liveIds = new Set(r.entries.map((e) => String(e.id)));
    let prunedW = 0;
    for await (const p of walk(dir)) { if (p.startsWith('_workflows/') && p.endsWith('.json') && !p.endsWith('_index.json')) { const wid = p.split('/').pop().replace(/\.json$/, ''); if (!liveIds.has(wid)) { try { await removeFile(p); prunedW++; } catch (_) {} } } }
    await loadWorkflowIndex();
    if (viewMode === 'workflows') { renderWorkflows(); updateMissingButton(); }
    await downloadMissingWf();
    if (prunedW) setStatus($('stxt').textContent + ` \u00b7 ${prunedW} deleted removed`, 'ok');
    if (r.capped) setStatus($('stxt').textContent + ' \u00b7 list capped at 4000 \u2014 some workflows may be missing', 'warn');
    await noteAccess('workflows', null);
  } catch (e) { await noteAccess('workflows', e); setStatus(pullFailMessage('workflows', e), 'bad'); } finally { pullActive = false; }
}
async function openWorkflowInZoho(id) {
  const ws = bound || {};
  if (!ws.base || !ws.instance) { setStatus('Unknown workspace binding \u2014 pull first.', 'warn'); return; }
  const url = `${ws.base}/crm/${ws.instance}/settings/workflow-rules/${id}`;
  let tid = await zohoTabId();
  try { if (tid) await chrome.tabs.update(tid, { url, active: true }); else await chrome.tabs.create({ url }); setStatus('Opened workflow in Zoho.', 'ok'); }
  catch (e) { setStatus('Could not open: ' + e.message, 'warn'); }
}
async function openWorkflow(e) {
  if (!e.downloaded) { const ok = await downloadOneWf(e); updateRow(e); updateMissingButton(); if (!ok) { setStatus('Could not download this workflow.', 'warn'); return; } }
  let rule; try { rule = JSON.parse(await readFile(e.path)); } catch (err) { setStatus('Read failed: ' + err.message, 'bad'); return; }
  currentPath = e.path; pvHist = []; updateBack();
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === e.path));
  $('pvname').textContent = e.name;
  $('pvcallers').className = ''; $('pvcallers').textContent = '';   // else the last function's callers/connections bar lingers
  $('pvreveal').style.display = ''; $('pvreveal').textContent = 'Go to \u2197'; $('pvreveal').title = 'Open the workflow in Zoho'; $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  $('pvtable').innerHTML = renderWorkflowDetail(rule);
  $('preview').classList.add('show'); $('resizer').classList.add('show'); resetPreviewScroll();
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
  const actionSpan = (a) => a.type === 'functions'
    ? `<span class="wf-fn" data-fnid="${esc(a.id)}" data-fnname="${esc(a.name)}" title="Open the function">\u0192 ${esc(a.name)}</span>`
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
  h += `<div class="wfusage-wrap"><button class="wfusage" data-wfid="${esc(rule.id)}">Show executions (last 30 days)</button><div class="wfusage-out"></div></div>`;
  h += `<details class="wfraw"><summary>Raw JSON</summary><pre>${esc(JSON.stringify(rule, null, 2))}</pre></details>`;
  return h + `</div>`;
}
async function loadWorkflowUsage(id, outEl, btn) {
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
  if (!ent) { setStatus(`Function \u201c${name}\u201d not in workspace \u2014 pull functions first.`, 'warn'); return; }
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
// The tab set is a preference plus a per-workspace measurement, so it is built once at start-up and
// again whenever either can have moved: a workspace opening (different org, different roles) and a
// pull learning something new both call renderTabs themselves.
loadTabPrefs().then(renderTabs);
$('pull').onclick = pullEverything; $('pullone').onclick = pullCurrent; $('health').onclick = toggleHealth; $('healthx').onclick = closeHealth; $('missing').onclick = () => (viewMode === 'workflows' ? downloadMissingWf() : downloadMissing()); $('export').onclick = exportHtml; $('exportmd').onclick = exportMarkdown; $('graph').onclick = () => (viewMode === 'functions' ? openGraph() : openSchemaGraph()); $('refresh').onclick = async () => { if (root && !rootGranted) { await grantRoot(); return; } await rebuildActive(); };
$('ainotex').onclick = () => $('ainote').classList.remove('show');   // hidden for this session of the chat, back on next open
$('askai').onclick = toggleAI; $('aix').onclick = closeAI; $('aiclear').onclick = aiClear; $('aisend').onclick = aiSend; $('aigear').onclick = aiOpenSettings;
$('aiinput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiSend(); } });
buildTypeChips();
chrome.storage.local.get('previewH').then((r) => { if (r?.previewH) $('preview').style.height = r.previewH; });
chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_t, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
loadWorkspaces();
setInterval(refreshContext, 5000);
