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
  + 'Deciding what may be extracted from Zoho Analytics, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';

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

/** Decide what each provider's stored key becomes, given what was typed and what was already there.
 *
 * Lifted out of the Save handler on purpose: it is the part with a wrong answer that loses data. Two
 * rules, both learnt the hard way.
 *
 * A blank field with a key already stored means **leave it alone**, never "erase it" — the field is
 * blank because a protected key cannot be redisplayed, and reading that as a deletion would throw the
 * key away on every unrelated save. `forget` is the one declared exception, and it says so on screen.
 *
 * And **nothing here destroys**. Every path that cannot produce a plaintext — no passphrase, wrong
 * passphrase — carries the ciphertext over untouched and lets the handler refuse. A merge that deletes
 * what it failed to read is how "turn the protection off" became a way to lose a key.
 */
async function mergeKeys(cfg, prev, wantLock, pass, forget, cur) {
  for (const prov of ['anthropic', 'openai']) {
    const typed = cfg[prov].apiKey;
    const had = prev[prov] || {};
    if (forget && forget.has(prov)) { cfg[prov].apiKey = ''; delete cfg[prov].apiKeyEnc; continue; }

    // The plaintext to store, from the most authoritative source available. Decrypting is the last
    // resort and the only one that can fail.
    let plain = typed || had.apiKey || null;
    if (!plain && had.apiKeyEnc && cur) plain = await window.ZOOST_KEYVAULT.unlock(had.apiKeyEnc, cur);

    if (wantLock) {
      // `pass` is a *new* passphrase; with none given the one already in use stays in use.
      const phrase = pass || cur;
      if (plain && phrase) cfg[prov].apiKeyEnc = await window.ZOOST_KEYVAULT.lock(plain, phrase);
      else if (had.apiKeyEnc) cfg[prov].apiKeyEnc = had.apiKeyEnc;
      delete cfg[prov].apiKey;                       // the plaintext must not survive the switch
    } else if (plain) {
      cfg[prov].apiKey = plain;
    } else if (had.apiKeyEnc) {
      cfg[prov].apiKeyEnc = had.apiKeyEnc;           // could not read it, so it is kept, not dropped
    }
  }
  return cfg;
}

// Which providers the Forget button has emptied, pending Save. It has to be tracked rather than
// inferred from the blank fields, because blank means "keep what is stored" everywhere else on this
// page — that is the rule protecting a passphrase-locked key, and it would otherwise make forgetting
// impossible. Nothing is written until Save, so the way to undo is to reload the page.
const aiForget = new Set();
function wireForget(prov, keyId, modelId) {
  $(`ai_${prov === 'anthropic' ? 'a' : 'o'}_forget`).onclick = () => {
    aiForget.add(prov);
    $(keyId).value = ''; $(modelId).value = '';
    $(keyId).placeholder = 'will be removed when you save';
    $(modelId).placeholder = 'will be removed when you save';
    markEngine();
  };
}

/** Selecting an engine that cannot answer is a dead end the panel only discovers later, so it is
 *  refused here. The *form* is what decides, not what is stored: refusing a key the user can see they
 *  have just typed would be the tool arguing with its own screen.
 *
 *  The guard alone was not enough, and the gap was the obvious one: it stopped you *moving to* an
 *  unconfigured engine while saying nothing about *sitting on* one. A fresh install starts on
 *  Anthropic with nothing filled in, so the selector showed a chosen, working engine that could not
 *  answer a single question — the rule enforced on the user and not on the default. So the options
 *  say which of them is ready, and a save that leaves exactly one usable engine selects it. */
function engineIncomplete(which) {
  const model = $(which === 'anthropic' ? 'ai_a_model' : 'ai_o_model').value.trim();
  const key = $(which === 'anthropic' ? 'ai_a_key' : 'ai_o_key').value.trim();
  const stored = aiStored[which] || {};
  const hasKey = key || (!aiForget.has(which) && (stored.apiKey || stored.apiKeyEnc));
  const hasModel = model || (!aiForget.has(which) && stored.model);
  const missing = [!hasModel && 'a model', !hasKey && 'an API key'].filter(Boolean);
  return missing.length ? missing.join(' and ') : null;
}
let aiStored = { anthropic: {}, openai: {} };

/** The passphrase row is shown whenever a passphrase is *needed*, which is not the same as "protection
 *  is on". Turning it off asks for the current one, because going back to clear text means decrypting
 *  what is stored and only the user can do that. Getting this wrong would leave the only way out of
 *  the feature being "delete the key", which is the trap this whole design exists to avoid. */
