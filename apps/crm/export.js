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
const EXPORT_CSS = `
:root{--ink:#1f2937;--muted:#6b7280;--accent:#2563eb;--line:#e5e7eb}
*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;z-index:5}
header h1{margin:0 0 4px;font-size:20px}.meta{color:var(--muted);font-size:13px;font-family:ui-monospace,monospace}
.credit{margin-top:6px;color:#94a3b8;font-size:12px}.credit a{color:var(--accent)}
#q{margin-top:10px;width:100%;max-width:520px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px}
main{max-width:1000px;margin:0 auto;padding:24px 20px 80px}
h2{font-size:16px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);border-bottom:2px solid var(--line);padding-bottom:6px;margin:36px 0 10px}
h3.grp{font:12px ui-monospace,monospace;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:22px 0 8px}
h3.grp .cnt{color:#9aa4b2}
.item{border:1px solid var(--line);border-radius:10px;background:#fff;margin:10px 0;overflow:hidden}
.ih{padding:9px 12px;border-bottom:1px solid var(--line);background:#fbfcfe;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ih b{font-size:14px}.ih code{background:#eef1f5;padding:1px 6px;border-radius:5px;font-size:12px;color:#2563eb}
.ih .gen{color:#8b5cf6;font:12px ui-monospace,monospace}
.item{scroll-margin-top:120px}
.refs{padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;display:flex;flex-direction:column;gap:3px;background:#fcfdff}
.refs a,.ftbl td.mono a{color:var(--accent);text-decoration:none}.refs a:hover,.ftbl td.mono a:hover{text-decoration:underline}
.refs .none{color:#9aa4b2}
.badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;text-transform:uppercase}
.badge.rest{background:#ede9fe;color:#6d28d9}.badge.no{background:#fef3c7;color:#92400e}
pre.code{margin:0;padding:12px 14px;background:#0f1622;color:#cbd5e1;font:12.5px/1.55 ui-monospace,monospace;white-space:pre;overflow:auto}
.c-com{color:#5b6b82;font-style:italic}.c-str{color:#7ee0a6}.c-num{color:#e0a86b}.c-kw{color:#7aa2f7;font-weight:600}.c-type{color:#c792ea}.c-fn{color:#82d2ff}
table.ftbl{width:100%;border-collapse:collapse;font:12.5px ui-monospace,monospace}
.ftbl th{background:#f6f8fb;color:var(--muted);text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase}
.ftbl td{padding:5px 10px;border-bottom:1px solid var(--line)}.ftbl td.mono{color:#2563eb}
.toc{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:16px 0}
.toc>h2{margin:0 0 8px;border:0;padding:0}
.toch{font-size:13px;margin:14px 0 6px;color:var(--ink);text-transform:none;letter-spacing:0}
.toctbl{width:100%;border-collapse:collapse;font:12.5px system-ui,-apple-system,sans-serif}
.toctbl th{text-align:left;padding:5px 8px;border-bottom:2px solid var(--line);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.3px}
.toctbl td{padding:4px 8px;border-bottom:1px solid var(--line)}
.toctbl td.mono{font-family:ui-monospace,monospace;color:var(--muted);font-size:11.5px}
.toctbl td.ct{text-align:center}
.toctbl a{color:var(--accent);text-decoration:none}.toctbl a:hover{text-decoration:underline}
.toctbl tbody tr:hover{background:#f6f8fb}
.toctbl .none{color:#9aa4b2;text-align:center}
.wfxcond{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0;background:#fbfcff}
.wfxc{color:#2563eb;font-size:11px;font-weight:600;margin-bottom:4px}
.wfxcrit{font:12px ui-monospace,monospace;color:var(--ink);margin-bottom:4px}.wfxcrit i{color:var(--muted)}
.wfxact{font-size:12px;margin:3px 0}.wfxact b{color:var(--muted);font-weight:600;margin-right:4px}
.wfxact a{color:var(--accent);text-decoration:none}.wfxact a:hover{text-decoration:underline}
.wfact-x{display:inline-block;background:#eef1f5;color:var(--muted);border-radius:5px;padding:1px 6px;margin:1px 3px 0 0;font-size:11px}
.hxcov{font-size:12px;color:var(--muted);line-height:1.6;background:#f6f8fc;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0 14px}
.hxsec{margin:12px 0}.hxsec h3{font-size:13px;margin:0 0 3px;display:flex;align-items:center;gap:8px}
.hxn{font:11px ui-monospace,monospace;padding:1px 8px;border-radius:10px}
.hxn.warn{background:#fdf0d5;color:#8a5a12}.hxn.bad{background:#fbe0e0;color:#b42318}.hxn.ok{background:#d9f3e6;color:#177a4a}
.hxd{font-size:11.5px;color:var(--muted);margin:0 0 6px}
.hxrow{padding:3px 8px;border:1px solid var(--line);border-radius:6px;margin:2px 0;font:12px ui-monospace,monospace}
.hxrow .hxm{color:var(--muted);font-size:11px}
.hxnone{font-size:11.5px;color:#177a4a;margin:0}
.tochx{font-size:12px;margin:2px 0 6px}.tochx a{color:var(--accent);text-decoration:none}
.empty{color:var(--muted)}footer{max-width:1000px;margin:0 auto;padding:0 20px 40px;color:var(--muted);font-size:12px}

tr.relrow.sys td{color:#9aa4b2;background:#fbfbfc}

footer .legal{margin-top:6px;font-size:11px;line-height:1.5;opacity:.75;max-width:70ch}
`;
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
  const fnAnchor = (api) => 'fn-' + sanitize(api || '');
  const connAnchor = (name) => 'conn-' + sanitize(name || '');
  const connApiSet = new Set((conns || []).map((c) => c.name));
  const _hByName = {}; Object.values(g.nodes || {}).forEach((n) => (_hByName[n.name] ||= []).push(n));
  const codeResolve = (ns, name) => {
    const nodes = g.nodes || {};
    const t = nodes[ns + '.' + name] || ((_hByName[name] || []).length === 1 ? _hByName[name][0] : null);
    return t ? { href: '#' + fnAnchor(t.api_name), label: t.display_name || t.name } : null;
  };
  const hl = (c) => (window.highlightDeluge ? window.highlightDeluge(c, codeResolve) : esc(c));
  const fnApiSet = new Set(fns.map((f) => f.api_name));
  const fnLink = (api) => (api && fnApiSet.has(api)) ? `<a href="#${fnAnchor(api)}">${esc(api)}</a>` : esc(api || '?');
  const nodeByApi = {}; if (g && g.nodes) Object.values(g.nodes).forEach((n) => { if (n.api_name) nodeByApi[n.api_name] = n; });
  const apiOf = (id) => (g && g.nodes[id] && g.nodes[id].api_name) || null;
  // workflow <-> function wiring
  const fnById = {}, fnByName = {};
  fns.forEach((f) => { fnById[f.id] = f; if (f.name) fnByName[f.name.toLowerCase()] = f; if (f.display_name) fnByName[f.display_name.toLowerCase()] = f; });
  const wfFnActions = (w) => { const acts = []; ((w.detail && w.detail.conditions) || []).forEach((c) => ['instant_actions', 'scheduled_actions'].forEach((bk) => { const b = c[bk]; if (b && b.actions) b.actions.forEach((a) => { if (isFnAction(a)) acts.push(a); }); })); return acts; };
  const resolveFn = (a) => fnById[String(a.id)] || fnByName[(a.name || '').toLowerCase()];
  const triggeredBy = {};
  wfs.forEach((w) => wfFnActions(w).forEach((a) => { const fn = resolveFn(a); if (fn) (triggeredBy[fn.api_name] ||= []).push({ id: w.id, name: w.name }); }));
  const wfAnchor = (id) => 'wf-' + sanitize(String(id));
  const schAnchor = (id) => 'sch-' + sanitize(String(id));
  const scheduledBy = {};
  scheds.forEach((sc) => { const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()]; if (fn) (scheduledBy[fn.api_name] ||= []).push(sc); });
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
      const node = nodeByApi[f.api_name];
      const uses = node ? node.calls.map(apiOf).filter(Boolean) : [];
      const usedBy = node ? node.called_by.map(apiOf).filter(Boolean) : [];
      const trig = triggeredBy[f.api_name] || [];
      const refs = f.downloaded ? `<div class="refs">`
        + `<span><b>Uses (${uses.length}):</b> ${uses.length ? uses.map(fnLink).join(', ') : '<span class=\'none\'>none</span>'}</span>`
        + `<span><b>Used by (${usedBy.length}):</b> ${usedBy.length ? usedBy.map(fnLink).join(', ') : '<span class=\'none\'>none (entry point or unused)</span>'}</span>`
        + (trig.length ? `<span><b>Triggered by (${trig.length}):</b> ${trig.map((w) => `<a href="#${wfAnchor(w.id)}">${esc(w.name)}</a>`).join(', ')}</span>` : '')
        + ((scheduledBy[f.api_name] || []).length ? `<span><b>Scheduled by (${scheduledBy[f.api_name].length}):</b> ${scheduledBy[f.api_name].map((sc) => `<a href="#${schAnchor(sc.id)}">${esc(sc.name)}</a>`).join(', ')}</span>` : '')
        + assocText(f)
        + ((f.modulesR || []).length ? `<span><b>Reads (${f.modulesR.length}):</b> ${f.modulesR.map(esc).join(', ')}</span>` : '')
        + ((f.modulesW || []).length ? `<span><b>Writes (${f.modulesW.length}):</b> ${f.modulesW.map(esc).join(', ')}</span>` : '')
        + ((f.modulesT || []).length ? `<span><b>Reached by URL (${f.modulesT.length}):</b> ${f.modulesT.map(esc).join(', ')}</span>` : '')
        + (f.modulesUnknown ? `<span><b>Module not determinable:</b> ${f.modulesUnknown} call(s)</span>` : '')
        + ((scope.connections && (f.connections || []).length) ? `<span><b>Connections (${f.connections.length}):</b> ${f.connections.map((c) => (c.name && connApiSet.has(c.name)) ? `<a href="#${connAnchor(c.name)}">${esc(c.name)}</a>` : esc(c.name)).join(', ')}</span>` : '')
        + (f.stats ? `<span><b>Size:</b> ${f.stats.lines} lines (${f.stats.codeLines} code) · ${(f.stats.chars / 1024).toFixed(1)} KB · <b>outbound calls:</b> ${f.stats.apiCalls || 'none'}${f.stats.apiCalls ? ` (${f.stats.invokeurl} invokeurl, ${f.stats.crm} zoho.crm, ${f.stats.zoho} other${f.stats.sendmail ? ', ' + f.stats.sendmail + ' sendmail' : ''})` : ''}</span>` : '')
        + ((f.modified_by || f.updatedTime) ? `<span><b>Modified:</b> ${f.modified_by ? 'by ' + esc(f.modified_by) : ''}${f.updatedTime ? ' · ' + esc(String(f.updatedTime).slice(0, 16)) : ''}</span>` : '')
        + `</div>` : '';
      fnHtml += `<section class="item" id="${escA(fnAnchor(f.api_name))}" data-name="${escA(((f.api_name || '') + ' ' + (f.display_name || '')).toLowerCase())}">`
        + `<div class="ih"><b>${esc(f.display_name || f.api_name)}</b> <code>${esc(f.api_name)}</code>`
        + `${f.rest ? '<span class="badge rest">REST</span>' : ''}${f.downloaded ? '' : '<span class="badge no">not downloaded</span>'}</div>`
        + `${refs}${(scope.code && f.code) ? `<pre class="code">${hl(f.code)}</pre>` : ''}</section>`;
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
  const relRowHtml = (r) => `<tr class="relrow${r.sys ? ' sys' : ''}" data-name="${escA(((r.api || '') + ' ' + (r.label || '') + ' ' + (r.parent || '') + ' ' + (r.child || '')).toLowerCase())}">`
    + `<td class="mono"><b>${esc(r.api)}</b></td><td>${esc(r.label)}</td>`
    + `<td class="mono">${modLink(r.parent)}</td><td class="mono">${r.child ? modLink(r.child) : ''}</td>`
    + `<td class="mono">${esc(r.via || '')}</td><td class="ct">${esc(r.type)}${r.visible ? '' : ' \u00b7 hidden'}</td>`
    + `<td class="mono">zoho.crm.getRelatedRecords("${esc(r.api)}", "${esc(r.parent)}", recordId)</td></tr>`;
  const relHtml = allRels.length
    ? `<p class="hxd">One row per relation. To read a related list in Deluge you need the <b>relation API name</b> - it is not the api_name of either module.</p>`
      + `<table class="ftbl"><thead><tr><th>Relation API name</th><th>Label</th><th>On module</th><th>Returns</th><th>Via</th><th>Type</th><th>Deluge</th></tr></thead><tbody>${allRels.map(relRowHtml).join('')}</tbody></table>`
    : '<p class="empty">No related lists in this export - re-run Pull Modules.</p>';

  // workflows grouped by trigger module
  const wfByMod = {}; wfs.forEach((w) => (wfByMod[w.module || '(no module)'] ||= []).push(w));
  // rich workflow rendering (mirrors the panel detail)
  const wfValOf = (g) => { const v = g.value; if (g.type === 'field' && v && v.api_name) return v.api_name; if (v === '${EMPTY}' || v === '${empty}') return 'empty'; return v == null ? '' : String(v); };
  const wfOne = (g) => `${(g.field && g.field.api_name) || '?'} ${g.comparator || ''} ${wfValOf(g)}`;
  const wfCrit = (crit) => { if (!crit) return ''; if (crit.group && crit.group.length) { const op = crit.group_operator || 'AND'; return crit.group.map((g) => (g.group ? '(' + wfCrit(g) + ')' : wfOne(g))).join(` ${op} `); } if (crit.comparator) return wfOne(crit); return ''; };
  const wfTiming = (bk) => { const ea = bk.execute_after; return (ea && ea.unit != null) ? `after ${ea.unit} ${ea.period || ''}`.trim() : ''; };
  const wfActionHtml = (a) => { if (isFnAction(a)) { const fn = resolveFn(a); return fn ? `<a href="#${fnAnchor(fn.api_name)}">\u0192 ${esc(fn.display_name || fn.api_name)}</a>` : `<span class="none">\u0192 ${esc(a.name)}</span>`; } return `<span class="wfact-x">${esc(a.type)}: ${esc(a.name)}</span>`; };
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
  const wfRows = [];
  Object.keys(wfByMod).sort().forEach((mod) => wfByMod[mod].slice().sort(byField('name')).forEach((w) => {
    const wsc = wfScheduled(w.detail);
    wfRows.push(`<tr><td><a href="#${wfAnchor(w.id)}">${esc(w.name)}</a></td><td class="mono">${esc(w.module || '')}</td><td class="ct">${esc(w.type || '')}</td><td class="ct">${w.active ? '\u25cf' : ''}</td><td class="ct">${wfFnActions(w).length}</td><td class="ct">${wsc.count || ''}</td><td class="ct">${esc(((w.detail && w.detail.last_executed_time) || '').slice(0, 16))}</td></tr>`);
  }));

  // schedules
  let schHtml = '';
  scheds.slice().sort(byField('name')).forEach((sc) => {
    const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()];
    const fl = fn ? `<a href="#${fnAnchor(fn.api_name)}">${esc(fn.display_name || fn.api_name)}</a>` : `<span class="none">${esc(sc.function_name || '?')}</span>`;
    schHtml += `<section class="item" id="${escA(schAnchor(sc.id))}" data-name="${escA(((sc.name || '') + ' ' + (sc.function_name || '')).toLowerCase())}">`
      + `<div class="ih"><b>${esc(sc.name)}</b> <code>${esc(sc.frequency || '')}</code>${sc.status !== 'active' ? `<span class="badge no">${esc(sc.status || '')}</span>` : ''}</div>`
      + `<div class="refs"><span><b>Runs function:</b> ${fl}</span>${sc.next ? `<span><b>Next:</b> ${esc(sc.next)}</span>` : ''}</div></section>`;
  });
  const schRows = scheds.slice().sort(byField('name')).map((sc) => {
    const fn = fnById[String(sc.function_id)] || fnByName[(sc.function_name || '').toLowerCase()];
    const fl = fn ? `<a href="#${fnAnchor(fn.api_name)}">${esc(fn.display_name || fn.api_name)}</a>` : esc(sc.function_name || '?');
    return `<tr><td><a href="#${schAnchor(sc.id)}">${esc(sc.name)}</a></td><td>${fl}</td><td class="ct">${esc(sc.frequency || '')}</td><td class="ct">${sc.status === 'active' ? '\u25cf' : esc(sc.status || '')}</td></tr>`;
  });

  // health / audit (same checks as the panel, rendered statically with links to #fn anchors)
  const hNodes = Object.values(g.nodes || {});
  const hById = {}, hByAny = {};
  hNodes.forEach((n) => { if (n.id) hById[String(n.id)] = n; [n.name, n.api_name, n.display_name].forEach((k) => { if (k) hByAny[String(k).toLowerCase()] = n; }); });
  const hLink = (n) => `<a href="#${fnAnchor(n.api_name)}">${esc(n.display_name || n.name)}</a>`;
  const hOrph = hNodes.filter((n) => n.dead_suspect).sort((a, b) => (a.display_name || a.name || '').localeCompare(b.display_name || b.name || ''));
  const hUnres = hNodes.filter((n) => n.unresolved && n.unresolved.length);
  const hAmbig = hNodes.filter((n) => n.ambiguous && n.ambiguous.length);
  // Informational rankings, deliberately kept out of the issue total below: they are not defects.
  const hStat = hNodes.filter((n) => n.stats && n.stats.lines);
  const hBig = hStat.slice().sort((a, b) => b.stats.lines - a.stats.lines).slice(0, 15);
  const hChatty = hStat.filter((n) => n.stats.apiCalls > 0).sort((a, b) => b.stats.apiCalls - a.stats.apiCalls).slice(0, 15);
  const hBroken = [];
  wfs.forEach((w) => { if (!w.detail) return; (w.detail.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter(isFnAction).forEach((a) => { if (!(hById[String(a.id)] || hByAny[(a.name || '').toLowerCase()])) hBroken.push({ kind: 'workflow', id: w.id, name: w.name, fn: a.name }); }); }); });
  scheds.forEach((sc) => { if (!(hById[String(sc.function_id)] || hByAny[(sc.function_name || '').toLowerCase()])) hBroken.push({ kind: 'schedule', id: sc.id, name: sc.name, fn: sc.function_name }); });
  const hModSet = new Set(mods.map((m) => m.api_name));
  const hFK = [];
  mods.forEach((m) => { if (/__s$/.test(m.api_name || '')) return; (m.fields || []).forEach((fl) => { let t = fl.lookup; if (t && typeof t === 'object') t = t.api_name || (t.module && (t.module.api_name || t.module)) || null; if (!t || typeof t !== 'string') return; if (/__s$/.test(t)) return; if (!hModSet.has(t)) hFK.push({ module: m.api_name, field: fl.api_name || fl.label, target: t }); }); });
  const hSec = (title, count, desc, rows, bad) => `<div class="hxsec"><h3>${esc(title)} <span class="hxn ${count ? (bad ? 'bad' : 'warn') : 'ok'}">${count}</span></h3>${desc ? `<p class="hxd">${desc}</p>` : ''}${count ? rows : '<p class="hxnone">None</p>'}</div>`;
  const healthHtml =
    `<div class="hxcov"><b>Coverage.</b> Analyzed: function\u2192function calls, workflows, schedules, and each function's <i>associated_place</i> (blueprint, button, \u2026). <b>Not</b> analyzed: custom client scripts, approval/assignment/scoring rules. Items are <b>candidates to review</b>, never automatic deletions.</div>`
    + hSec(MSG.hOrphan, hOrph.length, 'No caller in code, not REST, no associated_place.', hOrph.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.namespace || '')}</span></div>`).join(''))
    + hSec(MSG.hUnresolved, hUnres.length, 'Calls a function that does not resolve in this workspace.', hUnres.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.unresolved.join(', '))}</span></div>`).join(''), true)
    + hSec(MSG.hAmbiguous, hAmbig.length, 'A call matches more than one function.', hAmbig.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${esc(n.ambiguous.join(', '))}</span></div>`).join(''))
    + hSec(MSG.hBroken, hBroken.length, 'A workflow/schedule references a function not in this workspace.', hBroken.map((b) => `<div class="hxrow">${esc(b.kind)} <a href="#${b.kind === 'workflow' ? wfAnchor(b.id) : schAnchor(b.id)}">${esc(b.name || '?')}</a> <span class="hxm">\u2192 missing \u00ab${esc(b.fn || '?')}\u00bb</span></div>`).join(''), true)
    + hSec(MSG.hMissingRefs, hFK.length, 'A lookup points to a module not in this workspace.', hFK.map((r) => `<div class="hxrow"><b>${esc(r.module)}</b>.${esc(r.field)} <span class="hxm">\u2192 ${esc(r.target)}</span></div>`).join(''))
    + hSec(MSG.hBiggest, hBig.length, MSG.hBiggestDesc, hBig.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${n.stats.lines} lines \u00b7 ${n.stats.codeLines} code \u00b7 ${(n.stats.chars / 1024).toFixed(1)} KB</span></div>`).join(''))
    + hSec(MSG.hChattiest, hChatty.length, 'invokeurl, zoho.crm and other Zoho service tasks, counted outside comments and strings.', hChatty.map((n) => `<div class="hxrow">${hLink(n)} <span class="hxm">${n.stats.apiCalls} calls - ${n.stats.invokeurl} invokeurl \u00b7 ${n.stats.crm} zoho.crm \u00b7 ${n.stats.zoho} other${n.stats.sendmail ? ' \u00b7 ' + n.stats.sendmail + ' sendmail' : ''}</span></div>`).join(''))
    ;
  const healthTotal = hOrph.length + hUnres.length + hAmbig.length + hBroken.length + hFK.length;

  // Contents index: informative tables (one row per item) for functions and modules
  const fnRows = [];
  Object.keys(byNs).sort().forEach((ns) => {
    byNs[ns].slice().sort(byField('api_name')).forEach((f) => {
      const n = nodeByApi[f.api_name];
      fnRows.push(`<tr><td><a href="#${fnAnchor(f.api_name)}">${esc(f.display_name || f.api_name)}</a></td>`
        + `<td class="mono">${esc(f.api_name)}</td><td class="mono">${esc(ns)}</td>`
        + `<td class="ct">${f.rest ? '\u25cf' : ''}</td><td class="ct">${f.downloaded ? '' : '\u2014'}</td>`
        + `<td class="ct">${n ? n.calls.length : 0}</td><td class="ct">${n ? n.called_by.length : 0}</td>`
        + `<td class="ct">${f.stats ? f.stats.lines : ''}</td><td class="ct">${f.stats ? f.stats.apiCalls : ''}</td></tr>`);
    });
  });
  const modRows = [];
  ['Standard', 'Custom'].forEach((k) => groups[k].slice().sort(byField('api_name')).forEach((m) => {
    const rb = (modRefs && modRefs[m.api_name]) ? modRefs[m.api_name].length : 0;
    modRows.push(`<tr><td><a href="#${modAnchor(m.api_name)}">${esc(m.plural_label || m.singular_label || m.module_name || m.api_name)}</a></td>`
      + `<td class="mono">${esc(m.api_name)}</td><td class="mono">${esc(m.module_name || '')}</td>`
      + `<td class="ct">${k}</td><td class="ct">${(m.fields || []).length ? (m.fields || []).length : (m.unreadable ? `<span title="${escA(moduleRefusal(m.unreadable).text)}">not described</span>` : 0)}</td><td class="ct">${rb}</td></tr>`);
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
      const users = (actUsers && actUsers.get(a.kind + ':' + String(a.id))) || [];
      const detail = a.kind === 'email_notifications'
        ? [a.template ? 'template: ' + esc(a.template.name || a.template.id) : '',
           a.from_type ? 'from: ' + (scope.addresses && a.from_address ? esc(a.from_address) : esc(a.from_type === 'user' ? 'a user address' : 'an organisation address')) : '',
           a.recipient_count != null ? esc(String(a.recipient_count)) + ' recipient(s)' : ''].filter(Boolean).join(' \u00b7 ')
        : a.kind === 'field_updates' ? (a.field ? esc(a.field) + (a.field_type ? ' (' + esc(a.field_type) + ')' : '')
            + ' \u2190 ' + (actStale(a) ? 'not read by this pull' : (a.value === null || a.value === undefined) ? 'cleared' : esc(String(a.value))) : '')
        : a.kind === 'webhooks' ? [esc(a.method || ''), esc(a.url || '')].filter(Boolean).join(' ')
        : a.kind === 'tasks' && actKept(a) ? esc(KEPT_DETAIL)
        : a.kind === 'tasks' && actThin(a) ? esc(MISS_DETAIL)
        : a.notify === true ? 'notifies' : '';
      return '<tr><td>' + esc(a.name || a.id) + '</td><td>' + esc(actionKindLabel(a.kind)) + '</td><td>' + esc(a.module || '') + '</td>'
        + '<td class="num">' + users.length + '</td><td>' + users.map((w) => esc(w.name || w.id)).join(', ') + '</td><td>' + detail + '</td></tr>';
    });
  const actHtml = acts.length
    ? '<p class="hxd">What a workflow rule fires, and which rules fire it. \u00abFired by\u00bb is read from the rules in this workspace, so a rule that was never pulled cannot appear in it.</p>'
      + ((actWithheld && !scope.addresses) ? `<p class="note">${actWithheld} sender address(es) withheld - that section was left off. Nothing else about those notifications is missing.</p>` : '')
      + `<table class="ftbl"><thead><tr><th>Action</th><th>Kind</th><th>Module</th><th>Rules</th><th>Fired by</th><th>Detail</th></tr></thead><tbody>${actRows.join('')}</tbody></table>`
    : '';
  const connHtml = conns.length
    ? `<p class="hxd">The org's connections and the functions that use each - the join key is the name in <code>invokeurl […connection:"…"]</code>.</p><table class="ftbl"><thead><tr><th>Connection</th><th>Label</th><th>Connector</th><th>Status</th><th>Uses</th><th>Used by functions</th></tr></thead><tbody>${connRows.join('')}</tbody></table>`
    : '<p class="empty">No connections in this export.</p>';
  // Failures. A chapter that says *when it was read* in its own heading, because unlike every other
  // one here it is a reading of a runtime rather than of a structure - a report that presented it as
  // durable would be claiming something the data cannot support.
  const failRows = (fails.failures || []).slice().sort((a, b) => (b.count - a.count) || String(b.lastFailedAt || '').localeCompare(String(a.lastFailedAt || '')));
  const failHtml = failRows.length || fails.usage ? (
    `<p class="note">Read from Zoho on ${esc(fails.at ? new Date(fails.at).toLocaleString() : 'an unknown date')}. `
    + (fails.usage
        ? `In the 24 hours before that: ${esc(String(fails.usage.success ?? 'unknown'))} run(s), ${esc(String(fails.usage.failure ?? 'unknown'))} failed. `
        : '')
    + (fails.capped ? esc(FAIL_CAPPED) + ' ' : '')
    + 'The input of each failed execution stays in Zoho - Zoost does not read it.</p>'
    + (failRows.length
        ? '<table><thead><tr><th>Function</th><th>Invoked by</th><th>Times</th><th>Last failure</th><th>Reason</th></tr></thead><tbody>'
          + failRows.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.componentType || '')}</td><td>${esc(String(f.count))}</td>`
              + `<td>${esc(f.lastFailedAt ? new Date(f.lastFailedAt).toLocaleString() : '')}</td><td>${esc(f.reason || '')}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p class="empty">Nothing had failed when this was read.</p>')
  ) : '';
  const toc = `<nav class="toc"><h2>Contents</h2>`
    + `<h3 class="toch">Functions (${fns.length})</h3>`
    + `<table class="toctbl"><thead><tr><th>Function</th><th>API name</th><th>Namespace</th><th>REST</th><th>DL</th><th>Uses</th><th>Used by</th><th title="source lines">Lines</th><th title="invokeurl + Zoho service tasks">Calls</th></tr></thead><tbody>${fnRows.join('') || '<tr><td colspan="9" class="none">none</td></tr>'}</tbody></table>`
    + `<h3 class="toch">Modules (${mods.length})</h3>`
    + `<table class="toctbl"><thead><tr><th>Module</th><th>API name</th><th>Generated</th><th>Kind</th><th>Fields</th><th>Ref by</th></tr></thead><tbody>${modRows.join('') || '<tr><td colspan="6" class="none">none</td></tr>'}</tbody></table>`
    + (wfs.length ? `<h3 class="toch">Workflows (${wfs.length})</h3><table class="toctbl"><thead><tr><th>Workflow</th><th>Module</th><th>Trigger</th><th>Active</th><th>Fn calls</th><th title="Actions that do not run immediately">Scheduled</th><th>Last run</th></tr></thead><tbody>${wfRows.join('')}</tbody></table>` : '')
    + (scheds.length ? `<h3 class="toch">Schedules (${scheds.length})</h3><table class="toctbl"><thead><tr><th>Schedule</th><th>Function</th><th>Frequency</th><th>Status</th></tr></thead><tbody>${schRows.join('')}</tbody></table>` : '')
    + (allRels.length ? `<h3 class="toch">Relations (${allRels.length})</h3><div class="tochx"><a href="#relations">Relation-first catalogue - related-list API names for Deluge</a></div>` : '')
    + (acts.length ? `<h3 class="toch">Actions (${acts.length})</h3><div class="tochx"><a href="#actions">Notifications, field updates, tasks and webhooks - and which rules fire each</a></div>` : '')
    + (conns.length ? `<h3 class="toch">Connections (${conns.length})</h3><div class="tochx"><a href="#connections">Catalogue - connectors, status, and which functions use each</a></div>` : '')
    + (failRows.length ? `<h3 class="toch">Failures (${failRows.length})</h3><div class="tochx"><a href="#failures">What is breaking, as read on ${esc(fails.at ? new Date(fails.at).toLocaleDateString() : 'an unknown date')}</a></div>` : '')
    + (scope.health ? `<h3 class="toch">Health <span class="cnt">${healthTotal}</span></h3><div class="tochx"><a href="#health">Orphans ${hOrph.length} \u00b7 Unresolved ${hUnres.length} \u00b7 Ambiguous ${hAmbig.length} \u00b7 Broken ${hBroken.length} \u00b7 Missing FK ${hFK.length}</a></div>` : '')
    + `</nav>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(PRODUCT_NAME)} - ${esc(ws.label || ws.instance || 'Export')}</title>`
    + `<meta name="author" content="${escA(PRODUCT_AUTHOR)}"><meta name="generator" content="${escA(PRODUCT_NAME)}"><meta name="description" content="Export of Zoho CRM Deluge functions and module schema.">${PRODUCT_URL ? `<link rel="canonical" href="${escA(PRODUCT_URL)}">` : ''}`
    + `<style>${EXPORT_CSS}</style></head><body>`
    + `<header><h1>${esc(PRODUCT_NAME)} - Export</h1>`
    + `<div class="meta">${ws.label ? `${esc(ws.label)} · ` : ''}${esc(ws.instance || '')} · org ${esc(ws.org || '')} · ${esc(envOf(ws.base))} · ${esc(now)} · ${fns.length} functions · ${mods.length} modules · contents: ${esc(SCOPE_KEYS.filter((k) => scope[k]).join(', ') || 'nothing')}${scope.code ? '' : ' · source code excluded'}</div>`
    + `<div class="meta">Data read from Zoho: ${esc(freshnessLine())}</div>`
    + `<input id="q" placeholder="Filter functions & modules…" oninput="filt()"></header>`
    + `<main>${toc}<h2 id="functions">Functions</h2>${fnHtml || '<p class="empty">No functions.</p>'}<h2 id="modules">Modules</h2>${modHtml || '<p class="empty">No modules.</p>'}<h2 id="relations">Relations</h2>${relHtml}${wfs.length ? `<h2 id="workflows">Workflows</h2>${wfHtml}` : ''}${scheds.length ? `<h2 id="schedules">Schedules</h2>${schHtml}` : ''}${acts.length ? `<h2 id="actions">Actions</h2>${actHtml}` : ''}${conns.length ? `<h2 id="connections">Connections</h2>${connHtml}` : ''}${failHtml ? `<h2 id="failures">Failures</h2>${failHtml}` : ''}${scope.health ? `<h2 id="health">Health</h2>${healthHtml}` : ''}</main>`
    + `<footer><div>Generated by ${PRODUCT_URL ? `<a href="${escA(PRODUCT_URL)}">${esc(PRODUCT_NAME)}</a>` : esc(PRODUCT_NAME)} · Created by ${esc(PRODUCT_AUTHOR)}${SPONSOR_URL ? ` · <a href="${escA(SPONSOR_URL)}">Sponsor</a>` : ''}${KOFI_URL ? ` · <a href="${escA(KOFI_URL)}">\u2615 Ko-fi</a>` : ''}</div><div class="legal">${esc(LEGAL_DISCLAIMER)}</div></footer>`
    + `<script>function filt(){var q=document.getElementById('q').value.trim().toLowerCase();document.querySelectorAll('.item').forEach(function(s){s.style.display=(!q||s.dataset.name.indexOf(q)>=0)?'':'none';});document.querySelectorAll('tr.relrow').forEach(function(r){r.style.display=(!q||r.dataset.name.indexOf(q)>=0)?'':'none';});}<\/script></body></html>`;
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
    const d = metaById.get(String(e.id)); let code = '';
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
    list.forEach((a) => { if (!a || !a.type) return; const k = a.type + ':' + String(a.id);
      if (!actUsers.has(k)) actUsers.set(k, []);
      if (!actUsers.get(k).some((x) => String(x.id) === String(w.id))) actUsers.get(k).push({ id: w.id, name: w.name }); });
  }));
  return { fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers };
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
  const nodes = scope.functions ? ((g && g.nodes) || {}) : {};
  const fnList = Object.values(nodes).sort((a, b) => (a.namespace + '.' + a.name).localeCompare(b.namespace + '.' + b.name));
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const inst = (bound && bound.instance) || 'workspace', org = (bound && bound.org) || '?', env = bound ? envOf(bound.base) : '?';
  const first = (t) => (t || '').split('\n')[0].slice(0, 120);
  const params = (n) => '(' + ((n.params || []).map((p) => (p && (p.name || p.param_name)) || p).filter(Boolean).join(', ')) + ')';
  const wfFns = (w) => { const out = []; const det = w.detail; if (det) (det.conditions || []).forEach((c) => { const acts = []; if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions); (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || []))); acts.filter(isFnAction).forEach((a) => out.push(a.name)); }); return [...new Set(out)]; };
  let md = '# Zoho CRM Deluge - Workspace export (AI context)\n\n';
  if (bound && bound.label) md += `- Workspace: ${bound.label}\n`;
  md += `- Instance: ${inst}\n- Org: ${org}\n- Environment: ${env}\n- Generated: ${now}\n- Functions: ${fnList.length} \u00b7 Modules: ${mods.length} \u00b7 Workflows: ${wfs.length} \u00b7 Schedules: ${scheds.length}\n`;
  md += `- Data read from Zoho: ${freshnessLine()}\n\n`;
  md += `- Contents: ${SCOPE_KEYS.filter((k) => scope[k]).join(', ') || 'nothing'}\n\n`;
  md += '> Self-contained, read-only snapshot of this Zoho CRM org\'s Deluge functions, module schema, and automations. Intended as context for an AI assistant used outside the extension.\n\n';
  md += '## Index\n\n### Functions\n';
  fnList.forEach((n) => { const used = [...new Set((n.associated_place || []).map((p) => p._type).filter(Boolean))]; md += `- \`${n.namespace}.${n.name}\`${params(n)}${n.return_type ? ' \u2192 ' + n.return_type : ''}${n.rest ? ' \u00b7 REST' : ''}${used.length ? ' \u00b7 used in ' + used.join('/') : ''}${n.stats ? ` \u00b7 ${n.stats.lines} lines \u00b7 ${n.stats.apiCalls} API call(s)` : ''}${n.description ? ' - ' + first(n.description) : ''}\n`; });
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
  if (fnList.length) md += `\n---\n\n## Functions${scope.code ? ' (full source)' : ' (signatures only - source code excluded from this export)'}\n\n`;
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
    md += scope.code ? ('\n```deluge\n' + String(n.source_code || '').replace(/```/g, '`\u200b``') + '\n```\n\n') : '\n';
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
  if (rels.length && scope.relations) {
    md += '---\n\n## Relations (related lists)\n\n';
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
  if (mods.length) md += '---\n\n## Modules (schema)\n\n';
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
  if (mdStat.length) {
    md += '---\n\n## Size and outbound calls\n\nPlain counts, no threshold and no verdict: length is verbosity, not complexity, and each outbound call is work Zoho meters. Calls are counted outside comments and string literals. Interpretation is the reader\'s.\n\n';
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
  if (acts.length) {
    const withheld = acts.filter((a) => a.from_address).length;
    md += '---\n\n## Actions\n\nWhat a workflow rule fires: notifications, field updates, tasks and webhooks. Each exists on its own in Zoho and is reused across rules. "Fired by" is read from the rules in this workspace.\n\n';
    if (withheld && !scope.addresses) md += `> ${withheld} sender address(es) withheld - that section was left off. Nothing else about those notifications is missing.\n\n`;
    md += '| Action | Kind | Module | Rules | Fired by | Detail |\n|---|---|---|---|---|---|\n';
    acts.slice().sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || byField('name')(a, b)).forEach((a) => {
      const users = (d.actUsers && d.actUsers.get(a.kind + ':' + String(a.id))) || [];
      const detail = a.kind === 'email_notifications'
        ? [a.template ? 'template ' + (a.template.name || a.template.id) : '',
           a.from_type ? 'from ' + ((scope.addresses && a.from_address) || (a.from_type === 'user' ? 'a user address' : 'an organisation address')) : '',
           a.recipient_count != null ? a.recipient_count + ' recipient(s)' : ''].filter(Boolean).join(' - ')
        : a.kind === 'field_updates' ? (a.field ? `${a.field}${a.field_type ? ' (' + a.field_type + ')' : ''} <- ${actStale(a) ? 'not read by this pull' : (a.value === null || a.value === undefined) ? 'cleared' : a.value}` : '')
        : a.kind === 'webhooks' ? [a.method || '', a.url || ''].filter(Boolean).join(' ')
        : a.kind === 'tasks' && actKept(a) ? KEPT_DETAIL
        : a.kind === 'tasks' && actThin(a) ? MISS_DETAIL
        : a.notify === true ? 'notifies' : '';
      md += `| ${_mdCell(a.name || a.id)} | ${_mdCell(actionKindLabel(a.kind))} | ${_mdCell(a.module || '')} | ${users.length} | ${_mdCell(users.map((w) => w.name || w.id).join(', '))} | ${_mdCell(detail)} |\n`;
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
    if (fails.capped) md += ' ' + FAIL_CAPPED;
    md += ' The input of each failed execution stays in Zoho - Zoost does not read it.\n\n';
    if (failRows.length) {
      md += '| function | invoked by | times | last failure | reason |\n|---|---|---|---|---|\n';
      md += failRows.map((f) => `| ${_mdCell(f.name)} | ${_mdCell(f.componentType)} | ${f.count} | ${_mdCell(f.lastFailedAt)} | ${_mdCell(f.reason)} |`).join('\n') + '\n\n';
    } else {
      md += 'Nothing had failed when this was read.\n\n';
    }
    md += '| Connection | Label | Connector | Status | Uses | Used by |\n|---|---|---|---|---|---|\n';
    conns.slice().sort((a, b) => (b.uses.length - a.uses.length) || byField('name')(a, b)).forEach((c) => {
      const status = c.missing ? 'not in catalogue' : c.connected === false ? 'not connected' : 'connected';
      md += `| \`${_mdCell(c.name)}\` | ${_mdCell(c.label || '')} | ${_mdCell(c.connector || '')} | ${status} | ${c.uses.length} | ${_mdCell(c.uses.join(', '))} |\n`;
    });
    md += '\n';
  }
  md += `\n---\n\n## About this file\n\nGenerated by **${PRODUCT_NAME}**${PRODUCT_URL ? ` (${PRODUCT_URL})` : ''}, created by ${PRODUCT_AUTHOR}.\n\n${LEGAL_DISCLAIMER}\n`;
  return md;
}
async function exportMarkdown() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (!dir) return;
  const scope = await askScope(); if (!scope) return;
  try {
    await requirePerm(op.root);
    setStatus('Building AI (Markdown) export\u2026', 'busy');
    const data = await loadExportData(op);
    const md = buildExportMarkdown(data, scope);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && bound.instance) || 'workspace')}-${stamp}.md`;
    await op.write(name, md);
    setStatus(`Exported \u2192 ${name} (in your workspace folder).`, 'ok');
  } catch (e) { if (op.current()) setStatus(MSG.exportErr + e.message, 'bad'); }
}
async function exportHtml() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (!dir) return;
  const scope = await askScope(); if (!scope) return;
  try {
    await requirePerm(op.root);
    setStatus('Building HTML export\u2026', 'busy');
    const { fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers } = await loadExportData(op);
    const html = buildExportHtml(fns, mods, g, modRefs, wfs, scheds, conns, fails, acts, actUsers, scope);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && bound.instance) || 'workspace')}-${stamp}.html`;
    await op.write(name, html);
    setStatus(`Exported \u2192 ${name} (in your workspace folder).`, 'ok');
  } catch (e) { if (op.current()) setStatus(MSG.exportErr + e.message, 'bad'); }
}
