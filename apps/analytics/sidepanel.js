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
const escA = (s) => esc(s).replace(/"/g, '&quot;');   // attribute-safe — esc() alone truncates on a quote

const PRODUCT_NAME = chrome.runtime.getManifest().name;   // single source of truth: rename in manifest.json only
const HOST_RE = /^https:\/\/analytics\.(zoho\.(eu|com|in|com\.au|jp)|zohocloud\.ca)\//;
const APP_DIR = 'analytics';                  // this app's subfolder inside the working folder
const APP_DIRS = ['crm', 'analytics'];        // known product folders — not "foreign" content
const CFG = '.zoost.json';
const PULL_SV = 1;                            // pull schema version; bump when new fields are captured

// Identity and legal text, worded as in the CRM panel — the two are one product to the reader.
// There is deliberately no Web Store link: this extension is not published, and a link to a listing
// that does not exist would be a claim outliving its truth before it was even made.
const PRODUCT_URL = 'https://zoost.it';
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
  + 'Deciding what may be extracted from Analytics, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';

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
  for await (const e of base.values()) {
    if (e.kind !== 'directory' || e.name.startsWith('.')) continue;
    try {
      const fh = await e.getFileHandle(CFG);
      const cfg = JSON.parse(await (await fh.getFile()).text());
      if (cfg && cfg.workspace) out.push({ id: String(cfg.workspace), name: cfg.name || '', folder: e.name, handle: e, cfg });
    } catch (_) { /* a folder without a config is not a workspace; silently skipped */ }
  }
  return out.sort((a, b) => (a.name || a.folder).localeCompare(b.name || b.folder));
}

