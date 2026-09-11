#!/usr/bin/env node
/* Read-only contract canary for the discovery routes used by the shipped bridges.
 * It is inert without explicit per-product configuration and never prints cookies or org ids. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROFILES = Object.freeze({
  crm: Object.freeze({
    envBase: 'ZOOST_CANARY_CRM_BASE', envSession: 'ZOOST_CANARY_CRM_SESSION', envCsrf: 'ZOOST_CANARY_CRM_CSRF',
    envOrg: 'ZOOST_CANARY_CRM_ORG', envInstance: 'ZOOST_CANARY_CRM_INSTANCE',
    routes: Object.freeze([
      // This is the same instance-scoped read used by the bridge when it refreshes a page CSRF
      // token.  It makes the required instance/org values part of a real request, not decoration.
      { name: 'context', path: ({ instance }) => `/crm/${encodeURIComponent(instance)}/ConstantsInitial.do`, contract: false },
      { name: 'functions', path: () => '/crm/v2/settings/functions?type=org&start=1&limit=1&language=deluge' },
      { name: 'modules', path: () => '/crm/v2/settings/modules' },
      { name: 'workflow-rules', path: () => '/crm/v8/settings/automation/workflow_rules?page=1&per_page=200' },
    ]),
  }),
  analytics: Object.freeze({
    envBase: 'ZOOST_CANARY_ANALYTICS_BASE', envSession: 'ZOOST_CANARY_ANALYTICS_SESSION',
    envWorkspace: 'ZOOST_CANARY_ANALYTICS_WORKSPACE',
    routes: Object.freeze([
      { name: 'workspace-info', path: ({ workspace }) => `/reportsapi/DATASHEETREQUESTS?DBID=${encodeURIComponent(workspace)}&ISCREATEVIEW=false&ISSTANDALONEEDIT=false` },
      { name: 'view-list', path: ({ workspace }) => `/reportsapi/db/${encodeURIComponent(workspace)}/VIEWLIST?ZOHO_FOLDERLIST=true&NOCACHE=${Date.now()}` },
    ]),
  }),
});

function shape(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return {
    type: 'array',
    length: value.length,
    item: value.length ? shape(value[0]) : null,
    // Keep every element's shape so a later row cannot silently introduce a new variant.
    items: value.map(shape),
  };
  if (typeof value !== 'object') return { type: typeof value };
  return { type: 'object', keys: Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])])) };
}

function diffShape(actual, expected, at = '$', out = []) {
  if (!expected) return out;
  if (Array.isArray(expected.types)) {
    if (!expected.types.includes(actual?.type)) out.push(`${at}: expected one of ${expected.types.join(', ')}, got ${actual?.type || 'missing'}`);
    return out;
  }
  if (actual?.type !== expected.type) { out.push(`${at}: expected ${expected.type}, got ${actual?.type || 'missing'}`); return out; }
  if (expected.type === 'object') {
    for (const [key, wanted] of Object.entries(expected.keys || {})) diffShape(actual.keys?.[key], wanted, `${at}.${key}`, out);
    // Optional fields are still checked when present, but their absence is a supported upstream
    // variant. Keeping them outside `keys` makes the distinction reviewable in the contract file.
    for (const [key, wanted] of Object.entries(expected.optional || {})) {
      if (Object.prototype.hasOwnProperty.call(actual.keys || {}, key)) diffShape(actual.keys[key], wanted, `${at}.${key}`, out);
    }
    if (expected.strict === true) {
      for (const key of Object.keys(actual.keys || {})) {
        if (!Object.prototype.hasOwnProperty.call(expected.keys || {}, key)
            && !Object.prototype.hasOwnProperty.call(expected.optional || {}, key)) out.push(`${at}.${key}: unexpected field`);
      }
    }
  } else if (expected.type === 'array') {
    if (expected.nonEmpty === true && (actual.length || 0) === 0) out.push(`${at}: expected at least one item, got empty array`);
    if (Number.isInteger(expected.minLength) && (actual.length || 0) < expected.minLength) {
      out.push(`${at}: expected at least ${expected.minLength} items, got ${actual.length || 0}`);
    }
    if (Number.isInteger(expected.exactLength) && (actual.length || 0) !== expected.exactLength) {
      out.push(`${at}: expected exactly ${expected.exactLength} items, got ${actual.length || 0}`);
    }
    // `item` is the common shape. It is deliberately applied to every row: checking only the
    // first row was the false green that let a later function change id from string to number.
    if (expected.item) for (let i = 0; i < (actual.items?.length || 0); i++) diffShape(actual.items[i], expected.item, `${at}[${i}]`, out);
    if (Array.isArray(expected.variants)) {
      for (let i = 0; i < (actual.items?.length || 0); i++) {
        const matches = expected.variants.some((variant) => diffShape(actual.items[i], variant, `${at}[${i}]`, []).length === 0);
        if (!matches) out.push(`${at}[${i}]: no allowed shape variant`);
      }
    }
    if (Array.isArray(expected.items)) {
      if (actual.items?.length !== expected.items.length) out.push(`${at}: expected ${expected.items.length} items, got ${actual.items?.length || 0}`);
      for (let i = 0; i < Math.min(actual.items?.length || 0, expected.items.length); i++) diffShape(actual.items[i], expected.items[i], `${at}[${i}]`, out);
    }
  }
  return out;
}

// A shape intentionally contains no response values: printing a view or function name from a live
// organisation would turn a harmless canary into a data leak.  Contracts may nevertheless require
// stable protocol labels (the Analytics column arrays) through `requiredValues`; this companion
// check sees the raw value, reports only the missing label and is never included in the output.
function diffResponse(actual, expected, at = '$', out = []) {
  diffShape(shape(actual), expected, at, out);
  const labels = (value, schema, location) => {
    if (schema?.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, wanted] of Object.entries(schema.keys || {})) {
        if (Object.prototype.hasOwnProperty.call(value, key)) labels(value[key], wanted, `${location}.${key}`);
      }
      for (const [key, wanted] of Object.entries(schema.optional || {})) {
        if (Object.prototype.hasOwnProperty.call(value, key)) labels(value[key], wanted, `${location}.${key}`);
      }
    } else if (schema?.type === 'array' && Array.isArray(value)) {
      for (const wanted of schema.requiredValues || []) {
        if (!value.includes(wanted)) out.push(`${location}: missing required value ${JSON.stringify(wanted)}`);
      }
      if (schema.item) for (let i = 0; i < value.length; i++) labels(value[i], schema.item, `${location}[${i}]`);
    }
  };
  labels(actual, expected, at);
  return out;
}

function required(profile, env) {
  const keys = [profile.envBase, profile.envSession];
  if (profile.envCsrf) keys.push(profile.envCsrf);
  if (profile.envWorkspace) keys.push(profile.envWorkspace);
  else keys.push(profile.envOrg, profile.envInstance);
  return keys.filter((key) => !env[key]);
}

function expectedContracts() {
  // A live canary must always compare against a reviewed contract.  The environment override is
  // useful for a deliberately updated fixture in a review, while the repository contract keeps a
  // bare invocation from silently becoming a connectivity-only check.
  const file = process.env.ZOOST_CANARY_CONTRACT || path.join(ROOT, 'tools', 'zoho-canary-contract.json');
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function loadContracts() { return expectedContracts(); }

function contractDigest(contracts) {
  return crypto.createHash('sha256').update(JSON.stringify(contracts)).digest('hex');
}

function recordPath() {
  const arg = process.argv.find((value) => value.startsWith('--record='));
  return arg ? path.resolve(arg.slice('--record='.length)) : null;
}

function checkRecordPath() {
  const arg = process.argv.find((value) => value.startsWith('--check-record='));
  return path.resolve(arg ? arg.slice('--check-record='.length) : path.join(ROOT, 'tools', 'zoho-canary-status.json'));
}

function maxAgeDays() {
  const arg = process.argv.find((value) => value.startsWith('--max-age-days='));
  const value = Number(arg?.slice('--max-age-days='.length) || 30);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function writeRunRecord(file, results, contracts) {
  const record = {
    schema: 1,
    status: 'success',
    recordedAt: new Date().toISOString(),
    contract: { file: path.basename(process.env.ZOOST_CANARY_CONTRACT || 'zoho-canary-contract.json'), sha256: contractDigest(contracts) },
    profiles: results.map((result) => ({ app: result.app, routes: result.results.map((route) => ({ name: route.name, status: route.status })) })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function checkRunRecord(file, ageDays) {
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { throw new Error(`canary record is missing or unreadable: ${file}`); }
  if (record.status === 'never-run' || !record.recordedAt) throw new Error('canary has never completed a live run');
  if (record.status !== 'success' || record.schema !== 1) throw new Error('canary record is not a successful schema-1 run');
  const at = Date.parse(record.recordedAt);
  if (!Number.isFinite(at)) throw new Error('canary record has an invalid timestamp');
  if (Date.now() - at > ageDays * 86400000) throw new Error(`canary last success is older than ${ageDays} days`);
  if (!Array.isArray(record.profiles) || !record.profiles.some((profile) => profile.app === 'crm')
      || !record.profiles.some((profile) => profile.app === 'analytics')) throw new Error('canary record does not contain both product profiles');
  return { status: 'success', recordedAt: record.recordedAt, profiles: record.profiles.map((profile) => profile.app) };
}

async function run(app, profile, env, contracts) {
  const missing = required(profile, env);
  if (missing.length) throw new Error(`${app}: missing explicit environment ${missing.join(', ')}`);
  const base = new URL(env[profile.envBase]);
  const context = { workspace: env.ZOOST_CANARY_ANALYTICS_WORKSPACE, instance: env.ZOOST_CANARY_CRM_INSTANCE };
  const headers = { cookie: env[profile.envSession], 'x-requested-with': 'XMLHttpRequest', accept: 'application/json' };
  if (env[profile.envOrg]) headers['x-crm-org'] = env[profile.envOrg];
  if (env[profile.envCsrf]) headers['x-zcsrf-token'] = `crmcsrfparam=${env[profile.envCsrf]}`;
  const results = [];
  for (const route of profile.routes) {
    const url = new URL(route.path(context), base);
    // A canary must never follow a redirect: the session cookie is scoped to the configured Zoho
    // host, and forwarding it to an arbitrary Location would turn a read-only check into a data
    // disclosure.  Redirects are an explicit configuration/availability failure to investigate.
    const response = await fetch(url, { method: 'GET', headers, redirect: 'error' });
    if (!response.ok) throw new Error(`${app}/${route.name}: HTTP ${response.status}`);
    let actual = null;
    if (route.contract !== false) {
      const body = await response.json();
      actual = shape(body);
      const differences = diffResponse(body, contracts[`${app}.${route.name}`]);
      if (differences.length) throw new Error(`${app}/${route.name}: contract changed: ${differences.join('; ')}`);
    } else {
      // Do not retain or print the token body; the status is enough to prove the instance route is
      // valid and the session can read it.
      await response.arrayBuffer();
    }
    results.push({ name: route.name, status: response.status, ...(actual ? { shape: actual } : {}) });
  }
  return { app, routes: results.length, results };
}

async function main() {
  const selected = process.argv.find((arg) => arg.startsWith('--app='))?.slice(6) || 'all';
  const apps = selected === 'all' ? Object.keys(PROFILES) : [selected];
  if (process.argv.some((arg) => arg === '--check-record' || arg.startsWith('--check-record='))) {
    const result = checkRunRecord(checkRecordPath(), maxAgeDays());
    console.log(JSON.stringify(result));
    return;
  }
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ mode: 'dry-run', readOnly: true, profiles: apps.map((app) => ({ app, routes: PROFILES[app]?.routes.map((route) => route.name) })) }));
    return;
  }
  const contracts = expectedContracts();
  const results = [];
  for (const app of apps) {
    if (!PROFILES[app]) throw new Error(`unknown canary app: ${app}`);
    results.push(await run(app, PROFILES[app], process.env, contracts));
  }
  const record = recordPath();
  if (record) writeRunRecord(record, results, contracts);
  console.log(JSON.stringify({ mode: 'live', readOnly: true, results }, null, 2));
}

export { shape, diffShape, diffResponse, loadContracts, contractDigest, writeRunRecord, checkRunRecord };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`canary: ${error.message}`); process.exitCode = 1; });
}
