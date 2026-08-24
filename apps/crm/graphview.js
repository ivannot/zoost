// --- Attribution (set PRODUCT_URL to the Chrome Web Store URL once available) ---
const PRODUCT_NAME = chrome.runtime.getManifest().name;   // renaming happens in manifest.json only
const PRODUCT_URL = 'https://zoost.it';
const PRODUCT_AUTHOR = 'Ivan Notaristefano';
/* graphview.js - Explorer + boxed call/schema diagram. The graph arrives via chrome.storage.session
   (per browser session, like the unlocked key); the reader's own settings stay in .local. */
let DATA = null, N = {}, ids = [], sel = null, hist = [], nameMode = 'display';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// esc() is NOT attribute-safe: a double quote closes the attribute early and silently truncates
// the value - that is what cut the getRelatedRecords snippet right after the opening bracket.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// What this window says in more than one place. `showList` is one control's aria-label and its
// title - the same words twice on the same element by design, which is exactly the pair that goes
// quiet when only one of them is edited. A literal used once stays where it is used;
// tests/panel.test.mjs enforces the rule in the other direction, over every shipped script.
const MSG = {
  // Loading an arrangement onto a diagram the mirror has moved on. Three numbers rather than a
  // verdict: the reader is the one who knows whether it is worth arranging again.
  arrLoaded: (kept, fresh, stale) => `${kept} where you put ${kept === 1 ? 'it' : 'them'}`
    + (fresh ? ` \u00b7 ${fresh} new, placed by the layout` : '')
    + (stale ? ` \u00b7 ${stale} in the file ${stale === 1 ? 'is' : 'are'} gone from this diagram` : ''),
  // Every id still matches and the relationships do not: the insidious one, because the line above
  // would report a clean load and say nothing about the thing worth knowing. A number, not a grade.
  arrArcs: (d) => ` \u00b7 the diagram has ${Math.abs(d)} ${Math.abs(d) === 1 ? 'relation' : 'relations'} `
    + (d > 0 ? 'more' : 'fewer') + ' than when this was saved',
  // Naming the workspace it came from, because «nothing here matches» is true and is not the
  // reason. Reported: saved one arrangement, changed workspace, loaded it, and nothing said
  // the file belonged somewhere else - which is the one fact the file actually carries.
  // A fold whose arc is no longer there cannot be replayed, and it was being dropped without a
  // word - which made «every loss is counted» false in four guides. auditcheck stopped the
  // release over exactly that sentence, which is what it is for.
  arrFolds: (n) => ` \u00b7 ${n} folded ${n === 1 ? 'branch' : 'branches'} in the file no longer apply`,
  arrOtherWorkspace: (was) => ` \u00b7 saved from ${was}, so only names that match on their own came back`,
  arrWrongWorkspace: (was, now) => `That arrangement was saved from ${was}, and this diagram is ${now}. `
    + 'Nothing in it belongs to this one.',
  arrWrongKind: (was) => `This file arranges ${was || 'a different diagram'}, and this window is not drawing one.`,
  // **Two refusals shared one sentence, and it described only the second.** An arrangement written
  // by the *other* Zoost was refused with «this window is not drawing one» while the window was
  // drawing exactly that - the one fact the file carries that explains the refusal was never said,
  // and the sentence that was said is false about what is on screen. Reachable by anyone running
  // both extensions: the suggested filenames are near-identical between them.
  arrOtherProduct: 'That arrangement was saved by the other Zoost. The two products draw different '
    + 'things, so nothing in it names anything here.',
  arrNothingMatched: 'Nothing in that file is on this diagram - it was saved from a different graph, or everything in it has since been renamed.',
  arrBadFile: {
    notJson: 'That file is not readable as an arrangement.',
    notOurs: 'That is not a Zoost arrangement.',
    newer: 'That arrangement was written by a newer version of Zoost than this one.',
    noPositions: 'That arrangement has no positions in it.',
    tooBig: 'That arrangement holds more boxes than this diagram is set to draw.',
  },
  arrSaved: (n) => `Arrangement saved: ${n} ${n === 1 ? 'box' : 'boxes'}.`,
  cutDo: (name, k) => (k > 1
    ? `Hide ${name} and the ${k - 1} ${k === 2 ? 'box' : 'boxes'} that came with it`
    : `Hide ${name}`),
  cutUndo: (k) => `Show the ${k} ${k === 1 ? 'box' : 'boxes'} again`,
  // What a control is about to take away, by name. A count answers «how much» and the question in
  // front of somebody zoomed in on a crowded rim is «what» - most of what a cascade removes is off
  // screen, so it cannot be looked at, only read.
  //
  // A heading, a blank line, and one dash per box. The first version put the names one per line on the
  // belief that a tooltip does not wrap - it does, and the reader's own screenshot is the proof: a
  // name like «Formazione specialistica valorizza esito e Crea Compito dopo colloquio» takes three
  // lines by itself, so «one line, one box» stops being true exactly where the names are long enough
  // to need it. The dash survives the wrap: a continuation line has none, so what is one item and what
  // is two is never in question. Reported as «it all looks stuck together».
  cutTip: (names, more) => (names.length === 1 && !more
    ? `Removing ${names[0]}`
    : `Removing ${names.length + more} boxes:\n\n`
      + names.map((n) => `- ${n}`).join('\n') + (more ? `\n- and ${more} more` : '')),
  backTip: (names, more) => (names.length === 1 && !more
    ? `Putting back ${names[0]}`
    : `Putting back ${names.length + more} boxes:\n\n`
      + names.map((n) => `- ${n}`).join('\n') + (more ? `\n- and ${more} more` : '')),
  folded: (k) => `${k} ${k === 1 ? 'box' : 'boxes'} off the diagram \u00b7 the + where the arc meets the box brings ${k === 1 ? 'it' : 'them'} back`,
  unfolded: (k) => `${k} ${k === 1 ? 'box is' : 'boxes are'} back on the diagram`,
  kept: (k, n) => `kept where you put ${k === 1 ? 'it' : 'them'} \u00b7 ${k} arranged` + (n ? ` \u00b7 ${n} placed by the layout` : '') + ' \u00b7 Re-layout starts over',
  dropCovers: (k) => `moved \u00b7 it now covers ${k} other ${k === 1 ? 'box' : 'boxes'}`,
  dropClear: 'moved \u00b7 nothing is covered',
  tabCount: (n) => `${n} ${NOUN().n} to draw`,
  tabCrowded: (n) => `${n} ${NOUN().n} - past the ${CROWDED_NODES} this diagram has been measured to draw without boxes covering each other, so expect it crowded. It is still drawn: switch a category off above, or pick something to focus on, to bring it down.`,
  tabOver: (n) => `${n} ${NOUN().n} - more than the ${drawMax} this diagram is set to lay out. Switch a category off above, or pick something to focus on.`,
  tooMany: (n) => `<b>Too many to lay out.</b> ${n} ${NOUN().n} are on the tab above and the ceiling is ${drawMax}, which is ${DRAW_MAX_NODES} by default because that is what was measured: past it the layout takes longer than anyone waits - 1200 comes to about seven seconds - and what it produces cannot be read anyway. Switch a category off above, or pick one to focus on: the number beside the tab comes down as you do, and the diagram draws itself as soon as it fits. Past ${CROWDED_NODES} it is drawn but crowded, which the number says before you ask for it.`,
  showList: 'Show the list',
  emphasis: 'Emphasis: ',
};
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
// What kinds of thing this window knows about, in the order they read in: what runs, what it
// fires, what fires it, what it reaches, what it all touches. Declared for the order and the
// capital letter only - an entity that is not here still gets its own group and its own count,
// because the set comes from the nodes and never from this list.
const ENTITY_LABEL = { functions: 'Functions', actions: 'Actions', workflows: 'Workflows',
                       schedules: 'Schedules', connections: 'Connections', modules: 'Modules' };
const entityOf = (n) => n.entity || 'functions';
const entityWord = (e) => e.replace(/s$/, '');
// A declaration rather than an arrow, so `tests/slice.mjs` can lift it: that helper ends a `const`
// at the first semicolon closing a line, which inside a multi-line body is not the end of anything.
function entityBreakdown() {
  const c = {}, all = {};
  // The fifth reader of what the fold hid, and the last one that was still counting it. `erFit`,
  // the print handler, `erCovers` and the tab badge all skip it; this line sat beside the badge and
  // disagreed with it - the window saying in one place that three boxes went and in another that
  // they are still there, which the note in `erCovers` describes in exactly those words.
  //
  // Only in the ER view, where folding exists at all: `erHiddenSet()` is empty elsewhere, and
  // asking is cheaper than reasoning about whether it always will be.
  const gone = curView === 'er' ? erHiddenSet() : new Set();
  Object.entries(N).forEach(([id, n]) => {
    const k = entityOf(n);
    all[k] = (all[k] || 0) + 1;
    if (passKind(n) && !gone.has(id)) c[k] = (c[k] || 0) + 1;
  });
  return entitiesPresent().map((k) => {
    const shown = c[k] || 0;
    const of = shown !== all[k] ? ` <span style="color:#94a3b8">of ${all[k]}</span>` : '';
    return `<b>${shown}</b>${of} ${entityWord(k)}${all[k] === 1 ? '' : 's'}`;
  }).join(' \u00b7 ');
}
const NOUN = () => (DATA.kind === 'schema'
  // `n1`/`e1` beside `n`/`e`: the plural alone produced «1 modules» wherever a count of one is
  // shown, and a singular derived by chopping an «s» is a rule that would be wrong the first time a
  // noun does not end in one.
  ? { n: 'modules', n1: 'module', e: 'lookups', e1: 'lookup', dead: 'unreferenced', all: 'All modules', box: 'table' }
  : { n: 'nodes', n1: 'node', e: 'links', e1: 'link', dead: 'nothing calls them', all: 'Everything', box: 'node' });
/** The workspace this window is drawing, as the header states it.
 *
 *  The name the user gave it, if there is one, and never *instead of* the platform's: a header
 *  showing only our own words would be one nobody could check against Zoho, which is the reason the
 *  panel keeps both too. It was inline in each window and Analytics simply did not draw the label -
 *  its payload never carried one - so the same workspace was «Contabilita 2026» in the panel and an
 *  id in the diagram opened from it.
 */
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
const KINDCOL = (k) => declaredHue(k) || (k ? hueFor(k) : '');
const NSCOL = (ns) => KINDCOL(ns) || '#94a3b8';

