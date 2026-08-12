// --- Attribution (set PRODUCT_URL to the Chrome Web Store URL once available) ---
const PRODUCT_NAME = chrome.runtime.getManifest().name;   // renaming happens in manifest.json only
const PRODUCT_URL = 'https://zoost.it';
const PRODUCT_AUTHOR = 'Ivan Notaristefano';
/* graphview.js - Explorer + Visual graph. Reads graph from chrome.storage.local. */
let DATA = null, N = {}, ids = [], sel = null, hist = [], nameMode = 'display';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// esc() is NOT attribute-safe: a double quote closes the attribute early and silently truncates
// the value - that is what cut a snippet in half right after the opening bracket.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// What this window says in more than one place. `showList` is one control's aria-label and its
// title - the same words twice on the same element by design, which is exactly the pair that goes
// quiet when only one of them is edited. A literal used once stays where it is used;
// tests/panel.test.mjs enforces the rule in the other direction, over every shipped script.
const MSG = {
  showList: 'Show the list',
};
// Tolerant of a missing node: the callers pass N[id] and an id can outlive its node when a graph
// is filtered. Returning '' lets them fall back to the id rather than printing "undefined".
const label = (n) => (!n ? '' : nameMode === 'internal'
  ? (n.api_name || n.name)
  : ((DATA && DATA.kind === 'schema') ? (n.display_name || n.api_name || n.name) : n.name));
// The one dimension the list and the chips share. In functions mode the chips select a function's
// *category* - standalone, automation, button, schedule, validation rule - and the dot was coloured
// by its Deluge *namespace*, which is a different fact and usually has no colour defined, so every
// dot came out the fallback grey. `pass()` had the same confusion and compared the chip against
// `namespace` too, which means those five filters only ever worked in an org where Zoho returns no
// namespace at all. One accessor now decides both, so they cannot drift apart again.
/** The workspace this window is drawing, as the header states it.
 *
 *  The name the user gave it, if there is one, and never *instead of* the platform's: a header
 *  showing only our own words would be one nobody could check against Zoho, which is the reason the
 *  panel keeps both too. It was inline in each window and Analytics simply did not draw the label -
 *  its payload never carried one - so the same workspace was «Contabilita 2026» in the panel and an
 *  id in the diagram opened from it.
 */