async function refreshWorkspaces() {
  const sel = $('ws');
  $('wsroot').textContent = root ? `${root.name}/${APP_DIR}` : 'Choose folder…';
  $('wsroot').classList.toggle('needgrant', !!root && !rootGranted);
  if (root && !rootGranted) {
    $('wsroot').textContent = `${root.name} — click to grant access`;
    sel.innerHTML = '<option value="">access not granted</option>';
    dir = null; bound = null; return updateButtons();
  }
  if (!root) { sel.innerHTML = '<option value="">no working folder yet</option>'; dir = null; bound = null; return updateButtons(); }

  const list = await listWorkspaces();
  wsList = list;
  // Folders sitting directly in the working folder are the older flat layout. This is not a
  // compatibility fallback — nothing keeps working the old way — it is an empty state that says
  // what it sees instead of reporting "no workspaces" while the folders are plainly there.
  let stray = 0;
  try {
    for await (const e of root.values()) {
      if (e.kind !== 'directory' || APP_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
      try { await e.getFileHandle(CFG); stray++; } catch (_) {}
    }
  } catch (_) {}

  if (!list.length) {
    sel.innerHTML = `<option value="">${esc(root.name)}/${APP_DIR} — no workspaces yet</option>`;
    if (stray) status(`${stray} workspace folder(s) sit directly in «${root.name}». Each Zoost product keeps its own — move the Analytics ones into «${root.name}/${APP_DIR}/» and reopen the panel.`, 'warn');
    dir = null; bound = null; return updateButtons();
  }
  sel.innerHTML = list.map((w) => `<option value="${escA(w.id)}">${esc(w.name || w.folder)} · ${esc(w.id)}</option>`).join('');
  const active = await window.idbHandle.get('activeWsAnalytics');
  const pick = list.find((w) => w.id === active) || list[0];
  sel.value = pick.id;
  await selectWorkspace(pick);
}

async function selectWorkspace(w) {
  dir = w.handle;
  bound = { workspace: w.id, name: w.cfg.name || '', origin: w.cfg.origin || '' };
  await window.idbHandle.set('activeWsAnalytics', w.id);
  await loadFromDisk();
  await refreshContext();
}

async function addWorkspace() {
  if (!root) return status('Pick a working folder first.', 'warn');
  if (!ctx || !ctx.workspace) return status('Open an Analytics workspace in the active tab first.', 'warn');
  setBusy(true, 'Creating the workspace folder…');
  try {
    const info = await toBridge({ cmd: 'workspaceInfo' });
    const base = await appRoot(true);
    if (!base) throw new Error(`could not create the ${APP_DIR}/ folder`);
    const folder = stemOf(info.name || 'workspace', info.workspace);
    const h = await base.getDirectoryHandle(folder, { create: true });
    dir = h;
    await writeJson(CFG, { workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV, lastPull: null });
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
    $('detail').classList.remove('show'); selectedId = null;
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
  if (!r) throw new Error('No answer from the Analytics page.');
  if (r.ok === false) throw new Error(r.error || 'unknown error');
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

  if (!ctx) { el.className = 'offzoho'; who.innerHTML = 'Analytics tab (not ready — reload it)'; bnd.innerHTML = localLbl; }
  else if (!ctx.workspace) { el.className = 'offzoho'; who.innerHTML = '<span class="rlbl remote">Analytics tab</span><span>no workspace open</span>'; bnd.innerHTML = localLbl; }
  else {
    who.innerHTML = `<span class="rlbl remote">Analytics tab</span><b>${esc(ctx.workspace)}</b>`;
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
    $('detail').classList.remove('show');
    $('mmtext').textContent = `The tab is workspace ${ctx.workspace}; this folder mirrors «${bound.name || bound.workspace}» (${bound.workspace}). Everything is disabled until they match.`;
    $('mmsw').textContent = `Switch tab → «${bound.name || bound.workspace}» ↗`;
    $('mmsw').className = 'znav';
    $('mmsw').onclick = () => switchTab();
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
  $('wsadd').disabled = busy || !root || !rootGranted || !ctx || !ctx.workspace;
  $('wsdel').disabled = busy || !dir || !wsList.length;
  $('pull').disabled = busy || !dir || !guardOk();
  $('retry').disabled = busy || !dir || !guardOk() || !pullFailed.length;
  $('retry').textContent = pullFailed.length ? `Retry ${pullFailed.length} failed` : 'Retry failed';
  const loaded = views.length > 0;
  $('export').disabled = busy || !loaded;
  $('exportmd').disabled = busy || !loaded;
  $('health').disabled = busy || !loaded;
  $('pull').title = $('pull').disabled && dir && ctx && ctx.workspace && !guardOk()
    ? 'The active tab is a different workspace from the one selected here.' : '';
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
    setBusy(false, 'Pull failed: ' + (e.message || e));
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
// items that failed, and `refreshOne()` re-reads a single view from its detail pane.
async function refreshOne(id) {
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
  const index = await readJson('sql/_index.json', {});
  for (const [id, q] of Object.entries(sqls)) {
    if (typeof q.sql !== 'string') continue;              // not re-read this session; its file is current
    const v = viewById().get(id);
    const stem = q.stem || stemOf(v ? v.name : id, id);
    await writeFile(`sql/${stem}.sql`, q.sql);
    index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
  }
  await writeJson('sql/_index.json', index);
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
    await writeFile(`sql/${stem}.sql`, q.sql || '');
    index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
  }
  await writeJson('sql/_index.json', index);
  await writeJson(CFG, {
    workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV,
    lastPull: new Date().toISOString(),
    counts: { views: views.length, folders: folders.length, tables: Object.keys(schema).length, relations: relations.length, sql: Object.keys(sqls).length },
  });
  bound = { workspace: info.workspace, name: info.name, origin: info.origin };
}

async function loadFromDisk() {
  const v = await readJson('views.json', null);
  const s = await readJson('schema.json', null);
  const l = await readJson('lineage.json', null);
  views = (v && v.views) || []; folders = (v && v.folders) || [];
  schema = (s && s.tables) || {}; relations = (s && s.relations) || [];
  deps = l && l.deps ? l.deps : null; pullFailed = (l && l.failed) || [];
  sqls = {};
  const index = await readJson('sql/_index.json', null);
  if (index) for (const [id, e] of Object.entries(index)) sqls[id] = { id, sql: null, stem: e.stem, parents: e.parents || [], sources: e.sources || {} };
  mergeSchemaIntoViews();
  selectedId = null; $('detail').classList.remove('show');
  render();
  if (views.length) status(`${views.length} views loaded from disk${v && v.pulledAt ? ' · pulled ' + v.pulledAt.slice(0, 10) : ''}.`, '');
}

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

// Every relation this view takes part in, either end. Relations are stored once, not per side.
const relationsOf = (id) => relations.filter((r) => r.source === id || r.target === id);

const viewById = () => { const m = new Map(); for (const v of views) m.set(v.id, v); return m; };
const nameOf = (id, m) => (m.get(id) ? m.get(id).name : id);

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

function renderCensus() {
  const box = $('census');
  if (!views.length) { box.innerHTML = ''; return; }
  const counts = new Map();
  for (const v of views) counts.set(v.type, (counts.get(v.type) || 0) + 1);
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) =>
    `<span class="chip${typeFilter === t ? ' on' : ''}" data-type="${escA(t)}">${esc(t)} <b>${n}</b></span>`);
  chips.unshift(`<span class="chip${typeFilter === null ? ' on' : ''}" data-type="">All <b>${views.length}</b></span>`);
  if (deps) {
    const n = views.filter(isOrphanCandidate).length;
    chips.push(`<span class="chip${typeFilter === ORPHANS ? ' on' : ''}" data-type="${ORPHANS}" title="Nothing in this workspace depends on them — candidates, not a verdict">Nothing depends on <b>${n}</b></span>`);
  }
  box.innerHTML = chips.join('');
  box.querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => { const t = c.dataset.type; typeFilter = t === '' ? null : t; render(); };
  });
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