// A declaration and a call, not an immediately-invoked expression. `functions()` in
// `tools/asynccheck.py` matches a declaration at the start of a line, so a *named* function
// wearing a paren is as invisible as an anonymous one - and the whole startup of this page runs
// inside it, awaits included.
async function init() {
  // One key per window: the token rides the URL, so two diagrams open together cannot consume each
  // other's payload. Consumed on read - a window owns its graph from here on, and a stale slot must
  // not outlive it. Without a token (the render harness opens the page bare) the plain key answers.
  const token = new URLSearchParams(location.search).get('graph');
  const key = token ? 'graphData:' + token : 'graphData';
  const store = await chrome.storage.session.get(key);
  DATA = store[key];
  if (DATA && token) { try { await chrome.storage.session.remove(key); } catch (_) {} }
  if (!DATA) { $('main').innerHTML = '<div class="empty">No graph data. Open it from the side panel.</div>'; return; }
  N = DATA.nodes; ids = Object.keys(N).sort((a, b) => a.localeCompare(b));
  // The four numbers are written by `graphStat()`, which replaces the whole line and runs twice
  // during this init, a few lines below. Poking the spans here wrote them once and never again -
  // the exact pattern the comment above `graphStat` records about this same element - and the
  // sentence saying what «nothing calls them» was measured over lives in that one place, so a
  // second writer would have printed the number without it.
  const _schema = DATA.kind === 'schema';
  document.title = PRODUCT_NAME;
  { const h = $('gtitle'); if (h) h.textContent = PRODUCT_NAME; }
  // The boxed diagram is the same drawing in both cases, so it is the same tab - under the name the
  // project already gives each one: "ER diagram" for modules and tables, "Wiring" for the rest.
  // Two names, never a third.
  //
  // It was "Call graph" and it stayed "Call graph" through a rename, because the markup said Graph
  // and this line wrote the old word back over it on every open - the exact trap this repository
  // already records about labels that live in the markup and are rebuilt by the code that updates
  // state. The label is written here because it genuinely varies with the subject; what it must not
  // do is disagree with the button in the panel that opens it, which now says Graph too.
  {
    $('ertab').style.display = '';
    $('ertabname').textContent = _schema ? 'ER diagram' : 'Wiring';
    $('reltab').style.display = ''; buildRelChips();
    erP = Object.assign({}, ER_PRESET[erBoxPreset()]);
    try {
      const st = await chrome.storage.local.get('erParams');
      // A recorded `kind` must match; **no** recorded kind is a default written by the settings page
      // and applies to any graph. It used to require the match either way, and that page writes no
      // kind - so every value saved there was read and thrown away, silently, on every open. Box
      // spacing, spread, label gap, label size: «Diagram defaults saved.» and nothing changed. The
      // Analytics twin has no such guard and has always worked.
      const ep = st && st.erParams;
      if (ep && ep.current && (ep.kind === undefined || ep.kind === DATA.kind)) {
        erP = Object.assign({}, erP, erKnownParams(ep.current));
      }
      const dm = await chrome.storage.local.get('erDrawMax');
      if (Number.isFinite(dm.erDrawMax) && dm.erDrawMax > 0) drawMax = dm.erDrawMax;
    } catch (_) {}
    erInitControls();
    // Depth buttons wired once: they work whether the focus comes from the open ("Open ER") or is
    // set later by selecting a module in the Explorer of a whole-graph ("Schema") view.
    $('erdMinus').onclick = () => setDepth(egoDepth - 1);
    $('erdPlus').onclick = () => setDepth(egoDepth + 1);
  }
  graphStat();
  $('s-ws').innerHTML = wsLine(DATA.workspace);
  // The box searches whatever this window is drawing, and it stopped being only functions the day
  // workflows, schedules and connections became nodes.
  $('q').placeholder = (DATA.kind === 'schema' ? 'Search module\u2026' : 'Search anything here\u2026') + '  (/ to focus)';
  buildChips(); render(); initPositions(); wireSubject(); graphStat(); updateScopeUI();
  // Guarded here since this window was written; what it did not do is say anything when the guard
  // fired, so an unanswerable request looked exactly like an ordinary whole-graph view.
  if (DATA.focus && !N[DATA.focus]) noFocusHere(DATA.focus);
  if (DATA.focus && N[DATA.focus]) {
    curFocus = DATA.focus; computeMaxDepth();
    egoDepth = Math.max(1, Math.min(maxEgoDepth, DATA.depth || 2));
    updateDepthUI();
    bfsEgo(); egoStat(); updateScopeUI();
    const t = document.querySelector('.tab[data-v="er"]'); if (t) setTimeout(() => t.click(), 60);
  }
}
init();

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
// One group per entity, and inside it one chip per kind of that entity - so the four kinds of
// action sit in an Actions box exactly as the five Deluge categories sit in a Functions box, and
// «switch the field updates off» is a question this window can now be asked.
//
// It used to be a hand-written list of which kinds were entities rather than categories, with
// everything else swept into a box called Functions. The moment actions arrived they landed in
// there - four action kinds among the Deluge categories, one dimension pretending to be another,
// which is the mistake this repository has already recorded twice. Both levels come off the nodes
// now: an entity Zoho invents tomorrow gets a group and a kind gets a chip, without anyone
// remembering.
function kindGroups() {
  // The empty string is a kind too. A function Zoho gave no category for is a fact about the org,
  // and filtering it out of this set left it with no chip - so it could not be switched off, and
  // «None» left it on screen, which is exactly the defect one layer down.
  if (DATA.kind === 'schema') {
    const seen = [...new Set(Object.values(N).map((n) => KINDOF(n)))].sort();
    return seen.length ? [['Modules', seen.map((k) => [k, k ? k.replace(/_/g, ' ') : 'no category'])]] : [];
  }
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
  // Three names, not two - see the panel's FN_NAMES. `api_name` was missing here, so the same
  // search behaved differently in the two windows, which is worse than either being wrong.
  return !q || [n.name, n.display_name, n.api_name].some((x) => String(x || '').toLowerCase().includes(q));
}
// The chips choose what the window is looking at, so all four views follow them. The search box
// narrows the *list* only: hiding the diagram down to one node as you type would be a different
// feature wearing the same control.
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
  const extra = schema ? fieldsTableHtml(n) : '';   // no source in this window - see graphlogic.js
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
  // Focus mode: the Explorer selection IS the context. Set it here so that switching to the boxed
  // diagram afterwards already shows this item. It was gated on `schema`, so on a call
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
  // Four things can narrow this table - the chips, the facet, the search and the focus - so «N of M»
  // has to say which. It names the reason, not the item: the focus group sits a few pixels above
  // with the name in it.
  //
  // It carried a «show all» of its own, added when the focus lived inside the diagram and this was
  // the only way out from here. The focus group is on screen in every view now, so that link became
  // a second switch for one state - the thing the comment it replaced was written to avoid.
  const noun = calls ? 'calls' : 'relations';
  $('relcount').textContent = `${rows.length} of ${RELS.length} ${noun}`
    + (relScoped() ? ' \u00b7 focus neighbourhood' : '');
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
      const r = await chrome.runtime.sendMessage({ type: 'graphSwitch', kind: el.dataset.k, token: new URLSearchParams(location.search).get('graph') });
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

// Explorer and the diagram are two projections of one context. A selection that cannot be projected
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
// The count that matters is what is about to be laid out, never how big the org is: switching a
// category off can bring a graph that was refused under the budget, and refusing it anyway would
// mean the filters cannot buy what they exist to buy.
// Two limits, two jobs, both measured - and neither is the other's, which is the mistake that put a
// 1200-node hairball on screen in the first place.
//
// **DRAW_MAX_NODES blocks**, and it is a limit of *cost*. Profiled end to end on generated graphs with
// the collision pass as it now stands: 200 nodes lay out in 0.5s, 400 in 1.3s, 600 in 2.2s, 1000 in
// 4.9s, 1200 in **7.2s**. This constant was 1200 on an older profile of about 2.1s, taken against the
// all-pairs collision pass that has since been replaced - so the change to that pass invalidated the
// number and nothing said so, which is why the profile is quoted here rather than remembered. Two
// seconds is a wait and seven is a hang, the same criterion as before, so the line is the largest
// round size measured under two seconds. **Those figures are layout only**: erRender then builds an
// SVG path and a div per box, and headless Chrome cannot be trusted to time that - virtual time
// advances the clock - so the real wait is longer than the numbers above and the line is drawn at the
// measured 1.3s rather than at the 2.2s that would otherwise have qualified.
// **800 rather than 400, because a real org measured 725.** The first value satisfied the criterion
// above - largest round size under two seconds - and refused the org it was written for, which makes it
// a number that served the rule and missed the user. 800 covers that measurement with headroom and
// costs about 3.6 seconds of layout, behind a spinner, once. Three seconds is a wait somebody makes
// deliberately for a whole-org drawing; the seven at 1200 is not. The lesson is the one this file keeps
// learning: a threshold derived from generated data has to be checked against one real reading before
// it is trusted, and the reading changed it by a factor of two.
const DRAW_MAX_NODES = 800;
// The measured figure is the default, not the rule: the options page lets it be raised, because
// what is being traded is the reader's own patience against how much of the graph they get, and
// that is theirs to trade. Read once when the window opens; a change there takes effect on the
// next open, which is the same contract the layout sliders have.
let drawMax = DRAW_MAX_NODES;
const drawable = (n) => n <= drawMax;
// **CROWDED_NODES advises**, and it is a limit of *quality*. With the canvas shaped to the panel, five
// generated graphs at each size come out with no box covering another up to 80 nodes, 4 of 5 at 90 and
// at 100, 1 of 5 at 120, none at 150. Past it the drawing is still worth having - at 400 nodes about
// 320 pairs overlap, which is crowded and readable in places rather than useless - so this number is
// said and not enforced. The reader is told where the quality goes and decides; blocking here instead
// made the whole-org view unreachable for any org with more than eighty functions in one category,
// which is most of them, and that is worse than a crowded drawing.
const CROWDED_NODES = 80;
const crowded = (n) => n > CROWDED_NODES;
// What "everything" would cost with the chips as they stand - used before scopeAll is applied, so
// it cannot ask erVisibleIds().
const edgesAmong = (list) => { const s = new Set(list); return edgesA.filter(([a, b]) => s.has(a) && s.has(b)); };

// The chips are the colour key now: each carries its hue and its word, they sit in the header, and
// they are on screen in every view - which the legend never was, since it lived inside the canvas.
// Two keys for one dimension is how they end up disagreeing, and this window has done that before.
// (It sits above initPositions by accident of history: it explains the chips and the legend that is
// gone, not the function below it.)

