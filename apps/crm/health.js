/*
 * health.js - the audit view, whole: buildHealth over the mirror, the grouped rendering, the
 * open-a-finding map, and the view's own open/close. The third slice of splitting sidepanel.js,
 * same contract as ai.js and export.js: a classic script of declarations only, loaded before
 * sidepanel.js, whose bottom wiring assigns toggleHealth and friends at load time.
 *
 * What deliberately stays behind: pullHealthRuntime and healthSay live with the other pulls -
 * a pull is wired and guarded like its siblings, wherever its view's code lives - and
 * runtimeSummary is shared with the failures pull's status line.
 */

// ---------- health / audit ----------
let healthData = null, healthTab = 'functions';
function nmNode(n) { return escHtml(nameMode === 'display' ? (n.display_name || n.name) : (n.api_name || n.name)); }
async function buildHealth(op = beginWorkspaceOp()) {
  const g = await ensureGraph(op);
  const nodes = Object.values(g.nodes);
  const fnById = {}, fnByName = {};
  nodes.forEach((n) => { if (n.id) fnById[String(n.id)] = n; [n.name, n.api_name, n.display_name].forEach((k) => { if (k) fnByName[String(k).toLowerCase()] = n; }); });
  const byName = (a, b) => (a.display_name || a.name || '').localeCompare(b.display_name || b.name || '');
  const fnLink = (n) => `<a data-file="${escA(n.file)}">${nmNode(n)}</a>`;
  const orphan = nodes.filter((n) => n.dead_suspect).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">${escHtml(n.namespace || '')}</span>` }));
  const unresolved = nodes.filter((n) => n.unresolved && n.unresolved.length).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">calls: ${escHtml(n.unresolved.join(', '))}</span>` }));
  const ambiguous = nodes.filter((n) => n.ambiguous && n.ambiguous.length).sort(byName).map((n) => ({ html: `${fnLink(n)} <span class="meta">ambiguous: ${escHtml(n.ambiguous.join(', '))}</span>` }));
  const broken = [];
  let wfIdx = []; try { wfIdx = JSON.parse(await op.read('workflows/index.json')); } catch (_) {}
  for (const w of wfIdx) { let d = null; try { d = JSON.parse(await op.read(`workflows/${w.id}.json`)); } catch (_) {} if (!d) continue; (d.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter(isFnAction).forEach((a) => { if (!(fnById[String(a.id)] || fnByName[(a.name || '').toLowerCase()])) broken.push({ kind: 'workflow', id: w.id, name: w.name, fn: a.name }); }); }); }
  let scheds = []; try { scheds = JSON.parse(await op.read('schedules/index.json')); } catch (_) {}
  scheds.forEach((sc) => { if (!(fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()])) broken.push({ kind: 'schedule', id: sc.id, name: sc.name, fn: sc.function_name }); });
  const brokenItems = broken.map((b) => ({ html: `<span>${escHtml(b.kind)}</span> <a data-kind="${escA(b.kind)}" data-id="${escA(String(b.id || ''))}">${escHtml(b.name || '?')}</a> <span class="meta">\u2192 missing function \u00ab${escHtml(b.fn || '?')}\u00bb</span>` }));
  const missingFK = []; const modApis = new Set(); const modObjs = [];
  for await (const p of walk(op.root)) { if (isModuleFile(p)) { try { const m = JSON.parse(await op.read(p)); modObjs.push(m); modApis.add(m.api_name); } catch (_) {} } }
  modObjs.forEach((m) => { if (/__s$/.test(m.api_name || '')) return; (m.fields || []).forEach((fl) => { let t = fl.lookup; if (t && typeof t === 'object') t = t.api_name || (typeof t.module === 'string' ? t.module : (t.module && t.module.api_name)) || null; if (!t || typeof t !== 'string') return; if (/__s$/.test(t)) return; if (!modApis.has(t)) missingFK.push({ module: m.api_name, field: fl.api_name || fl.label, target: t }); }); });
  // The module named here *is* in the workspace - it is its lookup's target that is not - so it
  // opens, and the target stays plain text because there is nothing to open.
  const fkItems = missingFK.map((r) => ({ html: `<a data-kind="module" data-id="${escA(r.module)}">${escHtml(r.module)}</a>.<span>${escHtml(r.field)}</span> <span class="meta">\u2192 ${escHtml(r.target)} (not in workspace)</span>` }));
  // What is *not in this mirror* comes first, because it is the only gap on this list that changes
  // what the items below mean. The rest of the sentence names categories Zoho does not report - true
  // of every workspace, and nothing anybody can act on. This one is a number about yours, and a
  // function whose only caller failed to download appears in «no caller» because of it.
  const short = g.counts && g.counts.notInMirror;
  const mirror = short === null || short === undefined
    ? `<b>Read from your mirror.</b> How many of your functions are in it could not be established, so treat «no caller» as covering only what is here. `
    : short > 0
      ? `<b>Read from your mirror:</b> ${g.counts.nodes} of ${g.counts.inOrg} functions. ${short} could not be downloaded, and a function called only from one of those appears below as having no caller. `
      : '';
  const coverage = mirror + `<b>Coverage.</b> Analyzed: function\u2192function calls, workflows, schedules, and each function's <i>associated_place</i> (blueprint, button, \u2026). <b>Not</b> analyzed: custom client scripts, approval/assignment/scoring rules, and anything Zoho doesn't report. Every item is a <b>candidate to review</b> - never an automatic deletion. <b>Size &amp; calls</b> are plain counts with no threshold and no verdict: they show where length and outbound calls concentrate, and you decide what that means. Based on ${nodes.length} functions, ${modObjs.length} modules in this workspace.`;
  // Everything read from the platform rather than computed from the mirror, fetched once: both
  // groups below need it. It sits above them because moving one of them up put a use of `fx`
  // before its declaration - a temporal dead zone that `node --check` waves through and only
  // running the function finds, which is the trap this repository has already recorded twice.
  const fx = (await failuresIndex(op)) || { at: null, usage: null, runs: null, credits: null, capped: false, byName: new Map(), all: [] };
  // Measured cost, beside the static proxies that were the only thing here before. «180 lines and
  // five outbound calls» is a guess about what a function costs; «it ran 239 times yesterday» is
  // what it cost. Both stay: the proxy covers every function, the measurement covers the busiest
  // few, and neither is a verdict.
  const runsById = new Map(), runsByName = new Map();
  (fx.runs || []).forEach((r) => { if (r.id) runsById.set(String(r.id), r.count); if (r.name) runsByName.set(String(r.name).toLowerCase(), r.count); });
  const runsOf = (n) => runsById.get(String(n.id || ''))
    ?? [n.display_name, n.name, n.api_name].map((k) => runsByName.get(String(k || '').toLowerCase())).find((v) => v != null);
  const mostRun = (fx.runs || []).map((r) => {
    const n = fnById[String(r.id || '')] || fnByName[String(r.name || '').toLowerCase()];
    const who = n ? fnLink(n) : `<b>${escHtml(r.name || '?')}</b>`;
    const st = n && n.stats ? ` \u00b7 ${n.stats.lines} lines, ${n.stats.apiCalls} outbound call(s)` : '';
    const cnt = r.count == null ? 'an unknown number of' : escHtml(String(r.count));
    return { html: `${who} <span class="meta">${cnt} run(s) in 24h${st}</span>` };
  });
  const runsDesc = fx.runs
    ? `The busiest ${fx.runs.length} functions in the 24 hours before ${escHtml(fmtDate(fx.at))}, as Zoho counted them - not every function, and not a ranking of anything but frequency.`
      + (fx.credits && (fx.credits.used != null || fx.credits.limit != null)
          ? ` Over the same period Zoho counted ${escHtml(String(fx.credits.used ?? 'unknown'))} against a ceiling of ${escHtml(String(fx.credits.limit ?? 'unknown'))}.` : '')
      + ' Zoho reports how often, not how long: a function that runs often is not automatically the expensive one.'
    : MSG.notReadYet;
  // Size and outbound-call counts, shown as plain rankings with no threshold and no verdict: a long
  // function is worth a look, not automatically wrong, and the reader decides what the numbers mean.
  const withStats = nodes.filter((n) => n.stats && n.stats.lines);
  const ranNote = (n) => { const r = runsOf(n); return r == null ? '' : ` \u00b7 ran ${r}\u00d7 in 24h`; };
  const biggest = withStats.slice().sort((a, b) => b.stats.lines - a.stats.lines).slice(0, 15)
    .map((n) => ({ html: `${fnLink(n)} <span class="meta">${n.stats.lines} lines · ${n.stats.codeLines} code · ${(n.stats.chars / 1024).toFixed(1)} KB${ranNote(n)}</span>` }));
  const chattiest = withStats.filter((n) => n.stats.apiCalls > 0).sort((a, b) => b.stats.apiCalls - a.stats.apiCalls).slice(0, 15)
    .map((n) => ({ html: `${fnLink(n)} <span class="meta">${n.stats.apiCalls} calls - ${n.stats.invokeurl} invokeurl · ${n.stats.crm} zoho.crm · ${n.stats.zoho} other${n.stats.sendmail ? ' · ' + n.stats.sendmail + ' sendmail' : ''}${ranNote(n)}</span>` }));
  // What Zoho reports as failing. Unlike every other group here it is not computed from the mirror:
  // it is a reading of a runtime, taken at a moment, so it says the moment. The counts beside it are
  // aggregates - a run count and a failure count for the 24 hours before that reading - and they
  // carry no verdict, like every other number in this view.
  const failing = (fx.all || []).slice().sort((a, b) => b.count - a.count).map((f) => {
    const n = fnByName[String(f.name || '').toLowerCase()];
    const who = n ? fnLink(n) : `<b>${escHtml(f.name || '?')}</b>`;
    return { html: `${who} <span class="meta">${escHtml(String(f.count))}\u00d7 \u00b7 ${escHtml(f.componentType || '?')} \u00b7 ${escHtml(f.reason || '')}</span>` };
  });
  const failDesc = fx.at
    ? `Read from Zoho on ${escHtml(fmtDate(fx.at))}.`
      + (fx.usage ? ` In the 24 hours before that Zoho counted ${escHtml(String(fx.usage.success ?? 'unknown'))} run(s) and ${escHtml(String(fx.usage.failure ?? 'unknown'))} failure(s).` : '')
      + ' This is the only thing here read from the platform rather than computed from the mirror, so it is as old as that date and no older. The input of a failed run stays in Zoho.'
    : MSG.notReadYet;
  // Automation actions nothing fires. The same statement this view already makes about a function
  // nobody calls, on the objects nobody ever prunes - and the same care: it is a **candidate**.
  // Two sources disagree politely and both are shown: Zoho's own «in use» flag, and whether any rule
  // in this workspace names it. A rule that was never pulled cannot name anything, so «no rule here
  // names it» is not «nothing uses it», and the description says which is which.
  let actIdx = []; try { const a = JSON.parse(await op.read('actions/index.json')); if (Array.isArray(a)) actIdx = a; } catch (_) {}
  const actUse = actionUsers || await buildActionUsers(op);
  if (!op.current()) throw new Error(WS_MOVED);
  const unattached = actIdx
    .filter((a) => !a.associated && !(actUse.get(a.kind + ':' + String(a.id)) || []).length)
    .sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || byField('name')(a, b))
    .map((a) => ({ html: `<a data-kind="action" data-id="${escA(a.kind + ':' + a.id)}">${escHtml(a.name || a.id)}</a>`
      + ` <span class="meta">${escHtml(actionKindLabel(a.kind))}${a.module ? ' \u00b7 ' + escHtml(a.module) : ''}</span>` }));
  const actDesc = actIdx.length
    ? 'Zoho reports these as attached to no rule, and no rule in this workspace names them either. A candidate to review, not a verdict: a rule that has not been pulled cannot name anything, and Zoho answers only for the automations it knows about.'
    : MSG.notReadYet;

  const groups = [
    { id: 'mostrun', tab: 'size', title: 'Most run, measured', desc: runsDesc, bad: false, items: mostRun },
    { id: 'failing', tab: 'functions', title: 'Failing in Zoho', desc: failDesc, bad: true, items: failing },
    { id: 'biggest', tab: 'size', title: MSG.hBiggest,
      desc: MSG.hBiggestDesc + ' ' + MSG.hRankedOver(withStats.length, nodes.length), bad: false, items: biggest },
    { id: 'chattiest', tab: 'size', title: MSG.hChattiest,
      desc: 'invokeurl, zoho.crm and other Zoho service tasks, counted outside comments and strings. Each call is work Zoho meters, so this is where execution cost concentrates. '
        + MSG.hRankedOver(withStats.length, nodes.length), bad: false, items: chattiest },
    { id: 'orphan', tab: 'functions', title: MSG.hOrphan, desc: 'No caller in code, not exposed as REST, and no associated_place.', bad: false, items: orphan },
    { id: 'unresolved', tab: 'functions', title: MSG.hUnresolved, desc: 'Calls a function that does not resolve to anything in this workspace.', bad: true, items: unresolved },
    { id: 'ambiguous', tab: 'functions', title: MSG.hAmbiguous, desc: 'A call matches more than one function (name collision across namespaces).', bad: false, items: ambiguous },
    { id: 'unattached', tab: 'wiring', title: 'Automation actions nothing fires', desc: actDesc, bad: false, items: unattached },
    { id: 'broken', tab: 'wiring', title: MSG.hBroken, desc: 'A workflow or schedule references a function not in this workspace.', bad: true, items: brokenItems },
    { id: 'fk', tab: 'wiring', title: MSG.hMissingRefs, desc: 'A lookup field points to a module not in this workspace (may be a system module).', bad: false, items: fkItems },
  ];
  if (!op.current()) throw new Error(WS_MOVED);
  return { groups, coverage };
}
async function openHealth() {
  const op = beginWorkspaceOp();   // an audit of the whole mirror takes as long as the mirror is big
  if (!dir) return;
  closeAI();   // one panel at a time
  $('healthview').classList.add('show'); $('health').classList.add('on'); document.body.classList.add('health-open');   // lit button + violet frame + covers the tabs, mirroring Ask AI
  $('healthbody').innerHTML = '<div class="hd">Analyzing\u2026</div>';
  healthSay('');                             // a verdict from the last time this was open is not one about now
  // Health reads the workspace files directly. Chrome lets the folder's File System Access
  // permission lapse after inactivity; without re-requesting it first (like every other file
  // operation does) the reads throw a generic "not allowed" DOMException. This click is a user
  // gesture, so requesting here re-grants it - and if the user declines, we say so plainly.
  if (!(await ensurePerm(dir))) { $('healthbody').innerHTML = '<div class="hd">Folder access is not granted - click Refresh, then open Health again.</div>'; return; }
  // Built before it is published: `healthData` is what the view, its export and its counts all read,
  // and an audit begun in one workspace is a description of that one.
  try { const built = await buildHealth(op); if (!op.current()) return; healthData = built; } catch (e) { if (!op.current()) return; $('healthbody').innerHTML = `<div class="hd">Could not analyze: ${escHtml(e.message)}</div>`; return; }
  renderHealthView();
}
function renderHealthView() {
  if (!healthData) return;
  const groups = healthData.groups;
  const tabCount = (tab) => groups.filter((g) => g.tab === tab).reduce((a, g) => a + g.items.length, 0);
  let html = `<div class="htabs">`
    + `<button class="htab ${healthTab === 'functions' ? 'on' : ''}" data-tab="functions">Functions <span class="htn">${tabCount('functions')}</span></button>`
    + `<button class="htab ${healthTab === 'wiring' ? 'on' : ''}" data-tab="wiring">Wiring <span class="htn">${tabCount('wiring')}</span></button>`
    + `<button class="htab ${healthTab === 'size' ? 'on' : ''}" data-tab="size">Size &amp; calls</button>`
    + `</div>`;
  html += `<div class="hcov">${healthData.coverage}</div>`;
  groups.filter((g) => g.tab === healthTab).forEach((g) => {
    html += `<div class="hsec"><div class="ht">${escHtml(g.title)} <span class="n ${g.items.length ? (g.bad ? 'bad' : 'warn') : 'ok'}">${g.items.length}</span></div>`
      + (g.desc ? `<div class="hd">${g.desc}</div>` : '')
      + (g.items.length ? g.items.map((it) => `<div class="hrow"><div class="hcontent">${it.html}</div></div>`).join('') : '<div class="hnone">None \u2713</div>')
      + `</div>`;
  });
  $('healthbody').innerHTML = html;
  $('healthbody').querySelectorAll('.htab').forEach((b) => (b.onclick = () => { healthTab = b.dataset.tab; renderHealthView(); }));
  wireFnChips($('healthbody'), (a) => healthOpenFn(a.dataset.file, a.dataset.line ? parseInt(a.dataset.line, 10) : null));
  // A map, not a ternary. Two kinds fitted in a conditional and the third and fourth did not: the
  // «Automation actions nothing fires» list rendered as plain text for exactly as long as it has
  // existed, because adding a row to a health group and adding a way to open it were two separate
  // things to remember. Reported. Now the finding names its kind and the opener is looked up.
  $('healthbody').querySelectorAll('a[data-kind]').forEach((a) => (a.onclick = () => {
    const open = HEALTH_OPEN[a.dataset.kind];
    if (open) open(a.dataset.id); else setStatus(`Nothing to open for a ${a.dataset.kind}.`, 'warn');
  }));
}
function healthOpenFn(file, line) { closeHealth(); if (!tabReachable('functions')) return; if (viewMode !== 'functions') { setMode('functions'); } openFile(file, line || null); }
async function healthOpenAction(key, name) {
  closeHealth(); if (!tabReachable('actions')) return; setMode('actions'); await rebuildActions();
  const [kind, ...rest] = String(key).split(':'); const id = rest.join(':');
  // Same two ways in as the rules above: an «used in» entry keys itself Zoho's way, and the name is
  // what the reader clicked. `key` may be a bare id when it comes from there rather than kind:id.
  const e = actionData.find((a) => a.kind === kind && String(a.id) === id)
    || actionData.find((a) => String(a.id) === String(key))
    || (name && actionData.find((a) => (a.name || '') === name));
  if (e) openAction(e); else setStatus(actionData.length ? MSG.actNotHere : MSG.actNotPulled, 'warn');
}
async function healthOpenModule(api, name) {
  closeHealth(); if (!tabReachable('modules')) return; setMode('modules'); await rebuildModules();
  // `label` is the localized plural Zoho puts in an «used in» entry - «Contatti» for `Contacts` -
  // and `gen` is the generated name. The fallback used to read `m.name`, which no row of moduleData
  // has, so every by-name attempt compared against undefined and failed silently.
  const key = String(api == null ? '' : api);
  const e = moduleData.find((m) => m.api_name === key)
    || moduleData.find((m) => (m.label || '') === key) || moduleData.find((m) => (m.gen || '') === key)
    || (name && moduleData.find((m) => (m.label || m.api_name || '') === name));
  if (e) openModule(e.path); else setStatus(moduleData.length ? MSG.modNotHere : MSG.modNotPulled, 'warn');
}
// By id, then by name. Zoho keys a function's «used in» entry its own way, and a rule that is
// plainly in the mirror was being reported as absent because the two keys did not match - a true
// sentence about the wrong question. The name is what the reader clicked, so it is what the second
// attempt uses, and the message says which of the two things is actually missing.
async function healthOpenWorkflow(id, name) {
  closeHealth(); if (!tabReachable('workflows')) return; setMode('workflows'); await rebuildWorkflows();
  // Measured on a real org rather than assumed: of 77 «used in» references to workflow rules, **none**
  // matched the rules index by id and every one matched by name - Zoho's id there is not the rule's.
  // For schedules the same field is the schedule's own id, and both of the two references matched. So
  // the id is tried first, because where it is right it is exact, and the name second.
  //
  // And only when the name identifies one rule. Names were unique in that org - 106 of 106 - but that
  // is a fact about one workspace, not a guarantee: with two rules sharing a name, opening either
  // would be a guess, so the list is filtered to that name instead and the reader picks.
  const e = workflowData.find((w) => String(w.id) === String(id));
  const byName = name ? workflowData.filter((w) => (w.name || '') === name) : [];
  if (e || byName.length === 1) { openWorkflow(e || byName[0]); return; }
  if (byName.length > 1) {
    $('find').value = name; runSearch();
    setStatus(`${byName.length} workflows are called «${name}» - listed, so you can pick the one you meant.`, 'warn');
    return;
  }
  setStatus(workflowData.length ? MSG.wfNotHere : MSG.wfNotPulled, 'warn');
}
async function healthOpenSchedule(id, name) {
  closeHealth(); if (!tabReachable('schedules')) return; setMode('schedules'); await rebuildSchedules();
  const e = scheduleData.find((x) => String(x.id) === String(id))
    || (name && scheduleData.find((x) => (x.name || '') === name));
  if (e) openSchedule(e);
  else setStatus(scheduleData.length ? MSG.schNotHere : MSG.schNotPulled, 'warn');
}
// Which finding opens what. One entry per kind a health row can name, so a group that starts
// naming a new kind gets its opener here rather than silently rendering an unclickable name.
// One entry of «Used in …»: a link when this panel can open that kind of thing, plain text when it
// cannot. The kind Zoho writes is plural and its own - `workflow_rules`, `schedules` - so it is
// mapped here rather than matched loosely, and an unknown kind falls through to text.
// Which tab each opener lands on. Deliberately a map beside AP_OPEN rather than a string inside each
// opener: the two lists have to stay in step, and side by side a missing row is visible.
const AP_TAB = { workflow: 'workflows', schedule: 'schedules', action: 'actions', module: 'modules' };
/** Whether a jump into `tab` can land. An area the Zoho role forbids has no segment and can never be
 *  pulled, so arriving there shows an empty list with no way back to it - the panel looking lost
 *  instead of saying what happened. Hiding a tab in Settings is *not* this: `renderTabs()` puts that
 *  segment back for as long as the reader is on it, which is the case this used to be confused with.
 */
