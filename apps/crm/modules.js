/*
 * modules.js - the Modules tab, whole: the pull with its layout files and its pruning, the tree, the
 * detail with its field table and layout matrix, the per-module resync, and the schema-graph bridge.
 * Fifth slice, same contract as ai.js / export.js / health.js: declarations only, loaded before
 * sidepanel.js, proven by executing the file in an empty scope.
 */

// ---------- modules: pull ----------
async function pullModules() {
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
    let mw = 0, lw = 0; const wFail = [], rFail = [];
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
      try {
        await op.write(`modules/${sanitize(m.api_name || 'unknown')}.json`, JSON.stringify(m, null, 2)); mw++;
        index.push({ api_name: m.api_name, module_name: m.module_name, generated_type: m.generated_type, fields: (m.fields || []).length, layouts: m.layouts.length, related_lists: (m.related_lists || []).length });
        layIndex.push({ module: m.api_name, generated: m.module_name, layouts: m.layouts });
      } catch (e) { if ((e && e.message) === WS_MOVED) return; wFail.push(m.api_name); }
    }
    if (!op.current()) return;   // you changed workspace while this was reading
    await op.write('modules/index.json', JSON.stringify(index, null, 2));
    await op.write('modules/layouts/index.json', JSON.stringify(layIndex, null, 2));
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
      + (rFail.length ? ` ${rFail.length} stale file(s) could not be removed - the next pull retries.` : '');
    setStatus(`Modules pull complete: ${mw}/${r.modules.length} modules, ${lw} layout sets${prunedM ? `, ${prunedM} removed` : ''}${prunedL ? `, ${prunedL} layout set(s) removed` : ''}.${gap}`, gap ? 'warn' : 'ok');
    await noteAccess('modules', gap ? { status: 0, message: gap.trim() } : null, op);
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
      rows.push({ path: p, api_name: m.api_name, gen: m.module_name || m.api_name, label: m.plural_label || m.singular_label || m.module_name || m.api_name, custom: m.generated_type === 'custom', generated_type: m.generated_type || '', fieldCount: (m.fields || []).length, lookupCount: (m.fields || []).filter((f) => f.lookup).length, layoutCount: (m.layouts || []).length, layouts: (m.layouts || []), viewable: (m.viewable !== false && m.visible !== false), navigable: moduleNavigable(m), unreadable: m.unreadable || null });
    } catch (_) {}
  }
  if (!current()) return;
  moduleData = rows;          // published once, whole - never a list two loads are both writing into
  renderModules();
  setStatus(moduleData.length ? `${moduleData.length} modules in workspace.` : (emptyReason() || 'No modules yet - click Pull.'), moduleData.length ? 'ok' : 'warn');
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
  if (!groups.Standard.length && !groups.Custom.length) { tree.innerHTML = '<div class="empty">' + (moduleData.length ? '<b>No modules match.</b>' : (emptyReason() || '<b>No modules yet.</b> Press <b>Pull</b> to read them.')) + '</div>'; return; }
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
async function resyncModule(m) {
  return runPullAction(async () => {
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
  });
}
/** The values of a picklist, on request and downwards. Laid out on one line - eight of them, then
 *  «…(+31)» - a module with long options made the fields table scroll sideways with no end, and a
 *  horizontal scrollbar in a 400px panel hides the columns somebody came for. The count is the
 *  summary, because a number is a fact and «many» is not, and the list opens under it one value per
 *  line. Reported. */
function pickCell(values) {
  const v = values || []; if (!v.length) return '';
  return `<button class="plbtn" data-n="${escA(String(v.length))}" aria-expanded="false" title="Show the values">\u25b8 ${v.length} value${v.length === 1 ? '' : 's'}</button>`;
}
/** The values, in a row of their own that spans the table.
 *
 *  They were put inside the picklist cell first, and that was the wrong place twice over: it is the
 *  last of six columns in a 400px pane, so «WhatsApp/SMS» came out broken across two lines at about
 *  ninety pixels wide, with a scrollbar inside a scrollbar and no line between one value and the
 *  next. Reported, with a picture, and the report was that it had become worse than the sideways
 *  scroll it replaced - which it had. A cell cannot be widened; a row can, so the values get the
 *  whole width, and each one wears a border because a list of names needs a boundary, not a newline. */
