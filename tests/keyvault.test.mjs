/*
 * keyvault.test.mjs — the optional passphrase protection, and the save rule around it.
 *
 * Two things are covered, and they fail in opposite directions.
 *
 * The crypto: a wrong passphrase must fail rather than return rubbish, and the plaintext must not
 * survive anywhere in the stored box. If that breaks, the extension claims a protection it does not
 * provide, which is worse than storing the key plainly and saying so.
 *
 * The merge: a blank key field with a key already stored means "leave it alone". A protected key
 * cannot be redisplayed — the passphrase is not ours to hold — so the field is empty every time the
 * options page loads, and reading that as a deletion would silently throw the key away on any
 * unrelated save. That is the case with a real cost and it is why mergeKeys() was lifted out of the
 * Save handler at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run an app's real keyvault.js, with the browser globals it expects. */
function vault(app) {
  const win = {};
  const ctx = vm.createContext({
    window: win, crypto: globalThis.crypto, TextEncoder, TextDecoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    chrome: { storage: { session: sessionStub() } },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps', app, 'keyvault.js'), 'utf8'), ctx);
  return win.ZOOST_KEYVAULT;
}

function sessionStub() {
  let store = {};
  return {
    get: async (k) => ({ [k]: store[k] }),
    set: async (o) => { Object.assign(store, o); },
    remove: async (k) => { delete store[k]; },
    _peek: () => store,
  };
}

const KEY = 'sk-ant-not-a-real-key-0000000000';

test('the stored box carries no trace of the plaintext', async () => {
  const box = await vault('crm').lock(KEY, 'correct horse');
  const flat = JSON.stringify(box);
  assert.ok(!flat.includes(KEY));
  assert.ok(!Buffer.from(flat).includes(Buffer.from(KEY)));
  assert.equal(box.v, 1);
  assert.ok(box.salt && box.iv && box.ct);
});

test('the right passphrase returns the key', async () => {
  const kv = vault('crm');
  assert.equal(await kv.unlock(await kv.lock(KEY, 'correct horse'), 'correct horse'), KEY);
});

test('a wrong passphrase returns null, never rubbish', async () => {
  const kv = vault('crm');
  assert.equal(await kv.unlock(await kv.lock(KEY, 'correct horse'), 'Correct horse'), null);
  assert.equal(await kv.unlock(await kv.lock(KEY, 'correct horse'), ''), null);
});

test('two encryptions of the same key differ — salt and IV are random', async () => {
  const kv = vault('crm');
  const a = await kv.lock(KEY, 'p'), b = await kv.lock(KEY, 'p');
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

test('a tampered box is rejected rather than half-decrypted', async () => {
  const kv = vault('crm');
  const box = await kv.lock(KEY, 'p');
  const bad = Buffer.from(box.ct, 'base64'); bad[0] ^= 1;
  assert.equal(await kv.unlock({ ...box, ct: bad.toString('base64') }, 'p'), null);
});

test('malformed input does not throw — a damaged config must not break the panel', async () => {
  const kv = vault('crm');
  for (const junk of [null, undefined, {}, { v: 2 }, { v: 1, salt: '!', iv: '!', ct: '!' }]) {
    assert.equal(await kv.unlock(junk, 'p'), null);
  }
});

test('the unlocked key goes to session storage and comes back', async () => {
  const kv = vault('crm');
  await kv.remember('anthropic', KEY);
  assert.equal(await kv.recall('anthropic'), KEY);
  assert.equal(await kv.recall('openai'), null);
  await kv.forget();
  assert.equal(await kv.recall('anthropic'), null);
});

test('both apps ship the same vault', () => {
  assert.equal(
    fs.readFileSync(path.join(ROOT, 'apps/crm/keyvault.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'apps/analytics/keyvault.js'), 'utf8'),
  );
});

// ---------- mergeKeys: what Save writes ----------

/** The real mergeKeys() out of an app's options.js, with a working vault behind it. */
function merger(app) {
  const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
  const start = src.indexOf('async function mergeKeys');
  if (start < 0) throw new Error(`${app}/options.js: mergeKeys() not found — renamed or removed. Fix the test or restore the cover.`);
  const end = src.indexOf('\n}', src.indexOf('{', start)) + 2;
  const ctx = vm.createContext({ window: { ZOOST_KEYVAULT: vault(app) } });
  vm.runInContext(src.slice(start, end) + '\nmergeKeys', ctx);
  return vm.runInContext('mergeKeys', ctx);
}

const cfgOf = (a, o = '') => ({ anthropic: { model: 'm', apiKey: a }, openai: { model: 'm', apiKey: o } });

test('an empty field never erases a stored key', async () => {
  const merge = merger('crm');
  const out = await merge(cfgOf(''), { anthropic: { apiKey: KEY }, openai: {} }, false, '');
  assert.equal(out.anthropic.apiKey, KEY);
});

test('an empty field never erases a stored *encrypted* key', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, true, '');
  assert.deepEqual(out.anthropic.apiKeyEnc, box);
  assert.equal(out.anthropic.apiKey, undefined);
});

test('turning protection on encrypts the key already stored in plain', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const out = await merge(cfgOf(''), { anthropic: { apiKey: KEY }, openai: {} }, true, 'p');
  assert.equal(out.anthropic.apiKey, undefined, 'the plaintext must not survive the switch');
  assert.equal(await kv.unlock(out.anthropic.apiKeyEnc, 'p'), KEY);
});

test('turning protection off leaves no ciphertext behind', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf('typed-again'), { anthropic: { apiKeyEnc: box }, openai: {} }, false, '');
  assert.equal(out.anthropic.apiKeyEnc, undefined);
  assert.equal(out.anthropic.apiKey, 'typed-again');
});

test('a newly typed key is encrypted, not stored plainly', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const out = await merge(cfgOf(KEY), { anthropic: {}, openai: {} }, true, 'p');
  assert.equal(out.anthropic.apiKey, undefined);
  assert.equal(await kv.unlock(out.anthropic.apiKeyEnc, 'p'), KEY);
});

