/*
 * Pure logic inside the panels and the bridges. Every case here is a bug that happened.
 *
 * These functions live in browser scripts that assume a DOM, so they are lifted out by
 * tests/slice.mjs and run alone. Read the note at the top of that file for what the technique does
 * and does not prove — in short: it catches wrong logic, it does not catch a correct helper wired
 * to the wrong caller.
 */
import { test } from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { sliceFn, sliceConst, load, read, ROOT } from './slice.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------- Deluge: stripping comments and strings before counting anything ----------

const { stripNonCode } = load([sliceFn('apps/crm/sidepanel.js', 'stripNonCode')]);

test('a URL inside a string is not mistaken for a line comment', () => {
  // The trap that made this a single left-to-right scan instead of chained regexes: removing line
  // comments first cuts `url: "https://x"` at the `//`, which leaves an unterminated quote that
  // swallows the following lines. The counts then under-report, silently, with no error anywhere.
  const src = 'a = invokeurl url: "https://example.com/x";\nb = 1;\nc = 2;';
  const out = stripNonCode(src);
  assert.ok(out.includes('b = 1'), 'the line after the URL survived');
  assert.ok(out.includes('c = 2'), 'and so did the one after that');
});

test('a real line comment is removed', () => {
  assert.ok(!stripNonCode('a = 1; // zoho.crm.getRecords\nb = 2;').includes('getRecords'));
});

test('a block comment is removed and does not eat the code after it', () => {
  const out = stripNonCode('/* zoho.crm.createRecord */\nkeep = 1;');
  assert.ok(!out.includes('createRecord'));
  assert.ok(out.includes('keep = 1'));
});

test('an apostrophe inside a double-quoted string does not open a string', () => {
  const out = stripNonCode('msg = "it\'s fine";\nafter = 1;');
  assert.ok(out.includes('after = 1'));
});

// ---------- CRM: which cookie carries which CSRF token ----------

const csrf = load([
  sliceConst('apps/crm/content-bridge.js', 'CSRF_COOKIES'),
  sliceFn('apps/crm/content-bridge.js', 'csrfToken'),
], { cookie: (n) => globalThis.__jar[n], document: { getElementById: () => null } });

function withJar(jar, fn) { globalThis.__jar = jar; try { return fn(); } finally { delete globalThis.__jar; } }

test('the deluge family reads drecn, not the CRM token', () => {
  // Measured after a 400 INVALID_CSRF_TOKEN: the two cookies usually hold the same value, which is
  // why reading CT_CSRF_TOKEN for both worked for months and then stopped when drecn rotated.
  withJar({ drecn: 'D', CT_CSRF_TOKEN: 'C', crmcsr: 'C', CSRF_TOKEN: 'C' }, () => {
    assert.equal(csrf.csrfToken('drepn'), 'D');
    assert.equal(csrf.csrfToken('crmcsrfparam'), 'C');
  });
});

test('with the cookies aligned both families agree — the case that hid the bug', () => {
  withJar({ drecn: 'X', CT_CSRF_TOKEN: 'X' }, () => {
    assert.equal(csrf.csrfToken('drepn'), 'X');
    assert.equal(csrf.csrfToken('crmcsrfparam'), 'X');
  });
});

test('a missing cookie degrades to the other family rather than sending an empty token', () => {
  // An empty token is a guaranteed 400. Falling back is a worse answer than the right cookie and a
  // much better one than no answer.
  withJar({ CT_CSRF_TOKEN: 'C' }, () => assert.equal(csrf.csrfToken('drepn'), 'C'));
});

test('no cookies at all yields an empty string, not a crash', () => {
  withJar({}, () => assert.equal(csrf.csrfToken('drepn'), ''));
});

test('an unknown prefix falls back to the CRM family rather than throwing', () => {
  withJar({ CT_CSRF_TOKEN: 'C' }, () => assert.equal(csrf.csrfToken('nonsense'), 'C'));
});

// ---------- CRM: which areas are behind, derived and not declared ----------

const stale = load([
  sliceConst('apps/crm/sidepanel.js', 'STALE_MARGIN_MS'),
  sliceFn('apps/crm/sidepanel.js', 'newestPull'),
  sliceFn('apps/crm/sidepanel.js', 'areaStale'),
], {
  get TABS() { return globalThis.__tabs; },
  get tabAccess() { return globalThis.__acc; },
  // The real fallback, not a simplified one: an area with no record of its own inherits the
  // workspace's lastPull. Testing a stand-in here would have hidden the bug this covers.
  pulledAt: (id) => (globalThis.__acc[id] || {}).pulledAt || globalThis.__lastPull || null,
});

const AREAS = ['functions', 'modules', 'workflows', 'schedules', 'connections'];
function withAccess(acc, fn, lastPull = null) {
  globalThis.__tabs = AREAS.map((id) => ({ id }));
  globalThis.__acc = acc;
  globalThis.__lastPull = lastPull;
  try { return fn(); } finally { delete globalThis.__tabs; delete globalThis.__acc; delete globalThis.__lastPull; }
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test('with nothing pulled, nothing is behind', () => {
  withAccess({}, () => AREAS.forEach((a) => assert.equal(stale.areaStale(a), false)));
});

test('an area excluded from the pull for months is behind', () => {
  withAccess({
    functions: { pulledAt: iso(0) }, modules: { pulledAt: iso(0) },
    connections: { pulledAt: iso(120 * 864e5) },
  }, () => {
    assert.equal(stale.areaStale('connections'), true);
    assert.equal(stale.areaStale('functions'), false);
  });
});

test('an area never pulled while others have been is behind', () => {
  withAccess({ functions: { pulledAt: iso(0) } },
    () => assert.equal(stale.areaStale('connections'), true));
});

test('the seconds between areas in one pull are not a finding', () => {
  // A full pull writes its areas moments apart. Without the margin every pull would report four
  // stale areas, which is the kind of noise that makes people stop reading a warning.
  const acc = {};
  AREAS.forEach((a, i) => { acc[a] = { pulledAt: iso(i * 4000) }; });
  withAccess(acc, () => AREAS.forEach((a) => assert.equal(stale.areaStale(a), false)));
});

test('the margin is six hours: five is fine, seven is behind', () => {
  withAccess({ functions: { pulledAt: iso(0) }, schedules: { pulledAt: iso(5 * 36e5) } },
    () => assert.equal(stale.areaStale('schedules'), false));
  withAccess({ functions: { pulledAt: iso(0) }, schedules: { pulledAt: iso(7 * 36e5) } },
    () => assert.equal(stale.areaStale('schedules'), true));
});

test('a workspace mirrored before per-area dates existed is not reported as behind', () => {
  // Reported bug. `pulledAt` only exists for areas pulled since the feature landed, so a folder
  // full of current data carried no record and read as "never pulled while others have been".
  // The export dialog then unticked Functions and Workflows and the report came out smaller than
  // the user had asked for, without them choosing that.
  withAccess({ connections: { pulledAt: iso(0) } }, () => {
    assert.equal(stale.areaStale('functions'), false);
    assert.equal(stale.areaStale('workflows'), false);
  }, iso(60 * 1000));   // the workspace itself was pulled a minute ago
});

test('the fallback does not hide an area that really is months behind', () => {
  withAccess({ functions: { pulledAt: iso(0) }, connections: { pulledAt: iso(120 * 864e5) } },
    () => assert.equal(stale.areaStale('connections'), true), iso(0));
});

// ---------- the export dialog must not rewrite the saved defaults ----------

test('clearing a section for staleness never becomes a stored preference', () => {
  // The dialog saves what you leave it with, so unticking a box *for* the user rewrote their
  // settings: one export and Functions and Workflows were gone from Settings too. A transient
  // warning must not survive as a preference. This mirrors the merge the panel performs.
  const saved = { functions: true, code: true, workflows: true, modules: true };
  const dlg = { functions: false, code: false, workflows: false, modules: true };
  const autoCleared = new Set(['functions', 'code', 'workflows']);

  const keep = Object.assign({}, dlg);
  autoCleared.forEach((k) => { keep[k] = saved[k]; });

  assert.deepEqual(keep, saved, 'settings are untouched by an automatic clear');
  assert.equal(dlg.functions, false, 'while the export itself still leaves the stale part out');
});

test('a box the user re-ticks is theirs, and is remembered', () => {
  const saved = { workflows: true, schedules: true };
  const dlg = { workflows: true, schedules: false };      // user cleared schedules by hand
  const autoCleared = new Set();                          // their edit removed it from the set
  const keep = Object.assign({}, dlg);
  autoCleared.forEach((k) => { keep[k] = saved[k]; });
  assert.equal(keep.schedules, false, 'a deliberate change is kept');
});

// ---------- what the assistant is told you are looking at ----------

const focusCtx = {
  get currentPath() { return globalThis.__cur; },
  get workflowData() { return globalThis.__wf || []; },
  get scheduleData() { return globalThis.__sc || []; },
  get connectionData() { return globalThis.__cn || []; },
  get moduleData() { return globalThis.__md || []; },
  aiTrunc: (t, n) => String(t).slice(0, n),
  ensureGraph: async () => ({ nodes: { a: { file: 'ns/Fn.dg', namespace: 'ns', name: 'Fn', source_code: 'info 1;' } } }),
  readFile: async (p) => {
    if (globalThis.__files && globalThis.__files[p]) return globalThis.__files[p];
    throw new Error('not on disk');
  },
  JSON, Object,
};
const { aiFocus } = load([sliceFn('apps/crm/sidepanel.js', 'moduleRefusal'),
                          sliceFn('apps/crm/sidepanel.js', 'aiFocus')], focusCtx);

function looking(at, extra = {}) {
  Object.assign(globalThis, { __cur: at, __wf: [], __sc: [], __cn: [], __md: [], __files: {} }, extra);
  return aiFocus();
}

test('a Deluge function still gets its source as focus', async () => {
  const out = await looking('ns/Fn.dg');
  assert.match(out, /CURRENT FOCUS/);
  assert.match(out, /Deluge function ns\.Fn/);
  assert.match(out, /info 1;/);
});

test('a selected workflow gets its conditions and actions, not "give me details"', async () => {
  // The reported bug: select a workflow, open the assistant, ask what it does, and it answered that
  // it had no reference — while the same question about a function worked. currentPath was already
  // set by every tab; only the focus read it for one of them.
  const out = await looking('workflows/42.json', {
    __wf: [{ path: 'workflows/42.json', name: 'Notify owner', id: '42' }],
    __files: { 'workflows/42.json': JSON.stringify({ name: 'Notify owner', actions: ['send mail'] }) },
  });
  assert.match(out, /the workflow «Notify owner»/);
  assert.match(out, /send mail/, 'the file, which is where "what does it do" is answered');
});

test('a workflow whose detail was never pulled says so rather than looking complete', async () => {
  const out = await looking('workflows/7.json', { __wf: [{ path: 'workflows/7.json', name: 'Half known' }] });
  assert.match(out, /the workflow «Half known»/);
  assert.match(out, /have not been pulled/);
});

test('schedules, connections and modules each get a focus of their own', async () => {
  const sc = await looking('schedules/9', { __sc: [{ path: 'schedules/9', name: 'Nightly' }] });
  assert.match(sc, /the schedule «Nightly»/);

  const cn = await looking('connections/books', { __cn: [{ path: 'connections/books', name: 'books', label: 'Books API' }] });
  assert.match(cn, /the connection «Books API»/);

  const md = await looking('modules/Contacts.json', { __md: [{ path: 'modules/Contacts.json', api_name: 'Contacts', label: 'Contacts' }] });
  assert.match(md, /the module «Contacts»/);
});

test('a module Zoho refused is said to be unreadable, not empty', async () => {
  // Reported with a HAR. Invoices is hidden in that org, Zoho answers 400 INVALID_MODULE, and both
  // fields calls were `catch {}` - so the module was written with nothing in it and the panel said
  // "None recorded - re-run Pull Modules to fetch them", advice that could never work. An assistant
  // handed a module with no fields will explain why a module has none; the answer is that nobody was
  // ever allowed to look, and it has to be told that before the empty list, not after.
  const md = await looking('modules/Invoices.json', {
    __md: [{
      path: 'modules/Invoices.json', api_name: 'Invoices', label: 'Invoices', fieldCount: 0,
      unreadable: { status: 400, code: 'INVALID_MODULE', message: 'operation cannot be performed for hidden module', at: '2026-08-06T09:30:45.000Z' },
    }],
  });
  assert.match(md, /the module «Invoices»/);
  assert.match(md, /hidden module/, "Zoho's own words, not ours");
  assert.match(md, /INVALID_MODULE/);
  assert.match(md, /2026-08-06/, 'a refusal is dated: it records one answer, not a permanent truth');
  assert.match(md, /never read, not because there are none/);
});

test('nothing selected, or something with no focus to give, adds nothing', async () => {
  assert.equal(await looking(null), '');
  assert.equal(await looking('export/report.html'), '');
  assert.equal(await looking('schedules/404'), '', 'a path with no matching entry is silent, not broken');
});

// ---------- absent when there is nothing to do, disabled when merely not yet ----------

// The rule the panels follow, extracted so both readings of it are pinned: a permanent "no" hides
// the control, a temporary one greys it. Mixing them is what made "+ Workspace" look broken — it
// was disabled for a reason that would never clear.
function addButtonState({ root, ctx, known }) {
  return { hidden: !!known, disabled: !root || !ctx };
}

test('a workspace that already exists hides the button rather than grey it', () => {
  const st = addButtonState({ root: true, ctx: true, known: true });
  assert.equal(st.hidden, true, 'nothing here will ever become available');
});

test('the reasons that clear on their own leave it visible and disabled', () => {
  // No working folder, no Zoho tab: both are waits, and a button that says what is missing is
  // more use than one that has vanished.
  assert.deepEqual(addButtonState({ root: false, ctx: true, known: false }), { hidden: false, disabled: true });
  assert.deepEqual(addButtonState({ root: true, ctx: false, known: false }), { hidden: false, disabled: true });
});

test('ready to act: visible and enabled', () => {
  assert.deepEqual(addButtonState({ root: true, ctx: true, known: false }), { hidden: false, disabled: false });
});

// ---------- which links belong in the Zoho tab, and which get their own window ----------

const { isZohoUrl } = load([sliceFn('apps/crm/sidepanel.js', 'isZohoUrl')]);

test('Zoho pages stay in the Zoho tab', () => {
  // Opening these in a window would defeat the point: they are meant to land where the panel is
  // looking.
  ['https://crm.zoho.eu/crm/tab/Contacts',
   'https://analytics.zoho.com/workspace/123',
   'https://crmsandbox.zoho.com/crm/x',
   // The data centres whose domain is not literally «zoho.something» were falling through to a
   // window of their own, and the three added later were not in the regex at all.
   'https://crm.zohocloud.ca/crm/x',
   'https://crm.zoho.sa/crm/x',
   'https://crmsandbox.zoho.uk/crm/x',
   'https://one.zoho.ae/',
   'https://zoho.com/crm'].forEach((u) => assert.equal(isZohoUrl(u), true, u));
});

test('everything else opens in its own window', () => {
  // chrome.tabs.create activates the new tab, so the panel finds itself on a non-Zoho page, the
  // environment guard fires and the interface empties behind the mismatch overlay. Right behaviour,
  // wrong cause — the user clicked Help and the workbench looked like it had lost its place.
  ['https://zoost.it/docs-crm.html',
   'https://github.com/ivannot/zoost',
   'https://ko-fi.com/ivannot',
   'https://chromewebstore.google.com/detail/abc'].forEach((u) => assert.equal(isZohoUrl(u), false, u));
});

test('a host that merely contains the word is not Zoho', () => {
  // Sending these to the Zoho tab would make the guard complain about a mismatch it did not cause.
  assert.equal(isZohoUrl('https://notzoho.com/x'), false);
  assert.equal(isZohoUrl('https://evil.com/zoho.eu'), false);
});

test('a non-http scheme is left entirely alone', () => {
  assert.equal(isZohoUrl('mailto:ivan@zoost.it'), false);
});

// ---------- attribute escaping ----------

const { escA } = load([sliceConst('apps/crm/sidepanel.js', 'escA')]);

test('a quote cannot close the attribute it sits in', () => {
  // The documented trap, found again by an outside review: escHtml() escapes & < > and not quotes,
  // so a name from Zoho containing a quote ends the attribute and whatever follows becomes markup.
  assert.ok(!escA('x" onerror=alert(1)').includes('"'));
  assert.ok(!escA("x' onerror=alert(1)").includes("'"));
});

test('a tag does not survive', () => {
  assert.equal(escA('<img src=x>'), '&lt;img src=x&gt;');
});

test('an ampersand is escaped once, not twice', () => {
  // Double-escaping is the other failure: swapping esc() for escA() rather than wrapping it is what
  // keeps `a & b` from becoming `a &amp;amp; b` in every title on the page.
  assert.equal(escA('a & b'), 'a &amp; b');
});

test('ordinary text is left alone', () => {
  assert.equal(escA('Update Contact Status'), 'Update Contact Status');
});

test('the slicer lifts exactly the constant, not the lines around it', () => {
  // Not decoration. `.*?;` stopped inside a string and cut escA in half; requiring the semicolon at
  // end-of-line then swallowed two extra lines whenever a trailing comment followed it — and the
  // tests kept passing, because the surplus happened to be harmless. A mis-slice that still passes
  // is how a test quietly stops testing the thing it names.
  assert.equal(sliceConst('apps/crm/sidepanel.js', 'escA').trim().split('\n').length, 1);
  assert.equal(sliceConst('site/_worker.js', 'IS_VERSION').trim().split('\n').length, 1);
  assert.equal(sliceConst('apps/crm/content-bridge.js', 'CSRF_COOKIES').trim().split('\n').length, 4);
});

test('a namespace from Zoho cannot become markup in a group header', () => {
  // The one real finding of the content audit: the functions tree grouped by namespace and wrote
  // the namespace straight into innerHTML. The other 378 content slots were numbers, our own
  // literals, or markup this code had just built.
  const src = read('apps/crm/sidepanel.js');
  assert.match(src, /<span>\$\{escHtml\(ns\)\}<\/span>/,
    'the group header must escape the namespace it renders');
});


// ---------- a workspace's own name ----------

test('the label is shown and the platform name is kept', () => {
  // Both halves matter. Showing the user's name is the feature; keeping the platform's is what makes
  // the list checkable against Zoho, and it is the half that is easy to drop.
  for (const app of ['crm', 'analytics']) {
    const text = sliceFn(`apps/${app}/sidepanel.js`, 'wsOptionText');
    const title = sliceFn(`apps/${app}/sidepanel.js`, 'wsOptionTitle');
    const ctx = load([text, title], {});
    const derived = app === 'crm' ? { name: 'acme-1234567890' } : { name: 'Sales', folder: 'Sales', id: '99' };
    const bare = { ...derived, cfg: {} };
    const named = { ...derived, cfg: { label: 'Q4 migration' } };

    assert.notEqual(ctx.wsOptionText(bare), '', `${app}: an unnamed workspace must still say something`);
    assert.equal(ctx.wsOptionText(named), 'Q4 migration', `${app}: the label is what is shown`);
    assert.match(ctx.wsOptionTitle(named), /Q4 migration/, `${app}: and the tooltip carries it`);
    assert.match(ctx.wsOptionTitle(named), new RegExp(derived.name), `${app}: the platform name must survive in the tooltip`);
    assert.match(ctx.wsOptionTitle(bare), new RegExp(derived.name), `${app}: with no label, the tooltip is the platform name`);
  }
});

test('whitespace is not a name', () => {
  for (const app of ['crm', 'analytics']) {
    const ctx = load([sliceFn(`apps/${app}/sidepanel.js`, 'wsOptionText')], {});
    const derived = app === 'crm' ? { name: 'acme-1234567890' } : { name: 'Sales', folder: 'Sales', id: '99' };
    assert.notEqual(ctx.wsOptionText({ ...derived, cfg: { label: '   ' } }), '   ');
  }
});

test('every writer of .zoost.json merges', () => {
  // The cacheBinding trap, found live in two more places while adding `label`: the CRM's own pullAll
  // wrote the file whole and dropped the access verdicts, and Analytics had no patchCfg at all. A
  // whole-object write is correct only until someone else puts a field in the same file — which has
  // now happened three times.
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/sidepanel.js`);   // `read` from slice.mjs; this file imports no fs
    const body = src.replace(/^\s*\/\/.*$/gm, '');
    const whole = [...body.matchAll(/\bwrite(Cfg|Json)\(\s*(CFG\s*,)?/g)]
      .filter((m) => m[1] === 'Cfg' || (m[2] || '').includes('CFG'))
      .filter((m) => !body.slice(Math.max(0, m.index - 40), m.index).includes('patchCfg'));
    assert.equal(whole.length, 0,
      `${app}/sidepanel.js: ${whole.length} whole-object write(s) to .zoost.json — use patchCfg, or the next field added to that file is silently dropped`);
  }
});


// ---------- a mark in the markup must survive the code ----------

test('nothing rebuilds the label of a button whose label is a mark', () => {
  // Three times in one change: $('pullone').textContent = 'Pull' put the word back on every mode
  // switch, $('graph').textContent did the same, and updateButtons() blanked #pull's title — which is
  // where a mark's *name* lives, so the control lost its name on the first repaint. The general shape
  // is worth the check: a label that lives in the markup must not be rebuilt by whatever updates state.
  const marked = ['pull', 'pullone', 'healthpull', 'graph', 'dpull', 'dgraph'];
  const findings = [];
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/sidepanel.js`).replace(/^\s*\/\/.*$/gm, '');
    const html = read(`apps/${app}/sidepanel.html`);
    for (const id of marked) {
      if (!html.includes(`id="${id}"`)) continue;
      const isMark = new RegExp(`id="${id}"[^>]*>\\s*<svg`).test(html);
      if (!isMark) continue;
      for (const prop of ['textContent', 'innerHTML']) {
        if (src.includes(`$('${id}').${prop} =`)) findings.push(`${app}: #${id}.${prop} is written in JS, over its mark`);
      }
      // its title may vary, but it may never be emptied: that is the name
      const m = src.match(new RegExp(`\\$\\('${id}'\\)\\.title = [\\s\\S]{0,300}?;`));
      if (m && /:\s*''\s*;/.test(m[0])) findings.push(`${app}: #${id}.title can be set to '' — a mark with no title has no name`);
    }
  }
  assert.deepEqual(findings, []);
});

