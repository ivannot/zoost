/*
 * preview-controller.js - CRM item preview, project files and list selection.
 *
 * Loaded before sidepanel.js. It declares state and callable controllers only; sidepanel.js
 * remains the composition root that attaches controls after every script has loaded.
 */
let currentPath = null;
let previewLoad = 0;
const previewCurrent = (mine, op) => mine === previewLoad && op.current();
// ---------- preview ----------
// The preview header, written in one place so the five tabs cannot say different things.
//
// Reported: selecting a function showed `functions/<namespace>/<name>.dg` in a 400px header, so the
// ellipsis ate the file name - the one part worth reading - and left the folder. And no other tab
// named a file at all, which reads as five products rather than five tabs. So: the item's own name,
// then the file, then the whole workspace-relative path in the tooltip, which is where a long string
// belongs.
//
// Schedules and connections carry a synthetic path (`schedules/<id>`, `connections/<name>`): there is
// no such file, they are rows inside one index. Naming a file that is not there would be worse than
// naming none, so those name the file that does hold them and say what they are inside it.
function pvFileOf(path) {
  return previewFileDescription(path);
}
// Copy the code that is on screen. `textContent` rather than the source variable: what the reader is
// looking at is what lands in the clipboard, and the highlighting comes back off by itself. The mark
// becomes a tick for a moment, because a copy that says nothing is indistinguishable from a click
// that missed.
const COPY_MARK = '<svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V10a1.5 1.5 0 0 0 1.5 1.5h1.5"/></svg>';
const COPY_TICK = '<svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
async function copyCode(text) {
  const btn = $('codecopy');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.innerHTML = COPY_TICK;
    setTimeout(() => { btn.innerHTML = COPY_MARK; }, 1200);
  } catch (e) {
    setStatus(MSG.copyFailed + friendlyError(e), 'warn');
  }
}
function setPvName(label, path) {
  navLabel(label);   // the chain shows what the header shows - one name, decided in one place
  const f = pvFileOf(path);
  // A function's name *is* its file name, so printing both would say it twice. Derived from the two
  // strings rather than decided per tab, which is how the tabs drifted apart in the first place.
  const same = !!f && label === f.name;
  $('pvname').textContent = label;
  $('pvname').title = same ? f.title : label;
  $('pvfile').textContent = f && !same ? f.name : '';
  $('pvfile').title = f && !same ? f.title : '';
}

// A project has one row and several files. Search opens the exact file that matched, so resolving
// only `row.path` loses the function as soon as that file is not the chosen primary one (most visibly
// on config.json): the tree selection, the name and «Open in Zoho» all disappear together.
const functionRowForPath = (path) => findPreviewFunction(treeData, path);
const projectFilesOf = (row) => previewProjectFiles(row, isDeluge);
const projectDirectoriesOf = (row) => previewProjectDirectories(row, isDeluge);

// Which folders the reader has closed, and for which function. A project is opened, walked and left;
// carrying one project's closed folders into the next would close folders that are not the same
// folders. Keyed by the project root, so going back to a function finds it as it was left.
let projCollapsed = new Set(), projRootOpen = '';
/** The project as a tree: folders that open and close, files that open in the Code pane.
 *
 *  It was a `<select>` above the code, which is fine for three files and unusable for a project with
 *  a `node_modules` in it - reported that way. A tree is what a folder of files is, so this draws
 *  one: every node is a row, a folder toggles, a file opens. Directories Zoho returned empty are
 *  drawn too, because «this folder is here and has nothing in it» is a fact about the project and
 *  the reader would otherwise wonder where it went.
 */
function showProjectFiles(row, path) {
  const box = $('pvfiles');
  const files = projectFilesOf(row), directories = projectDirectoriesOf(row);
  const root = ((row && row.metaPath) || '').replace(/\.meta\.json$/, '.files/');
  box.dataset.available = (files.length > 1 || directories.length) ? '1' : '';
  box.innerHTML = '';
  if (!box.dataset.available) { projRootOpen = ''; return; }
  if (projRootOpen !== root) { projRootOpen = root; projCollapsed = new Set(); }
  const rel = (p) => (root && p.startsWith(root) ? p.slice(root.length) : p.split('/').pop());
  // One node per path segment, folders before files at each level and each side by name - the order
  // a file manager uses, and the only one in which a reader can find anything.
  const tree = { dirs: new Map(), files: [] };
  const dirAt = (parts) => parts.reduce((node, part) => {
    if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
    return node.dirs.get(part);
  }, tree);
  directories.forEach((d) => { const parts = rel(d).split('/').filter(Boolean); if (parts.length) dirAt(parts); });
  files.forEach((f) => {
    const parts = rel(f).split('/').filter(Boolean);
    const name = parts.pop();
    dirAt(parts).files.push({ name, path: f });
  });
  const draw = (node, prefix, depth) => {
    [...node.dirs.keys()].sort().forEach((name) => {
      const here = prefix + name + '/';
      const closed = projCollapsed.has(here);
      const el = document.createElement('div');
      el.className = 'pfrow pfdir'; el.style.paddingLeft = (8 + depth * 12) + 'px';
      el.setAttribute('role', 'treeitem'); el.setAttribute('aria-expanded', String(!closed));
      el.innerHTML = `<span class="pfmk">${closed ? '▸' : '▾'}</span><span>${escHtml(name)}/</span>`;
      el.onclick = () => {
        closed ? projCollapsed.delete(here) : projCollapsed.add(here);
        showProjectFiles(row, currentPath);
      };
      box.appendChild(el);
      if (!closed) draw(node.dirs.get(name), here, depth + 1);
    });
    node.files.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => {
      const el = document.createElement('div');
      el.className = 'pfrow' + (f.path === path ? ' on' : '');
      el.style.paddingLeft = (8 + depth * 12) + 'px';
      el.setAttribute('role', 'treeitem'); el.title = rel(f.path);
      el.innerHTML = `<span class="pfmk"></span><span>${escHtml(f.name)}</span>`;
      // Opening a file lands on the pane that shows it: `openFile` draws the strip, and the strip
      // starts on Code. Leaving the reader on the tree would be a control that answers somewhere
      // they are not looking.
      el.onclick = () => { void openFile(f.path, null, true); };
      box.appendChild(el);
    });
  };
  draw(tree, '', 0);
}
// The list follows whatever the preview is showing. Marking the row was already here; what was
// missing is everything a reader needs for that mark to *mean* anything - it was reported as the
// selection staying uncoordinated after jumping from one function to another through a call in the
// code.
//
// Three things, and each was its own small lie: a group closed over the target stays closed and the
// row does not exist to be marked, so the tree shows nothing selected; a row far down the list is
// marked where nobody can see it; and the keyboard went on stepping from where *it* had been, so
// the next arrow jumped back to the previous function.
function syncTreeTo(path) {
  const e = functionRowForPath(path);
  const rowPath = (e && e.path) || path;
  // `ns`, spelled the way the tree spells it: `collapsed` is shared with the modules list, which
  // prefixes its keys, and a test holds that difference. Same key, same name for it.
  const ns = e && e.namespace;
  if (ns && treeSort === 'name' && collapsed.has(ns)) {
    collapsed.delete(ns);                 // opened, because you asked to look at what is inside it
    renderTree();
  }
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === rowPath));
  stepAnchor = rowPath;                   // the arrows carry on from the function whose file you are looking at
  const row = [...$('tree').querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === rowPath);
  revealRow(row, $('tree'), '.grp');
}