/** Can this tab be opened at all, and if not, why - the two reasons being different facts.
 *
 *  It knew about one of them: an area your Zoho role refuses. A tab you hid in **Settings** answered
 *  yes, so every cross-tab link went on working and landing on it - and the panel then had to give the
 *  hidden tab a segment again to avoid looking lost. Reported: «when a tab is disabled we must not
 *  still have live references that take you there - the links stop existing for that tab, otherwise
 *  hiding it means nothing.» Which is the right rule: a hidden tab is a part of the product the reader
 *  has put away, and a link is a way in.
 *
 *  The two messages stay apart because the actions are different: one is your administrator's, the
 *  other is one switch in Settings. */
function tabReachable(tab, quiet) {
  if (!tab) return true;
  if (isForbidden(tab)) {
    if (!quiet) setStatus(`${tabLabel(tab)}: your Zoho role does not grant access to that area, so it cannot be opened.`, 'warn');
    return false;
  }
  if (isHiddenByUser(tab)) {
    if (!quiet) setStatus(`${tabLabel(tab)} is hidden in Settings, so nothing here opens it. Turn it back on to follow this.`, 'warn');
    return false;
  }
  return true;
}
const AP_OPEN = { workflow_rules: 'workflow', workflow: 'workflow', schedules: 'schedule',
                  schedule: 'schedule', actions: 'action', module: 'module', modules: 'module' };
