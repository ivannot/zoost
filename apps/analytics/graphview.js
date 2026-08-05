// --- Attribution (set PRODUCT_URL to the Chrome Web Store URL once available) ---
const PRODUCT_NAME = chrome.runtime.getManifest().name;   // renaming happens in manifest.json only
const PRODUCT_URL = 'https://zoost.it';
const PRODUCT_AUTHOR = 'Ivan Notaristefano';
/* graphview.js — Explorer + Visual graph. Reads graph from chrome.storage.local. */
let DATA = null, N = {}, ids = [], filter = 'all', sel = null, hist = [], nameMode = 'display';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// esc() is NOT attribute-safe: a double quote closes the attribute early and silently truncates
// the value — that is what cut a snippet in half right after the opening bracket.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Tolerant of a missing node: the callers pass N[id] and an id can outlive its node when a graph
// is filtered. Returning '' lets them fall back to the id rather than printing "undefined".
const label = (n) => (!n ? '' : nameMode === 'internal'
  ? (n.api_name || n.name)
  : ((DATA && DATA.kind === 'schema') ? (n.display_name || n.api_name || n.name) : n.name));
const NSCOL = (ns) => getComputedStyle(document.documentElement).getPropertyValue('--n-' + ns).trim() || '#94a3b8';

(async function init() {
  const store = await chrome.storage.local.get('graphData');
  DATA = store.graphData;
  if (!DATA) { $('main').innerHTML = '<div class="empty">No graph data. Open it from the side panel.</div>'; return; }
  N = DATA.nodes; ids = Object.keys(N).sort((a, b) => a.localeCompare(b));
  $('s-nodes').textContent = DATA.counts.nodes;
  $('s-edges').textContent = DATA.counts.edges;
  $('s-dead').textContent = DATA.counts.dead_suspects;
  $('s-unres').textContent = DATA.counts.unresolved;
  const _schema = DATA.kind === 'schema';
  document.title = PRODUCT_NAME;
  { const h = $('gtitle'); if (h) h.textContent = PRODUCT_NAME; }
  if (_schema) {
    $('ertab').style.display = ''; $('reltab').style.display = ''; buildRelChips();
    try {
      const st = await chrome.storage.local.get('erParams');
      if (st && st.erParams && st.erParams.current) erP = Object.assign({}, ER_PRESET.modules, st.erParams.current);
    } catch (_) {}
    erInitControls();
    // Depth buttons wired once: they work whether the focus comes from the open ("Open ER") or is
    // set later by selecting a module in the Explorer of a whole-graph ("Schema") view.
    $('erdMinus').onclick = () => setDepth(egoDepth - 1);
    $('erdPlus').onclick = () => setDepth(egoDepth + 1);
  }
  $('statline').innerHTML = _schema
    ? `${DATA.focus ? `<b style=\"color:#d98e00\">Focus: ${esc(label(N[DATA.focus]) || DATA.focus)}</b> · depth ${DATA.depth} · ` : ''}<b>${DATA.counts.nodes}</b> tables · <b>${DATA.counts.edges}</b> relations · <b>${DATA.counts.dead_suspects}</b> in no relation`
    : `<b>${DATA.counts.nodes}</b> functions · <b>${DATA.counts.edges}</b> calls · <b>${DATA.counts.dead_suspects}</b> no-caller · <b>${DATA.counts.unresolved}</b> unresolved`;
  const ws = DATA.workspace || {};
  $('s-ws').innerHTML = (ws.instance || ws.org) ? `· <b>${esc(ws.instance || '?')}</b> · org ${esc(ws.org || '?')}` : '';
  buildChips(); render(); buildLegend(); initCanvas(); updateTopTools();
  if (DATA.kind === 'schema' && DATA.focus) {
    curFocus = DATA.focus; computeMaxDepth();
    egoDepth = Math.max(1, Math.min(maxEgoDepth, DATA.depth || 2));
    $('erdepth').style.display = 'inline-flex'; updateDepthUI();
    bfsEgo(); egoStat(); updateTopTools(); updateScopeUI();
    const t = document.querySelector('.tab[data-v="er"]'); if (t) setTimeout(() => t.click(), 60);
  }
})();

// ---------------- Explorer ----------------
const FILTERS = [['all', 'All'], ['standalone', 'standalone'], ['automation', 'automation'], ['button', 'button'],
  ['schedule', 'schedule'], ['validation_rule', 'validation'], ['rest', 'REST'], ['dead', 'no-caller'], ['unres', 'unresolved']];
const FILTERS_SCHEMA = [['all', 'All'], ['table', 'tables'], ['query', 'query tables'], ['system', 'system'], ['hub', 'hub (3+)'], ['orphan', 'no relation']];
function buildChips() {
  const chips = $('chips'); const F = DATA.kind === 'schema' ? FILTERS_SCHEMA : FILTERS;
  F.forEach(([k, l]) => {
    const c = document.createElement('span'); c.className = 'chip'; c.textContent = l; c.setAttribute('aria-pressed', k === 'all');
    c.onclick = () => { filter = k;[...chips.children].forEach((x) => x.setAttribute('aria-pressed', x === c)); render(); };
    chips.appendChild(c);
  });
}
function pass(n, q) {
  const matchQ = !q || n.name.toLowerCase().includes(q) || (n.display_name || '').toLowerCase().includes(q);
  if (DATA.kind === 'schema') {
    if (filter === 'table' && n.namespace !== 'table') return false;
    if (filter === 'query' && n.namespace !== 'query') return false;
    if (filter === 'system' && !n.system) return false;
    if (filter === 'hub' && n.called_by.length < 3) return false;
    if (filter === 'orphan' && !(n.called_by.length === 0 && n.calls.length === 0)) return false;
    return matchQ;
  }
  if (filter === 'rest' && !n.rest) return false;
  if (filter === 'dead' && !n.dead_suspect) return false;
  if (filter === 'unres' && !n.unresolved.length) return false;
  if (['standalone', 'automation', 'button', 'schedule', 'validation_rule'].includes(filter) && n.namespace !== filter) return false;
  return matchQ;
}
function render() {
  const q = $('q').value.trim().toLowerCase(); const listEl = $('list'); listEl.innerHTML = '';
  ids.map((i) => N[i]).filter((n) => pass(n, q))
    .sort((a, b) => (b.called_by.length - a.called_by.length) || a.name.localeCompare(b.name))
    .forEach((n) => {
      const d = document.createElement('div'); d.className = 'item'; d.setAttribute('aria-selected', n.id === sel);
      d.innerHTML = `<span class="dot" style="background:${NSCOL(n.namespace)}"></span><span class="nm">${esc(label(n))}</span><span class="ns">${esc(String(n.namespace || "").slice(0, 4))}</span><span class="deg">${n.called_by.length}◂</span>`;
      d.onclick = () => select(n.id); listEl.appendChild(d);
    });
}
function refRow(id) {
  const n = N[id]; const d = document.createElement('div'); d.className = 'ref';
  d.innerHTML = `<span class="dot" style="background:${NSCOL(n.namespace)}"></span><span class="nm">${esc(n.namespace + "." + label(n))}</span><span class="deg">${n.called_by.length}◂</span>`;
  d.onclick = () => select(id); return d;
}
function srcBlock(n) {
  const code = n.source_code || '';
  if (!code) return '';
  const lines = code.split('\n').length;
  const gut = Array.from({ length: lines }, (_, k) => k + 1).join('\n');
  const hl = window.highlightDeluge ? window.highlightDeluge(code) : esc(code);
  const st = n.stats;   // computed by the panel from the same source; counts only, no verdict
  const callBits = st && st.apiCalls ? ` · ${st.apiCalls} outbound call${st.apiCalls === 1 ? '' : 's'} (${st.invokeurl} invokeurl, ${st.crm} zoho.crm, ${st.zoho} other${st.sendmail ? `, ${st.sendmail} sendmail` : ''})` : st ? ' · no outbound calls' : '';
  return `<div class="srcwrap"><div class="srchead">Source · ${lines} lines${st ? ` (${st.codeLines} code)` : ''}${callBits} · ${esc(n.namespace)}.${esc(n.name)}</div><div class="srcbody"><pre class="gut">${gut}</pre><pre class="src">${hl}</pre></div></div>`;
}
let layFilter = null;   // null = all fields, otherwise the index of a layout in n.layouts
const layShort = (t) => { t = String(t || ''); return t.length > 12 ? t.slice(0, 11) + '\u2026' : t; };

