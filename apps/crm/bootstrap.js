// @ts-check
/* CRM composition root.  All platform, filesystem and UI adapters are supplied by the panel; the
 * controller is constructed here so there is one auditable place where the application is wired. */
/** @param {object} deps @returns {object} */
function createCrmBootstrap(deps) {
  if (typeof createCrmPullController !== 'function') throw new Error('CRM pull controller is unavailable');
  return createCrmPullController(/** @type {any} */ (deps));
}
