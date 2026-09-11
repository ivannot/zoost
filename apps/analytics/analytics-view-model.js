// @ts-check
/* Pure Analytics view derivations.  The panel owns state and DOM; this module receives snapshots
 * explicitly so list, relation and structure logic can be exercised without Chrome or a document. */
function createAnalyticsViewModel() {
  function isOrphanCandidateModel(view, dependencies) {
    if (!dependencies) return false;
    const dependency = dependencies[view.id];
    if (!dependency || view.type === 'Dashboard') return false;
    return dependency.children.length === 0 && dependency.dashboards.length === 0;
  }
  function mergeSchemaModel(views, schema) {
    return views.map((view) => ({ ...view, designModifiedAt: schema[view.id]?.designModifiedAt || null,
      system: !!schema[view.id]?.system }));
  }
  function foreignKeysModel(viewId, relations) {
    const out = new Map(), inc = new Map();
    for (const relation of relations || []) {
      if (relation.source === viewId) for (let i = 0; i < relation.sourceColumns.length; i++) {
        const column = relation.sourceColumns[i]; if (!out.has(column)) out.set(column, []);
        out.get(column).push({ id: relation.target, name: relation.targetName, column: relation.targetColumns[i] || relation.targetColumns[0] || '' });
      }
      if (relation.target === viewId) for (let i = 0; i < relation.targetColumns.length; i++) {
        const column = relation.targetColumns[i]; if (!inc.has(column)) inc.set(column, []);
        inc.get(column).push({ id: relation.source, name: relation.sourceName, column: relation.sourceColumns[i] || relation.sourceColumns[0] || '' });
      }
    }
    return { out, inc };
  }
  const relationsOfModel = (id, relations) => (relations || []).filter((r) => r.source === id || r.target === id);
  function viewByIdModel(views) {
    const list = Array.isArray(views) ? views : views instanceof Map ? [...views.values()]
      : views && typeof views === 'object' ? Object.values(views) : [];
    return new Map(list.map((view) => [view.id, view]));
  }
  const nameOfModel = (id, views) => { const view = viewByIdModel(views).get(id); return view?.name || String(id == null ? '?' : id); };
  function structureChainModel(view, views, schema = {}) {
    const map = viewByIdModel(views), chain = [], seen = new Set(); let current = view;
    while (current && !seen.has(current.id)) {
      seen.add(current.id); chain.push(current);
      if (schema[current.id]) return chain;
      current = current.parent ? map.get(current.parent) : null;
    }
    return null;
  }
  return Object.freeze({ isOrphanCandidate: isOrphanCandidateModel, mergeSchema: mergeSchemaModel,
    foreignKeys: foreignKeysModel, relationsOf: relationsOfModel, viewById: viewByIdModel, nameOf: nameOfModel,
    structureChain: structureChainModel });
}
