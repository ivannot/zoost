// CRM filter and sort control renderer.  The panel supplies state accessors and render callbacks;
// this module owns the DOM construction for the controls so the composition root does not also
// contain the complete filter vocabulary for every tab.
/** @typedef {{
 *  $: (id: string) => HTMLElement, getViewMode: () => string, NS: string[], LANG_FAMILY: string[][],
 *  langFamily: (value: unknown) => string, langFamilyLabel: (value: string) => string,
 *  actionKindLabel: (value: string) => string, getActionData: () => Array<{kind?: string}>,
 *  getCurFilter: () => string, setCurFilter: (value: string) => void,
 *  getLangFilter: () => string, setLangFilter: (value: string) => void,
 *  getActionSort: () => string, setActionSort: (value: string) => void,
 *  getActionSortDir: () => string, setActionSortDir: (value: string) => void,
 *  getTreeSort: () => string, setTreeSort: (value: string) => void,
 *  getTreeSortDir: () => string, setTreeSortDir: (value: string) => void,
 *  TREE_SORTS: Record<string, {text?: boolean}>, lastModified: string,
 *  getTreeData: () => Array<{language?: string}>, runSearch: () => void,
 *  renderModules: () => void, renderWorkflows: () => void, renderSchedules: () => void,
 *  renderActions: () => void, renderConnections: () => void, renderTree: () => void
 * }} CrmTypeChipDeps */

/** @param {CrmTypeChipDeps} deps @returns {() => void} */
function createCrmTypeChips(deps) {
  function buildTypeChips() {
    const wrap = deps.$('typechips'); wrap.innerHTML = '';
    const mode = deps.getViewMode();
    const defs = mode === 'functions'
      ? [['all', 'All'], ...deps.NS.map((n) => [n, n === 'validation_rule' ? 'validation' : n]), ['rest', 'REST']]
      : mode === 'modules'
      ? [['all', 'All'], ['standard', 'Standard'], ['custom', 'Custom']]
      : mode === 'connections'
      ? [['all', 'All'], ['used', 'Used'], ['unused', 'Unused'], ['disconnected', 'Disconnected']]
      : mode === 'actions'
      ? [['all', 'All'], ...[...new Set(deps.getActionData().map((a) => a.kind))].sort().map((k) => [k, deps.actionKindLabel(k)]), ['unused', 'Attached to nothing']]
      : mode === 'workflows'
      ? [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive'], ['scheduled', 'Has scheduled actions']]
      : [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive']];
    const curFilter = deps.getCurFilter;
    const keep = defs.some(([k]) => k === curFilter()) ? curFilter() : 'all';
    deps.setCurFilter(keep);
    const lbl = document.createElement('span'); lbl.className = 'fsellbl';
    lbl.textContent = mode === 'functions' ? 'Type' : (mode === 'modules' || mode === 'actions') ? 'Kind' : mode === 'connections' ? 'Filter' : 'Status';
    const sel = document.createElement('select'); sel.className = 'filtersel'; sel.setAttribute('aria-label', lbl.textContent + ' filter');
    defs.forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; sel.appendChild(o); });
    sel.value = keep;
    sel.onchange = () => {
      const k = sel.value; deps.setCurFilter(k);
      (mode === 'functions' ? deps.runSearch : mode === 'modules' ? deps.renderModules : mode === 'workflows' ? deps.renderWorkflows : mode === 'schedules' ? deps.renderSchedules : mode === 'actions' ? deps.renderActions : deps.renderConnections)();
    };
    wrap.appendChild(lbl); wrap.appendChild(sel);
    if (mode === 'functions') {
      const seen = new Set(deps.getTreeData().map((e) => deps.langFamily(e.language)));
      const langs = deps.LANG_FAMILY.map(([k]) => k).filter((k) => seen.has(k))
        .concat([...seen].filter((k) => !deps.LANG_FAMILY.some(([n]) => n === k)).sort());
      if (langs.length > 1) {
        if (deps.getLangFilter() !== 'all' && !langs.includes(deps.getLangFilter())) deps.setLangFilter('all');
        const ll = document.createElement('span'); ll.className = 'fsellbl'; ll.textContent = 'Language';
        const ls = document.createElement('select'); ls.className = 'filtersel'; ls.setAttribute('aria-label', 'Language filter');
        [['all', 'All'], ...langs.map((k) => [k, deps.langFamilyLabel(k)])].forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; ls.appendChild(o); });
        ls.value = deps.getLangFilter(); ls.onchange = () => { deps.setLangFilter(ls.value); deps.runSearch(); };
        wrap.appendChild(ll); wrap.appendChild(ls);
      } else if (deps.getLangFilter() !== 'all') deps.setLangFilter('all'); // the control is gone
    }
    if (mode === 'functions' || mode === 'actions') {
      const acts = mode === 'actions';
      const sl = document.createElement('span'); sl.className = 'fsellbl'; sl.textContent = 'Sort';
      const ss = document.createElement('select'); ss.className = 'filtersel'; ss.setAttribute('aria-label', acts ? 'Sort actions' : 'Sort functions');
      (acts ? [['name', 'Kind, then name'], ['rules', 'Rules that fire it'], ['module', 'Module'], ['modified', deps.lastModified]]
            : [['name', 'Name (grouped)'], ['lines', 'Lines'], ['calls', 'API calls'], ['language', 'Language'], ['modified', deps.lastModified]])
        .forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; ss.appendChild(o); });
      const currentSort = () => acts ? deps.getActionSort() : deps.getTreeSort();
      ss.value = currentSort();
      const dirBtn = document.createElement('button'); dirBtn.className = 'sortdir';
      const paintDir = () => {
        const asc = (acts ? deps.getActionSortDir() : deps.getTreeSortDir()) === 'asc'; dirBtn.textContent = asc ? '↑' : '↓';
        const sort = currentSort();
        const byName = acts ? (sort === 'name' || sort === 'module') : (sort === 'name' || (deps.TREE_SORTS[sort] && deps.TREE_SORTS[sort].text));
        dirBtn.title = byName ? (asc ? 'A to Z - click for Z to A' : 'Z to A - click for A to Z') : (asc ? 'Lowest first - click for highest first' : 'Highest first - click for lowest first');
        dirBtn.setAttribute('aria-label', dirBtn.title);
      };
      ss.onchange = () => {
        const next = ss.value;
        if (acts) { deps.setActionSort(next); deps.setActionSortDir((next === 'name' || next === 'module') ? 'asc' : 'desc'); }
        else { deps.setTreeSort(next); deps.setTreeSortDir((next === 'name' || (deps.TREE_SORTS[next] && deps.TREE_SORTS[next].text)) ? 'asc' : 'desc'); }
        paintDir(); (acts ? deps.renderActions : deps.renderTree)();
      };
      dirBtn.onclick = () => {
        if (acts) deps.setActionSortDir(deps.getActionSortDir() === 'asc' ? 'desc' : 'asc');
        else deps.setTreeSortDir(deps.getTreeSortDir() === 'asc' ? 'desc' : 'asc');
        paintDir(); (acts ? deps.renderActions : deps.renderTree)();
      };
      paintDir(); wrap.appendChild(sl); wrap.appendChild(ss); wrap.appendChild(dirBtn);
    }
  }
  return buildTypeChips;
}
