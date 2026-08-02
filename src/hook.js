/*
 * hook.js — runs in the MAIN world of the Zoho page.
 * Detects a function save in the editor: the UI issues
 *   PUT /crm/v2/settings/functions/{id}?language=deluge
 * On a successful response it notifies the content-bridge via window.postMessage.
 * Observation only — it never mutates anything.
 */
(() => {
  if (window.__zoostHook) return; window.__zoostHook = true;
  const RE = /\/crm\/v\d+\/settings\/functions\/(\d+)\b/;
  const notify = (id) => {
    try {
      window.postMessage({ source: 'DELUGE_IDE_HOOK', type: 'saved', id: String(id) }, '*');
    } catch (_) {}
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      const method = (args[1]?.method || (req && req.method) || 'GET').toUpperCase();
      const m = url.match(RE);
      if (m && method === 'PUT' && res.ok) notify(m[1]);
    } catch (_) {}
    return res;
  };

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__di = { method: (method || 'GET').toUpperCase(), url: url || '' };
    return XO.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        const d = this.__di || {};
        const m = (d.url || '').match(RE);
        if (m && d.method === 'PUT' && this.status >= 200 && this.status < 300) notify(m[1]);
      } catch (_) {}
    });
    return XS.apply(this, a);
  };

  console.debug('[zoost] hook active');
})();
