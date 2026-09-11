#!/usr/bin/env node
/* Read-only contract canary for the discovery routes used by the shipped bridges.
 * It is inert without explicit per-product configuration and never prints cookies or org ids. */
import fs from 'node:fs';
import path from 'node:path';
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
  if (actual?.type !== expected.type) { out.push(`${at}: expected ${expected.type}, got ${actual?.type || 'missing'}`); return out; }
  if (expected.type === 'object') {
    for (const [key, wanted] of Object.entries(expected.keys || {})) diffShape(actual.keys?.[key], wanted, `${at}.${key}`, out);
    if (expected.strict === true) {
      for (const key of Object.keys(actual.keys || {})) {
        if (!Object.prototype.hasOwnProperty.call(expected.keys || {}, key)) out.push(`${at}.${key}: unexpected field`);
      }
    }
  } else if (expected.type === 'array') {
    if (expected.item) diffShape(actual.item, expected.item, `${at}[]`, out);
    if (Array.isArray(expected.items)) {
      if (actual.items?.length !== expected.items.length) out.push(`${at}: expected ${expected.items.length} items, got ${actual.items?.length || 0}`);
      for (let i = 0; i < Math.min(actual.items?.length || 0, expected.items.length); i++) diffShape(actual.items[i], expected.items[i], `${at}[${i}]`, out);
    }
  }
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
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) throw new Error(`${app}/${route.name}: HTTP ${response.status}`);
    let actual = null;
    if (route.contract !== false) {
      actual = shape(await response.json());
      const differences = diffShape(actual, contracts[`${app}.${route.name}`]);
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
  console.log(JSON.stringify({ mode: 'live', readOnly: true, results }, null, 2));
}

export { shape, diffShape };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`canary: ${error.message}`); process.exitCode = 1; });
}
