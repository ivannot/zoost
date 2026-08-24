/*
 * hook.js - runs in the MAIN world of the Zoho page.
 * Detects what the editor does to a function. Measured from a HAR of the three gestures, all on
 * one public v2 path:
 *   PUT    /crm/v2/settings/functions/{id}   a save     -> 'saved',   id from the url
 *   DELETE /crm/v2/settings/functions/{id}   a deletion -> 'deleted', id from the url
 *   POST   /crm/v2/settings/functions        a creation -> 'created', **no id**
 * On a successful response it notifies the content-bridge via window.postMessage.
 *
 * The creation carries its id only in the *response body*, and this hook does not read bodies: it
 * says what kind of thing happened and the panel goes and looks. That is the difference between a
 * hint and a source, and it is the whole reason this file is defensible - it observes, it does not
 * carry data, and nothing downstream can be fed by it.
 * Observation only - it never mutates anything.
 */
(() => {
  // The guard against installing twice used to be a boolean, and a boolean cannot tell «this hook is
  // already here» from «an **older** hook is already here». So when Chrome kept a page alive across
  // an extension update - or injected this script twice in one page - the new build bowed out and
  // the old one stayed, silently: an evening of fixes that could not possibly take effect, because
  // the code being run was never the code being written. Found by making the bail say so.
  //
  // A version instead of a flag. Same version: nothing to do. Different version: this one is newer
  // by construction (it is the one Chrome just loaded), so it re-patches over whatever is there -
  // the patches wrap whatever they find, so wrapping twice costs one extra call and loses nothing.
  // Bumped whenever anything in this file changes behaviour: a page already running the previous
  // build carries the previous number, and an equal number means «nothing to do» - so leaving it
  // alone leaves the old hook in place in every open tab. That is what it did once, and it cost an
  // evening of fixes that could not take effect.
  const HOOK_V = 3;
  if (window.__zoostHook === HOOK_V) return;
  const replacing = window.__zoostHook;
  window.__zoostHook = HOOK_V;
  const RE = /\/crm\/v\d+\/settings\/functions\/(\d+)\b/;
  // The creation posts to the collection, with nothing after `functions` but a query string.
  const RE_NEW = /\/crm\/v\d+\/settings\/functions(?:\?|$)/;
  // `location.origin` rather than '*': this message goes to a listener in the isolated world of the
  // same document, so the narrower target costs nothing and stops the notice being readable by a
  // frame that happens to be listening. It is a hint, not an authority - the receiver checks that
  // the sender is this window and that the id is digits, and re-reads the function from Zoho itself.
  // Raised by an outside audit, which was right about the '*' and wrong about the receiver: source
  // was already checked. Neither half is worth much alone.
  // Installing over an older hook leaves *its* wrappers underneath - they were never removed, and
  // cannot be: a wrapper does not know how to unwrap itself. So one request walks two observers and
  // the panel is told twice. Harmless in effect (a notice only ever asks for a re-read of the state
  // as it is now) and wrong as a fact, so identical notices arriving together are collapsed here,
  // where the duplication is made, rather than by everyone downstream learning to expect it.
  //
  // A window rather than a flag, because a second genuine save of the same function is a thing
  // people do - and re-reading once instead of twice for it costs nothing.
  // No collapsing here, and deliberately none. An older hook's wrappers stay underneath this one and
  // notify from a closure of their own, so a memory kept here would be two memories and would
  // collapse nothing - measured. And a window that drops a repeat can drop a **second real save**,
  // which is a lost edit. The panel answers a notice by asking Zoho what exists now, which is
  // idempotent: hearing it twice costs one list call and can never lose anything.
  const notify = (type, id) => {
    try {
      window.postMessage({ source: 'DELUGE_IDE_HOOK', type, id: id == null ? '' : String(id) }, location.origin);
    } catch (_) {}
  };
  // One place that maps a request to a kind of event, so the two interceptors below cannot disagree
  // about what they saw - which is the shape this repository keeps arriving at.
  const kindOf = (method, url) => {
    const m = url.match(RE);
    if (m && method === 'PUT') return ['saved', m[1]];
    if (m && method === 'DELETE') return ['deleted', m[1]];
    if (!m && method === 'POST' && RE_NEW.test(url)) return ['created', null];
    return null;
  };

  const origFetch = window.fetch;
  // A declaration rather than an anonymous expression, for the reason the whole convention exists:
  // `tools/asynccheck.py` reads declarations, so this body - the one that watches every request the
  // page makes - was a scope nothing looked inside. `this` still comes from the call site, which an
  // arrow would have broken and a declaration does not.
  async function hookedFetch(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      const method = (args[1]?.method || (req && req.method) || 'GET').toUpperCase();
      const k = res.ok && kindOf(method, url);
      if (k) notify(k[0], k[1]);
    } catch (_) {}
    return res;
  }
  window.fetch = hookedFetch;

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__di = { method: (method || 'GET').toUpperCase(), url: url || '' };
    return XO.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    // If the page captured `open` before this script ran, our record of the method never gets
    // written and every request looks like nothing at all. `responseURL` is on the object itself
    // after the response, so the url can always be recovered; the method cannot, and that is the
    // one thing worth being defensive about.
    if (!this.__di) this.__di = { method: '', url: '' };
    // `loadend`, not `load`: `load` is the success path only, and it does not fire when a request is
    // aborted or errors after the server has already answered - which is a request we would then
    // never hear about. `loadend` fires in every case and the status is checked below anyway.
    this.addEventListener('loadend', () => {
      try {
        const d = this.__di || {};
        if (!d.url && this.responseURL) d.url = this.responseURL;
        const ok = this.status >= 200 && this.status < 300;
        const k = ok && kindOf(d.method, d.url || '');
        if (k) notify(k[0], k[1]);
      } catch (_) {}
    });
    return XS.apply(this, a);
  };

  console.debug('[zoost] hook active v' + HOOK_V + (replacing ? ', replacing v' + replacing : ''));
})();