// You clicked it, so you know where it is: opening the pane shortens the list and may push that row
// below the fold, and scrolling after your own click is the panel arguing with your finger. Arriving
// from anywhere else - a link, a health row, a step of the history - is the opposite: there the row
// has to be found for you. One flag tells the two apart, set by the only place a click starts.
function openFromTree(path) { openFile(path, null, true); }
async function openFile(path, line = null, byClick = false) {
  const mine = ++previewLoad;
  const op = beginWorkspaceOp();
  if (!(await ensurePerm(op.root))) { if (previewCurrent(mine, op)) setStatus('File access denied - click Refresh to grant.', 'bad'); return; }
  if (!previewCurrent(mine, op)) return;
  // The `push` flag is gone with the back stack it fed: whether a step is remembered is no longer
  // something each caller decides - every arrival is a step, which is what made the old one useless
  // the moment the reader changed tab.
  currentPath = path; navHere(path.split('/').pop()); if ($('status').className) setStatus('', '');
  $('pvreveal').style.display = 'none';   // "Go to" (auto-open in the editor) removed: it drove Zoho's localized DOM. Find is the deterministic way in.
  $('pvfind').style.display = ''; $('pvfind').textContent = 'Functions in Zoho \u2197'; $('pvfind').title = 'Open Zoho\u0027s own functions page. It no longer types this name into their search box: the newer functions interface is addressed by URL, and this product does not script somebody else\u0027s page.'; $('pvtable').style.display = 'none';
  syncTreeTo(path);
  const trow = functionRowForPath(path);
  // The button says which of the two it does. It opened the list and said so; with the mapping
  // pulled it opens this function, and a label that still said «Functions in Zoho» would be a
  // control describing the behaviour it used to have.
  if (trow && trow.uiId) {
    $('pvfind').textContent = MSG.openInZoho;
    $('pvfind').title = 'Open this function in Zoho, by URL. An org without the newer functions interface is redirected by Zoho to the functions list.';
  }
  if (trow) navNames({ display: trow.display_name, api: trow.api_name });
  setPvName(path.split('/').pop(), path); $('pvcallers').className = ''; $('pvcallers').textContent = '';
  // The tree is built *before* the strip is drawn: whether the Files tab exists is read from what
  // this item has, and `pvTabsFor` is what asks. The other way round the strip described the item
  // before this one - which is the stale-projection defect this panel keeps meeting.
  showProjectFiles(trow, path);
  pvTabsFor('function');
  let code; try { code = await op.read(path); } catch (e) { if (previewCurrent(mine, op)) setStatus(MSG.readFailed + e.message, 'bad'); return; }
  if (!previewCurrent(mine, op)) return;
  const lines = code.split('\n').length;
  $('pvgutter').textContent = Array.from({ length: lines }, (_, k) => k + 1).join('\n');
  const _g = await ensureGraph(op).catch(() => null);
  if (!previewCurrent(mine, op)) return;
  const _resolve = _g ? makeCallResolver(_g) : null;
  // The module named inside a call is a link too, on the same principle as the call itself: a name
  // that identifies something this panel can show is hypertext. Resolved against the module index,
  // so a string that merely looks like a module stays a string.
  const _known = (await moduleNames(op).catch(() => null)) || new Map();
  if (!previewCurrent(mine, op)) return;
  // A related-list name identifies the module at the *other* end of the relation - which is what
  // the reader means by it - so it is resolved inside its parent module's own catalogue of related
  // lists, where Zoost already holds `api_name` beside the module it points at. The same name can
  // exist on two modules, which is why the parent is part of the question and not a guess.
  const _mfiles = (await loadModuleFiles(op).catch(() => null)) || {};
  if (!previewCurrent(mine, op)) return;
  const _linkFor = (name, kind, parent) => {
    if (kind === 'mod') return _known.has(name) ? name : null;
    const p = parent && _mfiles[parent];
    const rl = p && (p.related_lists || []).find((r) => (r.api_name || '') === name);
    const target = rl && (rl.module || rl.connected_module);
    return target && _known.has(target) ? target : null;
  };
  const delugeSource = /\.dg$/i.test(path) && (!trow || isDeluge(trow.language));
  // Deluge is the one this panel *knows* - it resolves calls into links from the org's own graph.
  // A project file gets the colours and nothing more, because there is no such knowledge to spend on
  // it; showing it as plain text next to a coloured sibling is what made those files look like
  // something the product was merely holding.
  const otherLang = !delugeSource && window.sourceLanguage && window.sourceLanguage(path);
  $('pvcode').innerHTML = delugeSource && window.highlightDeluge
    ? window.highlightDeluge(code, _resolve, _linkFor)
    : otherLang && window.highlightSource ? window.highlightSource(code, otherLang)
    : escHtml(code);
  $('pvcode').querySelectorAll('a.c-link[data-file]').forEach((a) => { a.onclick = () => openFile(a.dataset.file); });
  $('pvcode').querySelectorAll('a.c-link[data-mod]').forEach((a) => { a.onclick = () => healthOpenModule(a.dataset.mod); });
  paintFindMarks($('pvcode'), findMarkRe());
  showPreview(byClick);
  if (line) { const lh = parseFloat(getComputedStyle($('pvcode')).lineHeight) || 16; $('pvbody').scrollTop = Math.max(0, (line - 3) * lh); }
  showCallers(path, mine, op);
}
/** Two tabs rather than one long column, for the two kinds of item whose detail is crowded.
 *
 *  The first tab is *the thing you opened the item for* - the source of a function, the fields of a
 *  module - and the second is everything else, which is what had grown to seven blocks stacked above
 *  a 400px-wide pane. The first tab is therefore also the default, and the choice is not remembered:
 *  it is one click, and a remembered mode that opens on Details would hide what you came for.
 *
 *  Which panes belong to which tab is declared here rather than assigned at each opener, because the
 *  strip is one control and an opener that forgot half of it is how the module detail ended up
 *  showing a function's tabs. */