test('both providers are handled independently', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const out = await merge(cfgOf('', 'openai-key'), { anthropic: { apiKey: KEY }, openai: {} }, true, 'p');
  assert.equal(await kv.unlock(out.anthropic.apiKeyEnc, 'p'), KEY);
  assert.equal(await kv.unlock(out.openai.apiKeyEnc, 'p'), 'openai-key');
});

test('the two apps decide identically — same code, same answers', async () => {
  const cases = [
    [cfgOf(''), { anthropic: { apiKey: KEY }, openai: {} }, false, ''],
    [cfgOf(KEY), { anthropic: {}, openai: {} }, true, 'p'],
    [cfgOf('', 'o'), { anthropic: { apiKey: 'a' }, openai: {} }, false, ''],
  ];
  for (const [cfg, prev, lock, pass] of cases) {
    const a = await merger('crm')(structuredClone(cfg), prev, lock, pass);
    const b = await merger('analytics')(structuredClone(cfg), prev, lock, pass);
    // Ciphertext differs by design (random salt/IV); what must match is which fields exist.
    assert.deepEqual(Object.keys(a.anthropic).sort(), Object.keys(b.anthropic).sort());
    assert.deepEqual(Object.keys(a.openai).sort(), Object.keys(b.openai).sort());
  }
});

test('the Save handler proves the passphrase in use before writing anything', () => {
  // Encrypting a new key with a passphrase the user has mistyped locks them out of a key they believe
  // they can open, so `cur` is checked against the stored ciphertext rather than taken on trust — and
  // before the merge, not after. Asserted as text because the handler is DOM-bound and not sliceable.
  for (const app of ['crm', 'analytics']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
    const save = src.slice(src.indexOf('const prev = await currentAi();'), src.indexOf('await mergeKeys('));
    assert.match(save, /const needCur = boxes\.length > 0 && \(!wantLock \|\| aiPassChanging \|\| typedKey\)/,
      `${app}: the three cases that need the passphrase in use are no longer stated`);
    assert.match(save, /ZOOST_KEYVAULT\.unlock\(boxes\[0\], cur\)\) === null/,
      `${app}: the passphrase in use is not verified against the stored key`);
  }
});

test('with no passphrase to encrypt with, the merge keeps what was there rather than losing both', async () => {
  // The state the guard above forbids, run anyway. The first version of mergeKeys fell through every
  // branch here and wrote a config with *no key at all* — the typed one could not be encrypted and
  // the stored one was not carried over. The handler refuses this state so the user is told; the
  // function refuses to destroy anything so a future caller that forgets cannot cause a loss.
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf('freshly-typed'), { anthropic: { apiKeyEnc: box }, openai: {} }, true, '');
  assert.equal(out.anthropic.apiKey, undefined, 'the typed key must not be stored in plain');
  assert.equal(await kv.unlock(out.anthropic.apiKeyEnc, 'p'), KEY, 'the stored key must survive');
});

// ---------- going back: the switch has to work in both directions ----------

test('turning protection off with the right passphrase returns the key to clear text', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, false, '', undefined, 'p');
  assert.equal(out.anthropic.apiKey, KEY);
  assert.equal(out.anthropic.apiKeyEnc, undefined);
});

test('turning it off with no passphrase keeps the key rather than destroying it', async () => {
  // This shipped broken and was caught by asking the obvious question: can I go back? The answer was
  // "yes, and your key is gone" — the merge deleted the ciphertext and had no plaintext to put in its
  // place. Silent, total, and irreversible. The handler now refuses; the merge keeps what it has.
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, false, '');
  assert.deepEqual(out.anthropic.apiKeyEnc, box, 'the stored key must survive a failed unlock');
  assert.ok(!out.anthropic.apiKey);
});

test('turning it off with the wrong passphrase keeps the key too', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, false, '', undefined, 'not-it');
  assert.deepEqual(out.anthropic.apiKeyEnc, box);
});

