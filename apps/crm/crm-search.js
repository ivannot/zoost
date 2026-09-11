// ---------- controls ----------
// Each mode keeps its own filter, and the value was read and written by two ternary chains over the
// same six variables - the shape that drifts the moment a seventh mode is added to one of them.
const curFilter = () => viewMode === 'functions' ? typeFilter : viewMode === 'modules' ? moduleFilter
  : viewMode === 'workflows' ? workflowFilter : viewMode === 'schedules' ? scheduleFilter
  : viewMode === 'actions' ? actionFilter : connCatFilter;
function setCurFilter(k) {
  if (viewMode === 'functions') typeFilter = k; else if (viewMode === 'modules') moduleFilter = k;
  else if (viewMode === 'workflows') workflowFilter = k; else if (viewMode === 'schedules') scheduleFilter = k;
  else if (viewMode === 'actions') actionFilter = k; else connCatFilter = k;
}
// Which of the two is narrowing, named. «The type filter» over a list held down by the language one
// sends the reader to clear a control that is already at All, and «No matches» stays on screen.
function narrowingName() {
  const on = [typeFilter !== 'all' && 'type', langFilter !== 'all' && 'language'].filter(Boolean);
  return on.length === 2 ? 'type and language filters are' : `${on[0]} filter is`;
}
let _buildTypeChips = null;
function buildTypeChips() {
  if (!_buildTypeChips) _buildTypeChips = createCrmTypeChips({
    $,
    getViewMode: () => viewMode, NS, LANG_FAMILY, langFamily, langFamilyLabel,
    // automation.js is loaded after this panel. Keep the dependency lazy so the initial
    // Functions render does not touch its lexical binding before that script exists.
    actionKindLabel: (value) => actionKindLabel(value),
    getActionData: () => actionData, getCurFilter: curFilter, setCurFilter,
    getLangFilter: () => langFilter, setLangFilter: (value) => { langFilter = value; },
    getActionSort: () => actionSort, setActionSort: (value) => { actionSort = value; },
    getActionSortDir: () => actionSortDir, setActionSortDir: (value) => { actionSortDir = value; },
    getTreeSort: () => treeSort, setTreeSort: (value) => { treeSort = value; },
    getTreeSortDir: () => treeSortDir, setTreeSortDir: (value) => { treeSortDir = value; },
    TREE_SORTS, lastModified: MSG.lastModified, getTreeData: () => treeData,
    runSearch: (...args) => runSearch(...args),
    // These renderers live in scripts loaded after the panel. Pass lazy adapters so the initial
    // filter bar can be built before those classic-script bindings exist.
    renderModules: (...args) => renderModules(...args),
    renderWorkflows: (...args) => renderWorkflows(...args),
    renderSchedules: (...args) => renderSchedules(...args),
    renderActions: (...args) => renderActions(...args),
    renderConnections: (...args) => renderConnections(...args),
    renderTree: (...args) => renderTree(...args),
  });
  return _buildTypeChips();
}
$('nameToggle').onclick = () => {
  if (viewMode === 'functions') {
    nameMode = nameMode === 'internal' ? 'display' : 'internal';
    $('nameToggle').textContent = MSG.namePrefix + nameMode;
    renderTree(); if (currentPath) showCallers(currentPath); redrawNavMenu();
  } else {
    moduleNameMode = moduleNameMode === 'api' ? 'display' : moduleNameMode === 'display' ? 'generated' : 'api';
    $('nameToggle').textContent = MSG.namePrefix + moduleNameMode;
    renderModules(); redrawNavMenu();
  }
};


