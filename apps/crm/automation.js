/*
 * automation.js - the three list views over what the org runs on its own: schedules, workflow rules,
 * and the actions the rules fire. One file rather than three, because they lean on each other - the
 * actions census joins against the workflow files on disk, and the workflows pull is what refreshes
 * the action users - while the rest of the panel reaches all of it through the per-tab handful
 * (pull*, rebuild*, render*, open*). Fourth slice, and the one that loads AFTER sidepanel.js: its
 * ACTION_SORTS initializer reads MSG.lastModified at load time, and MSG lives in sidepanel.js -
 * while nothing in sidepanel's own top level reads a name from here outside a closure. Proven both
 * ways in an empty scope: this file loads with MSG alone, and needs it.
 */

// ---------- schedules ----------
async function loadScheduleIndex(op = beginWorkspaceOp()) {
  // These read the mirror and then publish a whole list into the panel's memory. A rebuild is
  // short, but it is not instant, and what overtakes it is a change of workspace - so the list of
  // one org arrived in the panel showing another. Found by `tools/asynccheck.py`, which derives
  // this class instead of waiting for the next reader to notice an instance of it.
  let idx = []; try { idx = JSON.parse(await op.read('schedules/index.json')); } catch (_) {}
  if (!op.current()) return false;
  scheduleData = idx.map((e) => ({ ...e, id: String(e.id), path: 'schedules/' + String(e.id) }));
  return true;
}
// ---------- blueprints ----------
// A blueprint is the process a record walks through: states, and transitions between them that can
// update fields and call functions. That is the whole reason this area exists - without it a field
// written by a transition looks written by nobody, and a function a transition calls looks called by
// nobody. Read like schedules (one list, written whole) and shown like them: no tab strip, one table
// in the preview, because a blueprint has no second thing to look at until transitions are read.
async function loadBlueprintIndex(op = beginWorkspaceOp()) {
  // Same reason as `loadScheduleIndex` above: this publishes a whole list into the panel's memory
  // after a read, and what overtakes a read is a change of workspace.
  let idx = []; try { idx = JSON.parse(await op.read('blueprints/index.json')); } catch (_) {}
  // What is already on disk, read from the folder rather than remembered: the index is a list of
  // what Zoho has, and `downloaded` is a fact about this mirror. Same walk the workflow loader does,
  // and for the same reason - a row that says «read» when its file is absent opens nothing.
  const have = new Set();
  for await (const p of walk(op.root)) {
    if (!op.current()) return false;
    if (p.startsWith('blueprints/') && p.endsWith('.json') && !p.endsWith('/index.json')) have.add(p.split('/').pop().replace(/\.json$/, ''));
  }
  if (!op.current()) return false;
  // `.json` like every other per-item path, and for two reasons rather than tidiness: a detail read
  // writes to `entry.path`, and the pruning of files Zoho no longer has filters on `.endsWith('.json')`
  // - so an extension-less path would write files nothing recognises and nothing ever removes. The
  // four readers of this path (the history routing, its kind, and the two AI lookups) all test the
  // `blueprints/` prefix and none of them looks at the suffix, which is what makes this safe.
  // **One resolver, filled here, used by both the list and the pane.** The label was looked up in
  // `moduleData` - which only the Modules rebuild fills - so a blueprint seen before that tab had
  // been opened showed the API name. Fixing it in the pane alone left the list still wrong, which is
  // how the same report came back four times. `renderBlueprints` is synchronous (the search calls
  // it), so the read cannot happen there: it happens once here, for the distinct modules only.
  bpModLabel = new Map();
  // **From disk, not from `moduleData`.** That list is in memory and only the Modules tab fills it,
  // so opening Blueprints first left it empty - and then a standard module still resolved, because
  // its file is named by the same api name the blueprint carries, while a custom one could not:
  // learning that `CustomModule20` is stored as `Iscrizioni.json` needs the index row. That is why
  // this survived five fixes: it worked for every module except the ones the reader asked about.
  let modIdx = []; try { modIdx = JSON.parse(await op.read('modules/index.json')); } catch (_) {}
  if (!op.current()) return false;
  const modRows = (Array.isArray(modIdx) && modIdx.length) ? modIdx : (moduleData || []);
  for (const api of new Set(idx.map((e) => e && e.module).filter(Boolean))) {
    // **The fields that exist, measured.** This asked for `row.label`, and a row here comes from
    // `modules/index.json`, which carries `api_name`, `module_name` and counts and has never had a
    // `label` - so the fast path could not fire once, and every group header depended on the file
    // read below. It is the fifth report of a module drawn by its API name; the branch was there the
    // whole time and was reading a field nobody writes.
    // **Two names, and Zoho swaps which field carries which.** Measured on a real org: in the modules
    // index a custom module is `api_name: "Iscrizioni"` with `module_name: "CustomModule20"`, while
    // the blueprints reply puts `CustomModule20` into a field it also calls `api_name`. Matching on
    // one key could never hit, and the file read asked for `modules/CustomModule20.json`, which the
    // pull never writes - it names the file by the row's `api_name`. One dimension error, reported
    // five times, and it kept looking like a missing fallback.
    const row = modRows.find((x) => x && (x.api_name === api || x.module_name === api));
    const fileApi = (row && row.api_name) || api;
    let m = null; try { m = JSON.parse(await op.read(`modules/${sanitize(fileApi)}.json`)); } catch (_) {}
    if (!op.current()) return false;
    // The label the org uses, and failing that the readable name the index already carries - which is
    // still better than the internal one, and is what the modules list itself shows.
    const label = (m && (m.plural_label || m.singular_label)) || (fileApi !== api ? fileApi : '');
    // Both halves: the word to draw, and the name every opener needs. The chip carried the blueprint's
    // own value and so opened nothing at all, which is the same error one layer on.
    if (label || fileApi !== api) bpModLabel.set(api, { label: label || fileApi, api: fileApi });
  }
  blueprintData = idx.map((e) => ({ ...e, id: String(e.id), path: `blueprints/${String(e.id)}.json`,
                                    downloaded: have.has(String(e.id)), error: false }));
  return true;
}
async function rebuildBlueprints() {
  const op = beginWorkspaceOp();
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { op.say(MSG.folder, 'warn'); return; }
    op.say('Reading blueprints…', 'busy');
    const _cfg = await opReadCfg(op); if (!op.current()) return; if (_cfg) bound = _cfg; await cacheBinding(bound);
    if (!(await loadBlueprintIndex(op))) return;
    renderBlueprints();
    op.say(blueprintData.length ? `${blueprintData.length} blueprints.`
                                : (emptyReason('blueprints') || 'No blueprints pulled yet - use Pull all.'),
           blueprintData.length ? 'ok' : 'warn');
  } catch (e) { if (op.current()) setStatus(MSG.refreshErr + e.message, 'bad'); }
  if (op.current()) await refreshContext();
}
/** The mark on a blueprint row, derived from what the pull did to it.
 *
 *  It was the literal `st-ok` on every row, so a process Zoho refused sat among the others looking
 *  read while the line above the list counted it as not read - two surfaces of one pull contradicting
 *  each other, and the one carrying the marks was the one that lied. Three states, the same three
 *  every other list here draws: read, never read, and refused with the reason on the row. */