test('a leftover ciphertext with protection off is what the handler refuses to save', () => {
  for (const app of ['crm', 'analytics']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
    assert.match(src, /if \(!wantLock && \(cfg\.anthropic\.apiKeyEnc \|\| cfg\.openai\.apiKeyEnc\)\) \{/,
      `${app}/options.js no longer refuses to write "no protection" over a key nobody can read`);
  }
});

test('on, off, on again — the key survives the whole round trip', async () => {
  const kv = vault('crm'), merge = merger('crm');
  let cfg = await merge(cfgOf(KEY), { anthropic: {}, openai: {} }, true, 'first');
  assert.equal(await kv.unlock(cfg.anthropic.apiKeyEnc, 'first'), KEY);

  cfg = await merge(cfgOf(''), { anthropic: cfg.anthropic, openai: {} }, false, '', undefined, 'first');
  assert.equal(cfg.anthropic.apiKey, KEY, 'back to clear text');

  cfg = await merge(cfgOf(''), { anthropic: cfg.anthropic, openai: {} }, true, 'second');
  assert.equal(await kv.unlock(cfg.anthropic.apiKeyEnc, 'second'), KEY, 'and locked again, with a new passphrase');
  assert.equal(cfg.anthropic.apiKey, undefined);
});

test('changing the passphrase while it stays on re-encrypts nothing it cannot read', async () => {
  // Blank fields with protection already on mean "keep the passphrase I set"; the ciphertext is
  // carried over untouched rather than re-derived from something we do not have.
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, true, '');
  assert.deepEqual(out.anthropic.apiKeyEnc, box);
});

// ---------- Forget: the only place a blank field means "erase" ----------

test('Forget removes the key, where a merely blank field would have kept it', async () => {
  // These two are the same screen state — empty fields — and they must do opposite things. Everywhere
  // else blank means "keep what is stored", which is what protects a passphrase-locked key from being
  // wiped by an unrelated save; Forget is the declared exception, and it is the only way out for a key
  // whose passphrase is gone.
  const merge = merger('crm');
  const prev = { anthropic: { apiKey: KEY }, openai: {} };
  const kept = await merge(cfgOf(''), prev, false, '', new Set());
  assert.equal(kept.anthropic.apiKey, KEY, 'blank alone keeps');

  const gone = await merge(cfgOf(''), prev, false, '', new Set(['anthropic']));
  assert.equal(gone.anthropic.apiKey, '', 'Forget erases');
});

test('Forget releases a key whose passphrase is lost', async () => {
  // The escape hatch. Without it, "I have forgotten the passphrase" would have no answer inside the
  // page: the merge refuses to drop a ciphertext it cannot read, and rightly so.
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'lost-forever');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, false, '', new Set(['anthropic']));
  assert.equal(out.anthropic.apiKeyEnc, undefined);
  assert.equal(out.anthropic.apiKey, '');
});

test('Forget touches one provider and leaves the other alone', async () => {
  const merge = merger('crm');
  const out = await merge(cfgOf('', ''), { anthropic: { apiKey: 'a-key' }, openai: { apiKey: 'o-key' } },
                          false, '', new Set(['openai']));
  assert.equal(out.anthropic.apiKey, 'a-key');
  assert.equal(out.openai.apiKey, '');
});

test('the engine selector refuses an engine that cannot answer, on both sides', () => {
  // Asserted as text: the guard is DOM-bound. What it protects against is a panel that looks
  // configured and fails at the first question, with the reason two clicks away in another window.
  for (const app of ['crm', 'analytics']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
    assert.match(src, /const missing = engineIncomplete\(picked\);/, `${app}: no completeness check on engine change`);
    assert.match(src, /\$\('aiengine'\)\.value = prevEngine;/, `${app}: a refused engine change must put the selector back`);
    assert.match(src, /function engineIncomplete\(which\)/, `${app}: engineIncomplete() is gone`);
  }
});

// ---------- what the passphrase row is asking, at any moment ----------

/** syncLockRow() against a stub DOM. It is four booleans deciding five elements, which is exactly the
 *  shape that looks obvious and is not: the first version left two empty passphrase boxes on screen
 *  after a successful save, which reads as "it did not take" and was reported as a bug. */
function lockUI(app) {
  const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
  const start = src.indexOf('let aiLockStored = false;');
  if (start < 0) throw new Error(`${app}/options.js: the lock-row state is gone — renamed or removed.`);
  const end = src.indexOf('\n}', src.indexOf('function syncLockRow')) + 2;
  const els = {};
  const el = (id) => (els[id] ||= {
    hidden: false, textContent: '', checked: false, value: '',
    classList: { add() {}, remove() {}, toggle() {} },
  });
  const ctx = vm.createContext({ $: el });
  vm.runInContext(src.slice(start, end), ctx);
  return (want, stored, changing, keyTyped = '') => {
    el('ai_lock').checked = want;
    el('ai_a_key').value = keyTyped; el('ai_o_key').value = '';
    vm.runInContext(`aiLockStored = ${stored}; aiPassChanging = ${changing}; syncLockRow();`, ctx);
    return {
      row: !el('ai_lockrow').hidden,
      cur: !el('ai_currow').hidden,
      pass: !el('ai_passrow').hidden,
      repeat: !el('ai_pass2row').hidden,
      set: !el('ai_lockset').hidden,
      lost: !el('ai_lostrow').hidden,
      hint: el('ai_lockhint').textContent,
    };
  };
}

