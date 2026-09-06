/* The functions list, without DOM or workspace state.
 *
 * The panel supplies the current controls and the two product-specific language functions. This
 * module answers which rows are visible and in what order; rendering only turns that answer into
 * elements. Keeping the complete selection in one call also means the empty-state count and the
 * rows on screen cannot apply different filters.
 */

const FUNCTION_NAMES = ['api_name', 'display_name', 'name'];
const TREE_SORTS = {
  name: null,
  lines: { label: 'lines', get: (row) => (row.stats ? row.stats.lines : -1) },
  calls: { label: 'outbound calls', get: (row) => (row.stats ? row.stats.apiCalls : -1) },
  modified: {
    label: 'last modified',
    get: (row) => (row.updatedTime
      ? (Date.parse(String(row.updatedTime).replace(' ', 'T')) || 0) : -1),
  },
  language: { label: 'language', text: true },
};

function functionRowPasses(row, options = {}) {
  const type = options.typeFilter || 'all';
  const language = options.langFilter || 'all';
  const familyOf = options.languageFamily || ((value) => String(value || 'deluge'));
  const typePasses = type === 'all' || (type === 'rest' ? !!row.rest : row.namespace === type);
  return typePasses && (language === 'all' || familyOf(row.language) === language);
}

function functionSortValue(row, key, options) {
  if (key === 'language') return options.languageLabel(options.languageFamily(row.language));
  return TREE_SORTS[key].get(row);
}

function selectFunctionRows(rows, options = {}) {
  const label = options.label || ((row) => row.display_name || row.api_name || row.name || '');
  const nameKeys = options.nameKeys || FUNCTION_NAMES;
  const term = String(options.term || '').trim().toLowerCase();
  const connectionPaths = options.connectionPaths || null;
  const sortKey = options.sortKey || 'name';
  const sortDir = options.sortDir === 'desc' ? 'desc' : 'asc';
  const languageFamily = options.languageFamily || ((value) => String(value || 'deluge'));
  const languageLabel = options.languageLabel || String;
  const filterOptions = {
    typeFilter: options.typeFilter,
    langFilter: options.langFilter,
    languageFamily,
  };
  const filterCount = rows.filter((row) => functionRowPasses(row, filterOptions)).length;
  const visible = rows.filter((row) => functionRowPasses(row, filterOptions))
    .filter((row) => !connectionPaths || connectionPaths.has(row.path))
    .filter((row) => !term || nameKeys.some((key) => String(row[key] || '').toLowerCase().includes(term)));
  const sorter = TREE_SORTS[sortKey];
  if (sorter) {
    const direction = sortDir === 'asc' ? 1 : -1;
    const valueOptions = { languageFamily, languageLabel };
    const sorted = visible.slice().sort((a, b) => {
      const left = functionSortValue(a, sortKey, valueOptions);
      const right = functionSortValue(b, sortKey, valueOptions);
      if (sorter.text) {
        const compared = String(left).localeCompare(String(right));
        return compared ? direction * compared : label(a).localeCompare(label(b));
      }
      // A value nobody has measured is not the smallest value. It stays at the bottom in either
      // direction so the list never presents an unknown as an answer.
      if ((left < 0) !== (right < 0)) return left < 0 ? 1 : -1;
      if (left !== right) return direction * (left - right);
      return label(a).localeCompare(label(b));
    });
    return {
      rows: sorted,
      groups: null,
      filterCount,
      sorter,
      noData: sorter.text
        ? 0 : sorted.filter((row) => functionSortValue(row, sortKey, valueOptions) < 0).length,
    };
  }

  const byNamespace = new Map();
  for (const row of visible) {
    if (!byNamespace.has(row.namespace)) byNamespace.set(row.namespace, []);
    byNamespace.get(row.namespace).push(row);
  }
  const direction = sortDir === 'asc' ? 1 : -1;
  const groups = [...byNamespace.keys()].sort().map((namespace) => ({
    namespace,
    rows: byNamespace.get(namespace).sort((a, b) => direction * label(a).localeCompare(label(b))),
  }));
  return { rows: visible, groups, filterCount, sorter: null, noData: 0 };
}
