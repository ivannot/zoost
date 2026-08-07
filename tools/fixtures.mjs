/* Write fixtures/ from the generator the extension itself ships.
 *
 *     node tools/fixtures.mjs
 *
 * There is ONE generator - `apps/<app>/sample-org.js` - and this is its second consumer. It used to
 * be a Python script beside the fixture, which meant two descriptions of the same workspace shape
 * and no way to keep them honest; the shipped one is the authority now and this borrows it.
 *
 * The difference between what the panel writes and what lands here is a flag, not a fork:
 * `edgeCases` adds the states that exist so the panel's own marks and filters have something to
 * show - a module Zoho refuses to describe, meta below META_SV, unresolved and ambiguous names, a
 * hidden layout, system and many-to-many related lists. Those belong in a fixture the tests read.
 * They do not belong in the workspace somebody opens on their first day, where a refused module is
 * just a puzzle.
 *
 * It also builds the graphData payloads the diagram window consumes, because tools/shots.py feeds
 * them straight to graphview.html. They are derived from the same file tree, so they cannot describe
 * a workspace the files do not.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function generator(app) {
  const ctx = { window: {}, Object, JSON, Math, String, Array, Set, Number };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(ROOT, 'apps', app, 'sample-org.js'), 'utf8'), ctx);
  if (!ctx.window.SAMPLE_ORG) throw new Error(app + ': sample-org.js defined no window.SAMPLE_ORG');
  return ctx.window.SAMPLE_ORG;
}

function writeTree(base, files) {
  rmSync(base, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
}

/* The call graph the diagram window is given. It is what the panel's own callGraphWithContext()
 * produces - functions, plus what *starts* the code and what it *reaches* - derived here from the
 * same files so the two cannot describe different orgs. */
function callGraph(files, meta) {
  const nodes = {};
  const read = (p) => JSON.parse(files[p]);
  for (const f of read('functions/index.json').items) {
    const id = f.namespace + '.' + f.name;
    const m = read('functions/' + f.namespace + '/' + f.name + '.meta.json');
    const src = files['functions/' + f.namespace + '/' + f.name + '.dg'];
    const re = new RegExp(String.raw`\b(${meta.namespaces.join('|')})\.([A-Za-z_]\w*)\s*\(`, 'g');
    const calls = [...new Set([...src.matchAll(re)].map((x) => x[1] + '.' + x[2]))].filter((c) => c !== id);
    nodes[id] = { id, name: f.name, display_name: f.name, namespace: f.namespace,
                  category: f.category, calls, called_by: [], params: m.params || [],
                  return_type: m.return_type || '', rest: !!m.rest, dead_suspect: false,
                  unresolved: m.unresolved || [], ambiguous: m.ambiguous || [] };
  }
  for (const w of read('workflows/index.json').items) {
    const full = read('workflows/' + w.id + '.json');
    const fns = [];
    for (const c of full.conditions || []) {
      for (const a of (c.actions || []).concat(...(c.scheduled_actions || []).map((s) => s.actions || []))) {
        if (a.type === 'function' && a.name) fns.push(a.name);
      }
    }
    nodes['wf:' + w.id] = { id: 'wf:' + w.id, name: w.name, display_name: w.name,
                            namespace: w.module, category: 'workflows', calls: fns, called_by: [],
                            params: [], return_type: '', rest: false, dead_suspect: false,
                            unresolved: [], ambiguous: [] };
  }
  for (const s of read('schedules/index.json').items) {
    nodes['sch:' + s.id] = { id: 'sch:' + s.id, name: s.name, display_name: s.name,
                             namespace: 'schedules', category: 'schedules',
                             calls: s.function ? [s.function] : [], called_by: [], params: [],
                             return_type: '', rest: false, dead_suspect: false,
                             unresolved: [], ambiguous: [] };
  }
  for (const c of read('connections/index.json').items) {
    const id = 'conn:' + c.name;
    nodes[id] = { id, name: c.display_name, display_name: c.display_name, namespace: 'connections',
                  category: 'connections', calls: [], called_by: [], params: [], return_type: '',
                  rest: false, dead_suspect: false, unresolved: [], ambiguous: [] };
    for (const u of c.used_by || []) if (nodes[u]) nodes[u].calls.push(id);
  }
  for (const n of Object.values(nodes)) {
    for (const c of n.calls) if (nodes[c]) nodes[c].called_by.push(n.id);
  }
  for (const n of Object.values(nodes)) {
    n.dead_suspect = !n.called_by.length && n.category !== 'workflows' && n.category !== 'schedules';
  }
  const edges = Object.values(nodes).reduce((s, n) => s + n.calls.filter((c) => nodes[c]).length, 0);
  return { kind: 'calls', nodes, edges: [], focus: null, depth: 2,
           counts: { nodes: Object.keys(nodes).length, edges,
                     dead_suspects: Object.values(nodes).filter((n) => n.dead_suspect).length,
                     unresolved: Object.values(nodes).filter((n) => n.unresolved.length).length },
           workspace: { instance: meta.instance, org: meta.org, label: 'Sample org' } };
}

/* The module graph: lookups are the edges, and a module Zoho refused to describe is a node that
 * makes no claim about its own fields. */
