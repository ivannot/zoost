/*
 * options.js - Zoost for Zoho Analytics, settings.
 *
 * AI configuration lives here, not in the side panel: the panel is ~400px wide and these are
 * set-once fields. The panel picks changes up via chrome.storage.onChanged.
 */
'use strict';

const $ = (id) => document.getElementById(id);
// Attribute-safe escaping: `&`, `<`, `>` and both quote characters. Identical to the definition in
// the panels and the graph windows - one behaviour under one name, so a reader never has to check
// which file they are in.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PRODUCT_AUTHOR = 'Ivan Notaristefano';
// What this page says in more than one place. `saveFailed` prefixes the platform's own sentence
// rather than replacing it, at all three writers. A literal used once stays where it is used;
// tests/panel.test.mjs enforces the rule in the other direction, over every shipped script.
const MSG = {
  saveFailed: 'Could not save: ',
  // A read that failed is not «nothing is stored»: the one write on this page that can destroy a key
  // the user cannot recover has to refuse rather than merge onto an empty answer.
  readFailed: 'Could not read what is already stored, so nothing was saved - reload this page and try again.',
};
// The two engines under the names the user chose them by. Written out as a ternary at each site
// until the duplicate-message check found the pair - two copies of one mapping, which is how a
// third provider would have ended up named on one surface and not the other.
const ENGINE_LABEL = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (ChatGPT)' };
const engineLabel = (id) => ENGINE_LABEL[id] || id;

const LEGAL_DISCLAIMER = 'Independent, unofficial tool. Not affiliated with, endorsed by, sponsored by or supported by Zoho Corporation. '
  + '"Zoho" and "Zoho Analytics" are trademarks of Zoho Corporation, used here in a nominative sense only, to indicate compatibility. '
  + 'Licensed under the Apache License 2.0 and provided AS IS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. '
  + 'The author accepts no liability for any loss, damage or data issue arising from its use, and is under no obligation to provide support or maintenance. '
  + 'Deciding what may be extracted from Zoho Analytics, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';

// The ER preset the graph window starts from. Kept identical to ER_PRESET.modules in graphview.js:
// the two are the same setting seen from two places, not a default and a copy of it.
const LAY_DEFAULT = { margin: 36, spread: 42, gap: 8, fs: 10, sub: true };
const LAY_CTL = [['pMargin', 'vMargin', 'margin'], ['pSpread', 'vSpread', 'spread'], ['pGap', 'vGap', 'gap'], ['pFs', 'vFs', 'fs']];
let lay = Object.assign({}, LAY_DEFAULT);
// The ceiling is not one of the layout values: the graph window's Layout panel does not edit it,
// `Restore built-in defaults` above is about the sliders, and erSaveParams() there writes the whole
// erParams object - so a ceiling stored inside it would be lost the next time a slider moved. Its
// own key, and the built-in default is the measured one: 800, which covers the 725 a real org
// reported. 400 satisfied the profile and refused that org, which is the wrong way round.
const DRAW_MAX_DEFAULT = 800;
let drawMax = DRAW_MAX_DEFAULT;

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
 * A blank field with a key already stored means **leave it alone**, never "erase it" - the field is
 * blank because a protected key cannot be redisplayed, and reading that as a deletion would throw the
 * key away on every unrelated save. `forget` is the one declared exception, and it says so on screen.
 *
 * And **nothing here destroys**. Every path that cannot produce a plaintext - no passphrase, wrong
 * passphrase - carries the ciphertext over untouched and lets the handler refuse. A merge that deletes
 * what it failed to read is how "turn the protection off" became a way to lose a key.
 */
