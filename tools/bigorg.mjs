/* tools/bigorg.mjs - a workspace far larger than anyone's, written to disk for measuring against.
 *
 *   node tools/bigorg.mjs <dir> [functions]
 *
 * The sample generator that ships in the panel already takes a count - `+ Sample` asks it for 120 -
 * so a big org is that same code asked for a bigger number. Nothing here invents a second generator:
 * a fixture built by a different writer than the product's would be measuring the fixture.
 *
 * **What this can and cannot tell you.** It exercises everything downstream of the pull: reading a
 * workspace off disk, drawing the tree, searching names and source, the health audit, the exports,
 * the diagram. It says nothing about the pull itself - how Zoho paginates, how it rate-limits, how
 * long 5,000 functions take to arrive - because that is the half of the product this repository
 * cannot simulate, and pretending otherwise would be the worst kind of green light.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [dir, countArg] = process.argv.slice(2);
if (!dir) { console.error('usage: node tools/bigorg.mjs <dir> [functions]'); process.exit(2); }
const count = Number(countArg || 5000);

const ctx = { window: {}, Object, JSON, Math, String, Array, Set, Number };
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, 'apps/crm/sample-org.js'), 'utf8'), ctx);
const gen = ctx.window.SAMPLE_ORG;
if (!gen || typeof gen.files !== 'function') {
  console.error('the shipped generator does not expose files(); it is: ' + Object.keys(ctx.window));
  process.exit(2);
}

const t0 = Date.now();
// The shipped writer saturates at about 1,230 functions: its vocabulary is 16 verbs by 15 nouns
// across five namespaces, and it refuses to repeat a name. So it is asked for as much as it will
// give and the result is *replicated* - same file shapes, same fields, distinct names and ids - to
// reach the size being measured. The shape stays the product's; only the count is this file's.
const seedFiles = gen.files({ functions: 2000, edgeCases: false });
const files = {};
const seedIdx = JSON.parse(seedFiles['functions/index.json']);
const seedList = Array.isArray(seedIdx) ? seedIdx : seedIdx.functions;
const copies = Math.max(1, Math.ceil(count / seedList.length));
const index = [];
for (const [rel, body] of Object.entries(seedFiles)) {
  if (!rel.startsWith('functions/')) files[rel] = body;
}
for (let k = 0; k < copies; k++) {
  const tag = k === 0 ? '' : String(k);
  for (const row of seedList) {
    if (index.length >= count) break;
    const api = row.api_name + tag, id = String(700000 + index.length);
    const src = `functions/${row.namespace}/${row.api_name}.dg`;
    const meta = `functions/${row.namespace}/${row.api_name}.meta.json`;
    if (!seedFiles[src]) continue;
    files[`functions/${row.namespace}/${api}.dg`] = seedFiles[src];
    const m = JSON.parse(seedFiles[meta]);
    m.id = id; m.api_name = api; m.display_name = (row.display_name || row.name || api) + (tag ? ' ' + tag : '');
    files[`functions/${row.namespace}/${api}.meta.json`] = JSON.stringify(m, null, 2) + '\n';
    index.push({ ...row, id, api_name: api, display_name: m.display_name });
  }
}
files['functions/index.json'] = JSON.stringify(index, null, 2) + '\n';
const built = Date.now() - t0;

const base = join(dir, 'crm', 'bigorg-1234567890');
let bytes = 0;
for (const [rel, body] of Object.entries(files)) {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  bytes += body.length;
}
writeFileSync(join(base, '.zoost.json'), JSON.stringify(
  { name: 'bigorg', org: '1234567890', instance: 'yourinstance', sample: true }, null, 2) + '\n');

console.log(JSON.stringify({
  functions: index.length,
  files: Object.keys(files).length + 1,
  megabytes: +(bytes / 1048576).toFixed(1),
  generated_ms: built,
  where: base,
}));
