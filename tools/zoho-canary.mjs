#!/usr/bin/env node
/* Controlled, read-only contract canary. It is deliberately inert without explicit live config. */
const routes = Object.freeze([
  { name: 'crm-functions', path: '/crm/v7/functions' },
  { name: 'crm-modules', path: '/crm/v7/settings/modules' },
  { name: 'analytics-workspaces', path: '/analytics/api/workspaces' },
]);
const required = ['ZOOST_CANARY_BASE', 'ZOOST_CANARY_ORG', 'ZOOST_CANARY_INSTANCE', 'ZOOST_CANARY_SESSION'];

function shape(value) {
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (!value || typeof value !== 'object') return { type: typeof value };
  return { type: 'object', keys: Object.keys(value).sort().slice(0, 40) };
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ mode: 'dry-run', readOnly: true, routes: routes.map((r) => r.name), required }));
    return;
  }
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`canary requires explicit environment: ${missing.join(', ')}`);
  const base = new URL(process.env.ZOOST_CANARY_BASE);
  const headers = { cookie: process.env.ZOOST_CANARY_SESSION, 'x-zoost-canary': 'read-only' };
  const results = [];
  for (const route of routes) {
    const url = new URL(route.path, base);
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) throw new Error(`${route.name}: HTTP ${response.status}`);
    const body = await response.json();
    results.push({ ...route, status: response.status, contentType: response.headers.get('content-type'), shape: shape(body) });
  }
  console.log(JSON.stringify({ mode: 'live', readOnly: true, org: process.env.ZOOST_CANARY_ORG, instance: process.env.ZOOST_CANARY_INSTANCE, results }, null, 2));
}

main().catch((error) => { console.error(`canary: ${error.message}`); process.exitCode = 1; });
