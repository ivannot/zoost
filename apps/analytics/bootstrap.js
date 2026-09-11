// @ts-check
/* Analytics composition root.  The panel owns DOM bindings and presentation; this file wires the
 * transport adapter to the Pull all use case so the application path has one explicit entry point. */
/** @param {object} deps @returns {Function} */
function createAnalyticsBootstrap(deps) {
  if (typeof createAnalyticsPullUseCase !== 'function') throw new Error('Pull use case is unavailable');
  if (typeof createAnalyticsPullAdapter !== 'function') throw new Error('Pull adapter is unavailable');
  const d = /** @type {any} */ (deps);
  const bridge = createAnalyticsPullAdapter((command) => d.toBridge(command));
  return createAnalyticsPullUseCase({
    requirePerm: d.requirePerm, setBusy: d.setBusy,
    ...bridge,
    phase: d.phase, writeToDisk: d.writeToDisk,
    applySnapshot: d.applySnapshot, mergeSchemaIntoViews: d.mergeSchemaIntoViews,
    setStatus: d.setStatus, render: d.render, finish: d.finish,
  });
}
