/*
 * history-controller.js - browser-like CRM item history and its overlay.
 *
 * The pure walk lives in navigation.js; this controller maps its entries to CRM items and DOM.
 * Control bindings stay in sidepanel.js so this slice performs no work while scripts load.
 */
// ---------- history: the chain you have walked, and the way back up it ----------
// A browser's three: back, forward, and the list itself, because «back» alone only reaches the step
// before - the author asked to be able to «risalire la catena», which is the list.
//
// Keyed by `currentPath`, which every opener in this panel sets and whose prefix says what kind of
// thing it is; `navOpen()` is that discrimination once, in the order `aiFocusLabel()` already uses.
// A new tab joins the history by setting `currentPath` like its siblings, with nothing to add here.
const NAV_MAX = 50;
const navHistory = createNavigationState(NAV_MAX);

/** Record where we have just arrived. Called by the openers, so every way in is covered - a click in
 *  the tree, an arrow key, a search result, a link in a code pane or in «Used in». A step onto the
 *  item already showing is not a step: re-opening after a pull would otherwise fill the chain with
 *  the same name. `n` is the unique runtime id - the menu's key, and the reason a place visited
 *  twice stays two rows rather than collapsing into one. */
function navHere(label) {
  if (!currentPath) return;
  const changed = navHistory.record(currentPath,
    { path: currentPath, label: label || currentPath.split('/').pop() });
  if (!changed) return;   // replay is an arrival on screen, not a new step in the walk
  updateNav();
}
/** The name the header ended up showing is the name the chain shows. Openers know their item's real
 *  name at different moments - some after reading the file - so the label is taken from the one
 *  funnel they all pass through rather than from six call sites that could each forget. */
function navLabel(name) {
  if (name && navHistory.updateCurrent({ label: name })) updateNav();
}
/** The names this item is known by, kept on the step itself.
 *
 *  Deriving them at draw time from `treeData` worked only while the reader was on the tab that holds
 *  them: in Workflows, `treeData` is the rules, so every function in the chain fell back to its file
 *  name and the panel showed `alertcompito....dg`. Reported with a picture. Recorded here instead,
 *  where the opener has just read the row, so which tab is open afterwards cannot change what a step
 *  is called.
 */
function navNames(names) {
  if (names && navHistory.updateCurrent({ names })) updateNav();
}
function navClear() { navHistory.clear(); closeNavMenu(); updateNav(); }

async function navOpen(p) {
  const find = (arr) => (arr || []).find((x) => x.path === p);
  const gone = () => setStatus(MSG.navGone, 'warn');
  // Only when the tab actually changes. `setMode()` closes the detail pane - it has to, the pane is
  // showing something from the tab being left - so calling it for a step that is already on this tab
  // made every «back» close the pane, select the row and reopen it. Reported as a flicker, and it is
  // one: the reader is looking at the pane, and the pane is what blinked.
  const goMode = (m) => { if (viewMode !== m) setMode(m); };
  // A step can point into an area the role has stopped granting - the mirror still has the files,
  // the tab is gone. Same refusal as every other jump, from the one guard.
  if (!tabReachable(navKind(p) === 'function' ? 'functions' : navKind(p) + 's')) return;
  if (p.startsWith('workflows/')) { goMode('workflows'); await rebuildWorkflows(); const e = find(workflowData); return e ? openWorkflow(e) : gone(); }
  if (p.startsWith('schedules/')) { goMode('schedules'); await rebuildSchedules(); const e = find(scheduleData); return e ? openSchedule(e) : gone(); }
  if (p.startsWith('connections/')) { goMode('connections'); await rebuildConnections(); const e = find(connectionData); return e ? openConnection(e) : gone(); }
  if (p.startsWith('actions/')) { goMode('actions'); await rebuildActions(); const e = find(actionData); return e ? openAction(e) : gone(); }
  if (p.startsWith('modules/')) { goMode('modules'); await rebuildModules(); return openModule(p); }
  // Functions were the one kind here that opened without asking whether there is anything to open -
  // every other branch answers `gone()`. A step to a function whose source this mirror does not hold
  // says which of the two it is, in the same words the row does, instead of closing the pane.
  goMode('functions');
  // **By the row that owns the path, not by the path itself.** A step onto a file inside a compiled
  // project - `x.files/lib/helper.js` - is not any row's `path`, which is the project's entry point,
  // so this answered «that is no longer here» about a file the mirror was holding and the reader had
  // just been looking at. Reported as history behaving differently inside a Java or Node project.
  const fe = functionRowForPath(p);
  if (fe && fe.mirrored === false) { selectRow(p); setStatus(MSG.notMirrored(langLabel(fe.language)), 'warn'); return; }
  if (fe && !fe.downloaded) { selectRow(p); return void fetchThenRedrawRow(fe); }
  if (!fe) return gone();
  return openFile(p);
}

/** Go to step `i`. The position moves even when the item turns out not to be there any more - the
 *  same thing a browser does with a page that has since 404'd, and the status line says which it
 *  was. Pretending the step never existed would be worse: the chain is a record of where the reader
 *  went, not a claim that all of it still exists. */
async function navTo(i) {
  const e = navHistory.startReplay(i);
  if (!e) return;
  navShow(false); updateNav();
  try { await navOpen(e.path); } finally { navHistory.finishReplay(); }
}

