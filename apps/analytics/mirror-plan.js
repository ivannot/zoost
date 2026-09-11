// @ts-check
/* Immutable mirror plan. Deletions are legal only after a complete census. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function buildMirrorPlan(previous, next, options = {}) {
  const oldMap = previous && typeof previous === 'object' ? previous : {};
  const newMap = next && typeof next === 'object' ? next : {};
  const complete = options.complete === true;
  const creates = [], updates = [], keeps = [], deletes = [];
  for (const key of Object.keys(newMap).sort()) {
    if (!(key in oldMap)) creates.push(key);
    else if (stableStringify(oldMap[key]) !== stableStringify(newMap[key])) updates.push(key);
    else keeps.push(key);
  }
  if (complete) for (const key of Object.keys(oldMap).sort()) if (!(key in newMap)) deletes.push(key);
  return Object.freeze({ complete, creates: Object.freeze(creates), updates: Object.freeze(updates), keeps: Object.freeze(keeps), deletes: Object.freeze(deletes) });
}
function validateMirrorPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('invalid mirror plan');
  if (typeof plan.complete !== 'boolean') throw new Error('invalid mirror plan completeness');
  for (const key of ['creates', 'updates', 'keeps', 'deletes']) {
    if (!Array.isArray(plan[key])) throw new Error(`invalid mirror plan ${key}`);
  }
  const seen = new Set();
  for (const key of ['creates', 'updates', 'keeps', 'deletes']) {
    for (const path of plan[key]) {
      if (typeof path !== 'string' || !path || seen.has(path)) throw new Error('invalid mirror plan paths');
      seen.add(path);
    }
  }
  if (plan.complete !== true && plan.deletes.length) throw new Error('partial mirror cannot delete files');
  return true;
}
