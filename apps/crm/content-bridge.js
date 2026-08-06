/*
 * content-bridge.js - ISOLATED world on the Zoho page.
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
  // The Zoho user id (zuid) is on every CRM page - a #dreZuId field (deluge runtime) and a `zuid`
  // JS global. The connections catalogue endpoint needs it. Scraped like orgId (same fragility).
  function zuid() {
    try { const el = document.getElementById('dreZuId'); const v = el && String(el.value || el.textContent || '').trim(); if (v && /^\d{6,}$/.test(v)) return v; } catch (_) {}
    try { const m = document.documentElement.innerHTML.match(/\bzuid\s*["'\s]*[:=]\s*["']?(\d{9,})/i); if (m) return m[1]; } catch (_) {}
    return null;
  }
  const context = () => ({ ok: true, origin: BASE, org: orgId(), instance: instanceName(), zuid: zuid() });

  // The /crm/... APIs want the CSRF as `crmcsrfparam=<token>`; the /deluge/ (DRE) APIs want `drepn=`.
  //
  // "Same value, different prefix" was wrong, and wrong in the way that hides itself: the two are
  // *usually* equal, so reading CT_CSRF_TOKEN for both worked right up until the day they diverged
  // and the connections pull started answering 400 INVALID_CSRF_TOKEN. Hooking setRequestHeader on
  // the page and comparing what Zoho's own UI sends against the cookie jar settled it - the deluge
  // runtime's token is the **`drecn`** cookie, and in the capture where it had rotated it was the
  // only cookie holding the value Zoho accepted.
  //
  // Note the shape of the trap, because it is the same one as the Analytics bridge from the other
  // side: the header prefix is `drepn`, the cookie is `drecn`. One letter apart, and neither is
  // derivable from the other. Find the source; never infer it from the prefix.
  const CSRF_COOKIES = {
    drepn: ['drecn'],                                          // deluge runtime
    crmcsrfparam: ['CT_CSRF_TOKEN', 'crmcsr', 'CSRF_TOKEN'],   // CRM APIs
  };
  function csrfToken(csrfPrefix) {
    const names = CSRF_COOKIES[csrfPrefix || 'crmcsrfparam'] || CSRF_COOKIES.crmcsrfparam;
    for (const n of names) { const v = cookie(n); if (v) return v; }
    // Fall back to the other family rather than sending nothing: an empty token is a guaranteed 400,
    // and before this split the shared value was right often enough to be worth trying.
    for (const n of CSRF_COOKIES.crmcsrfparam.concat(CSRF_COOKIES.drepn)) { const v = cookie(n); if (v) return v; }
    try { const el = document.getElementById('token'); if (el && el.value) return el.value; } catch (_) {}
    return '';
  }
  function headers(csrfPrefix) {
    const h = { 'X-ZCSRF-TOKEN': (csrfPrefix || 'crmcsrfparam') + '=' + csrfToken(csrfPrefix), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
    const org = orgId(); if (org) h['X-CRM-ORG'] = org;
    return h;
  }
  // A refused request is a different fact from a failed one, and the panel has to be able to tell
  // them apart: "your Zoho role does not cover this" is something the user can act on, while
  // "500 on /crm/v2/…" is not. Zoho answers 401 when the session is not entitled and 403 when the
  // profile is not - both mean *asked and refused*, neither means Zoost is broken.
  //
  // Not verified: whether Zoho ever signals a permission refusal as 200 with an error body. If it
  // does, that case will read as a normal failure here rather than being mislabelled - which is the
  // right way round for a guess we have not tested.
  function apiError(status, path, detail, code) {
    const e = new Error(status + ' on ' + path + (detail ? ' - ' + detail : '') + (code && code !== detail ? ' [' + code + ']' : ''));
    e.status = status;
    e.forbidden = status === 401 || status === 403;
    e.detail = detail || null;
    // Zoho's machine-readable reason, kept apart from the sentence. `INVALID_MODULE` is the one a
    // caller can act on; "operation cannot be performed for hidden module" is the one to show a
    // person. Nothing branches on either here - both are carried, and the caller decides.
    e.code = code || null;
    return e;
  }
  // Zoho explains itself in the body and we were throwing it away. A connections pull failing with
  // `{"errorMessage":"INVALID_CSRF_TOKEN"}` reached the user as the bare string "400 on
  // /deluge/api/…", which names the symptom and hides the one word that says what to do. Read at
  // most a short body, and only to quote it - nothing here branches on its contents.
  async function errorDetail(res) {
    try {
      const t = (await res.text()).slice(0, 400);
      const m = t.match(/"(?:errorMessage|message|error)"\s*:\s*"([^"]{1,120})"/);
      // `code` is read separately rather than added to the alternation above: it appears *first* in
      // a CRM error body, so folding it in would have made the regex return INVALID_MODULE and lose
      // the sentence - and `api()` compares this value against INVALID_CSRF_TOKEN.
      const c = t.match(/"code"\s*:\s*"([A-Z0-9_]{1,60})"/);
      return { message: m ? m[1] : null, code: c ? c[1] : null };
    } catch (_) { return { message: null, code: null }; }
  }
  // Right after a fresh login the deluge runtime rejects the very first `/deluge/` call with
  // 400 INVALID_CSRF_TOKEN, and any `/crm/` call in between makes the next attempt succeed -
  // reproduced deliberately: log out, log in, pull connections (fails), pull schedules, pull
  // connections (works). It is also why "Pull all" never showed this: functions run first.
  //
  // Which of the two explanations is true - `drecn` not yet set/refreshed, or the deluge session not
  // yet initialised server-side - is **not** established. It does not need to be: the remedy is the
  // same under both, and it is the one that was measured rather than reasoned about. So on exactly
  // that error, make one ordinary CRM call and try again, once.
  //
  // This is the "recovering by a known action" exception, not a retry loop: one attempt, only on a
  // specific error string, only for the deluge family, and the primer's own result is ignored -
  // we are after the side effect, and a user whose role refuses that endpoint is no worse off than
  // before. If the second attempt fails the original error is what the user sees.
  async function warmDeluge() {
    try {
      await fetch(BASE + '/crm/v9/settings/automation/schedules?page=1&per_page=1',
        { headers: headers(), credentials: 'include' });
    } catch (_) {}
  }
  async function api(path, csrfPrefix, retried) {
    const res = await fetch(BASE + path, { headers: headers(csrfPrefix), credentials: 'include' });
    if (res.ok) return res.json();
    const { message, code } = await errorDetail(res);
    if (!retried && csrfPrefix === 'drepn' && res.status === 400 && message === 'INVALID_CSRF_TOKEN') {
      await warmDeluge();
      return api(path, csrfPrefix, true);
    }
    throw apiError(res.status, path, message, code);
  }
  function toFile(fn, fallback) {
    const ns = fn.nameSpace || fallback?.namespace || fn.category || 'misc';
    const stem = (fn.api_name || fn.name || 'unknown').replace(/[^\w.\-]/g, '_');
    const meta = {
      id: fn.id, name: fn.name, display_name: fn.display_name, api_name: fn.api_name,
      nameSpace: fn.nameSpace, category: fn.category, source: fn.source,
      return_type: fn.return_type, params: fn.params || [],
      description: fn.description || '', updatedTime: fn.updatedTime, modified_by: fn.modified_by || null,
      associated_place: fn.associated_place ?? null, workflow: fn.workflow || '',
      rest_api: (fn.rest_api || []).map((r) => ({ type: r.type, active: r.active })),
      // Connections the function uses. connectionLinkName is the join key - the exact name that
      // appears in invokeurl [...connection:"..."], and the `name` in the org's connections catalogue.
      connections: (fn.connections || []).map((c) => ({ name: c.connectionLinkName, label: c.connectionName || c.connectionLinkName, service: c.serviceName || null, scopes: c.scopes || [] })).filter((c) => c.name),
      sv: 2,   // meta schema version - bump when new fields are captured, so old copies re-fetch (backfill)
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
  // Metadata-only list (fast, no code) - used to show all functions immediately, then download each on demand.
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
  // Workflow rules - list (metadata) and per-rule detail (conditions + actions).
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
  // Scheduled functions - the list already carries the called function {id, name}.
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
      // Why the fields did not come, when they did not. Both attempts used to be `catch {}`, so a
      // module Zoho refuses looked exactly like one that had never been pulled: zero fields, zero
      // layouts, zero related lists, and a panel saying "re-run Pull Modules to fetch them" - advice
      // that could not work, offered forever. Reported with a HAR: Invoices is hidden in that org and
      // Zoho answers 400 INVALID_MODULE, "operation cannot be performed for hidden module".
      //
      // Nothing here decides what that means. The status, Zoho's code and Zoho's own sentence are
      // written to the module file with the date they were given, in the same spirit as the per-area
      // access record: it is what was asked and what came back, not a permanent verdict.
      let fields = [], fieldsOk = false, unreadable = null;
      try { fields = (await api(`/crm/v2/settings/fields?module=${encodeURIComponent(m.api_name)}&type=all`)).fields || []; fieldsOk = true; }
      catch (e1) {
        try { fields = (await api(`/crm/v2/settings/fields?module=${encodeURIComponent(m.api_name)}`)).fields || []; fieldsOk = true; }
        catch (e2) {
          const err = e2.status ? e2 : e1;   // the second attempt drops the URL variant, not the reason
          // Only a 4xx is a refusal: Zoho understood and said no. A dropped connection or a 5xx is a
          // failure, and dating it on disk as a settled answer would be a measurement never taken.
          const st = Number(err.status) || 0;
          if (st >= 400 && st < 500) unreadable = { status: st, code: err.code || null, message: err.detail || String(err.message || err), at: new Date().toISOString() };
        }
      }
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
        // null when the module read fine. Present only when Zoho refused, and then it is the whole
        // reason the three lists below are empty.
        unreadable,
        api_name: m.api_name, module_name: m.module_name || m.api_name,
        singular_label: m.singular_label || null, plural_label: m.plural_label || null,
        id: m.id, generated_type: m.generated_type || null,
        deletable: !!m.deletable, editable: !!m.editable, creatable: !!m.creatable,
        viewable: m.viewable !== false, visible: m.visible !== false,
        api_supported: m.api_supported !== false,
        layouts: layouts,   // full layout JSON (sections, fields per layout); the panel splits this into layouts/ files
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
  // renames this class, Find stops and says so - it does not improvise.
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
  // binding we cannot invoke ourselves - "click and hope" through a private DOM contract. It was
  // removed on principle: the panel offers Find (a deterministic filter, above) and the user opens
  // the function from Zoho's own menu, reading the label in their own language.

  // Connections catalogue: the full list of the org's connections (including ones no function uses).
  // connection.name is the join key with a function's meta.connections[].name (the connectionLinkName
  // used in invokeurl [...connection:"..."]). Same host as everything else; needs the zuid.
  async function pullConnections() {
    const org = orgId(); const zu = zuid();
    if (!org) throw new Error('org id not found on the page');
    if (!zu) throw new Error('zuid not found on the page');
    const j = await api(`/deluge/api/ui/v1/${org}/services/ZohoCRM/connections?zuid=${zu}&flowNeeded=true&extentionPlatform=false`, 'drepn');
    const connections = (j.connections || []).map((c) => ({
      name: c.name, label: c.displayName || c.name,
      connector: (c.connector && c.connector.name) || null,
      connectorLabel: (c.connector && c.connector.displayName) || null,
      connected: c.isConnected !== false, createdBy: c.createdBy || null,
      scopes: c.scopes || [], id: c.id || null,
    })).filter((c) => c.name);
    return { total: connections.length, connections };
  }

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
  // An Error does not survive chrome.runtime messaging - it arrives as a plain object, and
  // `String(e)` throws away everything except the text. That is the boundary trap CLAUDE.md is about:
  // `forbidden` would be lost exactly here, and the panel would go back to guessing from a string.
  // So every handler replies through this, and the two facts travel as their own fields.
  const fail = (send) => (e) => send({ ok: false, error: String(e && e.message || e), status: (e && e.status) || 0,
    forbidden: !!(e && e.forbidden), code: (e && e.code) || null, detail: (e && e.detail) || null });

    if (msg?.cmd === 'context') { const c = context(); if (/^https:\/\/crm(sandbox)?\.zoho/.test(c.origin || '') && c.instance) sendResponse(c); return; }   // only the real CRM APP frame answers (CRM origin + a resolved instance) - skips wrapper service frames
    if (msg?.cmd === 'pullAll') { pullAll().then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'listFunctions') { listFunctions().then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'listWorkflows') { listWorkflows().then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'fetchWorkflow') { fetchWorkflow(msg.id).then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'workflowUsage') { workflowUsage(msg.id, msg.from, msg.till).then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'listSchedules') { listSchedules().then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'fetchModuleFields') { fetchModuleFields(msg.apiName).then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'fetchOne') { fetchOne(msg.id, msg.category, msg.source).then((file) => sendResponse({ ok: true, file })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'pullModules') { pullModules().then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'pullConnections') { pullConnections().then((r) => sendResponse({ ok: true, ...r })).catch(fail(sendResponse)); return true; }
    if (msg?.cmd === 'fillSearch') { sendResponse(fillSearch(msg.name)); return; }
    if (msg?.cmd === 'listReady') { sendResponse({ ready: !!findSearchInput() }); return; }
  });

  console.debug('[zoost] bridge active on', BASE, '· instance', instanceName(), '· org', orgId());
})();
