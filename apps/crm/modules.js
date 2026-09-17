/*
 * modules.js - the Modules tab, whole: the pull with its layout files and its pruning, the tree, the
 * detail with its field table and layout matrix, the per-module resync, and the schema-graph bridge.
 * Fifth slice, same contract as ai.js / export.js / health.js: declarations only, loaded before
 * sidepanel.js, proven by executing the file in an empty scope.
 */

// ---------- modules: pull ----------
async function pullModules(depth = {}) {
  // «Pull list» reads which modules exist, and is a pull of its own - see pullModuleList.
  if (depth && depth.full === false) return pullModuleList();
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    await requirePerm(op.root);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing.`);
    setStatus('Pulling modules…', 'busy');
    const r = await toBridge({ cmd: 'pullModules' }); if (!r?.ok) throw bridgeError(r, 'pull failed');
    op.say(`Writing ${r.modules.length} modules…`, 'busy');
    const keepLayoutFiles = new Set(); const index = []; const layIndex = [];
    // The rows as they stand, so a module whose layouts were not read this time keeps the row that
    // describes the file being kept beside it.
    // Built without a `for`, deliberately: the check that every long loop in this file asks
    // `op.current()` on each turn finds the *first* loop in the body, and a second one up here would
    // take that place and read as the guard being gone. A derivation is allowed to be shaped by the
    // check that reads it, as long as it does the same thing - this does.
    const prevLayIndex = new Map();
    try {
      (JSON.parse(await op.read('modules/layouts/index.json')) || [])
        .forEach((row) => { if (row && row.module) prevLayIndex.set(row.module, row); });
    } catch (_) { /* no index yet, or unreadable: every row is then written fresh */ }
    let mw = 0, lw = 0; const wFail = [], rFail = [];
    // Modules whose fields could not be read this time - kept as they were, and counted, because a
    // pull that covered less than the whole org without saying so is the mirror lying by omission.
    const notRead = [];
    // Refused is its own word, because it is its own thing to do next: the role, or the ⊘ dot on
    // the row. Counted in neither list, a refusal came out as a clean pull.
    const refused = [];
    for (const m of r.modules) {
      if (!op.current()) return;   // one file per module and per layout set: a loop long enough to be left
      const fullLayouts = Array.isArray(m.layouts) ? m.layouts : [];
      const lf = `modules/layouts/${sanitize(m.api_name || 'unknown')}.json`;
      if (fullLayouts.length) {
        // A write that failed is not permission to delete what is already there: the old file is
        // still the best answer anybody has, and losing it costs a re-pull of the expensive half.
        try { await op.write(lf, JSON.stringify(fullLayouts, null, 2)); lw++; }
        catch (e) { if ((e && e.message) === WS_MOVED) return; wFail.push(`${m.api_name} (layouts)`); }
        keepLayoutFiles.add(lf);
      } else if (m.layouts_read !== true) {
        // Zoho did not answer - refused, rate-limited, or never asked because the fields call had
        // already failed. «I could not read it» is not «it has none», and only the second is a fact
        // the prune below may act on. Reported: a 429 on one module deleted its layout detail and
        // the status line said nothing.
        keepLayoutFiles.add(lf);
      }
      // keep a compact summary inside the module JSON (drives the preview line + index)
      m.layouts = fullLayouts.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false, status: l.status || null, sections: (l.sections || []).length }));
      // Into the index only when its file landed: an index row whose file is old or absent is the
      // mirror lying about itself - measured by an outside scan as «0/1 modules» under a green
      // status, with noteAccess recording the area as read.
      // **A read that failed is not permission to replace what is on disk.** When the fields call
      // fails, the bridge never attempts layouts or related lists either, so `m` arrives with three
      // empty lists - and this wrote that over the module file, destroying the fields, the lookup
      // targets, the layout summary and the related-list API names, under a green «Modules pull
      // complete». The layout *file* three lines up was already protected by exactly this argument;
      // the file holding the fields was not. A refusal is still written down - `unreadable` is a
      // measurement and belongs on disk - but a failure that read nothing leaves the old answer,
      // which is the best one anybody has.
      // **And a refusal is read no differently.** The line above used to end `&& !m.unreadable`, so
      // the branch that preserves the file was skipped exactly when Zoho had *refused* to describe
      // the module - which is the commonest way a module stops being readable - and the empty shell
      // went over three fields, their lookup targets, the layout summary and the related lists,
      // under «Modules pull complete: 1/1 modules» in green. `resyncModuleNow`, the ⊘ dot on the
      // row, handles the same refusal by reading the file, adding `unreadable` and keeping
      // everything: one event, two paths, and the destructive one ran on every Pull all. Both are
      // measurements and both are kept - «Zoho would not describe this» does not mean «this has no
      // fields», and the layout file two lines up has been protected by that argument all along.
      if (!m.fields_read) {
        // Keep the old answer *and* the old index row: skipping the row would leave the file on disk
        // and the module out of the list, which is the mirror disagreeing with itself - the exact
        // shape the layout index is being fixed for two lines down.
        let prev = null;
        try { prev = JSON.parse(await op.read(`modules/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
        if (prev) {
          if (m.unreadable) {
            prev.unreadable = m.unreadable;   // dated today, on the file that keeps what was captured
            try { await op.write(`modules/${sanitize(m.api_name || 'unknown')}.json`, JSON.stringify(prev, null, 2)); }
            catch (e) { if ((e && e.message) === WS_MOVED) return; wFail.push(m.api_name); }
          }
          index.push({ api_name: prev.api_name, module_name: prev.module_name, generated_type: prev.generated_type,
                       fields: (prev.fields || []).length, layouts: (prev.layouts || []).length,
                       related_lists: (prev.related_lists || []).length });
          layIndex.push({ module: prev.api_name, generated: prev.module_name, layouts: prev.layouts || [] });
          keepLayoutFiles.add(lf);
          (m.unreadable ? refused : notRead).push(m.api_name);
          continue;
        }
        // Nothing on disk to keep: an empty shell is what was actually learnt, and it says so
        // through `unreadable` and `fields_read` both.
        (m.unreadable ? refused : notRead).push(m.api_name);
      }
      // The same argument as the layouts two branches up: a read that did not happen is not a module
      // with no pipelines, and only the second is a fact this write may act on.
      // Only for a module that can have them: `has_stages` is false for seventy-eight of seventy-nine,
      // and reading each one's file to learn it has no ladders to keep is a disk read per module per
      // pull that can change nothing. Found by review.
      if (m.pipelines_read !== true && m.has_stages !== false) {
        let old = null; try { old = JSON.parse(await op.read(`modules/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
        if (!op.current()) return;
        // The pool is kept on its own: it holds the probabilities and Zoho's leftover stages, and a
        // module can have one with no ladder configured - where the first version kept nothing at all.
        const hadPipes = old && (old.pipelines || []).length, hadPool = old && (old.stage_pool || []).length;
        if (hadPipes || hadPool) {
          m.pipelines = hadPipes ? old.pipelines : [];
          m.stage_pool = old.stage_pool || [];
          m.pipelines_kept = true;
        }
      }
      try {
        await op.write(`modules/${sanitize(m.api_name || 'unknown')}.json`, JSON.stringify(m, null, 2)); mw++;
        index.push({ api_name: m.api_name, module_name: m.module_name, generated_type: m.generated_type, fields: (m.fields || []).length, layouts: m.layouts.length, related_lists: (m.related_lists || []).length });
        // From what the file actually holds. When a module's layouts were not read, `m.layouts` is
        // empty and the *file* beside it is deliberately kept - so writing this row from `m` made
        // the index say «no layouts» about a file that has them. Two files in one mirror
        // disagreeing, and which one a reader believes depends on the surface they opened.
        layIndex.push((m.layouts_read === true || fullLayouts.length)
          ? { module: m.api_name, generated: m.module_name, layouts: m.layouts }
          : (prevLayIndex.get(m.api_name)
            || { module: m.api_name, generated: m.module_name, layouts: [] }));
      } catch (e) { if ((e && e.message) === WS_MOVED) return; wFail.push(m.api_name); }
    }
    if (!op.current()) return;   // you changed workspace while this was reading
    await op.write('modules/index.json', JSON.stringify(index, null, 2));
    await op.write('modules/layouts/index.json', JSON.stringify(layIndex, null, 2));
    // **The other end of a relation the mirror only ever saw one side of.** A function's
    // `associated_place` already named the buttons that call it - 18 of them on the org this was
    // built against - and there was nowhere to go from the button back to the function, nor any way
    // to see which buttons exist. They ride the modules pull because that is where Zoho declares
    // them, one module at a time, on a walk this pull already makes.
    //
    // Only from the modules whose buttons were actually read: a module that refused keeps whatever
    // the last pull wrote, which is the same rule the layout files follow two blocks down.
    const btnRead = r.modules.filter((m) => m.buttons_read === true);
    if (btnRead.length) {
      let prevBtn = [];
      try { prevBtn = JSON.parse(await op.read('buttons/index.json')) || []; } catch (_) { /* none yet */ }
      const fresh = new Set(btnRead.map((m) => m.api_name));
      const rows = prevBtn.filter((b) => b && !fresh.has(b.module))
        .concat(btnRead.flatMap((m) => m.buttons || []));
      if (!op.current()) return;
      await op.write('buttons/index.json', JSON.stringify(rows, null, 2));
    }
    const liveFiles = new Set(r.modules.map((m) => `modules/${sanitize(m.api_name || 'unknown')}.json`));
    let prunedM = 0;
    for await (const p of walk(op.root)) { if (isModuleFile(p) && !liveFiles.has(p)) { try { await op.remove(p); prunedM++; } catch (e) { if ((e && e.message) === WS_MOVED) return; rFail.push(p); } } }
    // Only what this pull *knows* is gone: a module Zoho answered for, with no layouts. Anything it
    // could not read, or could not write, keeps whatever is on disk.
    let prunedL = 0;
    for await (const p of walk(op.root)) {
      if (!isLayoutFile(p) || keepLayoutFiles.has(p)) continue;
      if (!op.current()) return;
      try { await op.remove(p); prunedL++; } catch (e) { if ((e && e.message) === WS_MOVED) return; rFail.push(p); }
    }
    await rebuildModules(op);
    // Incomplete is said as incomplete, and recorded as such: «ok» over failed writes is how an old
    // file hides behind a fresh green line, and a removal that failed is a deleted module still on
    // screen - rebuildModules() reads the disk, so the residue is what the reader sees.
    const gap = (wFail.length ? ` ${wFail.length} write(s) failed: ${wFail.slice(0, 3).join(', ')}${wFail.length > 3 ? '…' : ''}.` : '')
      + (rFail.length ? ` ${rFail.length} stale file(s) could not be removed - the next pull retries.` : '')
      + (notRead.length ? ` ${notRead.length} module(s) could not be read and were left as they were: `
        + `${notRead.slice(0, 3).join(', ')}${notRead.length > 3 ? '…' : ''}.` : '')
      + (refused.length ? ` ${refused.length} module(s) Zoho would not describe - what was captured before is kept: `
        + `${refused.slice(0, 3).join(', ')}${refused.length > 3 ? '…' : ''}.` : '');
    setStatus(`Modules pull complete: ${mw}/${r.modules.length} modules, ${lw} layout sets${prunedM ? `, ${prunedM} removed` : ''}${prunedL ? `, ${prunedL} layout set(s) removed` : ''}.${gap}`, gap ? 'warn' : 'ok');
    // «Every module read» only when it was: a module Zoho would not describe, one whose fields did not come
    // and one that could not be written are each a detail not here - the third instance of a full read
    // claimed over a gap, after functions and actions. Measured: 27 of 87 and 16 of 84 modules refused.
    await noteAccess('modules', gap ? { status: 0, message: gap.trim() } : null, op, true, ...pullDepth(true, { refused: refused.length, unread: notRead.length + wFail.length }));   // the mirror was written; the gap is what came up short in it
  } catch (e) { await notePullFailure('modules', e, op); } finally { endPull(); }
}

/** «Pull list» on Modules: which modules exist in Zoho, and nothing about their fields.
 *
 *  A module already on disk keeps its file and its index rows exactly as the last Pull left them - that
 *  reading is the best one there is, and the bar says how old it is. A module new since then lands as
 *  its identity with the three reads marked as not made, so its table says «press Pull list + details» rather than
 *  «no fields». A module gone from the list goes from the mirror, as it does in a full Pull: the list is
 *  one unpaged answer, the same one the full Pull prunes by. A pull of its own - the same checks of the
 *  folder, the tab and the binding, its own failure record and its own end - because a guard on the
 *  caller is the one the next caller forgets. */
async function pullModuleList() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // its own, like every path to Zoho: a save notice meanwhile waits for the pull to end
    await requirePerm(op.root);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing.`);
    setStatus('Listing modules…', 'busy');
    const r = await toBridge({ cmd: 'listModules' }); if (!r?.ok) throw bridgeError(r, 'list failed');
    if (!op.current()) return;
    let prevIdx = [], prevLay = [];
    try { prevIdx = JSON.parse(await op.read('modules/index.json')) || []; } catch (_) {}
    try { prevLay = JSON.parse(await op.read('modules/layouts/index.json')) || []; } catch (_) {}
    const rowOf = new Map((Array.isArray(prevIdx) ? prevIdx : []).map((x) => [x && x.api_name, x]));
    const layOf = new Map((Array.isArray(prevLay) ? prevLay : []).map((x) => [x && x.module, x]));
    const modRows = [], layIndex = [], added = [], wFail = [];
    for (const m of r.modules || []) {
      if (!op.current()) return;
      const f = `modules/${sanitize(m.api_name || 'unknown')}.json`;
      // The file decides, not the index: a module whose file is there and whose row went missing must
      // not be taken for a new one - that would write an empty shell over its fields.
      let prev = null; try { prev = JSON.parse(await op.read(f)); } catch (_) {}
      if (prev) {
        modRows.push(rowOf.get(m.api_name) || { api_name: prev.api_name, module_name: prev.module_name, generated_type: prev.generated_type,
          fields: (prev.fields || []).length, layouts: (prev.layouts || []).length, related_lists: (prev.related_lists || []).length });
        layIndex.push(layOf.get(m.api_name) || { module: prev.api_name, generated: prev.module_name, layouts: prev.layouts || [] });
        continue;
      }
      try {
        await op.write(f, JSON.stringify({ ...m, fields: [], layouts: [], related_lists: [],
          fields_read: false, layouts_read: false, related_read: false, unreadable: null }, null, 2));
      } catch (e) { if ((e && e.message) === WS_MOVED) return; wFail.push(m.api_name); continue; }
      modRows.push({ api_name: m.api_name, module_name: m.module_name, generated_type: m.generated_type, fields: 0, layouts: 0, related_lists: 0 });
      layIndex.push({ module: m.api_name, generated: m.module_name, layouts: [] });
      added.push(m.api_name);
    }
    if (!op.current()) return;
    await op.write('modules/index.json', JSON.stringify(modRows, null, 2));
    await op.write('modules/layouts/index.json', JSON.stringify(layIndex, null, 2));
    const live = new Set((r.modules || []).map((m) => sanitize(m.api_name || 'unknown')));
    let pruned = 0; const rFail = [];
    for await (const p of walk(op.root)) {
      if (!op.current()) return;
      const stem = p.split('/').pop().replace(/\.json$/, '');
      if (!(isModuleFile(p) || isLayoutFile(p)) || live.has(stem)) continue;
      try { await op.remove(p); pruned++; } catch (e) { if ((e && e.message) === WS_MOVED) return; rFail.push(p); }
    }
    await rebuildModules(op);
    if (!op.current()) return;
    const gap = (wFail.length ? ` ${wFail.length} new module(s) could not be written: ${wFail.slice(0, 3).join(', ')}.` : '')
      + (rFail.length ? ` ${rFail.length} file(s) of removed modules could not be deleted - the next pull retries.` : '');
    setStatus(`Modules list pulled: ${(r.modules || []).length} in Zoho${added.length ? `, ${added.length} new - Pull list + details reads their fields` : ''}`
      + `${pruned ? `, ${pruned} file(s) of removed modules deleted` : ''}. Fields on disk were not read again.${gap}`, gap ? 'warn' : 'ok');
    await noteAccess('modules', gap ? { status: 0, message: gap.trim() } : null, op, true, 'list');
  } catch (e) { await notePullFailure('modules', e, op); } finally { endPull(); }
}

// ---------- modules: tree ----------
// Which module load is the current one. `rebuildModules()` empties `moduleData` and then fills it a
// file at a time, so two of them running together is not two lists - it is one list written by two
// writers: the second empties what the first has put in and both keep pushing, and every module
// comes out twice. Reported from a jump that arrives while the tab is already loading, which is
// exactly the window a jump lands in. The tree has carried this token since the phased load; the
// other lists were left with the hazard and no token, which is the «one of a set» miss this project
// keeps recording.
let moduleLoad = 0;

async function rebuildModules(op = beginWorkspaceOp()) {
  if (!op.root) return;
  if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'warn'); return; }
  const mine = ++moduleLoad;
  const current = () => mine === moduleLoad && op.current();
  setStatus('Loading modules…', 'busy');
  // The guarantee, not the accident. This was one line - read, then publish - and it was safe only
  // because `op.read` throws when the workspace has moved, so `_cfg` came back null and the write was
  // skipped. Its four siblings all ask, and so does `rebuildTree`; this one relied on a property of a
  // helper two files away. Found by a review, which also showed the checker could not see it: an
  // `await` earlier on the same line does not reset the sticky «a guard has been passed» flag.
  const _cfg = await opReadCfg(op);
  if (!op.current()) return;
  if (_cfg) bound = _cfg;
  await cacheBinding(bound);
  if (!current()) return;
  const names = [];
  for await (const p of walk(op.root)) { if (!current()) return; if (isModuleFile(p)) names.push(p); }
  names.sort();
  if (!current()) return;
  const rows = [];
  for (const p of names) {
    try {
      const m = JSON.parse(await op.read(p));
      rows.push({ path: p, api_name: m.api_name, gen: m.module_name || m.api_name, label: m.plural_label || m.singular_label || m.module_name || m.api_name, custom: m.generated_type === 'custom', generated_type: m.generated_type || '', fieldCount: (m.fields || []).length, lookupCount: (m.fields || []).filter((f) => f.lookup).length, layoutCount: (m.layouts || []).length, layouts: (m.layouts || []), viewable: (m.viewable !== false && m.visible !== false), navigable: moduleNavigable(m), unreadable: m.unreadable || null, fieldsRead: m.fields_read !== false });
    } catch (_) {}
  }
  if (!current()) return;
  moduleData = rows;          // published once, whole - never a list two loads are both writing into
  renderModules();
  setStatus(moduleData.length ? `${moduleData.length} modules in workspace.` : (emptyReason('modules') || 'No modules yet - click Pull.'), moduleData.length ? 'ok' : 'warn');
  await refreshContext();
}
// What Zoho said when it refused to describe a module, in one sentence, in one place - the row, the
// detail pane and both exports all ask this. Zoho's own words are quoted rather than reworded: the
// fact is the product, and our paraphrase of it would be an interpretation.
// Zoho understood and said no (4xx), as against everything else - a dropped connection, a 5xx, a
// tab that went away - which is a failure and stays retryable. A blip written to disk as a dated
// refusal would be a measurement that was never taken, presented as a settled one.
function isRefusal(status) { return Number(status) >= 400 && Number(status) < 500; }
function moduleRefusal(u) {
  if (!u) return null;
  const when = u.at ? new Date(u.at) : null;
  const day = when && !isNaN(when) ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}` : null;
  const said = u.message || u.code || `HTTP ${u.status || '?'}`;
  return {
    short: u.code === 'INVALID_MODULE' ? 'not described' : 'refused',
    text: `Zoho would not describe this module, so its fields, layouts and related lists were never read. `
        + `It answered ${u.status || '?'}${u.code ? ' ' + u.code : ''}: \u00ab${said}\u00bb${day ? `, asked on ${day}` : ''}. `
        + `Pulling again will not change that by itself - the answer has to change in Zoho first.`,
  };
}
function renderModules() {
  if (viewMode !== 'modules') return;
  const term = $('find').value.trim().toLowerCase();

  const groups = { Standard: [], Custom: [] };
  moduleData
    .filter((m) => moduleFilter === 'all' || (moduleFilter === 'custom' ? m.custom : !m.custom))
    .filter((m) => !term || (m.api_name || '').toLowerCase().includes(term) || (m.label || '').toLowerCase().includes(term))
    .forEach((m) => (m.custom ? groups.Custom : groups.Standard).push(m));
  const tree = $('tree'); tree.innerHTML = '';
  if (!groups.Standard.length && !groups.Custom.length) { tree.innerHTML = '<div class="empty">' + (moduleData.length ? '<b>No modules match.</b>' : (emptyReason('modules') || '<b>No modules yet.</b> Press <b>Pull</b> to read them.')) + '</div>'; return; }
  for (const g of ['Standard', 'Custom']) {
    const list = groups[g]; if (!list.length) continue;
    const isCol = collapsed.has('mod:' + g);
    const gh = document.createElement('div'); gh.className = 'grp' + (isCol ? ' collapsed' : '');
    gh.innerHTML = `<span class="chev">\u25be</span><span>${g}</span><span class="cnt">${list.length}</span>`;
    gh.onclick = () => { isCol ? collapsed.delete('mod:' + g) : collapsed.add('mod:' + g); renderModules(); };
    tree.appendChild(gh);
    if (isCol) continue;
    const nm = (m) => moduleNameMode === 'display' ? m.label : moduleNameMode === 'generated' ? m.gen : m.api_name;
    list.sort((a, b) => nm(a).localeCompare(nm(b)));
    list.forEach((m) => {
      const el = document.createElement('div'); el.className = 'f'; el.dataset.path = m.path; el.dataset.api = m.api_name;
      el.setAttribute('aria-selected', m.path === currentPath);
      const multi = (m.layoutCount || 0) > 1; const exp = expandedMods.has(m.path);
      // The layouts chevron lives on the RIGHT (next to the layout count), not between dot and name,
      // so module names line up with the other tabs' dot\u2192name spacing.
      //
      // And its slot is **always there**, empty on a module with one layout. It used to be absent,
      // which meant a row with several layouts was 12px wider on the right than its neighbours and
      // pushed its own field and layout counts left - so the one column a reader scans as figures
      // stopped being a column. Reported. A control that comes and goes may not move what is beside
      // it: reserve the space, do not reflow around it.
      const chev = `<span class="laychev${multi ? '' : ' none'}"${multi ? ' title="Show / hide layouts"' : ' aria-hidden="true"'}>${multi ? (exp ? '\u25be' : '\u25b8') : ''}</span>`;
      // The refusal wins over `error`: it is the more specific answer, and it is the one that says
      // whether doing anything again is worth it.
      //
      // \u2298, and grey. It wore \u27f3 in amber - the panel's "failed, click to retry" - which
      // advertised an action that changes nothing, and he said so. The vocabulary now runs
      // \u25cf here \u00b7 \u25cb not here yet \u00b7 \u25d0 partial \u00b7 \u27f3 failed \u00b7 \u2298 refused, and only the last
      // means "no" rather than "not yet". Reusing \u25cb would have been worse than a new glyph: in the
      // functions list it means "click to download", which is the opposite claim.
      const ref = moduleRefusal(m.unreadable);
      const stTitle = ref ? ref.text : m.error ? 'Failed - click to retry' : 'In workspace - click to resync fields from Zoho';
      el.innerHTML = `<span class="st ${ref ? 'st-none' : m.error ? 'st-err' : 'st-ok'}" title="${escA(stTitle)}">${ref ? '\u2298' : m.error ? '\u27f3' : '\u25cf'}</span><span class="fname">${escHtml(nm(m))}</span>`
        + (ref ? `<span class="rest rx" title="${escA(ref.text)}">${escHtml(ref.short)}</span>` : '')
        + `<span class="rest rf" title="${m.fieldCount} field(s)">${m.fieldCount ? m.fieldCount + 'f' : ''}</span>`
        + `<span class="rest rl" title="${m.layoutCount} layout(s)">${m.layoutCount ? m.layoutCount + 'L' : ''}</span>${chev}`;
      el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); resyncModule(m); };
      const ch = el.querySelector('.laychev');
      if (ch) ch.onclick = (ev) => { ev.stopPropagation(); exp ? expandedMods.delete(m.path) : expandedMods.add(m.path); renderModules(); };
      el.onclick = () => openModule(m.path); tree.appendChild(el);
      if (multi && exp) {
        (m.layouts || []).forEach((L) => {
          const sub = document.createElement('div'); sub.className = 'f fsub';
          sub.innerHTML = `<span class="laysub">\u21b3</span><span>${escHtml(L.name || String(L.id))}</span>${L.visible === false ? '<span class="rest" style="color:#6b7688">hidden</span>' : ''}${L.sections ? `<span class="rest" style="color:#8ea0bb">${L.sections} sections</span>` : ''}`;
          sub.onclick = () => openModule(m.path, String(L.id));
          tree.appendChild(sub);
        });
      }
    });
  }
}
async function resyncModuleNow(m) {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'bad'); return; }
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  setStatus(`Resyncing ${m.api_name}…`, 'busy');
  const r = await toBridge({ cmd: 'fetchModuleFields', apiName: m.api_name });
  let mod = {}; try { mod = JSON.parse(await op.read(m.path)); } catch (_) {}
  // Re-asking is the whole point of this dot, so the answer is recorded either way - a refusal
  // dated today, or its removal. Leaving a stale `unreadable` behind would keep the banner up on a
  // module Zoho has just described, which is the same class of lie in the other direction.
  if (!r?.ok) {
    if (isRefusal(r?.status)) {
      mod.unreadable = { status: r.status, code: r.code || null, message: r.detail || r.error || 'no answer', at: new Date().toISOString() };
      // The memory follows the file, never the other way round: with the write swallowed, the
      // panel showed the new verdict, the disk kept the old one, and the next load put the old
      // one back - a UI that told the truth for exactly one screenful. Same rule as below.
      try { await op.write(m.path, JSON.stringify(mod, null, 2)); }
      catch (e) { if ((e && e.message) !== WS_MOVED) setStatus(`Could not save ${m.api_name}: ${(e && e.message) || e}`, 'bad'); return; }
      if (!op.current()) return;
      m.unreadable = mod.unreadable; m.error = false;
      renderModules(); if (currentPath === m.path) openModule(m.path);
      setStatus(`${m.api_name}: ${moduleRefusal(m.unreadable).text}`, 'warn');
      return;
    }
    m.error = true; renderModules();
    setStatus(`Resync of ${m.api_name} failed: ${r?.error || 'no answer'}`, 'warn');
    return;
  }
  mod.fields = r.fields; delete mod.unreadable;
  try { await op.write(m.path, JSON.stringify(mod, null, 2)); }
  catch (e) { if ((e && e.message) !== WS_MOVED) setStatus(`Could not save ${m.api_name}: ${(e && e.message) || e}`, 'bad'); return; }
  if (!op.current()) return;
  m.fieldCount = r.fields.length; m.lookupCount = r.fields.filter((f) => f.lookup).length; m.error = false; m.unreadable = null;
  renderModules(); if (currentPath === m.path) openModule(m.path);
  setStatus(`Resynced ${m.api_name} (${m.fieldCount} fields).`, 'ok');
}
async function resyncModule(m) {
  return runPullAction(() => resyncModuleNow(m));
}
/** The values of a picklist, on request and downwards. Laid out on one line - eight of them, then
 *  «…(+31)» - a module with long options made the fields table scroll sideways with no end, and a
 *  horizontal scrollbar in a 400px panel hides the columns somebody came for. The count is the
 *  summary, because a number is a fact and «many» is not, and the list opens under it one value per
 *  line. Reported. */
/** A field's picklist values and the workflow rules that watch it, each a count that opens a list.
 *
 *  Both used to open downwards, in a row spanning the table, with the entries side by side as chips -
 *  reported as hard to read. They open a layer now, one entry per line, the width of the panel. The
 *  count for the rules has a column of its own so the table sorts by it. */
function pickCell(f) {
  const v = f.picklist || []; if (!v.length) return '';
  return `<button class="plbtn" data-list="values" data-f="${escA(f.api_name)}" aria-haspopup="dialog" title="Show the values, one per line">${v.length} value${v.length === 1 ? '' : 's'}</button>`;
}
function trigCell(f, rules) {
  const n = ruleCount(rules); if (!n) return '';
  return `<button class="plbtn" data-list="rules" data-f="${escA(f.api_name)}" aria-haspopup="dialog" aria-label="Workflows" title="Workflow rules this field starts, that check it, or that write it">${n}</button>`;
}
function bpCell(f, bps) {
  const n = ruleCount(bps); if (!n) return '';
  return `<button class="plbtn" data-list="bps" data-f="${escA(f.api_name)}" aria-haspopup="dialog" aria-label="Blueprints" title="Blueprints whose states this field holds, or whose transitions write it">${n}</button>`;
}
const lookupOf = (f) => (typeof f.lookup === 'string' ? f.lookup
  : (f.lookup && (f.lookup.api_name || (f.lookup.module && (f.lookup.module.api_name || f.lookup.module))))) || '';
/** How the Fields table is ordered. `key: null` is Zoho's own order, the default; a header cycles
 *  through its first direction, the other one, and back to Zoho's. Numbers start from the largest,
 *  because «which field fires the most rules» is the question a count column is sorted to answer.
 *  Kept across modules: comparing modules by one column should not mean asking for it each time. */
let fieldSort = { key: null, dir: 1 };
const FIELD_SORTS = {
  label: { text: 'Field', of: (f) => String(f.label || f.api_name || '').toLowerCase() },
  api: { text: 'API name', of: (f) => String(f.api_name || '').toLowerCase() },
  type: { text: 'Type', of: (f) => String(f.data_type || '') },
  req: { text: 'Req', of: (f) => (f.mandatory ? 1 : 0), numeric: true },
  lookup: { text: 'Lookup', of: (f) => lookupOf(f).toLowerCase() },
  // «WF», not «Workflows»: the word took a column's width for a cell holding one number, and the
  // table is read at panel width. The tooltip on the button still says it in full.
  wf: { text: 'WF', of: (f, n) => (n && n.wf) || 0, numeric: true },
  // The processes that touch this field: the one whose states it holds, and the ones whose
  // transitions write it. A separate column from WF because they are separate things in Zoho and a
  // reader asks about them separately - the count answers «which field does a process depend on».
  bp: { text: 'BP', of: (f, n) => (n && n.bp) || 0, numeric: true },
};
function sortedFields(fields, countOf, sort = fieldSort) {
  const list = (fields || []).map((f, i) => ({ f, i, n: countOf(f) }));
  const s = sort && FIELD_SORTS[sort.key];
  if (!s) return list;
  return list.sort((a, b) => {
    const x = s.of(a.f, a.n), y = s.of(b.f, b.n);
    const c = s.numeric ? x - y : String(x).localeCompare(String(y));
    return (c * sort.dir) || (a.i - b.i);
  });
}
function nextFieldSort(key, sort = fieldSort) {
  const first = FIELD_SORTS[key] && FIELD_SORTS[key].numeric ? -1 : 1;
  if (sort.key !== key) return { key, dir: first };
  if (sort.dir === first) return { key, dir: -first };
  return { key: null, dir: 1 };
}
/** What a count in the table on screen opens - that table's module and map, not a new reading. */
let fieldListShown = null, fieldListOpener = null, fieldListAgain = null;
// The buttons pane's own state, beside the fields table's. Separate because the dialog above looks a
// *field* up by api_name, and a button is not one - sharing the state would have returned early for
// every button and drawn an empty dialog.
let buttonListShown = null;
function openFieldList(kind, api, opener) {
  // The buttons pane's own dialog, before the field lookup below: a button is not a field, and that
  // lookup would return early for every one of them.
  if (kind === 'btnprofiles') {
    const b = ((buttonListShown && buttonListShown.rows) || []).find((x) => String(x.id) === String(api));
    if (!b) return;
    const profiles = b.profiles || [];
    $('fieldlisth').textContent = `${b.name || b.api_name || b.id} · ${profiles.length} profile${profiles.length === 1 ? '' : 's'}`;
    $('fieldlistbody').innerHTML = `<ol class="fllist">${profiles.map((p) => `<li>${escHtml(p)}</li>`).join('')}</ol>`;
    fieldListOpener = opener || null; fieldListAgain = { kind, api };
    $('scrim').classList.add('on'); panelInert(true); $('fieldlist').classList.add('on');
    $('fieldlistx').focus();
    return;
  }
  const shown = fieldListShown; if (!shown) return;
  const f = (shown.m.fields || []).find((x) => x.api_name === api); if (!f) return;
  const name = f.label || f.api_name;
  if (kind === 'values') {
    const v = f.picklist || [];
    $('fieldlisth').textContent = `${name} · ${v.length} value${v.length === 1 ? '' : 's'}`;
    $('fieldlistbody').innerHTML = `<ol class="fllist">${v.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ol>`;
  } else if (kind === 'bps') {
    // The same layer, grouped the same way: what the process does with the field is the reason the
    // reader opened it. A blueprint row opens the blueprint, as a rule row opens the rule.
    const bps = shown.bpOf ? shown.bpOf(f) : [], n = ruleCount(bps);
    $('fieldlisth').textContent = `${name} · ${n} blueprint${n === 1 ? '' : 's'}`;
    const li = (r) => `<li><button type="button" class="bare wflink" data-bpid="${escA(r.id)}" title="Open this blueprint">${escHtml(r.name)}</button>`
      + `<span class="wfwhen">${escHtml(r.when || '')}${r.transition ? ' · ' + escHtml(r.transition) : ''}${r.active ? '' : ' · off'}</span></li>`;
    // Not «Writes it»: that heading belongs to the workflow layer below, and one user-facing string
    // in two places drifts apart. A transition is what writes here, and the word says so.
    $('fieldlistbody').innerHTML = [['runs on', 'Runs on it'], ['writes', 'A transition writes it']].map(([role, title]) => {
      const mine = bps.filter((r) => r.role === role);
      return mine.length ? `<h4 class="flrole">${title} <span>${mine.length}</span></h4><ul class="fllist">${mine.map(li).join('')}</ul>` : '';
    }).join('');
  } else {
    const rules = shown.trig(f), n = ruleCount(rules);
    $('fieldlisth').textContent = `${name} · ${n} workflow${n === 1 ? '' : 's'}`;
    // Grouped by what the rule does with the field: a rule that both starts on it and writes it is
    // listed under each, because those are two different reasons to be looking at it.
    const li = (r) => `<li><button type="button" class="bare wflink" data-wfid="${escA(r.id)}" title="Open this workflow">${escHtml(r.name)}</button>`
      + `<span class="wfwhen">${escHtml(roleText(r))}${r.active ? '' : ' · off'}</span></li>`;
    $('fieldlistbody').innerHTML = [['starts', 'Starts it'], ['checks', 'Checks it'], ['writes', 'Writes it']].map(([role, title]) => {
      const mine = rules.filter((r) => r.role === role);
      return mine.length ? `<h4 class="flrole">${title} <span>${mine.length}</span></h4><ul class="fllist">${mine.map(li).join('')}</ul>` : '';
    }).join('');
  }
  fieldListOpener = opener || null; fieldListAgain = { kind, api };
  $('scrim').classList.add('on'); panelInert(true); $('fieldlist').classList.add('on');
  $('fieldlistx').focus();
}
function closeFieldList() {
  if (!$('fieldlist').classList.contains('on')) return;
  $('scrim').classList.remove('on'); panelInert(false); $('fieldlist').classList.remove('on');
  const back = fieldListOpener, again = fieldListAgain; fieldListOpener = null; fieldListAgain = null;
  // The table can be drawn again while the layer is open - a pull finishing underneath it - and the
  // button that opened it is then gone. Its successor in the new table takes the keyboard instead of
  // the page body. Seen by review.
  if (back && back.isConnected) back.focus();
  else if (again) {
    const twin = [...document.querySelectorAll('#pvfields .plbtn')].find((b) => b.dataset.list === again.kind && b.dataset.f === again.api);
    if (twin) twin.focus();
  }
}
/** Every report cuts a long picklist, and none of them said so: twelve values printed and the rest
 *  gone, which makes the report quietly wrong rather than merely shorter. It states what it dropped
 *  now, the way the panel always did. */
function _pick(values, cap, esc) {
  const v = values || []; if (!v.length) return '';
  return esc(v.slice(0, cap).join(', ')) + (v.length > cap ? ` \u2026(+${v.length - cap} more)` : '');
}

/** Copy a related list's API name, and say so only if the browser actually did it.
 *
 * A `.then()` callback is a scope `tools/asynccheck.py` cannot enter, so what happened after this
 * write was unread - and what happens after it is a status line, which belongs to whatever workspace
 * is on screen. Awaited here, where it can be checked.
 */
async function copyRelatedName(text) {
  // A refusal is the browser's own dialogue and needs nothing from us; what must not happen is
  // «Copied» over a clipboard that was never written.
  try { await navigator.clipboard.writeText(text); } catch (_) { return; }
  setStatus(`Copied \u00ab${text}\u00bb`, 'ok');
}

/** Draw the layout the reader picked, or every field if they picked «all».
 *
 * `mine` and `op` are carried in rather than read again: this reads a file, and by the time it comes
 * back the panel may be showing another module in another workspace - which is what `previewCurrent`
 * is asked about before anything is written.
 */
async function showChosenLayout(sel, m, mine, op) {
  const body = document.getElementById('laybody'); const v = sel.value;
  if (v === '__all__') {
    // Read again rather than drawn from the cache: a workflows write since the module opened dropped
    // it, and a table drawn without it lost every mark and the note that explains their absence.
    const trig = await fieldTriggersNow(op, () => previewCurrent(mine, op));
    const bpt = await blueprintFieldsNow(op, () => previewCurrent(mine, op));
    if (!previewCurrent(mine, op)) return;
    body.innerHTML = renderFieldsTable(m, trig, bpt); return;
  }
  body.innerHTML = '<div style="padding:10px;color:var(--muted)">Loading layout\u2026</div>';
  let full = []; try { full = JSON.parse(await op.read(`modules/layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
  if (!previewCurrent(mine, op)) return;
  const L = (full || []).find((x) => String(x.id) === String(v));
  body.innerHTML = L ? renderLayoutView(L) : '<div style="padding:10px;color:var(--muted)">Layout detail not found - re-pull modules.</div>';
}