function bpRowState(e) {
  if (e && e.error) {
    return { cls: 'st-err', mark: '⟳',
             title: `Could not be read${e.errorMsg ? ' - ' + e.errorMsg : ''} - click to try again` };
  }
  return e && e.downloaded
    ? { cls: 'st-ok', mark: '●', title: 'In workspace - click to re-read this blueprint from Zoho' }
    : { cls: 'st-no', mark: '○', title: 'Not in the mirror yet - click to read it from Zoho' };
}
function renderBlueprints() {
  if (viewMode !== 'blueprints') return;
  const term = $('find').value.trim().toLowerCase();
  // Grouped by module, which is the thing a blueprint belongs to - the equivalent of grouping
  // schedules by status. A blueprint with no module is possible in the shape the documentation
  // describes, so it gets a group of its own rather than being dropped.
  const byModule = {};
  blueprintData
    .filter((e) => blueprintFilter === 'all' || (blueprintFilter === 'active' ? e.active : !e.active))
    .filter((e) => !term || (e.name || '').toLowerCase().includes(term) || (e.module || '').toLowerCase().includes(term))
    .forEach((e) => (byModule[e.module || '(no module)'] ||= []).push(e));
  const tree = $('tree'); tree.innerHTML = '';
  const keys = Object.keys(byModule).sort();
  if (!keys.length) { tree.innerHTML = '<div class="empty">' + (blueprintData.length ? '<b>No matches.</b>' : (emptyReason('blueprints') || '<b>No blueprints yet.</b> Press <b>Pull all</b> to read them.')) + '</div>'; return; }
  keys.forEach((mod) => {
    const list = byModule[mod].sort(byField('name'));
    // The module's own word, not its API name: a process grouped under «CustomModule20» tells the
    // reader nothing, and `moduleData` already carries the label the org uses. The grouping key stays
    // the API name, which is stable, so a group left collapsed stays collapsed on the pull that fills
    // Modules in and makes the label appear.
    const shownHit = bpModLabel.get(mod);
    const shown = (shownHit && shownHit.label) || mod;
    // The folded state is read next to the header it paints, the way the other four headers read
    // theirs. Four lines of comment had pushed it away from them, and a check that derives the pair
    // from the lines around `className = 'grp'` said so - rightly, because that adjacency is what
    // makes the wiring reviewable at all.
    const isCol = collapsed.has('bp:' + mod);
    const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
    g.innerHTML = `<span class="chev">▾</span><span>${escHtml(shown)}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete('bp:' + mod) : collapsed.add('bp:' + mod); renderBlueprints(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => {
      const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path;
      el.setAttribute('aria-selected', e.path === currentPath);
      // The field the process runs on, not the layout: the layout was «Standard» on all 12 measured,
      // so it spent the row's one informative slot saying nothing. The field is what differs.
      // **The dot is derived, not painted green.** It was the literal `st-ok` on every row, so a
      // blueprint whose detail Zoho refused sat among the others looking read - while the line above
      // the list counted it as not read. Two surfaces of one pull contradicting each other, and the
      // one with the marks was the one that lied. The three states are the ones every other list
      // here draws: read, never read, and refused with the reason on the row.
      const st = bpRowState(e);
      el.innerHTML = `<span class="st ${st.cls}" title="${escA(st.title)}">${st.mark}</span><span>${escHtml(e.name)}</span><span class="wftype">${escHtml(e.field_label || e.field || '')}</span>${e.active ? '' : '<span class="wfoff">off</span>'}`;
      el.querySelector('.st').onclick = (ev) => bpDotClick(ev, e);
      el.onclick = () => openBlueprint(e);
      tree.appendChild(el);
    });
  });
}
/** The dot on a row acts on **that row**, which is what every other per-item list here does.
 *
 *  It called `refreshBlueprints()` - the whole area - so clicking one process re-read all twelve, and
 *  on an org where each carries its transitions that is hundreds of requests for one click. Reported.
 *  The two lists whose dot legitimately re-reads everything are Schedules and Connections, where one
 *  call *is* the whole catalogue and there is nothing smaller to ask for; a blueprint has its own
 *  detail call, so there was no reason beyond the copied line.
 *
 *  Same shape as `wfDotClick`, deliberately: one item, through `runPullAction` so the pull lock and
 *  the busy state behave as they do everywhere, then the list redraws to show the new dot. */
/** One blueprint, whole: the detail **and** what its transitions do.
 *
 *  A dot that fetched only the states left the pane saying the actions had never been read, which is
 *  the opposite of what «read this one» means to whoever clicked it.
 *
 *  A named declaration and not the arrow it started as: `asynccheck` can only enter an async scope
 *  that is a named function, so `async () => {}` is a blind spot in the check that finds globals
 *  written after an await. Its ceiling is zero, so this is converted rather than recorded. */
async function bpReadOne(e) {
  const op = beginWorkspaceOp();
  op.say(`Reading ${e.name}…`, 'busy');
  // Say what happened. A silent return left the busy line *and* its spinner on screen for ever - a
  // finished, failed read that is indistinguishable from one still running, which is exactly the
  // «which exit says nothing» question this project asks of every change. Worse than before the dot
  // existed: that path set no busy line at all. The reason is the one the download recorded on the
  // entry, so what Zoho said is what the reader is told.
  if (!(await downloadOneBp(e))) {
    if (!op.current()) return;
    // The name in « », like every other status line: the redaction net that runs before a status
    // string reaches a bug report cannot recognise a bare name - it is words. And the guard is the
    // early return the rest of this function uses rather than an inline one, which would have made
    // the function «decided» for the check that holds a function to one spelling of its guard, and
    // reported the guarded line below it.
    setStatus(`«${e.name}» could not be read${e.errorMsg ? ' - ' + e.errorMsg : ''}.`, 'bad');
    return;
  }
  // The same line a full pull writes, for the same reason: reading one blueprint is still a call per
  // transition, and a panel that says nothing for twenty seconds is indistinguishable from a stuck
  // one. The denominator comes from the detail just written, so it costs a read and no request.
  let total = 0;
  try {
    const d = JSON.parse(await op.read(e.path));
    total = new Set(((d && d.connections) || []).map((c) => c.transitions && c.transitions.id).filter(Boolean)).size;
  } catch (_) {}
  if (!op.current()) return;
  let n = 0;
  const tr = await downloadTransitionsFor(e, op, () => {
    n++;
    op.say(`${e.name} · transition ${n} of ${total}…`, 'busy');
  });
  if (!op.current()) return;
  setStatus(tr.hidden ? `${e.name}: its module is hidden from your Zoho profile, so its transitions cannot be read.`
    : tr.throttled ? `${e.name}: Zoho is refusing further requests for now - the rest is read by the next pull.`
    // Both refusals are a warning, not a result. `downloadTransitionsFor` bails on the *first* one
    // and so returns `failed: 0`, which meant «Zoho is refusing further requests» and «its module is
    // hidden from your profile» were both painted green - the panel agreeing with itself that
    // nothing was wrong while naming the thing that was.
    : `${e.name}: read, ${tr.read} transition(s).`, (tr.failed || tr.hidden || tr.throttled) ? 'warn' : 'ok');
}
async function bpDotClick(ev, e) {
  ev.stopPropagation();
  await runPullAction(() => bpReadOne(e));
  if (viewMode === 'blueprints') renderBlueprints();
}
async function openBlueprint(e) {
  // `mine` and the op together: the detail below is read after an await, and what overtakes it is
  // either another blueprint being opened or the workspace changing under it. `previewCurrent`
  // answers both in one question, which is why it exists.
  const mine = ++previewLoad, op = beginWorkspaceOp();
  currentPath = e.path; navHere(e.name);
  selectRow(e.path);
  setPvName(e.name, e.path);
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);   // else the last item's bar lingers
  $('pvreveal').style.display = ''; $('pvreveal').textContent = MSG.openInZoho; $('pvreveal').title = 'Open the blueprint in Zoho';
  $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  // The field's label and its API name are different words on a localised org - «Lead Status» against
  // `Lead_Status`, and in another language entirely where the org works in one - so both are shown
  // when they differ: one is what the org calls it, the other is what Deluge needs.
  const fieldTxt = e.field_label && e.field_label !== e.field
    ? `${escHtml(e.field_label)} <span class="wfoff">${escHtml(e.field)}</span>`
    : escHtml(e.field_label || e.field || '');
  // The module is a place you can go, so it is a chip and not a word - the same `.mod[data-mod]` the
  // code pane and the graph tables already use, wired to the same opener a few lines down. Shown by
  // the org's own label, with the API name beside it when they differ, because that is the string
  // Deluge needs and the label is the one the reader recognises.
  // The same resolver the list uses, filled once by `loadBlueprintIndex`. It had its own lookup here
  // and a different one there, so fixing the pane left the list showing the API name and the report
  // came back a fourth time. One map, or the two drift again.
  const modHit = bpModLabel.get(e.module) || null;
  const modLabel = (modHit && modHit.label) || e.module || '';
  // The name the opener needs, which is not the one the blueprint carries: a custom module is
  // `CustomModule20` there and `Iscrizioni` in the modules index, and the chip was sending the first.
  const modApi = (modHit && modHit.api) || e.module || '';
  const modTxt = e.module
    // `.mod` keeps the wiring and `.wf-fn` gives it the same look as the chips below it: one pane was
    // drawing two different chip styles for the same idea - «this opens something» - which is the
    // reader being asked to learn two vocabularies for one. Only this chip is touched; `.mod`
    // elsewhere is unchanged.
    ? `<span class="wf-fn" data-mod="${escA(modApi)}" title="${escA(modApi + ' - click to open the module')}">${escHtml(modLabel)}</span>`
      + (modLabel !== e.module ? ` <span class="wfoff">${escHtml(e.module)}</span>` : '')
    : '';
  $('pvtable').innerHTML = `<div class="wfd">`
    + `<div class="wfrow"><span class="wk">Module</span> ${modTxt}</div>`
    + (e.field || e.field_label ? `<div class="wfrow"><span class="wk">Field</span> ${fieldTxt}</div>` : '')
    + (e.layout ? `<div class="wfrow"><span class="wk">Layout</span> ${escHtml(e.layout)}</div>` : '')
    // Zoho's own spelling, not a word of ours: it answers `Active` or `Inactive`, and a panel that
    // rewrites that is a panel the reader cannot check against the screen they came from.
    + `<div class="wfrow"><span class="wk">Status</span> ${escHtml(e.status || (e.active ? 'Active' : 'Inactive'))}</div>`
    + (e.api_name ? `<div class="wfrow"><span class="wk">API name</span> ${escHtml(e.api_name)}</div>` : '')
    + (e.description ? `<div class="wfrow"><span class="wk">Description</span> ${escHtml(e.description)}</div>` : '')
    + `</div>`
    + `<div class="bpdetail"></div>`;
  // Wired in the same breath as the draw: a chip that looks clickable and does nothing is worse than
  // a plain word, because it spends the reader's attention twice. Same opener as the code pane and
  // the graph tables - one mechanism for «take me to that module», not a second one here.
  // By the attribute, not by `.mod`: this pane draws the module with the same chip as the function
  // and the actions below it, so one look means «this opens something». `.mod` is left alone
  // everywhere else - `#pvtable .mod` is an id-scoped rule and outweighs `.wf-fn`, so carrying both
  // classes produced a hybrid with one rule's border and the other's fill.
  // The module chip is wired by the delegated listener on `#pvtable` in crm-bootstrap.js. Attaching
  // one here as well made a single click fire `healthOpenModule` twice - two `rebuildModules()`, two
  // opens, and with Modules hidden the same refusal written to the status line twice. Delegation is
  // also the half that survives a re-render, which is why it is the half that stays.
  // The function a transition calls opens like every other function chip in this panel - same
  // helper the workflow pane uses, not a second mechanism. Wired after the detail is drawn, below.
  showPreview();
  // The detail, the way a workflow does it: fetched on open when the mirror has not got it yet, then
  // read back from the file. The pull stores it for every blueprint; this is the path for a reader
  // who opens one after a «Pull list», and the file is what is rendered either way - a pane that
  // drew from the reply and not from the mirror would show what was never stored.
  if (!e.downloaded) {
    const ok = await downloadOneBp(e);
    if (!previewCurrent(mine, op)) return;
    if (viewMode === 'blueprints') renderBlueprints();
    if (!ok) { setStatus('Could not read this blueprint - press Pull list + details to try again.', 'warn'); return; }
  }
  let bp = null; try { bp = JSON.parse(await op.read(e.path)); } catch (_) {}
  // Beside the detail, not inside it: what each transition does is a call per transition and is kept
  // in its own file. Absent is ordinary - a blueprint read by «Pull list» alone has none - and the
  // pane says so per transition rather than printing nothing.
  let acts = null; try { acts = JSON.parse(await op.read(`blueprints/${e.id}.actions.json`)); } catch (_) {}
  // The actions catalogue, when the Actions tab has been pulled. A transition names the *action* it
  // runs; which field that action writes and to what value lives on the catalogue row, and joining
  // them here is what turns «Set status» into «writes Status = In review». Absent is ordinary, and
  // the pane falls back to the action's own name rather than claiming anything about the field.
  let actIndex = null;
  try {
    const rows = JSON.parse(await op.read('actions/index.json'));
    if (Array.isArray(rows)) actIndex = new Map(rows.map((r) => [String(r && r.id), r]));
  } catch (_) {}
  if (!previewCurrent(mine, op)) return;
  const box = $('pvtable').querySelector('.bpdetail'); if (!box) return;
  // **Never an empty box.** Without the file this set the pane to nothing at all - no states, no
  // transitions, no reason - so a blueprint whose detail had not been read looked identical to one
  // that has none, and the reader had nothing to act on. Reported as «I do not see it».
  box.innerHTML = bp ? renderBlueprintDetail(bp, acts, actIndex)
    : `<div class="ftnote">The detail of this blueprint is not in the mirror. Press <b>Pull list + details</b>`
      + ` to read its states and transitions from Zoho.</div>`;
  // After the draw, never before: the chips do not exist until the line above has run. Same helper
  // the workflow pane uses - one mechanism for «open that function», not a second one here.
  wireFnChips(box, (sp) => openFunctionFromWorkflow(sp.dataset.fnid, sp.dataset.fnname));
  // The actions a transition fires, opened where they live. Same wiring the function pane uses for
  // «Used in», rather than a second mechanism: `HEALTH_OPEN` already maps a kind to its opener, so a
  // kind that gains one is reachable from here too without this line being touched.
  box.querySelectorAll('a.aplink[data-ap]').forEach((a) => (a.onclick = () => {
    const open = HEALTH_OPEN[a.dataset.ap];
    if (open) open(a.dataset.apid, a.dataset.apname);
  }));
  pvDiagram(`bp:${e.id}`, 'blueprint');
}
/** The states a record moves through, the transitions between them, and what each transition does.
 *
 *  **Measured, on one org's own answer.** `chart_data.nodes` holds the states - 25 of them there -
 *  and `connections` holds 78 entries, each a `from_state`, a `to_state` and the transition between
 *  them. What a transition *does* is not in that reply at all: no field update, no function, no
 *  webhook appears anywhere in it. It comes from one call per transition, stored beside the detail,
 *  and a transition whose actions were never read is said as that rather than drawn as one that does
 *  nothing - two facts that look identical on screen and are not.
 *
 *  **An action names itself, and the catalogue says what it touches.** A transition carries
 *  `{type, id, name}` per action, where the id is the *action's*. For a field update the field and
 *  the value are on the catalogue row the Actions tab already pulls, joined here by that id; for a
 *  function the function's own id was resolved when the transition was read, because the action's
 *  would open nothing. Both joins are optional and their absence is drawn as the action's own name -
 *  a mirror that has not pulled Actions is an ordinary state, not a broken one.
 *
 *  A node's `state` was measured as a key and not as a type, so it is read as either a name or an
 *  object carrying one. That is a tolerance about a shape nobody here has seen, written as such
 *  instead of a guess that renders «[object Object]» on the first org that differs. */
function renderBlueprintDetail(bp, acts, actIndex) {
  const nameOf = (s) => (typeof s === 'string' ? s : (s && (s.name || s.display_label || s.api_name)) || '');
  const states = (bp.chart_data && Array.isArray(bp.chart_data.nodes) ? bp.chart_data.nodes : [])
    .map((n) => nameOf(n.state)).filter(Boolean);
  const conns = Array.isArray(bp.connections) ? bp.connections : [];
  // Two facts the note at the bottom is about, collected while drawing rather than restated always:
  // a sentence that is on screen when it does not apply is one the reader learns to skip, and then
  // misses on the day it is the answer.
  let anyUnread = false, anyUnjoined = false;
  /** An action the catalogue holds is a **link**, not a word. It is the same `.aplink` the function
   *  pane uses under «Used in», so one mechanism opens an action from anywhere - and the reason is
   *  the product's own: a transition that fires a notification and the notification itself are two
   *  objects the reader should be one click apart from. Reported as «email and task carry a textual
   *  indication but not the link to their action, which is there».
   *
   *  Plain when the id is in no catalogue - Actions not pulled, or an action removed since - because
   *  a link that leads nowhere spends the reader's attention twice. */
  // `.wf-fn` is the chip this panel already uses for «this opens something», so the action links
  // look like the function chip beside them instead of like bold text. No new selector: `.aplink`
  // carries no appearance of its own - in the function pane it only looks like a link because a
  // `#pvcallers a` rule colours it, and this pane is not inside that box. Reported as «they are
  // clickable and the interface does not say so».
  const actLink = (act, text) => (actIndex && act && act.id && actIndex.get(String(act.id))
    ? `<a class="wf-fn aplink" data-ap="action" data-apid="${escA(String(act.id))}" data-apname="${escA(act.name || '')}" title="Open this action">${escHtml(text)}</a>`
    : `<b>${escHtml(text)}</b>`);
  const rows = conns.map((c) => {
    const from = nameOf(c.from_state), to = nameOf(c.to_state);
    const t = c.transitions && (c.transitions.name || c.transitions.api_name);
    // What this transition does, when it has been read. Each kind says what it is and names what it
    // touches - the field it writes, the function it calls - because a bare count would be a number
    // nobody can act on. Unread is said as itself: a transition whose actions were never fetched
    // must not look like one that does nothing.
    const a = acts && c.transitions && acts[String(c.transitions.id)];
    const bits = [];
    for (const act of (a && a.actions) || []) {
      const row = actIndex && act && act.id ? actIndex.get(String(act.id)) : null;
      if (!act) continue;
      if (act.type === 'functions') {
        // The chip opens the function, so it carries the *function's* id - the action's would open
        // nothing. Unresolved, it stays a plain name: a chip that does nothing spends the reader's
        // attention twice, which is the rule the module chip beside it already follows.
        bits.push(act.function_id
          ? `calls <span class="wf-fn" data-fnid="${escA(act.function_id)}" data-fnname="${escA(act.function_api_name || act.name || '')}" title="Open the function">ƒ ${escHtml(act.function_api_name || act.name || '?')}</span>`
          : `calls <b>${escHtml(act.name || '?')}</b>`);
      } else if (act.type === 'field_updates') {
        // «Set status» is not an answer to «which field, to what value», and the answer is on the
        // catalogue row. `null` there is «clears it» and is said as that, never as a blank.
        if (!(row && row.field)) anyUnjoined = true;
        bits.push(row && row.field
          ? `writes ${actLink(act, row.field_label || row.field)}`
            + (row.value == null ? ' <span class="wfoff">(cleared)</span>' : ' = ' + escHtml(String(row.value)))
          : `writes ${actLink(act, act.name || '?')}`);
      } else if (act.type === 'tasks') bits.push(`task ${actLink(act, act.name || '')}`);
      else if (act.type === 'email_notifications') bits.push(`emails ${actLink(act, act.name || '')}`);
      else if (act.type === 'webhooks') bits.push(`webhook ${actLink(act, act.name || '')}`);
      // A kind nobody here has seen is named rather than dropped: five types were measured on one
      // org, and silently skipping a sixth would draw a transition that acts as one that does not.
      else bits.push(`${escHtml(act.type || 'action')} <b>${escHtml(act.name || '')}</b>`);
    }
    // One action per line. Joined with a separator they ran together into a sentence - «task X · calls
    // ƒ Y · emails Z · writes W» - which is four facts read as one, and the longer the transition the
    // worse it got. Reported from a real org, where one transition carries five.
    if (!a) anyUnread = true;
    const lines = a ? (bits.length ? bits : ['<span class="wfoff">does nothing</span>'])
                    : ['<span class="wfoff">actions not read</span>'];
    return `<div class="wfrow"><span class="wk">${escHtml(t || 'transition')}</span> ${escHtml(from)} → ${escHtml(to)}`
      + lines.map((b) => `<div class="ftnote">${b}</div>`).join('') + `</div>`;
  });
  // Counted from what was read, not from the blueprint's own reply: `include=transition` carries an
  // `actions` key that is `null` on every transition of every org measured, so counting it would
  // report «0 of 78» about a process that acts on most of them.
  const actsOf = (c) => (c.transitions && acts && acts[String(c.transitions.id)] || {}).actions || [];
  const withActions = conns.filter((c) => actsOf(c).length);
  const actKinds = [...new Set(withActions.flatMap((c) => actsOf(c).map((a) => a && a.type).filter(Boolean)))];
  return `<div class="wfd"><div class="wfrow"><span class="wk">States</span> ${states.length}${states.length ? ' · ' + escHtml(states.join(', ')) : ''}</div>`
    + `<div class="wfrow"><span class="wk">With actions</span> ${withActions.length} of ${conns.length}${actKinds.length ? ' · ' + escHtml(actKinds.join(', ')) : ''}</div>`
    + `<div class="wfrow"><span class="wk">Transitions</span> ${conns.length}</div></div>`
    + (rows.length ? `<div class="wfd">${rows.join('')}</div>` : '')
    // Which road produced this file. Said rather than hidden: the documented call refused for this
    // blueprint and the internal one answered, and a reader comparing the panel against Zoho's own
    // screen has to know when the two were read differently.
    + (bp._via ? `<div class="ftnote">Zoho's documented API refused this blueprint, so its states and`
                 + ` transitions were read from the endpoint its own screen uses (<b>${escHtml(bp._via)}</b>).`
                 + ` What each transition does still comes from the documented call.</div>` : '')
    // Only what applies. This used to state all of it every time - two sentences about things to pull,
    // on a pane where both had already been pulled - and a note that is always there is one nobody
    // reads on the day it means something.
    + (anyUnread ? `<div class="ftnote">A transition marked <i>actions not read</i> was pulled before`
                   + ` its actions were - press <b>Pull list + details</b>.</div>` : '')
    + (anyUnjoined ? `<div class="ftnote">A field update is named rather than showing the field and the`
                     + ` value it writes: that comes from the <b>Actions</b> tab, which has not been pulled.</div>` : '');
}
/** The blueprint in Zoho's own editor. The module query the UI adds is optional - measured: the URL
 *  works without it - so it is not sent, and nothing here depends on a parameter we would be
 *  guessing the meaning of. */
async function openBlueprintInZoho(id) {
  if (sampleRefuse()) return;
  const ws = bound || {};
  if (!ws.base || !ws.instance) { setStatus('Unknown workspace binding - pull first.', 'warn'); return; }
  try { if (await goToZoho(`${ws.base}/crm/${ws.instance}/settings/blueprint/${id}`)) setStatus('Opened blueprint in Zoho.', 'ok'); }
  catch (e) { setStatus('Could not open: ' + e.message, 'warn'); }
}
async function refreshBlueprintsNow() {
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  setStatus('Refreshing blueprints…', 'busy');
  // The pull owns the message, for the reason written out over `refreshSchedulesNow`: every early
  // return in it sets its own line, so a count painted here would be the length of the list already
  // in memory and would read as a refresh that happened when it did not.
  await pullBlueprints();
}
async function refreshBlueprints() {
  return runPullAction(refreshBlueprintsNow);
}
async function rebuildSchedules() {
  const op = beginWorkspaceOp();   // the workspace this rebuild is about
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { op.say(MSG.folder, 'warn'); return; }
    op.say('Reading schedules\u2026', 'busy');
    const _cfg = await opReadCfg(op); if (!op.current()) return; if (_cfg) bound = _cfg; await cacheBinding(bound);
    if (!(await loadScheduleIndex(op))) return;
    renderSchedules();
    // `emptyReason()` first, like the tree three lines down and like the other four tabs: on a
    // sample workspace Pull is refused by design, so «use Pull all» sends the reader to press a grey
    // button. The status line also stopped being 'ok' over an empty list.
    op.say(scheduleData.length ? `${scheduleData.length} schedules.`
                                  : (emptyReason('schedules') || 'No schedules pulled yet - use Pull all.'),
              scheduleData.length ? 'ok' : 'warn');
  } catch (e) { if (op.current()) setStatus(MSG.refreshErr + e.message, 'bad'); }
  if (op.current()) await refreshContext();
}
function renderSchedules() {
  if (viewMode !== 'schedules') return;
  const term = $('find').value.trim().toLowerCase();
  const byStatus = {};
  scheduleData
    .filter((e) => scheduleFilter === 'all' || (scheduleFilter === 'active' ? e.status === 'active' : e.status !== 'active'))
    .filter((e) => !term || (e.name || '').toLowerCase().includes(term) || (e.function_name || '').toLowerCase().includes(term))
    .forEach((e) => (byStatus[e.status === 'active' ? 'Active' : 'Inactive'] ||= []).push(e));
  const tree = $('tree'); tree.innerHTML = '';
  const keys = Object.keys(byStatus).sort();
  if (!keys.length) { tree.innerHTML = '<div class="empty">' + (scheduleData.length ? '<b>No matches.</b>' : (emptyReason('schedules') || '<b>No schedules yet.</b> Press <b>Pull all</b> to read them.')) + '</div>'; return; }
  keys.forEach((st) => {
    const list = byStatus[st].sort(byField('name'));
    const isCol = collapsed.has('sc:' + st);
    const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
    g.innerHTML = `<span class="chev">\u25be</span><span>${st}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete('sc:' + st) : collapsed.add('sc:' + st); renderSchedules(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => {
      const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path;
      el.setAttribute('aria-selected', e.path === currentPath);
      el.innerHTML = `<span class="st st-ok" title="In workspace - click to refresh schedules from Zoho">\u25cf</span><span>${escHtml(e.name)}</span><span class="wftype">${escHtml(e.frequency || '')}</span>${e.status === 'active' ? '' : '<span class="wfoff">off</span>'}`;
      el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); refreshSchedules(); };
      el.onclick = () => openSchedule(e);
      tree.appendChild(el);
    });
  });
}
// The status dot's own action, named: it awaits a pull and then rewrites the row it belongs to, which
// is a write after a yield and therefore exactly what `tools/asynccheck.py` is for. As a `.then()`
// arrow it was a scope the tool could not enter.
async function wfDotClick(ev, e) {
  ev.stopPropagation();
  await runPullAction(() => downloadOneWf(e));
  updateRow(e); updateMissingButton();
}

async function refreshSchedulesNow() {
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  setStatus('Refreshing schedules\u2026', 'busy');
  // The pull owns the message, like its three siblings. This wrote «N schedules.» in green
  // afterwards, unconditionally - and `pullSchedules` never throws: a partial list from Zoho, a
  // role that refuses, no Zoho tab, an environment mismatch, a folder permission denied are six
  // early returns, each of which sets its own line and comes back here to be painted over. The
  // count was the length of the list *already in memory*, since the new one is only installed on
  // success, so it read as «refreshed, 12 schedules» over a refresh that did not happen.
  //
  // And `setStatus` calls `showEmergency(false)`, so the green line also closed the «Report this
  // problem» banner that the failure had just raised.
  await pullSchedules();
}
async function refreshSchedules() {
  return runPullAction(refreshSchedulesNow);
}
async function openSchedule(e) {
  previewLoad++;
  currentPath = e.path; navHere(e.name);
  selectRow(e.path);
  setPvName(e.name, e.path);
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);   // else the last function's callers/connections bar lingers
  $('pvreveal').style.display = 'none'; $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  const fnLink = `<span class="wf-fn" data-fnid="${escA(e.function_id || '')}" data-fnname="${escA(e.function_name || '')}" title="Open the function">\u0192 ${escHtml(e.function_name || '?')}</span>`;
  $('pvtable').innerHTML = `<div class="wfd">`
    + `<div class="wfrow"><span class="wk">Function</span> ${fnLink}</div>`
    + `<div class="wfrow"><span class="wk">Frequency</span> ${escHtml(e.frequency || '')}</div>`
    + `<div class="wfrow"><span class="wk">Status</span> ${escHtml(e.status || '')}</div>`
    + (e.next ? `<div class="wfrow"><span class="wk">Next run</span> ${escHtml(e.next)}</div>` : '')
    + (e.last ? `<div class="wfrow"><span class="wk">Last run</span> ${escHtml(e.last)}</div>` : '')
    + `</div>`;
  showPreview();
  wireFnChips($('pvtable'), (sp) => openFunctionFromWorkflow(sp.dataset.fnid, sp.dataset.fnname));
  pvDiagram(`sch:${e.id}`, 'schedule');
}

// ---------- workflows ----------

/** The scheduled-action facts of one rule, read from the rule we already have on disk.
 *
 * "How many workflows have actions that do not run immediately" had no answer anywhere: the list
 * endpoint does not carry it, so `workflows/index.json` does not either, and the fact was sitting unread in
 * every `workflows/<id>.json` - one level down, inside `conditions[].scheduled_actions[]`.
 *
 * Derived rather than captured, deliberately. Adding it to the index would mean a field that older
 * workspaces lack and a re-pull to acquire, for something already on the disk: this reads what the
 * pull wrote, which is the same rule the graph and the health audit follow.
 */
function wfScheduled(rule) {
  let count = 0; const delays = [];
  ((rule && rule.conditions) || []).forEach((c) => {
    (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => {
      count += (sa.actions || []).length;
      const ea = sa.execute_after;
      if (ea && ea.unit != null && ea.period) delays.push(`${ea.unit} ${ea.period}`);
    });
  });
  return { count, delays: [...new Set(delays)] };
}

async function loadWorkflowIndex(op = beginWorkspaceOp()) {
  // These read the mirror and then publish a whole list into the panel's memory. A rebuild is
  // short, but it is not instant, and what overtakes it is a change of workspace - so the list of
  // one org arrived in the panel showing another. Found by `tools/asynccheck.py`, which derives
  // this class instead of waiting for the next reader to notice an instance of it.
  let idx = []; try { idx = JSON.parse(await op.read('workflows/index.json')); } catch (_) {}
  const have = new Set();
  for await (const p of walk(op.root)) {
    if (!op.current()) return false;
    if (p.startsWith('workflows/') && p.endsWith('.json') && !p.endsWith('/index.json')) have.add(p.split('/').pop().replace(/\.json$/, ''));
  }
  if (!op.current()) return false;
  // The list and its index are one fact and are published together. They were not: the index was
  // filled at the very end, after a loop that reads one file per downloaded rule, so an interrupted
  // loader left a list on screen whose rows opened nothing. Found by `tools/probe.py` in a browser,
  // on a guard this same session had added - a guard that returns is a guard that must not leave
  // half a state behind.
  const nextData = idx.map((e) => ({ ...e, id: String(e.id), path: `workflows/${String(e.id)}.json`, downloaded: have.has(String(e.id)), error: false }));
  const nextIndex = new Map();
  // One pass over the rules on disk for the two facts the list endpoint does not return. A rule not
  // downloaded yet has neither, and says so as absence rather than as a zero - «0 scheduled» about a
  // workflow nobody has read is a measurement that was never taken.
  // The loop below reads one file per downloaded rule, so the index it fills is filled long after the
  // list it is an index *of* - and `wfIndex` is read by every workflow row on screen.
  nextData.forEach((e) => nextIndex.set(e.id, e));
  // Enrichment from here on - two fields the list endpoint does not return, one file per rule. It may
  // stop; what is already on screen stays consistent with what a click can find.
  for (const e of nextData) {
    if (!op.current()) return false;
    if (!e.downloaded) continue;
    try {
      const rule = JSON.parse(await op.read(e.path));
      const s = wfScheduled(rule);
      e.sched = s.count; e.schedDelays = s.delays;
      e.lastRun = rule.last_executed_time || null;
    } catch (_) { /* unreadable here is the same as not downloaded: no fact, not a false zero */ }
  }
  if (!op.current()) return false;
  workflowData = nextData;
  wfIndex = nextIndex;
  return true;
}
async function rebuildWorkflows() {
  const op = beginWorkspaceOp();   // the workspace this rebuild is about
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { op.say(MSG.folder, 'warn'); return; }
    op.say('Reading workflows\u2026', 'busy');
    const _cfg = await opReadCfg(op); if (!op.current()) return; if (_cfg) bound = _cfg; await cacheBinding(bound);
    if (!(await loadWorkflowIndex(op))) return;
    renderWorkflows(); updateMissingButton();
    const dl = workflowData.filter((e) => e.downloaded).length;
    op.say(`${workflowData.length} workflows (${dl} downloaded).`, 'ok');
  } catch (e) { if (op.current()) setStatus(MSG.refreshErr + e.message, 'bad'); }
  if (op.current()) await refreshContext();
}
function renderWorkflows() {
  if (viewMode !== 'workflows') return;
  const term = $('find').value.trim().toLowerCase();
  const byMod = {};
  workflowData
    .filter((e) => workflowFilter === 'all'
      || (workflowFilter === 'scheduled' ? e.sched > 0 : workflowFilter === 'active' ? e.active : !e.active))
    .filter((e) => !term || (e.name || '').toLowerCase().includes(term) || (e.module || '').toLowerCase().includes(term))
    .forEach((e) => (byMod[e.module || '(no module)'] ||= []).push(e));
  const tree = $('tree'); tree.innerHTML = '';
  const keys = Object.keys(byMod).sort();
  if (!keys.length) { tree.innerHTML = '<div class="empty">' + (workflowData.length ? '<b>No matches.</b>' : (emptyReason('workflows') || '<b>No workflows yet.</b> Press <b>Pull all</b> to read them.')) + '</div>'; return; }
  // The scheduled-action count comes from the rule on disk, so a rule not downloaded yet has no
  // count - it is not a zero. Filtering on it therefore answers about part of the org, and the
  // figure states its own gap rather than letting the list look complete.
  if (workflowFilter === 'scheduled') {
    const unread = workflowData.filter((e) => !e.downloaded).length;
    if (unread) {
      const n = document.createElement('div'); n.className = 'wfnote';
      n.innerHTML = `${unread} workflow(s) have not been downloaded, so they are not counted here either way.`
        + ' Press <b>Complete missing</b> above to read them.';
      tree.appendChild(n);
    }
  }
  keys.forEach((mod) => {
    const list = byMod[mod].sort(byField('name'));
    const isCol = collapsed.has('wf:' + mod);
    const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
    g.innerHTML = `<span class="chev">\u25be</span><span>${escHtml(mod)}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete('wf:' + mod) : collapsed.add('wf:' + mod); renderWorkflows(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => {
      const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path; el.dataset.id = e.id;
      el.setAttribute('aria-selected', e.path === currentPath);
      const stCls = e.error ? 'st-err' : e.downloaded ? 'st-ok' : 'st-no';
      const stCh = e.error ? '\u27f3' : e.downloaded ? '\u25cf' : '\u25cb';
      const wfTitle = e.error ? (MSG.failed + (e.errorMsg || 'unknown') + MSG.clickRetry) : e.downloaded ? MSG.hereRepull : MSG.notHere;
      // The delay is part of the fact: "2 scheduled" and "2 scheduled, 30 minutes later" are
      // different things to know before touching a rule, and the second costs a tooltip.
      const schedBadge = e.sched > 0
        ? `<span class="wfsched" title="${escA(e.sched + ' action(s) that do not run immediately'
            + (e.schedDelays && e.schedDelays.length ? ' - after ' + e.schedDelays.join(', ') : ''))}">⏱ ${e.sched}</span>`
        : '';
      el.innerHTML = `<span class="st ${stCls}" title="${escA(wfTitle)}">${stCh}</span><span>${escHtml(e.name)}</span><span class="wftype">${escHtml(e.type)}</span>${schedBadge}${e.active ? '' : '<span class="wfoff">off</span>'}`;
      el.querySelector('.st').onclick = (ev) => wfDotClick(ev, e);
      el.onclick = () => openWorkflow(e);
      tree.appendChild(el);
    });
  });
}
async function downloadOneWf(entry) {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  const had = !!entry.downloaded;   // a re-read that fails leaves the file on disk, and the row says so
  if (mismatchRefuse()) return false;
  if (!dir) return false;
  if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'bad'); return false; }
  try {
    const r = await toBridge({ cmd: 'fetchWorkflow', id: entry.id });
    if (!r?.ok || !r.rule) throw new Error(r?.error || 'not found');
    await op.write(entry.path, JSON.stringify(r.rule, null, 2));
    entry.downloaded = true; entry.error = false; entry.errorMsg = '';
    return true;
  } catch (e) { entry.error = true; entry.downloaded = had; entry.errorMsg = errText(e); return false; }
}
/** Fetch rule details: the ones not on disk, or - from a pull - every one of them.
 *
 *  A pull fetched a rule's detail only when its file was missing, so a rule edited in Zoho after its
 *  first download was never read again: its conditions and actions stayed as they were, on screen, in
 *  the reports and in every field's Workflows count, while the list beside them was current. Found by
 *  the author watching the network during a pull - one request, where he expected one per rule.
 *  Every rule now, not the ones whose `modified_time` moved: whether an edit to a condition or an
 *  action moves the rule's own time is a claim about Zoho nothing here has measured, and a hundred
 *  rules cost seconds. «Complete missing» keeps the narrow meaning its name says. */