// Field table + layout matrix. One column per layout (max ~5 per module), a dot where the
// field belongs to it, an amber dot where it is required there.
function layoutZoneHtml(n) {
  const lays = n.layouts || [];
  const detail = !!n.layoutDetail && lays.length > 0;
  const all = n.fields || [];
  const rowsSrc = (detail && layFilter !== null)
    ? all.filter((f) => Array.isArray(f._lay) && f._lay.includes(layFilter))
    : all;

  const chips = detail
    ? `<div class="laychips"><span class="laychip" data-lay="all" aria-pressed="${layFilter === null}">All fields \u00b7 ${all.length}</span>`
      + lays.map((l, i) => {
          const cnt = all.filter((f) => Array.isArray(f._lay) && f._lay.includes(i)).length;
          return `<span class="laychip" data-lay="${escA(i)}" aria-pressed="${layFilter === i}" title="${escA(l.name || String(l.id))}${l.visible === false ? ' (hidden)' : ''}">${esc(l.name || String(l.id))}${l.visible === false ? ' \u00b7 hidden' : ''} \u00b7 ${cnt}</span>`;
        }).join('')
      + `</div>`
    : '';

  const lhead = detail
    ? lays.map((l, i) => `<th class="lcol${l.visible === false ? ' hid' : ''}" title="${escA(l.name || String(l.id))}${l.visible === false ? ' (hidden layout)' : ''}">${esc(layShort(l.name || l.id))}</th>`).join('')
    : '';

  const rows = rowsSrc.map((f) => {
    const inAny = Array.isArray(f._lay) && f._lay.length > 0;
    const orphan = detail && !inAny;
    const cells = detail ? lays.map((l, i) => {
      if (!Array.isArray(f._lay) || !f._lay.includes(i)) return '<td class="lcol"></td>';
      const req = Array.isArray(f._req) && f._req.includes(i);
      return `<td class="lcol"><span class="d${req ? ' req' : ''}" title="${escA(l.name || String(l.id))}${req ? ' \u2014 required here' : ''}"></span></td>`;
    }).join('') : '';
    return `<tr class="${orphan ? 'nolay' : ''}">
    <td>${esc(f.label || f.api_name)}${f.custom ? ' <span style="color:#a78bfa">*</span>' : ''}${orphan ? '<span class="nolaytag">no layout</span>' : ''}</td>
    <td class="mono">${esc(f.api_name)}</td>
    <td>${esc(f.data_type || '')}${f.length ? ` (${f.length})` : ''}</td>
    <td style="text-align:center">${f.mandatory ? '\u25cf' : ''}</td>
    <td class="mono">${f.lookup ? '\u2192 ' + esc(label(N[f.lookup]) || f.lookup) : ''}</td>${cells}
  </tr>`;
  }).join('');

  const head = detail && layFilter !== null
    ? `Fields in \u00ab${esc(lays[layFilter].name || lays[layFilter].id)}\u00bb \u00b7 ${rowsSrc.length} of ${all.length}`
    : `Fields \u00b7 ${all.length}${detail ? ` \u00b7 ${lays.length} layout(s)` : ''}`;

  const legend = detail
    ? `<div class="laylegend"><span class="d"></span> in layout \u00b7 <span class="d req"></span> required in that layout \u00b7 highlighted rows are fields in <b>no</b> layout (API-only)</div>`
    : (lays.length ? `<div class="laylegend">Layout detail not in this graph \u2014 re-run <b>Pull Modules</b>, then reopen the diagram.</div>` : '');

  return `<div class="srcwrap"><div class="srchead">${head}</div>${chips}`
    + `<div style="display:block;padding:0;max-height:340px;overflow:auto;background:#fff"><table class="ftbl"><thead><tr><th>Field</th><th>API</th><th>Type</th><th>Req</th><th>Lookup</th>${lhead}</tr></thead><tbody>${rows}</tbody></table></div>${legend}</div>`;
}
function wireLayoutZone(n) {
  document.querySelectorAll('#layzone .laychip').forEach((c) => (c.onclick = () => {
    layFilter = c.dataset.lay === 'all' ? null : parseInt(c.dataset.lay, 10);
    const z = $('layzone'); if (z) { z.innerHTML = layoutZoneHtml(n); wireLayoutZone(n); }
  }));
}
// A table's relations, both directions, with the join exactly as Zoho writes it. This replaces the
// CRM panel's related-lists block: the concept that matters here is the join, not a related-list
// API name, and inventing an equivalent would have been a worse lie than having none.
function joinsHtml(n) {
  const js = n.joins || [];
  if (!js.length) {
    return `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Relations \u00b7 0</div>`
      + `<div style="padding:9px 10px;color:#94a3b8;font:11.5px var(--sans)">This table takes part in no join in the ER model. That can be deliberate \u2014 a lookup list, a staging table \u2014 so it is a fact, not a problem.</div></div>`;
  }
  const rows = js.map((r) => `<tr>
    <td>${r.direction === 'out' ? '\u2192' : '\u2190'}</td>
    <td class="mono"><b>${esc(r.otherName)}</b></td>
    <td class="mono">${esc(r.column || '')}</td>
    <td class="mono">${esc(r.otherColumn || '')}</td>
    <td class="mono" style="color:#64748b">${esc(r.relation || '')}</td>
  </tr>`).join('');
  return `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Relations \u00b7 ${js.length} <span style="font-weight:400;color:#94a3b8">\u2014 \u2192 this table points out, \u2190 something points here</span></div>`
    + `<div style="display:block;padding:0;max-height:260px;overflow:auto;background:#fff"><table class="ftbl"><thead><tr><th></th><th>Other table</th><th>This column</th><th>Their column</th><th>Join</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function fieldsTableHtml(n) {
  const tbl = `<div id="layzone">${layoutZoneHtml(n)}</div>` + joinsHtml(n);
  const rd = n.reads || [];
  const who = rd.length
    ? `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Read by ${rd.length} view(s) \u2014 from Analytics\u2019 own lineage</div><div style="padding:8px 10px;font:11.5px var(--mono);color:#33415a;line-height:1.7">${rd.map((t) => esc(t)).join('<br>')}</div></div>`
    : '<div class="none" style="margin-top:12px">Nothing in this workspace reads from it. A shared link, a scheduled export or an API consumer would be invisible here \u2014 a candidate, not a verdict.</div>';
  return tbl + who;
}
function select(id, nopush) {
  if (sel && !nopush) hist.push(sel);
  if (sel !== id) layFilter = null;   // layout filter is per-module
  sel = id; const n = N[id]; render();
  const schema = DATA.kind === 'schema';
  const crumb = hist.length ? `<a id="back">\u25c2 back</a>  \u00b7  ${hist.slice(-4).map((h) => `<a data-id="${escA(h)}">${esc(label(N[h]))}</a>`).join(' \u2039 ')}` : '';
  let assoc = '';
  if (!schema && Array.isArray(n.associated_place) && n.associated_place.length) {
    assoc = '<div class="assoc">Bound to: ' + n.associated_place.map((a) => `<b>${esc(a._type || '')}</b> ${esc(a.name || '')} <span>(${esc(a.module || '')})</span>`).join(' \u00b7 ') + '</div>';
  }
  const sig = schema
    ? `${(n.fields || []).length} columns \u00b7 ${(n.joins || []).length} relations \u00b7 ${esc(n.category || 'table')}`
    : `${n.return_type || 'void'} ${n.namespace}.${n.name}(` + (n.params || []).map((p) => `${p.type} ${p.name}`).join(', ') + ')';
  const upHead = schema ? `Referenced by (${n.called_by.length}) <span class="hint">\u2014 tables pointing here</span>` : `Called by (${n.called_by.length}) <span class="hint">\u2014 breaks if you change it</span>`;
  const downHead = schema ? `References (${n.calls.length}) <span class="hint">\u2014 tables it points at</span>` : `Calls (${n.calls.length}) <span class="hint">\u2014 its dependencies</span>`;
  const badges = schema
    ? `<span class="badge">${esc(n.namespace)}</span>${n.dead_suspect ? '<span class="badge">unreferenced</span>' : ''}`
    : `<span class="badge">${esc(n.namespace)} \u00b7 ${esc(n.category || '')}</span>${n.rest ? '<span class="badge b-rest">REST</span>' : ''}${n.dead_suspect ? '<span class="badge">no caller</span>' : ''}`;
  const extra = schema ? fieldsTableHtml(n) : srcBlock(n);
  const layInfo = (schema && (n.layouts || []).length) ? `<div class="assoc" style="margin-top:2px">Layouts (${n.layouts.length}): ${n.layouts.map((l) => esc(l.name || String(l.id)) + (l.visible === false ? ' (hidden)' : '')).join(' \u00b7 ')}</div>` : '';
  $('main').innerHTML = `
    <div class="crumbs">${crumb}</div>
    <div class="title"><h2>${esc(label(n))}</h2>${badges}</div>
    <div class="sub">${esc(n.display_name)}</div>
    ${n.description ? `<p class="desc">${esc(n.description)}</p>` : ''}
    <div class="sig">${esc(sig)}</div>
    ${layInfo}
    <div class="cols">
      <div class="col up"><h3>${upHead}</h3><div class="refs" id="up"></div></div>
      <div class="col down"><h3>${downHead}</h3><div class="refs" id="down"></div></div>
    </div>
    ${(!schema && (n.unresolved.length || n.ambiguous.length)) ? `<div class="warn">
      ${n.unresolved.length ? `<h4>Unresolved references</h4>${n.unresolved.map((r) => `<code>${esc(r)}</code>`).join('  ')}` : ''}
      ${n.ambiguous.length ? `<h4 style="margin-top:6px">Ambiguous</h4>${n.ambiguous.map((r) => `<code>${esc(r)}</code>`).join('  ')}` : ''}</div>` : ''}
    ${assoc}
    <div class="file">${esc(n.file || '')}</div>
    ${extra}`;
  const up = $('up'), down = $('down');
  n.called_by.length ? n.called_by.forEach((i) => up.appendChild(refRow(i))) : (up.innerHTML = `<div class="none">no ${schema ? 'incoming lookup' : 'internal caller'}</div>`);
  n.calls.length ? n.calls.forEach((i) => down.appendChild(refRow(i))) : (down.innerHTML = `<div class="none">no ${schema ? 'lookup fields' : 'internal calls'}</div>`);
  const back = $('back'); if (back) back.onclick = () => { const p = hist.pop(); if (p) select(p, true); };
  document.querySelectorAll('.crumbs a[data-id]').forEach((a) => (a.onclick = () => select(a.dataset.id)));
  if (schema) wireLayoutZone(n);
  $('main').scrollTop = 0;
  focusNode = id;
  // Focus mode: the Explorer selection IS the context. Set it here so that switching to
  // Visual or ER afterwards already shows this module (it used to update only via ER).
  if (schema && id !== curFocus) setFocus(id);   // selecting a module ALWAYS establishes/moves the focus, even from the whole-graph view
  else if (curView === 'visual') draw();
}
$('q').addEventListener('input', render);
document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement.id !== 'q') { e.preventDefault(); $('q').focus(); } });

// ---------------- Relations (relation-first catalogue) ----------------
// The ER diagram puts modules first and relations second. This view inverts it: one row per
// relation, module names demoted to context. It exists because the thing you actually need
// when writing Deluge is the related-list API name, not the module map.
let RELS = [], relFilter = 'all', relQ = '';
function buildRels() {
  RELS = [];
  const seen = new Set();
  Object.values(N).forEach((n) => (n.joins || []).forEach((r) => {
    if (r.direction !== 'out') return;              // each relation is stored on both ends; keep one
    const k = n.id + '\u0000' + r.other + '\u0000' + r.column;
    if (seen.has(k)) return; seen.add(k);
    RELS.push({ from: n.id, fromName: label(n), col: r.column, to: r.other, toName: r.otherName, toCol: r.otherColumn, join: r.relation, system: !!n.system });
  }));
  RELS.sort((a, b) => (a.fromName.localeCompare(b.fromName) || String(a.col).localeCompare(String(b.col))));
}
function relPass(r) {
  if (relFilter === 'user' && r.system) return false;
  if (relFilter === 'sys' && !r.system) return false;
  if (!relQ) return true;
  const q = relQ.toLowerCase();
  return [r.fromName, r.col, r.toName, r.toCol, r.join].some((x) => (x || '').toLowerCase().includes(q));
}
function relRender() {
  if (!RELS.length) buildRels();
  const rows = RELS.filter(relPass);
  $('relcount').textContent = `${rows.length} of ${RELS.length} relations`;
  if (!RELS.length) {
    $('relwrap').innerHTML = '<div class="empty">No relations in this workspace. They come from the ER model \u2014 run <b>Pull all</b> and reopen this window.</div>';
    return;
  }
  // The join string is Zoho's own, copyable as-is. Re-rendering it in our words would be an
  // interpretation; the fact is what is useful when you are about to write a query.
  $('relwrap').innerHTML = `<table class="rtbl"><thead><tr>
      <th>From table</th><th>Column</th><th>To table</th><th>Column</th><th>Join (click to copy)</th>
    </tr></thead><tbody>${rows.map((r) => `<tr class="${r.system ? 'sys' : ''}">
      <td><span class="mod" data-mod="${escA(r.from)}">${esc(r.fromName)}</span></td>
      <td class="rlab" style="font:11px var(--mono)">${esc(r.col || '')}</td>
      <td><span class="mod" data-mod="${escA(r.to)}">${esc(r.toName)}</span></td>
      <td class="rlab" style="font:11px var(--mono)">${esc(r.toCol || '')}</td>
      <td><span class="snip" data-copy="${escA(r.join || '')}" title="Click to copy">${esc(r.join || '')}</span></td>
    </tr>`).join('')}</tbody></table>`;
  $('relwrap').querySelectorAll('[data-copy]').forEach((el) => (el.onclick = () => {
    navigator.clipboard.writeText(el.dataset.copy).then(() => {
      const old = el.textContent; el.textContent = 'copied \u2713';
      setTimeout(() => { el.textContent = old; }, 900);
    }).catch(() => {});
  }));
  $('relwrap').querySelectorAll('[data-mod]').forEach((el) => (el.onclick = () => {
    const id = el.dataset.mod; if (!N[id]) return;
    document.querySelector('.tab[data-v="explorer"]').click(); select(id);
  }));
}
function buildRelChips() {
  const box = $('relchips'); if (!box) return;
  [['all', 'all'], ['user', 'yours'], ['sys', 'system tables']].forEach(([k, l]) => {
    const c = document.createElement('span'); c.className = 'chip'; c.textContent = l;
    c.setAttribute('aria-pressed', k === relFilter);
    c.onclick = () => { relFilter = k; [...box.children].forEach((x) => x.setAttribute('aria-pressed', x === c)); relRender(); };
    box.appendChild(c);
  });
  $('relq').addEventListener('input', () => { relQ = $('relq').value.trim(); relRender(); });
}

// ---------------- View toggle ----------------
let curView = 'explorer';
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
  curView = t.dataset.v;
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', x === t));
  $('v-explorer').classList.toggle('on', curView === 'explorer');
  $('v-visual').classList.toggle('on', curView === 'visual');
  $('v-er').classList.toggle('on', curView === 'er');
  $('v-rel').classList.toggle('on', curView === 'rel');
  updateTopTools();
  if (curView === 'rel') relRender();
  if (curView === 'visual') {
    if (!forceFeasible()) { showVisualTooBig(); }
    else { hideVisualTooBig(); requestAnimationFrame(() => { resize(); if (!laidOut) { settle(); laidOut = true; } fitView(); draw(); }); }
  }
  if (curView === 'er') requestAnimationFrame(erShow);
});

// ---------------- Visual (canvas force graph) ----------------
let cv, ctx2d, W = 0, H = 0, nodesA = [], edgesA = [], posX = {}, posY = {}, vx = {}, vy = {};
let scale = 1, offX = 0, offY = 0, focusNode = null, subFocus = null, labelMode = 'hubs', laidOut = false;
let egoDepth = 2, egoSet = null, egoLevel = {}, curFocus = null, maxEgoDepth = 6;
let scopeAll = false;   // true = ignore the focus and draw the whole org (wall-poster mode)
let dragging = false, lastX = 0, lastY = 0;

// Deterministic robustness guard. The force layout (settle) is O(n²) per iteration × ~420 and runs
// on the main thread, so above this many nodes we do NOT attempt it — it would freeze the window.
// We know n before we start, so we refuse up front and point to the views that stay fast (Explorer,
// and — for schema — focus + depth). Conservative and NOT calibrated against a very large org; tune
// this single number if you ever profile one.
const FORCE_MAX_NODES = 600;
function forceFeasible() { return nodesA.length <= FORCE_MAX_NODES; }
function showVisualTooBig() {
  let ov = document.getElementById('vistoobig');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'vistoobig';
    ov.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:28px;background:#fff;color:#475569;font:14px/1.7 system-ui,-apple-system,Segoe UI,sans-serif;z-index:6';
    $('visual').appendChild(ov);
  }
  const focusHint = (DATA && DATA.kind === 'schema') ? ', or open the diagram <b>focused on one module</b> with a small depth' : '';
  ov.innerHTML = `<div style="max-width:560px"><div style="font-size:16px;margin-bottom:8px"><b>${nodesA.length} nodes</b> — too many to lay out interactively.</div>`
    + `The force-directed graph is not drawn above ${FORCE_MAX_NODES}: it would block this window while it computes.<br><br>`
    + `Use the <b>Explorer</b> tab — search and filter, always fast${focusHint}.</div>`;
  ov.style.display = 'flex';
}
function hideVisualTooBig() { const ov = document.getElementById('vistoobig'); if (ov) ov.style.display = 'none'; }

function buildLegend() {
  const seen = {}; Object.values(N).forEach((n) => (seen[n.namespace] = 1));
  const leg = $('legend');
  Object.keys(seen).sort().forEach((ns) => {
    const li = document.createElement('div'); li.className = 'li';
    li.innerHTML = `<span class="dot" style="width:9px;height:9px;border-radius:50%;background:${NSCOL(ns)}"></span>${ns}`;
    leg.appendChild(li);
  });
}
function initCanvas() {
  cv = $('cv'); ctx2d = cv.getContext('2d');
  $('visual').style.position = $('visual').style.position || 'relative';   // anchor the too-big overlay to the canvas area, not the page
  nodesA = Object.keys(N);
  const idx = {}; nodesA.forEach((id, i) => (idx[id] = i));
  const es = new Set();
  Object.values(N).forEach((n) => n.calls.forEach((c) => es.add(n.id + '\u0000' + c)));
  edgesA = [...es].map((e) => { const [a, b] = e.split('\u0000'); return [a, b]; });
  const R = Math.min(400, 60 + nodesA.length * 2);
  nodesA.forEach((id, i) => {
    const a = (i / nodesA.length) * Math.PI * 2;
    posX[id] = Math.cos(a) * R + (Math.random() - 0.5) * 40;
    posY[id] = Math.sin(a) * R + (Math.random() - 0.5) * 40;
    vx[id] = 0; vy[id] = 0;
  });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const f = e.deltaY < 0 ? 1.1 : 0.9; scale *= f; draw(); }, { passive: false });
  cv.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', () => (dragging = false));
  cv.addEventListener('mousemove', onMove);
  cv.addEventListener('click', onClick);
  window.addEventListener('resize', () => { if (curView === 'visual') resize(); });
}
function resize() {
  const r = $('visual').getBoundingClientRect();
  W = Math.round(r.width) || Math.round(window.innerWidth);
  H = Math.round(r.height) || Math.round(window.innerHeight - 54);
  cv.width = W; cv.height = H;
  if (!offX && !offY) { offX = W / 2; offY = H / 2; }
  draw();
}
function activeSet() { return subFocus ? neighbors(subFocus) : null; }
function fitView() {
  if (!nodesA.length) return;
  const set = activeSet(); const list = set ? [...set] : (egoSet ? [...egoSet] : nodesA);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of list) { minX = Math.min(minX, posX[id]); minY = Math.min(minY, posY[id]); maxX = Math.max(maxX, posX[id]); maxY = Math.max(maxY, posY[id]); }
  const gw = (maxX - minX) || 1, gh = (maxY - minY) || 1, pad = 60;
  scale = Math.min((W - pad * 2) / gw, (H - pad * 2) / gh);
  scale = Math.max(0.15, Math.min(scale, 2.5));
  offX = W / 2 - ((minX + maxX) / 2) * scale;
  offY = H / 2 - ((minY + maxY) / 2) * scale;
  draw();
}
function screenXY(id) { return [posX[id] * scale + offX, posY[id] * scale + offY]; }
function nodeRadius(id) { return 3 + Math.min(9, N[id].called_by.length); }

function settle() {
  const k = 5200, maxR = 120 + nodesA.length * 3, maxV = 40;
  let a = 0.5;
  for (let it = 0; it < 420; it++) {
    for (let i = 0; i < nodesA.length; i++) {
      const A = nodesA[i]; let fx = 0, fy = 0;
      for (let j = 0; j < nodesA.length; j++) {
        if (i === j) continue; const B = nodesA[j];
        let dx = posX[A] - posX[B], dy = posY[A] - posY[B]; let d2 = dx * dx + dy * dy + 0.01;
        const f = k / d2; fx += dx * f; fy += dy * f;
      }
      vx[A] = (vx[A] + fx) * 0.85; vy[A] = (vy[A] + fy) * 0.85;
    }
    for (const [A, B] of edgesA) {
      let dx = posX[B] - posX[A], dy = posY[B] - posY[A]; const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 90) * 0.02; const ux = dx / d, uy = dy / d;
      vx[A] += ux * f; vy[A] += uy * f; vx[B] -= ux * f; vy[B] -= uy * f;
    }
    for (const id of nodesA) {
      vx[id] += -posX[id] * 0.006; vy[id] += -posY[id] * 0.006;
      vx[id] = Math.max(-maxV, Math.min(maxV, vx[id])); vy[id] = Math.max(-maxV, Math.min(maxV, vy[id]));
      posX[id] += vx[id] * a; posY[id] += vy[id] * a;
      const d = Math.hypot(posX[id], posY[id]);
      if (d > maxR) { const s = maxR / d; posX[id] *= s; posY[id] *= s; vx[id] *= 0.5; vy[id] *= 0.5; }
    }
    a *= 0.986;
  }
}

function updateTopTools() {
  // Graph controls live inside #vistools (in the Visual view) — nothing to show/hide in the header.
  // In schema focus mode the ego-set already drives what is drawn, so the Visual "Focus" button
  // (a second, competing filter) would only be confusing: hide it.
  const fb = $('focusBtn');
  if (fb) fb.style.display = (DATA && DATA.kind === 'schema' && curFocus) ? 'none' : '';
}
function bfsEgo() {
  egoLevel = {};
  if (scopeAll) { egoSet = null; return; }
  if (!curFocus || !N[curFocus]) { egoSet = null; return; }
  const keep = new Set([curFocus]); egoLevel[curFocus] = 0; let fr = [curFocus];
  for (let d = 0; d < egoDepth; d++) {
    const nx = [];
    fr.forEach((k) => { const n = N[k]; if (!n) return; [...(n.calls || []), ...(n.called_by || [])].forEach((nb) => { if (N[nb] && !keep.has(nb)) { keep.add(nb); egoLevel[nb] = d + 1; nx.push(nb); } }); });
    fr = nx; if (!fr.length) break;
  }
  egoSet = keep;
}
function computeMaxDepth() {
  maxEgoDepth = 1;
  if (!curFocus || !N[curFocus]) return;
  const keep = new Set([curFocus]); let fr = [curFocus], lvl = 0;
  while (fr.length) {
    const nx = [];
    fr.forEach((k) => { const n = N[k]; if (!n) return; [...(n.calls || []), ...(n.called_by || [])].forEach((nb) => { if (N[nb] && !keep.has(nb)) { keep.add(nb); nx.push(nb); } }); });
    if (nx.length) lvl++;
    fr = nx;
  }
  maxEgoDepth = Math.max(1, lvl);
}
function updateDepthUI() {
  $('erdVal').textContent = egoDepth;
  const mx = $('erdMax'); if (mx) mx.textContent = '/ ' + maxEgoDepth;
  $('erdMinus').disabled = scopeAll || egoDepth <= 1;
  $('erdPlus').disabled = scopeAll || egoDepth >= maxEgoDepth;
  const dp = $('erdepth'); if (dp) dp.style.opacity = scopeAll ? '.45' : '';
}
function updateScopeUI() {
  const lbl = scopeAll ? 'Scope: all tables' : `Scope: ${(curFocus && label(N[curFocus])) || 'focus'}`;
  const ttl = scopeAll
    ? 'Showing every module. Click to go back to the focused neighbourhood.'
    : 'Showing the focus neighbourhood. Click to show every module (full diagram for A0 printing).';
  ['erScope', 'visScope'].forEach((id) => {
    const b = $(id); if (!b) return;
    b.style.display = curFocus ? '' : 'none';
    b.textContent = lbl; b.title = ttl; b.classList.toggle('on', scopeAll);
  });
  // The reset appears only when a focus is active (whole-graph view already IS the reset target).
  ['erReset', 'visReset'].forEach((id) => { const b = $(id); if (b) b.style.display = curFocus ? '' : 'none'; });
}
function setScope(all) {
  if (!curFocus) return;
  // "All modules" triggers the whole-org free layout. Above the budget we don't attempt it — we
  // stay focused and say why, rather than freezing on the way to a poster nobody can wait for.
  if (all && !forceFeasible()) {
    $('statline').innerHTML = `<b>${nodesA.length} tables</b> — too many to lay out all at once. Staying focused on <b style="color:#d98e00">${esc(label(N[curFocus]) || curFocus)}</b>; widen with depth instead.`;
    return;
  }
  scopeAll = !!all;
  bfsEgo(); updateDepthUI(); updateScopeUI(); egoStat(); erLaidOut = false;
  if (curView === 'er') erShow();
  else if (curView === 'visual') { fitView(); draw(); }
}
function egoStat() {
  if (!curFocus) return;
  if (scopeAll) {
    $('statline').innerHTML = `<b>All tables</b> \u00b7 <b>${DATA.counts.nodes}</b> tables \u00b7 <b>${DATA.counts.edges}</b> relations \u00b7 <span style=\"color:#94a3b8\">focus \u00ab${esc(label(N[curFocus]) || curFocus)}\u00bb paused \u2014 Save PDF prints the whole diagram on one page</span>`;
    return;
  }
  const nn = egoSet ? egoSet.size : DATA.counts.nodes;
  const ne = egoSet ? edgesA.filter(([a, b]) => egoSet.has(a) && egoSet.has(b)).length : DATA.counts.edges;
  $('statline').innerHTML = `<b style=\"color:#d98e00\">Focus: ${esc(label(N[curFocus]) || curFocus)}</b> \u00b7 depth ${egoDepth}/${maxEgoDepth} \u00b7 <b>${nn}</b> tables \u00b7 <b>${ne}</b> relations \u00b7 <span style=\"color:#94a3b8\">click a box to re-center</span>`;
}
function setDepth(d) {
  egoDepth = Math.max(1, Math.min(maxEgoDepth, d));
  updateDepthUI(); bfsEgo(); egoStat(); erLaidOut = false;
  if (curView === 'er') erShow(); if (curView === 'visual') { fitView(); draw(); }
}
function setFocus(id) {
  // Re-centre the shared focus WITHOUT changing view. Explorer / Visual / ER are three
  // projections of the same context, so whoever changes the focus updates all of them.
  if (!id || !N[id] || id === curFocus) return;
  const wasUnfocused = !curFocus;
  curFocus = id; computeMaxDepth(); egoDepth = Math.max(1, Math.min(maxEgoDepth, egoDepth || 2));
  if (wasUnfocused) $('erdepth').style.display = 'inline-flex';   // first focus (e.g. from the whole-graph view): reveal the depth control
  updateDepthUI(); updateScopeUI(); updateTopTools();
  if (scopeAll) {
    // remember the new focus for when the scope goes back, but do not re-lay-out the org
    egoStat();
    if (curView === 'er') erRender(); else if (curView === 'visual') draw();
    return;
  }
  bfsEgo(); egoStat(); erLaidOut = false;
  if (curView === 'er') erShow();
  else if (curView === 'visual') { fitView(); draw(); }
}
function clearFocus() {
  // Back to the pristine whole-graph view — the state you get opening via "Schema".
  curFocus = null; scopeAll = false; egoSet = null; egoLevel = {};
  $('erdepth').style.display = 'none';
  updateScopeUI(); updateTopTools(); erLaidOut = false;
  $('statline').innerHTML = `<b>${DATA.counts.nodes}</b> tables · <b>${DATA.counts.edges}</b> relations · <b>${DATA.counts.dead_suspects}</b> in no relation`;
  if (curView === 'er') erShow();
  else if (curView === 'visual') { fitView(); draw(); }
}
function neighbors(id) { const s = new Set([id]); N[id].calls.forEach((c) => s.add(c)); N[id].called_by.forEach((c) => s.add(c)); return s; }
function draw() {
  if (!ctx2d) return;
  ctx2d.clearRect(0, 0, W, H);
  const near = focusNode ? neighbors(focusNode) : null;
  const set = activeSet();
  // edges
  ctx2d.lineWidth = 1;
  for (const [a, b] of edgesA) {
    if (set && !(set.has(a) && set.has(b))) continue;
    if (egoSet && !(egoSet.has(a) && egoSet.has(b))) continue;
    const [ax, ay] = screenXY(a), [bx, by] = screenXY(b);
    const hot = near && (near.has(a) && near.has(b) && (a === focusNode || b === focusNode));
    ctx2d.strokeStyle = hot ? 'rgba(47,111,237,.55)' : (near ? 'rgba(150,160,175,.10)' : 'rgba(150,160,175,.28)');
    ctx2d.beginPath(); ctx2d.moveTo(ax, ay); ctx2d.lineTo(bx, by); ctx2d.stroke();
  }
  // nodes
  for (const id of nodesA) {
    if (set && !set.has(id)) continue;
    if (egoSet && !egoSet.has(id)) continue;
    const [x, y] = screenXY(id); const r = nodeRadius(id) * Math.max(0.6, Math.min(scale, 1.6));
    const dim = !set && near && !near.has(id);
    ctx2d.globalAlpha = dim ? 0.15 : 1;
    ctx2d.fillStyle = NSCOL(N[id].namespace);
    ctx2d.beginPath(); ctx2d.arc(x, y, r, 0, Math.PI * 2); ctx2d.fill();
    if (id === focusNode) { ctx2d.lineWidth = 2; ctx2d.strokeStyle = '#182130'; ctx2d.stroke(); }
    if (id === curFocus) { ctx2d.lineWidth = 3.5; ctx2d.strokeStyle = '#fbbf24'; ctx2d.stroke(); }
    // labels honor the label mode
    const showLabel = labelMode === 'all' ? true : labelMode === 'off' ? false : (N[id].called_by.length >= 3 || scale > 1.3 || (near && near.has(id)) || (set && set.has(id)));
    if (!dim && showLabel) {
      ctx2d.globalAlpha = dim ? 0.15 : 0.9; ctx2d.fillStyle = '#334155';
      ctx2d.font = '10px ui-monospace, monospace'; ctx2d.fillText(label(N[id]), x + r + 2, y + 3);
    }
    ctx2d.globalAlpha = 1;
  }
}
function pick(mx, my) {
  let best = null, bd = 12 * 12; const set = activeSet();
  for (const id of nodesA) { if (set && !set.has(id)) continue; const [x, y] = screenXY(id); const dx = mx - x, dy = my - y; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = id; } }
  return best;
}
function onMove(e) {
  const rect = cv.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (dragging) { offX += e.clientX - lastX; offY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; draw(); return; }
  const id = pick(mx, my); const tip = $('tip');
  if (id) { tip.style.display = 'block'; tip.style.left = mx + 'px'; tip.style.top = my + 'px'; tip.textContent = N[id].id; }
  else tip.style.display = 'none';
}
function onClick(e) {
  const rect = cv.getBoundingClientRect(); const id = pick(e.clientX - rect.left, e.clientY - rect.top);
  if (id) { focusNode = id; if (subFocus) { subFocus = id; fitView(); } draw(); select(id); }
}