let aiLockStored = false;      // a passphrase is set right now, according to what is on disk
let aiPassChanging = false;    // …and the user has asked to replace it

/** Is the passphrase already in use needed for this save?
 *
 * Three things need it, and all three are the same fact: **you cannot re-encrypt what you cannot
 * decrypt.** Turning the protection off, changing the passphrase, and replacing the API key all end
 * in a write that must start from the plaintext, and only the user can produce it. Missing this is
 * what made "Change passphrase" ask for the new one twice, save, report success, and change nothing.
 */
function aiNeedCurrent() {
  if (!aiLockStored) return false;
  const typed = $('ai_a_key').value.trim() || $('ai_o_key').value.trim();
  return !$('ai_lock').checked || aiPassChanging || !!typed;
}

/** The dropdown says which engines can actually answer. Nothing is hidden and nothing is disabled:
 *  an option you cannot pick and cannot see the reason for is worse than one that states its state. */
/** The way out when the passphrase is gone.
 *
 * There was one already — Forget on each provider, then untick, then save — and it had to be *worked
 * out*, which is not a way out. Somebody who has lost a passphrase is not in the mood to deduce a
 * three-step sequence from a form, and a recovery path nobody can find is the same as none.
 *
 * It acts immediately rather than waiting for Save, and that is deliberate: Save asks for the
 * passphrase in use, which is the one thing that does not exist here. Destructive, so it says exactly
 * what goes and exactly what stays before doing it.
 */
async function loseLock() {
  const prev = await currentAi();
  const which = ['anthropic', 'openai'].filter((p) => (prev[p] || {}).apiKeyEnc);
  if (!which.length) return;
  const names = which.map((p) => (p === 'anthropic' ? 'Anthropic' : 'OpenAI')).join(' and ');
  if (!window.confirm(
    `Without the passphrase the stored key cannot be decrypted by anyone, including Zoost.\n\n`
    + `This removes the encrypted ${names} key and turns the protection off.\n\n`
    + `Kept: your model names, and every other setting on this page.\n`
    + `Lost: nothing but the stored key — paste it in again from your provider's dashboard.\n\n`
    + `Continue?`)) return;
  const cfg = Object.assign({}, (await chrome.storage.local.get('aicfg')).aicfg || {});
  for (const prov of which) { cfg[prov] = Object.assign({}, cfg[prov]); delete cfg[prov].apiKeyEnc; cfg[prov].apiKey = ''; }
  markOwn('aicfg'); dirty.delete('aicfg'); conflictBox('aicfg', false);
  await chrome.storage.local.set({ aicfg: cfg });
  try { await chrome.storage.session.remove('aikeys'); } catch (_) {}
  aiPassChanging = false;
  await loadAi();
  toast(`Protection removed. Paste the ${names} API key in again, then save.`, true);
}

/** Put the caret in the first field the row is actually asking for.
 *
 * Derived from what is on screen rather than named: "Change passphrase" reveals *two* questions and
 * the first of them is the passphrase in use, so hard-coding the new-passphrase field sent the caret
 * past the field that has to be filled in first. Anything that changes which fields are asked for
 * keeps working without remembering this.
 */
function focusFirstAsked() {
  const first = ['ai_passcur', 'ai_pass'].map((id) => $(id)).find((el) => el && !el.closest('label').hidden);
  if (first) first.focus();
}

function markEngineOptions() {
  const sel = $('aiengine');
  [...sel.options].forEach((o) => {
    const base = o.dataset.label || (o.dataset.label = o.textContent);
    const missing = engineIncomplete(o.value);
    o.textContent = missing ? `${base} — needs ${missing}` : base;
  });
}