let pvTab = 'code', pvKind = null;
const PV_KINDS = {
  // `files` is declared here and *offered* only when the item has a project - see `setPvTab`. A
  // Deluge function is one file, and a tab leading to an empty pane is a control that lies.
  function: { first: 'Code', panes: { code: [['pvbody', 'flex']], files: [['pvfiles', 'block']], info: [['pvcallers', '']] } },
  // `pvcallers` is on both kinds now: on a function it is what calls it, on a module it is what
  // reads and writes it. Same pane, same question - what relates to the thing on screen.
  //
  // A module has three. Its related lists used to sit at the bottom of «Details», under the refusal
  // banner, the names block and the layout counts, in a column that does not fit a side panel -
  // «you struggle to see the whole detail, there is no room». They carry the one string Deluge
  // actually needs, so they get their own tab rather than the bottom of somebody else's.
  module: { first: 'Fields', panes: { code: [['pvfields', '']], rel: [['pvrels', '']],
                                      info: [['pvdetails', ''], ['pvcallers', '']] } },
};
const PV_TABS = { code: 'pvtab_code', files: 'pvtab_files', rel: 'pvtab_rel', info: 'pvtab_info' };
function setPvTab(which) {
  // Derived from the kind's own panes rather than from a pair of ids: the strip was two buttons and a
  // boolean, so a third tab meant a third `if` in four places. What a kind has is what it declares.
  const kinds = PV_KINDS[pvKind];
  // Files is the one tab whose existence depends on the *item* and not on its kind: a function is
  // one file or a project, and only the second has anything to show. Asked in one place, so the
  // strip and the fallback below cannot disagree about whether it is there.
  const has = (tab) => !!(kinds && kinds.panes[tab] && (tab !== 'files' || $('pvfiles').dataset.available));
  pvTab = has(which) ? which : 'code';
  Object.entries(PV_TABS).forEach(([tab, id]) => {
    const b = $(id); if (!b) return;
    // A tab a kind does not have is absent, not disabled: the panel's rule everywhere else, and a
    // «Related lists» on a function would lead to an empty pane.
    b.style.display = has(tab) ? '' : 'none';
    b.classList.toggle('active', tab === pvTab);
  });
  // The copy control belongs to the pane that holds code, so it follows the strip like every other
  // pane rather than being switched on by the opener: set there, it stayed lit on «Details» and on a
  // module, where there is no code at all - visible in a picture published on the site. It is the
  // defect the comment above `PV_KINDS` describes, made once more by the same route.
  $('codecopy').style.display = (pvKind === 'function' && pvTab === 'code') ? '' : 'none';
  const k = PV_KINDS[pvKind]; if (!k) return;
  Object.entries(k.panes).forEach(([tab, panes]) => panes.forEach(([id, shown]) => {
    const el = $(id); if (el) el.style.display = tab === pvTab ? shown : 'none';
  }));
}
/** Showing the strip resets it to the first tab - opening a second item and landing on the tab the
 *  previous one was left on is the stale-projection problem in miniature. Called with anything else
 *  (a workflow, a schedule, a connection) it takes the strip away: those have one pane and no
 *  choice to make. `openModule` not calling it at all is what let a module show `Code | Details`. */