$('nameToggle').onclick = () => {
  nameMode = nameMode === 'display' ? 'internal' : 'display';
  $('nameToggle').textContent = 'Name: ' + nameMode;
  $('nameToggle').classList.toggle('on', nameMode === 'internal');
  render(); if (sel) select(sel, true); draw();
};

// Fit button
$('fitBtn').onclick = () => fitView();
$('focusBtn').onclick = () => {
  if (subFocus) { subFocus = null; $('focusBtn').textContent = 'Focus'; }
  else if (sel) { subFocus = sel; focusNode = sel; $('focusBtn').textContent = 'Show all'; }
  $('focusBtn').classList.toggle('on', !!subFocus);
  fitView(); draw();
};

// Auto-resize the canvas when its container changes
try { new ResizeObserver(() => { if (curView === 'visual') { resize(); fitView(); } }).observe($('visual')); } catch (_) {}

// Save PDF (via the browser's print-to-PDF)
$('pdfBtn').onclick = () => window.print();
let _pw = 0, _ph = 0;
let _pl = 'hubs';
window.addEventListener('beforeprint', () => {
  if (curView !== 'visual') return;
  _pw = W; _ph = H; _pl = labelMode; labelMode = 'all';
  const n = nodesA.length; W = Math.min(6000, 1600 + n * 12); H = Math.min(4000, 1000 + n * 8);
  cv.width = W; cv.height = H; fitView(); draw();
});
window.addEventListener('afterprint', () => {
  if (curView !== 'visual') return;
  labelMode = _pl; $('labelBtn').textContent = 'Labels: ' + labelMode;
  if (_pw) { cv.width = W = _pw; cv.height = H = _ph; } resize(); fitView();
});

