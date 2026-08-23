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
  // OWASP's current figure for PBKDF2-HMAC-SHA256 is 600,000; this was 250,000, chosen when it was
  // the figure. Raising it costs nothing to anybody who already has a box: the envelope carries `it`,
  // which is exactly what that field is for, so an old box is still read at its own cost and is
  // re-written at this one the next time it is locked. Paid once per unlock, on a passphrase whose
  // threat model is a shared machine.
  const ITER = 600000;
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

  /** Every change to that cache, one at a time.
   *
   * `remember` and `forget` both read the whole object, build a new one from it and write it back.
   * Two of those in flight at once read the same thing and the second write erases the first's
   * effect. Reachable: Save is not disabled while it runs, and `mergeKeys` calls `forget(prov)` for
   * each provider the reader ticked - so a double-press with both ticked can leave a key the reader
   * asked to forget sitting in memory. That is the same defect the comment on `forget` records
   * having just fixed from the other direction.
   *
   * It was safe only as a property of four call sites, never of these two functions - the shape a
   * review of this repository has already named once, about a checker trusting an escaper by name.
   * And nothing could have said so: `keyvault.js` matches `asynccheck`'s declared library exclusion,
   * so the one tool for «written after an await with nothing asked in between» never opens it.
   *
   * A chain rather than a lock: no flag to release, nothing to leave held if a step throws, and the
   * order is the order the callers asked in. `catch` on both sides so one failure does not stop the
   * queue for the rest of the session.
   */
  let _chain = Promise.resolve();
  function serial(fn) {
    const run = _chain.then(fn, fn);
    _chain = run.then(() => {}, () => {});
    return run;
  }
  async function remember(provider, plain) {
    return serial(async () => {
      try {
        const r = await chrome.storage.session.get(SESSION);
        await chrome.storage.session.set({ [SESSION]: Object.assign({}, r[SESSION] || {}, { [provider]: plain }) });
      } catch (_) {}
    });
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
    return serial(async () => {
      try {
        if (!provider) { await chrome.storage.session.remove(SESSION); return; }
        const r = await chrome.storage.session.get(SESSION);
        const keys = Object.assign({}, r[SESSION] || {});
        delete keys[provider];
        await chrome.storage.session.set({ [SESSION]: keys });
      } catch (_) {}
    });
  }

  window.ZOOST_KEYVAULT = { lock, unlock, remember, recall, forget };
})();
