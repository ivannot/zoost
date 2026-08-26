/*
 * export.js - the two self-contained reports, whole: the shared CSS, every section builder, and the
 * writers for HTML and Markdown. The second slice of splitting sidepanel.js, cut on the same rule as
 * ai.js: a block the rest of the panel reaches through two names (exportHtml, exportMarkdown) and
 * that reaches the rest through the loaders and beginWorkspaceOp.
 *
 * A classic script loaded BEFORE sidepanel.js, declarations only - same contract as ai.js, proven
 * the same way, by executing the file in an empty scope.
 */

// ---------- export a self-contained, shareable HTML report ----------
// The stylesheet, the header, the card, the empty state and the foot live in `reportshell.js`,
// byte-identical in both products, because two reports from one maker that are shaped
// differently are two products to whoever receives them. What stays here is this report's own
// chapters. See that file for what the measurement was.
const EXPORT_CSS = REPORT_CSS + ':root{--accent:#2563eb}';
// The per-area dates, for the reports. A report that says "generated today" while a third of it is
// four months old is the misleading half-truth this whole thread is about - so every report states
// when each part was last read, whether or not anything is behind. The reader gets the fact; nobody
// here decides for them what it means.
function freshnessLine() {
  const parts = TABS.map((t) => {
    const behind = areaStale(t.id) ? ' (behind)' : '';
    return `${tabLabel(t.id)} ${areaAsOf(t.id)}${behind}`;
  });
  return parts.join(' \u00b7 ');
}

// **The audit, computed once for both reports.** It used to live inside `buildExportHtml`, so the
// Markdown export - the one written for an assistant, where a missing chapter is invisible - simply
// had no Health at all. Recomputing it beside the second builder would be the same list twice, and
// the twin that drifts is always the one nobody opens. `hSec` and its Markdown counterpart render
// this; neither decides what is in it.
// The criteria and timing of a workflow, as text. Module-level because both reports print them and
// a second copy of a formatter is a second answer to «what does this rule actually say».
// What each section of the audit means, said once. Both reports print these, and the day they were
// two copies is the day one of them starts describing a different audit from the one it lists.
const HD_ORPHAN = 'No caller in code, not REST, no associated_place.';
const HD_UNRESOLVED = 'Calls a function that does not resolve in this workspace.';
const HD_AMBIGUOUS = 'A call matches more than one function.';
const HD_BROKEN = 'A workflow/schedule references a function not in this workspace.';
const HD_MISSING_FK = 'A lookup points to a module not in this workspace.';
const HD_CHATTIEST = 'invokeurl, zoho.crm and other Zoho service tasks, counted outside comments and strings.';
const wfValOf = (g) => { const v = g.value; if (g.type === 'field' && v && v.api_name) return v.api_name; if (v === '${EMPTY}' || v === '${empty}') return 'empty'; return v == null ? '' : String(v); };
const wfOne = (g) => `${(g.field && g.field.api_name) || '?'} ${g.comparator || ''} ${wfValOf(g)}`;
const wfCrit = (crit) => { if (!crit) return ''; if (crit.group && crit.group.length) { const op = crit.group_operator || 'AND'; return crit.group.map((g) => (g.group ? '(' + wfCrit(g) + ')' : wfOne(g))).join(` ${op} `); } if (crit.comparator) return wfOne(crit); return ''; };
const wfTiming = (bk) => { const ea = bk.execute_after; return (ea && ea.unit != null) ? `after ${ea.unit} ${ea.period || ''}`.trim() : ''; };
function healthFacts(g, mods, wfs, scheds) {
  const nodes = Object.values((g && g.nodes) || {});
  const byId = {}, byAny = {};
  nodes.forEach((n) => { if (n.id) byId[String(n.id)] = n; [n.name, n.api_name, n.display_name].forEach((k) => { if (k) byAny[String(k).toLowerCase()] = n; }); });
  const orphans = nodes.filter((n) => n.dead_suspect).sort((a, b) => (a.display_name || a.name || '').localeCompare(b.display_name || b.name || ''));
  const unresolved = nodes.filter((n) => n.unresolved && n.unresolved.length);
  const ambiguous = nodes.filter((n) => n.ambiguous && n.ambiguous.length);
  // Informational rankings, deliberately kept out of the issue total: they are not defects.
  const stat = nodes.filter((n) => n.stats && n.stats.lines);
  const biggest = stat.slice().sort((a, b) => b.stats.lines - a.stats.lines).slice(0, 15);
  const chattiest = stat.filter((n) => n.stats.apiCalls > 0).sort((a, b) => b.stats.apiCalls - a.stats.apiCalls).slice(0, 15);
  const broken = [];
  wfs.forEach((w) => { if (!w.detail) return; (w.detail.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter(isFnAction).forEach((a) => { if (!(byId[String(a.id)] || byAny[(a.name || '').toLowerCase()])) broken.push({ kind: 'workflow', id: w.id, name: w.name, fn: a.name }); }); }); });
  scheds.forEach((sc) => { if (!(byId[String(sc.function_id)] || byAny[(sc.function_name || '').toLowerCase()])) broken.push({ kind: 'schedule', id: sc.id, name: sc.name, fn: sc.function_name }); });
  const modSet = new Set(mods.map((m) => m.api_name));
  const missingFk = [];
  mods.forEach((m) => { if (/__s$/.test(m.api_name || '')) return; (m.fields || []).forEach((fl) => { let t = fl.lookup; if (t && typeof t === 'object') t = t.api_name || (t.module && (t.module.api_name || t.module)) || null; if (!t || typeof t !== 'string') return; if (/__s$/.test(t)) return; if (!modSet.has(t)) missingFk.push({ module: m.api_name, field: fl.api_name || fl.label, target: t }); }); });
  return { nodes, stat, orphans, unresolved, ambiguous, broken, missingFk, biggest, chattiest,
           total: orphans.length + unresolved.length + ambiguous.length + broken.length + missingFk.length };
}

