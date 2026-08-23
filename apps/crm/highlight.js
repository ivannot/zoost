/* highlight.js - minimal Deluge syntax highlighter.
 * Tokenizes the RAW source and HTML-escapes each piece, so it is injection-safe.
 * window.highlightDeluge(code, resolve?, resolveModule?) -> HTML string.
 *   resolve(namespace, name) -> { file, label } | null
 *   linkFor(name, kind, parent) -> module api_name to open, or null. 'mod' is a module named
 *     directly; 'rel' is a related-list name, which identifies the module at the *other* end of
 *     the relation - and that is where the link goes.
 *   When provided and a custom-function call (ns.name where ns is a Deluge function
 *   namespace) resolves, that call is emitted as <a class="c-fn c-link" data-file=…>
 *   so the host can turn it into hypertext navigation.
 */
(function () {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // The same escaper as everywhere else in this repository, and it was not: this one did `&`, `"` and
  // `<` and left `'` and `>` alone. Harmless where it is used - four attributes, all double-quoted -
  // and that is a property of *those call sites*, not of the function, which is the wrong place for a
  // safety property to live. `htmlcheck` approves an expression when it sees a call to `escA`; it
  // never read this body, so the one weak escaper in the tree was the one the checker trusted by
  // name. Found by an outside review, which pointed out that the tool's own docstring already argues
  // against exactly this: a list of names is a checklist wearing a script's clothes.
  const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  // Which argument of which task names something the panel can open. Read from the documented
  // signatures one by one, because they do not agree: `getRelatedRecords("Campaign_Products","Campaigns",id)`
  // names a **related list** first and the module second, and assuming the first argument everywhere
  // linked the wrong word - reported from a real line of Deluge.
  const ARGS = {
    getRecordById: { mod: 0 }, getRecords: { mod: 0 }, searchRecords: { mod: 0 },
    getRelatedRecords: { rel: 0, mod: 1 },
    createRecord: { mod: 0 }, updateRecord: { mod: 0 },
    upsert: { mod: 0 }, attachFile: { mod: 0 }, bulkUpdate: { mod: 0 }, bulkCreate: { mod: 0 },
    updateRelatedRecord: { mod: 0, parent: 2 },
    // Same list as `MODULE_TASK` in graph-core.js and for the same reason: only signatures somebody
    // has read. A task in one and not the other would link a word the reading does not count.
  
  };

  /** Where in the source a string literal is one of those arguments: offset -> {kind, name}.
   *
   *  Computed before tokenizing rather than tracked as the tokenizer walks. The state machine that
   *  did it the other way had to know how many commas it had passed and got the second argument
   *  wrong; this reads the call as a whole, which is the only way the *positions* can be right. */
  /** Where each argument of a Deluge call starts and ends, from just after its `(`.
   *
   *  Here rather than in `graph-core.js` because this file is loaded by both the panel and the graph
   *  window and that one only by the panel - and because there were two implementations of this, one
   *  depth-aware and one not. The weaker one was in the extractor, so it was the one producing the
   *  data: `getRelatedRecords(makeRelation("Prices", "Backup"), "Contacts", id)` split at the first
   *  comma it saw and reported the module as **Backup**, an argument of an argument, with the
   *  dynamic-reference counter at zero - a wrong answer stated as a certain one. Same for a comma
   *  inside a string and for a map literal.
   *
   *  Depth counts `(` `[` `{`, and quotes are skipped whole with their escapes. Positions, not text,
   *  because the highlighter needs to mark a place and the extractor needs to read one. */
  function delugeArgs(code, from) {
    const starts = [from], ends = [];
    let depth = 0, i = from;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === '"' || c === "'") { const q = c; i++; while (i < code.length && code[i] !== q) { if (code[i] === '\\') i++; i++; } continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (c === ')' && depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) { ends.push(i); starts.push(i + 1); }
    }
    ends.push(i);
    return { starts, ends, end: i };
  }
  window.delugeArgs = delugeArgs;

  function argMarks(code) {
    const marks = new Map();
    const call = /\bzoho\.crm\.(?:v8\.)?(\w+)\s*\(/g;   // the V8 family is the same list under a prefix
    let m;
    while ((m = call.exec(code))) {
      const sig = ARGS[m[1]]; if (!sig) continue;
      // Walk the argument list once, remembering where each argument starts. Depth-aware, so a
      // nested call or a map literal does not make the commas lie.
      const { starts, ends } = delugeArgs(code, call.lastIndex);
      const litAt = (idx) => {
        if (idx === undefined || starts[idx] === undefined) return null;
        const lit = code.slice(starts[idx], ends[idx]).match(/^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
        return lit ? { at: starts[idx] + lit[0].length - lit[1].length, name: lit[1].slice(1, -1) } : null;
      };
      const mod = litAt(sig.mod), rel = litAt(sig.rel), par = litAt(sig.parent);
      if (mod) marks.set(mod.at, { kind: 'mod', name: mod.name });
      if (par) marks.set(par.at, { kind: 'mod', name: par.name });
      // The relation is resolved *within* its parent, because the same related-list name can exist
      // on more than one module - so the parent travels with it rather than being looked up later.
      if (rel) marks.set(rel.at, { kind: 'rel', name: rel.name, parent: mod ? mod.name : null });
    }
    return marks;
  }

  window.highlightDeluge = function (code, resolve, linkFor) {
    let out = '', last = 0, m;
    const marks = argMarks(code);
    RE.lastIndex = 0;
    while ((m = RE.exec(code))) {
      out += esc(code.slice(last, m.index));
      if (m[1]) out += `<span class="c-com">${esc(m[0])}</span>`;
      else if (m[2]) {
        const k = marks.get(m.index);
        const target = k && linkFor ? linkFor(k.name, k.kind, k.parent) : null;
        if (target) {
          const why = k.kind === 'rel' ? ` \u00b7 the ${escA(k.name)} relation` : '';
          out += `<a class="c-str c-mod c-link" data-mod="${escA(target)}" title="Go to the ${escA(target)} module${why}">${esc(m[0])}</a>`;
        } else out += `<span class="c-str">${esc(m[0])}</span>`;
      }
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
