#!/usr/bin/env node
/* Drive one CRM Pull all through the shipped panel and bridge against invented raw responses.
 * Every request is intercepted; no request can reach Zoho or any other host. */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = path.join(ROOT, 'apps', 'crm');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'crm', 'raw-pull.json'), 'utf8'));
const origin = fixture.origin;
const pageUrl = `${origin}/crm/${fixture.instance}/tab/Contacts`;

function chromePath() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      const full = path.join(dir, name); if (fs.existsSync(full)) return full;
    }
  }
  throw new Error('no Chrome found');
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return port;
}
async function debuggerUrl(port, child) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return (await r.json()).webSocketDebuggerUrl; }
    catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chrome did not open its debugging port${child.exitCode !== null ? ` (exit ${child.exitCode})` : ''}`);
}
// A lost connection rejects everything waiting, and every call has a timeout: see the note on the
// same function in tools/endpointprobe.mjs for the false pass and the hang this closes.
const CALL_TIMEOUT_MS = 15000;
function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl); let seq = 0, gone = null;
  const waiting = new Map(), listeners = new Set();
  const fail = (why) => {
    if (!gone) gone = why;
    for (const [id, pending] of waiting) { waiting.delete(id); clearTimeout(pending.timer); pending.reject(new Error(`${pending.method}: ${gone}`)); }
  };
  socket.addEventListener('close', () => fail('Chrome closed the debugging connection before answering'));
  socket.addEventListener('error', () => fail('the debugging connection to Chrome failed'));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const pending = waiting.get(message.id); waiting.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(`${pending.method}: ${message.error.message}`)) : pending.resolve(message.result); return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    open: () => new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }),
    call(method, params = {}, sessionId, timeoutMs = CALL_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        if (gone) { reject(new Error(`${method}: ${gone}`)); return; }
        const id = ++seq;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: Chrome did not answer within ${timeoutMs / 1000}s`)); }, timeoutMs);
        waiting.set(id, { resolve, reject, method, timer }); socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    on(listener) { listeners.add(listener); }, close() { socket.close(); },
  };
}

const PLATFORM = String.raw`
(function () {
  const listeners = new Set();
  const events = () => ({ addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) });
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const tab = { id: 1, url: location.href, active: true, status: 'complete' };
  const makeArea = () => {
    const values = new Map();
    return {
      async get(keys) {
        if (keys == null) return Object.fromEntries(values);
        if (typeof keys === 'string') return { [keys]: clone(values.get(keys)) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, clone(values.get(k))]));
        const out = { ...keys }; for (const key of Object.keys(keys)) if (values.has(key)) out[key] = clone(values.get(key)); return out;
      },
      async set(items) { for (const [key, value] of Object.entries(items || {})) values.set(key, clone(value)); },
      async remove(keys) { for (const key of [].concat(keys || [])) values.delete(key); },
    };
  };
  function dispatchTab(message) {
    return new Promise((resolve, reject) => {
      let answered = false, pending = false;
      const send = (value) => { if (!answered) { answered = true; resolve(clone(value)); } };
      for (const listener of [...listeners]) { const result = listener(clone(message), { tab, frameId: 0 }, send); if (result === true) pending = true; }
      if (!pending && !answered) reject(new Error('Could not establish connection. Receiving end does not exist.'));
      setTimeout(() => { if (!answered) reject(new Error('The message port closed before a response was received.')); }, 15000);
    });
  }
  const asyncOrCallback = (value, callback) => { if (callback) { queueMicrotask(() => callback(clone(value))); return; } return Promise.resolve(clone(value)); };
  window.chrome = {
    runtime: {
      getManifest: () => ({ name: 'Zoost - workbench for Zoho CRM', version: '1.50.0', host_permissions: ['https://crm.zoho.eu/*'] }),
      getURL: (part) => part,
      sendMessage(message, callback) {
        if (message?.type === 'pullProgress') (window.__crmProgress ||= []).push(clone(message));
        for (const listener of [...listeners]) listener(clone(message), { tab, frameId: 0 }, () => {});
        if (callback) callback(); return Promise.resolve();
      },
      onMessage: events(), onInstalled: { addListener() {} }, lastError: null,
    },
    storage: { local: makeArea(), session: makeArea(), onChanged: { addListener() {}, removeListener() {} } },
    tabs: {
      query(_query, callback) { return asyncOrCallback([tab], callback); },
      get(_id, callback) { return asyncOrCallback(tab, callback); },
      sendMessage(_id, message) { return dispatchTab(message); }, update: async () => tab, create: async () => tab,
      onUpdated: { addListener() {}, removeListener() {} }, onActivated: { addListener() {}, removeListener() {} },
    },
    scripting: { executeScript: async () => [{ frameId: 0, result: { href: location.href, top: true } }] },
    windows: { getAll: async () => [], create: async () => ({ tabs: [] }) }, permissions: { contains: async () => true },
  };
  document.cookie = ${JSON.stringify(`CT_CSRF_TOKEN=${fixture.csrf}; path=/; SameSite=Lax`)};
})();
`;

