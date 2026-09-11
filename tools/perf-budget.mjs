#!/usr/bin/env node
/* Small deterministic macro budgets for the shipped sample generator. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sizes = [120, 500, 1000];
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
  console.log('perf: green (small/medium/large generation budgets)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
