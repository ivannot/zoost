import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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

test('Analytics view model derives relations and structure without browser globals', () => {
  const model = load('analytics/analytics-view-model.js').createAnalyticsViewModel();
  const views = [{ id: 'root', name: 'Orders', type: 'Table' }, { id: 'report', name: 'Report', parent: 'root', type: 'Pivot' }];
  const schema = { root: { designModifiedAt: 12, system: false } };
  assert.equal(model.structureChain(views[1], views, schema).map((v) => v.id).join(','), 'report,root');
  assert.equal(model.isOrphanCandidate({ id: 'root', type: 'Table' }, { root: { children: [], dashboards: [] } }), true);
  assert.equal(model.nameOf('missing', views), 'missing');
  assert.equal(model.mergeSchema(views, schema)[0].designModifiedAt, 12);
});

test('CRM pull adapter keeps census and source requests discriminated', async () => {
  const sent = [];
  const { createCrmPullAdapter } = load('crm/pull-adapter.js');
  const adapter = createCrmPullAdapter(async (request) => {
    sent.push(request);
    if (request.cmd === 'listFunctions') return { ok: true, entries: [] };
    if (request.cmd === 'functionUiIds') return { ok: true, map: {} };
    return { ok: true, file: { id: request.id } };
  });
  await adapter.listFunctions();
  await adapter.functionUiIds();
  await adapter.fetchOne({ id: 'fn-1', language: 'deluge' });
  assert.equal(JSON.stringify(sent), JSON.stringify([
    { cmd: 'listFunctions' }, { cmd: 'functionUiIds' },
    { cmd: 'fetchOne', id: 'fn-1', language: 'deluge' },
  ]));
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

test('CRM pull controller does not replay phases owned by a vertical runner', async () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../apps/crm/pull-lifecycle.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../apps/crm/pull-controller.js', import.meta.url), 'utf8'), context);
  let busy = false;
  let controller;
  const options = {
    busy: () => busy, publishBusy: (value) => { busy = value; }, blockZoho: () => {}, zohoReady: () => true,
    hasDirectory: () => true, navigationOpen: () => false, updateWorkspaceButtons: () => {},
    restoreWorkspaceSelection: () => {}, setStatus: () => {}, currentView: () => 'functions',
    tabLabel: (id) => id, runners: () => ({ functions: async () => {
      controller.phase('planning'); controller.phase('writing'); controller.phase('refreshing');
    }}), statusKind: () => 'ok', rebuildActive: async () => {},
    beginOperation: () => ({ root: {}, current: () => true, say: () => {} }),
    plan: () => ({ areas: [{ id: 'functions' }], skipped: [], asked: [], askedBefore: {} }),
    answeredRechecks: () => [], takeRechecks: async () => {}, renderTabs: () => {}, forbiddenNote: () => '',
    consumePreferencesChanged: () => false, preferencesChangedNote: '', takeListGap: () => '',
    statusSnapshot: () => ({ text: '', kind: 'ok' }), errorText: String,
  };
  controller = context.createCrmPullController(options);
  await controller.pullEverything();
  assert.equal(controller.pullLifecycle().state, 'completed');
});

test('CRM pull controller rejects construction without a lifecycle', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../apps/crm/pull-controller.js', import.meta.url), 'utf8'), context);
  assert.throws(() => context.createCrmPullController({}), /Pull lifecycle is required/);
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
      { app: 'crm', results: [
        { name: 'context', status: 200 }, { name: 'functions', status: 200 },
        { name: 'modules', status: 200 }, { name: 'workflow-rules', status: 200 },
      ] },
    ], loadContracts());
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(checkRunRecord(file, 30).status, 'success');
    assert.equal(saved.status, 'success');
    assert.deepEqual(saved.profiles.map((profile) => profile.app), ['crm']);
    assert.equal(JSON.stringify(saved).includes('session'), false);
    assert.equal(JSON.stringify(saved).includes('org'), false);

    const analytics = join(root, 'analytics.json');
    writeRunRecord(analytics, [
      { app: 'analytics', results: [
        { name: 'workspace-info', status: 200 }, { name: 'view-list', status: 200 },
      ] },
    ], loadContracts());
    assert.deepEqual(checkRunRecord(analytics, 30).profiles, ['analytics']);

    const staleContract = JSON.parse(readFileSync(file, 'utf8'));
    staleContract.contract.sha256 = '0'.repeat(64);
    const staleContractFile = join(root, 'stale-contract.json');
    writeFileSync(staleContractFile, `${JSON.stringify(staleContract)}\n`);
    assert.throws(() => checkRunRecord(staleContractFile, 30), /different contract/);

    const missingRoute = JSON.parse(readFileSync(file, 'utf8'));
    missingRoute.profiles[0].routes.pop();
    const missingRouteFile = join(root, 'missing-route.json');
    writeFileSync(missingRouteFile, `${JSON.stringify(missingRoute)}\n`);
    assert.throws(() => checkRunRecord(missingRouteFile, 30), /missing or extra routes/);

    const duplicateRoute = JSON.parse(readFileSync(file, 'utf8'));
    duplicateRoute.profiles[0].routes[1].name = 'context';
    const duplicateRouteFile = join(root, 'duplicate-route.json');
    writeFileSync(duplicateRouteFile, `${JSON.stringify(duplicateRoute)}\n`);
    assert.throws(() => checkRunRecord(duplicateRouteFile, 30), /missing, duplicate or reordered routes/);

    const failedRoute = JSON.parse(readFileSync(file, 'utf8'));
    failedRoute.profiles[0].routes[1].status = 500;
    const failedRouteFile = join(root, 'failed-route.json');
    writeFileSync(failedRouteFile, `${JSON.stringify(failedRoute)}\n`);
    assert.throws(() => checkRunRecord(failedRouteFile, 30), /unsuccessful route/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canary accepts only HTTPS hosts belonging to the selected Zoho product', async () => {
  const { canaryBase } = await import('../tools/zoho-canary.mjs');
  assert.equal(canaryBase('crm', 'https://crm.zoho.eu').hostname, 'crm.zoho.eu');
  assert.equal(canaryBase('analytics', 'https://analytics.zohocloud.ca').hostname, 'analytics.zohocloud.ca');
  assert.throws(() => canaryBase('crm', 'http://127.0.0.1:8787'), /HTTPS Zoho host/);
  assert.throws(() => canaryBase('analytics', 'https://analytics.zoho.eu.evil.test'), /HTTPS Zoho host/);
});