async function downloadMissingWf(all = false) {
  const op = beginWorkspaceOp();   // the workspace these workflows belong to - see downloadMissing()
  const pending = workflowData.filter((e) => all || !e.downloaded);
  if (!pending.length) { setStatus('All workflows downloaded.', 'ok'); updateMissingButton(); return; }
  setPullBusy(true); $('missing').disabled = true;   // both Pull buttons, and pullCurrent refuses to start on top
  let ok = 0, fail = 0;
  try {
    for (let i = 0; i < pending.length; i++) {
      if (!op.current()) return;
      const e = pending[i];
      op.say(`${all ? 'Reading' : 'Downloading'} workflow ${i + 1}/${pending.length}\u2026${fail ? ' (' + fail + ' failed)' : ''}`, 'busy');
      let done = await downloadOneWf(e);
      if (!done && isTransient(e.errorMsg)) { await sleep(700); done = await downloadOneWf(e); }
      done ? ok++ : fail++;
      if (viewMode === 'workflows') updateRow(e);
      await sleep(120);
    }
    if (!op.current()) return;
    updateMissingButton();
    // A rule already on disk whose re-read failed is not missing - its file is there, the row says so, and
    // «Complete missing» does not count it. Sending the reader to that hidden button was the review's find.
    const kept = pending.filter((e) => e.error && e.downloaded).length;
    setStatus(fail ? `Downloaded ${ok}${fail - kept ? `, ${fail - kept} still missing - use "Complete missing"` : ''}${kept ? `, ${kept} could not be read again - the copy on disk is kept, and the next Pull list + details retries` : ''}.`
      : `All ${ok} workflows downloaded.`, fail ? 'warn' : 'ok');
    return { failed: fail };   // a pull that could not read every rule must not record that it did
  } finally { setPullBusy(false); $('missing').disabled = false; }
}
/** One blueprint's detail → `blueprints/<id>.json`, the same shape `fetchBlueprint` returns.
 *
 *  Measured on a real org before this was written: the answer carries `chart_data.nodes` (the states)
 *  and `connections` (each one a from-state, a to-state and the transition between them). It does
 *  **not** carry what a transition does - no field updates, no functions - so nothing here pretends
 *  to read those. The whole object is stored as it came, which is what the workflow detail does too:
 *  the panel decides what to show, and a mirror that keeps less than it read cannot be re-read. */
