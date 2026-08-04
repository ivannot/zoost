/* options.js — Zoost settings.
 * Everything here writes to storage the side panel and the graph window already read:
 *   IndexedDB 'zoost'/kv  → rootDir (FileSystemDirectoryHandle)
 *   chrome.storage.local  → aicfg, exportScope, erParams
 * A `settingsStamp` is bumped on every change so an open side panel can react.
 */
const $ = (id) => document.getElementById(id);

const LEGAL_DISCLAIMER = 'Independent, unofficial tool. Not affiliated with, endorsed by, sponsored by or supported by '
  + 'Zoho Corporation. "Zoho", "Zoho CRM" and "Deluge" are trademarks of Zoho Corporation, used here in a nominative '
  + 'sense only, to indicate compatibility. Licensed under the Apache License 2.0 and provided AS IS, WITHOUT WARRANTIES '
  + 'OR CONDITIONS OF ANY KIND, express or implied. The author accepts no liability for any loss, damage or data issue '
  + 'arising from its use, and is under no obligation to provide support or maintenance.';

const SCOPE_KEYS = ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules', 'connections', 'health'];
const SCOPE_FULL = { functions: true, code: true, modules: true, layouts: true, relations: true, workflows: true, schedules: true, connections: true, health: true };
const SCOPE_SAFE = { functions: true, code: false, modules: true, layouts: true, relations: true, workflows: false, schedules: false, connections: true, health: false };
const LAY_DEFAULT = { margin: 36, spread: 42, ring: 420, gap: 8, fs: 10, sub: true };
const LAY_CTL = [['pMargin', 'vMargin', 'margin'], ['pSpread', 'vSpread', 'spread'], ['pRing', 'vRing', 'ring'], ['pGap', 'vGap', 'gap'], ['pFs', 'vFs', 'fs']];
const CFG_FILE = '.zoost.json';

let toastT = null;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}
async function stamp() { try { await chrome.storage.local.set({ settingsStamp: Date.now() }); } catch (_) {} }

// ---------- working folder ----------
async function showRoot() {
  let h = null; try { h = await window.idbHandle.get('rootDir'); } catch (_) {}
  const el = $('rootPath');
  if (!h) { el.textContent = 'Not set'; el.classList.add('none'); return; }
  let granted = false;
  try { granted = (await h.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch (_) {}
  el.textContent = h.name + (granted ? '' : '  (access needs to be granted again)');
  el.classList.remove('none');
}
$('pickRoot').onclick = async () => {
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'zoost-root' });
    if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted'
      && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
    // Blast radius: this permission covers everything below the folder.
    let foreign = 0, seen = 0;
    for await (const e of h.values()) {
      if (++seen > 80) break;
      if (e.kind !== 'directory') { foreign++; continue; }
      try { await e.getFileHandle(CFG_FILE); } catch (_) { foreign++; }
    }
    if (foreign > 6 && !confirm(`«${h.name}» already contains ${foreign} items that are not Zoost workspaces.\n\n`
      + 'Zoost will hold read/write access to everything inside it. A dedicated folder is strongly recommended.\n\nUse this folder anyway?')) return;
    await window.idbHandle.set('rootDir', h);
    await stamp(); await showRoot();
    toast('Working folder set. Reopen the side panel to see the workspaces.');
  } catch (e) { if (e?.name !== 'AbortError') toast(e.message, true); }
};
$('clearRoot').onclick = async () => {
  if (!confirm('Forget the working folder?\n\nNothing on disk is deleted — Zoost simply stops using it until you pick one again.')) return;
  await window.idbHandle.set('rootDir', null);
  await window.idbHandle.set('activeWs', null);
  await stamp(); await showRoot();
  toast('Working folder forgotten.');
};

// ---------- AI ----------
async function loadAi() {
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  const cfg = {
    active: c.active || 'anthropic',
    anthropic: Object.assign({ model: '', apiKey: '' }, c.anthropic || {}),
    openai: Object.assign({ model: '', apiKey: '' }, c.openai || {}),
    maxIter: c.maxIter || 20,
    seedCap: c.seedCap || 72000,
  };
  $('aiengine').value = cfg.active;
  $('ai_a_model').value = cfg.anthropic.model; $('ai_a_key').value = cfg.anthropic.apiKey;
  $('ai_o_model').value = cfg.openai.model; $('ai_o_key').value = cfg.openai.apiKey;
  $('ai_maxiter').value = cfg.maxIter;
  $('ai_seedcap').value = cfg.seedCap;
  markEngine();
}
function markEngine() {
  const a = $('aiengine').value === 'anthropic';
  $('provAnthropic').classList.toggle('on', a);
  $('provOpenai').classList.toggle('on', !a);
}
// The engine dropdown is a mode switch, not a text field. Persisting it only on "Save" made it
// possible to change engine, see the panel ignore it, and blame the panel. It now saves on change.
$('aiengine').onchange = async () => {
  markEngine();
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  c.active = $('aiengine').value;
  await chrome.storage.local.set({ aicfg: c }); await stamp();
  toast(`Engine set to ${c.active === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI (ChatGPT)'}.`);
};
$('saveAi').onclick = async () => {
  const cfg = {
    active: $('aiengine').value,
    anthropic: { model: $('ai_a_model').value.trim(), apiKey: $('ai_a_key').value.trim() },
    openai: { model: $('ai_o_model').value.trim(), apiKey: $('ai_o_key').value.trim() },
    maxIter: Math.max(1, Math.min(40, parseInt($('ai_maxiter').value, 10) || 20)),
    seedCap: Math.max(4000, Math.min(400000, parseInt($('ai_seedcap').value, 10) || 72000)),
  };
  const p = cfg[cfg.active] || {};
  await chrome.storage.local.set({ aicfg: cfg }); await stamp();
  toast(p.apiKey && p.model ? 'AI settings saved.' : 'Saved — but the selected engine still needs a model and an API key.', !(p.apiKey && p.model));
};