function schemaGraph(files, meta) {
  const nodes = {};
  const index = JSON.parse(files['modules/index.json']).items;
  for (const m of index) {
    const full = JSON.parse(files['modules/' + m.api_name + '.json']);
    const n = { id: m.api_name, name: m.api_name, api_name: m.api_name,
                display_name: m.display_name, namespace: m.category, category: m.category,
                fields: full.fields || [], layouts: full.layouts || [],
                related_lists: full.related_lists || [], calls: [], called_by: [],
                dead_suspect: false, unresolved: [], ambiguous: [] };
    if (full.unreadable) n.unreadable = full.unreadable;
    n.calls = (full.fields || []).filter((f) => f.lookup).map((f) => f.lookup);
    nodes[m.api_name] = n;
  }
  for (const n of Object.values(nodes)) {
    for (const c of n.calls) if (nodes[c]) nodes[c].called_by.push(n.id);
  }
  const edges = Object.values(nodes).reduce((s, n) => s + n.calls.filter((c) => nodes[c]).length, 0);
  return { kind: 'schema', nodes, edges: [], focus: null, depth: 2,
           counts: { nodes: Object.keys(nodes).length, edges, dead_suspects: 0, unresolved: 0 },
           workspace: { instance: meta.instance, org: meta.org, label: 'Sample org' } };
}

const crm = generator('crm');
const files = crm.files({ functions: 120, edgeCases: true });
writeTree(join(ROOT, 'fixtures', 'crm', crm.folderName()), files);
const meta = { namespaces: crm.namespaces, org: crm.org, instance: crm.instance };
const J = (p, v) => writeFileSync(join(ROOT, 'fixtures', p), JSON.stringify(v, null, 2) + '\n', 'utf8');
const calls = callGraph(files, meta);
J('graph-crm-calls.json', calls);
J('graph-crm-schema.json', schemaGraph(files, meta));

console.log('CRM      : %d files, %d nodes, %d edges in the call graph',
            Object.keys(files).length, calls.counts.nodes, calls.counts.edges);
console.log('           %d modules, %d workflows, %d schedules, %d connections',
            JSON.parse(files['modules/index.json']).items.length,
            JSON.parse(files['workflows/index.json']).items.length,
            JSON.parse(files['schedules/index.json']).items.length,
            JSON.parse(files['connections/index.json']).items.length);

/* Zoho Analytics: one node per data-bearing view, foreign keys as the edges. Presentation views are
 * not nodes - they have no columns of their own, which is a fact about the platform and not a gap. */
function analyticsGraph(af) {
  const views = JSON.parse(af['views.json']).views;
  const schema = JSON.parse(af['schema.json']);
  const byId = Object.fromEntries(views.map((v) => [v.VIEW_ID, v]));
  const nodes = {};
  for (const v of views) {
    if (v.VIEW_TYPE !== 'Table' && v.VIEW_TYPE !== 'QueryTable') continue;
    const t = schema.tables[v.VIEW_ID] || { columns: [] };
    nodes[v.VIEW_ID] = {
      id: v.VIEW_ID, name: v.VIEW_NAME, api_name: v.VIEW_NAME, display_name: v.VIEW_NAME,
      namespace: v.VIEW_TYPE === 'QueryTable' ? 'query' : 'table', category: v.VIEW_TYPE,
      system: !!v.SYSTEM, joins: [], calls: [], called_by: [],
      dead_suspect: false, unresolved: [], ambiguous: [],
      fields: t.columns.map((c) => ({ api_name: c.name, data_type: c.type, mandatory: false,
        lookup: (schema.relations.find((r) => r.from === v.VIEW_ID && r.fromColumn === c.name) || {}).to || null })),
    };
  }
  for (const r of schema.relations) {
    const a = nodes[r.from], b = nodes[r.to];
    if (!a || !b) continue;
    a.calls.push(r.to); b.called_by.push(r.from);
    a.joins.push({ direction: 'out', column: r.fromColumn, other: r.to,
                   otherName: byId[r.to].VIEW_NAME, otherColumn: r.toColumn, relation: r.relation });
    b.joins.push({ direction: 'in', column: r.toColumn, other: r.from,
                   otherName: byId[r.from].VIEW_NAME, otherColumn: r.fromColumn, relation: r.relation });
  }
  for (const nd of Object.values(nodes)) nd.dead_suspect = !nd.calls.length && !nd.called_by.length;
  const edges = Object.values(nodes).reduce((s, nd) => s + nd.calls.length, 0);
  return { kind: 'schema', nodes, edges: [], focus: null, depth: 2,
           counts: { nodes: Object.keys(nodes).length, edges,
                     dead_suspects: Object.values(nodes).filter((nd) => nd.dead_suspect).length,
                     unresolved: 0 },
           workspace: { name: 'Sample workspace', id: '99000001', label: 'Sample workspace' } };
}

const an = generator('analytics');
const af = an.files({ edgeCases: true });
writeTree(join(ROOT, 'fixtures', 'analytics', an.folderName()), af);
const ag = analyticsGraph(af);
J('graph-analytics.json', ag);
console.log('Analytics: %d files, %d views, %d data objects, %d relations',
            Object.keys(af).length, JSON.parse(af['views.json']).views.length,
            ag.counts.nodes, ag.counts.edges);
