/*
 * options.js — Zoost for Zoho Analytics, settings.
 *
 * AI configuration lives here, not in the side panel: the panel is ~400px wide and these are
 * set-once fields. The panel picks changes up via chrome.storage.onChanged.
 */
'use strict';

const $ = (id) => document.getElementById(id);
// Attribute-safe escaping: `&`, `<`, `>` and both quote characters. Identical to the definition in
// the panels and the graph windows — one behaviour under one name, so a reader never has to check
// which file they are in.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PRODUCT_AUTHOR = 'Ivan Notaristefano';
const LEGAL_DISCLAIMER = 'Independent, unofficial tool. Not affiliated with, endorsed by, sponsored by or supported by Zoho Corporation. '
  + '"Zoho" and "Zoho Analytics" are trademarks of Zoho Corporation, used here in a nominative sense only, to indicate compatibility. '
  + 'Licensed under the Apache License 2.0 and provided AS IS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. '
  + 'The author accepts no liability for any loss, damage or data issue arising from its use, and is under no obligation to provide support or maintenance. '
  + 'Deciding what may be extracted from Analytics, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';

// The ER preset the graph window starts from. Kept identical to ER_PRESET.modules in graphview.js:
// the two are the same setting seen from two places, not a default and a copy of it.
const LAY_DEFAULT = { margin: 36, spread: 42, ring: 420, gap: 8, fs: 10, sub: true };
const LAY_CTL = [['pMargin', 'vMargin', 'margin'], ['pSpread', 'vSpread', 'spread'], ['pRing', 'vRing', 'ring'], ['pGap', 'vGap', 'gap'], ['pFs', 'vFs', 'fs']];
let lay = Object.assign({}, LAY_DEFAULT);

let toastT = null;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'on' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 2600);
}

async function loadAi() {
  let c = {};
  try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  $('aiengine').value = c.active || 'anthropic';
  $('ai_a_model').value = (c.anthropic && c.anthropic.model) || '';
  $('ai_a_key').value = (c.anthropic && c.anthropic.apiKey) || '';
  $('ai_o_model').value = (c.openai && c.openai.model) || '';
  $('ai_o_key').value = (c.openai && c.openai.apiKey) || '';
  $('ai_maxiter').value = c.maxIter || 20;
  $('ai_seedcap').value = c.seedCap || 72000;
  markEngine();
}
// A selector that changes a *mode* saves on change, not behind a Save button — the same rule as the
// CRM options page.
function markEngine() {
  const e = $('aiengine').value;
  $('provAnthropic').classList.toggle('on', e === 'anthropic');
  $('provOpenai').classList.toggle('on', e === 'openai');
}
async function saveAi(silent) {
  const cfg = {
    active: $('aiengine').value,
    anthropic: { model: $('ai_a_model').value.trim(), apiKey: $('ai_a_key').value.trim() },
    openai: { model: $('ai_o_model').value.trim(), apiKey: $('ai_o_key').value.trim() },
    maxIter: Math.max(1, Math.min(40, Number($('ai_maxiter').value) || 20)),
    seedCap: Math.max(4000, Math.min(400000, Number($('ai_seedcap').value) || 72000)),
  };
  markOwn('aicfg'); dirty.delete('aicfg'); conflictBox('aicfg', false);
  try { await chrome.storage.local.set({ aicfg: cfg }); if (!silent) toast('AI settings saved.'); }
  catch (e) { toast('Could not save: ' + e.message, true); }
}