async function mergeKeys(cfg, prev, wantLock, pass, forget, cur) {
  for (const prov of ['anthropic', 'openai']) {
    const typed = cfg[prov].apiKey;
    const had = prev[prov] || {};
    if (forget && forget.has(prov)) {
      cfg[prov].apiKey = ''; delete cfg[prov].apiKeyEnc;
      // And out of the session cache too, or «Forget» means «forget on disk» - the panel would go on
      // holding the plaintext for this provider until the browser restarted.
      await window.ZOOST_KEYVAULT.forget(prov);
      continue;
    }

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
// page - that is the rule protecting a passphrase-locked key, and it would otherwise make forgetting
// impossible. Nothing is written until Save, so the way to undo is to reload the page.
const aiForget = new Set();
function wireForget(prov, keyId, modelId) {
  $(`ai_${prov === 'anthropic' ? 'a' : 'o'}_forget`).onclick = () => {
    aiForget.add(prov);
    $(keyId).value = ''; $(modelId).value = '';
    $(keyId).placeholder = 'will be removed when you save';
    $(modelId).placeholder = 'will be removed when you save';
    // A pending removal is an unsaved edit like any other. Without this an `aicfg` write from
    // another window silently reloaded the section, dropped the pending removal, and Save then
    // said «AI settings saved.» with the key still stored - the one thing a reader pressing
    // Forget wants to be told the truth about.
    markDirty('aicfg');
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
 *  answer a single question - the rule enforced on the user and not on the default. So the options
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
 * There was one already - Forget on each provider, then untick, then save - and it had to be *worked
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
    + `Lost: nothing but the stored key - paste it in again from your provider's dashboard.\n\n`
    + `Continue?`)) return;
  let cfg;
  try { cfg = await readCfgForWrite(); }
  catch (e) { toast('Could not read the saved settings, so nothing was removed. Try again.', true); return; }
  for (const prov of which) { cfg[prov] = Object.assign({}, cfg[prov]); delete cfg[prov].apiKeyEnc; cfg[prov].apiKey = ''; }
  if (!await saveKeys({ aicfg: cfg })) return;
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
    o.textContent = missing ? `${base} - needs ${missing}` : base;
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
           : 'Enter the current passphrase to turn the protection off - the key has to be decrypted to be stored in clear text. If you have lost it, use «Remove the protection» below.';
}

// **A read that failed must never authorise a write.** Every save on this page is a
// read-modify-write of one object: read `aicfg`, change one field, put the whole thing back. The
// read was `let c = {}; try { … } catch (_) {}`, so a failure left `c` empty and the write then
// replaced the stored configuration with a single field - losing the encrypted API key, the model
// names and the rest. The user typed a passphrase to protect that key; a quota error or an
// extension update under an open options page would have thrown it away without a word.
//
// It throws instead, and the callers say so and stop. Reading for *display* keeps its fallback:
// an empty form is visible and costs nothing, and the two cases are different.
async function readCfgForWrite() {
  const r = await chrome.storage.local.get('aicfg');   // throws: the caller must not write
  return Object.assign({}, r.aicfg || {});
}
async function currentAi() {
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  return { anthropic: c.anthropic || {}, openai: c.openai || {} };
}

// Whether a provider has anything stored at all - a key in the clear, or one behind a passphrase.
// Both count: forgetting is about what is on this machine, not about which form it took.
function showForget(prov, stored) {
  const btn = $(prov === 'anthropic' ? 'ai_a_forget' : 'ai_o_forget');
  if (!btn) return;
  btn.style.display = (stored && (stored.apiKey || stored.apiKeyEnc)) ? '' : 'none';
}

async function loadAi() {
  aiLoadFailed = 'loading';   // in flight, so a cancellation has something to cancel
  // Reading for *display* keeps its fallback - an empty form renders and nothing is lost. What it
  // must not do is stay quiet: Save writes the form back whole, so a reader who cannot tell «nothing
  // is stored yet» from «I could not read what is stored» saves the empty one over their key.
  const current = beginLoad('aicfg');
  let c = {};
  try { c = (await chrome.storage.local.get('aicfg')).aicfg || {}; }
  catch (_) {
    toast('Could not read your saved AI settings - what is shown below is not what is stored. '
      + 'Reload this page before saving, or Save will overwrite it.', true);
    aiLoadFailed = 'failed';
  }
  if (!current()) return;   // an older read must not fill the form
  const cfg = {
    active: c.active || 'anthropic',
    anthropic: Object.assign({ model: '', apiKey: '' }, c.anthropic || {}),
    openai: Object.assign({ model: '', apiKey: '' }, c.openai || {}),
  };
  // Fields first, state second. syncLockRow() and markEngineOptions() both read the *form* - which is
  // the right criterion, and only if the form has already been filled in. Called before it, they judge
  // whatever the previous render left behind, which after a save is the key the user had just typed.
  $('aiengine').value = cfg.active;
  $('ai_a_model').value = cfg.anthropic.model; $('ai_a_key').value = cfg.anthropic.apiKey;
  $('ai_o_model').value = cfg.openai.model; $('ai_o_key').value = cfg.openai.apiKey;
  $('ai_maxiter').value = c.maxIter || 20;
  $('ai_maxtokens').value = c.maxTokens || 16384;
  $('ai_seedcap').value = c.seedCap || 72000;
  // A key already protected shows as protected, with the field left empty: the passphrase is not
  // stored, so there is nothing to put back in it.
  [['ai_a_key', cfg.anthropic], ['ai_o_key', cfg.openai]].forEach(([id, prov]) => {
    if (prov.apiKeyEnc) { $(id).value = ''; $(id).placeholder = 'stored encrypted - type it again to replace it'; }
  });
  aiStored = { anthropic: cfg.anthropic, openai: cfg.openai };
  // Absent when there is nothing to forget. The same rule as the panel's retry and Clear buttons:
  // a control that can do nothing goes away rather than sitting there, because offering to remove
  // what is not there is an answer to a question nobody asked. Reported.
  showForget('anthropic', cfg.anthropic); showForget('openai', cfg.openai);
  prevEngine = cfg.active;
  aiForget.clear();
  wireForget('anthropic', 'ai_a_key', 'ai_a_model'); wireForget('openai', 'ai_o_key', 'ai_o_model');
  aiLockStored = !!(cfg.anthropic.apiKeyEnc || cfg.openai.apiKeyEnc);
  $('ai_lock').checked = aiLockStored;
  if (aiLoadFailed === 'loading') aiLoadFailed = false;
  syncLockRow(); markEngineOptions(); markEngine();
}
// A selector that changes a *mode* saves on change, not behind a Save button - the same rule as the
// CRM options page.
function markEngine() {
  const e = $('aiengine').value;
  $('provAnthropic').classList.toggle('on', e === 'anthropic');
  $('provOpenai').classList.toggle('on', e === 'openai');
}
async function saveAi() {
  if (aiLoadFailed) { toast(loadState(aiLoadFailed), true); return; }
  const cfg = {
    active: $('aiengine').value,
    anthropic: { model: $('ai_a_model').value.trim(), apiKey: $('ai_a_key').value.trim() },
    openai: { model: $('ai_o_model').value.trim(), apiKey: $('ai_o_key').value.trim() },
    maxIter: Math.max(1, Math.min(40, Number($('ai_maxiter').value) || 20)),
    maxTokens: Math.max(1024, Math.min(64000, Number($('ai_maxtokens').value) || 16384)),
    seedCap: Math.max(4000, Math.min(400000, Number($('ai_seedcap').value) || 72000)),
  };
  // **The merge base for the keys, read the way a write is allowed to read.** This used `currentAi`,
  // which swallows a failed read and answers «nothing is stored» - and that answer is
  // indistinguishable from the truth. On the one write on this page that can destroy a secret the
  // user cannot recover, a rejected read meant `mergeKeys` had nothing to carry, and unticking the
  // passphrase saved an empty key over the ciphertext without ever asking for the passphrase. The
  // helper written for exactly this rule was already used by the two cheap writers on this page and
  // not by the expensive one.
  let prev;
  try { const c = await readCfgForWrite(); prev = { anthropic: c.anthropic || {}, openai: c.openai || {} }; }
  catch (_) { toast(MSG.readFailed, true); return; }
  const wantLock = $('ai_lock').checked;
  const pass = $('ai_pass').value;
  const cur = $('ai_passcur').value;
  const lockBad = (msg) => {
    // Said beside the field as well as in the toast: a toast is gone in two seconds and this page is
    // long enough that the passphrase fields can be nowhere near where the eye ends up.
    $('ai_lockhint').textContent = msg; $('ai_lockhint').hidden = false; $('ai_lockhint').classList.add('bad');
  };

  // Which stored ciphertexts this save still has to care about - a provider being forgotten is not one.
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
      lockBad('Enter the passphrase in use - the stored key has to be decrypted before it can be re-encrypted or turned back into clear text.');
      $('ai_passcur').focus(); toast('The current passphrase is needed - nothing saved.', true); return;
    }
    if ((await window.ZOOST_KEYVAULT.unlock(boxes[0], cur)) === null) {
      lockBad('That passphrase did not open the stored key. Either it is wrong, or the stored key is damaged - the two cannot be told apart. If it is lost, use \u00abRemove the protection\u00bb below.');
      $('ai_passcur').select(); toast('Wrong passphrase - nothing saved.', true); return;
    }
  }
  if (needNew) {
    if (pass !== $('ai_pass2').value) { lockBad('The two new passphrases do not match.'); $('ai_pass2').select(); toast('The passphrases do not match - nothing saved.', true); return; }
    if (!pass) { lockBad('Choose a passphrase, or turn the protection off.'); $('ai_pass').focus(); toast('Choose a passphrase - nothing saved.', true); return; }
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
    moved = engineLabel(cfg.active);
  }
  // **«Saved.» is a claim about the next question the reader will ask, which is «does it work».**
  // The CRM twin has said the honest thing since it shipped; this side announced plain success over
  // a configuration the assistant cannot use - an engine selected with no model, or with no key -
  // and the reader learnt otherwise in the AI panel, one screen away, with nothing connecting the
  // two. Same words as the twin, same warning flag.
  const sel = cfg[cfg.active] || {};
  const ready = !!((sel.apiKey || sel.apiKeyEnc) && sel.model);
  if (!await saveKeys({ aicfg: cfg })) return;
  toast(moved ? `AI settings saved - ${moved} is now the selected engine, being the only one configured.`
    : ready ? 'AI settings saved.'
    : 'Saved - but the selected engine still needs a model and an API key.', !ready);
  // Re-read from where it was just written, rather than patching the flags by hand: the form has to
  // agree with the disk, and the page has three of them to keep in step (is a key stored, is it
  // encrypted, is a passphrase set). Reconstructing that here is a second copy of loadAi() waiting to
  // drift - which is what left two empty passphrase boxes on screen after a successful save, reading
  // as "it did not take".
  await loadAi();
}

