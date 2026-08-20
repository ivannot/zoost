/* options.js - Zoost settings.
 * Everything here writes to storage the side panel and the graph window already read:
 *   IndexedDB 'zoost'/kv  → rootDir (FileSystemDirectoryHandle)
 *   chrome.storage.local  → aicfg, exportScope, erParams, erDrawMax
 * A `settingsStamp` is bumped on every change so an open side panel can react.
 */
const $ = (id) => document.getElementById(id);
// Attribute-safe escaping: `&`, `<`, `>` and both quote characters. Identical to the definition in
// the panels and the graph windows - one behaviour under one name, so a reader never has to check
// which file they are in.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


// The two engines under the names the user chose them by. Written out as a ternary at each site
// until the duplicate-message check found the pair - two copies of one mapping, which is how a
// third provider would have ended up named on one surface and not the other.
const ENGINE_LABEL = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (ChatGPT)' };
const engineLabel = (id) => ENGINE_LABEL[id] || id;

const LEGAL_DISCLAIMER = 'Independent, unofficial tool. Not affiliated with, endorsed by, sponsored by or supported by '
  + 'Zoho Corporation. "Zoho", "Zoho CRM" and "Deluge" are trademarks of Zoho Corporation, used here in a nominative '
  + 'sense only, to indicate compatibility. Licensed under the Apache License 2.0 and provided AS IS, WITHOUT WARRANTIES '
  + 'OR CONDITIONS OF ANY KIND, express or implied. The author accepts no liability for any loss, damage or data issue '
  + 'arising from its use, and is under no obligation to provide support or maintenance.';

const SCOPE_KEYS = ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules', 'connections', 'health'];
const SCOPE_FULL = { functions: true, code: true, modules: true, layouts: true, relations: true, workflows: true, schedules: true, connections: true, health: true };
const SCOPE_SAFE = { functions: true, code: false, modules: true, layouts: true, relations: true, workflows: false, schedules: false, connections: true, health: false };
const LAY_DEFAULT = { margin: 36, spread: 42, gap: 8, fs: 10, sub: true };
const LAY_CTL = [['pMargin', 'vMargin', 'margin'], ['pSpread', 'vSpread', 'spread'], ['pGap', 'vGap', 'gap'], ['pFs', 'vFs', 'fs']];
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
  if (!confirm('Forget the working folder?\n\nNothing on disk is deleted - Zoost simply stops using it until you pick one again.')) return;
  await window.idbHandle.set('rootDir', null);
  await window.idbHandle.set('activeWs', null);
  await stamp(); await showRoot();
  toast('Working folder forgotten.');
};

