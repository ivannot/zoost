/* graph-core.js - build the Deluge reference graph in the browser.
 * window.buildGraph(input) where input = [{ namespace, name, api_name, category,
 *   source, display_name, description, rest, associated_place, dg, file }]
 * Resolution: exact (namespace,name) first; else unique name; else ambiguous/unresolved.
 */
(function () {
  const NS = ['standalone', 'automation', 'button', 'schedule', 'validation_rule'];
  const CALL_RE = new RegExp('\\b(' + NS.join('|') + ')\\.([A-Za-z_]\\w*)\\s*\\(', 'g');

  // Comments and string literals out, newlines and everything else kept. It lives here because this
  // is the file that reads Deluge text, and because there must be one of it: the statistics have
  // used it since they were written while the extractor below read the raw source, so a call
  // somebody commented out months ago was an edge, and the name of a function inside an error
  // message was another. Measured on six shapes that occur in ordinary Deluge: five were wrong.
  //
  // A single left-to-right scan on purpose. Chained regexes get it wrong, because a URL literal
  // ("https://x") contains "//" and a comment-first pass would cut the line and leave an
  // unterminated quote that swallows the lines after it. Newlines are preserved so the line count
  // stays meaningful.
  function stripNonCode(src) {
    const s = String(src || '');
    let out = '', i = 0;
    while (i < s.length) {
      const c = s[i], d = s[i + 1];
      if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); const seg = s.slice(i, e < 0 ? s.length : e + 2); out += seg.replace(/[^\n]/g, ' '); i = e < 0 ? s.length : e + 2; continue; }
      if (c === '/' && d === '/') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; out += ' '; continue; }
      if (c === '"' || c === "'") { const q = c; i++; while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; } i++; out += q + q; continue; }
      out += c; i++;
    }
    return out;
  }
  window.stripNonCode = stripNonCode;

  window.buildGraph = function (input) {
    const nodes = {}, byName = {};
    for (const it of input) {
      const id = it.namespace + '.' + it.name;
      nodes[id] = {
        id, name: it.name, namespace: it.namespace, api_name: it.api_name,
        display_name: it.display_name || it.name, category: it.category, source: it.source,
        description: it.description || '', rest: !!it.rest,
        associated_place: it.associated_place || null, file: it.file,
        calls: [], called_by: [], unresolved: [], ambiguous: [], _dg: stripNonCode(it.dg || ''),
        // Handed in by a caller that read this source before and wrote down what it saw. The
        // node carries it explicitly, like every other field: this constructor copies what it
        // names and nothing else, which is why the first version of the shortcut silently
        // produced a graph with no edges at all.
        _refs: Array.isArray(it._refs) ? it._refs : null,
      };
      (byName[it.name] ||= []).push(id);
    }
    const resolve = (ns, name) => {
      const k = ns + '.' + name;
      if (nodes[k]) return { id: k };
      const hits = byName[name] || [];
      if (hits.length === 1) return { id: hits[0] };
      if (hits.length > 1) return { problem: 'ambiguous' };
      return { problem: 'unresolved' };
    };
    const edges = new Set();
    for (const id in nodes) {
      const n = nodes[id];
      // What the source refers to, as `ns.name` pairs. Either read out of the text here, or handed in
      // by a caller that has them written down from a previous read - the *resolution* below runs
      // either way, because whether a name is unique is a property of the whole workspace and not of
      // the file that mentions it.
      const refs = [];
      if (Array.isArray(n._refs)) { for (const r of n._refs) refs.push(r); }
      else {
        const src = n._dg; let mm; CALL_RE.lastIndex = 0;
        while ((mm = CALL_RE.exec(src))) refs.push(mm[1] + '.' + mm[2]);
      }
      n.refs = refs.slice();          // handed back so the caller can write them down
      const seen = new Set();
      for (const ref of refs) {
        const dot = ref.indexOf('.'); const ns = ref.slice(0, dot), name = ref.slice(dot + 1);
        if (ns + '.' + name === id) continue;
        const r = resolve(ns, name);
        if (r.id && r.id !== id) { if (!seen.has(r.id)) { edges.add(id + '\u0000' + r.id); seen.add(r.id); } }
        else if (r.problem === 'unresolved') { const ref = ns + '.' + name; if (!n.unresolved.includes(ref)) n.unresolved.push(ref); }
        else if (r.problem === 'ambiguous') { const ref = ns + '.' + name; if (!n.ambiguous.includes(ref)) n.ambiguous.push(ref); }
      }
    }
    edges.forEach((e) => { const [a, b] = e.split('\u0000'); nodes[a].calls.push(b); nodes[b].called_by.push(a); });
    let dead = 0, unres = 0, ambig = 0;
    for (const id in nodes) {
      const n = nodes[id]; n.calls.sort(); n.called_by.sort();
      n.dead_suspect = !n.called_by.length && !n.rest && !(n.associated_place && n.associated_place.length);
      if (n.dead_suspect) dead++; unres += n.unresolved.length; ambig += n.ambiguous.length;
      delete n._dg;
    }
    return {
      generated: new Date().toISOString(),
      counts: { nodes: Object.keys(nodes).length, edges: edges.size, dead_suspects: dead, unresolved: unres, ambiguous: ambig },
      nodes,
    };
  };

})();