test('every marked button carries a name and a tooltip', () => {
  for (const app of ['crm', 'analytics']) {
    const html = read(`apps/${app}/sidepanel.html`);
    for (const m of html.matchAll(/<button([^>]*)>\s*<svg class="mk"/g)) {
      const attrs = m[1];
      const id = (attrs.match(/id="([^"]+)"/) || [])[1] || '?';
      assert.match(attrs, /aria-label="/, `${app}: #${id} draws a mark and has no name`);
      assert.match(attrs, /title="/, `${app}: #${id} draws a mark and has no tooltip`);
    }
  }
});


// ---------- one window, one name; one colour key, one dimension ----------

test('the diagram window is called two things, not four', () => {
  // «Graph ↗», «Schema ↗», «ER ↗» and «Open ER» all opened the same window, and the author could not
  // keep them apart either. Two names survive because there are two drawings: a call graph between
  // functions, and an ER model of modules or tables. Nothing else may name that window.
  for (const app of ['crm', 'analytics']) {
    for (const f of ['sidepanel.html', 'sidepanel.js']) {
      const src = read(`apps/${app}/${f}`).replace(/^\s*\/\/.*$/gm, '');
      for (const dead of ['Open ER', 'Schema \u2197', 'Graph \u2197', 'ER \u2197']) {
        assert.ok(!src.includes(dead), `${app}/${f}: «${dead}» is back`);
      }
    }
  }
});

test('the dot, the chips and the filter read the same fact', () => {
  // They did not. The chips select a function's *category*; the dot was coloured by its Deluge
  // *namespace*, and pass() compared the chip against the namespace too — so those five filters only
  // worked in an org where Zoho returns no namespace, and every dot fell back to grey. One accessor
  // decides all three now, which is the only thing that stops them drifting apart again.
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/graphview.js`);
    assert.match(src, /const KINDOF = \(n\) => \(DATA\.kind === 'schema' \? n\.namespace : n\.category\)/,
      `${app}: the shared accessor is gone`);
    assert.ok(!/NSCOL\(n\.namespace\)/.test(src), `${app}: a dot is coloured by namespace again`);
    // The canvas kept its own copy of the mistake - NSCOL(N[id].namespace) - and it survived the
    // first fix because that one read `n.` and this one reads `N[id].`. On a call graph every dot in
    // the Visual view was grey, because `billing` has no hue and never will.
    assert.ok(!/NSCOL\(N\[id\]\.namespace\)/.test(src), `${app}: the canvas is coloured by namespace again`);
    const body = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}', src.indexOf(`function ${name}(`)));
    const p = body('passKind') || body('pass');
    assert.ok(!/n\.namespace !== /.test(p), `${app}: a filter compares the namespace again`);
  }
});

test('the kinds are read off the graph, never listed in the code', () => {
  // The list used to be written out, and it was written out wrong: standalone / automation / button
  // / schedule / validation_rule are graph-core's NS - the Deluge *namespaces* the call regex
  // matches - while KINDOF reads `category`, a different field with different values (scheduler,
  // crmfundamentals, …). So a node whose category was not one of the five namespaces matched no
  // chip, got no hue, and could never be switched off: «None» left it on screen, which is how this
  // was found. It is the same mismatch already recorded here once, fixed on the KINDOF side and
  // left standing on the list side.
  const N = {
    a: { id: 'a', name: 'a', namespace: 'schedule', category: 'scheduler' },
    b: { id: 'b', name: 'b', namespace: 'validation_rule', category: 'crmfundamentals' },
    c: { id: 'c', name: 'c', namespace: 'standalone', category: 'standalone' },
    d: { id: 'd', name: 'd', namespace: 'x', category: '' },
    e: { id: 'e', name: 'Deal won', namespace: 'Deals', category: 'workflows', entity: 'workflows' },
    // Two kinds of one entity, which is what the second level exists for: they must land in an
    // Actions box together and never among the Deluge categories.
    f: { id: 'f', name: 'Chase it', category: 'tasks', entity: 'actions' },
    g: { id: 'g', name: 'Notify', category: 'email_notifications', entity: 'actions' },
  };
  const ctx = { N, DATA: { kind: 'calls' }, Object, Set, Map };
  const api = load([sliceConst('apps/crm/graphview.js', 'KINDOF'),
                    sliceConst('apps/crm/graphview.js', 'ENTITY_LABEL'),
                    sliceConst('apps/crm/graphview.js', 'entityOf'),
                    sliceFn('apps/crm/graphview.js', 'entitiesPresent'),
                    sliceFn('apps/crm/graphview.js', 'kindGroups'),
                    sliceConst('apps/crm/graphview.js', 'allKinds')], ctx);
  const groups = api.kindGroups();
  assert.equal(groups.map(([t]) => t).join(' '), 'Functions Actions Workflows',
    'the groups are not the entities actually present, in their declared order');
  assert.equal(groups[1][1].map(([k]) => k).join(','), 'email_notifications,tasks',
    'the two kinds of action are not both chips inside the Actions group');
  assert.equal(groups[0][1].map(([k]) => k).join(','), ',crmfundamentals,scheduler,standalone',
    'the categories are not read off the nodes');
  // ...including the one Zoho gave no category for, or it can never be switched off
  assert.equal(groups[0][1].find(([k]) => k === '')[1], 'no category', 'a node with no category has no chip');
  assert.ok(api.allKinds().includes(''), '«None» would leave the uncategorised nodes on screen');
  // and a kind that is not present gets no chip at all
  assert.ok(!api.allKinds().includes('schedules'), 'a kind with no nodes still has a chip');
});

test('every kind gets a colour, and no condition gets one', () => {
  // A hue says «this is a kind of thing». The set of kinds is the platform's to decide, so declared
  // hues cannot cover it: what is declared is used, and anything else gets a fallback.
  //
  // The hash alone was not enough - it gave `scheduler` and `custombutton` the same violet, which is
  // two roles in one colour. It now picks a *preferred* slot and takes the first free one from
  // there, so the answer depends on the whole set and every kind present is distinct.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/graphview.js`);
    assert.ok(/const FALLBACK_HUES = \[/.test(js), `${app}: an unknown kind would have no colour`);
    assert.ok(/const KINDCOL = \(k\) => declaredHue\(k\) \|\| \(k \? hueFor\(k\) : ''\)/.test(js),
      `${app}: the declared hue no longer wins, or the fallback is gone`);

    let kinds = [];
    const ctx = { allKinds: () => kinds, Set, Object,
      // nothing is declared in this stub, so every kind falls through to the fallback
      document: { documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: () => '' }) };
    const { hueFor } = load([sliceConst(`apps/${app}/graphview.js`, 'FALLBACK_HUES'),
                             sliceConst(`apps/${app}/graphview.js`, 'declaredHue'),
                             // the memo the function keeps, so the slice is the real one
                             'let _hues = null, _huesKey = null;',
                             sliceFn(`apps/${app}/graphview.js`, 'hueFor')], ctx);
    kinds = ['scheduler', 'custombutton', 'crmfundamentals', 'standalone', 'workflow'];
    const cols = kinds.map(hueFor);
    assert.equal(new Set(cols).size, kinds.length, `${app}: two kinds collapse to one colour: ${cols}`);
    assert.equal(hueFor('scheduler'), cols[0], `${app}: the answer is not stable within one set`);
    // ...and the same set always comes out the same way, whatever order it is asked in
    const again = [...kinds].reverse().map(hueFor).reverse();
    assert.deepEqual(again, cols, `${app}: the colours depend on the order they are asked for`);
  }

  for (const app of ['crm', 'analytics']) {
    const css = read(`apps/${app}/graphview.html`);
    for (const c of ['all', 'hub', 'orphan', 'dead', 'unres']) {
      assert.ok(!css.includes(`--n-${c}:`), `${app}: «${c}» is a condition and has been given a hue`);
    }
  }
});


// ---------- an empty state names the reason it is actually empty ----------

test('every empty list asks what is blocking before blaming the pull', () => {
  // Reported: Analytics told the reader to pick a folder, create a workspace and press Pull all,
  // while the only thing in the way was one click on Grant access — four instructions where one
  // would do, and three of them already done. The CRM looked right only because its status line
  // happened to say the true thing; its tree messages had the same defect.
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/sidepanel.js`).replace(/^\s*\/\/.*$/gm, '');
    const fn = 'emptyReason';   // one name on both sides now, and the same wording behind it
    assert.match(src, new RegExp(`function ${fn}\\(\\)`), `${app}: nothing derives why a list is empty`);
    // the three states that block before a pull ever could
    for (const guard of ['!root', '!rootGranted']) {
      const body = src.slice(src.indexOf(`function ${fn}()`), src.indexOf('\n}', src.indexOf(`function ${fn}()`)));
      assert.ok(body.includes(guard), `${app}: ${fn}() does not consider ${guard}`);
    }
  }
});

test('no list still tells the reader to pull without asking first', () => {
  const src = read('apps/crm/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
  for (const m of src.matchAll(/'<b>No [^']*<\/b> Press <b>Pull[^']*'/g)) {
    const before = src.slice(Math.max(0, m.index - 140), m.index);
    assert.ok(before.includes('emptyReason() ||'),
      `a list points at Pull without asking what is actually blocking`);
  }
});

test('the export box is never faded with opacity, and the bar is never outlined', () => {
  // Two separate things, both about the same strip of interface.
  //
  // .explabel sits over .expgroup's top border with an opaque background, which is what gives the
  // export box its legend look and what makes HTML and MD mean something - they name a file format,
  // not an action, and the legend is what says "export". `opacity` on .expgroup composites the whole
  // subtree, so that background stops hiding anything and the border draws straight through the
  // word: measured at 6.5px down an 8px label. So the box dims from the inside instead.
  //
  // And .wsgroup used to take an accent border while Health or the assistant was open. It was
  // decoration and he said so - the faded controls and the lit-up button already say which mode you
  // are in, and an outline around everything says it a third time.
  for (const app of ['crm', 'analytics']) {
    const css = read(`apps/${app}/sidepanel.html`);
    for (const m of css.matchAll(/^ *([^\n{]*\.expgroup[^\n{]*)\{([^}]*)\}/gm)) {
      // the *subject* of the selector, not any mention: `.expgroup button{opacity:.32}` is how the
      // box is meant to dim, and the first version of this test flagged it.
      if (!m[1].split(',').some((sel) => /\.expgroup$/.test(sel.trim()))) continue;
      assert.ok(!/(^|;)\s*opacity\s*:/.test(m[2]),
        `${app}: opacity on .expgroup makes its own border show through EXPORT - "${m[1].trim().slice(0, 60)}"`);
    }
    assert.ok(/\.explabel\{[^}]*background:var\(--surface\)/.test(css), `${app}: .explabel lost the background that masks the border`);
    assert.ok(!/body\.(ai|health)-open \.wsgroup\{/.test(css), `${app}: the bar is outlined again when a mode opens`);
  }
});

test('the export buttons say they export, not just which file they write', () => {
  // HTML and MD name a format. The legend says what pressing them does, for anyone looking; the
  // aria-label has to say it for anyone not.
  for (const app of ['crm', 'analytics']) {
    const html = read(`apps/${app}/sidepanel.html`);
    for (const [id, name] of [['export', 'Export HTML'], ['exportmd', 'Export Markdown']]) {
      // No `#` in an assertion message: it opens a comment in TAP, so `#exportmd` truncated the
      // failure to "analytics: " and said nothing. Second unreadable failure in two days, different
      // cause - write the id without its selector sigil.
      const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`));
      assert.ok(tag, `${app}: the button id=${id} is gone`);
      assert.ok(tag[0].includes(`aria-label="${name}"`), `${app}: id=${id} does not say it exports - aria-label must read "${name}"`);
    }
  }
});

test('a module Zoho refused cannot be focused, and its emptiness is not a measurement', () => {
  // Reported: a refused module has no fields, so the ER button in its detail pane opened a window
  // with nothing in it. Everything downstream of a refusal is the same defect - a box with no rows,
  // a node with no edges, a count of zero - and each of them is a claim nobody is entitled to make,
  // because the fields were never read.
  //
  // setFocus is lifted and run: the early return is the whole behaviour, so the stubs below are
  // never reached unless it lets an unreadable node through.
  let focused = null;
  const ctx = {
    N: { Contacts: { id: 'Contacts', api_name: 'Contacts' },
         Invoices: { id: 'Invoices', api_name: 'Invoices', unreadable: { status: 400, code: 'INVALID_MODULE' } } },
    get curFocus() { return null; },
    set curFocus(v) { focused = v; },
    $: () => ({ innerHTML: '', style: {} }),
    esc: (x) => String(x),
    label: (n) => n.api_name,
    computeMaxDepth() { focused = focused || 'reached'; },
    updateDepthUI() {}, updateScopeUI() {}, updateTopTools() {}, egoStat() {}, erRender() {}, draw() {},
    bfsEgo() {}, updateBack() {}, erShow() {},
    get egoDepth() { return 2; }, set egoDepth(_v) {}, get maxEgoDepth() { return 6; },
    get scopeAll() { return false; }, get curView() { return 'er'; },
    Math,
  };
  const { setFocus } = load([sliceFn('apps/crm/graphview.js', 'setFocus')], ctx);
  setFocus('Invoices');
  assert.equal(focused, null, 'a module Zoho would not describe was made the focus');
  setFocus('Contacts');
  assert.equal(focused, 'Contacts', 'a readable module can no longer be focused either');
});

test('a function box lists what it calls, the way a module box lists its fields', () => {
  // The window is one engine fed by two shapes, so a call graph expresses itself in the shape the
  // engine already draws - rows of {api_name, data_type} - rather than the renderer learning a
  // second one. Each row is a callee: its name, and its namespace where a field would put its type.
  const N = {
    'billing.createInvoice': { id: 'billing.createInvoice', name: 'createInvoice', namespace: 'billing', calls: ['shared.log', 'billing.calcTax'], called_by: [] },
    'shared.log': { id: 'shared.log', name: 'log', namespace: 'shared', calls: [], called_by: ['billing.createInvoice'] },
    'billing.calcTax': { id: 'billing.calcTax', name: 'calcTax', namespace: 'billing', calls: [], called_by: ['billing.createInvoice'] },
  };
  const { erCallRows } = load([sliceFn('apps/crm/graphview.js', 'erCallRows')],
    { N, label: (n) => n.name, DATA: { kind: 'calls' }, passKind: () => true });
  const rows = erCallRows(N['billing.createInvoice']);
  assert.deepEqual(rows.map((r) => r.api_name), ['calcTax', 'log'], 'the callees are not listed, or not in order');
  assert.deepEqual(rows.map((r) => r.data_type), ['billing', 'shared'], 'the second column is not the callee namespace');
  assert.deepEqual(erCallRows(N['shared.log']), [], 'a function that calls nothing has rows');

  // ...and erFieldsFor has to route to it. Testing erCallRows alone left the wiring uncovered:
  // deleting the line that reaches it passed, which is the mutation that found this gap.
  const rowsOf = (kind, n, node) => {
    const ctx = { N, label: (x) => x.name, DATA: { kind }, erEmph: 'modules', erAll: true, passKind: () => true };
    const { erFieldsFor } = load([sliceFn('apps/crm/graphview.js', 'erCallRows'),
                                  sliceFn('apps/crm/graphview.js', 'erFieldsFor')], ctx);
    return erFieldsFor(node);
  };
  assert.deepEqual(rowsOf('calls', 0, N['billing.createInvoice']).map((r) => r.api_name), ['calcTax', 'log'],
    'erFieldsFor does not reach the call rows on a call graph');
  assert.deepEqual(rowsOf('schema', 0, { fields: [{ api_name: 'Email', data_type: 'email' }] }).map((r) => r.api_name),
    ['Email'], 'erFieldsFor stopped returning a module\'s fields');
});

test('nothing user-facing prints a raw node id', () => {
  // The rule is already written down - anything a person reads goes through label(), with the id
  // only as a last resort - and it held by luck: a function's id *is* namespace.name, so it read
  // fine. A workflow's is «wf:501», and the Focus label printed exactly that. Reported.
  const src = read('apps/crm/graphview.js').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /const focusName = \(id\) => \(id && N\[id\] \? label\(N\[id\]\) : \(id \|\| ''\)\)/,
    'the accessor that keeps an id off the screen is gone');
  for (const raw of [/esc\(curFocus\)/, /esc\(DATA\.focus\)/, /\$\{curFocus \|\| 'focus'\}/]) {
    assert.ok(!raw.test(src), `a raw id reaches the screen again: ${raw}`);
  }
});

test('the workspace bar carries the name the user gave it, next to the platform\'s', () => {
  // A list showing only our own words would be one nobody could check against Zoho - the reason the
  // panel keeps both - and the diagram window was showing only the platform's.
  //
  // Both windows now, and that is the half this used to miss: it read the CRM alone, so Analytics
  // could hand its diagram a workspace with no label in it at all - and did, for as long as it has
  // had one. Reported. The line itself is one function in both files, so a fix on one side is a fix
  // on the other by construction rather than by anyone remembering.
  const js = read('apps/crm/sidepanel.js');
  const w = [...js.matchAll(/workspace = \{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(w.length >= 3, 'the graph stopped carrying its workspace');
  for (const one of w) assert.match(one, /label: bound\?\.label/, `a graph is handed over without the workspace name: ${one.slice(0, 60)}`);
  const an = read('apps/analytics/sidepanel.js');
  const aw = [...an.matchAll(/workspace: \{[^}]*\}/g)].map((m) => m[0]).filter((x) => /instance:/.test(x));
  assert.ok(aw.length >= 1, 'id=analytics the graph stopped carrying its workspace');
  for (const one of aw) assert.ok(/label:/.test(one), `id=analytics a graph is handed over without the workspace name: ${one.slice(0, 60)}`);
  for (const app of ['crm', 'analytics']) {
    const gv = read(`apps/${app}/graphview.js`);
    assert.ok(/function wsLine\(ws\)/.test(gv), `${app}: the header line is not the shared function`);
    assert.ok(/ws\.label && ws\.label !== ws\.instance/.test(gv),
      `${app}: the window either ignores the label or prints it beside an identical name`);
  }
});

test('the chips show what is on screen and are switched off, not on', () => {
  // Two reports, one model. First: Workflows, Schedules and Connections are Zoho objects, not kinds
  // of function, and nine identical pills read as one list of nine kinds. Then: with «nothing picked
  // means everything», hiding the connections meant selecting the other eight - working backwards.
  //
  // So every kind starts *on* - the chips are what you are looking at - and clicking one removes it.
  // The conditions are the other question, «narrow to nodes that are also...», and they start off,
  // which is the honest state when none is chosen.
  const css = read('apps/crm/graphview.html');
  assert.match(css, /\.dim\{[^}]*border:1px solid var\(--border\)/, 'the dimensions have no container');
  assert.match(css, /\.dimt\{/, 'the dimensions are not named');
  assert.match(css, /\.dim\.only\{border-style:dashed\}/, 'the conditions look like a kind');

  const N = {
    a: { id: 'a', name: 'a', category: 'standalone', calls: [], called_by: ['x'], rest: false, dead_suspect: false, unresolved: [] },
    b: { id: 'b', name: 'b', category: 'automation', calls: [], called_by: [], rest: false, dead_suspect: true, unresolved: [] },
    c: { id: 'c', name: 'c', category: 'connections', calls: [], called_by: [], rest: false, dead_suspect: true, unresolved: [] },
  };
  const hiddenKinds = new Set(), onlyConds = new Set();
  const ctx = { N, DATA: { kind: 'calls' }, hiddenKinds, onlyConds, Set, Object };
  const { passKind } = load([sliceConst('apps/crm/graphview.js', 'KINDOF'),
                             sliceConst('apps/crm/graphview.js', 'CONDITION_KEYS'),
                             sliceFn('apps/crm/graphview.js', 'passKind')], ctx);
  const shown = () => Object.keys(N).filter((k) => passKind(N[k])).join('');

  assert.equal(shown(), 'abc', 'the default is not everything');
  hiddenKinds.add('connections');
  assert.equal(shown(), 'ab', 'switching a kind off does not remove it - which was the whole point');
  hiddenKinds.clear();
  onlyConds.add('dead');
  assert.equal(shown(), 'bc', 'a condition does not narrow');
  hiddenKinds.add('connections');
  assert.equal(shown(), 'b', 'the two questions are not ANDed');
});

test('the filter can be emptied as well as filled, and says so when it is', () => {
  // Starting from everything is right while reading a result and wrong while hunting for one kind:
  // isolating «standalone» meant switching eight things off, which is the same eight clicks the
  // first model charged for the opposite job. Both directions exist now, and each button is absent
  // when it would do nothing.
  const src = read('apps/crm/graphview.js').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /btn\('chipall'/, 'there is no way back to everything');
  assert.match(src, /btn\('chipnone'[\s\S]*?hiddenKinds = new Set\(allKinds\(\)\)/, 'there is no way to empty it');
  const sync = src.slice(src.indexOf('function syncChips('), src.indexOf('\n}', src.indexOf('function syncChips(')));
  assert.match(sync, /chipall[\s\S]*?hiddenKinds\.size \|\| onlyConds\.size/, 'All is offered when there is nothing to restore');
  assert.match(sync, /chipnone[\s\S]*?hiddenKinds\.size < allKinds\(\)\.length/, 'None is offered when everything is already off');

  // and an empty list names which of the three reasons it is
  const r = src.slice(src.indexOf('function render('), src.indexOf('\n}', src.indexOf('function render(')));
  for (const why of [/Everything is switched off/, /Nothing matches the filter/, /Nothing matches that search/]) {
    assert.match(r, why, `an empty list is silent about one of its reasons: ${why}`);
  }
});

test('the Visual view is gone, and nothing it alone used survives', () => {
  // It was a second, weaker drawing of what the boxed diagram already shows, so it went. What must
  // not go with it is the layout machinery the boxed free branch shares - settle, the position
  // arrays, forceFeasible - which is the whole risk in deleting a view rather than a file.
  const js = read('apps/crm/graphview.js'), html = read('apps/crm/graphview.html');
  for (const dead of ['v-visual', 'vistools', 'visScope', 'visReset', 'fitBtn', 'focusBtn', 'labelBtn',
                      'pdfBtn', 'vistoobig', 'id="cv"', 'id="tip"']) {
    assert.ok(!html.includes(dead), `the markup still carries ${dead}`);
  }
  for (const dead of [/function draw\(/, /function fitView\(/, /function screenXY\(/, /function pick\(/,
                      /curView === 'visual'/, /ctx2d/, /labelMode/, /subFocus/]) {
    assert.ok(!dead.test(js), `dead code from the Visual view survives: ${dead}`);
  }
  // ...and the shared half is still there
  // forceFeasible was on this list and is deliberately not any more: it was folded into the drawing
  // ceiling, which has a case of its own. A list that keeps a retired name alive is the thing this
  // repository has already been bitten by, so it comes off rather than being kept for the shape.
  for (const kept of [/function settle\(/, /const drawable/, /function initPositions\(/, /\bposX\b/]) {
    assert.match(js, kept, `the boxed diagram lost something it shares: ${kept}`);
  }
  // Every $('x') still has an element to find. Ids come from the markup and from the two places the
  // script builds elements - `e.id = ...` in a helper, and the chip row's own children.
  const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1])
    .concat([...js.matchAll(/\.id = '([\w-]+)'/g)].map((m) => m[1]))
    .concat([...js.matchAll(/btn\('([\w-]+)'/g)].map((m) => m[1]))
    // ...and from the markup the script writes into the detail pane and the diagram
    .concat([...js.matchAll(/id="([\w-]+)"/g)].map((m) => m[1])));
  for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) {
    assert.ok(ids.has(m[1]), `$('${m[1]}') has no element - a deletion took its markup`);
  }
  // the three views that remain
  // `[^"]*` ate the X when this was mutated to class="viewX", so it counted a broken view as a view.
  assert.equal([...html.matchAll(/class="view(?: on)?" id="v-/g)].length, 3, 'a view was lost or added');
});

test('a box is as wide as what is written in it', () => {
  // Reported: long headers ran past the edge of a fixed 250px box. Text is measured now, and the
  // measurer makes its own canvas because this window no longer has one.
  const js = read('apps/crm/graphview.js');
  assert.match(js, /function textWidth\(/, 'nothing measures the text');
  assert.match(js, /const BOX_MIN = \d+, BOX_MAX = \d+;/, 'the width has no bounds');
  // Run it rather than read it: asserting that the clamp *appears* passed when the whole expression
  // was left in place behind a `250 ||`, which is the mutation that found this.
  const wide = { name: 'recalculateQuarterlyCommissionForSalesRepresentative', namespace: 'billing', category: 'standalone', calls: [] };
  const narrow = { name: 'log', namespace: 'shared', category: 'standalone', calls: [] };
  const ctx = {
    DATA: { kind: 'calls' }, erEmph: 'modules', erFieldsFor: () => [], label: (n) => n.name,
    KINDOF: (n) => n.category, Math,
    document: { createElement: () => ({ getContext: () => ({ set font(_v) {}, measureText: (t) => ({ width: t.length * 7 }) }) }) },
  };
  const { erBoxSize } = load([sliceConst('apps/crm/graphview.js', 'BOX_MIN'),
                              sliceConst('apps/crm/graphview.js', '_tm'),
                              sliceFn('apps/crm/graphview.js', 'textWidth'),
                              sliceFn('apps/crm/graphview.js', 'erBoxSize')], ctx);
  const w1 = erBoxSize(wide).w, w2 = erBoxSize(narrow).w;
  assert.ok(w1 > w2, `a long name does not widen its box (${w1} vs ${w2})`);
  assert.ok(w2 >= 190, `a short name goes below the minimum (${w2})`);
  assert.ok(w1 <= 460, `a long name is unbounded (${w1})`);
});

test('the filter is reachable from every view, and reaches every view', () => {
  // Reported as «why is there no filter for the connections». There was - the chips - and it lived
  // inside the Explorer column, which exists in one of the four views. So from the diagram, the
  // control that decides what the diagram draws was off screen.
  const html = read('apps/crm/graphview.html');
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.ok(header.includes('id="chips"'), 'the filter is not in the window chrome');
  const aside = html.slice(html.indexOf('<aside>'), html.indexOf('</aside>'));
  assert.ok(!aside.includes('id="chips"'), 'the filter is back inside the one view that has a column');

  const src = read('apps/crm/graphview.js').replace(/^\s*\/\/.*$/gm, '');
  const rp = src.slice(src.indexOf('function relPass('), src.indexOf('\n}', src.indexOf('function relPass(')));
  assert.match(rp, /passKind\(N\[r\.from\]\)/, 'the catalogue ignores the filter');
  // Three views, since Visual is gone: the list, the catalogue and the boxed diagram.
  const af = src.slice(src.indexOf('function applyFilter('), src.indexOf('\n}', src.indexOf('function applyFilter(')));
  for (const v of [/render\(\)/, /relRender\(\)/, /erShowMaybeHeavy\(\)/]) {
    assert.match(af, v, `a view is not redrawn when the filter changes: ${v}`);
  }
  assert.ok(!/id="legend"/.test(html), 'a second colour key is back inside the canvas');
});

test('the call graph carries what fires the code and what the code reaches', async () => {
  // The chain used to stop at functions: a workflow or a schedule that fires one, and a connection
  // one reaches, were known to the panel and drawn nowhere. Everything here is already on disk -
  // nothing is fetched and nothing is inferred.
  const files = {
    'workflows/index.json': JSON.stringify([{ id: 501, name: 'Deal won', module: 'Deals' }, { id: 502, name: 'Never pulled' }]),
    'workflows/501.json': JSON.stringify({ conditions: [
      { instant_actions: { actions: [{ type: 'functions', id: 9, name: 'createInvoice' }, { type: 'email' }] } },
      // `function`, singular: Zoho writes both, and this is the form nine readers used to miss.
      { scheduled_actions: [{ actions: [{ type: 'function', name: 'calcTax' }] }] },
    ] }),
    'schedules/index.json': JSON.stringify([{ id: 77, name: 'Nightly', function_id: 12, function_name: 'nightly', frequency: 'daily' }]),
    'connections/index.json': JSON.stringify([{ name: 'books', label: 'Zoho Books', service: 'zohobooks' }, { name: 'unused', label: 'Legacy' }]),
  };
  const fn = (ns, name, id, conns) => ({ id: ns + '.' + name, name, api_name: name, display_name: name,
    namespace: ns, category: 'standalone', calls: [], called_by: [], rest: false, unresolved: [],
    ambiguous: [], associated_place: null, connections: conns || [] , _zid: id });
  const nodes = {};
  for (const [ns, nm, id, c] of [['billing', 'createInvoice', 9, [{ name: 'books' }]],
                                 ['billing', 'calcTax', 10, []], ['shared', 'nightly', 12, []]]) {
    const n = fn(ns, nm, id, c); n.id2 = id; nodes[n.id] = n;
  }
  // the resolver matches on Zoho's own function id first, then on the name
  nodes['billing.createInvoice'].id = 'billing.createInvoice';
  const ctx = {
    ensureGraph: async () => ({ counts: { nodes: 3, edges: 0, dead_suspects: 3, unresolved: 0 }, nodes }),
    readFile: async (p) => { if (!(p in files)) throw new Error('not on disk'); return files[p]; },
    Object, JSON, Set, Date,
  };
  const { callGraphWithContext } = load([
    sliceConst('apps/crm/sidepanel.js', 'CTX_ID'),
    // Zoho writes both `functions` and `function`; the predicate travels with the function that
    // reads it, or the lift is a ReferenceError three lines in - the free-variable trap again.
    sliceConst('apps/crm/sidepanel.js', 'isFnAction'),
    sliceFn('apps/crm/sidepanel.js', 'ctxNode'),
    sliceFn('apps/crm/sidepanel.js', 'callGraphWithContext')], ctx);

  const g = await callGraphWithContext();
  const ids = Object.keys(g.nodes).sort().join(' ');
  assert.ok(ids.includes('wf:501'), 'a workflow is not a node');
  assert.ok(ids.includes('wf:502'), 'a workflow whose file was never pulled is dropped instead of shown with nothing measured');
  assert.ok(ids.includes('sch:77'), 'a schedule is not a node');
  assert.ok(ids.includes('conn:books') && ids.includes('conn:unused'), 'the connections catalogue is not a node set');

  // the links, in the direction that makes «who calls this» true
  assert.ok(g.nodes['wf:501'].calls.includes('billing.calcTax'), 'a scheduled action of a workflow does not link');
  assert.ok(g.nodes['billing.createInvoice'].called_by.includes('wf:501'), 'the function does not know the workflow fires it');
  assert.ok(g.nodes['sch:77'].calls.includes('shared.nightly'), 'a schedule does not link to the function it runs');
  assert.ok(g.nodes['billing.createInvoice'].calls.includes('conn:books'), 'a function does not link to the connection it uses');
  assert.equal(g.nodes['wf:502'].calls.length, 0, 'a workflow with no file on disk was given actions it never had');

  // and the counts follow the graph that is drawn
  assert.equal(g.counts.nodes, Object.keys(g.nodes).length, 'the node count is of the old graph');
  assert.ok(g.nodes['conn:unused'].dead_suspect, 'a connection nothing uses is not flagged as a candidate');
  assert.ok(!g.nodes['billing.createInvoice'].dead_suspect, 'a function a workflow fires is still called an orphan');
});

test('the diagram window can change subject, and says why when it cannot', async () => {
  // The window carries a context in and could not change its mind without going back to the panel.
  // It has no file access of its own - deliberately, and it stays that way - so the switch asks the
  // panel, which is the only thing holding the folder.
  const sent = [];
  const stat = { innerHTML: '' };
  const seg = ['calls', 'schema'].map((k) => ({ dataset: { k }, sel: null,
    setAttribute(_a, v) { this.sel = v; }, closest() { return this; } }));
  let reloaded = false, alerted = '';
  const box = { children: seg, onclick: null };
  const ctx = {
    document: { getElementById: (id) => (id === 'subj' ? box : null) },
    $: () => stat,
    DATA: { kind: 'calls' },
    chrome: { runtime: { sendMessage: async (m) => { sent.push(m); return { ok: false, error: 'no working folder is open in the panel' }; } } },
    location: { reload: () => { reloaded = true; } },
    alert: (m) => { alerted = m; },
  };
  const { wireSubject } = load([sliceFn('apps/crm/graphview.js', 'wireSubject')], ctx);
  wireSubject();
  assert.equal(seg.map((x) => x.sel).join(' '), 'true false', 'the segment does not mark what is on screen');

  await box.onclick({ target: seg[0] });          // the one already showing
  assert.equal(sent.length, 0, 'clicking the current subject asked the panel to rebuild it');

  await box.onclick({ target: seg[1] });
  assert.equal(sent.length, 1, 'the other subject did not ask for anything');
  assert.equal(sent[0].kind, 'schema');
  assert.equal(reloaded, false, 'it reloaded on a failed switch');
  assert.match(alerted, /no working folder is open in the panel/, 'the panel\'s own reason was swallowed');
  assert.match(alerted, /side panel/, 'the message does not name where the folder lives');
  assert.equal(stat.innerHTML, '', 'the status line was left saying it was building');

  // ...and a switch that works reloads, which is the whole mechanism: every global here was derived
  // from the graph being replaced, and re-deriving them one by one is the half-migrated state this
  // project keeps getting bitten by. Removing the reload passed until this was asserted.
  ctx.chrome.runtime.sendMessage = async () => ({ ok: true });
  const ok = load([sliceFn('apps/crm/graphview.js', 'wireSubject')], ctx);
  ok.wireSubject();
  await box.onclick({ target: seg[1] });
  assert.equal(reloaded, true, 'a successful switch left the old graph on screen');
});

test('the panel refuses to build a graph it cannot read, without asking for a gesture it has not got', async () => {
  // ensurePerm only *asks* when the permission has lapsed, and asking needs a user gesture that a
  // message handler does not have. hasPerm answers without asking, so a lapsed folder stops the
  // switch with a sentence naming the remedy instead of a DOMException naming neither.
  const mk = (over) => Object.assign({
    dir: {}, hasPerm: async () => true,
    callGraphWithContext: async () => ({ counts: { nodes: 3 } }),
    buildSchemaGraph: async () => ({ counts: { nodes: 5 } }),
    chrome: { storage: { local: { set: async () => {} } } },
    setStatus: () => {}, bound: null, lastCtx: null,
  }, over);

  let ctx = mk({});
  let { buildGraphFor } = load([sliceFn('apps/crm/sidepanel.js', 'buildGraphFor')], ctx);
  assert.deepEqual({ ...(await buildGraphFor('schema')) }, { ok: true });

  ctx = mk({ dir: null });
  ({ buildGraphFor } = load([sliceFn('apps/crm/sidepanel.js', 'buildGraphFor')], ctx));
  assert.match((await buildGraphFor('calls')).error, /no working folder/, 'a missing folder is not reported');

  ctx = mk({ hasPerm: async () => false });
  ({ buildGraphFor } = load([sliceFn('apps/crm/sidepanel.js', 'buildGraphFor')], ctx));
  const lapsed = (await buildGraphFor('calls')).error;
  assert.match(lapsed, /re-granting/, 'a lapsed folder does not name the remedy');

  ctx = mk({ callGraphWithContext: async () => ({ counts: { nodes: 0 } }) });
  ({ buildGraphFor } = load([sliceFn('apps/crm/sidepanel.js', 'buildGraphFor')], ctx));
  assert.match((await buildGraphFor('calls')).error, /no functions pulled/, 'an empty graph is handed over as if it were one');
});

test('the call catalogue puts the link first, and its snippet is derived not invented', () => {
  // The Relations tab for modules is one row per related list, with the API name Deluge needs made
  // copyable. For functions it is one row per call, and the copyable thing is the call itself.
  //
  // The form is not guessed: graph-core's CALL_RE - the regex that finds calls in real Deluge
  // sources - matches `namespace.name(`, so that is how one is written, and the parameter names come
  // from the captured meta rather than from a placeholder.
  const N = {
    'billing.createInvoice': { id: 'billing.createInvoice', name: 'createInvoice', namespace: 'billing', calls: ['billing.calcTax', 'shared.log'], category: '' },
    'billing.calcTax': { id: 'billing.calcTax', name: 'calcTax', namespace: 'billing', calls: [], category: '', params: [{ type: 'double', name: 'amount' }, { type: 'double', name: 'rate' }] },
    'shared.log': { id: 'shared.log', name: 'log', namespace: 'shared', calls: [], category: 'automation', params: [{ name: 'message' }] },
  };
  const ctx = { N, label: (n) => n.name, DATA: { kind: 'calls' }, RELS: [], relFilter: 'all', relQ: '', passKind: () => true };
  const { buildCallRels, relSnippet, relPass } = load([
    sliceFn('apps/crm/graphview.js', 'buildCallRels'),
    sliceConst('apps/crm/graphview.js', 'relSnippet'),
    sliceConst('apps/crm/graphview.js', 'relScoped'),
    sliceFn('apps/crm/graphview.js', 'relPass')], ctx);

  buildCallRels();
  // Joined rather than deepEqual: the rows are built inside the vm, so their array carries that
  // realm's prototype and deepStrictEqual rejects it however equal the contents are.
  const rels = ctx.RELS;
  const to = rels.map((r) => r.to).join(' ');
  assert.equal(rels.length, 2, 'one row per call');
  assert.equal(to, 'billing.calcTax shared.log', 'the callees are wrong or unsorted');
  assert.equal(rels.map((r) => r.cross).join(' '), 'false true', 'crossing a namespace is not recorded');

  assert.equal(relSnippet(rels[0]), 'billing.calcTax(amount, rate);', 'the copyable call lost its signature');
  assert.equal(relSnippet(rels[1]), 'shared.log(message);');
  // and it must not have borrowed the schema's snippet
  assert.ok(!/getRelatedRecords/.test(relSnippet(rels[0])), 'a call is being written as a related-list read');

  // No focus, so no neighbourhood to narrow to: this case is about the facets alone. The scoping
  // is exercised on its own, further down.
  ctx.curFocus = null; ctx.egoSet = null; ctx.scopeAll = false;
  ctx.relFilter = 'cross';
  assert.equal(rels.filter(relPass).map((r) => r.to).join(' '), 'shared.log', 'the cross-namespace facet does not filter');
  ctx.relFilter = 'same';
  assert.equal(rels.filter(relPass).map((r) => r.to).join(' '), 'billing.calcTax', 'the same-namespace facet does not filter');
  ctx.relFilter = 'all'; ctx.relQ = 'calctax';
  assert.equal(rels.filter(relPass).length, 1, 'the search does not reach both ends of a call');

  // ...and buildRels has to route to it. The same hole as with erFieldsFor: testing the builder
  // without the line that reaches it let deleting that line pass.
  const c2 = { N, label: (n) => n.name, DATA: { kind: 'calls' }, RELS: [], SYS_REL: /^$/, passKind: () => true };
  const b2 = load([sliceFn('apps/crm/graphview.js', 'buildCallRels'),
                   sliceFn('apps/crm/graphview.js', 'buildRels')], c2);
  b2.buildRels();
  assert.equal(c2.RELS.length, 2, 'buildRels does not reach the call catalogue on a call graph');
  assert.ok(c2.RELS[0].call, 'buildRels built schema rows for a call graph');
});

test('a call graph is never described in the nouns of a schema', () => {
  // Four status lines wrote "modules" and "lookups" literally, so the call graph reported the wrong
  // nouns in three of them. One accessor decides, and nothing else may spell them out.
  const src = read('apps/crm/graphview.js').replace(/^\s*\/\/.*$/gm, '');
  const stat = [...src.matchAll(/\$\('statline'\)\.innerHTML = ([^;]*);/g)].map((m) => m[1]);
  assert.ok(stat.length >= 3, 'the status lines moved - this test has drifted off its target');
  for (const line of stat) {
    assert.ok(!/\bmodules\b|\blookups\b|\bunreferenced\b/.test(line),
      `a status line spells out a schema noun instead of asking NOUN(): ${line.slice(0, 70)}`);
  }
});

test('widening the scope clears, says so, and only then computes', async () => {
  // Reported: clicking «Everything» did nothing for a moment, the window looked hung, and then the
  // finished graph appeared. It is the most expensive thing here and it ran in the click handler.
  // The old drawing is cleared first as well - leaving it up while a different graph is computed is
  // the stale-projection problem in miniature, which this window has already had once.
  const order = [];
  const frames = [];
  const ov = { className: '', innerHTML: '', classList: { add: () => order.push('spinner'), remove: () => order.push('done') },
    querySelector: () => ({ set textContent(_v) {} }), setAttribute() {} };
  const ctx = {
    curFocus: 'a', scopeAll: false, nodesA: new Array(200), SPIN_NODES: 60, curView: 'er',
    // The budget is now asked about what the chips leave standing, and the refusal is one shared
    // sentence rather than a string written here.
    // `drawable` is what setScope asks now - the drawing ceiling, which the old compute budget was
    // folded into - and it is lifted below rather than stubbed, so the test uses the shipped
    // predicate. 200 nodes is
    // over it, so the scope this case widens has to be brought within reach by the chips. 70 sits
    // between the two thresholds on purpose: above SPIN_NODES, so the heavy path with the spinner is
    // the one exercised, and at or below READABLE_MAX_NODES, so the widening is allowed at all. The
    // first attempt used 40 and silently took the light path, which asserted nothing about the order.
    visibleKindCount: () => 70, tooWideToDraw() {},
    N: { a: { id: 'a', name: 'a' } }, label: (n) => n.name,
    bfsEgo: () => order.push('work'), updateDepthUI() {}, updateScopeUI() {}, egoStat() {},
    erLaidOut: true, erShow: () => order.push('draw'), fitView() {}, draw() {},
    $: (id) => (id === 'erboxes' ? { set innerHTML(_v) { order.push('cleared'); } }
                                 : { querySelector: () => ov, appendChild() {} }),
    document: { createElement: () => ov },
    requestAnimationFrame: (f) => frames.push(f),
    NOUN: () => ({ all: 'Everything' }), esc: (x) => x, ctx2d: null, W: 0, H: 0,
  };
  const { setScope } = load([sliceConst('apps/crm/graphview.js', 'DRAW_MAX_NODES'),
                             sliceConst('apps/crm/graphview.js', 'drawable'),
                             sliceConst('apps/crm/graphview.js', 'focusName'),
                             sliceFn('apps/crm/graphview.js', 'runHeavy'),
                             sliceFn('apps/crm/graphview.js', 'setScope')], ctx);
  setScope(true);
  assert.deepEqual([...order], ['cleared', 'spinner'], 'it computed before saying anything');
  frames.shift()(); frames.shift()();
  assert.deepEqual([...order], ['cleared', 'spinner', 'work', 'draw', 'done'], 'the order is wrong');
});

test('the force layout paints its spinner before it blocks, not after', () => {
  // Switching to Visual runs an O(n^2) layout on the main thread - measured at 53ms for 50 nodes,
  // 359ms for 150, 1.4s for 300 and 5.9s at the 600-node cap - and the window simply froze with the
  // previous view still on screen.
  //
  // The trap is that a repaint does not happen inside the task that schedules it, and one
  // requestAnimationFrame is not enough either: that callback runs *before* its frame is painted, so
  // blocking inside it blocks that very frame and the message is never seen. Two rAFs put a full
  // paint in between, and this asserts the order rather than the nesting: the overlay must be marked
  // visible strictly before the work runs.
  for (const app of ['crm', 'analytics']) {
    const order = [];
    const ov = { className: '', innerHTML: '', attributes: {},
      classList: { add: (c) => order.push('show:' + c), remove: (c) => order.push('hide:' + c) },
      querySelector: () => ({ set textContent(_v) {} }), setAttribute() {} };
    const host = { querySelector: () => ov, appendChild() {} };
    const frames = [];
    const ctx = {
      document: { createElement: () => ov },
      requestAnimationFrame: (f) => frames.push(f),
      SPIN_NODES: 150,
    };
    const { runHeavy } = load([sliceFn(`apps/${app}/graphview.js`, 'runHeavy')], ctx);
    runHeavy(host, 'Laying out 300 nodes…', () => order.push('work'));

    assert.deepEqual(order, ['show:on'], `${app}: the work ran before anything was shown`);
    frames.shift()();                       // first frame: still nothing painted
    assert.deepEqual(order, ['show:on'], `${app}: one rAF is not a painted frame`);
    frames.shift()();                       // second frame: a paint has happened
    assert.deepEqual(order, ['show:on', 'work', 'hide:on'], `${app}: the spinner never came down`);
  }
});

test('one click folds the list, and one click brings it back', () => {
  // Reported: after the drag landed, the tab dragged and no longer clicked. `pointerup` folded and
  // the `click` that follows it read the class it had just changed and unfolded again - the two
  // cancelled each other and the control looked dead. Both handlers are exercised here rather than
  // read, because that is the only way this class of bug shows itself.
  for (const app of ['crm', 'analytics']) {
    const on = {};
    const cls = new Set();
    const btn = {
      addEventListener: (t, f) => (on[t] = f), setPointerCapture() {}, releasePointerCapture() {},
      textContent: '', title: '', setAttribute() {},
    };
    const body = { classList: {
      contains: (c) => cls.has(c),
      add: (c) => cls.add(c), remove: (c) => cls.delete(c),
      toggle: (c, v) => (v === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : (v ? cls.add(c) : cls.delete(c))),
    } };
    const ctx = {
      document: { getElementById: () => btn, body, querySelector: () => ({ getBoundingClientRect: () => ({ width: 340 }) }),
                  documentElement: { style: { setProperty() {} } } },
      curView: 'explorer', Math,
    };
    const { wireAsideFold } = load([sliceConst(`apps/${app}/graphview.js`, 'MIN'),
                                    sliceConst(`apps/${app}/graphview.js`, 'KEEP'),
                                    sliceConst(`apps/${app}/graphview.js`, 'DRAG'),
                                    // setFolded writes the control's own label, which lives in MSG
                                    // because it is the aria-label and the title of one element.
                                    sliceConst(`apps/${app}/graphview.js`, 'MSG'),
                                    sliceFn(`apps/${app}/graphview.js`, 'asideWidth'),
                                    sliceFn(`apps/${app}/graphview.js`, 'wireAsideFold')], ctx);
    wireAsideFold();

    const click = (x = 10) => {
      on.pointerdown({ clientX: x, pointerId: 1, preventDefault() {} });
      on.pointerup({ pointerId: 1 });
      if (on.click) on.click({ detail: 1 });          // the browser sends this after every pointerup
    };
    click();
    assert.ok(cls.has('no-aside'), `${app}: one click does not fold the list`);
    click();
    assert.ok(!cls.has('no-aside'), `${app}: a second click does not bring it back`);

    // A real drag is not a click...
    cls.clear();
    on.pointerdown({ clientX: 10, pointerId: 1, preventDefault() {} });
    on.pointermove({ clientX: 90 });
    on.pointerup({ pointerId: 1 });
    if (on.click) on.click({ detail: 1 });
    assert.ok(!cls.has('no-aside'), `${app}: dragging the edge folded the list`);

    // ...and a click with a wobble in it still is. This is the whole reason DRAG exists, and the
    // first version of this test moved 80px, which is a drag with or without the threshold - so
    // removing the threshold altogether passed. Two pixels is what a hand does on the way down.
    cls.clear();
    on.pointerdown({ clientX: 10, pointerId: 1, preventDefault() {} });
    on.pointermove({ clientX: 12 });
    on.pointerup({ pointerId: 1 });
    if (on.click) on.click({ detail: 1 });
    assert.ok(cls.has('no-aside'), `${app}: a click that wobbled two pixels was read as a drag`);
  }
});

test('the list resizes within bounds, and a container with no width is not a bound', () => {
  // The same edge resizes and folds; the clamp is lifted out of the drag so it can be run without a
  // DOM. A container reporting zero width - a hidden or detached pane - would otherwise snap the
  // column to its minimum, which is a measurement being read as a constraint. Found in a preview
  // whose JS context reported innerWidth 0 while the page rendered fine.
  for (const app of ['crm', 'analytics']) {
    const { asideWidth } = load([sliceConst(`apps/${app}/graphview.js`, 'MIN'),
                                 sliceConst(`apps/${app}/graphview.js`, 'KEEP'),
                                 sliceFn(`apps/${app}/graphview.js`, 'asideWidth')], { Math });
    assert.equal(asideWidth(500, 1240), 500, `${app}: a width that fits is not honoured`);
    assert.equal(asideWidth(100, 1240), 220, `${app}: the column can be dragged below its minimum`);
    assert.equal(asideWidth(1200, 1240), 980, `${app}: the detail can be squeezed to nothing`);
    assert.equal(asideWidth(500, 0), 500, `${app}: a container with no width is treated as a constraint`);
    assert.equal(asideWidth(500, 300), 500, `${app}: an impossible bound is applied anyway`);
  }
});

test('the list folds to zero on both sides, min-width included', () => {
  // The rule applied and the panel did not move: `visibility:hidden` from the same declaration took
  // effect while `width:0` was ignored, because a flex item's default `min-width:auto` resolves to
  // its min-content size and floors the width at whatever the search box needs. Nothing errors, and
  // there is no way to see it except by measuring - which is why it is asserted rather than trusted.
  for (const app of ['crm', 'analytics']) {
    const css = read(`apps/${app}/graphview.html`);
    const m = css.match(/body\.no-aside #v-explorer aside\{([^}]*)\}/);
    assert.ok(m, `${app}: the list cannot be folded away`);
    assert.match(m[1], /(^|;)width:0(;|$)/, `${app}: the folded list has no width rule`);
    assert.match(m[1], /min-width:0/, `${app}: width:0 is floored by min-width:auto and nothing happens`);
    // It is a mark, so the name has to live where a screen reader can reach it.
    const btn = css.match(/<button id="asidebtn"[\s\S]*?>/);
    assert.ok(btn && /aria-label="Hide the list"/.test(btn[0]), `${app}: the fold control has no name`);
    assert.match(read(`apps/${app}/graphview.js`), /classList\.toggle\('no-aside'/, `${app}: nothing toggles it`);

    // Explorer only - and by placement, not by a guard. It is a tab on the column, so it sits inside
    // #v-explorer and cannot appear in the three views that have no list. It shipped in all four on
    // the wrong argument ("a control that comes and goes" is the rule about a navigation shape, not
    // about a control whose target is off screen), then behind a check in the view switch, and the
    // markup now makes both unnecessary.
    const view = css.slice(css.indexOf('id="v-explorer"'), css.indexOf('id="v-visual"'));
    assert.ok(view.includes('id="asidebtn"'), `${app}: the fold control is not inside the view it folds`);
  }
});

test('a selection that cannot be projected takes the projections with it', () => {
  // Reported, and caused by the guard added the turn before: refusing to move the focus left the ER
  // diagram showing the previous module while the list said this one. Both halves looked right on
  // their own, which is the worst state a two-pane interface can be in.
  //
  // Disabled, not hidden - click another module and it is back, which is what "temporarily
  // unavailable" means - and if the reader is already looking at one of them, it goes back to
  // Explorer rather than leaving a stale diagram under a new title.
  const tabs = ['explorer', 'visual', 'er', 'rel'].map((v) => ({
    dataset: { v }, title: '', _off: false,
    classList: { toggle(c, on) { if (c === 'off') this.owner._off = on; }, contains: (c) => false },
  }));
  tabs.forEach((t) => (t.classList.owner = t));
  let shown = null;
  const ctx = {
    document: { querySelectorAll: () => tabs },
    N: { Contacts: { id: 'Contacts', api_name: 'Contacts' },
         Invoices: { id: 'Invoices', api_name: 'Invoices', unreadable: { status: 400 } } },
    label: (n) => n.api_name,
    showView: (v) => { shown = v; },
    get curView() { return 'er'; },
    get sel() { return globalThis.__sel; },
  };
  const { updateProjectableTabs } = load([sliceFn('apps/crm/graphview.js', 'updateProjectableTabs')], ctx);

  globalThis.__sel = 'Invoices';
  updateProjectableTabs();
  assert.deepEqual(tabs.map((t) => t._off), [false, true, true, true], 'the projections stayed available');
  assert.match(tabs[2].title, /nothing to draw/, 'the disabled tab does not say why');
  assert.equal(shown, 'explorer', 'the reader was left looking at the previous item\'s diagram');

  shown = null;
  globalThis.__sel = 'Contacts';
  updateProjectableTabs();
  assert.deepEqual(tabs.map((t) => t._off), [false, false, false, false], 'a readable module cannot be drawn either');
  assert.equal(shown, null, 'the view was changed for a module that projects fine');
});

test('a refusal travels into the graph, and is not counted as unreferenced', () => {
  // "Nothing references this" is a measurement, and on a refused module it was never taken - its own
  // fields were not read either, so both directions are unknown rather than empty. Asserted against
  // the source because buildSchemaGraph walks the file system and cannot be lifted; this proves the
  // rule is written, not that it runs, and that limit is why the check above runs its function.
  const src = read('apps/crm/sidepanel.js');
  const graph = src.slice(src.indexOf('async function buildSchemaGraph('), src.indexOf('async function openSchemaFocus('));
  assert.match(graph, /unreadable: m\.unreadable \|\| null/, 'the refusal does not reach the graph');
  assert.match(graph, /dead_suspect = !n\.unreadable && n\.called_by\.length === 0/,
    'a module nobody was allowed to read is being counted as unreferenced');

  // and the two ways in both refuse
  const focus = src.slice(src.indexOf('async function openSchemaFocus('), src.indexOf('async function openSchemaGraph('));
  assert.match(focus, /unreadable/, 'openSchemaFocus still opens an empty diagram');
  const pane = src.slice(src.indexOf('async function openModule('), src.indexOf('\nasync function buildSchemaGraph('));
  assert.match(pane, /const relBar = refusal \? '' :/, 'the ER button is still drawn with nothing to draw');
});

test('a refusal is a 4xx, and everything else stays a failure', () => {
  // The first version wrote `unreadable` on any thrown error, so a dropped connection would have
  // been dated on disk as a settled refusal and the row would have stopped looking retryable for
  // good. Same rule as the per-area access verdicts: only what Zoho actually answered counts.
  const { isRefusal } = load([sliceFn('apps/crm/sidepanel.js', 'isRefusal')]);
  for (const s of [400, 401, 403, 404, 429, 499]) assert.equal(isRefusal(s), true, `${s} is a refusal`);
  for (const s of [0, undefined, null, 200, 500, 502, 503]) assert.equal(isRefusal(s), false, `${s} is not`);
});

test('the refused mark is neutral, and not one the panel uses for "try again"', () => {
  // Reported: the row wore the amber circular arrow, which in this panel means "failed, click to
  // retry" - advertising an action that changes nothing. The mark has to say "no", not "not yet",
  // and it cannot borrow one that already says something else: the hollow circle is "click to
  // download" three tabs away, which is the opposite claim.
  const src = read('apps/crm/sidepanel.js');
  // from the start index, not from zero: the functions list has an `el.querySelector('.st')` of its
  // own further up, and searching from the top sliced an empty string that matched nothing.
  const at = src.indexOf('const ref = moduleRefusal(m.unreadable);');
  assert.ok(at > 0, 'the module row no longer asks moduleRefusal');
  const row = src.slice(at, src.indexOf("el.querySelector('.st')", at));
  // assert.ok, never assert.match, on a haystack this size: match prints the whole `actual` string
  // into the failure, and node 19's TAP lexer dies on a multi-byte character split across a socket
  // read. The test still failed - exit 1 - with a message nobody could read, which is half a test.
  assert.ok(/ref \? '\\u2298'/.test(row), 'the refused row no longer carries its own glyph');
  assert.ok(!/ref \? '\\u27f3'|ref \? '\\u25cb'|ref \? '\\u25d0'/.test(row), 'it borrowed a mark that means something else');
  assert.ok(/ref \? 'st-none'/.test(row), 'the refused row is not neutral');
  const css = read('apps/crm/sidepanel.html');
  assert.ok(/\.st-none\{color:var\(--muted\)\}/.test(css), 'st-none must be legible, not the dim "not here yet" grey');
  assert.ok(!/\.f \.rest\.rx\{[^}]*var\(--warn\)/.test(css), 'the chip still calls for attention');
});

test('a module refusal is explained once in the pane, not once per empty section', () => {
  // Reported with a screenshot: the same sixty-word sentence three times in a 300px pane - the
  // banner, the fields area and the related lists area. A reason repeated under the reason stops
  // reading as an explanation. The banner explains; the sections state their own fact and stop.
  const src = read('apps/crm/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
  // Whole function bodies, found by name and closed on the first `}` in column 1 - the same way the
  // rest of this file slices, and it does not depend on a comment surviving the strip above.
  const body = (name) => {
    const a = src.indexOf(name);
    assert.ok(a >= 0, `${name} is gone - this test has drifted off its target`);
    return src.slice(a, src.indexOf('\n}', a));
  };
  // The detail pane only: the exports and the AI carry it once each, and that is right - a reader
  // of an export cannot come back and ask the panel.
  const pane = body('async function openModule(') + body('function renderFieldsTable(');
  const uses = [...pane.matchAll(/refusal\.text|ref\.text/g)].length;
  assert.equal(uses, 1, `the full refusal is printed ${uses} times in the detail pane`);
});

test('a lapsed permission is reported in words, on both sides', () => {
  // The same sentence, word for word: the remedy is one click and both panels say so rather than
  // leaving the reader to work out that «access not granted» in a dropdown is actionable.
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/sidepanel.js`);
    assert.ok(src.includes('Grant access\\u00bb above, or anywhere in this panel - one click, no folder picker'),
      `${app}: the status line no longer offers the remedy, or the two sides have drifted`);
  }
});

test('the empty state is written in one place, not two', () => {
  // The Analytics markup hard-coded "Nothing pulled yet …" inside #list, and render() produced the
  // same sentence. Fixing the one in the code changed nothing on screen, because the markup copy is
  // what is there at startup — refreshWorkspaces returns early when the folder is not granted and
  // never redraws. The CRM's tree has always been empty in the markup for exactly this reason.
  const html = read('apps/analytics/sidepanel.html');
  const list = html.slice(html.indexOf('<div id="list"'), html.indexOf('</div>', html.indexOf('<div id="list"')) + 6);
  assert.doesNotMatch(list, /Nothing pulled|Pull all|working folder/,
    'the list carries an empty state in the markup, which the code cannot keep true');
});

test('every early return still redraws the list', () => {
  // Otherwise the reason on screen is whichever one was true last.
  const src = read('apps/analytics/sidepanel.js');
  const fn = src.slice(src.indexOf('async function refreshWorkspaces'), src.indexOf('\n}', src.indexOf('async function refreshWorkspaces')));
  const earlies = [...fn.matchAll(/return updateButtons\(\);/g)];
  assert.ok(earlies.length >= 3, 'fewer early returns than expected — check this test still matches');
  for (const m of earlies) {
    const before = fn.slice(Math.max(0, m.index - 60), m.index);
    assert.match(before, /render\(\);\s*$/, 'an early return leaves the previous reason on screen');
  }
});

test('both panels say the same thing when the folder is not granted', () => {
  // The CRM said it only in the status line and Analytics only in the list, so the same state read as
  // two different products. Both now put the same sentence in the same place, and the wording is
  // compared here rather than trusted to stay in step.
  const bodies = ['crm', 'analytics'].map((app) => {
    const src = read(`apps/${app}/sidepanel.js`);
    const i = src.indexOf('function emptyReason()');
    assert.ok(i > 0, `${app}: emptyReason() is gone`);
    return src.slice(i, src.indexOf('\n}', i));
  });
  const sentence = /Folder access is not granted\.<\/b> Press <b>\\u\{1F513\} Grant access<\/b> above/;
  const shortcut = /click anywhere in this panel/;
  for (const [i, b] of bodies.entries()) {
    assert.match(b, sentence, `${['crm', 'analytics'][i]}: the not-granted wording has drifted`);
    assert.ok(!b.includes('permission lapse'),
      `${['crm', 'analytics'][i]}: explains a cause that does not apply on a first install`);
    // The shortcut is real on both — a capture-phase click handler re-grants — and it is faster than
    // reaching for the button, so it is said rather than left to be discovered.
    assert.match(b, shortcut, `${['crm', 'analytics'][i]}: does not mention the click-anywhere shortcut`);
  }
  // and the CRM has to actually draw it — that is why it never appeared
  assert.match(read('apps/crm/sidepanel.js'), /function renderBlocked\(\)/, 'crm: nothing draws the blocker');
});

test('only the first b in an empty state is a heading', () => {
  // `.empty b{display:block}` hit every one, so «Press <b>Grant access</b> above» became its own line
  // and one sentence arrived as four fragments. Reported as the message being misleading, which it
  // was — not by its words but by its shape.
  for (const app of ['crm', 'analytics']) {
    const css = read(`apps/${app}/sidepanel.html`);
    assert.match(css, /\.empty > b:first-child\{[^}]*display:block/, `${app}: the heading rule is gone`);
    assert.ok(!/\.empty b\{[^}]*display:block/.test(css), `${app}: every b in an empty state is a block again`);
  }
});

test('the click-anywhere shortcut exists on both, and stays out of the same places', () => {
  // Saying it in the message is only honest if it is true, and it was true on both — with *different*
  // exclusion lists, neither of them wrong, which is how a divergence survives: both looked
  // deliberate. It is the union now.
  const guards = ['crm', 'analytics'].map((app) => {
    const src = read(`apps/${app}/sidepanel.js`);
    const i = src.indexOf("document.addEventListener('click', async");
    assert.ok(i > 0, `${app}: nothing re-grants on a stray click`);
    return src.slice(i, src.indexOf('}, true);', i));
  });
  for (const [i, g] of guards.entries()) {
    for (const sel of ['#wsroot', '#pfoot', '.dlg', '#aiview', '#offoverlay']) {
      assert.ok(g.includes(`closest('${sel}')`),
        `${['crm', 'analytics'][i]}: a click in ${sel} would ask for permission unprompted`);
    }
  }
});

// ---------- Workflows: the scheduled actions the list endpoint never returns ----------

const { wfScheduled } = load([sliceFn('apps/crm/sidepanel.js', 'wfScheduled')]);

// The shape as Zoho actually returns it, from a real rule (names replaced).
const RULE = {
  last_executed_time: '2026-08-04T09:12:33+02:00',
  conditions: [{
    instant_actions: { actions: [{ name: 'Notify', id: '1', type: 'tasks' }] },
    scheduled_actions: [{
      execute_after: { period: 'minutes', unit: 2 },
      id: '534982000049892294',
      actions: [{ name: 'Do the thing', id: '534982000049892189', type: 'functions' }],
    }],
  }],
};

test('a scheduled action is counted and its delay read', () => {
  const s = wfScheduled(RULE);
  assert.equal(s.count, 1);
  assert.equal(s.delays.join('|'), '2 minutes');
});

test('instant actions are not counted as scheduled', () => {
  // The whole question is "which do NOT run immediately"; counting both would answer a different one.
  assert.equal(wfScheduled({ conditions: [{ instant_actions: { actions: [{ name: 'a' }, { name: 'b' }] } }] }).count, 0);
});

test('several buckets across several conditions add up, and each delay is named once', () => {
  const s = wfScheduled({ conditions: [
    { scheduled_actions: [{ execute_after: { period: 'hours', unit: 1 }, actions: [{ name: 'a' }, { name: 'b' }] }] },
    { scheduled_actions: [{ execute_after: { period: 'hours', unit: 1 }, actions: [{ name: 'c' }] },
                          { execute_after: { period: 'days', unit: 3 }, actions: [{ name: 'd' }] }] },
  ] });
  assert.equal(s.count, 4);
  assert.equal(s.delays.join('|'), '1 hours|3 days');
});

test('a rule with no conditions, and a rule that is not there at all, are zero rather than a throw', () => {
  // It is called on `w.detail`, which is null for a workflow nobody has downloaded yet. Throwing
  // there would take the whole list render down with it.
  assert.equal(wfScheduled({}).count, 0);
  assert.equal(wfScheduled(null).count, 0);
  assert.equal(wfScheduled(undefined).count, 0);
});

test('scheduled_actions as an object rather than an array is ignored, not half-read', () => {
  // Zoho returns an array here; the panel has always guarded the shape elsewhere, and a bucket that
  // is not an array must not be counted as one action by accident.
  assert.equal(wfScheduled({ conditions: [{ scheduled_actions: { actions: [{ name: 'a' }] } }] }).count, 0);
});

test('a bucket with no execute_after still counts its actions', () => {
  const s = wfScheduled({ conditions: [{ scheduled_actions: [{ actions: [{ name: 'a' }] }] }] });
  assert.equal(s.count, 1);
  assert.equal(s.delays.length, 0);
});

// ---------- The workspace layout on disk ----------

test('no shipped script writes a folder with a leading underscore', () => {
  // The underscore was never a convention: it existed only so a folder the pull creates could not
  // collide with a Deluge namespace, because namespaces sat in the workspace root. Functions live
  // under functions/ now, so the collision is gone and so is the reason. A new one creeping back in
  // would be a third naming rule in a layout that has just been reduced to one.
  for (const f of ['apps/crm/sidepanel.js', 'apps/analytics/sidepanel.js', 'apps/crm/content-bridge.js']) {
    const src = read(f);
    const hits = [...src.matchAll(/['"`]_[a-z]+\//g)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${f} still names an underscore folder: ${hits.join(', ')}`);
  }
});

test("every per-kind index is <kind>/index.json, and both apps agree on the name", () => {
  const crm = read('apps/crm/sidepanel.js');
  for (const kind of ['functions', 'modules', 'modules/layouts', 'workflows', 'schedules', 'connections']) {
    assert.ok(crm.includes(`'${kind}/index.json'`), `${kind} has no ${kind}/index.json`);
  }
  // The twin: one index file, named the same way, so the two products read alike on disk.
  assert.ok(read('apps/analytics/sidepanel.js').includes('sql/index.json'));
  assert.ok(!read('apps/analytics/sidepanel.js').includes('sql/_index.json'));
});

test('functions are written under functions/<namespace>/, not in the workspace root', () => {
  const src = read('apps/crm/sidepanel.js');
  assert.ok(src.includes('`functions/${f.folder}/${f.stem}.dg`'), 'the sync path is not under functions/');
  assert.ok(src.includes('`functions/${f.folder}/${f.stem}.meta.json`'), 'the sidecar is not under functions/');
  assert.ok(!/[^/]\$\{f\.folder\}\/\$\{f\.stem\}\.dg/.test(src.replace(/functions\/\$\{f\.folder\}/g, 'X')),
    'a path still writes a namespace folder at the root');
});

test('the old layout is reported, never read', () => {
  // No reader knows the old paths — that is the point. What exists is an empty state that names the
  // real reason, so a workspace full of files does not report "nothing pulled yet".
  const src = read('apps/crm/sidepanel.js');
  assert.match(src, /OLD_DIRS = \['_index', '_modules', '_layouts', '_workflows', '_schedules', '_connections'\]/);
  assert.match(src, /This workspace uses the old folder layout/);
  const readers = [...src.matchAll(/readFile\(\s*[`'"]_/g)];
  assert.deepEqual(readers.map((m) => m[0]), [], 'something still reads an old-layout path');
});

// ---------- Switching workspace drops what belonged to the old one ----------

test('both panels drop the conversation when the workspace changes', () => {
  // The chat's own replies name functions, views and connections from the org you have just left,
  // and the whole thread is re-sent with every message — so the model was being asked to reason
  // about two orgs at once, with nothing marking the boundary. Reported by the user.
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/sidepanel.js`);
    assert.match(src, /function dropWorkspaceState\(\)/, `${app} has no dropWorkspaceState`);
    assert.match(src, /aiMessages = \[\]; aiSeedWarned = false;/, `${app} does not reset both`);
    assert.ok(/if \(!sameWs\) \{\s*const n = dropWorkspaceState\(\)/.test(src),
      `${app} does not call it when the workspace changes`);
    // ...and the interface goes with the data. Reported: with Health open, switching workspace
    // changed nothing on screen - the switch rebuilds the list under an overlay covering it - and a
    // search term typed for one org went on narrowing the next. Two functions on purpose: Clear in
    // the chat calls the first and must not empty the reader's search box.
    assert.ok(/function resetView\(\)/.test(src), `${app} has no resetView`);
    assert.ok(/if \(!sameWs\)[\s\S]{0,200}resetView\(\)/.test(src),
      `${app} does not reset the interface when the workspace changes`);
    for (const part of [/\$\('find'\)\.value = ''/, /healthview'\)\.classList\.contains\('show'\)/]) {
      assert.ok(part.test(src.slice(src.indexOf('function resetView()'))), `${app}: resetView leaves ${part} behind`);
    }
  }
});

test('re-activating the same workspace keeps the conversation', () => {
  // Regranting a lapsed folder permission re-runs activate/selectWorkspace for the workspace you are
  // already in. Clearing there would throw away a conversation about the org you never left.
  for (const app of ['crm', 'analytics']) {
    assert.match(read(`apps/${app}/sidepanel.js`), /const sameWs = /, `${app} does not compare first`);
  }
});

test("the CRM's per-org caches are dropped there too, not only in the Functions tab", () => {
  // graphCache, aiModCache and aiConnCache were cleared in rebuildTree(), which only runs if you
  // happen to be on Functions. Switch workspace from the Workflows tab and the assistant answered
  // from the previous org's functions and schema, with no sign of it anywhere.
  const src = read('apps/crm/sidepanel.js');
  const fn = src.slice(src.indexOf('function dropWorkspaceState()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const c of ['graphCache = null', 'aiModCache = null', 'aiConnCache = null']) {
    assert.ok(body.includes(c), `dropWorkspaceState does not clear ${c}`);
  }
});

test('Clear and switching workspace go through the same function', () => {
  // Two ways to empty the chat that reset different things is how the large-index warning came back
  // on one path and not the other. The twins had already drifted on exactly that.
  for (const app of ['crm', 'analytics']) {
    assert.match(read(`apps/${app}/sidepanel.js`), /function aiClear\(\)[^\n]*dropWorkspaceState\(\);/,
      `${app}: aiClear does not use the shared helper`);
  }
});

test('a layout lives under the module it describes, and the walks tell the two apart', () => {
  // layouts/ started as a sibling of modules/ because eight walks each said "a .json under modules/
  // is one module" and nesting anything inside would have needed a guard in every one of them — a
  // folder shape chosen to protect the code from a mistake I had just made, which is the wrong
  // direction. One named predicate, and the objection goes away; a layout is a property of a module
  // and now sits under it.
  const src = read('apps/crm/sidepanel.js');
  assert.match(src, /const isModuleFile = /);
  assert.match(src, /const isLayoutFile = /);
  assert.ok(!/p\.startsWith\('layouts\//.test(src), 'layouts/ is still addressed as a top-level folder');
  assert.ok(src.includes("'modules/layouts/index.json'"), 'the layout index did not move');

  // and the predicates actually separate the four cases
  const isModuleFile = (p) => p.startsWith('modules/') && p.endsWith('.json')
    && !p.startsWith('modules/layouts/') && p !== 'modules/index.json';
  const isLayoutFile = (p) => p.startsWith('modules/layouts/') && p.endsWith('.json')
    && p !== 'modules/layouts/index.json';
  assert.ok(isModuleFile('modules/Contacts.json'));
  assert.ok(!isModuleFile('modules/index.json'), 'the index would be parsed as a module');
  assert.ok(!isModuleFile('modules/layouts/Contacts.json'), 'a layout would be parsed as a module');
  assert.ok(isLayoutFile('modules/layouts/Contacts.json'));
  assert.ok(!isLayoutFile('modules/layouts/index.json'));
});

// ---------- The mark ----------

test('the Z is one stroked path, not three shapes butted together', () => {
  // Reported after seeing it big: the strokes were visibly separate pieces meeting by accident. It
  // was three shapes - two rects with their own corner radius and a polygon whose thickness was
  // defined by horizontal offsets, so the diagonal came out at three quarters of the bars' weight
  // and the corners had notches. A stroked centreline gives one weight everywhere and real joins by
  // construction, so it cannot drift back by careless drawing.
  for (const f of ['apps/crm/icons/icon.svg', 'apps/analytics/icons/icon.svg', 'site/icon.svg']) {
    const svg = read(f);
    const paths = [...svg.matchAll(/<path\b/g)].length;
    assert.equal(paths, 1, `${f}: the mark should be exactly one path`);
    assert.equal([...svg.matchAll(/<polygon\b|<circle\b|<line\b/g)].length, 0,
      `${f}: something other than the tile and the path is being drawn`);
    // exactly one rect: the tile
    assert.equal([...svg.matchAll(/<rect\b/g)].length, 1, `${f}: more than the tile is a rect`);
    assert.match(svg, /stroke-width="18"/, `${f}: the weight moved`);
    assert.match(svg, /stroke-linejoin="round"/, `${f}: miter joins spike past the tile on a Z`);
    // Not butt. A butt cap stops on the endpoint while a round join bulges half a stroke past the
    // vertex, so the two horizontals ended 9px out of register with each other - the corner not
    // lining up with the bar opposite it, which is the first thing you see at poster size. A square
    // cap extends by the same half stroke the join does, so all four extremities land together.
    assert.doesNotMatch(svg, /stroke-linecap="butt"/,
      `${f}: a butt cap leaves the capped ends 9px short of the joined ones`);
    assert.match(svg, /stroke-linecap="(square|round)"/, `${f}: the caps must extend like the joins`);
    assert.match(svg, /fill="none"/, `${f}: a filled path is not a stroke`);

    // Square, because he looked at it large and said it was wider than tall. It was: 80 x 74, a
    // 7.9% difference, measured off the render rather than argued about. Derived from the path so
    // that moving a number is caught, not from a comment restating it: the extent on each axis is
    // the centreline span plus a whole stroke, since a square cap and a round join both extend by
    // half of one - which is why this test only makes sense next to the cap rule above it.
    const pts = [...read(f).matchAll(/[ML] (\d+) (\d+)/g)].map((m) => [+m[1], +m[2]]);
    assert.equal(pts.length, 4, `${f}: the mark is no longer four points`);
    const span = (i) => Math.max(...pts.map((q) => q[i])) - Math.min(...pts.map((q) => q[i]));
    assert.equal(span(0), span(1), `${f}: the Z is ${span(0) + 18} x ${span(1) + 18}, not a square`);
    // and centred in the 128 tile, or a square box still sits off to one side
    for (const i of [0, 1]) {
      const lo = Math.min(...pts.map((q) => q[i])) - 9, hi = Math.max(...pts.map((q) => q[i])) + 9;
      assert.equal(lo + hi, 128, `${f}: axis ${i} runs ${lo}..${hi}, which is not centred on 64`);
    }
  }
});

test('the three marks share one geometry and differ only in hue', () => {
  // At 16px in a toolbar the hue is the only thing that still carries, so it has to be the thing
  // doing the work - and the geometry has to be identical or one reads as a worse drawing of the
  // other.
  const geom = (f) => read(f).replace(/fill="#[0-9a-f]{6}"/gi, 'fill="X"').replace(/<!--[\s\S]*?-->/g, '');
  const a = geom('apps/crm/icons/icon.svg');
  assert.equal(geom('apps/analytics/icons/icon.svg'), a, 'Analytics differs by more than its hue');
  assert.equal(geom('site/icon.svg'), a, 'the suite mark differs by more than its hue');
  const hues = ['apps/crm/icons/icon.svg', 'apps/analytics/icons/icon.svg', 'site/icon.svg']
    .map((f) => read(f).match(/<rect[^>]*fill="(#[0-9a-f]{6})"/i)[1]);
  assert.equal(new Set(hues).size, 3, 'two marks share a hue, so nothing tells them apart');
});

test('a filter changes the graph, not only what is painted of it', () => {
  // Reported: switching a category off in a large graph removed a big share of the boxes and the
  // drawing stayed exactly as large, so nothing became more readable. The layout was computed once
  // for every node and latched behind a boolean; filtering then drew a subset of a diagram laid out
  // for a set it no longer was.
  const src = read('apps/crm/graphview.js').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\blet\b[^\n]*\blaidOut\b\s*=\s*false/.test(src), 'the layout still latches behind a boolean');
  assert.ok(/laidOutKey/.test(src), 'nothing records which set the positions belong to');
  const er = src.slice(src.indexOf('function erLayout('), src.indexOf('\n}', src.indexOf('function erLayout(')));
  assert.ok(/const key = erIds\.join/.test(er), 'the key is not derived from the set on screen');
  assert.ok(/seedRing\(erIds\)[\s\S]*?settle\(erIds, edgesAmong\(erIds\)\)/.test(er),
    'the layout is still computed for every node rather than for the ones being drawn');
  // The ceiling used to be asked here, about erIds.length. It is asked one level up now, in erShow,
  // about erVisibleIds().length - which is the same protection in the place that can act on it: a
  // budget asked about the whole org rather than about what is being drawn is one that filtering
  // cannot bring within reach, and that was the defect this line was written for.
  const sh = src.slice(src.indexOf('function erShow('), src.indexOf('function erShow(') + 400);
  assert.ok(/erVisibleIds\(\)\.length/.test(sh) && /drawable\(/.test(sh),
    'the ceiling is asked about the whole graph, so filtering cannot bring it within reach');

  // and the chips have to reach the layout at all
  const af = src.slice(src.indexOf('function applyFilter('), src.indexOf('\n}', src.indexOf('function applyFilter(')));
  assert.ok(/erLaidOut = false/.test(af), 'a chip change does not invalidate the layout');
  assert.ok(/statRefresh\(\)/.test(af), 'the counts do not follow the filter');
});

test('the force layout carries the structure instead of drawing a ring', () => {
  // Measured, not argued: on a 728-node graph the old spring model put **100% of the boxes on its
  // own clamp radius** - a circle - and the mean edge came out as long as the distance between two
  // nodes picked at random. A drawing that says nothing about what is connected to what.
  //
  // The replacement is Fruchterman-Reingold, whose two forces are derived from one ideal distance
  // rather than from three constants tuned at about fifty nodes.
  const src = read('apps/crm/graphview.js');
  const s = src.slice(src.indexOf('function settle('), src.indexOf('\n}', src.indexOf('function settle(')));
  assert.ok(!/maxR/.test(s), 'the radius clamp is back, and it is what made the layout a circle');
  assert.ok(/Math\.sqrt\(area \/ n\)/.test(s), 'the ideal distance is not derived from the area');
  assert.ok(/Float64Array/.test(s), 'the O(n^2) loop is back on string-keyed objects');
  assert.ok(/t -= cool/.test(s), 'nothing cools the displacement, so it never settles');
  // it lays out what it is given, and only that
  assert.ok(/function settle\(list, edges\)/.test(src), 'settle no longer takes the set to lay out');
  assert.ok(!/\bnodesA\b/.test(s) && !/\bedgesA\b/.test(s), 'settle still reaches for the whole graph');
});

test('the layout is reproducible: the same set comes out the same way', () => {
  // The starting ring used Math.random(), so switching a chip off and back on rearranged a diagram
  // the reader had already learnt. Hashed per id instead - which also makes the PDF reproducible.
  const src = read('apps/crm/graphview.js');
  const seed = src.slice(src.indexOf('function seedRing('), src.indexOf('\n}', src.indexOf('function seedRing(')));
  assert.ok(!/Math\.random/.test(seed), 'the ring is seeded randomly, so the same filter draws differently');
  const { jitter } = load([sliceFn('apps/crm/graphview.js', 'jitter')], { Math });
  assert.equal(jitter('ns.alpha', 'x'), jitter('ns.alpha', 'x'), 'the scatter is not a function of the id');
  assert.notEqual(jitter('ns.alpha', 'x'), jitter('ns.alpha', 'y'), 'both axes get the same offset');
  assert.notEqual(jitter('ns.alpha', 'x'), jitter('ns.beta', 'x'), 'two nodes get the same offset');
  for (const id of ['a', 'ns.some.long.name', 'wf:12', 'conn:c3']) {
    assert.ok(Math.abs(jitter(id, 'x')) <= 20, `${id} is scattered outside the ring's own width`);
  }
});

test('a status line counts what is on screen, on both sides of the window', () => {
  // A line reading 900 nodes over a diagram drawing 200 is the same defect as a diagram that does
  // not shrink when filtered: a number that is not about what is being looked at. And it is counted
  // from the graph, never from the layout arrays - those are filled later, which is why the schema
  // side alone reported «0 of 90 modules» while the call graph was right.
  const src = read('apps/crm/graphview.js');
  const sc = src.slice(src.indexOf('function statCounts('), src.indexOf('\n}', src.indexOf('function statCounts(')));
  assert.ok(!/\bnodesA\b/.test(sc), 'the counts read layout state that is empty when the line is first written');
  assert.ok(/passKind/.test(sc), 'the counts ignore the chips');

  const N = {
    a: { id: 'a', name: 'a', category: 'standalone', calls: ['b'], called_by: [], rest: false, dead_suspect: false, unresolved: [] },
    b: { id: 'b', name: 'b', category: 'standalone', calls: [], called_by: ['a'], rest: false, dead_suspect: false, unresolved: [] },
    c: { id: 'c', name: 'c', category: 'connections', calls: [], called_by: [], rest: false, dead_suspect: false, unresolved: [] },
  };
  const hiddenKinds = new Set(), onlyConds = new Set();
  const ctx = { N, DATA: { kind: 'calls' }, hiddenKinds, onlyConds, Set, Object };
  const { statCounts } = load([sliceConst('apps/crm/graphview.js', 'KINDOF'),
                               sliceConst('apps/crm/graphview.js', 'CONDITION_KEYS'),
                               sliceFn('apps/crm/graphview.js', 'passKind'),
                               sliceFn('apps/crm/graphview.js', 'statCounts')], ctx);
  assert.deepEqual([statCounts(null).n, statCounts(null).e], [3, 1], 'the unfiltered counts are wrong');
  hiddenKinds.add('connections');
  assert.deepEqual([statCounts(null).n, statCounts(null).e], [2, 1], 'switching a kind off does not change the count');
  hiddenKinds.add('standalone');
  assert.deepEqual([statCounts(null).n, statCounts(null).e], [0, 0], 'an edge survives both its ends being hidden');
});

test('Relations is the third projection of the focus, not a catalogue beside it', () => {
  // Reported: selecting an item in Explorer and clicking Relations showed the whole table, so the
  // selection looked as though it had done nothing. Explorer and the diagram had shared a focus for
  // a long time; the table never joined them.
  const N = { a: {}, b: {}, c: {} };
  const ctx = { N, curFocus: 'a', egoSet: new Set(['a', 'b']), scopeAll: false, relFilter: 'all', relQ: '' };
  const { relPass, relScoped } = load([sliceConst('apps/crm/graphview.js', 'relScoped'),
                                       sliceFn('apps/crm/graphview.js', 'relPass')],
    Object.assign(ctx, { passKind: () => true, Set }));
  assert.ok(relScoped(), 'a focus with a neighbourhood does not scope the table');
  assert.equal(relPass({ call: true, from: 'a', to: 'b' }), true, 'a call inside the neighbourhood is dropped');
  assert.equal(relPass({ call: true, from: 'a', to: 'c' }), false, 'a call leaving the neighbourhood is kept');
  // a related list with no child module is still about its parent
  assert.equal(relPass({ parent: 'b', child: null, via: '', api: '', label: '' }), true,
    'an absent end is read as being outside the neighbourhood');
  assert.equal(relPass({ parent: 'c', child: null, via: '', api: '', label: '' }), false,
    'a relation outside the neighbourhood is kept');

  // The way out is the focus group in the header - the one control, not a second one. This table
  // carried a «show all» of its own while the focus lived inside the diagram; once the group moved
  // to the chrome it became a duplicate switch for a single state, which is what its own comment
  // had been written to avoid.
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/graphview.js`).replace(/^\s*\/\/.*$/gm, '');
    const rr = src.slice(src.indexOf('function relRender('), src.indexOf('\n}', src.indexOf('function relRender(')));
    assert.ok(!/relall/.test(rr), `${app}: the table still carries a second control for the scope`);
    // ...but it still says which of the four things narrowed it
    assert.ok(/relScoped\(\)[\s\S]{0,60}focus neighbourhood/.test(rr),
      `${app}: «N of M» does not say the focus is why`);
  }
});

test('the diagram lends its layout budget to nobody, and says so when it declines', () => {
  // «show all» beside the row count did nothing on a large org: setScope refused before setting the
  // state because the *diagram* could not lay that many out - a table pays no such cost. The limit
  // belongs where the cost is, and the diagram re-asserts it for itself rather than blocking a view
  // that was never going to be slow.
  const src = read('apps/crm/graphview.js').replace(/^\s*\/\/.*$/gm, '');
  const ss = src.slice(src.indexOf('function setScope('), src.indexOf('\n}', src.indexOf('function setScope(')));
  // The limit it keeps to itself is the *readability* one now. That is the same case one layer on:
  // borrowing the compute budget here is what let a 1200-node hairball be drawn at all, and borrowing
  // either of them for the Relations table is what made «show all» do nothing.
  assert.ok(/curView === 'er' && !drawable/.test(ss), 'the table is refused a scope it can afford');
  const es = src.slice(src.indexOf('function erShow('), src.indexOf('\n}', src.indexOf('function erShow(')));
  assert.ok(/scopeAll[\s\S]{0,120}drawable[\s\S]{0,160}tooWideToDraw/.test(es),
    'the diagram draws a scope it cannot lay out, or drops it without saying so');
  // one sentence, one function - it is stated in two places and must not be written twice
  assert.equal((src.match(/too many to lay out all at once/g) || []).length, 1,
    'the refusal is worded in more than one place');
});

test('the functions drawing has one name, and the code does not write the old one back', () => {
  // Renamed to «Graph», and it stayed «Call graph» because the markup said one thing and this line
  // wrote the other over it on every open - the trap this repository already records about labels
  // that live in the markup and are rebuilt by the code that updates state. It reached the user
  // twice, which is the failure.
  const js = read('apps/crm/graphview.js');
  // Into `#ertabname`, not onto the tab itself: the tab carries the count beside the name now, and
  // `textContent` on the parent would wipe it out on every open - which is this same trap, one element
  // up, and is why the assertion names the child rather than being relaxed to match either.
  assert.ok(/\$\('ertabname'\)\.textContent = _schema \? 'ER diagram' : 'Wiring'/.test(js),
    'the tab is not labelled from code with the name the panel opens it under');
  assert.ok(!/\$\('ertab'\)\.textContent/.test(js),
    'the tab label is written over the whole tab, which takes the count with it');
  // and nowhere a control is named may the old name survive - a third name is worse than either
  for (const f of ['apps/crm/graphview.html', 'apps/crm/sidepanel.html', 'apps/crm/sidepanel.js',
                   'apps/crm/product-help.js', 'apps/crm/graphview.js']) {
    const named = read(f).split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .filter((l) => /aria-label="Call graph"|title="Call graph|>Call graph<|'Call graph'|"Call graph"/.test(l));
    assert.deepEqual(named, [], `${f} still names a control Call graph`);
  }
});

test('every element the diagram window reaches for is in its own markup', () => {
  // This is the check that would have caught it on its own. Removing the Visual view from Analytics
  // left `$('visScope').onclick = …` at the top level of the script: $() returned null, assigning to
  // .onclick threw, and **the whole file stopped evaluating there** - so every const below it stayed
  // in its temporal dead zone and the window came up with no chips, no list and a status line still
  // holding the text from the markup. Nothing in the console, because the page had already loaded.
  //
  // The ids listed here are the ones built at runtime rather than authored, and they are named
  // rather than pattern-matched so that adding one is a decision.
  const RUNTIME = new Set(['back', 'chipall', 'chipnone', 'down', 'erpicksnip', 'layzone', 'up']);
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/graphview.js`), html = read(`apps/${app}/graphview.html`);
    const have = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g), ...js.matchAll(/getElementById\('([^']+)'\)/g)]
      .map((m) => m[1]));
    const missing = [...used].filter((id) => !have.has(id) && !RUNTIME.has(id)).sort();
    assert.deepEqual(missing, [], `${app}: graphview.js reaches for ids that no longer exist`);
  }
});

test('every element the side panel reaches for is in its own markup', () => {
  // The same check as the one above, on the file it was never pointed at. It earned that immediately:
  // a `$('healthpull').onclick = …` was added at the top level while the markup for it had failed to
  // be written, so the assignment threw, **the whole panel stopped evaluating there**, and the panel
  // came up saying «No workspace.» over a fixture that was right in front of it. `node --check` is
  // happy with all of that; only running it, or this, finds it.
  // Named rather than pattern-matched, so adding one is a decision - the same rule as the diagram
  // window's list above. Five are built into innerHTML by the module detail pane and wired straight
  // after; `pvfailgo` is the same shape in the failures block; and `q` is not in this document at
  // all - it is the search box of the **exported HTML report**, written into a <script> string for a
  // file that opens somewhere else entirely.
  const RUNTIME = new Set(['laybody', 'laymod', 'laysel', 'pvfailgo', 'reldepth', 'relopen', 'q']);
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`), html = read(`apps/${app}/sidepanel.html`);
    const have = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g), ...js.matchAll(/getElementById\('([^']+)'\)/g)]
      .map((m) => m[1]));
    const missing = [...used].filter((id) => !have.has(id) && !RUNTIME.has(id)).sort();
    assert.deepEqual(missing, [], `${app}: sidepanel.js reaches for ids that no longer exist`);
  }
});

test('the Visual view is gone from Analytics too, and the shared machinery is not', () => {
  // It went from the CRM when it turned out to be a weaker drawing of what the boxed diagram already
  // shows. Leaving it on one side made the twins two different products in the window they share.
  const js = read('apps/analytics/graphview.js'), html = read('apps/analytics/graphview.html');
  for (const dead of ['v-visual', 'vistools', 'visScope', 'visReset', 'fitBtn', 'focusBtn', 'labelBtn',
                      'id="cv"', 'id="tip"', 'data-v="visual"']) {
    assert.ok(!html.includes(dead), `the markup still carries ${dead}`);
  }
  for (const dead of [/function draw\(/, /function fitView\(/, /function screenXY\(/, /function pick\(/,
                      /function nodeRadius\(/, /function initCanvas\(/, /function buildLegend\(/,
                      /function updateTopTools\(/, /labelMode/, /subFocus/]) {
    assert.ok(!dead.test(js), `Analytics still carries ${dead}`);
  }
  // ...and what the boxed diagram shares with it must have survived the deletion
  for (const kept of ['function settle(', 'function seedRing(', 'function initPositions(',
                      'const drawable', 'const edgesAmong', 'function erLayout(']) {
    assert.ok(js.includes(kept), `the deletion took ${kept} with it`);
  }
});

test('the diagram never draws a box with nothing left to link it', () => {
  // Reported: switching a kind off left behind every node whose only links went into it - boxes with
  // no arrow at all, in a window whose whole subject is what connects to what. One pass is the whole
  // cascade: dropping nodes with no surviving edge cannot remove an edge between two that have one.
  for (const app of ['crm', 'analytics']) {
    const N = {
      a: { id: 'a', category: 'standalone', namespace: 'standalone', calls: ['b'], called_by: [], rest: false, dead_suspect: false, unresolved: [], system: false },
      b: { id: 'b', category: 'standalone', namespace: 'standalone', calls: [], called_by: ['a'], rest: false, dead_suspect: false, unresolved: [], system: false },
      c: { id: 'c', category: 'automation', namespace: 'query', calls: ['d'], called_by: [], rest: false, dead_suspect: false, unresolved: [], system: false },
      d: { id: 'd', category: 'standalone', namespace: 'standalone', calls: [], called_by: ['c'], rest: false, dead_suspect: false, unresolved: [], system: false },
    };
    const kindOf = app === 'crm' ? 'category' : 'namespace';
    const edgesA = [['a', 'b'], ['c', 'd']];
    const hiddenKinds = new Set(), onlyConds = new Set();
    // Analytics reads the namespace, and it only does so on a schema - which is the only kind it
    // ever builds. The CRM reads the category on a call graph. Same predicate, two vocabularies.
    // egoSet null: this case is about the chips alone. The neighbourhood is exercised on its own,
    // further down - it was the half that let orphans back in.
    const ctx = { N, edgesA, DATA: { kind: app === 'crm' ? 'calls' : 'schema' },
                  hiddenKinds, onlyConds, egoSet: null, Set, Object };
    const { linkedUnderFilter } = load([sliceConst(`apps/${app}/graphview.js`, 'KINDOF'),
                                        sliceConst(`apps/${app}/graphview.js`, 'CONDITION_KEYS'),
                                        sliceFn(`apps/${app}/graphview.js`, 'passKind'),
                                        sliceConst(`apps/${app}/graphview.js`, 'erCandidate'),
                                        sliceFn(`apps/${app}/graphview.js`, 'linkedUnderFilter')], ctx);
    assert.equal([...linkedUnderFilter()].sort().join(''), 'abcd', `${app}: an unfiltered graph already drops something`);
    // switch off the kind `c` belongs to: d loses its only link and must go with it
    hiddenKinds.add(N.c[kindOf]);
    assert.equal([...linkedUnderFilter()].sort().join(''), 'ab', `${app}: d is drawn with nothing to link it`);
  }
});

test('the two diagram limits are the measurements, and neither is doing the other one job', () => {
  // They were one number, twice over, and both times it was the wrong one. FORCE_MAX_NODES was a
  // compute budget at 1200 and it gated *readability*, so a 1200-node hairball was drawn. Then a
  // readability limit at 80 gated *drawing*, so any org with more than eighty functions in one
  // category could never see the whole-org view at all - worse than a crowded picture.
  //
  // So: DRAW_MAX_NODES blocks and is measured on cost - 200 nodes lay out in 0.5s, 400 in 1.3s, 600
  // in 2.2s, 1200 in 7.2s, profiled against the collision pass as it now stands, and layout only
  // because headless Chrome cannot time the DOM (virtual time advances the clock). Two seconds is a
  // wait and seven is a hang, so 400 is the largest round size measured under two. CROWDED_NODES
  // advises and is measured on quality - five generated graphs per size come out with no box covering
  // another up to 80. Moving either means measuring that one again.
  const d = (app) => +read(`apps/${app}/graphview.js`).match(/const DRAW_MAX_NODES = (\d+)/)[1];
  const c = (app) => +read(`apps/${app}/graphview.js`).match(/const CROWDED_NODES = (\d+)/)[1];
  const s2 = (app) => +read(`apps/${app}/graphview.js`).match(/const SPIN_NODES = (\d+)/)[1];
  assert.equal(d('crm'), 400, 'the ceiling moved without the profile moving');
  assert.equal(c('crm'), 80, 'the crowding line moved without the measurement moving');
  assert.equal(d('crm'), d('analytics'), 'the twins disagree about how much they can lay out');
  assert.equal(c('crm'), c('analytics'), 'the twins disagree about where it gets crowded');
  assert.equal(s2('crm'), s2('analytics'), 'the twins disagree about when to show a spinner');
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/graphview.js`);
    assert.ok(c(app) < d(app), `${app}: the advice is above the ceiling, so it is never given`);
    assert.ok(s2(app) < d(app), `${app}: the spinner threshold is above the ceiling, so it never fires`);
    // The old pair is gone rather than left beside the new one, or one of them is always true.
    assert.ok(!/FORCE_MAX_NODES|forceFeasible|READABLE_MAX_NODES/.test(js),
      `${app}: a retired limit is still in the file`);
    // Only the ceiling refuses. `crowded` may never be asked whether to draw.
    const body = js.slice(js.indexOf('function erShow() {'), js.indexOf('function erShow() {') + 400);
    assert.ok(/drawable\(/.test(body) && /erNotDrawn\(/.test(body),
      `${app}: erShow does not refuse on the ceiling`);
    assert.ok(!/crowded\(/.test(body), `${app}: crowding blocks the drawing, and it may only advise`);
    // The count, and the three things it can say about itself.
    assert.ok(/tabCount:/.test(js) && /tabCrowded:/.test(js) && /tabOver:/.test(js),
      `${app}: the tab cannot say which of the three states it is in`);
    assert.ok(read(`apps/${app}/graphview.html`).includes('id="ertabn"'), `${app}: the tab has nowhere to show a count`);
    assert.ok(read(`apps/${app}/graphview.html`).includes('id="ernone"'), `${app}: the view has nowhere to say why it drew nothing`);
    assert.ok(/erCountRefresh\(\);?\s*}/.test(js.slice(js.indexOf('function statRefresh()'), js.indexOf('function statRefresh()') + 200)),
      `${app}: the tab count does not follow a header refresh, so a filter can leave it stale`);
  }
});
test('a control that comes and goes may not move the numbers beside it', () => {
  // The layouts chevron appears only on a module with more than one, and it used to be absent
  // otherwise - so a row with several layouts was 12px wider on the right than its neighbours and
  // pushed its own field and layout counts left. Measured at 18px of drift. Reported.
  const js = read('apps/crm/sidepanel.js'), css = read('apps/crm/sidepanel.html');
  // Searched *after* the start, not from the top: moduleRefusal() is defined earlier in the file,
  // so a bare indexOf returned a slice that ran backwards and silently contained nothing.
  const from = js.indexOf('const multi = (m.layoutCount || 0) > 1');
  const row = js.slice(from, js.indexOf('const ref = moduleRefusal(', from));
  assert.ok(!/const chev = multi \?/.test(row), 'the slot is present only when there is an arrow to put in it');
  assert.ok(/class="laychev\$\{multi \? '' : ' none'\}"/.test(row), 'the empty slot does not carry the class that sizes it');
  assert.ok(/\.laychev\{flex:0 0 12px/.test(css), 'the slot has no fixed width, so it cannot hold a column');
  assert.ok(/\.laychev\.none\{[^}]*pointer-events:none/.test(css), 'the empty slot still takes the cursor');
});

test('the focus is chrome, and the diagram no longer owns the control for it', () => {
  // A control that governs the window belongs to the window. «Scope» and «↺ Whole graph» lived in
  // the diagram's own toolbar while the focus they change is projected by all three views - so from
  // Relations, the control that decides what Relations is scoped to was on another tab. It is one
  // group beside the tabs now, the same shape the chips use, and it carries the depth with it:
  // leaving that behind would have recreated the same problem one control over.
  for (const app of ['crm', 'analytics']) {
    const html = read(`apps/${app}/graphview.html`), js = read(`apps/${app}/graphview.js`);
    assert.ok(!html.includes('id="erScope"'), `${app}: the diagram still owns the scope button`);
    assert.ok(!html.includes('id="erReset"'), `${app}: the diagram still owns the reset button`);
    const head = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    for (const id of ['focusg', 'focusnode', 'focusall', 'focusx', 'erdepth']) {
      assert.ok(head.includes(`id="${id}"`), `${app}: #${id} is not in the header`);
    }
    // the group wears the chips' own shape, so it reads as one question like FUNCTIONS does
    assert.ok(/class="dim focusg"/.test(html), `${app}: the focus group is not a labelled dimension`);
    // Everything pauses the focus; only the ✕ forgets it. Two actions, two controls, no mode.
    assert.ok(/\$\('focusall'\)\.onclick = \(\) => \{ if \(curFocus\) setScope\(true\)/.test(js),
      `${app}: Everything does not go through the shared scope`);
    assert.ok(/\$\('focusx'\)\.onclick = \(\) => clearFocus\(\)/.test(js),
      `${app}: the clear is not wired to clearFocus`);
  }
});

test('the status line stops repeating what the focus group already says', () => {
  // The name, the scope and the depth are on screen in the header now. Saying them again in the
  // status line is the duplication this project keeps having to remove - and the line has facts of
  // its own that were being crowded out.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/graphview.js`);
    const ego = js.slice(js.indexOf('function egoStat('), js.indexOf('\n}', js.indexOf('function egoStat(')));
    assert.ok(!/Focus: /.test(ego), `${app}: the status line still names the focus`);
    assert.ok(!/depth \$\{egoDepth\}/.test(ego), `${app}: the status line still prints the depth`);
    assert.ok(!/paused/.test(ego), `${app}: the status line still says the focus is paused`);
    assert.ok(/statOf\(/.test(ego), `${app}: it stopped counting what is on screen`);
    // ...and the counts are still there, on both branches
    assert.equal((ego.match(/statOf\(/g) || []).length, 2, `${app}: one branch of the line lost its counts`);
    assert.equal((ego.match(/orphanNote\(\)/g) || []).length, 2, `${app}: one branch lost the orphan note`);
  }
});

test('the focus chip wears the focused item\'s own colour, not a colour of its own', () => {
  // It was a hardcoded amber written into the markup, which meant nothing and sat a few pixels from
  // the Connections chip in the same amber. A colour is a claim about a dimension, so it has to be
  // wired to that dimension - the mistake this window has already made once, with the dot that was
  // coloured by namespace while the chips filtered on category.
  for (const app of ['crm', 'analytics']) {
    const html = read(`apps/${app}/graphview.html`), js = read(`apps/${app}/graphview.js`);
    const chip = html.slice(html.indexOf('id="focusnode"') - 40, html.indexOf('id="focusnode"') + 60);
    assert.ok(!/--hue:#/.test(chip), `${app}: the focus chip still carries an authored colour`);
    assert.ok(!/data-hue="focus"/.test(chip), `${app}: the focus chip claims a kind called «focus»`);
    const fn = js.slice(js.indexOf('function updateScopeUI('), js.indexOf('\n}', js.indexOf('function updateScopeUI(')));
    assert.ok(/setProperty\('--hue', KINDCOL\(KINDOF\(N\[curFocus\]\)\)/.test(fn),
      `${app}: the chip does not take the focused item's own hue`);
    assert.ok(/delete nodeChip\.dataset\.hue/.test(fn),
      `${app}: with nothing selected there is no category, so there must be no hue`);
    // and the group sits with the tabs rather than being pushed to the far edge
    assert.ok(!/\.focusg\{[^}]*margin-left:auto/.test(html), `${app}: the focus group is pushed away from the tabs`);
  }
});

test('the sample org is in the shape a pull writes, and it never ships', () => {
  // Fixtures built in a scratch directory die with the session that made them, so this one is in
  // the repository: for the screenshots, for the tests, and for whoever opens the project next with
  // no context. It sits outside apps/, which is the only thing build.sh copies.
  const build = read('build.sh');
  assert.ok(/cp -R "apps\/\$APP\/\." "\$STAGE"/.test(build), 'the build no longer copies only the app');
  assert.ok(!/fixtures/.test(build), 'the build has learnt about fixtures/, which would ship them');
  // One generator, two consumers: the panel writes the sample workspace, tools/fixtures.mjs writes
  // fixtures/ from the same code. A second description of the same shape is what this replaced.
  for (const app of ['crm', 'analytics']) {
    assert.ok(read(`apps/${app}/sample-org.js`).includes('window.SAMPLE_ORG'),
      `${app}: the generator exposes nothing for either consumer to call`);
  }
  assert.ok(read('tools/fixtures.mjs').includes("generator('crm')"),
    'the fixture writer no longer borrows the shipped generator');

  for (const p of ['fixtures/crm/sampleorg-1234567890/functions/index.json',
                   'fixtures/crm/sampleorg-1234567890/modules/index.json',
                   'fixtures/crm/sampleorg-1234567890/modules/layouts/index.json',
                   'fixtures/crm/sampleorg-1234567890/workflows/index.json',
                   'fixtures/crm/sampleorg-1234567890/schedules/index.json',
                   'fixtures/crm/sampleorg-1234567890/connections/index.json',
                   'fixtures/crm/sampleorg-1234567890/.zoost.json',
                   'fixtures/analytics/sample-workspace/views.json',
                   'fixtures/analytics/sample-workspace/schema.json',
                   'fixtures/analytics/sample-workspace/lineage.json',
                   'fixtures/analytics/sample-workspace/sql/index.json']) {
    assert.doesNotThrow(() => JSON.parse(read(p)), `${p} is missing or not JSON`);
  }
  // one folder per kind, no underscores - the shape this project settled on in 1.13
  const fns = JSON.parse(read('fixtures/crm/sampleorg-1234567890/functions/index.json'));
  assert.ok(Array.isArray(fns), 'functions/index.json is not a bare array, which is what the pull writes');
  assert.ok(fns.length > 10, 'the sample org has too little in it to show anything');
  assert.ok(fns.every((f) => f.namespace && !f.namespace.startsWith('_')),
    'a namespace carries the leading underscore that was removed in 1.13');

  // and the graph payloads the diagram window consumes
  for (const g of ['graph-crm-calls.json', 'graph-crm-schema.json', 'graph-analytics.json']) {
    const d = JSON.parse(read('fixtures/' + g));
    assert.ok(d.nodes && d.counts && d.workspace, `${g} is not a graphData payload`);
    for (const n of Object.values(d.nodes)) {
      assert.ok(Array.isArray(n.calls) && Array.isArray(n.called_by), `${g}: ${n.id} has no edges`);
    }
  }
});

test('nothing in the sample org names the org this is developed against', () => {
  // Zoost is stated to be built independently of its author's day job, and a real portal, module or
  // function name in a fixture would quietly contradict that - on a surface that is about to be
  // published as a screenshot, which is worse than a comment.
  const gen = read('apps/crm/sample-org.js');
  assert.ok(/const ORG = '1234567890'/.test(gen), 'the sample org id is no longer the neutral placeholder');
  assert.ok(/const INSTANCE = 'sampleorg'/.test(gen), 'the sample instance is no longer neutral');
  const cfg = JSON.parse(read('fixtures/crm/sampleorg-1234567890/.zoost.json'));
  assert.equal(cfg.org, '1234567890');
  assert.equal(cfg.instance, 'sampleorg');
});

test('the sample org exercises every state the panels can draw', () => {
  // «I want everything in the fake data» is a requirement that decays the moment a new state is
  // added and nobody remembers the fixture. So it is a check rather than a habit: each row below is
  // a state with its own mark, its own message or its own filter, and a screenshot taken against an
  // org that has none of them shows a product simpler than the one that ships.
  const calls = JSON.parse(read('fixtures/graph-crm-calls.json'));
  const schema = JSON.parse(read('fixtures/graph-crm-schema.json'));
  const an = JSON.parse(read('fixtures/graph-analytics.json'));
  const nodes = Object.values(calls.nodes);

  const cats = new Set(nodes.map((n) => n.category));
  for (const c of ['standalone', 'scheduler', 'crmfundamentals', 'custombutton', '',
                   'workflows', 'schedules', 'connections']) {
    assert.ok(cats.has(c), `no function of category «${c || 'none'}» - that chip has nothing to filter`);
  }
  assert.ok(nodes.some((n) => n.rest), 'nothing is exposed as REST, so the REST filter is empty');
  assert.ok(nodes.some((n) => n.unresolved.length), 'no unresolved reference, so that section never shows');
  assert.ok(nodes.some((n) => n.ambiguous.length), 'no ambiguous reference');
  assert.ok(calls.counts.dead_suspects > 0, 'nothing is unreferenced, so «no-caller» is empty');
  assert.ok(nodes.some((n) => n.category === 'connections' && !n.called_by.length),
    'every connection is used, so an unused one - the thing the audit looks for - cannot be seen');

  // the module Zoho refuses to describe, with its five surfaces
  const refused = Object.values(schema.nodes).filter((n) => n.unreadable);
  assert.equal(refused.length, 1, 'no refused module, so the ⊘ mark and its banner never appear');
  assert.equal(refused[0].unreadable.code, 'INVALID_MODULE');
  assert.ok(refused[0].unreadable.at, 'the refusal carries no date, so it reads as permanent');
  assert.equal(refused[0].fields.length, 0, 'a refused module was given fields, which is the claim it must not make');

  // on disk: stale meta, hidden layouts, and both related-list facets
  const ws = 'fixtures/crm/sampleorg-1234567890/';
  const metas = JSON.parse(read(ws + 'functions/index.json'));
  assert.ok(metas.length > 20, 'the sample org is too small to show a list');
  // the file stem is the api_name, not the name - the pull writes it that way
  const anyMeta = (pred) => metas.some((f) => pred(JSON.parse(read(ws + 'functions/' + f.namespace + '/' + f.api_name + '.meta.json'))));
  assert.ok(anyMeta((m) => m.sv < 2), 'nothing on disk is stale, so «Refresh outdated» has nothing to do');
  const mods = ['Products', 'Campaigns', 'Accounts'].map((m) => JSON.parse(read(ws + 'modules/' + m + '.json')));
  assert.ok(mods.some((m) => m.related_lists.some((r) => r.type === 'system')),
    'no system related list, so that facet is empty');
  // The pull records the junction as `linking_module`, not as a `via` string - the graph window
  // renders «linking: X» from it. The fixture must carry the field, not the rendering.
  assert.ok(mods.some((m) => m.related_lists.some((r) => r.linking_module)),
    'no many-to-many related list, so that facet is empty');
  assert.ok(mods.some((m) => m.layouts.some((l) => l.visible === false)),
    'no hidden layout, so «(hidden)» never renders');
  const wf = JSON.parse(read(ws + 'workflows/index.json'));
  assert.ok(wf.length > 4, 'too few workflows');

  // Analytics: system tables, orphans, and the two different ways a query has no SQL
  assert.ok(Object.values(an.nodes).some((n) => n.system), 'no system table, so that condition is empty');
  assert.ok(an.counts.dead_suspects > 0, 'nothing is in no relation');
  const kinds = new Set(JSON.parse(read('fixtures/analytics/sample-workspace/views.json')).views.map((v) => v.type));
  for (const k of ['Table', 'QueryTable', 'Chart', 'Pivot', 'Dashboard']) {
    assert.ok(kinds.has(k), `no view of type ${k}`);
  }
  // «could not be read» is recorded in lineage.failed, which is what «Retry failed» works from;
  // «returned nothing» is a .sql file that exists and is empty. Different facts, different places.
  const lin = JSON.parse(read('fixtures/analytics/sample-workspace/lineage.json'));
  assert.ok((lin.failed || []).length, 'no unreadable query, so «Retry failed» has nothing to do');
  const sql = JSON.parse(read('fixtures/analytics/sample-workspace/sql/index.json'));
  const stems = Object.values(sql).map((v) => v.stem);
  const bodies = stems.map((st) => { try { return read('fixtures/analytics/sample-workspace/sql/' + st + '.sql'); } catch { return null; } });
  assert.ok(bodies.some((b) => b === ''), 'no empty query - «returned nothing» must have an instance');
  assert.ok(bodies.some((b) => b === null), 'every query has a file, so nothing is unreadable');
});

test('the arrowhead is the same size on screen at any zoom', () => {
  // Reported as «sometimes I see the arrows and sometimes not». They were always there - every link
  // carries a marker-end - but the marker is drawn in the diagram's own coordinates and the whole
  // drawing is then scaled, so its size on screen was the zoom times its size in the markup:
  // measured on the sample org, 20.6px across on a focused view and **3.3px** on the whole org.
  // Direction is half of what an edge says, so a three-pixel triangle is not there in any sense.
  for (const app of ['crm', 'analytics']) {
    const html = read(`apps/${app}/graphview.html`), js = read(`apps/${app}/graphview.js`);
    assert.ok(/id="erarrow"[^>]*markerUnits="userSpaceOnUse"/.test(html),
      `${app}: the marker still scales with each link's stroke width, and one marker cannot be four sizes`);
    assert.ok(/id="erarrow"[^>]*viewBox="0 0 7 6"/.test(html),
      `${app}: without a viewBox the shape and refX move when the width changes`);
    assert.ok(/function erSizeArrows\(\)/.test(js), `${app}: nothing sizes the arrowheads`);
    assert.ok(/const k = 1 \/ Math\.max\(erScale, 0\.02\)/.test(js),
      `${app}: the size is not the inverse of the zoom, so it cannot come out constant`);
    // and it has to run wherever the zoom changes, which is the one place the transform is written
    const ap = js.slice(js.indexOf('function erApply()'), js.indexOf('\n}', js.indexOf('function erApply()')));
    assert.ok(/erSizeArrows\(\)/.test(ap), `${app}: the arrows are not re-sized when the zoom changes`);
  }
});

test('the sample org speaks Deluge, so the reference graph can find its calls', () => {
  // A Deluge namespace is not free: CALL_RE matches `<namespace>.<name>(` for exactly the five
  // namespaces Zoho CRM has. The first fixture invented its own - billing, orders, shared - so the
  // scanner found nothing in perfectly plausible-looking sources, and the panel said «no known
  // usage (orphan candidate)» and listed no calls for a function that plainly makes four. It was
  // found by rendering a screenshot, which is the argument for rendering them rather than capturing.
  const core = read('apps/crm/graph-core.js');
  const NS = core.match(/const NS = \[([^\]]+)\]/)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  const calls = JSON.parse(read('fixtures/graph-crm-calls.json'));
  // By entity, not by the shape of the id: the prefixes were a list to keep in step, and it fell
  // behind the moment actions and modules became nodes - `act:` ids were read as functions and
  // reported for having no Deluge namespace, which they correctly do not.
  const fns = Object.values(calls.nodes).filter((n) => (n.entity || 'functions') === 'functions');
  for (const n of fns) {
    assert.ok(NS.includes(n.namespace),
      `${n.id} is in namespace «${n.namespace}», which CALL_RE cannot match - Zoho has only ${NS.join(', ')}`);
  }
  // ...and the sources on disk have to write the call in that form
  const src = read('fixtures/crm/sampleorg-1234567890/functions/standalone/build_Invoice.dg');
  const re = new RegExp(String.raw`\b(${NS.join('|')})\.([A-Za-z_]\w*)\s*\(`, 'g');
  const found = [...src.matchAll(re)];
  assert.ok(found.length >= 4, 'the sample sources do not call anything the scanner can see');
  // the namespace and the category are different fields with different values - the mismatch this
  // repository has recorded twice - so the fixture must not let them collapse into one
  const cats = new Set(fns.map((n) => n.category));
  assert.ok(cats.has('crmfundamentals') && cats.has('scheduler') && cats.has('custombutton'),
    'the categories have become the namespaces again');
});

test('an arc leaves and arrives on the side that faces the other box', () => {
  // Reported with a picture: «the arrows are hidden even on a very simple graph». They were drawn -
  // the arc always attached to the left or right edge, whatever the two boxes' relative positions,
  // so on a focused diagram with one neighbour (which the concentric layout puts **straight above**
  // the focus) the arc left sideways, swept out, and came back into the other box's side almost
  // parallel to the edge it landed on. The head then lay against the box and was painted over by
  // it, because #erboxes comes after #ersvg. Measured on that case: dx=0, dy=-320.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/graphview.js`);
    const fn = js.slice(js.indexOf('function erEdgePoints('), js.indexOf('\n}', js.indexOf('function erEdgePoints(')));
    assert.ok(/Math\.abs\(bcy - acy\) > Math\.abs\(bcx - acx\)/.test(fn),
      `${app}: the side is not chosen by the dominant direction`);
    assert.ok(/'v'/.test(fn) && /'h'/.test(fn), `${app}: the caller is not told which axis was used`);
    // ...and the bezier has to be pulled along the same axis, or it leaves the box sideways again
    assert.ok(/axis === 'v' \? `C\$\{x1\},\$\{my\} \$\{x2\},\$\{my\}/.test(js),
      `${app}: the control points still assume a horizontal attachment`);
  }

  // the geometry itself, run rather than read
  const { erEdgePoints } = load([sliceFn('apps/crm/graphview.js', 'erEdgePoints')], { Math });
  const A = { x: 100, y: 400, w: 200, h: 40 };
  const above = { x: 100, y: 40, w: 200, h: 40 };     // straight above: the reported case
  const beside = { x: 600, y: 400, w: 200, h: 40 };   // to the side: what already worked
  const v = erEdgePoints(A, above);
  assert.equal(v[4], 'v', 'a box straight above is still attached sideways');
  assert.equal(v[1], A.y, 'the arc leaves the wrong horizontal edge');
  assert.equal(v[3], above.y + above.h, 'the arc does not arrive at the bottom of the box above it');
  const h = erEdgePoints(A, beside);
  assert.equal(h[4], 'h', 'a box to the side is now attached vertically');
  assert.equal(h[0], A.x + A.w, 'the arc leaves the wrong vertical edge');
  assert.equal(h[2], beside.x, 'the arc does not arrive at the near side');
});

test('the orphan cascade is computed on the set that will actually be drawn', () => {
  // The first version counted an edge anywhere in the graph, while the drawing is restricted to the
  // focus neighbourhood - so a node was kept for a partner that was never going to be drawn.
  // Reported: focus a standalone function, switch the standalone chip off, and five boxes stayed
  // with nothing attached, each held in by an edge to a connection outside the neighbourhood.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/graphview.js`);
    assert.ok(/const erCandidate = \(id\) => !!\(N\[id\] && passKind\(N\[id\]\) && \(!egoSet \|\| egoSet\.has\(id\)\)\)/.test(js),
      `${app}: the candidate set does not include the focus neighbourhood`);
    const lk = js.slice(js.indexOf('function linkedUnderFilter('), js.indexOf('\n}', js.indexOf('function linkedUnderFilter(')));
    assert.ok(/erCandidate\(a\) && erCandidate\(b\)/.test(lk),
      `${app}: an edge still counts when one end will not be drawn`);
    // every reader of it must use the same predicate, or one of them drifts back
    for (const f of ['erVisibleIds', 'orphanedByFilter']) {
      const body = js.slice(js.indexOf('function ' + f + '('), js.indexOf('\n}', js.indexOf('function ' + f + '(')));
      assert.ok(/erCandidate\(/.test(body), `${app}: ${f}() has its own idea of what is a candidate`);
      assert.ok(!/egoSet\.has\(id\)/.test(body), `${app}: ${f}() still tests the ego set by hand`);
    }
  }

  const N = {
    f: { id: 'f', category: 'standalone', namespace: 'standalone', calls: ['g'], called_by: [], rest: false, dead_suspect: false, unresolved: [], system: false },
    g: { id: 'g', category: 'standalone', namespace: 'standalone', calls: [], called_by: ['f'], rest: false, dead_suspect: false, unresolved: [], system: false },
    s: { id: 's', category: 'schedules', namespace: 'schedule', calls: ['c'], called_by: [], rest: false, dead_suspect: false, unresolved: [], system: false },
    c: { id: 'c', category: 'connections', namespace: 'connections', calls: [], called_by: ['s'], rest: false, dead_suspect: false, unresolved: [], system: false },
  };
  const edgesA = [['f', 'g'], ['s', 'c']];
  const hiddenKinds = new Set(), onlyConds = new Set();
  // the neighbourhood holds `s` but not the connection it links to - the reported shape
  const ctx = { N, edgesA, DATA: { kind: 'calls' }, hiddenKinds, onlyConds,
                egoSet: new Set(['f', 'g', 's']), Set, Object };
  const { linkedUnderFilter } = load([sliceConst('apps/crm/graphview.js', 'KINDOF'),
                                      sliceConst('apps/crm/graphview.js', 'CONDITION_KEYS'),
                                      sliceFn('apps/crm/graphview.js', 'passKind'),
                                      sliceConst('apps/crm/graphview.js', 'erCandidate'),
                                      sliceFn('apps/crm/graphview.js', 'linkedUnderFilter')], ctx);
  assert.equal([...linkedUnderFilter()].sort().join(''), 'fg',
    's is kept for a partner the neighbourhood excludes');
});

test('the sample workspace is written by the shipped generator, and nothing about it is a mode', () => {
  // The design he settled: a function writes the files and then the working folder is treated as a
  // real one. No `if (demo)` branch in rendering code - that is how invented data eventually gets
  // shown as somebody's own - only `sample: true` in .zoost.json and the guard that already exists.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`), html = read(`apps/${app}/sidepanel.html`);
    assert.ok(html.includes('src="sample-org.js"'), `${app}: the panel does not load the generator`);
    assert.ok(html.includes('id="wssample"'), `${app}: there is no way to ask for one`);
    assert.ok(/async function addSampleWorkspace\(\)/.test(js), `${app}: nothing writes it`);
    assert.ok(/window\.SAMPLE_ORG/.test(js), `${app}: the panel has its own copy of the data`);

    // one predicate, asked in the one place every platform-bound action already funnels through
    assert.ok(/const isSample = \(\) => !!\(bound && bound\.sample\)/.test(js),
      `${app}: there is no single answer to «is this a sample»`);
    // The CRM's guardOk is a function declaration and Analytics' is an arrow, so the check reads
    // the definition rather than a fixed window after the first mention of the name.
    const gi = js.search(/(function guardOk\(\)|const guardOk = )/);
    assert.ok(gi >= 0 && /isSample\(\)/.test(js.slice(gi, gi + 700)),
      `${app}: guardOk does not refuse a sample, so each button would have to remember`);
    // ...and it must not be dressed as an environment mismatch, which is a state that can be fixed
    assert.ok(/!guardOk\(\) && !isSample\(\)/.test(js),
      `${app}: a sample workspace raises the mismatch bar, which offers actions that cannot help`);

    // the flag has to survive every rebuild of `bound`, or the guard silently stops firing
    // Line by line, not `\{[^}]*\}`: that stops at the first closing brace, which on one of these
    // is inside `readJson(CFG, {})`, so a line that does carry the flag was reported as missing it.
    for (const line of js.split('\n')) {
      if (!/^\s*bound = \{/.test(line)) continue;
      assert.ok(/sample/.test(line),
        `${app}: «${line.trim().slice(0, 60)}…» rebuilds the binding without the sample flag`);
    }
    // and it is absent once one exists - a control with nothing to do
    assert.ok(/wssample'\)[\s\S]{0,300}hidden = /.test(js), `${app}: the button never goes away`);
  }

  // the generator writes what the panel expects to read back
  const files = (() => {
    const src = read('apps/crm/sample-org.js');
    const ctx = { window: {}, Object, JSON, Math, String, Array, Set, Number };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return ctx.window.SAMPLE_ORG.files({});
  })();
  const cfg = JSON.parse(files['.zoost.json']);
  assert.equal(cfg.sample, true, 'the workspace it writes is not marked as a sample');
  assert.ok(cfg.org && cfg.instance && cfg.base, 'the binding fields the guard reads are missing');
  for (const p of ['functions/index.json', 'modules/index.json', 'workflows/index.json',
                   'schedules/index.json', 'connections/index.json', 'modules/layouts/index.json']) {
    assert.ok(files[p], `the sample workspace has no ${p}`);
  }
  // ...and without the flag, none of the awkward states - a refused module on day one is a puzzle
  assert.ok(!Object.values(files).some((t) => /INVALID_MODULE/.test(t)),
    'the workspace a first-time reader opens contains a module Zoho refused to describe');
});

test('nothing reaches Zoho for a sample workspace, navigations included', () => {
  // The guide says «everything that would talk to the platform is disabled for it», and the
  // absolutes ledger is what forced that to be checked rather than assumed. It was not true: the
  // pull and the per-item reads go through guardOk, but the *navigations* build a URL from the
  // workspace's own instance and would have opened one that does not exist.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`);
    // every function that hands a URL to chrome.tabs has to refuse first
    const names = [...js.matchAll(/async function (\w+)\([^)]*\)\s*\{/g)].map((m) => m[1]);
    for (const fn of names) {
      const i = js.indexOf(`async function ${fn}(`);
      const body = js.slice(i, js.indexOf('\nasync function ', i + 1) + 1 || undefined);
      const head = body.slice(0, body.indexOf('\n}\n') + 3);
      if (!/chrome\.tabs\.(update|create)\(/.test(head)) continue;
      if (!/homeUrl\(\)|functionsUrl\(\)|\/crm\/\$\{|\/workspace\//.test(head)) continue;
      // Either form counts: the eight sites that repeated the refusal by hand now read
      // `if (sampleRefuse()) return;`, and sampleRefuse() is isSample() plus the sentence.
      assert.ok(/isSample\(\)|sampleRefuse\(\)/.test(head),
        `${app}: ${fn}() opens a Zoho URL without refusing a sample workspace, which has none`);
    }
  }
});

test('a window resize re-fits the diagram, unless the view is the reader\'s own', () => {
  // Asked for: resizing the window left the drawing framed for a size it no longer had, and the
  // only way back was clicking Fit every time. The half that is not obvious is the exception -
  // panning and zooming are a view somebody chose, and re-fitting because the window changed size
  // would be the window overruling them. Measured on the sample org: fitted 0.109, the reader zooms
  // to 0.119, a resize keeps 0.119; Fit hands it back and the next resize follows again.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/graphview.js`);
    assert.ok(/window\.addEventListener\('resize'/.test(js), `${app}: nothing listens for a resize`);
    const h = js.slice(js.indexOf("window.addEventListener('resize'"));
    assert.ok(/curView === 'er' && !erUserMoved/.test(h.slice(0, 300)),
      `${app}: the resize re-fits regardless of what the reader has done to the view`);
    assert.ok(/clearTimeout\(_erFitT\)/.test(h.slice(0, 300)),
      `${app}: resize fires continuously through a drag and this is not debounced`);
    // the flag has to be set where the view is moved, and cleared where it is fitted
    const fit = js.slice(js.indexOf('function erFit()'), js.indexOf('\n}', js.indexOf('function erFit()')));
    assert.ok(/erUserMoved = false/.test(fit), `${app}: a fit does not hand the view back to the window`);
    const wheel = js.slice(js.indexOf("addEventListener('wheel'"), js.indexOf("addEventListener('wheel'") + 500);
    assert.ok(/erUserMoved = true/.test(wheel), `${app}: zooming does not mark the view as chosen`);
    const move = js.slice(js.indexOf("addEventListener('mousemove'"), js.indexOf("addEventListener('mousemove'") + 400);
    assert.ok(/erUserMoved = true/.test(move), `${app}: panning does not mark the view as chosen`);
  }
});

test('the sample workspace has the shape the pull writes, field for field', () => {
  // This is the test that would have saved a whole round. The first generator invented the shapes -
  // `{items: […]}` instead of a bare array, `namespace` instead of `nameSpace`, a boolean `rest`
  // instead of `rest_api`, `sv: 3` when META_SV is 2, connections as strings - and the panel
  // answered with «wfIdx is not iterable», «idx.map is not a function», no connections and a broken
  // export. Each key below is read from the writer in content-bridge.js or the reader in
  // sidepanel.js, so the fixture cannot drift from what a real workspace contains.
  const ctx = { window: {}, Object, JSON, Math, String, Array, Set, Number };
  vm.createContext(ctx);
  vm.runInContext(read('apps/crm/sample-org.js'), ctx);
  const files = ctx.window.SAMPLE_ORG.files({ functions: 40 });

  for (const p of ['functions/index.json', 'modules/index.json', 'modules/layouts/index.json',
                   'workflows/index.json', 'schedules/index.json', 'connections/index.json']) {
    assert.ok(Array.isArray(JSON.parse(files[p])), `${p} is not a bare array - the pull writes one`);
  }
  const fn = JSON.parse(files['functions/index.json'])[0];
  for (const k of ['id', 'api_name', 'name', 'display_name', 'namespace', 'category', 'source', 'rest']) {
    assert.ok(k in fn, `functions/index.json entries have no ${k}`);
  }
  assert.notEqual(fn.api_name, fn.display_name,
    'api_name and display_name are equal, so «Name: display / internal» does nothing');

  // the meta is toFile()'s, including the casing Zoho uses and the version the panel calls current
  const meta = JSON.parse(files[`functions/${fn.namespace}/${fn.api_name}.meta.json`]);
  for (const k of ['id', 'name', 'display_name', 'api_name', 'nameSpace', 'category', 'source',
                   'return_type', 'params', 'description', 'updatedTime', 'modified_by',
                   'associated_place', 'workflow', 'rest_api', 'connections', 'sv']) {
    assert.ok(k in meta, `the function meta has no ${k}`);
  }
  const SV = +read('apps/crm/sidepanel.js').match(/const META_SV = (\d+)/)[1];
  assert.equal(meta.sv, SV, `the meta says sv ${meta.sv} where the panel's META_SV is ${SV}`);
  assert.ok(Array.isArray(meta.rest_api), 'rest_api is not the list the reader tests with .some()');
  assert.ok(meta.connections.every((c) => c && typeof c === 'object' && c.name),
    'connections are not the {name,label,…} objects the reader expects');

  const mod = JSON.parse(files['modules/index.json'])[0];
  for (const k of ['api_name', 'module_name', 'generated_type', 'fields', 'layouts', 'related_lists']) {
    assert.ok(k in mod, `modules/index.json entries have no ${k}`);
  }
  assert.equal(typeof mod.fields, 'number', 'the module index holds field objects, not a count');

  const wf = JSON.parse(files['workflows/index.json'])[0];
  for (const k of ['id', 'name', 'module', 'module_id', 'type', 'active', 'source']) {
    assert.ok(k in wf, `workflows/index.json entries have no ${k}`);
  }
  // the per-workflow file is the rule itself, and wfScheduled() reads execute_after off it
  const rule = JSON.parse(files[`workflows/${wf.id}.json`]);
  assert.ok(Array.isArray(rule.conditions), 'the workflow file is not the rule object');
  const anyRule = Object.keys(files).filter((p) => /^workflows\/\d+\.json$/.test(p))
    .map((p) => JSON.parse(files[p]));
  assert.ok(anyRule.some((r) => (r.conditions || []).some((c) =>
    (c.scheduled_actions || []).some((sa) => sa.execute_after && sa.execute_after.period))),
    'no scheduled action carries execute_after, so the delay never shows');

  const sch = JSON.parse(files['schedules/index.json'])[0];
  for (const k of ['id', 'name', 'status', 'function_id', 'function_name', 'frequency', 'next', 'last']) {
    assert.ok(k in sch, `schedules/index.json entries have no ${k}`);
  }
  const conn = JSON.parse(files['connections/index.json'])[0];
  for (const k of ['name', 'label', 'connector', 'connectorLabel', 'connected', 'createdBy', 'scopes', 'id']) {
    assert.ok(k in conn, `connections/index.json entries have no ${k}`);
  }

  // Analytics: a document with folders and views, not the raw API keys the bridge transforms away
  const actx = { window: {}, Object, JSON, Math, String, Array, Set, Number };
  vm.createContext(actx);
  vm.runInContext(read('apps/analytics/sample-org.js'), actx);
  const af = actx.window.SAMPLE_ORG.files({});
  const doc = JSON.parse(af['views.json']);
  assert.ok(Array.isArray(doc.views) && Array.isArray(doc.folders),
    'views.json is not {folders, views} - which is what loadFromDisk reads');
  for (const k of ['id', 'name', 'type', 'folder', 'folderName', 'parent', 'system',
                   'dataModifiedAt', 'designModifiedText']) {
    assert.ok(k in doc.views[0], `a view has no ${k} - the bridge renames VIEW_ID before it lands`);
  }
  const sc = JSON.parse(af['schema.json']);
  assert.ok(sc.tables && Array.isArray(sc.relations), 'schema.json is not {tables, relations}');
  const t = Object.values(sc.tables)[0];
  for (const k of ['name', 'kind', 'system', 'columns']) assert.ok(k in t, `a table has no ${k}`);
  const rel = sc.relations[0];
  for (const k of ['source', 'target', 'sourceName', 'targetName', 'sourceColumns', 'targetColumns', 'relation']) {
    assert.ok(k in rel, `a relation has no ${k}`);
  }
  const lin = JSON.parse(af['lineage.json']);
  assert.ok(lin.deps && 'failed' in lin, 'lineage.json is not {deps, failed}');
  const sq = Object.values(JSON.parse(af['sql/index.json']))[0];
  for (const k of ['stem', 'name', 'parents', 'sources']) assert.ok(k in sq, `a sql index entry has no ${k}`);
});

test('a workspace binding is in place before anything is enabled from it', () => {
  // Reported as «the per-type Pull is still enabled on the sample org». setEnabled() asks
  // isSample(), which reads `bound` - and `bound` was assigned four lines *after* the call, so it
  // was still answering about the workspace being left. «Fields first, state second» in its mirror
  // image: here the state is read before it is written.
  // Comments stripped first: the note explaining this bug names setEnabled( above the line that
  // calls it, so searching the raw text found the explanation and reported the fix as the defect.
  const js = read('apps/crm/sidepanel.js').replace(/^\s*\/\/.*$/gm, '');
  const body = js.slice(js.indexOf('async function activate('), js.indexOf('\n}', js.indexOf('async function activate(')));
  const bind = body.indexOf('bound = w.binding');
  const enable = body.indexOf('setEnabled(');
  assert.ok(bind >= 0 && enable >= 0, 'activate() no longer binds or enables');
  assert.ok(bind < enable,
    'the binding is read after setEnabled(), so a control that depends on it sees the previous workspace');
});

test('a sample workspace states the discrepancy, and only the blocking differs', () => {
  // Reported: the sample stayed active with no warning while the tab was on a real org. One muted
  // line in the workspace half is too quiet for that - reading invented data while looking at a
  // real org is exactly what the mismatch bar exists to say. So it is said.
  //
  // What is *not* the same is the overlay. A real mismatch can be resolved and browsing until it is
  // means reading org A's mirror while looking at org B; a sample will never match anything,
  // everything Zoho-bound is already refused for it, and blocking it would make it unusable the
  // whole time a Zoho tab is open. Say it, do not stop it.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`).replace(/^\s*\/\/.*$/gm, '');
    const html = read(`apps/${app}/sidepanel.html`);
    assert.ok(/const sampleMm = !!\(bound && (?:lastCtx|ctx)/.test(js),
      `${app}: nothing detects a sample sitting beside a real tab`);
    assert.ok(/classList\.toggle\('show', mm \|\| sampleMm\)/.test(js),
      `${app}: the bar stays hidden for a sample`);
    assert.ok(/mmoverlay'\)\.classList\.toggle\('show', mm\)/.test(js),
      `${app}: the overlay blocks a sample, which makes it unusable while any tab is open`);
    assert.ok(/classList\.toggle\('soft', sampleMm\)/.test(js),
      `${app}: the two situations look identical, so a reader cannot tell them apart`);
    assert.ok(/#mmbar\.soft\{/.test(html), `${app}: the softer bar has no style, so it renders as the hard one`);
    // «Switch tab» is meaningless for a sample - there is no Zoho org to switch to
    assert.ok(/\$\('mmgo'\)\.style\.display = sampleMm \? 'none' : ''/.test(js),
      `${app}: the bar offers to switch to a Zoho org the sample does not have`);
  }
});

test('the sample can be reached and read without any Zoho tab at all', () => {
  // The off-Zoho overlay is fixed, inset:0 and above everything, so with no Zoho tab the panel was
  // unreachable - including «+ Sample». That made the one workspace anybody can open without an
  // account the one you could not open without one, which is the opposite of what it is for.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`).replace(/^\s*\/\/.*$/gm, '');
    const html = read(`apps/${app}/sidepanel.html`);
    assert.ok(/\$\('offoverlay'\)\.classList\.toggle\('show', !isSample\(\)/.test(js),
      `${app}: the off-Zoho overlay still covers a sample workspace, which owes Zoho nothing`);
    assert.ok(!/\$\('offoverlay'\)\.classList\.add\('show'\)/.test(js),
      `${app}: something still shows that overlay unconditionally`);
    // and the way in has to be on the overlay itself, which is where a new install actually lands
    const ov = html.slice(html.indexOf('id="offoverlay"'), html.indexOf('id="offoverlay"') + 800);
    assert.ok(/id="offsample"/.test(ov), `${app}: the overlay offers no way to try Zoost without signing in`);
    assert.ok(/\$\('offsample'\)\.onclick = \(\) => addSampleWorkspace\(\)/.test(js),
      `${app}: the overlay's sample button is not wired`);
    // Both copies call the one function, and **the function decides** - not the label. A label is
    // repainted by updateWsButtons and can be stale; the report was clicking a button still reading
    // «+» and creating the sample again each time. So the check is on the action.
    const fn = js.slice(js.indexOf('async function addSampleWorkspace()'),
                        js.indexOf('async function writeSampleWorkspace()'));
    assert.ok(/w\.(binding|cfg) && w\.\1\.sample/.test(fn),
      `${app}: addSampleWorkspace does not look for one that already exists, so a stale label writes a second`);
    // Grant *first*, then decide. Until the folder permission is granted the enumeration returns
    // early, so `wsList` is empty for a reason that has nothing to do with the question - and the
    // panel offered to create a sample that was sitting right there. Three reports.
    const grant = fn.indexOf('ensurePerm(root)');
    const decide = fn.search(/w\.(binding|cfg) && w\.(binding|cfg)\.sample/);
    assert.ok(grant >= 0 && decide > grant,
      `${app}: it decides whether a sample exists before the folder can be read`);
    assert.ok(/if \(!rootGranted\) \{ rootGranted = true; await (loadWorkspaces|refreshWorkspaces)\(\)/.test(fn),
      `${app}: the list is not re-read after the permission is granted, so it is still empty`);
    assert.ok(/(activate\(have|selectWorkspace\(have)/.test(fn), `${app}: it cannot open the one that exists`);
    assert.ok(/if \(sampleBusy\) return;/.test(fn),
      `${app}: a second click lands while the first is still writing three hundred files`);
    assert.ok(/offoverlay'\)\.classList\.remove\('show'\)/.test(fn),
      `${app}: the overlay stays up over the progress, which is what made pressing again look reasonable`);
    // the label still has to say which of the two it will do
    const lbl = js.slice(js.indexOf("const ob = $('offsample')"), js.indexOf("const ob = $('offsample')") + 400);
    assert.ok(/have \? 'Open sample workspace'/.test(lbl),
      `${app}: the button says «+ Sample workspace» even when one already exists`);
    assert.ok(/without signing in anywhere/.test(ov),
      `${app}: the overlay does not say the sample needs no account, which is the whole point`);
  }
});

test('the panel remembers whether a sample exists, for the moment it cannot look', () => {
  // Chrome drops the folder permission between sessions, so the state right after the panel opens is
  // the one where it cannot enumerate anything - and that is exactly when the overlay asks whether
  // to create or open the sample. It offered to create one that was already there, three times.
  //
  // Same shape as `tabAccessView`: a display-only copy of a fact, in chrome.storage.local, for a
  // surface that cannot reach the folder. The folder stays the authority - this is only read into a
  // label, and the action re-checks after granting.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`).replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/chrome\.storage\.local\.get\('sampleWs'\)/.test(js),
      `${app}: nothing remembers whether a sample exists`);
    assert.ok(/chrome\.storage\.local\.set\(\{ sampleWs/.test(js), `${app}: the fact is never recorded`);
    const known = js.slice(js.indexOf('function knownSample()'), js.indexOf('function updateSampleButtons()'));
    assert.ok(/sampleWsKnown/.test(known), `${app}: the label ignores what was remembered`);
    assert.ok(/wsList \|\| \[\]/.test(known), `${app}: it trusts the memory over the folder it can read`);
    // recorded from a list that is real, and set back to null when the sample is deleted
    assert.ok(/noteSampleWs\(\(wsList\.find/.test(js),
      `${app}: the remembered answer is not refreshed from a real enumeration`);
    // one place decides both buttons
    assert.ok((js.match(/updateSampleButtons\(\)/g) || []).length >= 2,
      `${app}: the two buttons are decided in two places, which is how they came to disagree`);
  }
});

test('the panel does not claim what it has not looked at, and a poll does not undo a decision', () => {
  // Four reports of the same thing. Two mistakes of mine, and both are general.
  //
  // 1. «+ Sample workspace» asserts there is none and «Open sample workspace» asserts there is one.
  //    Until the folder permission is granted the enumeration returns early, so the panel has not
  //    looked and neither claim is warranted. It said «+». This project does not state what it has
  //    not measured, and a button label is a statement like any other.
  //
  // 2. The panel re-derives its whole state on a five-second poll. I hid the overlay with an
  //    assignment at the click, and the next tick put it back - reported as the overlay returning in
  //    the middle of writing the sample. A state that has to hold across time is a **term in the
  //    condition**, never an assignment on top of the derivation.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`).replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/const sampleKnowable = \(\) => !!\(root && rootGranted\) \|\| !!sampleWsKnown;/.test(js),
      `${app}: nothing distinguishes «there is none» from «I have not looked»`);
    const lbl = js.slice(js.indexOf("const ob = $('offsample')"), js.indexOf("const ob = $('offsample')") + 700);
    assert.ok(/sampleKnowable\(\) \? '\+ Sample workspace' : 'Sample workspace'/.test(lbl),
      `${app}: the button still says «+ Sample workspace» when it cannot tell`);
    assert.ok(/toggle\('show', !isSample\(\) && !sampleBusy\)/.test(js),
      `${app}: the overlay is derived without knowing a sample is being written, so the poll brings it back`);
  }
});

// ---------- one sentence, one place ----------
//
// A message copied at eight call sites is eight places to correct when it changes, and the panels
// have already paid that: the refusal below was reworded once and one site kept the old wording for
// a release. These four cases hold each folded thing at one occurrence per panel, so putting a
// duplicate back is a red test rather than something noticed later by eye. They read the source with
// comments stripped, because the helper's own comment quotes the string it replaced.

const panelBody = (app) => read(`apps/${app}/sidepanel.js`).replace(/^\s*\/\/.*$/gm, '');
const countOf = (s, lit) => s.split(lit).length - 1;

test('the sample refusal is written once per panel', () => {
  // Eight sites in the CRM and two in Analytics, seven of the CRM's carrying the same three-line
  // comment as well. One of them returns null rather than undefined - openTargetZoho hands its
  // caller a tab id - and that is preserved at the call site, not folded into the helper.
  const msg = {
    crm: 'This is the sample workspace - there is no Zoho org to open.',
    analytics: 'This is the sample workspace - there is no Zoho Analytics workspace to open.',
  };
  for (const app of ['crm', 'analytics']) {
    const src = panelBody(app);
    assert.equal(countOf(src, msg[app]), 1,
      `${app}: the sample refusal is written ${countOf(src, msg[app])} times - fold the site back into sampleRefuse()`);
    assert.ok(/function sampleRefuse\(\) \{/.test(src), `${app}: sampleRefuse() is gone`);
    // it must report *and* answer true, or `if (sampleRefuse()) return;` refuses nothing
    const body = src.slice(src.indexOf('function sampleRefuse'), src.indexOf('\n}', src.indexOf('function sampleRefuse')));
    assert.ok(/if \(!isSample\(\)\) return false;/.test(body), `${app}: sampleRefuse() does not let a real workspace through`);
    assert.ok(/return true;/.test(body), `${app}: sampleRefuse() never answers true, so every caller carries on`);
  }
  // the CRM's one null-returning site keeps its null
  assert.ok(/if \(sampleRefuse\(\)\) return null;/.test(panelBody('crm')),
    'openTargetZoho returns undefined where it used to return null - its callers test the id');
});

test('the folder-access guard throws from one place per panel', () => {
  // Nine identical `if (!(await ensurePerm(dir))) throw new Error(...)` lines in the CRM, folded
  // into requirePerm(). Analytics has one such site and no helper: that asymmetry is real and is
  // recorded here rather than smoothed over - see the note in requirePerm. Callers that report and
  // carry on instead of throwing keep their own ensurePerm, so this counts the *throw*. The message
  // itself is no longer written here: it is MSG.folder, one sentence for the ten sites that used to
  // say it three ways, and the case below holds the two panels to the same wording.
  const thrown = /throw new Error\(MSG\.folder\)/g;
  for (const app of ['crm', 'analytics']) {
    const src = panelBody(app);
    const n = (src.match(thrown) || []).length;
    assert.equal(n, 1, `${app}: the guard throws from ${n} places - use requirePerm(dir)`);
  }
  const crm = panelBody('crm');
  assert.ok(/async function requirePerm\(h\)/.test(crm), 'the CRM lost requirePerm()');
  assert.ok((crm.match(/await requirePerm\(dir\);/g) || []).length >= 9,
    'a call site stopped guarding the folder before touching the mirror');
});

test('a failed pull records and reports through one helper', () => {
  // Six sites did `await noteAccess(area, e); setStatus(pullFailMessage(area, e), 'bad');` by hand.
  // The two halves belong together: recording without saying leaves a tab that vanished with no
  // reason, saying without recording loses the verdict the next pull skips on.
  const src = panelBody('crm');
  const pair = /await noteAccess\((.+?), e\); setStatus\(pullFailMessage\(/g;
  assert.equal((src.match(pair) || []).length, 0,
    'a pull failure still records and reports by hand - call notePullFailure(area, e)');
  assert.ok(/async function notePullFailure\(area, e\)/.test(src), 'the CRM lost notePullFailure()');
  // Eight since the automation actions joined: every pull is one of these, and a new one that
  // forgot the helper would show up here as a count that did not move.
  assert.equal((src.match(/await notePullFailure\(/g) || []).length, 8,
    'a pull failure site stopped going through notePullFailure()');
  // the helper must keep the order: the verdict is on disk before the sentence is on screen
  const body = src.slice(src.indexOf('async function notePullFailure'), src.indexOf('\n}', src.indexOf('async function notePullFailure')));
  assert.ok(body.indexOf('noteAccess') < body.indexOf('setStatus'), 'notePullFailure() says it before it records it');
});

test('sorting by one field goes through one comparator', () => {
  // Twelve identical arrow functions - six on `name`, six on `api_name` - plus the same expression
  // as the tail of three compound comparators. byField keeps the `|| ''` each site carried, so a
  // missing field still sorts as an empty string rather than throwing.
  const src = panelBody('crm');
  for (const k of ['name', 'api_name', 'label']) {
    const lit = `(a.${k} || '').localeCompare(b.${k} || '')`;
    assert.equal(countOf(src, lit), 0,
      `a comparator on ${k} is still written out - use byField('${k}')`);
  }
  assert.ok(/const byField = \(k\) => \(a, b\) => \(a\[k\] \|\| ''\)\.localeCompare\(b\[k\] \|\| ''\);/.test(src),
    'byField is gone, or no longer carries the || \'\' the sites relied on');
  assert.ok((src.match(/byField\('/g) || []).length >= 15, 'a sort stopped going through byField');
});

// The four cases above read the source; these run the helpers. Both are needed, and the reason is
// in CLAUDE.md: a free variable is syntax-clean, `node --check` passes, and the ReferenceError only
// arrives when the line executes. Each of these folded a live call site, so a typo in `setStatus`
// or `noteAccess` would have been a button that silently stopped working.

test('every settings section is filled when the page opens', () => {
  // The data-centre picklist was built by a call that had landed on the *folder picker*, so the
  // select was empty until you chose a folder - which is not when a form fills itself. Reported
  // from a real install. The page's own start-up loads every section, and that is the list.
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/options.js`);
    // The two pages boot differently - one awaits a line of loaders, the other calls them from an
    // IIFE - so the check is «is loadDc() reached from the same place loadLay() is», not a shape.
    const near = (fn) => {
      const i = src.indexOf(fn + '();');
      return i > 0 ? src.slice(Math.max(0, i - 400), i + 400) : '';
    };
    assert.ok(near('loadLay').includes('loadDc();'),
      `${app}: loadDc() is not called where the other sections are loaded, so the picklist is empty ` +
      'until something else happens to call it');
  }
});

test('every automation list asks Zoho for the details its rows need', () => {
  // Without `include_inner_details` Zoho answers with the thin form: a notification's from_address
  // arrives with a type and no resource, so the sender read «an organisation address» and nothing
  // else. The field was there and empty, which is why it took two reports to find. Each list asks
  // for what Zoho's own page asks for, read off its requests.
  const src = read('apps/crm/content-bridge.js');
  const block = src.slice(src.indexOf('const ACTION_KINDS = ['), src.indexOf('];', src.indexOf('const ACTION_KINDS = [')));
  for (const [kind, needs] of [
    ['email_notifications', ['from_address.field_label']],
    ['field_updates', ['field.field_label', 'field.data_type']],
    ['tasks', ['display_value']],
    ['webhooks', ['display_url']],
  ]) {
    const i = block.indexOf(`kind: '${kind}'`);
    assert.ok(i > 0, `id=inner ${kind}: not in the registry`);
    const entry = block.slice(i, block.indexOf('}', i));
    for (const n of needs) {
      assert.ok(entry.includes(n), `id=inner ${kind}: does not ask for ${n}, so its rows arrive thin`);
    }
  }
  assert.ok(/include_inner_details=\$\{encodeURIComponent\(k\.detail\)\}/.test(src),
    'id=inner: the list call does not send what the registry declares');
});

test('the data centres offered are the hosts the manifest can reach', () => {
  // Two literal lists - the panel's picklist and the Settings form - were held equal by a test,
  // which is a checker standing in for a source of truth. Both derive from the manifest now: a host
  // this extension cannot reach is not a destination it may offer.
  for (const app of ['crm', 'analytics']) {
    const host = app === 'crm' ? 'crm' : 'analytics';
    const hosts = JSON.parse(read(`apps/${app}/manifest.json`)).host_permissions;
    const want = [...new Set(hosts.map((h) => (h.match(new RegExp(`^https://${host}\\.([^/*]+)/\\*$`)) || [])[1]).filter(Boolean))].sort();
    assert.ok(want.length >= 5, `id=dc ${app}: only ${want.length} data centre(s) in the manifest`);
    for (const f of [`apps/${app}/sidepanel.js`, `apps/${app}/options.js`]) {
      const src = read(f);
      assert.ok(/getManifest\(\)\.host_permissions/.test(src), `id=dc ${f}: the list is not derived`);
      assert.ok(!/'zoho\.eu'|"zoho\.eu"/.test(src.replace(/^\s*(\/\/|\s\*).*$/gm, '')),
        `id=dc ${f}: a data centre is written out in code, so there are two lists again`);
    }
    // and the form no longer carries them in markup either
    assert.ok(!/<option value="zoho/.test(read(`apps/${app}/options.html`)),
      `id=dc ${app}: Settings still lists data centres in its markup`);
  }
});

test('the runtime reading says whose failures those are', () => {
  // «8 failing · read Aug 10, 2026, 02:22 PM» sat next to a Pull button and read as eight failed
  // downloads. It was green, and green did not help: a colour cannot name a subject. Reported.
  const { runtimeSummary } = load([sliceFn('apps/crm/sidepanel.js', 'runtimeSummary')], {});
  for (const n of [0, 1, 8]) {
    const said = runtimeSummary(n);
    assert.match(said, /^Read from Zoho/, `id=runtime n=${n}: it must say what was read first`);
    assert.ok(!/^\d/.test(said), `id=runtime n=${n}: a count first reads as a count of failures`);
    assert.match(said, /failing there|nothing failing/, `id=runtime n=${n}: the subject is not named`);
  }
  assert.match(runtimeSummary(8), /8 function\(s\)/, 'id=runtime: the count lost its noun');
  assert.ok(!/\d/.test(runtimeSummary(0)), 'id=runtime: «0 functions failing» is a count nobody asked for');
});

test('sampleRefuse() refuses a sample and lets a real workspace through', () => {
  for (const [app, say, msg] of [
    ['crm', 'setStatus', 'This is the sample workspace - there is no Zoho org to open.'],
    ['analytics', 'status', 'This is the sample workspace - there is no Zoho Analytics workspace to open.'],
  ]) {
    let said = null, boundState = null;
    // MSG travels with the function: the CRM's refusal reads its sentence from there now (it has a
    // second reader, the health view's own line, and a message written twice is the defect the
    // duplicate check exists for), and without the constant this lift is a ReferenceError.
    const { sampleRefuse } = load([
      sliceConst(`apps/${app}/sidepanel.js`, 'MSG'),
      sliceConst(`apps/${app}/sidepanel.js`, 'isSample'),
      sliceFn(`apps/${app}/sidepanel.js`, 'sampleRefuse'),
    ], { get bound() { return boundState; }, [say]: (t, c) => { said = [t, c]; } });

    boundState = { sample: true };
    assert.equal(sampleRefuse(), true, `${app}: a sample workspace was not refused`);
    assert.deepEqual(said, [msg, 'warn'], `${app}: the refusal said something else`);

    said = null; boundState = { org: '1234567890' };
    assert.equal(sampleRefuse(), false, `${app}: a real workspace was refused`);
    assert.equal(said, null, `${app}: a real workspace got a status line it should not have`);
  }
});

test('requirePerm() throws the shipped message, and only when the folder is denied', async () => {
  const { requirePerm } = load([
    sliceConst('apps/crm/sidepanel.js', 'MSG'),
    sliceFn('apps/crm/sidepanel.js', 'requirePerm'),
    sliceFn('apps/crm/sidepanel.js', 'ensurePerm'),
  ], {});
  const handle = (state) => ({ queryPermission: async () => state, requestPermission: async () => state });
  await requirePerm(handle('granted'));   // must not throw, or every pull stops on a granted folder
  // The wording is read from the shipped MSG rather than repeated here - a copy in the test is one
  // more place the sentence can drift, which is the whole defect this fold was about. What is
  // asserted is that the thrown message *is* that constant and names a button the user can press.
  await assert.rejects(() => requirePerm(handle('denied')),
    (e) => e.message === 'Folder access needs re-granting - click ↻ Refresh.',
    'the message a user reads when the folder is gone has changed');
});

test('notePullFailure() records the verdict before it says anything', async () => {
  // The order is the point. The status line is what the user reads; the verdict on disk is what the
  // next pull skips on and what Settings explains. Reporting first and failing to record would leave
  // a tab that vanished with nothing behind it saying why.
  const order = [];
  const { notePullFailure } = load([sliceFn('apps/crm/sidepanel.js', 'notePullFailure')], {
    noteAccess: async (a, e) => { await null; order.push(['noteAccess', a, e.message]); },
    pullFailMessage: (a, e) => `${a} pull error: ${e.message}`,
    setStatus: (t, c) => order.push(['setStatus', t, c]),
    showEmergency: (on) => order.push(['showEmergency', on]),
  });
  await notePullFailure('connections', new Error('boom'));
  assert.deepEqual(order, [
    ['noteAccess', 'connections', 'boom'],
    ['setStatus', 'connections pull error: boom', 'bad'],
    ['showEmergency', true],
  ]);
});

test('a role refusal does not point at /emergency', async () => {
  // The pointer answers one question - «has a fix for this been released» - and for a Zoho role that
  // does not grant an area the answer is no and always will be. Offering it there would send someone
  // to a page that cannot help, which is the «wrong missing thing» this project already has a rule
  // about. Every other failure is «Zoho did not answer the way this expects», and that is its case.
  const seen = [];
  const { notePullFailure } = load([sliceFn('apps/crm/sidepanel.js', 'notePullFailure')], {
    noteAccess: async () => { await null; },
    pullFailMessage: () => 'refused',
    setStatus: () => {},
    showEmergency: (on) => seen.push(on),
  });
  const refusal = Object.assign(new Error('403'), { forbidden: true, status: 403 });
  await notePullFailure('workflows', refusal);
  assert.deepEqual(seen, [false]);
  await notePullFailure('workflows', new Error('Failed to fetch'));
  assert.deepEqual(seen, [false, true]);
});

test('byField() sorts exactly as the arrow it replaced did', () => {
  // Twelve sites carried `(a.name || '').localeCompare(b.name || '')`. The `|| ''` is not decoration:
  // a missing field is common in a partially pulled workspace, and String() would have been a fix
  // rather than a fold - so the helper keeps the coercion the sites actually had, and this compares
  // the two on every shape they meet, missing and null and empty and accented included.
  const { byField } = load([sliceConst('apps/crm/sidepanel.js', 'byField')], {});
  const rows = [{ name: 'pear' }, {}, { name: 'Apple' }, { name: '' }, { name: 'apple' },
    { name: 'Ärger' }, { name: null }, { name: undefined }, { name: 'zebra' }];
  for (const a of rows) for (const b of rows) {
    assert.equal(byField('name')(a, b), (a.name || '').localeCompare(b.name || ''),
      `byField differs from the arrow it replaced on ${JSON.stringify([a, b])}`);
  }
  assert.deepEqual(rows.slice().sort(byField('name')),
    rows.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    'a sorted list came out in a different order');
});

// ---------- the panel opens on the tab the user put first ----------
//
// The tabs are reorderable, and `viewMode` was initialised to the literal 'functions'. The strip
// honoured the order and the panel ignored it: whatever you dragged to the front, Functions was the
// one showing. The correcting line only fired when the current tab was *hidden or refused*, which is
// a different question from "nothing has been chosen yet". Verified by rendering the shipped panel
// headless over tools/fsshim.js with three different orders - functions/workflows/connections first -
// and reading which segment carried `active`; with the defect reintroduced all three answered
// Functions.

test('viewMode starts unchosen, not on a tab named in the source', () => {
  const src = read('apps/crm/sidepanel.js');
  assert.ok(/let viewMode = null,/.test(src),
    'viewMode is initialised to a tab id again - reordering the tabs will not move the panel');
});

test('the first draw selects the first ordered tab', () => {
  const src = read('apps/crm/sidepanel.js');
  assert.ok(/if \(vis\.length && \(viewMode === null \|\| !vis\.includes\(viewMode\)\)\) setMode\(vis\[0\]\);/.test(src),
    'the selection guard no longer covers the unchosen case, so the panel opens on whatever the ' +
    'source names rather than on the tab the user ordered first');
});

test('every entry point that writes the mirror asks for the folder first', () => {
  // Chrome drops the permission between sessions, so a write that has not asked throws a raw
  // NotAllowedError - a sentence naming neither the folder nor the remedy. Analytics guarded two of
  // its five writing entry points: pullAll, pullOne and retryFailed went straight to disk. Found by
  // the twin comparison, not by a report - the CRM guarded nine places and Analytics one, and the
  // asymmetry was the signal.
  const src = read('apps/analytics/sidepanel.js');
  for (const fn of ['pullAll', 'pullOne', 'retryFailed']) {
    const at = src.indexOf(`async function ${fn}(`);
    assert.ok(at > 0, `id=${fn} is gone from the Analytics panel`);
    const head = src.slice(at, at + 700);
    assert.ok(/requirePerm\(dir\)/.test(head),
      `id=${fn} writes the mirror without asking for the folder first`);
  }
});

// ---------- one message, one place ----------
//
// «Se proliferano le funzioni duplicate è la fine» - and a message written out twice is the same
// defect one layer down, because the two copies are one edit away from disagreeing. It had already
// happened: the CRM panel said the same lapsed folder permission three ways in ten places - «needs
// re-granting», «denied», «not granted» - so the reader met three different problems where there
// was one, and the health audit carried seven section titles in two renderers with nothing holding
// them level. Measured on the tree before the fold: 39 clusters over 22 shipped scripts, 25 of them
// in apps/crm/sidepanel.js alone.
//
// The criterion is deliberately crude and was tuned by measuring rather than by argument: a quoted
// literal (never a template chunk), starting with a capital, containing a space. On the fixed tree
// that reports **zero** across every shipped script - no exemption list, no allow-list, nothing to
// keep in step. That matters more than catching every possible case: a checker with false positives
// is one nobody reads, which this repository has learnt twice.
//
// What it does NOT catch, stated rather than left to be discovered:
//   - a fragment that starts lowercase. ` - click to retry` was duplicated three times beside
//     `Failed: ` and is folded into MSG, but nothing here would have found it.
//   - the same sentence spelt differently in two files, or in two apps. The twin rule covers that,
//     and `requirePerm` throwing one wording in both panels is enforced by the case below.
//   - a message built by concatenation, which is not one literal.
// Extend the check when one of those bites; do not extend the care.

/** Every quoted string literal in a script, decoded, with template chunks skipped and `${…}`
 *  expressions scanned - a message inside an interpolation is an ordinary literal and counts.
 *  Comments are skipped: outward the rule never bends, between us it can. */
function messageLiterals(src) {
  const out = [];
  const n = src.length;
  const stack = [];
  let i = 0;
  const escLen = (j) => {
    const c = src[j + 1];
    if (c === 'u' && src[j + 2] === '{') return src.indexOf('}', j) - j + 1;
    return c === 'u' ? 6 : c === 'x' ? 4 : 2;
  };
  const unesc = (j) => {
    const raw = src.slice(j, j + escLen(j));
    try { return JSON.parse('"' + raw.replace(/"/g, '\\"') + '"'); } catch { return raw; }
  };
  // Template text up to the end of the literal or the start of an interpolation. The chunks
  // themselves are never collected - they are not a message, they are the frame around one.
  const skipTplChunk = () => {
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { stack.pop(); i++; return; }
      if (src[i] === '$' && src[i + 1] === '{') return;
      i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c; let j = i + 1, buf = '';
      while (j < n && src[j] !== q && src[j] !== '\n') {
        if (src[j] === '\\') { buf += unesc(j); j += escLen(j); continue; }
        buf += src[j]; j++;
      }
      // An unterminated quote is a regex or an apostrophe in code, not a string: step over it.
      if (src[j] === q) { out.push({ s: buf, line: src.slice(0, i).split('\n').length }); i = j + 1; continue; }
      i++; continue;
    }
    if (c === '`') { stack.push('tpl'); i++; skipTplChunk(); continue; }
    if (c === '$' && src[i + 1] === '{' && stack[stack.length - 1] === 'tpl') { stack.push('expr'); i += 2; continue; }
    if (c === '{' && stack[stack.length - 1] === 'expr') { stack.push('brace'); i++; continue; }
    if (c === '}' && stack.length) {
      const top = stack.pop(); i++;
      if (top === 'expr') skipTplChunk(); else if (top !== 'brace') stack.push(top);
      continue;
    }
    i++;
  }
  return out;
}
// ---------- A group header is a control, in every list that draws one ----------

test('every group header folds its list, because the CSS already promises it does', () => {
  // Reported: on the Actions tab, clicking «FIELD UPDATES» did nothing, while the same click on the
  // Functions tab folded the group away. `renderActions` built its header without a `collapsed`
  // lookup and without an onclick - and `.grp` carries `cursor:pointer`, so it looked like a control
  // and was not. The worst shape of this defect: not a missing feature, a lie about what is clickable.
  //
  // It is the schematic-piece rule, which this project states and had not enforced: when you add one
  // of a set, it does everything its siblings do. Four lists had it and the fifth did not, and
  // nothing was measuring, so the check is derived from the tree rather than from a list of tabs -
  // a sixth one written tomorrow is covered without anybody remembering.
  const findings = [];
  for (const rel of shippedScripts()) {
    const lines = read(rel).split('\n');
    lines.forEach((line, i) => {
      if (!/className = 'grp'/.test(line)) return;
      // The header and its wiring are written together, within a few lines - that is how all four
      // working ones read. A window is enough and avoids parsing JavaScript to find a block, and it
      // opens *above* the header: every one of them reads `collapsed.has` first and uses the answer
      // on the className, so a window starting at the header itself reports all five as broken.
      const near = lines.slice(Math.max(0, i - 4), i + 6).join('\n');
      // Two halves, asserted separately, because either alone passes while the header is broken.
      // The first version of this asked only whether the block mentioned `collapsed` at all, and a
      // planted defect that made the chevron constant - `const isCol = false` - sailed through it,
      // since the onclick still said `collapsed.add`. Reading the state and writing it are different
      // jobs: without the read the arrow never turns and the rows never hide.
      if (!/collapsed\.has\(/.test(near)) {
        findings.push(`${rel}:${i + 1} draws a .grp whose folded state is never read`);
      }
      if (!/\.onclick\s*=/.test(near)) findings.push(`${rel}:${i + 1} draws a .grp with no onclick`);
    });
  }
  assert.deepEqual(findings, [], findings.join('\n'));
});

test('the folded state of one list cannot fold another', () => {
  // `collapsed` is a single Set shared by every list in the panel, so the keys have to be namespaced
  // or two tabs collide - a function namespace and an action kind that happen to share a word would
  // fold each other, which is untraceable from either screen. Functions owns the bare key by being
  // first; everything since carries a prefix.
  const src = read('apps/crm/sidepanel.js');
  const keys = [...src.matchAll(/collapsed\.(?:has|add|delete)\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(keys.length >= 8, `expected the five lists to use collapsed, found ${keys.length} uses`);
  const bare = keys.filter((k) => !/^'[a-z]+:'/.test(k));
  // Only the functions tree, which predates the convention and would need a migration to change.
  assert.deepEqual([...new Set(bare)], ['ns'],
    `a list is keying collapsed without a prefix: ${[...new Set(bare)].join(', ')}`);
});

const looksLikeMessage = (s) => /^[A-Z]/.test(s) && s.includes(' ');

/** Every .js an app ships, globbed rather than listed - a file added tomorrow is covered without
 *  anyone remembering, which is the only direction that fails safe. */
function shippedScripts() {
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true }).filter((d) => d.isDirectory());
  const out = [];
  for (const a of apps) {
    for (const f of readdirSync(join(ROOT, 'apps', a.name))) {
      if (f.endsWith('.js')) out.push(`apps/${a.name}/${f}`);
    }
  }
  return out.sort();
}

export function duplicateMessages(rel) {
  const seen = new Map();
  for (const { s, line } of messageLiterals(read(rel))) {
    if (!looksLikeMessage(s)) continue;
    if (!seen.has(s)) seen.set(s, []);
    seen.get(s).push(line);
  }
  return [...seen].filter(([, lines]) => lines.length > 1);
}

test('the scanner finds a duplicate, and is not fooled by comments or templates', () => {
  // Proving the check can fail, on inputs rather than by mutating the tree: a checker that has
  // never caught anything is a claim, not a check.
  const dup = messageLiterals(`a('Folder access needs re-granting.'); b('Folder access needs re-granting.');`);
  assert.equal(dup.filter((d) => looksLikeMessage(d.s)).length, 2, 'two plain literals were not both seen');

  const inComment = messageLiterals(`// See 'Pull all now' twice\nx('Pull all now');`);
  assert.equal(inComment.filter((d) => looksLikeMessage(d.s)).length, 1,
    'a message quoted in a comment counted as a use - comments are exempt on purpose');

  const inTpl = messageLiterals('x(`Pull all now ${y} Pull all now`);');
  assert.equal(inTpl.filter((d) => looksLikeMessage(d.s)).length, 0,
    'template text was collected as a literal - a chunk is the frame around a message, not one');

  const inInterp = messageLiterals("x(`${a ? 'Pull all now' : 'Pull all now'}`);");
  assert.equal(inInterp.filter((d) => looksLikeMessage(d.s)).length, 2,
    'a literal inside an interpolation was missed - that is where the engine labels were hiding');

  const escaped = messageLiterals(`a('Loading\\u2026 now'); b('Loading… now');`);
  assert.equal(new Set(escaped.map((d) => d.s)).size, 1,
    'the two escape spellings of one sentence read as two different messages');
});

test('no shipped script says the same thing twice', () => {
  const files = shippedScripts();
  assert.ok(files.length >= 20, `id=glob found only ${files.length} shipped scripts - the walk is wrong`);
  const findings = [];
  for (const rel of files) {
    for (const [s, lines] of duplicateMessages(rel)) {
      findings.push(`${rel}: ${JSON.stringify(s.slice(0, 60))} at lines ${lines.join(', ')}`);
    }
  }
  assert.equal(findings.length, 0,
    'a user-facing message is written out more than once - give it a name (MSG.x, or a const beside '
    + 'its siblings) so the two copies cannot drift apart:\n  ' + findings.join('\n  '));
});

test('both panels report a lapsed folder permission in the same words', () => {
  // requirePerm() exists in both apps and is the one place that throws it. Two wordings would mean
  // the same browser behaviour arrives as two different problems depending on which Zoost you are
  // in - the drift the twin rule exists to stop, in the helper a previous pass folded for it.
  const wording = ['apps/crm/sidepanel.js', 'apps/analytics/sidepanel.js'].map((rel) => {
    const src = read(rel);
    assert.ok(/async function requirePerm\(h\) \{ if \(!\(await ensurePerm\(h\)\)\) throw new Error\(MSG\.folder\); \}/.test(src),
      `id=${rel} no longer throws MSG.folder from requirePerm`);
    return (src.match(/^\s*folder: '([^']*)',/m) || [])[1];
  });
  assert.ok(wording[0], 'id=crm has no MSG.folder to compare');
  assert.equal(wording[0], wording[1], 'the two panels word the lapsed folder permission differently');
  assert.ok(wording[0].includes('↻'), 'MSG.folder no longer names the ↻ Refresh button that fixes it');
});

// The environment guard disables every Zoho-bound control, not the first one somebody remembered.
// Reported: on a tab/workspace mismatch `Pull all` went grey and the per-type `Pull` stayed live,
// failing at the click with a message instead - two controls that read from Zoho, one of them
// guarded. `ZOHO_BTNS` already knew there were two; the guard named `pull` by hand. Measured by
// rendering the panel against a non-sample fixture with a tab reporting a different org:
// before, `pull=OFF pullone=on`; after, both off, and both on again when the orgs line up.
test('the mismatch guard drives every Zoho-bound button from one list', () => {
  const src = read('apps/crm/sidepanel.js');
  const zoho = src.match(/const ZOHO_BTNS = \[([^\]]*)\]/);
  assert.ok(zoho, 'id=crm ZOHO_BTNS is gone - the list the guard derives from');
  assert.ok(/'pull'/.test(zoho[1]) && /'pullone'/.test(zoho[1]),
    'id=crm ZOHO_BTNS no longer holds both pull buttons');
  // No line may disable one of them on its own: that is exactly how they came apart.
  for (const m of src.matchAll(/\$\('(pull|pullone)'\)\.disabled\s*=/g)) {
    assert.fail(`id=crm $('${m[1]}').disabled is set by hand at index ${m.index} - `
      + 'drive it from ZOHO_BTNS so the two cannot drift');
  }
  // and the one that downloads without being in that list guards at the call instead
  assert.ok(/async function downloadMissing\(\) \{[\s\S]{0,400}?if \(!zohoReady\(\)\)/.test(src),
    'id=crm downloadMissing no longer refuses the wrong tab');
});

// The workspace dropdown is ordered by what the reader sees. Reported as unordered, and it was, in
// two different ways: Analytics did not sort at all, and the CRM sorted by the derived folder name
// while the option shows the user's own label when there is one - so «Acme» in a folder called
// «zzz-…» sat at the end. Both panels share one comparator now.
for (const app of ['crm', 'analytics']) {
  test(`${app}: the workspace list sorts by the text the option shows`, () => {
    const { byWsLabel, wsOptionText } = load([
      sliceFn(`apps/${app}/sidepanel.js`, 'wsOptionText'),
      sliceFn(`apps/${app}/sidepanel.js`, 'byWsLabel'),
    ]);
    const ws = [
      { id: '1', folder: 'f', name: 'zzz-9999999999', cfg: { label: 'Acme' } },
      { id: '2', folder: 'f', name: 'client-10' },
      { id: '3', folder: 'f', name: 'client-2' },
      { id: '4', folder: 'f', name: 'Alfa' },
      { id: '5', folder: 'f', name: 'aaa-1111111111', cfg: { label: 'zeta' } },
    ];
    const got = ws.slice().sort(byWsLabel).map(wsOptionText);
    assert.deepEqual(got.map((x) => x.split(' ')[0]), ['Acme', 'Alfa', 'client-2', 'client-10', 'zeta'],
      `id=${app} the dropdown is not in the order the reader reads: ` + got.join(' | '));
  });
}

// One comparator, byte for byte, on both sides - the bar is shared chrome and a list ordered two
// ways is exactly the discontinuity the twin rule exists to stop.
test('both panels order the workspace list with the same comparator', () => {
  // sliceFn hands back the function and whatever follows it, and what follows differs between the
  // two by design (wsOptionTitle). The comparator is one line; that is the line to compare.
  const line = (rel) => sliceFn(rel, 'byWsLabel').trim().split('\n')[0].trim();
  assert.equal(line('apps/crm/sidepanel.js'), line('apps/analytics/sidepanel.js'),
    'id=byWsLabel the two panels sort the workspace list differently');
});

// A function answers to three names and Zoho means a different thing by each: display_name, the
// lowercased api_name slug, and `name` - the CamelCase one you write in Deluge. The tree filter
// checked two of them, so searching for the name copied out of a call found nothing; the graph
// window checked a different two. Reported. Which name is *shown* is the reader's choice; which are
// *searched* is not one.
test('the function search accepts every name a function answers to', () => {
  const src = panelBody('crm');
  const m = src.match(/const FN_NAMES = \[([^\]]*)\]/);
  assert.ok(m, 'id=crm FN_NAMES is gone - the list the search derives from');
  for (const k of ['api_name', 'display_name', 'name']) {
    assert.ok(m[1].includes(`'${k}'`), `id=crm FN_NAMES no longer holds ${k}`);
  }
  assert.ok(/FN_NAMES\.some\(/.test(src), 'id=crm the tree filter stopped deriving from FN_NAMES');
  // and the diagram window has to agree, or the same box behaves differently in two places
  const gv = read('apps/crm/graphview.js');
  const line = gv.split('\n').find((l) => /return !q \|\|/.test(l));
  assert.ok(line, 'id=graphview the node search is gone');
  for (const k of ['n.name', 'n.display_name', 'n.api_name']) {
    assert.ok(line.includes(k), `id=graphview the node search no longer looks at ${k}`);
  }
});

// The picklist is written out as literal pairs on purpose - `featurecheck.py` reads them, and a
// derived list would take four named capabilities out of its sight, which is the coverage regression
// this project has already paid for once. The cost of the literal is that it can drift from the map
// it is offering, so that is what this holds: the same trap as KIND_FILTERS being derived from
// FILTERS rather than repeated - add a sort, forget the other list, and the option selects nothing.
test('every Actions sort is offered, and every option sorts by something', () => {
  const src = panelBody('crm');
  const map = src.slice(src.indexOf('const ACTION_SORTS = {'));
  const keys = [...map.slice(0, map.indexOf('\n};')).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 4, 'id=crm ACTION_SORTS no longer parses');
  const at = src.indexOf("[['name', 'Kind, then name']");
  assert.ok(at > 0, 'id=crm the Actions sort picklist is gone or has been rewritten');
  const list = src.slice(at, src.indexOf('\n', at));
  const offered = [...list.matchAll(/\['(\w+)',/g)].map((x) => x[1]);
  assert.deepEqual(offered.slice().sort(), keys.slice().sort(),
    `id=crm the picklist offers ${offered} and ACTION_SORTS holds ${keys}`);
});

// Reported: an action was selected, the assistant said it had no reference, and the line above the
// chat agreed with it - «No function focused». aiFocus() had no branch for that kind and the label
// read `.dg` and nothing else, so both halves were wrong in the same direction. They are checked
// together because a label that contradicts what the prompt carries is worse than one saying nothing.
test('the chat knows what is focused, whatever kind it is', () => {
  const src = panelBody('crm');
  const focus = src.slice(src.indexOf('async function aiFocus()'), src.indexOf('function productHelp()'));
  const label = src.slice(src.indexOf('function aiFocusLabel()'), src.indexOf('async function aiContextLabel()'));
  for (const kind of ['workflows/', 'schedules/', 'connections/', 'modules/', 'actions/']) {
    assert.ok(focus.includes(`p.startsWith('${kind}')`), `id=crm aiFocus sends nothing for ${kind}`);
    assert.ok(label.includes(`p.startsWith('${kind}')`), `id=crm the context line cannot name ${kind}`);
  }
  assert.ok(!/No function focused/.test(src), 'id=crm the label still claims only functions can be focused');
});

// The panel's width is Chrome's - `chrome.sidePanel` has no say in it, `getLayout()` reports which
// side it is on and nothing else - so the sixth tab wrapping the segment row onto two lines at the
// width the user happens to have is only fixable here. Reported. The thresholds are a measurement
// (400px as authored, 380 with the spacing closed, 330 at 10px) and are not asserted; what is
// asserted is the algorithm, which is where this can go wrong: escalate only as far as needed, and
// always decide from the untightened state so it can come back and cannot oscillate.
test('the segment row is tightened only as far as it has to be', () => {
  // `setBar` is handed back the same way the function under test is: `load` evaluates the pieces
  // in a vm context of its own, so the test cannot reach into it with globalThis.
  const { fitTabs, setBar } = load([
    'let bar; const $ = () => bar;',
    sliceFn('apps/crm/sidepanel.js', 'fitTabs'),
    'const setBar = (b) => { bar = b; };',
  ]);
  // A stub whose layout depends on the classes, the way the real one depends on the CSS: `need` is
  // how much width each step costs, and rows are recomputed from the width on every read.
  const make = (width, need = { none: 400, tight: 380, tighter: 330 }) => {
    const cls = new Set();
    const step = () => (cls.has('tighter') ? 'tighter' : cls.has('tight') ? 'tight' : 'none');
    const kids = [0, 1, 2, 3, 4, 5].map((i) => ({ get offsetTop() { return width >= need[step()] ? 0 : (i < 3 ? 0 : 20); } }));
    return { classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c) },
             querySelectorAll: () => kids, get className() { return [...cls].join(' '); } };
  };
  const run = (w) => { const b = make(w); setBar(b); fitTabs(); return b.className; };
  assert.equal(run(420), '', 'id=crm a row with room to spare is being shrunk');
  assert.equal(run(390), 'tight', 'id=crm the labels shrink before the spacing has been closed');
  assert.equal(run(360), 'tight tighter', 'id=crm it stops one step short and still wraps');
  assert.equal(run(300), 'tight tighter', 'id=crm below the floor it wraps, having tried everything');
  // ...and the state is not latched: the same element, widened, must come back to as-authored.
  const b = make(420); setBar(b);
  b.classList.add('tight', 'tighter');
  fitTabs();
  assert.equal(b.className, '', 'id=crm tightening never comes off, so the panel stays small for ever');
});

// Reported: in Health, «Automation actions nothing fires» rendered a plain list while the function
// findings beside it were links. The cause is the shape rather than the omission - two kinds fitted
// in a ternary and the third and fourth did not - so what is asserted is that the openers are a map
// and that every kind a finding can name has one. A health row that names something and cannot open
// it is a dead end in the one view whose whole purpose is to send you somewhere.
test('every kind of health finding has a way to open it', () => {
  const src = panelBody('crm');
  const map = src.slice(src.indexOf('const HEALTH_OPEN = {'), src.indexOf('};', src.indexOf('const HEALTH_OPEN = {')));
  assert.ok(map, 'id=crm HEALTH_OPEN is gone - the openers are a conditional again');
  // The literal ones. The workflow/schedule pair is written `data-kind="${escA(b.kind)}"` - one
  // attribute carrying two kinds - so it is asserted by name below rather than found here.
  const named = [...src.matchAll(/data-kind="(\w+)"/g)].map((m) => m[1]);
  assert.ok(named.length >= 2, `id=crm only ${named.length} kinds of finding are linked at all`);
  for (const k of new Set(named)) {
    assert.ok(new RegExp(`\\b${k}:`).test(map), `id=crm a finding names a ${k} and nothing opens one`);
  }
  // ...and the interpolated kinds are covered too: `data-kind="${escA(b.kind)}"` is the workflow and
  // schedule pair, which the map has to keep.
  for (const k of ['workflow', 'schedule']) {
    assert.ok(new RegExp(`\\b${k}:`).test(map), `id=crm nothing opens a ${k}`);
  }
});
