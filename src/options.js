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

const SCOPE_KEYS = ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules', 'health'];
const SCOPE_FULL = { functions: true, code: true, modules: true, layouts: true, relations: true, workflows: true, schedules: true, health: true };
const SCOPE_SAFE = { functions: true, code: false, modules: true, layouts: true, relations: true, workflows: false, schedules: false, health: false };
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
    maxIter: c.maxIter || 8,
  };
  $('aiengine').value = cfg.active;
  $('ai_a_model').value = cfg.anthropic.model; $('ai_a_key').value = cfg.anthropic.apiKey;
  $('ai_o_model').value = cfg.openai.model; $('ai_o_key').value = cfg.openai.apiKey;
  $('ai_maxiter').value = cfg.maxIter;
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
    maxIter: Math.max(1, Math.min(30, parseInt($('ai_maxiter').value, 10) || 8)),
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

// ---------- init ----------
(async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  $('legal').textContent = LEGAL_DISCLAIMER;
  await showRoot(); await loadAi(); await loadScope(); await loadLay();
})();