function pvTabsFor(kind) {
  pvKind = PV_KINDS[kind] ? kind : null;
  // `#pvcallers` belongs to a function - its own box above the code - and to a module, where it is
  // «read by / written by» and belongs *under* the names, inside the Details pane, so that the pane
  // scrolls as one region instead of two stacked boxes each with a scrollbar. Reported with a
  // picture. Moved here rather than by whoever opens a module: this runs on every open and knows the
  // kind, so nothing has to remember to put it back.
  const callers = $('pvcallers'), home = $('pvcallershome');
  if (kind !== 'module' && callers && home && callers.previousElementSibling !== home) home.after(callers);
  $('pvtabs').hidden = !pvKind;
  if (!pvKind) $('codecopy').style.display = 'none';   // a workflow, a schedule, a connection: no code
  // The pane belongs to the item being left, like every other. Cleared here rather than by whoever
  // opens the next one: this runs on every open and knows the kind, so nothing has to remember.
  if (kind !== 'function') {
    $('pvfiles').dataset.available = ''; $('pvfiles').style.display = 'none'; $('pvfiles').innerHTML = '';
  }
  $('pvtabsr').innerHTML = '';        // the diagram control belongs to the item being left
  if (pvKind) { $('pvtab_code').textContent = PV_KINDS[pvKind].first; setPvTab('code'); }
  else { $('pvcallers').style.display = ''; }
}

/** The modules this org actually has, by api_name, read once per workspace.
 *
 *  A module *candidate* out of a source becomes a fact only here: `graph-core` reads names out of
 *  the text and knows nothing about which of them exist, so a COQL query selecting from a word that
 *  is not a module of this org says nothing rather than drawing a box. Measured on two production
 *  orgs before this was written: three and four such names each, every one correctly refused.
 */
let modNamesCache = null;
async function moduleNames(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (modNamesCache) return modNamesCache;
  let idx = []; try { idx = JSON.parse(await op.read('modules/index.json')); } catch (_) {}
  const list = Array.isArray(idx) ? idx : (idx && idx.modules) || [];
  const m = new Map();
  list.forEach((x) => { const a = x.api_name || x.module_name || x.name; if (a) m.set(a, x); });
  if (!op.current()) return null;
  modNamesCache = m; return m;
}

/** What this function does to the modules of this org: read, written, or reached by a url whose
 *  method we have not looked at. Sorted, deduplicated, and with the count of the calls whose module
 *  is computed at run time - which is shown rather than dropped, because the answer is a lower
 *  bound and a reader deciding whether a field is safe to change has to be told so. */
async function modulesOf(node) {
  const known = await moduleNames();
  const out = { read: [], write: [], touch: [], unknown: (node && node.modulesUnknown) || 0 };
  if (!known) return out;
  for (const m of (node && node.modules) || []) {
    if (!known.has(m.name)) continue;
    const b = out[m.mode] || out.touch;
    if (!b.includes(m.name)) b.push(m.name);
  }
  // A module both read and written is a write as far as «is this safe to change» goes, but both
  // facts are true and the panel shows both - interpreting them is the reader's business.
  ['read', 'write', 'touch'].forEach((k) => out[k].sort());
  return out;
}
/** Which functions read this module, and which write it - the reading turned round.
 *
 *  This is the question the platform cannot answer at all: Zoho will show you a module's fields and
 *  its layouts, and nothing that says «this Deluge writes here». It fills the same pane a function's
 *  callers use, because it is the same kind of fact - what relates to the thing on screen - and it
 *  is drawn after the pane rather than blocking it, since it needs the call graph.
 *
 *  It is a lower bound and says so. A call whose module is computed at run time cannot be attributed
 *  to any module, so «nothing writes here» is «nothing that could be read», and the line under the
 *  lists carries that instead of leaving the reader to assume otherwise.
 */
/** A cross-tab chip stops being a way in when its tab is not there.
 *
 *  «When a tab is disabled we must not still have live references that take you there - the links
 *  stop existing for that tab, otherwise hiding it means nothing.» Reported after watching a hidden
 *  Functions tab come back by clicking a function in a module's detail. Refusing the click was the
 *  first half and it is not enough: a link that looks like a link and then says no is a worse
 *  interface than no link, because the reader learns nothing until they have pressed it.
 *
 *  So it is decided here, once, from the target the chip already declares - `data-file` and `data-fnid`
 *  mean the functions tab, `data-wf` means workflows - rather than at six render sites that would
 *  drift. What a chip becomes is plain text carrying the reason, which is the same shape the empty
 *  states in this panel use: say what is in the way and what to do about it.
 *
 *  `root` is where the chips were just drawn; `open` is what a live one does with the element. */
