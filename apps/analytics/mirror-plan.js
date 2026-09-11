// @ts-check
/* Immutable mirror plan. Deletions are legal only after a complete census. */
function buildMirrorPlan(previous, next, options = {}) {
  const oldMap = previous && typeof previous === 'object' ? previous : {};
  const newMap = next && typeof next === 'object' ? next : {};
  const complete = options.complete === true;
  const creates = [], updates = [], keeps = [], deletes = [];
  for (const key of Object.keys(newMap).sort()) {
    if (!(key in oldMap)) creates.push(key);
    else if (JSON.stringify(oldMap[key]) !== JSON.stringify(newMap[key])) updates.push(key);
    else keeps.push(key);
  }
  if (complete) for (const key of Object.keys(oldMap).sort()) if (!(key in newMap)) deletes.push(key);
  return Object.freeze({ complete, creates: Object.freeze(creates), updates: Object.freeze(updates), keeps: Object.freeze(keeps), deletes: Object.freeze(deletes) });
}
function validateMirrorPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('invalid mirror plan');
  if (plan.complete !== true && Array.isArray(plan.deletes) && plan.deletes.length) throw new Error('partial mirror cannot delete files');
  return true;
}