function renderFieldsTable(m, found = fieldTriggers, bpFound = blueprintFields) {
  const trig = (f) => (found && found.map.get(`${m.api_name}:${f.api_name}`)) || [];
  const bpOf = (f) => (bpFound && bpFound.map && bpFound.map.get(`${m.api_name}:${f.api_name}`)) || [];
  fieldListShown = { m, found, trig, bpFound, bpOf };
  // Both counts, because both columns sort: one number per row could only ever order by one of them.
  const rows = sortedFields(m.fields, (f) => ({ wf: ruleCount(trig(f)), bp: ruleCount(bpOf(f)) })).map(({ f }) => `<tr>
    <td title="${escA(f.label || f.api_name || '')}">${escHtml(f.label || f.api_name)}${f.custom ? ' <span style="color:#a78bfa">*</span>' : ''}</td>
    <td class="mono" title="${escA(f.api_name || '')}">${escHtml(f.api_name)}</td>
    <td>${escHtml(f.data_type || '')}${f.length ? ` (${f.length})` : ''} ${pickCell(f)}</td>
    <td style="text-align:center">${f.mandatory ? '\u25cf' : ''}</td>
    <td class="mono">${f.lookup ? '\u2192 ' + `<span class="wf-fn" data-mod="${escA(lookupOf(f))}" title="${escA(lookupOf(f) + ' - click to open the module')}">${escHtml(lookupOf(f))}</span>` : ''}</td>
    <td class="num">${trigCell(f, trig(f))}</td>
    <td class="num">${bpCell(f, bpOf(f))}</td>
  </tr>`).join('');
  if (!rows) {
    // The refusal is stated once, in the banner directly above this. Repeating it here and again
    // under Related lists put the same sixty words on screen three times.
    return `<div class="empty" style="padding:12px 10px">${m.unreadable ? '<b>No fields were read.</b>'
      // **No area here.** This is one module's fields, inside a workspace that has every other module
      // on disk - so the area's own verdict does not apply to it, and asking for it printed «the last
      // pull of this area did not succeed. Nothing is stored for it» beside a list of 299 modules the
      // reader can see. `failed` is written by a pull that worked and came up short, which is exactly
      // the pull that produces this state. The workspace-level blockers above it still apply, and
      // those are what `emptyReason()` is being asked for.
      : (emptyReason() || '<b>No fields recorded.</b> Press <b>Pull list + details</b> above to read them from Zoho.')}</div>`;
  }
  // The values have no column: a column of them is what once made the table scroll sideways, and
  // their count sits in Type, where the word «picklist» already is. The rules do have one - a number,
  // narrow - because a count that cannot be sorted cannot answer «which field fires the most».
  // Silence here would read as «no field starts a rule», which is only true when the rules were read.
  const notes = !found ? []
    : !found.pulled ? ['No workflow rules are in this workspace, so no field here shows the rules that touch it.']
    : [found.unread ? `${found.unread} workflow rule(s) are not downloaded, so the fields they touch are not counted.` : '',
       found.actions === false ? 'Automation actions are not pulled, so a rule that writes a field is not counted for it.' : ''].filter(Boolean);
  // A header is a button: sorting is reached by Tab and Enter like every other control here.
  const th = (key) => {
    const on = fieldSort.key === key, s = FIELD_SORTS[key];
    return `<th${key === 'wf' || key === 'bp' ? ' class="num"' : ''}${on ? ` aria-sort="${fieldSort.dir === 1 ? 'ascending' : 'descending'}"` : ''}>`
      + `<button type="button" class="bare thsort" data-sort="${escA(key)}" title="Sort by this column - again to reverse, a third time for Zoho's order">${escHtml(s.text)}${on ? (fieldSort.dir === 1 ? ' \u25b4' : ' \u25be') : ''}</button></th>`;
  };
  return `<table class="ftbl"><thead><tr>${Object.keys(FIELD_SORTS).map(th).join('')}</tr></thead><tbody>${rows}</tbody></table>`
    + notes.map((t) => `<div class="ftnote">${escHtml(t)}</div>`).join('');
}
// Selecting a different item must start the reader at the top of the new content;
// keeping the previous scroll offset lands you in the middle of an unrelated document.
/** The ladders a record climbs: one table per pipeline, its stages in order, and what a stage is
 *  worth. Measured on a sandbox: the Stage picklist a module carries is the union of its pipelines'
 *  stages - 24 values from ladders of 9, 8 and 7 - so the field says which stages exist and nothing
 *  about which ladder they sit on. The module's pool is wider still: 33 there, the nine left over
 *  being Zoho's default stages on no pipeline at all, which is the group at the bottom.
 *
 *  Zoho answers the probability on the *stage*, not on the pipeline-and-stage pair, so a stage on two
 *  ladders is worth the same on both. Measured on one org; said rather than assumed. */