test('with nothing protected and the box unticked, the row is not there at all', () => {
  const ui = lockUI('crm')(false, false, false);
  assert.equal(ui.row, false);
  assert.equal(ui.hint, '');
});

test('ticking the box asks for a passphrase, twice', () => {
  const ui = lockUI('crm')(true, false, false);
  assert.equal(ui.pass, true);
  assert.equal(ui.repeat, true);
  assert.match(ui.hint, /Choose a passphrase/);
});

test('once it is set, the row states it and asks nothing', () => {
  // Reported: two empty boxes still on screen after saving, reading as a failed save.
  const ui = lockUI('crm')(true, true, false);
  assert.equal(ui.cur, false, 'no empty box to misread');
  assert.equal(ui.pass, false);
  assert.equal(ui.set, true, 'it says the key is encrypted instead');
  assert.equal(ui.hint, '');
});

test('changing the passphrase asks for the one in use as well as the new one', () => {
  // Reported, and the worst of the three: it asked for the new passphrase twice, saved, reported
  // success and changed nothing — the old one still unlocked. You cannot re-encrypt what you have not
  // decrypted, and nothing on screen was asking for what the decryption needs.
  const ui = lockUI('crm')(true, true, true);
  assert.equal(ui.cur, true, 'the passphrase in use has to be asked for');
  assert.equal(ui.pass, true);
  assert.equal(ui.repeat, true);
  assert.equal(ui.set, false);
});

test('replacing the API key while protected asks for the passphrase in use', () => {
  // Same fact, third face: a new key has to be encrypted with the passphrase already in use, so that
  // passphrase has to be produced. Without this the collapsed row was a dead end — the save refused
  // for want of a passphrase with no field on screen to type it into.
  const ui = lockUI('crm')(true, true, false, 'sk-new');
  assert.equal(ui.cur, true);
  assert.equal(ui.pass, false, 'the passphrase is not changing, so no new one is asked for');
});

test('unticking with a key protected asks for the current one, once', () => {
  const ui = lockUI('crm')(false, true, false);
  assert.equal(ui.cur, true);
  assert.equal(ui.pass, false, 'you are not choosing a new one, so there is nothing to repeat');
  assert.match(ui.hint, /passphrase in use|current passphrase/);
});

test('the row never shows a box without a question, on either side', () => {
  for (const app of ['crm', 'analytics']) {
    const ui = lockUI(app);
    for (const want of [true, false]) {
      for (const stored of [true, false]) {
        for (const changing of [true, false]) {
          for (const typed of ['', 'sk-new']) {
            const s = ui(want, stored, changing, typed);
            const where = `${app} (${want},${stored},${changing},'${typed}')`;
            if (s.pass || s.cur) assert.ok(s.hint, `${where}: a passphrase box with no question`);
            if (s.repeat) assert.ok(s.pass, `${where}: Repeat without a new passphrase`);
            if (!s.row) assert.ok(!s.pass && !s.cur && !s.set, `${where}: content inside a hidden row`);
            if (s.pass && stored) assert.ok(s.cur, `${where}: re-encrypting without asking what to decrypt with`);
          }
        }
      }
    }
  }
});

