/*
 * slice.mjs — lift a named function out of a shipped file and evaluate it in isolation.
 *
 * The panels are browser scripts, not modules: `sidepanel.js` is 3000 lines that assume `document`,
 * `chrome` and a DOM, and nothing in them is exported. Restructuring them so they could be imported
 * is exactly the refactor this project has no safety net for — CLAUDE.md says so in as many words —
 * and doing it *in order to add tests* would be spending the risk before earning the cover.
 *
 * So the tests take the function's source text and run it alone. What this buys and what it does not:
 *
 *   It tests the function as written. If the logic is wrong, the test fails. That is the whole
 *   value, and every case in these files is one that actually went wrong at some point today.
 *
 *   It does not test the function as *called*. A correct helper wired to the wrong caller passes
 *   here. Nothing static catches that; reading the code does.
 *
 * The one thing it must never do is stop covering something in silence. If the function is renamed,
 * moved or deleted, `sliceFn` throws rather than returning nothing — a test that quietly tests
 * nothing is worse than no test, because it reports success.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Extract `function NAME(...) { ... }` from a source file.
 *
 * The end is the first `}` at column zero. Brace counting was the obvious approach and it was
 * wrong: a regex literal such as /['"]/ contains a quote, the scanner read it as the start of a
 * string, and the slice ran to the end of the file — 2490 lines instead of 20, and the test failed
 * on a DOM helper it should never have seen. Every file here puts a top-level function's closing
 * brace in column zero, so that is a fact about the code rather than a guess about JavaScript.
 */
export function sliceFn(rel, name) {
  const src = read(rel);
  const start = src.search(new RegExp(`(^|\\n)\\s*(export\\s+)?(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`${rel}: function ${name}() not found — renamed, moved or deleted. Fix the test or restore the cover.`);
  // The closing brace sits at the same indentation as the declaration. Column zero alone was not
  // enough: content-bridge.js wraps everything in an IIFE, so its functions are indented by two and
  // csrfToken() sliced 317 lines. Indentation is a fact about this codebase, consistently applied.
  // A declaration that closes on its own line ends there. Without this the search below runs past it
  // to the next `}` at that indentation and the slice quietly carries whatever sits between - which
  // is how `ensurePerm`, one line long, arrived with three unrelated declarations attached and a
  // duplicate `const` that only failed once something after it happened to share a name. A test that
  // silently evaluates its neighbours is the failure this file exists to refuse.
  // `start` sits on the newline before the declaration, because the search allows `(^|\n)`.
  const from = src[start] === '\n' ? start + 1 : start;
  const lineEnd = src.indexOf('\n', from);
  const firstLine = src.slice(from, lineEnd < 0 ? src.length : lineEnd);
  if (firstLine.includes('{') && firstLine.trimEnd().endsWith('}')) return firstLine.replace(/^(\s*)export\s+/, '$1');
  const kw = src.indexOf('function', start);
  const pad = src.slice(src.lastIndexOf('\n', kw) + 1, kw).match(/^[ \t]*/)[0];
  const end = src.indexOf('\n' + pad + '}', src.indexOf('{', start));
  if (end < 0) throw new Error(`${rel}: no closing brace at the declaration's indentation after ${name}()`);
  // Strip `export`: the slice is evaluated as a plain script, not as a module.
  return src.slice(start, end + pad.length + 2).replace(/^(\s*)export\s+/, '$1');
}

/** Lift a top-level `const NAME = …;` — one line, so the test uses the real value, not a copy.
 *
 * A test that restates a constant is testing its own copy of it. IS_VERSION *is* the shape guard;
 * duplicating it here would let the guard change and the test keep passing on the old one.
 */
export function sliceConst(rel, name) {
  // Ends at a `;` that closes a *line*, not at the first `;` anywhere. The obvious non-greedy `.*?;`
  // stopped inside a string literal — `const escA = … '&amp;' …` was cut after `&amp` and produced
  // a syntax error — and it would have mis-sliced any constant containing a semicolon just as
  // quietly. Every declaration in this codebase ends its statement at the end of a line — allowing
  // for a trailing comment, which is what made IS_VERSION slice three lines instead of one on the
  // first attempt. The tests still passed, because the surplus happened to be harmless; that is
  // exactly how a mis-slice survives, so the shape is asserted below rather than assumed.
  // `var` as well as `const`: site.js is a no-build classic script and declares everything with var,
  // 27 times and never once const. Bending the file to suit the test helper would be the wrong way
  // round — the helper exists to read the code as written.
  const m = read(rel).match(new RegExp(`(^|\\n)\\s*(export\\s+)?(?:const|var|let)\\s+${name}\\s*=[\\s\\S]*?;\\s*(//[^\\n]*)?$`, 'm'));
  if (!m) throw new Error(`${rel}: const/var ${name} not found — renamed or removed.`);
  return m[0].replace(/^\s*export\s+/m, '');
}

/** Evaluate one or more sliced functions together, with whatever globals they need stubbed. */
export function load(pieces, globals = {}) {
  // Not `{ ...globals }`: spreading invokes any getter immediately, freezing the value at load time
  // when the test has not set it yet. The object is handed over as it is, so a getter stays live and
  // a test can change what a function sees between cases.
  const ctx = vm.createContext(globals);
  const names = [];
  for (const p of pieces) {
    const m = p.match(/function\s+(\w+)\s*\(/) || p.match(/const\s+(\w+)\s*=/);
    if (m) names.push(m[1]);
  }
  vm.runInContext(pieces.join('\n\n') + `\n;({ ${names.join(', ')} })`, ctx);
  return vm.runInContext(`({ ${names.join(', ')} })`, ctx);
}
