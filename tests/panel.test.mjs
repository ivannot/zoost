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
const { aiFocus } = load([sliceFn('apps/crm/sidepanel.js', 'aiFocus')], focusCtx);

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
  const out = await looking('_workflows/42.json', {
    __wf: [{ path: '_workflows/42.json', name: 'Notify owner', id: '42' }],
    __files: { '_workflows/42.json': JSON.stringify({ name: 'Notify owner', actions: ['send mail'] }) },
  });
  assert.match(out, /the workflow «Notify owner»/);
  assert.match(out, /send mail/, 'the file, which is where "what does it do" is answered');
});

test('a workflow whose detail was never pulled says so rather than looking complete', async () => {
  const out = await looking('_workflows/7.json', { __wf: [{ path: '_workflows/7.json', name: 'Half known' }] });
  assert.match(out, /the workflow «Half known»/);
  assert.match(out, /have not been pulled/);
});

test('schedules, connections and modules each get a focus of their own', async () => {
  const sc = await looking('_schedules/9', { __sc: [{ path: '_schedules/9', name: 'Nightly' }] });
  assert.match(sc, /the schedule «Nightly»/);

  const cn = await looking('_connections/books', { __cn: [{ path: '_connections/books', name: 'books', label: 'Books API' }] });
  assert.match(cn, /the connection «Books API»/);

  const md = await looking('_modules/Contacts.json', { __md: [{ path: '_modules/Contacts.json', api_name: 'Contacts', label: 'Contacts' }] });
  assert.match(md, /the module «Contacts»/);
});

test('nothing selected, or something with no focus to give, adds nothing', async () => {
  assert.equal(await looking(null), '');
  assert.equal(await looking('export/report.html'), '');
  assert.equal(await looking('_schedules/404'), '', 'a path with no matching entry is silent, not broken');
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