function buildExportHtml(fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers, scope) {
  scope = Object.assign({}, SCOPE_DEFAULT, scope || {});
  if (!scope.functions) fns = [];
  if (!scope.modules) mods = [];
  wfs = scope.workflows ? (wfs || []) : []; scheds = scope.schedules ? (scheds || []) : [];
  conns = scope.connections ? (conns || []) : [];
  acts = scope.actions ? (acts || []) : [];
  fails = scope.failures ? (fails || { failures: [] }) : { at: null, usage: null, failures: [] };
  const esc = escHtml;
  const ws = bound || {};
  const now = new Date().toLocaleString();

  // function cross-references (uses / used by), navigable via anchors
  // **A function is `namespace.api_name`, and this file had it as `api_name`.** Two functions in
  // different namespaces sharing a name - 9 of 120 in the sample - collapsed onto one anchor and one
  // graph node, so both sections printed the last node's callers and callees: one reported as
  // calling nothing while it calls two, the other as having a caller it does not have, under the
  // same heading and beside different source code. The whole chapter a reader uses to decide what is
  // safe to delete. The Markdown twin has keyed on the pair since it was written - `### automation.notifyOwner`.
  const fnKey = (f) => (f ? (f.namespace || '') + '.' + (f.api_name || f.name || '') : '');
  const fnAnchor = (key) => 'fn-' + sanitize(key || '');
  const nodeByKey = {}; if (g && g.nodes) Object.values(g.nodes).forEach((n) => { nodeByKey[fnKey(n)] = n; });
  const keyOf = (id) => (g && g.nodes[id] ? fnKey(g.nodes[id]) : null);
  const connAnchor = (name) => 'conn-' + sanitize(name || '');
  const connApiSet = new Set((conns || []).map((c) => c.name));
  const _hByName = {}; Object.values(g.nodes || {}).forEach((n) => (_hByName[n.name] ||= []).push(n));
  const codeResolve = (ns, name) => {
    const nodes = g.nodes || {};
    const t = nodes[ns + '.' + name] || ((_hByName[name] || []).length === 1 ? _hByName[name][0] : null);
    return t ? { href: '#' + fnAnchor(fnKey(t)), label: t.display_name || t.name } : null;
  };
  const hl = (c) => (window.highlightDeluge ? window.highlightDeluge(c, codeResolve) : esc(c));
  const fnKeySet = new Set(fns.map(fnKey));
  // The label stays the api_name - it is what the reader recognises - while the link carries the pair.
  const fnLink = (key) => { const lab = (nodeByKey[key] && nodeByKey[key].api_name) || String(key || '').split('.').slice(1).join('.') || key;
    return (key && fnKeySet.has(key)) ? `<a href="#${fnAnchor(key)}">${esc(lab)}</a>` : esc(lab || '?'); };


  // What goes where the source would be. `code === null` is «there was nothing to read»; `''` is a
  // file that is there and is empty, which is a fact about the function and not a failure.
  //
  // **Declared above its first use, and that is the whole of it.** It was written 76 lines *below*
  // the function section that calls it, and a `const` is in its temporal dead zone until the line
  // that declares it runs - so every HTML export with source ticked died on «Cannot access
  // 'srcBlock' before initialization», which is the default scope. A function *declaration* is
  // hoisted and would not have done this; an arrow assigned to a const is not, and looks identical.
  const srcBlock = (f) => (
    !f.downloaded ? '<p class="note">Source not downloaded - run Pull all, or \u21bb Refresh, to fetch it.</p>'
      : f.code === null || f.code === undefined
        ? '<p class="note">Source could not be read from the workspace folder. The function exists; this copy of it does not.</p>'
        : `<pre class="code">${hl(f.code)}</pre>`);

  // workflow <-> function wiring
  const fnById = {}, fnByName = {};
  fns.forEach((f) => { fnById[f.id] = f; if (f.name) fnByName[f.name.toLowerCase()] = f; if (f.display_name) fnByName[f.display_name.toLowerCase()] = f; });
  const wfFnActions = (w) => { const acts = []; ((w.detail && w.detail.conditions) || []).forEach((c) => ['instant_actions', 'scheduled_actions'].forEach((bk) => { const b = c[bk]; if (b && b.actions) b.actions.forEach((a) => { if (isFnAction(a)) acts.push(a); }); })); return acts; };
  const resolveFn = (a) => fnById[String(a.id)] || fnByName[(a.name || '').toLowerCase()];
  const triggeredBy = {};
  wfs.forEach((w) => wfFnActions(w).forEach((a) => { const fn = resolveFn(a); if (fn) (triggeredBy[fnKey(fn)] ||= []).push({ id: w.id, name: w.name }); }));
  const wfAnchor = (id) => 'wf-' + sanitize(String(id));
  const schAnchor = (id) => 'sch-' + sanitize(String(id));
  const scheduledBy = {};
  scheds.forEach((sc) => { const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()]; if (fn) (scheduledBy[fnKey(fn)] ||= []).push(sc); });
  const assocText = (f) => {
    const ap = f.associated_place || [];
    if (!ap.length) return '';
    const byType = {};
    ap.forEach((p) => { const t = p._type || 'other'; if (t === 'workflow' || t === 'schedule') return; (byType[t] ||= []).push(p.name || '(unnamed)'); });
    const keys = Object.keys(byType).sort();
    return keys.map((t) => `<span><b>Used in ${esc(t)} (${byType[t].length}):</b> ${byType[t].map(esc).join(', ')}</span>`).join('');
  };

  const byNs = {}; fns.forEach((f) => (byNs[f.namespace || 'misc'] ||= []).push(f));
  let fnHtml = '';
  Object.keys(byNs).sort().forEach((ns) => {
    fnHtml += `<h3 class="grp">${esc(ns)} <span class="cnt">${byNs[ns].length}</span></h3>`;
    byNs[ns].sort(byField('api_name')).forEach((f) => {
      const node = nodeByKey[fnKey(f)];
      const uses = node ? node.calls.map(keyOf).filter(Boolean) : [];
      const usedBy = node ? node.called_by.map(keyOf).filter(Boolean) : [];
      const trig = triggeredBy[fnKey(f)] || [];
      const refs = f.downloaded ? `<div class="refs">`
        + `<span><b>Uses (${uses.length}):</b> ${uses.length ? uses.map(fnLink).join(', ') : '<span class=\'none\'>none</span>'}</span>`
        + `<span><b>Used by (${usedBy.length}):</b> ${usedBy.length ? usedBy.map(fnLink).join(', ') : '<span class=\'none\'>none (entry point or unused)</span>'}</span>`
        + (trig.length ? `<span><b>Triggered by (${trig.length}):</b> ${trig.map((w) => `<a href="#${wfAnchor(w.id)}">${esc(w.name)}</a>`).join(', ')}</span>` : '')
        + ((scheduledBy[fnKey(f)] || []).length ? `<span><b>Scheduled by (${scheduledBy[fnKey(f)].length}):</b> ${scheduledBy[fnKey(f)].map((sc) => `<a href="#${schAnchor(sc.id)}">${esc(sc.name)}</a>`).join(', ')}</span>` : '')
        + assocText(f)
        + ((f.modulesR || []).length ? `<span><b>Reads (${f.modulesR.length}):</b> ${f.modulesR.map(esc).join(', ')}</span>` : '')
        + ((f.modulesW || []).length ? `<span><b>Writes (${f.modulesW.length}):</b> ${f.modulesW.map(esc).join(', ')}</span>` : '')
        + ((f.modulesT || []).length ? `<span><b>Reached by URL (${f.modulesT.length}):</b> ${f.modulesT.map(esc).join(', ')}</span>` : '')
        + (f.modulesUnknown ? `<span><b>Module not determinable:</b> ${f.modulesUnknown} call(s)</span>` : '')
        + ((scope.connections && (f.connections || []).length) ? `<span><b>Connections (${f.connections.length}):</b> ${f.connections.map((c) => (c.name && connApiSet.has(c.name)) ? `<a href="#${connAnchor(c.name)}">${esc(c.name)}</a>` : esc(c.name)).join(', ')}</span>` : '')
        + (f.stats ? `<span><b>Size:</b> ${f.stats.lines} lines (${f.stats.codeLines} code) · ${(f.stats.chars / 1024).toFixed(1)} KB · <b>outbound calls:</b> ${f.stats.apiCalls || 'none'}${f.stats.apiCalls ? ` (${f.stats.invokeurl} invokeurl, ${f.stats.crm} zoho.crm, ${f.stats.zoho} other${f.stats.sendmail ? ', ' + f.stats.sendmail + ' sendmail' : ''})` : ''}</span>` : '')
        + ((f.modified_by || f.updatedTime) ? `<span><b>Modified:</b> ${f.modified_by ? 'by ' + esc(f.modified_by) : ''}${f.updatedTime ? ' · ' + esc(String(f.updatedTime).slice(0, 16)) : ''}</span>` : '')
        + `</div>` : '';
      fnHtml += `<section class="item" id="${escA(fnAnchor(fnKey(f)))}" data-name="${escA(((f.api_name || '') + ' ' + (f.display_name || '')).toLowerCase())}">`
        + `<div class="ih"><b>${esc(f.display_name || f.api_name)}</b> <code>${esc(f.api_name)}</code>`
        + `${f.rest ? '<span class="badge rest">REST</span>' : ''}${f.downloaded ? '' : '<span class="badge no">not downloaded</span>'}</div>`
        // Three states, not two. «Not downloaded» has a badge in the header; «downloaded and the
        // file could not be read» had nothing at all - the section simply ended, and a reader
        // without the extension saw a function that looks like every other one and happens to show
        // no source. The Markdown twin says the first and emits an **empty fence** for the second,
        // which its own comment forbids in those words. Neither covered the case that is a failure.
        + `${refs}${scope.code ? srcBlock(f) : ''}</section>`;
    });
  });

  // module cross-references (FK links + referenced-by), navigable via anchors
  const modAnchor = (api) => 'mod-' + sanitize(api || '');
  const modApiSet = new Set(mods.map((m) => m.api_name));
  const modLink = (api) => (api && modApiSet.has(api)) ? `<a href="#${modAnchor(api)}">${esc(api)}</a>` : esc(api || '');
  const relsHtmlFor = (m) => {
    const rl = scope.relations ? (m.related_lists || []) : [];
    if (!rl.length) return (scope.relations && m.related_read === false)
      ? `<p class="note">Related lists: neither endpoint would answer for this module when it was pulled, so whether it has any is unknown.</p>` : '';
    return `<div style="font-weight:700;margin:12px 0 4px;color:#d97706">Related lists (${rl.length}) <span class="none" style="font-weight:400">- API name for zoho.crm.getRelatedRecords()</span></div>`
      + `<table class="ftbl"><thead><tr><th>Relation API</th><th>Label</th><th>Returns</th><th>Type</th></tr></thead><tbody>`
      + rl.map((r) => `<tr><td class="mono"><b>${esc(r.api_name)}</b></td><td>${esc(r.label || '')}</td><td class="mono">${r.module ? modLink(r.module) : esc(r.connected_module || '')}${r.linking_module ? ` <span class="none">via ${esc(r.linking_module)}</span>` : ''}</td><td>${esc(r.type || '')}${r.visible === false ? ' \u00b7 hidden' : ''}</td></tr>`).join('')
      + `</tbody></table>`;
  };
  const groups = { Standard: [], Custom: [] }; mods.forEach((m) => (m.generated_type === 'custom' ? groups.Custom : groups.Standard).push(m));
  let modHtml = '';
  for (const g2 of ['Standard', 'Custom']) {
    const list = groups[g2]; if (!list.length) continue;
    modHtml += `<h3 class="grp">${g2} <span class="cnt">${list.length}</span></h3>`;
    list.sort(byField('api_name')).forEach((m) => {
      const rows = (m.fields || []).map((fl) => `<tr><td>${esc(fl.label || fl.api_name)}</td><td class="mono">${esc(fl.api_name)}</td><td>${esc(fl.data_type || '')}${fl.length ? ` (${fl.length})` : ''}</td><td style="text-align:center">${fl.mandatory ? '●' : ''}</td><td class="mono">${fl.lookup ? '→ ' + modLink(fl.lookup) : ''}</td><td>${_pick(fl.picklist, 12, esc)}</td></tr>`).join('');
      const inbound = (modRefs && modRefs[m.api_name]) || [];
      const refBy = inbound.length ? `<div class="refs"><span><b>Referenced by (${inbound.length}):</b> ${inbound.map((r) => `${modLink(r.module)} <span class="none">(${esc(r.field)})</span>`).join(', ')}</span></div>` : '';
      const laySrc = !scope.layouts ? [] : ((m._layouts && m._layouts.length) ? m._layouts : (m.layouts || []));
      const layoutsHtml = laySrc.length ? `<div style="font-weight:700;margin:12px 0 4px;color:#7c5cff">Layouts (${laySrc.length})</div>` + laySrc.map((L) => {
        const secArr = Array.isArray(L.sections) ? L.sections : [];
        const secs = secArr.map((sec) => {
          const frows = (sec.fields || []).map((fl) => `<tr><td>${esc(fl.field_label || fl.display_label || fl.api_name)}</td><td class="mono">${esc(fl.api_name || '')}</td><td>${esc(fl.data_type || '')}</td><td style="text-align:center">${fl.required ? '●' : ''}</td></tr>`).join('');
          return `<div style="font-weight:600;margin:8px 0 3px;font-size:12px">${esc(sec.display_label || sec.name || 'Section')} <span class="none">(${(sec.fields || []).length})</span></div><table class="ftbl"><thead><tr><th>Field</th><th>API</th><th>Type</th><th>Req</th></tr></thead><tbody>${frows}</tbody></table>`;
        }).join('');
        const secCount = secArr.length || (typeof L.sections === 'number' ? L.sections : 0);
        return `<details open style="margin-top:6px"><summary style="cursor:pointer"><b>${esc(L.name || String(L.id))}</b>${L.visible === false ? ' <span class=\"none\">(hidden)</span>' : ''} <span class=\"none\">\u00b7 ${secCount} sections</span></summary>${secs || '<div class=\"none\" style=\"padding:4px 0\">Section detail not in this export - re-pull modules for full layout fields.</div>'}</details>`;
      }).join('') : '';
      // A section with three empty tables and no reason reads as a module with nothing in it. The
      // reader of an export cannot ask the panel, which is the whole point of the export.
      const mref = moduleRefusal(m.unreadable);
      modHtml += `<section class="item" id="${escA(modAnchor(m.api_name))}" data-name="${escA(((m.api_name || '') + ' ' + (m.plural_label || m.module_name || '')).toLowerCase())}">`
        + `<div class="ih"><b>${esc(m.plural_label || m.singular_label || m.module_name || m.api_name)}</b> <code>${esc(m.api_name)}</code> <span class="gen">${esc(m.module_name || '')}</span>${laySrc.length ? ` <span class="none">\u00b7 ${laySrc.length} layout(s)</span>` : ''}</div>`
        + (mref ? `<div class="refs"><span><b>Not described by Zoho.</b> ${esc(mref.text)}</span></div>` : '')
        + `${refBy}<table class="ftbl"><thead><tr><th>Field</th><th>API</th><th>Type</th><th>Req</th><th>Lookup</th><th>Picklist</th></tr></thead><tbody>${rows}</tbody></table>${relsHtmlFor(m)}${layoutsHtml}</section>`;
    });
  }

  // Relations: a relation-first catalogue. The ER puts modules first; here the related-list
  // API name is the subject, because that is the string Deluge actually needs.
  const SYS_REL_X = /^(Notes|Attachments|Emails|Tasks|Calls|Events|Tasks_History|Calls_History|Events_History|CheckLists|Activities.*|Zoho_Support|Social|Campaigns_Sent|Invited_Events|Cadences|Timeline|Approvals?)$/i;
  const allRels = [];
  (scope.relations ? mods : []).forEach((m) => (m.related_lists || []).forEach((r) => {
    const child = r.module || r.connected_module || null;
    let via = r.linking_module ? `linking: ${r.linking_module}` : '';
    if (!via && child) {
      const cm = mods.find((x) => x.api_name === child);
      if (cm) { const ff = (cm.fields || []).filter((x) => x.lookup === m.api_name).map((x) => x.api_name); if (ff.length) via = ff.join(' / '); }
    }
    allRels.push({ api: r.api_name, label: r.label || '', parent: m.api_name, child, via, type: r.type || 'default', visible: r.visible !== false, sys: SYS_REL_X.test(r.api_name) || !child });
  }));
  allRels.sort((a, b) => (a.sys - b.sys) || a.parent.localeCompare(b.parent) || a.api.localeCompare(b.api));
  // «There are none» and «you did not ask for them» are different facts, and this said the first
  // about both. With Functions unticked in the export dialog the report printed «Functions / No
  // functions.» - a positive claim about somebody's org, in a document written to be read by
  // people who do not have the extension and cannot go and check. The Markdown twin omits the
  // heading entirely when the list is empty and so never says it; two halves of one rule, one on
  // each side, which is the shape this repository keeps meeting.
  //
  // The heading stays rather than disappearing: a reader wondering why a section is missing is
  // better served by being told it was left out than by finding nothing at all, and the export
  // states what it does not contain next to what it does.
  const absent = (asked, what) => (asked
    ? `<p class="empty">No ${what}.</p>`
    : `<p class="empty">Not included in this export - ${what} were unticked when it was made.</p>`);


  const relRowHtml = (r) => `<tr class="relrow${r.sys ? ' sys' : ''}" data-name="${escA(((r.api || '') + ' ' + (r.label || '') + ' ' + (r.parent || '') + ' ' + (r.child || '')).toLowerCase())}">`
    + `<td class="mono"><b>${esc(r.api)}</b></td><td>${esc(r.label)}</td>`
    + `<td class="mono">${modLink(r.parent)}</td><td class="mono">${r.child ? modLink(r.child) : ''}</td>`
    + `<td class="mono">${esc(r.via || '')}</td><td class="ct">${esc(r.type)}${r.visible ? '' : ' \u00b7 hidden'}</td>`
    + `<td class="mono">zoho.crm.getRelatedRecords("${esc(r.api)}", "${esc(r.parent)}", recordId)</td></tr>`;
  const relHtml = allRels.length
    ? `<p class="hxd">One row per relation. To read a related list in Deluge you need the <b>relation API name</b> - it is not the api_name of either module.</p>`
      + `<table class="ftbl"><thead><tr><th>Relation API name</th><th>Label</th><th>On module</th><th>Returns</th><th>Via</th><th>Type</th><th>Deluge</th></tr></thead><tbody>${allRels.map(relRowHtml).join('')}</tbody></table>`
    // **And unticked is not «none».** This sentence went out whatever the reader had chosen, so an
    // export made with Relations off told whoever received it that the org has no related lists -
    // 22 of them in the sample - and instructed them to re-run a pull that would change nothing. A
    // positive claim about somebody's org, in a document written for a reader who cannot check it.
    // Its two neighbours ask `absent()`; this one never learnt to.
    : absent(scope.relations, 'related lists');

  // workflows grouped by trigger module
  const wfByMod = {}; wfs.forEach((w) => (wfByMod[w.module || '(no module)'] ||= []).push(w));
  // rich workflow rendering (mirrors the panel detail)
  const wfActionHtml = (a) => { if (isFnAction(a)) { const fn = resolveFn(a); return fn ? `<a href="#${fnAnchor(fnKey(fn))}">\u0192 ${esc(fn.display_name || fn.api_name)}</a>` : `<span class="none">\u0192 ${esc(a.name)}</span>`; } return `<span class="wfact-x">${esc(a.type)}: ${esc(a.name)}</span>`; };
  let wfHtml = '';
  Object.keys(wfByMod).sort().forEach((mod) => {
    wfHtml += `<h3 class="grp">${esc(mod)} <span class="cnt">${wfByMod[mod].length}</span></h3>`;
    wfByMod[mod].slice().sort(byField('name')).forEach((w) => {
      const d = w.detail;
      const modl = mods.some((m) => m.api_name === w.module) ? `<a href="#${modAnchor(w.module)}">${esc(w.module)}</a>` : esc(w.module || '');
      const head = `<section class="item" id="${escA(wfAnchor(w.id))}" data-name="${escA(((w.name || '') + ' ' + (w.module || '')).toLowerCase())}">`
        + `<div class="ih"><b>${esc(w.name)}</b> <code>${esc(w.type || '')}</code> ${modl}${w.active ? '' : '<span class="badge no">inactive</span>'}</div>`;
      if (!d) { wfHtml += head + `<div class="refs"><span class="none">not downloaded</span></div></section>`; return; }
      const ew = d.execute_when || {}, det = ew.details || {};
      const trigParts = [esc(w.type || ew.type || '')];
      if (det.repeat != null) trigParts.push(`repeat: ${det.repeat ? 'yes' : 'no'}`);
      if (Array.isArray(det.fields) && det.fields.length) trigParts.push(`fields: ${det.fields.map((fl) => esc((fl.field && fl.field.api_name) || fl.api_name || String(fl))).join(', ')}`);
      const ewCrit = wfCrit(det.criteria || ew.criteria);
      let meta = `<div class="refs"><span><b>Trigger:</b> ${trigParts.join(' \u00b7 ')}</span>`;
      if (ewCrit) meta += `<span><b>When:</b> ${esc(ewCrit)}</span>`;
      if (d.description) meta += `<span><b>Description:</b> ${esc(d.description)}</span>`;
      meta += `</div>`;
      let condHtml = '';
      (d.conditions || []).forEach((c, i) => {
        const cd = c.criteria_details || {};
        const ct = wfCrit(cd.criteria);
        const rel = cd.relational_criteria;
        let actsHtml = '';
        const inst = (c.instant_actions && c.instant_actions.actions) || [];
        if (inst.length) actsHtml += `<div class="wfxact"><b>Instant:</b> ${inst.map(wfActionHtml).join(' ')}</div>`;
        const sched = Array.isArray(c.scheduled_actions) ? c.scheduled_actions : (c.scheduled_actions && c.scheduled_actions.actions ? [c.scheduled_actions] : []);
        sched.forEach((bk) => { const acts = bk.actions || []; const tim = wfTiming(bk); if (acts.length) actsHtml += `<div class="wfxact"><b>Scheduled${tim ? ` (${tim})` : ''}:</b> ${acts.map(wfActionHtml).join(' ')}</div>`; });
        condHtml += `<div class="wfxcond"><div class="wfxc">Condition ${c.sequence_number || i + 1}</div>`
          + (ct ? `<div class="wfxcrit">${esc(ct)}</div>` : '')
          + (rel && (rel.module || rel.criteria) ? `<div class="wfxcrit"><i>related:</i> ${esc((rel.module && rel.module.api_name) || rel.module || '')} ${esc(wfCrit(rel.criteria))}</div>` : '')
          + actsHtml + `</div>`;
      });
      wfHtml += head + meta + condHtml + `</section>`;
    });
  });
  Object.keys(wfByMod).sort().forEach((mod) => wfByMod[mod].slice().sort(byField('name')).forEach((w) => {
    const wsc = wfScheduled(w.detail);
  }));

  // schedules
  let schHtml = '';
  scheds.slice().sort(byField('name')).forEach((sc) => {
    const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()];
    const fl = fn ? `<a href="#${fnAnchor(fnKey(fn))}">${esc(fn.display_name || fn.api_name)}</a>` : `<span class="none">${esc(sc.function_name || '?')}</span>`;
    schHtml += `<section class="item" id="${escA(schAnchor(sc.id))}" data-name="${escA(((sc.name || '') + ' ' + (sc.function_name || '')).toLowerCase())}">`
      + `<div class="ih"><b>${esc(sc.name)}</b> <code>${esc(sc.frequency || '')}</code>${sc.status !== 'active' ? `<span class="badge no">${esc(sc.status || '')}</span>` : ''}</div>`
      + `<div class="refs"><span><b>Runs function:</b> ${fl}</span>${sc.next ? `<span><b>Next:</b> ${esc(sc.next)}</span>` : ''}</div></section>`;
  });

  // health / audit (same checks as the panel, rendered statically with links to #fn anchors)
  const H = healthFacts(g, mods, wfs, scheds);
  const hNodes = H.nodes, hStat = H.stat, hOrph = H.orphans, hUnres = H.unresolved,
        hAmbig = H.ambiguous, hBroken = H.broken, hFK = H.missingFk, hBig = H.biggest, hChatty = H.chattiest;
  // **A link only where the section exists.** The health lists are built from the graph, which is
  // not filtered by the export's scope - so with Functions unticked this named every function in
  // the audit and pointed each one at a chapter that was never written. Measured: one dead anchor
  // per health entry, in the report of an org whose functions the reader deliberately left out.
  // `fnLink` above already asks this question; this one did not, which is the whole defect.
  const hLink = (n) => (scope.functions && fnKeySet.has(fnKey(n))
    ? `<a href="#${fnAnchor(fnKey(n))}">${esc(n.display_name || n.name)}</a>`
    : esc(n.display_name || n.name));
  const hSec = (title, count, desc, rows, bad) => `<div class="hxsec"><h3>${esc(title)} <span class="hxn ${count ? (bad ? 'bad' : 'warn') : 'ok'}">${count}</span></h3>${desc ? `<p class="hxd">${desc}</p>` : ''}${count ? rows : '<p class="hxnone">None</p>'}</div>`;
  const healthHtml =
    // What the panel, the assistant and the diagram window all say and this did not: the graph is
    // built from the `.dg` files on disk, so a function that never downloaded is not a node, and
    // anything it alone called comes out under «no caller». Three of four consumers stated it; the
    // report - the document written for somebody who cannot go back and ask the panel, and whose
    // orphan list is where a reader decides a function is safe to delete - did not.
    (g && g.counts && g.counts.notInMirror === null
      ? `<div class="hxcov"><b>Read from your mirror.</b> How many of your functions are in it could not be established, so treat \u00abno caller\u00bb as covering only what is here.</div>`
      : g && g.counts && g.counts.notInMirror > 0
      ? `<div class="hxcov"><b>Read from your mirror:</b> ${esc(g.counts.nodes)} of ${esc(g.counts.inOrg)} functions. ${esc(g.counts.notInMirror)} could not be downloaded, and a function called only from one of those is counted here as having no caller.</div>`
      : '')
    + (scope.functions ? '' : `<div class="hxcov"><b>Functions were not included in this export.</b> The lists below still name them, because the audit is about them - but there is nothing here to link to. Export again with Functions ticked to read them.</div>`)
    + `<div class="hxcov"><b>Coverage.</b> Analyzed: function\u2192function calls, workflows, schedules, and each function's <i>associated_place</i> (blueprint, button, \u2026). <b>Not</b> analyzed: custom client scripts, approval/assignment/scoring rules. Items are <b>candidates to review</b>, never automatic deletions.</div>`
    + hSec(MSG.hOrphan, hOrph.length, HD_ORPHAN, hOrph.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.namespace || '')}</span></div>`).join(''))
    + hSec(MSG.hUnresolved, hUnres.length, HD_UNRESOLVED, hUnres.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.unresolved.join(', '))}</span></div>`).join(''), true)
    + hSec(MSG.hAmbiguous, hAmbig.length, HD_AMBIGUOUS, hAmbig.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.ambiguous.join(', '))}</span></div>`).join(''))
    + hSec(MSG.hBroken, hBroken.length, HD_BROKEN, hBroken.map((b) => `<div class="hxrow">${esc(b.kind)} <a href="#${b.kind === 'workflow' ? wfAnchor(b.id) : schAnchor(b.id)}">${esc(b.name || '?')}</a> <span class="hxm">\u2192 missing \u00ab${esc(b.fn || '?')}\u00bb</span></div>`).join(''), true)
    + hSec(MSG.hMissingRefs, hFK.length, HD_MISSING_FK, hFK.map((r) => `<div class="hxrow"><b>${esc(r.module)}</b>.${esc(r.field)} <span class="hxm">\u2192 ${esc(r.target)}</span></div>`).join(''))
    + hSec(MSG.hBiggest, hBig.length, MSG.hBiggestDesc + ' ' + esc(MSG.hRankedOver(hStat.length, hNodes.length)), hBig.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${n.stats.lines} lines \u00b7 ${n.stats.codeLines} code \u00b7 ${(n.stats.chars / 1024).toFixed(1)} KB</span></div>`).join(''))
    + hSec(MSG.hChattiest, hChatty.length, HD_CHATTIEST + ' ' + esc(MSG.hRankedOver(hStat.length, hNodes.length)), hChatty.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${n.stats.apiCalls} calls - ${n.stats.invokeurl} invokeurl \u00b7 ${n.stats.crm} zoho.crm \u00b7 ${n.stats.zoho} other${n.stats.sendmail ? ' \u00b7 ' + n.stats.sendmail + ' sendmail' : ''}</span></div>`).join(''))
    ;
  const healthTotal = H.total;

  // Contents index: informative tables (one row per item) for functions and modules
  Object.keys(byNs).sort().forEach((ns) => {
    byNs[ns].slice().sort(byField('api_name')).forEach((f) => {
      const n = nodeByKey[fnKey(f)];
    });
  });
  ['Standard', 'Custom'].forEach((k) => groups[k].slice().sort(byField('api_name')).forEach((m) => {
    const rb = (modRefs && modRefs[m.api_name]) ? modRefs[m.api_name].length : 0;
  }));
  // Connections: catalogue + which functions use each
  const connRows = (conns || []).slice().sort((a, b) => (b.uses.length - a.uses.length) || byField('name')(a, b)).map((c) => {
    const usesLinks = c.uses.length ? c.uses.map(fnLink).join(', ') : '<span class="none">none</span>';
    const status = c.missing ? '<span style="color:#b45309">not in catalogue</span>' : c.connected === false ? '<span style="color:#b45309">not connected</span>' : 'connected';
    return `<tr id="${escA(connAnchor(c.name))}"><td class="mono"><b>${esc(c.name)}</b></td><td>${esc(c.label || '')}</td><td class="mono">${esc(c.connector || '')}</td><td class="ct">${status}</td><td class="ct">${c.uses.length}</td><td>${usesLinks}</td></tr>`;
  });
  // Automation actions. The count of rules that fire each is the column the chapter exists for, and
  // the sender address is the one field a reader may not be allowed to receive - so it has a scope of
  // its own, off by default, and what was withheld is stated rather than left blank.
  const actWithheld = acts.filter((a) => a.from_address).length;
  const actRows = acts.slice().sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || byField('name')(a, b))
    .map((a) => {
      const users = firedBy(a, actUsers);
      const detail = a.kind === 'email_notifications'
        ? [a.template ? 'template: ' + esc(a.template.name || a.template.id) : '',
           a.from_type ? 'from: ' + (scope.addresses && (a.from_name || a.from_address) ? esc([a.from_name, a.from_address].filter(Boolean).join(' ')) : esc(a.from_type === 'user' ? 'a user address' : 'an organisation address')) : '',
           a.recipient_count != null ? esc(String(a.recipient_count)) + ' recipient(s)' : ''].filter(Boolean).join(' \u00b7 ')
        : a.kind === 'field_updates' ? (a.field ? esc(a.field_label || a.field) + (a.field_type ? ' (' + esc(a.field_type) + ')' : '')
            + ' \u2190 ' + (actStale(a) ? 'not read by this pull' : (a.value === null || a.value === undefined) ? 'cleared' : esc(String(a.value))) : '')
        : a.kind === 'webhooks' ? [esc(a.method || ''), esc(a.url || '')].filter(Boolean).join(' ')
        : a.kind === 'tasks' && actKept(a) ? esc(KEPT_DETAIL)
        : a.kind === 'tasks' && actThin(a) ? esc(MISS_DETAIL)
        // Same six fields as the Markdown and as the panel - see the note there. `mapVal` is shared
        // so the two reports cannot come to read a task differently.
        : (a.mappings || []).length
          ? a.mappings.map((m) => esc(String(m.field || '').replace(/_/g, ' ')) + ': ' + esc(mapVal(m))).join(' \u00b7 ')
        : a.notify === true ? 'notifies' : '';
      return '<tr><td>' + esc(a.name || a.id) + '</td><td>' + esc(actionKindLabel(a.kind)) + '</td><td>' + esc(actProv(a)) + '</td>'
        + '<td class="num">' + users.length + '</td><td>' + users.map((w) => esc(w.name || w.id)).join(', ') + '</td><td>' + detail + '</td></tr>';
    });
  const actHtml = acts.length
    ? '<p class="hxd">What a workflow rule fires, and which rules fire it. \u00abFired by\u00bb is read from the rules in this workspace, so a rule that was never pulled cannot appear in it.</p>'
      + ((actWithheld && !scope.addresses) ? `<p class="note">${actWithheld} sender address(es) withheld - that section was left off. Nothing else about those notifications is missing.</p>` : '')
      + `<table class="ftbl"><thead><tr><th>Action</th><th>Kind</th><th>Module</th><th>Rules</th><th>Fired by</th><th>Detail</th></tr></thead><tbody>${actRows.join('')}</tbody></table>`
    : '';
  const connHtml = conns.length
    ? `<p class="hxd">The org's connections and the functions that use each - the join key is the name in <code>invokeurl […connection:"…"]</code>.</p><table class="ftbl"><thead><tr><th>Connection</th><th>Label</th><th>Connector</th><th>Status</th><th>Uses</th><th>Used by functions</th></tr></thead><tbody>${connRows.join('')}</tbody></table>`
    : absent(scope.connections, 'connections');
  // Failures. A chapter that says *when it was read* in its own heading, because unlike every other
  // one here it is a reading of a runtime rather than of a structure - a report that presented it as
  // durable would be claiming something the data cannot support.
  const failRows = (fails.failures || []).slice().sort((a, b) => (b.count - a.count) || String(b.lastFailedAt || '').localeCompare(String(a.lastFailedAt || '')));
  const failHtml = failRows.length || fails.usage ? (
    `<p class="note">Read from Zoho on ${esc(fails.at ? new Date(fails.at).toLocaleString() : 'an unknown date')}. `
    + (fails.usage
        ? `In the 24 hours before that: ${esc(String(fails.usage.success ?? 'unknown'))} run(s), ${esc(String(fails.usage.failure ?? 'unknown'))} failed. `
        : '')
    // The credit reading, beside the run counts it belongs with. The panel says both and the reports
    // said neither, on data `loadExportData` already has in hand: `failures/index.json` carries
    // `runs` and `credits` and both builders read only `usage`, `capped`, `at` and the failure rows.
    + (fails.credits && (fails.credits.used != null || fails.credits.limit != null)
        ? `Over the same period Zoho counted ${esc(String(fails.credits.used ?? 'unknown'))} against a ceiling of ${esc(String(fails.credits.limit ?? 'unknown'))}. `
        : '')
    + (fails.capped ? esc(FAIL_CAPPED) + ' ' : '')
    + 'The input of each failed execution stays in Zoho - Zoost does not read it.</p>'
    // The busiest functions, as the health view lists them - with the same caveat, because the
    // number is a count of runs and not of time, and a report is read without the panel beside it.
    + ((fails.runs || []).length
        ? `<p class="note">The busiest ${esc(String(fails.runs.length))} functions over the same period, as Zoho counted them - not every function, and Zoho reports how often, not how long: a function that runs often is not automatically the expensive one.</p>`
          + '<table><thead><tr><th>Function</th><th>Runs in 24h</th></tr></thead><tbody>'
          + fails.runs.map((r) => `<tr><td>${esc(r.name || String(r.id || '?'))}</td>`
              + `<td>${esc(r.count == null ? 'unknown' : String(r.count))}</td></tr>`).join('')
          + '</tbody></table>'
        : '')
    + (failRows.length
        ? '<table><thead><tr><th>Function</th><th>Invoked by</th><th>Times</th><th>Last failure</th><th>Reason</th></tr></thead><tbody>'
          + failRows.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.componentType || '')}</td><td>${esc(String(f.count))}</td>`
              + `<td>${esc(f.lastFailedAt ? new Date(f.lastFailedAt).toLocaleString() : '')}</td><td>${esc(f.reason || '')}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p class="empty">Nothing had failed when this was read.</p>')
  ) : '';
  // **An index, not a copy of the document.** This listed every row of every chapter - on a real org
  // that is a hundred and fifty functions inside a box called «Contents», and then the Functions
  // chapter repeating all of them underneath. Reported, in the only words that fit: there is a thing
  // called contents and right below it there are the functions.
  //
  // A contents says what is in the document and how much of it, and gets you there in one click. The
  // rows belong to the chapters. It is `reportToc` from the shared shell now, which is what the other
  // product's report uses, so the two indexes are the same object rather than two ideas about one.
  const toc = reportToc([
    { title: 'Functions', count: fns.length, href: 'functions', note: 'Inventory, namespaces, cross-references' },
    { title: 'Modules', count: mods.length, href: 'modules', note: 'Fields, types, lookups, picklists' },
    { title: 'Relations', count: allRels.length, href: 'relations', note: 'Relation-first catalogue - related-list API names for Deluge' },
    wfs.length ? { title: 'Workflows', count: wfs.length, href: 'workflows', note: 'Triggers, criteria, actions' } : null,
    scheds.length ? { title: 'Schedules', count: scheds.length, href: 'schedules', note: 'Frequency, status, the function each runs' } : null,
    acts.length ? { title: 'Actions', count: acts.length, href: 'actions', note: 'Notifications, field updates, tasks and webhooks - and which rules fire each' } : null,
    conns.length ? { title: 'Connections', count: conns.length, href: 'connections', note: 'Connectors, status, and which functions use each' } : null,
    failHtml ? { title: 'Failures', count: failRows.length, href: 'failures', note: `What is breaking, as read on ${esc(fails.at ? new Date(fails.at).toISOString().slice(0, 10) : 'the last reading')}` } : null,
    scope.health ? { title: 'Health', count: healthTotal, href: 'health', note: `Orphans ${hOrph.length} \u00b7 Unresolved ${hUnres.length} \u00b7 Ambiguous ${hAmbig.length} \u00b7 Broken ${hBroken.length} \u00b7 Missing FK ${hFK.length}` } : null,
  ].filter(Boolean));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(PRODUCT_NAME)} - ${esc(ws.label || ws.instance || 'Export')}</title>`
    + `<meta name="author" content="${escA(PRODUCT_AUTHOR)}"><meta name="generator" content="${escA(PRODUCT_NAME)}"><meta name="description" content="Export of Zoho CRM Deluge functions and module schema.">${PRODUCT_URL ? `<link rel="canonical" href="${escA(PRODUCT_URL)}">` : ''}`
    + `<style>${EXPORT_CSS}</style></head><body>`
    // Raw: `reportHead` escapes the subject itself. Escaping it here as well produced
    // «R&amp;D» in the title of a workspace called «R&D» - the meta lines below it are markup
    // and are escaped by the caller, which is the asymmetry that hid this.
    + reportHead(ws.label || ws.instance || 'Export',
                 [`${ws.label ? `${esc(ws.label)} · ` : ''}${esc(ws.instance || '')} · org ${esc(ws.org || '')} · ${esc(envOf(ws.base))} · ${fns.length} functions · ${mods.length} modules · contents: ${esc(SCOPE_KEYS.filter((k) => scope[k]).join(', ') || 'nothing')}${scope.code ? '' : ' · source code excluded'}`,
                  `Data read from Zoho CRM: ${esc(freshnessLine())}`],
                 'Filter - hides any row, entry or card that does not match\u2026',
                 // The tile of this product's own icon, so the mark in the header is the one the
                 // reader has in their toolbar. It is the only thing about the two headers that
                 // differs, and it is the thing that says which export this is.
                 { name: PRODUCT_NAME, version: chrome.runtime.getManifest().version, tile: '#2563eb' })
    + `<main>${toc}<h2 id="functions">Functions</h2>${fnHtml || absent(scope.functions, 'functions')}<h2 id="modules">Modules</h2>${modHtml || absent(scope.modules, 'modules')}<h2 id="relations">Relations</h2>${relHtml}${wfs.length ? `<h2 id="workflows">Workflows</h2>${wfHtml}` : ''}${scheds.length ? `<h2 id="schedules">Schedules</h2>${schHtml}` : ''}${acts.length ? `<h2 id="actions">Actions</h2>${actHtml}` : ''}${conns.length ? `<h2 id="connections">Connections</h2>${connHtml}` : ''}${failHtml ? `<h2 id="failures">Failures</h2>${failHtml}` : ''}${scope.health ? `<h2 id="health">Health</h2>${healthHtml}` : ''}</main>`
    + reportFoot(PRODUCT_NAME, PRODUCT_URL)
    + `<script>${REPORT_FILTER_JS}</script></body></html>`;
}

async function loadExportData(op = beginWorkspaceOp()) {
    const metaById = new Map();
  for await (const p of walk(op.root)) {
    if (p.endsWith('.meta.json')) { try { const m = JSON.parse(await op.read(p)); metaById.set(String(m.id), { meta: m, dg: p.replace(/\.meta\.json$/, '.dg') }); } catch (_) {} }
  }
  let idx = null; try { idx = JSON.parse(await op.read('functions/index.json')); } catch (_) {}
  const entries = (idx && idx.length) ? idx : [...metaById.values()].map((v) => ({ id: v.meta.id, api_name: v.meta.api_name, display_name: v.meta.display_name, namespace: v.meta.nameSpace, category: v.meta.category, source: v.meta.source, rest: (v.meta.rest_api || []).some((r) => r.active) }));
  const fns = [];
  for (const e of entries) {
    // `null` and not `''`: a source that could not be read is not an empty one, and `fnStats`
    // tells the two apart now - so a function whose fetch failed no longer reports «0 lines, 0
    // outbound calls» in a report somebody reads without the extension.
    const d = metaById.get(String(e.id)); let code = null;
    if (d) { try { code = await op.read(d.dg); } catch (_) {} }
    fns.push({ api_name: e.api_name, display_name: e.display_name || e.api_name, namespace: (d && (d.meta.nameSpace)) || e.namespace, rest: e.rest, code, downloaded: !!d, associated_place: (d && d.meta && d.meta.associated_place) || null, modified_by: (d && d.meta.modified_by) || null, updatedTime: (d && d.meta.updatedTime) || null, connections: (d && d.meta.connections) || [], stats: d ? fnStats(code) : null });
  }
  const mods = [];
  for await (const p of walk(op.root)) { if (isModuleFile(p)) { try { const m = JSON.parse(await op.read(p)); try { m._layouts = JSON.parse(await op.read(`modules/layouts/${sanitize(m.api_name || 'unknown')}.json`)); } catch (_) { m._layouts = []; } mods.push(m); } catch (_) {} } }
  // A report with «Functions: 0» because the graph failed is a report that lies about the org: the
  // HTML crashed on g.nodes and the Markdown shipped the zero. The failure stops the export and says
  // why; a reader gets a report about the workspace, or none.
  const g = await ensureGraph(op);
  if (!op.current()) throw new Error(WS_MOVED);
  // The module reading, resolved once for both reports. It is done here rather than in each builder
  // because the two must not be able to disagree - a reader moves between the HTML and the Markdown
  // and a number that differs between them is worse than a number missing from one.
  if (g) {
    const known = (await moduleNames(op)) || new Map();
    const byKey = new Map();
    for (const n of Object.values(g.nodes)) {
      if (!n.file) continue;
      const r = [], w = [], tc = [];
      for (const m of n.modules || []) {
        if (!known.has(m.name)) continue;
        const b = m.mode === 'write' ? w : m.mode === 'read' ? r : tc;
        if (!b.includes(m.name)) b.push(m.name);
      }
      n.modulesR = r.sort(); n.modulesW = w.sort(); n.modulesT = tc.sort();
      byKey.set((n.namespace || '') + '.' + (n.api_name || n.name), n);
    }
    fns.forEach((f) => {
      const n = byKey.get((f.namespace || '') + '.' + (f.api_name || ''));
      if (!n) return;
      f.modulesR = n.modulesR; f.modulesW = n.modulesW; f.modulesT = n.modulesT;
      f.modulesUnknown = n.modulesUnknown || 0;
      // What the graph knows about this function, kept beside the index row it belongs to: calls,
      // callers, signature, description. The Markdown used to enumerate the graph instead of the
      // index, which is the same divergence one level up - see buildExportMarkdown().
      f.node = n;
    });
  }
  const modRefs = {};
  mods.forEach((m) => (m.fields || []).forEach((fl) => { if (fl.lookup) (modRefs[fl.lookup] ||= []).push({ module: m.api_name, field: fl.api_name }); }));
  const wfs = [];
  let wfIdx = []; try { wfIdx = JSON.parse(await op.read('workflows/index.json')); } catch (_) {}
  for (const w of wfIdx) { let detail = null; try { detail = JSON.parse(await op.read(`workflows/${w.id}.json`)); } catch (_) {} wfs.push({ ...w, id: String(w.id), detail }); }
  let scheds = []; try { scheds = JSON.parse(await op.read('schedules/index.json')); } catch (_) {}
  // connections catalogue + usage (which functions reference each), joined on connectionLinkName
  let connCat = []; try { connCat = JSON.parse(await op.read('connections/index.json')); } catch (_) {}
  if (!Array.isArray(connCat)) connCat = [];
  const connUse = {};
  fns.forEach((f) => (f.connections || []).forEach((c) => { if (c && c.name) (connUse[c.name] ||= []).push(f.api_name); }));
  const conns = connCat.map((c) => ({ ...c, uses: (connUse[c.name] || []).slice() }));
  const catNames = new Set(connCat.map((c) => c.name));
  Object.keys(connUse).forEach((name) => { if (!catNames.has(name)) conns.push({ name, label: name, connector: null, connected: null, missing: true, uses: connUse[name].slice() }); });
  // The failures index is one file that says when it was read - not a folder - so it is loaded
  // whole and carries its own date into the report. `params` is not in it: the bridge never sent it.
  let fails = { at: null, usage: null, failures: [] };
  try { const d = JSON.parse(await op.read('failures/index.json')); if (d && Array.isArray(d.failures)) fails = d; } catch (_) {}
  // The automation actions, and the map of which rules fire each - built from the rules that were
  // just read rather than from the panel's cache, because an export must not depend on which tab
  // the reader happened to open.
  let acts = []; try { const a = JSON.parse(await op.read('actions/index.json')); if (Array.isArray(a)) acts = a; } catch (_) {}
  const actUsers = new Map();
  wfs.forEach((w) => ((w.detail && w.detail.conditions) || []).forEach((c) => {
    const list = [];
    if (c.instant_actions && c.instant_actions.actions) list.push(...c.instant_actions.actions);
    (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => list.push(...(sa.actions || [])));
    // Both keys, like `buildActionUsers`: the id inside a workflow's action list is not always the
    // id the census carries, and this map was built with the id alone - so the report answered «no
    // rules» about an action the panel shows a rule for.
    list.forEach((a) => { if (!a || !a.type) return;
      for (const k of [`${a.type}:${String(a.id)}`, `${a.type}:name:${String(a.name || '').toLowerCase()}`]) {
        if (!actUsers.has(k)) actUsers.set(k, []);
        if (!actUsers.get(k).some((x) => String(x.id) === String(w.id))) actUsers.get(k).push({ id: w.id, name: w.name });
      } });
  }));
  return { fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers };
}
/** A task mapping's value, as the panel reads it: `{name}` for a person or a picklist entry, the
 *  bare value otherwise. Written once because the two reports and the panel must not disagree about
 *  what a task does - which is the whole reason these fields are in the report at all. */
/** The module column, with what the panel also shows beside an action: who last changed it and
 *  whether Zoho has it locked. Both were on screen and in neither report - and «Modified by» is
 *  printed for a *function* in the same file, so the omission was inconsistent inside one report. */
function actProv(a) {
  const bits = [a.module_label || a.module || ''];
  if (a.modified_by || a.modified_time) {
    bits.push('modified' + (a.modified_by ? ' by ' + a.modified_by : '')
              + (a.modified_time ? ' ' + String(a.modified_time).slice(0, 16) : ''));
  }
  if (a.locked === true) bits.push('locked in Zoho');
  return bits.filter(Boolean).join(' \u00b7 ');
}
function mapVal(m) {
  const v = m && m.value;
  if (v && typeof v === 'object') return String(v.name || v.id || '');
  return String(v == null ? '' : v);
}
function _mdCell(x) { return String(x == null ? '' : x).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function buildExportMarkdown(d, scope) {
  scope = Object.assign({}, SCOPE_DEFAULT, scope || {});
  let { mods, g, wfs, scheds, conns, fails, acts } = d;
  if (!scope.modules) mods = [];
  if (!scope.workflows) wfs = [];
  if (!scope.schedules) scheds = [];
  conns = scope.connections ? (conns || []) : [];
  acts = scope.actions ? (acts || []) : [];
  fails = scope.failures ? (fails || { failures: [] }) : { at: null, usage: null, failures: [] };
  // The enumeration is the index - every function the org has - and not the call graph, which is
  // built by walking the .dg files and therefore holds only the ones a pull managed to download.
  // The HTML has always listed all of them, marking what is missing «not downloaded»; this one
  // listed the downloaded ones and printed their number as the org's function count, so two reports
  // of one workspace disagreed and the one that disagreed downwards is the one written to be given
  // to an assistant. It would have answered that a function the org has does not exist - «not read»
  // masquerading as «does not exist», which is the defect this repository fixed in the Analytics
  // query tables and left standing here.
  //
  // The source comes from `code`, read from disk by loadExportData: a graph node carries none.
  const fnList = (scope.functions ? (d.fns || []) : [])
    .map((f) => Object.assign({ namespace: f.namespace, name: f.api_name, api_name: f.api_name,
                                rest: f.rest, stats: f.stats, source_code: f.code }, f.node || {},
                              { downloaded: f.downloaded, source_code: f.code,
                                display_name: f.display_name, associated_place: f.associated_place,
                                connections: f.connections, modified_by: f.modified_by, updatedTime: f.updatedTime }))
    .sort((a, b) => (a.namespace + '.' + a.name).localeCompare(b.namespace + '.' + b.name));
  const notDown = fnList.filter((n) => !n.downloaded).length;
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const inst = (bound && bound.instance) || 'workspace', org = (bound && bound.org) || '?', env = bound ? envOf(bound.base) : '?';
  const first = (t) => (t || '').split('\n')[0].slice(0, 120);
  const params = (n) => '(' + ((n.params || []).map((p) => (p && (p.name || p.param_name)) || p).filter(Boolean).join(', ')) + ')';
  const wfFns = (w) => { const out = []; const det = w.detail; if (det) (det.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter(isFnAction).forEach((a) => out.push(a.name)); }); return [...new Set(out)]; };
  let md = '# Zoho CRM Deluge - Workspace export (AI context)\n\n';
  if (bound && bound.label) md += `- Workspace: ${bound.label}\n`;
  md += `- Instance: ${inst}\n- Org: ${org}\n- Environment: ${env}\n- Generated: ${now}\n- Functions: ${fnList.length}${notDown ? ` (${notDown} not downloaded - listed, without source)` : ''} \u00b7 Modules: ${mods.length} \u00b7 Workflows: ${wfs.length} \u00b7 Schedules: ${scheds.length}\n`;
  md += `- Data read from Zoho CRM: ${freshnessLine()}\n\n`;
  // What is in this file, not what was ticked. The line listed the scope, and the scope included
  // `health`, which this report had no chapter for - so a reader, and the assistant this file is
  // written for, were told the export covers an audit that was not in it. «Nothing in a report should
  // be invented there» is the rule, and a contents list is the first thing that can break it. The
  // chapter exists now, and this line is still derived rather than declared: the fix for the missing
  // chapter must not become the reason nobody notices the next one.
  //
  // Placed after the body is built, so it can only ever name chapters that were emitted.
  // The same three states the HTML report gives a chapter, in the same words: it is here and full, it
  // is here and empty, or it was not asked for. This report emitted its chapters only when they had
  // content, so «no functions in this org» and «functions were unticked» both came out as silence -
  // and silence in the file an assistant reads is the one absence nobody can see. `absent()` next
  // door has drawn this distinction since it was written.
  const mdAbsent = (asked, what) => (asked ? `No ${what}.\n\n` : `Not included in this export - ${what} were unticked when it was made.\n\n`);
  const CONTENTS = '- Contents: (filled in below)\n\n';
  md += CONTENTS;
  md += '> Self-contained, read-only snapshot of this Zoho CRM org\'s Deluge functions, module schema, and automations. Intended as context for an AI assistant used outside the extension.\n\n';
  md += '## Index\n\n### Functions\n';
  fnList.forEach((n) => { const used = [...new Set((n.associated_place || []).map((p) => p._type).filter(Boolean))]; md += `- \`${n.namespace}.${n.name}\`${params(n)}${n.return_type ? ' \u2192 ' + n.return_type : ''}${n.rest ? ' \u00b7 REST' : ''}${used.length ? ' \u00b7 used in ' + used.join('/') : ''}${n.stats ? ` \u00b7 ${n.stats.lines} lines \u00b7 ${n.stats.apiCalls} API call(s)` : ''}${n.downloaded ? '' : ' \u00b7 not downloaded'}${n.description ? ' - ' + first(n.description) : ''}\n`; });
  md += '\n### Modules\n';
  mods.slice().sort(byField('api_name')).forEach((m) => { md += `- \`${m.api_name}\` - ${m.unreadable ? 'not described by Zoho' : `${(m.fields || []).length} fields`}\n`; });
  if (wfs.length) {
    md += '\n### Workflows\n';
    wfs.forEach((w) => {
      const fl = wfFns(w); const wsc = wfScheduled(w.detail);
      const last = (w.detail && w.detail.last_executed_time) || '';
      md += `- ${w.name}${w.module ? ' (' + w.module + ')' : ''}${fl.length ? ' \u2192 ' + fl.join(', ') : ''}`
        + `${wsc.count ? ` \u00b7 ${wsc.count} scheduled${wsc.delays.length ? ' after ' + wsc.delays.join(', ') : ''}` : ''}`
        + `${last ? ' \u00b7 last run ' + String(last).slice(0, 16) : ''}\n`;
    });
  }
  if (scheds.length) { md += '\n### Schedules\n'; scheds.forEach((sc) => { md += `- ${sc.name} \u2192 ${sc.function_name || '?'}${sc.frequency ? ' (' + sc.frequency + ')' : ''}\n`; }); }
  md += `\n---\n\n## Functions${scope.code ? ' (full source)' : ' (signatures only - source code excluded from this export)'}\n\n`;
  if (!fnList.length) md += mdAbsent(scope.functions, 'functions');
  fnList.forEach((n) => {
    md += `### ${n.namespace}.${n.name}\n\n`;
    md += `- api_name: \`${n.api_name || ''}\`${n.return_type ? ` \u00b7 returns ${n.return_type}` : ''}${n.rest ? ' \u00b7 REST-enabled' : ''}\n`;
    if (n.calls && n.calls.length) md += `- calls: ${n.calls.join(', ')}\n`;
    if (n.called_by && n.called_by.length) md += `- called by: ${n.called_by.join(', ')}\n`;
    if (n.associated_place && n.associated_place.length) md += `- used in: ${n.associated_place.map((p) => `${p._type}${p.name ? ' ' + p.name : ''}`).join('; ')}\n`;
    if (n.stats) md += `- size: ${n.stats.lines} lines (${n.stats.codeLines} code) · ${(n.stats.chars / 1024).toFixed(1)} KB\n- outbound calls: ${n.stats.apiCalls || 'none'}${n.stats.apiCalls ? ` (${n.stats.invokeurl} invokeurl, ${n.stats.crm} zoho.crm, ${n.stats.zoho} other Zoho${n.stats.sendmail ? `, ${n.stats.sendmail} sendmail` : ''})` : ''}\n`;
    if (scope.connections && n.connections && n.connections.length) md += `- connections: ${n.connections.map((c) => c.name).join(', ')}\n`;
    // What the code does to the org's modules. Read and write are kept apart here as on screen, and
    // the calls whose module is computed are stated rather than dropped - a report that quietly
    // omits what it could not read is a lesser copy of the panel, which is the one thing an export
    // must never be.
    if (n.modulesR && n.modulesR.length) md += `- reads modules: ${n.modulesR.join(', ')}\n`;
    if (n.modulesW && n.modulesW.length) md += `- writes modules: ${n.modulesW.join(', ')}\n`;
    if (n.modulesT && n.modulesT.length) md += `- reaches by URL: ${n.modulesT.join(', ')}\n`;
    if (n.modulesUnknown) md += `- module not determinable in ${n.modulesUnknown} call(s)\n`;
    if (n.modified_by || n.updatedTime) md += `- modified: ${n.modified_by ? 'by ' + n.modified_by : ''}${n.updatedTime ? ' · ' + String(n.updatedTime).slice(0, 16) : ''}\n`;
    // An empty fence would read as a function with no body. Not downloaded is a different fact from
    // empty, and this report has one job: never to let the two look alike.
    md += !n.downloaded ? '\n- source: not downloaded - run Pull all, or ↻ Refresh, to fetch it\n\n'
        // The third state, which this line had two of. A function whose file could not be read
        // got an empty fence - «a function with no body», which the comment above forbids in those
        // words about the case one branch over. `null` is «nothing to read»; `''` is an empty file
        // and keeps its fence, because that is true of it.
        : (n.source_code === null || n.source_code === undefined)
          ? '\n- source: could not be read from the workspace folder - the function exists, this copy does not'
          + '\n\n'
        : scope.code ? ('\n```deluge\n' + String(n.source_code).replace(/```/g, '`\u200b``') + '\n```\n\n') : '\n';
  });
  // Relation-first catalogue: this is the section an LLM should hit when asked
  // \"how do I read the related data of a contact?\"
  const SYS_REL_M = /^(Notes|Attachments|Emails|Tasks|Calls|Events|Tasks_History|Calls_History|Events_History|CheckLists|Activities.*|Zoho_Support|Social|Campaigns_Sent|Invited_Events|Cadences|Timeline|Approvals?)$/i;
  const rels = [];
  mods.forEach((m) => (m.related_lists || []).forEach((r) => {
    const child = r.module || r.connected_module || null;
    let via = r.linking_module ? `linking module ${r.linking_module}` : '';
    if (!via && child) {
      const cm = mods.find((x) => x.api_name === child);
      if (cm) { const ff = (cm.fields || []).filter((x) => x.lookup === m.api_name).map((x) => x.api_name); if (ff.length) via = `lookup ${ff.join(' / ')}`; }
    }
    rels.push({ api: r.api_name, label: r.label || '', parent: m.api_name, child, via, type: r.type || 'default', sys: SYS_REL_M.test(r.api_name) || !child });
  }));
  md += '---\n\n## Relations (related lists)\n\n';
  if (!rels.length || !scope.relations) md += mdAbsent(scope.relations, 'related lists');
  if (rels.length && scope.relations) {
    md += 'To read a related list in Deluge you need the **relation API name**. It is not the api_name of the parent module, nor of the target module. Call:\n\n';
    md += '```deluge\nrows = zoho.crm.getRelatedRecords("<relation API name>", "<module the record belongs to>", recordId);\n```\n\n';
    const emit = (list, title) => {
      if (!list.length) return;
      md += `### ${title}\n\n| Relation API name | Label | On module | Returns | Via | Type | Deluge |\n|---|---|---|---|---|---|---|\n`;
      list.sort((a, b) => a.parent.localeCompare(b.parent) || a.api.localeCompare(b.api)).forEach((r) => {
        md += `| \`${_mdCell(r.api)}\` | ${_mdCell(r.label)} | \`${_mdCell(r.parent)}\` | ${r.child ? '`' + _mdCell(r.child) + '`' : ''} | ${_mdCell(r.via || '')} | ${_mdCell(r.type)} | \`zoho.crm.getRelatedRecords("${_mdCell(r.api)}", "${_mdCell(r.parent)}", recordId)\` |\n`;
      });
      md += '\n';
    };
    emit(rels.filter((r) => !r.sys), 'Module-to-module relations');
    emit(rels.filter((r) => r.sys), 'System related lists (notes, attachments, activities\u2026)');
  }
  md += '---\n\n## Modules (schema)\n\n';
  if (!mods.length) md += mdAbsent(scope.modules, 'modules');
  mods.slice().sort(byField('api_name')).forEach((m) => {
    md += `### ${m.api_name}${(m._layouts && m._layouts.length) ? ` \u00b7 ${m._layouts.length} layout(s)` : ''}\n\n`;
    const mref = moduleRefusal(m.unreadable);
    if (mref) md += `> **Not described by Zoho.** ${mref.text}\n\n`;
    md += `#### All fields (flat)\n\n| Field | API name | Type | Lookup | Picklist |\n|---|---|---|---|---|\n`;
    (m.fields || []).forEach((f) => { md += `| ${_mdCell(f.label || f.api_name)} | \`${_mdCell(f.api_name)}\` | ${_mdCell((f.data_type || '') + (f.length ? ' (' + f.length + ')' : ''))} | ${f.lookup ? '\u2192 ' + _mdCell(f.lookup) : ''} | ${_pick(f.picklist, 12, _mdCell)} |\n`; });
    md += '\n';
    if (scope.relations && (m.related_lists || []).length) {
      md += `#### Related lists (use the API name in zoho.crm.getRelatedRecords)\n\n| API name | Label | Target module | Type |\n|---|---|---|---|\n`;
      m.related_lists.forEach((r) => { md += `| \`${_mdCell(r.api_name)}\` | ${_mdCell(r.label || '')} | ${_mdCell(r.module || r.connected_module || '')}${r.linking_module ? ' via ' + _mdCell(r.linking_module) : ''} | ${_mdCell(r.type || '')}${r.visible === false ? ' (hidden)' : ''} |\n`; });
      md += '\n';
    } else if (scope.relations && m.related_read === false) {
      md += 'Related lists: neither endpoint would answer for this module when it was pulled, so whether it has any is unknown.\n\n';
    }
    (scope.layouts ? (m._layouts || []) : []).forEach((L) => {
      md += `#### Layout: ${_mdCell(L.name || String(L.id))}${L.visible === false ? ' (hidden)' : ''} - ${(L.sections || []).length} sections\n\n`;
      (L.sections || []).forEach((sec) => {
        md += `**${_mdCell(sec.display_label || sec.name || 'Section')}** (${(sec.fields || []).length})\n\n| Field | API name | Type | Req |\n|---|---|---|---|\n`;
        (sec.fields || []).forEach((fl) => { md += `| ${_mdCell(fl.field_label || fl.display_label || fl.api_name)} | \`${_mdCell(fl.api_name || '')}\` | ${_mdCell(fl.data_type || '')} | ${fl.required ? '\u25cf' : ''} |\n`; });
        md += '\n';
      });
    });
  });
  const mdStat = fnList.filter((n) => n.stats && n.stats.lines);
  // The chapter exists whenever there are functions, and says what it could measure. It used to
  // appear only when something was measurable, so a workspace whose sources were never downloaded
  // got a report with no size chapter at all - indistinguishable from an org whose functions are all
  // empty, and the reader cannot know which.
  if (fnList.length) {
    md += '---\n\n## Size and outbound calls\n\nPlain counts, no threshold and no verdict: length is verbosity, not complexity, and each outbound call is work Zoho meters. Calls are counted outside comments and string literals. Interpretation is the reader\'s.\n\n'
      + MSG.hRankedOver(mdStat.length, fnList.length) + '\n\n';
    md += '| Function | Lines | Code lines | KB | invokeurl | zoho.crm | Other Zoho | sendmail | Total calls |\n|---|---|---|---|---|---|---|---|---|\n';
    mdStat.slice().sort((a, b) => b.stats.lines - a.stats.lines).forEach((n) => {
      const s = n.stats;
      md += `| \`${_mdCell(n.namespace + '.' + n.name)}\` | ${s.lines} | ${s.codeLines} | ${(s.chars / 1024).toFixed(1)} | ${s.invokeurl} | ${s.crm} | ${s.zoho} | ${s.sendmail} | ${s.apiCalls} |\n`;
    });
    md += '\n';
  }
  // The actions a rule fires, for a reader who has the file and not the panel. This is the chapter
  // an external model is most likely to be asked about - «what happens when a deal is won» - so the
  // rules that fire each are in the row rather than a section away.
  // **The three chapters the HTML report had and this one did not.** «Every piece of information the
  // panel shows about an item belongs in the HTML and Markdown exports too» - and a workflow was one
  // line here (name, module, functions, last run) against the HTML's trigger, criteria, per-condition
  // criteria and instant/scheduled actions with their delays; a schedule was one line against
  // frequency, status, the function and the next run; and the audit was not here at all, while the
  // dialog offered a Health tick for both buttons. This file is the one written for an assistant, so
  // what is absent from it is absent from every answer it gives - invisibly.
  if (wfs.length) {
    md += '---\n\n## Workflows\n\nWhat fires, when, and what it does. Criteria are as Zoho stores them.\n\n';
    const wfActionMd = (a) => (isFnAction(a) ? `\u0192 ${a.name || a.id}` : `${a.type || '?'}: ${a.name || a.id}`);
    const wfByModMd = {};
    wfs.forEach((w) => (wfByModMd[w.module || 'Other'] ||= []).push(w));
    Object.keys(wfByModMd).sort().forEach((mod) => {
      md += `### ${_mdCell(mod)}\n\n`;
      wfByModMd[mod].slice().sort(byField('name')).forEach((w) => {
        const det = w.detail;
        md += `#### ${_mdCell(w.name)}${w.active ? '' : ' (inactive)'}\n\n`;
        if (!det) { md += '- not downloaded\n\n'; return; }
        const ew = det.execute_when || {}, dt = ew.details || {};
        const trig = [w.type || ew.type || ''];
        if (dt.repeat != null) trig.push(`repeat: ${dt.repeat ? 'yes' : 'no'}`);
        if (Array.isArray(dt.fields) && dt.fields.length) trig.push(`fields: ${dt.fields.map((fl) => (fl.field && fl.field.api_name) || fl.api_name || String(fl)).join(', ')}`);
        md += `- trigger: ${_mdCell(trig.filter(Boolean).join(' \u00b7 '))}\n`;
        const ewc = wfCrit(dt.criteria || ew.criteria);
        if (ewc) md += `- when: ${_mdCell(ewc)}\n`;
        if (det.description) md += `- description: ${_mdCell(det.description)}\n`;
        if (det.last_executed_time) md += `- last run: ${_mdCell(String(det.last_executed_time).slice(0, 16))}\n`;
        (det.conditions || []).forEach((c, i) => {
          const cd = c.criteria_details || {};
          md += `\n**Condition ${c.sequence_number || i + 1}**\n\n`;
          const ct = wfCrit(cd.criteria);
          if (ct) md += `- criteria: ${_mdCell(ct)}\n`;
          const rel = cd.relational_criteria;
          if (rel && (rel.module || rel.criteria)) md += `- related: ${_mdCell((rel.module && rel.module.api_name) || rel.module || '')} ${_mdCell(wfCrit(rel.criteria))}\n`;
          const inst = (c.instant_actions && c.instant_actions.actions) || [];
          if (inst.length) md += `- instant: ${_mdCell(inst.map(wfActionMd).join(', '))}\n`;
          const sch = Array.isArray(c.scheduled_actions) ? c.scheduled_actions : (c.scheduled_actions && c.scheduled_actions.actions ? [c.scheduled_actions] : []);
          sch.forEach((bk) => {
            const aa = bk.actions || []; const tim = wfTiming(bk);
            if (aa.length) md += `- scheduled${tim ? ` (${_mdCell(tim)})` : ''}: ${_mdCell(aa.map(wfActionMd).join(', '))}\n`;
          });
        });
        md += '\n';
      });
    });
  }
  if (scheds.length) {
    md += '---\n\n## Schedules\n\nEach schedule and the function it runs.\n\n';
    md += '| Schedule | Frequency | Status | Runs function | Next |\n|---|---|---|---|---|\n';
    scheds.slice().sort(byField('name')).forEach((sc) => {
      md += `| ${_mdCell(sc.name)} | ${_mdCell(sc.frequency || '')} | ${_mdCell(sc.status || '')} | ${_mdCell(sc.function_name || '?')} | ${_mdCell(sc.next || '')} |\n`;
    });
    md += '\n';
  }
  if (acts.length) {
    const withheld = acts.filter((a) => a.from_address).length;
    md += '---\n\n## Actions\n\nWhat a workflow rule fires: notifications, field updates, tasks and webhooks. Each exists on its own in Zoho and is reused across rules. "Fired by" is read from the rules in this workspace.\n\n';
    if (withheld && !scope.addresses) md += `> ${withheld} sender address(es) withheld - that section was left off. Nothing else about those notifications is missing.\n\n`;
    md += '| Action | Kind | Module | Rules | Fired by | Detail |\n|---|---|---|---|---|---|\n';
    acts.slice().sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || byField('name')(a, b)).forEach((a) => {
      const users = firedBy(a, d.actUsers);
      const detail = a.kind === 'email_notifications'
        ? [a.template ? 'template ' + (a.template.name || a.template.id) : '',
           a.from_type ? 'from ' + ((scope.addresses && [a.from_name, a.from_address].filter(Boolean).join(' ')) || (a.from_type === 'user' ? 'a user address' : 'an organisation address')) : '',
           a.recipient_count != null ? a.recipient_count + ' recipient(s)' : ''].filter(Boolean).join(' - ')
        : a.kind === 'field_updates' ? (a.field ? `${a.field_label || a.field}${a.field_type ? ' (' + a.field_type + ')' : ''} <- ${actStale(a) ? 'not read by this pull' : (a.value === null || a.value === undefined) ? 'cleared' : a.value}` : '')
        : a.kind === 'webhooks' ? [a.method || '', a.url || ''].filter(Boolean).join(' ')
        : a.kind === 'tasks' && actKept(a) ? KEPT_DETAIL
        : a.kind === 'tasks' && actThin(a) ? MISS_DETAIL
        // What the task actually says. The panel renders every `mappings` row - subject, due date,
        // status, priority, owner, reminder - and both reports fell through every arm to «notifies»
        // or to nothing, so a task's Detail cell was **empty** while six fields were on screen. The
        // rule this breaks is the project's own: anything shown about an item belongs in the reports
        // too, or the report is a quietly lesser copy and the reader cannot know what is missing.
        : (a.mappings || []).length ? a.mappings.map((m) => `${String(m.field || '').replace(/_/g, ' ')}: ${mapVal(m)}`).join(' \u00b7 ')
        : a.notify === true ? 'notifies' : '';
      md += `| ${_mdCell(a.name || a.id)} | ${_mdCell(actionKindLabel(a.kind))} | ${_mdCell(actProv(a))} | ${users.length} | ${_mdCell(users.map((w) => w.name || w.id).join(', '))} | ${_mdCell(detail)} |\n`;
    });
    md += '\n';
  }
  if (conns.length) {
    md += '---\n\n## Connections\n\nThe org\'s connections and which functions use each. The join key is the name in `invokeurl [...connection:"..."]`.\n\n';
    md += '| Connection | Label | Connector | Status | Uses | Used by |\n|---|---|---|---|---|---|\n';
    conns.slice().sort((a, b) => (b.uses.length - a.uses.length) || byField('name')(a, b)).forEach((c) => {
      const status = c.missing ? 'not in catalogue' : c.connected === false ? 'not connected' : 'connected';
      md += `| \`${_mdCell(c.name)}\` | ${_mdCell(c.label || '')} | ${_mdCell(c.connector || '')} | ${status} | ${c.uses.length} | ${_mdCell(c.uses.join(', '))} |\n`;
    });
    md += '\n';
  }
  // Failures, for the reader who has the file and not the panel. It states the date it was read in
  // the section itself: this is the one chapter that is a reading of a runtime rather than of a
  // structure, and a report that hid that would be claiming more than the data can carry.
  const failRows = (fails.failures || []).slice().sort((a, b) => (b.count - a.count));
  if (failRows.length || fails.usage) {
    md += '---\n\n## Failures\n\n';
    md += `Read from Zoho on ${fails.at || 'an unknown date'}.`;
    if (fails.usage) md += ` In the 24 hours before that: ${fails.usage.success ?? 'unknown'} run(s), ${fails.usage.failure ?? 'unknown'} failed.`;
    if (fails.credits && (fails.credits.used != null || fails.credits.limit != null)) {
      md += ` Over the same period Zoho counted ${fails.credits.used ?? 'unknown'} against a ceiling of ${fails.credits.limit ?? 'unknown'}.`;
    }
    if (fails.capped) md += ' ' + FAIL_CAPPED;
    md += ' The input of each failed execution stays in Zoho - Zoost does not read it.\n\n';
    if ((fails.runs || []).length) {
      md += `The busiest ${fails.runs.length} functions over the same period, as Zoho counted them - not every `
        + 'function, and Zoho reports how often, not how long: a function that runs often is not automatically '
        + 'the expensive one.\n\n';
      md += '| function | runs in 24h |\n|---|---|\n';
      md += fails.runs.map((r) => `| ${_mdCell(r.name || r.id)} | ${r.count == null ? 'unknown' : r.count} |`).join('\n') + '\n\n';
    }
    if (failRows.length) {
      md += '| function | invoked by | times | last failure | reason |\n|---|---|---|---|---|\n';
      md += failRows.map((f) => `| ${_mdCell(f.name)} | ${_mdCell(f.componentType)} | ${f.count} | ${_mdCell(f.lastFailedAt)} | ${_mdCell(f.reason)} |`).join('\n') + '\n\n';
    } else {
      md += 'Nothing had failed when this was read.\n\n';
    }
  }
  // One line, the way the HTML report's foot is one line: what made this, and a link to it. The
  // section that used to be here carried the author and the legal disclaimer as well, and the two
  // formats of one export are not allowed to say different amounts about themselves.
  if (scope.health) {
    const H = healthFacts(g, mods, wfs, scheds);
    const label = (n) => _mdCell(n.display_name || n.name);
    md += '---\n\n## Health\n\n';
    if (g && g.counts && g.counts.notInMirror === null) {
      md += '> **Read from your mirror.** How many of your functions are in it could not be established, so treat "no caller" as covering only what is here.\n\n';
    } else if (g && g.counts && g.counts.notInMirror > 0) {
      md += `> **Read from your mirror:** ${g.counts.nodes} of ${g.counts.inOrg} functions. ${g.counts.notInMirror} could not be downloaded, and a function called only from one of those is counted here as having no caller.\n\n`;
    }
    if (!scope.functions) md += '> **Functions were not included in this export.** The lists below still name them, because the audit is about them.\n\n';
    md += '> **Coverage.** Analyzed: function-to-function calls, workflows, schedules, and each function\'s *associated_place* (blueprint, button, ...). **Not** analyzed: custom client scripts, approval/assignment/scoring rules. Items are **candidates to review**, never automatic deletions.\n\n';
    const sec = (title, rows, desc) => {
      md += `### ${_mdCell(title)} (${rows.length})\n\n`;
      if (desc) md += `${desc}\n\n`;
      md += rows.length ? rows.join('\n') + '\n\n' : 'None\n\n';
    };
    sec(MSG.hOrphan, H.orphans.map((n) => `- ${label(n)}${n.namespace ? ` \u00b7 ${_mdCell(n.namespace)}` : ''}`), HD_ORPHAN);
    sec(MSG.hUnresolved, H.unresolved.map((n) => `- ${label(n)} \u2192 ${_mdCell(n.unresolved.join(', '))}`), HD_UNRESOLVED);
    sec(MSG.hAmbiguous, H.ambiguous.map((n) => `- ${label(n)} \u2192 ${_mdCell(n.ambiguous.join(', '))}`), HD_AMBIGUOUS);
    sec(MSG.hBroken, H.broken.map((b) => `- ${_mdCell(b.kind)} ${_mdCell(b.name || '?')} \u2192 missing "${_mdCell(b.fn || '?')}"`), HD_BROKEN);
    sec(MSG.hMissingRefs, H.missingFk.map((r) => `- ${_mdCell(r.module)}.${_mdCell(r.field)} \u2192 ${_mdCell(r.target)}`), HD_MISSING_FK);
    sec(MSG.hBiggest, H.biggest.map((n) => `- ${label(n)} \u00b7 ${n.stats.lines} lines \u00b7 ${n.stats.codeLines} code \u00b7 ${(n.stats.chars / 1024).toFixed(1)} KB`), MSG.hBiggestDesc + ' ' + MSG.hRankedOver(H.stat.length, H.nodes.length));
    sec(MSG.hChattiest, H.chattiest.map((n) => `- ${label(n)} \u00b7 ${n.stats.apiCalls} calls - ${n.stats.invokeurl} invokeurl \u00b7 ${n.stats.crm} zoho.crm \u00b7 ${n.stats.zoho} other${n.stats.sendmail ? ` \u00b7 ${n.stats.sendmail} sendmail` : ''}`), HD_CHATTIEST + ' ' + MSG.hRankedOver(H.stat.length, H.nodes.length));
  }
  md += `\n---\n\nGenerated by [${PRODUCT_NAME}](${PRODUCT_URL})\n`;
  // Derived from the chapters that were actually written. See the note beside CONTENTS.
  const chapters = [...md.matchAll(/(?:^|\n)## ([^\n(]+)/g)].map((m) => m[1].trim())
    .filter((h) => h !== 'Index');
  md = md.replace(CONTENTS, `- Contents: ${[...new Set(chapters)].join(', ') || 'nothing'}\n\n`);
  return md;
}
async function exportMarkdown() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (!dir) return;
  // The name is part of the report, and it was the one thing in here read from the panel instead of
  // from the operation - after every await, when the writing was already done. `bound` is reassigned
  // by a pull and by a rebinding of the Zoho tab, neither of which moves the workspace, so `op.write`
  // would let it through: the right folder, the right generation, and a file whose name claims a
  // different org from the one whose mirror is inside it. Read once, beside the op, so the name and
  // the contents describe the same instant.
  const whose = (bound && bound.instance) || 'workspace';
  const scope = await askScope(); if (!scope) return;
  try {
    await requirePerm(op.root);
    op.say('Building AI (Markdown) export\u2026', 'busy');
    const data = await loadExportData(op);
    const md = buildExportMarkdown(data, scope);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize(whose)}-${stamp}.md`;
    await op.write(name, md);
    op.say(`Exported \u2192 ${name} (in your workspace folder).`, 'ok');
  } catch (e) { if (op.current()) setStatus(MSG.exportErr + e.message, 'bad'); }
}
async function exportHtml() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (!dir) return;
  // The name is part of the report, and it was the one thing in here read from the panel instead of
  // from the operation - after every await, when the writing was already done. `bound` is reassigned
  // by a pull and by a rebinding of the Zoho tab, neither of which moves the workspace, so `op.write`
  // would let it through: the right folder, the right generation, and a file whose name claims a
  // different org from the one whose mirror is inside it. Read once, beside the op, so the name and
  // the contents describe the same instant.
  const whose = (bound && bound.instance) || 'workspace';
  const scope = await askScope(); if (!scope) return;
  try {
    await requirePerm(op.root);
    op.say('Building HTML export\u2026', 'busy');
    const { fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers } = await loadExportData(op);
    const html = buildExportHtml(fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers, scope);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize(whose)}-${stamp}.html`;
    await op.write(name, html);
    op.say(`Exported \u2192 ${name} (in your workspace folder).`, 'ok');
  } catch (e) { if (op.current()) setStatus(MSG.exportErr + e.message, 'bad'); }
}