// Each control is there only when it can do something, which is this panel's rule for the retry
// button, for Clear and for Forget. An arrow greyed out is a control saying «not now» in a place
// where nothing is ever going to make it work except walking somewhere first.
function updateNav() {
  const state = navHistory.snapshot();
  $('pvback').classList.toggle('show', state.canBack);
  $('pvfwd').classList.toggle('show', state.canForward);
  const seg = $('navtab');
  if (seg) seg.style.display = state.entries.length ? '' : 'none';   // nowhere to go, nothing to offer
}
function closeNavMenu() { navShow(false); }
// Open it, or draw it again where it already is - the second is what the name toggle needs, and
// without it the chain kept the old names until it was closed and reopened.
function redrawNavMenu() { if (navOpenNow()) renderNav(); }
const navOpenNow = () => $('navview').classList.contains('show');
function navShow(on) {
  $('navview').classList.toggle('show', on);
  // The same class the health and AI views set, driving the same rules: while this is up, every
  // other control in the toolbar is dimmed and inert. Three views of the workspace, one behaviour.
  document.body.classList.toggle('nav-open', on);
  if (on) $('navname').textContent = MSG.namePrefix + nameMode;
  const seg = $('navtab');
  if (seg) { seg.classList.toggle('on', on); seg.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  if (on) renderNav();
}
function toggleNavMenu() { navShow(!navOpenNow()); }
/** The chain, drawn full width. Newest first - the reader is looking for where they were a moment
 *  ago, not for where they started - and the step they are on is marked rather than left out. */
function renderNav() {
  const body = $('navbody');
  const state = navHistory.snapshot();
  const navHist = state.entries, navPos = state.position;
  // The same search box as every other tab, filtering the same way: by the name on screen, which is
  // the one `navLabelNow()` decides. A history that ignored the box while sitting in its place would
  // be a list that looks like the others and does not behave like them.
  const q = ($('navfind').value || '').trim().toLowerCase();
  const rows = navHist.map((e, i) => ({ e, i }))
    .filter(({ e }) => !q || navLabelNow(e).toLowerCase().includes(q) || navKind(e.path).includes(q));
  $('navcount').textContent = navHist.length
    ? `${rows.length === navHist.length ? navHist.length : rows.length + ' of ' + navHist.length} step${navHist.length > 1 ? 's' : ''}`
    : '';
  if (!navHist.length) {
    body.innerHTML = '<div class="nvnone">Nothing yet. Open a function, a rule or a module and every '
      + 'step you take is listed here - click one to go back to it.</div>';
    return;
  }
  if (!rows.length) { body.innerHTML = `<div class="nvnone">${escHtml(MSG.narrowNav)}</div>`; return; }
  body.innerHTML = rows.map(({ e, i }) => `<div class="nvrow${i === navPos ? ' at' : ''}" data-i="${escA(String(i))}" title="${escA(e.path)}">`
    + `<span class="nvk">${escHtml(navKind(e.path))}</span><span class="nvl">${escHtml(navLabelNow(e))}</span>`
    + `<span class="nvw">${escHtml(navWhen(e.at))}</span></div>`).reverse().join('');
  body.querySelectorAll('.nvrow').forEach((r) => { r.onclick = () => navTo(Number(r.dataset.i)); });
}
// What kind of thing a step was, from the same prefix navOpen() dispatches on - so the chain reads
// «workflow Invoice overdue» rather than a bare name that could be any of six things.
// When a step was taken. A real fact rather than something to fill a row with: with a chain that
// spans a session, «which of these two did I look at first» is a question the reader actually has,
// and the panel is the only thing that knows. Today's steps show the time alone - the date would be
// noise on every row - and anything older carries its day.
function navWhen(ms) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const sameDay = d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
    && d.getFullYear() === today.getFullYear();
  return sameDay ? t : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${t}`;
}
/** What to call a step *now*.
 *
 * The label captured when the step was taken is a fallback, not the answer: this panel lets the
 * reader switch between a function's display name and its api name, and between three names for a
 * module, and a chain still reading «Build invoice» while the tree reads `buildInvoice` is two lists
 * disagreeing about the same item. Reported. So the name is derived at draw time from the same rows
 * the tree and the module list derive theirs from - one source, so they cannot drift - and the
 * stored label is used only for something no longer in the mirror.
 */
function navLabelNow(e) {
  const n = e.names;
  if (e.path.startsWith('modules/')) {
    if (n) return (moduleNameMode === 'display' ? n.display : moduleNameMode === 'generated' ? n.gen : n.api) || e.label;
    const m = moduleData.find((x) => x.path === e.path);
    return m ? (moduleNameMode === 'display' ? m.label : moduleNameMode === 'generated' ? m.gen : m.api_name) : e.label;
  }
  if (e.path.startsWith('functions/')) {
    if (n) return (nameMode === 'display' ? n.display : n.api) || e.label;
    const f = treeData.find((x) => x.path === e.path);
    return f ? labelOf(f) : e.label;
  }
  return e.label;   // a rule, a schedule, an action, a connection: one name each, and it was recorded
}
function navKind(p) {
  if (p.startsWith('workflows/')) return 'workflow';
  if (p.startsWith('schedules/')) return 'schedule';
  if (p.startsWith('connections/')) return 'connection';
  if (p.startsWith('actions/')) return 'action';
  if (p.startsWith('modules/')) return 'module';
  // `.dg` is the extension Zoho gives a Deluge function's source, so every function in the chain
  // was labelled «diagram». Reported. The kinds here are the ones `navOpen()` dispatches on, and
  // functions are its default: nothing else in this panel opens a file that is not one of the five
  // above.
  return 'function';
}
