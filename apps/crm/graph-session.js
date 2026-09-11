/** The workspace identity, photographed at the entry of a graph action - not read after the build.
 *  Every diagram entry read `bound`/`lastCtx` *after* its awaits, so a build begun in one workspace
 *  could be stamped with the identity of the next: data of A presented as B, which a mirror can
 *  never do. Reproduced by an outside scan. */
const graphIdentity = () => ({ instance: bound?.instance || lastCtx?.instance || null,
                               org: bound?.org || lastCtx?.org || null, label: bound?.label || null });
/** Hand a graph to its own window: one key per window, not one slot for all of them.
 *  Two windows - a call graph and an ER - shared `graphData`, so two opens close together could each
 *  consume the other's payload. The token rides the URL; the window consumes exactly its own key.
 *  Checked against the op before the write and again before the window, and the key is removed
 *  rather than left if the workspace moved between the two. Returns false when it did. */
async function publishGraph(g, op, ws) {
  g.workspace = ws;
  const token = crypto.randomUUID();
  const key = 'graphData:' + token;
  if (op && !op.current()) return false;
  await chrome.storage.session.set({ [key]: graphForWindow(g) });
  if (op && !op.current()) { try { await chrome.storage.session.remove(key); } catch (_) {} return false; }
  // A window that cannot open leaves nobody to consume the key, so it goes at once - otherwise the
  // payload sat in session storage until the browser closed, which is longer than the privacy page
  // is allowed to promise.
  try { await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html?graph=' + token), type: 'normal', width: 1240, height: 840 }); }
  catch (e) { try { await chrome.storage.session.remove(key); } catch (_) {} throw e; }
  return true;
}
function graphForWindow(g) {
  const out = Object.assign({}, g, { nodes: {} });
  for (const [id, n] of Object.entries(g.nodes || {})) {
    const copy = Object.assign({}, n);
    // **Both fields, because the source has two names.** This stripped `source_code`, and the assistant
    // caches what it read on the same node as `_src` - so once somebody had asked about a function, the
    // payload handed to the diagram window carried its Deluge source again, and `privacy.html` says in
    // as many words that it does not. It never leaves the machine, and the page still has to be true.
    delete copy.source_code;
    delete copy._src;
    out.nodes[id] = copy;
  }
  return out;
}

/** The call graph, from what was written down when the sources were last read.
 *
 *  It used to read every `.dg` and every `.meta.json` - two files per function, 40,000 file-system
 *  calls on an org of five thousand - and parse the sources again each time. What the parse produces
 *  per function is now kept in `functions/meta-index.json`: the references the parser saw and the
 *  size counts. Both are *readings* of one file, so they age exactly when that file changes - and
 *  what detects that is **not** the folder walk, which sees paths appearing and disappearing and
 *  nothing about the bytes behind them. This comment used to claim the walk was enough; a review
 *  asked for the proof, the first test written for it failed, and the answer is `_dirtySource`:
 *  every write this panel makes marks the file it touched, and ↻ Refresh marks all of them for the
 *  writes it cannot see. The resolution of a reference into an edge still happens on every build,
 *  because it depends on the whole workspace.
 *
 *  A source the summary does not describe is read and parsed as before, and the summary is brought
 *  up to date afterwards. So a hand-pulled function, an older mirror or a file somebody dropped in
 *  all produce the same graph as a full read - proven in the suite by building it both ways.
 */
async function loadGraph(op = beginWorkspaceOp()) {
  if (!op.current()) throw new Error(WS_MOVED);
  const nodes = [];
  // `idWord` because the header is drawn by a file both products share - see the twin, where the
  // number is a workspace id and this one is an org.
  const workspace = { idWord: 'org', instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null, label: bound?.label || null };
  const dirtySrc = new Set(_dirtySource);   // snapshot, as the tree load does
  let summary = null;
  try { summary = JSON.parse(await op.read(META_INDEX)); } catch (_) {}
  const known = (!distrustSummary && summary && summary.v === SUMMARY_V && summary.files) ? summary.files : {};
  let read = 0;
  for await (const p of walk(op.root)) {
    if (!op.current()) throw new Error(WS_MOVED);
    if (!p.endsWith('.dg')) continue;
    const cached = dirtySrc.has(p) ? null : known[p];
    if (cached && Array.isArray(cached.refs) && cached.stats) {
      nodes.push({ namespace: cached.namespace || p.split('/')[0],
                   name: cached.name || p.split('/').pop().replace(/\.dg$/, ''),
                   api_name: cached.api_name || p.split('/').pop().replace(/\.dg$/, ''),
                   display_name: cached.display_name, category: cached.category, source: cached.source,
                   description: cached.description || '', rest: !!cached.rest,
                   associated_place: cached.associated_place || null, file: p,
                   return_type: cached.return_type || '', params: cached.params || [],
                   connections: cached.connections || [], updatedTime: cached.updatedTime || null,
                   modified_by: cached.modified_by || null,
                   refs: cached.refs, stats: cached.stats,
                   _modules: Array.isArray(cached.modules) ? { modules: cached.modules, unknown: cached.modulesUnknown || 0 } : null,
                   dg: '' });
      continue;
    }
    read++;
    const dg = await op.read(p); let meta = {}; try { meta = JSON.parse(await op.read(p.replace(/\.dg$/, '.meta.json'))); } catch {}
    nodes.push({ namespace: meta.nameSpace || p.split('/')[0], name: meta.name || p.split('/').pop().replace(/\.dg$/, ''), api_name: meta.api_name, category: meta.category, source: meta.source, display_name: meta.display_name, description: meta.description || '', rest: (meta.rest_api || []).some((r) => r.active), associated_place: meta.associated_place || null, return_type: meta.return_type, params: meta.params || [], connections: meta.connections || [], modified_by: meta.modified_by || null, updatedTime: meta.updatedTime || null, dg, stats: fnStats(dg), file: p });
  }
  const g = window.buildGraph(nodes.map((n) => (n.refs ? { ...n, _refs: n.refs, _modules: n._modules } : n)));
  // **How much of the org this drawing is of.** The graph is built from the `.dg` files on disk, and
  // a function that never downloaded - the ones in `failures/` - is not a node at all. So it makes
  // no calls here, and anything it was the only caller of comes out as «no caller»: the number the
  // diagram prints in its headline and the list the health audit puts names in, which is where
  // somebody decides a function is safe to delete.
  //
  // `functions/index.json` is what Zoho reported, so the difference is the answer. Unknown rather
  // than zero when the index cannot be read: «nobody looked» is not «nothing missing», which is the
  // distinction this panel spent the day learning in four other places.
  //
  // Compiled-runtime files are mirrored, but the call graph remains a Deluge static analysis. Keep
  // those functions out of the "download failed" count and name the analysis boundary separately.
  let inOrg = null, notMirrorable = 0, unreadFns = [];
  try {
    const idx = JSON.parse(await op.read('functions/index.json'));
    if (Array.isArray(idx)) {
      inOrg = idx.length;
      // The rows themselves, not only how many: three surfaces have to *name* these functions -
      // the assistant answers about them by name, and it had to re-read the index to do it.
      unreadFns = idx.filter((e) => !isDeluge(e && e.language))
        .map((e) => ({ id: e.id, api_name: e.api_name, name: e.name, display_name: e.display_name,
                       namespace: e.namespace, language: e.language }));
      notMirrorable = unreadFns.length;
    }
  } catch (_) {}
  g.counts.inOrg = inOrg;
  g.counts.notMirrorable = notMirrorable;
  g.unreadFns = unreadFns;
  g.counts.notInMirror = inOrg === null ? null : Math.max(0, inOrg - notMirrorable - g.counts.nodes);
  // What the parser saw, written down for the next build. Only when something had to be read: a
  // graph built entirely from the summary has nothing new to say, and rewriting the file on every
  // open would touch a folder the reader may have under version control.
  if (read) await saveGraphFacts(nodes, g, op);
  if (!op.current()) throw new Error(WS_MOVED);
  nodes.forEach((nd) => { const id = nd.namespace + '.' + nd.name; if (g.nodes[id]) { g.nodes[id].return_type = nd.return_type; g.nodes[id].params = nd.params; g.nodes[id].connections = nd.connections; g.nodes[id].modified_by = nd.modified_by; g.nodes[id].updatedTime = nd.updatedTime; // The counts come from the source when it was read, and from the summary when it was not -
  // the same numbers either way, since `fnStats()` is a pure reading of that text and what the
  // summary holds is the result of having run it.
  g.nodes[id].stats = nd.stats || fnStats(nd.dg); } });
  g.workspace = workspace;
  return g;
}
/** Keep, per function, exactly what a source read produced: the references the parser found and the
 *  size counts. Everything else in the graph is computed from those two and from the workspace as a
 *  whole, so nothing here is a stored judgement - only a stored reading. */
async function saveGraphFacts(nodes, g, op = beginWorkspaceOp()) {
  const written = updateMetaIndex((files) => {
    nodes.forEach((nd) => {
      if (!nd.file) return;
      const node = g.nodes[nd.namespace + '.' + nd.name];
      const entry = files[nd.file] || (files[nd.file] = {});
      entry.namespace = nd.namespace; entry.name = nd.name; entry.api_name = nd.api_name;
      entry.display_name = nd.display_name; entry.category = nd.category; entry.source = nd.source;
      entry.rest = !!nd.rest; entry.associated_place = nd.associated_place || null;
      entry.return_type = nd.return_type || ''; entry.params = nd.params || [];
      entry.connections = nd.connections || []; entry.modified_by = nd.modified_by || null;
      entry.description = nd.description || '';
      entry.refs = (node && node.refs) ? node.refs : (nd.refs || []);
      // The module candidates, beside the references and for the same reason: a reading of one
      // source, never a resolution against the workspace.
      entry.modules = (node && node.modules) ? node.modules : (nd.modules || []);
      entry.modulesUnknown = (node && node.modulesUnknown) || 0;
      entry.stats = nd.stats || (node && node.stats) || null;
      // `sv` and `updatedTime` belong to the meta writer: this one has read a `.dg`, which says
      // nothing about either. Writing them here is how a merge base becomes a lost update.
    });
  }, op);
  // The sources this pass read are now described, and only those - a file rewritten while this
  // build was walking the folder keeps its mark and is read by the next one. And only if the write
  // happened, for the same reason as in the meta half.
  if (!(await written) || !op.current()) return;
  nodes.forEach((nd) => { if (nd.file) _dirtySource.delete(nd.file); });
}
async function ensureGraph(op = beginWorkspaceOp()) {
  if (!op.current()) throw new Error(WS_MOVED);
  if (graphCache) return graphCache;
  // The *result* was cached after the await, so a build begun in one workspace finished into the
  // next - and `saveGraphFacts` then wrote its readings into that workspace's summary. What comes
  // back for a folder we have left is thrown away rather than kept.
  const g = await loadGraph(op);
  if (!op.current()) throw new Error(WS_MOVED);
  graphCache = g;
  return graphCache;
}
function makeCallResolver(g) {
  const nodes = g.nodes || {}, byName = {};
  Object.values(nodes).forEach((n) => { (byName[n.name] ||= []).push(n); });
  return (ns, name) => {
    const exact = nodes[ns + '.' + name];
    if (exact) return { file: exact.file, label: exact.display_name || exact.name };
    const hits = byName[name] || [];
    if (hits.length === 1) return { file: hits[0].file, label: hits[0].display_name || hits[0].name };
    return null;   // ambiguous / unresolved -> not linked
  };
}