// ---------- export scope ----------
let scope = Object.assign({}, SCOPE_FULL);
function scopeToUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.checked = !!scope[k]; });
  $('sc_code').disabled = !scope.functions;
  $('sc_layouts').disabled = !scope.modules;
  $('sc_relations').disabled = !scope.modules;
}
function scopeFromUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) scope[k] = !!e.checked; });
  if (!scope.functions) scope.code = false;
  if (!scope.modules) { scope.layouts = false; scope.relations = false; }
  scopeToUI();
}
async function loadScope() {
  try { const r = await chrome.storage.local.get('exportScope'); if (r.exportScope) scope = Object.assign({}, SCOPE_FULL, r.exportScope); } catch (_) {}
  scopeToUI();
}
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('scFull').onclick = () => { scope = Object.assign({}, SCOPE_FULL); scopeToUI(); };
$('scSafe').onclick = () => { scope = Object.assign({}, SCOPE_SAFE); scopeToUI(); };
$('saveScope').onclick = async () => { scopeFromUI(); await chrome.storage.local.set({ exportScope: scope }); await stamp(); toast('Export defaults saved.'); };

// ---------- diagram layout ----------
let lay = Object.assign({}, LAY_DEFAULT);
function layToUI() {
  LAY_CTL.forEach(([sl, lb, k]) => { $(sl).value = lay[k]; $(lb).textContent = k === 'spread' ? (lay[k] / 10).toFixed(1) : lay[k]; });
  $('pSub').checked = !!lay.sub;
}
LAY_CTL.forEach(([sl, lb, k]) => {
  $(sl).addEventListener('input', () => { lay[k] = parseInt($(sl).value, 10); $(lb).textContent = k === 'spread' ? (lay[k] / 10).toFixed(1) : lay[k]; });
});
$('pSub').onchange = () => { lay.sub = $('pSub').checked; };
$('layReset').onclick = () => { lay = Object.assign({}, LAY_DEFAULT); layToUI(); };
$('saveLay').onclick = async () => { await chrome.storage.local.set({ erParams: { current: lay } }); await stamp(); toast('Diagram defaults saved.'); };
async function loadLay() {
  try { const r = await chrome.storage.local.get('erParams'); if (r.erParams && r.erParams.current) lay = Object.assign({}, LAY_DEFAULT, r.erParams.current); } catch (_) {}
  layToUI();
}


// ---------- tabs ----------
//
// The list is the registry's, kept in one place: adding a type to the panel must not mean
// remembering to add a row here. It is duplicated as a literal rather than imported because the
// options page and the side panel do not share a module — if they ever do, this is the first thing
// that should move.
const TAB_DEFS = [
  { id: 'functions',   label: 'Functions',   note: 'Deluge functions, namespaces, cross-references' },
  { id: 'modules',     label: 'Modules',     note: 'fields, layouts, related lists' },
  { id: 'workflows',   label: 'Workflows',   note: 'rules, triggers, actions' },
  { id: 'schedules',   label: 'Schedules',   note: 'scheduled functions' },
  { id: 'connections', label: 'Connections', note: 'the org connection catalogue' },
];
const TAB_IDS = TAB_DEFS.map((t) => t.id);
let tabOrderCur = TAB_IDS.slice();
let tabHiddenCur = [];
let tabNoPullCur = [];
let tabAccessCur = { ws: null, access: {} };