const SETUP = `
window.__fsshim.clear();
window.__fsshim.load(${JSON.stringify({
  [`crm/${fixture.folder}/.zoost.json`]: JSON.stringify({ org: fixture.org, instance: fixture.instance, base: fixture.origin, sv: 1, lastPull: null }, null, 2),
})});
window.idbHandle.set('rootDir', window.__fsshim.root());
window.idbHandle.set('activeWs', ${JSON.stringify(`org:${fixture.org}`)});
`;

const DRIVER = String.raw`
(function () {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (condition, message, limit = 20000) => { const started = Date.now(); for (;;) { try { if (condition()) return; } catch (_) {} if (Date.now() - started > limit) throw new Error(message); await wait(25); } };
  const same = (actual, expected, subject) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(subject + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); };
  window.addEventListener('load', () => { (async () => {
    const fs = window.__fsshim, base = 'crm/endpoint-probe-990000000001/';
    await until(() => typeof pullEverything === 'function' && Array.isArray(wsList)
      && wsList.some((item) => item.id === 'org:990000000001') && bound && bound.org === '990000000001',
      'the endpoint workspace never opened');
    await pullEverything();
    await until(() => pullBusy === false && !pullActive, 'Pull all never released its lock');
    const progress = window.__crmProgress || [];
    if (!progress.some((m) => m.stage === 'action types' && m.done === 4 && m.total === 4))
      throw new Error('the action-type progress never reached 4/4');
    if (!progress.some((m) => m.stage === 'task details' && m.total > 0 && m.done === m.total))
      throw new Error('the task-detail progress never reached its total');
    const functions = JSON.parse(fs.read(base + 'functions/index.json') || 'null');
    const meta = JSON.parse(fs.read(base + 'functions/standalone/build_Invoice.meta.json') || 'null');
    const compiledMeta = JSON.parse(fs.read(base + 'functions/standalone/sync_Report.meta.json') || 'null');
    const modules = JSON.parse(fs.read(base + 'modules/index.json') || 'null');
    const module = JSON.parse(fs.read(base + 'modules/Contacts.json') || 'null');
    const workflows = JSON.parse(fs.read(base + 'workflows/index.json') || 'null');
    const workflow = JSON.parse(fs.read(base + 'workflows/990000000301.json') || 'null');
    const schedules = JSON.parse(fs.read(base + 'schedules/index.json') || 'null');
    const actions = JSON.parse(fs.read(base + 'actions/index.json') || 'null');
    const connections = JSON.parse(fs.read(base + 'connections/index.json') || 'null');
    const cfg = JSON.parse(fs.read(base + '.zoost.json') || 'null');
    same(functions && functions.map((row) => row.id), ['990000000101', '990000000104'], 'function census');
    same(meta && { id: meta.id, language: meta.language, deployed_on: meta.deployed_on, connection: meta.connections && meta.connections[0] && meta.connections[0].name },
      { id: '990000000101', language: 'deluge', deployed_on: '1787817600000', connection: 'billing_api' }, 'function detail');
    same(fs.read(base + 'functions/standalone/build_Invoice.dg'), 'invoice = Map();\ninvoice.put("Status", "Draft");\nreturn invoice;', 'function source');
    same(compiledMeta && {
      id: compiledMeta.id, language: compiledMeta.language, runtime: compiledMeta.runtime,
      files: compiledMeta.files, directories: compiledMeta.directories, primary_file: compiledMeta.primary_file,
    }, {
      id: '990000000104', language: 'nodejs_22', runtime: 'nodejs_22',
      files: ['src/main.js', 'config.json'], directories: ['src'], primary_file: 'src/main.js',
    }, 'compiled function sidecar');
    same(fs.read(base + 'functions/standalone/sync_Report.files/src/main.js'),
      "export function run() { return 'ok'; }\n", 'compiled function source');
    same(fs.read(base + 'functions/standalone/sync_Report.files/config.json'),
      '{"runtime":"nodejs_22"}\n', 'compiled function config');
    same(modules, [{ api_name: 'Contacts', module_name: 'Contacts', generated_type: 'default', fields: 1, layouts: 1, related_lists: 1 }], 'module census');
    same(module && { fields: module.fields.length, layouts: module.layouts.length, related: module.related_lists[0].api_name, fields_read: module.fields_read },
      { fields: 1, layouts: 1, related: 'Contact_Notes', fields_read: true }, 'module detail');
    same(workflows && workflows.map((row) => row.id), ['990000000301'], 'workflow census');
    same(workflow && workflow.id, '990000000301', 'workflow detail');
    same(schedules && schedules.map((row) => row.function_id), ['990000000101'], 'schedule function');
    same(actions && actions.map((row) => row.kind), ['email_notifications', 'field_updates', 'tasks', 'webhooks'], 'action kinds');
    same(actions && actions.find((row) => row.kind === 'tasks').mappings.map((row) => row.field), ['Subject', 'Priority'], 'task detail');
    same(connections, [{ name: 'billing_api', label: 'Billing API', connector: 'billing', connectorLabel: 'Billing', connected: true, createdBy: 'Example Admin', scopes: ['invoices.READ'], id: '990000000601' }], 'connection catalogue');
    same(Object.keys(cfg.access || {}).sort(), ['actions', 'connections', 'functions', 'modules', 'schedules', 'workflows'], 'area access record');
    if (/failed|error|could not/i.test(document.getElementById('stxt').textContent)) throw new Error('the panel ended on ' + document.getElementById('stxt').textContent);
    window.__crmEndpointProbeResult = { files: fs.dump().filter((name) => name.startsWith(base)).length };
    document.title = 'CRM ENDPOINT PULL OK';
  })().catch((error) => { window.__crmEndpointProbeResult = { error: String(error && (error.stack || error.message) || error) }; document.title = 'CRM ENDPOINT PULL ERROR'; }); });
})();
`;

