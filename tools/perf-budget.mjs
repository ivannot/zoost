#!/usr/bin/env node
/* Small deterministic macro budgets for the shipped sample generator. */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  // Measure the shipped Analytics pull use case after the dataset exists.  The adapter is local,
  // but deliberately uses a real temporary directory: the old benchmark measured empty promises
  // and could not see JSON serialization, directory creation, or the number of files the mirror
  // writes.  Fixture construction remains outside the timed region.
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(join(ROOT, 'apps', 'analytics', 'pull-usecase.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(ROOT, 'apps', 'analytics', 'analytics-mirror-writer.js'), 'utf8'), context);
  const pull = context.createAnalyticsPullUseCase;
  const makeMirrorWriter = context.createAnalyticsMirrorWriter;
  const productTimes = [];
  for (const size of sizes) {
    const views = Array.from({ length: size }, (_, i) => ({ id: String(i + 1), type: i % 4 === 0 ? 'QueryTable' : 'Table' }));
    const queries = views.filter((view) => view.type === 'QueryTable');
    const sql = Object.fromEntries(queries.map((view) => [view.id, { sql: `SELECT ${view.id}`, parents: [], sources: {} }]));
    const deps = Object.fromEntries(views.map((view) => [view.id, { id: view.id, parents: [], children: [], dashboards: [] }]));
    const phases = [];
    const productRoot = mkdtempSync(join(root, `product-${size}-`));
    let writes = 0, bytes = 0;
    const disk = join(productRoot, 'workspace');
    const writeJson = async (rel, value) => {
      const body = JSON.stringify(value);
      const target = join(disk, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body); writes += 1; bytes += Buffer.byteLength(body);
    };
    const readJson = async (rel, fallback) => {
      try { return JSON.parse(readFileSync(join(disk, rel), 'utf8')); }
      catch (_) { return fallback; }
    };
    const writer = makeMirrorWriter({
      readJson, writeJson,
      stemOf: (name, id) => `${String(name || 'unnamed').replace(/[^\w.\- ]/g, '_').trim() || 'unnamed'}-${id}`,
    });
    const started = Date.now();
    const run = pull({
      root: {}, current: () => true, say: () => {}, requirePerm: async () => {},
      setBusy: () => {}, readWorkspace: async () => ({ workspace: 'perf', origin: 'https://analytics.zoho.eu' }),
      readViews: async () => ({ views, folders: [] }), readErd: async () => ({ tables: {}, relations: [] }),
      readSql: async () => ({ sql, failed: [] }), readDependencies: async () => ({ deps, failed: [] }),
      phase: (name) => { phases.push(name); return true; },
      writeToDisk: async (_info, _op, next) => {
        await writeJson('views.json', { views: next.views, folders: next.folders });
        await writeJson('structure.json', { schema: next.schema, relations: next.relations });
        await writer.writeLineage(_op, 'perf', next.deps, next.pullFailed);
        await writer.writeSql(_op, next.sqls, next.views);
        return true;
      },
      applySnapshot: () => {}, mergeSchemaIntoViews: () => {}, setStatus: () => {}, render: () => {}, finish: () => {},
    });
    const result = await run({
      root: {}, current: () => true, say: () => {},
      write: async (rel, body) => {
        const target = join(disk, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body); writes += 1; bytes += Buffer.byteLength(body);
      },
    });
    const elapsed = Date.now() - started;
    if (result.moved || !result.next || result.qIds.length !== queries.length) throw new Error(`pull use case produced an invalid ${size}-view snapshot`);
    if (phases.join(',') !== 'planning,writing,refreshing') throw new Error(`pull phases were ${phases.join(',')}`);
    if (writes !== queries.length + 4) throw new Error(`pull wrote ${writes} files for ${size} views`);
    const onDisk = readdirSync(join(productRoot, 'workspace', 'sql')).filter((name) => name.endsWith('.sql'));
    if (onDisk.length !== queries.length) throw new Error(`pull wrote ${onDisk.length} SQL files for ${size} views`);
    if (elapsed > 30000) throw new Error(`product pull budget exceeded for ${size}: ${elapsed}ms`);
    productTimes.push(elapsed);
    console.log(`perf: product pull ${size} views, ${writes} files / ${bytes} bytes, ${elapsed}ms`);
    rmSync(productRoot, { recursive: true, force: true });
  }
  const base = Math.max(1, productTimes[0]);
  if (productTimes.at(-1) > base * 20) throw new Error(`product pull growth exceeded budget: ${productTimes.join(', ')}ms`);
  // Exercise the shipped CRM pull controller separately.  Its runners are supplied as effects, so
  // this measures the real immutable-plan walk, lock and lifecycle bookkeeping without pretending
  // that synthetic promises are Zoho or filesystem latency.  The Analytics use case above remains
  // the product read/plan/write benchmark; this one guards the CRM orchestration path that has no
  // DOM-free vertical use case yet.
  vm.runInContext(readFileSync(join(ROOT, 'apps', 'crm', 'pull-lifecycle.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(ROOT, 'apps', 'crm', 'pull-controller.js'), 'utf8'), context);
  const crmTimes = [];
  for (const size of sizes) {
    let busy = false;
    const areas = Array.from({ length: size }, (_, i) => ({ id: `area-${i}` }));
    const runners = Object.fromEntries(areas.map((area) => [area.id, async () => {}]));
    const controller = context.createCrmPullController({
      busy: () => busy, publishBusy: (value) => { busy = value; }, blockZoho: () => {},
      zohoReady: () => true, hasDirectory: () => true, navigationOpen: () => false,
      updateWorkspaceButtons: () => {}, restoreWorkspaceSelection: () => {}, setStatus: () => {},
      currentView: () => 'functions', tabLabel: (id) => id, runners: () => runners,
      statusKind: () => 'ok', rebuildActive: async () => {},
      beginOperation: () => ({ root: {}, current: () => true, say: () => {} }),
      plan: () => ({ areas, skipped: [], asked: [], askedBefore: {} }), answeredRechecks: () => [],
      takeRechecks: async () => {}, renderTabs: () => {}, forbiddenNote: () => '',
      consumePreferencesChanged: () => false, preferencesChangedNote: '', takeListGap: () => '',
      statusSnapshot: () => ({ text: '', kind: 'ok' }), errorText: (error) => String(error),
    });
    const started = Date.now();
    await controller.pullEverything();
    const elapsed = Date.now() - started;
    const snapshot = controller.pullLifecycle();
    if (snapshot && snapshot.state !== 'completed') throw new Error(`CRM controller ended in ${snapshot.state}`);
    if (elapsed > 30000) throw new Error(`CRM pull orchestration budget exceeded for ${size}: ${elapsed}ms`);
    crmTimes.push(elapsed);
    console.log(`perf: CRM pull orchestration ${size} areas, ${elapsed}ms`);
  }
  if (crmTimes.at(-1) > Math.max(1, crmTimes[0]) * 20) throw new Error(`CRM pull growth exceeded budget: ${crmTimes.join(', ')}ms`);
  console.log('perf: green (fixture generation, Analytics pull and CRM orchestration budgets)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