function layToUI() {
  LAY_CTL.forEach(([sl, lb, k]) => { $(sl).value = lay[k]; $(lb).textContent = k === 'spread' ? (lay[k] / 10).toFixed(1) : lay[k]; });
  $('pSub').checked = !!lay.sub;
}
LAY_CTL.forEach(([sl, lb, k]) => {
  $(sl).addEventListener('input', () => { lay[k] = parseInt($(sl).value, 10); $(lb).textContent = k === 'spread' ? (lay[k] / 10).toFixed(1) : lay[k]; });
});
$('pSub').onchange = () => { lay.sub = $('pSub').checked; };
$('layReset').onclick = () => { lay = Object.assign({}, LAY_DEFAULT); layToUI(); };
$('saveLay').onclick = async () => {
  markOwn('erParams'); dirty.delete('erParams'); conflictBox('erParams', false);
  try { await chrome.storage.local.set({ erParams: { current: lay } }); toast('Diagram defaults saved.'); }
  catch (e) { toast('Could not save: ' + e.message, true); }
};
async function loadLay() {
  try { const r = await chrome.storage.local.get('erParams'); if (r.erParams && r.erParams.current) lay = Object.assign({}, LAY_DEFAULT, r.erParams.current); } catch (_) {}
  layToUI();
}

$('aiengine').onchange = () => { markEngine(); saveAi(true); };
$('saveAi').onclick = () => saveAi(false);

// ---------- guarding against the stale save ----------
//
// One settings window stops you having two copies of this form. It does not stop this copy going out
// of date while it sits open, so each section watches its own key: changed elsewhere and untouched
// here, the form catches up silently; changed elsewhere while you were editing, nothing is
// overwritten in either direction and you choose. Never resolve it by guessing which side is newer.
//
// The same mechanism, the same wording and the same markup as the CRM workbench — this is shared
// chrome, and the two panels must not disagree about what a settings conflict looks like.
const SECTIONS = {
  aicfg: { label: 'AI assistant', reload: loadAi },
  erParams: { label: 'Diagram layout', reload: loadLay },
};
const dirty = new Set();
const ownWrite = new Map();
function markOwn(key) { ownWrite.set(key, Date.now()); }
function wasOwn(key) {
  const t = ownWrite.get(key);
  if (t && Date.now() - t < 3000) { ownWrite.delete(key); return true; }
  return false;
}
function markDirty(key) { dirty.add(key); }
function conflictBox(key, on) {
  const id = 'cf_' + key;
  let el = document.getElementById(id);
  const sec = document.querySelector(`[data-section="${escA(key)}"]`);
  if (!sec) return;
  if (!on) { if (el) el.remove(); return; }
  if (el) return;
  el = document.createElement('div');
  el.id = id; el.className = 'conflict';
  el.innerHTML = `<b>${SECTIONS[key].label} changed somewhere else</b> while you were editing here. `
    + 'Saving now would overwrite it with what this page loaded.'
    + '<span class="cfb"><button data-take="' + key + '">Take theirs</button>'
    + '<button data-keep="' + key + '">Keep mine</button></span>';
  sec.insertBefore(el, sec.firstChild);
  el.querySelector('[data-take]').onclick = async () => { dirty.delete(key); await SECTIONS[key].reload(); conflictBox(key, false); };
  el.querySelector('[data-keep]').onclick = () => conflictBox(key, false);
}
document.querySelectorAll('[data-section]').forEach((sec) => {
  const k = sec.dataset.section;
  sec.addEventListener('input', () => markDirty(k));
  sec.addEventListener('change', () => markDirty(k));
});
try {
  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(SECTIONS)) {
      if (!ch[key] || wasOwn(key)) continue;
      if (dirty.has(key)) conflictBox(key, true);
      else { try { await SECTIONS[key].reload(); } catch (_) {} }
    }
  });
} catch (_) {}

(function init() {
  const m = chrome.runtime.getManifest();
  $('ttl').textContent = m.name;
  $('ver').textContent = 'v' + m.version;
  $('sqlrules').innerHTML = '<ul style="margin:0;padding-left:18px">'
    + window.ZOHO_ANALYTICS_SQL.rules.map((r) => `<li style="padding:2px 0">${esc(r).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')}</li>`).join('')
    + '</ul>';
  $('legal').innerHTML = `<b>${esc(m.name)}</b> v${esc(m.version)} · created by ${esc(PRODUCT_AUTHOR)} (with the support of Claudio)<br><br>${esc(LEGAL_DISCLAIMER)}`;
  loadAi();
  loadLay();
})();