function syncLockRow() {
  const want = $('ai_lock').checked;
  const needCur = aiNeedCurrent();
  const needNew = want && (!aiLockStored || aiPassChanging);
  // A control with nothing to ask is absent, not shown empty: a pair of blank boxes under a key that
  // is already protected reads as "it did not take", which is what it was reported as.
  const asking = needCur || needNew;
  $('ai_lockrow').hidden = !(asking || (want && aiLockStored));
  $('ai_currow').hidden = !needCur;
  $('ai_passrow').hidden = !needNew;
  $('ai_pass2row').hidden = !needNew;
  $('ai_lockset').hidden = !(want && aiLockStored && !aiPassChanging);
  // Offered in *every* state where a passphrase exists, not only the quiet one: the moment it is
  // most needed is the moment the form is refusing a passphrase the user cannot produce.
  $('ai_lostrow').hidden = !aiLockStored;
  $('ai_lockhint').hidden = !asking;
  $('ai_lockhint').classList.remove('bad');
  $('ai_lockhint').textContent = !asking ? ''
    : needNew ? (aiLockStored ? 'Enter the passphrase in use, then the new one twice. The key is decrypted and re-encrypted when you save.'
                              : 'Choose a passphrase. It is never stored and cannot be recovered.')
    : want ? 'Enter the passphrase in use, so the key you have just typed can be encrypted with it.'
           : 'Enter the current passphrase to turn the protection off — the key has to be decrypted to be stored in clear text. If you have lost it, use «Remove the protection» below.';
}

async function currentAi() {
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  return { anthropic: c.anthropic || {}, openai: c.openai || {} };
}