// ---------------------------------------------------------------------------------------------
// **A record of the pull may not refuse the pull.**
//
// `setPullBusy(true)` began the lifecycle and threw when `begin()` declined - and `begin()` declines
// from any non-terminal state. «Complete missing», its Workflows twin, and a per-tab pull whose
// runner ends on a non-busy status all take the lock and advance no phase, so the lifecycle was left
// resting in `reading`; from that moment Pull all, the per-tab pull and a click on a row's status dot
// threw *before* their `try`, writing no status and leaving the rejection unhandled. Buttons enabled,
// nothing said, nothing working until the panel was reopened. Three readers found it independently.
test('CRM: an ordinary gesture that advances no phase does not kill every later pull', async () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../apps/crm/pull-lifecycle.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../apps/crm/pull-controller.js', import.meta.url), 'utf8'), context);
  let busy = false;
  const said = [];
  const controller = context.createCrmPullController({
    busy: () => busy, publishBusy: (value) => { busy = value; }, blockZoho: () => {}, zohoReady: () => true,
    hasDirectory: () => true, navigationOpen: () => false, updateWorkspaceButtons: () => {},
    restoreWorkspaceSelection: () => {}, setStatus: (t, k) => said.push(`${k}: ${t}`),
    currentView: () => 'modules', tabLabel: (id) => id, errorText: String,
    runners: () => ({ modules: async () => {}, functions: async () => {} }),
    rebuildActive: async () => {}, renderTabs: () => {}, forbiddenNote: () => '',
    beginOperation: () => ({ root: {}, current: () => true, say: () => {} }),
    plan: () => ({ areas: [], skipped: [], asked: [], askedBefore: {} }),
    answeredRechecks: () => [], takeRechecks: async () => {}, takeListGap: () => '',
    consumePreferencesChanged: () => false, preferencesChangedNote: '',
    statusSnapshot: () => ({ text: '', kind: 'ok' }), statusKind: () => 'ok',
  });

  // The gesture: «Complete missing» takes the lock and releases it, advancing no phase.
  controller.setPullBusy(true);
  controller.setPullBusy(false);
  assert.ok(['completed', 'completed-with-warnings', 'failed', 'cancelled'].includes(controller.pullLifecycle().state),
    `the lock was released and left the lifecycle at «${controller.pullLifecycle().state}», where nothing can begin`);

  // And everything the user can press afterwards still works.
  await assert.doesNotReject(() => controller.pullEverything(), 'Pull all is dead after one ordinary gesture');
  await assert.doesNotReject(() => controller.pullCurrent(), 'the per-tab pull is dead after one ordinary gesture');
  await assert.doesNotReject(() => controller.runPullAction(async () => {}),
    'a single function download is dead after one ordinary gesture');
});

