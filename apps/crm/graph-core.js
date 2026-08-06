/* graph-core.js - build the Deluge reference graph in the browser.
 * window.buildGraph(input) where input = [{ namespace, name, api_name, category,
 *   source, display_name, description, rest, associated_place, dg, file }]
 * Resolution: exact (namespace,name) first; else unique name; else ambiguous/unresolved.
 */
(function () {
  const NS = ['standalone', 'automation', 'button', 'schedule', 'validation_rule'];
  const CALL_RE = new RegExp('\\b(' + NS.join('|') + ')\\.([A-Za-z_]\\w*)\\s*\\(', 'g');

  window.buildGraph = function (input) {
    const nodes = {}, byName = {};
    for (const it of input) {
      const id = it.namespace + '.' + it.name;
      nodes[id] = {
        id, name: it.name, namespace: it.namespace, api_name: it.api_name,
        display_name: it.display_name || it.name, category: it.category, source: it.source,
        description: it.description || '', rest: !!it.rest,
        associated_place: it.associated_place || null, file: it.file,
        calls: [], called_by: [], unresolved: [], ambiguous: [], _dg: it.dg || '',
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
      const n = nodes[id]; const src = n._dg; let m; CALL_RE.lastIndex = 0; const seen = new Set();
      while ((m = CALL_RE.exec(src))) {
        const ns = m[1], name = m[2]; if (ns + '.' + name === id) continue;
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