function wsLine(ws) {
  if (!ws || !(ws.instance || ws.org)) return '';
  const inst = esc(ws.instance || '?'), org = esc(ws.org || '?');
  // A label the same as the derived name is not a label: printing both would say the one word
  // twice, which is what a sample workspace does by construction and what a user is free to do by
  // hand.
  const label = ws.label && ws.label !== ws.instance ? esc(ws.label) : null;
  return label
    ? `\u00b7 <b>${label}</b> \u00b7 ${inst} \u00b7 org ${org}`
    : `\u00b7 <b>${inst}</b> \u00b7 org ${org}`;
}
const KINDOF = (n) => (DATA.kind === 'schema' ? n.namespace : n.category) || '';
// A declared hue where there is one, and a fallback where there is not - because the set of kinds is
// the platform's to decide, not ours.
//
// The hash alone was not enough: it gave `scheduler` and `custombutton` the same violet, which is
// two roles wearing one colour - the defect this project already records about an accent eating a
// button role, one dimension over. So the hash chooses a *preferred* slot and the first free one
// from there wins. Deterministic, and it depends only on the set of kinds present: the same
// workspace always draws the same colours, and a kind keeps its own unless a new one lands on the
// slot it wanted.
//
// More kinds than hues is possible and is not hidden: past the palette the probe wraps and a
// repeat is unavoidable. Eight is well past what either platform has shown.
const FALLBACK_HUES = ['#0ea5e9', '#f97316', '#14b8a6', '#a855f7', '#84cc16', '#ec4899', '#64748b', '#eab308'];
const declaredHue = (k) => getComputedStyle(document.documentElement).getPropertyValue('--n-' + k).trim();
let _hues = null, _huesKey = null;
function hueFor(k) {
  const need = allKinds().filter((x) => x && !declaredHue(x)).sort();
  const key = need.join('\n');
  if (_huesKey !== key) {
    _hues = {};
    const used = new Set();
    for (const x of need) {
      let h = 0; for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0;
      const start = h % FALLBACK_HUES.length;
      let idx = start;
      for (let n = 0; n < FALLBACK_HUES.length; n++) {
        const j = (start + n) % FALLBACK_HUES.length;
        if (!used.has(j)) { idx = j; break; }
      }
      used.add(idx); _hues[x] = FALLBACK_HUES[idx];
    }
    _huesKey = key;
  }
  return _hues[k] || FALLBACK_HUES[0];
}
const KINDCOL = (k) => declaredHue(k) || (k ? hueFor(k) : '');
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
  if (_schema) {
    $('ertab').style.display = ''; $('reltab').style.display = ''; buildRelChips();
    try {
      const st = await chrome.storage.local.get('erParams');
      if (st && st.erParams && st.erParams.current) erP = Object.assign({}, ER_PRESET.modules, erKnownParams(st.erParams.current));
    } catch (_) {}
    erInitControls();
    // Depth buttons wired once: they work whether the focus comes from the open ("Open ER") or is
    // set later by selecting a module in the Explorer of a whole-graph ("Schema") view.
    $('erdMinus').onclick = () => setDepth(egoDepth - 1);
    $('erdPlus').onclick = () => setDepth(egoDepth + 1);
  }
  $('s-ws').innerHTML = wsLine(DATA.workspace);
  buildChips(); render(); initPositions(); graphStat(); updateScopeUI();
  if (DATA.kind === 'schema' && DATA.focus) {
    curFocus = DATA.focus; computeMaxDepth();
    egoDepth = Math.max(1, Math.min(maxEgoDepth, DATA.depth || 2));
    updateDepthUI();
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
// Zoho Analytics has one vocabulary here - what kind of view a node is - so there is no second
// dimension of entity chips the way the CRM has workflows, schedules and connections.
// One group per entity, and inside it one chip per kind of that entity. This workspace has one
// entity - a view is a view - so it draws one group called Views and looks exactly as it did. The
// machinery is here anyway because it is the CRM's, byte for byte: that panel grew a second entity
// (four kinds of automation action beside five Deluge categories) and the shape that answers it is
// shared chrome, not a CRM feature. A second entity here would get its own group without anyone
// touching this.
const ENTITY_LABEL = { views: 'Views' };
const entityOf = (n) => n.entity || 'views';
function entitiesPresent() {
  const seen = new Set(Object.values(N).map(entityOf));
  return Object.keys(ENTITY_LABEL).filter((e) => seen.has(e))
    .concat([...seen].filter((e) => !(e in ENTITY_LABEL)).sort());
}
function kindGroups() {
  // The empty string is a kind too. A view Zoho Analytics gave no kind for is a fact about the
  // workspace, and filtering it out of this set left it with no chip - so it could not be switched
  // off, and «None» left it on screen, which is exactly the defect one layer down.
  const byEnt = new Map();
  Object.values(N).forEach((n) => {
    const e = entityOf(n);
    if (!byEnt.has(e)) byEnt.set(e, new Set());
    byEnt.get(e).add(KINDOF(n));
  });
  return entitiesPresent().map((e) => {
    const ks = [...byEnt.get(e)].sort();
    return [ENTITY_LABEL[e] || (e.charAt(0).toUpperCase() + e.slice(1)),
            ks.map((k) => [k, k ? k.replace(/_/g, ' ') : 'no category'])];
  });
}
// «System» belongs here and not among the kinds: it is something true *about* a table, the way
// «hub» is, not a kind of thing - so it gets no hue and it starts off. Zoho Analytics flags it
// itself (isSystemTable), which is why it can be stated rather than inferred.
const ONLY = [['hub', 'hub (3+)'], ['orphan', 'orphan'], ['system', 'system table']];
const onlyList = () => ONLY;
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
const CONDITION_KEYS = new Set(['hub', 'orphan', 'system']);
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
    if (c === 'system' && !n.system) return false;
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
  if (!ids.filter((i) => pass(N[i], q)).length) {
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
      d.innerHTML = `<span class="dot" style="background:${NSCOL(KINDOF(n))}"></span><span class="nm">${esc(label(n))}</span><span class="ns">${esc(String(n.namespace || "").slice(0, 4))}</span><span class="deg">${n.called_by.length}◂</span>`;
      d.onclick = () => select(n.id); listEl.appendChild(d);
    });
}
function refRow(id) {
  const n = N[id]; const d = document.createElement('div'); d.className = 'ref';
  d.innerHTML = `<span class="dot" style="background:${NSCOL(KINDOF(n))}"></span><span class="nm">${esc(n.namespace + "." + label(n))}</span><span class="deg">${n.called_by.length}◂</span>`;
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
    <td class="mono">${f.lookup ? '\u2192 ' + esc(label(N[f.lookup]) || f.lookup) : ''}</td>${cells}
  </tr>`;
  }).join('');

  const head = detail && layFilter !== null
    ? `Fields in \u00ab${esc(lays[layFilter].name || lays[layFilter].id)}\u00bb \u00b7 ${rowsSrc.length} of ${all.length}`
    : `Fields \u00b7 ${all.length}${detail ? ` \u00b7 ${lays.length} layout(s)` : ''}`;

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
// A table's relations, both directions, with the join exactly as Zoho writes it. This replaces the
// CRM panel's related-lists block: the concept that matters here is the join, not a related-list
// API name, and inventing an equivalent would have been a worse lie than having none.
function joinsHtml(n) {
  const js = n.joins || [];
  if (!js.length) {
    return `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Relations \u00b7 0</div>`
      + `<div style="padding:9px 10px;color:#94a3b8;font:11.5px var(--sans)">This table takes part in no join in the ER model. That can be deliberate - a lookup list, a staging table - so it is a fact, not a problem.</div></div>`;
  }
  const rows = js.map((r) => `<tr>
    <td>${r.direction === 'out' ? '\u2192' : '\u2190'}</td>
    <td class="mono"><b>${esc(r.otherName)}</b></td>
    <td class="mono">${esc(r.column || '')}</td>
    <td class="mono">${esc(r.otherColumn || '')}</td>
    <td class="mono" style="color:#64748b">${esc(r.relation || '')}</td>
  </tr>`).join('');
  return `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Relations \u00b7 ${js.length} <span style="font-weight:400;color:#94a3b8">- \u2192 this table points out, \u2190 something points here</span></div>`
    + `<div style="display:block;padding:0;max-height:260px;overflow:auto;background:#fff"><table class="ftbl"><thead><tr><th></th><th>Other table</th><th>This column</th><th>Their column</th><th>Join</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function fieldsTableHtml(n) {
  const tbl = `<div id="layzone">${layoutZoneHtml(n)}</div>` + joinsHtml(n);
  const rd = n.reads || [];
  const who = rd.length
    ? `<div class="srcwrap" style="margin-top:12px"><div class="srchead">Read by ${rd.length} view(s) - from Zoho Analytics\' own lineage</div><div style="padding:8px 10px;font:11.5px var(--mono);color:#33415a;line-height:1.7">${rd.map((t) => esc(t)).join('<br>')}</div></div>`
    : '<div class="none" style="margin-top:12px">Nothing in this workspace reads from it. A shared link, a scheduled export or an API consumer would be invisible here - a candidate, not a verdict.</div>';
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
  const upHead = schema ? `Referenced by (${n.called_by.length}) <span class="hint">- tables pointing here</span>` : `Called by (${n.called_by.length}) <span class="hint">- breaks if you change it</span>`;
  const downHead = schema ? `References (${n.calls.length}) <span class="hint">- tables it points at</span>` : `Calls (${n.calls.length}) <span class="hint">- its dependencies</span>`;
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
  // Focus mode: the Explorer selection IS the context. Set it here so that switching to the
  // diagram afterwards already shows this table (it used to update only via ER).
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
// The neighbourhood the whole window is looking at, or null when nothing is focused. Explorer sets
// it on every selection and the diagram follows it; Relations did not, so selecting an item and
// switching to Relations landed on the whole catalogue and the click looked like it had done
// nothing. It is one context with three projections, not two and a table.
const relScoped = () => (curFocus && egoSet && !scopeAll ? egoSet : null);
function relPass(r) {
  // The chips are window-wide, so a relation whose either end is filtered out is not a row here.
  if (!N[r.from] || !N[r.to] || !passKind(N[r.from]) || !passKind(N[r.to])) return false;
  const ego = relScoped();
  if (ego && !(ego.has(r.from) && ego.has(r.to))) return false;
  if (relFilter === 'user' && r.system) return false;
  if (relFilter === 'sys' && !r.system) return false;
  if (!relQ) return true;
  const q = relQ.toLowerCase();
  return [r.fromName, r.col, r.toName, r.toCol, r.join].some((x) => (x || '').toLowerCase().includes(q));
}
function relRender() {
  if (!RELS.length) buildRels();
  const rows = RELS.filter(relPass);
  // Four things can narrow this table - the chips, the facet, the search and the focus - so «N of M»
  // has to say which. It names the reason, not the item: the focus group sits a few pixels above
  // with the name in it.
  //
  // It carried a «show all» of its own, added when the focus lived inside the diagram and this was
  // the only way out from here. The focus group is on screen in every view now, so that link became
  // a second switch for one state - the thing the comment it replaced was written to avoid.
  $('relcount').textContent = `${rows.length} of ${RELS.length} relations`
    + (relScoped() ? ' \u00b7 focus neighbourhood' : '');
  if (!RELS.length) {
    $('relwrap').innerHTML = '<div class="empty">No relations in this workspace. They come from the ER model - run <b>Pull all</b> and reopen this window.</div>';
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
    btn.setAttribute('aria-label', off ? MSG.showList : 'Hide the list');
    btn.title = off ? MSG.showList : 'Drag to resize the list, click to hide it';
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
// Re-measured after settle() became Fruchterman-Reingold over typed arrays: 4ms at 50 nodes, 27 at
// 150, 75 at 300, 294 at the 600 cap, against 53 / 359 / 1419 / 5854 before. 150 now means a spinner
// over about twenty-five milliseconds of work, which is the flicker the number exists to avoid; 200
// keeps the same rule - show it when the work is around a third of a second - with a margin for a
// machine slower than the one it was measured on.
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
  const t = [...document.querySelectorAll('.tab')].find((x) => x.dataset.v === v);
  if (!t) return;
  curView = v;
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', x === t));
  $('v-explorer').classList.toggle('on', curView === 'explorer');
  $('v-er').classList.toggle('on', curView === 'er');
  $('v-rel').classList.toggle('on', curView === 'rel');
  statRefresh();
  if (curView === 'rel') relRender();
  if (curView === 'er') erShowMaybeHeavy();
}
// Whether the work about to happen is worth saying something about. erShow's cost is in erLayout,
// and erLayout only runs when the layout is stale - so a second visit to the tab is instant and
// must not flash anything. Counted on what is about to be laid out, not on how big the workspace is.
function erShowMaybeHeavy() {
  const n = erVisibleIds().length;
  if (!erLaidOut && n >= SPIN_NODES) {
    runHeavy($('v-er'), `Laying out ${n} tables\u2026`, erShow);
  } else requestAnimationFrame(erShow);
}

// ---------------- Visual (canvas force graph) ----------------
let nodesA = [], edgesA = [], posX = {}, posY = {}, vx = {}, vy = {};
let laidOutKey = '';   // the set the force positions belong to, never a boolean - see settle()
let egoDepth = 2, egoSet = null, egoLevel = {}, curFocus = null, maxEgoDepth = 6;
let scopeAll = false;   // true = ignore the focus and draw the whole org (wall-poster mode)

// Deterministic robustness guard. The force layout (settle) is O(n²) per iteration × ~420 and runs
// on the main thread, so above this many nodes we do NOT attempt it - it would freeze the window.
// We know n before we start, so we refuse up front and point to the views that stay fast (Explorer,
// and - for schema - focus + depth). Conservative and NOT calibrated against a very large org; tune
// this single number if you ever profile one.
const FORCE_MAX_NODES = 1200;   // profiled end to end - see the CRM copy for the table
function forceFeasible(n) { return (n == null ? nodesA.length : n) <= FORCE_MAX_NODES; }
const edgesAmong = (list) => { const s = new Set(list); return edgesA.filter(([a, b]) => s.has(a) && s.has(b)); };
// What "everything" would cost with the chips as they stand - asked before scopeAll is applied, so
// it cannot ask erVisibleIds().
function visibleKindCount() { return nodesA.filter((id) => N[id] && passKind(N[id])).length; }
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
}
const focusName = (id) => (id && N[id] ? label(N[id]) : (id || ''));
function updateScopeUI() {
  const nodeChip = $('focusnode'), allChip = $('focusall'), x = $('focusx'), dp = $('erdepth');
  if (!nodeChip) return;
  const has = !!curFocus;
  nodeChip.textContent = has ? focusName(curFocus) : 'nothing selected';
  nodeChip.title = has
    ? `Draw only what is around ${focusName(curFocus)}`
    : 'Select a table in the Explorer to focus on it';
  // The chip wears the focused item's **own** category colour, read from the same accessor the list
  // dots and the filter chips use - so «what am I focused on» and «what kind is it» are one glance.
  // It was a hardcoded amber, which meant nothing and collided with the Connections chip: a colour
  // that is a claim about a dimension has to be wired to that dimension, which is a mistake this
  // window has already made once. With nothing selected there is no category, so there is no hue.
  if (has) { nodeChip.dataset.hue = KINDOF(N[curFocus]); nodeChip.style.setProperty('--hue', KINDCOL(KINDOF(N[curFocus])) || '#94a3b8'); }
  else { delete nodeChip.dataset.hue; nodeChip.style.removeProperty('--hue'); }
  nodeChip.classList.toggle('off', !has);
  nodeChip.setAttribute('aria-pressed', String(has && !scopeAll));
  allChip.setAttribute('aria-pressed', String(!has || scopeAll));
  allChip.title = has
    ? `Draw every table - the focus is kept and one click picks it up again`
    : `Drawing every table`;
  // Absent when there is nothing to forget, and when there is no neighbourhood to widen.
  if (x) x.style.display = has ? '' : 'none';
  if (dp) dp.style.display = (has && !scopeAll) ? 'inline-flex' : 'none';
}
// The focus group governs the window, so it is wired once here and not from a view.
// `Everything` pauses the focus rather than dropping it - the name stays on screen and can be
// picked up again - and `✕` is the one that forgets it. Two actions, two controls, no mode.
$('focusnode').onclick = () => { if (curFocus) setScope(false); };
$('focusall').onclick = () => { if (curFocus) setScope(true); };
$('focusx').onclick = () => clearFocus();
// The counts are of what the chips leave standing, with the full figure beside them when they
// differ. A status line reading 900 tables over a diagram drawing 200 is the same defect as a
// diagram that does not shrink when you filter it: a number that is not about what is on screen.
//
// Counted from the graph, never from nodesA/edgesA - those are layout state, and this line is
// written once before initPositions() has filled them.
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
  return `<b>${c.n}</b>${nf} tables · <b>${c.e}</b>${ef} relations`;
}
// The whole-graph line, with no focus on it. Lifted out of the init block so the chips can put it
// back: it was written once at startup and then never again, so filtering changed the drawing
// underneath a summary of the unfiltered graph.
function graphStat() {
  $('statline').innerHTML = `${statOf(null, DATA.counts.nodes, DATA.counts.edges)} · <b>${DATA.counts.dead_suspects}</b> in no relation${orphanNote()}`;
}
// Whichever of the two is the right one for the state we are in.
function statRefresh() { if (curFocus) egoStat(); else graphStat(); }
// Said in the diagram, where it is the difference between what the Explorer lists and what is
// drawn. It is not only about the filter: a node with no link of its own is not drawn either, and
// the first wording («with nothing left to link them») blamed the chips for both. The number is
// what the reader needs; why is one click away in the list beside it.
function orphanNote() {
  if (curView !== 'er') return '';
  const k = orphanedByFilter();
  return k ? ` · <span style="color:#94a3b8">${k} not drawn - nothing links them</span>` : '';
}
// One sentence, one function - the setter that refuses, and the diagram that puts itself back when
// a scope widened elsewhere turns out to be more than it can draw.
function tooWideToDraw(wide) {
  const filtered = wide < nodesA.length;
  $('statline').innerHTML = `<b>${wide} tables</b>${filtered ? ` of ${nodesA.length}` : ''} - too many to lay out all at once. Staying focused on <b style="color:#d98e00">${esc(label(N[curFocus]) || curFocus)}</b>; switch a kind off above, or widen with depth instead.`;
}
function setScope(all) {
  if (!curFocus) return;
  // "All tables" triggers the whole-workspace free layout. Above the budget we don't attempt it -
  // we stay focused and say why, rather than freezing on the way to a poster nobody can wait for.
  // And it is the *diagram's* budget: Relations is a table, so refusing there would be borrowing
  // one view's limit to block another.
  const wide = visibleKindCount();
  if (all && curView === 'er' && !forceFeasible(wide)) { tooWideToDraw(wide); return; }
  scopeAll = !!all;
  // Widening lays the whole workspace out again, which is the most expensive thing this window
  // does - and it did it in the click handler, so the interface sat there looking hung and then
  // jumped to the result. The work is deferred behind a painted frame, and the old drawing is
  // cleared first: leaving it up while a different graph is computed is the stale-projection
  // problem in miniature.
  const work = () => {
    bfsEgo(); updateDepthUI(); updateScopeUI(); egoStat(); erLaidOut = false;
    if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
  };
  if (!(wide >= SPIN_NODES && curView === 'er')) return work();
  $('erboxes').innerHTML = '';
  runHeavy($('v-er'), all ? 'Laying out every table\u2026' : `Laying out around ${label(N[curFocus]) || curFocus}\u2026`, work);
}
function egoStat() {
  if (!curFocus) return;
  if (scopeAll) {
    $('statline').innerHTML = `${statOf(null, DATA.counts.nodes, DATA.counts.edges)} · <span style=\"color:#94a3b8\">Save PDF prints the whole diagram on one page</span>${orphanNote()}`;
    return;
  }
  const allN = egoSet ? egoSet.size : DATA.counts.nodes;
  const allE = egoSet ? edgesA.filter(([a, b]) => egoSet.has(a) && egoSet.has(b)).length : DATA.counts.edges;
  $('statline').innerHTML = `${statOf(egoSet, allN, allE)} \u00b7 <span style=\"color:#94a3b8\">click a box to re-center</span>${orphanNote()}`;
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
  curFocus = id; computeMaxDepth(); egoDepth = Math.max(1, Math.min(maxEgoDepth, egoDepth || 2));
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
  updateScopeUI(); erLaidOut = false;
  graphStat();
  if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
}
// ---------------- ER diagram (entities + FK arrows) ----------------
let erLaidOut = false, erAll = false, erScale = 1, erTx = 0, erTy = 0;
const erPos = {};
let erIds = [];
let erEmph = 'modules';   // 'relations' = modules demoted to labels, relation names in the foreground
let erMaxX = 0, erMaxY = 0;
// Readability vs. compactness has no single right answer across graphs, so the trade-off is
// exposed as runtime controls instead of being guessed once at build time.
const ER_PRESET = {
  modules:   { margin: 36,  spread: 42, gap: 8,  fs: 10, sub: true },
  relations: { margin: 120, spread: 72, gap: 10, fs: 13, sub: true },
};
// A stored blob may only put back keys the presets declare. `ring` was a slider once, and a browser
// that had drawn one diagram before this version still has `ring: 420` in `chrome.storage.local` -
// merged in whole, it would sit in `erP` for ever, read by nothing and reported by nothing. This is
// not migration code with a version to grow out of: it is the permanent shape of the merge, so the
// next parameter that goes has nothing left to leave behind.
const erKnownParams = (o) => Object.fromEntries(
  Object.entries(o || {}).filter(([k]) => k in ER_PRESET.modules));
let erP = Object.assign({}, ER_PRESET.modules);
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
  // copied verbatim - it is the thing you paste into a query.
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
// Which nodes still have a relation to another node the chips have left standing.
//
// It used to be computed from the whole edge list, so switching a kind off left behind every node
// whose only relations went into it: boxes with no arrow at all, in a diagram whose whole subject
// is what joins to what.
//
// One pass is the whole cascade, not an approximation of it: dropping nodes that have no surviving
// edge cannot remove an edge between two nodes that do, so a second pass would find nothing.
// The candidate set: what would be drawn if nothing else were dropped. The **ego set belongs in
// here**, and leaving it out is what let orphans back in: the cascade counted an edge to a node the
// focus neighbourhood excludes, so a node was kept for a partner that was never going to be drawn.
// Reported - focus a standalone function, switch the standalone chip off, and five boxes stayed with
// nothing attached, each of them held in by an edge to a connection outside the neighbourhood.
const erCandidate = (id) => !!(N[id] && passKind(N[id]) && (!egoSet || egoSet.has(id)));
// One pass is still the whole cascade: dropping nodes with no edge inside the candidate set cannot
// remove an edge between two nodes that have one.
function linkedUnderFilter() {
  const linked = new Set();
  edgesA.forEach(([a, b]) => {
    if (erCandidate(a) && erCandidate(b)) { linked.add(a); linked.add(b); }
  });
  return linked;
}
function erVisibleIds() {
  // A table with no column to show has nothing to draw and stays out - the behaviour that was
  // already here, and a different question from having no relation left.
  if (erEmph !== 'relations') {
    return nodesA.filter((id) => erCandidate(id) && erFieldsFor(N[id]).length > 0);
  }
  const linked = linkedUnderFilter();
  return nodesA.filter((id) => erCandidate(id) && (linked.has(id) || id === curFocus));
}
// What the chips leave standing but the diagram will not draw, because nothing links it any more.
// The Explorer beside it still lists those items, so the number has to be given rather than left
// for the reader to work out by counting boxes.
function orphanedByFilter() {
  if (erEmph !== 'relations') return 0;
  const linked = linkedUnderFilter();
  return nodesA.filter((id) => erCandidate(id) && !linked.has(id) && id !== curFocus).length;
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
  // measured too: a long column name overflows just as readily as a title does.
  const sans = 'var(--sans)';
  const head = textWidth(label(n), `700 12px ${sans}`)
    + textWidth(n.api_name || '', `500 10px ${sans}`)
    + 18 + 8;
  const shown = Math.min(rows.length, cap);
  const widest = rows.slice(0, shown).reduce((m, f) => Math.max(m,
    textWidth(f.api_name, '11px ui-monospace, monospace')
    // The row draws label(N[id]), not the id - in Zoho Analytics an id is a number - so that is
    // what has to be measured. Measuring the id would size the box for a string nobody sees.
    + textWidth(f.lookup ? '\u2192 ' + (label(N[f.lookup]) || f.lookup) : (f.data_type || ''), '11px ui-monospace, monospace') + 26), 0);
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
    // A ring is as wide as what has to sit on it, and no wider. It was `L * erP.ring` with a default
    // of 420, so the radius was the same for eight boxes as for eighty and `erFit` then scaled the
    // whole drawing down to fit a circle that was mostly empty. Measured on the sample schema at
    // 1280x800: a focused diagram of eight boxes over two levels fitted at **28%** - 10px text drawn
    // under 3px - where the radii below fit the same drawing at **76%**. Both terms are measured
    // rather than chosen, which is the point: the slider that used to compensate for this is gone.
    //
    //   radially, a ring clears the one inside it by half of each ring's tallest box plus `margin` -
    //     the same clearance the collision pass further down enforces between any two boxes, so the
    //     two agree instead of one undoing the other;
    //   tangentially, the chord between neighbours has to clear the narrower of a box's two sides,
    //     because two axis-aligned rectangles are apart as soon as *either* axis separates them.
    //
    // The tangential term is a starting position, not a proof of non-overlap: near the top of a ring
    // it is the wide axis that has to do the separating, and the collision pass finishes that off.
    // Choosing it this way leaves the pass little to do, which is what keeps a ring looking like a
    // ring. Measured against the alternatives on seven shapes: a radius derived from arc length alone
    // came out 70% too large (47% zoom where this gives 76%), and a radial-only one let twelve boxes
    // collapse into a blob. This also matches or beats the hand-tuned `ring: 140` that `shots.py` was
    // setting to photograph the diagrams honestly - which it no longer needs to.
    let ringR = 0, prevH = 0;
    Object.keys(byLevel).map(Number).sort((a, b) => a - b).forEach((L) => {
      const ids = byLevel[L], sizes = ids.map((id) => erBoxSize(N[id]));
      if (L === 0) { const s = sizes[0]; erPos[ids[0]] = { x: -s.w / 2, y: -s.h / 2, w: s.w, h: s.h }; prevH = s.h; return; }
      const n = ids.length;
      const tall = Math.max(...sizes.map((s) => s.h)), wide = Math.max(...sizes.map((s) => s.w));
      const step = prevH / 2 + tall / 2 + erP.margin;
      const chord = n > 1 ? (Math.min(wide, tall) + erP.margin) / (2 * Math.sin(Math.PI / n)) : 0;
      ringR = Math.max(ringR + step, chord);
      prevH = tall;
      ids.forEach((id, i) => { const ang = (i / n) * 2 * Math.PI - Math.PI / 2; const s = sizes[i]; erPos[id] = { x: ringR * Math.cos(ang) - s.w / 2, y: ringR * Math.sin(ang) - s.h / 2, w: s.w, h: s.h }; });
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
// Where an arc leaves one box and where it arrives at the other.
//
// It used to attach to the left or right edge always, whatever the two boxes' relative positions.
// On a focused diagram with one neighbour the concentric layout puts that neighbour **straight
// above** the focus, so the arc left one box sideways, swept out, and came back into the other box's
// side - arriving almost parallel to the edge it landed on, with the arrowhead lying against the box
// and painted over by it, since #erboxes comes after #ersvg in the DOM. Reported, with a picture, as
// «the arrows are hidden even on a very simple graph». Measured on that case: dx=0, dy=-320, and the
// endpoints were the right edge of one box and the left edge of the other.
//
// So the side is chosen by the dominant direction. The caller needs to know which it was, because
// the bezier's control points have to be pulled along the same axis or the curve leaves the box
// sideways again.
function erEdgePoints(A, B) {
  const acx = A.x + A.w / 2, acy = A.y + A.h / 2;
  const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
  if (Math.abs(bcy - acy) > Math.abs(bcx - acx)) {
    const down = bcy >= acy;
    return [acx, down ? A.y + A.h : A.y, bcx, down ? B.y : B.y + B.h, 'v'];
  }
  const right = bcx >= acx;
  return [right ? A.x + A.w : A.x, acy, right ? B.x : B.x + B.w, bcy, 'h'];
}
function erApply() {
  $('ervp').style.transform = `translate(${erTx}px,${erTy}px) scale(${erScale})`;
  erSizeArrows();
}
// The arrowhead is drawn in the diagram's own coordinates and then the whole drawing is scaled, so
// its size on screen was the zoom times its size in the markup: measured on the sample org, 20.6px
// across on a focused view at 1.15 and **3.3px** on the whole org at 0.28. It was reported as «the
// arrows are sometimes there and sometimes not» - they were always there, and a three-pixel triangle
// is not there in any sense that matters. Direction is half of what an edge says.
//
// So the marker is sized against the zoom and comes out the same on screen at any of them. It needs
// `markerUnits="userSpaceOnUse"`, or the size would also multiply by each link's stroke width - four
// different values here - and one marker cannot be four sizes. The `viewBox` is what lets the width
// change without the shape or `refX` moving with it, so the tip still lands on the box edge.
const ARROW = { erarrow: [9, 8], erarrowsel: [12, 9] };
function erSizeArrows() {
  const k = 1 / Math.max(erScale, 0.02);
  for (const [id, [w, h]] of Object.entries(ARROW)) {
    const m = document.getElementById(id); if (!m) continue;
    m.setAttribute('markerWidth', (w * k).toFixed(2));
    m.setAttribute('markerHeight', (h * k).toFixed(2));
  }
}
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
    const A = erPos[a], B = erPos[b]; const [x1, y1, x2, y2, axis] = erEdgePoints(A, B);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const curve = axis === 'v' ? `C${x1},${my} ${x2},${my} ${x2},${y2}` : `C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    const hot = (a === sel || b === sel);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1},${y1} ${curve}`);
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
// Whether the reader has moved the diagram since it was last fitted. A window resize re-fits, which
// is what the Fit button was being clicked for every time - but only while this is false: panning
// and zooming are a view somebody chose, and throwing it away because the window changed size would
// be the window overruling them.
let erUserMoved = false;
function erFit() {
  // The panel's measured size is the only honest input to a scale, and this read used to be
  // `clientWidth || 1000, clientHeight || 700` - a viewport invented for the case where the panel
  // measures 0, which is a real state: a `.view` without `.on` is `display:none`. Measured on the
  // sample schema at 1280x800, where the panel is 1280x583: the true fit is 1.018 centred at x=358,
  // the invented pair gives 1.255 at x=153 - a diagram 23% too big and 200px off.
  //
  // No reachable path hit it. Instrumenting this function across all six rendered shots and driving
  // Fit, depth, focus and scope gives 35 calls, and every one that measured 0 needed a click on a
  // button that was `display:none` - all four call sites are guarded by `curView === 'er'`. It goes
  // anyway, because a guard on the caller is the only thing that stood between an invented number
  // and a wrong drawing: the fifth call site would have got a silently mis-scaled diagram instead of
  // no diagram, and this project does not guess a number it can measure. Nothing to fall back to
  // means nothing to draw yet - the next fit has a real panel to read.
  const vw = $('v-er').clientWidth, vh = $('v-er').clientHeight;
  if (!vw || !vh) return;
  let maxX = erMaxX, maxY = erMaxY;
  erIds.forEach((id) => { const p = erPos[id]; if (!p) return; maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h); });
  const pad = 40;
  erScale = Math.max(0.02, Math.min(1.4, Math.min((vw - pad * 2) / (maxX || 1), (vh - pad * 2) / (maxY || 1))));
  erTx = (vw - maxX * erScale) / 2; erTy = (vh - maxY * erScale) / 2; erApply();
  erUserMoved = false;
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
}
let erDown = false, erDragged = false, erSx = 0, erSy = 0, erT0x = 0, erT0y = 0;
document.addEventListener('mousedown', (e) => {
  if (curView !== 'er' || e.target.closest('#ertools')) return;
  erDown = true; erDragged = false; erSx = e.clientX; erSy = e.clientY; erT0x = erTx; erT0y = erTy;
});
document.addEventListener('mousemove', (e) => {
  if (!erDown) return; const dx = e.clientX - erSx, dy = e.clientY - erSy;
  if (Math.abs(dx) + Math.abs(dy) > 4) { erDragged = true; erUserMoved = true; }
  erTx = erT0x + dx; erTy = erT0y + dy; erApply();
});
document.addEventListener('mouseup', () => { erDown = false; setTimeout(() => (erDragged = false), 0); });
// The window changing size leaves the drawing framed for a size it no longer has, and the only way
// back was the Fit button. Debounced, because resize fires continuously through a drag and erFit
// walks every box; 120ms is below what reads as a delay and well above the event rate.
let _erFitT = null;
window.addEventListener('resize', () => {
  clearTimeout(_erFitT);
  _erFitT = setTimeout(() => { if (curView === 'er' && !erUserMoved) erFit(); }, 120);
});
document.addEventListener('wheel', (e) => {
  if (curView !== 'er') return; e.preventDefault();
  const rect = $('v-er').getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const before = erScale; erScale = Math.max(0.02, Math.min(3, erScale * (e.deltaY < 0 ? 1.1 : 0.9)));
  erTx = mx - (mx - erTx) * (erScale / before); erTy = my - (my - erTy) * (erScale / before); erApply();
  erUserMoved = true;
}, { passive: false });
// ---- runtime layout controls ----
const ER_CTL = [
  ['pMargin', 'vMargin', 'margin'], ['pSpread', 'vSpread', 'spread'],
  ['pGap', 'vGap', 'gap'], ['pFs', 'vFs', 'fs'],
];
const ER_RELAYOUT = new Set(['margin', 'spread']);
let _erT = null;
// Which layout branch is live decides which knobs mean anything:
// the force branch is driven by `spread`; the concentric one derives its radii and has no knob.
function erConcentric() { return !!(curFocus && egoSet); }   // concentric follows the CURRENT focus, not just the one it was opened with
function erUpdateControlVis() {
  const rel = erEmph === 'relations', conc = erConcentric();
  const set = (id, on) => { const e = $(id); if (e) e.classList.toggle('off', !on); };
  set('rowMargin', true);
  set('rowSpread', !conc);
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
  el.innerHTML = `${PRODUCT_NAME}${url} \u00b7 Created by ${PRODUCT_AUTHOR} \u00b7 Apache-2.0 \u00b7 Independent, unofficial tool - not affiliated with Zoho Corporation \u00b7 provided AS IS, no warranty`;
})();
