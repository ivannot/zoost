/*
 * sidepanel.js — Zoost for Zoho Analytics.
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
// out which one an attribute used — the same definition as the CRM panel and both graph windows.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PRODUCT_NAME = chrome.runtime.getManifest().name;   // single source of truth: rename in manifest.json only
const HOST_RE = /^https:\/\/analytics\.(zoho\.(eu|com|in|com\.au|jp)|zohocloud\.ca)\//;
const PULL_TITLE = 'Pull all \u2014 views, structure, relations, SQL and lineage';
const APP_DIR = 'analytics';                  // this app's subfolder inside the working folder
const APP_DIRS = ['crm', 'analytics'];        // known product folders — not "foreign" content
const CFG = '.zoost.json';
const PULL_SV = 1;                            // pull schema version; bump when new fields are captured

// Identity and legal text, worded as in the CRM panel — the two are one product to the reader.
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

let wsList = [];            // workspaces found on disk, cached like the CRM panel's
let views = [], folders = [], schema = {}, relations = [], sqls = {}, deps = null, pullFailed = [];
const ORPHANS = '__orphans__';
let typeFilter = null, sortKey = 'name', sortDir = 1, selectedId = null, detailTab = 'cols';

// ---------- status ----------
function status(text, kind) { $('statustext').textContent = text; $('status').className = kind || ''; }

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
const readJson = async (rel, fallback) => { try { return JSON.parse(await readFile(rel)); } catch { return fallback; } };
const writeJson = (rel, o) => writeFile(rel, JSON.stringify(o, null, 2));
// Merge rather than replace. `.zoost.json` holds more than the binding — the workspace's own name
// lives there too — and a whole-object write from any one writer silently drops what the others put
// in it. The CRM learnt this twice; this side inherits the lesson rather than the bug.
const patchCfg = async (o) => writeJson(CFG, Object.assign({}, await readJson(CFG, {}), o));
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
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'zoost-root' });
    if (!(await ensurePerm(h))) { status('Permission to the folder was not granted.', 'bad'); return; }
    root = h; rootGranted = true; await window.idbHandle.set('rootDir', h);
    await refreshWorkspaces();
    status(`Working folder: ${h.name}`, 'ok');
  } catch (e) {
    if (e && e.name === 'AbortError') return;         // the user closed the picker — not an error
    status('Could not open that folder: ' + (e.message || e), 'bad');
  }
}
// A stored handle whose permission lapsed needs *authorisation*, not re-selection. Asking for the
// folder again is what made this panel more annoying than the CRM one: showDirectoryPicker() makes
// the user navigate the filesystem, requestPermission() is a one-click prompt.
async function grantRoot() {
  if (!root) { await pickRoot(); return; }
  try {
    if (!(await ensurePerm(root))) { status('Access denied — Zoost cannot read the working folder.', 'bad'); return; }
    rootGranted = true;
    status(`Access granted to ${root.name}.`, 'ok');
    await refreshWorkspaces();
  } catch (e) { status('Grant failed: ' + (e.message || e), 'bad'); }
}
async function restoreRoot() {
  if (!root) root = await window.idbHandle.get('rootDir');
  if (!root) return;
  rootGranted = await hasPerm(root);
  await refreshWorkspaces();
}

// Workspaces are found by reading each folder's .zoost.json, never by parsing folder names — that is
// what lets a folder be renamed without orphaning it.
async function listWorkspaces() {
  const base = await appRoot(false);
  if (!base) return [];
  const out = [];
  // The enumeration itself can fail — a handle whose permission lapsed, a folder moved or removed
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
    : needsGrant ? 'Chrome dropped the file-system permission for this folder. One click restores it \u2014 no folder picker.'
    : `Working folder: ${root.name} \u2014 click to choose a different one`;
  if (root && !rootGranted) {
    sel.innerHTML = '<option value="">access not granted</option>';
    dir = null; bound = null;
    // Word for word the CRM's. The blocker is one click, and saying nothing here left the status line
    // reading "Ready." while nothing could be read at all.
    status('Click \u00abGrant access\u00bb above, or anywhere in this panel \u2014 one click, no folder picker.', 'warn');
    render(); return updateButtons();
  }
  if (!root) { sel.innerHTML = '<option value="">no working folder yet</option>'; dir = null; bound = null; render(); return updateButtons(); }

  const list = await listWorkspaces();
  wsList = list;
  // Folders sitting directly in the working folder are the older flat layout. This is not a
  // compatibility fallback — nothing keeps working the old way — it is an empty state that says
  // what it sees instead of reporting "no workspaces" while the folders are plainly there.
  let stray = 0;
  try {
    for await (const e of root.values()) {   // same exposure as above; the catch below covers it
      if (e.kind !== 'directory' || APP_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
      try { await e.getFileHandle(CFG); stray++; } catch (_) {}
    }
  } catch (_) {}

  if (!list.length) {
    sel.innerHTML = `<option value="">${esc(root.name)}/${APP_DIR} — no workspaces yet</option>`;
    if (stray) status(`${stray} workspace folder(s) sit directly in «${root.name}». Each Zoost product keeps its own — move the Zoho Analytics ones into «${root.name}/${APP_DIR}/» and reopen the panel.`, 'warn');
    dir = null; bound = null; render(); return updateButtons();
  }
  sel.innerHTML = list.map((w) => `<option value="${escA(w.id)}" title="${escA(wsOptionTitle(w))}">${esc(wsOptionText(w))}</option>`).join('');
  const active = await window.idbHandle.get('activeWsAnalytics');
  const pick = list.find((w) => w.id === active) || list[0];
  sel.value = pick.id;
  await selectWorkspace(pick);
}

async function selectWorkspace(w) {
  dir = w.handle;
  bound = { workspace: w.id, name: w.cfg.name || '', origin: w.cfg.origin || '', label: w.cfg.label || '' };
  await window.idbHandle.set('activeWsAnalytics', w.id);
  await loadFromDisk();
  await refreshContext();
}

async function addWorkspace() {
  if (!root) return status('Pick a working folder first.', 'warn');
  if (!ctx || !ctx.workspace) return status('Open a Zoho Analytics workspace in the active tab first.', 'warn');
  setBusy(true, 'Creating the workspace folder…');
  try {
    const info = await toBridge({ cmd: 'workspaceInfo' });
    const base = await appRoot(true);
    if (!base) throw new Error(`could not create the ${APP_DIR}/ folder`);
    const folder = stemOf(info.name || 'workspace', info.workspace);
    const h = await base.getDirectoryHandle(folder, { create: true });
    dir = h;
    await patchCfg({ workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV, lastPull: null });
    setBusy(false, `Workspace «${info.name || info.workspace}» created. Press Pull all.`);
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
  const w = wsList.find((x) => x.id === $('ws').value);
  if (!w || !root) return;
  if (!confirm(`Delete the folder «${w.folder}» and everything in it?\n\nThis removes the local mirror only — nothing in Zoho Analytics is touched. You can pull it again at any time.`)) return;
  try {
    if (!(await ensurePerm(root))) return;
    const base = await appRoot(false);
    if (!base) { status('Could not open the workspace folder.', 'warn'); return; }
    await base.removeEntry(w.folder, { recursive: true });   // delete inside analytics/, never at the root
    await window.idbHandle.set('activeWsAnalytics', null);
    dir = null; bound = null;
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null;
    $('detail').classList.remove('show'); $('resizer').classList.remove('show'); selectedId = null;
    status(`Removed ${w.folder}.`, 'ok');
    await refreshWorkspaces();
    render();
  } catch (e) { status('Remove failed: ' + (e.message || e), 'warn'); }
}

// ---------- tab / bridge ----------
async function analyticsTabId() {
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  return a && HOST_RE.test(a.url || '') ? a.id : null;
}
async function ensureBridge(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'context' }); return true; }
  catch {
    // The one recovery the "never click-and-hope" rule allows: re-inject a script we own, once.
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content-bridge.js'] }); await sleep(60); return true; }
    catch { return false; }
  }
}
async function toBridge(msg) {
  const id = await analyticsTabId();
  if (id == null) throw new Error('The active tab is not Zoho Analytics.');
  await ensureBridge(id);
  const r = await chrome.tabs.sendMessage(id, msg);
  if (!r) throw new Error('No answer from the Zoho Analytics page.');
  // Rebuild the Error with the two fields the reply carries, or the classification made in the
  // bridge is thrown away one line after crossing the boundary — which is how "your role does not
  // allow this" would end up displayed as a bare status code again.
  if (r.ok === false) {
    const e = new Error(r.error || 'unknown error');
    e.status = r.status || 0; e.forbidden = !!r.forbidden;
    throw e;
  }
  return r;
}

// ---------- context bar + environment guard ----------
const guardOk = () => !!(bound && ctx && ctx.workspace && String(ctx.workspace) === String(bound.workspace));

async function refreshContext() {
  const el = $('ctx'), who = $('who'), bnd = $('bound');
  const id = await analyticsTabId();
  const localLbl = bound
    ? `<span class="rlbl local">Workspace</span>«${esc(bound.name || bound.workspace)}» ${esc(bound.workspace)}`
    : '<span class="rlbl local">Workspace</span><span>not bound yet</span>';

  if (id == null) {                                  // the ACTIVE tab is not Analytics
    ctx = null;
    $('offoverlay').classList.add('show');
    $('mmbar').classList.remove('show'); $('mmoverlay').classList.remove('show');
    el.className = 'offzoho'; who.innerHTML = 'Not on a Zoho Analytics tab'; bnd.innerHTML = localLbl;
    return updateButtons();
  }
  $('offoverlay').classList.remove('show');
  await ensureBridge(id);
  try { const r = await chrome.tabs.sendMessage(id, { cmd: 'context' }); ctx = r && r.ok ? r : null; } catch { ctx = null; }

  if (!ctx) { el.className = 'offzoho'; who.innerHTML = 'Zoho Analytics tab (not ready — reload it)'; bnd.innerHTML = localLbl; }
  else if (!ctx.workspace) { el.className = 'offzoho'; who.innerHTML = '<span class="rlbl remote">Zoho Analytics tab</span><span>no workspace open</span>'; bnd.innerHTML = localLbl; }
  else {
    who.innerHTML = `<span class="rlbl remote">Zoho Analytics tab</span><b>${esc(ctx.workspace)}</b>`;
    if (!bound) { el.className = 'unbound'; bnd.innerHTML = localLbl; }
    else if (guardOk()) { el.className = 'match'; bnd.innerHTML = localLbl + ' ✓'; }
    else { el.className = 'mismatch'; bnd.innerHTML = localLbl + ' ✗'; }
  }

  // The mismatch bar offers the one action that resolves it, and the overlay makes it impossible to
  // browse one workspace's mirror while looking at another. Same guarantee as the CRM panel's.
  const mm = !!(bound && ctx && ctx.workspace && !guardOk());
  $('mmbar').classList.toggle('show', mm);
  $('mmoverlay').classList.toggle('show', mm);
  if (mm) {
    $('detail').classList.remove('show'); $('resizer').classList.remove('show');
    $('mmtext').textContent = `The tab is workspace ${ctx.workspace}; this folder mirrors «${bound.name || bound.workspace}» (${bound.workspace}). Everything is disabled until they match.`;
    // Two ways out, as the CRM offers: take the tab to the bound workspace, or move this panel to
    // the workspace the tab is already in — switching to it if it exists locally, creating it if not.
    $('mmgo').textContent = `Switch tab → «${bound.name || bound.workspace}» ↗`;
    $('mmgo').onclick = () => switchTab();
    const match = (wsList || []).find((w) => w.id === String(ctx.workspace) && w.id !== bound.workspace);
    const sw = $('mmsw'); sw.className = 'znav';
    if (match) { sw.textContent = `Switch workspace → «${match.name || match.folder}»`; sw.onclick = () => { $('ws').value = match.id; selectWorkspace(match); }; }
    else { sw.textContent = `Create workspace for «${ctx.workspace}»`; sw.onclick = () => addWorkspace(); }
  }
  updateButtons();
}

// Both are a plain navigation to a URL we construct ourselves — no clicking through Zoho's UI, and
// nothing that depends on what the page happens to look like.
const homeUrl = () => (bound && bound.origin ? `${bound.origin}/workspace/${bound.workspace}` : 'https://analytics.zoho.eu/');
async function switchTab() {
  const id = await analyticsTabId();
  const url = homeUrl();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url, active: true });
}
async function openZohoHome() {
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = homeUrl();
  if (a && HOST_RE.test(a.url || '')) await chrome.tabs.update(a.id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
}

function updateButtons() {
  // Same rule as the CRM panel, and the same reason. Analytics had no such check at all: it left
  // the button offering to "create" a workspace that already existed, and reopened the same folder.
  // Harmless, and still a control saying it will do something it will not.
  const known = (wsList || []).some((w) => ctx && ctx.workspace && String(w.id) === String(ctx.workspace));
  $('wsadd').hidden = known;
  $('wsadd').disabled = busy || !root || !rootGranted || !ctx || !ctx.workspace;
  $('wsdel').disabled = busy || !dir || !wsList.length;
  $('wsrename').disabled = busy || !dir || !wsList.length;   // temporarily unavailable: pick a workspace and it works
  $('pull').disabled = busy || !dir || !guardOk();
  // Absent, not disabled, when there is nothing to retry — the CRM's equivalent does the same.
  // A greyed button still says "there is something here you cannot have", which is misleading
  // when there is no something. The label carries the count, so the button is self-explaining.
  const rb = $('retry');
  rb.style.display = pullFailed.length ? '' : 'none';
  rb.textContent = `Retry ${pullFailed.length} failed`;
  rb.disabled = busy || !dir || !guardOk();
  $('refresh').disabled = busy || (!dir && !(root && !rootGranted));
  const loaded = views.length > 0;
  $('export').disabled = busy || !loaded;
  $('exportmd').disabled = busy || !loaded;
  $('graph').disabled = busy || !Object.keys(schema).length;
  $('health').disabled = busy || !loaded;
  $('askai').disabled = busy || !loaded;
  // Back to the button's own title, never to nothing. This wrote '' on every state refresh, which
  // was survivable while the button said "Pull all" and is not now that it is a mark: the tooltip is
  // where the name lives. A control that loses its name on the first repaint has no name.
  $('pull').title = $('pull').disabled && dir && ctx && ctx.workspace && !guardOk()
    ? 'The active tab is a different workspace from the one selected here.'
    : PULL_TITLE;
}
function setBusy(on, text) { busy = on; status(text || (on ? 'Working…' : 'Ready.'), on ? 'busy' : ''); updateButtons(); }

// ---------- pull ----------
async function pullAll() {
  const onProgress = (m) => { if (m?.type === 'pullProgress') status(`Pulling ${m.stage}… ${m.done} / ${m.total}`, 'busy'); };
  chrome.runtime.onMessage.addListener(onProgress);
  setBusy(true, 'Pulling…');
  try {
    setBusy(true, 'Reading the workspace…');
    const info = await toBridge({ cmd: 'workspaceInfo' });

    setBusy(true, 'Reading the view list…');
    const vl = await toBridge({ cmd: 'listViews' });
    views = vl.views || []; folders = vl.folders || [];

    setBusy(true, 'Reading structure and relations…');
    const sc = await toBridge({ cmd: 'workspaceErd' });
    schema = sc.tables || {}; relations = sc.relations || [];

    const qIds = views.filter((v) => v.type === 'QueryTable').map((v) => v.id);
    setBusy(true, `Reading SQL… 0 / ${qIds.length}`);
    const sq = await toBridge({ cmd: 'pullSql', ids: qIds });
    sqls = sq.sql || {};

    const allIds = views.map((v) => v.id);
    setBusy(true, `Reading lineage… 0 / ${allIds.length}`);
    const dp = await toBridge({ cmd: 'scanDependencies', ids: allIds });
    deps = dp.deps || {};
    pullFailed = [].concat(sq.failed || [], dp.failed || []);

    mergeSchemaIntoViews();
    await writeToDisk(info);

    const orphans = views.filter(isOrphanCandidate).length;
    const cols = Object.values(schema).reduce((n, t) => n + t.columns.length, 0);
    setBusy(false, `${views.length} views · ${Object.keys(schema).length} tables · ${cols} columns · ${relations.length} relations · ${qIds.length} SQL · ${orphans} nothing depends on`
      + (pullFailed.length ? ` · ${pullFailed.length} could not be read` : ''));
    $('status').className = pullFailed.length ? 'warn' : 'ok';
    render();
  } catch (e) {
    // A refusal is not a fault, and saying "Pull failed: 403" for one sends the user looking for a
    // bug in Zoost instead of to whoever administers their Analytics roles.
    setBusy(false, e && e.forbidden
      ? `Your Zoho Analytics role does not grant access to this workspace${e.status ? ` (Zoho Analytics answered ${e.status})` : ''}. Nothing was written — what is on disk is unchanged.`
      : 'Pull failed: ' + (e.message || e));
    $('status').className = 'bad';
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
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
  const v = viewById().get(id);
  if (!v) return;
  setBusy(true, `Re-reading «${v.name}»…`);
  try {
    if (v.type === 'QueryTable') {
      const r = await toBridge({ cmd: 'pullSql', ids: [id] });
      if (r.sql && r.sql[id]) sqls[id] = r.sql[id];
    }
    const d = await toBridge({ cmd: 'viewDependencies', id });
    if (!deps) deps = {};
    deps[id] = { id: d.id, parents: d.parents, children: d.children, dashboards: d.dashboards };
    pullFailed = pullFailed.filter((f) => f.id !== id);
    await writeLineage(); await writeSql();
    setBusy(false, `«${v.name}» re-read.`); $('status').className = 'ok';
    render(); await openDetail(id);
  } catch (e) {
    setBusy(false, `Could not re-read «${v.name}»: ` + (e.message || e));
    $('status').className = 'bad';
  }
}

async function retryFailed() {
  const ids = [...new Set(pullFailed.map((f) => f.id))];
  if (!ids.length) return;
  const onProgress = (m) => { if (m?.type === 'pullProgress') status(`Retrying ${m.stage}… ${m.done} / ${m.total}`, 'busy'); };
  chrome.runtime.onMessage.addListener(onProgress);
  setBusy(true, `Retrying ${ids.length} item(s)…`);
  try {
    const qIds = ids.filter((i) => { const v = viewById().get(i); return v && v.type === 'QueryTable'; });
    const still = [];
    if (qIds.length) { const r = await toBridge({ cmd: 'pullSql', ids: qIds }); Object.assign(sqls, r.sql || {}); still.push(...(r.failed || [])); }
    const r2 = await toBridge({ cmd: 'scanDependencies', ids });
    if (!deps) deps = {};
    Object.assign(deps, r2.deps || {}); still.push(...(r2.failed || []));
    pullFailed = still;
    mergeSchemaIntoViews();
    await writeLineage(); await writeSql();
    setBusy(false, pullFailed.length ? `${pullFailed.length} still unreadable.` : 'All previously failed items are now in.');
    $('status').className = pullFailed.length ? 'warn' : 'ok';
    render();
  } catch (e) {
    setBusy(false, 'Retry failed: ' + (e.message || e)); $('status').className = 'bad';
  } finally { chrome.runtime.onMessage.removeListener(onProgress); }
}

// Split out so a single-item refresh rewrites only what it touched, instead of the whole mirror.
async function writeLineage() {
  if (!dir) return;
  await writeJson('lineage.json', { workspace: bound && bound.workspace, deps, failed: pullFailed });
}
async function writeSql() {
  if (!dir) return;
  const index = await readJson('sql/index.json', {});
  for (const [id, q] of Object.entries(sqls)) {
    if (typeof q.sql !== 'string') continue;              // not re-read this session; its file is current
    const v = viewById().get(id);
    const stem = q.stem || stemOf(v ? v.name : id, id);
    await writeFile(`sql/${stem}.sql`, q.sql);
    index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
  }
  await writeJson('sql/index.json', index);
}

async function writeToDisk(info) {
  await writeJson('views.json', { workspace: info.workspace, pulledAt: new Date().toISOString(), folders, views });
  await writeJson('schema.json', { workspace: info.workspace, tables: schema, relations });
  await writeJson('lineage.json', { workspace: info.workspace, deps, failed: pullFailed });
  // One .sql per query table, so the workspace is diffable in git — that is the whole point of the
  // mirror. The index keeps the id-to-file mapping and the column-level lineage beside it.
  const index = {};
  for (const [id, q] of Object.entries(sqls)) {
    const v = views.find((x) => x.id === id);
    const stem = stemOf(v ? v.name : id, id);
    await writeFile(`sql/${stem}.sql`, typeof q.sql === 'string' ? q.sql : '');
    index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
  }
  await writeJson('sql/index.json', index);
  await patchCfg({
    workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV,
    lastPull: new Date().toISOString(),
    counts: { views: views.length, folders: folders.length, tables: Object.keys(schema).length, relations: relations.length, sql: Object.keys(sqls).length },
  });
  bound = { workspace: info.workspace, name: info.name, origin: info.origin, label: (await readJson(CFG, {})).label || '' };
}

async function loadFromDisk() {
  const v = await readJson('views.json', null);
  const s = await readJson('schema.json', null);
  const l = await readJson('lineage.json', null);
  views = (v && v.views) || []; folders = (v && v.folders) || [];
  schema = (s && s.tables) || {}; relations = (s && s.relations) || [];
  deps = l && l.deps ? l.deps : null; pullFailed = (l && l.failed) || [];
  sqls = {};
  const index = await readJson('sql/index.json', null);
  if (index) for (const [id, e] of Object.entries(index)) sqls[id] = { id, sql: null, stem: e.stem, parents: e.parents || [], sources: e.sources || {} };
  mergeSchemaIntoViews();
  selectedId = null; $('detail').classList.remove('show'); $('resizer').classList.remove('show');
  render();
  if (views.length) status(`${views.length} views loaded from disk${v && v.pulledAt ? ' · pulled ' + v.pulledAt.slice(0, 10) : ''}.`, '');
}

// "Empty" and "unreadable" are different facts and were the same message: every surface wrote
// `body || 'could not be read'`, and an empty string is falsy. So a query Analytics returned empty —
// or one whose file was written empty by the bug above — was reported as never having been read,
// which sent the assistant off reconstructing SQL it could simply have been told was absent.
//   null  → the file is not there or could not be opened
//   ''    → Analytics answered with an empty query
const SQL_UNREADABLE = '(the .sql file could not be read — use Pull on this view to fetch it again)';
const SQL_EMPTY = '(Zoho Analytics returned this query table with no SQL text at all)';
const sqlText = (body) => (body == null ? SQL_UNREADABLE : (body.trim() ? body : SQL_EMPTY));

// SQL bodies are not held in memory after a reload — they are read from their file on demand, which
// is also what keeps a large workspace from sitting in the panel's heap.
async function sqlBodyOf(id) {
  const q = sqls[id];
  if (!q) return null;
  if (typeof q.sql === 'string') return q.sql;
  try { q.sql = await readFile(`sql/${q.stem}.sql`); } catch { q.sql = null; }
  return q.sql;
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
// sort — but only Tables and QueryTables have it. Presentation views still only have Zoho's
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
//   out — this column points at another table  (the classic foreign key)
//   in  — another table's column points at this one
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
// A view we cannot resolve is shown by its id — which is at least true. Returning the raw
// `.name` was how `undefined` reached the diagram as if it were a table's name.
const nameOf = (id, m) => (m.get(id) && m.get(id).name) || String(id == null ? '?' : id);

// Walk PARENT_ID up to the first view that actually has columns. Only Tables and QueryTables carry
// structure; a Pivot or a Report is a presentation of one of them, sometimes several steps removed.
// Following the chain is what lets the panel answer "what is the structure of this report" instead
// of shrugging — and it costs nothing, because PARENT_ID is already in the view list.
// Returns the chain from the view down to the data-bearing root, or null if it dangles.
function structureChain(v, m) {
  const chain = []; const seen = new Set();
  let cur = v;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id); chain.push(cur);
    if (schema[cur.id]) return chain;
    cur = cur.parent ? m.get(cur.parent) : null;
  }
  return null;               // no data source reachable — say so rather than showing an empty table
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

// One line, not two rows of chips: the CRM made this call already and wrote down why — seven
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
  sel.value = typeFilter || '';
}

function visibleViews() {
  const q = $('find').value.trim().toLowerCase();
  let out = views;
  if (typeFilter === ORPHANS) out = out.filter(isOrphanCandidate);
  else if (typeFilter) out = out.filter((v) => v.type === typeFilter);
  if (q) {
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
      // Views with no timestamp sort last in both directions — an absent value is not "oldest".
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
 * changes — which is what happened when a folder whose permission had lapsed was told to pick a
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
    return '<b>Folder access is not granted.</b> Press <b>\u{1F513} Grant access</b> above \u2014 or simply '
      + 'click anywhere in this panel, which does the same. One click, no folder picker.';
  }
  if (!wsList.length) {
    return '<b>No workspace here yet.</b> Open a Zoho Analytics workspace in the active tab \u2014 its URL '
      + 'looks like <code>/workspace/&lt;id&gt;</code> \u2014 then press <b>+ Workspace</b>.';
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
    // click would do — and it is the step they have already done that gets repeated at them.
    list.innerHTML = `<div class="empty">${emptyReason()}</div>`;
    return;
  }
  const rows = visibleViews();
  if (!rows.length) {
    list.innerHTML = `<div class="empty"><b>No view matches.</b>
      ${typeFilter ? 'The type filter and the' : 'The'} search box are narrowing ${views.length} views down to none.
      The search also looks inside column names. Clear it to see them all again.</div>`;
    return;
  }
  // The number is the answer's headline; clicking it opens the breakdown. Naming the same fact
  // "Used by" in the list and "Read by" in the detail is how a reader ends up unsure they are
  // looking at the same thing — so it is one name now, and one click away from its detail.
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
    // numbers and read as «419» — a mark that changes how a number reads is worse than no mark, and
    // this one is in the one column where the reader is scanning figures. Brackets cannot be mistaken
    // for a digit, the muted colour still separates it from an own count, and the tooltip still names
    // the view the structure comes from.
    return `<span title="${escA('columns inherited from ' + src.name + ' — this view has none of its own')}" style="color:var(--muted)">(${schema[src.id].columns.length})</span>`;
  };
  list.innerHTML = `<table class="vtbl">
    <thead><tr>
      <th>View</th><th>Type</th><th class="num" title="Columns. A number in brackets is inherited: the view has none of its own, and the count is the view it is built on.">Cols</th>
      <th class="num" title="As Zoho words it, in your interface language — not sortable, see the note below">Design</th>
      <th class="num">Data</th>${deps ? '<th class="num" title="How many views read from it, plus the dashboards it appears on \u2014 the Lineage tab breaks the same figure down">Read by</th>' : ''}
    </tr></thead><tbody>${rows.map((v) => `<tr data-id="${escA(v.id)}"${v.id === selectedId ? ' class="sel"' : ''}>
      <td><div class="vname">${esc(v.name)}</div><div class="vsub">${esc(v.folderName || '—')}${v.owner ? ' · ' + esc(v.owner) : ''}${v.system ? ' · <span class="sysflag" title="Zoho Analytics flags this as a system table — it came from a connected source, you did not build it">system</span>' : ''}</div></td>
      <td><span class="vtype">${esc(v.type)}</span></td>
      <td class="num">${colCount(v)}</td>
      ${v.designModifiedAt
        ? `<td class="num" title="${escA(v.designModifiedBy ? 'by ' + v.designModifiedBy : '')}">${esc(shortDate(v.designModifiedAt))}</td>`
        : `<td class="num verbatim" title="${escA('Zoho gives no machine-readable value for this one — shown as it sends it' + (v.designModifiedBy ? ', by ' + v.designModifiedBy : ''))}">${esc(v.designModifiedText || '—')}</td>`}
      <td class="num">${esc(shortDate(v.dataModifiedAt))}</td>
      ${deps ? `<td class="num">${usedBy(v)}</td>` : ''}
    </tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => openDetail(tr.dataset.id); });
  list.querySelectorAll('a.fk[data-lin]').forEach((a2) => {
    a2.onclick = (ev) => { ev.stopPropagation(); detailTab = 'lin'; openDetail(a2.dataset.lin); };
  });
}

// ---------- detail ----------
// Every time the pane shows something else, it shows it from the top. Without this the scrollbar
// stays where the previous item left it and the reader is looking at row 40 of a table they have
// never seen. Run twice — once now, once after layout — because content rendered on the next frame
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
  selectedId = id;
  const v = viewById().get(id);
  if (!v) return;
  $('detail').classList.add('show'); $('resizer').classList.add('show');
  $('dtitle').textContent = v.name;
  // A Zoho read, so it is worded and coloured like every other Zoho read: "Pull", .zbtn. The ↻ glyph
  // means "reload from disk / re-grant folder access" in the CRM panel and must keep meaning only
  // that here — a symbol that fetches from Zoho in one app and reads the disk in the other is worse
  // than no symbol.
  $('dpull').disabled = busy || !guardOk();
  $('dpull').title = guardOk()
    ? 'Pull — this view only, its SQL and its lineage; «Pull all» does every view'
    : 'The active tab is a different workspace, so nothing can be pulled';
  $('dpull').onclick = () => pullOne(v.id);
  // Focused ER, exactly as the CRM opens a module's relations: the window takes it from here and
  // the depth stays adjustable there.
  const chain = structureChain(v, viewById());
  const srcId = chain ? chain[chain.length - 1].id : null;
  $('dgraph').disabled = !srcId || !relationsOf(srcId).length;
  $('dgraph').title = srcId && relationsOf(srcId).length
    ? 'ER diagram — opened on this table, in its own window'
    : 'ER diagram — this table takes part in no relation, so there is nothing to draw';
  $('dgraph').onclick = () => openSchemaGraph(srcId, 2);
  $('dtitle').title = `${v.type} · ${v.folderName || 'no folder'} · id ${v.id}`;
  // A tab that cannot say anything about this view is disabled, not shown and silently empty.
  $('tab_sql').disabled = !sqls[id];
  $('tab_rel').disabled = !relationsOf(id).length;
  $('tab_lin').disabled = !deps;
  if (detailTab === 'sql' && !sqls[id]) detailTab = 'cols';
  if (detailTab === 'rel' && !relationsOf(id).length) detailTab = 'cols';
  if (detailTab === 'lin' && !deps) detailTab = 'cols';
  document.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === detailTab));
  await renderDetail(v);
  resetDetailScroll();
  render();
}

async function renderDetail(v) {
  const body = $('dbody');
  const m = viewById();
  if (detailTab === 'cols') {
    const chain = structureChain(v, m);
    if (!chain) {
      body.innerHTML = `<div class="dpad"><div class="empty" style="padding:0"><b>No structure to show.</b>
        A ${esc(v.type)} has no columns of its own, and Zoho Analytics does not tell us which view it is
        built on — so there is nothing here that would be true.</div></div>`;
      return;
    }
    const src = chain[chain.length - 1];
    const t = schema[src.id];
    // When the structure is inherited, say whose it is and through what — a column list attributed
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
    // Zoho's own `relationstring` is shown as it writes it — "(A.col)=(B.col)". Re-rendering the
    // join in our own words would be an interpretation, and the point here is the fact, not our
    // phrasing of it. The direction is stated because a lookup is not symmetric.
    body.innerHTML = '<div class="dpad">' + rs.map((r) => {
      const out = r.source === v.id;
      return `<div class="rel"><b>${esc(out ? '→ ' + r.targetName : '← ' + r.sourceName)}</b><br>${esc(r.relation)}</div>`;
    }).join('') + '</div>';
    return;
  }
  if (detailTab === 'sql') {
    const sql = await sqlBodyOf(v.id);
    body.innerHTML = '<div class="dpad">' + (sql && sql.trim()
      ? `<pre class="sql">${esc(sql)}</pre>`
      : `<div class="empty" style="padding:0"><b>${sql == null ? 'The SQL file could not be read.' : 'No SQL text.'}</b> ${esc(sqlText(sql))}</div>`) + '</div>';
    return;
  }
  // lineage
  const d = deps ? deps[v.id] : null;
  if (!d) { body.innerHTML = '<div class="dpad"><div class="empty" style="padding:0"><b>No lineage for this view.</b> Use Pull above to fetch just this one.</div></div>'; return; }
  const li = (arr) => arr.length
    ? `<ul>${arr.map((x) => `<li>${esc(nameOf(x.id, m))} <span class="lv">level ${x.level}</span></li>`).join('')}</ul>`
    : '<div class="none">none</div>';
  const dash = d.dashboards.length
    ? `<ul>${d.dashboards.map((x) => `<li>${esc(nameOf(x, m))}</li>`).join('')}</ul>`
    : '<div class="none">none</div>';
  const q = sqls[v.id];
  const cols = q && q.sources
    ? Object.entries(q.sources).map(([tid, s]) => `<li>${esc(s.name || nameOf(tid, m))} <span class="lv">${s.columns.length} columns involved</span></li>`).join('')
    : '';
  body.innerHTML = '<div class="dpad">'
    + `<div class="lin"><h5>Reads from</h5>${li(d.parents)}</div>`
    + `<div class="lin"><h5>Read by <span class="lv">\u2014 the same count the list shows</span></h5>${li(d.children)}</div>`
    + `<div class="lin"><h5>On dashboards</h5>${dash}</div>`
    + (cols ? `<div class="lin"><h5>Source columns involved</h5><ul>${cols}</ul></div>` : '')
    + '</div>';
}

// Local only. Re-reads the mirror from disk, or takes the chance to re-grant a lapsed folder
// permission — it never talks to Zoho. Same meaning, same glyph and same title as the CRM panel's.
async function refreshLocal() {
  if (root && !rootGranted) { await grantRoot(); return; }
  if (!dir) return;
  setBusy(true, 'Reloading from disk…');
  await loadFromDisk();
  setBusy(false);
}

// ---------- schema graph ----------
// The graph window is the CRM one, unchanged in its engine: same ER layout with the concentric and
// force branches, the same depth control and the same layout sliders. It consumes a generic
// node/edge shape, so the job here is to express the Analytics workspace in that shape rather than
// to write a second diagram — which is also why the two windows behave identically for anyone who
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
    workspace: { instance: bound ? (bound.name || bound.workspace) : null, org: bound ? bound.workspace : null },
  };
}

async function openSchemaGraph(focusId, depth) {
  try {
    if (!Object.keys(schema).length) throw new Error('nothing pulled yet — run Pull all first');
    const g = buildSchemaGraph();
    if (!g.counts.nodes) throw new Error('no tables in this workspace');
    if (focusId && g.nodes[focusId]) { g.focus = focusId; g.depth = Math.max(1, depth || 2); }
    await chrome.storage.local.set({ graphData: g });
    await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html'), type: 'normal', width: 1240, height: 840 });
    status(`Schema: ${g.counts.nodes} tables, ${g.counts.edges} relations.`, 'ok');
  } catch (e) { status('Schema graph error: ' + (e.message || e), 'bad'); }
}

// ---------- AI ----------
// Ported from the CRM panel: same config shape, same storage key, same streaming agent loop, same
// single-shot OpenAI path with the max_tokens/max_completion_tokens retry. What differs is what the
// tools read — views, columns, relations, SQL and lineage instead of functions and modules — and the
// SQL guardrail, which is the one thing here not derived from the user's own workspace.
let aiMessages = [];
let aiBusy = false, aiSeedTruncated = false, aiSeedWarned = false, aiSeedOmitted = [];

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
// the API key again — stated in Settings, and not softened here.
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
 * the extension. It has surfaced three times now — the agent loop, and renaming a workspace — so this
 * is deliberately not AI-specific. Translated where it surfaces, so a user who meets it once more is told which button to
 * press. Nothing branches on the class name — it is matched, not parsed, and anything unrecognised is
 * passed through untouched rather than dressed up.
 */
