/*
 * content-bridge.js — ISOLATED world on the Zoho page.
 * Wrapped in a guard so it is safe to (re)inject via chrome.scripting.
 */
(function () {
  if (window.__zoostBridge) { return; }
  window.__zoostBridge = true;

  const PAGE = 50;
  const BASE = location.origin;
  const cookie = (n) => document.cookie.split('; ').find((c) => c.startsWith(n + '='))?.split('=')[1];

  function instanceName() {
    const p = location.pathname.split('/').filter(Boolean);   // e.g. ['crm','yourinstance','tab','Contacts']
    const i = p.indexOf('crm');
    const cand = i >= 0 ? p[i + 1] : (p[0] === 'crm' ? p[1] : null);
    return (cand && !/^v\d/.test(cand) && cand !== 'org') ? cand : null;   // skip API version / org-prefixed forms
  }
  function orgId() {
    // The CRM org id is the zgid / crmZgid. Do NOT fall back to a generic "orgId":
    // on some pages that is an embedded ASAP/help-portal id (e.g. ASAP_ORGID), not the CRM org.
    try {
      const html = document.documentElement.innerHTML;
      const m = html.match(/(?:crmZgid|["']?zgid["']?)["'\s]*[,:=]["'\s]*(\d{9,})/);
      if (m) return m[1];
    } catch (_) {}
    return null;
  }
  const context = () => ({ ok: true, origin: BASE, org: orgId(), instance: instanceName() });

  function headers() {
    const csrf = cookie('CT_CSRF_TOKEN') || cookie('crmcsr') || cookie('CSRF_TOKEN');
    const h = { 'X-ZCSRF-TOKEN': 'crmcsrfparam=' + (csrf || ''), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
    const org = orgId(); if (org) h['X-CRM-ORG'] = org;
    return h;
  }
  async function api(path) {
    const res = await fetch(BASE + path, { headers: headers(), credentials: 'include' });
    if (!res.ok) throw new Error(res.status + ' on ' + path);
    return res.json();
  }
  function toFile(fn, fallback) {
    const ns = fn.nameSpace || fallback?.namespace || fn.category || 'misc';
    const stem = (fn.api_name || fn.name || 'unknown').replace(/[^\w.\-]/g, '_');
    const meta = {
      id: fn.id, name: fn.name, display_name: fn.display_name, api_name: fn.api_name,
      nameSpace: fn.nameSpace, category: fn.category, source: fn.source,
      return_type: fn.return_type, params: fn.params || [],
      description: fn.description || '', updatedTime: fn.updatedTime,
      associated_place: fn.associated_place ?? null, workflow: fn.workflow || '',
      rest_api: (fn.rest_api || []).map((r) => ({ type: r.type, active: r.active })),
    };
    return { folder: ns.replace(/[^\w.\-]/g, '_'), stem, dg: fn.script || fn.workflow || '', meta };
  }
  async function pullAll() {
    let start = 1, raw = [];
    while (true) {
      const page = (await api(`/crm/v2/settings/functions?type=org&start=${start}&limit=${PAGE}&language=deluge`)).functions || [];
      raw = raw.concat(page); if (page.length < PAGE) break; start += PAGE;
    }
    const all = raw.filter((f) => f.source !== 'extension'); const files = [];
    for (let i = 0; i < all.length; i++) {
      const f = all[i];
      try {
        const d = await api(`/crm/v2/settings/functions/${f.id}?category=${encodeURIComponent(f.category)}&language=deluge&source=${encodeURIComponent(f.source)}`);
        const fn = (d.functions || [])[0]; if (fn) files.push(toFile(fn, { namespace: f.workflow?.namespace || f.category }));
      } catch (_) {}
      chrome.runtime.sendMessage({ type: 'pullProgress', done: i + 1, total: all.length }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
    return { total: raw.length, readable: all.length, skipped: raw.length - all.length, files };
  }
  // Metadata-only list (fast, no code) — used to show all functions immediately, then download each on demand.
  async function listFunctions() {
    let start = 1, raw = [];
    while (true) {
      const page = (await api(`/crm/v2/settings/functions?type=org&start=${start}&limit=${PAGE}&language=deluge`)).functions || [];
      raw = raw.concat(page); if (page.length < PAGE) break; start += PAGE;
    }
    const all = raw.filter((f) => f.source !== 'extension');
    const entries = all.map((f) => ({
      id: String(f.id), api_name: f.api_name, name: f.name, display_name: f.display_name || f.api_name,
      namespace: (f.workflow && f.workflow.namespace) || f.category || 'misc',
      category: f.category, source: f.source,
      rest: (f.rest_api || []).some((r) => r.active),
    }));
    return { total: raw.length, readable: all.length, skipped: raw.length - all.length, entries };
  }
  // Workflow rules — list (metadata) and per-rule detail (conditions + actions).
  async function listWorkflows() {
    let page = 1, raw = [], capped = false;
    while (true) {
      const resp = await api(`/crm/v8/settings/automation/workflow_rules?page=${page}&per_page=200`);
      const rules = resp.workflow_rules || []; raw = raw.concat(rules);
      const info = resp.info || {}; if (!info.more_records || rules.length === 0) break; page++;
      if (page > 20) { capped = true; break; }   // surfaced to the panel instead of stopping in silence
    }
    const entries = raw.map((r) => ({
      id: String(r.id), name: r.name, description: r.description || '',
      module: (r.module && r.module.api_name) || '', module_id: (r.module && r.module.id) || '',
      type: (r.execute_when && r.execute_when.type) || '', active: !!(r.status && r.status.active), source: r.source || '',
    }));
    return { total: raw.length, entries, capped };
  }
  async function fetchWorkflow(id) {
    const resp = await api(`/crm/v8/settings/automation/workflow_rules/${id}`);
    const rule = (resp.workflow_rules || [])[0]; if (!rule) throw new Error('not found');
    return { rule };
  }
  async function workflowUsage(id, fromD, tillD) {
    const resp = await api(`/crm/v8/settings/automation/workflow_rules/${id}/actions/usage?executed_from=${fromD}&executed_till=${tillD}&include_inner_details=related_details.sent_percentage`);
    return { usage: (resp.workflow_rules || [])[0] || null };
  }
  // Scheduled functions — the list already carries the called function {id, name}.
  async function fetchModuleFields(apiName) {
    const fr = await api(`/crm/v2/settings/fields?module=${encodeURIComponent(apiName)}&type=all`);
    return { fields: fr.fields || [] };
  }
  async function listSchedules() {
    let page = 1, raw = [], capped = false;
    while (true) {
      const resp = await api(`/crm/v9/settings/automation/schedules?page=${page}&per_page=200`);
      const s = resp.schedules || []; raw = raw.concat(s);
      const info = resp.info || {}; if (!info.more_records || s.length === 0) break; page++; if (page > 20) { capped = true; break; }
    }
    const entries = raw.map((s) => ({
      id: String(s.id), name: s.name, status: s.status,
      function_id: (s.function && String(s.function.id)) || '', function_name: (s.function && s.function.name) || '',
      frequency: (s.frequency && s.frequency.type) || '', next: s.next_execution_time || null, last: s.last_execution_time || null,
    }));
    return { total: raw.length, entries, capped };
  }
  async function fetchOne(id, category, source) {
    const q = []; if (category) q.push('category=' + encodeURIComponent(category)); q.push('language=deluge'); if (source) q.push('source=' + encodeURIComponent(source));
    const d = await api(`/crm/v2/settings/functions/${id}?${q.join('&')}`); const fn = (d.functions || [])[0];
    return fn ? toFile(fn) : null;
  }

  async function pullModules() {
    const mods = (await api('/crm/v2/settings/modules')).modules || [];
    const out = [];
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i]; if (!m.api_name) continue;
      let fields = [], fieldsOk = false;
      try { fields = (await api(`/crm/v2/settings/fields?module=${encodeURIComponent(m.api_name)}&type=all`)).fields || []; fieldsOk = true; }
      catch { try { fields = (await api(`/crm/v2/settings/fields?module=${encodeURIComponent(m.api_name)}`)).fields || []; fieldsOk = true; } catch {} }
      let layouts = [];
      // Only real record modules have layouts. Exact call the CRM UI uses (verified via HAR):
      // v2.2 with the comma URL-encoded (id%2Cstatus) returns every layout WITH full sections/fields.
      if (fieldsOk) { try { layouts = (await api(`/crm/v2.2/settings/layouts?module=${encodeURIComponent(m.api_name)}&fields=id%2Cstatus`)).layouts || []; } catch (_) {} }
      // Related lists. The API name of a related list is NOT the api_name of the target module:
      // it is what zoho.crm.getRelatedRecords() / the REST /{module}/{id}/{related_list} path expect.
      let related = [];
      if (fieldsOk) {
        try {
          const rl = (await api(`/crm/v2/settings/related_lists?module=${encodeURIComponent(m.api_name)}`)).related_lists || [];
          related = rl.map((r) => ({
            api_name: r.api_name || r.name || null,
            label: r.display_label || r.name || r.api_name || null,
            module: (r.module && (r.module.api_name || (typeof r.module === 'string' ? r.module : null))) || null,
            type: r.type || null,
            visible: r.visible !== false,
            connected_module: (r.connectedmodule && (r.connectedmodule.api_name || r.connectedmodule)) || null,
            linking_module: (r.linking_module && (r.linking_module.api_name || r.linking_module)) || null,
            id: r.id || null, src: 'api',
          })).filter((r) => r.api_name);
        } catch (_) {
          // Fallback: the endpoint the CRM UI itself uses (rellistsysrefname == related list API name).
          try {
            const inst = instanceName();
            if (inst) {
              const j = await api(`/crm/${inst}/EntityFieldCustomize.do?module=${encodeURIComponent(m.module_name || m.api_name)}&isDeveloperSpace=true&isRelatedList=true`);
              const k = Object.keys(j || {})[0];
              related = (((j || {})[k] || {}).RelatedList || []).map((r) => ({
                api_name: r.rellistsysrefname || null, label: r.rellistlabel || null, module: null,
                type: r.isCustom ? 'custom' : 'default', visible: r.isVisible !== false,
                connected_module: null, linking_module: null, id: r.rellistid || null, src: 'ui',
              })).filter((r) => r.api_name);
            }
          } catch (_) {}
        }
      }
      out.push({
        related_lists: related,
        api_name: m.api_name, module_name: m.module_name || m.api_name,
        singular_label: m.singular_label || null, plural_label: m.plural_label || null,
        id: m.id, generated_type: m.generated_type || null,
        deletable: !!m.deletable, editable: !!m.editable, creatable: !!m.creatable,
        viewable: m.viewable !== false, visible: m.visible !== false,
        api_supported: m.api_supported !== false,
        layouts: layouts,   // full layout JSON (sections, fields per layout); the panel splits this into _layouts/ files
        fields: fields.map((f) => ({
          api_name: f.api_name, label: f.field_label || f.display_label || f.api_name, data_type: f.data_type,
          length: f.length || null, custom: !!f.custom_field,
          mandatory: !!(f.system_mandatory || f.required || f.mandatory),
          lookup: f.lookup && f.lookup.module ? (f.lookup.module.api_name || (typeof f.lookup.module === 'string' ? f.lookup.module : null)) : null,
          picklist: (f.pick_list_values || []).map((p) => p.display_value || p.actual_value).filter(Boolean),
          id: f.id,
        })),
      });
      chrome.runtime.sendMessage({ type: 'pullProgress', done: i + 1, total: mods.length }).catch(() => {});
      await new Promise((r) => setTimeout(r, 80));
    }
    return { total: mods.length, modules: out };
  }
  // Functions-list search box (Lyte input.searchBar, maxlength=20). ONLY the stable, language-
  // independent class selector. We do not fall back to matching the placeholder text: that is
  // localized, and guessing from it is exactly the "try and hope" this tool refuses. If Zoho
  // renames this class, Find stops and says so — it does not improvise.
  function findSearchInput() {
    return document.querySelector('input.searchBar');
  }
  function setSearch(input, term) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, term);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: term.slice(-1) || 'a' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fillSearch(name) {
    const input = findSearchInput(); if (!input) return { ok: false, reason: 'search input not found' };
    const term = String(name).slice(0, 20); setSearch(input, term); return { ok: true, term };
  }
  // The old "open the function in the Zoho editor" path lived here. It drove Zoho's DOM: it found
  // the row by matching text/attributes, fired synthetic pointer/mouse click chains on several
  // ancestors hoping a framework handler would catch, waited for a popup, then clicked a link
  // matched by its localized label ("Modifica funzione" / "Edit function"). Even with a stable
  // selector (data-zcqa="cf_editFunction") the final step is a synthetic click that triggers a Lyte
  // binding we cannot invoke ourselves — "click and hope" through a private DOM contract. It was
  // removed on principle: the panel offers Find (a deterministic filter, above) and the user opens
  // the function from Zoho's own menu, reading the label in their own language.

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d && d.source === 'DELUGE_IDE_HOOK' && d.type === 'saved') chrome.runtime.sendMessage({ type: 'saved', id: d.id }).catch(() => {});
  });
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    // Only a real CRM-origin frame acts. With all_frames:true the scripts also load into sandboxed /
    // null-origin iframes (location.origin === 'null'), where fetch(BASE + path) becomes a relative,
    // malformed URL (…/null/crm/v2/…) → 400. Those frames must stay silent so the real CRM frame answers.
    if (!/^https:\/\/crm(sandbox)?\.zoho/.test(location.origin)) return false;
    if (msg?.cmd === 'context') { const c = context(); if (/^https:\/\/crm(sandbox)?\.zoho/.test(c.origin || '') && c.instance) sendResponse(c); return; }   // only the real CRM APP frame answers (CRM origin + a resolved instance) — skips wrapper service frames
    if (msg?.cmd === 'pullAll') { pullAll().then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'listFunctions') { listFunctions().then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'listWorkflows') { listWorkflows().then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'fetchWorkflow') { fetchWorkflow(msg.id).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'workflowUsage') { workflowUsage(msg.id, msg.from, msg.till).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'listSchedules') { listSchedules().then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'fetchModuleFields') { fetchModuleFields(msg.apiName).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'fetchOne') { fetchOne(msg.id, msg.category, msg.source).then((file) => sendResponse({ ok: true, file })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'pullModules') { pullModules().then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e) })); return true; }
    if (msg?.cmd === 'fillSearch') { sendResponse(fillSearch(msg.name)); return; }
    if (msg?.cmd === 'listReady') { sendResponse({ ready: !!findSearchInput() }); return; }
  });

  console.debug('[zoost] bridge active on', BASE, '· instance', instanceName(), '· org', orgId());
})();
