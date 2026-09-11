import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function load(file) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL(`../apps/${file}`, import.meta.url), 'utf8'), context);
  return context;
}

test('pull lifecycle allows a complete operation and records progress', () => {
  const { createPullLifecycle } = load('crm/pull-lifecycle.js');
  const life = createPullLifecycle();
  const id = life.begin();
  assert.equal(life.finish(false, id), false);
  assert.equal(id, 1);
  assert.equal(life.transition('reading', id), true);
  assert.equal(life.progress({ stage: 'reading', done: 2, total: 4 }, id), true);
  assert.equal(life.transition('planning', id), true);
  assert.equal(life.transition('writing', id), true);
  assert.equal(life.transition('refreshing', id), true);
  assert.equal(life.finish(false, id), true);
  assert.equal(life.snapshot().state, 'completed');
});

test('pull lifecycle ignores late progress from an older operation', () => {
  const { createPullLifecycle } = load('analytics/pull-lifecycle.js');
  const life = createPullLifecycle();
  const first = life.begin();
  life.transition('reading', first);
  life.transition('planning', first);
  life.transition('writing', first);
  life.transition('refreshing', first);
  life.finish(false, first);
  const second = life.begin();
  assert.equal(life.progress({ stage: 'old', done: 99 }, first), false);
  assert.equal(life.snapshot().progress, null);
  assert.equal(second, 2);
});

test('pull lifecycle rejects impossible transitions', () => {
  const { createPullLifecycle } = load('crm/pull-lifecycle.js');
  const life = createPullLifecycle();
  assert.equal(life.transition('writing'), false);
  const id = life.begin();
  assert.equal(life.transition('completed', id), false);
  assert.equal(life.snapshot().state, 'validating');
});

test('mirror plan never deletes on an incomplete census', () => {
  const { buildMirrorPlan, validateMirrorPlan } = load('crm/mirror-plan.js');
  const plan = buildMirrorPlan({ old: 1 }, {}, { complete: false });
  assert.deepEqual([...plan.deletes], []);
  assert.equal(validateMirrorPlan(plan), true);
});

test('mirror plan lists create, update, keep and delete explicitly', () => {
  const { buildMirrorPlan, validateMirrorPlan } = load('analytics/mirror-plan.js');
  const plan = buildMirrorPlan({ same: 1, changed: 1, removed: 1 }, { same: 1, changed: 2, added: 1 }, { complete: true });
  assert.deepEqual([...plan.creates], ['added']);
  assert.deepEqual([...plan.updates], ['changed']);
  assert.deepEqual([...plan.keeps], ['same']);
  assert.deepEqual([...plan.deletes], ['removed']);
  assert.equal(validateMirrorPlan(plan), true);
});

test('mirror plan output is immutable', () => {
  const { buildMirrorPlan } = load('crm/mirror-plan.js');
  const plan = buildMirrorPlan({}, { x: 1 }, { complete: true });
  assert.throws(() => plan.creates.push('y'));
});

test('mirror plan treats object key order as the same content', () => {
  const { buildMirrorPlan } = load('analytics/mirror-plan.js');
  const plan = buildMirrorPlan(
    { file: { name: 'query', id: 7 } },
    { file: { id: 7, name: 'query' } },
    { complete: true },
  );
  assert.deepEqual([...plan.updates], []);
  assert.deepEqual([...plan.keeps], ['file']);
});

test('structured error classification marks authentication as retryable', () => {
  const { classifyZoostError } = load('crm/error-model.js');
  const error = classifyZoostError(new Error('INVALID_CSRF_TOKEN'), 'connections');
  assert.equal(error.code, 'authentication');
  assert.equal(error.retryable, true);
  assert.equal(error.area, 'connections');
});

test('structured error classification separates permission failures', () => {
  const { classifyZoostError } = load('analytics/error-model.js');
  const error = classifyZoostError(new Error('permission denied'), 'views');
  assert.equal(error.code, 'permission');
  assert.equal(error.retryable, false);
});

test('structured errors preserve the original cause', () => {
  const { classifyZoostError } = load('crm/error-model.js');
  const cause = new Error('partial response');
  const error = classifyZoostError(cause, 'pull');
  assert.equal(error.code, 'partial-response');
  assert.equal(error.cause, cause);
});

test('bridge errors classify forbidden replies without circular serialization', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../apps/crm/error-model.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../apps/crm/bridge-contract.js', import.meta.url), 'utf8'), context);
  const error = context.bridgeResponseError({ error: 'forbidden', status: 403, forbidden: true }, 'fallback', 'stale');
  assert.equal(error.code, 'permission');
  assert.equal(error.retryable, false);
  assert.doesNotThrow(() => JSON.stringify(error));
});

