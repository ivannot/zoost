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

// ---------- state ----------
let root = null;            // the working folder handle
let rootGranted = false;
let dir = null;             // the active workspace folder handle
let bound = null;           // { workspace, name, origin } of the active workspace, from its .zoost.json
let ctx = null;             // { origin, workspace, view } of the active tab
let busy = false;

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
  const sel = $('wssel');
  $('pickroot').textContent = root ? `${root.name}/${APP_DIR}` : 'Choose folder…';
  $('pickroot').classList.toggle('needgrant', !!root && !rootGranted);
  if (root && !rootGranted) {
    $('pickroot').textContent = `${root.name} — click to grant access`;
    sel.innerHTML = '<option value="">access not granted</option>';
    dir = null; bound = null; return updateButtons();
  }
  if (!root) { sel.innerHTML = '<option value="">no working folder yet</option>'; dir = null; bound = null; return updateButtons(); }

  const list = await listWorkspaces();
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
    if (stray) status(`${stray} workspace folder(s) sit directly in «${root.name}». Each Zoost product keeps its own — move Analytics ones into «${root.name}/${APP_DIR}/» and click ↻.`, 'warn');
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
  const el = $('ctx'), who = $('ctxwho');
  const id = await analyticsTabId();
  if (id == null) { ctx = null; }
  else {
    await ensureBridge(id);
    try { const r = await chrome.tabs.sendMessage(id, { cmd: 'context' }); ctx = r && r.ok ? r : null; } catch { ctx = null; }
  }
  const local = bound ? `<span>· local «${esc(bound.name || bound.workspace)}»</span>` : '';
  if (!ctx) { el.className = 'off'; who.innerHTML = `Not on a Zoho Analytics tab ${local}`; }
  else if (!ctx.workspace) { el.className = 'nows'; who.innerHTML = `Analytics · no workspace open ${local}`; }
  else if (!bound) { el.className = 'nows'; who.innerHTML = `<b>workspace ${esc(ctx.workspace)}</b> <span>· press + to create it locally</span>`; }
  else if (guardOk()) { el.className = 'bound'; who.innerHTML = `<b>${esc(bound.name || bound.workspace)}</b> <span>· ${esc(ctx.workspace)} ✓</span>`; }
  else { el.className = 'mismatch'; who.innerHTML = `<b>tab is workspace ${esc(ctx.workspace)}</b> <span>≠ local «${esc(bound.name || bound.workspace)}» ✗</span>`; }
  updateButtons();
}
function updateButtons() {
  $('addws').disabled = busy || !root || !rootGranted || !ctx || !ctx.workspace;
  $('pull').disabled = busy || !dir || !guardOk();
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
      body.innerHTML = `<div class="empty" style="padding:10px 0"><b>No structure to show.</b>
        A ${esc(v.type)} has no columns of its own, and Analytics does not tell us which view it is
        built on — so there is nothing here that would be true.</div>`;
      return;
    }
    const src = chain[chain.length - 1];
    const t = schema[src.id];
    // When the structure is inherited, say whose it is and through what — a column list attributed
    // to the wrong object is worse than no column list.
    const via = chain.length > 1
      ? `<div class="vsub" style="margin:0 0 8px">Structure of <b>${esc(src.name)}</b> (${esc(t.kind)}), inherited through ${chain.slice(0, -1).map((c) => esc(c.name)).join(' → ')} → <b>${esc(src.name)}</b></div>`
      : '';
    body.innerHTML = via + `<table class="ctbl"><thead><tr><th>Column</th><th>Type</th></tr></thead><tbody>${
      t.columns.map((c) => `<tr><td>${esc(c.name)}</td><td class="t">${esc(c.type)}</td></tr>`).join('')
    }</tbody></table>`;
    return;
  }
  if (detailTab === 'rel') {
    const rs = relationsOf(v.id);
    // Zoho's own `relationstring` is shown as it writes it — "(A.col)=(B.col)". Re-rendering the
    // join in our own words would be an interpretation, and the point here is the fact, not our
    // phrasing of it. The direction is stated because a lookup is not symmetric.
    body.innerHTML = rs.map((r) => {
      const out = r.source === v.id;
      return `<div class="rel"><b>${esc(out ? '→ ' + r.targetName : '← ' + r.sourceName)}</b><br>${esc(r.relation)}</div>`;
    }).join('');
    return;
  }
  if (detailTab === 'sql') {
    const sql = await sqlBodyOf(v.id);
    body.innerHTML = sql
      ? `<pre class="sql">${esc(sql)}</pre>`
      : `<div class="empty" style="padding:10px 0"><b>The SQL file could not be read.</b> Pull again to fetch it.</div>`;
    return;
  }
  // lineage
  const d = deps ? deps[v.id] : null;
  if (!d) { body.innerHTML = '<div class="empty" style="padding:10px 0"><b>No lineage for this view.</b> It could not be read during the last pull.</div>'; return; }
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
  body.innerHTML =
    `<div class="lin"><h5>Reads from</h5>${li(d.parents)}</div>`
    + `<div class="lin"><h5>Read by</h5>${li(d.children)}</div>`
    + `<div class="lin"><h5>On dashboards</h5>${dash}</div>`
    + (cols ? `<div class="lin"><h5>Source columns involved</h5><ul>${cols}</ul></div>` : '');
}

// ---------- about ----------
function showAbout() {
  const m = chrome.runtime.getManifest();
  status(`${PRODUCT_NAME} ${m.version} — read-only, independent, not affiliated with Zoho.`, 'ok');
}

// ---------- wiring ----------
$('pickroot').onclick = pickRoot;
$('addws').onclick = addWorkspace;
$('wsrefresh').onclick = () => refreshWorkspaces();
$('wssel').onchange = async () => {
  const list = await listWorkspaces();
  const w = list.find((x) => x.id === $('wssel').value);
  if (w) await selectWorkspace(w);
};
$('pull').onclick = pullAll;
$('find').oninput = render;
$('findclear').onclick = () => { $('find').value = ''; render(); };
$('sort').onchange = () => { sortKey = $('sort').value; render(); };
$('sortdir').onclick = () => { sortDir = -sortDir; $('sortdir').innerHTML = sortDir === 1 ? '&#8593;' : '&#8595;'; render(); };
$('about').onclick = showAbout;
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

chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
window.addEventListener('focus', () => refreshContext());

(async () => { await restoreRoot(); await refreshContext(); })();