function layToUI() {
  LAY_CTL.forEach(([sl, lb, k]) => { $(sl).value = lay[k]; $(lb).textContent = k === 'spread' ? (lay[k] / 10).toFixed(1) : lay[k]; });
  $('pSub').checked = !!lay.sub;
  $('pDrawMax').value = drawMax;
  $('vDrawMax').textContent = drawMax === DRAW_MAX_DEFAULT ? 'boxes (measured)' : 'boxes';
}
LAY_CTL.forEach(([sl, lb, k]) => {
  $(sl).addEventListener('input', () => { lay[k] = parseInt($(sl).value, 10); $(lb).textContent = k === 'spread' ? (lay[k] / 10).toFixed(1) : lay[k]; });
});
$('pSub').onchange = () => { lay.sub = $('pSub').checked; };
$('pDrawMax').addEventListener('input', () => {
  // Clamped to the field's own bounds rather than trusted: a number input accepts anything typed
  // into it, and 0 would refuse every diagram while 10 million would hang the window for minutes.
  const raw = parseInt($('pDrawMax').value, 10);
  const lo = +$('pDrawMax').min, hi = +$('pDrawMax').max;
  drawMax = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : DRAW_MAX_DEFAULT;
  $('vDrawMax').textContent = drawMax === DRAW_MAX_DEFAULT ? 'boxes (measured)' : 'boxes';
});
// **A preset is an edit, and the page only counted the ones it could hear.** Marks are attached
// to the section - one `input`, one `change` - so a field added later is covered without anyone
// remembering. Neither fires when a script writes into the controls, which is exactly what these
// buttons do, so the whole form changed under a section the page still believed was untouched.
// The cost lands on the next write from the diagram window or a second settings tab: an
// unmarked section is reloaded on the spot, without the conflict box, and the preset the reader
// had just applied disappeared while they were looking at it.
$('layReset').onclick = () => { lay = Object.assign({}, LAY_DEFAULT); drawMax = DRAW_MAX_DEFAULT; layToUI(); markDirty('erParams'); };
async function onSaveLay() {
  if (layLoadFailed) { toast(loadState(layLoadFailed), true); return; }
  // Merged, like the CRM twin and for the same reason: `mode` belongs to the diagram window, which
  // writes it when the reader changes Emphasis in there. Replacing the object threw it away.
  // **Read inside a guard, because this is a merge and a merge needs its base.** Unguarded, a
  // rejection escaped an `onclick`-assigned async function - and neither settings page registers
  // an `unhandledrejection` listener, though both panels do - so Save did nothing, said nothing,
  // and looked like a button that is not wired. Every other Save on this page goes through
  // `saveKeys`, which catches and says so.
  let prev;
  try { prev = (await chrome.storage.local.get('erParams')).erParams || {}; }
  catch (_) { toast(MSG.readFailed, true); return; }
  if (!await saveKeys({ erParams: Object.assign({}, prev, { current: lay }), erDrawMax: drawMax })) return;
  toast('Diagram defaults saved.');
}
$('saveLay').onclick = onSaveLay;
async function loadLay() {
  layLoadFailed = 'loading';   // in flight, so a cancellation has something to cancel
  const current = beginLoad('erParams');
  // Clamped to each control's own bounds, the way the ceiling below already was. Without it the
  // page shows one number and saves another: `layToUI` puts the stored value into a range input,
  // which clamps it *for display*, while `lay` keeps what was on disk and Save writes `lay`. The
  // reason is the one written on the ceiling - a stored setting is not necessarily a value this
  // page can mean - and it had been applied to one field of five, in this function.
  //
  // From the controls rather than from a table: the bounds are declared in the markup, and a
  // second copy of them here is the next thing to drift.
  try {
    const r = await chrome.storage.local.get('erParams');
    if (current() && r.erParams && r.erParams.current) {
      lay = Object.assign({}, LAY_DEFAULT, r.erParams.current);
      LAY_CTL.forEach(([sl, , k]) => {
        const lo = +$(sl).min, hi = +$(sl).max;
        if (Number.isFinite(lo) && Number.isFinite(hi) && Number.isFinite(lay[k])) lay[k] = Math.min(hi, Math.max(lo, lay[k]));
      });
    }
  } catch (_) { layLoadFailed = 'failed'; }
  try {
    const r = await chrome.storage.local.get('erDrawMax');
    const lo = +$('pDrawMax').min, hi = +$('pDrawMax').max;
    if (current() && Number.isFinite(r.erDrawMax)) drawMax = Math.min(hi, Math.max(lo, r.erDrawMax));
  } catch (_) { layLoadFailed = 'failed'; }
  // **The one loader that drew after a cancelled read.** Every other one returns first. The sliders
  // are safe either way - their handlers write straight into `lay` - but `drawMax` is not: with the
  // second read discarded, `layToUI()` paints the built-in ceiling into the box and a Save writes it
  // over whatever was stored. A read that was overtaken, or cancelled because the reader started
  // typing, has nothing to publish.
  if (!current()) return;
  if (layLoadFailed === 'loading') layLoadFailed = false;
  layToUI();
}

