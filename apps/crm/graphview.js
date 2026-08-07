// --- Attribution (set PRODUCT_URL to the Chrome Web Store URL once available) ---
const PRODUCT_NAME = chrome.runtime.getManifest().name;   // renaming happens in manifest.json only
const PRODUCT_URL = 'https://zoost.it';
const PRODUCT_AUTHOR = 'Ivan Notaristefano';
/* graphview.js - Explorer + Visual graph. Reads graph from chrome.storage.local. */
let DATA = null, N = {}, ids = [], sel = null, hist = [], nameMode = 'display';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// esc() is NOT attribute-safe: a double quote closes the attribute early and silently truncates
// the value - that is what cut the getRelatedRecords snippet right after the opening bracket.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (n) => (nameMode === 'internal'
  ? (n.api_name || n.name)
  : ((DATA && DATA.kind === 'schema') ? (n.display_name || n.api_name || n.name) : n.name));
// The one dimension the list and the chips share. In functions mode the chips select a function's
// *category* - standalone, automation, button, schedule, validation rule - and the dot was coloured
// by its Deluge *namespace*, which is a different fact and usually has no colour defined, so every
// dot came out the fallback grey. `pass()` had the same confusion and compared the chip against
// `namespace` too, which means those five filters only ever worked in an org where Zoho returns no
// namespace at all. One accessor now decides both, so they cannot drift apart again.
// What this window is drawing, in words. Four status lines were writing «modules» and «lookups»
// literally, so a call graph reported the wrong nouns in three of them. Derived once, from the kind.
// A call graph carries what fires the code and what the code reaches, so its nodes are not all
// functions and calling them that would be counting the wrong thing. The breakdown is stated rather
// than summarised: «3 functions · 1 workflow · 1 schedule · 2 connections» is a fact, «7 nodes» is a
// shrug - and this window exists to answer what is there, not how much of it.
const ENTITY_WORD = { workflows: 'workflow', schedules: 'schedule', connections: 'connection' };
function entityBreakdown() {
  const c = {}, all = {};
  Object.values(N).forEach((n) => {
    const k = ENTITY_WORD[n.category] || 'function';
    all[k] = (all[k] || 0) + 1;
    if (passKind(n)) c[k] = (c[k] || 0) + 1;
  });
  return ['function', 'workflow', 'schedule', 'connection'].filter((k) => all[k]).map((k) => {
    const shown = c[k] || 0;
    const of = shown !== all[k] ? ` <span style="color:#94a3b8">of ${all[k]}</span>` : '';
    return `<b>${shown}</b>${of} ${k}${all[k] === 1 ? '' : 's'}`;
  }).join(' \u00b7 ');
}
const NOUN = () => (DATA.kind === 'schema'
  ? { n: 'modules', e: 'lookups', dead: 'unreferenced', all: 'All modules', box: 'table' }
  : { n: 'nodes', e: 'links', dead: 'nothing calls them', all: 'Everything', box: 'node' });
const KINDOF = (n) => (DATA.kind === 'schema' ? n.namespace : n.category) || '';
// A declared hue where there is one, and a stable fallback where there is not - because the set of
// categories is the platform's to decide, not ours. Hashed rather than indexed by position, so a
// kind keeps its colour when another appears or disappears beside it.
const FALLBACK_HUES = ['#0ea5e9', '#f97316', '#14b8a6', '#a855f7', '#84cc16', '#ec4899', '#64748b', '#eab308'];
function hueFor(k) {
  let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return FALLBACK_HUES[h % FALLBACK_HUES.length];
}
const KINDCOL = (k) => getComputedStyle(document.documentElement).getPropertyValue('--n-' + k).trim() || (k ? hueFor(k) : '');
const NSCOL = (ns) => KINDCOL(ns) || '#94a3b8';

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
  // The boxed diagram is the same drawing in both cases, so it is the same tab - under the name the
  // project already gives each one: "ER diagram" for modules and tables, "Graph" for functions.
  // Two names, never a third.
  //
  // It was "Call graph" and it stayed "Call graph" through a rename, because the markup said Graph
  // and this line wrote the old word back over it on every open - the exact trap this repository
  // already records about labels that live in the markup and are rebuilt by the code that updates
  // state. The label is written here because it genuinely varies with the subject; what it must not
  // do is disagree with the button in the panel that opens it, which now says Graph too.
  {
    $('ertab').style.display = '';
    $('ertab').textContent = _schema ? 'ER diagram' : 'Graph';
    $('reltab').style.display = ''; buildRelChips();
    erP = Object.assign({}, ER_PRESET[erBoxPreset()]);
    try {
      const st = await chrome.storage.local.get('erParams');
      if (st && st.erParams && st.erParams.current && st.erParams.kind === DATA.kind) erP = Object.assign({}, erP, st.erParams.current);
    } catch (_) {}
    erInitControls();
    // Depth buttons wired once: they work whether the focus comes from the open ("Open ER") or is
    // set later by selecting a module in the Explorer of a whole-graph ("Schema") view.
    $('erdMinus').onclick = () => setDepth(egoDepth - 1);
    $('erdPlus').onclick = () => setDepth(egoDepth + 1);
  }
  graphStat();
  const ws = DATA.workspace || {};
  // The name the user gave the workspace, if there is one, and never *instead of* the platform's:
  // a header showing only our own words would be one nobody could check against Zoho, which is the
  // reason the panel keeps both too.
  $('s-ws').innerHTML = (ws.instance || ws.org)
    ? `\u00b7 ${ws.label ? `<b>${esc(ws.label)}</b> \u00b7 ` : ''}${ws.label ? '' : '<b>'}${esc(ws.instance || '?')}${ws.label ? '' : '</b>'} \u00b7 org ${esc(ws.org || '?')}`
    : '';
  // The box searches whatever this window is drawing, and it stopped being only functions the day
  // workflows, schedules and connections became nodes.
  $('q').placeholder = (DATA.kind === 'schema' ? 'Search module\u2026' : 'Search anything here\u2026') + '  (/ to focus)';
  buildChips(); render(); initPositions(); wireSubject(); graphStat();
  if (DATA.focus && N[DATA.focus]) {
    curFocus = DATA.focus; computeMaxDepth();
    egoDepth = Math.max(1, Math.min(maxEgoDepth, DATA.depth || 2));
    $('erdepth').style.display = 'inline-flex'; updateDepthUI();
    bfsEgo(); egoStat(); updateScopeUI();
    const t = document.querySelector('.tab[data-v="er"]'); if (t) setTimeout(() => t.click(), 60);
  }
})();

// ---------------- Explorer ----------------
// What the window is drawing, in two questions.
//
// KINDS is «which kinds are on screen», and every one of them starts **on**: the chips show what you
// are looking at, and turning one off removes it. The first model was the other way round - nothing
// selected meant everything, and excluding the connections meant selecting the other eight - which
// he reported as having to work backwards. Showing the state and letting it be switched off is the
// same information with the work in the right direction.
//
// ONLY is «narrow to nodes that are also...». Those are conditions - facts *about* a node, not kinds
// of node - so they carry no hue and they start off, because «no condition applied» is the truth
// when none is chosen. Two behaviours, which is why they are two labelled groups and not one row:
// the level of a dimension has to be visible, not inferred.
// Derived from the graph, never listed here.
//
// The list used to be written out, and it was written out **wrong**: those five words -
// standalone, automation, button, schedule, validation_rule - are `NS` from graph-core, the Deluge
// *namespaces* the call regex matches. `KINDOF` reads `category`, which is a different field with
// different values (`scheduler`, `crmfundamentals`, …). So a node whose category was not one of the
// five namespaces matched no chip, got no hue, and could never be switched off - which is how
// «None» left items on screen. It is the same mismatch this repository already recorded once:
// variables named after categories and consumed as namespaces. Fixed on one side then, and the
// list left holding the other side's values.
//
// So the kinds come from the nodes. A category Zoho invents tomorrow gets a chip without anyone
// remembering, and nothing can be switched off that the filter does not know about.
const ENTITY_KINDS = [['workflows', 'Workflows'], ['schedules', 'Schedules'], ['connections', 'Connections']];
function kindGroups() {
  // The empty string is a kind too. A function Zoho gave no category for is a fact about the org,
  // and filtering it out of this set left it with no chip - so it could not be switched off, and
  // «None» left it on screen, which is exactly the defect one layer down.
  const seen = new Set(Object.values(N).map((n) => KINDOF(n)));
  const entity = ENTITY_KINDS.filter(([k]) => seen.has(k));
  entity.forEach(([k]) => seen.delete(k));
  const rest = [...seen].sort();
  const title = DATA.kind === 'schema' ? 'Modules' : 'Functions';
  return (rest.length ? [[title, rest.map((k) => [k, k ? k.replace(/_/g, ' ') : 'no category'])]] : [])
    .concat(entity.map(([k, l]) => [l, [[k, null]]]));
}
// Function-only, all three of them, which is the other half of why they cannot sit among the kinds:
// «REST» and «unresolved» say nothing about a workflow or a connection.
const ONLY = {
  calls: [['rest', 'REST'], ['dead', 'no-caller'], ['unres', 'unresolved']],
  schema: [['hub', 'hub (3+)'], ['orphan', 'orphan']],
};
const onlyList = () => ONLY[DATA.kind === 'schema' ? 'schema' : 'calls'];
const allKinds = () => kindGroups().flatMap(([, ks]) => ks.map(([k]) => k));

let hiddenKinds = new Set();   // switched off, so absent from every view
let onlyConds = new Set();     // narrow to nodes that are also these