$('labelBtn').onclick = () => {
  labelMode = labelMode === 'hubs' ? 'all' : labelMode === 'all' ? 'off' : 'hubs';
  $('labelBtn').textContent = 'Labels: ' + labelMode;
  draw();
};


// ---------------- ER diagram (entities + FK arrows) ----------------
let erLaidOut = false, erAll = false, erScale = 1, erTx = 0, erTy = 0;
const erPos = {};
let erIds = [];
let erEmph = 'modules';   // 'relations' = modules demoted to labels, relation names in the foreground
let erMaxX = 0, erMaxY = 0;
// Readability vs. compactness has no single right answer across graphs, so the trade-off is
// exposed as runtime controls instead of being guessed once at build time.
const ER_PRESET = {
  modules:   { margin: 36,  spread: 42, ring: 420, gap: 8,  fs: 10, sub: true },
  relations: { margin: 120, spread: 72, ring: 640, gap: 10, fs: 13, sub: true },
};
let erP = Object.assign({}, ER_PRESET.modules);
// Selecting one arc is the cheapest fix for a crowded diagram: instead of untangling everything,
// the reader isolates the single relation they care about and the rest recedes.
let erSelEdge = null;   // "a\u0000b"
const ekey = (a, b) => a + '\u0000' + b;
function erPick(a, b) { erSelEdge = (erSelEdge === ekey(a, b)) ? null : ekey(a, b); erRender(); }
function erClearPick() { if (erSelEdge) { erSelEdge = null; erRender(); } }
function erPickCard() {
  const card = $('erpick');
  if (!erSelEdge) { card.classList.remove('on'); return; }
  const [a, b] = erSelEdge.split('\u0000');
  if (!N[a] || !N[b]) { card.classList.remove('on'); return; }
  // a points at b: find the joins on a that target b. Zoho's own relation string is shown and
  // copied verbatim — it is the thing you paste into a query.
  const js = (N[a].joins || []).filter((r) => r.direction === 'out' && r.other === b);
  if (!js.length) { card.classList.remove('on'); return; }
  const snip = js.map((r) => r.relation).filter(Boolean).join('  AND  ');
  $('erpickbody').innerHTML =
    `<div class="pk1">${esc(label(N[a]))} \u2192 ${esc(label(N[b]))}</div>`
    + `<div class="pk2">${js.map((r) => `<b>${esc(r.column)}</b> \u2192 <b>${esc(r.otherColumn)}</b>`).join(' \u00b7 ')}</div>`
    + (snip ? `<div class="pksnip" id="erpicksnip" title="Click to copy">${esc(snip)}</div>` : '');
  card.classList.add('on');
  const sn = $('erpicksnip');
  if (sn) sn.onclick = () => navigator.clipboard.writeText(snip).then(() => {
    const t = sn.textContent; sn.textContent = 'copied \u2713'; setTimeout(() => { sn.textContent = t; }, 900);
  }).catch(() => {});
}
function erFieldsFor(n) {
  if (erEmph === 'relations') return [];   // the box is only a label; the edges carry the information
  const all = n.fields || [];
  const base = erAll ? all.slice() : all.filter((f) => f.lookup || f.mandatory || /^(Name|Owner|id)$/i.test(f.api_name));
  const rank = (f) => (f.lookup ? 0 : (f.mandatory ? 1 : 2));
  return base.sort((a, b) => rank(a) - rank(b));
}
function erVisibleIds() {
  if (erEmph === 'relations') {
    const linked = new Set(); edgesA.forEach(([a, b]) => { linked.add(a); linked.add(b); });
    return nodesA.filter((id) => (linked.has(id) || id === curFocus) && (!egoSet || egoSet.has(id)));
  }
  return nodesA.filter((id) => erFieldsFor(N[id]).length > 0 && (!egoSet || egoSet.has(id)));
}
function erBoxSize(n) {
  const rows = erFieldsFor(n); const w = erEmph === 'relations' ? 190 : 250, headerH = 28, rowH = 18, cap = 40;
  const shown = Math.min(rows.length, cap); const more = rows.length > cap ? 16 : 0;
  return { w, h: headerH + shown * rowH + more, rows, shown, more };
}
function erLayout() {
  erSelEdge = null;   // positions change under it; a stale pick would point at the wrong arc
  erIds = erVisibleIds();
  if (erConcentric()) {
    // concentric ego layout: focus at centre, each BFS level on its own ring (compact + readable)
    const byLevel = {};
    erIds.forEach((id) => { const L = (egoLevel[id] != null) ? egoLevel[id] : 1; (byLevel[L] = byLevel[L] || []).push(id); });
    Object.keys(byLevel).map(Number).sort((a, b) => a - b).forEach((L) => {
      const ids = byLevel[L];
      if (L === 0) { const s = erBoxSize(N[ids[0]]); erPos[ids[0]] = { x: -s.w / 2, y: -s.h / 2, w: s.w, h: s.h }; return; }
      const n = ids.length, slot = Math.max(160, erP.ring * 0.73);
      const ringR = Math.max(L * erP.ring, (n * slot) / (2 * Math.PI));
      ids.forEach((id, i) => { const ang = (i / n) * 2 * Math.PI - Math.PI / 2; const s = erBoxSize(N[id]); erPos[id] = { x: ringR * Math.cos(ang) - s.w / 2, y: ringR * Math.sin(ang) - s.h / 2, w: s.w, h: s.h }; });
    });
  } else {
    // Free layout needs the force positions. Concentric focus mode above does NOT (it uses rings),
    // so settle() is skipped there — that is the common case and it stays cheap at any org size.
    // Here we only run the O(n²) settle if we can afford it; otherwise nodes keep their initial
    // circular positions (from initCanvas) and the diagram still renders instead of freezing.
    if (!laidOut && forceFeasible()) { settle(); laidOut = true; }
    const spread = erP.spread / 10;
    erIds.forEach((id) => { const s = erBoxSize(N[id]); erPos[id] = { x: (posX[id] || 0) * spread, y: (posY[id] || 0) * spread, w: s.w, h: s.h }; });
  }
  const margin = erP.margin;   // labels live between the boxes, they need the room
  const passes = erIds.length > 150 ? 60 : 140;   // whole-org layouts are O(n\u00b2) per pass
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < erIds.length; i++) for (let j = i + 1; j < erIds.length; j++) {
      const A = erPos[erIds[i]], B = erPos[erIds[j]];
      const dx = (B.x + B.w / 2) - (A.x + A.w / 2), dy = (B.y + B.h / 2) - (A.y + A.h / 2);
      const ox = (A.w + B.w) / 2 + margin - Math.abs(dx), oy = (A.h + B.h) / 2 + margin - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        moved = true;
        if (ox < oy) { const p = (dx < 0 ? -1 : 1) * ox / 2; A.x -= p; B.x += p; }
        else { const p = (dy < 0 ? -1 : 1) * oy / 2; A.y -= p; B.y += p; }
      }
    }
    if (!moved) break;
  }
  let minX = Infinity, minY = Infinity;
  erIds.forEach((id) => { minX = Math.min(minX, erPos[id].x); minY = Math.min(minY, erPos[id].y); });
  erIds.forEach((id) => { erPos[id].x -= minX - 40; erPos[id].y -= minY - 40; });
}
function erEdgePoints(A, B) {
  const acx = A.x + A.w / 2, bcx = B.x + B.w / 2;
  const ax = bcx >= acx ? A.x + A.w : A.x, ay = A.y + A.h / 2;
  const bx = bcx >= acx ? B.x : B.x + B.w, by = B.y + B.h / 2;
  return [ax, ay, bx, by];
}
function erApply() { $('ervp').style.transform = `translate(${erTx}px,${erTy}px) scale(${erScale})`; }
function erRender() {
  const shown = new Set(erIds);
  const boxes = $('erboxes'); boxes.innerHTML = '';
  let maxX = 0, maxY = 0;
  erIds.forEach((id) => {
    const n = N[id], p = erPos[id], s = erBoxSize(n);
    maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
    const div = document.createElement('div');
    const pickIds = erSelEdge ? erSelEdge.split('\u0000') : null;
    const inPick = pickIds ? pickIds.includes(id) : null;
    div.className = 'erbox ' + (n.namespace === 'custom' ? 'custom' : 'standard') + (erEmph === 'relations' ? ' dim' : '')
      + (inPick === false ? ' faded' : '') + (inPick === true ? ' epick' : '')
      + (id === sel ? ' sel' : '') + (id === curFocus ? ' focus' : '');
    div.style.cssText = `left:${p.x}px;top:${p.y}px;width:${p.w}px`;
    const rows = s.rows.slice(0, s.shown).map((fld) => {
      const lk = fld.lookup ? ' lk' : ''; const req = fld.mandatory ? '<span class="pk">*</span>' : '';
      const t = fld.lookup ? ('\u2192 ' + esc(label(N[fld.lookup]) || fld.lookup)) : esc(fld.data_type || '');
      return `<div class="errow${lk}"><span class="fn">${esc(fld.api_name)}${req}</span><span class="ft">${t}</span></div>`;
    }).join('');
    const more = s.more ? `<div class="ermore">+${s.rows.length - s.shown} more\u2026</div>` : '';
    div.innerHTML = `<div class="erhdr"><span>${esc(n.display_name || n.api_name)}</span><small>${esc(n.api_name)}</small></div>${rows}${more}`;
    div.onclick = () => { if (erDragged) return; const wasFocus = curFocus; select(id); if (!wasFocus) erRender(); };
    boxes.appendChild(div);
  });
  const svg = $('ersvg');
  [...svg.querySelectorAll('.erlink,.erlabel,.erlead')].forEach((x) => x.remove());
  $('v-er').classList.toggle('relemph', erEmph === 'relations');

  // --- pass 1: draw the links, collect the label descriptors ---
  const labels = [];
  const REL = erEmph === 'relations';
  edgesA.forEach(([a, b]) => {
    if (!shown.has(a) || !shown.has(b)) return;
    const A = erPos[a], B = erPos[b]; const [x1, y1, x2, y2] = erEdgePoints(A, B); const mx = (x1 + x2) / 2;
    const hot = (a === sel || b === sel);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
    path.setAttribute('class', 'erlink'); path.setAttribute('fill', 'none');
    const key = ekey(a, b), picked = erSelEdge === key, dimmed = erSelEdge && !picked;
    path.setAttribute('stroke', picked ? '#d97706' : (dimmed ? '#e7e2f5' : (hot ? '#7c3aed' : (REL ? '#dcd4f7' : '#c4b5fd'))));
    path.setAttribute('stroke-width', picked ? '3' : (dimmed ? '1' : (hot ? '2' : (REL ? '1' : '1.3'))));
    path.setAttribute('marker-end', picked ? 'url(#erarrowsel)' : 'url(#erarrow)');
    svg.appendChild(path);
    // invisible fat copy: makes a 1px arc comfortably clickable
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', path.getAttribute('d')); hit.setAttribute('class', 'erhit');
    hit.setAttribute('fill', 'none'); hit.setAttribute('stroke', 'transparent'); hit.setAttribute('stroke-width', '14');
    hit.addEventListener('click', (ev) => { if (erDragged) return; ev.stopPropagation(); erPick(a, b); });
    const ht = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    ht.textContent = `${label(N[b]) || b} \u2192 ${label(N[a]) || a}`; hit.appendChild(ht);
    svg.appendChild(hit);

    // The join, from A's side: which of A's columns points at which of B's. Both ends are labelled
    // because a foreign key is not symmetric and the reader needs to know which way it runs.
    const jo = (N[a].joins || []).filter((r) => r.direction === 'out' && r.other === b);
    const fld = jo.length ? { api_name: jo[0].column } : null;
    const full = [...new Set(jo.map((r) => r.otherColumn).filter(Boolean))].join(' / ');
    const rl = jo;                       // same shape downstream: "is there a named relation here"
    const cy = (y1 + y2) / 2;
    if (!jo.length) return;

    if (REL) {
      // one label per edge: relation name headline, lookup field as a footnote inside the pill
      const head = jo.length ? `${jo[0].column} \u2192 ${jo[0].otherColumn}${jo.length > 1 ? `  +${jo.length - 1}` : ''}` : '';
      const sub = (erP.sub && fld) ? fld.api_name : '';
      const fs = erP.fs, cw = fs * 0.615;
      const w = Math.max(head.length * cw, sub.length * (fs * 0.47)) + 20;
      const h = sub ? fs + 21 : fs + 10;
      labels.push({ cx: mx, cy, w, h, ax: mx, ay: cy, head, sub, hot, fs, a, b, key, title: (jo[0] && jo[0].relation) || head, rel: true });
    } else {
      if (fld) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', mx); t.setAttribute('y', cy - 3); t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'erlabel'); t.textContent = fld.api_name;
        t.setAttribute('style', `font:10px ui-monospace,monospace;fill:${hot ? '#6d28d9' : '#8b5cf6'};stroke:#eef1f6;stroke-width:3px;paint-order:stroke`);
        svg.appendChild(t);
      }
      if (full) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', mx); t.setAttribute('y', cy + 9); t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'erlabel'); t.textContent = '\u25c2 ' + full;
        t.setAttribute('style', `font:9.5px ui-monospace,monospace;fill:${hot ? '#b45309' : '#d97706'};stroke:#eef1f6;stroke-width:3px;paint-order:stroke`);
        svg.appendChild(t);
      }
    }
  });

  // --- pass 2: pull the labels apart, and away from the boxes ---
  if (labels.length) {
    const obst = erIds.map((id) => erPos[id]);
    const GAP = erP.gap;
    for (let pass = 0; pass < 220; pass++) {
      let moved = false;
      for (let i = 0; i < labels.length; i++) {
        const L = labels[i];
        for (let j = i + 1; j < labels.length; j++) {
          const M = labels[j];
          const dx = M.cx - L.cx, dy = M.cy - L.cy;
          const ox = (L.w + M.w) / 2 + GAP - Math.abs(dx), oy = (L.h + M.h) / 2 + GAP - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            moved = true;
            // labels are wide and short: separating vertically keeps them near their edge
            const p = (dy < 0 ? -1 : 1) * Math.min(oy, 26) / 2;
            L.cy -= p; M.cy += p;
            if (oy > 40) { const q = (dx < 0 ? -1 : 1) * ox / 6; L.cx -= q; M.cx += q; }
          }
        }
        for (const O of obst) {
          const dx = (O.x + O.w / 2) - L.cx, dy = (O.y + O.h / 2) - L.cy;
          const ox = (L.w + O.w) / 2 + GAP - Math.abs(dx), oy = (L.h + O.h) / 2 + GAP - Math.abs(dy);
          if (ox > 0 && oy > 0) { moved = true; L.cy -= (dy < 0 ? -1 : 1) * Math.min(oy, 22); }
        }
        // gentle spring back to the edge midpoint so labels stay readable as edge labels
        L.cx += (L.ax - L.cx) * 0.02; L.cy += (L.ay - L.cy) * 0.02;
      }
      if (!moved) break;
    }
    labels.sort((x, y) => (x.key === erSelEdge ? 1 : 0) - (y.key === erSelEdge ? 1 : 0));
    labels.forEach((L) => {
      const picked = erSelEdge === L.key, dimmed = erSelEdge && !picked;
      const x = L.cx - L.w / 2, y = L.cy - L.h / 2;
      maxX = Math.max(maxX, x + L.w); maxY = Math.max(maxY, y + L.h);
      // leader line back to the edge it belongs to, when the label had to move
      if (Math.hypot(L.cx - L.ax, L.cy - L.ay) > 14) {
        const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('x1', L.ax); ln.setAttribute('y1', L.ay); ln.setAttribute('x2', L.cx); ln.setAttribute('y2', L.cy);
        ln.setAttribute('class', 'erlead');
        ln.setAttribute('style', `stroke:${erSelEdge === L.key ? '#b45309' : '#d9c9a8'};stroke-width:1;stroke-dasharray:3 3;opacity:${erSelEdge && erSelEdge !== L.key ? 0.12 : 1}`);
        svg.appendChild(ln);
      }
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'erlabel');
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', L.w); r.setAttribute('height', L.h); r.setAttribute('rx', 7);
      r.setAttribute('style', `fill:${picked ? '#fde68a' : (L.hot ? '#fef3c7' : '#fffbeb')};stroke:${picked ? '#b45309' : (L.hot ? '#d9a441' : '#e8b563')};stroke-width:${picked ? 2 : (L.hot ? 1.4 : 1)}`);
      g.appendChild(r);
      const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t1.setAttribute('x', L.cx); t1.setAttribute('y', y + L.fs + 3); t1.setAttribute('text-anchor', 'middle');
      t1.setAttribute('style', `font:700 ${L.fs}px ui-monospace,monospace;fill:${L.rel ? '#92400e' : '#7c3aed'}`);
      t1.textContent = L.head; g.appendChild(t1);
      if (L.sub) {
        const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t2.setAttribute('x', L.cx); t2.setAttribute('y', y + L.h - 6); t2.setAttribute('text-anchor', 'middle');
        t2.setAttribute('style', `font:${Math.max(8, L.fs - 3)}px ui-monospace,monospace;fill:#9b8ab8`);
        t2.textContent = L.sub; g.appendChild(t2);
      }
      const ttl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      ttl.textContent = L.title + (L.sub ? ' \u2014 via ' + L.sub : '');
      g.appendChild(ttl);
      if (dimmed) g.setAttribute('opacity', '0.14');
      g.addEventListener('click', (ev) => { if (erDragged) return; ev.stopPropagation(); erPick(L.a, L.b); });
      svg.appendChild(g);
    });
  }
  erMaxX = maxX; erMaxY = maxY;
  svg.setAttribute('width', maxX + 60); svg.setAttribute('height', maxY + 60);
  erPickCard();
}
function erFit() {
  let maxX = erMaxX, maxY = erMaxY;
  erIds.forEach((id) => { const p = erPos[id]; if (!p) return; maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h); });
  const vw = $('v-er').clientWidth || 1000, vh = $('v-er').clientHeight || 700, pad = 40;
  erScale = Math.max(0.02, Math.min(1.4, Math.min((vw - pad * 2) / (maxX || 1), (vh - pad * 2) / (maxY || 1))));
  erTx = (vw - maxX * erScale) / 2; erTy = (vh - maxY * erScale) / 2; erApply();
}
function erShow() { if (!erLaidOut) { erLayout(); erLaidOut = true; } erRender(); erFit(); erUpdateControlVis(); }
let erDown = false, erDragged = false, erSx = 0, erSy = 0, erT0x = 0, erT0y = 0;
document.addEventListener('mousedown', (e) => {
  if (curView !== 'er' || e.target.closest('#ertools')) return;
  erDown = true; erDragged = false; erSx = e.clientX; erSy = e.clientY; erT0x = erTx; erT0y = erTy;
});
document.addEventListener('mousemove', (e) => {
  if (!erDown) return; const dx = e.clientX - erSx, dy = e.clientY - erSy;
  if (Math.abs(dx) + Math.abs(dy) > 4) erDragged = true; erTx = erT0x + dx; erTy = erT0y + dy; erApply();
});
document.addEventListener('mouseup', () => { erDown = false; setTimeout(() => (erDragged = false), 0); });
document.addEventListener('wheel', (e) => {
  if (curView !== 'er') return; e.preventDefault();
  const rect = $('v-er').getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const before = erScale; erScale = Math.max(0.02, Math.min(3, erScale * (e.deltaY < 0 ? 1.1 : 0.9)));
  erTx = mx - (mx - erTx) * (erScale / before); erTy = my - (my - erTy) * (erScale / before); erApply();
}, { passive: false });
$('erScope').onclick = () => setScope(!scopeAll);
$('visScope').onclick = () => setScope(!scopeAll);
$('erReset').onclick = clearFocus;
$('visReset').onclick = clearFocus;
// ---- runtime layout controls ----
const ER_CTL = [
  ['pMargin', 'vMargin', 'margin'], ['pSpread', 'vSpread', 'spread'],
  ['pRing', 'vRing', 'ring'], ['pGap', 'vGap', 'gap'], ['pFs', 'vFs', 'fs'],
];
const ER_RELAYOUT = new Set(['margin', 'spread', 'ring']);
let _erT = null;
// Which layout branch is live decides which knobs mean anything:
// concentric (focus + ego set) is driven by `ring`, the force branch by `spread`.
function erConcentric() { return !!(curFocus && egoSet); }   // concentric follows the CURRENT focus, not just the one it was opened with
function erUpdateControlVis() {
  const rel = erEmph === 'relations', conc = erConcentric();
  const set = (id, on) => { const e = $(id); if (e) e.classList.toggle('off', !on); };
  set('rowMargin', true);
  set('rowSpread', !conc);
  set('rowRing', conc);
  set('rowGap', rel);
  set('rowFs', rel);
  set('rowSub', rel);
  const h = $('erlayHead');
  if (h) h.textContent = (conc ? 'Concentric layout (focus + depth)' : 'Free layout (all modules)')
    + ' \u00b7 ' + (rel ? 'relation labels' : 'module boxes');
}
function erParamsToUI() {
  ER_CTL.forEach(([sl, lb, k]) => { const e = $(sl); if (e) { e.value = erP[k]; $(lb).textContent = k === 'spread' ? (erP[k] / 10).toFixed(1) : erP[k]; } });
  const cb = $('pSub'); if (cb) cb.checked = !!erP.sub;
}
function erApplyParams(relayout) {
  if (_erT) clearTimeout(_erT);
  _erT = setTimeout(() => {
    if (relayout) { erLaidOut = false; erShow(); } else { erRender(); }
  }, 110);
}
function erInitControls() {
  ER_CTL.forEach(([sl, lb, k]) => {
    const e = $(sl); if (!e) return;
    e.addEventListener('input', () => {
      erP[k] = parseInt(e.value, 10);
      $(lb).textContent = k === 'spread' ? (erP[k] / 10).toFixed(1) : erP[k];
      erSaveParams(); erApplyParams(ER_RELAYOUT.has(k));
    });
  });
  const cb = $('pSub');
  if (cb) cb.addEventListener('change', () => { erP.sub = cb.checked; erSaveParams(); erApplyParams(false); });
  $('erlayReset').onclick = () => {
    erP = Object.assign({}, ER_PRESET[erEmph] || ER_PRESET.modules);
    erParamsToUI(); erSaveParams(); erApplyParams(true);
  };
  $('erLayBtn').onclick = () => {
    const on = $('erlay').classList.toggle('on');
    $('erLayBtn').classList.toggle('on', on);
    if (on) erUpdateControlVis();
  };
  erParamsToUI(); erUpdateControlVis();
}
function erSaveParams() { try { chrome.storage.local.set({ erParams: { modules: erEmph === 'modules' ? erP : null, current: erP, mode: erEmph } }); } catch (_) {} }
$('erEmph').onclick = () => {
  erEmph = erEmph === 'relations' ? 'modules' : 'relations';
  $('erEmph').textContent = 'Emphasis: ' + erEmph;
  $('erEmph').classList.toggle('on', erEmph === 'relations');
  $('erAll').disabled = erEmph === 'relations';
  erP = Object.assign({}, ER_PRESET[erEmph]);   // each mode has its own sensible starting point
  erParamsToUI(); erUpdateControlVis(); erSaveParams();
  erLaidOut = false; erShow();
};
$('erpickx').onclick = () => erClearPick();
$('v-er').addEventListener('click', (e) => {
  if (erDragged) return;
  const t = e.target;
  if (t.closest && (t.closest('#ertools') || t.closest('#erlay') || t.closest('#erpick') || t.closest('.erbox'))) return;
  erClearPick();
});
$('erAll').onclick = () => { erAll = !erAll; $('erAll').textContent = 'Fields: ' + (erAll ? 'all' : 'key'); erLaidOut = false; erShow(); };
$('erFit2').onclick = () => erFit();
$('erPdf').onclick = () => window.print();

