/*
 * content-bridge.js — ISOLATED world on the Zoho Analytics page.
 * Wrapped in a guard so it is safe to (re)inject via chrome.scripting.
 *
 * Read-only, like its CRM sibling. It never creates, edits or deletes a view.
 *
 * Three differences from the CRM bridge worth knowing:
 *
 *  - **No CSRF token.** The CRM APIs reject a request without `X-ZCSRF-TOKEN`, and the /crm/ and
 *    /deluge/ families want the same token under different prefixes. The Analytics endpoints used
 *    here take none at all: session cookies plus `X-Requested-With: XMLHttpRequest` is the whole
 *    contract. Do not add a token "to be safe" — it was verified absent, and inventing one is the
 *    kind of guess that produces a 400 nobody can explain.
 *
 *  - **HTTP 200 is not success.** Analytics answers `{"status":"failure"}` with a 200, so the code
 *    alone tells you nothing. `api()` treats anything that is not an explicit success as an error.
 *
 *  - **The workspace comes from the URL, not from the page HTML.** Analytics puts it right there in
 *    /workspace/{id}, so there is nothing to scrape and nothing to be fragile about. This is also
 *    why the workspace list endpoint is not needed: the user tells us which workspace by being in
 *    it, exactly as the CRM panel takes the org from the tab it is looking at.
 */