function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/not allowed by the user agent|NotAllowedError/i.test(m)) {
    return 'The working folder is no longer readable — Chrome lets that permission lapse after a while. '
      + 'Press \u21bb Refresh in the toolbar to grant it again, then ask once more. Nothing was lost.';
  }
  return 'Error: ' + m;
}

/** Re-grant the working folder before the assistant touches it.
 *
 * Chrome lets a File System Access permission lapse after inactivity, and every read then throws
 * `NotAllowedError: The request is not allowed by the user agent or the platform in the current
 * context.` — a message that names neither the folder nor the remedy. The AI path reads the mirror
 * directly (the seed index, the tools, the graph) and was the one path that never asked first, so it
 * surfaced as "the chat is broken until I click an item and come back": clicking an item runs
 * ensurePerm() under a real gesture and fixes it as a side effect.
 *
 * It has to happen *here*, at the click. requestPermission() needs transient user activation, so the
 * same call made inside the agent loop — after a network round trip to the model — is refused for want
 * of a gesture, which is the very error being reported. Same fix the Health view already carries.
 */
async function aiEnsureFiles() {
  if (!dir) return true;
  try { return await ensurePerm(dir); } catch (_) { return false; }
}

/** The verdict on a passphrase goes beside the field, because that is where the eye is — and because
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
    aiLockMsg('That passphrase did not open the key. Either it is wrong, or the stored key is damaged — the two cannot be told apart. If it is lost, open Settings and use «Remove the protection», then enter the API key again.');
    status('Wrong passphrase.', 'warn');
    $('ailockpass').select(); return;
  }
  await window.ZOOST_KEYVAULT.remember(prov, key);
  aiLockMsg(''); aiShowLock(false); status('API key unlocked for this browser session.', 'ok');
}
function aiTrunc(x, n) { const t = x || ''; return t.length > n ? t.slice(0, n) + '\n… (truncated)' : t; }

const aiFindView = (q) => {
  if (!q) return null;
  const low = String(q).toLowerCase();
  return views.find((v) => v.id === String(q)) || views.find((v) => (v.name || '').toLowerCase() === low)
    || views.find((v) => (v.name || '').toLowerCase().includes(low)) || null;
};
function aiStructureText(v) {
  const m = viewById();
  const chain = structureChain(v, m);
  if (!chain) return `${v.name} (${v.type}) has no columns and no reachable source.`;
  const src = chain[chain.length - 1], t = schema[src.id];
  const { out, inc } = foreignKeys(src.id);
  let s2 = `${src.name} (${t.kind}${t.system ? ', system table — synced by Zoho, not built by the user' : ''})`;
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
// The order below is the answer. Data objects are the vocabulary — you cannot write a query, follow
// a foreign key or judge whether something already exists without knowing the tables, so they are
// never dropped. Reports and dashboards are findable by name through list_views, so they go first if
// something must. Whatever is left out is *named as left out*, in the prompt itself, with what to
// call instead — an index that is silently short is worse than one that is honestly partial.
const AI_SEED_CAP_DEFAULT = 72000;
let aiSeedSize = 0;                     // what the last index actually came to, shown in the chat

async function aiBuildSeed(cap) {
  cap = Math.max(4000, Number(cap) || AI_SEED_CAP_DEFAULT);
  const m = viewById();
  const byType = new Map();
  for (const v of views) byType.set(v.type, (byType.get(v.type) || 0) + 1);
  const cols = Object.values(schema).reduce((n, t) => n + t.columns.length, 0);

  const header = `Workspace: ${bound ? (bound.name || bound.workspace) : '?'} (id ${bound ? bound.workspace : '?'})\n`
    + `${views.length} views — ` + [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') + '\n'
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

  aiSeedOmitted = omitted;
  if (out.length > cap) {          // even the tables alone overflow: an enormous workspace
    aiSeedOmitted = [`part of the table list — this workspace is larger than the index can hold`];
    out = aiTrunc(out, cap);
  }
  aiSeedTruncated = omitted.length > 0 || out.length >= cap;
  if (omitted.length) {
    out += `\nNOT LISTED ABOVE: ${omitted.join(' and ')}. They exist and you can find them by name`
      + ` with list_views (it takes a name substring and a type) — do not assume a view is absent`
      + ` because it is not in this index.\n`;
  }
  aiSeedSize = out.length;
  return out;
}

// The extension's own help, so "how do I export this?" is answered where the user already is
// rather than by sending them to a website — which would move the question rather than answer it.
// Guarded: a missing script must cost the product primer, never the whole assistant.
function productHelp() {
  try { return '\n' + window.ZOOST_PRODUCT_HELP.text() + '\n'; } catch (_) { return ''; }
}

async function aiSystemPrompt(withTools, cap) {
  const seed = await aiBuildSeed(cap);
  let focus = '';
  const cur = selectedId ? viewById().get(selectedId) : null;
  if (cur) {
    focus = `\n# CURRENT FOCUS\nThe user is looking at ${cur.name} (${cur.type}).\n${aiStructureText(cur)}\n`;
    const q = sqls[cur.id];
    if (q) { const body = await sqlBodyOf(cur.id); if (body) focus += `\nIts SQL:\n\u0060\u0060\u0060sql\n${aiTrunc(body, 4000)}\n\u0060\u0060\u0060\n`; }
  }
  const toolsLine = withTools
    ? 'You have READ-ONLY tools over the local mirror: list_views, get_view, get_structure, get_sql, search_sql, search_columns, get_relations, who_uses, orphans. Use them to fetch exact structure and SQL instead of guessing. get_view returns the whole dossier for one view — structure, foreign keys, SQL and lineage — so prefer it over three narrower calls, and prefer search_columns or search_sql over opening views one at a time.'
    : 'Answer from the WORKSPACE INDEX and CURRENT FOCUS below. If you need a structure or a query that is not shown, say which view you would need rather than inventing it.';
  return `You are an expert assistant for Zoho Analytics, working on the user\u2019s real workspace.\n${toolsLine}\n`
    + `Reference real view and column names. Zoost is read-only: it never creates, edits or deletes anything in Zoho Analytics, and it never reads the rows in a table \u2014 so you know structure, relations and SQL, never data values. Never claim to know what is in the data.\n`+ `If a query table's SQL comes back as unreadable or empty, say so and stop there. Do not reconstruct what a query probably does from column names and lineage and present it as its logic \u2014 a plausible reconstruction of code the user cannot check is worse than \"I could not read it\".\n\n`
    + `${window.ZOHO_ANALYTICS_SQL.text()}\n`
    + `${productHelp()}${focus}\n# WORKSPACE INDEX\n${seed}`;
}

const AI_TOOLS = [
  { name: 'list_views', description: 'List views in the workspace. Optionally filter by a substring of the name, by type (Table, QueryTable, Pivot, AnalysisView, SummaryView, Report, Dashboard), and/or by a minimum column count.', input_schema: { type: 'object', properties: { filter: { type: 'string' }, type: { type: 'string' }, min_columns: { type: 'number' } } } },
  { name: 'get_view', description: 'THE DOSSIER for one view, in a single call: type, folder, owner, dates, what it is built on, its full column list with data types and foreign keys, its SQL if it is a query table, its relations, and what reads from it. Prefer this over calling get_structure, get_sql and who_uses separately.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_structure', description: 'Columns and Zoho data types of a table or query table, with each column\u2019s foreign keys in both directions. For a report or pivot, returns the structure it inherits and says so.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_sql', description: 'The SQL source of a query table, with the source tables and the columns it involves.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'search_sql', description: 'Full-text search across every query table\u2019s SQL. Returns the view names that match.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'search_columns', description: 'Find which tables have a column whose name matches. Use this to answer "where is this data" before writing a query.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_relations', description: 'Relations (joins) a table takes part in, in both directions, as Zoho writes them. Omit the name for the whole workspace.', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'who_uses', description: 'What reads from a view, transitively, plus the dashboards it appears on.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'orphans', description: 'Views that nothing in the workspace depends on. Candidates, not a verdict.', input_schema: { type: 'object', properties: {} } },
];

// A tool that answers with nine hundred lines has not answered. Cap the list, say how many there
// were, and say how to narrow — the model can then ask a better question instead of drowning in the
// first one.
function aiCap(lines, total, how, limit = 120) {
  if (lines.length <= limit) return lines.join('\n');
  return lines.slice(0, limit).join('\n')
    + `\n… and ${total - limit} more (${total} in all). ${how}`;
}

async function aiExecTool(name, input) {
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
  const v = name === 'orphans' || name === 'get_relations' ? null : aiFindView(input.name);
  if (!v && name !== 'orphans' && !(name === 'get_relations' && !input.name)) return 'View not found: ' + input.name;
  if (name === 'get_view') {
    // Everything about one view in one step. It used to answer the metadata alone, so any real
    // question cost three or four calls — which is how a limit of eight ran out on a single
    // question. The tools are the expensive part of an agent loop; making each one answer more is
    // worth more than adding steps.
    const d = deps && deps[v.id];
    let out = `${v.name}\ntype: ${v.type}\nfolder: ${v.folderName || '(none)'}\nowner: ${v.owner || ''}\n`
      + `built_on: ${v.parent && m.get(v.parent) ? m.get(v.parent).name : '(nothing — it is a data object)'}\n`
      + `design_changed: ${v.designModifiedAt ? shortDate(v.designModifiedAt) : v.designModifiedText + ' (Zoho\u2019s own text, not machine-readable)'}\n`
      + `data_changed: ${shortDate(v.dataModifiedAt)}\n`
      + `system_table: ${!!v.system}\ndescription: ${v.description || '(none)'}\n`;
    out += '\n' + aiStructureText(v) + '\n';
    const rs = relationsOf(v.id);
    if (rs.length) out += `\nrelations (${rs.length}):\n` + rs.map((r) => `${r.sourceName} → ${r.targetName}   ${r.relation}`).join('\n') + '\n';
    const q = sqls[v.id];
    if (q) {
      const body = await sqlBodyOf(v.id);
      const src = Object.entries(q.sources || {}).map(([, sd]) => `${sd.name} (${sd.columns.length} columns involved)`).join(', ');
      out += `\nsource tables: ${src || '(none recorded)'}\nSQL:\n${sqlText(body)}\n`;
    }
    out += d
      ? `\nreads_from: ${d.parents.map((x) => nameOf(x.id, m)).join(', ') || '(none)'}\nread_by: ${d.children.map((x) => nameOf(x.id, m)).join(', ') || '(none)'}\non_dashboards: ${d.dashboards.map((x) => nameOf(x, m)).join(', ') || '(none)'}\n`
        + 'Note: Zoho Analytics only knows what its own views read from each other — a shared link, a scheduled export or an API consumer is invisible to it.'
      : '\nlineage: not pulled';
    return out;
  }
  if (name === 'get_structure') return aiStructureText(v);
  if (name === 'get_sql') {
    const q = sqls[v.id];
    if (!q) return `${v.name} is a ${v.type}, not a query table — it has no SQL.`;
    const body = await sqlBodyOf(v.id);
    const src = Object.entries(q.sources || {}).map(([, sdef]) => `${sdef.name} (${sdef.columns.length} columns involved)`).join(', ');
    return `${v.name}\nsource tables: ${src || '(none recorded)'}\n\n${sqlText(body)}`;
  }
  if (name === 'search_sql') {
    // With the matching line beside each name the model can usually answer without opening the
    // query at all — a bare list of names made every hit cost another call.
    const q = String(input.query || '').toLowerCase(); if (!q) return '(empty query)';
    const hits = [];
    for (const vv of views.filter((x) => x.type === 'QueryTable')) {
      const body = await sqlBodyOf(vv.id);
      if (!body || !body.toLowerCase().includes(q)) continue;
      const line = body.split('\n').find((l) => l.toLowerCase().includes(q)) || '';
      hits.push(`${vv.name}\n    ${line.trim().slice(0, 160)}`);
    }
    return hits.length ? `${hits.length} query table(s) contain "${input.query}":\n` + aiCap(hits, hits.length, 'Use a longer substring to narrow.', 60) : '(no matches)';
  }
  if (name === 'search_columns') {
    const q = String(input.query || '').toLowerCase(); if (!q) return '(empty query)';
    const hits = [];
    for (const [id, t] of Object.entries(schema)) {
      const cols = t.columns.filter((c) => c.name.toLowerCase().includes(q));
      if (cols.length) hits.push(`${t.name} [${t.kind}]: ` + cols.map((c) => `${c.name} (${c.type})`).join(', '));
    }
    return hits.length ? `${hits.length} table(s) have a matching column:\n` + aiCap(hits, hits.length, 'Use a longer substring to narrow.') : '(no matches)';
  }
  if (name === 'get_relations') {
    const list = v ? relationsOf(v.id) : relations;
    if (!list.length) return v ? `${v.name} takes part in no relation.` : 'No relations in this workspace.';
    return `${list.length} relation(s):\n` + aiCap(list.map((r) => `${r.sourceName} → ${r.targetName}   ${r.relation}`), list.length, 'Pass a table name to see only its relations.');
  }
  if (name === 'who_uses') {
    const d = deps && deps[v.id];
    if (!d) return `No lineage for ${v.name} — it was not pulled.`;
    return `${v.name} is read by ${d.children.length} view(s) and appears on ${d.dashboards.length} dashboard(s).\n`
      + (d.children.map((x) => `- ${nameOf(x.id, m)} (level ${x.level})`).join('\n') || '(nothing reads from it)')
      + `\nNote: Zoho Analytics only knows what its own views read from each other. A shared link, a scheduled export, an embedded report or an API consumer is invisible to it.`;
  }
  if (name === 'orphans') {
    if (!deps) return 'Lineage was not pulled, so this cannot be answered.';
    const o = views.filter(isOrphanCandidate);
    const byType = new Map();
    for (const x of o) byType.set(x.type, (byType.get(x.type) || 0) + 1);
    return `${o.length} candidate(s) that nothing in this workspace depends on — candidates, not a verdict.\n`
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
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\n/g, '<br>');
  t = t.replace(/\uE000(\d+)\uE001/g, (mm, i) => codes[+i]);
  return t;
}
function aiToolArg(input) { try { const t = JSON.stringify(input || {}); return t.length > 60 ? t.slice(0, 57) + '…' : t; } catch (_) { return ''; } }
function aiToolEvent(name, input) { aiMessages.push({ role: 'tool', content: `🔧 ${name}(${aiToolArg(input)})` }); aiRenderMessages(); }

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
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const post = async (limitField) => fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
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
  if (!txt && c && c.finish_reason === 'length') return '(The model hit the output limit before writing anything — this usually means the workspace context is too large for it. Try a model with a bigger context window.)';
  return txt;
}

function aiRenderMessages() {
  const box = $('aimsgs');
  if (!aiMessages.length && !aiBusy) { box.innerHTML = '<div class="aimsg assistant"><div class="aitext">Ask me anything about this workspace — I can read structures, follow foreign keys, open the SQL of a query table, search columns, and say what depends on what.</div></div>'; return; }
  box.innerHTML = aiMessages.map((m) => m.role === 'tool' ? `<div class="aitool">${esc(m.content)}</div>` : `<div class="aimsg ${m.role}"><div class="airole">${m.role === 'user' ? 'You' : 'AI'}</div><div class="aitext">${m.role === 'assistant' ? aiMarkdown(m.content) : esc(m.content).replace(/\n/g, '<br>')}</div></div>`).join('')
    + (aiBusy ? '<div class="aiwait"><i></i><i></i><i></i> thinking…</div>' : '');
  box.scrollTop = box.scrollHeight;
}

async function aiSend() {
  const cfg = await aiGetCfg();
  aiEngineChrome();
  if (aiLocked(cfg)) { aiShowLock(true); return; }
  if (!(await aiEnsureFiles())) { status('Folder access needs re-granting \u2014 press \u21bb Refresh, then ask again.', 'warn'); return; }
  if (!aiActiveReady(cfg)) { openSettings(); status('Set the model and API key in Settings (just opened), then try again.', 'warn'); return; }
  const inp = $('aiinput'); const text = inp.value.trim(); if (!text) return;
  inp.value = ''; aiMessages.push({ role: 'user', content: text });
  aiBusy = true; $('aisend').disabled = true; aiRenderMessages(); status('AI thinking…', 'busy');
  try {
    const apiMessages = aiMessages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim() !== '').map((m) => ({ role: m.role, content: m.content }));
    const withTools = cfg.active === 'anthropic';
    const system = await aiSystemPrompt(withTools, cfg.seedCap);
    // The workspace index sent to the model is capped. If it was cut, say so once — do not let the
    // user assume the model saw everything. Claude can still look things up; OpenAI cannot.
    if (aiSeedTruncated && !aiSeedWarned) {
      aiSeedWarned = true;
      const what = aiSeedOmitted.length ? aiSeedOmitted.join(' and ') : 'part of the index';
      aiMessages.push({ role: 'tool', content: `ℹ️ Large workspace: ${what} could not fit in the index sent with each message. `
        + (withTools ? 'Claude can still find them by name with its tools — the tables are always included in full.' : 'OpenAI answers in one pass and cannot look them up, so ask about specific views by name.') });
      aiRenderMessages();
    }
    if (withTools) await aiRunAnthropicAgent(cfg.anthropic, apiMessages, system, AI_TOOLS, cfg.maxIter || 20);
    else { const reply = await aiCall(cfg, apiMessages, system); aiMessages.push({ role: 'assistant', content: reply || '(empty response)' }); }
    status('', '');
  } catch (e) { aiMessages.push({ role: 'assistant', content: friendlyError(e) }); status('AI error', 'warn'); }
  aiBusy = false; $('aisend').disabled = false;
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
      + 'and cannot go and read other structures by itself — so it will ask you for what it is missing. '
      + 'Switch to Claude in Settings for an agent that explores the whole workspace on its own.';
    note.className = 'ainote show';
  }
}
// The index is sent with *every* message, so its size is what each question costs before you have
// asked anything. Showing it is the only way the setting that caps it can be a real choice rather
// than a number in a form: build it once, measure, and say so.
async function aiContextLabel() {
  const el = $('aictx'); if (!el) return;
  const v = selectedId ? viewById().get(selectedId) : null;
  const focus = v ? `Focus: ${v.name}` : 'No view focused — open one to give structure-level context';
  let cost = '';
  try {
    const cfg = await aiGetCfg();
    await aiBuildSeed(cfg.seedCap);
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
  aiEnsureFiles().then(() => aiContextLabel());   // the label reads the mirror too, and fills in when its measurement lands
}
function closeAI() { $('aiview').classList.remove('show'); $('askai').classList.remove('on'); document.body.classList.remove('ai-open'); }
function aiClear() { if (!aiMessages.length) return; if (!window.confirm('Clear this conversation?')) return; aiMessages = []; aiSeedWarned = false; aiRenderMessages(); }

// ---------- export ----------
// Coarse scope on purpose: sections, never single views. Kept in IndexedDB beside the folder handle
// rather than chrome.storage, so this build still needs no `storage` permission — the same choice,
// one fewer thing to justify.
const SCOPE_KEYS = ['views', 'structure', 'relations', 'sql', 'lineage', 'health'];
const SCOPE_FULL = { views: true, structure: true, relations: true, sql: true, lineage: true, health: true };
const SCOPE_SAFE = { views: true, structure: true, relations: true, sql: false, lineage: true, health: true };
let expScope = Object.assign({}, SCOPE_FULL);
async function loadScope() {
  try { const v = await window.idbHandle.get('exportScopeAnalytics'); if (v) expScope = Object.assign({}, SCOPE_FULL, v); } catch (_) {}
}
function scopeToUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.checked = !!expScope[k]; });
  const q = $('sc_sql'); if (q) q.disabled = !expScope.structure;
  $('scwarn').textContent = expScope.sql ? '\u26a0 includes the full SQL of every query table' : '';
}
function scopeFromUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) expScope[k] = !!e.checked; });
  if (!expScope.structure) expScope.sql = false;
  scopeToUI();
}
let _scopeResolve = null;
function askScope() {
  return new Promise((resolve) => {
    _scopeResolve = resolve; scopeToUI();
    $('scrim').classList.add('on'); $('expscope').classList.add('on');
  });
}
function closeScope(ok) {
  $('scrim').classList.remove('on'); $('expscope').classList.remove('on');
  const r = _scopeResolve; _scopeResolve = null;
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

function exportSections(sc) {
  const m = viewById();
  const h = healthFindings();
  const out = [];
  if (sc.views) out.push({ id: 'views', title: 'Views', rows: views.map((v) => [v.name, v.type, v.folderName || '—', v.owner || '—', v.designModifiedAt ? shortDate(v.designModifiedAt) : (v.designModifiedText || '—'), shortDate(v.dataModifiedAt), v.system ? 'system' : '']),
    head: ['View', 'Type', 'Folder', 'Owner', 'Design', 'Data', ''] });
  if (sc.structure) out.push({ id: 'structure', title: 'Structure', tables: Object.entries(schema).map(([id, t]) => ({ id, ...t })) });
  if (sc.relations) out.push({ id: 'relations', title: 'Relations', rows: relations.map((r) => [r.sourceName, r.targetName, r.relation]), head: ['From', 'To', 'Join'] });
  if (sc.sql) out.push({ id: 'sql', title: 'Query table SQL' });
  if (sc.lineage && deps) out.push({ id: 'lineage', title: 'Lineage', rows: views.filter((v) => deps[v.id]).map((v) => [v.name, String(deps[v.id].parents.length), String(deps[v.id].children.length), String(deps[v.id].dashboards.length)]), head: ['View', 'Reads from', 'Read by', 'On dashboards'] });
  if (sc.health) out.push({ id: 'health', title: 'Health', h });
  return out;
}

async function buildExportHtml(sc) {
  const secs = exportSections(sc);
  const esc2 = esc;
  const toc = secs.map((x) => `<li><a href="#${x.id}">${esc2(x.title)}</a></li>`).join('');
  const tbl = (head, rows) => `<table><thead><tr>${head.map((h2) => `<th>${esc2(h2)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc2(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  let body = '';
  for (const x of secs) {
    body += `<h2 id="${escA(x.id)}">${esc2(x.title)}</h2>`;
    if (x.rows) body += tbl(x.head, x.rows);
    else if (x.tables) body += x.tables.map((t) => `<h3>${esc2(t.name)} <small>${esc2(t.kind)}${t.system ? ' · system' : ''}</small></h3>` + tbl(['Column', 'Type', 'References'], t.columns.map((c) => [c.name, c.type, fkText(t.id, c.name)]))).join('');
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        const q = sqls[v.id]; if (!q) continue;
        const src = await sqlBodyOf(v.id);
        body += `<h3>${esc2(v.name)}</h3><pre>${esc2(sqlText(src))}</pre>`;
      }
    } else if (x.h) {
      const H = x.h;
      body += `<p><b>${H.counts.views}</b> views · <b>${H.counts.tables}</b> tables · <b>${H.counts.columns}</b> columns · <b>${H.counts.relations}</b> relations · <b>${H.counts.sql}</b> SQL</p>`
        + `<p class="gap">Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.</p>`
        + `<h3>Nothing depends on them (${H.orphans ? H.orphans.length : '—'})</h3><p class="gap">Candidates, not a verdict — a shared link, a scheduled export, an embedded report or an API consumer is invisible to Zoho Analytics' own dependency graph.</p>`
        + (H.orphans ? `<ul>${H.orphans.map((v) => `<li>${esc2(v.name)} <i>${esc2(v.type)}</i></li>`).join('')}</ul>` : '')
        + `<h3>Tables in no relation (${H.islands.length})</h3><ul>${H.islands.map((t) => `<li>${esc2(t.name)} <i>${esc2(t.kind)}</i></li>`).join('')}</ul>`
        + `<h3>Put there by Zoho, not by you (${H.system.length})</h3><ul>${H.system.map((v) => `<li>${esc2(v.name)}</li>`).join('')}</ul>`
        + (H.unread.length ? `<h3>Could not be read (${H.unread.length})</h3><ul>${H.unread.map((f) => `<li>${esc2((viewById().get(f.id) || {}).name || f.id)} — ${esc2(f.error)}</li>`).join('')}</ul>` : '');
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Zoost — ${esc2(bound.label || bound.name || bound.workspace)}</title><style>
body{font:14px/1.6 system-ui,sans-serif;color:#1b2431;background:#fff;margin:0;padding:28px;max-width:1100px}
h1{margin:0 0 4px} h2{margin:30px 0 8px;padding-top:8px;border-top:2px solid #e6ebf2} h3{margin:18px 0 6px;font-size:15px}
small,i{color:#6b7a90;font-weight:400;font-style:normal}
table{border-collapse:collapse;width:100%;margin:6px 0;font-size:12.5px;display:block;overflow-x:auto}
th{background:#f3f6fa;text-align:left;padding:5px 8px;border-bottom:2px solid #dde4ee;white-space:nowrap}
td{padding:4px 8px;border-bottom:1px solid #eef2f7;vertical-align:top}
pre{background:#f7f9fc;border:1px solid #e3e9f2;border-radius:6px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap}
.meta{color:#6b7a90;font-size:12.5px} .gap{color:#6b7a90;font-size:12.5px;border-left:3px solid #e6ebf2;padding-left:10px}
nav ul{columns:2;list-style:none;padding:0} nav a{color:#0e9488;text-decoration:none}
footer{margin-top:36px;padding-top:12px;border-top:1px solid #e6ebf2;color:#6b7a90;font-size:12px}
</style></head><body>
<h1>${esc2(bound.label || bound.name || bound.workspace)}</h1>
<div class="meta">${bound.label ? `Zoho Analytics workspace ${esc2(bound.name || '')} \u00b7 ` : 'Zoho Analytics workspace '}${esc2(bound.workspace)} · ${esc2(bound.origin || '')} · exported ${new Date().toISOString().slice(0, 10)} by ${esc2(PRODUCT_NAME)} v${esc2(chrome.runtime.getManifest().version)}</div>
<nav><ul>${toc}</ul></nav>
${body}
<footer>Read-only mirror. Zoost never creates, edits or deletes anything in Zoho Analytics, and never reads record data.<br>${esc2(LEGAL_DISCLAIMER)}</footer>
</body></html>`;
}

async function buildExportMarkdown(sc) {
  const secs = exportSections(sc);
  const row = (r) => '| ' + r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';
  let out = `# ${bound.label || bound.name || bound.workspace}\n\nZoho Analytics workspace ${bound.label && bound.name ? `${bound.name} ` : ''}\`${bound.workspace}\` · exported ${new Date().toISOString().slice(0, 10)} by ${PRODUCT_NAME} v${chrome.runtime.getManifest().version}\n\n`;
  out += '> Read-only mirror. Zoost never writes to Zoho Analytics and never reads record data.\n\n';
  out += '## Contents\n\n' + secs.map((x) => `- ${x.title}`).join('\n') + '\n- Zoho Analytics SQL — what query tables allow\n\n';
  // The dialect reference travels with the export on purpose: this file exists to be handed to an
  // agent that has never seen Analytics, and a workspace description without the tool's constraints
  // would get it writing SQL that cannot run.
  out += window.ZOHO_ANALYTICS_SQL.markdown() + '\n';
  for (const x of secs) {
    out += `## ${x.title}\n\n`;
    if (x.rows) out += row(x.head) + '\n' + row(x.head.map(() => '---')) + '\n' + x.rows.map(row).join('\n') + '\n\n';
    else if (x.tables) for (const t of x.tables) out += `### ${t.name} (${t.kind}${t.system ? ', system' : ''})\n\n| Column | Type | References |\n| --- | --- | --- |\n` + t.columns.map((c) => row([c.name, c.type, fkText(t.id, c.name)])).join('\n') + '\n\n';
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        const q = sqls[v.id]; if (!q) continue;
        const src = await sqlBodyOf(v.id);
        out += `### ${v.name}\n\n\u0060\u0060\u0060sql\n${src && src.trim() ? src : '-- ' + sqlText(src)}\n\u0060\u0060\u0060\n\n`;
      }
    } else if (x.h) {
      const H = x.h;
      out += `${H.counts.views} views · ${H.counts.tables} tables · ${H.counts.columns} columns · ${H.counts.relations} relations · ${H.counts.sql} SQL\n\n`;
      out += '> Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.\n\n';
      out += `### Nothing depends on them (${H.orphans ? H.orphans.length : '—'})\n\n> Candidates, not a verdict — a shared link, a scheduled export, an embedded report or an API consumer is invisible to Zoho Analytics' own dependency graph.\n\n`;
      if (H.orphans) out += H.orphans.map((v) => `- ${v.name} (${v.type})`).join('\n') + '\n\n';
      out += `### Tables in no relation (${H.islands.length})\n\n` + H.islands.map((t) => `- ${t.name} (${t.kind})`).join('\n') + '\n\n';
      out += `### Put there by Zoho, not by you (${H.system.length})\n\n` + H.system.map((v) => `- ${v.name}`).join('\n') + '\n\n';
      if (H.unread.length) out += `### Could not be read (${H.unread.length})\n\n` + H.unread.map((f) => `- ${(viewById().get(f.id) || {}).name || f.id} — ${f.error}`).join('\n') + '\n\n';
    }
  }
  return out;
}

// Folder, filename shape, timestamp format, permission check and status wording are all the CRM
// panel's, deliberately: an export is the artefact a user collects from both apps, and finding it
// somewhere else in one of them is precisely the discontinuity the two are supposed to avoid.
// There is no "analytics" in the filename because the workspace already sits under analytics/, and
// the CRM does not put "crm" in its own.
async function doExport(kind) {
  if (!dir) return;
  const sc = await askScope();
  if (!sc) return;
  await window.idbHandle.set('exportScopeAnalytics', sc);
  setBusy(true, kind === 'md' ? 'Building AI (Markdown) export…' : 'Building HTML export…');
  try {
    if (!(await ensurePerm(dir))) throw new Error('Folder access not granted.');
    const md = kind === 'md';
    const body = md ? await buildExportMarkdown(sc) : await buildExportHtml(sc);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && (bound.name || bound.workspace)) || 'workspace')}-${stamp}.${md ? 'md' : 'html'}`;
    await writeFile(name, body);
    setBusy(false, `Exported → ${name} (in your workspace folder).`); $('status').className = 'ok';
  } catch (e) {
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
    unread: pullFailed.slice(),
    noStructure: views.filter((v) => v.type !== 'Dashboard' && !structureChain(v, m)),
  };
}
function renderHealth() {
  const h = healthFindings();
  const list = (arr, f) => arr.length ? `<ul>${arr.slice(0, 40).map(f).join('')}</ul>${arr.length > 40 ? `<div class="gap">…and ${arr.length - 40} more. The full list is in the exports.</div>` : ''}` : '';
  const nm = (v) => `<li>${esc(v.name)} <span style="color:var(--muted)">${esc(v.type || v.kind || '')}</span></li>`;
  $('healthbody').innerHTML =
    `<h4>What was pulled</h4><div class="hnum">${h.counts.views} views · ${h.counts.folders} folders · ${h.counts.tables} tables · ${h.counts.columns} columns · ${h.counts.relations} relations · ${h.counts.sql} SQL</div>`
    + `<div class="gap">Report definitions — which columns a chart puts on which axis, and how it aggregates them — are <b>not</b> covered. The endpoint that carries them also carries the computed series, which is your data, so Zoost does not call it.</div>`

    + `<h4>Nothing depends on them <span class="hnum">${h.orphans ? h.orphans.length : '—'}</span></h4>`
    + (h.orphans ? list(h.orphans, nm) : '<div class="gap">Lineage was not pulled.</div>')
    + `<div class="gap">Candidates, not a verdict. Zoho Analytics only knows what its own views read from each other; a shared link, a scheduled export, an embedded report or an API consumer is invisible to it.</div>`

    + `<h4>Tables in no relation <span class="hnum">${h.islands.length}</span></h4>`
    + list(h.islands, nm)
    + `<div class="gap">They take part in no join in the ER model. That can be deliberate — a lookup list, a staging table — so this is a list to read, not a problem to fix.</div>`

    + `<h4>Put there by Zoho, not by you <span class="hnum">${h.system.length}</span></h4>`
    + list(h.system, nm)
    + `<div class="gap">Flagged <code>isSystemTable</code> by Zoho Analytics itself — typically synced from a connected source. The view list does not flag any of them, so this comes from the ER model alone.</div>`

    + `<h4>No description <span class="hnum">${h.undescribed.length}</span> of ${h.counts.views}</h4>`
    + `<div class="gap">A count, not a judgement. Plenty of views need no description.</div>`

    + (h.noStructure.length ? `<h4>No structure reachable <span class="hnum">${h.noStructure.length}</span></h4>` + list(h.noStructure, nm)
       + '<div class="gap">Neither their own columns nor a parent chain leading to any. Dashboards are excluded, since having none is correct for them.</div>' : '')

    + (h.unread.length ? `<h4 style="color:var(--warn)">Could not be read <span class="hnum">${h.unread.length}</span></h4>`
       + list(h.unread, (f) => `<li>${esc((viewById().get(f.id) || {}).name || f.id)} — <span style="color:var(--muted)">${esc(f.error)}</span></li>`)
       + '<div class="gap">Use <b>Retry failed</b>, or ↻ on a single view. Until then this mirror is short by exactly these.</div>' : '')

    + `<h4>Design and data dates</h4><div class="gap">Design is a real timestamp for tables and query tables, and Zoho\u2019s own text for everything else — shown exactly as it sends it, in your interface language, never parsed, and sorted last. Data is always a real timestamp.</div>`;
}
function openHealth() { renderHealth(); document.body.classList.add('health-open'); $('healthview').classList.add('show'); }
function closeHealth() { document.body.classList.remove('health-open'); $('healthview').classList.remove('show'); }

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
    + `Zoost has no server of its own. <b>The one exception is the AI assistant</b>: when you use it, the parts of the workspace it needs — view and column names, relations, and the SQL of your query tables — are sent directly from your browser to the provider you configured, and to no one else. `
    + `Rows are never sent, because Zoost never reads them. Leave the assistant unconfigured and nothing leaves this machine.</div>`;
  $('scrim').classList.add('on'); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); $('aboutdlg').classList.remove('on'); }

// ---------- wiring ----------
$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
/** What the workspace list shows, and what it must never stop showing.
 *
 * The label is a convenience; the identity is the org or workspace id. So the label is displayed and
 * the derived name is kept — in the option's tooltip, always, whether or not a label is set. A list
 * that showed only the user's name for something would be a list you cannot check against the
 * platform.
 */
