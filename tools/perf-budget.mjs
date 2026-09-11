#!/usr/bin/env node
/* Small deterministic macro budgets for the shipped sample generator. */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const sizes = [120, 500, 1000];
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'zoost-perf-'));
try {
  for (const size of sizes) {
    const started = Date.now();
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./bigorg.mjs', import.meta.url)), root, String(size)], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr || `bigorg failed for ${size}`);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
    const elapsed = Date.now() - started;
    if (result.functions !== size) throw new Error(`generator produced ${result.functions}, expected ${size}`);
    if (elapsed > 30000) throw new Error(`large-org budget exceeded for ${size}: ${elapsed}ms`);
    console.log(`perf: ${size} functions, ${result.files} files, ${elapsed}ms`);
  }
  // Measure the shipped Analytics pull use case after the dataset exists.  This is intentionally
  // an in-memory adapter: it exercises the product's stage order and snapshot shaping without
  // charging fixture construction or network/Chrome startup to the product budget.
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(join(ROOT, 'apps', 'analytics', 'pull-usecase.js'), 'utf8'), context);
  const pull = context.createAnalyticsPullUseCase;
  const productTimes = [];
  for (const size of sizes) {
    const views = Array.from({ length: size }, (_, i) => ({ id: String(i + 1), type: i % 4 === 0 ? 'QueryTable' : 'Table' }));
    const queries = views.filter((view) => view.type === 'QueryTable');
    const sql = Object.fromEntries(queries.map((view) => [view.id, { sql: `SELECT ${view.id}`, parents: [], sources: {} }]));
    const deps = Object.fromEntries(views.map((view) => [view.id, { id: view.id, parents: [], children: [], dashboards: [] }]));
    const phases = [];
    let writes = 0;
    const started = Date.now();
    const run = pull({
      root: {}, current: () => true, say: () => {}, requirePerm: async () => {},
      setBusy: () => {}, readWorkspace: async () => ({ workspace: 'perf', origin: 'https://analytics.zoho.eu' }),
      readViews: async () => ({ views, folders: [] }), readErd: async () => ({ tables: {}, relations: [] }),
      readSql: async () => ({ sql, failed: [] }), readDependencies: async () => ({ deps, failed: [] }),
      phase: (name) => { phases.push(name); return true; },
      writeToDisk: async (_info, _op, next) => { writes += Object.keys(next.sqls).length + 4; return true; },
      applySnapshot: () => {}, mergeSchemaIntoViews: () => {}, setStatus: () => {}, render: () => {}, finish: () => {},
    });
    const result = await run({ root: {}, current: () => true, say: () => {} });
    const elapsed = Date.now() - started;
    if (result.moved || !result.next || result.qIds.length !== queries.length) throw new Error(`pull use case produced an invalid ${size}-view snapshot`);
    if (phases.join(',') !== 'planning,writing,refreshing') throw new Error(`pull phases were ${phases.join(',')}`);
    if (writes !== queries.length + 4) throw new Error(`pull wrote ${writes} units for ${size} views`);
    if (elapsed > 30000) throw new Error(`product pull budget exceeded for ${size}: ${elapsed}ms`);
    productTimes.push(elapsed);
    console.log(`perf: product pull ${size} views, ${writes} write units, ${elapsed}ms`);
  }
  const base = Math.max(1, productTimes[0]);
  if (productTimes.at(-1) > base * 20) throw new Error(`product pull growth exceeded budget: ${productTimes.join(', ')}ms`);
  console.log('perf: green (fixture generation and product pull budgets)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
