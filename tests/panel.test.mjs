/*
 * Pure logic inside the panels and the bridges. Every case here is a bug that happened.
 *
 * These functions live in browser scripts that assume a DOM, so they are lifted out by
 * tests/slice.mjs and run alone. Read the note at the top of that file for what the technique does
 * and does not prove — in short: it catches wrong logic, it does not catch a correct helper wired
 * to the wrong caller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceFn, sliceConst, load, read } from './slice.mjs';

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
  const marked = ['pull', 'pullone', 'graph', 'dpull', 'dgraph'];
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
    const p = src.slice(src.indexOf('function pass('), src.indexOf('\n}', src.indexOf('function pass(')));
    assert.ok(!/n\.namespace !== /.test(p), `${app}: a filter compares the namespace again`);
  }
});

test('every value the chips select has a colour, and no condition has one', () => {
  // A hue says "this is a kind of thing". hub, orphan, no-caller and unresolved are not kinds, they
  // are facts about one — giving them a colour would claim eleven categories where there are six.
  const VALUES = {
    crm: ['standalone', 'automation', 'button', 'schedule', 'validation_rule', 'rest', 'standard', 'custom'],
    analytics: ['standalone', 'automation', 'button', 'schedule', 'validation_rule', 'rest', 'table', 'query', 'system'],
  };
  const CONDITIONS = ['all', 'hub', 'orphan', 'dead', 'unres'];
  for (const [app, values] of Object.entries(VALUES)) {
    const css = read(`apps/${app}/graphview.html`);
    for (const v of values) assert.match(css, new RegExp(`--n-${v}\\s*:`), `${app}: no colour for «${v}»`);
    for (const c of CONDITIONS) assert.ok(!css.includes(`--n-${c}:`), `${app}: «${c}» is a condition and has been given a hue`);
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
    assert.match(src, /if \(!sameWs\) \{ const n = dropWorkspaceState\(\)/,
      `${app} does not call it when the workspace changes`);
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