function wsOptionText(w) { return ((w.cfg && w.cfg.label) || '').trim() || `${w.name || w.folder} \u00b7 ${w.id}`; }
function wsOptionTitle(w) {
  const label = ((w.cfg && w.cfg.label) || '').trim();
  return label ? `${label} \u2014 folder ${`${w.name || w.folder} \u00b7 ${w.id}`}` : `${w.name || w.folder} \u00b7 ${w.id}`;
}

/** A name of the user's own for a workspace.
 *
 * The folder name is derived from the platform, and the platform is not always evocative: Zoho
 * Analytics names the first workspace of every account the same way, so three projects can arrive on
 * disk with the same label and nothing to tell them apart. Zoho CRM has the instance and the org id,
 * which are unambiguous and still not memorable.
 *
 * So the label is *displayed instead of* the derived name, and the derived name never disappears —
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
    // DOMException the AI path used to. Third time this shape has surfaced — a write reached from a
    // control is a write that must re-request first.
    if (!(await ensurePerm(dir))) { status('Folder access needs re-granting — press ↻ Refresh, then try again.', 'warn'); return; }
    await patchCfg({ label });
    status(label ? `Workspace named \u00ab${label}\u00bb.` : 'Workspace name cleared \u2014 back to the folder name.', 'ok');
    await refreshWorkspaces();
  } catch (e) { status('Could not save the name. ' + friendlyError(e), 'bad'); }
}
$('wsrename').onclick = renameWorkspace;
$('wsadd').onclick = addWorkspace;
$('wsdel').onclick = delWorkspace;
$('ws').onchange = async () => { const w = wsList.find((x) => x.id === $('ws').value); if (w) await selectWorkspace(w); };
$('pull').onclick = pullAll;
$('gozoho').onclick = openZohoHome;
$('find').oninput = render;
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
$('aigear').onclick = () => openSettings();
$('ainotex').onclick = () => $('ainote').classList.remove('show');
$('ailockgo').onclick = aiUnlock; $('ailockpass').onkeydown = (e) => { if (e.key === 'Enter') aiUnlock(); };
$('aisend').onclick = aiSend;
$('aiinput').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); aiSend(); } });
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.aicfg) aiEngineChrome(); });
window.addEventListener('focus', () => aiEngineChrome());
$('healthx').onclick = closeHealth;
$('expx').onclick = () => closeScope(false);
$('expcancel').onclick = () => closeScope(false);
$('expgo').onclick = () => { scopeFromUI(); closeScope(true); };
$('pspFull').onclick = () => { expScope = Object.assign({}, SCOPE_FULL); scopeToUI(); };
$('pspSafe').onclick = () => { expScope = Object.assign({}, SCOPE_SAFE); scopeToUI(); };
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('opts').onclick = () => openSettings();
$('about').onclick = showAbout;
$('aboutx').onclick = closeAbout;
$('aboutok').onclick = closeAbout;
$('scrim').onclick = () => { closeAbout(); closeScope(false); };
$('dclose').onclick = () => { $('detail').classList.remove('show'); $('resizer').classList.remove('show'); selectedId = null; render(); };
document.querySelectorAll('.dtab').forEach((b) => {
  b.onclick = async () => {
    if (b.disabled) return;
    detailTab = b.dataset.tab;
    document.querySelectorAll('.dtab').forEach((x) => x.classList.toggle('active', x === b));
    const v = viewById().get(selectedId);
    if (v) { await renderDetail(v); resetDetailScroll(); }   // a different tab is different content too
  };
});
// A stored folder handle loses its permission between sessions and can only be re-granted from a
// user gesture. Any click in the panel counts, so the first thing the user does restores access —
// except on the controls that would themselves ask, on a dialog, on the mismatch overlay, or in the
// chat. The two panels excluded different subsets of those and neither list was wrong, which is how
// a divergence survives: both looked deliberate. It is the union now, and the same on both sides.
document.addEventListener('click', async (e) => {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('#pfoot') || t.closest('.dlg') || t.closest('#aiview') || t.closest('#offoverlay'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await refreshWorkspaces(); } } catch (_) {}
}, true);

// resizable split — the CRM's, down to the stored height
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
  try { chrome.storage.local.set({ detailH: $('detail').style.height }); } catch (_) {}
});

chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
window.addEventListener('focus', () => refreshContext());

(async () => {
  try { const r = await chrome.storage.local.get('detailH'); if (r && r.detailH) $('detail').style.height = r.detailH; } catch (_) {}
  await loadScope(); await restoreRoot(); await refreshContext();
})();
$('help').href = DOCS_URL;   // set here, not in the markup — same as the CRM panel