function pickRow(values, cols) {
  const v = values || []; if (!v.length) return '';
  return `<tr class="plrow" hidden><td colspan="${escA(String(cols))}"><div class="plvals">`
    + v.map((x) => `<span class="plv">${escHtml(x)}</span>`).join('')
    + '</div></td></tr>';
}
/** Every report cuts a long picklist, and none of them said so: twelve values printed and the rest
 *  gone, which makes the report quietly wrong rather than merely shorter. It states what it dropped
 *  now, the way the panel always did. */
function _pick(values, cap, esc) {
  const v = values || []; if (!v.length) return '';
  return esc(v.slice(0, cap).join(', ')) + (v.length > cap ? ` \u2026(+${v.length - cap} more)` : '');
}
function renderFieldsTable(m) {
  const rows = (m.fields || []).map((f) => `<tr>
    <td>${escHtml(f.label || f.api_name)}${f.custom ? ' <span style="color:#a78bfa">*</span>' : ''}</td>
    <td class="mono">${escHtml(f.api_name)}</td>
    <td>${escHtml(f.data_type || '')}${f.length ? ` (${f.length})` : ''} ${pickCell(f.picklist)}</td>
    <td style="text-align:center">${f.mandatory ? '\u25cf' : ''}</td>
    <td class="mono">${f.lookup ? '\u2192 ' + escHtml(typeof f.lookup === 'string' ? f.lookup : (f.lookup.api_name || (f.lookup.module && (f.lookup.module.api_name || f.lookup.module)) || '')) : ''}</td>
  </tr>${pickRow(f.picklist, 5)}`).join('');
  if (!rows) {
    // The refusal is stated once, in the banner directly above this. Repeating it here and again
    // under Related lists put the same sixty words on screen three times.
    return `<div class="empty" style="padding:12px 10px">${m.unreadable ? '<b>No fields were read.</b>'
      : (emptyReason() || '<b>No fields recorded.</b> Press <b>Pull</b> above to read them from Zoho.')}</div>`;
  }
  // Five columns, not six. The values used to have one of their own, which is what made the table
  // scroll sideways - and once they moved to a row of their own the column left behind held only the
  // button that opens it, in the last position, off screen at 400px. It sits in Type, where the word
  // «picklist» already is and where the reader is already looking.
  return `<table class="ftbl"><thead><tr><th>Field</th><th>API name</th><th>Type</th><th>Req</th><th>Lookup</th></tr></thead><tbody>${rows}</tbody></table>`;
}
// Selecting a different item must start the reader at the top of the new content;
// keeping the previous scroll offset lands you in the middle of an unrelated document.
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
  currentPath = path; navHere(); if ($('status').className) setStatus('', '');
  selectRow(path);
  let m; try { m = JSON.parse(await op.read(path)); } catch (e) { if (previewCurrent(mine, op)) setStatus(MSG.readFailed + e.message, 'bad'); return; }
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
  const namesBlock = `<div style="padding:8px 10px;font:11px var(--mono);border-bottom:1px solid var(--border);background:#141b29;line-height:1.7">`
    + `<div style="color:#8ea0bb">display: <span style="color:#e7edf6">${escHtml(m.plural_label || m.singular_label || m.module_name || m.api_name)}</span></div>`
    + `<div style="color:#8ea0bb">api_name: <span style="color:#82d2ff">${escHtml(m.api_name)}</span></div>`
    + `<div style="color:#8ea0bb">generated: <span style="color:#a78bfa">${escHtml(gen)}</span>${nav ? '' : ' <span style=\"color:#fbbf24\">(no records tab)</span>'}</div>`
    + `<div style="color:#8ea0bb">layouts: <span style="color:#e7edf6">${(m.layouts || []).length || (m.layouts_read === false ? 'not read' : 0)}</span>${(m.layouts || []).length ? ' <span style=\"color:#8ea0bb\">(' + (m.layouts || []).map((l) => escHtml(l.name)).join(', ') + ')</span>' : ''}</div>`
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
        + `<td class="mono">${escHtml(r.module || r.connected_module || '')}${r.linking_module ? ` <span style="color:var(--muted)">via ${escHtml(r.linking_module)}</span>` : ''}</td>`
        + `<td>${escHtml(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td></tr>`).join('')
      + `</tbody></table>`
    : `<div class="secttl">Related lists</div><div style="padding:8px 10px;color:var(--muted)">${
        refusal ? 'Not read either - Zoho would not describe this module.'
        : m.related_read === false ? 'Neither endpoint would answer for this module, so whether it has any is unknown - not that it has none.'
        : 'None recorded - re-run <b>Pull Modules</b> to fetch them.'}</div>`;
  const refBanner = refusal
    ? `<div class="box warn" style="margin:8px 10px;padding:8px 10px;font:11px var(--sans);line-height:1.5;color:#f7c66b;background:rgba(217,119,6,.12);border:1px solid #8a6321;border-radius:6px">${escHtml(refusal.text)}</div>`
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
  $('pvcallershome').after($('pvcallers'));
  $('pvtable').innerHTML = `<div id="pvfields">${selector}<div id="laybody">${renderFieldsTable(m)}</div></div>`
    + `<div id="pvrels">${rlBlock}</div>`
    + `<div id="pvdetails">${refBanner}${namesBlock}</div>`;
  pvTabsFor('module');                 // clears the slot, so the bar goes in after it, never before
  // The names first, then what reads and writes it. It was the other way round - «read by» and
  // «written by» at the top and the module's own display name, api_name and generated name below the
  // fold - which is backwards: what the thing *is* comes before what uses it. Reported with a
  // picture. Moving the element rather than re-rendering it keeps `showModuleUsage()` writing into
  // the one box it has always written into, and it arrives asynchronously into whatever is on screen.
  $('pvdetails').appendChild($('pvcallers'));
  $('pvtabsr').innerHTML = relBar;
  $('pvtable').querySelectorAll('.rlcopy').forEach((c) => (c.onclick = () => {
    navigator.clipboard.writeText(c.dataset.c).then(() => setStatus(`Copied \u00ab${c.dataset.c}\u00bb`, 'ok')).catch(() => {});
  }));
  const relOpen = $('pvtabsr').querySelector('#relopen');
  if (relOpen) relOpen.onclick = () => openSchemaFocus(m.api_name, parseInt(document.getElementById('reldepth').value, 10) || 2);
  const sel = document.getElementById('laysel');
  if (sel) sel.onchange = async () => {
    const body = document.getElementById('laybody'); const v = sel.value;
    if (v === '__all__') { body.innerHTML = renderFieldsTable(m); return; }
    body.innerHTML = '<div style="padding:10px;color:var(--muted)">Loading layout\u2026</div>';
    let full = []; try { full = JSON.parse(await op.read(`modules/layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) {}
    if (!previewCurrent(mine, op)) return;
    const L = (full || []).find((x) => String(x.id) === String(v));
    body.innerHTML = L ? renderLayoutView(L) : '<div style="padding:10px;color:var(--muted)">Layout detail not found - re-pull modules.</div>';
  };
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
    if (!g.counts.nodes) throw new Error('No functions pulled yet - press Pull all.');
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
    if (!g.counts.nodes) throw new Error('No modules pulled yet - pull in Modules mode.');
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
    if (!g.counts.nodes) throw new Error((emptyReason() || 'No modules pulled yet - click Pull in Modules mode.'));
    if (!(await publishGraph(g, op, ws))) return;
    setStatus(`Schema: ${g.counts.nodes} modules, ${g.counts.edges} lookups.`, 'ok');
  } catch (e) { if ((e && e.message) !== WS_MOVED) setStatus('Schema graph error: ' + e.message, 'bad'); }
}