function chipEl(k, label, hue) {
  const c = document.createElement('span');
  c.className = 'chip'; c.dataset.k = k;
  if (hue) { c.dataset.hue = k; c.style.setProperty('--hue', hue); c.innerHTML = '<span class="cdot"></span>'; }
  c.appendChild(document.createTextNode(label));
  return c;
}
function buildChips() {
  const box = $('chips'); box.innerHTML = '';
  kindGroups().forEach(([title, ks]) => {
    const g = document.createElement('span'); g.className = 'dim';
    // A dimension with one kind in it is its own chip: a label plus a single chip saying the same
    // word twice is a box drawn for the sake of symmetry.
    if (ks.length === 1) {
      const [k] = ks[0];
      const c = chipEl(k, title, KINDCOL(k));
      c.classList.add('solo');
      g.appendChild(c);
    } else {
      const t = document.createElement('span'); t.className = 'dimt'; t.textContent = title;
      g.appendChild(t);
      ks.forEach(([k, l]) => g.appendChild(chipEl(k, l, KINDCOL(k))));
    }
    box.appendChild(g);
  });
  const only = document.createElement('span'); only.className = 'dim only';
  const ot = document.createElement('span'); ot.className = 'dimt'; ot.textContent = 'Only';
  only.appendChild(ot);
  onlyList().forEach(([k, l]) => only.appendChild(chipEl(k, l, null)));
  box.appendChild(only);

  // Both directions, because either one alone is the other's problem. Starting from everything is
  // right while you are reading a result and wrong while you are hunting for one kind: isolating
  // «standalone» meant switching eight things off, which is the same eight clicks the first model
  // charged for the opposite job. «None» empties it so one click brings back what you want.
  const btn = (id, label, title, fn) => {
    const e = document.createElement('span');
    e.className = 'chipx'; e.id = id; e.textContent = label; e.title = title;
    e.setAttribute('role', 'button'); e.setAttribute('aria-label', title);
    e.onclick = fn; box.appendChild(e);
  };
  btn('chipall', '\u21ba All', 'Show everything again',
    () => { hiddenKinds.clear(); onlyConds.clear(); syncChips(); applyFilter(); });
  btn('chipnone', 'None', 'Switch everything off, then turn on the one you want',
    () => { hiddenKinds = new Set(allKinds()); syncChips(); applyFilter(); });

  box.onclick = (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const k = c.dataset.k;
    if (CONDITION_KEYS.has(k)) { onlyConds.has(k) ? onlyConds.delete(k) : onlyConds.add(k); }
    else { hiddenKinds.has(k) ? hiddenKinds.delete(k) : hiddenKinds.add(k); }
    syncChips(); applyFilter();
  };
  syncChips();
}
const CONDITION_KEYS = new Set(['rest', 'dead', 'unres', 'hub', 'orphan']);
function syncChips() {
  document.querySelectorAll('#chips .chip').forEach((c) => {
    const k = c.dataset.k;
    c.setAttribute('aria-pressed', CONDITION_KEYS.has(k) ? onlyConds.has(k) : !hiddenKinds.has(k));
  });
  // Each is absent when it would do nothing: no «everything» to go back to while nothing is off, and
  // no «none» to reach while nothing is on.
  const a = $('chipall'), n = $('chipnone');
  if (a) a.style.display = (hiddenKinds.size || onlyConds.size) ? '' : 'none';
  if (n) n.style.display = hiddenKinds.size < allKinds().length ? '' : 'none';
}
function passKind(n) {
  if (hiddenKinds.has(KINDOF(n))) return false;
  for (const c of onlyConds) {
    if (c === 'rest' && !n.rest) return false;
    if (c === 'dead' && !n.dead_suspect) return false;
    if (c === 'unres' && !n.unresolved.length) return false;
    if (c === 'hub' && n.called_by.length < 3) return false;
    if (c === 'orphan' && !(n.called_by.length === 0 && n.calls.length === 0)) return false;
  }
  return true;
}
function pass(n, q) {
  if (!passKind(n)) return false;
  return !q || n.name.toLowerCase().includes(q) || (n.display_name || '').toLowerCase().includes(q);
}
// The chips choose what the window is looking at, so all four views follow them. The search box
// narrows the *list* only: hiding the diagram down to one node as you type would be a different
// feature wearing the same control.
function applyFilter() {
  render();
  statRefresh();
  if (curView === 'rel') relRender();
  // Not just a repaint: erLayout re-runs the force settle for the set that is left, so the diagram
  // closes up around what survives instead of keeping the extent of the graph it no longer is.
  erLaidOut = false;
  if (curView === 'er') erShowMaybeHeavy();
}
function render() {
  const q = $('q').value.trim().toLowerCase(); const listEl = $('list'); listEl.innerHTML = '';
  // An empty list has three reasons and they are not the same advice. Nothing here is ever silent
  // about which one it is - the rule this project applies to every empty state.
  const shownIds = ids.filter((i) => pass(N[i], q));
  if (!shownIds.length) {
    const why = hiddenKinds.size >= allKinds().length
      ? '<b>Everything is switched off.</b> Turn a chip on above to choose what to show.'
      : (hiddenKinds.size || onlyConds.size)
        ? '<b>Nothing matches the filter.</b> <span>\u21ba All</span> above puts everything back.'
        : (q ? '<b>Nothing matches that search.</b>' : '<b>Nothing in this graph.</b>');
    listEl.innerHTML = `<div class="empty" style="padding:14px 12px">${why}</div>`;
    return;
  }
  ids.map((i) => N[i]).filter((n) => pass(n, q))
    .sort((a, b) => (b.called_by.length - a.called_by.length) || a.name.localeCompare(b.name))
    .forEach((n) => {
      const d = document.createElement('div'); d.className = 'item'; d.setAttribute('aria-selected', n.id === sel);
      d.innerHTML = `<span class="dot" style="background:${NSCOL(KINDOF(n))}"></span><span class="nm">${esc(label(n))}</span><span class="ns">${esc(String(n.namespace || "").slice(0, 4))}</span><span class="deg">${n.unreadable ? '?' : n.called_by.length + '◂'}</span>`;
      d.title = [KINDOF(n), n.namespace].filter(Boolean).join(' \u00b7 ');
      if (n.unreadable) { d.classList.add('unread'); d.title = 'Zoho would not describe this module - its fields and relations were never read, so it is not that it has none'; }
      d.onclick = () => select(n.id); listEl.appendChild(d);
    });
}
function refRow(id) {
  const n = N[id]; const d = document.createElement('div'); d.className = 'ref';
  d.innerHTML = `<span class="dot" style="background:${NSCOL(KINDOF(n))}"></span><span class="nm">${esc(n.namespace + "." + label(n))}</span><span class="deg">${n.unreadable ? '?' : n.called_by.length + '◂'}</span>`;
  if (n.unreadable) { d.classList.add('unread'); d.title = 'Zoho would not describe this module - its fields and relations were never read'; }
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
      return `<td class="lcol"><span class="d${req ? ' req' : ''}" title="${escA(l.name || String(l.id))}${req ? ' - required here' : ''}"></span></td>`;
    }).join('') : '';
    return `<tr class="${orphan ? 'nolay' : ''}">
    <td>${esc(f.label || f.api_name)}${f.custom ? ' <span style="color:#a78bfa">*</span>' : ''}${orphan ? '<span class="nolaytag">no layout</span>' : ''}</td>
    <td class="mono">${esc(f.api_name)}</td>
    <td>${esc(f.data_type || '')}${f.length ? ` (${f.length})` : ''}</td>
    <td style="text-align:center">${f.mandatory ? '\u25cf' : ''}</td>
    <td class="mono">${f.lookup ? '\u2192 ' + esc(f.lookup) : ''}</td>${cells}
  </tr>`;
  }).join('');

  const head = detail && layFilter !== null
    ? `Fields in \u00ab${esc(lays[layFilter].name || lays[layFilter].id)}\u00bb \u00b7 ${rowsSrc.length} of ${all.length}`
    : (n.unreadable ? 'Fields - never read' : `Fields \u00b7 ${all.length}${detail ? ` \u00b7 ${lays.length} layout(s)` : ''}`);

  const legend = detail
    ? `<div class="laylegend"><span class="d"></span> in layout \u00b7 <span class="d req"></span> required in that layout \u00b7 highlighted rows are fields in <b>no</b> layout (API-only)</div>`
    : (lays.length ? `<div class="laylegend">Layout detail not in this graph - re-run <b>Pull Modules</b>, then reopen the diagram.</div>` : '');

  return `<div class="srcwrap"><div class="srchead">${head}</div>${chips}`
    + `<div style="display:block;padding:0;max-height:340px;overflow:auto;background:#fff"><table class="ftbl"><thead><tr><th>Field</th><th>API</th><th>Type</th><th>Req</th><th>Lookup</th>${lhead}</tr></thead><tbody>${rows}</tbody></table></div>${legend}</div>`;
}
function wireLayoutZone(n) {
  document.querySelectorAll('#layzone .laychip').forEach((c) => (c.onclick = () => {
    layFilter = c.dataset.lay === 'all' ? null : parseInt(c.dataset.lay, 10);
    const z = $('layzone'); if (z) { z.innerHTML = layoutZoneHtml(n); wireLayoutZone(n); }
  }));
}
function relatedListsHtml(n) {
  const rls = n.related_lists || [];
  // The exact sentence the panel stopped giving, still here: "run Pull Modules again" cannot work on
  // a module Zoho refuses to describe, and «Related lists · 0» claims a count nobody took.
  if (n.unreadable) {
    return `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Related lists</div>`
      + `<div style="padding:9px 10px;color:#94a3b8;font:11.5px var(--sans)">Never read. Zoho would not describe this module, so its related lists were not fetched - pulling again will not change that by itself.</div></div>`;
  }
  if (!rls.length) {
    return `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Related lists \u00b7 0</div>`
      + `<div style="padding:9px 10px;color:#94a3b8;font:11.5px var(--sans)">Nothing recorded for this module. Related lists are fetched by <b>Pull Modules</b> - run it again, then reopen this diagram.</div></div>`;
  }
  const rows = rls.map((r) => `<tr>
    <td class="mono"><b>${esc(r.api_name)}</b></td>
    <td>${esc(r.label || '')}</td>
    <td class="mono">${esc(r.module || r.connected_module || '')}${r.linking_module ? ` <span style="color:#94a3b8">via ${esc(r.linking_module)}</span>` : ''}</td>
    <td>${esc(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td>
  </tr>`).join('');
  return `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Related lists \u00b7 ${rls.length} <span style="font-weight:400;color:#94a3b8">- the API name zoho.crm.getRelatedRecords() expects (not the module api_name)</span></div>`
    + `<div style="display:block;padding:0;max-height:260px;overflow:auto;background:#fff"><table class="ftbl"><thead><tr><th>Related list API</th><th>Label</th><th>Target module</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function fieldsTableHtml(n) {
  const tbl = `<div id="layzone">${layoutZoneHtml(n)}</div>` + relatedListsHtml(n);
  const tb = n.touched_by || [];
  const fns = tb.length
    ? `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Touched by ${tb.length} function(s) - string match in code</div><div style="padding:8px 10px;font:11.5px var(--mono);color:#33415a;line-height:1.7">${tb.map((t) => esc((t.ns ? t.ns + '.' : '') + t.api_name)).join('<br>')}</div></div>`
    : '<div class="none" style="margin-top:12px">No functions reference this module (by string match).</div>';
  return tbl + fns;
}
function select(id, nopush) {
  if (sel && !nopush) hist.push(sel);
  if (sel !== id) layFilter = null;   // layout filter is per-module
  sel = id; const n = N[id]; render(); updateProjectableTabs();
  const schema = DATA.kind === 'schema';
  const crumb = hist.length ? `<a id="back">\u25c2 back</a>  \u00b7  ${hist.slice(-4).map((h) => `<a data-id="${escA(h)}">${esc(label(N[h]))}</a>`).join(' \u2039 ')}` : '';
  let assoc = '';
  if (!schema && Array.isArray(n.associated_place) && n.associated_place.length) {
    assoc = '<div class="assoc">Bound to: ' + n.associated_place.map((a) => `<b>${esc(a._type || '')}</b> ${esc(a.name || '')} <span>(${esc(a.module || '')})</span>`).join(' \u00b7 ') + '</div>';
  }
  const sig = schema
    ? (n.unreadable
      ? `not described by Zoho \u00b7 ${esc(n.category || 'module')}`
      : `${(n.fields || []).length} fields \u00b7 ${(n.layouts || []).length} layouts \u00b7 ${(n.related_lists || []).length} related lists \u00b7 ${esc(n.category || 'module')}`)
    : `${n.return_type || 'void'} ${n.namespace}.${n.name}(` + (n.params || []).map((p) => `${p.type} ${p.name}`).join(', ') + ')';
  // A count of zero is a measurement. On a module Zoho refused to describe neither direction was
  // measured - its own fields were never read either - so both headings drop the number.
  const unread = schema && n.unreadable;
  const upHead = schema ? `Referenced by${unread ? '' : ` (${n.called_by.length})`} <span class="hint">- modules linking here</span>` : `Called by (${n.called_by.length}) <span class="hint">- breaks if you change it</span>`;
  const downHead = schema ? `Lookups${unread ? '' : ` (${n.calls.length})`} <span class="hint">- modules it references</span>` : `Calls (${n.calls.length}) <span class="hint">- its dependencies</span>`;
  const badges = schema
    ? `<span class="badge">${esc(n.namespace)}</span>${n.unreadable ? '<span class="badge">not described by Zoho</span>' : ''}${n.dead_suspect ? '<span class="badge">unreferenced</span>' : ''}`
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
  const nothingRead = 'never read - Zoho would not describe this module';
  n.called_by.length ? n.called_by.forEach((i) => up.appendChild(refRow(i))) : (up.innerHTML = `<div class="none">${unread ? nothingRead : `no ${schema ? 'incoming lookup' : 'internal caller'}`}</div>`);
  n.calls.length ? n.calls.forEach((i) => down.appendChild(refRow(i))) : (down.innerHTML = `<div class="none">${unread ? nothingRead : `no ${schema ? 'lookup fields' : 'internal calls'}`}</div>`);
  const back = $('back'); if (back) back.onclick = () => { const p = hist.pop(); if (p) select(p, true); };
  document.querySelectorAll('.crumbs a[data-id]').forEach((a) => (a.onclick = () => select(a.dataset.id)));
  if (schema) wireLayoutZone(n);
  $('main').scrollTop = 0;
  // Focus mode: the Explorer selection IS the context. Set it here so that switching to Visual or
  // the boxed diagram afterwards already shows this item. It was gated on `schema`, so on a call
  // graph selecting a function left the diagram centred on whatever it opened with - the same
  // "one of a set" miss as everywhere else: the rule is about the three projections agreeing, and
  // it has nothing to do with which kind of thing is being projected.
  if (id !== curFocus) setFocus(id);

}
$('q').addEventListener('input', () => { render(); updateQx(); });
function updateQx() { const x = $('qx'); if (x) x.classList.toggle('on', !!$('q').value); }
$('qx').onclick = () => { $('q').value = ''; render(); updateQx(); $('q').focus(); };
document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement.id !== 'q') { e.preventDefault(); $('q').focus(); } });

// ---------------- Relations (relation-first catalogue) ----------------
// The ER diagram puts modules first and relations second. This view inverts it: one row per
// relation, module names demoted to context. It exists because the thing you actually need
// when writing Deluge is the related-list API name, not the module map.
const SYS_REL = /^(Notes|Attachments|Emails|Tasks|Calls|Events|Tasks_History|Calls_History|Events_History|CheckLists|Activities.*|Zoho_Support|Social|Campaigns_Sent|Invited_Events|Cadences|Timeline|Approvals?)$/i;
let RELS = [], relFilter = 'user', relQ = '';
// One row per call, the way the schema's catalogue is one row per related list. Same reason for
// existing: the diagram puts the *things* first and this puts the *link* first, which is the shape
// the question has when you are about to change a function and want to know who feels it.
//
// The snippet is derived, not invented: graph-core's CALL_RE - the regex that finds calls in real
// Deluge sources - matches `namespace.name(`, so that is how a call is written. The parameter names
// come from the captured meta, so what is copied is the callee's actual signature.
function buildCallRels() {
  RELS = [];
  Object.values(N).forEach((n) => (n.calls || []).forEach((id) => {
    const c = N[id]; if (!c) return;
    RELS.push({
      call: true,
      from: n.id, fromLabel: label(n), fromNs: n.namespace || '',
      to: c.id, toLabel: label(c), toNs: c.namespace || '',
      kind: c.category || '', params: c.params || [],
      cross: (n.namespace || '') !== (c.namespace || ''),
    });
  }));
  RELS.sort((a, b) => (a.from.localeCompare(b.from) || a.to.localeCompare(b.to)));
}
function buildRels() {
  if (DATA.kind !== 'schema') return buildCallRels();
  RELS = [];
  Object.values(N).forEach((n) => (n.related_lists || []).forEach((r) => {
    const child = r.module || r.connected_module || null;
    // the lookup field on the child that materialises this relation (best effort)
    let via = r.linking_module ? `linking: ${r.linking_module}` : '';
    if (!via && child && N[child]) {
      const f = (N[child].fields || []).filter((x) => x.lookup === n.api_name).map((x) => x.api_name);
      if (f.length) via = f.join(' / ');
    }
    RELS.push({
      api: r.api_name, label: r.label || '', parent: n.api_name, parentLabel: n.display_name || n.api_name,
      child, via, type: r.type || '', visible: r.visible !== false,
      sys: SYS_REL.test(r.api_name) || !child,
    });
  }));
  RELS.sort((a, b) => (a.parent.localeCompare(b.parent) || a.api.localeCompare(b.api)));
}
const relSnippet = (r) => (r.call
  ? `${r.to}(${(r.params || []).map((p) => p.name).join(', ')});`
  : `zoho.crm.getRelatedRecords("${r.api}", "${r.parent}", recordId);`);
// The neighbourhood the whole window is looking at, or null when nothing is focused. Explorer sets
// it on every selection and the diagram follows it; Relations did not, so selecting an item and
// switching to Relations landed on the whole catalogue and the click looked like it had done
// nothing. Reported. It is one context with three projections, not two and a table.
const relScoped = () => (curFocus && egoSet && !scopeAll ? egoSet : null);
function relPass(r) {
  const ego = relScoped();
  if (ego) {
    const ends = r.call ? [r.from, r.to] : [r.parent, r.child];
    // A related list with no child module is still about its parent, so an absent end does not
    // exclude the row - only an end that exists and sits outside the neighbourhood does.
    if (!ends.every((x) => !x || ego.has(x))) return false;
  }
  if (r.call) {
    // The chips are window-wide, so a call whose either end is filtered out is not a row here either.
    // Reported as «why can I not exclude the connections» - they could be excluded, in three views
    // out of four, and this was the fourth.
    if (!N[r.from] || !N[r.to] || !passKind(N[r.from]) || !passKind(N[r.to])) return false;
    if (relFilter === 'cross' && !r.cross) return false;
    if (relFilter === 'same' && r.cross) return false;
    if (!relQ) return true;
    const q = relQ.toLowerCase();
    return [r.from, r.to, r.kind].some((x) => (x || '').toLowerCase().includes(q));
  }
  if (relFilter === 'user' && r.sys) return false;
  if (relFilter === 'sys' && !r.sys) return false;
  if (relFilter === 'm2m' && !/linking:/.test(r.via)) return false;
  if (!relQ) return true;
  const q = relQ.toLowerCase();
  return [r.api, r.label, r.parent, r.child, r.via].some((x) => (x || '').toLowerCase().includes(q));
}
function relRender() {
  if (!RELS.length) buildRels();
  const calls = DATA.kind !== 'schema';
  const rows = RELS.filter(relPass);
  // The scope is stated where it applies and carries its own way out - the same control the diagram
  // uses, not a second one, because a state with two switches is a state that can disagree with
  // itself. Without a focus there is nothing to say and the line stays a count.
  const ego = relScoped();
  const noun = calls ? 'calls' : 'relations';
  $('relcount').innerHTML = ego
    ? `${rows.length} of ${RELS.length} ${noun} · around <b>${esc(focusName(curFocus))}</b> · <a id="relall" role="button" tabindex="0" title="Show every row, and pause the focus in the diagram too">show all</a>`
    : `${rows.length} of ${RELS.length} ${noun}`;
  { const a = $('relall'); if (a) a.onclick = () => setScope(true); }
  if (!RELS.length) {
    $('relwrap').innerHTML = calls
      ? '<div class="empty">No calls between functions in this graph. A call is one Deluge function invoking another; a function that only talks to Zoho makes none.</div>'
      : '<div class="empty">No related lists in this graph. Run <b>Pull Modules</b> and reopen the diagram.</div>';
    return;
  }
  if (calls) {
    // A call is the link put first, the way a related list is above. The columns differ because the
    // facts differ - this is the product-specific half the shared engine deliberately does not own.
    $('relwrap').innerHTML = `<table class="rtbl"><thead><tr>
        <th>Function</th><th>Namespace</th><th>Calls</th><th>Namespace</th><th>Kind</th><th>Deluge</th>
      </tr></thead><tbody>${rows.map((r) => `<tr class="${r.cross ? '' : 'sys'}">
        <td><span class="mod" data-mod="${escA(r.from)}">${esc(r.fromLabel)}</span></td>
        <td class="rlab" style="font:11px var(--mono)">${esc(r.fromNs)}</td>
        <td><span class="mod" data-mod="${escA(r.to)}">${esc(r.toLabel)}</span></td>
        <td class="rlab" style="font:11px var(--mono)">${esc(r.toNs)}${r.cross ? '' : ' \u00b7 same'}</td>
        <td><span class="rtype">${esc(r.kind || 'standalone')}</span></td>
        <td><span class="snip" data-copy="${escA(relSnippet(r))}" title="Click to copy the call with its parameter names">${esc(r.toLabel)}(\u2026)</span></td>
      </tr>`).join('')}</tbody></table>`;
  } else {
  $('relwrap').innerHTML = `<table class="rtbl"><thead><tr>
      <th>Relation API name</th><th>Label</th><th>On module</th><th>Returns</th><th>Via</th><th>Type</th><th>Deluge</th>
    </tr></thead><tbody>${rows.map((r, i) => `<tr class="${r.sys ? 'sys' : ''}">
      <td><span class="rname" data-copy="${escA(r.api)}" title="Click to copy">${esc(r.api)}</span></td>
      <td class="rlab">${esc(r.label)}</td>
      <td><span class="mod" data-mod="${escA(r.parent)}">${esc(r.parent)}</span></td>
      <td>${r.child ? `<span class="mod" data-mod="${escA(r.child)}">${esc(r.child)}</span>` : '<span style="color:#cbd5e1">\u2014</span>'}</td>
      <td class="rlab" style="font:11px var(--mono)">${esc(r.via || '')}</td>
      <td><span class="rtype">${esc(r.type || 'default')}${r.visible ? '' : ' \u00b7 hidden'}</span></td>
      <td><span class="snip" data-copy="${escA(relSnippet(r))}" title="Click to copy">getRelatedRecords(\u2026)</span></td>
    </tr>`).join('')}</tbody></table>`;
  }
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
  const calls = DATA.kind !== 'schema';
  if (calls) {
    $('relq').placeholder = 'Search function, namespace, kind\u2026';
    $('relhint').textContent = 'Click a call to copy it with its parameter names \u00b7 click a function to open it in the Explorer'
      + ' \u00b7 a call to a name that resolves to nothing is not a row here: those are in the Health audit';
  }
  const facets = calls
    ? [['cross', 'crosses namespace'], ['same', 'same namespace'], ['all', 'all']]
    : [['user', 'module relations'], ['m2m', 'many-to-many'], ['sys', 'system'], ['all', 'all']];
  // The default facet belongs to the catalogue: `user` hides the system related lists, which is the
  // right first view of a schema and means nothing here - a call graph opens on everything.
  if (!facets.some(([k]) => k === relFilter)) relFilter = calls ? 'all' : 'user';
  facets.forEach(([k, l]) => {
    const c = document.createElement('span'); c.className = 'chip'; c.textContent = l;
    c.setAttribute('aria-pressed', k === relFilter);
    c.onclick = () => { relFilter = k; [...box.children].forEach((x) => x.setAttribute('aria-pressed', x === c)); relRender(); };
    box.appendChild(c);
  });
  $('relq').addEventListener('input', () => { relQ = $('relq').value.trim(); relRender(); });
}

// ---------------- Which of the two drawings is on screen ----------------
//
// The window is opened carrying a context - a module or a function - and until now changing your
// mind meant going back to the panel and opening it again. The switch asks the panel to build the
// other graph, because the panel is the only thing here that holds the folder: this window has no
// file access at all, by design, and inventing one for a convenience would be a permission nobody
// asked for.
//
// It reloads rather than swapping the data in place. Every global in this file - the layout, the
// ego set, the focus, the chips, the canvas - was computed from the graph that is being replaced,
// and re-deriving them one by one is exactly the kind of half-migrated state this project keeps
// getting bitten by. A reload costs one frame and cannot leave a stale half behind.
function wireSubject() {
  const box = document.getElementById('subj');
  if (!box) return;
  const here = DATA.kind === 'schema' ? 'schema' : 'calls';
  [...box.children].forEach((el) => el.setAttribute('aria-selected', el.dataset.k === here));
  box.onclick = async (e) => {
    const el = e.target.closest('span[data-k]');
    if (!el || el.dataset.k === here) return;
    const was = $('statline').innerHTML;
    $('statline').innerHTML = '<b>Building\u2026</b> asking the panel for the other graph';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'graphSwitch', kind: el.dataset.k });
      if (!r || !r.ok) throw new Error((r && r.error) || 'no answer');
      location.reload();
    } catch (err) {
      // Precise, because there is exactly one thing that makes this fail: the panel is the only
      // holder of the folder handle, and it has to be open and granted for the graph to be built.
      $('statline').innerHTML = was;
      alert('Could not switch: ' + (err.message || err)
        + '\n\nThe Zoost side panel builds the graph - it holds the working folder, this window does not.'
        + '\nOpen the panel in a Zoho CRM tab, make sure the folder is granted, then try again.');
    }
  };
}

// ---------------- The list, folded away ----------------
// A reference pane, an ER box or a source listing is easier to read across the whole window than
// across the window minus 340px, and the list is not needed while reading one. Per window and per
// session: nothing is stored, so nothing new has to be declared in the privacy policy for a
// preference that costs one click to set again.
//
// Explorer only, and by construction: the handle is markup inside #v-explorer, so it cannot appear
// in the three views that have no list. It got there the long way - shipped in all four views on the
// argument that a control which comes and goes is disorienting, which is the rule about a navigation
// *shape* and not about a control whose target is not on screen - then guarded in the view switch,
// and now simply placed where it belongs. A control with nothing to do is absent; a control that
// lives inside the thing it acts on cannot be anywhere else.
const MIN = 220;    // the list is never dragged narrower than this
const KEEP = 260;   // ...nor so wide that the detail beside it has less than this
const DRAG = 4;     // ...and under this many pixels of movement it was a click, not a drag

// The clamp, named and out of the drag so it can be tested without a DOM: never below MIN, and
// never so wide that the detail beside it has less than KEEP. A container reporting no width is not
// a reason to snap the column to its minimum - that is a measurement, not a constraint - so the
// upper bound is only applied when there is a width to apply it from.
function asideWidth(want, wrapW) {
  const w = Math.max(MIN, Math.round(want));
  const max = wrapW - KEEP;
  return max > MIN ? Math.min(max, w) : w;
}

function wireAsideFold() {
  const btn = document.getElementById('asidebtn');
  if (!btn) return;
  let down = null;

  function setFolded(off) {
    document.body.classList.toggle('no-aside', off);
    // The arrow points where the column will go. `aria-expanded` rather than `aria-pressed`: this
    // discloses a region, it does not toggle a mode.
    btn.textContent = off ? '\u25b8' : '\u25c2';
    btn.setAttribute('aria-expanded', String(!off));
    btn.setAttribute('aria-label', off ? 'Show the list' : 'Hide the list');
    btn.title = off ? 'Show the list' : 'Drag to resize the list, click to hide it';
    // The canvas is sized from its box, so it has to be told the box changed.
  }

  // The same edge resizes and folds, which is what a divider does everywhere else. They are told
  // apart by movement, not by a second control: under DRAG pixels it was a click. The ER boxes
  // already separate a click from a drag this way.
  btn.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('no-aside')) return;   // nothing to resize while folded
    const aside = document.querySelector('#v-explorer aside');
    down = { x: e.clientX, w: aside.getBoundingClientRect().width, moved: false };
    btn.setPointerCapture(e.pointerId);
    document.body.classList.add('aside-drag');
    e.preventDefault();
  });
  btn.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    if (!down.moved && Math.abs(dx) < DRAG) return;
    down.moved = true;
    document.documentElement.style.setProperty('--aside-w',
      asideWidth(down.w + dx, document.querySelector('.wrap').getBoundingClientRect().width) + 'px');
  });
  btn.addEventListener('pointerup', (e) => {
    const wasDrag = down && down.moved;
    down = null;
    document.body.classList.remove('aside-drag');
    try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!wasDrag) setFolded(!document.body.classList.contains('no-aside'));
  });
  // Keyboard only. `pointerup` already handles both directions - it fires whether or not
  // `pointerdown` armed a drag - and the first version had this reading `no-aside` as well, so a
  // plain click folded on pointerup and was immediately unfolded again by the click that followed
  // it. The two cancelled each other and the tab looked dead. A `click` from the keyboard carries
  // detail 0 and no pointer events at all, which is the only case left for it to do.
  btn.addEventListener('click', (e) => { if (e.detail === 0) setFolded(!document.body.classList.contains('no-aside')); });
}
wireAsideFold();

// Work that blocks the main thread, with something on screen while it does.
//
// The trap is that the message has to be *painted* first, and a repaint does not happen inside the
// task that schedules it. One requestAnimationFrame is not enough either: that callback runs before
// the frame it belongs to is painted, so blocking inside it blocks that very frame and nothing is
// ever shown. Two gets one full paint in between.
// Re-measured after settle() became Fruchterman-Reingold over typed arrays, which is about twenty
// times faster than the spring model it replaced: 4ms at 50 nodes, 27 at 150, 75 at 300, 294 at the
// 600 cap, against 53 / 359 / 1419 / 5854 before. A whole erShow at 352 nodes - layout, collision
// passes, boxes and fit - comes to 266ms on this machine.
//
// So 60 now means a spinner over about five milliseconds of work, which is the flicker the number
// exists to avoid. 200 keeps the same rule as before (show it when the work is around a third of a
// second) with a margin for a machine slower than the one it was measured on. It was 150 once,
// tuned on the force layout alone rather than on the whole path, and on an org of 87 modules it
// never appeared at all - reported as «the spinner is gone», which is why this is derived from a
// measurement of erShow and not of settle.
const SPIN_NODES = 200;
function runHeavy(host, label, work) {
  let ov = host.querySelector('.busy');
  if (!ov) { ov = document.createElement('div'); ov.className = 'busy'; host.appendChild(ov); }
  ov.innerHTML = '<i></i><span></span>';
  ov.querySelector('span').textContent = label;
  ov.setAttribute('role', 'status');
  ov.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { work(); } finally { ov.classList.remove('on'); }
  }));
}

// ---------------- View toggle ----------------
let curView = 'explorer';
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
  if (t.classList.contains('off')) return;
  showView(t.dataset.v);
});
function showView(v) {
  // Found in the collection rather than by a selector built from a string. The value is one of our
  // own four literals, but htmlcheck cannot know that and is right not to try: its criterion is a
  // property of the value, never a list of names we promise are safe.
  const t = [...document.querySelectorAll('.tab')].find((x) => x.dataset.v === v);
  if (!t) return;
  curView = v;
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', x === t));
  $('v-explorer').classList.toggle('on', curView === 'explorer');
  $('v-er').classList.toggle('on', curView === 'er');
  $('v-rel').classList.toggle('on', curView === 'rel');
 
  statRefresh();
  if (curView === 'rel') relRender();
  // The boxed layout is the one that leaves a blank pane: the concentric branch is cheap, but the
  // free one runs an O(n^2) force settle and then several collision passes on top.
  if (curView === 'er') erShowMaybeHeavy();
}
// Whether the work about to happen is worth saying something about. erShow's cost is in erLayout,
// and erLayout only runs when the layout is stale - so a second visit to the tab is instant and
// must not flash anything.
function erShowMaybeHeavy() {
  // Counted on what is about to be laid out. It used to ask how big the graph was, so filtering a
  // thousand nodes down to twenty still flashed a spinner over work that takes a few milliseconds.
  const n = erVisibleIds().length;
  if (!erLaidOut && n >= SPIN_NODES) {
    runHeavy($('v-er'), `Laying out ${n} ${NOUN().n}\u2026`, erShow);
  } else requestAnimationFrame(erShow);
}

// Explorer, Visual and ER are three projections of one context. A selection that cannot be projected
// must not leave the other two showing the previous one: reported, selecting a module Zoho would not
// describe left the ER diagram on the last valid item, so the list said one thing and the diagram
// another - the worst possible state, because both looked right on their own.
//
// Disabled, not hidden: this is the textbook temporarily-unavailable case - click another module and
// it is back - and a tab strip that changes length as you move down a list is disorienting in the
// way the conventions already describe. It is the same decision Analytics made for its detail tabs.
function updateProjectableTabs() {
  const n = sel && N[sel];
  const off = !!(n && n.unreadable);
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.v === 'explorer') return;
    t.classList.toggle('off', off);
    t.title = off ? `Zoho would not describe ${label(n)}, so there is nothing to draw for it` : '';
  });
  if (off && curView !== 'explorer') showView('explorer');
}

// ---------------- Layout state, shared by the boxed diagram ----------------
// laidOutKey is the *set* the force positions were computed for, not a boolean. It was a boolean,
// and that is the bug this replaces: switching a chip off removed the boxes and left every survivor
// exactly where it was, so a graph that had just lost half its nodes kept the extent of the whole
// one and gained nothing but holes. Reported. A filter is not a visibility toggle, it says which
// graph we are looking at - so it changes the geometry, and keying on the set means it re-runs when
// the set changes and never when it has not.
let nodesA = [], edgesA = [], posX = {}, posY = {}, vx = {}, vy = {}, laidOutKey = '';
let egoDepth = 2, egoSet = null, egoLevel = {}, curFocus = null, maxEgoDepth = 6;
let scopeAll = false;   // true = ignore the focus and draw the whole org (wall-poster mode)

// Deterministic robustness guard. The force layout (settle) is O(n²) per iteration and runs on the
// main thread, so above this many nodes we do NOT attempt it - the boxes keep their ring positions
// and the diagram still draws instead of freezing.
//
// 600 was a guess made when settle cost 5.9 seconds there. It has now been profiled end to end -
// the force layout, the collision passes and building the DOM - on a synthetic 2055-node graph:
//
//     nodes    settle   collision+rest   DOM     total
//       600     313ms         204ms      28ms    ~0.5s
//      1200    1166ms         885ms      43ms    ~2.1s
//      2055    3364ms        3715ms      83ms    ~7.1s
//
// The layout does not get worse with size - the structure ratio is 0.13 at 600 and 0.116 at 1200 -
// so the only question is how long a deliberate «draw the whole org» may take behind a spinner.
// Two seconds is a wait; seven is a hang. Hence 1200.
//
// Two things this cap does **not** cover, and neither is an oversight. The DOM is not the cost at
// any size - 83ms for two thousand boxes. And the **collision passes are the other O(n²)** and run
// whether or not the force layout does, so an org past this cap still pays them: at 2055 that is
// 3.7 seconds to draw a ring, with a spinner over it. If a real org ever lands there, that pass -
// not this number - is what to attack.
const FORCE_MAX_NODES = 1200;
// The count that matters is what is about to be laid out, never how big the org is: switching a
// category off can bring a graph that was refused under the budget, and refusing it anyway would
// mean the filters cannot buy what they exist to buy.
function forceFeasible(n) { return (n == null ? nodesA.length : n) <= FORCE_MAX_NODES; }
// What "everything" would cost with the chips as they stand - used before scopeAll is applied, so
// it cannot ask erVisibleIds().
function visibleKindCount() { return nodesA.filter((id) => N[id] && passKind(N[id])).length; }
const edgesAmong = (list) => { const s = new Set(list); return edgesA.filter(([a, b]) => s.has(a) && s.has(b)); };

// The chips are the colour key now: each carries its hue and its word, they sit in the header, and
// they are on screen in every view - which the legend never was, since it lived inside the canvas.
// Two keys for one dimension is how they end up disagreeing, and this window has done that before.
// The node and edge arrays, and a ring of starting positions for the force layout. This was
// initCanvas and it set up a canvas as well - the Visual view is gone, and what the boxed diagram
// actually needed from it was only ever this.
function initPositions() {
  nodesA = Object.keys(N);
  const es = new Set();
  Object.values(N).forEach((n) => n.calls.forEach((c) => es.add(n.id + '\u0000' + c)));
  edgesA = [...es].map((e) => { const [a, b] = e.split('\u0000'); return [a, b]; });
  seedRing(nodesA);
}

// The starting ring, sized for the list it is given rather than for the whole graph - which is what
// makes a filtered layout compact instead of a sparse copy of the unfiltered one.
//
// The scatter is a hash of the id, not Math.random(): the same set has to come out the same way
// every time, or switching a chip off and back on would rearrange a diagram the reader had already
// learnt to read. It also makes the PDF reproducible, which is worth having on its own.
function seedRing(list) {
  const R = Math.min(400, 60 + list.length * 2);
  list.forEach((id, i) => {
    const a = (i / list.length) * Math.PI * 2;
    posX[id] = Math.cos(a) * R + jitter(id, 'x');
    posY[id] = Math.sin(a) * R + jitter(id, 'y');
    vx[id] = 0; vy[id] = 0;
  });
}
function jitter(id, salt) {
  let h = 2166136261; const s = id + salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967295 - 0.5) * 40;
}

function settle(list, edges) {
  // Fruchterman-Reingold. The ideal edge length is derived from the area the drawing has to fill, so
  // the same code behaves at twenty nodes and at five hundred.
  //
  // What was here before was a hand-tuned spring model with three constants - a repulsion of 5200,
  // a rest length of 90, and a radius clamp of 120 + 3n. It looked right at about fifty nodes, which
  // is where it was tuned, and above that repulsion overwhelmed attraction and the clamp caught
  // every node on the way out: measured on a 700-node graph, **100% of the boxes ended up on the
  // clamp radius**, which is to say the diagram was a circle of boxes - and the mean edge came out
  // as long as the distance between two nodes picked at random, which is a drawing that carries no
  // information at all. That is why filtering it did not make it more readable: there was no
  // structure in it to reveal.
  //
  // Nothing here is tuned by eye. The two forces are the published ones and the only free parameter
  // is the area, which cancels out downstream - erLayout normalises the extent before drawing.
  const n = list.length;
  if (n < 2) return;
  // Typed arrays, not the posX/posY objects. This is the one O(n^2) loop in the window and it runs
  // on the main thread behind a spinner, so the cost of a string key lookup is paid n^2 * iterations
  // times: measured, moving the inner loop off the objects took a 352-node layout from 2.2s to a
  // fraction of it. The positions are read in and written back once.
  const X = new Float64Array(n), Y = new Float64Array(n), DX = new Float64Array(n), DY = new Float64Array(n);
  const idx = new Map();
  for (let i = 0; i < n; i++) { idx.set(list[i], i); X[i] = posX[list[i]] || 0; Y[i] = posY[list[i]] || 0; }
  const E = [];
  for (const [a, b] of edges) {
    const i = idx.get(a), j = idx.get(b);
    if (i !== undefined && j !== undefined && i !== j) E.push(i, j);
  }
  const area = 1000 * 1000;
  const L = Math.sqrt(area / n);          // ideal distance between two nodes
  const iter = 300;
  let t = Math.sqrt(area) / 8;            // maximum displacement, cooled linearly to zero
  const cool = t / (iter + 1);
  for (let it = 0; it < iter; it++) {
    DX.fill(0); DY.fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i], yi = Y[i];
      let ax = 0, ay = 0;
      for (let j = i + 1; j < n; j++) {
        let ex = xi - X[j], ey = yi - Y[j];
        let d2 = ex * ex + ey * ey;
        // Two nodes on the same point have no direction to push apart in, so give them one that
        // depends on which they are - a random nudge would make the layout different every time.
        if (d2 < 1e-4) { ex = jitter(list[i] + list[j], 'r'); ey = jitter(list[j] + list[i], 'r'); d2 = ex * ex + ey * ey || 1; }
        const f = (L * L) / d2;
        ax += ex * f; ay += ey * f; DX[j] -= ex * f; DY[j] -= ey * f;
      }
      DX[i] += ax; DY[i] += ay;
    }
    for (let e = 0; e < E.length; e += 2) {
      const i = E[e], j = E[e + 1];
      const ex = X[i] - X[j], ey = Y[i] - Y[j];
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
      const f = d / L;
      DX[i] -= ex * f; DY[i] -= ey * f; DX[j] += ex * f; DY[j] += ey * f;
    }
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(DX[i] * DX[i] + DY[i] * DY[i]);
      if (!d) continue;
      const s = (d < t ? d : t) / d;
      X[i] += DX[i] * s; Y[i] += DY[i] * s;
    }
    t -= cool;
  }
  for (let i = 0; i < n; i++) { posX[list[i]] = X[i]; posY[list[i]] = Y[i]; vx[list[i]] = 0; vy[list[i]] = 0; }
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
  const lbl = scopeAll ? `Scope: ${NOUN().all.toLowerCase()}` : `Scope: ${focusName(curFocus) || 'focus'}`;
  const ttl = scopeAll
    ? 'Showing every module. Click to go back to the focused neighbourhood.'
    : 'Showing the focus neighbourhood. Click to show every module (full diagram for A0 printing).';
  {
    const b = $('erScope'); if (!b) return;
    b.style.display = curFocus ? '' : 'none';
    b.textContent = lbl; b.title = ttl; b.classList.toggle('on', scopeAll);
  }
  // The reset appears only when a focus is active (whole-graph view already IS the reset target).
  { const b = $('erReset'); if (b) b.style.display = curFocus ? '' : 'none'; }
}
// One sentence, one function, two callers - the setter that refuses, and the diagram that puts
// itself back when a scope widened elsewhere turns out to be more than it can draw.
function tooWideToDraw(wide) {
  const filtered = wide < nodesA.length;
  $('statline').innerHTML = `<b>${wide} ${NOUN().n}</b>${filtered ? ` of ${nodesA.length}` : ''} - too many to lay out all at once. Staying focused on <b style="color:#d98e00">${esc(focusName(curFocus))}</b>; switch a category off above, or widen with depth instead.`;
}
function setScope(all) {
  if (!curFocus) return;
  // "All modules" triggers the whole-org free layout. Above the budget we don't attempt it - we
  // stay focused and say why, rather than freezing on the way to a poster nobody can wait for.
  // The budget is asked about what the chips leave standing, not about the org: switching a
  // category off is now a way to bring the whole graph within reach, and it says so.
  //
  // And it is the *diagram's* budget, not the window's. Relations is a table: widening it costs
  // nothing to lay out, so refusing there would be borrowing one view's limit to block another -
  // which is what made «show all» beside the row count do nothing at all. The diagram re-asserts
  // the limit for itself when it is the view being drawn.
  const wide = visibleKindCount();
  if (all && curView === 'er' && !forceFeasible(wide)) { tooWideToDraw(wide); return; }
  scopeAll = !!all;
  // Widening to everything lays the whole org out again, which is the most expensive thing this
  // window does - and it did it in the click handler, so the interface sat there looking hung and
  // then jumped to the result. Reported. The work is deferred behind a painted frame like every
  // other layout, and the old drawing is cleared first: leaving it up while a different graph is
  // being computed is the stale-projection problem in miniature.
  const work = () => {
    bfsEgo(); updateDepthUI(); updateScopeUI(); egoStat(); erLaidOut = false;
    if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
    };
  const heavy = wide >= SPIN_NODES && curView === 'er';
  if (!heavy) return work();
  $('erboxes').innerHTML = '';
  runHeavy($('v-er'),
    all ? `Laying out ${NOUN().all.toLowerCase()}\u2026` : `Laying out around ${focusName(curFocus)}\u2026`, work);
}
const focusName = (id) => (id && N[id] ? label(N[id]) : (id || ''));
// The counts are of what the chips leave standing, with the full figure beside them when they
// differ. A status line reading 900 nodes over a diagram drawing 200 is the same defect as a
// diagram that does not shrink when you filter it: a number that is not about what is on screen.
// Counted from the graph, never from nodesA/edgesA - those are layout state, and this line is
// written once before initPositions() has filled them. It reported «0 of 90 modules» on the schema
// side and nowhere else, because the call-graph branch happens to count from N already.
function statCounts(set) {
  const inSet = (id) => !set || set.has(id);
  const nodes = Object.keys(N).filter((id) => inSet(id) && passKind(N[id]));
  const keep = new Set(nodes);
  let e = 0;
  Object.values(N).forEach((n) => { if (!keep.has(n.id)) return; n.calls.forEach((c) => { if (keep.has(c)) e++; }); });
  return { n: nodes.length, e };
}
function statOf(set, allN, allE) {
  const c = statCounts(set);
  const nf = c.n !== allN ? ` <span style="color:#94a3b8">of ${allN}</span>` : '';
  const ef = c.e !== allE ? ` <span style="color:#94a3b8">of ${allE}</span>` : '';
  return `<b>${c.n}</b>${nf} ${NOUN().n} \u00b7 <b>${c.e}</b>${ef} ${NOUN().e}`;
}
// The whole-graph line, with no focus on it. Lifted out of the init block so the chips can put it
// back: it was written once at startup and then never again, so filtering changed the drawing
// underneath a summary of the unfiltered graph.
function graphStat() {
  $('statline').innerHTML = DATA.kind === 'schema'
    ? `${DATA.focus ? `<b style="color:#d98e00">Focus: ${esc(focusName(DATA.focus))}</b> · depth ${DATA.depth} · ` : ''}${statOf(null, DATA.counts.nodes, DATA.counts.edges)} · <b>${DATA.counts.dead_suspects}</b> ${NOUN().dead}${orphanNote()}`
    : `${entityBreakdown()} · <b>${DATA.counts.edges}</b> links · <b>${DATA.counts.dead_suspects}</b> nothing calls them · <b>${DATA.counts.unresolved}</b> unresolved${orphanNote()}`;
}
// Whichever of the two is the right one for the state we are in.
function statRefresh() { if (curFocus) egoStat(); else graphStat(); }
// Said in the diagram, where it is the difference between what the Explorer lists and what is
// drawn. It is not only about the filter: a node with no link of its own is not drawn either, and
// the first wording («with nothing left to link them») blamed the chips for both. The number is
// what the reader needs; why is one click away in the list beside it.
// The Explorer beside it still lists those items, so the two panes are not disagreeing; they answer
// different questions, and without this the reader is left counting boxes to find out which.
function orphanNote() {
  if (curView !== 'er') return '';
  const k = orphanedByFilter();
  return k ? ` \u00b7 <span style="color:#94a3b8">${k} not drawn - nothing links them</span>` : '';
}
function egoStat() {
  if (!curFocus) return;
  if (scopeAll) {
    $('statline').innerHTML = `<b>${NOUN().all}</b> \u00b7 ${statOf(null, DATA.counts.nodes, DATA.counts.edges)} \u00b7 <span style=\"color:#94a3b8\">focus \u00ab${esc(focusName(curFocus))}\u00bb paused - Save PDF prints the whole diagram on one page</span>`;
    return;
  }
  const allN = egoSet ? egoSet.size : DATA.counts.nodes;
  const allE = egoSet ? edgesA.filter(([a, b]) => egoSet.has(a) && egoSet.has(b)).length : DATA.counts.edges;
  $('statline').innerHTML = `<b style=\"color:#d98e00\">Focus: ${esc(focusName(curFocus))}</b> \u00b7 depth ${egoDepth}/${maxEgoDepth} \u00b7 ${statOf(egoSet, allN, allE)} \u00b7 <span style=\"color:#94a3b8\">click a box to re-center</span>${orphanNote()}`;
}
function setDepth(d) {
  egoDepth = Math.max(1, Math.min(maxEgoDepth, d));
  updateDepthUI(); bfsEgo(); egoStat(); erLaidOut = false;
  if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
}
function setFocus(id) {
  // Re-centre the shared focus WITHOUT changing view. Explorer / Visual / ER are three
  // projections of the same context, so whoever changes the focus updates all of them.
  if (!id || !N[id] || id === curFocus) return;
  // Except a module Zoho refused to describe. It has no fields and no lookups *that anyone read*, so
  // all three projections would come out empty - and an empty diagram reads as "this relates to
  // nothing", which is the opposite of what is true. Reported: the panel offered the ER button on
  // such a module and it opened a window with nothing in it.
  if (N[id].unreadable) {
    $('statline').innerHTML = `<b style="color:#94a3b8">${esc(label(N[id]))}</b> \u00b7 Zoho would not describe this module, so its fields and relations were never read - there is nothing to draw for it.`;
    return;
  }
  const wasUnfocused = !curFocus;
  curFocus = id; computeMaxDepth(); egoDepth = Math.max(1, Math.min(maxEgoDepth, egoDepth || 2));
  if (wasUnfocused) $('erdepth').style.display = 'inline-flex';   // first focus (e.g. from the whole-graph view): reveal the depth control
  updateDepthUI(); updateScopeUI();
  if (scopeAll) {
    // remember the new focus for when the scope goes back, but do not re-lay-out the org
    egoStat();
    if (curView === 'er') erRender();
    return;
  }
  bfsEgo(); egoStat(); erLaidOut = false;
  if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
}
function clearFocus() {
  // Back to the pristine whole-graph view - the state you get opening via "Schema".
  curFocus = null; scopeAll = false; egoSet = null; egoLevel = {};
  $('erdepth').style.display = 'none';
  updateScopeUI(); erLaidOut = false;
  $('statline').innerHTML = `<b>${DATA.counts.nodes}</b> ${NOUN().n} · <b>${DATA.counts.edges}</b> ${NOUN().e} · <b>${DATA.counts.dead_suspects}</b> ${NOUN().dead}`;
  if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
}

// `nameMode` decides what a node is called - the display label or the internal api_name - and it
// feeds label(), which the list and the boxes both use. Its button lived in the Visual toolbar and
// came out with it; it belongs with the other diagram controls, since that is what it changes.
$('nameToggle').onclick = () => {
  nameMode = nameMode === 'display' ? 'internal' : 'display';
  $('nameToggle').textContent = 'Name: ' + nameMode;
  $('nameToggle').classList.toggle('on', nameMode === 'internal');
  render(); if (sel) select(sel, true); erLaidOut = false; if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
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
  // `spread` drives the free branch and `ring` the concentric one, so only one of the two is ever
  // in use - and this preset's spread had never been exercised, because «edges» used to be reached
  // only with a focus. 72 put 19 boxes on a 3000px canvas: measured 0.25 zoom against 0.39 for the
  // same graph in boxes mode, which is a diagram laid out correctly and drawn too small to read.
  relations: { margin: 120, spread: 38, ring: 640, gap: 10, fs: 13, sub: true },
  // A call box carries a handful of rows where a module box carries dozens, so the same spacing
  // leaves the diagram mostly empty. Tighter rings, less spread, and the boxes come out closer.
  calls:     { margin: 28,  spread: 34, ring: 320, gap: 8,  fs: 10, sub: true },
};
// The boxed mode's preset depends on what is being drawn; `relations` is the same idea either way.
const erBoxPreset = () => (DATA && DATA.kind === 'schema' ? 'modules' : 'calls');
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
  const flds = (N[a].fields || []).filter((f) => f.lookup === b).map((f) => f.api_name);
  const rl = ((N[b].related_lists) || []).filter((r) => r.module === a);
  const head = rl.length ? rl[0].api_name : '(no related list recorded)';
  const snip = rl.length ? `zoho.crm.getRelatedRecords("${rl[0].api_name}", "${b}", recordId);` : '';
  $('erpickbody').innerHTML =
    `<div class="pk1">${esc(head)}</div>`
    + `<div class="pk2">on <b>${esc(b)}</b> \u2192 returns <b>${esc(a)}</b>${flds.length ? ` \u00b7 via lookup <b>${esc(flds.join(' / '))}</b>` : ''}</div>`
    + (snip ? `<div class="pksnip" id="erpicksnip" title="Click to copy">${esc(snip)}</div>` : '')
    + (rl.length > 1 ? `<div class="pkalt">also: ${rl.slice(1).map((r) => esc(r.api_name)).join(' \u00b7 ')}</div>` : '');
  card.classList.add('on');
  const sn = $('erpicksnip');
  if (sn) sn.onclick = () => navigator.clipboard.writeText(snip).then(() => {
    const t = sn.textContent; sn.textContent = 'copied \u2713'; setTimeout(() => { sn.textContent = t; }, 900);
  }).catch(() => {});
}
// A function's box lists what it calls, the way a module's box lists its fields. The engine draws
// rows of {api_name, data_type, lookup}, so the calls are expressed in that shape rather than the
// renderer learning a second one - the same move the Analytics side makes to reuse this window.
function erCallRows(n) {
  // A callee the chips have filtered out is not listed either: it would name in a row the very node
  // the reader has just chosen not to see, and the arrow to it is gone anyway.
  return (n.calls || []).filter((id) => N[id] && passKind(N[id])).map((id) => {
    const c = N[id];
    return { api_name: c ? label(c) : id, data_type: c ? (c.namespace || '') : '', lookup: null, mandatory: false, _to: id };
  }).sort((x, y) => x.api_name.localeCompare(y.api_name));
}
function erFieldsFor(n) {
  if (erEmph === 'relations') return [];   // the box is only a label; the edges carry the information
  if (DATA.kind !== 'schema') return erCallRows(n);
  const all = n.fields || [];
  const base = erAll ? all.slice() : all.filter((f) => f.lookup || f.mandatory || /^(Name|Owner|id)$/i.test(f.api_name));
  const rank = (f) => (f.lookup ? 0 : (f.mandatory ? 1 : 2));
  return base.sort((a, b) => rank(a) - rank(b));
}
// Which nodes still have a link to another node the chips have left standing.
//
// It used to be computed from the whole edge list, so switching a category off left behind every
// node whose only links went into it: boxes with no arrow at all, sitting in a diagram whose whole
// subject is what connects to what. Reported - «rimangono gli elementi che sarebbero collegati a
// quelle automation, rendendo monco il grafico».
//
// One pass is the whole cascade, not an approximation of it: dropping nodes that have no surviving
// edge cannot remove an edge between two nodes that do, so the second pass would find nothing. If
// A links to B and both pass the chips, both are linked - including when one of them links to
// nothing else.
function linkedUnderFilter() {
  const ok = (id) => N[id] && passKind(N[id]);
  const linked = new Set();
  edgesA.forEach(([a, b]) => { if (ok(a) && ok(b)) { linked.add(a); linked.add(b); } });
  return linked;
}
function erVisibleIds() {
  const ok = (id) => N[id] && passKind(N[id]);
  // On a schema a module with no field to show has nothing to draw and stays out - the behaviour
  // that was already here, and a different question from having no link left.
  if (DATA.kind === 'schema' && erEmph !== 'relations') {
    return nodesA.filter((id) => ok(id) && erFieldsFor(N[id]).length > 0 && (!egoSet || egoSet.has(id)));
  }
  const linked = linkedUnderFilter();
  return nodesA.filter((id) => ok(id) && (linked.has(id) || id === curFocus) && (!egoSet || egoSet.has(id)));
}
// What the chips leave standing but the diagram will not draw, because nothing links it any more.
// A number the reader has to be given: the Explorer beside it lists those items, and two panes
// disagreeing about how many there are with no explanation is the state this window keeps ending in.
function orphanedByFilter() {
  if (DATA.kind === 'schema' && erEmph !== 'relations') return 0;
  const linked = linkedUnderFilter();
  return nodesA.filter((id) => N[id] && passKind(N[id]) && !linked.has(id) && id !== curFocus
    && (!egoSet || egoSet.has(id))).length;
}
// Text measured, not guessed. The box was a fixed 250px and a long name simply ran past its own
// edge - reported. There is no canvas in this window any more, so one is made here for its 2D
// context, which is the only text-measuring API that does not require laying anything out.
let _tm = null;
function textWidth(text, font) {
  if (!_tm) _tm = document.createElement('canvas').getContext('2d');
  _tm.font = font;
  return _tm.measureText(String(text || '')).width;
}
const BOX_MIN = 190, BOX_MAX = 460;
function erBoxSize(n) {
  const rows = erFieldsFor(n); const headerH = 28, rowH = 18, cap = 40;
  // The header is name + a smaller sub-label, with padding and the gap between them. The rows are
  // measured too: a callee with a long namespace overflows just as readily as a title does.
  const sans = 'var(--sans)';
  const head = textWidth(label(n), `700 12px ${sans}`)
    + textWidth(DATA.kind === 'schema' ? (n.api_name || '') : [KINDOF(n), n.namespace].filter(Boolean).join(' \u00b7 '), `500 10px ${sans}`)
    + 18 + 8;
  const shown = Math.min(rows.length, cap);
  const widest = rows.slice(0, shown).reduce((m, f) => Math.max(m,
    textWidth(f.api_name, '11px ui-monospace, monospace')
    + textWidth(f.lookup ? '\u2192 ' + f.lookup : (f.data_type || ''), '11px ui-monospace, monospace') + 26), 0);
  const w = Math.round(Math.max(BOX_MIN, Math.min(BOX_MAX, erEmph === 'relations' ? head : Math.max(head, widest))));
  const more = rows.length > cap ? 16 : 0;
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
    // so settle() is skipped there - that is the common case and it stays cheap at any org size.
    // Here we only run the O(n²) settle if we can afford it; otherwise nodes keep their ring
    // positions and the diagram still renders instead of freezing.
    //
    // Both are computed for erIds - the set on screen - and re-computed whenever that set changes.
    // Laying out the whole graph and then drawing part of it is what made the filters feel inert:
    // the boxes went away and the diagram stayed exactly as large, which is the opposite of what
    // switching a category off is for.
    const key = erIds.join('\n');
    if (laidOutKey !== key) {
      seedRing(erIds);
      if (forceFeasible(erIds.length)) settle(erIds, edgesAmong(erIds));
      laidOutKey = key;
    }
    // settle() produces positions whose extent depends on how many nodes it was given, so a constant
    // multiplier means something different at 20 nodes and at 300. That is why «Scope: everything»
    // with «Emphasis: edges» came out at 19% zoom - a diagram laid out correctly and drawn too small
    // to read, which is indistinguishable from nothing. So the positions are normalised first: the
    // canvas is sized from the boxes that have to fit on it, and `spread` then means the same thing
    // whatever the node count.
    const sizes = {};
    let area = 0;
    erIds.forEach((id) => { const b = erBoxSize(N[id]); sizes[id] = b; area += b.w * b.h; });
    const ext = (k) => { const v = erIds.map((id) => (k === 'x' ? posX[id] : posY[id]) || 0); return Math.max(...v) - Math.min(...v); };
    const cur = Math.max(1, Math.max(ext('x'), ext('y')));
    const target = Math.sqrt(Math.max(1, area)) * (erP.spread / 10);
    const spread = target / cur;
    erIds.forEach((id) => { const s = sizes[id]; erPos[id] = { x: (posX[id] || 0) * spread, y: (posY[id] || 0) * spread, w: s.w, h: s.h }; });
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
    const hue = DATA.kind === 'schema' ? '' : NSCOL(KINDOF(n));
    div.className = 'erbox ' + (DATA.kind === 'schema' ? (n.namespace === 'custom' ? 'custom' : 'standard') : 'hued') + (erEmph === 'relations' ? ' dim' : '')
      + (inPick === false ? ' faded' : '') + (inPick === true ? ' epick' : '')
      + (id === sel ? ' sel' : '') + (id === curFocus ? ' focus' : '');
    div.style.cssText = `left:${p.x}px;top:${p.y}px;width:${p.w}px${hue ? `;--kind:${hue}` : ''}`;
    const rows = s.rows.slice(0, s.shown).map((fld) => {
      const lk = fld.lookup ? ' lk' : ''; const req = fld.mandatory ? '<span class="pk">*</span>' : '';
      const t = fld.lookup ? ('\u2192 ' + esc(fld.lookup)) : esc(fld.data_type || '');
      return `<div class="errow${lk}"><span class="fn">${esc(fld.api_name)}${req}</span><span class="ft">${t}</span></div>`;
    }).join('');
    const more = s.more ? `<div class="ermore">+${s.rows.length - s.shown} more\u2026</div>` : '';
    // The small right-hand label is the second identity of the thing. A module has an api_name that
    // differs from its label; a function's does not, and printing the same word twice says nothing -
    // its namespace is the fact worth having there.
    // The colour says which kind it is and the word says it again, because a hue alone asks the
    // reader to hold a key in their head - reported as «i colori sono utili ma non sufficienti».
    // Category first: it is the dimension everything else in this window is coloured and filtered by.
    const sub = DATA.kind === 'schema' ? (n.api_name || '')
      : [KINDOF(n), n.namespace].filter(Boolean).join(' \u00b7 ');
    div.innerHTML = `<div class="erhdr"><span>${esc(label(n))}</span><small>${esc(sub)}</small></div>${rows}${more}`;
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
    ht.textContent = `${b} \u2192 ${a}`; hit.appendChild(ht);
    svg.appendChild(hit);

    const fld = (N[a].fields || []).find((f) => f.lookup === b);
    // Reverse direction: on B the relation is reachable as a related list, whose API name is
    // NOT B's (or A's) api_name. That is the string getRelatedRecords() wants.
    const rl = ((N[b].related_lists) || []).filter((r) => r.module === a);
    const full = rl.map((r) => r.api_name).join(' / ');
    const cy = (y1 + y2) / 2;
    if (!rl.length && !fld) return;

    if (REL) {
      // one label per edge: relation name headline, lookup field as a footnote inside the pill
      const head = rl.length ? (rl.length > 1 ? `${rl[0].api_name}  +${rl.length - 1}` : rl[0].api_name) : (fld ? fld.api_name : '');
      const sub = (erP.sub && fld) ? fld.api_name : '';
      const fs = erP.fs, cw = fs * 0.615;
      const w = Math.max(head.length * cw, sub.length * (fs * 0.47)) + 20;
      const h = sub ? fs + 21 : fs + 10;
      labels.push({ cx: mx, cy, w, h, ax: mx, ay: cy, head, sub, hot, fs, a, b, key, title: full || head, rel: !!rl.length });
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
      ttl.textContent = L.title + (L.sub ? ' - via ' + L.sub : '');
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
function erShow() {
  // A scope widened from Relations, where it is free, may be more than the diagram can lay out.
  // Say so and go back to the focus rather than drawing a ring of boxes nobody can read - the
  // fallback is stated, never silent.
  if (scopeAll && curFocus && !forceFeasible(visibleKindCount())) {
    scopeAll = false; bfsEgo(); updateScopeUI(); erLaidOut = false;
    tooWideToDraw(visibleKindCount());
  }
  if (!erLaidOut) { erLayout(); erLaidOut = true; }
  erRender(); erFit(); erUpdateControlVis();
  const h = document.querySelector('#v-er .hint2');
  if (h) h.textContent = `scroll to zoom \u00b7 drag to pan \u00b7 click a ${NOUN().box} to inspect`;
}
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
$('erReset').onclick = clearFocus;
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
  const rel = erEmph === 'relations', conc = erConcentric(), _schema = DATA.kind === 'schema';
  const set = (id, on) => { const e = $(id); if (e) e.classList.toggle('off', !on); };
  // "Fields: key / all" chooses which of a module's fields are worth a row. A call box has no such
  // choice - every call it makes is one - so the control has nothing to do and is absent.
  const fa = $('erAll'); if (fa) fa.style.display = _schema ? '' : 'none';
  const em = $('erEmph'); if (em) em.textContent = 'Emphasis: ' + erEmphLabel();
  set('rowMargin', true);
  set('rowSpread', !conc);
  set('rowRing', conc);
  set('rowGap', rel);
  set('rowFs', rel);
  set('rowSub', rel);
  const h = $('erlayHead');
  const all = NOUN().all.toLowerCase();
  if (h) h.textContent = (conc ? 'Concentric layout (focus + depth)' : `Free layout (${all})`)
    + ' \u00b7 ' + (rel ? (_schema ? 'relation labels' : 'call labels') : (_schema ? 'module boxes' : 'function boxes'));
}
function erParamsToUI() {
  ER_CTL.forEach(([sl, lb, k]) => { const e = $(sl); if (e) { e.value = erP[k]; $(lb).textContent = k === 'spread' ? (erP[k] / 10).toFixed(1) : erP[k]; } });
  const cb = $('pSub'); if (cb) cb.checked = !!erP.sub;
}
function erApplyParams(relayout) {
  if (_erT) clearTimeout(_erT);
  _erT = setTimeout(() => {
    if (relayout) { erLaidOut = false; erShowMaybeHeavy(); } else { erRender(); }
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
    erP = Object.assign({}, ER_PRESET[erEmph === 'relations' ? 'relations' : erBoxPreset()]);
    erParamsToUI(); erSaveParams(); erApplyParams(true);
  };
  $('erLayBtn').onclick = () => {
    const on = $('erlay').classList.toggle('on');
    $('erLayBtn').classList.toggle('on', on);
    if (on) erUpdateControlVis();
  };
  erParamsToUI(); erUpdateControlVis();
}
// Keyed by kind: a spread tuned on an ER diagram of 87 modules is the wrong starting point for a
// call graph, and restoring it there was how the boxes came out a screen apart.
function erSaveParams() { try { chrome.storage.local.set({ erParams: { current: erP, mode: erEmph, kind: DATA.kind } }); } catch (_) {} }
// «Emphasis» switches between boxes-with-contents and labels-with-arcs. The internal values stay
// `modules` / `relations` because the presets and the layout branch are keyed on them; only the word
// on the button follows what is being drawn.
const erEmphLabel = () => (erEmph === 'relations' ? (DATA.kind === 'schema' ? 'relations' : 'edges')
                                                 : (DATA.kind === 'schema' ? 'modules' : 'calls'));
$('erEmph').onclick = () => {
  erEmph = erEmph === 'relations' ? 'modules' : 'relations';
  $('erEmph').textContent = 'Emphasis: ' + erEmphLabel();
  $('erEmph').classList.toggle('on', erEmph === 'relations');
  $('erAll').disabled = erEmph === 'relations';
  erP = Object.assign({}, ER_PRESET[erEmph === 'relations' ? 'relations' : erBoxPreset()]);   // each mode has its own sensible starting point
  erParamsToUI(); erUpdateControlVis(); erSaveParams();
  erLaidOut = false; erShowMaybeHeavy();
};
$('erpickx').onclick = () => erClearPick();
$('v-er').addEventListener('click', (e) => {
  if (erDragged) return;
  const t = e.target;
  if (t.closest && (t.closest('#ertools') || t.closest('#erlay') || t.closest('#erpick') || t.closest('.erbox'))) return;
  erClearPick();
});
$('erAll').onclick = () => { erAll = !erAll; $('erAll').textContent = 'Fields: ' + (erAll ? 'all' : 'key'); erLaidOut = false; erShowMaybeHeavy(); };
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
      header,#ertools,.hint2,#v-explorer{display:none !important}
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
  const kind = DATA.kind === 'schema' ? (curView === 'er' ? 'schema-ER' : 'schema') : (curView === 'er' ? 'graph' : 'functions');
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
  el.innerHTML = `${PRODUCT_NAME}${url} \u00b7 Created by ${PRODUCT_AUTHOR} \u00b7 Apache-2.0 \u00b7 Independent, unofficial tool - not affiliated with Zoho Corporation \u00b7 provided AS IS, no warranty`;
})();