// The same shape in the Analytics twin, where `begin()` does not throw: the pull performs every
// remote read and only then finds `phase('planning')` false, returns `moved`, writes nothing and says
// nothing - the panel looks hung on the last progress line, and it repeats on every press.
test('Analytics: a pull interrupted while writing does not silence the next one', () => {
  // The shipped lock, lifted and executed - not a copy of it written here, which would stay green
  // while the product regressed. `setPullBusy` is a declaration in the panel; the lifecycle and the
  // two globals it touches come with it.
  const context = { Math, Object, Error, String, JSON, updateButtons: () => {} };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../apps/analytics/pull-lifecycle.js', import.meta.url), 'utf8'), context);
  const panel = readFileSync(new URL('../apps/analytics/sidepanel.js', import.meta.url), 'utf8');
  const lock = panel.slice(panel.indexOf('function setPullBusy(on) {'), panel.indexOf('function workspaceChangeRefuse'));
  vm.runInContext('let pullDepth = 0, pullBusy = false; const pullLifecycle = createPullLifecycle();', context);
  vm.runInContext(lock, context);
  const setPullBusy = vm.runInContext('setPullBusy', context);
  const phase = (next) => vm.runInContext('pullLifecycle', context).transition(next);
  const state = () => vm.runInContext('pullLifecycle', context).snapshot().state;

  // A pull interrupted while writing: the workspace moved, so nothing finishes it.
  setPullBusy(true); phase('planning'); phase('writing');
  setPullBusy(false);

  // **Two guards, and this sees one of them.** Measured, both ways: with the release closing what it
  // opened, the reopening branch never fires, so removing it leaves this green - they are each
  // other's net, and no single case can tell them apart. What is asserted is the property that must
  // hold either way, plus the half that keeps the record honest: an abandoned pull must read as
  // cancelled, not as one still writing. Removing the release alone does turn this red.
  assert.ok(['completed', 'completed-with-warnings', 'failed', 'cancelled'].includes(state()),
    `releasing the lock left the lifecycle at «${state()}», which is a pull that never ended`);

  // The next Pull all must be able to plan. The use case consults the phase only after every remote
  // read, so a false here means the panel re-reads the whole workspace, writes nothing and says
  // nothing - it looks hung on the last progress line, and it repeats on every press.
  setPullBusy(true);
  assert.ok(phase('planning'),
    `the next Pull all cannot plan: the lifecycle rests at «${state()}»`);
});
