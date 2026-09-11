// @ts-check
/* CRM composition root.  All platform, filesystem and UI adapters are supplied by the panel; the
 * controller is constructed here so there is one auditable place where the application is wired. */
/** @param {object} deps @returns {object} */
function createCrmBootstrap(deps) {
  if (typeof createCrmPullController !== 'function') throw new Error('Pull controller is unavailable');
  // In the shipped document the lifecycle script is a required dependency.  The document guard is
  // intentional: low-level VM tests can still compose the controller in isolation without having
  // to recreate a browser document, while a real panel fails closed on a load-order regression.
  if (typeof createPullLifecycle !== 'function') {
    if (typeof document !== 'undefined') throw new Error('Pull lifecycle is unavailable');
    return createCrmPullController(/** @type {any} */ (deps));
  }
  const d = /** @type {any} */ (deps);
  return createCrmPullController({ ...d, lifecycle: createPullLifecycle() });
}