function updateDepthUI() {
  $('erdVal').textContent = egoDepth;
  const mx = $('erdMax'); if (mx) mx.textContent = '/ ' + maxEgoDepth;
  $('erdMinus').disabled = scopeAll || egoDepth <= 1;
  $('erdPlus').disabled = scopeAll || egoDepth >= maxEgoDepth;
}
function updateScopeUI() {
  const nodeChip = $('focusnode'), allChip = $('focusall'), x = $('focusx'), dp = $('erdepth');
  if (!nodeChip) return;
  const has = !!curFocus;
  nodeChip.textContent = has ? focusName(curFocus) : 'nothing selected';
  nodeChip.title = has
    ? `Draw only what is around ${focusName(curFocus)}`
    : `Select ${NOUN().box === 'table' ? 'a table' : 'an item'} in the Explorer to focus on it`;
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
    ? `Draw ${NOUN().all.toLowerCase()} - the focus is kept and one click picks it up again`
    : `Drawing ${NOUN().all.toLowerCase()}`;
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
  if (all && curView === 'er' && !drawable(wide)) { tooWideToDraw(wide); return; }
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
// The noun follows the number it is standing next to, and that is not always the selection.
//
// «1 of 87 table» - the Analytics twin - pluralised on the 1 while the word sits after the 87. «1
// modules» - the CRM - never pluralised at all, because `NOUN()` hands back a fixed plural. Both are
// reached whenever a focused view has exactly one node or one edge, which is the case that carries
// «it takes part in none» - the sentence a reader is most likely to stop and read.
//
// One helper, because the rule is one rule: whichever number the word is attached to decides it.
const countedAs = (shown, total, one, many) => ((total == null ? shown : total) === 1 ? one : many);
function statOf(set, allN, allE) {
  const c = statCounts(set);
  const nf = c.n !== allN ? ` <span style="color:#94a3b8">of ${allN}</span>` : '';
  const ef = c.e !== allE ? ` <span style="color:#94a3b8">of ${allE}</span>` : '';
  // A reason when the answer is one box with nothing around it, the same as its twin: the count on
  // its own reads as a fault rather than as the finding it is.
  const alone = c.n === 1 && c.e === 0 && curFocus;
  return `<b>${c.n}</b>${nf} ${countedAs(c.n, nf ? allN : null, NOUN().n1, NOUN().n)}`
    + ` \u00b7 <b>${c.e}</b>${ef} ${countedAs(c.e, ef ? allE : null, NOUN().e1, NOUN().e)}`
    + (alone ? ' <span style="color:#94a3b8">- it takes part in none, so there is nothing to draw around it</span>' : '');
}
// The whole-graph line, with no focus on it. Lifted out of the init block so the chips can put it
// back: it was written once at startup and then never again, so filtering changed the drawing
// underneath a summary of the unfiltered graph.
function graphStat() {
  $('statline').innerHTML = DATA.kind === 'schema'
    ? `${statOf(null, DATA.counts.nodes, DATA.counts.edges)} · <b>${DATA.counts.dead_suspects}</b> ${NOUN().dead}${mirrorNote()}${orphanNote()}`
    : `${entityBreakdown()} · <b>${DATA.counts.edges}</b> links · <b>${DATA.counts.dead_suspects}</b> nothing calls them${mirrorNote()} · <b>${DATA.counts.unresolved}</b> unresolved${orphanNote()}`;
  erCountRefresh();
}
// Whichever of the two is the right one for the state we are in.
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
// What «nothing calls them» was measured over. The drawing is built from the functions in the
// mirror, and one that never downloaded is not here at all - so it makes no calls, and anything it
// was the only caller of is counted as having none. Said beside the number rather than in a note
// somebody has to go and find, because the number is what gets acted on.
//
// Unknown is marked too, and differently: «how much of the org is here could not be established»
// is not «nothing is missing», and this window has no way to tell them apart on its own.
function mirrorNote() {
  const c = DATA && DATA.counts ? DATA.counts : {};
  if (c.notInMirror === undefined) return '';
  if (c.notInMirror === null) {
    return ' \u00b7 <span style="color:#94a3b8" title="This counts callers among the functions in your'
      + ' mirror. How many the org has could not be established.">over an unknown share of the org</span>';
  }
  if (!c.notInMirror) return '';
  // Escaped although they are counts: «it is a number» is a belief about the value, and the checker
  // that reads this line is built to refuse exactly that argument. It costs nothing to be right.
  return ` \u00b7 <span style="color:#94a3b8" title="${escA(c.nodes)} of ${escA(c.inOrg)} functions are in this`
    + ` mirror. ${escA(c.notInMirror)} did not download, and a function called only from one of those is`
    + ` counted as having no caller.">over ${esc(c.nodes)} of ${esc(c.inOrg)}</span>`;
}
// Asked to centre on something this diagram does not contain. Never silently: the whole point of
// opening it focused was to look at that one thing, so the window says which it was and what it is
// showing instead - and it stays on the whole workspace, which is at least an answer.
function noFocusHere(id) {
  const line = document.getElementById('statline');
  if (!line) return;
  // What it was called, when the caller knew: an id is not something a reader can act on. Escaped,
  // because it is a name from the org - a Zoho view or module called `<img src=x>` is a legal name,
  // and this is the one place a name reached `innerHTML` raw. The CSP stops it executing; it does
  // not stop it being markup, and «no hostile string keeps a tag open» is a rule this project asserts
  // elsewhere. Found by an outside audit inside a function a test already inspected - the test read
  // the *path* and never the property.
  const name = esc(String(DATA.focusName || id));
  line.innerHTML = `<b>Nothing to focus on.</b> ${name} is not in this diagram - `
    + `nothing names it, so it is not one of the boxes this graph is made of. Showing everything instead.`;
}

function egoStat() {
  if (!curFocus) return;
  if (scopeAll) {
    $('statline').innerHTML = `${statOf(null, DATA.counts.nodes, DATA.counts.edges)} · <span style=\"color:#94a3b8\">Save PDF prints the whole diagram on one page</span>${orphanNote()}`;
    return;
  }
  const allN = egoSet ? egoSet.size : DATA.counts.nodes;
  const allE = egoSet ? edgesA.filter(([a, b]) => egoSet.has(a) && egoSet.has(b)).length : DATA.counts.edges;
  $('statline').innerHTML = `${statOf(egoSet, allN, allE)} \u00b7 <span style=\"color:#94a3b8\">click a box to focus it</span>${orphanNote()}`;
  erCountRefresh();
}
function setFocus(id) {
  // Re-centre the shared focus WITHOUT changing view. Explorer and the diagram are two
  // projections of the same context, so whoever changes the focus updates both.
  if (!id || !N[id] || id === curFocus) return;
  // Except a module Zoho refused to describe. It has no fields and no lookups *that anyone read*, so
  // all three projections would come out empty - and an empty diagram reads as "this relates to
  // nothing", which is the opposite of what is true. Reported: the panel offered the ER button on
  // such a module and it opened a window with nothing in it.
  if (N[id].unreadable) {
    $('statline').innerHTML = `<b style="color:#94a3b8">${esc(label(N[id]))}</b> \u00b7 Zoho would not describe this module, so its fields and relations were never read - there is nothing to draw for it.`;
    return;
  }
  // Asking to look at something is asking for it back: the Explorer beside the diagram still lists
  // what has been taken off it, so the focus can be moved to a box that is not drawn, and a diagram
  // whose subject is missing is one lying about itself. Only the removals that took *it* are dropped;
  // everything else the reader put away stays away.
  erUnhide(id);
  curFocus = id; computeMaxDepth(); egoDepth = Math.max(1, Math.min(maxEgoDepth, egoDepth || 2));
  updateDepthUI(); updateScopeUI();
  if (scopeAll) {
    // remember the new focus for when the scope goes back, but do not re-lay-out the org
    egoStat();
    if (curView === 'er') erRender();
    return;
  }
  bfsEgo(); egoStat(); erLaidOut = false;
  // Changing the focus lays the diagram out again, which is the work `SPIN_NODES` was measured
  // against - and this ran it bare, in both products, so a focus taken on a large graph froze the
  // window with the previous drawing still up. The wrapper decides whether a spinner is warranted;
  // calling it unconditionally is not a cost, because below the ceiling it is one frame.
  if (curView === 'er') erShowMaybeHeavy(); else if (curView === 'rel') relRender();
}
// `nameMode` decides what a node is called - the display label or the internal api_name - and it
// feeds label(), which the list and the boxes both use. Its button lived in the toolbar of the
// Visual view (a canvas force graph, removed - docs/diagrams.md keeps the story) and came out with
// it; it belongs with the other diagram controls, since that is what it changes.
$('nameToggle').onclick = () => {
  nameMode = nameMode === 'display' ? 'internal' : 'display';
  $('nameToggle').textContent = 'Name: ' + nameMode;
  $('nameToggle').classList.toggle('on', nameMode === 'internal');
  render(); if (sel) select(sel, true);
  if (curView === 'er') erResize(); else if (curView === 'rel') relRender();
};

// ---------------- ER diagram (entities + FK arrows) ----------------
let erLaidOut = false, erAll = false, erScale = 1, erTx = 0, erTy = 0;
const erPos = {};
let erIds = [];
let erEmph = 'modules';   // 'relations' = modules demoted to labels, relation names in the foreground
let erMaxX = 0, erMaxY = 0;
// Where the drawing actually starts, which is not the origin. The layout leaves a 40px margin and a
// reader can drag a box anywhere, so framing from 0 counted that margin on one side only - 379px of
// air against 341 - and counted a dragged box's whole excursion as drawing. What needs a corner
// rather than an extent (the printed page, the canvas) clamps this at 0 where it uses it.
let erMinX = 0, erMinY = 0;
// Readability vs. compactness has no single right answer across graphs, so the trade-off is
// exposed as runtime controls instead of being guessed once at build time.
const ER_PRESET = {
  modules:   { margin: 36,  spread: 42, gap: 8,  fs: 10, sub: true },
  // `spread` drives the free branch, and nothing drives the concentric one any more: its radii are
  // derived from the boxes on each ring. This preset's spread had never been exercised, because
  // «edges» used to be reached only with a focus. 72 put 19 boxes on a 3000px canvas: measured 0.25 zoom against 0.39 for the
  // same graph in boxes mode, which is a diagram laid out correctly and drawn too small to read.
  relations: { margin: 120, spread: 38, gap: 10, fs: 13, sub: true },
  // A call box carries a handful of rows where a module box carries dozens, so the same spacing
  // leaves the diagram mostly empty. Less margin and less spread, and the boxes come out closer -
  // and since the concentric radii are derived from `margin`, the rings tighten with it.
  calls:     { margin: 28,  spread: 34, gap: 8,  fs: 10, sub: true },
};
// A stored blob may only put back keys the presets declare. `ring` was a slider once, and a browser
// that had drawn one diagram before this version still has `ring: 420` in `chrome.storage.local` -
// merged in whole, it would sit in `erP` for ever, read by nothing and reported by nothing. This is
// not migration code with a version to grow out of: it is the permanent shape of the merge, so the
// next parameter that goes has nothing left to leave behind.
const erKnownParams = (o) => Object.fromEntries(
  Object.entries(o || {}).filter(([k]) => k in ER_PRESET.modules));
// The boxed mode's preset depends on what is being drawn; `relations` is the same idea either way.
const erBoxPreset = () => (DATA && DATA.kind === 'schema' ? 'modules' : 'calls');
let erP = Object.assign({}, ER_PRESET.modules);
// Selecting one arc is the cheapest fix for a crowded diagram: instead of untangling everything,
// the reader isolates the single relation they care about and the rest recedes.
let erSelEdge = null;   // "a\u0000b"
const ekey = (a, b) => a + '\u0000' + b;
// ---- taking off the drawing what you are not looking at ----
// The filters answer «which kinds am I looking at»; this answers the other half - *that* box, and
// whatever came into the drawing only because of it. An arc joins two boxes and carries a `-` at each
// end: the one where it touches A says «take B away, and what came with it», the one where it touches
// B says the same of A. So there is a control at every point where an arc meets a box, which is the
// reader's own description of what he wanted, and pressing one always removes something.
//
// **The rule it replaces refused most of them, and that is what the reader saw.** «Hide only what
// becomes unreachable any other way» was the first version: on the arc into a box that is referenced
// from somewhere else it removed nothing, said so, and left him with a hub carrying forty arcs and six
// controls. Measured on a star of forty with thirty-four of the neighbours also referenced elsewhere:
// exactly six. True, and no use to somebody clearing the view. What goes now is the box at the far end
// **and** whatever was only in the drawing through it - in a triangle A-B-C with D under B, cutting at
// A takes B and D, and leaves C, which A can still see without B.
//
// It is a filter on the *drawing*, not on the layout. Nothing is laid out again, so it composes with an
// arrangement instead of throwing it away: take away what is in the way, then move what is left, and
// the PDF prints what you see.
let erCut = new Map();     // edge key -> the end that went, in the order the reader took them away
/** What `from` can reach over the drawn set without entering a box in `skip`.
 *
 *  Nodes, not edges. The first version walked around *cut arcs*, which is a different question and the
 *  one that produced the six controls out of forty: an arc with another way round it cut nothing. What
 *  is asked here is what stays attached once a box is gone, and the arc is only how the reader named
 *  the box. */
/** What taking `away` off the drawing costs, seen from `from` - the box the control sits on. `away`
 *  itself, and everything that was in the drawing only through it.
 *
 *  Two walks: what `from` can see now, and what it can see with `away` gone. The difference is the
 *  answer, and taking it as a difference is what keeps it honest in both directions - a box with a
 *  life of its own stays, and a second component nobody asked about is never swallowed, because it
 *  was not in the first walk either. */
/** Everything currently off the drawing, replayed from the removals in the order they were made, each
 *  against what was on screen when it was taken.
 *
 *  Recomputed rather than stored, so a filter change or a different focus cannot leave it describing a
 *  graph that is no longer there. A removal whose own box has since gone is skipped rather than
 *  reinterpreted against a drawing it was never about. */
/** Which boxes come back if this one is undone. Measured against the set that is actually hidden, so
 *  two removals one inside the other cannot both claim the boxes only one of them is holding. */
// The names a control is about to take away or put back, ordered and capped, as its tooltip says
// them. One helper for the mark and for the card: the same click described two ways is the drift this
// repository spends its length on, and here they are ten pixels apart.
//
// The box the control names comes first and the cascade follows it alphabetically, because the first
// line answers «what am I pressing» and the rest answers «what comes with it». Ten of them: a tooltip
// is not a report, and a hundred names is a wall nobody reads - the count in the last line is the part
// that stays true at any size.
const TIP_MAX = 10;
// The same list, drawn rather than spelt. A `title` cannot be styled, so a name in it arrives without
// the one thing that says what it *is* - «le etichette potrebbero stare all'interno di badge con quel
// colore», and the colour is already on the box and on the chip in the header. So this is a panel of
// our own: same order, same cap, same wording, each name in the colour its box wears.
//
// It is positioned against `#v-er` rather than the page, flipped when it would run past an edge, and
// it never takes the pointer - a tooltip that can be hovered is one that can stand between the reader
// and the control it is about. `erTipText` stays: it is the aria-label, which is the only form of this
// a screen reader can be given.
let _tipT = null;
function erTipShow(anchor, set, first, back) {
  const tip = $('ertip'), host = $('v-er');
  if (!tip || !host || !set.size) return;
  const { shown, more } = erTipIds(set, first);
  tip.innerHTML = `<div class="tt1">${back ? 'Putting back' : 'Removing'} <b>${shown.length + more}</b> `
    + `${shown.length + more === 1 ? 'box' : 'boxes'}</div><div class="ttl"></div>`
    + (more ? `<div class="ttm">and ${more} more</div>` : '');
  const list = tip.querySelector('.ttl');
  shown.forEach((id) => {
    const b = document.createElement('div');
    b.className = 'tb';
    b.textContent = N[id] ? label(N[id]) : id;
    if (N[id]) erPaint(b, N[id]);
    list.appendChild(b);
  });
  tip.classList.add('on');
  const h = host.getBoundingClientRect(), r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth, ht = tip.offsetHeight;
  let x = r.right - h.left + 10, y = r.top - h.top + 10;
  if (x + w > h.width - 8) x = r.left - h.left - w - 10;
  if (y + ht > h.height - 8) y = h.height - ht - 8;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}
function erTipHide() { clearTimeout(_tipT); const tip = $('ertip'); if (tip) tip.classList.remove('on'); }
/** Put `id` back on the drawing, by dropping the removals that took it - the one that did, then any
 *  later one that does it again, and no others.
 *
 *  The Explorer beside the diagram still lists what has been taken off it, deliberately, so the focus
 *  can be moved to a box that is not drawn. A diagram whose subject is missing is a diagram lying about
 *  itself, and the reader asking to look at something is the clearest statement there is that he wants
 *  it back. Everything he took away that has nothing to do with it stays away. */
/** Take a box off the drawing, or put back what one removal took. `away` is the end that goes and
 *  `a`/`b` name the arc it was asked from, which is where the `+` will sit.
 *
 *  The hint reports what actually moved rather than what was promised: the promise is written on the
 *  control the reader just pressed, and a difference between the two is a defect he is entitled to see. */
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
  // The same two removals the circles on the arc offer, from the same computation and in the same
  // words: the card is where the reader arrives having clicked the arc to read what it *is*, and
  // having to go back out to the drawing to act on it would be the control living away from its
  // subject again. Both ends, because the arc has two and neither is the obvious one - the count is
  // worked out before the click, so each says what it will take away rather than being found out.
  const cutK = ekey(a, b), isCut = erCut.has(cutK);
  const gone = erHiddenSet();
  $('erpickbody').insertAdjacentHTML('beforeend', '<div class="pkcut">' + (isCut
    ? `<button type="button" id="erpickcut">${esc(MSG.cutUndo(erWouldShow(cutK)))}</button>`
    : `<button type="button" id="erpickcut">${esc(MSG.cutDo(label(N[b]), erWouldGo(a, b, gone).size))}</button>`
      + `<button type="button" id="erpickcut2">${esc(MSG.cutDo(label(N[a]), erWouldGo(b, a, gone).size))}</button>`) + '</div>');
  card.classList.add('on');
  const cb = $('erpickcut');
  // The same panel the mark on the arc opens, from the same helper: two descriptions of one click, ten
  // pixels apart, is exactly the drift a shared helper exists to stop.
  const wire = (btn, get) => {
    if (!btn) return;
    btn.setAttribute('aria-label', erTipText(get().set, get().first, get().back));
    btn.onmouseenter = () => erTipOn(btn, get);
    btn.onmouseleave = () => { erFlag(null); erTipHide(); };
  };
  if (cb) {
    cb.onclick = () => erToggleCut(a, b, isCut ? erCut.get(cutK) : b);
    wire(cb, isCut ? () => ({ set: erWouldShowSet(cutK), first: erCut.get(cutK), back: true })
                   : () => ({ set: erWouldGo(a, b, erHiddenSet()), first: b, back: false }));
  }
  const cb2 = $('erpickcut2');
  if (cb2) {
    cb2.onclick = () => erToggleCut(a, b, a);
    wire(cb2, () => ({ set: erWouldGo(b, a, erHiddenSet()), first: a, back: false }));
  }
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
// The candidate set: what would be drawn if nothing else were dropped. The **ego set belongs in
// here**, and leaving it out is what let orphans back in: the cascade counted an edge to a node the
// focus neighbourhood excludes, so a node was kept for a partner that was never going to be drawn.
// Reported - focus a standalone function, switch the standalone chip off, and five boxes stayed with
// nothing attached, each of them held in by an edge to a connection outside the neighbourhood.
const erCandidate = (id) => !!(N[id] && passKind(N[id]) && (!egoSet || egoSet.has(id)));
// One pass is still the whole cascade: dropping nodes with no edge inside the candidate set cannot
// remove an edge between two nodes that have one.
function erVisibleIds() {
  // A table or module with no field to show has nothing to draw and stays out - the behaviour that
  // was already here, and a different question from having no link left.
  // **The thing you asked to look at is always drawn.** The field filter decides what is *listed
  // inside* a box, and it was deciding whether the box exists at all: a query table with no lookup
  // and no column called Name, Owner or id left nothing to list, so it was dropped - and focusing on
  // it from the Explorer, which does list it, produced an empty sheet with no explanation. Measured
  // on a real workspace of 377 views: 86 of the 135 entities with columns were outside the diagram
  // for that reason. The `relations` branch below has always kept the focus for exactly this reason;
  // this one had not, which is the same guard present on one path and missing on its twin.
  // And what the reader folded away is not visible: the tab badge counts what is on the drawing, and
  // it counted folded boxes. `erFit` and the print handler already skip them; this is the third and
  // fourth reader of the same state. See the note in `erCovers`.
  const gone = erHiddenSet();
  if (DATA.kind === 'schema' && erEmph !== 'relations') {
    return nodesA.filter((id) => erCandidate(id) && !gone.has(id) && (erFieldsFor(N[id]).length > 0 || id === curFocus));
  }
  const linked = linkedUnderFilter();
  return nodesA.filter((id) => erCandidate(id) && !gone.has(id) && (linked.has(id) || id === curFocus));
}
// What the chips leave standing but the diagram will not draw, because nothing links it any more.
// A number the reader has to be given: the Explorer beside it lists those items, and two panes
// disagreeing about how many there are with no explanation is the state this window keeps ending in.
function orphanedByFilter() {
  if (DATA.kind === 'schema' && erEmph !== 'relations') return 0;
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
// Pull overlapping boxes apart. A box drawn over another hides its content, and a diagram that hides
// part of itself is worse than a smaller one - so this is a correctness pass, not a tidying one.
//
// It used to compare every pair against every other, which is O(n\u00b2) per pass, and the budget was
// therefore cut from 140 passes to 60 above 150 nodes: fewer passes exactly where there are more
// boxes to separate. Measured on generated graphs of the size a real org reaches, that left **230
// overlapping pairs at 200 nodes and 1852 at 500** - the worst by 116px, on boxes 82px tall - and
// nothing on screen said so.
//
// Two changes, both chosen by measuring rather than by reasoning about them:
//
//   A uniform grid, rebuilt each pass, so only boxes that could touch are compared. A cell is the
//   widest box plus the margin, so an overlapping pair is always in the same cell or one of the eight
//   around it - which makes a pass cost about n instead of n², and a generous uniform budget
//   cheaper than the old 60 passes were.
//
//   The run keeps its **best** pass rather than its last. The push oscillates: a pair that keeps
//   trading places can leave pass 240 worse than pass 90, so any fixed budget is a bet on where the
//   run happens to stop. Fewest overlaps wins, and among equals the smaller drawing.
//
// What it costs is stated rather than left to be found: in the middle of the range the drawing ends up
// one or two points wider, so the fit comes out a little smaller. That trade is deliberate - a box
// drawn over another loses information, where a smaller drawing only makes it smaller, and the zoom is
// a control the reader already has.
//
// What it does *not* do is converge. Relaxation cannot clear the overlaps at org scale: the cause is
// global - a canvas too small in a dense region - and pushing harder only moves the problem. Growing
// the canvas until nothing overlapped was measured too, and it reaches zero at every size by dropping
// the fit to 2%, which trades a readable diagram for an unreadable one. The ceiling is arithmetic and
// is written down in docs/diagrams.md: 200 boxes need 4.2 times the panel's area.
//
// `pinned` is the set of ids that may not be moved - the boxes the reader placed. Without it the
// comment in erLayout ("newcomers make room around an arrangement rather than the arrangement being
// computed away") described an intention the code did not have: held positions were written back
// and then this pass ran over everything, with nothing distinguishing a box somebody dragged there
// from one the layout guessed. Omit the argument and the behaviour is exactly what it was, which is
// what keeps the rendered diagrams identical where no arrangement exists.
//
// Two rules follow from "may not be moved", and the second is the one worth stating: when only one
// of a pair is pinned the other takes the **whole** push, so a pair separates in the same number of
// passes as before rather than half as fast; and when both are pinned the overlap is left alone. It
// is counted, so the pass still knows it is there, but it is not resolved - the reader put those two
// boxes where they are and is already told when one covers another. Tidying that away would be this
// pass overruling a placement, which is the thing the pinning exists to stop.
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
      settle(erIds, edgesAmong(erIds));
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
    const ext = (k) => { const v = erIds.map((id) => (k === 'x' ? posX[id] : posY[id]) || 0); return Math.max(1, Math.max(...v) - Math.min(...v)); };
    const target = Math.sqrt(Math.max(1, area)) * (erP.spread / 10);
    // And it is given the *panel's* proportions, not a square's. The panel is about two and a half
    // times wider than it is tall, so a square drawing wastes the width and the fit is decided by the
    // height every time - and the collision pass makes that worse, because it separates a pair along
    // the axis needing the smaller move, which for boxes 190 wide and ~82 tall is the vertical one.
    // Every overlapping pair was therefore pushed downwards and a round blob came out as a column:
    // measured at 60 nodes, 1972 x 4676. Shaping the target to the panel is the same total area in
    // the shape that fits, and it is measured on five generated graphs at each size from 20 to 150
    // nodes: the fit improves at every one of them - 28% to 37% at 20 nodes, 11% to 15% at 60 - and
    // the layout places every box clear of every other in 5 runs out of 5 up to 80 nodes, where a
    // square canvas managed 3 out of 5.
    //
    // It distorts: stretching one axis more than the other lengthens the edges that run that way, and
    // the force layout's distances are what carry the structure. Kept because the measurements say the
    // result is better on both counts that matter here, not because the distortion is harmless.
    //
    // With no panel to shape to - it measures 0 while the view is hidden - the neutral shape is the
    // one that favours neither axis. That is a choice about shape with nothing to match, not a
    // measurement invented for one: `erFit` refuses to guess a *size*, and still does.
    const pw = $('v-er').clientWidth - 80, ph = $('v-er').clientHeight - 80;
    const aspect = (pw > 0 && ph > 0) ? pw / ph : 1;
    const kx = target * Math.sqrt(aspect) / ext('x'), ky = target / Math.sqrt(aspect) / ext('y');
    erIds.forEach((id) => { const s = sizes[id]; erPos[id] = { x: (posX[id] || 0) * kx, y: (posY[id] || 0) * ky, w: s.w, h: s.h }; });
  }
  // Anything the reader placed goes back where they placed it, before the collision pass runs - so
  // newcomers make room around an arrangement rather than the arrangement being computed away. A box
  // that has left the screen keeps its entry, so switching a category off and on again finds it again.
  erFitToArcs(edgesAmong(erIds));
  erLastKept = 0;
  const erPinned = new Set();
  if (erArranged) {
    erIds.forEach((id) => {
      const h = erHeld[id];
      if (h && erPos[id]) { erPos[id].x = h.x; erPos[id].y = h.y; erLastKept++; erPinned.add(id); }
    });
  }
  collideBoxes(erIds, erP.margin, erPinnedNow(erPinned));   // labels live between the boxes, they need the room
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
// Which side of A the arc to B leaves from. Split out because the slot pass below has to make the
// same decision before anything is drawn.
/** Where each arc meets each box, as a share of the side it arrives on.
 *
 * Every arc used to meet the *middle* of its side, so seven arriving from above arrived at one point:
 * you could not tell them apart by looking, which is the complaint this window opened with, and you
 * could not click the one you meant either. Each side now shares its width between the arcs that use
 * it. They are ordered by where the other end lies, so the order along the edge matches the order on
 * screen and the fan does not cross itself. One arc on a side still gets the middle, so nothing that
 * was already unambiguous moves.
 */
// A box grows until its arcs have room to land apart. Reported with a picture: the fan works above and
// below, where the box is wide, and fails on the sides, where a relation-first box is only as tall as
// its own title - twenty arcs sharing forty pixels are one thick line again.
//
// The reader's argument for it is the better one, and it is why this grows the box rather than pushing
// the arcs around: a box that is referenced from twenty places *is* more important than one referenced
// once, so drawing it larger says something true. The arcs distributing better is then a consequence.
//
// One pass, not a fixed point. Growing a box moves its neighbours, which can change which side an arc
// arrives on, which would change the counts - chasing that to convergence would cost more than it is
// worth and could oscillate. The counts are taken once, from the positions as laid out, and the
// collision pass then makes room for whatever grew.
const ARC_GAP = 16;        // pixels between two landing points, a shade above the 14px hit corridor
function erApply() {
  $('ervp').style.transform = `translate(${erTx}px,${erTy}px) scale(${erScale})`;
  erSizeArrows();
  erSizeMarks();
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
//
// It also has to stand off the box by the width of the circle that now sits there. The fold control is
// centred on the point where the arc meets the box - which is where the arc ends - so the head was
// drawn underneath it and reported as barely visible. The head is the only part of an arc that says
// which way the relation points, so that is the diagram losing a fact.
//
// Moved by `refX` rather than by shortening every path, and the difference is not tidiness. Both the
// circle and the head keep a constant size *on screen*, so in the drawing's own units both change
// with the zoom - while a path is geometry, fixed when it is drawn. Shortened paths therefore came
// apart from the circles the moment the reader zoomed: reported, with a picture, as arrows floating
// a few pixels off. `refX` is read from the marker at paint time and this runs on every erApply, so
// the head follows the zoom exactly as the circle does, and the arc still runs to the box edge -
// under the circle, where nobody can see it.
//
// The setback uses MARK_MIN, the *smallest* a circle gets: one marker serves every arc, the circles
// vary by a pixel and a half either way, and the error worth having is a head tucked a hair under a
// wide circle rather than one floating off a narrow one.
const ARROW = { erarrow: [9, 8, 7], erarrowsel: [12, 9, 8] };
function erSizeArrows() {
  const k = 1 / Math.max(erScale, 0.02);
  const back = erPrintFull ? 0 : (MARK_MIN / 2) * Math.min(MARK_MAX, k);
  for (const [id, [w, h, vb]] of Object.entries(ARROW)) {
    const m = document.getElementById(id); if (!m) continue;
    m.setAttribute('markerWidth', (w * k).toFixed(2));
    m.setAttribute('markerHeight', (h * k).toFixed(2));
    // refX is in viewBox units and the viewBox maps onto markerWidth, so a step of one user unit is
    // vb / (w * k) of them. At refX = vb the tip sits on the path's end, which is the box edge.
    m.setAttribute('refX', (vb * (1 + back / (w * k))).toFixed(3));
  }
}
// A control has to stay the size of the pointer that presses it, which is the argument the arrowheads
// already won: drawn in the diagram's coordinates, they measured 3.3px across on a whole-org view and
// were reported as missing. So the marks are counter-scaled against the zoom - and *capped*, because a
// circle that keeps growing as the reader zooms out ends up wider than the box it hangs off and hides
// the thing it is about. Below 0.56 it stops growing in the drawing and starts shrinking on screen:
// 20px at any zoom the diagram is read at, 6px on a whole org nobody is clicking arcs in.
const MARK_MAX = 1.8;
const MARK_D = 16;         // and never wider than the gap between two landing points; see markAt
// ...but never smaller than this, whatever the gap says. Reported with a picture: the first version
// floored at 11 and left the `-` on a crowded rim beside a `+` at the full 20, which reads as two
// different controls rather than as one that is squeezed. The gap is a *starting* number and not a
// guarantee - `erFitToArcs` grows a box for the arcs its sides carried **as laid out**, and the
// collision pass then moves boxes, which can move an arc onto a side that was never sized for it. So
// a floor, and where the rim is genuinely tighter than this the marks touch: two circles overlapping
// by a pixel is a smaller failure than a control nobody can hit, and hovering one raises it.
const MARK_MIN = 13;
let erPrintFull = false;   // the print asks for arcs that reach the boxes; see beforeprint
function erSizeMarks() {
  const m = document.getElementById('ermarks');
  if (m) m.style.setProperty('--mkz', Math.min(MARK_MAX, 1 / Math.max(erScale, 0.02)).toFixed(3));
}
// How wide one mark comes out, from the room its side has. It is asked in two places now that the
// arcs stand off it - markAt draws the circle and erSizeArrows sets the head back by MARK_MIN.
// The colour a node wears on the diagram - the header of its box, and now the badge the tooltip puts
// its name in. One helper and not two answers: «which colour is this node» written twice is two
// answers waiting to disagree, and the second one would be in a tooltip nobody diffs against a box.
// Analytics only ever draws a schema, so the first branch is the whole of it there.
// The colour a node wears, as a value rather than as a class. The fold marks paint themselves with
// the colour of the box at the *other* end of their arc, and that box is very often not on the
// drawing at all - which is exactly when knowing its colour is worth something. Read out of the
// stylesheet the first time it is asked, so --box-std and --box-cus stay declared in one place.
// Black or white on that colour, whichever can be read on it - sRGB relative luminance, the same
// arithmetic every contrast tool uses. A `-` in the diagram's violet was legible on white and is not
// legible on half the hues a box can wear, and the mark is 16px across: there is no room for a
// second look.
function erPaint(el, n) {
  el.classList.add('hued');
  el.style.setProperty('--kind', NSCOL(KINDOF(n)));
}
let erFlag = () => {};   // set by erRender, which is what knows the boxes
function erRender() {
  // Taken off the drawing by the reader, which is a filter on the drawing and not on the layout: the
  // positions are untouched, so what is left stays exactly where he put it.
  const gone = erHiddenSet();
  const shown = new Set(erIds.filter((id) => !gone.has(id)));
  const drawnPairs = edgesA.filter(([a, b]) => shown.has(a) && shown.has(b));
  // The arc a removal was asked from still meets the box that stayed, and that meeting point is where
  // its `+` sits, so it takes a slot on that side like any other arc. Without it the arcs left standing
  // would redistribute along the side the moment something is taken away: every one of them moving
  // under a click that was about one.
  const folds = [];
  erCut.forEach((away, k) => {
    const [a, b] = k.split('\u0000');
    const stay = away === a ? b : a;
    if (!erPos[a] || !erPos[b] || !shown.has(stay) || shown.has(away)) return;
    folds.push([a, b, away, stay]);
  });
  const boxes = $('erboxes'); boxes.innerHTML = '';
  const boxEl = new Map();          // so a control can outline what it is about to take away
  // Both ends of the drawing, not just the far one. Everything here used to be measured from the
  // origin outwards on the assumption that the layout puts the drawing there - which it does, until
  // the reader drags a box left of it. Then the frame, the page and the canvas were all sized for a
  // rectangle that started at 0 while the drawing started somewhere else. Reported as Fit resizing
  // and not centring.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  erIds.forEach((id) => {
    if (gone.has(id)) return;
    const n = N[id], p = erPos[id], s = erBoxSize(n);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
    const div = document.createElement('div');
    const pickIds = erSelEdge ? erSelEdge.split('\u0000') : null;
    const inPick = pickIds ? pickIds.includes(id) : null;
    div.className = 'erbox' + (erEmph === 'relations' ? ' dim' : '')
      + (inPick === false ? ' faded' : '') + (inPick === true ? ' epick' : '')
      + (id === sel ? ' sel' : '') + (id === curFocus ? ' focus' : '');
    div.style.cssText = `left:${p.x}px;top:${p.y}px;width:${p.w}px;min-height:${p.h}px`;
    erPaint(div, n);        // after cssText, which would wipe the inline --kind it sets
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
    // reader to hold a key in their head - reported as «the colours help but are not enough».
    // Category first: it is the dimension everything else in this window is coloured and filtered by.
    const sub = DATA.kind === 'schema' ? (n.api_name || '')
      : [KINDOF(n), n.namespace].filter(Boolean).join(' \u00b7 ');
    div.innerHTML = `<div class="erhdr"><span>${esc(label(n))}</span><small>${esc(sub)}</small></div>${rows}${more}`;
    div.onclick = () => { if (erDragged) return; const wasFocus = curFocus; select(id); if (!wasFocus) erRender(); };
    // The id on the element, because dragging starts from a mousedown on the box and the handler has
    // the element, not the loop. Without it the drag reads undefined and never begins - which is how
    // it was written the first time.
    div.dataset.id = id;
    // Moved boxes keep the order they were moved in, so the last one placed is the one on top.
    const z = erRaised.get(id);
    if (z) div.style.zIndex = String(10 + z);
    boxes.appendChild(div);
    boxEl.set(id, div);
  });
  // What the control under the pointer would take, outlined on the boxes that are on screen. Rebuilt
  // with the boxes, so it cannot outlive the render that drew them.
  let flagged = [];
  erFlag = (set) => {
    flagged.forEach((el) => el.classList.remove('willgo'));
    flagged = [];
    if (!set) return;
    set.forEach((id) => { const el = boxEl.get(id); if (el) { el.classList.add('willgo'); flagged.push(el); } });
  };
  const svg = $('ersvg');
  // `.erhit` was not in this list, and it is the one nobody can see: an invisible 14px-wide copy of
  // every arc, left behind by every render since the window opened. Measured on the sample schema
  // after five renders - six arcs on screen, **thirty** hit corridors under them, each still carrying
  // the click handler and the geometry of the layout it was drawn for. So clicking beside an arc could
  // select a relation that had moved, and the count grew for as long as the window stayed open. Found
  // by counting elements while checking something else, which is the argument for counting.
  [...svg.querySelectorAll('.erlink,.erhit,.erlabel,.erlead')].forEach((x) => x.remove());
  $('v-er').classList.toggle('relemph', erEmph === 'relations');

  // --- pass 1: draw the links, collect the label descriptors ---
  const labels = [];
  const REL = erEmph === 'relations';
  const erSlotMap = erComputeSlots(drawnPairs.concat(folds.map(([a, b]) => [a, b])));
  edgesA.forEach(([a, b]) => {
    if (!shown.has(a) || !shown.has(b)) return;
    const A = erPos[a], B = erPos[b];
    const ek = ekey(a, b);
    const [x1, y1, x2, y2, axis] = erEdgePoints(A, B,
      erSlotMap.get(ek + '\u0001' + a), erSlotMap.get(ek + '\u0001' + b));
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

  // --- the marks: one where every arc meets every box ---
  // An arc joins two boxes, so it carries a control at each end: the `-` where it touches A takes B
  // away and whatever came into the drawing with it, the one where it touches B says the same of A.
  // Standing on a box, every arc that reaches it offers to take that neighbour off - which is why the
  // marks cluster on the rim of the box you are reading, where the pointer already is.
  //
  // A `+` where a removal was made brings it back. No number on it: two arcs never meet a box at the
  // same point, so one `+` is one removal, and the count is in the tooltip and in the line below the
  // drawing at the moment it happens.
  //
  // Drawn above the boxes rather than in the arc layer: the meeting point *is* the box's edge, and a
  // control the box paints over half of is not a control.
  //
  // The size comes from the arcs themselves. `erFitToArcs` grows a box until its landing points are
  // ARC_GAP apart, so a mark that is at most that wide can never cover its neighbour - measured on the
  // reported case, a box with thirteen arcs on one side where a fixed 20px circle overlapped the next.
  // The `+` keeps the full size: there are a handful of them and they are the ones saying something is
  // missing, where the `-` are one per arc and must not become the drawing.
  const marks = $('ermarks'); marks.innerHTML = '';
  const markAt = (a, b, away, stay, folded) => {
    const A = erPos[a], B = erPos[b];
    if (!A || !B) return;
    const ek = ekey(a, b);
    const sa = erSlotMap.get(ek + '\u0001' + a), sb = erSlotMap.get(ek + '\u0001' + b);
    const pt = erEdgePoints(A, B, sa, sb);
    const S = stay === a ? A : B, slot = stay === a ? sa : sb;
    const el = document.createElement('button');
    el.type = 'button';
    // The arc runs a -> b, so the mark standing on `a` is where it leaves and the one on `b` is where
    // it arrives. Both are drawn for every arc, which is what makes the pair readable at a glance.
    el.className = 'ermk ' + (folded ? 'back' : 'fold') + (stay === a ? ' out' : ' in');
    const fill = erNodeCol(N[away]);
    el.style.setProperty('--mkfill', fill);
    el.style.setProperty('--mkink', erInk(fill));
    el.style.left = (stay === a ? pt[0] : pt[2]) + 'px';
    el.style.top = (stay === a ? pt[1] : pt[3]) + 'px';
    el.style.setProperty('--d', erMarkD(S, stay === a ? B : A, slot).toFixed(1) + 'px');
    el.textContent = folded ? '+' : '\u2212';
    // Worked out when it is asked for, not for every arc on every render: the walks behind it are
    // cheap once and 2N times is the render. A tooltip nobody has hovered has told nobody anything.
    //
    // It says the names, not a number. Reaching one of these usually means being zoomed in on a
    // crowded rim, where most of what a cascade would take is off screen - so it cannot be looked at,
    // only read. What *is* on screen is outlined at the same moment, which the list cannot do and the
    // outline cannot do for the rest: two halves of the same answer.
    const asked = () => ({ set: folded ? erWouldShowSet(ek) : erWouldGo(stay, away, erHiddenSet()), first: away, back: folded });
    el.setAttribute('aria-label', folded ? MSG.cutUndo(erWouldShow(ek)) : MSG.cutDo(label(N[away]), 1));
    el.addEventListener('mouseenter', () => {
      const { set, first, back } = asked();
      el.setAttribute('aria-label', erTipText(set, first, back));
      erTipOn(el, asked);
    });
    el.addEventListener('mouseleave', () => { erFlag(null); erTipHide(); });
    // The same guard the arcs and the boxes use: a drag that ends over a control is still a drag.
    el.addEventListener('click', (ev) => { ev.stopPropagation(); if (erDragged) return; erToggleCut(a, b, away); });
    marks.appendChild(el);
  };
  drawnPairs.forEach(([a, b]) => { markAt(a, b, b, a, false); markAt(a, b, a, b, false); });
  folds.forEach(([a, b, away, stay]) => markAt(a, b, away, stay, true));

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
      minX = Math.min(minX, x); minY = Math.min(minY, y);
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
  erMaxX = Number.isFinite(maxX) ? maxX : 0;
  erMaxY = Number.isFinite(maxY) ? maxY : 0;
  erMinX = Number.isFinite(minX) ? minX : 0;
  erMinY = Number.isFinite(minY) ? minY : 0;
  // The canvas is a rectangle from the origin, whatever the drawing does - it cannot have negative
  // width - so this is the one place that still clamps. What the drawing *is* stays in erMin/erMax,
  // because that is what has to be framed and printed.
  svg.setAttribute('width', Math.max(0, erMaxX) + 60); svg.setAttribute('height', Math.max(0, erMaxY) + 60);
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
  // A folded box keeps its position - that is what lets a fold compose with an arrangement - so this
  // walk has to skip what is not drawn or the frame is sized for boxes nobody can see: fold a branch
  // at the far edge and Fit would zoom out to include it. `erMaxX` is already measured over what was
  // drawn; this is the boxes themselves, in case the last render did not reach them.
  const goneNow = erHiddenSet();
  let minX = erMinX, minY = erMinY, maxX = erMaxX, maxY = erMaxY;
  erIds.forEach((id) => {
    const p = erPos[id]; if (!p || goneNow.has(id)) return;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
  });
  const pad = 40;
  // The drawing's own width, not its distance from the origin. Those are the same number only while
  // every box sits right of and below 0, which is true of a diagram nobody has arranged and false the
  // moment one is: a box dragged 600px to the left left the fit framing 600px of empty canvas and
  // pushed the drawing against the edge - 17px of margin on one side against 341 on the other,
  // measured. The offset then has to undo the corner as well as centre the width.
  const w = maxX - minX, h = maxY - minY;
  erScale = Math.max(0.02, Math.min(1.4, Math.min((vw - pad * 2) / (w || 1), (vh - pad * 2) / (h || 1))));
  erTx = (vw - w * erScale) / 2 - minX * erScale;
  erTy = (vh - h * erScale) / 2 - minY * erScale;
  erApply();
  erUserMoved = false;
}
// How many boxes the diagram would draw right now, on the tab that draws them. `erCandidate` already
// accounts for the chips, the focus and the depth, so this is the number and not an approximation of
// it - and it is shown before the drawing is asked for, so a reader can see a filter bring the graph
// within reach instead of clicking and finding out.
function erCountRefresh() {
  const tab = $('ertab');
  if (!tab || tab.style.display === 'none') return;
  const n = erVisibleIds().length;
  const badge = $('ertabn');
  if (badge) badge.textContent = n ? String(n) : '';
  const over = !drawable(n), tight = crowded(n);
  tab.classList.toggle('over', over || tight);
  tab.title = over ? MSG.tabOver(n) : tight ? MSG.tabCrowded(n) : MSG.tabCount(n);
}
// Nothing is drawn, said where the reader is standing. The tab stays enabled and this is why: above
// the limit a click lands here and explains itself, where a disabled tab would be a dead control that
// teaches nothing. That is a stated departure from `updateProjectableTabs`, which *disables* a tab
// when the selection cannot be projected - there nothing the reader does will help, here switching a
// category off or picking a focus will.
//
// The filter stays live while the diagram is open, which is the whole point of it, so this state is
// reached by raising a filter as well as by clicking the tab. The drawing is taken down when it
// happens: leaving the previous one up under a filter that no longer describes it is the stale
// projection this window already refuses elsewhere - both panes looking right on their own and
// disagreeing with each other.
function erNotDrawn(n) {
  const box = $('ernone');
  if (box) { box.querySelector('p').innerHTML = MSG.tooMany(n); box.classList.add('on'); }
  $('ervp').classList.add('off');
  $('ertools').classList.add('off');
  const h = document.querySelector('#v-er .hint2');
  if (h) h.classList.add('off');
}
function erDrawn() {
  const box = $('ernone');
  if (box) box.classList.remove('on');
  $('ervp').classList.remove('off');
  $('ertools').classList.remove('off');
  const h = document.querySelector('#v-er .hint2');
  if (h) h.classList.remove('off');
}
// A label change is not a layout change. `Name:` and `Fields:` alter what is written in a box - and
// therefore how wide and how tall it is - but not which boxes there are or how they relate, so laying
// the diagram out again throws away an arrangement for nothing. Reported: after moving boxes, switching
// `Name:` redrew everything, because every box's width changed and the layout followed.
//
// The boxes are re-measured in place instead, and the collision pass tidies whatever the new size made
// overlap. Nothing is placed again, so a hand-arranged diagram survives a relabelling intact.
function erShow() {
  const drawing = erVisibleIds().length;
  if (!drawable(drawing)) { erNotDrawn(drawing); erCountRefresh(); return; }
  erDrawn();
  // A scope widened from Relations, where it is free, may be more than the diagram can lay out.
  // Say so and go back to the focus rather than drawing a ring of boxes nobody can read - the
  // fallback is stated, never silent.
  if (scopeAll && curFocus && !drawable(visibleKindCount())) {
    scopeAll = false; bfsEgo(); updateScopeUI(); erLaidOut = false;
    tooWideToDraw(visibleKindCount());
  }
  if (!erLaidOut) { erLayout(); erLaidOut = true; }
  erRender(); erFit(); erUpdateControlVis();
  const h = document.querySelector('#v-er .hint2');
  if (h) h.textContent = `scroll or double-click to zoom \u00b7 drag to pan or to arrange \u00b7 click a ${NOUN().box} to inspect`;
  // Said rather than warned about: a filter change keeps what was arranged and places the rest, so
  // the line reports what happened instead of asking permission for it.
  if (erLastKept) erHint(MSG.kept(erLastKept, erIds.length - erLastKept));
}
// ---- arranging by hand ----
// A box can be dragged. The auto layout is a starting point, not a verdict: past eighty boxes it
// crowds whatever it does, and the reader is the one who knows which two boxes need to be side by
// side for the PDF. `Save PDF` already sizes the page from `erPos`, so an arrangement exports as
// arranged with nothing added here.
//
// The arcs are hidden for the duration of the drag and drawn again on the drop. That is not a
// shortcut, it is the measured one: their paths are derived from the positions, so following a box
// live means recomputing every path that touches it on every mousemove, and there are 16ms in a frame.
// Hidden and then correct beats present and stuttering.
//
// Nothing else moves on the drop, and this is a deliberate departure from what was agreed: making the
// neighbours give way would fight the reader, who has just said where they want that box. The reason
// for wanting it - never hiding content unknowingly - is served by *saying* what the drop covers
// instead, which is this project's position on numbers anyway. `Re-layout` is the way back.
let erArranged = false;    // the reader has moved at least one box
let erLastKept = 0;        // how many the last layout handed back, so the hint can say so
// Where they put them. A filter change lays the diagram out again - eight controls do - and refusing
// each of them was tried and was worse: the refusal fired *after* the control had toggled its own
// state, so a chip went grey while its category stayed on screen, which is a control lying about
// itself, and fixing that properly would have meant intercepting all eight. Keeping the positions
// means nothing has to be refused. What is still on screen stays where it was put, what is new is
// placed by the layout, and `Re-layout` is the way to start over. Reported: "il chip ha cambiato di
// stato pur non applicando il filtro".
let erHeld = {};           // id -> { x, y }, as the reader left it

// ---- an arrangement, written down ------------------------------------------------------------
//
// Twenty minutes of deciding which two boxes have to sit side by side is work, and until now it died
// with the window. `Save PDF` kept the picture; nothing kept the *arrangement*, so it could not be
// picked up again, handed to somebody else, or kept beside the mirror it describes.
//
// Three pure functions, so the part with rules in it can be tested without a browser, and written
// word for word in both products - which the twin ledger then holds without anyone maintaining a
// list. Everything that touches the DOM stays outside them.
//
// What the file does *not* carry is as deliberate as what it does. No zoom or pan: that is where you
// were looking, not what you built. No undo history: replaying a story is fragile where replaying its
// effects is not. No box sizes: a size comes from the content and the label mode, so a stored one is
// a lie waiting for a rename. No display names anywhere - ids and numbers only, so a file that
// arrives from somebody else cannot put text on the screen. And no list of what is hidden: hiding is
// what folding a branch *does*, so the folds already say it, and a file carrying both would have two
// sources for one fact - which is the pair that disagrees eventually.
const ARR_V = 1;

// A box the reader moved rises above the rest and stays there. Without it, dropping one onto a cluster
// can put it *under* boxes it was moved to sit beside - and the reader has just said which one matters.
// The order is kept rather than a single flag, so the last thing moved is the thing on top. Reported.
let erRaised = new Map();  // id -> the order it was moved in
let erRaiseN = 0;
let erBoxDrag = null;      // { id, sx, sy, x0, y0 }
// The line the diagram talks in. `warn` is for the states a reader has to notice rather than read:
// a load that refused, or one that came back with something missing. It was 11px of grey at the far
// corner from the button that had just been pressed, and a whole workspace mismatch went unseen in it.
function erHint(text, warn) {
  const h = document.querySelector('#v-er .hint2');
  if (!h) return;
  h.textContent = text;
  h.classList.toggle('warn', !!warn);
}
let erDown = false, erDragged = false, erSx = 0, erSy = 0, erT0x = 0, erT0y = 0;
document.addEventListener('mousedown', (e) => {
  if (curView !== 'er' || e.target.closest('#ertools') || e.target.closest('#ermarks')) return;
  const box = erBoxUnder(e.target);
  if (box && box.dataset.id && erPos[box.dataset.id]) {
    // Arranging, not panning. The arcs go for the duration; see erCovers above for why.
    const p = erPos[box.dataset.id];
    erBoxDrag = { id: box.dataset.id, sx: e.clientX, sy: e.clientY, x0: p.x, y0: p.y, el: box };
    erDragged = false;
    $('ersvg').classList.add('dragging');
    $('ermarks').classList.add('dragging');
    box.classList.add('dragging');
    e.preventDefault();
    return;
  }
  // Panning, and only from the drawing itself. The browser begins a text selection on any mousedown
  // it is allowed to keep, so a pan left every label it crossed highlighted until the next click -
  // reported. The box branch above never showed it because it calls preventDefault; this one did not.
  //
  // What may pan is listed rather than what may not. The layout sliders, the picker and the hint line
  // all sit inside #v-er, so a blacklist would have to name each of them - and a list of exclusions is
  // exactly the shape this project has already watched drift between the two apps. The canvas is
  // #ervp, plus the empty ground of the view itself when the drawing is smaller than the window.
  if (e.target !== $('v-er') && !e.target.closest('#ervp')) return;
  e.preventDefault();
  // preventDefault also keeps the focus where it was, which the default mousedown would have moved:
  // clicking the drawing has always taken the caret out of the search field, and still does.
  const act = document.activeElement;
  if (act && act !== document.body && typeof act.blur === 'function') act.blur();
  erDown = true; erDragged = false; erSx = e.clientX; erSy = e.clientY; erT0x = erTx; erT0y = erTy;
});
document.addEventListener('mousemove', (e) => {
  if (erBoxDrag) {
    // The viewport carries a scale, so a screen delta is not a diagram delta.
    const dx = (e.clientX - erBoxDrag.sx) / (erScale || 1), dy = (e.clientY - erBoxDrag.sy) / (erScale || 1);
    if (Math.abs(e.clientX - erBoxDrag.sx) + Math.abs(e.clientY - erBoxDrag.sy) > 4) erDragged = true;
    const p = erPos[erBoxDrag.id];
    if (p) { p.x = erBoxDrag.x0 + dx; p.y = erBoxDrag.y0 + dy; }
    if (erBoxDrag.el) { erBoxDrag.el.style.left = (erBoxDrag.x0 + dx) + 'px'; erBoxDrag.el.style.top = (erBoxDrag.y0 + dy) + 'px'; }
    return;
  }
  if (!erDown) return; const dx = e.clientX - erSx, dy = e.clientY - erSy;
  if (Math.abs(dx) + Math.abs(dy) > 4) { erDragged = true; erUserMoved = true; }
  erTx = erT0x + dx; erTy = erT0y + dy; erApply();
});
document.addEventListener('mouseup', () => {
  if (erBoxDrag) {
    const id = erBoxDrag.id, el = erBoxDrag.el;
    erBoxDrag = null;
    $('ersvg').classList.remove('dragging');
    $('ermarks').classList.remove('dragging');
    if (el) el.classList.remove('dragging');
    if (erDragged) {
      erArranged = true;
      // Every box, not just the one that was moved. Holding only the dragged ones preserved nothing
      // that matters: an arrangement is a set of *relationships* between boxes, so letting the other
      // three hundred be placed again destroys it while the dragged one sits where it was left.
      // Reported, and the guides had already described the right behaviour - the code had not.
      erIds.forEach((other) => {
        const q = erPos[other];
        if (q) erHeld[other] = { x: q.x, y: q.y };
      });
      erRaised.set(id, ++erRaiseN);
      erPinOnly = null;   // touched by hand: it is their arrangement again, not the file's
      erRender();                                   // the arcs follow the new position, once
      const k = erCovers(id);
      erHint(label(N[id]) + ' ' + (k ? MSG.dropCovers(k) : MSG.dropClear));
    }
    setTimeout(() => (erDragged = false), 0);
    return;
  }
  erDown = false; setTimeout(() => (erDragged = false), 0);
});
// The window changing size leaves the drawing framed for a size it no longer has, and the only way
// back was the Fit button. Debounced, because resize fires continuously through a drag and erFit
// walks every box; 120ms is below what reads as a delay and well above the event rate.
let _erFitT = null;
window.addEventListener('resize', () => {
  clearTimeout(_erFitT);
  _erFitT = setTimeout(() => { if (curView === 'er' && !erUserMoved) erFit(); }, 120);
});
// Double-click on empty canvas: zoom in and put what was clicked in the middle. It is what every
// interface does, and this one only had the wheel - which zooms towards the pointer but never centres,
// so reaching a cluster meant scrolling and then dragging. `Fit` is the way back.
//
// Empty canvas only: a box answers a double-click by being inspected and an arc by being isolated, so
// those keep their own meaning. The same exclusions the click handler already uses, plus the arc hit
// areas, which are transparent and 14px wide and would otherwise swallow a double-click near a line.
document.addEventListener('dblclick', (e) => {
  if (curView !== 'er') return;
  const t = e.target;
  if (t.closest && (t.closest('#ertools') || t.closest('#erlay') || t.closest('#erfile') || t.closest('#erpick')
      || t.closest('.erbox') || t.closest('.erhit'))) return;
  const rect = $('v-er').getBoundingClientRect();
  // Where the click landed in the drawing's own coordinates, before the transform.
  const dx = (e.clientX - rect.left - erTx) / (erScale || 1);
  const dy = (e.clientY - rect.top - erTy) / (erScale || 1);
  const before = erScale;
  erScale = Math.max(0.02, Math.min(3, erScale * 1.6));
  if (erScale === before) return;              // already at the ceiling: nothing to say, nothing to do
  erTx = rect.width / 2 - dx * erScale;
  erTy = rect.height / 2 - dy * erScale;
  erApply();
  erUserMoved = true;                          // a view somebody chose, so a resize must not overrule it
}, { passive: true });
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
   // concentric follows the CURRENT focus, not just the one it was opened with
function erUpdateControlVis() {
  const rel = erEmph === 'relations', conc = erConcentric(), _schema = DATA.kind === 'schema';
  const set = (id, on) => { const e = $(id); if (e) e.classList.toggle('off', !on); };
  // "Fields: key / all" chooses which of a module's fields are worth a row. A call box has no such
  // choice - every call it makes is one - so the control has nothing to do and is absent.
  const fa = $('erAll'); if (fa) fa.style.display = _schema ? '' : 'none';
  const em = $('erEmph'); if (em) em.textContent = MSG.emphasis + erEmphLabel();
  set('rowMargin', true);
  set('rowSpread', !conc);
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
// erApplyParams lives in graphlogic.js: identical in both windows and touching no element.
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
    if (on) { $('erfile').classList.remove('on'); $('erFileBtn').classList.remove('on'); }
    if (on) erUpdateControlVis();
  };
  // Anchored under its own button rather than at a fixed left, because it is not the first control
  // in the row and a menu that opens somewhere else is a menu nobody connects to what they pressed.
  $('erFileBtn').onclick = () => {
    const p = $('erfile');
    const on = p.classList.toggle('on');
    $('erFileBtn').classList.toggle('on', on);
    if (on) {
      // Measured against the view, which is what the panel is positioned inside. offsetLeft is
      // relative to the toolbar instead, so the menu opened a toolbar's padding away from its
      // own button - close enough to look intentional and wrong at every window width.
      p.style.left = Math.round($('erFileBtn').getBoundingClientRect().left
                                - $('v-er').getBoundingClientRect().left) + 'px';
      $('erlay').classList.remove('on'); $('erLayBtn').classList.remove('on');
    }
  };
  // A menu closes when it has been used, and when the reader goes elsewhere. Capture, because the
  // canvas stops a click from travelling and this has to hear it either way.
  document.addEventListener('click', (e) => {
    if (curView !== 'er') return;
    const p = $('erfile');
    if (!p || !p.classList.contains('on')) return;
    if (e.target.closest && e.target.closest('#erFileBtn')) return;
    p.classList.remove('on'); $('erFileBtn').classList.remove('on');
  }, true);
  erParamsToUI(); erUpdateControlVis();
}
// Keyed by kind: a spread tuned on an ER diagram of 87 modules is the wrong starting point for a
// call graph, and restoring it there was how the boxes came out a screen apart.
// Merged: the settings page writes `current` into this same key and knows nothing about `kind` or
// `mode`, and each replacing the other is how a value saved in one place disappeared by visiting the
// other. Same fix in the Analytics twin.
async function erSaveParams() {
  try {
    const prev = (await chrome.storage.local.get('erParams')).erParams || {};
    await chrome.storage.local.set({ erParams: Object.assign({}, prev, { current: erP, mode: erEmph, kind: DATA.kind }) });
  } catch (_) {}
}
// «Emphasis» switches between boxes-with-contents and labels-with-arcs. The internal values stay
// `modules` / `relations` because the presets and the layout branch are keyed on them; only the word
// on the button follows what is being drawn.
const erEmphLabel = () => (erEmph === 'relations' ? (DATA.kind === 'schema' ? 'relations' : 'edges')
                                                 : (DATA.kind === 'schema' ? 'modules' : 'calls'));
$('erEmph').onclick = () => {
  erEmph = erEmph === 'relations' ? 'modules' : 'relations';
  $('erEmph').textContent = MSG.emphasis + erEmphLabel();
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
  if (t.closest && (t.closest('#ertools') || t.closest('#erlay') || t.closest('#erfile') || t.closest('#erpick') || t.closest('.erbox'))) return;
  erClearPick();
});
$('erAll').onclick = () => { erAll = !erAll; $('erAll').textContent = 'Fields: ' + (erAll ? 'all' : 'key'); erResize(); };
$('erRelay').onclick = () => { erHeld = {}; erRaised = new Map(); erRaiseN = 0; erArranged = false; erLaidOut = false; erShowMaybeHeavy(); };
$('erFit2').onclick = () => erFit();
$('erPdf').onclick = () => window.print();