function apLink(kind, p) {
  const opener = AP_OPEN[kind];
  const id = p && (p.id != null ? String(p.id) : '');
  const label = (p && (p.name || p.label)) || '(unnamed)';
  const name = (p && p.name) || '';
  // The name is passed per call, never closed over: on the module link below the name in scope is
  // the *button's*, and sending it as the module's would have the opener look for a module called
  // «Sincronizza licenze Microsoft» - a fallback that cannot match, which is the same defect this
  // change fixes one function down.
  const link = (op, key, text, why, nm) => `<a class="aplink" data-ap="${escA(op)}" data-apid="${escA(String(key))}"`
    + `${nm ? ` data-apname="${escA(nm)}"` : ''} title="${escA(why)}">${escHtml(text)}</a>`;
  // The name travels beside the id, because the id is Zoho's and not necessarily the one the rules
  // index is keyed by. Measured: of 77 references to workflow rules in a real org, none matched by
  // id and every one matched by name.
  //
  // A tab the org's role forbids is not offered at all: refusing after the click would be a control
  // saying «no» for a reason nothing on screen shows.
  if (opener && id && HEALTH_OPEN[opener] && tabReachable(AP_TAB[opener], true)) {
    return link(opener, id, label, MSG.openThis + opener, name);
  }
  // No page for this kind of thing - a custom button is the measured case, 18 of them in that org
  // and nothing in this panel that shows one. Its module *is* here, so that is what is offered, and
  // the link's text is the module's name and not the button's: a link says where it goes.
  const mod = (p && p.module) || '';
  if (mod && tabReachable('modules', true)) {
    return `${escHtml(label)} <span class="apin">in</span> `
      + link('module', mod, mod, `Zoost has no page for a ${kind.replace(/s$/, '').replace(/_/g, ' ')} - this opens its module`, mod);
  }
  return escHtml(label);
}
const HEALTH_OPEN = { workflow: healthOpenWorkflow, schedule: healthOpenSchedule,
                      action: healthOpenAction, module: healthOpenModule };
function toggleHealth() { if ($('healthview').classList.contains('show')) closeHealth(); else openHealth(); }
function closeHealth() { $('healthview').classList.remove('show'); $('health').classList.remove('on'); document.body.classList.remove('health-open'); }