let prevEngine = 'anthropic';
async function onAiengine() {
  // The mode is saved on change; the *form* is not. Running the whole save here wrote whatever was
  // half-typed in the key fields, and once a passphrase can be required it could refuse outright -
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
  let c;
  try { c = await readCfgForWrite(); }
  catch (e) { toast('Could not read the saved settings, so nothing was changed - the stored key is untouched. Try again.', true); return; }
  c.active = $('aiengine').value;
  prevEngine = c.active;
  if (!await saveKeys({ aicfg: c })) return;
  toast(`Engine set to ${engineLabel(c.active)}.`);
}
$('aiengine').onchange = onAiengine;
$('saveAi').onclick = () => saveAi();

// ---------- guarding against the stale save ----------
//
// One settings window stops you having two copies of this form. It does not stop this copy going out
// of date while it sits open, so each section watches its own key: changed elsewhere and untouched
// here, the form catches up silently; changed elsewhere while you were editing, nothing is
// overwritten in either direction and you choose. Never resolve it by guessing which side is newer.
//
// The same mechanism, the same wording and the same markup as the CRM workbench - this is shared
// chrome, and the two panels must not disagree about what a settings conflict looks like.
/** The data centre to fall back on. It is a one-value setting that changes a mode, so it saves on
 *  change rather than behind a Save button - the convention this page already follows for a
 *  selector. It is only ever read when the panel knows neither a workspace nor a tab. */