function wireFnChips(root, open) {
  if (!root) return;
  root.querySelectorAll('.wf-fn, a[data-file]').forEach((el) => {
    const target = el.dataset.wf != null ? 'workflows' : 'functions';
    if (tabReachable(target, true)) { el.onclick = () => open(el); return; }
    // Not a link any more, and that has to be true of the *element* and not only of its handler.
    // Removing the click left an `<a>` behind, and the containers style anchors by id - `#pvcallers a`
    // and `#healthbody a` both set a pointer and a hover, and an id selector beats any class this
    // could add. So it looked exactly like a working link that had stopped working, which is the
    // worst of the three states. Reported. The same trap is already recorded ten lines above the
    // `#pvcallers a.wf-fn` rule, one turn earlier: the container wins over the chip.
    //
    // So the anchor becomes a span. Nothing that styles `a` can reach it, in this container or in any
    // container added later, and the chip keeps its own class-based look minus the colour, which
    // `.wf-fn.gone` mutes. The text stays: what uses a module is a fact about the module.
    const why = isForbidden(target)
      ? `${tabLabel(target)}: your Zoho role does not grant access to that area.`
      : `${tabLabel(target)} is hidden in Settings, so this does not open.`;
    if (el.tagName === 'A') {
      const span = document.createElement('span');
      span.className = el.className;
      span.textContent = el.textContent;
      Object.entries(el.dataset).forEach(([k, v]) => { span.dataset[k] = v; });
      el.replaceWith(span);
      span.classList.add('gone');
      span.title = why;
      return;
    }
    el.classList.add('gone');
    el.onclick = null;
    el.title = why;
  });
}
async function showModuleUsage(api, path, mine, op) {
  const box = $('pvcallers'); box.textContent = 'reading what the code does with it\u2026'; box.className = 'show';
  try {
    const g = await ensureGraph(op);
    if (!previewCurrent(mine, op) || currentPath !== path) return;
    const read = [], write = [], touch = [];
    let blind = 0;
    for (const n of Object.values(g.nodes)) {
      if (!n.file) continue;
      blind += n.modulesUnknown || 0;
      for (const m of n.modules || []) {
        if (m.name !== api) continue;
        const b = m.mode === 'write' ? write : m.mode === 'read' ? read : touch;
        if (!b.some((x) => x.id === n.id)) b.push(n);
      }
    }
    const nm = (n) => nameMode === 'display' ? (n.display_name || n.name) : (n.api_name || n.name);
    const chips = (list) => '<div class="fnchips">' + list
      .sort((a, b) => nm(a).localeCompare(nm(b)))
      .map((n) => `<a class="wf-fn" data-file="${escA(n.file)}" title="${escA(n.namespace + '.' + n.name)}">\u0192 ${escHtml(nm(n))}</a>`)
      .join('') + '</div>';
    let html = '';
    if (read.length) html += `<b>Read by (${read.length}):</b>${chips(read)}`;
    if (write.length) html += `<b>Written by (${write.length}):</b>${chips(write)}`;
    if (touch.length) html += `<b>Reached by URL from (${touch.length}):</b>${chips(touch)}`;
    if (!html) html = '<b>No function reads or writes it</b> - as far as the code can be read';
    html += `<div class="modline">From the module names written in your Deluge`
      + (blind ? ` \u00b7 ${blind} call(s) across the org name the module in a variable and cannot be attributed` : '')
      + '</div>';
    box.innerHTML = html;
    // A function opened from a module lives on the other tab, so the tab has to move with it -
    // `openFile()` alone left the list showing modules while the detail showed a function, which is
    // the panel reading as if it had lost its place. Reported. Same two calls every other cross-tab
    // jump here makes, rather than a second way of doing it.
    wireFnChips(box, (a) => { setMode('functions'); openFromTree(a.dataset.file); });
  } catch (_) { box.className = ''; }
}
async function showCallers(path, mine = previewLoad, op = beginWorkspaceOp()) {
  const box = $('pvcallers'); box.textContent = 'computing references…'; box.className = 'show';
  try {
    const g = await ensureGraph(op); if (!previewCurrent(mine, op) || currentPath !== path) return;
    const node = Object.values(g.nodes).find((n) => n.file === path); if (!node) { box.className = ''; return; }
    const callers = node.called_by;
    const nm = (id) => nameMode === 'display' ? (g.nodes[id].display_name || g.nodes[id].name) : (g.nodes[id].api_name || g.nodes[id].name);
    // Chips, not a sentence. A comma-separated list of seven names reads as prose while the reader
    // is scanning for one of them, and this panel already has a shape for «a link to a function» -
    // the `.wf-fn` chip that workflows, schedules and connections use. Asked for by name: the same
    // layout for every function link. Not inside the code pane, where a chip would deform the line
    // it sits in; there a call stays an inline link.
    let html = callers.length
      ? `<b>Called by (${callers.length}):</b><div class="fnchips">`
        + callers.map((id) => `<a class="wf-fn" data-file="${escA(g.nodes[id].file)}" title="${escA(g.nodes[id].display_name || g.nodes[id].name || '')}">\u0192 ${escHtml(nm(id))}</a>`).join('')
        + '</div>'
      : '<b>Called by</b> - none';
    // Above the references, because «is Zoho running this?» is asked before «what calls it?» - and
    // for a compiled function it is the first thing that explains an edit that changed nothing.
    const _row = functionRowForPath(path);
    const pub = publishState(_row);
    if (pub) {
      html = `<div class="publine${pub.deployed ? '' : ' pubdraft'}">${escHtml(publishSentence(pub))}</div>` + html;
    }
    // What Zoho knows about this function at *runtime*, asked only when somebody asks. It is per
    // function - three hundred requests on a real org - so it is a button and not a pull, and the
    // box below it says that what it shows is a live reading rather than part of the mirror.

    const ap = node.associated_place || [];
    if (ap.length) {
      const byType = {};
      // The whole entry is kept, not just its name: the id is what makes the name a link.
      ap.forEach((p) => (byType[p._type || 'other'] ||= []).push(p));
      // The names of the things that fire this function are links when this panel has somewhere to
      // take you: a workflow rule opens in the Workflows tab, a schedule in Schedules. `HEALTH_OPEN`
      // already maps a kind to its opener - it exists so that a group naming a new kind gets one
      // rather than silently rendering an unclickable name - and this is that map used a second
      // time. A kind with no opener stays plain, because a link that leads nowhere is worse.
      html += '<div class="apwrap">' + Object.keys(byType).sort().map((t) => `<b>Used in ${escHtml(t)} (${byType[t].length}):</b> ${byType[t].map((p) => apLink(t, p)).join(', ')}`).join('<br>') + '</div>';
    } else if (!callers.length && !node.rest) {
      html += ' <span class="orphan">\u00b7 no known usage (orphan candidate)</span>';
    }
    // What Zoho says about this function at runtime, next to what the mirror says about it
    // statically. Nothing is inferred: if it is not in the last reading, nothing is shown - «no
    // failures recorded» would be a claim about a measurement that may never have been taken.
    try {
      const fx = await failuresIndex(op);
      if (!fx || !previewCurrent(mine, op) || currentPath !== path) return;
      // Zoho reports the display name; the mirror knows three names for the same function and which
      // one matches is not ours to assume. Try them all rather than picking one and finding nothing.
      // Named `hits`, and it has to be: this was `const mine`, which shadows the *parameter* `mine`
      // for the whole block - so the `previewCurrent(mine, op)` three lines above read it in the
      // temporal dead zone and threw, every single time. The catch below swallowed it, so «what Zoho
      // says about this function at runtime» has never rendered once, silently, while the exports
      // printed it. Found by a review of this file.
      const hits = [node.display_name, node.name, node.api_name]
        .map((k) => fx.byName.get(String(k || '').toLowerCase())).find((v) => v && v.length) || [];
      if (hits.length) {
        const total = hits.reduce((n, f) => n + (f.count || 0), 0);
        const last = hits.map((f) => f.lastFailedAt).filter(Boolean).sort().pop();
        html += `<div class="failwrap"><b>Failing in Zoho:</b> ${escHtml(String(total))}\u00d7`
          + (last ? ` \u00b7 last ${escHtml(fmtDate(last))}` : '')
          + ` \u00b7 as read on ${escHtml(fmtDate(fx.at))}`
          // One line per distinct reason. Zoho returns a row per failing invocation, so a function
          // that broke the same way twice came back with the same sentence printed twice - which
          // reads as two problems and is one. The count above already says how many times.
          + [...new Map(hits.map((f) => [`${f.componentType}|${f.reason}`, f])).values()]
              .map((f) => `<div class="failrow">${escHtml(f.componentType || '?')} \u00b7 ${escHtml(f.reason || '')}</div>`).join('')
          + '</div>';
      }
    } catch (_) { /* no reading yet: say nothing rather than claim none */ }
    // Which modules this function touches, and how. The nearest sibling on this pane is the
    // connections row - a set of things outside the function that it reaches - so it is built the
    // same way, and the chips carry the module's api_name because that is what the code wrote.
    const mods = await modulesOf(node);
    if (mods.read.length || mods.write.length || mods.touch.length || mods.unknown) {
      const chips = (names, kind) => names.map((n) =>
        `<span class="mod ${kind}" data-mod="${escA(n)}" title="${escA(n + ' - click to open the module')}">${escHtml(n)}</span>`).join(' ');
      html += '<div class="modwrap">';
      if (mods.read.length) html += `<b>Reads (${mods.read.length}):</b> ${chips(mods.read, 'r')}<br>`;
      if (mods.write.length) html += `<b>Writes (${mods.write.length}):</b> ${chips(mods.write, 'w')}<br>`;
      if (mods.touch.length) html += `<b>Reached by URL (${mods.touch.length}):</b> ${chips(mods.touch, 't')}<br>`;
      // Never folded into the counts above: a number that quietly excludes what it could not read
      // is the kind of half-answer this panel exists to refuse.
      if (mods.unknown) html += `<span class="orphan">${mods.unknown} call(s) name the module in a variable - not determinable</span>`;
      html += '</div>';
    }
    const conns = node.connections || [];
    if (conns.length) {
      html += '<div class="connwrap"><b>Connections (' + conns.length + '):</b> '
        + conns.map((c) => `<span class="conn" data-conn="${escA(c.name)}" title="${escA((c.label || c.name) + (c.service ? ' \u00b7 ' + c.service : '') + ' - click to list every function that uses it')}">${escHtml(c.name)}</span>`).join(' ')
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
    // Declared, not a `.then` inside the handler: this reads Zoho and then writes into the box, and
    // a callback is a scope the race checker cannot enter.
    // Built rather than written into the markup: this box is inside `#pvcallers`, whose contents the
    // next open replaces, and an id reached for later would be an id that has gone. The panel has
    // paid for that shape once already, with the callers box inside `#pvtable`.
    if (_row && _row.id) {
      const wrap = document.createElement('div'); wrap.className = 'rtwrap';
      const go = document.createElement('button'); go.className = 'lbtn';
      go.textContent = 'Runtime in Zoho \u21bb';
      go.title = 'Ask Zoho what this function did lately: its last executions and its revision history. Read now, not stored.';
      // Which window, chosen the way Zoho's own page lets you choose it. It sits beside the button
      // rather than inside the answer: changing it before asking is the ordinary case, and a control
      // that only appears after the first answer cannot be used for the first one.
      const win = document.createElement('select'); win.className = 'filtersel';
      win.setAttribute('aria-label', 'Runtime window');
      RUNTIME_WINDOWS.forEach(([k, l]) => {
        const o = document.createElement('option'); o.value = k; o.textContent = l; win.appendChild(o);
      });
      win.value = runtimeWindow;
      const out = document.createElement('div');
      // Remembered across functions, not reset per open: a reader who works in months is asking the
      // same question of the next function, and re-choosing it every time is the control apologising.
      // The two date fields, present only for the window that uses them: a control with nothing to
      // do is one the reader has to work out the irrelevance of.
      const d1 = document.createElement('input'), d2 = document.createElement('input');
      // The two ends cannot cross, and the control is what says so: `max` on the first and `min` on
      // the second means the calendar simply does not offer a day that would invert the range.
      // Refusing afterwards is a sentence the reader has to read; not offering it is nothing to
      // read. The ordering in `runtimeSpan()` stays as the second half of the same rule - these
      // fields can still be typed into, and a typed range is not bound by either attribute.
      // **And Zoho keeps thirty days.** Reported from the platform: on 28 August the oldest day it
      // would accept was 29 July. So the calendar is bounded at both ends - no day before the floor
      // and none after today - and a reader is not offered a range that can only come back empty
      // with nothing saying why. It is the same thirty days the org-wide reading uses, arrived at
      // from the other side: their `last_month` and their retention are the same window.
      const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const today = day(new Date()), floor = day(new Date(Date.now() - RUNTIME_KEPT_DAYS * 86400000));
      const later = (a, b) => (a && b ? (a > b ? a : b) : a || b);
      const earlier = (a, b) => (a && b ? (a < b ? a : b) : a || b);
      const limit = () => {
        d1.min = floor; d1.max = earlier(today, runtimeTo);
        d2.min = later(floor, runtimeFrom); d2.max = today;
      };
      [d1, d2].forEach((d, i) => {
        d.type = 'date'; d.className = 'rtdate';
        d.title = i ? 'To this day, included' : 'From this day, included';
        d.setAttribute('aria-label', i ? 'To date' : 'From date');
        d.value = i ? runtimeTo : runtimeFrom;
        // A date field is a calendar already; what it is not is *obviously* one, because it draws
        // like a text box with a small icon at one end - «sarebbe meglio avere un calendar su cui
        // scegliere». Clicking anywhere in it opens the picker, so the field behaves like the thing
        // it is instead of inviting somebody to type `dd/mm/yyyy`. Guarded: `showPicker` throws
        // without a user gesture, and this is one, but a browser that does not have it must not
        // take the click down with it.
        d.onclick = () => { try { d.showPicker(); } catch (_) { } };
        d.onchange = () => { if (i) runtimeTo = d.value; else runtimeFrom = d.value; limit(); };
      });
      limit();
      const showDates = () => { const on = win.value === 'custom'; d1.style.display = d2.style.display = on ? '' : 'none'; };
      win.onchange = () => { runtimeWindow = win.value; showDates(); if (out.innerHTML) void showFunctionRuntime(_row, out); };
      showDates();
      go.onclick = () => { void showFunctionRuntime(_row, out); };
      wrap.appendChild(go); wrap.appendChild(win); wrap.appendChild(d1); wrap.appendChild(d2);
      wrap.appendChild(out); box.appendChild(wrap);
    }
    wireFnChips(box, (a) => openFile(a.dataset.file));
    box.querySelectorAll('.conn[data-conn]').forEach((c) => (c.onclick = () => filterByConnection(c.dataset.conn)));
    // A module chip opens the module, the way a function chip opens the function. It is the whole
    // point of the reading: the two halves of the mirror are one click apart instead of two lists.
    box.querySelectorAll('.mod[data-mod]').forEach((c) => (c.onclick = () => healthOpenModule(c.dataset.mod)));
    // «Used in …»: the rule or the schedule that fires this function, opened where it lives.
    box.querySelectorAll('a.aplink[data-ap]').forEach((a) => (a.onclick = () => {
      const open = HEALTH_OPEN[a.dataset.ap];
      if (open) open(a.dataset.apid, a.dataset.apname);
    }));
    // The same control the Modules preview carries, next to the same kind of fact: the references
    // are listed above it, this draws them. Absent when there is nothing to draw - a function
    // nobody calls and that calls nothing is a single box and no arrows.
    //
    // It sits on the tab strip rather than inside Details, and that is the rule the diagram window
    // already learnt about its focus: a control that acts on the item belongs to the item's chrome,
    // not to one of the views of it. Behind the second tab it was unreachable from Code - the tab
    // people open a function for. The depth travels with it, or the tooltip would name a control
    // that is on the other tab. The Modules preview keeps its own bar, because that detail has no
    // strip to move to and nothing is hiding it.
    const slot = $('pvtabsr'); slot.innerHTML = '';
    if (callers.length || (node.calls || []).length) {
      slot.innerHTML = `depth <select id="calldepth"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select><button id="callopen" class="laylocal icon" aria-label="Wiring" title="Wiring - opened on this function at the depth chosen here, in its own window"><svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5" rx="1"/><rect x="9" y="9" width="5.5" height="5" rx="1"/><path d="M7 4h3.5a1.2 1.2 0 0 1 1.2 1.2V9"/></svg></button>`;
      slot.querySelector('#callopen').onclick = () => openCallFocus(node.namespace + '.' + node.name, parseInt(slot.querySelector('#calldepth').value, 10) || 2);
    }
  } catch { box.className = ''; }
}
// ---- keyboard: the selection follows the arrows ------------------------------------------------
// The twin of the Analytics panel's, against the tree instead of a table: up and down used to
// scroll, and what a reader wants is the next function *open*. Only rows that are on screen take
// part - a collapsed group's children are not there to be stepped onto, and neither is anything the
// search or the type filter has taken away.
let stepAnchor = null;      // where the keyboard is, which the DOM learns a tick later
// Bring a row fully into view, under whatever is stuck to the top of the list. `scrollIntoView`
// with `block: 'nearest'` aligns to the container's edge and knows nothing about a sticky header -
// so stepping upwards parked the selected row exactly underneath it, half visible. Reported after
// the arrows landed: the movement was right and the row was not all there.
//
// The header is measured rather than assumed: it is a column row in one product and a group label
// in the other, both `position: sticky`, and both change height with the font a reader has set.
/** Mark a row as the selected one **and bring it into view** - one act, which was five.
 *
 *  Every list here had the first half; only the functions tree had the second, so a jump from a
 *  health row, a link in the code or a step of the history selected a module, a workflow or a
 *  connection that the reader then had to scroll to find. Reported exactly that way: «the highlighted
 *  item must always be visible». `openFile()` keeps its own two lines because it also
 *  moves the arrow anchor; everything else calls this, so the next list inherits both halves.
 */
/** Move the view to the current item. Called when the geometry is final, never by whoever opened it.
 *
 *  Measured rather than guessed, after five attempts that were not. The recorded sequence of one
 *  jump reads: the list is drawn, the reveal runs and finds the row **inside** a 376px box so it
 *  correctly does nothing, and only *then* the detail pane opens and the box becomes 68px. Nothing
 *  reveals after that, so whether the row is still on screen depends on where the scroll happened to
 *  be - which is exactly what «random» looks like from the outside.
 *
 *  So the event is not «the list has been drawn»: it is «the pane has opened», which is what changes
 *  the height. Reading the row's rect here forces the pending layout, so this sees the new geometry
 *  and not the old.
 */
function applySelection(byClick) {
  if (!currentPath) return;
  const box = $('tree'); if (!box) return;
  const owner = functionRowForPath(currentPath);
  const rowPath = (owner && owner.path) || currentPath;
  const row = [...box.querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === rowPath);
  if (!row) return;
  // **Arriving** is not **stepping**, and they want different things. `revealRow()` scrolls the least
  // it can - the right answer for the arrows, where a list that jumps under you is worse than one
  // that barely moves - but it means a jump lands at the top edge when you came from below and at
  // the bottom edge when you came from above, which reads as two behaviours. Reported that way.
  // A jump puts the row a couple of rows down from the top of the list instead: one place, always,
  // with what precedes it visible.
  const st = box.querySelector('.grp');
  const cover = st ? st.getBoundingClientRect().height : 0;
  // The origin travels with the call rather than in a variable shared between two navigations: a
  // click whose open then failed - no permission, an unreadable file - used to leave the flag set,
  // and the *next* arrival from somewhere else was mistaken for that click and never revealed.
  if (byClick) return;                    // your own click: the list stays put
  revealRow(row, box, '.grp');   // arrived from elsewhere: the least scroll that shows it
}

/** Open the detail pane - one function, because opening it is what shrinks the list, and the six
 *  places that used to do it by hand each left the selected row wherever it happened to be. */
function showPreview(byClick) {
  $('preview').classList.add('show');
  $('resizer').classList.add('show');
  resetPreviewScroll();
  applySelection(byClick);
}

function selectRow(path) {
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
  const find = () => [...$('tree').querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === path);
  let row = find();
  // Not there yet, for one of two reasons, and both were reported. The row may be inside a **closed
  // group** - every list here groups its rows and `collapsed` is shared, with a different key prefix
  // per list - or the list may not have been drawn yet, because arriving here changes tab and the
  // rebuild lands a tick later. Neither is worth teaching this function about: the group headers
  // already carry the code that opens them, so the ones that are closed are *clicked*, which is what
  // the reader would have done, and each list re-renders itself its own way. Then we look again on
  // the next frame, which is also the answer to the second reason.
  if (!row) {
    // **One at a time, asked again each time.** Collecting them and clicking the list opened the
    // first group, whose handler calls `renderTree()` - which replaces every node, so the rest of
    // that NodeList was detached from the document and its clicks did nothing at all. A row inside
    // the second closed group was still not drawn, `find()` still answered nothing, and the reader
    // was left where they were with no reason given. Found when a driver started refusing to click
    // a control that is not on the page.
    // **And it stops at the one that was in the way.** Opening them all was the shape the first
    // fix took, and it costs the reader every fold they had made: nine groups collapsed, one
    // arrival from a link, and all nine are open. The functions tree opens exactly the target's
    // group, because it can resolve the key from `treeData`; this function serves every list and
    // cannot, so it asks after each one instead. What it still opens is whatever sits above the
    // target in the list - said here rather than left to be found, because closing those again
    // would mean a re-render per group for a fold nobody was looking at.
    for (let k = 0; k < 200 && !row; k++) {
      const g = $('tree').querySelector('.grp.collapsed');
      if (!g) break;
      g.click();
      row = find();
    }
  }
  if (row) { revealRow(row, $('tree'), '.grp'); return; }
  requestAnimationFrame(() => {
    document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
    revealRow(find(), $('tree'), '.grp');
  });
}

function revealRow(el, box, stickySel) {
  if (!el || !box) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const st = stickySel ? box.querySelector(stickySel) : null;
  const cover = st ? st.getBoundingClientRect().height : 0;
  const top = b.top + cover;              // the first line the reader can actually see
  if (r.top < top) box.scrollTop -= (top - r.top);
  else if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom);
}