test('bridge errors preserve an upstream contract code and detail', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../apps/analytics/error-model.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../apps/analytics/bridge-contract.js', import.meta.url), 'utf8'), context);
  const error = context.bridgeResponseError({ ok: false, error: 'shape changed', code: 'UPSTREAM_CONTRACT', detail: { field: 'id' } }, 'fallback', 'stale');
  assert.equal(error.code, 'upstream-contract');
  assert.equal(error.upstreamCode, 'UPSTREAM_CONTRACT');
  assert.deepEqual(error.detail, { field: 'id' });
});

test('a mirror writer refuses a validator that returns false', () => {
  const source = readFileSync(new URL('../apps/analytics/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /if \(validateMirrorPlan\(mirrorPlan\) !== true\) throw/);
  const writer = source.slice(source.indexOf('async function writeToDisk'));
  assert.ok(writer.indexOf('validateMirrorPlan(mirrorPlan)') < writer.indexOf("op.write(PULL_STATE"),
    'Analytics writes the mirror marker before validating its plan');
});

test('bridge reply validation rejects a payload with the wrong container type', () => {
  const analytics = load('analytics/bridge-contract.js');
  assert.throws(() => analytics.validateBridgeReply({ cmd: 'listViews' }, { ok: true, views: {}, folders: [] }), /invalid views/);
  const crm = load('crm/bridge-contract.js');
  assert.throws(() => crm.validateBridgeReply({ cmd: 'listFunctions' }, { ok: true, entries: {}, total: 1 }), /invalid entries/);
});

test('analytics Pull all use case owns the stage order outside the panel', async () => {
  const { createAnalyticsPullUseCase } = load('analytics/pull-usecase.js');
  const phases = [];
  const runner = createAnalyticsPullUseCase({
    requirePerm: async () => {}, setBusy: () => {},
    readWorkspace: async () => ({ workspace: 'w', origin: 'https://analytics.zoho.eu' }),
    readViews: async () => ({ views: [{ id: '1', type: 'QueryTable' }], folders: [] }),
    readErd: async () => ({ tables: {}, relations: [] }), readSql: async () => ({ sql: {}, failed: [] }),
    readDependencies: async () => ({ deps: {}, failed: [] }), phase: (name) => (phases.push(name), true),
    writeToDisk: async () => true, applySnapshot: () => {}, mergeSchemaIntoViews: () => {},
  });
  const result = await runner({ root: {}, current: () => true, say: () => {} });
  assert.deepEqual(phases, ['planning', 'writing', 'refreshing']);
  assert.deepEqual(result.qIds, ['1']);
});

test('both extension bootstraps compose their pull boundary', () => {
  const crm = load('crm/bootstrap.js');
  const crmDeps = { marker: 'crm' };
  crm.createCrmPullController = (deps) => deps;
  assert.equal(crm.createCrmBootstrap(crmDeps), crmDeps);

  const analytics = {};
  vm.createContext(analytics);
  analytics.createAnalyticsPullAdapter = (send) => ({ readWorkspace: () => send({ cmd: 'workspaceInfo' }) });
  analytics.createAnalyticsPullUseCase = (deps) => deps;
  vm.runInContext(readFileSync(new URL('../apps/analytics/bootstrap.js', import.meta.url), 'utf8'), analytics);
  const analyticsDeps = { toBridge: () => Promise.resolve({}), requirePerm: () => {}, setBusy: () => {},
    phase: () => {}, writeToDisk: () => {}, applySnapshot: () => {}, mergeSchemaIntoViews: () => {},
    setStatus: () => {}, render: () => {}, finish: () => {} };
  const wired = analytics.createAnalyticsBootstrap(analyticsDeps);
  assert.equal(typeof wired.readWorkspace, 'function');
  assert.equal(typeof wired.requirePerm, 'function');
});

test('pull controller closes the lifecycle on success and failure', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../apps/crm/pull-lifecycle.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../apps/crm/pull-controller.js', import.meta.url), 'utf8'), context);
  let kind = '';
  const options = {
    busy: () => false, publishBusy: () => {}, blockZoho: () => {}, zohoReady: () => true,
    hasDirectory: () => true, navigationOpen: () => false, updateWorkspaceButtons: () => {},
    statusKind: () => kind,
  };
  const controller = context.createCrmPullController(options);
  controller.setPullBusy(true);
  controller.phase('planning');
  controller.phase('writing');
  controller.phase('refreshing');
  controller.finishPull(false);
  controller.setPullBusy(false);
  assert.equal(controller.pullLifecycle().state, 'completed');
  controller.setPullBusy(true);
  kind = 'bad';
  controller.failPull();
  controller.setPullBusy(false);
  assert.equal(controller.pullLifecycle().state, 'failed');
});

test('an HTTP 500 path containing an id starting with 401 is not authentication', () => {
  const { classifyZoostError } = load('analytics/error-model.js');
  const error = classifyZoostError({ status: 500, message: '500 on /crm/functions/401234' }, 'functions');
  assert.equal(error.code, 'upstream-unavailable');
  assert.equal(error.retryable, true);
});

test('structured errors distinguish rate limits and contract violations', () => {
  const { classifyZoostError } = load('crm/error-model.js');
  assert.equal(classifyZoostError({ status: 429, message: 'Too many requests' }, 'pull').code, 'rate-limited');
  assert.equal(classifyZoostError({ upstreamContract: true, message: 'response changed' }, 'pull').code, 'upstream-contract');
});

test('structured errors distinguish configuration from upstream failures', () => {
  const { classifyZoostError } = load('crm/error-model.js');
  const error = classifyZoostError(new Error('AI provider is not configured'), 'ai');
  assert.equal(error.code, 'configuration');
  assert.equal(error.retryable, false);
});

test('Zoho canary detects a nested contract type change', async () => {
  const { shape, diffShape } = await import('../tools/zoho-canary.mjs');
  const expected = shape({ status: 'success', data: { count: 1 } });
  const changed = shape({ status: 'success', data: { count: '1' } });
  assert.deepEqual(diffShape(changed, expected), ['$.data.count: expected number, got string']);
});

test('Zoho canary can enforce strict additions and later array variants', async () => {
  const { shape, diffShape } = await import('../tools/zoho-canary.mjs');
  const expected = { type: 'object', strict: true, keys: {
    rows: { type: 'array', items: [{ type: 'object', keys: { id: { type: 'number' } } },
      { type: 'object', keys: { id: { type: 'number' } } }] },
  } };
  const actual = shape({ rows: [{ id: 1 }, { id: '2' }], extra: true });
  const differences = diffShape(actual, expected);
  assert.ok(differences.includes('$.extra: unexpected field'));
  assert.ok(differences.includes('$.rows[1].id: expected number, got string'));
});

test('the shipped canary contract accepts the reviewed raw probe fixtures', async () => {
  const { diffResponse, loadContracts } = await import('../tools/zoho-canary.mjs');
  const crm = JSON.parse(readFileSync(new URL('../fixtures/crm/raw-pull.json', import.meta.url)));
  const analytics = JSON.parse(readFileSync(new URL('../fixtures/analytics/raw-pull.json', import.meta.url)));
  const responses = {
    'crm.functions': { functions: [crm.functions.list, crm.functions.compiledList] },
    'crm.modules': crm.modules.list,
    'crm.workflow-rules': crm.workflows.list,
    'analytics.workspace-info': { status: 'success', data: { datasheetJson: { DBNAME: analytics.name } } },
    'analytics.view-list': analytics.viewList,
  };
  const contracts = loadContracts();
  for (const [route, body] of Object.entries(responses)) assert.deepEqual(diffResponse(body, contracts[route]), [], route);
});

test('the default canary contract catches a later array type change and missing protocol label', async () => {
  const { diffResponse, loadContracts } = await import('../tools/zoho-canary.mjs');
  const crm = JSON.parse(readFileSync(new URL('../fixtures/crm/raw-pull.json', import.meta.url)));
  const analytics = JSON.parse(readFileSync(new URL('../fixtures/analytics/raw-pull.json', import.meta.url)));
  const functions = { functions: [crm.functions.list, { ...crm.functions.compiledList, id: 123 }] };
  const changedViews = { ...analytics.viewList, data: { ...analytics.viewList.data,
    viewListKey: analytics.viewList.data.viewListKey.filter((key) => key !== 'VIEW_NAME') } };
  const contracts = loadContracts();
  const functionDiff = diffResponse(functions, contracts['crm.functions']);
  const viewDiff = diffResponse(changedViews, contracts['analytics.view-list']);
  assert.ok(functionDiff.some((line) => line.includes('$.functions[1].id: expected string, got number')));
  assert.ok(viewDiff.some((line) => line.includes('missing required value "VIEW_NAME"')));
});

test('canary run records are sanitized and distinguish never-run from a recent success', async () => {
  const { checkRunRecord, writeRunRecord, loadContracts } = await import('../tools/zoho-canary.mjs');
  const root = mkdtempSync(join(tmpdir(), 'zoost-canary-record-'));
  try {
    const file = join(root, 'last-run.json');
    assert.throws(() => checkRunRecord(new URL('../tools/zoho-canary-status.json', import.meta.url), 30), /never completed/);
    writeRunRecord(file, [
      { app: 'crm', results: [{ name: 'functions', status: 200 }] },
      { app: 'analytics', results: [{ name: 'view-list', status: 200 }] },
    ], loadContracts());
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(checkRunRecord(file, 30).status, 'success');
    assert.equal(saved.status, 'success');
    assert.equal(saved.profiles.length, 2);
    assert.equal(JSON.stringify(saved).includes('session'), false);
    assert.equal(JSON.stringify(saved).includes('org'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