// Emptying the chain does not close what is open: the reader asked to forget where they have been,
// not to lose the thing they are reading. The step they are on is kept as the only entry, so the
// next link still has something to come back to.
$('navtab').onclick = () => toggleNavMenu();
$('codecopy').onclick = () => copyCode($('pvcode').textContent);
$('navfind').oninput = renderNav;
// The history's own Name. It moves *both* namings: it used to move the functions and leave the
// modules on whatever the Modules tab was set to, so half the chain answered the button - reported.
// A module has three names and a function two, so «internal» here is the api name for both, which is
// the pair a reader is switching between. A rule, a schedule, an action and a connection have one
// name each and cannot follow; that is Zoho's doing and is said in the guide rather than hidden.
// The lists underneath are redrawn as well: there is one naming, and coming out of the history onto
// a tree still labelled the old way is two lists disagreeing about the same item.
$('navname').onclick = () => {
  nameMode = nameMode === 'internal' ? 'display' : 'internal';
  moduleNameMode = nameMode === 'internal' ? 'api' : 'display';
  $('navname').textContent = MSG.namePrefix + nameMode;
  renderNav(); renderTree(); renderModules();
};
$('navclear').onclick = () => {
  navHistory.keepCurrent();
  updateNav(); renderNav();
};
$('navx').onclick = () => navShow(false);
$('pvback').onclick = () => navTo(navHistory.snapshot().position - 1);
$('pvfwd').onclick = () => navTo(navHistory.snapshot().position + 1);
// Alt+arrows, because that is what a browser answers to and the hands already know it. Left alone
// inside a field, where the arrows belong to the text.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navOpenNow()) { navShow(false); return; }
  if (!e.altKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
  const at = navHistory.snapshot().position;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navTo(at - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navTo(at + 1); }
});

$('tree').addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  const edge = { Home: 'first', End: 'last' }[e.key];
  if (!step && !edge) return;
  e.preventDefault();
  stepSelection(step || 0, edge);
});

function paintSearchControls(state = searchState.snapshot()) {
  const fullText = viewMode === 'functions' && state.mode === 'content';
  $('find').value = state.text;
  $('smode').textContent = fullText ? 'in: code' : 'in: names';
  $('smode').classList.toggle('on', fullText);
  $('find').placeholder = fullText ? MSG.findInCode : MSG.findByName;
  $('rxmode').classList.toggle('on', state.regex);
  $('rxmode').style.display = $('rxpick').style.display = fullText ? '' : 'none';
  if (!fullText) $('rxmenu').classList.remove('show');
}

$('find').oninput = () => { searchState.setText($('find').value); runSearch(); };
$('findx').onclick = () => { paintSearchControls(searchState.setText('')); runSearch(); $('find').focus(); };
$('smode').onclick = () => {
  if (viewMode !== 'functions') return;   // full-text search applies to function code only
  // Leaving full-text with the pattern on takes the pattern with it, like the toggle going off:
  // a regex read as a name filter is a search for text that does not exist. Reported.
  paintSearchControls(searchState.toggleMode());
  runSearch();
};
$('rxmode').onclick = () => {
  // Switching the toggle off clears the box: a pattern read as a literal is a search for text
  // that does not exist, and the reader would be left staring at «no matches» for \b\d{18}\b.
  // Switching it on keeps what was typed - a literal is often the seed of the pattern.
  paintSearchControls(searchState.toggleRegex());
  runSearch();
};
// The saved patterns, offered where they are used. The background seeds the first two; the list
// itself lives in Settings, where it can be added to, edited and emptied; the menu reads it
// fresh on every open, and can append to it - its Save row, when there is a pattern to save.
async function loadRxShortcuts() {
  try {
    const st = await chrome.storage.local.get('rxShortcuts');
    return Array.isArray(st.rxShortcuts)
      ? st.rxShortcuts.filter((x) => x && typeof x.name === 'string' && typeof x.pattern === 'string' && x.name && x.pattern)
      : [];
  } catch (_) { return null; }   // null, not []: a read that failed is not an empty list
}
async function openRxMenu() {
  const menu = $('rxmenu');
  const list = await loadRxShortcuts();
  // The read yielded: the tab, the mode or the workspace may have moved meanwhile, and every one of
  // those hides the button. A menu for a control that is no longer there is not opened.
  if ($('rxpick').style.display === 'none') return;
  // Alphabetical by name, the way a reader scans a menu - storage order is append order, which
  // says when a pattern was saved and nothing else. The Settings list keeps storage order: rows
  // being edited must not reshuffle under the hands renaming them.
  const items = (list || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const search = searchState.snapshot();
  const rawQ = search.text.trim();
  // The save row exists only when there is something it could do: a pattern in the box that parses,
  // regex mode on, and a list that was actually read - saving over one that was not would overwrite
  // entries nobody has seen. A control that can do nothing goes away rather than sitting there.
  const savable = list !== null && search.regex && rawQ && !!rxCompile(rawQ).re;
  // A pattern already in the list is named, not re-offered: a second copy would be two menu
  // entries that search identically, and the name is how the reader finds the one they have.
  const already = savable ? items.find((x) => x.pattern === rawQ) : null;
  menu.innerHTML = items.map((x, i) => `<button data-rx="${escA(i)}"><span>${escHtml(x.name)}</span><span class="rxpat">${escHtml(x.pattern)}</span></button>`).join('')
    + (already ? `<div class="rxsave"><span class="rxnote">This pattern is already saved as "${escHtml(already.name)}".</span></div>`
      : savable ? `<div class="rxsave"><input id="rxsavename" placeholder="Name this pattern\u2026" maxlength="60" aria-label="Name for the pattern in the search box"><button data-save="1" title="Save the pattern in the search box under this name">Save</button><div class="rxerr" id="rxsaveerr"></div></div>` : '')
    + `<button class="rxman" data-man="1">${list === null ? 'The saved patterns could not be read. ' : (items.length ? '' : 'No saved patterns yet. ')}Manage\u2026</button>`;
  menu.querySelectorAll('[data-rx]').forEach((b) => {
    b.onclick = () => {
      menu.classList.remove('show');
      // The same guard as above, one interaction later: a pattern applied into a view whose search
      // no longer offers regex would filter names by a literal `\\b\\d{18}\\b`.
      if ($('rxpick').style.display === 'none') return;
      const x = items[+b.dataset.rx];
      paintSearchControls(searchState.usePattern(x.pattern));
      runSearch();
    };
  });
  const sv = menu.querySelector('[data-save]');
  if (sv) {
    const doSave = () => saveSearchPattern(items, rawQ);
    sv.onclick = doSave;
    $('rxsavename').onkeydown = (e) => {
      // The panel's own shortcuts stay out of the input; Escape still bubbles to close the menu.
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key === 'Enter') doSave();
    };
  }
  menu.querySelector('[data-man]').onclick = () => { menu.classList.remove('show'); openSettings('#rx'); };
  const r = $('rxpick').getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.classList.add('show');
}