// Built from the manifest, like the panel's own picklist: the hosts this extension may reach are
// the data centres it may offer, and a list typed in two places is two lists.
const DC_DEFAULT = 'zoho.com';
async function loadDc() {
  const dcs = [...new Set((chrome.runtime.getManifest().host_permissions || [])
    .filter((h) => h.startsWith('https://analytics.'))
    .map((h) => h.slice('https://analytics.'.length).replace(/\/.*$/, '')))].sort();
  $('zohoDc').innerHTML = dcs.map((d) => `<option value="${escA(d)}">${escA(d)}</option>`).join('');
  // The select is published too, and two reads of one key race here as they do anywhere else:
  // the older one finishing last leaves the form showing a data centre that is not the stored
  // one. It writes to the DOM rather than to a module global, which is why `asynccheck` never
  // recorded it - the class is about *publishing*, not about where.
  const current = beginLoad('zohoDc');
  let want = DC_DEFAULT;
  try { const r = await chrome.storage.local.get('zohoDc'); if (r.zohoDc) want = r.zohoDc; } catch (_) {}
  if (!current()) return;
  $('zohoDc').value = dcs.includes(want) ? want : dcs[0];
}
async function onZohoDc() {
  if (!await saveKeys({ zohoDc: $('zohoDc').value })) return;
  toast('Data centre saved.');
}
$('zohoDc').onchange = onZohoDc;

const SEC_DIAGRAM = 'Diagram layout';