const dayOf = (iso) => {
  const d = new Date(iso);
  // Formatted from local parts. Going through toISOString() shifts the day for anyone east of
  // Greenwich — the trap is written up in CLAUDE.md and this is a date the user reads.
  return isNaN(d) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function renderTabs() {
  const box = $('tablist');
  const acc = tabAccessCur.access || {};
  box.innerHTML = '';
  tabOrderCur.forEach((id, i) => {
    const def = TAB_DEFS.find((t) => t.id === id); if (!def) return;
    const a = acc[id] || {};
    const denied = a.state === 'forbidden';
    const row = document.createElement('div');
    row.className = 'tabrow' + (denied ? ' denied' : '');
    // A refused tab is not a checkbox. Offering to "show" something Zoho will not answer for would be
    // a control that cannot do what it says — the same reason a refused tab is absent from the panel
    // rather than greyed out there.
    const why = denied
      ? `Not granted to your Zoho role${a.status ? ` — Zoho answered ${a.status}` : ''}${a.at ? `, asked ${dayOf(a.at)}` : ''}. Pull again to re-check.`
      : def.note;
    // Two independent switches, because they answer different questions: "do I want to look at this"
    // and "should Zoost even ask Zoho for it". A refused area has neither offered — it is skipped
    // whatever these say, and a control that cannot do what it says is worse than no control.
    row.innerHTML = `<input type="checkbox" ${denied ? 'disabled' : ''} ${tabHiddenCur.includes(id) ? '' : 'checked'} data-id="${id}" title="Show this tab in the side panel">
      <span class="tn"><b>${def.label}</b><span class="why">${why}</span></span>
      <label class="pl" title="Include this type when you click Pull all"><input type="checkbox" ${denied ? 'disabled' : ''} ${(denied || tabNoPullCur.includes(id)) ? '' : 'checked'} data-pull="${id}">pull</label>
      <button class="mv" data-up="${id}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
      <button class="mv" data-down="${id}" ${i === tabOrderCur.length - 1 ? 'disabled' : ''} title="Move down">↓</button>`;
    box.appendChild(row);
  });
  box.querySelectorAll('input[data-id]').forEach((c) => (c.onchange = () => {
    const id = c.dataset.id;
    if (c.checked) {
      tabHiddenCur = tabHiddenCur.filter((x) => x !== id);
    } else {
      tabHiddenCur = tabHiddenCur.concat([id]);
      // Turning a tab off also stops pulling it, and shows that it has: nine times in ten a tab is
      // turned off because that area is not readable anyway, and leaving it in the chain buys one
      // error per pull and nothing else. Shown rather than done invisibly, and you can turn the pull
      // back on for the tenth case — someone who mirrors a type for Git and never browses it.
      if (!tabNoPullCur.includes(id)) tabNoPullCur = tabNoPullCur.concat([id]);
    }
    renderTabs();
  }));
  box.querySelectorAll('input[data-pull]').forEach((c) => (c.onchange = () => {
    const id = c.dataset.pull;
    tabNoPullCur = c.checked ? tabNoPullCur.filter((x) => x !== id) : tabNoPullCur.concat([id]);
  }));
  box.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => move(b.dataset.up, -1)));
  box.querySelectorAll('[data-down]').forEach((b) => (b.onclick = () => move(b.dataset.down, 1)));

  const note = $('tabnote');
  const denied = TAB_IDS.filter((id) => (acc[id] || {}).state === 'forbidden');
  if (denied.length) {
    note.style.display = '';
    note.textContent = `${denied.length} of these is not available in the workspace `
      + `${tabAccessCur.ws ? '“' + tabAccessCur.ws + '”' : 'currently open'}: Zoho refused it for your role. `
      + 'Roles are per org, so another workspace may well grant it.';
  } else if (!tabAccessCur.ws) {
    note.style.display = '';
    note.textContent = 'What your Zoho role allows is discovered by pulling — there is no way to ask in '
      + 'advance. Until a workspace has been pulled, every tab is offered.';
  } else { note.style.display = 'none'; }
}
function move(id, d) {
  const i = tabOrderCur.indexOf(id); const j = i + d;
  if (i < 0 || j < 0 || j >= tabOrderCur.length) return;
  tabOrderCur.splice(j, 0, tabOrderCur.splice(i, 1)[0]);
  renderTabs();
}
async function loadTabs() {
  try {
    const st = await chrome.storage.local.get(['tabPrefs', 'tabAccessView']);
    const p = st && st.tabPrefs;
    if (p && Array.isArray(p.order) && Array.isArray(p.hidden)) {
      const known = p.order.filter((id) => TAB_IDS.includes(id));
      tabOrderCur = known.concat(TAB_IDS.filter((id) => !known.includes(id)));   // a tab added later must appear, not vanish
      tabHiddenCur = p.hidden.filter((id) => TAB_IDS.includes(id));
      tabNoPullCur = (Array.isArray(p.nopull) ? p.nopull : []).filter((id) => TAB_IDS.includes(id));
    }
    if (st && st.tabAccessView) tabAccessCur = st.tabAccessView;
  } catch (_) {}
  renderTabs();
}
$('saveTabs').onclick = async () => {
  await chrome.storage.local.set({ tabPrefs: { order: tabOrderCur, hidden: tabHiddenCur, nopull: tabNoPullCur } });
  await stamp();
  toast('Tabs saved.');
};
$('tabReset').onclick = () => { tabOrderCur = TAB_IDS.slice(); tabHiddenCur = []; tabNoPullCur = []; renderTabs(); };

// ---------- init ----------
(async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  $('legal').textContent = LEGAL_DISCLAIMER;
  await showRoot(); await loadAi(); await loadScope(); await loadLay(); await loadTabs();
})();