/** Save the pattern in the box under a name, or say why it cannot be saved.
 *
 * A declaration rather than an `= async () => {}`, which is a scope the race checker cannot enter -
 * and there is an await in the middle of it. `items` is carried in rather than read again: it is the
 * list the menu was drawn from, and the whole point of the two checks above the write is that they
 * are about *that* list.
 */
async function saveSearchPattern(items, rawQ) {
  const name = $('rxsavename').value.trim();
  // The same rules the Settings page enforces, refused with the reason in place.
  if (!name) { $('rxsaveerr').textContent = 'A pattern needs a name.'; return; }
  if (items.some((x) => x.name.trim().toLowerCase() === name.toLowerCase())) {
    $('rxsaveerr').textContent = `"${name}" is already taken - the menu could not tell them apart.`;
    return;
  }
  const dupP = items.find((x) => x.pattern === rawQ);
  if (dupP) { $('rxsaveerr').textContent = `This pattern is already saved as "${dupP.name}".`; return; }
  try { await chrome.storage.local.set({ rxShortcuts: [...items, { name, pattern: rawQ }] }); }
  catch (_) { $('rxsaveerr').textContent = 'Could not write the list - try from Settings.'; return; }
  openRxMenu();   // re-read and redraw: the new entry appearing in the list is the confirmation
}

$('rxpick').onclick = (ev) => {
  ev.stopPropagation();
  const menu = $('rxmenu');
  if (menu.classList.contains('show')) { menu.classList.remove('show'); return; }
  openRxMenu();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#rxmenu') && !e.target.closest('#rxpick')) $('rxmenu').classList.remove('show');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('rxmenu').classList.remove('show'); });

function runSearch() {
  const search = searchState.snapshot();
  // A contentSearch cannot be cancelled once running; what can be done is make its result refuse to
  // land. Any newer search - or the render of an emptied box - moves the sequence past it.
  searchSeq++;
  // The open preview shows the same search: matches painted in the source, cleared when the search
  // empties, changes mode or stops parsing - one call, because null clears.
  paintFindMarks($('pvcode'), findMarkRe());
  if (viewMode === 'modules') { renderModules(); return; }
  if (viewMode === 'workflows') { renderWorkflows(); return; }
  if (viewMode === 'schedules') { renderSchedules(); return; }
  if (viewMode === 'actions') { renderActions(); return; }
  if (viewMode === 'connections') { renderConnections(); return; }
  if (search.mode === 'content') { clearTimeout(_searchT); _searchT = setTimeout(contentSearch, 220); }
  else renderTree();
}

// Where a pattern matches inside one text, as [start, end) pairs - the pure half of the detail
// highlighter, lifted alone by tests/slice.mjs. Zero-length matches are stepped over, the same
// guard as everywhere else a user pattern runs.
function matchSpans(text, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex > text.length) break; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Paint every match of the active full-text search inside `root`, through the CSS Custom Highlight
// API: ranges over the rendered text nodes, no DOM mutation - so the syntax colouring underneath is
// untouched, and a match that crosses its token boundaries still paints whole. Byte-identical in
// both panels; the ::highlight(zoost-find) rule in each page gives the marks their colour.
function paintFindMarks(root, re) {
  if (!('highlights' in CSS)) return;   // without the API the search still works, unpainted
  CSS.highlights.delete('zoost-find');
  if (!root || !re) return;
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ n, at: text.length }); text += n.nodeValue; }
  const spans = matchSpans(text, re);
  if (!spans.length) return;
  const ranges = [];
  let i = 0;
  for (const [a, b] of spans) {
    while (i + 1 < nodes.length && nodes[i + 1].at <= a) i++;
    let j = i;
    while (j + 1 < nodes.length && nodes[j + 1].at < b) j++;
    const r = new Range();
    r.setStart(nodes[i].n, a - nodes[i].at);
    r.setEnd(nodes[j].n, b - nodes[j].at);
    ranges.push(r);
  }
  CSS.highlights.set('zoost-find', new Highlight(...ranges));
}

