// @ts-check
/* The immutable plan behind one CRM Pull all.
 *
 * Settings live in another browser tab and may change while a pull runs. The panel supplies one
 * snapshot of the relevant facts; this module decides the run once and records which explicit
 * permission rechecks can be spent only after Zoho has actually answered.
 */

/** @typedef {{id: string, [field: string]: unknown}} PullArea */
/** @typedef {{
 * recheck: (id: string) => boolean,
 * forbidden: (id: string) => boolean,
 * enabled: (id: string) => boolean,
 * verdictAt: (id: string) => unknown,
 * }} PullPlanFacts */
/** @typedef {{areas: PullArea[], skipped: string[], asked: string[], askedBefore: Record<string, unknown>}} PullPlan */

/** @param {PullArea[]} tabs @param {PullPlanFacts} facts @returns {PullPlan} */
function buildPullPlan(tabs, facts) {
  const areas = [];
  const skipped = [];
  const asked = [];
  /** @type {Record<string, unknown>} */
  const askedBefore = {};
  for (const tab of tabs) {
    if (facts.recheck(tab.id)) {
      areas.push(tab);
      asked.push(tab.id);
      askedBefore[tab.id] = facts.verdictAt(tab.id);
      continue;
    }
    if (facts.forbidden(tab.id)) continue;
    if (!facts.enabled(tab.id)) skipped.push(tab.id);
    else areas.push(tab);
  }
  return { areas, skipped, asked, askedBefore };
}

/** A recheck is spent only when its access verdict moved during this run.
 * @param {PullPlan} plan @param {(id: string) => unknown} verdictAt */
function answeredPullRechecks(plan, verdictAt) {
  return plan.asked.filter((id) => verdictAt(id) !== plan.askedBefore[id]);
}