async function downloadOneBp(entry) {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  const had = !!entry.downloaded;   // a re-read that fails leaves the file on disk, and the row says so
  if (mismatchRefuse()) return false;
  if (!dir) return false;
  if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'bad'); return false; }
  try {
    let r = await toBridge({ cmd: 'fetchBlueprint', id: entry.id });
    // **Only after the documented call has refused.** Measured: Zoho answers 500 INTERNAL_ERROR for
    // one blueprint of twelve on a real org, with and without `include`, while its own screen draws
    // that blueprint through an internal endpoint. So the second road is a failover and never the
    // primary - at most one extra request, and only for a blueprint that would otherwise be lost.
    if (!r?.ok || !r.blueprint) {
      let alt = null;
      try { alt = await toBridge({ cmd: 'fetchBlueprintInternal', id: entry.id }); } catch (_) {}
      if (alt?.ok && alt.blueprint) r = alt;
    }
    if (!r?.ok || !r.blueprint) throw new Error(r?.error || 'not found');
    await op.write(entry.path, JSON.stringify(r.blueprint, null, 2));
    entry.downloaded = true; entry.error = false; entry.errorMsg = '';
    return true;
  } catch (e) { entry.error = true; entry.downloaded = had; entry.errorMsg = errText(e); return false; }
}
/** The details: the ones not on disk, or - from a full pull - every one of them.
 *
 *  Every blueprint on a full pull rather than the ones whose file is missing, for the reason the
 *  workflow area learnt the hard way: a process edited in Zoho after its first download would never
 *  be read again, and its states would sit on screen looking current beside a list that was. */
/** What every transition of one blueprint does, into `blueprints/<id>.actions.json`.
 *
 *  Kept beside the detail rather than inside it: the detail is one reply from Zoho and this is one
 *  call per transition, so a blueprint whose actions were never read is a *missing file* rather than
 *  a half-written detail, and the pane can tell the reader which of the two it is showing.
 *
 *  The ids come from the detail we already hold - `connections[].transitions.id` - and nothing else
 *  is needed: the documented endpoint takes the transition id alone, where the internal one it
 *  replaced also wanted the module and the layout. Nothing is asked for twice - a transition named
 *  by two connections is read once, and a function action is resolved once however many transitions
 *  run it. */
