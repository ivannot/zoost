/*
 * content-bridge.js — ISOLATED world on the Zoho Analytics page.
 * Wrapped in a guard so it is safe to (re)inject via chrome.scripting.
 *
 * Read-only, like its CRM sibling. It never creates, edits or deletes a view.
 *
 * Two differences from the CRM bridge worth knowing:
 *
 *  - **No CSRF token.** The CRM APIs reject a request without `X-ZCSRF-TOKEN`, and the /crm/ and
 *    /deluge/ families want the same token under different prefixes. The Analytics endpoints used
 *    here take none at all: session cookies plus `X-Requested-With: XMLHttpRequest` is the whole
 *    contract. Do not add a token "to be safe" — it was verified absent, and inventing one is the
 *    kind of guess that produces a 400 nobody can explain.
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

  const context = () => ({
    ok: true, origin: BASE, workspace: workspaceId(), view: viewIdInUrl(),
  });

  async function api(path) {
    const res = await fetch(BASE + path, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error(res.status + ' on ' + path.split('?')[0]);
    const j = await res.json();
    // Analytics answers 200 with {"status":"failure"} on an error, so the HTTP code alone is not
    // the success signal. Anything that is not an explicit success is treated as a failure.
    if (j && j.status && String(j.status).toLowerCase() !== 'success') {
      throw new Error('Analytics returned status "' + j.status + '"' + (j.summary ? ': ' + j.summary : ''));
    }
    return j;
  }

  // VIEWLIST answers columnar — a key array plus a row array per record — so it is zipped back into
  // objects here rather than leaving index arithmetic scattered through the panel. Unknown columns
  // are carried through untouched: Zoho adds fields, and dropping one silently is how a feature ends
  // up quietly missing data it was asked for.
  const zip = (keys, rows) => (rows || []).map((r) => {
    const o = {}; (keys || []).forEach((k, i) => { o[k] = r[i]; }); return o;
  });
  // Several of these fields arrive with a leading space (" 03 Jul 2025"). Trimmed on the way in so
  // the panel never has to know.
  const text = (v) => (v == null ? '' : String(v).trim());

  async function listViews() {
    const ws = workspaceId();
    if (!ws) throw new Error('no workspace in the current URL');
    const j = await api(`/reportsapi/db/${ws}/VIEWLIST?ZOHO_FOLDERLIST=true&NOCACHE=${Date.now()}`);
    const d = (j && j.data) || {};
    const views = zip(d.viewListKey, d.viewListValues);
    const folders = zip(d.folderListKey, d.folderListValues);
    const folderName = new Map(folders.map((f) => [String(f.FOLDER_ID), f.FOLD_NAME]));
    return {
      workspace: ws,
      folders: folders.map((f) => ({ id: String(f.FOLDER_ID), name: f.FOLD_NAME, parent: f.FOL_PARID ? String(f.FOL_PARID) : null })),
      views: views.map((v) => ({
        id: String(v.VIEW_ID), name: v.VIEW_NAME, type: v.VIEW_TYPE,
        description: v.VIEW_DESC || '',
        folder: v.FOLD_ID ? String(v.FOLD_ID) : null,
        folderName: folderName.get(String(v.FOLD_ID)) || '',
        parent: v.PARENT_ID ? String(v.PARENT_ID) : null,
        createdText: text(v.VIEW_CREATE_TIME), createdBy: v.CREATED_BY || '',
        owner: v.OWNER_NAME || '',
        // Analytics keeps data and design apart, and that distinction is the whole point: a report
        // whose data refreshed nightly for two years but whose design nobody has touched since 2019
        // is a very different object from one redesigned last week.
        //
        // Only one of the two comes back machine-readable. ACT_VIEW_MODTIME is epoch milliseconds
        // and tracks the *data* change. Everything else in this payload is text already rendered in
        // the user's interface language — LAST_DATA_MODIFY arrives as "1 ora minuto fa", and
        // LAST_DESIGN_MODIFY as " 03 Jul 2025" with a leading space. Those are carried through
        // verbatim and never parsed: reading a localized date string is the same mistake as matching
        // a localized button label, and it fails silently on the first user whose UI is not English.
        dataModifiedAt: Number(v.ACT_VIEW_MODTIME) || null, dataModifiedBy: v.LAST_DATA_MODIFY_BY || '',
        designModifiedText: text(v.LAST_DESIGN_MODIFY), designModifiedBy: v.LAST_DESIGN_MODIFY_BY || '',
        live: !!v.IS_LIVE, system: !!v.IS_SYSTEM_TABLE, favourite: !!v.IS_FAVOURITE,
        tags: v.TAGS || [],
      })),
    };
  }

  // Dependencies of one view, both directions, as Analytics itself computes them for its dependency
  // panel: parents are what this view reads from, children are what reads from this view, and
  // dashboards are the dashboards it appears on. `level` is the distance in the graph, so this is
  // already transitive — not just the immediate neighbours.
  async function viewDependencies(id) {
    const ws = workspaceId();
    if (!ws) throw new Error('no workspace in the current URL');
    const j = await api(`/clientapi/dependencyview/workspace/${ws}/view/${id}`);
    const d = (j && j.data) || {};
    const ids = (a) => (a || []).map((x) => ({ id: String(x.objId), level: Number(x.level) || 0 }));
    return {
      id: String(id),
      parents: ids(d.parentTableIds),
      children: ids(d.childTableIds),
      dashboards: (d.dashboardViewIds || []).map((x) => String(x && x.objId != null ? x.objId : x)),
    };
  }

  // One dependency call per view, paced and reporting progress, the same shape as the CRM pull.
  // Failures are collected rather than aborting the scan: one unreadable view must not cost the
  // other three hundred, and the panel states how many were missed instead of quietly under-reporting.
  async function scanDependencies(ids) {
    const out = {}; const failed = [];
    for (let i = 0; i < ids.length; i++) {
      try { out[ids[i]] = await viewDependencies(ids[i]); }
      catch (e) { failed.push({ id: String(ids[i]), error: String(e.message || e) }); }
      chrome.runtime.sendMessage({ type: 'scanProgress', done: i + 1, total: ids.length }).catch(() => {});
      await new Promise((r) => setTimeout(r, 60));
    }
    return { deps: out, failed };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!IS_ANALYTICS) return false;
    if (msg?.cmd === 'context') { sendResponse(context()); return; }
    if (msg?.cmd === 'listViews') { listViews().then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) })); return true; }
    if (msg?.cmd === 'viewDependencies') { viewDependencies(msg.id).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) })); return true; }
    if (msg?.cmd === 'scanDependencies') { scanDependencies(msg.ids || []).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) })); return true; }
  });

  console.debug('[zoost/analytics] bridge active on', BASE, '· workspace', workspaceId());
})();