function panelHtml() {
  let html = fs.readFileSync(path.join(APP, 'sidepanel.html'), 'utf8');
  const first = '<script src="sample-org.js"></script>', idb = '<script src="idb.js"></script>';
  if (!html.includes(first) || !html.includes(idb)) throw new Error('sidepanel script order changed');
  html = html.replace(first, `<script>window.crmZgid=${JSON.stringify(fixture.org)};</script><input id="dreZuId" value="${fixture.zuid}">\n<script src="/__probe/platform.js"></script>\n${first}`);
  return html.replace(idb, `${idb}\n<script src="/__probe/fsshim.js"></script>\n<script src="/__probe/setup.js"></script>\n<script src="content-bridge.js"></script>\n<script src="/__probe/driver.js"></script>`);
}
function headers(request) { return Object.fromEntries(Object.entries(request.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])); }
function response(status, type, body) { return { responseCode: status, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(body).toString('base64') }; }
const json = (body, status = 200) => response(status, 'application/json; charset=utf-8', JSON.stringify(body));
const expected = new Map([
  ['functions:deluge', 1], ['functions:java', 1], ['functions:java17', 1], ['functions:nodejs', 1], ['functions:nodejs_22', 1], ['functions:python_3_12', 1], ['functions:all', 1],
  ['function-pref', 1], ['function-bulk', 1], ['function-detail:deluge', 1], ['function-detail:compiled', 1],
  ['function-file-list', 1], ['function-file:src/main.js', 1], ['function-file:config.json', 1],
  ['modules', 1], ['fields', 1], ['layouts', 1], ['related-lists', 1],
  ['workflows', 1], ['workflow-detail', 1], ['schedules', 1], ['actions:email_notifications', 1], ['actions:field_updates', 1], ['actions:tasks', 1], ['actions:task-detail', 1], ['actions:webhooks', 1],
  ['connections:first', 1], ['constants', 1], ['deluge-i18n-base', 1], ['deluge-validate', 1], ['deluge-i18n-token', 1], ['connections:retry', 1],
]);
const used = new Map(), failures = [];
const scripts = new Set(fs.readdirSync(APP).filter((name) => /[.](?:js|css)$/.test(name)));
let connectionCalls = 0, delugeStage = 0;
function mark(key) { if (!expected.has(key)) throw new Error(`unexpected endpoint ${key}`); const n = (used.get(key) || 0) + 1; used.set(key, n); if (n > expected.get(key)) throw new Error(`${key} called ${n} times`); }
function requireGet(request, url, csrf = 'crmcsrfparam') {
  const h = headers(request);
  if (request.method !== 'GET') throw new Error(`${url.pathname} used ${request.method}`);
  if (h['x-requested-with'] !== 'XMLHttpRequest' || !/application\/json/i.test(h.accept || '')) throw new Error(`${url.pathname} omitted JSON request headers`);
  if (h['x-zcsrf-token'] !== `${csrf}=${fixture.csrf}`) throw new Error(`${url.pathname} carried the wrong CSRF token`);
  if (h['x-crm-org'] !== fixture.org) throw new Error(`${url.pathname} carried the wrong org`);
}
function noCsrf(request, url) { const h = headers(request); if (request.method !== 'GET') throw new Error(`${url.pathname} used ${request.method}`); if (h['x-zcsrf-token']) throw new Error(`${url.pathname} unexpectedly carried CSRF`); }
function onlyQuery(url, expectedQuery) { const got = [...url.searchParams.entries()].sort(); const want = Object.entries(expectedQuery).map(([k, v]) => [k, String(v)]).sort(); if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${url.pathname} query was ${url.search}`); }

function apiReply(request) {
  const url = new URL(request.url); if (url.origin !== origin) throw new Error(`request left the fake Zoho origin: ${url.origin}`);
  const p = url.pathname; let body;
    if (p === '/crm/v2/settings/functions') {
      requireGet(request, url); const lang = url.searchParams.get('language'); mark(`functions:${lang}`);
      onlyQuery(url, { type: 'org', start: 1, limit: 50, language: lang });
      body = { functions: lang === 'deluge' ? [fixture.functions.list]
        : lang === 'nodejs_22' ? [fixture.functions.compiledList]
        : lang === 'all' ? [fixture.functions.list, fixture.functions.compiledList] : [] };
  } else if (p === '/crm/v8/settings/modules/Functions__s/actions/view_preference_configurations') {
    requireGet(request, url); mark('function-pref'); body = fixture.functions.viewPreference;
  } else if (p === '/crm/v8/Functions__s/bulk') {
    const h = headers(request); if (request.method !== 'POST' || !/^multipart\/form-data/i.test(h['content-type'] || '')) throw new Error('function bulk contract changed');
    if (h['x-zcsrf-token'] !== `crmcsrfparam=${fixture.csrf}`) throw new Error('function bulk carried wrong CSRF'); mark('function-bulk'); body = fixture.functions.bulk;
  } else if (p === `/crm/v2/settings/functions/${fixture.functions.list.id}`) {
    requireGet(request, url); mark('function-detail:deluge'); onlyQuery(url, { category: 'standalone', language: 'deluge', source: 'crm' }); body = { functions: [fixture.functions.detail] };
  } else if (p === `/crm/v2/settings/functions/${fixture.functions.compiledList.id}`) {
    requireGet(request, url); mark('function-detail:compiled'); onlyQuery(url, { category: 'standalone', language: 'nodejs', source: 'crm' }); body = { functions: [fixture.functions.compiledDetail] };
  } else if (p === `/crm/${fixture.org}/zce/function/getFileList`) {
    requireGet(request, url); mark('function-file-list');
    onlyQuery(url, { functionName: 'sync_Report', repositoryName: 'standalone', isDeployed: 'false' });
    body = { data: { functionFiles: fixture.functions.compiledFiles } };
  } else if (p === `/crm/${fixture.org}/zce/function/code`) {
    requireGet(request, url);
    const fileName = url.searchParams.get('fileName');
    const key = `function-file:${fileName}`;
    mark(key);
    onlyQuery(url, { functionName: 'sync_Report', repositoryName: 'standalone', isDeployed: 'false', fileName });
    if (!Object.prototype.hasOwnProperty.call(fixture.functions.compiledFileContents, fileName)) throw new Error(`no synthetic source for ${fileName}`);
    return response(200, 'text/plain; charset=utf-8', fixture.functions.compiledFileContents[fileName]);
  } else if (p === '/crm/v2/settings/modules') { requireGet(request, url); mark('modules'); onlyQuery(url, {}); body = fixture.modules.list;
  } else if (p === '/crm/v2/settings/fields') { requireGet(request, url); mark('fields'); onlyQuery(url, { module: 'Contacts', type: 'all' }); body = fixture.modules.fields;
  } else if (p === '/crm/v2.2/settings/layouts') { requireGet(request, url); mark('layouts'); onlyQuery(url, { module: 'Contacts', fields: 'id,status' }); body = fixture.modules.layouts;
  } else if (p === '/crm/v2/settings/related_lists') { requireGet(request, url); mark('related-lists'); onlyQuery(url, { module: 'Contacts' }); body = fixture.modules.relatedLists;
  } else if (p === '/crm/v8/settings/automation/workflow_rules') { requireGet(request, url); mark('workflows'); onlyQuery(url, { page: 1, per_page: 200 }); body = fixture.workflows.list;
  } else if (p === `/crm/v8/settings/automation/workflow_rules/${fixture.workflows.list.workflow_rules[0].id}`) { requireGet(request, url); mark('workflow-detail'); onlyQuery(url, {}); body = fixture.workflows.detail;
  } else if (p === '/crm/v9/settings/automation/schedules' && url.searchParams.get('per_page') === '200') { requireGet(request, url); mark('schedules'); onlyQuery(url, { page: 1, per_page: 200 }); body = fixture.schedules;
  } else if (p === '/crm/v9/settings/automation/schedules' && url.searchParams.get('per_page') === '1') { requireGet(request, url); mark('schedule-primer'); onlyQuery(url, { page: 1, per_page: 1 }); body = { schedules: [], info: { more_records: false } };
  } else if (/^\/crm\/v[89]\/settings\/automation\/(email_notifications|field_updates|tasks|webhooks)$/.test(p)) {
    requireGet(request, url); const kind = p.split('/').at(-1); mark(`actions:${kind}`);
    if (url.searchParams.get('page') !== '1' || url.searchParams.get('per_page') !== '200' || !url.searchParams.get('include_inner_details')) throw new Error(`${kind} query changed`);
    body = fixture.actions[kind];
  } else if (p === `/crm/v8/settings/automation/tasks/${fixture.actions.tasks.tasks[0].id}`) {
    requireGet(request, url); mark('actions:task-detail'); if (!url.searchParams.get('include_inner_details')) throw new Error('task detail omitted inner details'); body = fixture.actions.taskDetail;
  } else if (p === `/crm/${fixture.instance}/ConstantsInitial.do`) {
    requireGet(request, url); mark('constants'); body = { csrfToken: fixture.csrf };
  } else if (p === '/deluge/api/ui/v1/getI18n' && url.searchParams.has('baseName')) {
    noCsrf(request, url); onlyQuery(url, { baseName: 'EditorMessageResources' }); if (delugeStage !== 0) throw new Error('Deluge base i18n was out of order'); delugeStage = 1; mark('deluge-i18n-base'); body = fixture.delugeI18n;
  } else if (p === '/deluge/delugeauth/validateUser') {
    noCsrf(request, url); onlyQuery(url, { zohoServiceName: 'ZohoCRM', sharedBy: fixture.org, hideUserAccess: 'false' }); if (delugeStage !== 1) throw new Error('Deluge validateUser was out of order'); delugeStage = 2; mark('deluge-validate'); return response(200, 'text/html; charset=utf-8', '<div>authorised</div>');
  } else if (p === '/deluge/api/ui/v1/getI18n') {
    const h = headers(request);
    if (request.method !== 'GET' || h['x-zcsrf-token'] !== `drepn=${fixture.csrf}`
        || h['x-requested-with'] || (h.accept && h.accept !== '*/*')) throw new Error(`${url.pathname} token bootstrap headers changed`);
    onlyQuery(url, {}); if (delugeStage !== 2) throw new Error('Deluge token i18n was out of order'); delugeStage = 3; mark('deluge-i18n-token'); body = fixture.delugeI18n;
  } else if (p === `/deluge/api/ui/v1/${fixture.org}/services/ZohoCRM/connections`) {
    requireGet(request, url, 'drepn'); onlyQuery(url, { zuid: fixture.zuid, flowNeeded: 'true', extentionPlatform: 'false' }); connectionCalls++;
    if (connectionCalls === 1) { mark('connections:first'); return json({ code: 'INVALID_CSRF_TOKEN', errorMessage: 'INVALID_CSRF_TOKEN', status: 'error' }, 400); }
    mark('connections:retry'); if (delugeStage !== 3) return json({ code: 'INVALID_CSRF_TOKEN', errorMessage: 'INVALID_CSRF_TOKEN', status: 'error' }, 400); body = fixture.connections;
  } else throw new Error(`unexpected Zoho endpoint ${request.method} ${p}${url.search}`);
  return json(body);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zoost-crm-endpoint-probe-')), port = await freePort();
  const args = ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
  const child = spawn(chromePath(), args, { stdio: ['ignore', 'ignore', 'pipe'] }); let client, success = '', stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });
  try {
    client = cdp(await debuggerUrl(port, child)); await client.open();
    const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params = {}) => client.call(method, params, sessionId), logged = [];
    client.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.exceptionThrown') logged.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'uncaught exception');
      if (message.method !== 'Fetch.requestPaused') return;
      const request = message.params.request;
      (async () => {
        let answer;
        try {
          const url = new URL(request.url);
          if (url.origin !== origin) throw new Error(`request escaped interception: ${request.method} ${request.url}`);
          if (message.params.resourceType === 'Document' && url.pathname === `/crm/${fixture.instance}/tab/Contacts`) answer = response(200, 'text/html; charset=utf-8', panelHtml());
          else if (url.pathname === '/__probe/platform.js') answer = response(200, 'text/javascript; charset=utf-8', PLATFORM);
          else if (url.pathname === '/__probe/fsshim.js') answer = response(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'tools', 'fsshim.js')));
          else if (url.pathname === '/__probe/setup.js') answer = response(200, 'text/javascript; charset=utf-8', SETUP);
          else if (url.pathname === '/__probe/driver.js') answer = response(200, 'text/javascript; charset=utf-8', DRIVER);
          else if (url.pathname === '/favicon.ico') answer = response(204, 'image/x-icon', '');
          else if (scripts.has(url.pathname.split('/').at(-1))) { const name = url.pathname.split('/').at(-1); answer = response(200, name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', fs.readFileSync(path.join(APP, name))); }
          else answer = apiReply(request);
        } catch (error) { failures.push(String(error?.message || error)); answer = json({ status: 'failure', message: failures.at(-1) }, 500); }
        await call('Fetch.fulfillRequest', { requestId: message.params.requestId, ...answer });
      })().catch((error) => failures.push(String(error?.stack || error)));
    });
    await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable'); await call('Network.setCacheDisabled', { cacheDisabled: true }); await call('Network.clearBrowserCache');
    await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); await call('Page.navigate', { url: pageUrl });
    const deadline = Date.now() + 40000; let final;
    while (Date.now() < deadline) { final = (await call('Runtime.evaluate', { expression: '({ title: document.title, result: window.__crmEndpointProbeResult || null })', returnByValue: true })).result.value; if (String(final.title).startsWith('CRM ENDPOINT PULL ')) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    if (failures.length) throw new Error(failures.join(' | ')); if (logged.length) throw new Error(`page exception: ${logged.join(' | ')}`);
    if (!final || final.title !== 'CRM ENDPOINT PULL OK') throw new Error(final?.result?.error || `timed out with title ${JSON.stringify(final?.title)}`);
    const wrong = [...expected].filter(([key, count]) => used.get(key) !== count).map(([key, count]) => `${key}: ${used.get(key) || 0}/${count}`);
    if (wrong.length) throw new Error(`endpoint request count mismatch: ${wrong.join(', ')}`);
    const count = [...used.values()].reduce((sum, n) => sum + n, 0);
    success = `CRM endpoint pull: six areas, ${count} raw requests across ${used.size} routes -> ${final.result.files} local files; cache disabled, no network\n`;
    await client.call('Target.closeTarget', { targetId });
  } finally {
    if (client) { try { await client.call('Browser.close', {}, undefined, 3000); } catch (_) {} client.close(); }
    const waitExit = (limit) => (child.exitCode !== null || child.signalCode !== null) ? Promise.resolve(true) : new Promise((resolve) => { const timer = setTimeout(() => resolve(false), limit); child.once('exit', () => { clearTimeout(timer); resolve(true); }); });
    if (!(await waitExit(5000))) { child.kill('SIGKILL'); await waitExit(3000); }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
    catch (cleanupError) { if (success) throw cleanupError; process.stderr.write(`(also: could not remove the probe profile - ${cleanupError.message})\n`); }
  }
  process.stdout.write(success);
}
main().catch((error) => { process.stderr.write(`CRM endpoint pull failed: ${error.message}\n`); process.exitCode = 1; });
