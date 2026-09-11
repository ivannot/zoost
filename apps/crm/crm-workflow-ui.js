// CRM workflow list and detail UI.
async function pullWorkflows() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    await requirePerm(op.root);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing.`);
    setStatus('Listing workflows\u2026', 'busy');
    const r = await toBridge({ cmd: 'listWorkflows' }); if (!r?.ok) throw bridgeError(r, 'list failed');
    // Same rule the functions pull learned: a list that stopped early describes the reading, not the
    // org. Writing it as the index and pruning what is missing removes workflows that still exist -
    // and the warning came *after* the pruning, so it described rules already gone.
    if (r.capped) {
      setStatus(`Zoho returned a partial list of workflows (stopped at ${r.total || 'the limit'}) - nothing was removed.`, 'warn');
      if (!(await loadWorkflowIndex(op))) return; if (viewMode === 'workflows') renderWorkflows();
      // Zoho answered, so the verdict moves - the third of these, and the same reason each time.
      await noteAccess('workflows', null, op, false);   // asked and answered; nothing was stored
      return;
    }
    if (!op.current()) return;   // you changed workspace while this was reading
    await op.write('workflows/index.json', JSON.stringify(r.entries, null, 2));
    const liveIds = new Set(r.entries.map((e) => String(e.id)));
    let prunedW = 0; const wfRmFail = [];
    for await (const p of walk(op.root)) { if (p.startsWith('workflows/') && p.endsWith('.json') && !p.endsWith('/index.json')) { const wid = p.split('/').pop().replace(/\.json$/, ''); if (!liveIds.has(wid)) { try { await op.remove(p); prunedW++; } catch (e) { if ((e && e.message) === WS_MOVED) return; wfRmFail.push(p); } } } }
    if (!(await loadWorkflowIndex(op))) return;
    if (viewMode === 'workflows') { renderWorkflows(); updateMissingButton(); }
    await downloadMissingWf();
    // The writes above dropped \u00abwhich rule fires this action\u00bb - it is read out of these very rules.
    // Dropping it is the write's business; rebuilding it has to happen where there is an await, and
    // this is that place: `actionFiredBy()` is called while a row is being drawn and cannot read a
    // file, so a map that is merely absent would be drawn as \u00abno rule fires this\u00bb, which is a
    // stronger claim than the stale one it replaced.
    if (actionUsers === null) {
      const users = await buildActionUsers(op);
      if (!op.current()) return;
      actionUsers = users;
    }
    if (viewMode === 'actions') renderActions();
    if (prunedW) setStatus($('stxt').textContent + ` \u00b7 ${prunedW} deleted removed`, 'ok');
    // A removal that failed is a deleted rule still on screen: loadWorkflowIndex() reads the disk,
    // so the residue is what the reader sees - said, recorded, retried by the next pull for free.
    if (wfRmFail.length) setStatus($('stxt').textContent + ` \u00b7 ${wfRmFail.length} deleted rule(s) could not be removed - the next pull retries`, 'warn');
    if (r.capped) setStatus($('stxt').textContent + ' \u00b7 list stopped early - some workflows may be missing', 'warn');
    await noteAccess('workflows', wfRmFail.length ? { status: 0, message: `${wfRmFail.length} stale workflow file(s) could not be removed` } : null, op, true);   // the mirror was written; the gap is what could not be tidied after it
  } catch (e) { await notePullFailure('workflows', e, op); } finally { endPull(); }
}
async function openWorkflowInZoho(id) {
  if (sampleRefuse()) return;
  const ws = bound || {};
  if (!ws.base || !ws.instance) { setStatus('Unknown workspace binding - pull first.', 'warn'); return; }
  const url = `${ws.base}/crm/${ws.instance}/settings/workflow-rules/${id}`;
  try { if (await goToZoho(url)) setStatus('Opened workflow in Zoho.', 'ok'); }
  catch (e) { setStatus('Could not open: ' + e.message, 'warn'); }
}
async function openWorkflow(e) {
  const mine = ++previewLoad;
  const op = beginWorkspaceOp();
  if (!e.downloaded) {
    const ok = await downloadOneWf(e);
    if (!previewCurrent(mine, op)) return;
    updateRow(e); updateMissingButton();
    if (!ok) { setStatus('Could not download this workflow.', 'warn'); return; }
  }
  let rule; try { rule = JSON.parse(await op.read(e.path)); } catch (err) { if (previewCurrent(mine, op)) setStatus(MSG.readFailed + err.message, 'bad'); return; }
  if (!previewCurrent(mine, op)) return;
  currentPath = e.path; navHere(e.name);
  selectRow(e.path);
  setPvName(e.name, e.path);
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);   // else the last function's callers/connections bar lingers
  $('pvreveal').style.display = ''; $('pvreveal').textContent = MSG.openInZoho; $('pvreveal').title = 'Open the workflow in Zoho'; $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  $('pvtable').innerHTML = renderWorkflowDetail(rule);
  showPreview();
  wireFnChips($('pvtable'), (sp) => openFunctionFromWorkflow(sp.dataset.fnid, sp.dataset.fnname));
  const _ub = $('pvtable').querySelector('.wfusage'); if (_ub) _ub.onclick = () => loadWorkflowUsage(_ub.dataset.wfid, $('pvtable').querySelector('.wfusage-out'), _ub);
}
function renderWorkflowDetail(rule) {
  const esc = escHtml;
  const trig = (rule.execute_when && rule.execute_when.type) || '?';
  const mod = (rule.module && rule.module.api_name) || '?';
  // recursive criteria (handles nested groups)
  const valOf = (g) => {
    const v = g.value;
    if (g.type === 'field' && v && v.api_name) return v.api_name;
    if (v === '${EMPTY}' || v === '${empty}') return 'empty';
    return v == null ? '' : String(v);
  };
  const one = (g) => `${(g.field && g.field.api_name) || '?'} ${g.comparator || ''} ${valOf(g)}`;
  const critText = (crit) => {
    if (!crit) return '';
    if (crit.group && crit.group.length) { const op = crit.group_operator || 'AND'; return crit.group.map((g) => (g.group ? '(' + critText(g) + ')' : one(g))).join(` ${op} `); }
    if (crit.comparator) return one(crit);
    return '';
  };
  const timingText = (bk) => {
    const ea = bk.execute_after;
    if (ea && ea.unit != null) return `after ${ea.unit} ${ea.period || ''}`.trim();
    const t = bk.execution_details || bk.interval || bk.schedule || bk.time || null;
    if (!t) return '';
    if (typeof t === 'object') {
      if (t.days != null) return `after ${t.days} day(s)`;
      if (t.hours != null) return `after ${t.hours} hour(s)`;
      if (t.field || t.date_field) return `based on ${esc((t.field && t.field.api_name) || t.date_field || 'a date field')}`;
      return esc(JSON.stringify(t));
    }
    return esc(String(t));
  };
  const actionSpan = (a) => isFnAction(a)
    ? `<span class="wf-fn" data-fnid="${escA(a.id)}" data-fnname="${escA(a.name)}" title="Open the function">\u0192 ${esc(a.name)}</span>`
    : `<span class="wfact">${esc(a.type)}: ${esc(a.name)}</span>`;
  const bucketHtml = (bucket, label) => {
    if (!bucket) return '';
    const buckets = Array.isArray(bucket) ? bucket : [bucket];
    let out = '';
    buckets.forEach((bk) => {
      const acts = (bk && bk.actions) || [];
      const tim = bk && typeof bk === 'object' ? timingText(bk) : '';
      if (!acts.length && !tim) return;
      out += `<div class="wfacts"><span class="wk">${label}${tim ? ` <i>(${tim})</i>` : ''}</span>${acts.map(actionSpan).join('')}</div>`;
    });
    return out;
  };
  let h = `<div class="wfd">`;
  h += `<div class="wfrow"><span class="wk">Module</span> <b>${esc(mod)}</b></div>`;
  const ew = rule.execute_when || {}, det = ew.details || {};
  const trigParts = [esc(ew.type || '?')];
  if (det.repeat != null) trigParts.push(`repeat: ${det.repeat ? 'yes' : 'no'}`);
  if (Array.isArray(det.fields) && det.fields.length) trigParts.push(`fields: ${det.fields.map((fl) => esc((fl.field && fl.field.api_name) || fl.api_name || String(fl))).join(', ')}`);
  Object.keys(det).forEach((k) => { if (['trigger_module', 'repeat', 'fields'].includes(k)) return; const v = det[k]; if (v != null && typeof v !== 'object') trigParts.push(`${esc(k)}: ${esc(String(v))}`); });
  h += `<div class="wfrow"><span class="wk">Trigger</span> ${trigParts.join(' \u00b7 ')}</div>`;
  if (rule.category && rule.category !== 'default') h += `<div class="wfrow"><span class="wk">Category</span> ${esc(rule.category)}</div>`;
  const ewCrit = critText(det.criteria || ew.criteria);
  if (ewCrit) h += `<div class="wfrow"><span class="wk">When</span> ${esc(ewCrit)}</div>`;
  h += `<div class="wfrow"><span class="wk">Status</span> ${rule.status && rule.status.active ? 'active' : 'inactive'}</div>`;
  // Same row, same words as the Schedules preview: "Last run" is one fact and must not be two names.
  if (rule.last_executed_time) h += `<div class="wfrow"><span class="wk">Last run</span> ${esc(rule.last_executed_time)}</div>`;
  if (rule.description) h += `<div class="wfrow"><span class="wk">Description</span> ${esc(rule.description)}</div>`;
  (rule.conditions || []).forEach((c, i) => {
    h += `<div class="wfcond"><div class="wfch">Condition ${c.sequence_number || i + 1}</div>`;
    const cd = c.criteria_details || {};
    const ct = critText(cd.criteria);
    if (ct) h += `<div class="wfcrit">${esc(ct)}</div>`;
    const rel = cd.relational_criteria;
    if (rel && (rel.module || rel.criteria)) h += `<div class="wfcrit"><i>related:</i> ${esc((rel.module && rel.module.api_name) || rel.module || '')} ${esc(critText(rel.criteria))}</div>`;
    h += bucketHtml(c.instant_actions, 'Instant');
    h += bucketHtml(c.scheduled_actions, 'Scheduled');
    h += `</div>`;
  });
  h += `<div class="wfusage-wrap"><button class="wfusage" data-wfid="${escA(rule.id)}">Show executions (last 30 days)</button><div class="wfusage-out"></div></div>`;
  h += `<details class="wfraw"><summary>Raw JSON</summary><pre>${esc(JSON.stringify(rule, null, 2))}</pre></details>`;
  return h + `</div>`;
}
async function loadWorkflowUsage(id, outEl, btn) {
  if (mismatchRefuse()) return;
  btn.disabled = true; outEl.textContent = 'Loading executions\u2026';
  const fmt = (d) => d.toISOString().slice(0, 10);
  const till = new Date(), from = new Date(Date.now() - 30 * 864e5);
  try {
    const r = await toBridge({ cmd: 'workflowUsage', id, from: fmt(from), till: fmt(till) });
    if (!r?.ok || !r.usage) throw new Error(r?.error || 'no data');
    outEl.innerHTML = renderUsage(r.usage); btn.style.display = 'none';
  } catch (e) { outEl.textContent = 'Could not load executions: ' + e.message; btn.disabled = false; }
}
function renderUsage(u) {
  const esc = escHtml;
  let h = `<div class="wfu"><div class="wfrow"><span class="wk">Triggered</span> <b>${u.trigger_count == null ? 0 : u.trigger_count}</b> times (last 30 days)</div>`;
  (u.conditions || []).forEach((c) => ['instant_actions', 'scheduled_actions'].forEach((bk) => {
    const bucket = c[bk]; const buckets = Array.isArray(bucket) ? bucket : (bucket && bucket.actions ? [bucket] : []);
    buckets.forEach((bb) => (bb.actions || []).forEach((a) => {
      h += `<div class="wfustat"><span class="an">${esc(a.name)}</span> <span class="ok">${a.success_count || 0} ok</span> \u00b7 <span class="fail">${a.failure_count || 0} fail</span> \u00b7 ${a.queue_count || 0} queued</div>`;
    }));
  }));
  return h + `</div>`;
}
function openFunctionFromWorkflow(id, name) {
  const nid = String(id || ''); const nm = (name || '').toLowerCase();
  let ent = treeData.find((x) => x.id === nid) || treeData.find((x) => (x.display_name || '').toLowerCase() === nm || (x.api_name || '').toLowerCase() === nm);
  if (!ent) { setStatus(`Function "${name}" not in workspace - pull functions first.`, 'warn'); return; }
  if (!tabReachable('functions')) return;
  // **Arriving at a row is not the same as opening a file.** This asked «is it in `treeData`» and
  // then opened its path unconditionally - so a function this mirror has no source for closed the
  // pane the reader was looking at, flashed `Read failed: NotFoundError`, had that overwritten in
  // the same tick by the tree count, and recorded a step in the history that Back/Forward replays
  // for ever. The tree row two functions over has answered this properly since it was written; every
  // *link* to the same row went round it.
  setMode('functions');
  selectRow(ent.path);
  if (ent.mirrored === false) { setStatus(MSG.notMirrored(langLabel(ent.language)), 'warn'); return; }
  if (!ent.downloaded) { void fetchThenRedrawRow(ent); return; }
  openFromTree(ent.path);
}