async function downloadTransitionsFor(entry, op, onStep) {
  // Its own guard, like every other path that reaches the platform: this runs a call per transition,
  // hundreds of them on a real org, and the org under the panel can change while it does.
  if (mismatchRefuse()) return { failed: 0, read: 0 };
  let bp = null; try { bp = JSON.parse(await op.read(entry.path)); } catch (_) {}
  if (!bp) return { failed: 0, read: 0 };
  const conns = Array.isArray(bp.connections) ? bp.connections : [];
  const ids = [...new Set(conns.map((c) => c.transitions && c.transitions.id).filter(Boolean))].map(String);
  if (!ids.length) return { failed: 0, read: 0 };
  const out = {}; let fail = 0;
  /** What was read before a stop, kept. Nothing read means nothing written: an empty `{}` on disk is
   *  read back by the pane as «this transition does nothing», which is a claim about the process
   *  where «not read» is the only true sentence - the distinction this area draws everywhere else.
   *
   *  A named declaration rather than an arrow, and that is not style: `asynccheck` can only enter an
   *  async scope that is a named function, so `= async () => {}` is a scope it cannot read - a blind
   *  spot in the very check that finds globals written after an await. Its ceiling is zero, so this
   *  is converted rather than recorded on the migration list. */
  async function keep() {
    if (op.current() && Object.keys(out).length) {
      await op.write(`blueprints/${entry.id}.actions.json`, JSON.stringify(out, null, 2));
    }
  }
  // One lookup per function action for the whole blueprint rather than one per transition: the same
  // function is wired into several transitions on a real org, and the answer cannot differ between
  // two of them. `null` is remembered too - a refusal must not be retried once per transition.
  const fnSeen = new Map();
  for (const tid of ids) {
    if (!op.current()) return { failed: fail, read: Object.keys(out).length };
    if (onStep) onStep();
    let r = null; try { r = await toBridge({ cmd: 'fetchTransition', id: tid }); } catch (_) {}
    if (r?.ok && r.transition) {
      const t = r.transition;
      for (const a of t.actions || []) {
        // The id a transition carries is the *action's* and not the function's - measured, and they
        // differ by more than a suffix - so a chip built on it would open nothing at all. One more
        // call turns it into the function this mirror already holds.
        if (a.type !== 'functions' || !a.id) continue;
        if (!fnSeen.has(a.id)) {
          let fr = null; try { fr = await toBridge({ cmd: 'fetchFunctionAction', id: a.id }); } catch (_) {}
          fnSeen.set(a.id, fr?.ok && fr.action ? fr.action : null);
          await sleep(80);
        }
        // Left absent rather than written empty: an empty api name would draw as a chip naming
        // nothing, where absence is what the pane already words as «the function was not resolved».
        const got = fnSeen.get(a.id);
        if (got && got.function_id) { a.function_id = got.function_id; a.function_api_name = got.function_api_name; }
      }
      out[tid] = t;
    }
    else {
      // **Stop at the first throttle, and keep what was read.** Measured twice on the same org: the
      // 101st call answers Zoho's error page and every one after it does the same, so continuing
      // spends seventy requests to learn what the first one said. The rest is not lost - it is
      // written below and the ids that are missing are simply absent, which is what lets this be
      // picked up again rather than started over.
      // `upstreamCode`, not `code`: the first is what Zoho said, the second is Zoost's own
      // classification, which `bridgeResponseError` overwrites. Comparing against `code` here was a
      // stop that could never fire - decorative, and invisible to every test in this suite.
      const up = bridgeError(r, '').upstreamCode;
      if (up === 'THROTTLED_HTML') { await keep(); return { failed: fail, read: Object.keys(out).length, throttled: true }; }
      // **A hidden module refuses every transition of its blueprint, so asking the rest is waste.**
      // Measured on a real org: seven transitions of one process, seven identical refusals -
      // `NO_PERMISSION`, «operation cannot be performed for hidden module» - while 164 transitions of
      // the other blueprints answered. That is a fact about this reader's profile in Zoho, not a
      // failure of the pull: counted as a failure it sends them to press Pull again, which can never
      // succeed, and saying the wrong missing thing is worse than saying nothing.
      if (up === 'NO_PERMISSION') { await keep(); return { failed: fail, read: Object.keys(out).length, hidden: true }; }
      fail++;
    }
    await sleep(80);
  }
  if (!op.current()) return { failed: fail, read: Object.keys(out).length };
  // The same rule as the two stops above: a run where every transition refused writes no file at
  // all, because an empty map on disk is read back as a process whose transitions do nothing.
  if (Object.keys(out).length) await op.write(`blueprints/${entry.id}.actions.json`, JSON.stringify(out, null, 2));
  return { failed: fail, read: Object.keys(out).length };
}
async function downloadMissingBp(all = false) {
  const op = beginWorkspaceOp();
  // It reaches Zoho itself now - the probe below asks the documented endpoint once - so it carries
  // the guard its siblings carry rather than relying on whoever called it.
  if (mismatchRefuse()) return { failed: 0, read: 0 };
  const pending = blueprintData.filter((e) => all || !e.downloaded);
  if (!pending.length) { setStatus('All blueprints read.', 'ok'); return { failed: 0 }; }
  setPullBusy(true);
  // The denominator, counted before the first call rather than discovered as it goes: a line that
  // says «transition 41» and keeps climbing tells the reader nothing about how long this will take,
  // and on an org where this runs into the hundreds that is the difference between waiting and
  // giving up. The counts are already on disk - each detail carries its own connections - so this
  // costs a read per blueprint and no request at all.
  let tTotal = 0;
  for (const e of pending) {
    let d = null; try { d = JSON.parse(await op.read(e.path)); } catch (_) {}
    if (!op.current()) return { failed: 0, read: 0 };
    tTotal += new Set(((d && d.connections) || []).map((c) => c.transitions && c.transitions.id).filter(Boolean)).size;
  }
  let ok = 0, fail = 0, tRead = 0, tFail = 0, throttled = false, hidden = 0;
  try {
    for (let i = 0; i < pending.length; i++) {
      // `{failed}` on every exit, never `undefined`: the caller reads `dl.failed` into the depth it
      // records, so bailing with nothing made an interrupted run look like one that read everything.
      if (!op.current()) return { failed: pending.length - ok };
      const e = pending[i];
      op.say(`${all ? 'Reading' : 'Downloading'} blueprint ${i + 1}/${pending.length}…${fail ? ' (' + fail + ' failed)' : ''}`, 'busy');
      let done = await downloadOneBp(e);
      if (!done && isTransient(e.errorMsg)) { await sleep(700); done = await downloadOneBp(e); }
      done ? ok++ : fail++;
      // Where the value is: the field updates a transition writes and the function it calls. Counted
      // on the progress line by transition rather than by blueprint - there are hundreds of them, and
      // a line that moved once per blueprint would sit still for minutes and read as a hung panel.
      // **A pull reads them, and it is the documented endpoint that made that affordable.** The
      // internal one this replaced stopped answering with data after about a hundred calls in under
      // a minute and then refused the org - Zoho's own screen included - for more than ten minutes,
      // so a pull could not go near it. Measured on the documented one: 200 consecutive calls in
      // 21.7 seconds with no refusal, and a whole org of 172 transitions in about twenty.
      if (done) {
        const tr = await downloadTransitionsFor(e, op, () => {
          tRead++;
          op.say(`Blueprint ${i + 1}/${pending.length} · transition ${tRead} of ${tTotal}${tFail ? ` (${tFail} failed)` : ''}…`, 'busy');
        });
        tFail += tr.failed;
        // Zoho stopped answering: the rest of this run would be seventy more refusals. What was read
        // is on disk, the ids not read are simply absent from it, and the next run continues from
        // there - so this stops rather than emptying the budget it has already been refused.
        if (tr.throttled) {
          // The progress callback runs before the request, so this attempt is not a read.  Remove
          // it from the numerator; otherwise a throttle on the first transition was reported as
          // "1 of 1 read" and the access record could be advanced to full below.
          if (tRead > 0) tRead--;
          throttled = true;
          break;
        }
        // A blueprint whose module this profile cannot see is skipped and the run carries on - unlike
        // throttling, which is about the whole org. Measured: 164 transitions of the other blueprints
        // answered while seven of this one refused, so stopping would have thrown away a good pull.
        //
        // Counted apart from `tFail` deliberately: `tFail` is the gap a later pull is expected to
        // close, and this one never closes by pulling - the module would have to be made visible to
        // this reader in Zoho first. `tRead--` because the step counter is incremented before the
        // call, so the transition that was refused had already been counted as read.
        if (tr.hidden) { hidden++; if (tRead > 0) tRead--; }
      }
      if (viewMode === 'blueprints') renderBlueprints();
      await sleep(120);
    }
    if (!op.current()) return { failed: fail };
    // A blueprint already on disk whose re-read failed is not missing: its file is there and the
    // next full pull retries it. Said plainly rather than pointing at a button this area does not
    // have - «Complete missing» is wired for functions and workflows, and not for these.
    const kept = pending.filter((e) => e.error && e.downloaded).length;
    // «Stopped» is a different fact from «finished», and the reader has to be able to tell: the
    // mirror is incomplete on purpose, the rest is still in Zoho, and nothing here is broken.
    // A hidden module is a fact about this reader's Zoho profile and not a failure of the pull, so it
    // is said plainly and does not turn the line amber: nothing here is broken, and there is nothing
    // to retry. What would be wrong is silence - the shortfall against `tTotal` is visible either way,
    // and an unexplained shortfall is the reader assuming the mirror is unreliable.
    const trSaid = (tRead || tFail || hidden || throttled) ? ` · ${tRead - tFail} of ${tTotal} transition(s) read${tFail ? `, ${tFail} refused` : ''}`
                           + (hidden ? ` · ${hidden} blueprint(s) run on a module your Zoho profile cannot see, so their transitions cannot be read` : '')
                           + (throttled ? ' · stopped: Zoho is refusing further requests for now, the rest is read by the next pull' : '') : '';
    setStatus(fail ? `Read ${ok} blueprint(s)${fail - kept ? `, ${fail - kept} could not be read` : ''}${kept ? `, ${kept} kept from the last pull that read them` : ''}.${trSaid}`
      : `All ${ok} blueprint(s) read.${trSaid}`, fail || tFail || hidden || throttled ? 'warn' : 'ok');
    // Transitions count towards the gap, not only blueprints: a run that read every blueprint and
    // lost half their actions is not a run that read everything, and recording it as one is the
    // defect this project has already paid for once.
    // Hidden and throttled transitions are not retryable failures, but they are still unread.  The
    // caller must not advance the area to a full-details timestamp while either gap remains.
    return { failed: fail + tFail + hidden + (throttled ? 1 : 0) };
  } finally { setPullBusy(false); }
}
// Org-wide blueprint list → blueprints/index.json, plus one file per blueprint when the pull is a
// full one. «Pull list» stops at the index, like its three siblings.
async function pullBlueprints(depth = {}) {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  const full = !(depth && depth.full === false);   // «Pull list» stops at the index; see pullWorkflows
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // see pullSchedules below for why, and why it is released in a finally
    if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'warn'); return; }
    const ctx = await getContext(); if (!ctx) { setStatus(MSG.noTab, 'warn'); return; }
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus(MSG.envMismatch, 'warn'); return; }
    setStatus('Pulling blueprints…', 'busy');
    const r = await toBridge({ cmd: 'listBlueprints' }); if (!r?.ok) { const e = bridgeError(r, 'unknown'); await notePullFailure('blueprints', e, op); return; }
    if (!op.current()) return;   // you changed workspace while this was reading
    // A partial list is still an answer about access, and nothing is written to the mirror - the
    // same reasoning as `pullSchedules`, where bailing before `noteAccess` left a stale refusal on
    // record and a tab hidden for ever.
    if (r.capped) {
      setStatus('Zoho returned a partial list of blueprints - nothing was replaced.', 'warn');
      await noteAccess('blueprints', null, op, false);
      return;
    }
    await op.write('blueprints/index.json', JSON.stringify(r.entries, null, 2));
    // What Zoho no longer has goes, like every other area: a detail file left behind is a process
    // the panel would keep opening after it was deleted in the org.
    const liveIds = new Set((r.entries || []).map((e) => String(e.id)));
    let prunedB = 0; const bpRmFail = [];
    for await (const p of walk(op.root)) {
      if (p.startsWith('blueprints/') && p.endsWith('.json') && !p.endsWith('/index.json')) {
        // `<id>.actions.json` belongs to `<id>`: stripping only `.json` would leave «7000.actions»,
        // which is in no live id, so the next pull would delete the actions it had just read.
        const bid = p.split('/').pop().replace(/\.json$/, '').replace(/\.actions$/, '');
        if (!liveIds.has(bid)) { try { await op.remove(p); prunedB++; } catch (e) { if ((e && e.message) === WS_MOVED) return; bpRmFail.push(p); } }
      }
    }
    if (!(await loadBlueprintIndex(op))) return; if (viewMode === 'blueprints') renderBlueprints();
    const dl = full ? await downloadMissingBp(true) : null;   // every one, so an edit made in Zoho since the last pull arrives
    if (!full) setStatus(`Blueprints list pulled: ${(r.entries || []).length} in Zoho. The processes on disk were not read again - Pull list + details reads them.`, 'ok');
    if (prunedB) setStatus($('stxt').textContent + ` · ${prunedB} deleted removed`, 'ok');
    // A removal that failed is a deleted blueprint still on screen: the loader reads the disk, so the
    // residue is what the reader sees - said, recorded, and retried by the next pull for free.
    if (bpRmFail.length) setStatus($('stxt').textContent + ` · ${bpRmFail.length} deleted blueprint(s) could not be removed - the next pull retries`, 'warn');
    await noteAccess('blueprints', bpRmFail.length ? { status: 0, message: `${bpRmFail.length} stale blueprint file(s) could not be removed` } : null, op, true, ...pullDepth(full, { unread: dl ? dl.failed : 0 }));   // the mirror was written; the gap is what came up short in it
  } catch (e) { await notePullFailure('blueprints', e, op); } finally { endPull(); }
}
async function pullSchedules() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    // A pull is running: `reconcileFunctions` reads this to defer a save, create or delete notice
    // until it ends, because reconciling during a pull is a second list, a second index rewrite and
    // a second downloadMissing on top of the most expensive thing this panel does. Set by four pulls
    // and by none of the three here, which reach Zoho exactly like the other four. `finally`, so the
    // early returns inside this try release it too.
    pullActive = true;
    if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'warn'); return; }
    const ctx = await getContext(); if (!ctx) { setStatus(MSG.noTab, 'warn'); return; }
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus(MSG.envMismatch, 'warn'); return; }
    setStatus('Pulling schedules\u2026', 'busy');
    const r = await toBridge({ cmd: 'listSchedules' }); if (!r?.ok) { const e = bridgeError(r, 'unknown'); await notePullFailure('schedules', e, op); return; }
    if (!op.current()) return;   // you changed workspace while this was reading
    // **Zoho answered, so the verdict moves.** This bailed before `noteAccess`, and the record it
    // leaves is what says «this area was asked» - so an «ask again» ticked for a role that had since
    // been granted was never spent, the refusal on record was never overwritten, and the tab stayed
    // hidden while every later pull re-asked for ever. A partial list is still an answer: nothing is
    // written to the mirror, and what Zoho said about access is.
    if (r.capped) {
      setStatus('Zoho returned a partial list of schedules - nothing was replaced.', 'warn');
      await noteAccess('schedules', null, op, false);   // asked and answered; nothing was stored
      return;
    }
    await op.write('schedules/index.json', JSON.stringify(r.entries, null, 2));
    if (!(await loadScheduleIndex(op))) return; if (viewMode === 'schedules') renderSchedules();
    setStatus(`Schedules pull complete: ${(r.entries || []).length} schedules.${r.capped ? ' · stopped early - some may be missing' : ''}`, r.capped ? 'warn' : 'ok');
    await noteAccess('schedules', null, op);
  } catch (e) { await notePullFailure('schedules', e, op); } finally { endPull(); }
}
// Org-wide connections catalogue → connections/index.json. Written once per "Pull all".
async function pullConnections() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // see pullSchedules above for why, and why it is released in a finally
    if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'warn'); return; }
    const ctx = await getContext(); if (!ctx) { setStatus(MSG.noTab, 'warn'); return; }
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus('Connections: environment mismatch - refusing.', 'warn'); return; }
    setStatus('Pulling connections…', 'busy');
    const r = await toBridge({ cmd: 'pullConnections' });
    // **Through the shared path, so what the bridge said about *why* survives.** This wrote the
    // message straight onto the status line, which threw away `r.diag` - the cookie the token came
    // from, its shape, the cookies the page had - and, because `setStatus` hides the emergency
    // button, took away the way to report it. `pullConnections` is the only call in the product that
    // can produce that diagnostic, so «it is carried» and «nothing carries it» were the same thing.
    if (!r?.ok) { await notePullFailure('connections', bridgeError(r, 'connections pull failed'), op); return; }
    if (!op.current()) return;   // you changed workspace while this was reading
    await op.write('connections/index.json', JSON.stringify(r.connections || [], null, 2));
    if (viewMode === 'connections') await rebuildConnections();   // reflect it immediately, like the other pulls do
    else setStatus(`Connections pulled: ${(r.connections || []).length}.`, 'ok');
    await noteAccess('connections', null, op);
  } catch (e) { await notePullFailure('connections', e, op); } finally { endPull(); }
}
// ---------- automation actions (what a workflow fires) ----------
//
// Four kinds of object, one list. They are what a workflow rule points at - a notification, a field
// update, a task, a webhook - and Zoost mirrored the rules while resolving only the function ones,
// which in a real org is the smaller half: 275 notification actions against 149 function ones.
//
// The measurement that pays for the area is `associated`: in that same org, 85 notifications of 200,
// 50 field updates of 97 and 27 tasks of 56 are attached to nothing. It is the same statement this
// product already makes about a function nobody calls, on objects nobody ever prunes - and it is a
// candidate, never a verdict, because Zoho answers for the automations it knows about.
let actionData = [], actionFilter = 'all', actionUsers = null;
let actionSort = 'name', actionSortDir = 'asc';
// `null` means «nothing measured», never zero: an action whose module Zoho does not report is not an
// action in a module called nothing, and it sorts to the bottom rather than to the top of A-Z.
const ACTION_SORTS = {
  name: null,                       // the default: grouped by kind, names inside it
  rules: { label: 'rules that fire it', get: (a) => actionFiredBy(a).length },
  module: { label: 'module', get: (a) => a.module || null },
  modified: { label: MSG.lastModified, get: (a) => (a.modified_time ? (Date.parse(String(a.modified_time)) || null) : null) },
};
// The schema version the bridge writes. A row below it was captured before some of the fields
// existed - the field a rule writes and the value it writes were added after the first version -
// and «this pull did not read it» is not «Zoho says it is empty». Same mechanism, and same reason,
// as META_SV on a function's meta.
const ACT_SV = 4;
const actStale = (a) => (Number(a && a.sv) || 0) < ACT_SV;
// Two different absences, and they had the same appearance - none at all. A pull that could not read
// this one item says so by id; a pull made by an older copy of the extension says so by schema. Both
// are «not read», neither is «has none», and the wording is here once because four surfaces show it.
const MISS_DETAIL = 'Zoho did not answer for this one when it was pulled - its field mappings are not read';
const KEPT_DETAIL = 'Zoho did not answer for this one when it was pulled - the field mappings below are what the last pull that could read them saw';
// A «Pull list» does not ask for the detail at all, so «Zoho did not answer» would be a claim about a
// question nobody put. Found by review, on every task of an org after one list pull.
const LIST_MISS_DETAIL = 'Not read by the list pull that wrote this - its field mappings are not read yet';
const LIST_KEPT_DETAIL = 'Not read by the list pull that wrote this - the field mappings below are what the last pull that read them saw';
const actThin = (a) => a && a.detail_read === false;
const actKept = (a) => a && a.detail_kept === true;
/** Which rules fire each action, read from the workflow files already on disk.
 *
 *  This is the join the whole area rests on, and it costs nothing: `fetchWorkflow` has always
 *  written `conditions[].instant_actions.actions[]` and `conditions[].scheduled_actions[].actions[]`,
 *  every one of them carrying `{type, id, name}`. The panel resolved the `functions` ones and threw
 *  the rest away at the filter, so the id needed to answer «who sends this notification» was on disk
 *  the whole time. Keyed on kind+id, with the name as a fallback the way resolveFn() does it,
 *  because Zoho gives an id it knows and a name it displays. */
async function buildActionUsers(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  const map = new Map();
  let wfIdx = []; try { wfIdx = JSON.parse(await op.read('workflows/index.json')); } catch (_) {}
  for (const w of Array.isArray(wfIdx) ? wfIdx : []) {
    if (!op.current()) return null;
    let d = null; try { d = JSON.parse(await op.read(`workflows/${w.id}.json`)); } catch (_) {}
    if (!d) continue;   // not pulled: it is a rule with no measured actions, never a rule with none
    (d.conditions || []).forEach((c) => {
      const acts = [];
      if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions);
      (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || [])));
      acts.forEach((a) => {
        if (!a || !a.type) return;
        for (const key of [`${a.type}:${String(a.id)}`, `${a.type}:name:${String(a.name || '').toLowerCase()}`]) {
          if (!map.has(key)) map.set(key, []);
          if (!map.get(key).some((x) => x.kind === 'workflow' && String(x.id) === String(w.id))) {
            map.get(key).push({ id: w.id, name: w.name, kind: 'workflow' });
          }
        }
      });
    });
  }
  // **A blueprint transition fires actions too, and this map knew nothing about it.** Reported: open
  // the action a transition sends and the pane said «no rule uses it» - a relation the mirror holds,
  // shown from the blueprint side and from nowhere else. The join is the one the diagram and the
  // Fields table already make, out of the same files; only this map was walking the rules alone.
  let bpIdx = []; try { bpIdx = JSON.parse(await op.read('blueprints/index.json')); } catch (_) {}
  for (const b of Array.isArray(bpIdx) ? bpIdx : []) {
    if (!op.current()) return null;
    let acts = null; try { acts = JSON.parse(await op.read(`blueprints/${String(b.id)}.actions.json`)); } catch (_) {}
    if (!acts) continue;   // read by «Pull list» alone: nothing measured, never «it fires nothing»
    for (const t of Object.values(acts)) {
      for (const a of ((t && t.actions) || [])) {
        if (!a || !a.type || a.type === 'functions') continue;   // a function has its own two-way link
        for (const key of [`${a.type}:${String(a.id)}`, `${a.type}:name:${String(a.name || '').toLowerCase()}`]) {
          if (!map.has(key)) map.set(key, []);
          if (!map.get(key).some((x) => x.kind === 'blueprint' && String(x.id) === String(b.id))) {
            map.get(key).push({ id: String(b.id), name: b.name || String(b.id), kind: 'blueprint',
                               transition: (t && t.name) || '' });
          }
        }
      }
    }
  }
  return op.current() ? map : null;
}
/** Which rules fire this action, by id and then by name.
 *
 * `buildActionUsers` writes two keys per action on purpose: the id Zoho puts inside a workflow's
 * `instant_actions.actions[]` is not always the id the actions census carries - the same asymmetry
 * `healthOpenWorkflow` records as *measured*, where 77 of 77 workflow references matched by name and
 * none by id. The name key is the answer to that.
 *
 * **Four other readers asked the id key alone**: the health view's «nothing fires it» group, the
 * assistant's «attached to no rule» count and its `list_actions` tool, and both reports - where
 * `loadExportData` did not even build the second key. So one action read as `1 rule` on the Actions
 * tab and as *fired by nothing* in the list a reader uses to decide what is safe to delete.
 *
 * The map is a parameter now, so the panel's global and the export's local one go through the same
 * lookup. The panel's own callers pass nothing and get the global, as before.
 */
