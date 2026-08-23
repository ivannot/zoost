/*
 * connections.js - the org-wide connections catalogue with its usage join against the call graph.
 * Sixth slice, same contract: declarations only, loaded before sidepanel.js.
 */

// ---------- connections view (org-wide catalogue + usage) ----------
let connectionData = [], connCatFilter = 'all';
async function loadConnectionsIndex(op = beginWorkspaceOp()) {
  let idx = []; try { idx = JSON.parse(await op.read('connections/index.json')); } catch (_) {}
  if (!op.current()) return null;
  return Array.isArray(idx) ? idx : [];
}
async function rebuildConnections() {
  // These read the mirror and then publish a whole list into the panel's memory. A rebuild is
  // short, but it is not instant, and what overtakes it is a change of workspace - so the list of
  // one org arrived in the panel showing another. Found by `tools/asynccheck.py`, which derives
  // this class instead of waiting for the next reader to notice an instance of it.
  const op = beginWorkspaceOp();
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { op.say(MSG.folder, 'warn'); return; }
    op.say('Reading connections…', 'busy');
    const _cfg = await opReadCfg(op); if (!op.current()) return; if (_cfg) bound = _cfg; await cacheBinding(bound);
    const cat = await loadConnectionsIndex(op); if (!cat || !op.current()) return;
    // usage: which functions reference each connection (join meta.connections[].name)
    // A graph that failed to build is not a graph with nothing in it: `.catch(() => null)` here
    // turned «source unreadable» into `uses: []` on every row, «1 connections.» in green, and a
    // Used/Unused filter that was false exactly when nothing had been measured. Overtaken is the
    // one silent exit; everything else is a real failure and is said.
    let g;
    try { g = await ensureGraph(op); }
    catch (e) { if ((e && e.message) === WS_MOVED) return; op.say('Connections: could not build the usage graph - ' + ((e && e.message) || e), 'bad'); return; }
    const usedBy = {};
    Object.values(g.nodes).forEach((n) => (n.connections || []).forEach((c) => { if (c && c.name) (usedBy[c.name] ||= []).push(n); }));
    if (!op.current()) return;
    connectionData = cat.map((c) => ({ ...c, path: 'connections/' + c.name, uses: (usedBy[c.name] || []).slice() }));
    // connections a function references but that are NOT in the catalogue (renamed / removed)
    const catNames = new Set(cat.map((c) => c.name));
    Object.keys(usedBy).forEach((name) => { if (!catNames.has(name)) connectionData.push({ name, label: name, connector: null, connected: null, createdBy: null, scopes: [], missing: true, path: 'connections/' + name, uses: usedBy[name].slice() }); });
    renderConnections();
    op.say(connectionData.length ? `${connectionData.length} connections.` : (emptyReason() || 'No connections pulled yet - click Pull all.'), connectionData.length ? 'ok' : 'warn');
  } catch (e) { if (op.current()) setStatus('Connections error: ' + e.message, 'bad'); }
  if (op.current()) await refreshContext();
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
  return runPullAction(async () => {
    if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
    setStatus('Refreshing connections…', 'busy');
    await pullConnections();   // re-pulls the whole catalogue and rebuilds the view (like the schedules dot)
  });
}
function openConnection(c) {
  previewLoad++;
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
  wireFnChips($('pvtable'), (a) => { setMode('functions'); openFile(a.dataset.file); });
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
