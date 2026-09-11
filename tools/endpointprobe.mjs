#!/usr/bin/env node
/*
 * Drive one Analytics pull through the shipped side panel and the shipped content bridge.
 *
 * The only substitutes are boundaries a test browser cannot own: Chrome's messaging/storage/File
 * System Access APIs, and the Zoho server. The server answers with a small invented fixture whose
 * wire shapes were derived from a real Pull all HAR. It never returns the normalized objects the
 * panel consumes: content-bridge.js must issue the right HTTP requests and parse every response.
 *
 * Every request is intercepted before the network. An unknown URL, a wrong method/header/body, or
 * an unexpected call count fails the run. After the complete pull, raw HTTP failures prove that a
 * failed stage preserves the prior mirror, item failures stay explicit, and Retry repairs them.
 * The Chrome profile is new and its cache is disabled, so no response can be inherited from a
 * previous run.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = path.join(ROOT, 'apps', 'analytics');
const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'analytics', 'raw-pull.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const origin = fixture.origin;
const pageUrl = `${origin}/workspace/${fixture.workspace}`;

function chromePath() {
  const named = process.env.CHROME;
  if (named && fs.existsSync(named)) return named;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  for (const candidate of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) return full;
    }
  }
  throw new Error('no Chrome found');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function debuggerUrl(port, child) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chrome did not open its debugging port${child.exitCode !== null ? ` (exit ${child.exitCode})` : ''}`);
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let seq = 0;
  const waiting = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject, method } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    async open() {
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
    },
    call(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    on(listener) { listeners.add(listener); },
    close() { socket.close(); },
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
        const out = { ...keys }; for (const key of Object.keys(keys)) if (values.has(key)) out[key] = clone(values.get(key));
        return out;
      },
      async set(items) { for (const [key, value] of Object.entries(items || {})) values.set(key, clone(value)); },
      async remove(keys) { for (const key of [].concat(keys || [])) values.delete(key); },
    };
  };
  function dispatchTab(message) {
    return new Promise((resolve, reject) => {
      let answered = false, pending = false;
      const send = (value) => { if (!answered) { answered = true; resolve(clone(value)); } };
      for (const listener of [...listeners]) {
        const result = listener(clone(message), { tab, frameId: 0 }, send);
        if (result === true) pending = true;
      }
      if (!pending && !answered) reject(new Error('Could not establish connection. Receiving end does not exist.'));
      setTimeout(() => { if (!answered) reject(new Error('The message port closed before a response was received.')); }, 10000);
    });
  }
  function emitRuntime(message, callback) {
    for (const listener of [...listeners]) listener(clone(message), { tab, frameId: 0 }, () => {});
    if (callback) callback();
    return Promise.resolve();
  }
  const asyncOrCallback = (value, callback) => {
    if (callback) { queueMicrotask(() => callback(clone(value))); return; }
    return Promise.resolve(clone(value));
  };
  window.chrome = {
    runtime: {
      getManifest: () => ({
        name: 'Zoost - workbench for Zoho Analytics', version: '1.32.0',
        host_permissions: ['https://analytics.zoho.eu/*']
      }),
      getURL: (part) => part,
      sendMessage: emitRuntime,
      onMessage: events(), onInstalled: { addListener() {} }, lastError: null,
    },
    storage: { local: makeArea(), session: makeArea(), onChanged: { addListener() {}, removeListener() {} } },
    tabs: {
      query(_query, callback) { return asyncOrCallback([tab], callback); },
      get(_id, callback) { return asyncOrCallback(tab, callback); },
      sendMessage(_id, message) { return dispatchTab(message); },
      update: async () => tab, create: async () => tab,
      onUpdated: { addListener() {}, removeListener() {} },
      onActivated: { addListener() {}, removeListener() {} },
    },
    scripting: {
      executeScript: async () => [{ frameId: 0, result: { href: location.href, top: true } }],
    },
    windows: { getAll: async () => [], create: async () => ({ tabs: [] }) },
    permissions: { contains: async () => true },
  };
  document.cookie = 'CSRF_TOKEN=probe-token; path=/; SameSite=Lax';
})();
`;

const SETUP = `
window.__fsshim.clear();
window.__fsshim.load(${JSON.stringify({
  [`analytics/${fixture.folder}/.zoost.json`]: JSON.stringify({
    workspace: fixture.workspace,
    name: fixture.name,
    origin: fixture.origin,
    sv: 1,
    lastPull: null,
  }, null, 2),
})});
window.idbHandle.set('rootDir', window.__fsshim.root());
window.idbHandle.set('activeWsAnalytics', ${JSON.stringify(fixture.workspace)});
`;

const DRIVER = String.raw`
(function () {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (condition, message, limit = 12000) => {
    const started = Date.now();
    for (;;) {
      try { if (condition()) return; } catch (_) {}
      if (Date.now() - started > limit) throw new Error(message);
      await wait(25);
    }
  };
  const same = (actual, expected, subject) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(subject + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
    }
  };
  const snapshot = (fs, prefix) => Object.fromEntries(fs.dump()
    .filter((name) => name.startsWith(prefix))
    .map((name) => [name, fs.read(name)]));
  window.addEventListener('load', () => {
    (async () => {
      const fs = window.__fsshim;
      const base = 'analytics/endpoint-probe/';
      await until(() => typeof pullAll === 'function' && Array.isArray(wsList)
        && wsList.some((item) => String(item.id) === '99000999')
        && bound && String(bound.workspace) === '99000999', 'the endpoint workspace never opened');

      await pullAll();
      await until(() => JSON.parse(fs.read(base + '.pull-state.json') || '{}').state === 'complete',
                  'Pull all never completed');

      const viewsFile = JSON.parse(fs.read(base + 'views.json') || '{}');
      const schemaFile = JSON.parse(fs.read(base + 'schema.json') || '{}');
      const sqlIndex = JSON.parse(fs.read(base + 'sql/index.json') || '{}');
      const lineage = JSON.parse(fs.read(base + 'lineage.json') || '{}');
      const cfg = JSON.parse(fs.read(base + '.zoost.json') || '{}');
      const byId = new Map((viewsFile.views || []).map((view) => [view.id, view]));

      same((viewsFile.views || []).map((view) => view.id), ['99001001', '99001002', '99001003'], 'view census');
      same((viewsFile.folders || []).map((folder) => folder.name), ['Data', 'Queries', 'Reports'], 'folder census');
      same(byId.get('99001002') && {
        name: byId.get('99001002').name,
        type: byId.get('99001002').type,
        parent: byId.get('99001002').parent,
        folderName: byId.get('99001002').folderName,
        tags: byId.get('99001002').tags,
      }, { name: 'Revenue Query', type: 'QueryTable', parent: '99001001', folderName: 'Queries', tags: ['finance'] },
      'normalized query view');

      same(Object.keys(schemaFile.tables || {}), ['99001001', '99001002'], 'ER table ids');
      same(schemaFile.tables['99001001'].columns, [
        { name: 'Order_Id', type: 'BIGINT', colid: 'col-order-id', description: 'Stable order id' },
        { name: 'Amount', type: 'DECIMAL', colid: 'col-amount', description: 'Net amount' },
      ], 'ER columns');
      same(schemaFile.relations, [{
        source: '99001001', target: '99001002', sourceName: 'Orders', targetName: 'Revenue Query',
        sourceColumns: ['Order_Id'], targetColumns: ['Order_Id'],
        relation: '(Orders.Order_Id)=(Revenue Query.Order_Id)',
      }], 'ER relation');

      const query = sqlIndex['99001002'];
      same(query && query.parents, ['99001001'], 'SQL parent ids');
      same(query && query.sources && query.sources['99001001'], {
        name: 'Orders', kind: 'Table',
        columns: [{ name: 'Order_Id', type: 'BIGINT' }, { name: 'Amount', type: 'DECIMAL' }],
      }, 'SQL column lineage');
      same(fs.read(base + query.stem + '.sql'), undefined, 'SQL is confined to the sql directory');
      same(fs.read(base + 'sql/' + query.stem + '.sql'),
        'SELECT o."Order_Id", o."Amount" AS "Revenue"\nFROM "Orders" o', 'SQL source');

      same(lineage.deps['99001001'].children, [{ id: '99001002', level: 1 }], 'table children');
      same(lineage.deps['99001002'], {
        id: '99001002', parents: [{ id: '99001001', level: 1 }],
        children: [{ id: '99001003', level: 0 }], dashboards: ['99001003'],
      }, 'query lineage');
      same(cfg.counts, { views: 3, folders: 3, tables: 2, relations: 1, sql: 1 }, 'workspace counts');
      if (/failed|interrupted|could not/i.test(document.getElementById('statustext').textContent)) {
        throw new Error('the panel ended on ' + document.getElementById('statustext').textContent);
      }

      // A whole-stage failure happens before writeToDisk. The previous snapshot must therefore
      // survive byte for byte, including its complete marker and workspace metadata.
      const beforeStageFailure = snapshot(fs, base);
      await pullAll();
      same(snapshot(fs, base), beforeStageFailure, 'stage failure changed the previous mirror');
      if (!/Pull failed: 503/.test(document.getElementById('statustext').textContent)) {
        throw new Error('the stage failure was not explicit: ' + document.getElementById('statustext').textContent);
      }

      // Per-item reads are different: one SQL response and one lineage response may fail while the
      // rest of the workspace is still a coherent snapshot. The gaps must be durable and explicit,
      // and yesterday's SQL file must not be deleted merely because today's request was refused.
      const previousSql = fs.read(base + 'sql/' + query.stem + '.sql');
      await pullAll();
      const failedState = JSON.parse(fs.read(base + '.pull-state.json') || '{}');
      const failedLineage = JSON.parse(fs.read(base + 'lineage.json') || '{}');
      const failedIndex = JSON.parse(fs.read(base + 'sql/index.json') || '{}');
      same(failedState.state, 'complete', 'per-item failures left an incomplete mirror');
      same(failedLineage.failed, [
        { id: '99001002', error: '429 on /clientapi/sqltable/workspaces/99000999/views/99001002/editsql - rate limit', stage: 'sql' },
        { id: '99001003', error: '403 on /clientapi/dependencyview/workspace/99000999/view/99001003 - access denied', stage: 'lineage' },
      ], 'durable per-item failures');
      same(failedIndex, {}, 'failed SQL was presented as current');
      same(fs.read(base + 'sql/' + query.stem + '.sql'), previousSql, 'failed SQL read deleted the previous capture');
      if (!/2 could not be read/.test(document.getElementById('statustext').textContent)) {
        throw new Error('the completed partial pull hid its gaps: ' + document.getElementById('statustext').textContent);
      }

      // Retry is a user control over the declared gaps. Both endpoints answer normally on their
      // next call; the failure ledger must clear and the SQL/index pair must become current again.
      await retryFailed();
      const recoveredLineage = JSON.parse(fs.read(base + 'lineage.json') || '{}');
      const recoveredIndex = JSON.parse(fs.read(base + 'sql/index.json') || '{}');
      same(recoveredLineage.failed, [], 'retry left recovered entries marked as failed');
      same(recoveredLineage.deps['99001003'], {
        id: '99001003', parents: [{ id: '99001002', level: 0 }], children: [], dashboards: [],
      }, 'retry did not restore lineage');
      same(recoveredIndex['99001002'] && recoveredIndex['99001002'].parents, ['99001001'], 'retry did not restore SQL');
      same(fs.read(base + 'sql/' + query.stem + '.sql'), previousSql, 'retry restored the wrong SQL source');
      if (!/All previously failed items are now in/.test(document.getElementById('statustext').textContent)) {
        throw new Error('retry did not report recovery: ' + document.getElementById('statustext').textContent);
      }

      window.__endpointProbeResult = { files: fs.dump().filter((name) => name.startsWith(base)).length };
      document.title = 'ENDPOINT PULL OK';
    })().catch((error) => {
      window.__endpointProbeResult = { error: String(error && (error.stack || error.message) || error) };
      document.title = 'ENDPOINT PULL ERROR';
    });
  });
})();
`;

function panelHtml() {
  let html = fs.readFileSync(path.join(APP, 'sidepanel.html'), 'utf8');
  const first = '<script src="sample-org.js"></script>';
  const idb = '<script src="idb.js"></script>';
  if (!html.includes(first) || !html.includes(idb)) throw new Error('sidepanel script order changed');
  html = html.replace(first, '<script src="/__probe/platform.js"></script>\n' + first);
  html = html.replace(idb, idb
    + '\n<script src="/__probe/fsshim.js"></script>'
    + '\n<script src="/__probe/setup.js"></script>'
    + '\n<script src="content-bridge.js"></script>'
    + '\n<script src="/__probe/driver.js"></script>');
  return html;
}

function headers(request) {
  return Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function response(status, contentType, body) {
  return {
    responseCode: status,
    responseHeaders: [
      { name: 'Content-Type', value: contentType },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    body: Buffer.from(body).toString('base64'),
  };
}

const expected = new Map([
  ['workspace-info', 3], ['view-list', 3], ['erd', 3], ['sql:99001002', 3],
  ['dependency:99001001', 2], ['dependency:99001002', 3], ['dependency:99001003', 3],
]);
const used = new Map();
const failures = [];
const scripts = new Set(fs.readdirSync(APP).filter((name) => /[.](?:js|css)$/.test(name)));

function mark(key) {
  if (!expected.has(key)) throw new Error(`unexpected endpoint ${key}`);
  used.set(key, (used.get(key) || 0) + 1);
  if (used.get(key) > expected.get(key)) {
    throw new Error(`endpoint ${key} was requested ${used.get(key)} times, expected ${expected.get(key)}`);
  }
  return used.get(key);
}

function apiReply(request) {
  const url = new URL(request.url);
  if (url.origin !== origin) throw new Error(`request left the fake Zoho origin: ${url.origin}`);
  const h = headers(request);
  const get = () => {
    if (request.method !== 'GET') throw new Error(`${url.pathname} used ${request.method}, expected GET`);
    if (h['x-requested-with'] !== 'XMLHttpRequest') throw new Error(`${url.pathname} omitted X-Requested-With`);
    if (!/application\/json/i.test(h.accept || '')) throw new Error(`${url.pathname} did not ask for JSON`);
  };
  let body;
  if (url.pathname === '/reportsapi/DATASHEETREQUESTS') {
    get(); mark('workspace-info');
    if (url.searchParams.get('DBID') !== fixture.workspace
        || url.searchParams.get('ISCREATEVIEW') !== 'false'
        || url.searchParams.get('ISSTANDALONEEDIT') !== 'false') throw new Error('workspace-info query is wrong');
    body = { status: 'success', data: { datasheetJson: { DBNAME: fixture.name } } };
  } else if (url.pathname === `/reportsapi/db/${fixture.workspace}/VIEWLIST`) {
    get(); mark('view-list');
    if (url.searchParams.get('ZOHO_FOLDERLIST') !== 'true' || !/^\d+$/.test(url.searchParams.get('NOCACHE') || '')) {
      throw new Error('VIEWLIST query is wrong');
    }
    body = fixture.viewList;
  } else if (url.pathname === '/ZDBCreateERD.ma') {
    const call = mark('erd');
    if (request.method !== 'POST') throw new Error(`ERD used ${request.method}, expected POST`);
    if (h['x-requested-with'] !== 'XMLHttpRequest') throw new Error('ERD omitted X-Requested-With');
    if (h['x-zcsrf-token'] !== 'ZDB_CSRF_TOKEN=probe-token') throw new Error('ERD carried the wrong CSRF token');
    if (!/^application\/x-www-form-urlencoded/i.test(h['content-type'] || '')) throw new Error('ERD used the wrong content type');
    if (url.searchParams.get('ZDBACTION') !== 'CREATEDATABASEERD'
        || url.searchParams.get('SUBREQUEST') !== 'XMLHTTP'
        || url.searchParams.get('_ZVER_') !== '101') throw new Error('ERD query is wrong');
    const form = new URLSearchParams(request.postData || '');
    if (form.get('DBID') !== fixture.workspace || form.get('ISERDGNEWFLOW') !== 'true') throw new Error('ERD body is wrong');
    if (call === 2) {
      return response(503, 'application/json; charset=utf-8', JSON.stringify({ status: 'failure', summary: 'service unavailable' }));
    }
    body = fixture.erd;
  } else {
    let match = url.pathname.match(new RegExp(`^/clientapi/sqltable/workspaces/${fixture.workspace}/views/(\\d+)/editsql$`));
    if (match) {
      get();
      const call = mark(`sql:${match[1]}`);
      if (call === 2) {
        return response(429, 'application/json; charset=utf-8', JSON.stringify({ status: 'failure', summary: 'rate limit' }));
      }
      body = fixture.sql[match[1]];
      if (!body) throw new Error(`no synthetic SQL response for ${match[1]}`);
    } else {
      match = url.pathname.match(new RegExp(`^/clientapi/dependencyview/workspace/${fixture.workspace}/view/(\\d+)$`));
      if (!match) throw new Error(`unexpected Zoho endpoint ${request.method} ${url.pathname}`);
      get();
      const call = mark(`dependency:${match[1]}`);
      if (match[1] === '99001003' && call === 2) {
        return response(403, 'application/json; charset=utf-8', JSON.stringify({ status: 'failure', summary: 'access denied' }));
      }
      body = fixture.dependencies[match[1]];
      if (!body) throw new Error(`no synthetic dependency response for ${match[1]}`);
    }
  }
  return response(200, 'application/json; charset=utf-8', JSON.stringify(body));
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zoost-endpoint-probe-'));
  const port = await freePort();
  const args = [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
  const child = spawn(chromePath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
  let client;
  let success = '';
  try {
    client = cdp(await debuggerUrl(port, child));
    await client.open();
    const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params = {}) => client.call(method, params, sessionId);
    const logged = [];
    client.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params.exceptionDetails || {};
        logged.push(d.exception?.description || d.text || 'uncaught exception');
      }
      if (message.method !== 'Fetch.requestPaused') return;
      const request = message.params.request;
      (async () => {
        let answer;
        try {
          const url = new URL(request.url);
          if (url.origin !== origin) throw new Error(`request escaped interception: ${request.method} ${request.url}`);
          if (message.params.resourceType === 'Document' && url.pathname === `/workspace/${fixture.workspace}`) {
            answer = response(200, 'text/html; charset=utf-8', panelHtml());
          } else if (url.pathname === '/__probe/platform.js') {
            answer = response(200, 'text/javascript; charset=utf-8', PLATFORM);
          } else if (url.pathname === '/__probe/fsshim.js') {
            answer = response(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'tools', 'fsshim.js')));
          } else if (url.pathname === '/__probe/setup.js') {
            answer = response(200, 'text/javascript; charset=utf-8', SETUP);
          } else if (url.pathname === '/__probe/driver.js') {
            answer = response(200, 'text/javascript; charset=utf-8', DRIVER);
          } else if (url.pathname === '/favicon.ico' && message.params.resourceType === 'Other') {
            // Chrome asks for this on its own; it is not a request made by either shipped script.
            answer = response(204, 'image/x-icon', '');
          } else if (/^\/workspace\/[A-Za-z0-9._-]+$/.test(url.pathname)
                     && scripts.has(url.pathname.split('/').at(-1))) {
            // The intercepted document deliberately keeps its real workspace URL. Relative assets
            // therefore resolve below `/workspace/`; serve their basename from the extension.
            const name = url.pathname.split('/').at(-1);
            answer = response(200, name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
                              fs.readFileSync(path.join(APP, name)));
          } else {
            answer = apiReply(request);
          }
        } catch (error) {
          failures.push(String(error && error.message || error));
          answer = response(500, 'application/json', JSON.stringify({ status: 'failure', summary: failures.at(-1) }));
        }
        await call('Fetch.fulfillRequest', { requestId: message.params.requestId, ...answer });
      })().catch((error) => failures.push(String(error && error.stack || error)));
    });

    await call('Runtime.enable');
    await call('Page.enable');
    await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    await call('Network.clearBrowserCache');
    await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await call('Page.navigate', { url: pageUrl });

    const deadline = Date.now() + 30000;
    let title = '';
    while (Date.now() < deadline) {
      const value = await call('Runtime.evaluate', {
        expression: '({ title: document.title, result: window.__endpointProbeResult || null })',
        returnByValue: true,
      });
      title = value.result.value?.title || '';
      if (title.startsWith('ENDPOINT PULL ')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const final = (await call('Runtime.evaluate', {
      expression: '({ title: document.title, result: window.__endpointProbeResult || null })',
      returnByValue: true,
    })).result.value;
    if (failures.length) throw new Error(failures.join(' | '));
    if (logged.length) throw new Error(`page exception: ${logged.join(' | ')}`);
    if (final.title !== 'ENDPOINT PULL OK') {
      throw new Error(final.result?.error || `timed out with title ${JSON.stringify(final.title)}`);
    }
    const wrongCounts = [...expected].filter(([key, count]) => used.get(key) !== count)
      .map(([key, count]) => `${key}: ${used.get(key) || 0}/${count}`);
    if (wrongCounts.length) throw new Error(`endpoint request count mismatch: ${wrongCounts.join(', ')}`);
    const requestCount = [...used.values()].reduce((total, count) => total + count, 0);
    success = `endpoint pull: success, stage preservation, explicit item failures and retry recovery; ${requestCount} raw requests across ${used.size} Zoho routes -> ${final.result.files} local files; cache disabled, no network\n`;
    await client.call('Target.closeTarget', { targetId });
  } finally {
    // Closing only Chrome's parent process was enough on macOS and raced its profile-writing child
    // on the Linux runner: the pull was green, then cleanup hit ENOTEMPTY. Ask the browser itself to
    // close, observe the process exit (including the already-exited case), and only then remove the
    // profile. A cleanup failure must not be printed after an apparent success.
    if (client) {
      try { await client.call('Browser.close'); } catch (_) {}
      client.close();
    }
    const waitForExit = async (limit) => {
      if (child.exitCode !== null) return true;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), limit);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
    };
    if (!(await waitForExit(5000))) {
      child.kill('SIGKILL');
      await waitForExit(3000);
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
  process.stdout.write(success);
}

main().catch((error) => {
  process.stderr.write(`endpoint pull failed: ${error.message}\n`);
  process.exitCode = 1;
});