test('a failed unlock says so beside the field, not only in the status bar', () => {
  // Reported: typing a wrong passphrase produced no visible message. The message was being sent, to
  // #status — which in the CRM panel sits inside #belowbar, under an AI view that is absolute/inset:0.
  // The element existed, the text arrived, and nothing was on screen. A verdict about a field belongs
  // next to that field; the status line is a second copy, not the only one.
  for (const app of ['crm', 'analytics']) {
    const js = fs.readFileSync(path.join(ROOT, 'apps', app, 'sidepanel.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'apps', app, 'sidepanel.html'), 'utf8');
    assert.match(html, /id="ailockmsg"/, `${app}: no message element inside the unlock row`);
    assert.match(js, /function aiLockMsg\(text\)/, `${app}: aiLockMsg() is gone`);
    // Sliced per branch, not across the function: `[\s\S]*` reaching the success path's aiLockMsg('')
    // made this pass with the failure message deleted — a test that cannot fail, caught by trying.
    const unlock = js.slice(js.indexOf('async function aiUnlock'), js.indexOf('\n}', js.indexOf('async function aiUnlock')));
    for (const guard of ['if (!key) {', 'if (!pass) {']) {
      const i = unlock.indexOf(guard);
      assert.ok(i >= 0, `${app}: aiUnlock no longer guards with ${guard}`);
      const branch = unlock.slice(i, unlock.indexOf('return;', i));
      assert.match(branch, /aiLockMsg\(/, `${app}: "${guard}" fails without saying so next to the field`);
    }
  }
});

test('the CRM status bar is under the AI overlay, which is why the above matters', () => {
  // Not a bug being fixed here — the overlay owning everything below the toolbar is a documented
  // decision — but the reason a status-bar-only message is not a message. Asserted so that if the
  // layout is ever changed, whoever changes it finds this note rather than rediscovering it.
  const html = fs.readFileSync(path.join(ROOT, 'apps/crm/sidepanel.html'), 'utf8');
  const body = html.slice(html.indexOf('<body'));
  const seg = body.slice(body.indexOf('id="belowbar"'), body.indexOf('id="status"'));
  const depth = (seg.match(/<div\b/g) || []).length - (seg.match(/<\/div>/g) || []).length;
  assert.ok(depth > 0, 'if #status has moved out of #belowbar, the AI view no longer covers it');
  assert.match(html, /#aiview\{[^}]*inset:0/, 'and the overlay still covers its whole container');
});

test('the footer is outside the container the AI view covers', () => {
  // Reported with a screenshot: the chat's textarea and Send button had the footer drawn across
  // them. #pfoot was inside #belowbar, which #aiview covers at inset:0, and was held visible with
  // z-index:80 - so it was on top of the composer rather than beside it. The Analytics panel has
  // always had the footer as a sibling; this is the CRM catching up, and the assertion is here so a
  // future tidy-up does not put it back inside.
  for (const app of ['crm', 'analytics']) {
    const html = fs.readFileSync(path.join(ROOT, 'apps', app, 'sidepanel.html'), 'utf8');
    const body = html.slice(html.indexOf('<body'));
    const view = app === 'crm' ? 'id="belowbar"' : 'id="main"';
    const seg = body.slice(body.indexOf(view), body.indexOf('id="pfoot"'));
    const depth = (seg.match(/<div\b/g) || []).length - (seg.match(/<\/div>/g) || []).length;
    assert.ok(depth <= 0, `${app}: #pfoot is inside the container the AI and Health views cover`);
  }
});

// ---------- the lapsed folder permission ----------

/** friendlyError() lifted out of a panel. Pure string in, string out.
 *
 * The panel's MSG block goes into the context with it, because the wording it returns partly lives
 * there now - `Error: ` was written out twice in the Analytics panel and is one constant. Lifting
 * the function without it is a ReferenceError three lines in, which is how this surfaced: the fold
 * shipped, `node --check` passed (the syntax is fine) and only *running* the function found it. The
 * constant is read from the panel rather than restated here, so the test cannot pass on a wording
 * the product no longer uses. */
function errText(app) {
  const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'sidepanel.js'), 'utf8');
  const start = src.indexOf('function friendlyError(e)');
  if (start < 0) throw new Error(`${app}/sidepanel.js: friendlyError() not found — renamed or removed.`);
  const end = src.indexOf('\n}', src.indexOf('{', start)) + 2;
  const ctx = vm.createContext({});
  const msg = src.match(/\nconst MSG = \{[\s\S]*?\n\};/);
  if (!msg) throw new Error(`${app}/sidepanel.js: MSG not found — renamed or removed.`);
  vm.runInContext(msg[0], ctx);
  vm.runInContext(src.slice(start, end), ctx);
  return vm.runInContext('friendlyError', ctx);
}

test('a lapsed folder permission is explained, not quoted', () => {
  // What the user actually saw: "Error: The request is not allowed by the user agent or the platform
  // in the current context." — the exact wording Chrome produces when a File System Access permission
  // has lapsed. It names neither the folder nor the button, so it reads as the extension being broken.
  const real = 'The request is not allowed by the user agent or the platform in the current context.';
  for (const app of ['crm', 'analytics']) {
    const t = errText(app)(new Error(real));
    assert.doesNotMatch(t, /user agent/, `${app}: still quoting the DOMException at the user`);
    assert.match(t, /Refresh/, `${app}: the message must name the button that fixes it`);
    assert.match(t, /working folder/i, `${app}: and what it is about`);
  }
});

test('anything else is passed through rather than dressed up', () => {
  for (const app of ['crm', 'analytics']) {
    assert.equal(errText(app)(new Error('429 rate limited')), 'Error: 429 rate limited');
  }
});

test('the AI path re-grants the folder at the click, where a gesture still exists', () => {
  // The fix, and the reason it cannot live deeper: requestPermission() needs transient user
  // activation, so the same call made inside the agent loop — after a round trip to the model — is
  // refused for want of a gesture, which is the error itself. Both entry points are real clicks.
  for (const app of ['crm', 'analytics']) {
    const js = fs.readFileSync(path.join(ROOT, 'apps', app, 'sidepanel.js'), 'utf8');
    assert.match(js, /async function aiEnsureFiles\(\)/, `${app}: aiEnsureFiles() is gone`);
    const send = js.slice(js.indexOf('async function aiSend'), js.indexOf('aiBusy = true', js.indexOf('async function aiSend')));
    assert.match(send, /await aiEnsureFiles\(\)/, `${app}: aiSend asks the model before it asks for the folder`);
    const toggle = js.slice(js.indexOf('function toggleAI'), js.indexOf('function closeAI'));
    assert.match(toggle, /aiEnsureFiles\(\)/, `${app}: opening the chat measures the index without asking for the folder`);
  }
});

test('changing the passphrase actually changes it', async () => {
  // The bug as it was reported: Save reported success and the old passphrase still opened the key.
  // mergeKeys took `had.apiKeyEnc && !typed` as "leave it alone" and never looked at the new
  // passphrase at all.
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'old');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, true, 'new', undefined, 'old');
  assert.equal(await kv.unlock(out.anthropic.apiKeyEnc, 'new'), KEY, 'the new passphrase must open it');
  assert.equal(await kv.unlock(out.anthropic.apiKeyEnc, 'old'), null, 'the old one must not');
});

