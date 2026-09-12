/* CRM pull census and graph enrichment orchestration. */
// ---------- pull / graph ----------
// **What a pull writes when a language would not answer.** Refusing the whole write was the first
// shape of this, and on an org whose role always refuses one of them it made the product do nothing
// at all - no tree, no graph, no export, no assistant - with a message telling the reader to try
// again, for ever. What answered is complete; what did not answer is not «deleted», it is unread. So
// its rows from the previous index are carried forward, which keeps them in the tree and keeps the
// prune from taking their files. A language nobody has an old row for contributes nothing.
async function mergeUnanswered(entries, unanswered, op) {
  if (!(unanswered || []).length) return entries;
  let prev = [];
  try { const t = JSON.parse(await op.read('functions/index.json')); if (Array.isArray(t)) prev = t; } catch (_) {}
  const have = new Set(entries.map((e) => String(e.id)));
  // **Every non-Deluge row, not the ones whose language matches the ask that failed.** The ask carries
  // the query value and a row carries the response value, and the bridge's own comment says they
  // differ - `nodejs` is what is asked for and `nodejs_22` is what comes back. Comparing them for
  // equality meant that when the failing ask was spelled differently from the rows it would have
  // returned, nothing was carried and those functions were written out of the index: the deletion this
  // function exists to prevent, surviving in the one case the code documents as real.
  //
  // So the question is not «which language failed» but «can I still tell that this row is gone», and
  // with any ask refused the answer for every non-Deluge row is no. Deluge is walked on its own and
  // its failure is a failed pull, so a Deluge row missing from the list really is missing. The cost is
  // that a non-Deluge function Zoho has genuinely deleted lingers until a pull where every language
  // answers - which is the right side to err on, and the side the rest of this file already takes.
  const kept = prev.filter((e) => e && !isDeluge(e.language) && !have.has(String(e.id)));
  return kept.length ? entries.concat(kept) : entries;
}
async function pullAll() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    await requirePerm(op.root);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing to avoid cross-environment mix-ups.`);
    setStatus('Listing functions…', 'busy');
    const r = await crmPull().listFunctions(); if (!r?.ok) throw bridgeError(r, 'list failed');
    // **A list that came back short says so.** The org list is asked once per language, and the
    // second ask is deliberately allowed to fail without taking the pull down with it - which is
    // only defensible if the failure is stated. Otherwise a role that does not grant Node
    // functions produces exactly the silent, complete-looking mirror this change is undoing.
    if (op.current()) noteListGap(r.otherFailed, r.unanswered);   // the answer describes the workspace we asked from
    noteListProbe(r);
    // Same rule as the reconciler, and here it was worse: the truncation was reported *after* the
    // pruning had already run, so the warning described files that were already gone.
    if (r.capped) {
      // **Said after the rebuild, because the rebuild speaks too.** The sentence went first and
      // `rebuildTree` then closed with «120 functions (120 downloaded).» in green - so a census that
      // had stopped early was handed to the reader as the whole org, which is the one thing a mirror
      // may never do. Nothing was pruned, and that part was right; what was lost was the telling.
      // Measured by driving the pull with a truncated list and recording the status line in order.
      await rebuildTree();
      setStatus(`Zoho returned a partial list (stopped at ${r.total}) - nothing was removed. Try again.`, 'warn');
      // Zoho answered, so the verdict moves: the record is what says «this area was asked», and a
      // bail before it left an «ask again» unspent and a refusal on record for ever. Nothing is
      // written to the mirror here; what Zoho said about access is.
      await noteAccess('functions', null, op, false);   // asked and answered; nothing was stored
      endPull(); return;
    }
    // Read the previous manifest once, before any write replaces it.  It is the baseline for the
    // plan and must not be reconstructed from treeData, which may belong to another workspace.
    let prev = [];
    try { const previousIndex = JSON.parse(await op.read('functions/index.json')); if (Array.isArray(previousIndex)) prev = previousIndex; } catch (_) {}
    const merged = await mergeUnanswered(r.entries, r.unanswered, op);
    if (!op.current()) return;
    // Which record the newer Zoho interface calls each of these functions. Optional by
    // construction: an org without that interface answers `INVALID_MODULE`, a role without the
    // module is refused, and either way the pull carries on and the panel keeps opening the
    // functions list the way it always has. Never a reason to fail a pull, and never a reason to
    // *lose* what an earlier pull learnt - a map that came back short would otherwise take away
    // every «open this function» the previous one had earned, which is the partial-data rule this
    // repository keeps re-learning in new clothes.
    let ui = null;
    try { ui = await crmPull().functionUiIds(); }
    catch (_) { /* optional: a transport failure must not turn a successful function census red */ }
    if (!op.current()) return;
    await carryUiIds(merged, (ui && ui.map) || {}, op);
    if (!op.current()) return;
    // Build the deletion authority from the old and new file manifests before replacing the
    // index.  The list is a census only when every language answered; a partial answer may keep
    // old rows, but it may not authorise removal of anything.  Existing compiled projects are
    // carried by id so their individual files remain protected until a fresh project replaces
    // them.
    // `functions/<ns>/<stem>.files/lib/util.js` belongs to the project `functions/<ns>/<stem>.files`.
    const projectRootOf = (p) => { const m = /^(.*\.files)\//.exec(String(p)); return m ? m[1] : null; };
    const previousById = new Map(prev.map((e) => [String(e.id), e]));
    const mirrorPaths = (e) => {
      const known = Array.isArray(e && e.mirrorFiles) ? e.mirrorFiles : [];
      if (known.length) return known;
      const folder = sanitize(e && (e.namespace || e.category || 'misc'));
      const stem = sanitize(e && (e.api_name || e.name || e.id));
      const primary = fnDefaultPath(folder, stem, e && e.language);
      return [primary, fnMetaPath(folder, stem)];
    };
    const previousFiles = Object.fromEntries(prev.flatMap((e) => mirrorPaths(e)).map((p) => [p, { path: p }]));
    const nextFiles = Object.fromEntries(merged.flatMap((e) => {
      const old = previousById.get(String(e.id));
      return mirrorPaths(old && old.mirrorFiles ? old : e);
    }).map((p) => [p, { path: p }]));
    // This runner owns the real transition through planning and writing: the census and enrichment
    // above are reading, while the manifest comparison and mirror writes below are their actual
    // phases. Refreshing remains at the composite Pull all boundary so later areas are not labelled
    // as a refresh while they are still being read.
    pullController.phase('planning');
    const mirrorPlan = buildMirrorPlan(previousFiles, nextFiles,
      { complete: !r.capped && !(r.unanswered || []).length });
    if (validateMirrorPlan(mirrorPlan) !== true) throw new Error('mirror plan validation did not succeed');
    pullController.phase('writing');
    await op.write('functions/index.json', JSON.stringify(merged, null, 2));
    // reflect deletions: remove local files for functions no longer in Zoho
    const liveIds = new Set(merged.map((e) => String(e.id))); const rmF = [];
    for await (const p of walk(op.root)) {
      if (!p.startsWith('functions/')) continue;   // only a function has a .meta.json to prune by
      if (p.endsWith('.meta.json')) { try { const mm = JSON.parse(await op.read(p)); if (!liveIds.has(String(mm.id))) rmF.push(...pathsFromMeta(mm, p)); } catch (_) {} }
    }
    // Each removal, not the loop: `removeFile` resolves its path against the folder that is current
    // *now*, so a switch part-way through deletes the rest out of a workspace this pull never walked.
    // A missing or partial plan cannot silently turn the folder walk into a destructive action.
    // **The plan has to name the same files the walk finds, or the intersection deletes the wrong
    // half.** `pathsFromMeta` returns every source inside a compiled project - `<stem>.files/index.js`
    // and its siblings - while `mirrorPaths` fell back to the `.files` *directory* for any row
    // without `mirrorFiles`, which is every row in `functions/index.json`. So for a Java, Python or
    // Node function deleted in Zoho the intersection kept only the meta: the manifest was removed
    // and its sources were left on disk, unreachable by any later prune, since every prune needs the
    // meta that had just gone. Deluge was unaffected, which is why it read as working. Reproduced
    // against the shipped mirror plan.
    //
    // A path the plan does not name is still not deleted - that guard is the point of the plan - but
    // the plan is now built from the same reading the walk uses, so «not named» means «not ours»
    // rather than «spelled differently two functions apart».
    const plannedRemovals = rmF.filter((p) => mirrorPlan.deletes.includes(p) || mirrorPlan.deletes.includes(projectRootOf(p)));
    const removed = await removeFunctionPaths(plannedRemovals, op);
    if (removed.moved) return;
    const prunedF = removed.removed.filter((p) => p.endsWith('.meta.json')).length;
    // If you were reading one of the functions the pull has just pruned, the pane is showing
    // something that no longer exists - in Zoho or on disk. Reported: it stayed open, with the code
    // of a deleted function in it. It closes with the file, the same way a live deletion closes it.
    if (currentPath && rmF.includes(currentPath)) {
      $('preview').classList.remove('show'); $('resizer').classList.remove('show'); currentPath = null;
    }
    // patchCfg, not writeCfg: this file also holds the access verdicts and the workspace's own
    // name, and a whole-object write here drops both. The trap arriving a third time.
    // The org's identity is the one thing that must never land in another folder: written there,
    // two workspaces answer to the same id and only a hand-edited `.zoost.json` separates them
    // again. Checked immediately before, because everything above it awaited.
    if (!op.current()) return;
    await patchCfg({ org: ctx.org, instance: ctx.instance, base: ctx.origin, lastPull: new Date().toISOString() }, op);
    // Every field the binding carries, or the guard that reads one of them silently stops firing.
    // A pull cannot run on a sample - guardOk refuses it - so this can only ever be false here, and
    // writing it out is what stops the next field added to .zoost.json being dropped in this line.
    // Through the op, and asked again after it: `bound`, the binding cache, the tree and the
    // download queue are all about the workspace the panel is showing. The config read above and
    // this publication both travel through the operation, never through the current global folder.
    const _c = (await opReadCfg(op)) || {};
    if (!op.current()) return;
    bound = { org: ctx.org, base: ctx.origin, instance: ctx.instance, label: _c.label || '', sample: !!_c.sample };
    await cacheBinding(bound);
    await rebuildTree();
    await downloadMissing(true);   // fetch each function's code, resiliently (partials stay; failures can be retried); a pull re-asks what was refused
    if (prunedF) setStatus($('stxt').textContent + ` \u00b7 ${prunedF} deleted removed`, 'ok');
    if (removed.failed) setStatus($('stxt').textContent + ` \u00b7 ${removed.failed} stale file(s) could not be removed - \u21bb Refresh retries`, 'warn');
    // **The truncation is said where it is discovered, and this line is gone.** It sat here because
    // the ceiling had been introduced without anybody reading `capped` at all - the right complaint,
    // fixed in the wrong place: the branch that handles a truncated list returns three hundred lines
    // above, so nothing could ever reach this. Two warnings about one fact, one of them unreachable,
    // is worse than one - it reads as cover that is not there. The live one refuses to prune and says
    // so after the tree is drawn, which is where a reader is looking.
    await noteAccess('functions', removed.failed ? { status: 0, message: `${removed.failed} stale function file(s) could not be removed` } : null, op, true);   // the mirror was written; the gap is what could not be tidied after it
  } catch (e) { await notePullFailure('functions', e, op); } finally { endPull(); }
}
// The call graph with everything around it: what fires the code, and what the code reaches out to.
//
// A separate function on purpose. `ensureGraph()` has eleven other readers - the health audit, the
// exports, the AI index, the connection usage counts - and every one of them assumes each node is a
// Deluge function. Widening that shape would have made all eleven quietly wrong, so the enrichment
// lives here and only the diagram window sees it.
//
// Everything it adds is already on disk. Nothing is fetched, and nothing is inferred: a workflow
// fires a function because its own JSON says so, a schedule because its index row names it, a
// connection because the function's captured meta lists it.
const CTX_ID = { wf: (id) => 'wf:' + id, sch: (id) => 'sch:' + id, conn: (name) => 'conn:' + name,
                 act: (kind, id) => 'act:' + kind + ':' + id, mod: (api) => 'mod:' + api };
/** A node that is not a Deluge function.
 *
 *  `entity` is what kind of *thing* it is and `category` is what kind of that thing: a function is
 *  `functions` + its Deluge category, an action is `actions` + `email_notifications`. The two were
 *  one field while every non-function entity had exactly one category, and the moment actions
 *  arrived - four kinds under one entity - the graph window's chips put them among the Deluge
 *  categories, which is a dimension error of the sort this file already records twice. Splitting the
 *  field is what lets the chips have an Actions box with four chips in it, the same shape as the
 *  Functions box, without anything being enumerated in the window. */
function ctxNode(id, name, category, namespace, file, extra) {
  return Object.assign({
    id, name, api_name: name, display_name: name, namespace: namespace || '', category,
    calls: [], called_by: [], rest: false, dead_suspect: false, unresolved: [], ambiguous: [],
    associated_place: null, file: file || '', source_code: '', params: [], stats: null,
    description: '', connections: [], entity: category,
  }, extra || {});
}
async function callGraphWithContext(op = beginWorkspaceOp()) {
  const g = await ensureGraph(op);
  const nodes = {};
  for (const [id, n] of Object.entries(g.nodes)) {
    nodes[id] = Object.assign({}, n, { calls: n.calls.slice(), called_by: n.called_by.slice(), entity: 'functions' });
  }
  // The same resolution the health audit uses, and for the same reason: an action names a function
  // by id when Zoho gives one and by name when it does not.
  const byId = {}, byName = {};
  Object.values(nodes).forEach((n) => { if (n.id) byId[String(n.id)] = n; [n.name, n.api_name, n.display_name].forEach((k) => { if (k) byName[String(k).toLowerCase()] = n; }); });
  const link = (from, to) => { if (!from.calls.includes(to.id)) from.calls.push(to.id); if (!to.called_by.includes(from.id)) to.called_by.push(from.id); };
  const resolveFn = (a) => byId[String(a.id)] || byName[String(a.name || '').toLowerCase()] || null;

  // The actions index, so a rule can be linked to the thing it fires rather than to a name.
  const actIndex = new Map();
  let actRows = [];
  try {
    const rows = JSON.parse(await op.read('actions/index.json'));
    if (Array.isArray(rows)) { actRows = rows; rows.forEach((r) => actIndex.set(r.kind + ':' + String(r.id), r)); }
  } catch (_) { /* not pulled: the rules still draw, with fewer edges */ }

  // A module is a node only when something names it - a workflow it fires on, an action that writes
  // to it. Drawing every module in the mirror would put forty boxes with no arrow into a diagram
  // whose whole subject is what connects to what, and «nothing automates this module» is a
  // measurement the health view already makes. The label comes from the modules index when it is on
  // disk; without it the API name is what there is, and that is what it says.
  let modIdx = []; try { modIdx = JSON.parse(await op.read('modules/index.json')); } catch (_) {}
  const modLabel = {};
  (Array.isArray(modIdx) ? modIdx : []).forEach((m) => { if (m && m.api_name) modLabel[m.api_name] = m.plural_label || m.label || m.api_name; });
  const modOf = (api) => {
    if (!api) return null;
    const id = CTX_ID.mod(api);
    if (!nodes[id]) nodes[id] = ctxNode(id, modLabel[api] || api, 'modules', '', 'modules/index.json',
      { entity: 'modules', api_name: api });
    return nodes[id];
  };

  // Every action, not only the ones a rule was found to fire. Measured on a real org, roughly half
  // are attached to nothing - and an action nothing fires is exactly the kind of thing a diagram of
  // the wiring should show as a box on its own, rather than leave out and call the picture complete.
  actRows.forEach((r) => {
    if (!r || !r.kind) return;
    const id = CTX_ID.act(r.kind, r.id);
    if (!nodes[id]) nodes[id] = ctxNode(id, r.name || String(r.id), r.kind, '', 'actions/index.json',
      { entity: 'actions', _kind: r.kind });
    const m = modOf(r.module);
    if (m) link(nodes[id], m);
  });

  // ---- workflows: their own file says which functions each condition fires -------------------
  let wfIdx = []; try { wfIdx = JSON.parse(await op.read('workflows/index.json')); } catch (_) {}
  for (const w of wfIdx) {
    let d = null; try { d = JSON.parse(await op.read(`workflows/${w.id}.json`)); } catch (_) {}
    const node = ctxNode(CTX_ID.wf(w.id), w.name || String(w.id), 'workflows', w.module || '',
      `workflows/${w.id}.json`, { entity: 'workflows', _downloaded: !!d, _active: w.status !== 'inactive' });
    nodes[node.id] = node;
    // The module a rule fires on is a different fact from the module an action writes to, and both
    // are drawn: this one is «records of this kind are what set it off».
    { const m = modOf(w.module); if (m) link(node, m); }
    if (!d) continue;   // not pulled yet: it is a node with no measured actions, never a node with none
    (d.conditions || []).forEach((c) => {
      const acts = [];
      if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions);
      (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || [])));
      acts.filter(isFnAction).forEach((a) => { const fn = resolveFn(a); if (fn) link(node, fn); });
      // What else the rule fires. Until now the chain stopped at Deluge, which in a real org is the
      // smaller half - 275 notification actions against 149 function ones - so a diagram of «what
      // happens when this fires» was missing most of what happens. The nodes come from the actions
      // index, so an action nobody pulled is not invented here.
      acts.filter((a) => a && a.type && !isFnAction(a)).forEach((a) => {
        const row = actIndex.get(a.type + ':' + String(a.id));
        if (!row) return;
        const id = CTX_ID.act(row.kind, row.id);
        if (!nodes[id]) nodes[id] = ctxNode(id, row.name || String(row.id), row.kind, '',
          'actions/index.json', { entity: 'actions', _kind: row.kind });
        link(node, nodes[id]);
      });
    });
  }

  // ---- schedules: the index row carries the function it runs ---------------------------------
  let scheds = []; try { scheds = JSON.parse(await op.read('schedules/index.json')); } catch (_) {}
  scheds.forEach((sc) => {
    const node = ctxNode(CTX_ID.sch(sc.id), sc.name || String(sc.id), 'schedules', sc.frequency || '',
      'schedules/index.json', { entity: 'schedules', _active: sc.status !== 'inactive' });
    nodes[node.id] = node;
    const fn = resolveFn({ id: sc.function_id, name: sc.function_name });
    if (fn) link(node, fn);
  });

  // ---- connections: the join key is the name inside invokeurl [...connection:"..."] ------------
  let cat = []; try { cat = JSON.parse(await op.read('connections/index.json')); } catch (_) {}
  const conn = {};
  const ensureConn = (name, meta) => {
    const id = CTX_ID.conn(name);
    if (!conn[id]) { conn[id] = ctxNode(id, (meta && meta.label) || name, 'connections', (meta && meta.service) || '', 'connections/index.json', { entity: 'connections' }); nodes[id] = conn[id]; }
    return conn[id];
  };
  cat.forEach((c) => { if (c && c.name) ensureConn(c.name, c); });
  Object.values(nodes).forEach((n) => {
    if (n.entity !== 'functions') return;
    (n.connections || []).forEach((c) => { if (c && c.name) link(n, ensureConn(c.name, c)); });
  });

  // ---- and the counts follow the graph that is actually drawn ---------------------------------
  // "Nothing calls this" is now a stronger statement than it was, because a workflow and a schedule
  // are callers. A connection with no caller is a connection nothing uses - which is the same
  // candidate, never a verdict, that the panel already states with its coverage gap beside it.
  let dead = 0;
  Object.values(nodes).forEach((n) => {
    n.calls.sort(); n.called_by.sort();
    n.dead_suspect = !n.called_by.length && !n.rest && !(n.associated_place && n.associated_place.length);
    if (n.dead_suspect) dead++;
  });
  const edges = new Set();
  Object.values(nodes).forEach((n) => n.calls.forEach((c) => edges.add(n.id + '\u0000' + c)));
  return Object.assign({}, g, {
    nodes,
    // `nodes` here counts everything the drawing holds - functions, actions, workflows, schedules,
    // connections, modules - and `mirrorNote` reads it as «functions in this mirror», which is how
    // the window came to print «over 168 of 123»: more functions in the mirror than the org has,
    // contradicting the counts on its own line. The function count is kept under its own name.
    counts: Object.assign({}, g.counts, { fnNodes: g.counts ? g.counts.nodes : undefined,
      nodes: Object.keys(nodes).length, edges: edges.size, dead_suspects: dead }),
  });
}
async function openGraph() {
  if (!dir) return;
  const op = beginWorkspaceOp(), ws = graphIdentity();
  try {
    await requirePerm(op.root);
    if (!op.current()) return;
    setStatus('Building graph…', 'busy'); await refreshContext();
    const g = await callGraphWithContext(op);
    if (!(await publishGraph(g, op, ws))) return;
    setStatus(`Graph: ${g.counts.nodes} nodes, ${g.counts.edges} edges.`, 'ok');
  } catch (e) { if ((e && e.message) !== WS_MOVED) setStatus(MSG.graphErr + e.message, 'bad'); }
}