async function loadAi() {
  let c = {};
  try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  $('aiengine').value = c.active || 'anthropic';
  $('ai_a_model').value = (c.anthropic && c.anthropic.model) || '';
  $('ai_a_key').value = (c.anthropic && c.anthropic.apiKey) || '';
  // A key already protected shows as protected, with the field left empty: the passphrase is not
  // stored, so there is nothing to put back in it.
  const locked = !!((c.anthropic && c.anthropic.apiKeyEnc) || (c.openai && c.openai.apiKeyEnc));
  aiStored = { anthropic: cfg.anthropic, openai: cfg.openai };
  prevEngine = cfg.active;
  aiForget.clear();
  wireForget('anthropic', 'ai_a_key', 'ai_a_model'); wireForget('openai', 'ai_o_key', 'ai_o_model');
  aiLockStored = locked; $('ai_lock').checked = locked; syncLockRow(); markEngineOptions();
  [['ai_a_key', c.anthropic], ['ai_o_key', c.openai]].forEach(([id, prov]) => {
    if (prov && prov.apiKeyEnc) { $(id).value = ''; $(id).placeholder = 'stored encrypted — type it again to replace it'; }
  });
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
async function saveAi() {
  const cfg = {
    active: $('aiengine').value,
    anthropic: { model: $('ai_a_model').value.trim(), apiKey: $('ai_a_key').value.trim() },
    openai: { model: $('ai_o_model').value.trim(), apiKey: $('ai_o_key').value.trim() },
    maxIter: Math.max(1, Math.min(40, Number($('ai_maxiter').value) || 20)),
    seedCap: Math.max(4000, Math.min(400000, Number($('ai_seedcap').value) || 72000)),
  };
  const prev = await currentAi();
  const wantLock = $('ai_lock').checked;
  const pass = $('ai_pass').value;
  const cur = $('ai_passcur').value;
  const lockBad = (msg) => {
    // Said beside the field as well as in the toast: a toast is gone in two seconds and this page is
    // long enough that the passphrase fields can be nowhere near where the eye ends up.
    $('ai_lockhint').textContent = msg; $('ai_lockhint').hidden = false; $('ai_lockhint').classList.add('bad');
  };

  // Which stored ciphertexts this save still has to care about — a provider being forgotten is not one.
  const boxes = ['anthropic', 'openai']
    .filter((p) => !aiForget.has(p)).map((p) => (prev[p] || {}).apiKeyEnc).filter(Boolean);
  const typedKey = !!(cfg.anthropic.apiKey || cfg.openai.apiKey);
  const needCur = boxes.length > 0 && (!wantLock || aiPassChanging || typedKey);
  const needNew = wantLock && (boxes.length === 0 || aiPassChanging);

  // The passphrase in use is checked *before* anything is written, and against the stored ciphertext
  // rather than taken on trust: encrypting a new key with a passphrase the user has mistyped would
  // lock them out of a key they believe they can open.
  if (needCur) {
    if (!cur) {
      lockBad('Enter the passphrase in use — the stored key has to be decrypted before it can be re-encrypted or turned back into clear text.');
      $('ai_passcur').focus(); toast('The current passphrase is needed — nothing saved.', true); return;
    }
    if ((await window.ZOOST_KEYVAULT.unlock(boxes[0], cur)) === null) {
      lockBad('That passphrase did not open the stored key. Either it is wrong, or the stored key is damaged — the two cannot be told apart. If it is lost, use \u00abRemove the protection\u00bb below.');
      $('ai_passcur').select(); toast('Wrong passphrase — nothing saved.', true); return;
    }
  }
  if (needNew) {
    if (pass !== $('ai_pass2').value) { lockBad('The two new passphrases do not match.'); $('ai_pass2').select(); toast('The passphrases do not match — nothing saved.', true); return; }
    if (!pass) { lockBad('Choose a passphrase, or turn the protection off.'); $('ai_pass').focus(); toast('Choose a passphrase — nothing saved.', true); return; }
  }
  await mergeKeys(cfg, prev, wantLock, pass, aiForget, cur);
  // Protection off but something is still encrypted: nothing was decrypted, so saving now would write
  // "no protection" over a key nobody can read.
  if (!wantLock && (cfg.anthropic.apiKeyEnc || cfg.openai.apiKeyEnc)) {
    lockBad('The stored key could not be turned back into clear text. Enter the passphrase in use, or use «Remove the protection» below.');
    toast('Nothing saved.', true); return;
  }
  try { await chrome.storage.session.remove('aikeys'); } catch (_) {}   // a changed key must be re-unlocked
  $('ai_pass').value = ''; $('ai_pass2').value = ''; $('ai_passcur').value = ''; aiPassChanging = false;

  // Choosing the only engine that works is not a decision, so it is not asked for. A fresh install
  // sits on Anthropic; configure OpenAI and save, and leaving the selector on an engine that cannot
  // answer would be the form knowing better than it says.
  const usable = ['anthropic', 'openai'].filter((e) => {
    const p2 = cfg[e] || {};
    return !!((p2.apiKey || p2.apiKeyEnc) && p2.model);
  });
  let moved = '';
  if (!usable.includes(cfg.active) && usable.length === 1) {
    cfg.active = usable[0];
    moved = cfg.active === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI (ChatGPT)';
  }
  markOwn('aicfg'); dirty.delete('aicfg'); conflictBox('aicfg', false);
  try {
    await chrome.storage.local.set({ aicfg: cfg });
    toast(moved ? `AI settings saved \u2014 ${moved} is now the selected engine, being the only one configured.` : 'AI settings saved.');
  }
  catch (e) { toast('Could not save: ' + e.message, true); }
  // Re-read from where it was just written, rather than patching the flags by hand: the form has to
  // agree with the disk, and the page has three of them to keep in step (is a key stored, is it
  // encrypted, is a passphrase set). Reconstructing that here is a second copy of loadAi() waiting to
  // drift — which is what left two empty passphrase boxes on screen after a successful save, reading
  // as "it did not take".
  await loadAi();
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

let prevEngine = 'anthropic';
$('aiengine').onchange = async () => {
  // The mode is saved on change; the *form* is not. Running the whole save here wrote whatever was
  // half-typed in the key fields, and once a passphrase can be required it could refuse outright —
  // leaving the selector showing an engine that was never stored. Same shape as the CRM page.
  const picked = $('aiengine').value;
  const missing = engineIncomplete(picked);
  if (missing) {
    // Refused, and the selector goes back rather than showing a choice that was not made. Both
    // providers' fields are on this page, so this is never a dead end: fill them in and try again.
    $('aiengine').value = prevEngine; markEngine();
    toast(`${picked === 'anthropic' ? 'Anthropic' : 'OpenAI'} still needs ${missing}. Fill it in below, press Save, then pick it here.`, true);
    return;
  }
  markEngine();
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  c.active = $('aiengine').value;
  prevEngine = c.active;
  markOwn('aicfg'); dirty.delete('aicfg'); conflictBox('aicfg', false);
  try {
    await chrome.storage.local.set({ aicfg: c });
    toast(`Engine set to ${c.active === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI (ChatGPT)'}.`);
  } catch (e) { toast('Could not save: ' + e.message, true); }
};
$('saveAi').onclick = () => saveAi();

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
$('ai_lock').onchange = () => { aiPassChanging = false; $('ai_pass').value = ''; $('ai_pass2').value = ''; $('ai_passcur').value = ''; syncLockRow(); };
['ai_a_key', 'ai_o_key', 'ai_a_model', 'ai_o_model'].forEach((id) => {
  $(id).oninput = () => { syncLockRow(); markEngineOptions(); };
});
$('ai_passlost').onclick = loseLock;
$('ai_passchange').onclick = () => { aiPassChanging = true; syncLockRow(); focusFirstAsked(); };