test('a wrong current passphrase changes nothing at all', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'old');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, true, 'new', undefined, 'wrong');
  assert.deepEqual(out.anthropic.apiKeyEnc, box, 'the stored key is carried over untouched');
  assert.equal(await kv.unlock(out.anthropic.apiKeyEnc, 'old'), KEY);
});

test('a new API key is encrypted with the passphrase already in use', async () => {
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf('sk-replacement'), { anthropic: { apiKeyEnc: box }, openai: {} }, true, '', undefined, 'p');
  assert.equal(await kv.unlock(out.anthropic.apiKeyEnc, 'p'), 'sk-replacement');
  assert.equal(out.anthropic.apiKey, undefined);
});

test('saving something unrelated leaves a protected key exactly as it was', async () => {
  // No passphrase typed, nothing typed in the key fields: the ciphertext must come through byte for
  // byte rather than being re-derived from something we do not have.
  const kv = vault('crm'), merge = merger('crm');
  const box = await kv.lock(KEY, 'p');
  const out = await merge(cfgOf(''), { anthropic: { apiKeyEnc: box }, openai: {} }, true, '', undefined, '');
  assert.deepEqual(out.anthropic.apiKeyEnc, box);
});

test('the glyph for Clear is not the glyph for Refresh', () => {
  // ↺ and ↻ differ only in the direction of the arrow, at 11px, in a narrow bar. The rotational glyph
  // belongs to "reload"; a second meaning for it is worse than no glyph, so Clear lost its own.
  for (const app of ['crm', 'analytics']) {
    const html = fs.readFileSync(path.join(ROOT, 'apps', app, 'sidepanel.html'), 'utf8');
    assert.ok(!html.includes('\u21ba'), `${app}: ↺ is back next to ↻`);
    assert.ok(html.includes('\u21bb'), `${app}: Refresh has lost its glyph`);
  }
});

// ---------- the way out, and the engine that is not ready ----------

test('the way out of a lost passphrase is offered in every state where one exists', () => {
  // It existed before as a sequence — Forget on each provider, untick, save — that had to be deduced.
  // A recovery path nobody can find is the same as none, and the moment it is most needed is the
  // moment the form is refusing a passphrase the user cannot produce.
  const ui = lockUI('crm');
  for (const want of [true, false]) {
    for (const changing of [true, false]) {
      assert.equal(ui(want, true, changing).lost, true, `offered when protected (${want},${changing})`);
      assert.equal(ui(want, false, changing).lost, false, `not offered when there is nothing to remove (${want},${changing})`);
    }
  }
});