// ---------- saved search patterns ----------
// The same two starters the background seeds - a deliberate copy, because an options page and a
// service worker share no scope; a test holds all four copies to the same bytes.
function rxDefaults() {
  return [
    { name: 'Email address', pattern: '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}' },
    // No documented format exists: Zoho's own community puts CRM record ids at 18 digits
    // (Creator at 19), and the bound keeps ordinary numbers out of the matches.
    { name: 'Zoho ID', pattern: '\\b\\d{18}\\b' },
  ];
}
// The list behind the panel's ▾ menu. The background seeded the first two on install; this page
// and the menu's own Save row are the writers, and an emptied list stays empty.
// What stops a list from saving, named per row - or null. A declaration for tests/slice.mjs, and
// byte-identical in both apps' options pages: a test holds the twins to the same rules.
function rxProblems(list) {
  for (let i = 0; i < list.length; i++) {
    const name = String(list[i].name || '').trim();
    const pattern = String(list[i].pattern || '');
    if (!name) return `Row ${i + 1} has no name.`;
    if (!pattern.trim()) return `"${name}" has no pattern.`;
    try { new RegExp(pattern, 'gim'); } catch (e) { return `"${name}" does not parse: ${String((e && e.message) || e)}`; }
  }
  const names = list.map((x) => String(x.name || '').trim().toLowerCase());
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return `Two patterns share the name "${dup}" - the menu could not tell them apart.`;
  for (let i = 0; i < list.length; i++) {
    const j = list.findIndex((x) => String(x.pattern || '') === String(list[i].pattern || ''));
    if (j !== i) return `"${String(list[j].name).trim()}" and "${String(list[i].name).trim()}" are the same expression - one of them is enough.`;
  }
  return null;
}
let rxCur = [];
// A read that threw is not an empty list: rendering the two the same would let Save write [] over
// a list that still exists - absent data authorising a destructive act, the exact class the pull
// already refuses. The flag gates the save and names the state instead.
// **Every section that can be saved has one.** The two that did not - the AI settings and the
// diagram defaults - were the two whose Save had no guard, and they lost data for it: a Save
// pressed or provoked before their read published wrote the empty form over a stored engine,
// two model names and three budgets, and the built-in sliders and ceiling over the stored ones,
// each announcing success. The other four refuse. «Which sections have a flag» is not a
// judgement call: it is every section a Save can write.
let aiLoadFailed = 'never';
let layLoadFailed = 'never';
let rxLoadFailed = 'never';
function renderRx() {
  if (rxLoadFailed) {
    $('rxlist').innerHTML = `<p class="sub"><b>Nothing is shown here, and nothing can be saved over it.</b> ${escA(loadState(rxLoadFailed))}</p>`;
    $('rxRestore').style.display = 'none';
    return;
  }
  // Offered only while a starter is missing: restoring what is already there is nothing to do.
  const have = new Set(rxCur.map((x) => x.name.trim().toLowerCase()));
  $('rxRestore').style.display = rxDefaults().some((d) => !have.has(d.name.toLowerCase())) ? '' : 'none';
  $('rxlist').innerHTML = rxCur.map((x, i) => `<div class="rxrow" data-i="${escA(i)}">
    <input type="text" class="rxname" value="${escA(x.name)}" placeholder="Name" aria-label="Pattern name">
    <input type="text" class="rxpat" value="${escA(x.pattern)}" placeholder="Regular expression" aria-label="Pattern">
    <button class="rxdel" title="Remove this pattern">✕</button></div>`).join('')
    || '<p class="sub">No saved patterns - the panel\u2019s menu offers none until one is added.</p>';
  $('rxlist').querySelectorAll('.rxrow').forEach((row) => {
    const i = +row.dataset.i;
    row.querySelector('.rxname').oninput = (e) => { rxCur[i].name = e.target.value; };
    row.querySelector('.rxpat').oninput = (e) => { rxCur[i].pattern = e.target.value; };
    row.querySelector('.rxdel').onclick = () => { rxCur.splice(i, 1); renderRx(); markDirty('rxShortcuts'); };
  });
}
// **A load that was overtaken must not publish.** Every section on this page is re-read whenever the
// panel writes its key, so two changes arriving close together run two loaders at once - and the
// older one, finishing last, puts the older answer into the module state the form is built from.
// Save then writes that back over the newer one: a lost update on the reader's own settings, from
// nothing they did.
//
// The ledger records these writes as read and notes that «the options pages answer with
// markOwn/dirty». Measured, they do not: `markOwn` says «this change was mine, ignore the echo» and
// `dirty` says «I have unsaved edits», and neither of them orders two reads of the same key. The
// panel's idiom is a token, and this is it.
const _loadSeq = {};
function beginLoad(key) {
  const mine = (_loadSeq[key] = (_loadSeq[key] || 0) + 1);
  // **An edit made before this read started is still an edit.** `markDirty` cancels the loads
  // that are *in flight*, which is every load it can see; a read that begins a moment later is
  // current by that test and publishes the stored value straight over what the reader has just
  // typed - silently, and leaving the section marked dirty, so Save then writes back the value
  // they had replaced. The ordering is not theirs to control: the reload is started by a write
  // in another window. So a read asks the same question at the end, and a read that finds an
  // unsaved edit cancels itself rather than winning the race.
  return () => {
    if (mine !== _loadSeq[key]) return false;
    if (!dirtyPeer(key)) return true;
    markLoadCancelled(key);
    return false;
  };
}
async function loadRx() {
  rxLoadFailed = 'loading';   // in flight, so a cancellation has something to cancel
  const current = beginLoad('rxShortcuts');
  try {
    const st = await chrome.storage.local.get('rxShortcuts');
    if (!current()) return;
    rxCur = Array.isArray(st.rxShortcuts)
      ? st.rxShortcuts.map((x) => ({ name: String((x && x.name) || ''), pattern: String((x && x.pattern) || '') }))
      : [];
    rxLoadFailed = false;
  } catch (_) { if (!current()) return; rxCur = []; rxLoadFailed = 'failed'; }
  renderRx();
}
$('rxAdd').onclick = () => { rxCur.push({ name: '', pattern: '' }); renderRx(); markDirty('rxShortcuts'); };
$('rxRestore').onclick = () => {
  // Only what is absent comes back: the starters you kept - possibly edited - stay exactly as
  // they are, and so does everything you added. Save is still what persists it, like any edit.
  const have = new Set(rxCur.map((x) => x.name.trim().toLowerCase()));
  rxDefaults().forEach((d) => { if (!have.has(d.name.toLowerCase())) rxCur.push(d); });
  renderRx(); markDirty('rxShortcuts');
};
async function onSaveRx() {
  if (rxLoadFailed) { toast(loadState(rxLoadFailed), true); return; }
  const bad = rxProblems(rxCur);
  if (bad) { toast(bad, true); return; }
  // No settingsStamp here: the panel reads this list fresh every time the menu opens, so there is
  // nothing cached anywhere to tell about the change.
  if (!await saveKeys({ rxShortcuts: rxCur.map((x) => ({ name: x.name.trim(), pattern: x.pattern })) })) return;
  toast('Patterns saved.');
}
$('saveRx').onclick = onSaveRx;

const SECTIONS = {
  zohoDc: { label: 'Data centre', reload: loadDc },
  aicfg: { label: 'AI assistant', reload: loadAi },
  rxShortcuts: { label: 'Saved search patterns', reload: loadRx },
  // Two keys, one section, so the label is a name rather than two copies one edit apart.
  erParams: { label: SEC_DIAGRAM, reload: loadLay },
  erDrawMax: { label: SEC_DIAGRAM, reload: loadLay },
};
const dirty = new Set();
const ownWrite = new Map();
function markOwn(key) { ownWrite.set(key, Date.now()); }
function wasOwn(key) {
  const t = ownWrite.get(key);
  if (t && Date.now() - t < 3000) { ownWrite.delete(key); return true; }
  return false;
}
// Which flag belongs to which section, read as well as written - because a cancellation may only
// touch a load that is actually in flight.
const LOAD_FLAG = {
  rxShortcuts: { get: () => rxLoadFailed, set: (v) => { rxLoadFailed = v; } },
  aicfg: { get: () => aiLoadFailed, set: (v) => { aiLoadFailed = v; } },
  erParams: { get: () => layLoadFailed, set: (v) => { layLoadFailed = v; } },
  erDrawMax: { get: () => layLoadFailed, set: (v) => { layLoadFailed = v; } },
};
/** A read that was thrown away, recorded - **and only if there was one.**
 *
 * This wrote «cancelled» unconditionally, and `markDirty` calls it on every edit: an `input`, a
 * preset, a reorder, a delete. So after a perfectly good load, one ordinary keystroke turned the
 * flag from `false` to «cancelled» and every Save from then on refused, saying the stored value
 * could not be read - which had not happened, and which reloading did not cure, because the next
 * edit did it again. Four sections across both products, unsaveable by using them.
 *
 * Introduced by the fix for the opposite defect, hours earlier, and reported from outside within
 * the day. The state a read is in has to be *asked*, not assumed from the fact that somebody typed.
 */
