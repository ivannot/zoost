/* The Analytics view list, without DOM or panel state.
 *
 * The caller supplies the current search controls and the data already read from disk. This module
 * owns the complete filter-and-sort decision, including the distinction between zero dependencies
 * and lineage that was never read.
 */

function selectAnalyticsViews(rows, options = {}) {
  const typeFilter = options.typeFilter || null;
  const orphanToken = options.orphanToken || '__orphans__';
  const search = options.search || {};
  const query = String(search.text || '').trim().toLowerCase();
  const schema = options.schema || {};
  const sqlCache = options.sqlCache || null;
  const dependencies = options.dependencies || null;
  const sortKey = options.sortKey || 'name';
  const sortDir = options.sortDir === -1 ? -1 : 1;
  const isOrphan = options.isOrphan || (() => false);
  let selected = rows;

  if (typeFilter === orphanToken) {
    selected = selected.filter(isOrphan);
  } else if (typeFilter) {
    selected = selected.filter((view) => view.type === typeFilter);
  }

  if (query && search.mode === 'sql') {
    const compiled = search.regex ? options.compileRegex(String(search.text || '').trim()) : null;
    selected = compiled && compiled.error ? [] : selected.filter((view) => sqlCache
      && options.sqlMatches(sqlCache.get(view.id), query, compiled && compiled.re));
  } else if (query) {
    selected = selected.filter((view) => {
      if ((view.name || '').toLowerCase().includes(query)
          || (view.folderName || '').toLowerCase().includes(query)) return true;
      const table = schema[view.id];
      return !!(table && table.columns.some((column) => String(column.name || '').toLowerCase().includes(query)));
    });
  }

  return selected.slice().sort((a, b) => {
    if (sortKey === 'readBy') {
      const count = (view) => {
        const entry = dependencies && dependencies[view.id];
        return entry ? entry.children.length + entry.dashboards.length : null;
      };
      const left = count(a), right = count(b);
      if (left == null && right == null) return 0;
      if (left == null) return 1;
      if (right == null) return -1;
      return (left - right) * sortDir;
    }
    if (sortKey === 'dataModifiedAt' || sortKey === 'designModifiedAt') {
      const left = a[sortKey], right = b[sortKey];
      if (!left && !right) return 0;
      if (!left) return 1;
      if (!right) return -1;
      return (left - right) * sortDir;
    }
    const left = a[sortKey] ?? '', right = b[sortKey] ?? '';
    return String(left).localeCompare(String(right), undefined,
      { numeric: true, sensitivity: 'base' }) * sortDir;
  });
}
