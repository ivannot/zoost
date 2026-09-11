// @ts-check
/* Filesystem-facing mirror operations for the analytics view.  The panel supplies adapters and snapshots;
 * this module does not read DOM state or Chrome APIs, which keeps the write boundary explicit. */
function createAnalyticsMirrorWriter(deps) {
  if (!deps || typeof deps.writeJson !== 'function' || typeof deps.readJson !== 'function') {
    throw new Error('View mirror writer needs filesystem adapters');
  }
  async function writeLineageFiles(operation, workspace, nextDeps, nextFailed) {
    if (!operation || !operation.current()) return;
    await deps.writeJson('lineage.json', { workspace, deps: nextDeps, failed: nextFailed }, operation);
  }
  async function writeSqlFiles(operation, nextSqls, views) {
    if (!operation || !operation.current()) return;
    /** @type {{rel: string, name: string}|null} */
    let unreadable = null;
    const index = await deps.readJson('sql/index.json', {}, operation, (failure) => { unreadable = failure; });
    if (unreadable) throw new Error(`Could not read ${unreadable.rel} (${unreadable.name}).`);
    const byId = new Map((views || []).map((view) => [view.id, view]));
    for (const [id, query] of Object.entries(nextSqls || {})) {
      if (typeof query.sql !== 'string') continue;
      const view = byId.get(id);
      const stem = query.stem || deps.stemOf(view ? view.name : id, id);
      await operation.write(`sql/${stem}.sql`, query.sql);
      index[id] = { stem, name: view ? view.name : '', parents: query.parents, sources: query.sources };
    }
    await deps.writeJson('sql/index.json', index, operation);
  }
  return Object.freeze({ writeLineage: writeLineageFiles, writeSql: writeSqlFiles });
}