function markLoadCancelled(key) {
  const flag = LOAD_FLAG[key];
  if (flag && flag.get() === 'loading') flag.set('cancelled');
}
/** Why a section cannot be saved over, in the reader's words.
 *
 * **Three answers, not two, because a read can now be cancelled.** These flags were booleans - «did a
 * read fail» - and `invalidateSectionLoads` created a third outcome: a read that completed and was
 * thrown away because the reader typed while it was in flight. Left as «failed» it said the browser
 * had refused, which had not happened, and nothing ever re-read - so the section was unsaveable for
 * the rest of that page's life with the wrong cause on screen. The window is a click during
 * `init()`, which is the one moment somebody impatient is most likely to click.
 */
function loadState(flag) {
  if (!flag) return null;
  if (flag === 'cancelled') return 'This page was still loading when you changed something, so what is '
    + 'on screen is not what is stored. Reload the page, then make the change again.';
  if (flag === 'loading') return 'This page is still reading your stored settings. Nothing was saved - '
    + 'give it a moment and try again.';
  if (flag === 'never') return 'This page never finished reading your stored settings, so nothing was '
    + 'saved. Reload the page.';
  return MSG.readFailed;
}
/** A reader's edit is newer than every read already in flight for that section.
 *
 * `beginLoad` tells one loader from a later loader, and `otherWindowChanged` asks whether the
 * section is dirty *before* it awaits. Neither covers the third ordering: an external write starts a
 * read while the form is clean, the reader types, and the read then publishes over what they typed -
 * measured by holding the read open and typing into it. The page was left saying «unsaved changes»
 * about a form the changes had already disappeared from, with no conflict box, because the box is
 * decided before the await too.
 *
 * Bumping the sequence is what a later loader does, so an edit does the same thing: the read in
 * flight stops being current and returns without drawing.
 *
 * Every key that shares the reload is bumped, and that half is **belt and braces rather than
 * load-bearing today** - said, because a check cannot show it. Each reload opens its read under one
 * key (`loadTabs` under `tabPrefs`, `loadLay` under `erParams`), so bumping the edited key alone
 * would be enough right now, and a plant that narrows this to one key does not go red. It is written
 * wide because the pair exists for `dirtyPeer` one function up: the day a reload begins under the
 * other key of its section, the narrow version is wrong and nothing would have said so.
 */
function invalidateSectionLoads(key) {
  const mine = SECTIONS[key] && SECTIONS[key].reload;
  for (const [peer, sec] of Object.entries(SECTIONS)) {
    if (sec.reload === mine) _loadSeq[peer] = (_loadSeq[peer] || 0) + 1;
  }
  // The read that was in flight is now nobody's: it will not publish, and nothing is queued to take
  // its place. Recorded as what it is, so the refusal afterwards names the cause that happened.
  markLoadCancelled(key);
}
function markDirty(key) { dirty.add(key); invalidateSectionLoads(key); }

/** One key, one write, and every mark that describes the outcome moved by the write that happened.
 *
 * Eight places did this by hand - `markOwn(key)`, `dirty.delete(key)`, `conflictBox(key, false)`,
 * then `await chrome.storage.local.set(...)` - which puts every mark *before* the thing they
 * describe. A write that throws left the page saying it had no unsaved edits, with the conflict box
 * gone, over settings that were never stored; and in this product the failure said nothing at all,
 * because an `onclick` handler's rejection is silent. This is the defect already recorded in
 * `updateMetaIndex` - a refused write whose caller cleared its dirty mark over something that never
 * happened - one page over, in eight copies.
 *
 * `markOwn` still runs first and has to: the `onChanged` echo can arrive before `set` resolves, so a
 * mark placed after it would be too late to recognise our own write. What moves after the write is
 * everything that is a *claim about the outcome*. On a refusal the mark is withdrawn, the key goes
 * back to dirty - pressing Save is a statement that the form and the disk disagree - and the reason
 * is said.
 */
