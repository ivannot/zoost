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
  // One scan, two answers, because two readers of the same text is the shape this repository keeps
  // paying for. `code` has the string literals emptied - that is what «is this a call» wants, and it
  // is what the statistics have always counted. `bare` keeps them and drops only the comments,
  // because the *names of modules* are written inside those literals: `zoho.crm.getRecordById(
  // "Contacts", id)`, a COQL query, the path of a REST url. Emptying them would erase exactly the
  // thing the module reading is looking for.
  function scanDeluge(src) {
    const s = String(src || '');
    let code = '', bare = '', i = 0;
    while (i < s.length) {
      const c = s[i], d = s[i + 1];
      if (c === '/' && d === '*') {
        const e = s.indexOf('*/', i + 2); const seg = s.slice(i, e < 0 ? s.length : e + 2);
        const blank = seg.replace(/[^\n]/g, ' '); code += blank; bare += blank; i = e < 0 ? s.length : e + 2; continue;
      }
      if (c === '/' && d === '/') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; code += ' '; bare += ' '; continue; }
      if (c === '"' || c === "'") {
        const q = c, from = i; i++;
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
        i++;
        code += q + q; bare += s.slice(from, Math.min(i, s.length)); continue;
      }
      code += c; bare += c; i++;
    }
    return { code, bare };
  }
  // Kept as its own name because it is what the statistics ask for and what the tests lift - and
  // written over three lines because `tests/slice.mjs` ends a declaration at the first brace in the
  // declaration's own column, so a one-line function makes it swallow everything below.
  function stripNonCode(src) {
    return scanDeluge(src).code;
  }
  window.stripNonCode = stripNonCode;

  // Which Deluge task names a module in its first argument, and whether it reads or writes it. Not
  // inferred from the verb: each of these has a documented signature, and a task that is not on this
  // list contributes nothing rather than being guessed at. `read`/`write` is the distinction that
  // matters to somebody about to change a field, so it is carried rather than flattened to «uses».
  // `arg` is *which* argument names the module, because it is not always the first - and assuming it
  // was is a defect this file carried until somebody read a real line of Deluge: in
  // `getRelatedRecords("Campaign_Products", "Campaigns", id)` the first argument is the **related list**
  // and the module is the second. Each entry here is a documented signature, not a pattern.
  const MODULE_TASK = {
    getRecordById: { mode: 'read', arg: 0 }, getRecords: { mode: 'read', arg: 0 },
    searchRecords: { mode: 'read', arg: 0 },
    getRelatedRecords: { mode: 'read', arg: 1, list: 0 },
    createRecord: { mode: 'write', arg: 0 }, updateRecord: { mode: 'write', arg: 0 },
    upsert: { mode: 'write', arg: 0 }, attachFile: { mode: 'write', arg: 0 },
    bulkUpdate: { mode: 'write', arg: 0 }, bulkCreate: { mode: 'write', arg: 0 },
    // Two modules in one call: the sub module it writes, and the parent it hangs from - which is
    // the third argument, not the second. Another signature that no pattern would have got right.
    updateRelatedRecord: { mode: 'write', arg: 0, parent: 2 },
    // Every line above was read off its own documentation page, one at a time, after a signature
    // written from memory put the module in the wrong argument - `getRelatedRecords` names the
    // relation first and its parent module second, and assuming «the first argument» linked the
    // wrong word in somebody's real code. `deleteRecord`, `bulkUpdate` and `upsertRecord` have no
    // page under /deluge/help/crm/ and are deliberately absent: a task whose signature nobody here
    // has read contributes nothing rather than a guess. `deleteRecord` and `upsertRecord` are not
    // task names at all - the page that looks like the second documents `zoho.crm.upsert`.
    //
    // **The V8 family is the same list under another prefix.** `zoho.crm.v8.getRelatedRecords(...)`
    // is the same task with the same argument order and a longer tail of optional parameters, so
    // the prefix is optional in the pattern rather than a second table - and, until it was, every
    // V8 call was invisible here: `zoho.crm.(\w+)\(` cannot match a name with a dot in front of it,
    // so those orgs' modules simply did not appear, in silence. `getFields` and `convertLead` are
    // left out: the first reads a module's *metadata* rather than its records, and the second names
    // no module at all - neither has been read closely enough to claim.
  };
  // Not a module, whatever follows it in a url: these are the API's own endpoints.
  const NOT_A_MODULE = /^(coql|settings|org|users|functions|actions|__|v\d)/i;

  /** Every module this source names, as *candidates* - and the count of the ones it cannot name.
   *
   *  Candidates, not answers, for the same reason `refs` are references and not edges: whether a
   *  word is a module of *this* org is a fact about the workspace, not about the file, and it
   *  changes the day a module is added. The panel resolves them against the module index and shows
   *  nothing it cannot match, so a query selecting `from Contacts` in an org without that module
   *  says nothing instead of inventing a box.
   *
   *  Three ways a module gets named, all measured on real orgs before being written: the documented
   *  tasks (the overwhelming majority), a COQL query, and the path of a REST url. `unknown` counts
   *  the calls whose module is computed at run time - it is shown, never guessed, because a reader
   *  deciding whether a field is safe to change must be told the answer is a lower bound. */
  function moduleRefs(bare) {
    const seen = new Map(); let unknown = 0;
    const add = (name, mode, via) => {
      if (!name || !/^[A-Za-z_]\w*$/.test(name)) return;
      const k = name + '|' + mode;
      if (!seen.has(k)) seen.set(k, { name, mode, via });
    };
    let m;
    const lists = new Map();
    // The first two arguments, because that is as far as any documented signature puts a module.
    // Split by `window.delugeArgs`, the depth-aware scanner the syntax highlighter already had. This
    // used to cut the argument list at the first `,` or `)` it met, which is a different language:
    // `getRelatedRecords(makeRelation("Prices", "Backup"), "Contacts", id)` reported the module as
    // **Backup** - an argument of an argument - with `unknown` at zero, so a wrong answer arrived
    // stated as a certain one, into Details, Health, the exports and the assistant. Two scanners for
    // one job, and the weaker of the two was the one producing the data.
    //
    // `lastIndex` is deliberately not advanced past the call: a task nested inside another task's
    // arguments is a reference of its own and has to be found too.
    const task = /\bzoho\.crm\.(?:v8\.)?(\w+)\s*\(/g;
    const literal = (a) => { const l = String(a || '').trim().match(/^"([^"]*)"$|^'([^']*)'$/); return l ? (l[1] !== undefined ? l[1] : l[2]) : null; };
    while ((m = task.exec(bare))) {
      const sig = MODULE_TASK[m[1]]; if (!sig) continue;
      const at = window.delugeArgs(bare, task.lastIndex);
      const args = at.starts.map((st, i) => bare.slice(st, at.ends[i]));
      const mod = literal(args[sig.arg]);
      if (mod) add(mod, sig.mode, m[1]); else unknown++;
      // A task that names a second module names it as itself, not as a footnote to the first.
      // Counted when it cannot be read, exactly like the first module. A call that names one module
      // and computes the other was reported as fully understood - «every dynamic destination is
      // declared» has to hold for the second one too, or the count quietly promises more than it
      // knows.
      if (sig.parent !== undefined) { const p = literal(args[sig.parent]); if (p) add(p, sig.mode, m[1]); else unknown++; }
      // The related list is a name this workspace also holds, so it is carried beside the module
      // rather than thrown away - it is what the reader actually wrote, and it can be looked up.
      if (sig.list !== undefined) {
        const rl = literal(args[sig.list]);
        if (rl && !lists.has(rl)) lists.set(rl, { name: rl, module: mod || null });
      }
    }
    const url = /crm\/v\d+(?:\.\d+)?\/([A-Za-z_]\w*)/g;
    while ((m = url.exec(bare))) { if (!NOT_A_MODULE.test(m[1])) add(m[1], 'touch', 'url'); }
    // A COQL query is read-only by construction, and it is recognised as a whole rather than by the
    // word `from` alone - which also appears in `sendmail[from: ...]`.
    const coql = /"([^"]*\bselect\b[^"]*)"|'([^']*\bselect\b[^']*)'/gi;
    while ((m = coql.exec(bare))) {
      const q = m[1] || m[2] || ''; const f = q.match(/\bfrom\s+([A-Za-z_]\w*)/i);
      if (f) add(f[1], 'read', 'coql');
    }
    return { modules: [...seen.values()], lists: [...lists.values()], unknown };
  }

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
        // The source with its literals intact, for the module reading below. Same text, read once.
        _bare: it.dg ? scanDeluge(it.dg).bare : '',
        _mods: (it._modules && Array.isArray(it._modules.modules)) ? it._modules : null,
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
      // The modules this function names, on the same terms as the references: read from the source
      // when there is one, taken from the caller when it has them written down, and handed back
      // either way. They stay *candidates* here - graph-core knows nothing about which modules this
      // org has - and are resolved against the module index by whoever draws them.
      const mods = n._mods || moduleRefs(n._bare);
      n.modules = mods.modules.slice(); n.modulesUnknown = mods.unknown || 0;
      delete n._bare; delete n._mods;
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