/** The custom buttons on this module, and what each one calls.
 *
 *  **The other end of a relation the mirror only ever saw from one side.** A function's
 *  `associated_place` already said «used in a button» and there was nowhere to go: no list of the
 *  buttons a module carries, and no way back from a button to its function. Measured on a real org:
 *  18 buttons across 8 modules, and three of five carry a *different* name from the function they
 *  call - which is why the chip is keyed on the function's id and not on the button's name.
 *
 *  A button that calls no function is still listed: what it does is Zoho's business, and leaving it
 *  out would make this a list of «buttons we could resolve» wearing the name of a list of buttons. */
function renderModuleButtons(m, rows) {
  // Kept for the dialog, which is opened from a click long after this render: `fieldListShown` is
  // the fields table's own state and is looked up by field api_name, so a button - which is not a
  // field - needs its own or the dialog returns empty for every one of them.
  buttonListShown = { module: m.api_name, rows };
  if (!rows.length) return '<div class="empty" style="padding:12px 10px"><b>No custom buttons.</b> This module carries none, or they were not read by the last pull.</div>';
  const fnCell = (b) => (b.function_id
    ? `<span class="wf-fn" data-fnid="${escA(b.function_id)}" data-fnname="${escA(b.function_name || '')}" title="${escA('Open ' + (b.function_name || b.function_id))}">ƒ ${escHtml(b.function_name || b.function_id)}</span>`
    : `<span style="color:var(--muted)">${escHtml(b.action || 'no function')}</span>`);
  return `<div class="secttl">Custom buttons (${rows.length}) <span style="color:var(--muted);font-weight:400">- what the button runs, where it appears, and who sees it</span></div>`
    + '<table class="ftbl"><thead><tr><th>Button</th><th>Runs</th><th>Where</th><th>Layouts</th><th>Profiles</th></tr></thead><tbody>'
    + rows.map((b) => `<tr><td title="${escA(b.api_name || '')}">${escHtml(b.name || b.api_name || b.id)}</td>`
      + `<td>${fnCell(b)}</td>`
      + `<td>${escHtml(b.position || '')}</td>`
      + `<td>${escHtml((b.layouts || []).join(', '))}</td>`
      // A count and a dialog, like a picklist's values: the profile list on a real org is three or
      // four names of a dozen characters each, and printed in the cell it pushed the whole table
      // past the width of the panel. Reported. The names are one click away and nothing is lost.
      + `<td>${(b.profiles || []).length
          ? `<button class="plbtn" data-list="btnprofiles" data-f="${escA(String(b.id))}" aria-haspopup="dialog" title="${escA('Profiles that see ' + (b.name || b.api_name || b.id))}">${(b.profiles || []).length}</button>`
          : ''}</td></tr>`).join('')
    + '</tbody></table>';
}
function renderPipelines(m) {
  const pipes = m.pipelines || [], pool = m.stage_pool || [];
  if (!pipes.length && !pool.length) {
    return `<div class="empty" style="padding:12px 10px">${m.pipelines_read === false
      ? '<b>The pipelines were not read.</b> Zoho did not answer for them when this module was pulled - press <b>Pull list + details</b> above.'
      : '<b>No pipelines.</b> This module moves no record along stages, or Zoho does not offer them for it.'}</div>`;
  }
  const worth = new Map(pool.map((st) => [st.value || st.name, st]));
  const onALadder = new Set(pipes.flatMap((p) => (p.stages || []).map((st) => st.value || st.name)));
  const row = (st, i) => {
    const w = worth.get(st.value || st.name) || {};
    return `<tr><td class="num">${st.sequence == null ? i + 1 : st.sequence}</td><td>${escHtml(st.name)}</td>`
      + `<td>${escHtml(st.forecast_type || '')}</td><td class="num">${w.probability == null ? '' : w.probability + '%'}</td>`
      + `<td>${escHtml(st.forecast_category || w.forecast_category || '')}</td></tr>`;
  };
  const head = '<thead><tr><th class="num">#</th><th>Stage</th><th>Outcome</th><th class="num">Prob.</th><th>Forecast</th></tr></thead>';
  const table = (rows) => `<table class="ftbl">${head}<tbody>${rows}</tbody></table>`;
  let html = pipes.map((p) => `<div class="secttl">${escHtml(p.name)}${p.default ? ' <span class="pipedef">default</span>' : ''}`
    + `<span style="color:var(--muted);font-weight:400"> - ${(p.stages || []).length} stage(s)${p.layout ? ' · layout ' + escHtml(p.layout) : ''}</span></div>`
    + table((p.stages || []).map(row).join('')), '').join('');
  // The stages the module keeps and no ladder uses: Zoho's defaults, left behind when the pipelines
  // were built. They are in no picklist the panel draws, so this is the only place they are visible.
  const spare = pool.filter((st) => !onALadder.has(st.value || st.name));
  if (spare.length) {
    html += `<div class="secttl">In the module, on no pipeline <span style="color:var(--muted);font-weight:400">- ${spare.length}</span></div>`
      + table(spare.map((st, i) => row({ ...st, sequence: null }, i)).join(''));
  }
  return html + (m.pipelines_kept
    ? '<div class="ftnote">This pull did not read the pipelines; these are what the last pull that could read them saw.</div>' : '');
}
function resetPreviewScroll() {
  const doIt = () => {
    ['pvtable', 'pvbody', 'pvcode', 'pvwrap'].forEach((id) => { const e = $(id); if (e) { e.scrollTop = 0; e.scrollLeft = 0; } });
    const p = $('preview');
    if (p) p.querySelectorAll('pre,.code,.scroll,[style*="overflow"]').forEach((e) => { e.scrollTop = 0; e.scrollLeft = 0; });
  };
  doIt(); requestAnimationFrame(doIt);   // again after layout, for content rendered on the next frame
}
function renderLayoutView(layout) {
  const secs = layout.sections || [];
  if (!secs.length) return '<div style="padding:10px;color:var(--muted)">This layout has no section detail (re-pull modules).</div>';
  return secs.map((sec) => {
    const flds = sec.fields || [];
    const rows = flds.map((f) => `<tr>
      <td>${escHtml(f.field_label || f.display_label || f.api_name)}</td>
      <td class="mono">${escHtml(f.api_name || '')}</td>
      <td>${escHtml(f.data_type || '')}</td>
      <td style="text-align:center">${f.required ? '\u25cf' : ''}</td>
    </tr>`).join('');
    return `<div class="secttl">${escHtml(sec.display_label || sec.name || 'Section')} <span style="color:var(--muted)">(${flds.length})</span></div>`
      + `<table class="ftbl"><thead><tr><th>Field</th><th>API name</th><th>Type</th><th>Req</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
}
async function openModule(path, layoutId) {
  const mine = ++previewLoad;
  const op = beginWorkspaceOp();
  if (!(await ensurePerm(op.root))) { if (previewCurrent(mine, op)) setStatus('File access denied - click Refresh.', 'bad'); return; }
  if (!previewCurrent(mine, op)) return;
  currentPath = path; navHere(); clearItemStatus();
  selectRow(path);
  let m; try { m = JSON.parse(await op.read(path)); } catch (e) { if (previewCurrent(mine, op)) setStatus(MSG.readFailed + e.message, 'bad'); return; }
  if (!previewCurrent(mine, op)) return;
  // Which rules each field makes fire is read from every rule file, once, and dropped when one is written.
  const trig = await fieldTriggersNow(op, () => previewCurrent(mine, op));
  // Which blueprints touch each field, read on the same terms: once, here, and dropped by a write to
  // either source. Without it the BP column would be empty on a module opened straight from the tree.
  const bpTrig = await blueprintFieldsNow(op, () => previewCurrent(mine, op));
  if (!previewCurrent(mine, op)) return;
  navNames({ display: m.plural_label || m.singular_label || m.module_name || m.api_name,
             gen: m.module_name || m.api_name, api: m.api_name });
  const nav = moduleNavigable(m);
  const refusal = moduleRefusal(m.unreadable);
  setPvName(`${m.plural_label || m.singular_label || m.module_name || m.api_name} \u00b7 ${m.api_name} \u00b7 ${(m.fields || []).length} fields${nav ? '' : ' \u00b7 no records tab'}`, path);
  $('pvreveal').style.display = nav ? '' : 'none'; $('pvreveal').textContent = 'Records \u2197'; $('pvreveal').title = 'Open the module\'s records list in Zoho';
  $('pvfind').style.display = nav ? '' : 'none'; $('pvfind').textContent = 'Layouts \u2197'; $('pvfind').title = 'Open the module\'s layouts (add/edit fields & layout) in Zoho';
  $('pvcallers').className = ''; $('pvcallers').textContent = '';
  showModuleUsage(m.api_name, path, mine, op);   // not awaited: it needs the graph, and the fields must not wait for it
  const gen = m.module_name || m.api_name;
  // From disk, not from `workflowData`/`blueprintData`: those are filled only by their own tabs, and
  // a module opened first would show nothing - the exact trap that made the module label read as an
  // API name five times. Matched on either name Zoho gives a module: a custom one is `Iscrizioni`
  // here and `CustomModule20` in the blueprint index.
  const _isThis = (x) => x && (x.module === m.api_name || x.module === m.module_name);
  let modRules = [], modBps = [];
  try { modRules = (JSON.parse(await op.read('workflows/index.json')) || []).filter(_isThis); } catch (_) {}
  try { modBps = (JSON.parse(await op.read('blueprints/index.json')) || []).filter(_isThis); } catch (_) {}
  if (!previewCurrent(mine, op)) return;
  const namesBlock = `<div style="padding:8px 10px;font:11px var(--mono);border-bottom:1px solid var(--border);background:#141b29;line-height:1.7">`
    + `<div style="color:#8ea0bb">display: <span style="color:#e7edf6">${escHtml(m.plural_label || m.singular_label || m.module_name || m.api_name)}</span></div>`
    + `<div style="color:#8ea0bb">api_name: <span style="color:#82d2ff">${escHtml(m.api_name)}</span></div>`
    + `<div style="color:#8ea0bb">generated: <span style="color:#a78bfa">${escHtml(gen)}</span>${nav ? '' : ' <span style=\"color:#fbbf24\">(no records tab)</span>'}</div>`
    + `<div style="color:#8ea0bb">layouts: <span style="color:#e7edf6">${(m.layouts || []).length || (m.layouts_read === false ? 'not read' : 0)}</span>${(m.layouts || []).length ? ' <span style=\"color:#8ea0bb\">(' + (m.layouts || []).map((l) => escHtml(l.name)).join(', ') + ')</span>' : ''}</div>`
    // What automates this module, from the module's own side. Until now it was reachable only per
    // *field*, through the WF and BP columns - so a rule whose trigger is not a field, and every
    // blueprint, had no path from here at all, while both name this module in their own index.
    + (modRules.length ? `<div style="color:#8ea0bb">rules: ${modRules.map((w) =>
        `<span class="wf-fn" data-wfx="${escA(String(w.id))}" title="${escA(w.name || '')}">${escHtml(w.name || w.id)}</span>`).join('')}</div>` : '')
    + (modBps.length ? `<div style="color:#8ea0bb">blueprints: ${modBps.map((b) =>
        `<span class="wf-fn" data-bpx="${escA(String(b.id))}" title="${escA(b.name || '')}">${escHtml(b.name || b.id)}</span>`).join('')}</div>` : '')
    + `</div>`;
  const lays = m.layouts || [];
  const selector = lays.length
    ? `<div class="laybar">Layout: <select id="laysel"><option value="__all__">All fields (flat, ${(m.fields || []).length})</option>`
      + lays.map((l) => `<option value="${escA(String(l.id))}">${escHtml(l.name || l.id)}${l.visible === false ? ' \u00b7 hidden' : ''}${l.sections ? ` \u00b7 ${l.sections} sections` : ''}</option>`).join('')
      + `</select> <button id="laymod" class="laymod" title="Open the selected layout in Zoho - Zoost shows it, Zoho is where it is changed">View \u2197</button></div>`
    : '';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  // Absent, not disabled, and not left to open an empty window: with no fields there is no box to
  // draw and no lookup to follow, so the depth control and the ER button have nothing to act on.
  const relBar = refusal ? '' : `depth <select id="reldepth"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select><button id="relopen" class="laylocal icon" aria-label="ER diagram" title="ER diagram - opened on this module at the depth chosen here, in its own window"><svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5" rx="1"/><rect x="9" y="9" width="5.5" height="5" rx="1"/><path d="M7 4h3.5a1.2 1.2 0 0 1 1.2 1.2V9"/></svg></button>`;
  const rls = m.related_lists || [];
  const rlBlock = rls.length
    ? `<div class="secttl">Related lists (${rls.length}) <span style="color:var(--muted);font-weight:400">- API name for zoho.crm.getRelatedRecords(); click to copy</span></div>`
      + `<table class="ftbl"><thead><tr><th>API name</th><th>Label</th><th>Target module</th><th>Type</th></tr></thead><tbody>`
      + rls.map((r) => `<tr><td class="mono rlcopy" data-c="${escA(r.api_name)}" title="Click to copy">${escHtml(r.api_name)}</td>`
        + `<td>${escHtml(r.label || '')}</td>`
        + `<td class="mono">${(r.module || r.connected_module)
             ? `<span class="wf-fn" data-mod="${escA(r.module || r.connected_module)}" title="${escA((r.module || r.connected_module) + ' - click to open the module')}">${escHtml(r.module || r.connected_module)}</span>`
             : ''}${r.linking_module ? ` <span style="color:var(--muted)">via </span><span class="wf-fn" data-mod="${escA(r.linking_module)}" title="${escA(r.linking_module + ' - click to open the module')}">${escHtml(r.linking_module)}</span>` : ''}</td>`
        + `<td>${escHtml(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td></tr>`).join('')
      + `</tbody></table>`
    : `<div class="secttl">Related lists</div><div style="padding:8px 10px;color:var(--muted)">${
        refusal ? 'Not read either - Zoho would not describe this module.'
        : m.related_read === false ? 'Neither endpoint would answer for this module, so whether it has any is unknown - not that it has none.'
        : 'None recorded - re-run <b>Pull Modules</b> to fetch them.'}</div>`;
  const refBanner = refusal
    ? `<div style="margin:8px 10px;padding:8px 10px;font:11px var(--sans);line-height:1.5;color:#f7c66b;background:rgba(217,119,6,.12);border:1px solid #8a6321;border-radius:6px">${escHtml(refusal.text)}</div>`
    : '';
  // Three tabs: Fields, Related lists, Details. The pane once held the names, the banner, the
  // relations bar, the layout picker, the fields table *and* the related lists, stacked in 400px;
  // splitting it in two left the related lists at the bottom of «Details», under everything else,
  // which is a column a side panel still cannot show - «you struggle to see the whole detail, there
  // is no room». The fields are what a module is opened for, so they stay first; the related-list
  // API names are the one string Deluge actually needs, so they get a tab instead of a footer.
  // `#pvcallers` is a long-lived element that this function *moves* into the Details pane below - and
  // the pane lives inside `#pvtable`, whose contents are replaced on the next line. Opening a second
  // module therefore destroyed it, and every later `$('pvcallers')` was null: the detail of every
  // module after the first said nothing about what reads or writes it, silently. Caught by the probe
  // on the first run, in the case that opens a second module.
  //
  // So it goes home before the write and comes back after it. The rule is general and worth the line:
  // an element that outlives a render must not be inside what the render replaces.
  // The module's custom buttons, out of the index the modules pull writes. Filtered here rather than
  // kept inside each module file: one file for the org, and a module Zoho refused keeps whatever the
  // last pull recorded for it instead of being emptied by this read.
  let btnRows = [];
  try {
    btnRows = (JSON.parse(await op.read('buttons/index.json')) || [])
      .filter((b) => b && b.module === m.api_name);
  } catch (_) { /* never pulled, or nothing on disk: the pane says so rather than pretending none */ }
  if (!previewCurrent(mine, op)) return;
  $('pvcallershome').after($('pvcallers'));
  $('pvtable').innerHTML = `<div id="pvfields">${selector}<div id="laybody">${renderFieldsTable(m, trig, bpTrig)}</div></div>`
    + `<div id="pvrels">${rlBlock}</div>`
    + `<div id="pvpipes">${renderPipelines(m)}</div>`
    + `<div id="pvbtns">${renderModuleButtons(m, btnRows)}</div>`
    + `<div id="pvdetails">${refBanner}${namesBlock}</div>`;
  // Offered only where the module has them, the way Files is offered only for a project: the pane is
  // rebuilt by every open, so the flag is set beside it rather than remembered.
  $('pvpipes').dataset.available = ((m.pipelines || []).length || (m.stage_pool || []).length) ? '1' : '';
  $('pvbtns').dataset.available = btnRows.length ? '1' : '';
  pvTabsFor('module');                 // clears the slot, so the bar goes in after it, never before
  // The names first, then what reads and writes it. It was the other way round - «read by» and
  // «written by» at the top and the module's own display name, api_name and generated name below the
  // fold - which is backwards: what the thing *is* comes before what uses it. Reported with a
  // picture. Moving the element rather than re-rendering it keeps `showModuleUsage()` writing into
  // the one box it has always written into, and it arrives asynchronously into whatever is on screen.
  $('pvdetails').appendChild($('pvcallers'));
  $('pvtabsr').innerHTML = relBar;
  $('pvtable').querySelectorAll('.rlcopy').forEach((c) => (c.onclick = () => copyRelatedName(c.dataset.c)));
  // The lookup and related-list chips are wired by the delegated listener on `#pvtable`, not here:
  // this table is rebuilt by the layout picker and by every column sort, and a handler attached once
  // per open dies on the second render - which is exactly how those chips came to be drawn and dead.
  // The function a button runs opens like every other function chip in this panel - and it is the
  // whole point of the pane: `associated_place` could already say «used in a button», and this is
  // the way back. Wired here because the module pane draws its own chips and calls nothing else.
  wireFnChips($('pvbtns'), (sp) => openFunctionFromWorkflow(sp.dataset.fnid, sp.dataset.fnname));
  $('pvdetails').querySelectorAll('[data-wfx]').forEach((c) => (c.onclick = () => healthOpenWorkflow(c.dataset.wfx)));
  $('pvdetails').querySelectorAll('[data-bpx]').forEach((c) => (c.onclick = () => healthOpenBlueprint(c.dataset.bpx)));
  const relOpen = $('pvtabsr').querySelector('#relopen');
  if (relOpen) relOpen.onclick = () => openSchemaFocus(m.api_name, parseInt(document.getElementById('reldepth').value, 10) || 2);
  const sel = document.getElementById('laysel');
  // The handler is a declaration and this is the wiring - an `= async () => {}` is a scope the race
  // checker cannot enter, and the read below it is exactly the kind that has to be checked: it awaits
  // a file and then writes into a box that may belong to another module by then. The arrow *returns*
  // the promise, which is what keeps the `await sel.onchange()` further down meaning what it meant.
  if (sel) sel.onchange = () => showChosenLayout(sel, m, mine, op);
  const mod = document.getElementById('laymod');
  if (mod) mod.onclick = () => { const v = sel ? sel.value : '__all__'; openModuleLayout(m.module_name || m.api_name, v === '__all__' ? null : v); };
  if (layoutId && sel) { sel.value = String(layoutId); if (sel.value === String(layoutId)) await sel.onchange(); }
  if (!previewCurrent(mine, op)) return;
  showPreview();
}

// ---------- modules: schema graph (modules as nodes, lookups as edges) + function bridge ----------
async function buildSchemaGraph(focusApi, depth, op = beginWorkspaceOp()) {
  // Reads through the op: this walks and reads for seconds on a large org, and it used to resolve
  // every path against whatever folder was current by then.
  const modPaths = [];
  for await (const p of walk(op.root)) if (isModuleFile(p)) modPaths.push(p);
  const mods = [];
  for (const p of modPaths) { try { const m = JSON.parse(await op.read(p)); m._path = p; mods.push(m); } catch (_) {} }
  // Field -> layout membership. The module JSON only carries a layout summary; the full
  // sections/fields structure lives in modules/layouts/<Module>.json (written by Pull Modules).
  for (const m of mods) {
    let full = [];
    try { full = JSON.parse(await op.read(`modules/layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
    if (!Array.isArray(full) || !full.length) continue;
    m._layList = full.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false }));
    const memb = {};
    full.forEach((l, i) => (l.sections || []).forEach((sec) => (sec.fields || []).forEach((fl) => {
      const k = fl.api_name; if (!k) return;
      const e = memb[k] || (memb[k] = { lay: [], req: [] });
      if (!e.lay.includes(i)) e.lay.push(i);
      if (fl.required && !e.req.includes(i)) e.req.push(i);
    })));
    m._layMap = memb;
  }
  // functions (for the code<->module bridge)
  const funcs = [];
  for await (const p of walk(op.root)) {
    if (!p.endsWith('.dg')) continue;
    try {
      const dg = await op.read(p); let meta = {}; try { meta = JSON.parse(await op.read(p.replace(/\.dg$/, '.meta.json'))); } catch (_) {}
      funcs.push({ file: p, api_name: meta.api_name || p.split('/').pop().replace(/\.dg$/, ''), name: meta.name, ns: meta.nameSpace || p.split('/')[0], dg });
    } catch (_) {}
  }
  const nodes = {};
  mods.forEach((m) => {
    nodes[m.api_name] = {
      id: m.api_name, namespace: (m.generated_type === 'custom' ? 'custom' : 'standard'),
      name: m.api_name, api_name: m.api_name, display_name: m.plural_label || m.singular_label || m.module_name || m.api_name,
      called_by: [], calls: [], rest: false, dead_suspect: false, unresolved: [], ambiguous: [],
      category: m.generated_type || 'module', description: '', return_type: null, params: [],
      associated_place: null, file: m._path, source_code: '',
      // Zoho would not describe this module, so it has no fields, no lookups and no relations *that
      // anyone has read*. Carried into the graph because a box with nothing in it and a node with no
      // edges are both claims, and neither is one we are entitled to make.
      unreadable: m.unreadable || null,
      fields: (m.fields || []).map((fl) => {
        const e = (m._layMap || {})[fl.api_name];
        return e ? Object.assign({}, fl, { _lay: e.lay, _req: e.req }) : fl;
      }),
      layouts: (m._layList && m._layList.length) ? m._layList : (m.layouts || []),
      related_lists: m.related_lists || [],
      layoutDetail: !!(m._layMap), touched_by: [],
    };
  });
  // lookup edges (only to known modules)
  const edgeSet = new Set();
  mods.forEach((m) => (m.fields || []).forEach((fld) => {
    if (fld.lookup && nodes[fld.lookup] && fld.lookup !== m.api_name) {
      nodes[m.api_name].calls.push(fld.lookup); nodes[fld.lookup].called_by.push(m.api_name);
      edgeSet.add(m.api_name + '\u0000' + fld.lookup);
    }
  }));
  // "Nothing references this" is a measurement, and on a module Zoho refused it was never taken:
  // its own fields were not read either, so both directions are unknown rather than empty. Same rule
  // as a workflow that has not been downloaded having no scheduled-action count instead of zero.
  Object.values(nodes).forEach((n) => { n.calls = [...new Set(n.calls)]; n.called_by = [...new Set(n.called_by)]; n.dead_suspect = !n.unreadable && n.called_by.length === 0; });
  // function bridge: a function "touches" a module if its code contains the module api_name as a string literal
  funcs.forEach((fn) => mods.forEach((m) => {
    const dq = '"' + m.api_name + '"', sq = "'" + m.api_name + "'";
    if (fn.dg.indexOf(dq) >= 0 || fn.dg.indexOf(sq) >= 0) nodes[m.api_name].touched_by.push({ api_name: fn.api_name, ns: fn.ns, file: fn.file });
  }));
  // Optional ego-graph: keep only modules within `depth` lookup-hops of the focus module (undirected).
  let outNodes = nodes, keepEdges = [...edgeSet];
  if (focusApi && nodes[focusApi]) {
    const adj = {}; Object.keys(nodes).forEach((k) => (adj[k] = new Set()));
    [...edgeSet].forEach((e) => { const [a, b] = e.split('\u0000'); adj[a].add(b); adj[b].add(a); });
    const keep = new Set([focusApi]); let frontier = [focusApi]; const D = Math.max(1, depth || 2);
    for (let d = 0; d < D; d++) { const next = []; frontier.forEach((k) => adj[k].forEach((nb) => { if (!keep.has(nb)) { keep.add(nb); next.push(nb); } })); frontier = next; if (!frontier.length) break; }
    outNodes = {}; keep.forEach((k) => { outNodes[k] = nodes[k]; });
    keepEdges = [...edgeSet].filter((e) => { const [a, b] = e.split('\u0000'); return keep.has(a) && keep.has(b); });
    Object.values(outNodes).forEach((n) => { n.calls = n.calls.filter((x) => keep.has(x)); n.called_by = n.called_by.filter((x) => keep.has(x)); n.focus = (n.api_name === focusApi); });
  }
  const edges = keepEdges.map((e) => { const [a, b] = e.split('\u0000'); return [a, b]; });
  const dead = Object.values(outNodes).filter((n) => n.dead_suspect).length;
  return { kind: 'schema', nodes: outNodes, edges, focus: (focusApi && nodes[focusApi]) ? focusApi : null, depth: (focusApi && nodes[focusApi]) ? Math.max(1, depth || 2) : null, counts: { nodes: Object.keys(outNodes).length, edges: edges.length, dead_suspects: dead, unresolved: 0 }, workspace: { instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null } };
}
// Open the call graph centred on one function, at a depth. The same shape as openSchemaFocus for
// modules, and deliberately so: the window, the controls and the wording are the ones already there.
async function openCallFocus(id, depth) {
  const op = beginWorkspaceOp(), ws = graphIdentity();
  try {
    await requirePerm(op.root);
    op.say(`Building the graph for ${id}\u2026`, 'busy');
    const g = await callGraphWithContext(op);
    if (!g.counts.nodes) throw new Error(emptyReason('functions') || 'No functions pulled yet - press Pull all.');
    if (!g.nodes[id]) throw new Error(`${id} is not in the graph.`);
    const gg = Object.assign({}, g, { focus: id, depth: Math.max(1, depth || 2) });
    if (!(await publishGraph(gg, op, ws))) return;
    const n = g.nodes[id];
    setStatus(`Graph of ${id} (depth ${gg.depth}): calls ${n.calls.length}, called by ${n.called_by.length}.`, 'ok');
  } catch (e) { if ((e && e.message) !== WS_MOVED) setStatus(MSG.graphErr + e.message, 'bad'); }
}
async function openSchemaFocus(apiName, depth) {
  const op = beginWorkspaceOp(), ws = graphIdentity();
  try {
    await requirePerm(op.root);
    op.say(`Building relations graph for ${apiName}\u2026`, 'busy');
    const g = await buildSchemaGraph(undefined, undefined, op);   // full graph; the ER window filters by focus + depth client-side (adjustable there)
    if (!g.counts.nodes) throw new Error(emptyReason('modules') || 'No modules pulled yet - pull in Modules mode.');
    if (!g.nodes[apiName]) throw new Error(`Module ${apiName} not found in the schema.`);
    if (g.nodes[apiName].unreadable) throw new Error(`Zoho would not describe ${apiName}, so it has no fields and no relations to draw.`);
    g.focus = apiName; g.depth = Math.max(1, depth || 2);
    if (!(await publishGraph(g, op, ws))) return;
    setStatus(`Relations of ${apiName} (depth ${g.depth}): ${g.counts.nodes} modules, ${g.counts.edges} lookups.`, 'ok');
  } catch (e) { if ((e && e.message) !== WS_MOVED) setStatus('Relations graph error: ' + e.message, 'bad'); }
}
async function openSchemaGraph() {
  const op = beginWorkspaceOp(), ws = graphIdentity();
  try {
    await requirePerm(op.root);
    op.say('Building schema graph…', 'busy'); await refreshContext();
    const g = await buildSchemaGraph(undefined, undefined, op);
    if (!g.counts.nodes) throw new Error((emptyReason('modules') || 'No modules pulled yet - click Pull in Modules mode.'));
    if (!(await publishGraph(g, op, ws))) return;
    setStatus(`Schema: ${g.counts.nodes} modules, ${g.counts.edges} lookups.`, 'ok');
  } catch (e) { if ((e && e.message) !== WS_MOVED) setStatus('Schema graph error: ' + e.message, 'bad'); }
}
