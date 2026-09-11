// @ts-check
/* Pull all application use case.  The panel supplies effects (Zoho, filesystem and rendering);
 * this module owns the read -> plan -> write -> refresh order and returns a complete snapshot. */
/** @typedef {{root: unknown, current: () => boolean, say: (text: string, kind?: string) => void}} PullOperation */
/** @typedef {{workspace: string, origin: string, name?: string}} WorkspaceInfo */
/** @typedef {{views?: Array<{id: string, type?: string}>, folders?: object[]}} ViewList */
/** @typedef {{tables?: Record<string, object>, relations?: object[]}} ErdResult */
/** @typedef {{sql?: Record<string, object>, failed?: object[]}} SqlResult */
/** @typedef {{deps?: Record<string, object>, failed?: object[]}} DependencyResult */
/** @typedef {{
 * requirePerm: (root: unknown) => Promise<void>, setBusy: (busy: boolean, text?: string|null) => void,
 * readWorkspace: () => Promise<WorkspaceInfo>, readViews: () => Promise<ViewList>, readErd: () => Promise<ErdResult>,
 * readSql: (ids: string[]) => Promise<SqlResult>, readDependencies: (ids: string[]) => Promise<DependencyResult>,
 * phase: (name: string) => boolean,
 * writeToDisk: (info: any, op: PullOperation, next: any) => Promise<boolean>,
 * applySnapshot: (next: any) => void, mergeSchemaIntoViews: () => void,
 * setStatus: (text: string, kind?: string) => void, render: () => void,
 * finish: (warnings: boolean) => void, }} PullUseCaseDeps */

/** @param {PullUseCaseDeps} deps */
function createAnalyticsPullUseCase(deps) {
  /** @param {PullOperation} operation */
  async function run(operation) {
    await deps.requirePerm(operation.root);
    deps.setBusy(true, 'Reading the workspace…');
    const info = await deps.readWorkspace();
    deps.setBusy(true, 'Reading the view list…');
    const vl = await deps.readViews();
    if (!operation.current()) return { moved: true };
    deps.setBusy(true, 'Reading structure and relations…');
    const sc = await deps.readErd();
    if (!operation.current()) return { moved: true };
    const nextViews = vl.views || [];
    const qIds = nextViews.filter((v) => v.type === 'QueryTable').map((v) => v.id);
    deps.setBusy(true, `Reading SQL… 0 / ${qIds.length}`);
    const sq = await deps.readSql(qIds);
    if (!operation.current()) return { moved: true };
    const allIds = nextViews.map((v) => v.id);
    deps.setBusy(true, `Reading lineage… 0 / ${allIds.length}`);
    const dp = await deps.readDependencies(allIds);
    if (!operation.current()) return { moved: true };
    const next = {
      views: nextViews, folders: vl.folders || [], schema: sc.tables || {}, relations: sc.relations || [],
      sqls: sq.sql || {}, deps: dp.deps || {},
      pullFailed: [].concat((sq.failed || []).map((f) => ({ ...f, stage: 'sql' })),
                            (dp.failed || []).map((f) => ({ ...f, stage: 'lineage' }))),
    };
    deps.phase('planning'); deps.phase('writing');
    if (!(await deps.writeToDisk(info, operation, next))) return { moved: true };
    deps.phase('refreshing');
    deps.applySnapshot(next);
    deps.mergeSchemaIntoViews();
    return { next, qIds };
  }
  return run;
}