// ER PDF: print the whole diagram on ONE page sized to the content (no horizontal clipping)
let _erStyle = null;
window.addEventListener('beforeprint', () => {
  if (curView !== 'er') return;
  // What is folded away is not on the page, so it may not size the page either - same reason as erFit.
  const goneNow = erHiddenSet();
  let minX = erMinX, minY = erMinY, maxX = erMaxX, maxY = erMaxY;
  erIds.forEach((id) => {
    const p = erPos[id]; if (!p || goneNow.has(id)) return;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
  });
  // Same correction as the fit: the page is as big as the drawing, not as big as the distance from a
  // corner the drawing may not start at.
  const W = Math.ceil(maxX - Math.min(0, minX) + 40), H = Math.ceil(maxY - Math.min(0, minY) + 40);
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
  // The parts that are known, and nothing standing in for the parts that are not. This read
  // `${ws.instance || 'unknown'}-org${ws.org || 'x'}`, so a print with no identity came out as
  // `Zoost-graph-unknown-orgx-2026-08-23` - a filename on a document that leaves the machine,
  // carrying two placeholders that look like values. A shorter name says the same thing honestly.
  const who = [ws.instance, ws.org ? 'org' + ws.org : null].filter(Boolean).join('-');
  return `Zoost-${kind}${who ? '-' + who : ''}-${d}`;
}
let _prevDocTitle = null;
// A printed page has no controls on it - the fold marks are display:none there - so the arcs must not
// keep the room they were leaving for circles nobody can see. Redrawn full length for the print and
// redrawn again after it, which is cheap next to what printing itself costs.
window.addEventListener('beforeprint', () => {
  _prevDocTitle = document.title; document.title = pdfTitle();
  erPrintFull = true; erSizeArrows();
});
window.addEventListener('afterprint', () => {
  if (_prevDocTitle != null) { document.title = _prevDocTitle; _prevDocTitle = null; }
  erPrintFull = false; erSizeArrows();
});

// Visible attribution (also appears in the printed PDF)
(function () {
  const el = document.getElementById('credit'); if (!el) return;
  const url = PRODUCT_URL ? ` \u00b7 <a href="${escA(PRODUCT_URL)}">${PRODUCT_URL}</a>` : '';
  el.innerHTML = `${PRODUCT_NAME}${url} \u00b7 Created by ${PRODUCT_AUTHOR} \u00b7 Apache-2.0 \u00b7 Independent, unofficial tool - not affiliated with Zoho Corporation \u00b7 provided AS IS, no warranty`;
})();

// Which boxes the layout may not move. Normally that is everything the reader is holding: a drag
// keeps every box on screen where it is, because an arrangement is the relationships between them
// and re-placing the other three hundred destroys it. A *loaded* arrangement is the one exception -
// there the file says which boxes somebody actually chose to move, and only those are held against
// the layout, so a box that was placed automatically once can be placed automatically again to leave
// room for a newcomer. Set by the load, and dropped the moment the reader drags anything, because
// from then on it is their arrangement again.
// One description for both pickers: the same sentence written twice is two sentences one
// careless edit away from disagreeing, which is what the message check exists to catch.
const ARR_TYPES = [{ description: 'Zoost arrangement', accept: { 'application/json': ['.json'] } }];
let erPinOnly = null;
// Which product wrote the file. Taken from the manifest's own name and reduced to letters rather
// than written out, because a shipped file may name its own product and nothing else - and a line
// that branched on the other one's name would be exactly that. The value only changes if the product
// is renamed, which is a deliberate act.
const APP = (chrome.runtime.getManifest().name || '').replace(/[^a-z]/gi, '').toLowerCase();
// What identifies the diagram a file was saved from. Not for display - it decides whether a file may
// be applied at all - so it is built from the two things the mirror is keyed by and nothing else.
// A name to start from, which the reader is expected to type over: the same diagram has several
// readings - one arranged for a presentation, one for chasing a problem - and the filename is the
// whole of that versioning. Nothing inside the file carries a title, so renaming one can never
// break it.
$('erArrSave').onclick = async () => {
  if (curView !== 'er' || !erIds.length) return;
  const st = erArrState();
  const text = serializeArrangement(st);
  try {
    const h = await window.showSaveFilePicker({ suggestedName: erArrName(), types: ARR_TYPES });
    const w = await h.createWritable();
    await w.write(text); await w.close();
    erHint(MSG.arrSaved(Object.keys(st.positions).length));
  } catch (e) {
    // A picker the reader closed is not a failure, and saying so would be noise on a deliberate act.
    if (e && e.name === 'AbortError') return;
    erHint(friendlyArrError(e));
  }
};
const friendlyArrError = (e) => (e && e.message ? e.message : String(e));
$('erArrLoad').onclick = async () => {
  if (curView !== 'er') return;
  let text;
  try {
    const [h] = await window.showOpenFilePicker({ types: ARR_TYPES, multiple: false });
    text = await (await h.getFile()).text();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    erHint(friendlyArrError(e)); return;
  }
  const read = parseArrangement(text, drawMax);
  if (!read.ok) { erHint(MSG.arrBadFile[read.reason] || MSG.arrBadFile.notOurs, true); return; }
  erApplyArrangement(read.file);
};
// The graph is the truth, the file is an intention applied to it, and every disagreement resolves in
// favour of the graph with the loss named. Refusals first, because a file from another kind of
// diagram does not degrade - it means nothing.