// The active full-text search as a compiled pattern, or null when there is nothing to paint: name
// mode, an empty box, or a pattern that does not parse.
function findMarkRe() {
  const search = searchState.snapshot();
  if (search.mode !== 'content') return null;
  const q = search.text.trim();
  if (!q) return null;
  if (!search.regex) return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
  return rxCompile(q).re || null;
}

// The search text as a pattern, or the reason it is not one. Case-insensitive like the plain
// search, and `m` so ^ and $ mean "at a line edge", which is what a reader of code or SQL expects.
// A declaration rather than an arrow because `tests/slice.mjs` lifts it out and runs it alone, and
// byte-identical in both panels: a test holds the twins to the same source.
function rxCompile(term) {
  try { return { re: new RegExp(term, 'gim') }; } catch (e) { return { error: String((e && e.message) || e) }; }
}

// One line with every match wrapped in <mark>, escaped piece by piece - escaping first and then
// matching the escaped text would miss any pattern that touches `<` or `&`. A zero-length match is
// stepped over rather than marked: `x*` matches the empty string everywhere, and the escaper is a
// parameter because the two panels name theirs differently.
function markLine(line, re, escFn) {
  let out = '';
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(line))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex > line.length) break; continue; }
    out += escFn(line.slice(last, m.index)) + '<mark>' + escFn(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escFn(line.slice(last));
}


/** Read one function's source into the map being built, or leave it out.
 *
 * A declaration rather than an `async (e) => {}` inside a `map`: the checker cannot enter one, and a
 * read that fails silently is the shape this repository has already paid for twice. It stays silent
 * here on purpose - the map is «what could be read», the search says how many it holds, and a file
 * that has gone since the tree was drawn is not an error to report.
 */
async function readSourceInto(m, e, op) {
  try {
    const paths = (e.mirrorFiles || [e.path]).filter((p) => !p.endsWith('.meta.json'));
    const sources = [];
    for (const p of paths) sources.push({ path: p, code: await op.read(p) });
    m.set(e.id, sources);
  } catch (_) {}
}

/** Every source, once. Searching text means having read it - there is no index that spares this, and
 *  writing one would be a second answer to «what does this function say» that could disagree with the
 *  file. What can be spared is the *waiting*: the reads happen in tranches with a yield between them,
 *  the status line counts them off, and the cache is kept for the rest of the session, so this is
 *  paid once per workspace and never again until a pull changes something.
 *
 *  Measured on a generated org of 5,000 functions: 20,000 file-system calls the first time, none
 *  after. Before this, the panel simply stopped answering for the whole of it.
 */
