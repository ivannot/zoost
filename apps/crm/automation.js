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
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) { setStatus('Environment mismatch - refusing.', 'warn'); return; }
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
          if (!map.get(key).some((x) => String(x.id) === String(w.id))) map.get(key).push({ id: w.id, name: w.name });
        }
      });
    });
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
  return map.get(`${a.kind}:${String(a.id)}`)
      || map.get(`${a.kind}:name:${String(a.name || '').toLowerCase()}`) || [];
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
    await noteAccess('actions', null, op, true, full && !missed.length && !capped.length && !detailMissed.length ? 'full' : 'list');
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
      + `<span class="rest ru${used || a.associated ? '' : ' none'}" title="${escA(used ? 'rules that fire it, read from the rules on disk' : a.associated ? 'Zoho reports it as in use; no rule on disk names it' : 'no rule uses it, as far as Zoho reports')}">${used}\u00d7</span>`;
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
  let h = '<div class="wfd">'
    + row('Kind', escHtml(actionKindLabel(a.kind)))
    + row('Module', escHtml(a.module_label || a.module))
    + row('Used by', fires.length
        ? `<b>${fires.length}</b> rule(s)`
        : (a.associated ? 'Zoho reports it as in use, and no pulled rule names it' : '<span style="color:#f59e0b">no rule uses it</span>'))
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
    h += '<div class="connfns">' + fires.map((w) => `<a class="wf-fn" data-wf="${escA(String(w.id))}" title="${escA(w.name || '')}">\u2699 ${escHtml(w.name || w.id)}</a>`).join('') + '</div>';
  }
  h += '</div>';
  $('pvtable').innerHTML = h;
  $('pvtable').querySelectorAll('a[data-wf]').forEach((el) => (el.onclick = () => healthOpenWorkflow(el.dataset.wf)));
  $('pvtable').querySelectorAll('a[data-tpl]').forEach((el) => (el.onclick = () => openZohoAt(templateUrl(a), (a.template && a.template.name) || 'template')));
  showPreview();
}