function stepSelection(delta, edge) {
  const rows = [...$('tree').querySelectorAll('.f[data-path]')].filter((el) => el.offsetParent !== null);
  if (!rows.length) return;
  // The anchor is remembered here, not read back from the tree. Opening a function reads its file,
  // so `aria-selected` lands a tick later: holding the arrow down asked the DOM where it was before
  // the DOM knew, found nothing, and started from the top again - every press selecting the first
  // row. Measured by pressing twice and landing on row one. The attribute is still the truth for a
  // screen reader; this is just what the keyboard steps from.
  const cur = rows.find((r) => r.dataset.path === stepAnchor)
    || $('tree').querySelector('.f[data-path][aria-selected="true"]');
  let i;
  if (edge === 'first') i = 0;
  else if (edge === 'last') i = rows.length - 1;
  else {
    const at = cur ? rows.indexOf(cur) : -1;
    i = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
  }
  const el = rows[i];
  if (!el || el === cur) return;
  stepAnchor = el.dataset.path;
  // **The row is clicked, not opened as a function.** This list is the functions tree in one mode
  // and modules, workflows, schedules, actions or connections in the others, and each row already
  // carries what opening it means. Calling openFromTree() on all of them read an action's row as a
  // path to a .dg file and answered «A requested file or directory could not be found» - reported
  // from the Actions tab. A click is the one thing every row knows how to be.
  el.click();
  // The group header is sticky here, and it is the previous group's label that covers the row you
  // have just stepped up onto.
  revealRow(el, $('tree'), '.grp');
}