function firedBy(a, map = actionUsers) {
  if (!map) return [];
  // **Both keys, merged - not one or the other.** The `||` was right only while exactly one of them
  // could exist: a workflow's action reference matches the census by name (77 of 77 measured, none
  // by id), so the id key was absent and the lookup fell through to the name key and found the rule.
  // The blueprint join *creates* the id key whenever a transition's action id matches the census -
  // so the `||` then stopped at a list holding only the blueprint, and the rule disappeared from the
  // Actions table, from both reports and from the assistant at once. Found by executing the shipped
  // code on a shape where a rule and a transition fire the same action: Rules went 1 -> 0.
  const byId = map.get(`${a.kind}:${String(a.id)}`) || [];
  const byName = map.get(`${a.kind}:name:${String(a.name || '').toLowerCase()}`) || [];
  const seen = new Set();
  return byId.concat(byName).filter((w) => {
    const k = `${w.kind || 'rule'}:${w.id}:${w.transition || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function actionFiredBy(a) { return firedBy(a); }
/** The fields that make a rule fire, read out of the rule's own trigger.
 *
 *  Zoho CRM states a rule's trigger inside the rule and nowhere else, so «which workflows start when
 *  this field changes» has no answer on the platform - asked for by the author, on a real org, looking
 *  for exactly that. Two trigger types name a field, measured on an org of 106 rules: `field_update`
 *  lists the watched fields as criteria leaves whose comparator and value are both `${ANYVALUE}`,
 *  alone or inside OR groups nested four deep; `date_or_datetime` names one date field in
 *  `details.field`, with the offset beside it. Nothing else is read: the Calls module's
 *  `*_call_field_update` types are documented and were never seen, and `section_update` names section
 *  ids rather than fields - so a field those watch shows no rule, never a guessed one. */
const ANY_VALUE = '${ANYVALUE}';
function ruleTriggerFields(rule) {
  const ew = (rule && rule.execute_when) || {}, det = ew.details || {};
  const own = rule && rule.module;
  const module = (det.trigger_module && det.trigger_module.api_name)
    || (typeof own === 'string' ? own : (own && own.api_name)) || '';
  const fields = [];
  const add = (f) => { if (f && f.api_name && !fields.includes(f.api_name)) fields.push(f.api_name); };
  if (ew.type === 'date_or_datetime') { add(det.field); return { module, kind: 'date', fields, when: dateTriggerText(det) }; }
  if (ew.type === 'field_update') {
    const walk = (c) => { if (!c) return; if (Array.isArray(c.group)) c.group.forEach(walk); else add(c.field); };
    walk(det.criteria);
    return { module, kind: 'change', fields, when: '' };
  }
  return { module, kind: null, fields, when: '' };
}
/** The fields a rule writes: its field-update actions, looked up in the actions census.
 *
 *  A rule names an action as {type, id, name}, and the id there is not always the census id - measured,
 *  77 of 77 references matched by name and none by id - so the id is tried first, where it is exact,
 *  and a name second, only when it identifies one action. The census is what knows the field and the
 *  module: an action pulled before it recorded the field (`field` empty) writes nothing this can name. */
function ruleWrittenFields(rule, actions) {
  const out = [];
  const byId = new Map(), byName = new Map();
  for (const a of actions || []) {
    if (!a || a.kind !== 'field_updates') continue;
    byId.set(String(a.id), a);
    const k = String(a.name || '').toLowerCase();
    byName.set(k, byName.has(k) ? null : a);   // null: two actions share it, so it names neither
  }
  for (const c of (rule && rule.conditions) || []) {
    const acts = [];
    if (c && c.instant_actions && Array.isArray(c.instant_actions.actions)) acts.push(...c.instant_actions.actions);
    for (const sa of Array.isArray(c && c.scheduled_actions) ? c.scheduled_actions : []) acts.push(...((sa && sa.actions) || []));
    for (const ref of acts) {
      if (!ref || ref.type !== 'field_updates') continue;
      const a = byId.get(String(ref.id)) || byName.get(String(ref.name || '').toLowerCase());
      if (a && a.field && a.module && !out.some((o) => o.module === a.module && o.field === a.field)) {
        out.push({ module: a.module, field: a.field, value: writtenValue(a) });
      }
    }
  }
  return out;
}
/** The fields a rule's conditions check, and what each is compared with.
 *
 *  Measured on two orgs, 379 conditions: `conditions[].criteria_details.criteria` is one leaf or an
 *  AND/OR group of them, nested; a leaf is {comparator, field: {api_name, id}, type: 'value', value},
 *  the value a string, a boolean, a list of strings or a {name, display_label, id} object, and
 *  `${EMPTY}` for «empty». 50 conditions had no criteria at all - they apply to every record - and
 *  `relational_criteria` was null in every one of the 379, so a condition on a related module is not
 *  read: what it would look like has not been seen. A leaf whose value names another field (`type`
 *  other than 'value') was not seen either, and is read as «compared with another field», naming neither. */
function ruleCheckedFields(rule) {
  const own = rule && rule.module, det = ((rule && rule.execute_when) || {}).details || {};
  const module = (det.trigger_module && det.trigger_module.api_name)
    || (typeof own === 'string' ? own : (own && own.api_name)) || '';
  const out = new Map();
  const walk = (c) => {
    if (!c || typeof c !== 'object') return;
    if (Array.isArray(c.group)) { c.group.forEach(walk); return; }
    const api = c.field && c.field.api_name; if (!api) return;
    const said = comparedText(c);
    if (!out.has(api)) out.set(api, []);
    if (said && !out.get(api).includes(said)) out.get(api).push(said);
  };
  for (const cond of (rule && rule.conditions) || []) walk(cond && cond.criteria_details && cond.criteria_details.criteria);
  return [...out].map(([field, said]) => ({ module, field, when: said.length ? `checks ${said.join('; ')}` : 'checks it' }));
}
const COMPARED = { equal: 'is', not_equal: 'is not', contains: 'contains', not_contains: 'does not contain',
                   starts_with: 'starts with', ends_with: 'ends with', between: 'between', not_between: 'not between',
                   greater_than: 'greater than', less_than: 'less than' };
function comparedText(leaf) {
  const v = leaf.value;
  const words = COMPARED[leaf.comparator] || String(leaf.comparator || '').replace(/_/g, ' ');
  if (leaf.type && leaf.type !== 'value') return `${words} another field`;
  const val = v === '${EMPTY}' || v === '${empty}' ? 'empty'
    : Array.isArray(v) ? v.join(', ')
    : v && typeof v === 'object' ? (v.display_label || v.name || '')
    : v == null ? '' : String(v);
  return `${words} ${val}`.trim();
}
/** What a field update puts in the field, in words: absent is «clears it», which is what Zoho means
 *  by no value - not «unknown». */
function writtenValue(a) {
  const v = a.value;
  if (v === null || v === undefined) return 'clears it';
  if (Array.isArray(v)) return `writes ${v.join(', ')}`;
  if (typeof v === 'object') return `writes ${v.name || v.display_value || JSON.stringify(v)}`;
  return `writes ${String(v)}`;
}
/** «3 days after at 13:00», from the offset a date rule carries. A negative unit is before the date
 *  and zero is the day itself, both measured; a unit that is absent says nothing rather than «on the
 *  date», which would be a claim. */
function dateTriggerText(det) {
  const parts = [];
  if (det.unit != null && Number.isFinite(Number(det.unit))) {
    const n = Number(det.unit), per = String(det.period || 'days');
    parts.push(n === 0 ? 'on the date'
      : `${Math.abs(n)} ${Math.abs(n) === 1 ? per.replace(/s$/, '') : per} ${n < 0 ? 'before' : 'after'}`);
  }
  if (typeof det.execute_at === 'string' && det.execute_at) parts.push(`at ${det.execute_at.slice(0, 5)}`);
  if (det.recur_cycle && det.recur_cycle !== 'once') parts.push(`repeats ${det.recur_cycle}`);
  return parts.join(' ');
}
/** True when a criteria tree only names fields to watch - every leaf `${ANYVALUE}` on both sides - so
 *  printing it as a condition would read «Status ${ANYVALUE} ${ANYVALUE}», which it used to. */
function critWatchesOnly(crit) {
  if (!crit) return false;
  if (Array.isArray(crit.group)) return crit.group.length > 0 && crit.group.every(critWatchesOnly);
  return crit.comparator === ANY_VALUE && crit.value === ANY_VALUE;
}
/** `module:field` -> the rules that touch it, each with its role: `starts` (the field's change or
 *  its date makes the rule fire), `checks` (a condition compares it) or `writes` (a field update the
 *  rule runs). One builder for the panel
 *  and both reports, so the three cannot disagree. A rule with two roles on one field is two entries;
 *  `ruleCount` counts it once. */
function fieldTriggerMap(rules, actions) {
  const map = new Map();
  const put = (key, entry) => { if (!map.has(key)) map.set(key, []); map.get(key).push(entry); };
  for (const r of rules || []) {
    const base = { id: String(r.id), name: r.name || String(r.id), active: !!(r.status && r.status.active) };
    const t = ruleTriggerFields(r);
    for (const f of t.fields) put(`${t.module}:${f}`, { ...base, role: 'starts', kind: t.kind, when: t.when });
    for (const c of ruleCheckedFields(r)) put(`${c.module}:${c.field}`, { ...base, role: 'checks', kind: 'check', when: c.when });
    for (const w of ruleWrittenFields(r, actions)) put(`${w.module}:${w.field}`, { ...base, role: 'writes', kind: 'write', when: w.value });
  }
  return map;
}
/** Which blueprints touch a field, keyed exactly as the workflow map is: `module:field`.
 *
 *  Two ways a process touches a field, and they are different facts to a reader. It **runs on** one -
 *  the picklist whose values are its states, which the index row names - and its transitions **write**
 *  others, through field update actions whose ids join the same catalogue a rule's actions join.
 *
 *  The same key and the same entry shape as `fieldTriggerMap`, so the table, the layer and both
 *  reports treat the two columns alike instead of growing a second vocabulary for the same idea. */
function blueprintFieldMap(bps, actions, modRows) {
  const map = new Map();
  const put = (key, entry) => { if (!map.has(key)) map.set(key, []); map.get(key).push(entry); };
  const byAct = new Map();
  (actions || []).forEach((a) => { if (a && a.kind === 'field_updates') byAct.set(String(a.id), a); });
  // **The key has to be in the reader's dimension.** A blueprint's `module` comes from the blueprints
  // reply, which spells a custom module `CustomModule20`; every consumer of this map - the fields
  // table, both reports and `get_module` - asks with the modules index's `api_name`, `Iscrizioni`. So
  // the «runs on» entry for a custom module matched nothing and the BP column beside a filled WF one
  // read as «no process runs on this field», which is worse than empty. Translated once, here, because
  // this is the single function all three surfaces go through. Without rows it is a no-op, so a caller
  // that has no index keeps exactly today's behaviour rather than a half-translated map.
  const modApi = new Map();
  (modRows || []).forEach((m) => { if (m && m.module_name && m.api_name) modApi.set(m.module_name, m.api_name); });
  const modOf = (api) => (api ? (modApi.get(api) || api) : api);
  for (const b of bps || []) {
    if (!b || !b.module) continue;
    const base = { id: String(b.id), name: b.name || String(b.id), active: b.active !== false };
    if (b.field) put(`${modOf(b.module)}:${b.field}`, { ...base, role: 'runs on', when: 'the states of this field' });
    for (const t of Object.values((b && b.acts) || {})) {
      for (const a of ((t && t.actions) || [])) {
        if (!a || a.type !== 'field_updates' || !a.id) continue;
        const row = byAct.get(String(a.id));
        if (!row || !row.field) continue;   // Actions not pulled: unknown, never "writes nothing"
        put(`${modOf(row.module || b.module)}:${row.field}`,
            { ...base, role: 'writes', when: row.value == null ? 'clears it' : String(row.value),
              transition: (t && t.name) || '' });
      }
    }
  }
  return map;
}
let blueprintFields = null;
/** The same reading as `buildFieldTriggers`, for blueprints: the index, the actions catalogue, and
 *  one transitions file per blueprint. A blueprint in the index whose actions were never read is
 *  counted rather than skipped - it may write any field, so the table can say how many it cannot see. */
async function buildBlueprintFields(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  let idx = null; try { idx = JSON.parse(await op.read('blueprints/index.json')); } catch (_) {}
  if (!Array.isArray(idx)) return op.current() ? { map: new Map(), pulled: false, unread: 0, actions: false } : null;
  let acts = null; try { acts = JSON.parse(await op.read('actions/index.json')); } catch (_) {}
  // The index that holds both spellings of a module's name: a blueprint says `CustomModule20` and
  // every reader of this map asks by `api_name`. Absent, the map is keyed as it always was.
  let modRows = null; try { modRows = JSON.parse(await op.read('modules/index.json')); } catch (_) {}
  if (!op.current()) return null;
  const rows = []; let unread = 0;
  for (const b of idx) {
    if (!op.current()) return null;
    let a = null; try { a = JSON.parse(await op.read(`blueprints/${String(b.id)}.actions.json`)); } catch (_) {}
    if (a) rows.push({ ...b, acts: a }); else { rows.push({ ...b, acts: null }); unread++; }
  }
  return op.current()
    ? { map: blueprintFieldMap(rows, Array.isArray(acts) ? acts : [], Array.isArray(modRows) ? modRows : []), pulled: true, unread,
        actions: Array.isArray(acts) }
    : null;
}
/** Built when absent and kept only if nothing was written while it was being read - the same
 *  single-flight mark `fieldTriggersNow` uses, and for the same defect: a pull writes one file at a
 *  time, and a reading taken across one of those writes outlives the write that should have dropped it. */
async function blueprintFieldsNow(op, stillMine) {
  let t = blueprintFields && !blueprintFields.reading ? blueprintFields : null;
  for (let tries = 0; t === null && tries < 3; tries++) {
    const mark = { reading: true };
    blueprintFields = mark;
    t = await buildBlueprintFields(op);
    if (!stillMine() || !t) { if (blueprintFields === mark) blueprintFields = null; return null; }
    if (blueprintFields === mark) blueprintFields = t;
    else if (tries < 2) t = null;
  }
  return t;
}
const ruleCount = (entries) => new Set((entries || []).map((e) => e.id)).size;
/** A rule's role on a field, in the words the layer and both reports use. */
function roleText(r) {
  return r.role === 'writes' || r.role === 'checks' ? r.when : r.kind === 'date' ? (r.when || 'on a date') : 'on change';
}
/** The same map for the panel, from the rule files on disk. A rule in the index with no file is
 *  counted rather than skipped: it may watch any field, so the table says how many it cannot see. */
let fieldTriggers = null;
async function buildFieldTriggers(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  let idx = null; try { idx = JSON.parse(await op.read('workflows/index.json')); } catch (_) {}
  if (!Array.isArray(idx)) return op.current() ? { map: new Map(), pulled: false, unread: 0, actions: false } : null;
  // Without the census a rule's field updates name no field, so «writes» is unknown rather than none.
  let acts = null; try { acts = JSON.parse(await op.read('actions/index.json')); } catch (_) {}
  if (!op.current()) return null;
  const rules = []; let unread = 0;
  for (const w of idx) {
    if (!op.current()) return null;
    let d = null; try { d = JSON.parse(await op.read(`workflows/${w.id}.json`)); } catch (_) {}
    if (d) rules.push(Object.assign({ id: w.id, name: w.name }, d)); else unread++;
  }
  return op.current() ? { map: fieldTriggerMap(rules, Array.isArray(acts) ? acts : []), pulled: true, unread, actions: Array.isArray(acts) } : null;
}
/** The map for a table about to be drawn: built when absent, and kept only if no rule was written
 *  while it was being read. A pull writes rule files one at a time, so a reading taken across one of
 *  those writes was assigned over the null `noteWrite` had just left - an older map outliving the
 *  pull that replaced it. Found by review. The slot holds a mark while it reads, and a write replaces
 *  the mark with null the way it drops every other cache, so «was anything written» is one identity
 *  test and `noteWrite` stays a table of nulls. Three readings at most; past that the last one is
 *  drawn and not kept, so the next table reads again. `null` means the caller is no longer drawing. */
async function fieldTriggersNow(op, stillMine) {
  let t = fieldTriggers && !fieldTriggers.reading ? fieldTriggers : null;
  for (let tries = 0; t === null && tries < 3; tries++) {
    const mark = { reading: true };
    fieldTriggers = mark;
    t = await buildFieldTriggers(op);
    if (!stillMine() || !t) { if (fieldTriggers === mark) fieldTriggers = null; return null; }
    if (fieldTriggers === mark) fieldTriggers = t;
    else if (tries < 2) t = null;
  }
  return t;
}
const ACTION_LABEL = { email_notifications: 'Email notifications', field_updates: 'Field updates',
                       tasks: 'Tasks', webhooks: 'Webhooks' };
// A kind Zoho invents tomorrow gets a readable label without anyone editing this: underscores out,
// first letter up. Declared ones win, the rest are derived - the same rule the diagram window uses
// for category colours.
const actionKindLabel = (k) => ACTION_LABEL[k] || String(k || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
// The column form, for the flat sorts where the group headers are gone. Cutting the label to four
// characters - which is what the functions rows do to a namespace - gave «Emai», «Fiel», «Webh»:
// a namespace truncates into something still recognisable and a sentence does not.
const ACTION_SHORT = { email_notifications: 'Email', field_updates: 'Field', tasks: 'Task', webhooks: 'Webhook' };
const actionKindShort = (k) => ACTION_SHORT[k] || actionKindLabel(k).split(' ')[0];
async function loadActionsIndex(op = beginWorkspaceOp()) {
  let idx = []; try { idx = JSON.parse(await op.read('actions/index.json')); } catch (_) {}
  if (!op.current()) return null;
  return Array.isArray(idx) ? idx : [];
}
async function pullActions(depth = {}) {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  // «Pull list» reads the four lists and no task one by one; the bridge then reports every task as a
  // detail not read, which is exactly the case this pull already keeps the last reading for.
  const full = !(depth && depth.full === false);
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // see pullSchedules above for why, and why it is released in a finally
    if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'warn'); return; }
    const ctx = await getContext(); if (!ctx) { setStatus(MSG.noTab, 'warn'); return; }
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus(MSG.wrongTab, 'warn'); return; }
    setStatus('Pulling automation actions\u2026', 'busy');
    const r = await toBridge({ cmd: 'pullActions', taskDetails: full });
    // It said «Actions pull failed: unknown» - `toBridge` resolves `undefined` when nothing is
    // listening, so a reloaded Zoho tab produced the one sentence that names neither the problem
    // nor the remedy, and `setStatus` then hid the report button. Every other pull reports through
    // `notePullFailure`, which records the verdict, keeps the diagnostic and says the true thing.
    if (!r?.ok) throw bridgeError(r, 'actions read failed');
    if (!op.current()) return;   // you changed workspace while this was reading
    // A kind that refused is stated rather than folded into the total: an org without webhooks and
    // an org whose role cannot read them look identical in a count.
    const missed = (r.missed || []).filter((m) => m && m.kind);
    const capped = r.capped || [];
    // The tab keeps the content script it was loaded with: reloading the extension does not replace
    // it. So a pull can be answered by the previous version, which writes rows without the fields the
    // current one captures - and those fields are on disk already, measured by a pull that could read
    // them. Overwriting them would lose a reading and mark the loss «not read by the pull that wrote
    // this», which is true and unactionable. It used to write first and check afterwards; it checks
    // first and does not write, because the one thing to do here is reload that tab.
    if ((Number(r.sv) || 0) < ACT_SV) { setStatus(MSG.staleBridge, 'warn'); return; }
    // This census is per kind, and so is its incompleteness - which is why this does not do what the
    // schedules pull does and refuse the whole write. Refusing it would mean that one kind the role
    // cannot reach freezes the other three for ever, in every pull, for that org. So: a kind read
    // whole is replaced, deletions included, and a kind that refused or stopped early keeps what the
    // previous census had and takes what this one saw.
    //
    // The guard used to read `capped` alone while the comment beside it said «a kind that could not
    // be read makes the answer partial» - so a kind that refused outright, the worse half, lost every
    // item the previous pull had censused. And it wrote *before* checking the schema version, then
    // wrote the same thing again inside the check: completeness and schema are decided first now,
    // and there is one write.
    //
    // `capped` also carries `tasks (detail)`, which is not a kind: every task is in the list and some
    // carry less detail. That is reported, not merged - restoring a field this pull did not read
    // would be asserting something nobody measured.
    const partial = new Set([...missed.map((m) => m.kind), ...capped]);
    // A task whose detail did not answer is not a task with no field mappings, and it arrived as one:
    // full schema version, thin row, written over a row that had them. Named by id, so what is kept
    // is exactly the item that was not read - the kind around it was read whole and is replaced.
    const detailMissed = (r.detail_missed || []).filter((d) => d && d.kind && d.id != null);
    let actions = r.actions || [];
    if (partial.size || detailMissed.length) {
      const seen = new Set(actions.map((a) => `${a.kind}:${a.id}`));
      const prev = (await loadActionsIndex(op)) || [];
      const kept = prev.filter((a) => partial.has(a.kind) && !seen.has(`${a.kind}:${a.id}`));
      if (kept.length) actions = actions.concat(kept);
      if (detailMissed.length) {
        const thin = new Set(detailMissed.map((d) => `${d.kind}:${String(d.id)}`));
        const listed = new Set(detailMissed.filter((d) => d.reason === 'list pull').map((d) => `${d.kind}:${String(d.id)}`));
        const before = new Map(prev.map((a) => [`${a.kind}:${String(a.id)}`, a]));
        actions = actions.map((a) => {
          const k = `${a.kind}:${String(a.id)}`;
          if (!thin.has(k)) return a;
          const p = before.get(k), byList = listed.has(k);
          // A row that was itself kept still carries the last mappings anybody read: a second list pull
          // in a row replaced it with the list's five of six and dropped the reminder, with no warning.
          // Found by review. Only a row that never had them has nothing to give.
          if (!p || (p.detail_read === false && !p.detail_kept) || !(p.mappings || []).length) return byList ? { ...a, detail_list: true } : a;
          // Only the mappings, and said so. Keeping the previous row *whole* was worse than losing
          // it: everything this pull did read - the name, the module, the modified date - was thrown
          // away in favour of a row from before, and the result carried `detail_read: true`, so the
          // panel presented last week's name as current and nothing warned. The fields this pull
          // read win; the half it could not read comes from the last pull that could, and the row
          // says where it came from.
          return { ...a, mappings: p.mappings, detail_read: false, detail_kept: true, detail_list: byList,
                   detail_kept_from: p.detail_kept ? (p.detail_kept_from || null) : (p.modified_time || null) };
        });
      }
      if (!op.current()) return;   // reading the previous census is an await, and the folder can move under one
    }
    await op.write('actions/index.json', JSON.stringify(actions, null, 2));
    // Both are stated rather than folded into the count: a kind that refused and a kind that was cut
    // short are two different reasons for a number to be smaller than the org.
    // On `detailMissed`, not on what survived it: a row that kept the previous pull's mappings is
    // still a row this pull could not read, and counting only the empty ones meant the one case
    // where something was salvaged reported «1 action(s) pulled.» with no warning at all.
    const kept = detailMissed.filter((d) => actions.some((x) => `${x.kind}:${String(x.id)}` === `${d.kind}:${String(d.id)}` && x.detail_kept));
    // A task a list pull did not read was not asked for, so it is not a failure to report - the bar
    // says how old those mappings are. What a full pull could not read still is.
    const unread = detailMissed.filter((d) => d.reason !== 'list pull');
    const note = (missed.length ? ` ${missed.length} kind(s) could not be read - what the last pull saw of them was kept.` : '')
      + (capped.length ? ` ${capped.join(', ')} stopped early - there are more in Zoho, and nothing was removed.` : '')
      + (unread.length ? ` ${unread.length} task(s) whose detail Zoho did not return`
          + (kept.length ? ` - ${kept.length} of them still show the field mappings the last pull read.` : ' - they are listed, their field mappings are not read.') : '');
    const said = full ? `${actions.length} action(s) pulled.` : `Actions list pulled: ${actions.length}. Task field mappings on disk were not read again - Pull list + details reads them.`;
    if (viewMode === 'actions') { await rebuildActions(); setStatus(said + note, note ? 'warn' : 'ok'); }
    else setStatus(said + note, (missed.length || capped.length || unread.length) ? 'warn' : 'ok');
    // «Every item read» only when it was: a task past the per-pull bound, or one Zoho did not answer,
    // leaves the details older than the list, and the bar has to be able to say so.
    // "full" is an area-level claim: every kind and every item must have answered.  A refused or
    // capped kind is still a measured gap even though its previous rows were safely kept, and a
    // detail refusal is the same for that item.  Marking the area full here made the freshness bar
    // say all action details were current while one category was still from the previous pull.
    await noteAccess('actions', null, op, true, ...pullDepth(full, { kinds: missed.length + capped.length, unread: detailMissed.length }));
  } catch (e) { await notePullFailure('actions', e, op); } finally { endPull(); }
}
async function rebuildActions() {
  // These read the mirror and then publish a whole list into the panel's memory. A rebuild is
  // short, but it is not instant, and what overtakes it is a change of workspace - so the list of
  // one org arrived in the panel showing another. Found by `tools/asynccheck.py`, which derives
  // this class instead of waiting for the next reader to notice an instance of it.
  const op = beginWorkspaceOp();
  if (!dir) return;
  try {
    if (!(await ensurePerm(dir))) { op.say(MSG.folder, 'warn'); return; }
    op.say('Reading automation actions\u2026', 'busy');
    const _cfg = await opReadCfg(op); if (!op.current()) return; if (_cfg) bound = _cfg; await cacheBinding(bound);
    const idx = await loadActionsIndex(op); if (!idx || !op.current()) return;
    // Both publications after the last await, not before it. The first version of this guard sat
    // above the walk of the rules - so the check ran, the walk took its time, and the two lists were
    // published into whatever workspace had arrived meanwhile. A guard before an await is not a guard.
    const users = await buildActionUsers(op);   // one walk of the rules, not one per item opened
    if (!op.current()) return;
    actionUsers = users;
    actionData = idx.map((a) => ({ ...a, path: 'actions/' + a.kind + '/' + a.id }));
    buildTypeChips();          // the kinds come from the data, so the filter is built after it loads
    renderActions();
    op.say(actionData.length ? `${actionData.length} automation action(s).` : (emptyReason('actions') || 'No automation actions pulled yet - click Pull all.'), actionData.length ? 'ok' : 'warn');
  } catch (e) { if (op.current()) setStatus('Actions error: ' + e.message, 'bad'); }
  if (op.current()) await refreshContext();
}
function renderActions() {
  if (viewMode !== 'actions') return;
  const term = $('find').value.trim().toLowerCase();
  const pass = (a) => {
    if (actionFilter === 'unused' && a.associated) return false;
    if (actionFilter !== 'all' && actionFilter !== 'unused' && a.kind !== actionFilter) return false;
    return !term || (a.name || '').toLowerCase().includes(term) || (a.module || '').toLowerCase().includes(term)
      || (a.field || '').toLowerCase().includes(term) || ((a.template && a.template.name) || '').toLowerCase().includes(term);
  };
  // Sorting by a column answers a different question from browsing by kind, so - exactly as the
  // functions list does - any sort other than the default drops the group headers and goes flat,
  // with the sorted value carried on each row instead.
  const sorter = ACTION_SORTS[actionSort];
  const dir = actionSortDir === 'asc' ? 1 : -1;
  const list = actionData.filter(pass).sort(sorter
    ? (a, b) => {
      const va = sorter.get(a), vb = sorter.get(b);
      // A row with nothing measured stays at the bottom whichever way we sort: an ascending list
      // must not open with the actions we know least about.
      if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
      if (va === null) return byField('name')(a, b);
      if (va !== vb) return dir * (typeof va === 'string' ? String(va).localeCompare(String(vb)) : va - vb);
      return byField('name')(a, b);
    }
    : (a, b) => (a.kind || '').localeCompare(b.kind || '') || dir * byField('name')(a, b));
  const tree = $('tree'); tree.innerHTML = '';
  if (!list.length) {
    // Three reasons for an empty list and they are different advice - the rule this panel applies
    // everywhere: say *the* reason, not *a* reason.
    tree.innerHTML = '<div class="empty">' + (actionData.length ? '<b>No matches.</b>' : (emptyReason('actions') || '<b>No automation actions yet.</b> Press <b>Pull all</b> to read them.')) + '</div>';
    return;
  }
  if (sorter) {
    const noData = list.filter((a) => sorter.get(a) === null).length;
    const hdr = document.createElement('div'); hdr.className = 'srhdr';
    hdr.textContent = `${list.length} action(s) by ${sorter.label}, ${actionSortDir === 'asc' ? 'lowest' : 'highest'} first`
      + (noData ? ` \u00b7 ${noData} without one` : '');
    tree.appendChild(hdr);
  }
  let group = null;
  // Whether the group being emitted is folded away. The other four lists build their groups in an
  // outer loop and can `return` out of one; this one walks a flat sorted list and starts a group when
  // the kind changes, so the state has to be carried across iterations rather than scoped to a group.
  let groupCollapsed = false;
  list.forEach((a) => {
    if (sorter) { group = a.kind; groupCollapsed = false; }   // flat: no headers, and the kind rides on the row instead
    else if (a.kind !== group) {
      group = a.kind;
      // Prefixed, like `mod:` `sc:` `wf:`, because `collapsed` is one Set shared by every list: a
      // bare key here would fold a namespace on the Functions tab that happened to share the name.
      //
      // `kind` is a block-scoped copy and the handler below closes over *it*, never over `group`.
      // The other four lists take their key from a forEach parameter, which is a fresh binding per
      // call and safe by construction; this one walks a flat list and mutates one outer `let`, so a
      // handler reading `group` would run long after the loop had left it on the last kind - every
      // header folding the same group, and nothing about the code looking wrong.
      const kind = group;
      const isCol = collapsed.has('act:' + kind);
      groupCollapsed = isCol;
      const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
      const n = list.filter((x) => x.kind === group).length;
      g.innerHTML = `<span class="chev">\u25be</span><span>${escHtml(actionKindLabel(group).toUpperCase())}</span><span class="cnt">${n}</span>`;
      g.onclick = () => { isCol ? collapsed.delete('act:' + kind) : collapsed.add('act:' + kind); renderActions(); };
      tree.appendChild(g);
    }
    if (groupCollapsed) return;
    const el = document.createElement('div'); el.className = 'f'; el.dataset.path = a.path;
    el.setAttribute('aria-selected', a.path === currentPath);
    // The dot is the mirror state and nothing else - «this is on your disk» - because that is what
    // it means on every other tab: ● here · ○ not here yet · ◐ partial · ⟳ failed · ⊘ refused. It
    // was ◐ for «no rule uses it», which reads as «downloaded incompletely»: a glyph that means two
    // things is worse than none, and this panel has already paid for that once with ↺ against ↻.
    //
    // «Attached to nothing» is a fact about the object, so it is a badge, and it is a **count** -
    // the same one the Connections tab shows for the functions using a connection. A number and no
    // verdict: zero says it by itself, and the filter is how you list them.
    const used = actionFiredBy(a).length;
    // Every trailing slot is always emitted, empty when it has nothing to say - the same rule as the
    // functions rows, and for the same reason: a slot that disappears lets the next one slide into
    // its place and the columns stop lining up down the list.
    const kindSlot = sorter ? `<span class="rest rk" title="${escA(actionKindLabel(a.kind))}">${escHtml(actionKindShort(a.kind))}</span>` : '';
    el.innerHTML = `<span class="st st-ok" title="In the local mirror - click to re-read from Zoho">\u25cf</span>`
      + `<span class="fname">${escHtml(a.name || a.id)}</span>`
      + `<span class="rest rm" title="${escA(a.module_label || a.module || 'no module')}">${escHtml(a.module || '')}</span>`
      + kindSlot
      + `<span class="rest rs" title="${escA('Pulled before this version captured everything about it - press Pull list + details to complete it')}">${actStale(a) ? '\u25d0' : ''}</span>`
      + `<span class="rest ru${used || a.associated ? '' : ' none'}" title="${escA(used ? 'what fires it - rules and blueprint transitions, read from the files on disk' : a.associated ? 'Zoho reports it as in use; nothing on disk names it' : 'nothing on disk fires it, and Zoho does not report it as in use')}">${used}\u00d7</span>`;
    el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); refreshActions(); };
    el.onclick = () => openAction(a);
    tree.appendChild(el);
  });
}
async function refreshActionsNow() {
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  setStatus('Refreshing automation actions\u2026', 'busy');
  await pullActions();
}
async function refreshActions() {
  return runPullAction(refreshActionsNow);
}
/** One mapped field of a task, rendered from what it is rather than from what Zoho called it.
 *
 *  `value` is the configuration and is language-neutral: 'Not Started', 'High', {id,name} for an
 *  owner, {sign, unit, period, trigger_field} for a date, plus {time, notify_type} for a reminder.
 *  `display` is Zoho's own rendering in the org's language and is used only where the structure is a
 *  shape nobody here has seen - which is the honest fallback, and it says so by staying in italics. */
function mappingHtml(m) {
  const v = m && m.value;
  const rel = (o) => `${escHtml(String(o.unit || '?'))} ${escHtml(String(o.period || ''))} `
    + `${o.sign === 'minus' ? 'before' : 'after'} <span class="mono">${escHtml(prettyTrigger(o.trigger_field))}</span>`
    + (o.time ? ` at ${escHtml(String(o.time))}` : '')
    + (o.notify_type ? ` <span style="color:var(--muted)">by ${escHtml(String(o.notify_type).replace(/and/g, ' and '))}</span>` : '');
  if (v && typeof v === 'object' && (v.sign || v.period || v.unit)) return rel(v);
  if (v && typeof v === 'object' && (v.name || v.id)) return escHtml(v.name || v.id);
  if (typeof v === 'string' && v !== '') return escHtml(v);
  if (typeof v === 'boolean' || typeof v === 'number') return escHtml(String(v));
  return m && m.display ? `<i>${escHtml(m.display)}</i>` : '';
}
// `${CURRENTTIME}` and `${!Tasks.Due_Date}` are how Zoho names what a delay is measured from. They
// are shown as they are, minus the punctuation that only means «this is a placeholder».
const prettyTrigger = (t) => String(t || '').replace(/^\$\{!?/, '').replace(/\}$/, '') || 'the trigger';
function openAction(a) {
  previewLoad++;
  currentPath = a.path; navHere(a.name || a.id);
  selectRow(a.path);
  setPvName(a.name || a.id, 'actions/index.json');
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);
  // Absent rather than disabled, which is this panel's rule: for a webhook there is no page anyone
  // has shown me, and a greyed button says «there is something here you cannot have» about a page
  // that may not exist.
  const canOpen = !!actionUrl(a);
  $('pvreveal').style.display = canOpen ? '' : 'none';
  $('pvreveal').textContent = MSG.openInZoho;
  $('pvreveal').title = MSG.openThis + actionKindLabel(a.kind).toLowerCase().replace(/s$/, '') + ' in Zoho';
  $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  const row = (k, v) => v == null || v === '' ? '' : `<div class="wfrow"><span class="wk">${escHtml(k)}</span> ${v}</div>`;
  const fires = actionFiredBy(a);
  const firesWf = fires.filter((w) => w.kind !== 'blueprint');
  const firesBp = fires.filter((w) => w.kind === 'blueprint');
  let h = '<div class="wfd">'
    + row('Kind', escHtml(actionKindLabel(a.kind)))
    // A chip, not a word: the module an action writes to is the same relation the Fields table draws
    // from the other side. `data-mod` carries the api name; the label is what the reader recognises.
    + row('Module', a.module
        ? `<span class="wf-fn" data-mod="${escA(a.module)}" title="${escA(a.module + ' - click to open the module')}">${escHtml(a.module_label || a.module)}</span>`
        : '')
    // «rule(s)» was the whole vocabulary here, and a blueprint transition fires actions too - so an
    // action a process sends read as «no rule uses it». Each kind is counted in its own words.
    + row('Used by', fires.length
        ? [firesWf.length ? `<b>${firesWf.length}</b> rule(s)` : '',
           firesBp.length ? `<b>${firesBp.length}</b> blueprint(s)` : ''].filter(Boolean).join(' · ')
        : (a.associated ? 'Zoho reports it as in use, and nothing pulled names it' : '<span style="color:#f59e0b">nothing on disk fires it</span>'))
    + (a.template ? row('Template', templateUrl(a)
        ? `<a class="wf-fn" data-tpl="1" title="${escA('Open this template in Zoho')}">${escHtml(a.template.name || a.template.id)} \u2197</a>`
        : escHtml(a.template.name || a.template.id)) : '')
    // The sender, not a category. «From: a user's address» answers a question nobody asked - and
    // withholding it *here* makes no sense at all: the mirror is on this machine, and the two
    // switches are about what leaves it, in an export or in a chat. Reported, and the reasoning is
    // his: sharing a fact with a model while hiding it from the reader is the wrong way round.
    // The kind stays, muted and second, because «is this a person or the org» is worth a glance.
    + (a.from_address || a.from_name || a.from_type
        ? row('From', [a.from_name ? `<b>${escHtml(a.from_name)}</b>` : '',
                       a.from_address ? `<span class="mono">${escHtml(a.from_address)}</span>` : '',
                       a.from_type ? `<span style="color:var(--muted)">${escHtml(a.from_type === 'user' ? 'a user' : 'an organisation address')}</span>` : '']
              .filter(Boolean).join(' \u00b7 ')
            + (!a.from_address && actStale(a)
                ? ' <span style="color:var(--warn)">- the address was not read by the pull that wrote this</span>' : ''))
        : '')
    + (a.recipient_count != null ? row('Recipients', `${escHtml(String(a.recipient_count))} \u00b7 <span style="color:var(--muted)">a count; Zoost never reads who they are</span>`) : '')
    + (a.field ? row('Field', `<span class="mono">${escHtml(a.field)}</span>`
        + (a.field_label && a.field_label !== a.field ? ` \u00b7 ${escHtml(a.field_label)}` : '')
        + (a.field_type ? ` <span style="color:var(--muted)">${escHtml(a.field_type)}</span>` : '')) : '')
    // «Set stage to Won» does not say which value, and on a picklist of nine that is the whole
    // question. Three states, not two: a value, «clears the field» when Zoho answered with none,
    // and «this pull did not read it» when the row predates the field - which is what every row
    // looked like after the first version shipped, and it read as an org where nothing writes
    // anything.
    + (a.kind === 'field_updates' ? row('Writes', actStale(a)
        ? '<span style="color:var(--warn)">not read by the pull that wrote this - press Pull list + details to read it</span>'
        : (a.value === null || a.value === undefined)
          ? '<span style="color:var(--muted)">clears the field</span>'
          : `<b>${escHtml(String(a.value))}</b>`) : '')
    + (a.method ? row('Method', escHtml(a.method)) : '')
    + (a.url ? row('URL', `<span class="mono">${escHtml(a.url)}</span>`) : '')
    // Built from the configuration rather than from Zoho's rendered sentence: «Data trigger più 7
    // giorni» is the same rule as «7 days after the trigger», in the language of whoever pulled it,
    // and a mirror that changes with the reader's locale is not a mirror. Zoho's own words are the
    // fallback for a shape this code has not met.
    + ((a.mappings || []).map((m) => row(m.field.replace(/_/g, ' '), mappingHtml(m))).join(''))
    + (a.kind === 'tasks' && (actKept(a) || (!(a.mappings || []).length && (actStale(a) || actThin(a))))
        ? row('Detail', `<span style="color:var(--warn)">${actKept(a) ? escHtml(a.detail_list ? LIST_KEPT_DETAIL : KEPT_DETAIL) : actThin(a) ? escHtml(a.detail_list ? LIST_MISS_DETAIL : MISS_DETAIL) : 'not read by the pull that wrote this'} - press Pull list + details to read it</span>`) : '')
    + (a.notify === true ? row('Notify', 'yes') : '')
    + (a.modified_by ? row(MSG.lastModified, escHtml(a.modified_by) + (a.modified_time ? ' \u00b7 ' + escHtml(String(a.modified_time).slice(0, 16)) : '')) : '')
    + (a.locked ? row('Locked', 'yes') : '');
  if (fires.length) {
    // Both kinds, each opening where it lives: the rule in Workflows, the process in Blueprints, with
    // the transition named because that is where the reader has to look once they arrive.
    // Labelled, like every other line of this pane. They were one unlabelled `.connfns` block sitting
    // after \u00abLast modified\u00bb, so a chip arrived with no antecedent and nothing said which of them was
    // a rule and which a process - only a glyph did. Reported: \u00abthere is only the badge, and you
    // cannot tell the last link is a blueprint - I would expect to see Blueprints: link\u00bb. `.wfacts` is
    // this panel's own \u00ablabel, then chips\u00bb row, already used by the workflow pane for the actions a
    // rule fires: no new selector, and the two panes now read alike.
    const chip = (w) => (w.kind === 'blueprint'
      ? `<a class="wf-fn" data-bp="${escA(String(w.id))}" title="${escA((w.name || '') + (w.transition ? ' \u00b7 ' + w.transition : ''))}">\u25a6 ${escHtml(w.name || w.id)}</a>`
      : `<a class="wf-fn" data-wf="${escA(String(w.id))}" title="${escA(w.name || '')}">\u2699 ${escHtml(w.name || w.id)}</a>`);
    const firedRow = (list, label) => (list.length
      ? `<div class="wfacts"><span class="wk">${label}</span>${list.map(chip).join('')}</div>` : '');
    h += firedRow(firesWf, 'Rules') + firedRow(firesBp, 'Blueprints');
  }
  h += '</div>';
  $('pvtable').innerHTML = h;
  $('pvtable').querySelectorAll('a[data-wf]').forEach((el) => (el.onclick = () => healthOpenWorkflow(el.dataset.wf)));
  $('pvtable').querySelectorAll('a[data-bp]').forEach((el) => (el.onclick = () => healthOpenBlueprint(el.dataset.bp)));
  // The module chip drawn above: without this line it looks clickable and is not, which is worse
  // than a word - the rule the function chip and the module chip already follow everywhere else.
  // The module chip is wired by the delegated listener on `#pvtable` in crm-bootstrap.js. Attaching
  // one here as well made a single click fire `healthOpenModule` twice - two `rebuildModules()`, two
  // opens, and with Modules hidden the same refusal written to the status line twice. Delegation is
  // also the half that survives a re-render, which is why it is the half that stays.
  $('pvtable').querySelectorAll('a[data-tpl]').forEach((el) => (el.onclick = () => openZohoAt(templateUrl(a), (a.template && a.template.name) || 'template')));
  pvDiagram(`act:${a.kind}:${a.id}`, 'action');
  showPreview();
}
