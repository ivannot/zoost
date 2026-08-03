/* highlight.js — minimal Deluge syntax highlighter.
 * Tokenizes the RAW source and HTML-escapes each piece, so it is injection-safe.
 * window.highlightDeluge(code, resolve?) -> HTML string.
 *   resolve(namespace, name) -> { file, label } | null
 *   When provided and a custom-function call (ns.name where ns is a Deluge function
 *   namespace) resolves, that call is emitted as <a class="c-fn c-link" data-file=…>
 *   so the host can turn it into hypertext navigation.
 */
(function () {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const KW = 'if|else|for|each|in|return|while|do|try|catch|finally|throw|throws|and|or|not|null|true|false|info';
  const TY = 'void|string|int|bigint|long|double|decimal|float|boolean|bool|map|list|key|date|datetime|time|collection|file';
  const NS = 'standalone|automation|button|schedule|validation_rule';
  const RE = new RegExp(
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)' +          // 1 comments
    "|(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')" + // 2 strings
    '|\\b(\\d+\\.?\\d*)\\b' +                           // 3 numbers
    '|\\b(' + KW + ')\\b' +                             // 4 keywords
    '|\\b(' + TY + ')\\b' +                             // 5 types
    '|\\b(' + NS + ')\\.([A-Za-z_]\\w*)(?=\\s*\\()' +   // 6 ns, 7 name  (custom function call)
    '|\\b([A-Za-z_]\\w*)(?=\\s*\\()',                   // 8 bare call
    'g'
  );
  window.highlightDeluge = function (code, resolve) {
    let out = '', last = 0, m;
    RE.lastIndex = 0;
    while ((m = RE.exec(code))) {
      out += esc(code.slice(last, m.index));
      if (m[1]) out += `<span class="c-com">${esc(m[0])}</span>`;
      else if (m[2]) out += `<span class="c-str">${esc(m[0])}</span>`;
      else if (m[3]) out += `<span class="c-num">${esc(m[0])}</span>`;
      else if (m[4]) out += `<span class="c-kw">${esc(m[0])}</span>`;
      else if (m[5]) out += `<span class="c-type">${esc(m[0])}</span>`;
      else if (m[6] !== undefined) {                    // namespaced custom-function call
        const t = resolve && resolve(m[6], m[7]);
        if (t && (t.href || t.file)) {
          const attr = t.href ? `href="${escA(t.href)}"` : `data-file="${escA(t.file)}"`;
          out += `<a class="c-fn c-link" ${attr} title="Go to ${escA(t.label || m[7])}">${esc(m[0])}</a>`;
        } else out += `<span class="c-fn">${esc(m[0])}</span>`;
      } else out += `<span class="c-fn">${esc(m[0])}</span>`;   // bare call
      last = RE.lastIndex;
    }
    out += esc(code.slice(last));
    return out;
  };
})();