// ER PDF: print the whole diagram on ONE page sized to the content (no horizontal clipping)
let _erStyle = null;
window.addEventListener('beforeprint', () => {
  if (curView !== 'er') return;
  let maxX = erMaxX, maxY = erMaxY;
  erIds.forEach((id) => { const p = erPos[id]; if (p) { maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h); } });
  const W = Math.ceil(maxX + 40), H = Math.ceil(maxY + 40);
  _erStyle = document.createElement('style');
  _erStyle.textContent = `@page{size:${W}px ${H}px;margin:0}
    @media print{
      header,#ertools,.hint2,#v-explorer,#v-visual{display:none !important}
      html,body{width:${W}px;height:${H}px;overflow:visible !important;background:#fff}
      .wrap{position:static !important}
      #v-er{position:absolute !important;left:0;top:0;width:${W}px !important;height:${H}px !important;overflow:visible !important}
      #ervp{transform:none !important;position:absolute !important;left:0;top:0}
    }`;
  document.head.appendChild(_erStyle);
});
window.addEventListener('afterprint', () => {
  if (_erStyle) { _erStyle.remove(); _erStyle = null; }
  if (curView === 'er') { erApply(); erFit(); }
});

// Descriptive PDF filename (browsers use document.title as the print filename)
function pdfTitle() {
  const ws = DATA.workspace || {};
  const kind = DATA.kind === 'schema' ? (curView === 'er' ? 'schema-ER' : 'schema') : 'functions';
  const d = new Date().toISOString().slice(0, 10);
  return `Zoost-${kind}-${ws.instance || 'unknown'}-org${ws.org || 'x'}-${d}`;
}
let _prevDocTitle = null;
window.addEventListener('beforeprint', () => { _prevDocTitle = document.title; document.title = pdfTitle(); });
window.addEventListener('afterprint', () => { if (_prevDocTitle != null) { document.title = _prevDocTitle; _prevDocTitle = null; } });

// Visible attribution (also appears in the printed PDF)
(function () {
  const el = document.getElementById('credit'); if (!el) return;
  const url = PRODUCT_URL ? ` \u00b7 <a href="${escA(PRODUCT_URL)}">${PRODUCT_URL}</a>` : '';
  el.innerHTML = `${PRODUCT_NAME}${url} \u00b7 Created by ${PRODUCT_AUTHOR} \u00b7 Apache-2.0 \u00b7 Independent, unofficial tool \u2014 not affiliated with Zoho Corporation \u00b7 provided AS IS, no warranty`;
})();