async function getCodeCache(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (codeCache) return codeCache;
  const m = new Map();
  const rows = treeData.filter((e) => e.downloaded);
  const TRANCHE = 120;
  for (let i = 0; i < rows.length; i += TRANCHE) {
    await Promise.all(rows.slice(i, i + TRANCHE).map((e) => readSourceInto(m, e, op)));
    if (rows.length > TRANCHE) {
      op.say(`Reading sources ${Math.min(i + TRANCHE, rows.length)}/${rows.length}\u2026`, 'busy');
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (!op.current()) return null;
  // The line this loop opened is closed by the loop: a «busy» status left standing reads as a hang,
  // and it stood - «Reading sources 150/150…» with the spinner going, over a search long finished.
  // The Analytics twin (ensureSqlCache) has always closed its own. Reported.
  if (rows.length > TRANCHE) op.say(`${m.size} source(s) read.`, 'ok');
  codeCache = m; return m;
}
async function contentSearch() {
  const op = beginWorkspaceOp();
  const search = searchState.snapshot();
  const term = search.text.trim(); const tree = $('tree');
  if (!term) { renderTree(); return; }
  const rx = search.regex ? rxCompile(term) : null;
  if (rx && rx.error) {
    // «No matches» for a pattern that never ran would be the lie this panel exists to refuse.
    tree.innerHTML = `<div class="treemsg"><b>The pattern does not parse.</b> ${escHtml(rx.error)}. Nothing was searched - fix the pattern or switch .* off.</div>`;
    return;
  }
  const mine = searchSeq;
  tree.innerHTML = '<div class="treemsg">Searching\u2026</div>';
  const cache = await getCodeCache(op); if (mine !== searchSeq || !cache || !op.current()) return;
  const tl = term.toLowerCase();
  const results = [];
  // What the sentence below has to be able to say. «No matches» is the whole answer on this
  // surface, and it was given without mentioning that the Type filter had excluded 108 of 120
  // functions - a true sentence about a search that never looked. The Analytics twin names its
  // narrowing in the same situation; this is the same fact in the same voice.
  let searched = 0;
  for (const e of treeData) {
    if (!e.downloaded || !passRow(e)) continue;
    searched++;
    const cached = cache.get(e.id); if (!cached) continue;
    const sources = Array.isArray(cached) ? cached : [{ path: e.path, code: cached }];
    for (const source of sources) {
      const code = source.code; let idx = -1, count = 0;
      if (rx) {
        const re = rx.re; re.lastIndex = 0; let m;
        while ((m = re.exec(code))) {
          if (!m[0]) { re.lastIndex++; if (re.lastIndex > code.length) break; continue; }
          if (idx < 0) idx = m.index;
          count++;
        }
        if (idx < 0) continue;
      } else {
        const lc = code.toLowerCase(); idx = lc.indexOf(tl); if (idx < 0) continue;
        let i = idx; while (i >= 0) { count++; i = lc.indexOf(tl, i + tl.length); }
      }
      const ls = code.lastIndexOf('\n', idx) + 1; let le = code.indexOf('\n', idx); if (le < 0) le = code.length;
      const lineNo = code.slice(0, idx).split('\n').length;
      results.push({ e, path: source.path, count, lineNo, line: code.slice(ls, le).trim().slice(0, 140) });
    }
  }
  results.sort((a, b) => b.count - a.count || labelOf(a.e).localeCompare(labelOf(b.e)));
  tree.innerHTML = '';
  if (!results.length) {
    const narrowing = (typeFilter === 'all' && langFilter === 'all')
      ? 'The search box was' : `The ${narrowingName()} and the search box were`;
    tree.innerHTML = `<div class="treemsg"><b>No matches for "${escHtml(term)}".</b> `
      + `${narrowing} applied to ${searched} of ${treeData.length} function(s) - the rest were not searched. `
      + `${(typeFilter === 'all' && langFilter === 'all') ? 'Only downloaded source is searched.'
           : 'Set them to All to search them.'}</div>`;
    return;
  }
  const total = results.reduce((n, r) => n + r.count, 0);
  const hdr = document.createElement('div'); hdr.className = 'srhdr'; hdr.textContent = `${total} match(es) in ${results.length} file(s)`; tree.appendChild(hdr);
  const hlRe = rx ? rx.re : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
  results.forEach((r) => {
    const el = document.createElement('div'); el.className = 'sr'; el.dataset.path = r.path;
    const hi = markLine(r.line, hlRe, escHtml);
    const fileName = r.path === r.e.path ? '' : ` · ${r.path.split('/').pop()}`;
    el.innerHTML = `<div class="srname">${escHtml(labelOf(r.e) + fileName)} <span class="srcount">${r.count}</span></div><div class="srline"><span class="srln">${r.lineNo}</span> ${hi}</div>`;
    el.onclick = () => openFile(r.path, r.lineNo, true);   // the exact project file and line that matched
    tree.appendChild(el);
  });
}

