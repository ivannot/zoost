/*
 * keyvault.js - optional passphrase protection for the API key.
 *
 * Why this is optional, and why it is not the default, is the whole design.
 *
 * Chrome offers extensions no encryption at rest and no credential store. Anything the extension can
 * decrypt on its own, anyone with the browser profile can decrypt too - so "encrypting" with a key
 * kept beside the ciphertext is obfuscation, and worse than storing plainly, because it would let us
 * claim protection we do not provide. The only real protection is a secret the extension does not
 * hold: a passphrase the user types.
 *
 * That has a cost, and the cost is the user's to price. On a personal laptop, typing a passphrase
 * every time the browser restarts buys very little. On a shared or managed machine it buys a great
 * deal. So the choice is offered with the trade explained, nothing is forced, and the default stays
 * what it was - stored plainly, and said plainly.
 *
 * Forgetting the passphrase is not a disaster and is not treated as one: there is no recovery, no
 * hint, no escrow. You re-enter the API key and choose again. That is the honest shape for a secret
 * whose replacement costs one visit to a provider's dashboard.
 *
 * The crypto is the boring, correct kind, from the platform: PBKDF2-SHA256 over the passphrase with
 * a random salt, then AES-GCM with a random IV. No dependencies, nothing invented.
 */
(function () {
  const ITER = 250000;                 // deliberate cost, paid once per unlock
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function derive(pass, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iterations || ITER, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }

  async function lock(plain, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await derive(pass, salt, ITER);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
    // The cost is written down beside the ciphertext, not only in the code that produced it. Raising
    // ITER tomorrow is a change nobody can make while the number lives here alone: every box already
    // written would silently derive a different key and read as «wrong passphrase», which is the one
    // failure this file cannot distinguish from a real one. A box that predates this carries no `it`
    // and is read at the old cost, so nothing has to be migrated.
    return { v: 1, it: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  /** Returns the plaintext, or null when the passphrase is wrong - AES-GCM authenticates, so a wrong
   *  passphrase fails rather than returning rubbish. There is no way to tell "wrong passphrase" from
   *  "corrupted data", and the message says so instead of guessing. */
  async function unlock(box, pass) {
    try {
      if (!box || box.v !== 1) return null;
      const key = await derive(pass, unb64(box.salt), Number(box.it) || ITER);
      const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
      return dec.decode(out);
    } catch (_) { return null; }
  }

  // The unlocked key lives in chrome.storage.session - memory only, cleared when the browser
  // restarts or the extension reloads. It is never written back to storage.local, which is the
  // entire point: on disk there is only the ciphertext.
  const SESSION = 'aikeys';
  async function remember(provider, plain) {
    try {
      const r = await chrome.storage.session.get(SESSION);
      await chrome.storage.session.set({ [SESSION]: Object.assign({}, r[SESSION] || {}, { [provider]: plain }) });
    } catch (_) {}
  }
  async function recall(provider) {
    try { const r = await chrome.storage.session.get(SESSION); return (r[SESSION] || {})[provider] || null; }
    catch (_) { return null; }
  }
  // With a provider named, only that one leaves; with none, the whole cache goes. It was all-or-
  // nothing and, worse, nothing called it: pressing «Forget» cleared the key from storage and left
  // the plaintext sitting in the session cache until the browser restarted - so the one control whose
  // whole meaning is «this key is gone» left it in memory. Found while checking an audit's point
  // about session hygiene, which was right for a reason it did not have.
  async function forget(provider) {
    try {
      if (!provider) { await chrome.storage.session.remove(SESSION); return; }
      const r = await chrome.storage.session.get(SESSION);
      const keys = Object.assign({}, r[SESSION] || {});
      delete keys[provider];
      await chrome.storage.session.set({ [SESSION]: keys });
    } catch (_) {}
  }

  window.ZOOST_KEYVAULT = { lock, unlock, remember, recall, forget };
})();