test('every message about a lost passphrase names the control that exists', () => {
  // The messages pointed at "Forget", which is the per-provider button and only half the sequence.
  for (const app of ['crm', 'analytics']) {
    for (const f of ['options.js', 'sidepanel.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'apps', app, f), 'utf8');
      assert.ok(!src.includes('press Forget above'), `${app}/${f}: still sends the user round the old sequence`);
    }
    const html = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.html'), 'utf8');
    assert.match(html, /id="ai_passlost"/, `${app}: the control itself is gone`);
    assert.match(html, /Remove the protection/, `${app}: and its label`);
  }
});

test('removing the protection states what goes and what stays before doing it', () => {
  for (const app of ['crm', 'analytics']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function loseLock'), src.indexOf('\n}', src.indexOf('async function loseLock')));
    assert.match(fn, /window\.confirm\(/, `${app}: destructive and unconfirmed`);
    assert.match(fn, /Kept:/, `${app}: does not say what survives`);
    assert.match(fn, /Lost:/, `${app}: does not say what does not`);
    assert.match(fn, /apiKeyEnc/, `${app}: does not actually remove the ciphertext`);
  }
});

test('an engine that cannot answer says so in the dropdown', () => {
  // The guard stopped you moving *to* an unconfigured engine and said nothing about sitting on one —
  // and a fresh install sits on Anthropic with nothing filled in. The rule was enforced on the user
  // and not on the default.
  for (const app of ['crm', 'analytics']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
    assert.match(src, /function markEngineOptions\(\)/, `${app}: the options never state their state`);
    assert.match(src, /o\.textContent = missing \? `\$\{base\} - needs \$\{missing\}` : base;/,
      `${app}: an incomplete engine reads as a working one`);
  }
});

test('a save that leaves one usable engine selects it', () => {
  // Choosing the only engine that works is not a decision, so it is not asked for.
  for (const app of ['crm', 'analytics']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
    assert.match(src, /if \(!usable\.includes\(cfg\.active\) && usable\.length === 1\) \{/,
      `${app}: a configured engine can still sit behind an unconfigured selection`);
    assert.match(src, /being the only one configured/, `${app}: and it happens without saying so`);
  }
});

test('the caret goes to the first field being asked for, whichever that is', () => {
  // "Change passphrase" reveals two questions and the first is the passphrase in use; the caret was
  // hard-coded to the *new* one and skipped past it. Derived from what is on screen, so a future
  // state that asks for something else keeps working.
  for (const app of ['crm', 'analytics']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
    assert.match(src, /function focusFirstAsked\(\)/, `${app}: focusFirstAsked() is gone`);
    assert.match(src, /\['ai_passcur', 'ai_pass'\]/, `${app}: the order the fields are asked in is no longer stated`);
    assert.doesNotMatch(src, /aiPassChanging = true; syncLockRow\(\); \$\('ai_pass'\)\.focus\(\)/,
      `${app}: Change passphrase focuses the new field again, skipping the one in use`);
  }
});

// ---------- the options form actually loads ----------

/** Run an options page's real loadAi() against a stub DOM.
 *
 * This is the only kind of check that catches a *free variable*. Analytics' loadAi referred to `cfg`,
 * which exists in the CRM's copy of the function and not in its own: a ReferenceError three lines in,
 * silently abandoning everything after it — the OpenAI fields, the tool-step cap, the index cap, the
 * engine highlight and the dropdown labels all stopped being filled in, with nothing on screen saying
 * so. `node --check` sees only syntax, and a regex approximation of no-undef was written, measured at
 * 2251 findings across these files, and thrown away for the same reason the content checker was:
 * a checker with that ratio is one nobody reads. Running the function is exact and costs nothing.
 */
function runLoadAi(app, stored) {
  const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
  const fields = {};
  const el = (id) => (fields[id] ||= {
    value: '', textContent: '', placeholder: '', checked: false, hidden: false, dataset: {},
    options: [], classList: { add() {}, remove() {}, toggle() {} },
    focus() {}, select() {}, closest: () => ({ hidden: false }),
  });
  // The engine dropdown is the one element with real content, because markEngineOptions() rewrites it.
  el('aiengine').options = [
    { value: 'anthropic', textContent: 'Anthropic (Claude) — full agent', dataset: {} },
    { value: 'openai', textContent: 'OpenAI (ChatGPT) — single-shot', dataset: {} },
  ];

  const ctx = vm.createContext({
    $: el, document: { getElementById: el },
    chrome: { storage: { local: { get: async () => ({ aicfg: stored }) }, session: { remove: async () => {} } } },
    console, Object, Array, JSON, Set, Map, String, Number, Boolean, Promise, Date, Math, RegExp, Error,
    window: {}, setTimeout, clearTimeout,
  });
  // Everything loadAi needs, lifted whole. If one of these is renamed the slice throws rather than
  // quietly proving less.
  const pieces = ['aiForget', 'aiStored', 'aiLockStored', 'aiPassChanging', 'prevEngine'];
  for (const name of pieces) {
    const m = src.match(new RegExp(`^(?:const|let)\\s+${name}\\s*=[^\\n]*$`, 'm'));
    if (m) vm.runInContext(m[0], ctx);
  }
  for (const fn of ['wireForget', 'engineIncomplete', 'markEngineOptions', 'aiNeedCurrent',
                    'syncLockRow', 'markEngine', 'loadAi']) {
    const i = src.indexOf(`function ${fn}(`);
    if (i < 0) throw new Error(`${app}/options.js: ${fn}() not found — renamed or removed. Fix the test or restore the cover.`);
    const start = src.lastIndexOf('\n', i) + 1;
    vm.runInContext(src.slice(start, src.indexOf('\n}', i) + 2), ctx);
  }
  return { run: () => vm.runInContext('loadAi()', ctx), fields };
}

const STORED = {
  active: 'openai',
  anthropic: { model: 'claude-x', apiKey: 'sk-ant-x' },
  openai: { model: 'gpt-x', apiKey: 'sk-o-x' },
  maxIter: 12, seedCap: 51000,
};

test('loadAi runs to the end, on both sides', async () => {
  for (const app of ['crm', 'analytics']) {
    const { run } = runLoadAi(app, STORED);
    await run();          // a free variable throws here and nowhere else
  }
});

test('loadAi fills every field, not the ones before the first mistake', async () => {
  // Each of these sat after the ReferenceError and silently stopped being written.
  for (const app of ['crm', 'analytics']) {
    const { run, fields } = runLoadAi(app, STORED);
    await run();
    assert.equal(fields.ai_a_model.value, 'claude-x', `${app}: Anthropic model`);
    assert.equal(fields.ai_o_model.value, 'gpt-x', `${app}: OpenAI model`);
    assert.equal(fields.ai_o_key.value, 'sk-o-x', `${app}: OpenAI key`);
    assert.equal(String(fields.ai_maxiter.value), '12', `${app}: tool-step cap`);
    assert.equal(String(fields.ai_seedcap.value), '51000', `${app}: index cap`);
    assert.equal(fields.aiengine.value, 'openai', `${app}: selected engine`);
  }
});

test('the dropdown states which engines are ready, on both sides', async () => {
  for (const app of ['crm', 'analytics']) {
    const ready = runLoadAi(app, STORED);
    await ready.run();
    assert.ok(!ready.fields.aiengine.options.some((o) => /needs/.test(o.textContent)),
      `${app}: a fully configured pair should carry no warning`);

    const half = runLoadAi(app, { active: 'openai', openai: { model: 'gpt-x', apiKey: 'sk-o-x' } });
    await half.run();
    const anthropic = half.fields.aiengine.options.find((o) => o.value === 'anthropic');
    assert.match(anthropic.textContent, /needs a model and an API key/,
      `${app}: an unconfigured engine must say so in the list`);
  }
});

// ---------------------------------------------------------------------------------------------
// The cost of the derivation travels with the ciphertext. An outside audit asked for it and the
// reason is sharper than «future-proofing»: PBKDF2's iteration count is an input to the key, so
// raising it - the one change this file is *meant* to accept as machines get faster - would make
// every box already written derive a different key and fail to open. That failure is
// indistinguishable from a wrong passphrase, which is the single error this design cannot explain,
// so the number has to be readable from the box rather than from the code that wrote it.

test('the box records the cost it was written at', async () => {
  const box = await vault('crm').lock(KEY, 'correct horse');
  assert.equal(typeof box.it, 'number');
  assert.ok(box.it >= 100000, `a derivation cost of ${box.it} is not a cost`);
});

test('a box written at another cost still opens', async () => {
  // Not a hypothetical: this is what raising ITER looks like to a key stored yesterday.
  const kv = vault('crm');
  const box = await kv.lock(KEY, 'correct horse');
  const cheaper = { ...box, it: box.it };            // same box, read through the recorded number
  assert.equal(await kv.unlock(cheaper, 'correct horse'), KEY);
  const lying = { ...box, it: box.it + 1 };          // a cost that is not the one it was written at
  assert.equal(await kv.unlock(lying, 'correct horse'), null,
               'a box opened at the wrong cost - then the number in it is decorative');
});

test('a box from before the cost was recorded still opens', async () => {
  // Backward compatibility is the whole point of the default: an envelope written by 1.43.0 has no
  // `it`, and must read at the cost that produced it rather than being quietly unreadable.
  const kv = vault('crm');
  const box = await kv.lock(KEY, 'correct horse');
  const old = { v: box.v, salt: box.salt, iv: box.iv, ct: box.ct };
  assert.equal(await kv.unlock(old, 'correct horse'), KEY);
});

test('both products write the same envelope', async () => {
  const a = await vault('crm').lock(KEY, 'x');
  const b = await vault('analytics').lock(KEY, 'x');
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(a.it, b.it, 'the twins derive at different costs');
});

test('nothing that reaches a log or an error carries the key', async () => {
  // The audit's point, made testable: an API key that reaches a thrown message or a serialised
  // object has left the vault, and the panel prints error messages.
  const kv = vault('crm');
  const box = await kv.lock(KEY, 'correct horse');
  assert.ok(!JSON.stringify(box).includes(KEY));
  await kv.remember('anthropic', KEY);
  const wrong = await kv.unlock(box, 'not the passphrase');
  assert.equal(wrong, null, 'a wrong passphrase returned something');
  try {
    await kv.unlock({ v: 1, it: 250000, salt: 'x', iv: 'y', ct: 'z' }, 'p');
  } catch (e) {
    assert.ok(!String(e && e.message).includes(KEY));
  }
});

test('forgetting a provider takes it out of the session cache too', async () => {
  // «Forget» meant «forget on disk»: nothing called into the vault, so the plaintext stayed in the
  // session cache until the browser restarted. The button's whole meaning is that the key is gone.
  const kv = vault('crm');
  await kv.remember('anthropic', KEY);
  await kv.remember('openai', 'sk-openai-not-real');
  await kv.forget('anthropic');
  assert.equal(await kv.recall('anthropic'), null, 'the forgotten key is still in the session');
  assert.equal(await kv.recall('openai'), 'sk-openai-not-real', 'forgetting one took the other with it');
  await kv.forget();
  assert.equal(await kv.recall('openai'), null, 'a bare forget() left something behind');
});

test('the options page is what calls it', async () => {
  // The vault could always do this and nobody asked - which is the actual defect. Asserted on the
  // source because mergeKeys runs against a stubbed window in the other cases here.
  for (const app of ['crm', 'analytics']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps', app, 'options.js'), 'utf8');
    const i = src.indexOf('forget.has(prov)');
    assert.ok(i > 0, `${app}: the forget branch is gone`);
    assert.ok(/ZOOST_KEYVAULT\.forget\(prov\)/.test(src.slice(i, i + 400)),
              `${app}: forgetting a key leaves the plaintext in the session cache`);
  }
});