(function () {
  if (window.__zoostAnalyticsBridge) { return; }
  window.__zoostAnalyticsBridge = true;

  const BASE = location.origin;
  const IS_ANALYTICS = /^https:\/\/analytics\.(zoho\.(eu|com|in|com\.au|jp)|zohocloud\.ca)$/.test(BASE);
  const PACE = 60;   // ms between per-item calls, so a large workspace does not hammer the host

  // /workspace/{id} and /workspace/{id}/edit/{viewId} are the two shapes that carry a workspace.
  // Anywhere else (the home page, admin, the account pages) there is simply no workspace in scope,
  // and the panel says so rather than picking one.
  function workspaceId() {
    const m = location.pathname.match(/\/workspace\/(\d{6,})\b/);
    return m ? m[1] : null;
  }
  function viewIdInUrl() {
    const m = location.pathname.match(/\/workspace\/\d{6,}\/(?:edit|view)\/(\d{6,})\b/);
    return m ? m[1] : null;
  }
  const context = () => ({ ok: true, origin: BASE, workspace: workspaceId(), view: viewIdInUrl() });

  async function api(path) {
    const res = await fetch(BASE + path, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error(res.status + ' on ' + path.split('?')[0]);
    const j = await res.json();
    if (j && j.status && String(j.status).toLowerCase() !== 'success') {
      throw new Error('Analytics returned status "' + j.status + '"' + (j.summary ? ': ' + j.summary : ''));
    }
    return j;
  }
  const ws = () => {
    const w = workspaceId();
    if (!w) throw new Error('no workspace in the current URL');
    return w;
  };
  const progress = (stage, done, total) =>
    chrome.runtime.sendMessage({ type: 'pullProgress', stage, done, total }).catch(() => {});

  // VIEWLIST answers columnar — a key array plus a row array per record — so it is zipped back into
  // objects here rather than leaving index arithmetic scattered through the panel.
  const zip = (keys, rows) => (rows || []).map((r) => {
    const o = {}; (keys || []).forEach((k, i) => { o[k] = r[i]; }); return o;
  });
  // Several fields arrive with a leading space (" 03 Jul 2025"). Trimmed on the way in.
  const text = (v) => (v == null ? '' : String(v).trim());

  // ---- workspace identity -------------------------------------------------------------------
  // The workspace name is not in VIEWLIST. DATASHEETREQUESTS carries it as data.datasheetJson.DBNAME.
  // It is a label only: the workspace's identity is its id, so renaming it in Zoho must not orphan
  // anything on disk.
  async function workspaceInfo() {
    const id = ws();
    const j = await api(`/reportsapi/DATASHEETREQUESTS?DBID=${id}&ISCREATEVIEW=false&ISSTANDALONEEDIT=false`);
    const name = text(j?.data?.datasheetJson?.DBNAME);
    return { workspace: id, name, origin: BASE };
  }

  // ---- the census ---------------------------------------------------------------------------
  async function listViews() {
    const id = ws();
    const j = await api(`/reportsapi/db/${id}/VIEWLIST?ZOHO_FOLDERLIST=true&NOCACHE=${Date.now()}`);
    const d = (j && j.data) || {};
    const views = zip(d.viewListKey, d.viewListValues);
    const folders = zip(d.folderListKey, d.folderListValues);
    const folderName = new Map(folders.map((f) => [String(f.FOLDER_ID), f.FOLD_NAME]));
    return {
      workspace: id,
      folders: folders.map((f) => ({
        id: String(f.FOLDER_ID), name: f.FOLD_NAME, description: text(f.FOLD_DESC),
        parent: f.FOL_PARID ? String(f.FOL_PARID) : null, isDefault: !!f.ISDEFAULT,
      })),
      views: views.map((v) => ({
        id: String(v.VIEW_ID), name: v.VIEW_NAME, type: v.VIEW_TYPE,
        description: text(v.VIEW_DESC),
        folder: v.FOLD_ID ? String(v.FOLD_ID) : null,
        folderName: folderName.get(String(v.FOLD_ID)) || '',
        // PARENT_ID is the view this one is built on. Every presentation view carries it and it
        // always resolves to another view in the same list, so the whole report-to-source graph
        // comes out of this one call — no per-view request needed for it.
        parent: v.PARENT_ID ? String(v.PARENT_ID) : null,
        createdText: text(v.VIEW_CREATE_TIME), createdBy: v.CREATED_BY || '',
        owner: v.OWNER_NAME || '',
        // Only one timestamp here is machine-readable. ACT_VIEW_MODTIME is epoch milliseconds and
        // tracks the *data* change. LAST_DATA_MODIFY arrives as "1 ora minuto fa" and
        // LAST_DESIGN_MODIFY as " 03 Jul 2025", both already rendered in the user's interface
        // language. Those are carried through verbatim and never parsed: reading a localized date is
        // the same mistake as matching a localized button label, and it fails silently on the first
        // user whose UI is not English.
        dataModifiedAt: Number(v.ACT_VIEW_MODTIME) || null, dataModifiedBy: v.LAST_DATA_MODIFY_BY || '',
        designModifiedText: text(v.LAST_DESIGN_MODIFY), designModifiedBy: v.LAST_DESIGN_MODIFY_BY || '',
        live: !!v.IS_LIVE, system: !!v.IS_SYSTEM_TABLE, favourite: !!v.IS_FAVOURITE,
        tags: v.TAGS || [],
      })),
    };
  }

  // ---- structure ----------------------------------------------------------------------------
  // One call describes every data-bearing object at once: the base Tables and the QueryTables.
  // The payload is terse — tableValues is [name, kind] and each colValues entry is [name, type] —
  // so it is expanded here into something the panel and the reports can use without decoding
  // positional arrays. `kind` is Zoho's own discriminator: "0" for a Table, "6" for a QueryTable.
  const KIND = { 0: 'Table', 6: 'QueryTable' };
  function expandCols(entry) {
    const tv = entry.tableValues || [];
    return {
      name: text(tv[0]),
      kind: KIND[String(tv[1])] || String(tv[1] ?? ''),
      columns: (entry.colValues || []).map((c) => ({ name: text(c[0]), type: text(c[1]) })),
    };
  }
  async function tableSchema() {
    const id = ws();
    const j = await api(`/reportsapi/db/${id}/GETALLTABLECOLDETAILS`);
    const values = (j && j.data && j.data.values) || {};
    const tables = {};
    for (const [viewId, entry] of Object.entries(values)) tables[String(viewId)] = expandCols(entry);
    return { workspace: id, tables, count: Object.keys(tables).length };
  }

  // ---- the SQL of a QueryTable --------------------------------------------------------------
  // This is the only thing in an Analytics workspace that is genuinely source code someone wrote.
  // PAROBJID names the source tables; PAROBJIDINVCOLS says *which columns of each* the query
  // actually involves, which is what makes "if I drop this column, what breaks" answerable.
  async function querySql(id) {
    const j = await api(`/clientapi/sqltable/workspaces/${ws()}/views/${id}/editsql`);
    const d = (j && j.data) || {};
    const inv = (d.PAROBJIDINVCOLS && d.PAROBJIDINVCOLS.values) || {};
    const sources = {};
    for (const [tid, entry] of Object.entries(inv)) sources[String(tid)] = expandCols(entry);
    return {
      id: String(id),
      sql: typeof d.SQLQUERY === 'string' ? d.SQLQUERY : '',
      parents: (Array.isArray(d.PAROBJID) ? d.PAROBJID : []).map(String),
      sources,        // { sourceTableId: { name, kind, columns[] } } — column-level lineage
    };
  }
  async function pullSql(ids) {
    const out = {}; const failed = [];
    for (let i = 0; i < ids.length; i++) {
      try { out[ids[i]] = await querySql(ids[i]); }
      catch (e) { failed.push({ id: String(ids[i]), error: String(e.message || e) }); }
      progress('sql', i + 1, ids.length);
      await new Promise((r) => setTimeout(r, PACE));
    }
    return { sql: out, failed };
  }

  // ---- lineage ------------------------------------------------------------------------------
  // Analytics' own dependency answer for one view, both directions. `level` is the distance in the
  // graph, so this is already transitive — not just the immediate neighbours.
  async function viewDependencies(id) {
    const j = await api(`/clientapi/dependencyview/workspace/${ws()}/view/${id}`);
    const d = (j && j.data) || {};
    const ids = (a) => (a || []).map((x) => ({ id: String(x.objId), level: Number(x.level) || 0 }));
    return {
      id: String(id),
      parents: ids(d.parentTableIds),
      children: ids(d.childTableIds),
      dashboards: (d.dashboardViewIds || []).map((x) => String(x && x.objId != null ? x.objId : x)),
    };
  }
  // Failures are collected rather than aborting: one unreadable view must not cost the other three
  // hundred, and the panel states how many were missed instead of quietly under-reporting.
  async function scanDependencies(ids) {
    const out = {}; const failed = [];
    for (let i = 0; i < ids.length; i++) {
      try { out[ids[i]] = await viewDependencies(ids[i]); }
      catch (e) { failed.push({ id: String(ids[i]), error: String(e.message || e) }); }
      progress('lineage', i + 1, ids.length);
      await new Promise((r) => setTimeout(r, PACE));
    }
    return { deps: out, failed };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!IS_ANALYTICS) return false;
    const reply = (p) => { p.then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) })); return true; };
    if (msg?.cmd === 'context') { sendResponse(context()); return; }
    if (msg?.cmd === 'workspaceInfo') return reply(workspaceInfo());
    if (msg?.cmd === 'listViews') return reply(listViews());
    if (msg?.cmd === 'tableSchema') return reply(tableSchema());
    if (msg?.cmd === 'pullSql') return reply(pullSql(msg.ids || []));
    if (msg?.cmd === 'viewDependencies') return reply(viewDependencies(msg.id));
    if (msg?.cmd === 'scanDependencies') return reply(scanDependencies(msg.ids || []));
  });

  console.debug('[zoost/analytics] bridge active on', BASE, '· workspace', workspaceId());
})();
