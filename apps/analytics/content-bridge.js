/*
 * content-bridge.js - ISOLATED world on the Zoho Analytics page.
 * Wrapped in a guard so it is safe to (re)inject via chrome.scripting.
 *
 * Read-only, like its CRM sibling. It never creates, edits or deletes a view.
 *
 * Three differences from the CRM bridge worth knowing:
 *
 *  - **CSRF follows the HTTP method, not the path.** Measured across a 104-request capture with no
 *    exceptions: **every POST carries `X-ZCSRF-TOKEN: ZDB_CSRF_TOKEN=<value>`, and no GET does** -
 *    including `POST /reportsapi/DashAnalysisViewsJSON`, which is why "the /reportsapi/ family needs
 *    no token" was the wrong generalisation from a capture that happened to contain only its GETs.
 *    So `api()` (GET) sends none and `post()` sends it, and that split is the rule itself rather
 *    than a list of paths to keep updated.
 *
 *    Note the token's own name is **not** the cookie's name - the CRM bridge in this same repository
 *    proves it: header prefix `crmcsrfparam=`, cookie `CT_CSRF_TOKEN`. Assuming otherwise here is
 *    what made the first ER pull fail.
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
  // The manifest already decides where this script runs; recognising a *different* set here
  // could only ever be wrong in one direction or the other.
  const IS_ANALYTICS = (chrome.runtime.getManifest().host_permissions || [])
    .filter((h) => h.startsWith('https://analytics.'))
    .some((h) => h.replace(/\/\*$/, '') === BASE);
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

  // A refused request is a different fact from a failed one: "your Analytics role does not cover
  // this" is something the user can act on, "500" is not. The CRM workbench draws the same
  // distinction at the same place, and the panels must not diverge on what a refusal looks like.
  //
  // Only the HTTP form is classified. Analytics also answers 200 with `{"status":"failure"}` and
  // whether it ever refuses a permission *that* way has not been measured - so that path stays an
  // ordinary failure rather than being labelled a refusal on a guess. Understating is recoverable;
  // telling someone their role is the problem when it is not sends them to an administrator for
  // nothing.
  function apiError(status, path, detail) {
    const e = new Error(status + ' on ' + path.split('?')[0] + (detail ? ' - ' + detail : ''));
    e.status = status;
    e.forbidden = status === 401 || status === 403;
    return e;
  }
  // Same as the CRM bridge: quote what the platform said rather than only its status code.
  async function errorDetail(res) {
    try {
      const t = (await res.text()).slice(0, 400);
      const m = t.match(/"(?:errorMessage|message|summary|error)"\s*:\s*"([^"]{1,120})"/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }
  async function api(path) {
    const res = await fetch(BASE + path, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) throw apiError(res.status, path, await errorDetail(res));
    const j = await res.json();
    if (j && j.status && String(j.status).toLowerCase() !== 'success') {
      throw new Error('Zoho Analytics returned status "' + j.status + '"' + (j.summary ? ': ' + j.summary : ''));
    }
    return j;
  }
  const ws = () => {
    const w = workspaceId();
    if (!w) throw new Error('no workspace in the current URL');
    return w;
  };

  // Every POST wants a CSRF token; no GET does. It goes in as `ZDB_CSRF_TOKEN=<value>` - the same
  // shape as the CRM bridge's prefixed token, a different name. Deterministic places are checked in
  // order; if none has it the caller stops with a message naming exactly what was looked for, rather
  // than sending a request that would come back as an unexplained failure.
  const cookie = (n) => document.cookie.split('; ').find((c) => c.startsWith(n + '='))?.split('=')[1];
  function zdbCsrf() {
    // Verified by intercepting what the Analytics app itself sends: the value is the 128-character
    // `CSRF_TOKEN` cookie, and `CT_CSRF_TOKEN` on this host holds the identical value. Reading
    // either is therefore correct - the pair is tolerance for one being absent on another data
    // centre, not a guess between two candidates, and there is no request to retry if the first is
    // missing. The token was also confirmed **not** to be anywhere in the page source, so the
    // scrape that used to sit here was dead code and is gone.
    return cookie('CSRF_TOKEN') || cookie('CT_CSRF_TOKEN') || '';
  }
  async function post(path, params) {
    const token = zdbCsrf();
    if (!token) throw new Error('CSRF token not found (no CSRF_TOKEN or CT_CSRF_TOKEN cookie on this page - are you signed in?)');
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-ZCSRF-TOKEN': 'ZDB_CSRF_TOKEN=' + token,
        Accept: '*/*',
      },
      credentials: 'include',
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw apiError(res.status, path, await errorDetail(res));
    return res.json();
  }
  const progress = (stage, done, total) =>
    chrome.runtime.sendMessage({ type: 'pullProgress', stage, done, total }).catch(() => {});

  // VIEWLIST answers columnar - a key array plus a row array per record - so it is zipped back into
  // objects here rather than leaving index arithmetic scattered through the panel.
  const zip = (keys, rows) => (rows || []).map((r) => {
    const o = {}; (keys || []).forEach((k, i) => { o[k] = r[i]; }); return o;
  });
  // «This workspace has none» and «the answer is not the shape this reads» are two different facts,
  // and `(rows || [])` made the second look like the first: a VIEWLIST that changed would have been
  // mirrored as an empty workspace, in silence, by a tool whose whole promise is a faithful copy.
  // A census that came back as a shape nobody recognises stops here, naming the field. The twin
  // check on the CRM side is `list()`; the shape of the answer differs, the rule does not.
  // A `function`, not a `const` arrow, and that is not style: `tests/slice.mjs` lifts a named
  // declaration out of a browser file to run it alone, and it threw on the arrow version - which is
  // the rule CLAUDE.md already states about anything a test will lift.
  function need(v, field, path) {
    if (Array.isArray(v)) return v;
    const e = new Error(`${path} answered without «${field}» - the response is not the shape this `
      + 'reads, so nothing was written for it. Zoho Analytics may have changed the endpoint.');
    e.shape = true;
    throw e;
  }
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
    const path = `db/${id}/VIEWLIST`;
    const views = zip(need(d.viewListKey, 'viewListKey', path), need(d.viewListValues, 'viewListValues', path));
    const folders = zip(need(d.folderListKey, 'folderListKey', path), need(d.folderListValues, 'folderListValues', path));
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
        // comes out of this one call - no per-view request needed for it.
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
  // The payload is terse - tableValues is [name, kind] and each colValues entry is [name, type] -
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
  // The ER endpoint is what Analytics itself calls to draw the workspace diagram, and it is a strict
  // superset of GETALLTABLECOLDETAILS: the same 135 objects with the same columns and types
  // (verified against a capture - identical sets, only ordered differently), plus four things that
  // endpoint does not have:
  //
  //   - **the relations** - 119 of them in the workspace this was measured on, each with the join
  //     written out as "(A.col)=(B.col)". This is the foreign-key graph, and nothing else we can
  //     read exposes it.
  //   - **`lastModTime`**, epoch milliseconds, which matched LAST_DESIGN_MODIFY on 135/135. It is
  //     the machine-readable design date the view list only gives as localized text, so the Design
  //     column can finally sort for these objects.
  //   - **`isSystemTable`** - 37 of 135 here, while VIEWLIST flagged none. Telling what Zoho put
  //     there apart from what you built is close to the point of the product.
  //   - **`colid`**, a stable id per column, which survives a rename.
  //
  // It answers with no `status` field at all, so the shape is the only success signal; `api()`'s
  // check would have waved anything through.
  const KIND_ERD = { 0: 'Table', 6: 'QueryTable' };
  async function workspaceErd() {
    const id = ws();
    const j = await post('/ZDBCreateERD.ma?ZDBACTION=CREATEDATABASEERD&SUBREQUEST=XMLHTTP&_ZVER_=101',
      { DBID: id, ISERDGNEWFLOW: 'true' });
    if (!j || !Array.isArray(j.nodes) || !Array.isArray(j.links)) {
      throw new Error('the ER endpoint did not answer with nodes and links');
    }
    const tables = {}; const byIndex = new Map();
    for (const n of j.nodes) {
      const viewId = String(n.viewId);
      byIndex.set(n.id, { viewId, node: n });
      tables[viewId] = {
        name: text(n.name),
        kind: KIND_ERD[String(n.viewType)] || String(n.viewType ?? ''),
        description: text(n.viewDesc),
        system: !!n.isSystemTable,
        dataPrep: !!n.isDataPrepTable,
        designModifiedAt: Number(n.lastModTime) || null,
        columns: (n.columns || []).map((c) => ({ name: text(c.name), type: text(c.dt), colid: text(c.colid), description: text(c.coldesc) })),
      };
    }
    // Links reference nodes and columns by array index. Those indices mean nothing outside this
    // response, so they are resolved here and never travel further.
    const colName = (idx, i) => {
      const e = byIndex.get(idx);
      const c = e && e.node.columns && e.node.columns[i];
      return c ? text(c.name) : '';
    };
    const relations = j.links.map((l) => {
      const s = byIndex.get(l.source), t = byIndex.get(l.target);
      return {
        source: s ? s.viewId : null, target: t ? t.viewId : null,
        sourceName: s ? text(s.node.name) : '', targetName: t ? text(t.node.name) : '',
        sourceColumns: (l.sourceColumns || []).map((i) => colName(l.source, i)),
        targetColumns: (l.targetColumns || []).map((i) => colName(l.target, i)),
        relation: text(l.relationstring),   // Zoho's own rendering of the join, e.g. "(A.col)=(B.col)"
      };
    }).filter((r) => r.source && r.target);
    return { workspace: id, tables, relations, count: Object.keys(tables).length };
  }

  // ---- the SQL of a QueryTable --------------------------------------------------------------
  // This is the only thing in an Analytics workspace that is genuinely source code someone wrote.
  // PAROBJID names the source tables; PAROBJIDINVCOLS says *which columns of each* the query
  // actually involves, which is what makes "if I drop this column, what breaks" answerable.
  async function querySql(id) {
    const j = await api(`/clientapi/sqltable/workspaces/${ws()}/views/${id}/editsql`);
    const d = (j && j.data) || {};
    // A response without SQLQUERY is a shape this does not understand, not a query with no text.
    // Coercing it to '' made the pull report success, write an empty file, and leave the panel saying
    // "could not be read" about something that had never been read at all. Fail here instead: the
    // item lands in pullFailed, gets counted, and Retry can pick it up.
    if (typeof d.SQLQUERY !== 'string') throw new Error('the response carried no SQLQUERY');
    const inv = (d.PAROBJIDINVCOLS && d.PAROBJIDINVCOLS.values) || {};
    const sources = {};
    for (const [tid, entry] of Object.entries(inv)) sources[String(tid)] = expandCols(entry);
    return {
      id: String(id),
      sql: d.SQLQUERY,
      parents: (Array.isArray(d.PAROBJID) ? d.PAROBJID : []).map(String),
      sources,        // { sourceTableId: { name, kind, columns[] } } - column-level lineage
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
  // graph, so this is already transitive - not just the immediate neighbours.
  async function viewDependencies(id) {
    const j = await api(`/clientapi/dependencyview/workspace/${ws()}/view/${id}`);
    const d = (j && j.data) || {};
    // Validate at the boundary. `{objId, level}` is the shape every captured response used, but an
    // element that does not carry one must be dropped, not turned into the string "undefined" - which
    // is exactly what String(x.objId) did, and it travelled all the way to the diagram as a node name.
    // A bare id is accepted too, because dashboardViewIds already arrives that way.
    const one = (x) => {
      if (x == null) return null;
      const raw = (typeof x === 'object') ? (x.objId != null ? x.objId : x.id) : x;
      const v2 = raw == null ? '' : String(raw).trim();
      return /^\d{4,}$/.test(v2) ? v2 : null;      // Zoho ids are long integers; anything else is not one
    };
    const ids = (a) => (a || []).map((x) => ({ id: one(x), level: Number(x && x.level) || 0 })).filter((e) => e.id);
    const dropped = (a) => (a || []).filter((x) => !one(x)).length;
    return {
      id: String(id),
      parents: ids(d.parentTableIds),
      children: ids(d.childTableIds),
      dashboards: (d.dashboardViewIds || []).map(one).filter(Boolean),
      // Not hidden: if Analytics sent something we could not read, the count says so rather than the
      // diagram quietly showing one fewer dependency than exists.
      dropped: dropped(d.parentTableIds) + dropped(d.childTableIds) + dropped(d.dashboardViewIds),
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
    // `forbidden` and `status` travel as their own fields: an Error does not survive
    // chrome.runtime messaging, and String(e) would drop exactly the two facts the panel needs to
    // tell a refusal from a fault. Same boundary trap as everywhere else in this repository.
    const reply = (p) => { p.then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e), status: (e && e.status) || 0, forbidden: !!(e && e.forbidden) })); return true; };
    if (msg?.cmd === 'context') { sendResponse(context()); return; }
    if (msg?.cmd === 'workspaceInfo') return reply(workspaceInfo());
    if (msg?.cmd === 'listViews') return reply(listViews());
    if (msg?.cmd === 'workspaceErd') return reply(workspaceErd());
    if (msg?.cmd === 'pullSql') return reply(pullSql(msg.ids || []));
    if (msg?.cmd === 'viewDependencies') return reply(viewDependencies(msg.id));
    if (msg?.cmd === 'scanDependencies') return reply(scanDependencies(msg.ids || []));
  });

  console.debug('[zoost/analytics] bridge active on', BASE, '· workspace', workspaceId());
})();