function render() {
  renderCensus();
  const list = $('list');
  if (!views.length) {
    list.innerHTML = `<div class="empty"><b>Nothing pulled yet.</b>
      Pick a working folder, open a Zoho Analytics workspace in the active tab — its URL looks like
      <code>/workspace/&lt;id&gt;</code> — press <b>+</b> to create the workspace folder, then
      <b>Pull all</b>.</div>`;
    return;
  }
  const rows = visibleViews();
  if (!rows.length) {
    list.innerHTML = `<div class="empty"><b>No view matches.</b>
      ${typeFilter ? 'The type filter and the' : 'The'} search box are narrowing ${views.length} views down to none.
      The search also looks inside column names. Clear it to see them all again.</div>`;
    return;
  }
  const usedBy = (v) => {
    if (!deps) return '';
    const d = deps[v.id];
    if (!d) return '<span class="orphan" title="This view could not be read during the pull">?</span>';
    const n = d.children.length + d.dashboards.length;
    return n ? String(n) : '<span class="orphan">none</span>';
  };
  // Own columns plain; inherited ones marked, because attributing a parent's structure to a report
  // without saying so would be a quiet lie about whose columns those are.
  const m0 = viewById();
  const colCount = (v) => {
    if (schema[v.id]) return String(schema[v.id].columns.length);
    const chain = structureChain(v, m0);
    if (!chain) return '—';
    const src = chain[chain.length - 1];
    return `<span title="${escA('inherited from ' + src.name)}" style="color:var(--muted)">↳${schema[src.id].columns.length}</span>`;
  };
  list.innerHTML = `<table class="vtbl">
    <thead><tr>
      <th>View</th><th>Type</th><th class="num" title="Columns, for tables and query tables">Cols</th>
      <th class="num" title="As Zoho words it, in your interface language — not sortable, see the note below">Design</th>
      <th class="num">Data</th>${deps ? '<th class="num">Used by</th>' : ''}
    </tr></thead><tbody>${rows.map((v) => `<tr data-id="${escA(v.id)}"${v.id === selectedId ? ' class="sel"' : ''}>
      <td><div class="vname">${esc(v.name)}</div><div class="vsub">${esc(v.folderName || '—')}${v.owner ? ' · ' + esc(v.owner) : ''}${v.system ? ' · <span class="sysflag" title="Analytics flags this as a system table — it came from a connected source, you did not build it">system</span>' : ''}</div></td>
      <td><span class="vtype">${esc(v.type)}</span></td>
      <td class="num">${colCount(v)}</td>
      ${v.designModifiedAt
        ? `<td class="num" title="${escA(v.designModifiedBy ? 'by ' + v.designModifiedBy : '')}">${esc(shortDate(v.designModifiedAt))}</td>`
        : `<td class="num verbatim" title="${escA('Zoho gives no machine-readable value for this one — shown as it sends it' + (v.designModifiedBy ? ', by ' + v.designModifiedBy : ''))}">${esc(v.designModifiedText || '—')}</td>`}
      <td class="num">${esc(shortDate(v.dataModifiedAt))}</td>
      ${deps ? `<td class="num">${usedBy(v)}</td>` : ''}
    </tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => openDetail(tr.dataset.id); });
}