async function saveKeys(obj) {
  const keys = Object.keys(obj);
  keys.forEach(markOwn);
  try {
    await chrome.storage.local.set(obj);
  } catch (e) {
    keys.forEach((k) => { ownWrite.delete(k); dirty.add(k); });
    toast(MSG.saveFailed + (e && e.message ? e.message : 'the browser refused the write'), true);
    return false;
  }
  keys.forEach((k) => { dirty.delete(k); conflictBox(k, false); });
  return true;
}
/** Which key of this section has unsaved edits, if any.
 *
 * **A reload belongs to a section, not to the key that happened to change**, so «is there anything
 * to lose» has to be asked of the section. Asked of the key it was answered wrongly wherever two
 * keys share one reload, and both products have such a pair. In the CRM the panel writes
 * `tabAccessView` at the end of every pull - a display-only copy of which tabs the role still
 * grants - nothing ever marks that key, so the silent branch ran, `loadTabs()` redrew the section
 * from disk, and a reordering the reader had not saved yet was gone with no message at all. The same
 * shape sits under the diagram pair on both sides: `erDrawMax` arriving alone would reload `lay`.
 *
 * The box is raised on the *dirty* key rather than on the changed one, because the changed one may
 * have no section element to hang it from - `tabAccessView` has none - and a conflict nobody can see
 * is the silence this is here to end.
 */
function dirtyPeer(key) {
  const mine = SECTIONS[key].reload;
  return [...dirty].find((k) => SECTIONS[k] && SECTIONS[k].reload === mine);
}
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
  el.querySelector('[data-take]').onclick = () => takeTheirs(key);
  el.querySelector('[data-keep]').onclick = () => conflictBox(key, false);
}
// Named because it awaits: a reload lands after a yield and the section it redraws may have been
// edited in between, which is precisely what `tools/asynccheck.py` is for and precisely what an
// inline arrow hides from it.
async function takeTheirs(key) {
  // Every unsaved edit in this section, not the one the box happens to name: the two tab keys
  // share a reload, so clearing one leaves the section dirty - and a section with an unsaved
  // edit is exactly what a read now refuses to overwrite, which would make «Take theirs» the
  // one button that does nothing.
  Object.keys(SECTIONS).forEach((k) => { if (SECTIONS[k].reload === SECTIONS[key].reload) dirty.delete(k); });
  await SECTIONS[key].reload();
  // **The same window, through the other door.** A reader who presses «Take theirs» and then types
  // while the read is still in flight was having the box closed over a form that had unsaved edits in
  // it again - and the read itself no longer draws, because typing invalidated it. So the question is
  // asked after the await rather than assumed before it: the box closes when there is nothing left to
  // decide, and stays when there is.
  const late = dirtyPeer(key);
  if (late) conflictBox(late, true); else conflictBox(key, false);
}
document.querySelectorAll('[data-section]').forEach((sec) => {
  const k = sec.dataset.section;
  sec.addEventListener('input', () => markDirty(k));
  sec.addEventListener('change', () => markDirty(k));
});
// The settings page listens to itself being changed from another window. It awaits a reload,
// so the section it redraws may have been edited meanwhile - a named declaration, for the same
// reason as everything else here: an arrow is a scope the race check cannot enter.
async function otherWindowChanged(ch, area) {
  if (area !== 'local') return;
  for (const key of Object.keys(SECTIONS)) {
    if (!ch[key] || wasOwn(key)) continue;
    const peer = dirtyPeer(key);
    if (peer) conflictBox(peer, true);
    else {
      try { await SECTIONS[key].reload(); } catch (_) {}
      // **Asked again, because the answer above is from before the await.** An edit that arrived
      // while the read was in flight has already stopped that read from drawing - see
      // `invalidateSectionLoads` - so what is left is telling the reader their form and the disk have
      // parted company, which is the whole job of the box.
      const late = dirtyPeer(key);
      if (late) conflictBox(late, true);
    }
  }
}
try {
  chrome.storage.onChanged.addListener(otherWindowChanged);
} catch (_) {}

// A declaration and a call, not an immediately-invoked expression, and the same shape as the CRM
// twin - which was converted for this reason and this side was not walked. `functions()` in
// `tools/asynccheck.py` matches a declaration at the start of a line, so the whole startup of this
// page, awaits included, was invisible to the one check that reads for a global written after a
// yield. The four loaders were also fired and not awaited: four promises nobody holds, on a page
// that registers no `unhandledrejection` listener, and whose order decides which failure flag is
// set by the time a Save reads it.
async function init() {
  const m = chrome.runtime.getManifest();
  $('ttl').textContent = m.name;
  $('ver').textContent = 'v' + m.version;
  $('sqlrules').innerHTML = '<ul style="margin:0;padding-left:18px">'
    + window.ZOHO_ANALYTICS_SQL.rules.map((r) => `<li style="padding:2px 0">${esc(r).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')}</li>`).join('')
    + '</ul>';
  // The credits and the version live in the panel's own About dialog, which says the same words -
  // this page keeps the one thing that may not disappear from any user-facing surface.
  $('legal').textContent = LEGAL_DISCLAIMER;
  await loadDc(); await loadAi(); await loadLay(); await loadRx();
}
init();
$('ai_lock').onchange = () => { aiPassChanging = false; $('ai_pass').value = ''; $('ai_pass2').value = ''; $('ai_passcur').value = ''; syncLockRow(); };
['ai_a_key', 'ai_o_key', 'ai_a_model', 'ai_o_model'].forEach((id) => {
  $(id).oninput = () => { syncLockRow(); markEngineOptions(); };
});
$('ai_passlost').onclick = loseLock;
$('ai_passchange').onclick = () => { aiPassChanging = true; syncLockRow(); focusFirstAsked(); };
