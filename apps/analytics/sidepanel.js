/*
 * sidepanel.js — Zoost for Zoho Analytics.
 *
 * Scope of this first cut, stated plainly so nothing here is mistaken for more than it is:
 * it lists every view in the workspace the active tab is looking at, shows when each was last
 * changed in design and in data, and — on request — asks Analytics what depends on what, so views
 * nothing consumes can be surfaced. Nothing is written to disk yet, and nothing is written to Zoho
 * ever.
 *
 * The environment rule from the CRM panel holds here too: the workspace is whichever one the active
 * tab is in. Leave the tab and every action goes dead rather than acting on the wrong workspace.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = (s) => esc(s).replace(/"/g, '&quot;');   // attribute-safe — esc() alone truncates on a quote

const HOST_RE = /^https:\/\/analytics\.(zoho\.(eu|com|in|com\.au|jp)|zohocloud\.ca)\//;

let ctx = null;                 // { origin, workspace, view } of the active tab, or null
let views = [];                 // last listing
let folders = [];
let deps = null;                // { [viewId]: { parents, children, dashboards } } once scanned
let depsFailed = [];
let busy = false;
const ORPHANS = '__orphans__';  // sentinel: a census chip that is a question, not a view type
let typeFilter = null;          // a census chip, ORPHANS, or null for all
let sortKey = 'name', sortDir = 1;

// ---------- status ----------
function status(text, kind) {
  $('statustext').textContent = text;
  $('status').className = kind || '';
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

// ---------- context bar ----------
async function refreshContext() {
  const el = $('ctx'), who = $('ctxwho');
  const id = await analyticsTabId();
  if (id == null) {
    ctx = null; el.className = 'off';
    who.innerHTML = 'Not on a Zoho Analytics tab';
  } else {
    await ensureBridge(id);
    try { const r = await chrome.tabs.sendMessage(id, { cmd: 'context' }); ctx = r && r.ok ? r : null; } catch { ctx = null; }
    if (!ctx) { el.className = 'off'; who.innerHTML = 'Analytics tab (not ready — reload it)'; }
    else if (!ctx.workspace) { el.className = 'nows'; who.innerHTML = '<span>Analytics · no workspace open — go into one</span>'; }
    else { el.className = 'bound'; who.innerHTML = `<b>workspace ${esc(ctx.workspace)}</b> <span>· ${esc(ctx.origin.replace('https://', ''))}</span>`; }
  }
  updateButtons();
}
function updateButtons() {
  const live = !!(ctx && ctx.workspace) && !busy;
  $('refresh').disabled = !live;
  $('scan').disabled = !live || views.length === 0;
}
function setBusy(on, text) {
  busy = on; status(text || (on ? 'Working…' : 'Ready.'), on ? 'busy' : '');
  updateButtons();
}

// ---------- data ----------
async function listViews() {
  setBusy(true, 'Reading the view list…');
  try {
    const r = await toBridge({ cmd: 'listViews' });
    views = r.views || []; folders = r.folders || [];
    deps = null; depsFailed = [];              // a new listing invalidates the old dependency scan
    setBusy(false, `${views.length} views in ${folders.length} folders.`);
    $('status').className = 'ok';
    render();
  } catch (e) {
    views = []; folders = []; deps = null;
    setBusy(false, 'Could not list views: ' + (e.message || e));
    $('status').className = 'bad';
    render();
  }
}

async function scanDependencies() {
  const ids = views.map((v) => v.id);
  setBusy(true, `Scanning dependencies… 0 / ${ids.length}`);
  const onProgress = (m) => { if (m?.type === 'scanProgress') status(`Scanning dependencies… ${m.done} / ${m.total}`, 'busy'); };
  chrome.runtime.onMessage.addListener(onProgress);
  try {
    const r = await toBridge({ cmd: 'scanDependencies', ids });
    deps = r.deps || {}; depsFailed = r.failed || [];
    const orphans = views.filter(isOrphanCandidate).length;
    setBusy(false, depsFailed.length
      ? `${orphans} candidates nothing depends on · ${depsFailed.length} views could not be read.`
      : `${orphans} candidates nothing depends on.`);
    $('status').className = depsFailed.length ? 'warn' : 'ok';
    render();
  } catch (e) {
    setBusy(false, 'Dependency scan failed: ' + (e.message || e));
    $('status').className = 'bad';
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
  }
}

// A candidate, not a verdict. Analytics knows what its own views read from each other; it does not
// know about a shared link someone bookmarked, a scheduled export, an embedded report or an API
// consumer. The panel says "candidate" everywhere for that reason.
function isOrphanCandidate(v) {
  if (!deps) return false;
  const d = deps[v.id];
  if (!d) return false;                                  // unread → not claimed either way
  if (v.type === 'Dashboard') return false;              // a dashboard is consumed by people, not by views
  return d.children.length === 0 && d.dashboards.length === 0;
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
  if (q) out = out.filter((v) => (v.name || '').toLowerCase().includes(q) || (v.folderName || '').toLowerCase().includes(q));
  return out.slice().sort((a, b) => {
    if (sortKey === 'dataModifiedAt') {
      // Views with no timestamp sort last in both directions — an absent value is not "oldest".
      const x = a.dataModifiedAt, y = b.dataModifiedAt;
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
    list.innerHTML = `<div class="empty"><b>Nothing listed yet.</b>
      Open a Zoho Analytics workspace in the active tab — its URL looks like
      <code>/workspace/&lt;id&gt;</code> — then press <b>List views</b>.
      The workspace comes from the tab you are on, so there is nothing to configure.</div>`;
    return;
  }
  const rows = visibleViews();
  if (!rows.length) {
    list.innerHTML = `<div class="empty"><b>No view matches.</b>
      ${typeFilter ? 'The type filter and the' : 'The'} search box are narrowing ${views.length} views down to none.
      Clear the filter to see them all again.</div>`;
    return;
  }
  const usedBy = (v) => {
    if (!deps) return '';
    const d = deps[v.id];
    if (!d) return '<span class="orphan" title="This view could not be read during the scan">?</span>';
    const n = d.children.length + d.dashboards.length;
    return n ? String(n) : '<span class="orphan">none</span>';
  };
  list.innerHTML = `<table class="vtbl">
    <thead><tr>
      <th>View</th><th>Type</th>
      <th class="num" title="As Zoho words it, in your interface language — not sortable, see the note below">Design</th>
      <th class="num">Data</th>${deps ? '<th class="num">Used by</th>' : ''}
    </tr></thead><tbody>${rows.map((v) => `<tr>
      <td><div class="vname">${esc(v.name)}</div><div class="vsub">${esc(v.folderName || '—')}${v.owner ? ' · ' + esc(v.owner) : ''}</div></td>
      <td><span class="vtype">${esc(v.type)}</span></td>
      <td class="num verbatim" title="${escA(v.designModifiedBy ? 'by ' + v.designModifiedBy : '')}">${esc(v.designModifiedText || '—')}</td>
      <td class="num">${esc(shortDate(v.dataModifiedAt))}</td>
      ${deps ? `<td class="num">${usedBy(v)}</td>` : ''}
    </tr>`).join('')}</tbody></table>`;
}

// ---------- wiring ----------
$('refresh').onclick = listViews;
$('scan').onclick = scanDependencies;
$('find').oninput = render;
$('findclear').onclick = () => { $('find').value = ''; render(); };
$('sort').onchange = () => { sortKey = $('sort').value; render(); };
$('sortdir').onclick = () => {
  sortDir = -sortDir;
  $('sortdir').innerHTML = sortDir === 1 ? '&#8593;' : '&#8595;';
  render();
};
$('about').onclick = () => {
  const m = chrome.runtime.getManifest();
  status(`${m.name} ${m.version} — read-only, independent, not affiliated with Zoho.`, 'ok');
};

chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
window.addEventListener('focus', () => refreshContext());

refreshContext();