// ---------- AI ----------
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
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  const cfg = {
    active: c.active || 'anthropic',
    anthropic: Object.assign({ model: '', apiKey: '' }, c.anthropic || {}),
    openai: Object.assign({ model: '', apiKey: '' }, c.openai || {}),
    maxIter: c.maxIter || 20,
    shareAddresses: c.shareAddresses === true,
    seedCap: c.seedCap || 72000,
  };
  // Fields first, state second. syncLockRow() and markEngineOptions() both read the *form* - which is
  // the right criterion, and only if the form has already been filled in. Called before it, they judge
  // whatever the previous render left behind, which after a save is the key the user had just typed.
  $('aiengine').value = cfg.active;
  $('ai_a_model').value = cfg.anthropic.model; $('ai_a_key').value = cfg.anthropic.apiKey;
  $('ai_o_model').value = cfg.openai.model; $('ai_o_key').value = cfg.openai.apiKey;
  $('ai_maxiter').value = cfg.maxIter;
  $('ai_addr').checked = !!cfg.shareAddresses;
  $('ai_seedcap').value = cfg.seedCap;
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
  syncLockRow(); markEngineOptions(); markEngine();
}
function markEngine() {
  const a = $('aiengine').value === 'anthropic';
  $('provAnthropic').classList.toggle('on', a);
  $('provOpenai').classList.toggle('on', !a);
}
// The engine dropdown is a mode switch, not a text field. Persisting it only on "Save" made it
// possible to change engine, see the panel ignore it, and blame the panel. It now saves on change.
let prevEngine = 'anthropic';
$('aiengine').onchange = async () => {
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
  markOwn('aicfg'); dirty.delete('aicfg'); conflictBox('aicfg', false); await chrome.storage.local.set({ aicfg: c }); await stamp();
  toast(`Engine set to ${engineLabel(c.active)}.`);
};
$('saveAi').onclick = async () => {
  const cfg = {
    active: $('aiengine').value,
    anthropic: { model: $('ai_a_model').value.trim(), apiKey: $('ai_a_key').value.trim() },
    openai: { model: $('ai_o_model').value.trim(), apiKey: $('ai_o_key').value.trim() },
    maxIter: Math.max(1, Math.min(40, parseInt($('ai_maxiter').value, 10) || 20)),
    // Off unless the reader says otherwise, and the mirror keeps the address either way: what is
    // at stake here is whether it travels to a provider, not whether it is on disk.
    shareAddresses: $('ai_addr').checked,
    seedCap: Math.max(4000, Math.min(400000, parseInt($('ai_seedcap').value, 10) || 72000)),
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
  const p = cfg[cfg.active] || {};
  const ready = !!((p.apiKey || p.apiKeyEnc) && p.model);
  markOwn('aicfg'); dirty.delete('aicfg'); conflictBox('aicfg', false); await chrome.storage.local.set({ aicfg: cfg }); await stamp();
  toast(moved ? `AI settings saved - ${moved} is now the selected engine, being the only one configured.`
    : ready ? 'AI settings saved.'
    : 'Saved - but the selected engine still needs a model and an API key.', !ready);
  // Re-read from where it was just written, rather than patching the flags by hand: the form has to
  // agree with the disk, and the page has three of them to keep in step (is a key stored, is it
  // encrypted, is a passphrase set). Reconstructing that here is a second copy of loadAi() waiting to
  // drift - which is what left two empty passphrase boxes on screen after a successful save, reading
  // as "it did not take".
  await loadAi();
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
$('saveScope').onclick = async () => { scopeFromUI(); markOwn('exportScope'); dirty.delete('exportScope'); conflictBox('exportScope', false); await chrome.storage.local.set({ exportScope: scope }); await stamp(); toast('Export defaults saved.'); };

// ---------- diagram layout ----------
let lay = Object.assign({}, LAY_DEFAULT);
// The ceiling is not one of the layout values: the graph window's Layout panel does not edit it,
// `Restore built-in defaults` above is about the sliders, and erSaveParams() there writes the whole
// erParams object - so a ceiling stored inside it would be lost the next time a slider moved. Its
// own key, and the built-in default is the measured one: 800, which covers the 725 a real org
// reported. 400 satisfied the profile and refused that org, which is the wrong way round.
const DRAW_MAX_DEFAULT = 800;
let drawMax = DRAW_MAX_DEFAULT;
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
$('layReset').onclick = () => { lay = Object.assign({}, LAY_DEFAULT); drawMax = DRAW_MAX_DEFAULT; layToUI(); };
$('saveLay').onclick = async () => { markOwn('erParams'); dirty.delete('erParams'); conflictBox('erParams', false); markOwn('erDrawMax'); dirty.delete('erDrawMax'); conflictBox('erDrawMax', false);
  await chrome.storage.local.set({ erParams: { current: lay }, erDrawMax: drawMax });
  await stamp(); toast('Diagram defaults saved.'); };
async function loadLay() {
  try { const r = await chrome.storage.local.get('erParams'); if (r.erParams && r.erParams.current) lay = Object.assign({}, LAY_DEFAULT, r.erParams.current); } catch (_) {}
  try {
    const r = await chrome.storage.local.get('erDrawMax');
    const lo = +$('pDrawMax').min, hi = +$('pDrawMax').max;
    if (Number.isFinite(r.erDrawMax)) drawMax = Math.min(hi, Math.max(lo, r.erDrawMax));
  } catch (_) {}
  layToUI();
}


// ---------- tabs ----------
//
// The list is the registry's, kept in one place: adding a type to the panel must not mean
// remembering to add a row here. It is duplicated as a literal rather than imported because the
// options page and the side panel do not share a module - if they ever do, this is the first thing
// that should move.
const TAB_DEFS = window.ZOOST_TABS;   // one registry, in tabs.js - see the note at the top of it
const TAB_IDS = TAB_DEFS.map((t) => t.id);
let tabOrderCur = TAB_IDS.slice();
let tabHiddenCur = [];
let tabNoPullCur = [];
let tabAccessCur = { ws: null, access: {} };

const dayOf = (iso) => {
  const d = new Date(iso);
  // Formatted from local parts. Going through toISOString() shifts the day for anyone east of
  // Greenwich - the trap is written up in CLAUDE.md and this is a date the user reads.
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
    // a control that cannot do what it says - the same reason a refused tab is absent from the panel
    // rather than greyed out there.
    const why = denied
      ? `Not granted to your Zoho role${a.status ? ` - Zoho answered ${a.status}` : ''}${a.at ? `, asked ${dayOf(a.at)}` : ''}. Pull again to re-check.`
      : def.note;
    // Two independent switches, because they answer different questions: "do I want to look at this"
    // and "should Zoost even ask Zoho for it". A refused area has neither offered - it is skipped
    // whatever these say, and a control that cannot do what it says is worse than no control.
    row.innerHTML = `<input type="checkbox" ${denied ? 'disabled' : ''} ${tabHiddenCur.includes(id) ? '' : 'checked'} data-id="${escA(id)}" title="Show this tab in the side panel">
      <span class="tn"><b>${def.label}</b><span class="why">${why}</span></span>
      <label class="pl" title="Include this type when you click Pull all"><input type="checkbox" ${denied ? 'disabled' : ''} ${(denied || tabNoPullCur.includes(id)) ? '' : 'checked'} data-pull="${escA(id)}">pull</label>
      <button class="mv" data-up="${escA(id)}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
      <button class="mv" data-down="${escA(id)}" ${i === tabOrderCur.length - 1 ? 'disabled' : ''} title="Move down">↓</button>`;
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
      // back on for the tenth case - someone who mirrors a type for Git and never browses it.
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
      + `${tabAccessCur.ws ? '"' + tabAccessCur.ws + '"' : 'currently open'}: Zoho refused it for your role. `
      + 'Roles are per org, so another workspace may well grant it.';
  } else if (!tabAccessCur.ws) {
    note.style.display = '';
    note.textContent = 'What your Zoho role allows is discovered by pulling - there is no way to ask in '
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
  markOwn('tabPrefs'); dirty.delete('tabPrefs'); conflictBox('tabPrefs', false);
  await chrome.storage.local.set({ tabPrefs: { order: tabOrderCur, hidden: tabHiddenCur, nopull: tabNoPullCur } });
  await stamp();
  toast('Tabs saved.');
};
$('tabReset').onclick = () => { tabOrderCur = TAB_IDS.slice(); tabHiddenCur = []; tabNoPullCur = []; renderTabs(); };


// ---------- guarding against the stale save ----------
//
// One window stops you *having* two copies of this form. It does not stop this copy being out of
// date: it can sit open for hours while the side panel writes some of the same keys - exportScope
// is rewritten every time you export with a different scope, aicfg when the engine changes - and
// then Save writes back what was true when the page loaded. That is the lost update, and it is the
// bug being described: the older copy wins because it saved last.
//
// So each section watches its own key. If it changes elsewhere and you have not touched that
// section, the form re-reads it - silently, because there is nothing to decide. If you *have*
// touched it, nothing is overwritten in either direction: the section says so and offers both ways
// out. Never resolve this by guessing which side is newer; the user is the only one who knows which
// they meant.
/** The data centre to fall back on. It is a one-value setting that changes a mode, so it saves on
 *  change rather than behind a Save button - the convention this page already follows for a
 *  selector. It is only ever read when the panel knows neither a workspace nor a tab. */
// Built from the manifest, like the panel's own picklist: the hosts this extension may reach are
// the data centres it may offer, and a list typed in two places is two lists.
const DC_DEFAULT = 'zoho.com';
async function loadDc() {
  const dcs = [...new Set((chrome.runtime.getManifest().host_permissions || [])
    .filter((h) => h.startsWith('https://crm.'))
    .map((h) => h.slice('https://crm.'.length).replace(/\/.*$/, '')))].sort();
  $('zohoDc').innerHTML = dcs.map((d) => `<option value="${escA(d)}">${escA(d)}</option>`).join('');
  let want = DC_DEFAULT;
  try { const r = await chrome.storage.local.get('zohoDc'); if (r.zohoDc) want = r.zohoDc; } catch (_) {}
  $('zohoDc').value = dcs.includes(want) ? want : dcs[0];
}
$('zohoDc').onchange = async () => {
  markOwn('zohoDc'); dirty.delete('zohoDc'); conflictBox('zohoDc', false);
  await chrome.storage.local.set({ zohoDc: $('zohoDc').value });
  toast('Data centre saved.');
};

const SEC_DIAGRAM = 'Diagram layout';

// ---------- saved search patterns ----------
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
  return null;
}
let rxCur = [];
// A read that threw is not an empty list: rendering the two the same would let Save write [] over
// a list that still exists - absent data authorising a destructive act, the exact class the pull
// already refuses. The flag gates the save and names the state instead.
let rxLoadFailed = true;
function renderRx() {
  if (rxLoadFailed) {
    $('rxlist').innerHTML = '<p class="sub"><b>The stored list could not be read.</b> Nothing is shown and nothing can be saved over it - reload this page to try again.</p>';
    return;
  }
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
async function loadRx() {
  try {
    const st = await chrome.storage.local.get('rxShortcuts');
    rxCur = Array.isArray(st.rxShortcuts)
      ? st.rxShortcuts.map((x) => ({ name: String((x && x.name) || ''), pattern: String((x && x.pattern) || '') }))
      : [];
    rxLoadFailed = false;
  } catch (_) { rxCur = []; rxLoadFailed = true; }
  renderRx();
}
$('rxAdd').onclick = () => { rxCur.push({ name: '', pattern: '' }); renderRx(); markDirty('rxShortcuts'); };
$('saveRx').onclick = async () => {
  if (rxLoadFailed) { toast('The stored list could not be read - saving now could overwrite it. Reload this page.', true); return; }
  const bad = rxProblems(rxCur);
  if (bad) { toast(bad, true); return; }
  markOwn('rxShortcuts'); dirty.delete('rxShortcuts'); conflictBox('rxShortcuts', false);
  // No settingsStamp here: the panel reads this list fresh every time the menu opens, so there is
  // nothing cached anywhere to tell about the change.
  await chrome.storage.local.set({ rxShortcuts: rxCur.map((x) => ({ name: x.name.trim(), pattern: x.pattern })) });
  toast('Patterns saved.');
};

const SECTIONS = {
  zohoDc: { label: 'Data centre', reload: loadDc },
  exportScope: { label: 'Export defaults', reload: loadScope },
  tabPrefs: { label: 'Tabs', reload: loadTabs },
  // Two keys, one section, so the label is a name rather than two copies one edit apart.
  erParams: { label: SEC_DIAGRAM, reload: loadLay },
  erDrawMax: { label: SEC_DIAGRAM, reload: loadLay },
  aicfg: { label: 'AI assistant', reload: loadAi },
  rxShortcuts: { label: 'Saved search patterns', reload: loadRx },
};
const dirty = new Set();
// Writes made from this page also fire onChanged. Marked so the page does not warn about itself.
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
// Any edit inside a section marks it. Attached to the section rather than to each control, so a
// field added later is covered without anyone remembering - the reorder arrows are clicks and not
// input events, hence the third listener.
document.querySelectorAll('[data-section]').forEach((sec) => {
  const k = sec.dataset.section;
  sec.addEventListener('input', () => markDirty(k));
  sec.addEventListener('change', () => markDirty(k));
  sec.addEventListener('click', (e) => { if (e.target.closest('.mv')) markDirty(k); });
});
try {
  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(SECTIONS)) {
      if (!ch[key] || wasOwn(key)) continue;
      if (dirty.has(key)) conflictBox(key, true);          // your edits stand; you decide
      else { try { await SECTIONS[key].reload(); } catch (_) {} }   // nothing to lose: just catch up
    }
  });
} catch (_) {}

// ---------- init ----------
(async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  $('legal').textContent = LEGAL_DISCLAIMER;
  await showRoot(); await loadDc(); await loadAi(); await loadScope(); await loadLay(); await loadTabs(); await loadRx();
})();
$('ai_lock').onchange = () => { aiPassChanging = false; $('ai_pass').value = ''; $('ai_pass2').value = ''; $('ai_passcur').value = ''; syncLockRow(); };
['ai_a_key', 'ai_o_key', 'ai_a_model', 'ai_o_model'].forEach((id) => {
  $(id).oninput = () => { syncLockRow(); markEngineOptions(); };
});
$('ai_passlost').onclick = loseLock;
$('ai_passchange').onclick = () => { aiPassChanging = true; syncLockRow(); focusFirstAsked(); };