// ---------- detail ----------
async function openDetail(id) {
  selectedId = id;
  const v = viewById().get(id);
  if (!v) return;
  $('detail').classList.add('show');
  $('dtitle').textContent = v.name;
  $('drefresh').disabled = busy || !guardOk();
  $('drefresh').title = guardOk()
    ? 'Re-read this one view from Zoho — its SQL and its lineage'
    : 'The active tab is a different workspace, so nothing can be re-read';
  $('drefresh').onclick = () => refreshOne(v.id);
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
  render();
}

async function renderDetail(v) {
  const body = $('dbody');
  const m = viewById();
  if (detailTab === 'cols') {
    const chain = structureChain(v, m);
    if (!chain) {
      body.innerHTML = `<div class="dpad"><div class="empty" style="padding:0"><b>No structure to show.</b>
        A ${esc(v.type)} has no columns of its own, and Analytics does not tell us which view it is
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
    body.innerHTML = (via ? `<div class="dpad" style="padding-bottom:0">${via}</div>` : '') + `<table class="ctbl"><thead><tr><th>Column</th><th>Type</th></tr></thead><tbody>${
      t.columns.map((c) => `<tr><td>${esc(c.name)}</td><td class="t">${esc(c.type)}</td></tr>`).join('')
    }</tbody></table>`;
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
    body.innerHTML = '<div class="dpad">' + (sql
      ? `<pre class="sql">${esc(sql)}</pre>`
      : `<div class="empty" style="padding:0"><b>The SQL file could not be read.</b> Use ↻ above to fetch just this one.</div>`) + '</div>';
    return;
  }
  // lineage
  const d = deps ? deps[v.id] : null;
  if (!d) { body.innerHTML = '<div class="dpad"><div class="empty" style="padding:0"><b>No lineage for this view.</b> Use ↻ above to fetch just this one.</div></div>'; return; }
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
    + `<div class="lin"><h5>Read by</h5>${li(d.children)}</div>`
    + `<div class="lin"><h5>On dashboards</h5>${dash}</div>`
    + (cols ? `<div class="lin"><h5>Source columns involved</h5><ul>${cols}</ul></div>` : '')
    + '</div>';
}

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
    body += `<h2 id="${x.id}">${esc2(x.title)}</h2>`;
    if (x.rows) body += tbl(x.head, x.rows);
    else if (x.tables) body += x.tables.map((t) => `<h3>${esc2(t.name)} <small>${esc2(t.kind)}${t.system ? ' · system' : ''}</small></h3>` + tbl(['Column', 'Type'], t.columns.map((c) => [c.name, c.type]))).join('');
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        const q = sqls[v.id]; if (!q) continue;
        const src = await sqlBodyOf(v.id);
        body += `<h3>${esc2(v.name)}</h3><pre>${esc2(src || '(could not be read)')}</pre>`;
      }
    } else if (x.h) {
      const H = x.h;
      body += `<p><b>${H.counts.views}</b> views · <b>${H.counts.tables}</b> tables · <b>${H.counts.columns}</b> columns · <b>${H.counts.relations}</b> relations · <b>${H.counts.sql}</b> SQL</p>`
        + `<p class="gap">Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.</p>`
        + `<h3>Nothing depends on them (${H.orphans ? H.orphans.length : '—'})</h3><p class="gap">Candidates, not a verdict — a shared link, a scheduled export, an embedded report or an API consumer is invisible to Analytics' own dependency graph.</p>`
        + (H.orphans ? `<ul>${H.orphans.map((v) => `<li>${esc2(v.name)} <i>${esc2(v.type)}</i></li>`).join('')}</ul>` : '')
        + `<h3>Tables in no relation (${H.islands.length})</h3><ul>${H.islands.map((t) => `<li>${esc2(t.name)} <i>${esc2(t.kind)}</i></li>`).join('')}</ul>`
        + `<h3>Put there by Zoho, not by you (${H.system.length})</h3><ul>${H.system.map((v) => `<li>${esc2(v.name)}</li>`).join('')}</ul>`
        + (H.unread.length ? `<h3>Could not be read (${H.unread.length})</h3><ul>${H.unread.map((f) => `<li>${esc2((viewById().get(f.id) || {}).name || f.id)} — ${esc2(f.error)}</li>`).join('')}</ul>` : '');
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Zoost — ${esc2(bound.name || bound.workspace)}</title><style>
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
<h1>${esc2(bound.name || bound.workspace)}</h1>
<div class="meta">Zoho Analytics workspace ${esc2(bound.workspace)} · ${esc2(bound.origin || '')} · exported ${new Date().toISOString().slice(0, 10)} by ${esc2(PRODUCT_NAME)} v${esc2(chrome.runtime.getManifest().version)}</div>
<nav><ul>${toc}</ul></nav>
${body}
<footer>Read-only mirror. Zoost never creates, edits or deletes anything in Zoho Analytics, and never reads record data.<br>${esc2(LEGAL_DISCLAIMER)}</footer>
</body></html>`;
}

async function buildExportMarkdown(sc) {
  const secs = exportSections(sc);
  const row = (r) => '| ' + r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';
  let out = `# ${bound.name || bound.workspace}\n\nZoho Analytics workspace \`${bound.workspace}\` · exported ${new Date().toISOString().slice(0, 10)} by ${PRODUCT_NAME} v${chrome.runtime.getManifest().version}\n\n`;
  out += '> Read-only mirror. Zoost never writes to Zoho Analytics and never reads record data.\n\n';
  out += '## Contents\n\n' + secs.map((x) => `- ${x.title}`).join('\n') + '\n\n';
  for (const x of secs) {
    out += `## ${x.title}\n\n`;
    if (x.rows) out += row(x.head) + '\n' + row(x.head.map(() => '---')) + '\n' + x.rows.map(row).join('\n') + '\n\n';
    else if (x.tables) for (const t of x.tables) out += `### ${t.name} (${t.kind}${t.system ? ', system' : ''})\n\n| Column | Type |\n| --- | --- |\n` + t.columns.map((c) => row([c.name, c.type])).join('\n') + '\n\n';
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        const q = sqls[v.id]; if (!q) continue;
        const src = await sqlBodyOf(v.id);
        out += `### ${v.name}\n\n\u0060\u0060\u0060sql\n${src || '-- could not be read'}\n\u0060\u0060\u0060\n\n`;
      }
    } else if (x.h) {
      const H = x.h;
      out += `${H.counts.views} views · ${H.counts.tables} tables · ${H.counts.columns} columns · ${H.counts.relations} relations · ${H.counts.sql} SQL\n\n`;
      out += '> Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.\n\n';
      out += `### Nothing depends on them (${H.orphans ? H.orphans.length : '—'})\n\n> Candidates, not a verdict — a shared link, a scheduled export, an embedded report or an API consumer is invisible to Analytics' own dependency graph.\n\n`;
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
    + `<div class="gap">Candidates, not a verdict. Analytics only knows what its own views read from each other; a shared link, a scheduled export, an embedded report or an API consumer is invisible to it.</div>`

    + `<h4>Tables in no relation <span class="hnum">${h.islands.length}</span></h4>`
    + list(h.islands, nm)
    + `<div class="gap">They take part in no join in the ER model. That can be deliberate — a lookup list, a staging table — so this is a list to read, not a problem to fix.</div>`

    + `<h4>Put there by Zoho, not by you <span class="hnum">${h.system.length}</span></h4>`
    + list(h.system, nm)
    + `<div class="gap">Flagged <code>isSystemTable</code> by Analytics itself — typically synced from a connected source. The view list does not flag any of them, so this comes from the ER model alone.</div>`

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
    + `<div class="dnote" style="margin-top:8px">Early work in progress — not published on the Chrome Web Store, and not yet documented on the site.</div>`
    + `<h4>Links</h4><div><a href="${escA(PRODUCT_URL)}" target="_blank" rel="noopener">zoost.it</a> · <a href="${escA(PRODUCT_URL)}/privacy.html" target="_blank" rel="noopener">Privacy</a> · <a href="${escA(REPO_URL)}" target="_blank" rel="noopener">Source</a> · <a href="mailto:${escA(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></div>`
    + `<h4>Support</h4><div><a href="${escA(SPONSOR_URL)}" target="_blank" rel="noopener">GitHub Sponsors</a> · <a href="${escA(KOFI_URL)}" target="_blank" rel="noopener">☕ Ko-fi</a></div>`
    + `<h4>Licence</h4><div><a href="${escA(LICENSE_URL)}" target="_blank" rel="noopener">${esc(PRODUCT_LICENSE)}</a> · © 2026 ${esc(PRODUCT_AUTHOR)}</div>`
    + `<h4>Legal</h4><div class="legal">${esc(LEGAL_DISCLAIMER)}</div>`
    + `<h4>Your data</h4><div class="legal">Everything stays between your browser, your Zoho session and the local folder you picked. `
    + `The extension has no server of its own and sends nothing anywhere. What is written to your workspace folder — and what happens to it afterwards — is up to you.</div>`;
  $('scrim').classList.add('on'); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); $('aboutdlg').classList.remove('on'); }

// ---------- wiring ----------
$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
$('wsadd').onclick = addWorkspace;
$('wsdel').onclick = delWorkspace;
$('ws').onchange = async () => { const w = wsList.find((x) => x.id === $('ws').value); if (w) await selectWorkspace(w); };
$('pull').onclick = pullAll;
$('gozoho').onclick = openZohoHome;
$('find').oninput = render;
$('findclear').onclick = () => { $('find').value = ''; render(); };
$('sort').onchange = () => { sortKey = $('sort').value; render(); };
$('sortdir').onclick = () => { sortDir = -sortDir; $('sortdir').innerHTML = sortDir === 1 ? '&#8593;' : '&#8595;'; render(); };
$('export').onclick = () => doExport('html');
$('exportmd').onclick = () => doExport('md');
$('retry').onclick = retryFailed;
$('health').onclick = () => ($('healthview').classList.contains('show') ? closeHealth() : openHealth());
$('healthx').onclick = closeHealth;
$('expx').onclick = () => closeScope(false);
$('expcancel').onclick = () => closeScope(false);
$('expgo').onclick = () => { scopeFromUI(); closeScope(true); };
$('pspFull').onclick = () => { expScope = Object.assign({}, SCOPE_FULL); scopeToUI(); };
$('pspSafe').onclick = () => { expScope = Object.assign({}, SCOPE_SAFE); scopeToUI(); };
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('about').onclick = showAbout;
$('aboutx').onclick = closeAbout;
$('aboutok').onclick = closeAbout;
$('scrim').onclick = () => { closeAbout(); closeScope(false); };
$('dclose').onclick = () => { $('detail').classList.remove('show'); selectedId = null; render(); };
document.querySelectorAll('.dtab').forEach((b) => {
  b.onclick = async () => {
    if (b.disabled) return;
    detailTab = b.dataset.tab;
    document.querySelectorAll('.dtab').forEach((x) => x.classList.toggle('active', x === b));
    const v = viewById().get(selectedId);
    if (v) await renderDetail(v);
  };
});
// A stored folder handle loses its permission between sessions and can only be re-granted from a
// user gesture. Any click in the panel counts, so the first thing the user does restores access —
// except clicks on the controls that would themselves ask, or on a dialog.
document.addEventListener('click', async (e) => {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('.dlg') || t.closest('#offoverlay'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await refreshWorkspaces(); } } catch (_) {}
}, true);

chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
window.addEventListener('focus', () => refreshContext());

(async () => { await loadScope(); await restoreRoot(); await refreshContext(); })();
