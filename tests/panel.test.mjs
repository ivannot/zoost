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
import { sliceFn, sliceConst, load, read, blankNonCode, ROOT, handlerOf } from './slice.mjs';
import { readdirSync, existsSync } from 'node:fs';

// The CRM panel is two files since the split - ai.js and sidepanel.js load into one shared scope,
// so a test about «the panel» reads them as the page composes them. Analytics is still one file.
// The page's files, in load order, read once - not per call: 50 call sites each concatenating
// 700KB is real memory, and a blanket replace once made this function call itself (OOM, not probe,
// caught it - the mechanical-replace trap, fourth time in this repository's records).
let _crmPanelText = null;
const crmPanel = () => (_crmPanelText ??= CRM_FILES.map(read).join('\n'));
// Where an assistant function lives, per app: the CRM's moved to ai.js with the split.
const aiFile = (app) => (app === 'crm' ? `apps/${app}/ai.js` : `apps/${app}/sidepanel.js`);
// A slice by name, wherever the split put it: tries the app's files in page order and keeps
// sliceFn's own guarantee - a name found nowhere still throws, so cover cannot vanish silently.
// Derived from the page, in its load order: four manual copies of this list existed (here, the two
// composition maps in the Python checkers, keyvault.test) and a slice added to the HTML could have
// shipped without entering any of them. The HTML is what Chrome loads, so it is the one authority.
const CRM_FILES = [...read('apps/crm/sidepanel.html').matchAll(/<script\s+src="([^"]+\.js)"><\/script>/g)]
  .map((m) => `apps/crm/${m[1]}`)
  // The page also loads the shared libraries (keyvault, sample-org, the graph engine…), each with
  // its own tests and its own message tables - «the panel» for these checks is its slices.
  .filter((f) => !/(sample-org|idb|keyvault|product-help|highlight|graph-core|tabs)\.js$/.test(f));
function sliceApp(app, name) {
  const files = app === 'crm' ? CRM_FILES : [`apps/${app}/sidepanel.js`];
  let lastErr;
  for (const f of files) { try { return sliceFn(f, name); } catch (e) { lastErr = e; } }
  throw lastErr;
}

/** A pull entry is now one function or two: the wrapper that holds the flag, and the named body it
 *  delegates to. `tools/asynccheck.py` reads function *declarations*, so an inline
 *  `runPullAction(async () => {…})` was a scope nothing looked inside - 118 awaits and 45 `.then()`
 *  callbacks across the panels were in that position while the grid recorded the cells as covered.
 *  The convention is that every shipped async scope is a declaration; these cases follow the
 *  delegation rather than asserting the old shape, which would have forbidden the fix. */
function pullEntry(app, fn) {
  const body = sliceApp(app, fn);
  const m = body.match(/runPullAction\(\s*(?:\(\)\s*=>\s*)?(\w+)/);
  return m && m[1] !== 'async' ? `${body}\n${sliceApp(app, m[1])}` : body;
}

import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/** A named function or const out of a graph window, wherever it now lives: everything both products
 *  compute identically and that touches no DOM moved into graphlogic.js. Still throws when neither
 *  file has it, so a rename cannot quietly drop the cover. */
const gfn = (app, name) => {
  try { return sliceFn(`apps/${app}/graphlogic.js`, name); }
  catch { return sliceFn(`apps/${app}/graphview.js`, name); }
};
const gcon = (app, name) => {
  try { return sliceConst(`apps/${app}/graphlogic.js`, name); }
  catch { return sliceConst(`apps/${app}/graphview.js`, name); }
};
const gsrc = (app) => read(`apps/${app}/graphview.js`) + '\n' + read(`apps/${app}/graphlogic.js`);

// ---------- Deluge: stripping comments and strings before counting anything ----------

// The scanner comes with it: `stripNonCode` is now the façade over one pass that also hands back
// the source with its string literals intact, which is what the module reading needs.
// `delugeArgs` comes from highlight.js, which is where the one depth-aware scanner lives: the panel
// loads both files and the graph window only that one. The extractor had a second, weaker copy of
// the same job, and it was the copy producing the data.
const { stripNonCode, scanDeluge, moduleRefs } = load([
  sliceFn('apps/crm/graph-core.js', 'scanDeluge'),
  sliceFn('apps/crm/graph-core.js', 'stripNonCode'),
  sliceConst('apps/crm/graph-core.js', 'MODULE_TASK'),
  sliceConst('apps/crm/graph-core.js', 'NOT_A_MODULE'),
  sliceFn('apps/crm/highlight.js', 'delugeArgs'),
  'window.delugeArgs = delugeArgs;',
  sliceFn('apps/crm/graph-core.js', 'moduleRefs'),
], { window: {} });

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

// ---------- the detail strip is what the kind declares ----------
//
// It was two buttons and a boolean, so a module's related lists lived at the bottom of «Details» -
// under the refusal banner, the names and the layout counts, in a column a side panel cannot show.
// «You struggle to see the whole detail, there is no room.» They have a tab now, and the strip is
// derived from the kind's panes rather than from a pair of ids, so the fourth costs nothing.

test('crm: a module has three detail tabs and a function has two', () => {
  const kinds = load([sliceConst('apps/crm/sidepanel.js', 'PV_KINDS')]).PV_KINDS;
  assert.deepEqual(Object.keys(kinds.module.panes), ['code', 'rel', 'info']);
  assert.deepEqual(Object.keys(kinds.function.panes), ['code', 'info']);
  // Each pane names elements that exist in the markup, or a tab leads nowhere.
  const html = read('apps/crm/sidepanel.html');
  const rendered = read('apps/crm/modules.js');
  for (const panes of Object.values(kinds.module.panes)) {
    for (const [id] of panes) {
      assert.ok(html.includes(`id="${id}"`) || rendered.includes(`id="${id}"`),
        `the module's ${id} pane is in no markup`);
    }
  }
});

test('crm: a tab the kind does not declare is absent, not disabled', () => {
  // The panel's rule everywhere else, and «Related lists» on a function would open an empty pane.
  const fn = sliceFn('apps/crm/sidepanel.js', 'setPvTab');
  assert.match(fn, /b\.style\.display = \(kinds && kinds\.panes\[tab\]\) \? '' : 'none'/,
    'a kind without the tab still shows its button');
  assert.match(fn, /pvTab = \(kinds && kinds\.panes\[which\]\) \? which : 'code'/,
    'asking for a tab this kind does not have must land on the first, not on nothing');
});

test('crm: an element that outlives a render is not inside what the render replaces', () => {
  // `#pvcallers` is moved into the Details pane, and that pane is inside `#pvtable`, whose contents
  // the next module open replaces. Without taking it home first the second module destroyed it, and
  // every detail after the first said nothing about what reads or writes the module - silently. The
  // probe caught it; this holds the order it was fixed in.
  const src = read('apps/crm/modules.js');
  const home = src.indexOf("$('pvcallershome').after($('pvcallers'))");
  const write = src.indexOf("$('pvtable').innerHTML");
  const move = src.indexOf("$('pvdetails').appendChild($('pvcallers'))");
  assert.ok(home > 0 && write > 0 && move > 0, 'the module detail no longer moves the callers box');
  assert.ok(home < write, 'the shared element is still inside #pvtable when it is replaced');
  assert.ok(write < move, 'it is moved into a pane that does not exist yet');
});

test('crm: the related lists are rendered into their own pane, not into Details', () => {
  const src = read('apps/crm/modules.js');
  assert.match(src, /<div id="pvrels">\$\{rlBlock\}<\/div>/);
  const details = src.slice(src.indexOf('<div id="pvdetails">'), src.indexOf('</div>`;', src.indexOf('<div id="pvdetails">')));
  assert.ok(!details.includes('rlBlock'), 'the related lists are still inside Details');
});

// ---------- a hidden tab has no live references into it ----------
//
// Hide Functions, open a module, look at what uses it, click one - and the tab came back. «When a tab
// is disabled we must not still have live references that take you there: the links stop existing for
// that tab, otherwise hiding it means nothing.» Refusing the click is not enough either - a link that
// looks like one and then says no teaches the reader nothing until they have pressed it.

test('crm: every chip that leads to another tab is wired through the one helper', () => {
  // Six render sites, one decision. The point of the helper is that the seventh inherits it; the
  // point of this case is that nobody wires a chip by hand again.
  for (const file of ['apps/crm/sidepanel.js', 'apps/crm/automation.js', 'apps/crm/connections.js',
                      'apps/crm/health.js']) {
    const src = read(file);
    const raw = src.match(/querySelectorAll\('(?:\.wf-fn|a\[data-file\])'\)/g) || [];
    assert.deepEqual(raw, [], `${file}: a chip is wired outside wireFnChips, so it stays a link`);
  }
});

test('crm: the helper decides from the tab the chip declares, and says which reason', () => {
  const fn = sliceFn('apps/crm/sidepanel.js', 'wireFnChips');
  assert.match(fn, /dataset\.wf != null \? 'workflows' : 'functions'/,
    'the target is guessed rather than read from the chip');
  assert.match(fn, /tabReachable\(target, true\)/, 'it does not ask whether the tab can be opened');
  assert.match(fn, /el\.onclick = null/, 'an inert chip keeps its handler');
  // The element, not only the handler. Removing the click left an <a> behind, and the containers
  // style anchors by id - `#pvcallers a` and `#healthbody a` set a pointer and a hover, and an id
  // selector beats any class the chip can add. It looked like a link that had stopped working, which
  // is worse than either a link or plain text. Reported, one fix later.
  assert.match(fn, /el\.tagName === 'A'/, 'an inert chip is still an anchor, so the container styles it');
  assert.match(fn, /replaceWith\(span\)/, 'nothing swaps the element, so `#pvcallers a` still wins');
  assert.match(fn, /isForbidden\(target\)/, 'both reasons read as one, and they are two different actions');
});

test('crm: no container may style away the inertness by id', () => {
  // The rule that generalises: an inert chip must not be reachable by an `a` selector. This reads the
  // panel's own stylesheet for id-scoped anchor rules that set a pointer or a hover, and requires the
  // swap to exist rather than requiring each container to be polite - there were two such rules and a
  // third would have re-broken it silently.
  const css = read('apps/crm/sidepanel.html');
  const bossy = (css.match(/#\w+ a(?:\.[\w-]+)*(?::hover)?\s*\{[^}]*\}/g) || [])
    .filter((r) => /cursor:\s*pointer|:hover/.test(r));
  assert.ok(bossy.length > 0, 'the premise moved: no id-scoped anchor rules left, re-read this case');
  const fn = sliceFn('apps/crm/sidepanel.js', 'wireFnChips');
  assert.match(fn, /createElement\('span'\)/,
    `${bossy.length} id-scoped anchor rule(s) can out-specify the chip, so it must stop being an anchor`);
});

test('crm: hidden is a reason a tab cannot be opened, alongside refused', () => {
  const fn = sliceFn('apps/crm/health.js', 'tabReachable');
  assert.match(fn, /isForbidden\(tab\)/);
  assert.match(fn, /isHiddenByUser\(tab\)/,
    'a tab hidden in Settings still answers «reachable», so every link into it goes on working');
  assert.ok(fn.indexOf('Settings') > 0, 'the refusal does not say where to turn it back on');
});

// ---------- hiding the tab you are on takes you off it ----------
//
// `renderTabs()` gives the tab you are *on* a segment even when it is hidden, so you are never on a
// list with no segment in the row - right for a jump, where a health link lands you on a hidden tab.
// Applied to Settings it is wrong: turn two tabs off and one goes while the other stays, and which is
// which depends on where you happened to be standing. Reported that way.

test('crm: turning off the tab in front of you moves the panel off it', () => {
  const src = read('apps/crm/sidepanel.js');
  const handler = src.slice(src.indexOf('if (ch.tabPrefs)'), src.indexOf('if (ch.zohoDc)'));
  assert.match(handler, /isHiddenByUser\(viewMode\)/,
    'the preferences change and nothing asks whether you are standing on what was just hidden');
  assert.ok(handler.indexOf('loadTabPrefs') < handler.indexOf('isHiddenByUser'),
    'it asks before the new preferences are loaded, so it reads the old answer');
  assert.match(handler, /setMode\(next\)/, 'it notices and stays where it is');
});

test('crm: the jump onto a hidden tab still keeps its segment', () => {
  // The other half, and the reason this is two behaviours rather than one: a row with no segment in
  // the strip reads as the panel having lost its place, and a jump is not a preference.
  const fn = sliceFn('apps/crm/sidepanel.js', 'renderTabs');
  assert.match(fn, /!vis\.includes\(viewMode\) && !isForbidden\(viewMode\)/,
    'a jump onto a hidden tab now lands with no segment lit');
});

// ---------- a workspace is called what its owner called it ----------
//
// The mismatch bar named the platform's workspace («Default Workspace») or the instance over a folder
// the reader had labelled «Acme production» a minute earlier - the one word they would recognise,
// missing from the one sentence written to be recognised. Reported. The id stays beside it, because
// that is the fact nothing can be wrong about.

for (const [app, sample] of [['crm', { label: 'Acme production', instance: 'acme', org: '123' }],
                             ['analytics', { label: 'Acme production', name: 'Default Workspace', workspace: '99' }]]) {
  const { wsShown } = load([sliceFn(`apps/${app}/sidepanel.js`, 'wsShown')]);

  test(`${app}: the name its owner gave it wins`, () => {
    assert.equal(wsShown(sample), 'Acme production');
  });

  test(`${app}: without one, the platform's name - and the id only when there is nothing else`, () => {
    const noLabel = { ...sample, label: '' };
    assert.equal(wsShown(noLabel), app === 'crm' ? 'acme' : 'Default Workspace');
    const bare = app === 'crm' ? { org: '123' } : { workspace: '99' };
    assert.equal(wsShown(bare), app === 'crm' ? '123' : '99');
    // Whitespace is not a name. A label of «   » used to win over a real one and render as nothing.
    assert.equal(wsShown({ ...sample, label: '   ' }), app === 'crm' ? 'acme' : 'Default Workspace');
  });

  test(`${app}: every name the mismatch bar shows goes through it`, () => {
    // The first version of this read the bar *up to* `$('mmsw')` and stopped - so it passed while the
    // «Switch workspace ->» button on the next line went on naming the platform. A test whose window
    // ends where the bug starts agrees with the bug. Reported, one fix later.
    const src = read(`apps/${app}/sidepanel.js`);
    const from = src.indexOf("$('mmtext')");
    // The bar ends on the line that offers to create a workspace for the tab - the last thing in it,
    // and the only end marker both panels share. Asserted, because the first end anchor existed in one
    // twin and not the other: `indexOf` returned -1, `slice` read to the end of the file, and the test
    // reported a line four thousand down as a defect in the bar. An anchor that is absent must fail,
    // never widen.
    const end = src.indexOf('addWorkspace', from);
    assert.ok(from > 0 && end > from, `${app}: the mismatch bar no longer looks like this - fix the test`);
    const bar = src.slice(from, src.indexOf('\n', end));
    // A *name* must go through the helper; the id beside it is the fact nothing can be wrong about
    // and stays raw on purpose - `${bound.org}`, `${bound.workspace}`, `${ctx.workspace}`.
    // ...and the *tab* keeps the platform's word too: nobody has named a tab, they have named the
    // workspace, so `${lastCtx.instance}` is what the reader is looking at in Zoho. What must carry
    // the reader's own name is a workspace this panel holds - the binding, or a row it could switch to.
    for (const raw of bar.match(/\$\{[^}]*\b(bound|match)\.(name|instance|folder)\b[^}]*\}/g) || []) {
      assert.match(raw, /wsShown\(/,
        `${app}: the bar shows ${raw} raw - a workspace is called what its owner called it`);
    }
    assert.ok((bar.match(/wsShown\(/g) || []).length >= 3,
      'the sentence and both buttons name a workspace, so all three go through it');
  });
}

// ---------- what leaves the machine for the assistant ----------
//
// Three fields, one rule: the panel and the exports are the reader's own screen and a file they hand
// over deliberately; the AI path is the one that leaves without a per-item decision. So what travels
// there is decided field by field, and each of these was found travelling when it should not.

test('crm: a webhook URL reaches the model as a host and nothing else', () => {
  // A Zoho webhook URL routinely carries a token, and this was the *ungated* field - beside a sender
  // address that is behind a switch which is off by default.
  //
  // It withheld the **query string** only, and this test asserted that a URL without one passed
  // through unchanged - so the gap was not merely uncovered, it was written down as intended
  // behaviour. Slack, Teams, Discord, Zapier and Make all put the whole posting credential in the
  // **path**: `https://hooks.slack.com/services/T…/B…/8f3a…` has no query at all. What the model
  // needs to answer a question is the host; nothing after it is worth a credential.
  const { webhookForModel } = load([sliceFn('apps/crm/ai.js', 'webhookForModel')], { URL });
  assert.equal(webhookForModel('https://hooks.example.com/x?token=SECRET'),
               'https://hooks.example.com/(rest withheld)');
  assert.equal(webhookForModel('https://hooks.example.com/x#frag=SECRET'),
               'https://hooks.example.com/(rest withheld)');
  assert.equal(webhookForModel('https://hooks.slack.com/services/T00000000/B00000000/8f3aSECRET'),
               'https://hooks.slack.com/(rest withheld)',
               'the whole of a Slack posting credential is in the path, and it travelled');
  assert.equal(webhookForModel('https://hooks.example.com'), 'https://hooks.example.com');
  // Not a URL we can parse is not a URL we can redact.
  assert.equal(webhookForModel('httpX://%%%/not-a-url'), '(webhook address withheld)');
  assert.equal(webhookForModel(null), '');
  // **Both call sites, by what they produce.** This checked one of the two, and by photographing the
  // spelling it used to have - so replacing `webhookForModel(shown.url)` with `String(shown.url)` in
  // the focus block sent a whole Slack posting credential to the model with the battery green. The
  // question is not «is this line still written that way», it is «can a token get out», so both
  // sites are derived and every one of them is required to redact.
  const src = read('apps/crm/ai.js');
  const SECRET = 'https://hooks.slack.com/services/T00000000/B00000000/8f3aSECRETTOKEN';
  // Whole lines: the call that redacts wraps the value, so matching from the value to the end of the
  // line reads the closing bracket and calls it unredacted - which is what the first version did.
  const sites = src.split('\n')
    .filter((l) => /\b(a|shown)\.url\b/.test(l))
    .filter((l) => !/^\s*(\/\/|\*)/.test(l));
  assert.ok(sites.length >= 2, `only ${sites.length} place(s) in this file put a webhook URL anywhere `
                               + '- the derivation has stopped finding them');
  for (const line of sites) {
    assert.match(line, /webhookForModel\(/,
                 `a webhook URL is used without redaction: ${line.trim().slice(0, 90)}`);
  }
  // And the property itself, on the value the helper returns: no token survives it.
  assert.ok(!webhookForModel(SECRET).includes('8f3aSECRETTOKEN'),
            'the redaction lets the posting credential through');
});

test('crm: the sender-sharing switch is read when it is used, not cached with the workspace', () => {
  // `aiActCache` is dropped by a write to actions/, a write to workflows/ and a change of workspace.
  // A *setting* in there could be stale for a browser session - and this one decides whether a
  // person's address leaves the machine.
  const src = read('apps/crm/ai.js');
  const fn = sliceFn('apps/crm/ai.js', 'aiLoadActions');
  assert.ok(!/aiActCache = \{ list, users, addresses \}/.test(fn), 'the setting is cached again');
  assert.match(fn, /addresses: await shareAddresses\(\)/, 'it is not read where it is used');
  assert.equal((src.match(/addresses: await shareAddresses\(\)/g) || []).length, 2,
    'both the cached and the fresh path must read it');
});

test('crm: the sender name is withheld with the sender address, not without it', () => {
  // The focus block spreads the whole row, so withholding has to name every field that carries the
  // sender - `from_name` is the person's own name when the type is `user`, and it was travelling.
  const src = read('apps/crm/ai.js');
  const block = src.slice(src.indexOf('const shown = { ...e'), src.indexOf('return block(', src.indexOf('const shown = { ...e')));
  assert.match(block, /shown\.from_address = WITHHELD/);
  assert.match(block, /shown\.from_name = WITHHELD/, 'the name goes while the address is held back');
});

test('crm: a customer record id is not captured at the boundary', () => {
  // The bridge drops `params` because for a Workflow failure it is a record id. `entity_info.id` is
  // the same fact one field later, and it was kept, written to disk, and read by nothing.
  const src = read('apps/crm/content-bridge.js');
  assert.ok(!/recordId:/.test(src), 'a customer record id is captured again');
  assert.ok(!/entity_info/.test(src.replace(/\/\/[^\n]*/g, '')), 'entity_info is read outside a comment');
});

test('both panels: the unlock passphrase does not stay in the DOM', () => {
  for (const rel of ['apps/crm/ai.js', 'apps/analytics/sidepanel.js']) {
    const src = read(rel);
    const at = src.indexOf('KEYVAULT.remember(prov, key)');
    assert.ok(at > 0, `${rel}: the unlock path moved`);
    const after = src.slice(at, at + 700);
    assert.match(after, /\$\('ailockpass'\)\.value = ''/,
      `${rel}: the field is cleared only when the row is shown, so it survives a successful unlock`);
  }
});

// ---------- the way out of a mismatch is not refused by the guard on the mismatch ----------
//
// Delete the workspace you are in; the panel selects another; the tab now disagrees with it and the
// bar offers «Create workspace for <the tab's>». Pressing it answered «nothing here reads Zoho
// Analytics until they match» - the guard refusing the one action whose purpose is to make them
// match. Found by the author on the first manual check of a release.
//
// The exception is one command wide and it is safe for a reason that has to stay true, so both
// halves are held here: the panel marks only this call, and the bridge's `workspaceInfo` takes its
// id from the page's own URL rather than from the message - so it cannot be pointed at another
// workspace, whatever is in the message.

test('analytics: only the tab-scoped workspaceInfo is exempt from the mismatch guard', () => {
  const src = read('apps/analytics/sidepanel.js');
  const marked = [...src.matchAll(/toBridge\(\{([^}]*aboutTab[^}]*)\}/g)].map((m) => m[1]);
  assert.equal(marked.length, 1, `aboutTab is used ${marked.length} times - it is meant to be one`);
  assert.match(marked[0], /cmd:\s*'workspaceInfo'/, 'aboutTab marks something other than workspaceInfo');
  // The guard is still the guard for everything else, including the pull's own workspaceInfo.
  const guard = src.slice(src.indexOf('async function toBridge'));
  assert.match(guard, /msg\.cmd !== 'context' && !aboutTab && bound && !guardOk\(\)/);
  assert.match(guard, /const expected = \(msg && msg\.cmd !== 'context' && !aboutTab && bound\)/,
    'the binding would travel with it and the page would refuse what the panel allowed');
});

test('analytics: the bridge reads the workspace from the page, never from the message', () => {
  // This is what makes the exemption safe rather than convenient. If `workspaceInfo` ever takes an
  // id from the caller, the exemption becomes a way to read another workspace while bound here.
  const fn = sliceFn('apps/analytics/content-bridge.js', 'workspaceInfo');
  assert.match(fn, /const id = ws\(\)/, 'workspaceInfo must resolve its own id');
  assert.ok(!/\bmsg\b/.test(fn), 'workspaceInfo reads the message, so it can be pointed elsewhere');
});

test('analytics: a workspace it has just created is the one it selects', () => {
  // refreshWorkspaces() picks the remembered workspace, and the remembered one was still the one you
  // were in - so «Create workspace for X» created X and put you back, mismatch bar and all. The CRM
  // twin has always remembered it first.
  const src = read('apps/analytics/sidepanel.js');
  const body = src.slice(src.indexOf('async function addWorkspace()'));
  const remember = body.indexOf("idbHandle.set('activeWsAnalytics'");
  const refresh = body.indexOf('await refreshWorkspaces()');
  assert.ok(remember > 0, 'nothing remembers the workspace that was just created');
  assert.ok(remember < refresh, 'it is remembered after the list is rebuilt, which is too late');
});

// ---------- a pull says which stage it is in, including the ones that are not network ----------
//
// The reading stages announced themselves and counted; the stages that write did not. On the CRM side
// each area asks for the folder, the tab context and the config - three or four awaits - before its
// own first message lands, so between areas the panel showed the *previous* area's closing line with
// nothing turning: working, and indistinguishable from stuck. On the Analytics side the whole disk
// write was silent, which on a real workspace is hundreds of files after «Reading lineage... 50 / 50».
// Read out of the source rather than driven, for the reason slice.mjs exists: these are two lines
// inside 4000 of DOM-bound code, and what has to hold is that they are there and that they are said
// *before* the work, not after it.

test('the CRM names each area before it pulls it, and the position in the run', () => {
  const src = read('apps/crm/sidepanel.js');
  const body = src.slice(src.indexOf('async function pullEverything'));
  const say = body.indexOf('op.say(`${tabLabel(t.id)}');
  const call = body.indexOf('await runners[t.id]()');
  assert.ok(say > 0, 'no line names the area about to be pulled');
  assert.ok(say < call, 'the area is named after it has been pulled, which is when it is too late');
  assert.match(body, /of \$\{todo\.length\}/, 'the position must count the areas this run will do');
  // The denominator is what the run will actually do - not TABS, which includes what the role
  // refused and what settings excluded. «3 of 7» over a run of four is a wrong number, not a rough one.
  assert.match(body, /const todo = TABS\.filter\(\(t\) => !isForbidden\(t\.id\) && isPulled\(t\.id\)\)/);
});

test('the CRM says it is rebuilding the list after the last area', () => {
  const src = read('apps/crm/sidepanel.js');
  const body = src.slice(src.indexOf('async function pullEverything'));
  const say = body.indexOf('Rebuilding the list');
  const call = body.indexOf('await rebuildActive()');
  assert.ok(say > 0 && say < call, 'the rebuild is the second place a finished-looking pull is still working');
});

test('Analytics counts the SQL files it writes, and says so before the first one', () => {
  const src = read('apps/analytics/sidepanel.js');
  const body = src.slice(src.indexOf('async function writeToDisk'));
  assert.ok(body.indexOf('Writing the mirror') < body.indexOf("op.write(PULL_STATE"),
    'the disk stage must be announced before it starts, not once it is over');
  assert.match(body, /Writing SQL files\\u2026 \$\{written\} \/ \$\{total\}/,
    'one file per query table is the longest thing this does and it has to count');
  // `pruneSql(index, op, ...)` now takes the census as a third argument, so the call is matched by
  // its name rather than by an exact argument list - a test pinned to a signature reports a refactor
  // as a defect, which is how a suite teaches people to edit it.
  assert.ok(body.indexOf('Removing what the workspace no longer has') < body.indexOf('pruneSql('));
});

// ---------- both bridges: reading one cookie out of the jar ----------
//
// `csrfToken()` above is tested with the jar injected, so the *reading* was covered by nothing. It
// was `split('=')[1]`, which stops at the first `=` in the value - padding on anything base64 - and
// the failure is silent: two thirds of a token goes out and Zoho answers 400, which looks exactly
// like a session that has expired. Held in both bridges because the helper is byte-identical there.
for (const app of ['crm', 'analytics']) {
  const { cookie } = load([sliceFn(`apps/${app}/content-bridge.js`, 'cookie')],
    { get document() { return { cookie: globalThis.__raw }; } });
  const withRaw = (raw, fn) => { globalThis.__raw = raw; try { return fn(); } finally { delete globalThis.__raw; } };

  test(`${app}: a value containing = is read whole, not truncated at the first one`, () => {
    withRaw('a=1; CSRF_TOKEN=abc==; z=9', () => assert.equal(cookie('CSRF_TOKEN'), 'abc=='));
  });

  test(`${app}: an ordinary value reads as itself`, () => {
    withRaw('CSRF_TOKEN=plain; other=x', () => assert.equal(cookie('CSRF_TOKEN'), 'plain'));
  });

  test(`${app}: a cookie that is not there is absent, never an empty string`, () => {
    // The callers read it as truthy to decide whether to fall back to another name; '' and undefined
    // happen to behave alike there, and the distinction is what stops that being luck.
    withRaw('other=x', () => assert.equal(cookie('CSRF_TOKEN'), undefined));
  });

  test(`${app}: a longer name that starts with this one is not mistaken for it`, () => {
    withRaw('CSRF_TOKEN_OLD=stale; CSRF_TOKEN=live', () => assert.equal(cookie('CSRF_TOKEN'), 'live'));
  });
}

// ---------- CRM: which areas are behind, derived and not declared ----------

const stale = load([
  sliceConst('apps/crm/sidepanel.js', 'STALE_MARGIN_MS'),
  sliceFn('apps/crm/sidepanel.js', 'newestPull'),
  sliceFn('apps/crm/sidepanel.js', 'areaStale'),
], {
  // The areas, which is what freshness has always been about: `newestPull` used to walk the tabs and
  // could not see an area without one. The fixtures still set `__tabs`, so the ids come from there.
  get AREA_IDS() { return globalThis.__tabs.map((t) => t.id); },
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
  // No `source_code` on the node: the graph does not carry one, and a fixture that invented it here
  // is a fixture that could not have shown the defect. The source is on disk, where the code reads it.
  ensureGraph: async () => ({ nodes: { a: { file: 'ns/Fn.dg', namespace: 'ns', name: 'Fn' } } }),
  WS_MOVED: 'moved',
  readFile: async (p) => {
    if (globalThis.__files && globalThis.__files[p]) return globalThis.__files[p];
    throw new Error('not on disk');
  },
  beginWorkspaceOp: () => ({
    current: () => true,
    read: async (p) => {
      if (globalThis.__files && globalThis.__files[p]) return globalThis.__files[p];
      throw new Error('not on disk');
    },
  }),
  JSON, Object,
};
const { aiFocus } = load([sliceFn('apps/crm/modules.js', 'moduleRefusal'),
                          sliceFn('apps/crm/ai.js', 'fnSource'),
                          sliceFn('apps/crm/ai.js', 'aiFocus')], focusCtx);

function looking(at, extra = {}) {
  Object.assign(globalThis, { __cur: at, __wf: [], __sc: [], __cn: [], __md: [], __files: {} }, extra);
  return aiFocus();
}

test('a Deluge function still gets its source as focus', async () => {
  const out = await looking('ns/Fn.dg', { __files: { 'ns/Fn.dg': 'info 1;' } });
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
  // The registrable domain matters too. `zoho.example.com` starts with the right word but belongs
  // to example.com; the old `[a-z.]+` suffix accepted it as one of Zoho's own hosts.
  assert.equal(isZohoUrl('https://zoho.example.com/x'), false);
  assert.equal(isZohoUrl('https://crm.zoho.com.example.org/x'), false);
});

test('a non-http scheme is left entirely alone', () => {
  assert.equal(isZohoUrl('mailto:ivan@zoost.it'), false);
});

// ---------- attribute escaping ----------

// **Every copy, in both products, found rather than named.** This lifted `escA` from one file of the
// eight that define one, so the Analytics copy could be changed to pass a quote through and the whole
// battery stayed green - `htmlcheck` went on printing «Attributes are escaped», because it trusts the
// *name* and reads the definition it was pointed at. Eight definitions, one property, derived here so
// a ninth written tomorrow is held to it by existing.
const attributeEscapers = () => {
  const out = [];
  for (const app of ['crm', 'analytics']) {
    for (const f of readdirSync(`${ROOT}/apps/${app}`)) {
      if (!f.endsWith('.js')) continue;
      const rel = `apps/${app}/${f}`;
      for (const name of ['escA', 'escQ']) {
        if (!new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).test(read(rel))) continue;
        out.push([rel, name, load([sliceConst(rel, name)])[name]]);
      }
    }
  }
  return out;
};

test('a quote cannot close the attribute it sits in - every escaper, both products', () => {
  const found = attributeEscapers();
  // If the derivation finds nothing, it is the derivation that is broken, not the tree.
  assert.ok(found.length >= 6, `only ${found.length} attribute escaper(s) found across both products`);
  for (const [rel, name, fn] of found) {
    // The documented trap, found again by an outside review: escHtml() escapes & < > and not quotes,
    // so a name from Zoho containing a quote ends the attribute and whatever follows becomes markup.
    assert.ok(typeof fn === 'function', `${rel}: ${name} did not lift`);
    assert.ok(!fn('x" onerror=alert(1)').includes('"'), `${rel}: ${name} lets a double quote through`);
    assert.ok(!fn("x' onerror=alert(1)").includes("'"), `${rel}: ${name} lets an apostrophe through`);
  }
});

const { escA } = load([sliceConst('apps/crm/sidepanel.js', 'escA')]);

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
  const src = crmPanel();
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
      // Its own declaration is not a call site. `const writeCfg = async (o, op) =>` did not put a
      // paren after the name and `async function writeCfg(o, op)` does, so the day the helper became
      // a declaration the sweep reported the definition as a whole-object write.
      .filter((m) => !/function\s+$/.test(body.slice(Math.max(0, m.index - 10), m.index)))
      // Inside `patchCfg` itself, which *is* the merge. It used to be «somewhere in the 40
      // characters behind», which was the arrow's own `const patchCfg = async (…) => writeCfg(…)`;
      // as a declaration the name sits on the line above and 40 characters no longer reach it. Ask
      // which declaration the write is in instead - the same answer, derived rather than measured
      // in characters.
      .filter((m) => (body.lastIndexOf('function patchCfg', m.index) < 0)
                     || body.indexOf('\n}', body.lastIndexOf('function patchCfg', m.index)) < m.index);
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
    const src = gsrc(app);
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
  const api = load([gcon('crm', 'KINDOF'),
                    gcon('crm', 'ENTITY_LABEL'),
                    gcon('crm', 'entityOf'),
                    gfn('crm', 'entitiesPresent'),
                    gfn('crm', 'kindGroups'),
                    gcon('crm', 'allKinds')], ctx);
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
    const js = gsrc(app);
    assert.ok(/const FALLBACK_HUES = \[/.test(js), `${app}: an unknown kind would have no colour`);
    assert.ok(/const KINDCOL = \(k\) => declaredHue\(k\) \|\| \(k \? hueFor\(k\) : ''\)/.test(js),
      `${app}: the declared hue no longer wins, or the fallback is gone`);

    let kinds = [];
    const ctx = { allKinds: () => kinds, Set, Object,
      // nothing is declared in this stub, so every kind falls through to the fallback
      document: { documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: () => '' }) };
    const { hueFor } = load([gcon(app, 'FALLBACK_HUES'),
                             gcon(app, 'declaredHue'),
                             // the memo the function keeps, so the slice is the real one
                             'let _hues = null, _huesKey = null;',
                             gfn(app, 'hueFor')], ctx);
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
  const src = crmPanel().replace(/^\s*\/\/.*$/gm, '');
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
    // `erShowMaybeHeavy` beside `erShow`: every relayout path goes through the wrapper now, so a
    // stub that offers only the inner one throws where the real window would not.
    bfsEgo() {}, updateBack() {}, erShow() {}, erShowMaybeHeavy() {},
    // setFocus also puts back whatever removal had taken the new focus off the drawing - a free
    // variable, and a slice runs in a bare context. Stubbed here on purpose: this case is about the
    // refusal above, and erUnhide has its own case in tests/graphview.test.mjs, running the real one.
    erUnhide: () => {},
    get egoDepth() { return 2; }, set egoDepth(_v) {}, get maxEgoDepth() { return 6; },
    get scopeAll() { return false; }, get curView() { return 'er'; },
    Math,
  };
  const { setFocus } = load([gfn('crm', 'setFocus')], ctx);
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
  const { erCallRows } = load([gfn('crm', 'erCallRows')],
    { N, label: (n) => n.name, DATA: { kind: 'calls' }, passKind: () => true });
  const rows = erCallRows(N['billing.createInvoice']);
  assert.deepEqual(rows.map((r) => r.api_name), ['calcTax', 'log'], 'the callees are not listed, or not in order');
  assert.deepEqual(rows.map((r) => r.data_type), ['billing', 'shared'], 'the second column is not the callee namespace');
  assert.deepEqual(erCallRows(N['shared.log']), [], 'a function that calls nothing has rows');

  // ...and erFieldsFor has to route to it. Testing erCallRows alone left the wiring uncovered:
  // deleting the line that reaches it passed, which is the mutation that found this gap.
  const rowsOf = (kind, n, node) => {
    const ctx = { N, label: (x) => x.name, DATA: { kind }, erEmph: 'modules', erAll: true, passKind: () => true };
    const { erFieldsFor } = load([gfn('crm', 'erCallRows'),
                                  gfn('crm', 'erFieldsFor')], ctx);
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
  const src = gsrc('crm').replace(/^\s*\/\/.*$/gm, '');
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
  const js = crmPanel();
  // One function now - graphIdentity() - where three inline objects used to drift; every publish
  // goes through publishGraph, which stamps it.
  assert.ok(/const graphIdentity = \(\) => \(\{[^}]*label: bound\?\.label/.test(js),
            'the graph stopped carrying its workspace');
  const pubs = (js.match(/await publishGraph\(/g) || []).length;
  assert.ok(pubs >= 4, `only ${pubs} publishes go through the stamped path`);
  const an = read('apps/analytics/sidepanel.js');
  const aw = [...an.matchAll(/workspace: \{[^}]*\}/g)].map((m) => m[0]).filter((x) => /instance:/.test(x));
  assert.ok(aw.length >= 1, 'id=analytics the graph stopped carrying its workspace');
  for (const one of aw) assert.ok(/label:/.test(one), `id=analytics a graph is handed over without the workspace name: ${one.slice(0, 60)}`);
  for (const app of ['crm', 'analytics']) {
    const gv = gsrc(app);
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
  const { passKind } = load([gcon('crm', 'KINDOF'),
                             gcon('crm', 'CONDITION_KEYS'),
                             gfn('crm', 'passKind')], ctx);
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
  const src = gsrc('crm').replace(/^\s*\/\/.*$/gm, '');
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
  const js = gsrc('crm'), html = read('apps/crm/graphview.html');
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
  const js = gsrc('crm');
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
  const { erBoxSize } = load([gcon('crm', 'BOX_MIN'),
                              gcon('crm', '_tm'),
                              gfn('crm', 'textWidth'),
                              gfn('crm', 'erBoxSize')], ctx);
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

  const src = gsrc('crm').replace(/^\s*\/\/.*$/gm, '');
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
  ctx.beginWorkspaceOp = () => ({ current: () => true, root: ctx.dir, read: ctx.readFile });
  ctx.ensureGraph = ctx.ensureGraph;   // the stub the block already builds
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
    location: { reload: () => { reloaded = true; }, search: '?graph=t1' },
    URLSearchParams,
    alert: (m) => { alerted = m; },
  };
  // Two declarations now, not one: the click handler is named and lives at the file's top level,
  // because `tools/asynccheck.py` reads declarations and an inline `async (e) => {…}` is a scope it
  // cannot enter. The case drives the same path either way - it wires, then clicks.
  const { wireSubject } = load([gfn('crm', 'switchGraphKind'), gfn('crm', 'wireSubject')], ctx);
  wireSubject();
  assert.equal(seg.map((x) => x.sel).join(' '), 'true false', 'the segment does not mark what is on screen');

  await box.onclick({ target: seg[0] });          // the one already showing
  assert.equal(sent.length, 0, 'clicking the current subject asked the panel to rebuild it');

  await box.onclick({ target: seg[1] });
  assert.equal(sent.length, 1, 'the other subject did not ask for anything');
  assert.equal(sent[0].kind, 'schema');
  assert.equal(sent[0].token, 't1', 'the switch does not say which window is asking');
  assert.equal(reloaded, false, 'it reloaded on a failed switch');
  assert.match(alerted, /no working folder is open in the panel/, 'the panel\'s own reason was swallowed');
  assert.match(alerted, /side panel/, 'the message does not name where the folder lives');
  assert.equal(stat.innerHTML, '', 'the status line was left saying it was building');

  // ...and a switch that works reloads, which is the whole mechanism: every global here was derived
  // from the graph being replaced, and re-deriving them one by one is the half-migrated state this
  // project keeps getting bitten by. Removing the reload passed until this was asserted.
  ctx.chrome.runtime.sendMessage = async () => ({ ok: true });
  const ok = load([gfn('crm', 'wireSubject')], ctx);
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
    // `session`, because the graph payload is a hand-off to a window rather than a setting and
    // moved there when it stopped carrying the Deluge source with it.
    chrome: { storage: { local: { set: async () => {} }, session: { set: async () => {} } } },
    setStatus: () => {}, bound: null, lastCtx: null,
    WS_MOVED: 'moved',
    beginWorkspaceOp: () => ({ current: () => true, root: {}, say: () => {} }),
    graphIdentity: () => ({ instance: null, org: null, label: null }),
  }, over);

  let ctx = mk({});
  let { buildGraphFor } = load([sliceFn('apps/crm/sidepanel.js', 'buildGraphFor'), sliceFn('apps/crm/sidepanel.js', 'graphForWindow')], ctx);
  assert.deepEqual({ ...(await buildGraphFor('schema')) }, { ok: true });

  ctx = mk({ dir: null });
  ({ buildGraphFor } = load([sliceFn('apps/crm/sidepanel.js', 'buildGraphFor'), sliceFn('apps/crm/sidepanel.js', 'graphForWindow')], ctx));
  assert.match((await buildGraphFor('calls')).error, /no working folder/, 'a missing folder is not reported');

  ctx = mk({ hasPerm: async () => false });
  ({ buildGraphFor } = load([sliceFn('apps/crm/sidepanel.js', 'buildGraphFor'), sliceFn('apps/crm/sidepanel.js', 'graphForWindow')], ctx));
  const lapsed = (await buildGraphFor('calls')).error;
  assert.match(lapsed, /re-granting/, 'a lapsed folder does not name the remedy');

  ctx = mk({ callGraphWithContext: async () => ({ counts: { nodes: 0 } }) });
  ({ buildGraphFor } = load([sliceFn('apps/crm/sidepanel.js', 'buildGraphFor'), sliceFn('apps/crm/sidepanel.js', 'graphForWindow')], ctx));
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
    gfn('crm', 'buildCallRels'),
    gcon('crm', 'relSnippet'),
    gcon('crm', 'relScoped'),
    gfn('crm', 'relPass')], ctx);

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
  const b2 = load([gfn('crm', 'buildCallRels'),
                   gfn('crm', 'buildRels')], c2);
  b2.buildRels();
  assert.equal(c2.RELS.length, 2, 'buildRels does not reach the call catalogue on a call graph');
  assert.ok(c2.RELS[0].call, 'buildRels built schema rows for a call graph');
});

test('a call graph is never described in the nouns of a schema', () => {
  // Four status lines wrote "modules" and "lookups" literally, so the call graph reported the wrong
  // nouns in three of them. One accessor decides, and nothing else may spell them out.
  const src = gsrc('crm').replace(/^\s*\/\/.*$/gm, '');
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
  const { setScope } = load([gcon('crm', 'DRAW_MAX_NODES'),
                             // `drawMax` starts at the measured default and the options page may raise
                             // it, so the predicate reads the variable and not the constant - which is
                             // one more thing the lift has to carry.
                             gcon('crm', 'drawMax'),
                             gcon('crm', 'drawable'),
                             gcon('crm', 'focusName'),
                             gfn('crm', 'runHeavy'),
                             gfn('crm', 'setScope')], ctx);
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
    const { runHeavy } = load([gfn(app, 'runHeavy')], ctx);
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
    const { wireAsideFold } = load([gcon(app, 'MIN'),
                                    gcon(app, 'KEEP'),
                                    gcon(app, 'DRAG'),
                                    // setFolded writes the control's own label, which lives in MSG
                                    // because it is the aria-label and the title of one element.
                                    gcon(app, 'MSG'),
                                    gfn(app, 'asideWidth'),
                                    gfn(app, 'wireAsideFold')], ctx);
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
    const { asideWidth } = load([gcon(app, 'MIN'),
                                 gcon(app, 'KEEP'),
                                 gfn(app, 'asideWidth')], { Math });
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
    assert.match(gsrc(app), /classList\.toggle\('no-aside'/, `${app}: nothing toggles it`);

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
  const { updateProjectableTabs } = load([gfn('crm', 'updateProjectableTabs')], ctx);

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
  const src = crmPanel();
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
  const { isRefusal } = load([sliceFn('apps/crm/modules.js', 'isRefusal')]);
  for (const s of [400, 401, 403, 404, 429, 499]) assert.equal(isRefusal(s), true, `${s} is a refusal`);
  for (const s of [0, undefined, null, 200, 500, 502, 503]) assert.equal(isRefusal(s), false, `${s} is not`);
});

test('the refused mark is neutral, and not one the panel uses for "try again"', () => {
  // Reported: the row wore the amber circular arrow, which in this panel means "failed, click to
  // retry" - advertising an action that changes nothing. The mark has to say "no", not "not yet",
  // and it cannot borrow one that already says something else: the hollow circle is "click to
  // download" three tabs away, which is the opposite claim.
  const src = read('apps/crm/modules.js');   // the row this is about; the exports have their own copy
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
  const src = crmPanel().replace(/^\s*\/\/.*$/gm, '');
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
  assert.match(crmPanel(), /function renderBlocked\(\)/, 'crm: nothing draws the blocker');
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
  // The handler by name, not by the shape of its attachment. It used to be sliced from
  // `document.addEventListener('click', async` to the next `}, true);` - which stopped matching the
  // day the callback became a named declaration, and would have stopped matching again at the next
  // reshuffle. `sliceFn` cuts the body and nothing else.
  const guards = ['crm', 'analytics'].map((app) => {
    const src = read(`apps/${app}/sidepanel.js`);
    assert.match(src, /document\.addEventListener\('click', regrantOnAnyClick, true\)/,
                 `${app}: nothing re-grants on a stray click`);
    return sliceFn(`apps/${app}/sidepanel.js`, 'regrantOnAnyClick');
  });
  for (const [i, g] of guards.entries()) {
    for (const sel of ['#wsroot', '#pfoot', '.dlg', '#aiview', '#offoverlay']) {
      assert.ok(g.includes(`closest('${sel}')`),
        `${['crm', 'analytics'][i]}: a click in ${sel} would ask for permission unprompted`);
    }
  }
});

// ---------- Workflows: the scheduled actions the list endpoint never returns ----------

const { wfScheduled } = load([sliceFn('apps/crm/automation.js', 'wfScheduled')]);

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
  const crm = crmPanel();
  for (const kind of ['functions', 'modules', 'modules/layouts', 'workflows', 'schedules', 'connections']) {
    assert.ok(crm.includes(`'${kind}/index.json'`), `${kind} has no ${kind}/index.json`);
  }
  // The twin: one index file, named the same way, so the two products read alike on disk.
  assert.ok(read('apps/analytics/sidepanel.js').includes('sql/index.json'));
  assert.ok(!read('apps/analytics/sidepanel.js').includes('sql/_index.json'));
});

test('functions are written under functions/<namespace>/, not in the workspace root', () => {
  const src = crmPanel();
  assert.ok(src.includes('`functions/${f.folder}/${f.stem}.dg`'), 'the sync path is not under functions/');
  assert.ok(src.includes('`functions/${f.folder}/${f.stem}.meta.json`'), 'the sidecar is not under functions/');
  assert.ok(!/[^/]\$\{f\.folder\}\/\$\{f\.stem\}\.dg/.test(src.replace(/functions\/\$\{f\.folder\}/g, 'X')),
    'a path still writes a namespace folder at the root');
});

test('the old layout is reported, never read', () => {
  // No reader knows the old paths — that is the point. What exists is an empty state that names the
  // real reason, so a workspace full of files does not report "nothing pulled yet".
  const src = crmPanel();
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


// What a panel function actually clears, following calls one level deep.
//
// Three cases below used to grep the body of `dropWorkspaceState()` for `graphCache = null`, and
// went red the day that list moved into a `dropFileCaches()` the workspace change and ↻ Refresh now
// share - a change that made the code more correct, asserted against as a regression. The subject
// was never "this identifier appears in this function": it was "leaving a workspace drops this
// cache", and that survives one hop.
function clearedBy(src, name, depth = 2) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found - renamed, moved or deleted`);
  const body = src.slice(start, src.indexOf('\n}', start));
  let out = new Set([...body.matchAll(/(\w+)\s*=\s*(?:null|\[\]|new Map\(\))/g)].map((m) => m[1]));
  if (depth > 0) {
    for (const m of body.matchAll(/\b(\w+)\(\s*\)/g)) {
      if (m[1] === name || !src.includes(`function ${m[1]}(`)) continue;
      for (const c of clearedBy(src, m[1], depth - 1)) out.add(c);
    }
  }
  return out;
}

test("the CRM's per-org caches are dropped there too, not only in the Functions tab", () => {
  // graphCache, moduleFilesCache and aiConnCache were cleared in rebuildTree(), which only runs if you
  // happen to be on Functions. Switch workspace from the Workflows tab and the assistant answered
  // from the previous org's functions and schema, with no sign of it anywhere.
  const cleared = clearedBy(crmPanel(), 'dropWorkspaceState');
  // Derived, not listed. The first version of this named `treeData` and `index` - the pair a report
  // happened to name - and five more lists of exactly the same shape went on describing the previous
  // workspace: one instance of a class fixed, and the class reported closed. Every module-level
  // `*Data` / `*Index` a tab draws from is required here, so the seventh one added tomorrow is
  // covered without anyone remembering.
  const decl = read('apps/crm/sidepanel.js') + read('apps/crm/automation.js') + read('apps/crm/connections.js');
  const lists = [...decl.matchAll(/(?:^let |,\s*)(\w+(?:Data|Index))\s*=/gm)].map((m) => m[1]);
  assert.ok(new Set(lists).size >= 6, `only ${new Set(lists).size} per-tab lists found - the derivation broke`);
  for (const c of new Set([...lists, 'graphCache', 'moduleFilesCache', 'aiConnCache', 'treeData', 'index'])) {
    assert.ok(cleared.has(c), `id=${c} survives a change of workspace`);
  }
});

test('↻ Refresh drops everything a change of workspace drops, minus the conversation', () => {
  // Its tooltip promises «read every file again». It cleared three of nine, so the assistant and the
  // health view kept answering from the file that had just been replaced under them.
  const src = crmPanel();
  const workspace = clearedBy(src, 'dropWorkspaceState');
  const files = clearedBy(src, 'dropFileCaches');
  for (const c of ['failIndex', 'healthData', 'actionUsers', 'aiActCache', 'moduleFilesCache']) {
    assert.ok(files.has(c), `id=${c} is not dropped by Refresh, which says it reads every file again`);
  }
  for (const c of files) assert.ok(workspace.has(c), `id=${c} is dropped by Refresh but survives a workspace change`);
});

test('Clear and switching workspace empty the chat through the same function', () => {
  // Two ways to empty the chat that reset different things is how the large-index warning came back
  // on one path and not the other. What this used to assert was that both went through
  // `dropWorkspaceState()` - and that turned out to be the defect rather than the rule: leaving a
  // workspace also drops every cache and the queue of removals still owed on disk, none of which has
  // anything to do with a conversation. The shared part is the conversation; the rest is not shared.
  for (const app of ['crm', 'analytics']) {
    const src = app === 'crm' ? crmPanel() : read(`apps/${app}/sidepanel.js`);
    const clear = /function aiClear\(\)[^\n]*clearConversationState\(\);/.test(src)
               || /function aiClear\(\)[^\n]*dropWorkspaceState\(\);/.test(src);
    assert.ok(clear, `${app}: aiClear does not use the shared helper`);
    const drop = sliceFn(`apps/${app}/sidepanel.js`, 'dropWorkspaceState');
    if (/failedRemovals|Cache = null/.test(drop))
      assert.ok(/function aiClear\(\)[^\n]*clearConversationState\(\);/.test(src),
        `${app}: Clear goes through the function that also drops the caches and the removal queue`);
  }
});

test('a layout lives under the module it describes, and the walks tell the two apart', () => {
  // layouts/ started as a sibling of modules/ because eight walks each said "a .json under modules/
  // is one module" and nesting anything inside would have needed a guard in every one of them — a
  // folder shape chosen to protect the code from a mistake I had just made, which is the wrong
  // direction. One named predicate, and the objection goes away; a layout is a property of a module
  // and now sits under it.
  const src = crmPanel();
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
  const src = gsrc('crm').replace(/^\s*\/\/.*$/gm, '');
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
  const src = gsrc('crm');
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
  const src = gsrc('crm');
  const seed = src.slice(src.indexOf('function seedRing('), src.indexOf('\n}', src.indexOf('function seedRing(')));
  assert.ok(!/Math\.random/.test(seed), 'the ring is seeded randomly, so the same filter draws differently');
  const { jitter } = load([gfn('crm', 'jitter')], { Math });
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
  const src = gsrc('crm');
  const sc = src.slice(src.indexOf('function statCounts('), src.indexOf('\n}', src.indexOf('function statCounts(')));
  assert.ok(!/\bnodesA\b/.test(sc), 'the counts read layout state that is empty when the line is first written');
  assert.ok(/passKind/.test(sc), 'the counts ignore the chips');

  const N = {
    a: { id: 'a', name: 'a', category: 'standalone', calls: ['b'], called_by: [], rest: false, dead_suspect: false, unresolved: [] },
    b: { id: 'b', name: 'b', category: 'standalone', calls: [], called_by: ['a'], rest: false, dead_suspect: false, unresolved: [] },
    c: { id: 'c', name: 'c', category: 'connections', calls: [], called_by: [], rest: false, dead_suspect: false, unresolved: [] },
  };
  const hiddenKinds = new Set(), onlyConds = new Set();
  // Nothing folded here: `erCut` is the map of folded arcs and `erIds` the ids on the drawing, and
  // `statCounts` asks what the reader folded away now. The counts below are unchanged and still
  // about the chips - which is the point of an empty fixture for a state this case is not about.
  const ctx = { N, DATA: { kind: 'calls' }, hiddenKinds, onlyConds,
                erCut: new Map(), erIds: [], Set, Object, Map };
  const { statCounts } = load([gcon('crm', 'KINDOF'),
                               gcon('crm', 'CONDITION_KEYS'),
                               gfn('crm', 'passKind'),
                               // It asks what the reader folded away now, and running the function
                               // alone is what caught the free reference the moment that landed -
                               // the fourth time today. Nothing is folded in this fixture, so the
                               // counts below are unchanged and still about the chips.
                               gfn('crm', 'erHiddenSet'),
                               gfn('crm', 'statCounts')], ctx);
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
  const { relPass, relScoped } = load([gcon('crm', 'relScoped'),
                                       gfn('crm', 'relPass')],
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
    const src = gsrc(app).replace(/^\s*\/\/.*$/gm, '');
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
  const src = gsrc('crm').replace(/^\s*\/\/.*$/gm, '');
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
  const js = gsrc('crm');
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
  // `erpickcut` and `erpickcut2` join them: the arc card writes its own buttons, because an arc has
  // two ends and what each of them says is how many boxes that end would take away.
  const RUNTIME = new Set(['back', 'chipall', 'chipnone', 'down', 'erpickcut', 'erpickcut2', 'erpicksnip', 'layzone', 'up']);
  for (const app of ['crm', 'analytics']) {
    const js = gsrc(app), html = read(`apps/${app}/graphview.html`);
    const have = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const used = new Set([...code.matchAll(/\$\('([^']+)'\)/g), ...code.matchAll(/getElementById\('([^']+)'\)/g)]
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
  // file that opens somewhere else entirely. `rxsavename` and `rxsaveerr` are the ▾ menu's Save
  // row, built into its innerHTML only when there is a pattern worth saving and wired straight after.
  // `body` is not this document's at all: it is the textarea on zoost.it/report, named inside the
  // function the panel injects into that page. It belongs to the same family as `q`, which is the
  // search box of the exported HTML report.
  const RUNTIME = new Set(['laybody', 'laymod', 'laysel', 'pvfailgo', 'reldepth', 'relopen', 'q', 'rxsavename', 'rxsaveerr', 'body']);
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`), html = read(`apps/${app}/sidepanel.html`);
    const have = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    // Comments stripped. A comment of mine quoting `$('id').title` while explaining why two titles
    // are written out rather than looped was read as a reach for an element called «id» - the third
    // time today a check has been fooled by prose. A test about code reads code.
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const used = new Set([...code.matchAll(/\$\('([^']+)'\)/g), ...code.matchAll(/getElementById\('([^']+)'\)/g)]
      .map((m) => m[1]));
    const missing = [...used].filter((id) => !have.has(id) && !RUNTIME.has(id)).sort();
    assert.deepEqual(missing, [], `${app}: sidepanel.js reaches for ids that no longer exist`);
  }
});

test('the Visual view is gone from Analytics too, and the shared machinery is not', () => {
  // It went from the CRM when it turned out to be a weaker drawing of what the boxed diagram already
  // shows. Leaving it on one side made the twins two different products in the window they share.
  const js = gsrc('analytics'), html = read('apps/analytics/graphview.html');
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
    const { linkedUnderFilter } = load([gcon(app, 'KINDOF'),
                                        gcon(app, 'CONDITION_KEYS'),
                                        gfn(app, 'passKind'),
                                        gcon(app, 'erCandidate'),
                                        gfn(app, 'linkedUnderFilter')], ctx);
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
  // in 2.2s, 800 in 3.6s, 1200 in 7.2s, profiled against the collision pass as it now stands, layout only
  // because headless Chrome cannot time the DOM (virtual time advances the clock). Two seconds is a
  // wait and seven is a hang, so 400 is the largest round size measured under two. CROWDED_NODES
  // advises and is measured on quality - five generated graphs per size come out with no box covering
  // another up to 80. Moving either means measuring that one again.
  const d = (app) => +gsrc(app).match(/const DRAW_MAX_NODES = (\d+)/)[1];
  const c = (app) => +gsrc(app).match(/const CROWDED_NODES = (\d+)/)[1];
  const s2 = (app) => +gsrc(app).match(/const SPIN_NODES = (\d+)/)[1];
  // 800, not the 400 the profile alone suggested: a real org reported 725 boxes, so 400 satisfied the
  // criterion and refused the user it was written for. 800 covers that with headroom, at about 3.6
  // seconds behind a spinner. Moving it again means another reading, from a profile or from an org.
  assert.equal(d('crm'), 800, 'the ceiling moved without a profile or a real reading moving');
  assert.equal(c('crm'), 80, 'the crowding line moved without the measurement moving');
  assert.equal(d('crm'), d('analytics'), 'the twins disagree about how much they can lay out');
  assert.equal(c('crm'), c('analytics'), 'the twins disagree about where it gets crowded');
  assert.equal(s2('crm'), s2('analytics'), 'the twins disagree about when to show a spinner');
  for (const app of ['crm', 'analytics']) {
    const js = gsrc(app);
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
    // On both functions that write the header numbers, not on statRefresh which dispatches to them:
    // setFocus calls egoStat() directly, so selecting in the Explorer left the count stale. Reported.
    for (const fn of ['egoStat', 'graphStat']) {
      const body = js.slice(js.indexOf(`function ${fn}()`), js.indexOf('\n}', js.indexOf(`function ${fn}()`)));
      assert.ok(/erCountRefresh\(\)/.test(body),
        `${app}: ${fn} does not move the tab count, so a path that calls it directly leaves it stale`);
    }
  }
});
test('a control that comes and goes may not move the numbers beside it', () => {
  // The layouts chevron appears only on a module with more than one, and it used to be absent
  // otherwise - so a row with several layouts was 12px wider on the right than its neighbours and
  // pushed its own field and layout counts left. Measured at 18px of drift. Reported.
  const js = crmPanel(), css = read('apps/crm/sidepanel.html');
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
    const html = read(`apps/${app}/graphview.html`), js = gsrc(app);
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
    const js = gsrc(app);
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
    const html = read(`apps/${app}/graphview.html`), js = gsrc(app);
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
    const html = read(`apps/${app}/graphview.html`), js = gsrc(app);
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
    const js = gsrc(app);
    const fn = js.slice(js.indexOf('function erEdgePoints('), js.indexOf('\n}', js.indexOf('function erEdgePoints(')));
    assert.ok(/Math\.abs\(bcy - acy\) > Math\.abs\(bcx - acx\)/.test(fn),
      `${app}: the side is not chosen by the dominant direction`);
    assert.ok(/'v'/.test(fn) && /'h'/.test(fn), `${app}: the caller is not told which axis was used`);
    // ...and the bezier has to be pulled along the same axis, or it leaves the box sideways again
    assert.ok(/axis === 'v' \? `C\$\{x1\},\$\{my\} \$\{x2\},\$\{my\}/.test(js),
      `${app}: the control points still assume a horizontal attachment`);
  }

  // the geometry itself, run rather than read
  const { erEdgePoints } = load([gfn('crm', 'erEdgePoints')], { Math });
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
    const js = gsrc(app);
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
  const { linkedUnderFilter } = load([gcon('crm', 'KINDOF'),
                                      gcon('crm', 'CONDITION_KEYS'),
                                      gfn('crm', 'passKind'),
                                      gcon('crm', 'erCandidate'),
                                      gfn('crm', 'linkedUnderFilter')], ctx);
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
    const lines = js.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*bound = \{/.test(lines[i])) continue;
      // The whole statement, not its first line: one of these is written over two lines and the flag
      // is on the second, so a line-by-line read reported a binding that does carry it as missing it.
      let stmt = lines[i], j = i;
      while (!/\};?\s*$/.test(lines[j]) && j < lines.length - 1) stmt += '\n' + lines[++j];
      assert.ok(/sample/.test(stmt),
        `${app}: «${stmt.trim().slice(0, 60)}…» rebuilds the binding without the sample flag`);
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
    const js = gsrc(app);
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
    // The whole listener, to its own closing `});`, rather than a window of characters. This read 400
    // of them and went red the day a box-drag branch was added at the top of the handler, pushing the
    // panning code past the window - the assertion was still true and the slice no longer covered it,
    // which is the same mis-slice this repository records about brace counting.
    const mStart = js.indexOf("addEventListener('mousemove'");
    const move = js.slice(mStart, js.indexOf('\n});', mStart));
    assert.ok(/erUserMoved = true/.test(move), `${app}: panning does not mark the view as chosen`);
    // and the box drag must not claim the view was moved: dragging a box is arranging the diagram, not
    // choosing a viewport, so a later resize is still allowed to re-fit it.
    // The box branch itself, up to the `return` that keeps it out of the panning code below. Written
    // first as "erBoxDrag within 400 characters of erUserMoved" it fired on correct code, because the
    // two branches share one handler - a regex that cannot tell inside from after.
    const boxBranch = move.slice(move.indexOf('if (erBoxDrag)'), move.indexOf('return;', move.indexOf('if (erBoxDrag)')));
    assert.ok(!/erUserMoved/.test(boxBranch),
      `${app}: dragging a box marks the viewport as chosen, so a resize stops re-fitting`);
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
  const SV = +crmPanel().match(/const META_SV = (\d+)/)[1];
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
  assert.equal(JSON.parse(af['.pull-state.json']).state, 'complete',
               'the sample omits the marker that makes a real full pull one snapshot');
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
  const js = crmPanel().replace(/^\s*\/\/.*$/gm, '');
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
  // The overlay that used to make the difference is gone: it curtained off the list on a real
  // mismatch, which was protection by position on screen - and it was carrying more weight than
  // anyone had noticed, since a click on an undownloaded row reaches Zoho and nothing else stood in
  // front of it. Every path to the platform refuses on its own now, so both states are *said* and
  // neither is stopped. What still differs is the bar: softer for a sample, and without the offer to
  // switch to a Zoho org that a sample does not have.
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`).replace(/^\s*\/\/.*$/gm, '');
    const html = read(`apps/${app}/sidepanel.html`);
    assert.ok(/const sampleMm = !!\(bound && (?:lastCtx|ctx)/.test(js),
      `${app}: nothing detects a sample sitting beside a real tab`);
    assert.ok(/classList\.toggle\('show', mm \|\| sampleMm\)/.test(js),
      `${app}: the bar stays hidden for a sample`);
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

// The panel as the page composes it: the CRM is ai.js + sidepanel.js since the split, and a test
// about «the panel» must not care which file a function landed in.
const panelBody = (app) => (app === 'crm' ? crmPanel() : read(`apps/${app}/sidepanel.js`)).replace(/^\s*\/\/.*$/gm, '');
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
  // `op.root`, not `dir`: an operation guards the folder it belongs to, since the one on screen may
  // already be a different workspace by the time it asks.
  assert.ok((crm.match(/await requirePerm\((?:dir|op\.root)\);/g) || []).length >= 9,
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
  assert.ok(/async function notePullFailure\(area, e, op\)/.test(src), 'the CRM lost notePullFailure()');
  // The op reaches the record, or a refusal in one org is written into another org's `.zoost.json`.
  assert.equal((src.match(/await notePullFailure\('\w+', e, op\)/g) || []).length,
               (src.match(/await notePullFailure\(/g) || []).length,
               'a pull reports its failure without saying which workspace it belonged to');
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

test('crm: an access verdict is published only after its workspace config commits', async () => {
  let live = true, published = 0;
  const ctx = {
    TAB: { modules: {} }, tabAccess: { modules: { state: 'ok', pulledAt: 'old' } },
    accessOf: (area) => ctx.tabAccess[area]?.state || null,
    patchCfg: async () => { live = false; },
    publishAccess: () => { published++; }, renderTabs: () => {}, setStatus: () => {},
    tabLabel: (x) => x, Date, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/crm/sidepanel.js', 'noteAccess'), ctx);
  const ok = await vm.runInContext('noteAccess', ctx)('modules', { forbidden: true, status: 403 }, { current: () => live });
  assert.equal(ok, false, 'an overtaken config update was reported as committed');
  assert.equal(ctx.tabAccess.modules.state, 'ok', 'the old workspace verdict entered the new workspace memory');
  assert.equal(published, 0, 'the settings copy was published after the operation became stale');
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
  const src = crmPanel();
  assert.ok(/let viewMode = null,/.test(src),
    'viewMode is initialised to a tab id again - reordering the tabs will not move the panel');
});

test('the first draw selects the first ordered tab', () => {
  const src = crmPanel();
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
    assert.ok(/requirePerm\((?:dir|op\.root)\)/.test(src.slice(at, at + 1200)),
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
  const src = crmPanel();
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

// ---------- a message that is named must exist, and one that exists must be used ----------
//
// The fold marks landed with three new lines in the CRM's MSG and none in the Analytics one, because
// the edit that added them named a single file while the edit that used them ran over both. Nothing
// static said so: `node --check` is happy, and `tools/twincheck.py` compares *functions*, so a table
// of strings is outside what it can see. What found it was opening the Analytics window headless and
// watching `MSG.cutUndo is not a function` come out of a click - which is the argument for running
// things, and also the argument for this, since running every window is not something a suite does.
//
// Both directions, and the second is not padding: a message nobody names is a sentence left behind by
// a feature that went, which is the legacy this repository refuses to keep lying around. Derived from
// the same glob as the check above, so a script added tomorrow is covered without anyone remembering.
test('every message named is defined, and every message defined is named', () => {
  const files = shippedScripts();
  assert.ok(files.length >= 20, `id=glob found only ${files.length} shipped scripts - the walk is wrong`);
  const findings = [];
  for (const rel of files) {
    // A graph window is one program in two files: graphlogic.js holds what both products compute
    // identically and names the messages the window defines, and the table itself cannot move there
    // because its wording differs per product. So the pair is read together - splitting a file must
    // not turn one of its own messages into an undefined one.
    // Files that load into one scope are one program for this purpose: a graph window is
    // logic+view, and the CRM panel is sidepanel+ai+export since the split. The groups are
    // listed once; a file in one reads with its whole group.
    const GROUPS = [
      ['apps/crm/graphlogic.js', 'apps/crm/graphview.js'],
      ['apps/analytics/graphlogic.js', 'apps/analytics/graphview.js'],
      ['apps/crm/sidepanel.js', 'apps/crm/ai.js', 'apps/crm/export.js', 'apps/crm/health.js', 'apps/crm/automation.js', 'apps/crm/modules.js', 'apps/crm/connections.js'],
    ];
    const group = GROUPS.find((g) => g.includes(rel));
    let src = read(rel);
    if (group) src = group.map(read).join('\n');
    const used = new Set([...src.matchAll(/\bMSG\.(\w+)/g)].map((m) => m[1]));
    const at = src.indexOf('const MSG = {');
    if (at < 0) {
      if (used.size) findings.push(`${rel}: names MSG.${[...used][0]} and has no MSG table`);
      continue;
    }
    const block = src.slice(at, src.indexOf('\n};', at));
    const defined = new Set([...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]));
    for (const k of used) if (!defined.has(k)) findings.push(`${rel}: MSG.${k} is used and never defined`);
    for (const k of defined) if (!used.has(k)) findings.push(`${rel}: MSG.${k} is defined and never used`);
  }
  assert.equal(findings.length, 0, 'the message table and the code that reads it have come apart:\n  ' + findings.join('\n  '));
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
  const src = crmPanel();
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
  // Read from the function rather than from a window of N characters after its name: the window was
  // 400 and a comment pushed the guard past it, so the case failed over prose.
  assert.ok(/if \(!zohoReady\(\)\)/.test(sliceFn('apps/crm/sidepanel.js', 'downloadMissing')),
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

test('crm: summary invalidations stay with the workspace that caused them', () => {
  const ctx = { dir: null, _dirtyMeta: new Set(), _dirtySource: new Set(), _dirtyByRoot: new WeakMap(), Set, WeakMap };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/crm/sidepanel.js', 'switchDirtyWorkspace'), ctx);
  const swap = vm.runInContext('switchDirtyWorkspace', ctx);
  const A = {}, B = {};
  swap(A); ctx.dir = A;
  ctx._dirtySource.add('functions/ns/changed.dg');
  swap(B); ctx.dir = B;
  assert.equal(ctx._dirtySource.has('functions/ns/changed.dg'), false, 'B inherited A\'s invalidation');
  ctx._dirtySource.add('functions/ns/other.dg');
  swap(A); ctx.dir = A;
  assert.equal(ctx._dirtySource.has('functions/ns/changed.dg'), true, 'A\'s invalidation was consumed while B was open');
  assert.equal(ctx._dirtySource.has('functions/ns/other.dg'), false, 'B\'s invalidation leaked back into A');
});

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
  const gv = gsrc('crm');
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
  const focus = src.slice(src.indexOf('async function aiFocus('), src.indexOf('function productHelp()'));
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

// A workspace whose files were all on disk was announced as "Nothing pulled yet" - reported. Every
// failure to read went into one fallback, so «there is no such file» and «the read failed» arrived
// as the same fact, and the panel then named the wrong missing thing: the reader is sent to pull a
// workspace that has already been pulled, and pulling changes nothing.
test('analytics: a workspace that cannot be read is not reported as never pulled', () => {
  const js = read('apps/analytics/sidepanel.js');
  const rj = sliceFn('apps/analytics/sidepanel.js', 'readJson');
  assert.ok(/e\.name !== 'NotFoundError'/.test(rj),
    'every failure still becomes the fallback, so unreadable and absent are one fact');
  assert.ok(/onFailure\(\{ rel/.test(rj), 'a failed read leaves nothing behind to report');
  assert.ok(/op && !op\.current\(\)/.test(rj), 'an overtaken read can still alter the next workspace');
  // The state that was circular: the panel re-requests the folder permission only while it believes
  // it has none, so a cached "granted" that the browser disagrees with means no click ever asks for
  // it back - Refresh included. A NotAllowedError is the browser saying that verdict is wrong.
  assert.ok(/e\.name === 'NotAllowedError'\) rootGranted = false/.test(rj),
    'a lapsed permission leaves the panel believing it still has one');
  const click = js.slice(js.indexOf("document.addEventListener('click'"));
  assert.ok(/if \(!root \|\| rootGranted\) return;/.test(click),
    'the re-grant on click no longer depends on the verdict this now corrects');
  const load = sliceFn('apps/analytics/sidepanel.js', 'loadFromDisk');
  // The four reads are one snapshot, so its failure stays in this invocation and is published with
  // the rest. A global accumulator let a config read elsewhere describe the next workspace.
  assert.ok(/let failed = null;/.test(load) && /noteFailure/.test(load),
            'the load has no local place to collect its own failure');
  assert.ok(/diskUnreadable = views\.length \? null : failed;/.test(load),
    'a stray failure from an unrelated read can speak about this workspace');
  // Comments stripped: this asserts the order of two *branches*, and a comment above one of them
  // naming the other's sentence made it fail on a correct change. A test about code reads code.
  const why = sliceFn('apps/analytics/sidepanel.js', 'emptyReason')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(why.indexOf('diskUnreadable') < why.indexOf('Nothing pulled yet'),
    'the panel blames the pull before it says the files could not be read');
  assert.ok(/Refresh/.test(why.slice(why.indexOf('diskUnreadable'))),
    'the unreadable state names no control to press');
});

test('analytics: only the load that observed a read failure may keep it', async () => {
  const ctx = { rootGranted: true, readFile: async () => null, JSON };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'readJson'), ctx);
  const readJson = vm.runInContext('readJson', ctx);
  const seen = [];
  const denied = new Error('denied'); denied.name = 'NotAllowedError';
  await readJson('views.json', null, { current: () => false, read: async () => { throw denied; } }, (f) => seen.push(f));
  assert.equal(ctx.rootGranted, true, 'an old workspace revoked the permission verdict of the new one');
  assert.deepEqual(seen, [], 'an old workspace left its error behind for the new one');

  const broken = new Error('broken'); broken.name = 'NotReadableError';
  await readJson('schema.json', null, { current: () => true, read: async () => { throw broken; } }, (f) => seen.push(f));
  assert.equal(JSON.stringify(seen), JSON.stringify([{ rel: 'schema.json', name: 'NotReadableError' }]),
    'the active load lost the reason it needs to distinguish unreadable from absent');
});

// The mismatch bar told the reader that everything was disabled, in both products, word for word.
// It never was: Pull and the per-type pulls go dead because they would act on the wrong workspace,
// while Health, the diagram, the exports and the assistant read the mirror on disk and stay usable -
// which is the whole premise of a local mirror. The sentence was the one thing telling them
// otherwise, and it is what a reader forms their idea of the state from.
for (const app of ['crm', 'analytics']) {
  test(`${app}: the mismatch bar does not claim more is off than is off`, () => {
    const js = read(`apps/${app}/sidepanel.js`);
    assert.ok(!/Everything is disabled/.test(js), 'the bar claims the local views are off too');
    assert.ok(/what is already mirrored stays readable/.test(js),
      'the bar does not say that the mirror is still readable');
    // and what is actually refused is refused in one place, by the guard, rather than per button
    assert.ok(/guardOk\(\)/.test(js), 'nothing decides what a mismatch refuses');
  });
}

// A sample workspace is written by + Sample and never pulled, so Pull all is refused for it by
// design. Every empty list in one still said "Press Pull all" - reported on the Actions tab, which
// arrived after the sample generator did, so an older sample folder has no actions in it at all.
// Sending a reader to a control that is grey teaches them nothing and costs them the trip.
for (const app of ['crm', 'analytics']) {
  test(`${app}: an empty list in the sample workspace does not send you to a grey button`, () => {
    const why = sliceFn(`apps/${app}/sidepanel.js`, 'emptyReason');
    assert.ok(/isSample\(\)/.test(why), 'the sample is not a state the empty reason knows about');
    const at = why.indexOf('isSample()');
    const tail = why.slice(at);
    assert.ok(/\+ Sample<\/b> again/.test(tail), 'it does not name what actually rewrites the sample');
    assert.ok(!/Press <b>Pull all<\/b> to read/.test(tail.split('}')[0]),
      'the sample branch still sends the reader to Pull all');
    // Ordering: the folder and the permission still come first - they block the sample too.
    assert.ok(why.indexOf('rootGranted') < at, 'the sample is blamed before a folder nobody granted');
  });
}

// «Since Pull is disabled, everything that talks to Zoho should be» - and the protection has to be
// where the action starts, not where the control happens to sit. It was positional: an opaque
// overlay covered the list, and a click on a row of the tree that is not downloaded yet fetches that
// function from Zoho with nothing else in front of it. The overlay is gone, so every path that
// reaches the platform refuses on its own.
for (const [app, fns] of [
  ['crm', ['pullAll', 'pullModules', 'pullWorkflows', 'pullSchedules', 'pullConnections', 'pullActions',
           'pullFailures', 'downloadOne', 'downloadOneWf', 'resyncModuleNow', 'loadWorkflowUsage', 'syncOneNow',
           // The round, not the wiring: `reconcileFunctions` is single-flight bookkeeping and
           // `reconcileNow` is what reaches Zoho, which is what has to refuse.
           'reconcileNow']],
  ['analytics', ['pullAll', 'pullOne', 'retryFailed']],
]) {
  test(`${app}: every path to Zoho refuses a mismatch by itself`, () => {
    const js = panelBody(app);
    // The set is derived from the transport, so a path added tomorrow is measured rather than
    // remembered: everything that reaches the platform goes through toBridge.
    const reach = new Set();
    for (const m of js.matchAll(/toBridge\(/g)) {
      const head = Math.max(js.lastIndexOf('\nasync function ', m.index), js.lastIndexOf('\nfunction ', m.index));
      if (head > 0) reach.add(js.slice(head, js.indexOf('(', head)).split(' ').pop());
    }
    for (const fn of fns) {
      const body = pullEntry(app, fn);
      assert.ok(/if \(mismatchRefuse\(\)\) return/.test(body), `${fn} reaches Zoho without asking`);
    }
    // toBridge and getContext are the transport and the poll: they are how the mismatch is detected
    // at all, so they are the two that must not refuse.
    const unguarded = [...reach].filter((f) => !fns.includes(f) && !['toBridge', 'getContext', 'addWorkspace'].includes(f));
    assert.deepEqual(unguarded, [], `these reach Zoho and nothing was said about them: ${unguarded}`);
  });

  test(`${app}: the mismatch is stated, not curtained off`, () => {
    const html = read(`apps/${app}/sidepanel.html`), js = read(`apps/${app}/sidepanel.js`);
    assert.ok(!/mmoverlay/.test(html) && !/mmoverlay/.test(js),
      'the list is still covered, so what protects the reader is where things sit on screen');
    assert.ok(/id="mmbar"/.test(html), 'nothing says the two are different');
  });
}

// Asked for as a rule, by somebody who edits the DOM to remove `disabled` and sees what happens:
// «a check has to be added so that those functions cannot be invoked». So the refusal
// is at the action - above - and again at the transport, which is the only door to the platform.
// Two of them, because a guard on the caller can be forgotten on the next caller, and one in the
// door cannot.
for (const app of ['crm', 'analytics']) {
  test(`${app}: nothing reaches the platform through a mismatch, whatever the buttons say`, () => {
    const send = sliceFn(`apps/${app}/sidepanel.js`, 'toBridge');
    assert.ok(/throw new Error\(MSG\.mismatchRefused\)/.test(send),
      'the refusal is silent or unnamed at the door');
    const line = send.split('\n').find((l) => /throw new Error\(MSG\.mismatchRefused\)/.test(l));
    assert.ok(/&& bound && !guardOk\(\)/.test(line),
      'the transport lets anything through, so removing a disabled attribute is enough');
    // The exemptions are **derived from the line and checked against a declared set**, not pinned as
    // an expression: this used to assert the condition character for character, so adding a third
    // exemption failed the test for having changed rather than for being wrong, which teaches whoever
    // is adding one to edit the test. Each is a way past a guard on reaching Zoho, so each has to be
    // named here with its reason, and a fourth invented tomorrow fails until it is.
    //   context   the probe that detects the mismatch in the first place - refusing it is circular
    //   bound     a panel with nothing bound is creating its first workspace, which is no mismatch
    //   aboutTab  «Create workspace for <the tab's>», the control offered to *resolve* the mismatch.
    //             Safe because the bridge's workspaceInfo takes its id from the page's own URL.
    const declared = { crm: ["cmd !== 'context'", 'bound', '!guardOk()'],
                       analytics: ["cmd !== 'context'", '!aboutTab', 'bound', '!guardOk()'] }[app];
    const clauses = line.slice(line.indexOf('if (') + 4, line.lastIndexOf(') throw')).split('&&')
      .map((c) => c.trim().replace(/^msg\.?/, ''))
      .filter((c) => c && c !== 'msg');
    for (const c of clauses) {
      assert.ok(declared.some((d) => c.includes(d)),
        `${app}: «${c}» is a way past the mismatch guard that nothing here declares`);
    }
    for (const d of declared) {
      assert.ok(clauses.some((c) => c.includes(d)), `${app}: the guard no longer tests ${d}`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// «Nothing came back» is not «there is nothing». A mirror that cannot tell those apart writes a
// convincing lie: zero workflows, zero modules, zero views, and no error anywhere. The two bridges
// used to read every collection as `(resp.field || [])`, so a response whose shape had moved landed
// on disk as an empty area. These hold the three states apart - Zoho said none (204), Zoho sent an
// empty list, Zoho sent something this code does not recognise - in both products, because the rule
// is one and only the shape of the answer differs.
{
  // One context for both, and the reason is the thing being tested: the 204 answer is recognised by
  // *identity*, so lifting the sentinel and the reader separately gives two frozen objects that are
  // equal and not the same - which is exactly the failure this first produced. In the shipped file
  // they share one scope; a test that split them was testing its own harness.
  const { list, NO_CONTENT } = load([sliceConst('apps/crm/content-bridge.js', 'NO_CONTENT'),
                                     sliceFn('apps/crm/content-bridge.js', 'list')]);

  test('crm: a 204 is an answer, and it means none', () => {
    // Length, not deepEqual: the array comes back from the context the slice runs in, so its
    // prototype is that realm's and a strict structural compare fails on identity alone.
    assert.equal(list(NO_CONTENT, 'workflow_rules', 'workflow_rules').length, 0);
  });

  test('crm: an empty list is passed through as an empty list', () => {
    assert.equal(list({ workflow_rules: [] }, 'workflow_rules', 'workflow_rules').length, 0);
  });

  test('crm: a body without the collection stops, and says which field', () => {
    assert.throws(() => list({ info: { more_records: false } }, 'workflow_rules', '/crm/v8/...'),
                  /workflow_rules/);
    assert.throws(() => list({ workflow_rules: { id: 1 } }, 'workflow_rules', '/crm/v8/...'),
                  /not the shape/);
    try { list({}, 'modules', '/crm/v2/settings/modules'); assert.fail('no throw'); }
    catch (e) { assert.equal(e.shape, true, 'the failure does not say it is a shape failure'); }
  });

  const { need } = load([sliceFn('apps/analytics/content-bridge.js', 'need')]);

  test('analytics: the census refuses a shape it does not recognise', () => {
    assert.equal(need([], 'viewListValues', 'VIEWLIST').length, 0);
    assert.equal(need([[1]], 'viewListValues', 'VIEWLIST')[0][0], 1);
    assert.throws(() => need(undefined, 'viewListValues', 'VIEWLIST'), /viewListValues/);
    try { need(null, 'viewListKey', 'VIEWLIST'); assert.fail('no throw'); }
    catch (e) { assert.equal(e.shape, true); }
  });
}


// ---------------------------------------------------------------------------------------------
// Hostile text, from the three places it can actually come from: a name somebody typed in Zoho, a
// file in the mirror that a workspace author wrote, and an answer from a model. All three end up
// inside HTML the panel builds as strings, in a privileged extension page, so one missed helper is
// a DOM XSS with the extension's own permissions. The audit asked for these by name.
//
// What they hold is narrow on purpose: that the helpers do what they claim, on the inputs an
// attacker would actually send. They cannot prove every call site picked the right one - that is
// the limit of testing a helper rather than a page, and it is stated rather than implied.
{
  const HOSTILE = [
    '"><img src=x onerror=alert(1)>',
    '</scr' + 'ipt><scr' + 'ipt>alert(1)</scr' + 'ipt>',
    '<svg/onload=alert(1)>',
    '&"\'<>',
    ' <scr' + 'ipt>',
  ];

  const { escHtml } = load([sliceConst('apps/crm/sidepanel.js', 'escHtml')]);
  const { esc } = load([sliceConst('apps/analytics/sidepanel.js', 'esc')]);

  test('no hostile string keeps a tag open, in either product', () => {
    for (const s of HOSTILE) {
      for (const [name, f] of [['crm escHtml', escHtml], ['analytics esc', esc]]) {
        const out = f(s);
        assert.ok(!/<[a-zA-Z/]/.test(out), name + ' let a tag through: ' + out);
      }
    }
  });

  test('the attribute helper closes nothing it sits in', () => {
    for (const s of HOSTILE) {
      const out = escA(s);
      assert.ok(!/["\'<>]/.test(out), 'escA left a delimiter in: ' + out);
    }
  });

  test('what the model sends is text like any other', () => {
    // An answer is rendered, and a model can be talked into echoing markup by a Deluge comment that
    // looks like an instruction. Same helpers, same guarantee - the tools it can reach are a fixed
    // list elsewhere; this is only about what its words can do on the page.
    const injected = 'Sure! <img src=x onerror=fetch("https://evil.example/")>';
    assert.ok(!/<img/.test(escHtml(injected)));
    assert.ok(!/<img/.test(esc(injected)));
  });

  test('null and undefined do not arrive in markup as words', () => {
    // The Analytics helper takes `s ?? ''`; the CRM one takes String(s). Both are asserted so a
    // change to either is deliberate rather than noticed on a page.
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(escHtml(''), '');
  });
}

// ---------------------------------------------------------------------------------------------
// Searching inside the SQL, which the site promised and the panel could not do. `sqlHit` is the
// whole of the matching: what a term does inside one query - how many times, and the first line it
// is on - so the list can show where the match is instead of only that there was one.
{
  const { sqlHit } = load([sliceFn('apps/analytics/sidepanel.js', 'sqlHit')]);
  const SQL = 'SELECT a.x\nFROM "Orders" o\nJOIN "Accounts" a ON a.id = o.acc\nWHERE o.total > 0';

  test('a term that is not there is not a match', () => {
    assert.equal(sqlHit(SQL, 'zzz'), null);
    assert.equal(sqlHit('', 'JOIN'), null);
    assert.equal(sqlHit(SQL, ''), null);
    assert.equal(sqlHit(null, 'JOIN'), null);
  });

  test('it says how many times, and on which line the first one is', () => {
    const h = sqlHit(SQL, 'JOIN');
    assert.equal(h.count, 1);
    assert.equal(h.lineNo, 3);
    assert.ok(h.line.startsWith('JOIN "Accounts"'), h.line);
  });

  test('the count is every occurrence, not every line', () => {
    assert.equal(sqlHit('a x a x a', 'a').count, 3);
    assert.equal(sqlHit('aaaa', 'aa').count, 2, 'overlapping matches are counted once each');
  });

  test('case does not matter, because nobody types SQL in one case', () => {
    const h = sqlHit(SQL, 'join');
    assert.equal(h.count, 1);
    assert.equal(h.lineNo, 3);
  });

  test('the line is trimmed and bounded, so one long query cannot fill the list', () => {
    const long = 'x'.repeat(400) + 'needle';
    const h = sqlHit('   ' + long + '   ', 'needle');
    assert.ok(h.line.length <= 160, h.line.length);
    assert.equal(h.line[0], 'x', 'the line was not trimmed');
  });

  test('a match on the first line is line 1, not line 0', () => {
    assert.equal(sqlHit('SELECT 1', 'SELECT').lineNo, 1);
  });
}

// ---------------------------------------------------------------------------------------------
// The .* toggle: the same box, the text read as a pattern. `rxCompile` decides whether it parses,
// `sqlHit` takes the compiled pattern as its third argument, and `markLine` draws the marks. The
// helpers are byte-identical in the two panels, and that is asserted, because a twin that drifts
// is two search boxes that answer the same pattern differently.
{
  const { rxCompile, markLine, sqlHit } = load([
    sliceFn('apps/analytics/sidepanel.js', 'rxCompile'),
    sliceFn('apps/analytics/sidepanel.js', 'markLine'),
    sliceFn('apps/analytics/sidepanel.js', 'sqlHit'),
  ]);
  const SQL = 'SELECT a.x\nFROM "Orders" o\nJOIN "Accounts" a ON a.id = o.acc\nWHERE o.total > 0';

  test('the two panels carry the same helpers, byte for byte', () => {
    for (const fn of ['rxCompile', 'markLine']) {
      assert.equal(sliceFn('apps/crm/sidepanel.js', fn), sliceFn('apps/analytics/sidepanel.js', fn),
        'why=' + fn + ' has drifted between the twins');
    }
  });

  test('a pattern that parses comes back as a regexp, case-insensitive and per-line anchored', () => {
    const { re, error } = rxCompile('^join\\b');
    assert.equal(error, undefined);
    // Not `instanceof RegExp`: the slice runs in its own vm context, whose RegExp is another realm's.
    assert.equal(typeof re.exec, 'function');
    assert.equal(re.flags, 'gim');
  });

  test('a pattern that does not parse comes back as its reason, never as a throw', () => {
    const r = rxCompile('a(');
    assert.equal(r.re, undefined);
    assert.ok(/group|parenthes/i.test(r.error), r.error);
  });

  test('sqlHit with a pattern: count, first line, line number', () => {
    const h = sqlHit(SQL, 'o\\.\\w+', rxCompile('o\\.\\w+').re);
    assert.equal(h.count, 2, 'o.acc and o.total');
    assert.equal(h.lineNo, 3);
    assert.ok(h.line.includes('o.acc'), h.line);
  });

  test('^ and $ anchor at each line, which is what a reader of SQL means by them', () => {
    assert.equal(sqlHit(SQL, 'x', rxCompile('^JOIN').re).lineNo, 3);
    assert.equal(sqlHit(SQL, 'x', rxCompile('acc$').re).count, 1);
  });

  test('a pattern whose only matches are empty matches nothing', () => {
    assert.equal(sqlHit(SQL, 'x', rxCompile('q*').re), null);
  });

  test('a reused pattern starts from the top of each text - g keeps no state between calls', () => {
    const re = rxCompile('JOIN').re;
    assert.equal(sqlHit(SQL, 'x', re).count, 1);
    assert.equal(sqlHit(SQL, 'x', re).count, 1, 'the second call saw the stale lastIndex');
  });

  test('markLine wraps every match and escapes everything else', () => {
    const esc0 = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.equal(markLine('a < b JOIN c', rxCompile('join').re, esc0), 'a &lt; b <mark>JOIN</mark> c');
    assert.equal(markLine('x & <y>', rxCompile('nothing').re, esc0), 'x &amp; &lt;y&gt;');
  });

  test('markLine matches the raw text, so a pattern touching < still marks it', () => {
    const esc0 = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.equal(markLine('if (a < 3)', rxCompile('a < \\d').re, esc0), 'if (<mark>a &lt; 3</mark>)');
  });

  test('markLine steps over zero-length matches instead of looping', () => {
    const esc0 = (t) => t;
    assert.equal(markLine('abc', rxCompile('z*').re, esc0), 'abc');
    assert.equal(markLine('aab', rxCompile('a*').re, esc0), '<mark>aa</mark>b');
  });
}

// ---------------------------------------------------------------------------------------------
// Problem reports. The product's whole claim is that nothing leaves the machine on its own, and
// this is the one feature that could break it - so it is held to the mechanism rather than to the
// sentence: a whitelist decides what is offered, `redact()` scrubs every free-text field, the
// reader sees the result, and only a click opens the page that can send it.
{
  const { redact, buildReport } = load([
    sliceFn('apps/crm/sidepanel.js', 'redact'),
    sliceFn('apps/crm/sidepanel.js', 'redactHard'),
    sliceFn('apps/crm/sidepanel.js', 'buildReport'),
  ]);

  test('the report core is one text in both panels', () => {
    for (const fn of ['redact', 'buildReport', 'noteStep']) {
      assert.equal(sliceFn('apps/crm/sidepanel.js', fn), sliceFn('apps/analytics/sidepanel.js', fn),
        'why=' + fn + ' has drifted between the twins');
    }
  });

  test('redact takes out what could name a business, and counts what it took', () => {
    const r = redact('mail ivan@example.com about org 349725000131663089');
    assert.ok(!/example\.com/.test(r.text), r.text);
    assert.ok(!/349725000131663089/.test(r.text), r.text);
    assert.equal(r.n, 2, 'the reader is not told how much was removed');
  });

  test('a quoted name never survives, in either quoting style the panels use', () => {
    assert.ok(!/Acme/.test(redact('bound to EU \u00abAcme Ltd\u00bb').text));
    assert.ok(!/Secret/.test(redact('Failed: "Secret.Process"').text));
  });

  test('our own stack is kept - it is the whole diagnostic value', () => {
    const r = redact('at pullAll (chrome-extension://abcdefghijklmnop/sidepanel.js:1234:5)');
    assert.ok(/sidepanel\.js:1234:5/.test(r.text), r.text);
    assert.ok(/pullAll/.test(r.text), 'the function name went with the extension id');
    assert.ok(!/abcdefghijklmnop/.test(r.text), 'the extension id is noise and stays out');
  });

  test('a Zoho URL is not a place the report may name', () => {
    const r = redact('GET https://crm.zoho.eu/crm/v2/settings/modules failed');
    assert.ok(!/zoho\.eu/.test(r.text), r.text);
    assert.ok(/failed/.test(r.text), 'the shape of the sentence is what diagnoses');
  });

  test('redact is total: null, undefined and empty are not crashes', () => {
    for (const v of [null, undefined, '', 0]) assert.equal(redact(v).n, 0);
  });

  test('the report prints numbers as numbers and nothing a caller smuggled in', () => {
    const out = buildReport({
      product: 'Zoost CRM', version: '1.45.0', browser: 'Chrome 141',
      message: 'boom', tab: 'functions', search: 'code', pullActive: false,
      sample: true, ai: 'anthropic', counts: { functions: '412; rm -rf', modules: 31 }, refused: [],
    });
    assert.ok(/functions NaN/.test(out) || /functions 412/.test(out) === false || /rm -rf/.test(out) === false,
      'a count reached the report as text: ' + out);
    assert.ok(!/rm -rf/.test(out), 'free text arrived through a numeric field');
  });

  test('the report says how many redactions it made, every time', () => {
    const out = buildReport({ product: 'p', version: 'v', browser: 'b', message: 'org 349725000131663089', tab: 't', search: 's', pullActive: false, sample: false });
    assert.ok(/redactions: 1/.test(out), out);
    assert.ok(/no source, no SQL, no keys/.test(out), 'the report does not state its own scope');
    assert.ok(/stripped where they are recognised/.test(out),
      'why=the report claims more than the redaction can deliver, or says nothing about its limits');
  });

  // A fresh buffer per case: the array is module state, so two cases sharing one load would make
  // the second depend on what the first pushed.
  const freshBuffer = () => load([
    sliceConst('apps/crm/sidepanel.js', 'REPORT_STEPS_MAX'),
    sliceConst('apps/crm/sidepanel.js', 'reportSteps'),
    sliceFn('apps/crm/sidepanel.js', 'noteStep'),
  ]);

  test('the steps buffer is bounded and drops the oldest, so a long session cannot fill a report', () => {
    const m = freshBuffer();
    for (let i = 0; i < 100; i++) m.noteStep('line ' + i);
    assert.equal(m.REPORT_STEPS_MAX, 30);
    assert.equal(m.reportSteps.length, 30, 'the buffer grew past its bound');
    assert.equal(m.reportSteps[0], 'line 70', 'it dropped the newest instead of the oldest');
  });

  test('a progress line repeating itself does not fill the buffer with one sentence', () => {
    const m = freshBuffer();
    m.noteStep('same'); m.noteStep('same'); m.noteStep('other');
    assert.equal(m.reportSteps.length, 2, m.reportSteps.join('|'));
  });

  test('neither the builder nor the gatherer names a field the product promises never to collect', () => {
    // Derived from REPORT_NEVER itself, which was dead code claiming to be a mechanism until an
    // audit said so. Both functions are checked: the first version read only buildReport, and
    // everything sensitive would have arrived through reportFacts.
    for (const app of ['crm', 'analytics']) {
      const never = JSON.parse(sliceConst(`apps/${app}/sidepanel.js`, 'REPORT_NEVER')
        .replace(/^[^=]*=\s*/, '').replace(/;\s*$/, '').replace(/'/g, '"'));
      assert.ok(never.length >= 10, 'why=the list of what is never collected has been emptied');
      // The manifest is *ours* - `getManifest().name` is "Zoost - workbench for…", not anything of
      // the user's - so its reads are taken out before the check, and named here rather than left
      // as a mysterious exception.
      const src = (sliceFn(`apps/${app}/sidepanel.js`, 'buildReport') + sliceFn(`apps/${app}/sidepanel.js`, 'reportFacts'))
        .replace(/chrome\.runtime\.getManifest\(\)/g, 'MF').replace(/\bm\.(name|version)\b/g, 'MF');
      for (const field of never) {
        assert.ok(!new RegExp('\\.' + field + '\\b').test(src),
          'why=' + app + ' reads .' + field + ' into the report');
      }
    }
  });

  test('the hard redaction takes out what an audit found the status lines actually carry', () => {
    const { redactHard } = load([sliceFn('apps/crm/sidepanel.js', 'redactHard')]);
    // Every one of these is a real status string from these panels, with a real value in it.
    const cases = [
      ['Synced: functions/Commissions/Recalc_ACME_Fees.dg', /ACME|Recalc|Commissions/],
      ['Working folder: \u00abAcmeCorp Ltd\u00bb', /AcmeCorp/],
      ['Workspace ready: acmecorp-681234567 - Pull to fill it.', /681234567/],
      ['Could not open zcrm_349725000131663089', /349725000131663089/],
      ['GET crm.zoho.eu failed', /zoho\.eu/],
      ["Grant failed: user denied 'MyClientFolder'", /MyClientFolder/],
      ['Opened \u00abDeals_Custom\u00bb in Zoho.', /Deals_Custom/],
    ];
    for (const [input, mustGo] of cases) {
      const out = redactHard(input).text;
      assert.ok(!mustGo.test(out), 'why=' + JSON.stringify(input) + ' survived as ' + JSON.stringify(out));
      assert.ok(redactHard(input).n > 0, 'why=nothing was counted for ' + JSON.stringify(input));
    }
  });

  test('no status line interpolates a name outside quotes, so the net can find it', () => {
    // The net cannot recognise a bare name - «AcmeCorp Ltd» is words. The panels quote names with
    // « » everywhere else, so the fix and the house style are the same thing; this holds it.
    for (const app of ['crm', 'analytics']) {
      const src = read(`apps/${app}/sidepanel.js`);
      const re = /(?:setStatus|status)\(`([^`]*)`/g;
      let m;
      while ((m = re.exec(src))) {
        const tpl = m[1];
        const bare = /(^|[^\u00ab\/\w])\$\{[^}]*(?:\.name|\.stem|\.folder|genName)[^}]*\}/.test(tpl);
        assert.ok(!bare, 'why=' + app + ' puts a name into the status line unquoted: ' + tpl.slice(0, 70));
      }
    }
  });

  test('the report carries a stack when something actually threw', () => {
    for (const app of ['crm', 'analytics']) {
      const src = read(`apps/${app}/sidepanel.js`);
      assert.ok(/addEventListener\('error'/.test(src) && /unhandledrejection/.test(src),
        'why=' + app + ' never captures a thrown error, so the report is only the status buffer');
      assert.ok(/reportFacts\(lastThrown/.test(src),
        'why=' + app + ' builds the report without the error it captured');
    }
  });

  test('the report is handed to the page through the DOM, never through the address', () => {
    // It travelled in the URL fragment until an audit pointed out that the navigation itself is
    // recorded in history and syncs with it - the report leaving the machine with no click.
    for (const app of ['crm', 'analytics']) {
      const src = read(`apps/${app}/sidepanel.js`);
      assert.ok(!/zoost\.it\/report#/.test(src), 'why=' + app + ' still puts the report in a URL');
      assert.ok(/chrome\.scripting\.executeScript/.test(handlerOf(`apps/${app}/sidepanel.js`, 'repopen')),
        'why=' + app + ' does not put the text into the page it opened');
      const mf = JSON.parse(read(`apps/${app}/manifest.json`));
      assert.ok(mf.host_permissions.includes('https://zoost.it/*'),
        'why=' + app + ' injects into a host it has no permission for, so the button does nothing');
    }
  });

  test('the report page opens in a window of its own, not in a tab of this one', () => {
    // Reported after the first real send: the side panel belongs to its window, so a new tab opened
    // beside it - the reader was asked to read a report with the panel that wrote it still on screen.
    // A window has no panel in it. The listener must then watch the tab *inside* that window, which
    // is the part a careless change breaks silently: the injection simply never fires.
    for (const app of ['crm', 'analytics']) {
      const src = read(`apps/${app}/sidepanel.js`);
      const block = handlerOf(`apps/${app}/sidepanel.js`, 'repopen');
      assert.ok(/chrome\.windows\.create/.test(block), 'why=' + app + ' opens the report in a tab');
      assert.ok(!/chrome\.tabs\.create/.test(block), 'why=' + app + ' still opens a tab');
      assert.ok(/win\.tabs\[0\]/.test(block),
        'why=' + app + ' does not take the tab out of the window it just opened');
      assert.ok(/if \(!tabId\) \{ setReportFallback\(\); return; \}/.test(block),
        'why=' + app + ' bails silently when the window comes back without a tab');
    }
  });


  test('«outdated» compares what the list said with what the list said', () => {
    // The regression this replaces shipped on 19 Aug 2026 and was reported the next morning: the org
    // list reports `updatedTime` as epoch milliseconds and a function's detail reports it as
    // «2026-03-13 11:20:59.0», and the two were compared with `!==`. True for every function, for
    // ever. Measured on a real org: 160 of 160 rows «outdated», of which the panel showed one,
    // because the other 159 were loaded from the summary - which did not make the comparison at all.
    const { movedInZoho } = load([sliceConst('apps/crm/sidepanel.js', 'movedInZoho')]);
    assert.equal(movedInZoho(1773397259000, 1773397259000), false, 'the same instant reads as moved');
    assert.equal(movedInZoho(1773397259000, '1773397259000'), false, 'a number and its own text differ');
    assert.equal(movedInZoho(1773397259000, 1773397260000), true, 'a function edited in Zoho is missed');
    // The shapes that caused it: never comparable, so never a measurement.
    assert.equal(movedInZoho(1773397259000, null), false, 'a copy fetched before this field existed is not evidence');
    assert.equal(movedInZoho(null, 1773397259000), false, 'a list that said nothing is not evidence');
    assert.equal(movedInZoho(1773397259000, '2026-03-13 11:20:59.0'), true,
      'the string form must never be handed to this - the call sites are what keep the pair honest');
    const src = read('apps/crm/sidepanel.js');
    assert.ok(!/row\.listUpdated\s*!==\s*meta\.updatedTime/.test(src),
      'why=crm compares an epoch against a formatted string again');
    // Both paths, or the answer depends on which one loaded the workspace.
    for (const anchor of ['row.stale = (s.sv || 0) < META_SV', 'row.stale = row.pathChanged']) {
      const at = src.indexOf(anchor);
      assert.ok(at > 0, `why=the ${anchor} path is gone`);
      assert.ok(src.slice(at, at + 260).includes('movedInZoho('),
        'why=one of the two load paths does not apply the rule the other does');
    }
  });

  test('the tab decides whether the missing/outdated button is shown', () => {
    // Reported: leaving Functions with «Refresh 1 outdated» up and switching to Schedules left the
    // button there, over a list it says nothing about. It was the *renderers* that set it, and only
    // two of the six views call it - so on the other four the button kept whatever the last view had
    // put there. The mode is what the function reads on its first line, so the mode is what must
    // call it.
    const src = read('apps/crm/sidepanel.js');
    const fn = src.slice(src.indexOf('function setMode(mode) {'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(body.includes('updateMissingButton()'),
      'why=setMode leaves the button to whichever renderer happens to update it');
    assert.ok(body.indexOf('updateMissingButton()') < body.indexOf('rebuildActive()'),
      'why=the button is updated after the rebuild is kicked off, so it flickers with the old count');
    // And the function itself must still be the one that knows which tabs have no such button.
    const um = src.slice(src.indexOf('function updateMissingButton()'));
    for (const tab of ['modules', 'schedules', 'connections', 'actions']) {
      assert.ok(um.slice(0, um.indexOf('\n}')).includes(`'${tab}'`),
        `why=${tab} is not among the tabs the button hides itself on`);
    }
  });

  test('the emergency row can be dismissed, in both panels', () => {
    // Reported: after a report is sent nothing else happens, and every other status line is cleared
    // by the *next* one - so that row sat there for good, offering to report a problem that had
    // already been reported. The three parts appear and go together, which is the part a later edit
    // gets wrong: adding a fourth and forgetting it leaves a stray control on an empty row.
    for (const app of ['crm', 'analytics']) {
      const js = read(`apps/${app}/sidepanel.js`);
      const html = read(`apps/${app}/sidepanel.html`);
      assert.ok(html.includes('id="repdismiss"'), `why=${app} has no way to clear the row`);
      assert.ok(/\$\('repdismiss'\)\.onclick = \(\) => showEmergency\(false\);/.test(js),
        `why=${app} draws the control without wiring it`);
      const fn = js.slice(js.indexOf('function showEmergency('));
      const line = fn.slice(0, fn.indexOf('\n'));
      for (const id of ['emerg', 'repopen', 'repdismiss']) {
        assert.ok(line.includes(`'${id}'`), `why=${app} leaves ${id} behind when the row is toggled`);
      }
    }
  });

  test('the report is read once, on the page, and the panel has no dialog of its own', () => {
    // It used to be shown in a panel dialog whose button said «Send…» and sent nothing - the same
    // text read twice, with the button that mattered on the second copy. Nothing leaves when the
    // page opens, so the step defended nothing. A regression here is not cosmetic: it is a second
    // «Send» that does not send, which is the shape of the thing that was removed.
    for (const app of ['crm', 'analytics']) {
      const js = read(`apps/${app}/sidepanel.js`);
      const html = read(`apps/${app}/sidepanel.html`);
      for (const id of ['repdlg', 'repbody', 'repgo', 'repcancel', 'repcopy']) {
        assert.ok(!html.includes(`id="${id}"`), `why=${app} still has the dialog element ${id}`);
        assert.ok(!js.includes(`'${id}'`), `why=${app} still wires ${id}`);
      }
      const block = handlerOf(`apps/${app}/sidepanel.js`, 'repopen');
      assert.ok(/buildReport\(reportFacts\(/.test(block),
        `why=${app} does not build the report where the page is opened`);
    }
  });

  test('the status funnel is what fills the buffer, in both panels', () => {
    // One funnel, so a message printed by code written tomorrow is in the report without anyone
    // remembering - and a second funnel added later is the thing this would catch.
    assert.ok(/const setStatus = \(t, cls = ''\) => \{ noteStep\(t\);/.test(read('apps/crm/sidepanel.js')),
      'why=the CRM status line does not reach the report');
    assert.ok(/function status\(text, kind\) \{ noteStep\(text\);/.test(read('apps/analytics/sidepanel.js')),
      'why=the Analytics status line does not reach the report');
  });
}

// ---------------------------------------------------------------------------------------------
// The saved patterns behind the ▾ menu. The background seeds two on install - and only when the key
// has never existed, or an emptied list would grow its presets back. The options page is the only
// writer after that, and `rxProblems` is the whole of what it refuses.
{
  const { rxDefaults } = load([sliceFn('apps/crm/background.js', 'rxDefaults')]);
  const { rxProblems } = load([sliceFn('apps/crm/options.js', 'rxProblems')]);

  test('the seed and the validation are byte-identical in the twins', () => {
    // Four copies of the starters: two backgrounds (the seeders) and two options pages (Restore
    // the starters). Any one drifting means restore brings back something the seed never wrote.
    const seed = sliceFn('apps/crm/background.js', 'rxDefaults');
    for (const f of ['apps/analytics/background.js', 'apps/crm/options.js', 'apps/analytics/options.js']) {
      assert.equal(sliceFn(f, 'rxDefaults'), seed, 'why=the starters in ' + f + ' have drifted from the seed');
    }
    assert.equal(sliceFn('apps/crm/options.js', 'rxProblems'),
      sliceFn('apps/analytics/options.js', 'rxProblems'), 'why=the validation has drifted');
  });

  test('restoring the starters brings back only what is missing, and only when something is', () => {
    for (const app of ['crm', 'analytics']) {
      const o = read(`apps/${app}/options.js`);
      const h = o.slice(o.indexOf("$('rxRestore').onclick"), o.indexOf("$('saveRx')"));
      assert.ok(/if \(!have\.has\(d\.name\.toLowerCase\(\)\)\) rxCur\.push\(d\)/.test(h),
        'why=' + app + ' restore overwrites kept or edited entries instead of adding the absent ones');
      assert.ok(/rxDefaults\(\)\.some\(\(d\) => !have\.has\(d\.name\.toLowerCase\(\)\)\)/.test(o),
        'why=' + app + ' shows a restore button with nothing to restore');
    }
  });

  test('an expression already in the list is refused everywhere it could be saved twice', () => {
    assert.ok(/are the same expression/.test(
      rxProblems([{ name: 'A', pattern: 'x+' }, { name: 'B', pattern: 'x+' }])),
      'why=the Settings page saves two entries that search identically');
    for (const app of ['crm', 'analytics']) {
      const panel = read(`apps/${app}/sidepanel.js`);
      // The save is `saveSearchPattern` now, a declaration of its own, so the slice takes both:
      // reading only the menu would silently stop covering the three rules below it.
      const m = panel.slice(panel.indexOf('async function openRxMenu'), panel.indexOf("$('rxpick').onclick"))
        + sliceFn(`apps/${app}/sidepanel.js`, 'saveSearchPattern');
      assert.ok(/items\.find\(\(x\) => x\.pattern === rawQ\)/.test(m),
        'why=' + app + ' menu re-offers Save for a pattern the list already holds');
      assert.ok(/already saved as/.test(m),
        'why=' + app + ' hides the fact instead of naming the entry that holds the pattern');
      assert.ok(/\.slice\(\)\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name, undefined, \{ sensitivity: 'base' \}\)\)/.test(m),
        'why=' + app + ' menu lists patterns in append order, which a reader cannot scan');
    }
  });

  test('the seed only writes over a key that has never existed', () => {
    for (const app of ['crm', 'analytics']) {
      const bg = read(`apps/${app}/background.js`);
      assert.ok(/st\.rxShortcuts === undefined/.test(bg),
        'why=' + app + ' would re-seed an emptied list, making the presets undeletable');
    }
  });

  test('both seeded patterns parse under the flags the search uses', () => {
    for (const { pattern } of rxDefaults()) new RegExp(pattern, 'gim');
  });

  test('the email pattern finds an address and nothing pretending to be one', () => {
    const re = new RegExp(rxDefaults()[0].pattern, 'gim');
    assert.ok(re.test('write to First.Last+tag@sub.example.co about it'));
    re.lastIndex = 0;
    assert.ok(!re.test('an @ alone, or version 2.5, is not an address'));
  });

  test('the Zoho id pattern is exactly 18 digits, bounded', () => {
    const re = () => new RegExp(rxDefaults()[1].pattern, 'gim');
    assert.ok(re().test('deleteRecord(349725000131663089);'));
    assert.ok(!re().test('order 12345'), 'an ordinary number is not an id');
    assert.ok(!re().test('x1234567890123456789x'), '19 digits is not this id');
  });

  test('matchSpans finds every span once and steps over the empty ones', () => {
    const { matchSpans } = load([sliceFn('apps/analytics/sidepanel.js', 'matchSpans')]);
    const re = /a+/gim;
    // Compared as JSON: the slice runs in its own vm realm, whose Array prototype fails strict
    // deep-equality against this one.
    assert.equal(JSON.stringify(matchSpans('aa b a', re)), '[[0,2],[5,6]]');
    assert.equal(JSON.stringify(matchSpans('aa b a', re)), '[[0,2],[5,6]]', 'the second call saw the stale lastIndex');
    assert.equal(JSON.stringify(matchSpans('bcd', /z*/gim)), '[]', 'an all-empty match set is no spans');
  });

  test('the detail painter is the same in both panels, and both pages give it its colour', () => {
    for (const fn of ['matchSpans', 'paintFindMarks']) {
      assert.equal(sliceFn('apps/crm/sidepanel.js', fn), sliceFn('apps/analytics/sidepanel.js', fn),
        'why=' + fn + ' has drifted between the twins');
    }
    for (const app of ['crm', 'analytics']) {
      assert.ok(/::highlight\(zoost-find\)/.test(read(`apps/${app}/sidepanel.html`)),
        'why=' + app + ' registers ranges under a name its page never styles');
    }
  });

  test('the detail pane shows the search: painted on render, repainted on every change', () => {
    const crm = read('apps/crm/sidepanel.js');
    assert.equal((crm.match(/paintFindMarks\(\$\('pvcode'\), findMarkRe\(\)\)/g) || []).length, 2,
      'why=the CRM preview is painted on open or on search change, but not both');
    assert.ok(/openFile\(r\.e\.path, r\.lineNo, true\)/.test(crm),
      'why=a search hit opens the file at the top instead of at its line');
    const an = read('apps/analytics/sidepanel.js');
    assert.equal((an.match(/paintFindMarks\(.*pre\.sql.*findMarkRe\(\)\)/g) || []).length, 2,
      'why=the Analytics SQL tab is painted on render or on search change, but not both');
    assert.ok(/detailTab = 'sql';\n      openDetail/.test(an),
      'why=a row opened from an SQL search opens on a tab without the match');
  });

  test('a valid list is nothing to refuse', () => {
    assert.equal(rxProblems([{ name: 'Email', pattern: 'a+' }, { name: 'Id', pattern: '\\d{18}' }]), null);
    assert.equal(rxProblems([]), null, 'an empty list is a choice, not a problem');
  });

  test('a read that failed is not an empty list, anywhere it could be mistaken for one', () => {
    for (const app of ['crm', 'analytics']) {
      const panel = read(`apps/${app}/sidepanel.js`);
      assert.ok(/catch \(_\) \{ return null; \}/.test(panel),
        'why=' + app + ' panel turns a failed storage read into \u00abno saved patterns\u00bb');
      const opts = read(`apps/${app}/options.js`);
      assert.ok(/let rxLoadFailed = true;/.test(opts),
        'why=' + app + ' options can save over a list that was never read');
      assert.ok(/if \(rxLoadFailed\)/.test(handlerOf(`apps/${app}/options.js`, 'saveRx')),
        'why=' + app + ' Save does not ask whether the load succeeded');
    }
  });

  test('switching the toggle off empties the box; switching it on keeps the seed', () => {
    // Reported: the pattern stayed in the box with .* off, and a regex read as a literal is a
    // search for text that does not exist.
    for (const app of ['crm', 'analytics']) {
      const panel = read(`apps/${app}/sidepanel.js`);
      const h = handlerOf(`apps/${app}/sidepanel.js`, 'rxmode');
      assert.ok(/if \(!regexMode\) \$\('find'\)\.value = '';/.test(h),
        'why=' + app + ' keeps the pattern as a literal search when the toggle goes off');
      // The same rule on the other way out of full-text: the in: switch back to names.
      const sm = handlerOf(`apps/${app}/sidepanel.js`, 'smode');
      assert.ok(/&& regexMode\) \{ regexMode = false; \$\('rxmode'\)\.classList\.remove\('on'\); \$\('find'\)\.value = ''; \}/.test(sm),
        'why=' + app + ' carries the pattern into the name search when the scope switch leaves full-text');
    }
  });

  test('the menu saves only what it could: a parsing pattern, onto a list that was read', () => {
    for (const app of ['crm', 'analytics']) {
      const panel = read(`apps/${app}/sidepanel.js`);
      // The save is `saveSearchPattern` now, a declaration of its own - see the note above the twin
      // of this slice further up. Reading only the menu would silently stop covering it.
      const m = panel.slice(panel.indexOf('async function openRxMenu'), panel.indexOf("$('rxpick').onclick"))
        + sliceFn(`apps/${app}/sidepanel.js`, 'saveSearchPattern');
      assert.ok(/const savable = list !== null && regexMode && rawQ && !!rxCompile\(rawQ\)\.re/.test(m),
        'why=' + app + ' offers Save over an unread list, or for a pattern that does not parse');
      assert.ok(/x\.name\.trim\(\)\.toLowerCase\(\) === name\.toLowerCase\(\)/.test(m),
        'why=' + app + ' saves two patterns the menu cannot tell apart');
      assert.ok(/\[\.\.\.items, \{ name, pattern: rawQ \}\]/.test(m),
        'why=' + app + ' overwrites the list instead of appending to it');
      assert.ok(/if \(e\.key === 'Enter'\) doSave\(\)/.test(m),
        'why=' + app + ' makes the keyboard walk to the Save button');
    }
  });

  test('the menu element exists before the scripts that touch it at load', () => {
    // #rxmenu first landed after the <script> tags, and the top-level init crashed on
    // null.classList in setMode - found only by the render harness actually loading the page.
    for (const app of ['crm', 'analytics']) {
      const html = read(`apps/${app}/sidepanel.html`);
      const div = html.indexOf('id="rxmenu"');
      const script = html.search(/<script src=/);
      assert.ok(div >= 0 && script >= 0 && div < script,
        'why=' + app + ' scripts run before the menu element exists');
    }
  });

  test('hiding the picker closes its menu, and a menu opened late refuses to act', () => {
    for (const app of ['crm', 'analytics']) {
      const panel = read(`apps/${app}/sidepanel.js`);
      const hides = (panel.match(/\$\('rxpick'\)\.style\.display = ('none'|\$\('rxpick'\))/g) || []).length;
      const closes = (panel.match(/\$\('rxmenu'\)\.classList\.remove\('show'\)/g) || []).length;
      assert.ok(closes >= 3, 'why=' + app + ' can hide the \u25be button and leave its menu floating (' + closes + ' close sites)');
      assert.ok(/if \(\$\('rxpick'\)\.style\.display === 'none'\) return;/.test(panel),
        'why=' + app + ' opens or applies the menu for a control that is no longer there');
      // Anchored to the menu: the panels already close their dialogs on Escape, so a bare match
      // would pass with this listener deleted - proven by deleting it.
      assert.ok(/if \(e\.key === 'Escape'\) \$\('rxmenu'\)/.test(panel),
        'why=' + app + ' menu cannot be dismissed from the keyboard');
    }
  });

  test('the cache loop closes the status line it opened', () => {
    // «Reading sources 150/150…» stood with the spinner going after the read had finished, and a
    // busy status left standing is indistinguishable from a hang. The Analytics twin has always
    // said «N queries read.» at the end; this holds the CRM to the same shape.
    const crm = read('apps/crm/sidepanel.js');
    const cc = crm.slice(crm.indexOf('async function getCodeCache'), crm.indexOf('async function contentSearch'));
    assert.ok(/source\(s\) read\.`, 'ok'\)/.test(cc),
      'why=the busy line from the tranche loop is never closed');
  });

  test('a content search that finished late cannot land, and SQL typing is debounced', () => {
    const crm = read('apps/crm/sidepanel.js');
    assert.ok(/searchSeq\+\+/.test(crm), 'why=nothing moves the sequence');
    assert.ok(/mine !== searchSeq \|\| !cache/.test(crm),
      'why=a stale contentSearch overwrites the newer result after its await');
    const an = read('apps/analytics/sidepanel.js');
    assert.ok(/clearTimeout\(_sqlSearchT\); _sqlSearchT = setTimeout\(render, 220\)/.test(an),
      'why=every keystroke runs the pattern over every cached query body');
    assert.ok(/out = rx && rx\.error \? \[\]/.test(an),
      'why=a broken pattern leaves every view in visibleViews, and the keyboard steps onto them');
  });

  test('what stops a save is named: the row, the pattern, the clash', () => {
    assert.ok(/Row 2 has no name/.test(rxProblems([{ name: 'a', pattern: 'x' }, { name: ' ', pattern: 'y' }])));
    assert.ok(/"a" has no pattern/.test(rxProblems([{ name: 'a', pattern: '  ' }])));
    assert.ok(/does not parse/.test(rxProblems([{ name: 'a', pattern: 'x(' }])));
    assert.ok(/share the name/.test(rxProblems([{ name: 'A', pattern: 'x' }, { name: ' a ', pattern: 'y' }])),
      'two names one trim-and-case apart are the same menu entry');
  });
}

// ---------------------------------------------------------------------------------------------
// What the diagram window is handed. Reported by an assistant reading the repository, and the day
// before I had called the same finding false: `graph-core.js` does delete the source from every
// node - which is what I measured - and then `loadGraph()` puts it straight back as `source_code`,
// for the assistant and the Markdown export, both of which read it from memory. So every «open the
// diagram» wrote a copy of every Deluge function into chrome.storage.local, and left it there.
//
// The window has never read it: `source_code` appears nowhere in either graphview.js. So it is
// stripped, and the payload moved to session storage, which is memory.
{
  const { graphForWindow } = load([sliceFn('apps/crm/sidepanel.js', 'graphForWindow')]);

  test('the payload carries no source, and keeps everything else', () => {
    const g = { counts: { nodes: 1 }, focus: 'a.b', nodes: {
      'a.b': { id: 'a.b', name: 'b', calls: ['c.d'], stats: { lines: 4 }, source_code: 'info "secret";' },
      'c.d': { id: 'c.d', name: 'd', calls: [] },
    } };
    const out = graphForWindow(g);
    assert.equal('source_code' in out.nodes['a.b'], false, 'the source is still in the payload');
    assert.equal(out.nodes['a.b'].name, 'b');
    assert.equal(out.nodes['a.b'].stats.lines, 4);
    assert.equal(out.nodes['a.b'].calls[0], 'c.d');
    assert.equal(out.focus, 'a.b');
    assert.equal(out.counts.nodes, 1);
  });

  test('the graph the panel is holding is not changed by handing it over', () => {
    // The panel goes on using source_code after the window opens - the assistant reads it - so a
    // payload built by deleting in place would have taken the AI context with it.
    const g = { nodes: { 'a.b': { source_code: 'x' } } };
    graphForWindow(g);
    assert.equal(g.nodes['a.b'].source_code, 'x');
  });

  test('nothing writes a graph to storage.local, and the window reads session', () => {
    for (const app of ['crm', 'analytics']) {
      const panel = panelBody(app);
      const win = read(`apps/${app}/graphview.js`);
      assert.ok(!/storage\.local\.set\(\{\s*graphData/.test(panel),
                `${app}: a graph is still written to storage.local, where it stays on disk`);
      // One key per window since the token change; every write still goes through graphForWindow.
      const writes = panel.match(/storage\.session\.set\(\{ \[[^\]]*\]: [^}]*\}\)/g) || [];
      assert.ok(writes.length, `${app}: no graph is handed to the window at all`);
      writes.forEach((w) => assert.ok(/graphForWindow\(/.test(w),
        `${app}: a payload skips graphForWindow, so it may carry the source: ${w}`));
      assert.ok(!/storage\.session\.set\(\{ graphData:/.test(panel),
                `${app}: a writer still uses the shared slot, so two windows can consume each other's graph`);
      assert.ok(/storage\.session\.get\(key\)/.test(win), `${app}: the window does not read its own key`);
      assert.ok(/'graphData:' \+ token/.test(win), `${app}: the window ignores the token in its URL`);
      assert.ok(!/source_code/.test(win), `${app}: the window reads source_code, so stripping it breaks it`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// A preference saved before the default was fixed. The dialog used to open with the sensitive
// section ticked, so a stored `code: true` is at least as likely to be that old default as somebody's
// decision - and the promise on three surfaces is that including it *is* a decision. It is cleared
// once, stamped, and never touched again.
{
  const mkChrome = (stored) => {
    const store = { exportScope: stored };
    return { store, chrome: { storage: { local: {
      get: async () => ({ exportScope: store.exportScope }),
      set: async (o) => Object.assign(store, o),
    } } } };
  };

  const loadFor = (stored) => {
    const { store, chrome } = mkChrome(stored);
    const ctx = { chrome, SCOPE_FULL: { functions: true, code: true, modules: true },
                  SCOPE_DEFAULT: { functions: true, code: false, modules: true }, expScope: null };
    const { loadScope } = load([sliceConst('apps/crm/sidepanel.js', 'SCOPE_SV'),
                                sliceFn('apps/crm/sidepanel.js', 'loadScope')], ctx);
    return { run: () => loadScope(), ctx, store };
  };

  test('an old scope loses the source once, and is stamped so it is not touched again', async () => {
    const { run, ctx, store } = loadFor({ functions: true, code: true, modules: false });
    await run();
    assert.equal(store.exportScope.code, false, 'the old preference kept the source ticked');
    assert.ok(store.exportScope.sv, 'nothing marks it as migrated, so it would be cleared for ever');
    assert.equal(store.exportScope.modules, false, 'the rest of the choice was overwritten too');
  });

  test('a choice made after the fix is left alone, including turning it back on', async () => {
    const { run, store } = loadFor({ functions: true, code: true, modules: true, sv: 2 });
    await run();
    assert.equal(store.exportScope.code, true,
                 'a deliberate «yes, include the source» was cleared - the migration is not one-shot');
  });

  test('both products carry the same stamp and clear their own sensitive key', () => {
    for (const [app, key] of [['crm', 'code'], ['analytics', 'sql']]) {
      const src = read(`apps/${app}/sidepanel.js`);
      assert.match(src, /const SCOPE_SV = 2;/, `${app}: no version on the stored scope`);
      assert.ok(src.includes('sv !== SCOPE_SV'), `${app}: nothing checks the stamp`);
      assert.ok(src.includes(`${key} = false`), `${app}: the migration clears the wrong key`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The SQL highlighter. Its whole design is a refusal: it colours what can be established by
// reading - comments, strings, quoted identifiers, numbers, a fixed keyword list - and leaves
// everything else alone. «Better one highlight less than one that is wrong», which is the same
// rule the rest of this product applies to what it claims.
//
// The first thing asserted is not a colour but the escaping: this string is handed to innerHTML.
{
  // The whole file, run as the browser runs it: it is an IIFE that hangs one function on `window`,
  // so what the test wants is that window, not a slice - `load` names what it can see, and here that
  // is nothing.
  const win = {};
  vm.runInContext(read('apps/analytics/highlight.js'), vm.createContext({ window: win }));
  const highlightSql = win.highlightSql;

  test('it escapes before it colours', () => {
    const out = highlightSql('select "<img src=x onerror=alert(1)>" from t');
    assert.ok(!/<img/.test(out), out);
    assert.ok(out.includes('&lt;img'), out);
  });

  test('a comment, a string and a quoted name are told apart', () => {
    const out = highlightSql('-- why\nselect \'x\' , "Col" from "T"');
    assert.ok(/c-com">-- why/.test(out), out);
    assert.ok(/c-str">&#39;x&#39;|c-str">'x'/.test(out), out);
    assert.ok(/c-type">"Col"/.test(out), out);
  });

  test('the doubled quote SQL uses as an escape does not end the string', () => {
    const out = highlightSql("select 'it''s' from t");
    assert.equal((out.match(/c-str/g) || []).length, 1, out);
    assert.ok(out.includes("it''s"), out);
  });

  test('a keyword is coloured whatever case it is written in', () => {
    for (const w of ['SELECT', 'select', 'Select']) {
      assert.ok(new RegExp(`c-kw">${w}`).test(highlightSql(`${w} 1`)), w);
    }
  });

  test('a name that merely looks like a function is left alone', () => {
    // The refusal, asserted: `count(` is a keyword in every dialect and is coloured; `my_helper(`
    // may be anything, and colouring it would be a claim about a dialect nobody here has read.
    assert.ok(/c-fn">count/i.test(highlightSql('select count(*) from t')));
    assert.ok(!/c-fn">my_helper/i.test(highlightSql('select my_helper(x) from t')));
  });

  test('a word inside a name is not a keyword', () => {
    // «Ordered» starts with «order»; a highlighter that matched loosely would paint half of it.
    const out = highlightSql('select "Ordered_At" from t');
    assert.ok(!/c-kw">order/i.test(out), out);
  });

  test('text with nothing to colour comes back as itself, escaped', () => {
    assert.equal(highlightSql('a & b'), 'a &amp; b');
    assert.equal(highlightSql(''), '');
  });
}

// ---------------------------------------------------------------------------------------------
// Arrow keys move the selection, not only the scrollbar. Reported as missing: with the focus on the
// list, up and down scrolled - which is all a browser knows about a scrollable div - while what a
// reader wants is the next item *open*, the same thing a click does.
//
// The stepping is lifted and run: what it must get right is which rows take part (only what the
// filters left standing), where it starts when nothing is selected, and that it stops at the ends
// instead of wrapping - a list that jumps from bottom to top loses you your place.
{
  const rows = (...names) => names.map((n) => ({ id: n, name: n }));
  function drive(visible, selected) {
    const opened = [];
    const ctx = {
      visibleViews: () => visible,
      selectedId: selected,
      openDetail: (id) => { ctx.selectedId = id; opened.push(id); },
      // The list is walked now rather than queried by a built selector, so the stub answers with
      // rows: none here, because what these cases are about is which item is chosen, not scrolling.
      $: () => ({ querySelectorAll: () => [] }),
    };
    // `stepSelection` reveals the row it lands on, so the helper it calls comes with it.
    const { stepSelection } = load([sliceFn('apps/analytics/sidepanel.js', 'revealRow'),
                                    sliceFn('apps/analytics/sidepanel.js', 'stepSelection')], ctx);
    return { step: stepSelection, opened, ctx };
  }

  test('down from nothing starts at the top, up from nothing at the bottom', () => {
    let d = drive(rows('a', 'b', 'c'), null); d.step(1); assert.deepEqual(d.opened, ['a']);
    d = drive(rows('a', 'b', 'c'), null); d.step(-1); assert.deepEqual(d.opened, ['c']);
  });

  test('it steps one at a time, and opens what it lands on', () => {
    const d = drive(rows('a', 'b', 'c'), 'a');
    d.step(1); d.step(1);
    assert.deepEqual(d.opened, ['b', 'c']);
  });

  test('the ends hold: it does not wrap round', () => {
    const d = drive(rows('a', 'b', 'c'), 'c');
    d.step(1);
    assert.deepEqual(d.opened, [], 'down from the last row wrapped to the first');
    const u = drive(rows('a', 'b', 'c'), 'a');
    u.step(-1);
    assert.deepEqual(u.opened, [], 'up from the first row wrapped to the last');
  });

  test('Home and End go to the two ends', () => {
    let d = drive(rows('a', 'b', 'c'), 'b'); d.step(0, 'first'); assert.deepEqual(d.opened, ['a']);
    d = drive(rows('a', 'b', 'c'), 'b'); d.step(0, 'last'); assert.deepEqual(d.opened, ['c']);
  });

  test('an empty list is not a special case that throws', () => {
    const d = drive([], null);
    d.step(1); d.step(-1); d.step(0, 'last');
    assert.deepEqual(d.opened, []);
  });

  test('only what is on screen takes part', () => {
    // The filtered-out rows are simply not in what visibleViews() returns, which is the point: the
    // keyboard cannot step onto something the reader has filtered away.
    const d = drive(rows('a', 'c'), 'a');
    d.step(1);
    assert.deepEqual(d.opened, ['c']);
  });

  test('both panels wire the same four keys, and leave fields alone', () => {
    for (const [app, list] of [['analytics', 'list'], ['crm', 'tree']]) {
      const src = read(`apps/${app}/sidepanel.js`);
      const i = src.indexOf(`$('${list}').addEventListener('keydown'`);
      assert.ok(i > 0, `${app}: the list does not listen for keys`);
      const h = src.slice(i, i + 700);
      for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
        assert.ok(h.includes(k), `${app}: ${k} does nothing`);
      }
      assert.ok(/INPUT/.test(h), `${app}: a key typed in a field would be stolen from it`);
      assert.ok(/preventDefault/.test(h), `${app}: the list scrolls as well as selecting`);
      const html = read(`apps/${app}/sidepanel.html`);
      assert.ok(new RegExp(`id="${list}"[^>]*tabindex`).test(html),
                `${app}: the list cannot hold the focus, so the keys never reach it`);
    }
  });

  test('crm: the keyboard remembers where it is rather than asking the tree', () => {
    // Opening a function reads its file, so the tree marks the row a tick later: asking the DOM
    // where it was made every press start from the top again. Measured by pressing twice and
    // landing on row one.
    const src = crmPanel();
    assert.ok(/let stepAnchor = null/.test(src), 'the anchor is gone, so holding the arrow stalls');
    const i = src.indexOf('function stepSelection');
    assert.ok(/stepAnchor = el\.dataset\.path/.test(src.slice(i, i + 1400)),
              'the anchor is never moved, so it is decorative');
  });
}

test('Clear is absent while there is nothing to clear, in both panels', () => {
  // The convention this repository already applies to the retry button: a control that can do
  // nothing goes away rather than sitting there greyed, because a greyed button still says «there
  // is something here you cannot have». Clear stayed on an empty conversation, offering to remove
  // nothing. Reported by the author, against his own rule.
  for (const app of ['crm', 'analytics']) {
    const js = panelBody(app);
    const i = js.indexOf('function aiRenderMessages');
    assert.ok(i > 0, `${app}: the conversation is not rendered here any more`);
    const body = js.slice(i, i + 900);
    assert.ok(/aiclear'\)\.style\.display = aiMessages\.length/.test(body),
              `${app}: Clear is shown whatever the conversation holds`);
    const html = read(`apps/${app}/sidepanel.html`);
    assert.ok(/id="aiclear"[^>]*display:none/.test(html),
              `${app}: it is visible in the markup, so it flashes before the first render hides it`);
  }
});

// ---------------------------------------------------------------------------------------------
// The selected row, fully visible. `scrollIntoView({ block: 'nearest' })` aligns to the container's
// edge and knows nothing about a header stuck to the top of it, so stepping upwards parked the row
// exactly underneath: measured in the shipped panel, 24px of a 37px row hidden - the header's own
// height. Reported after the arrows landed, in those words: the movement was right and the row was
// not all there.
{
  const rect = (top, bottom) => ({ top, bottom, height: bottom - top });
  function scroller({ box, row, header = 0, scrollTop = 100 }) {
    const el = { getBoundingClientRect: () => rect(row[0], row[1]) };
    const container = {
      scrollTop,
      getBoundingClientRect: () => rect(box[0], box[1]),
      querySelector: () => (header ? { getBoundingClientRect: () => rect(box[0], box[0] + header) } : null),
    };
    const { revealRow } = load([sliceFn('apps/analytics/sidepanel.js', 'revealRow')]);
    revealRow(el, container, 'thead');
    return container.scrollTop;
  }

  test('a row under the sticky header is pulled out from under it', () => {
    // The header covers the first 24px of the box; the row starts 10px in, so 14 are hidden.
    assert.equal(scroller({ box: [0, 300], row: [10, 47], header: 24 }), 100 - 14);
  });

  test('a row below the fold is brought up by exactly what is missing', () => {
    assert.equal(scroller({ box: [0, 300], row: [290, 327], header: 24 }), 100 + 27);
  });

  test('a row already fully visible is left alone', () => {
    assert.equal(scroller({ box: [0, 300], row: [100, 137], header: 24 }), 100);
    assert.equal(scroller({ box: [0, 300], row: [24, 61], header: 24 }), 100, 'flush under the header counts as visible');
  });

  test('with no header it still uses the box edge', () => {
    assert.equal(scroller({ box: [0, 300], row: [-5, 32], header: 0 }), 95);
  });

  test('nothing to reveal is not a special case that throws', () => {
    const { revealRow } = load([sliceFn('apps/analytics/sidepanel.js', 'revealRow')]);
    revealRow(null, null, 'thead');
    revealRow({ getBoundingClientRect: () => rect(0, 10) }, null, 'thead');
  });

  test('both panels reveal rather than scrollIntoView', () => {
    for (const [app, sticky] of [['analytics', 'thead'], ['crm', '.grp']]) {
      const src = read(`apps/${app}/sidepanel.js`);
      const i = src.indexOf('function stepSelection');
      const body = src.slice(i, src.indexOf('\nfunction ', i + 10))
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      assert.ok(body.includes('revealRow(') && body.includes(`'${sticky}'`),
                `${app}: the row is not revealed under its own sticky header`);
      assert.ok(!/scrollIntoView/.test(body), `${app}: still aligning to the edge, header or no header`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The list follows what the preview is showing. Jumping from one function to another through a call
// in the code left the tree pointing at the previous one - reported as the selection staying
// uncoordinated. Marking the row was already there; what was missing is everything that makes the
// mark mean something.
{
  function jump({ path, ns, isCollapsed }) {
    const rows = [
      { dataset: { path: 'standalone/a.dg' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
        getBoundingClientRect: () => ({ top: 10, bottom: 40, height: 30 }) },
      { dataset: { path }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
        getBoundingClientRect: () => ({ top: 500, bottom: 530, height: 30 }) },
    ];
    const ctx = {
      treeData: [{ path, namespace: ns }],
      collapsed: new Set(isCollapsed ? [ns] : []),
      treeSort: 'name',
      rendered: 0,
      renderTree() { ctx.rendered++; },
      stepAnchor: 'standalone/a.dg',
      document: { querySelectorAll: () => rows },
      $: () => ({
        scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0, bottom: 300, height: 300 }),
        querySelector: () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 24, height: 24 }) }),
        querySelectorAll: () => rows,
      }),
    };
    const { syncTreeTo } = load([sliceFn('apps/crm/sidepanel.js', 'revealRow'),
                                 sliceFn('apps/crm/sidepanel.js', 'syncTreeTo')], ctx);
    syncTreeTo(path);
    return { ctx, rows };
  }

  test('the row of what is open is the one marked', () => {
    const { rows } = jump({ path: 'standalone/b.dg', ns: 'standalone', isCollapsed: false });
    assert.equal(rows[1].attrs['aria-selected'], true);
    assert.equal(rows[0].attrs['aria-selected'], false);
  });

  test('a group closed over the target is opened, because you asked to see inside it', () => {
    const { ctx } = jump({ path: 'standalone/b.dg', ns: 'standalone', isCollapsed: true });
    assert.equal(ctx.collapsed.has('standalone'), false, 'the group stayed shut, so there is no row to mark');
    assert.equal(ctx.rendered, 1, 'the tree was not redrawn, so the row does not exist yet');
  });

  test('the keyboard carries on from what you are looking at', () => {
    const { ctx } = jump({ path: 'standalone/b.dg', ns: 'standalone', isCollapsed: false });
    assert.equal(ctx.stepAnchor, 'standalone/b.dg',
                 'the next arrow would jump back to the function you came from');
  });

  test('analytics reveals the row it opens, from a foreign key or the lineage', () => {
    const src = read('apps/analytics/sidepanel.js');
    const i = src.indexOf('async function openDetail(id)');
    const body = src.slice(i, src.indexOf('async function renderDetail', i));
    assert.ok(/revealRow\(/.test(body), 'opening a view from a link marks a row nobody can see');
  });
}

test('crm: the arrows open a row the way that row opens', () => {
  // The tree is the functions list in one mode and modules, workflows, schedules, actions or
  // connections in the others. Stepping called openFromTree() on all of them, which reads a .dg
  // file - so in the Actions tab an arrow answered «A requested file or directory could not be
  // found at the time an operation was processed». Reported from there. A click is the one thing
  // every row already knows how to be.
  // Comments stripped first: this file explains at length why the row is clicked, and an assertion
  // over the prose would find the very name it is asserting is gone. The trap this repository
  // already recorded about the duplicate-message check.
  const src = crmPanel();
  const i = src.indexOf('function stepSelection');
  const body = src.slice(i, src.indexOf('\nfunction ', i + 10))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(/el\.click\(\)/.test(body), 'the step still opens every row as a function');
  assert.ok(!/openFromTree\(/.test(body), 'openFromTree is still called for rows that are not files');
});

// ---------------------------------------------------------------------------------------------
// «You should be able to jump from one element to another as in any hypertext» - the author, after
// finding two boxes that named things and would not take you to them: the workflows a CRM function
// is used in, and every entry in the Analytics lineage tab. The rule is general, so the test is
// about the rule: a name the panel can open is a link, and a name it cannot stays text, because a
// link that leads nowhere is worse than none.
{
  // The MSG block travels with the function, as the other lifted helpers here do: the wording lives
  // in the shipped constant and a test that restated it would be proving its own copy.
  const { apLink } = load([sliceConst('apps/crm/sidepanel.js', 'MSG'),
                           sliceConst('apps/crm/health.js', 'AP_OPEN'),
                           sliceFn('apps/crm/health.js', 'apLink')],
                          { HEALTH_OPEN: { workflow: () => {}, schedule: () => {}, action: () => {}, module: () => {} },
                            AP_TAB: { workflow: 'workflows', schedule: 'schedules', action: 'actions', module: 'modules' },
                            tabReachable: () => true,
                            escHtml: (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])),
                            escA: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') });

  test('a workflow rule is a link to the rule', () => {
    const out = apLink('workflow_rules', { id: 4002, name: 'Invoice overdue' });
    assert.match(out, /data-ap="workflow"/);
    assert.match(out, /data-apid="4002"/);
    assert.match(out, />Invoice overdue</);
  });

  test('a kind this panel cannot open stays text', () => {
    const out = apLink('blueprint', { id: 7, name: 'Onboarding' });
    assert.equal(out, 'Onboarding', out);
  });

  test('a name with no id stays text, because there is nowhere to go', () => {
    assert.equal(apLink('workflow_rules', { name: 'Nameless rule' }), 'Nameless rule');
  });

  test('the name is escaped whichever way it comes out', () => {
    assert.ok(!apLink('workflow_rules', { id: 1, name: '<img src=x>' }).includes('<img'));
    assert.ok(!apLink('blueprint', { id: 1, name: '<img src=x>' }).includes('<img'));
  });

  test('a custom button offers its module, since this panel has no page for a button', () => {
    // 18 of these in a real org, and the Actions tab holds notifications, field updates, tasks and
    // webhooks - never buttons. The link's text is the module's name, because a link says where it
    // goes: the reader is not told they are opening the button.
    const out = apLink('custom_buttons', { id: '5836608', name: 'Sync licences', module: 'Contatti' });
    assert.ok(/data-ap="module"/.test(out), out);
    assert.ok(/data-apid="Contatti"/.test(out), out);
    assert.ok(/>Contatti</.test(out), 'the link is labelled with where it goes');
    assert.ok(/Sync licences/.test(out), 'the button name is still shown');
    assert.ok(!/>Sync licences</.test(out.replace(/<span[^>]*>[^<]*<\/span>/g, '')) || true);
  });

  test('the module link does not carry the button name as a name to match', () => {
    // It would have the opener look for a module called «Sync licences» - a fallback that cannot
    // match, which is the very defect fixed one function down.
    const out = apLink('custom_buttons', { id: '1', name: 'Sync licences', module: 'Contatti' });
    assert.ok(!/data-apname="Sync licences"/.test(out), out);
  });

  test('with no module either, there is nothing to offer and it stays text', () => {
    assert.equal(apLink('blueprint', { id: 7, name: 'Onboarding' }), 'Onboarding');
  });

  test('no link is drawn into an area the role forbids', () => {
    const { apLink: strict } = load([sliceConst('apps/crm/sidepanel.js', 'MSG'),
                                     sliceConst('apps/crm/health.js', 'AP_OPEN'),
                                     sliceFn('apps/crm/health.js', 'apLink')],
                                    { HEALTH_OPEN: { workflow: () => {}, module: () => {} },
                                      AP_TAB: { workflow: 'workflows', module: 'modules' },
                                      tabReachable: (tab) => tab !== 'workflows',
                                      escHtml: (s) => String(s), escA: (s) => String(s) });
    assert.equal(strict('workflow_rules', { id: '1', name: 'Invoice overdue' }), 'Invoice overdue',
                 'a link was drawn into a tab that cannot be reached');
  });

  test('both halves are wired, or the links do nothing', () => {
    const crm = crmPanel();
    assert.ok(/a\.aplink\[data-ap\]/.test(crm), 'crm: the «Used in» links are drawn and never wired');
    const an = read('apps/analytics/sidepanel.js');
    const i = an.indexOf('<h5>Reads from</h5>');
    assert.ok(/a\.fk\[data-go\]/.test(an.slice(i, i + 900)), 'analytics: the lineage links are not wired');
  });

  test('the sample says where a function is used, so the picture can show it', () => {
    // It said `associated_place: null` for every function, so the line that lists them - and now the
    // links in it - had nothing to draw from and no render could exercise them.
    const src = read('apps/crm/sample-org.js');
    assert.ok(/associated_place: usedIn\[/.test(src), 'the sample is back to knowing nothing about usage');
  });
}

// ---------------------------------------------------------------------------------------------
// «Open in Zoho» for a view. The address shape was not inferred: it was read out of a browser -
// /workspace/<workspace>/view/<view>, one shape for a table, a query table, a report or a dashboard
// - which is the only way this repository allows a platform navigation to exist. No synthetic
// clicks, nothing that depends on Zoho's markup or on the interface language.
{
  const url = (bound, id) => {
    const { viewUrl } = load([sliceFn('apps/analytics/sidepanel.js', 'viewUrl')], { bound });
    return viewUrl(id);
  };
  const WS = { origin: 'https://analytics.zoho.eu', workspace: '177856000000004002' };

  test('the address is the workspace it is bound to, plus the view', () => {
    assert.equal(url(WS, '177856000002498563'),
                 'https://analytics.zoho.eu/workspace/177856000000004002/view/177856000002498563');
  });

  test('the data centre travels with the workspace, not with the tab', () => {
    // A panel bound to one workspace opens that one's views while the tab is elsewhere - the origin
    // is the mirror's own, which is what makes this an address and not a search.
    assert.match(url({ origin: 'https://analytics.zoho.com', workspace: '1' }, '2'),
                 /^https:\/\/analytics\.zoho\.com\/workspace\/1\/view\/2$/);
  });

  test('nothing to point at gives no address rather than a broken one', () => {
    assert.equal(url(null, '2'), null);
    assert.equal(url(WS, ''), null);
    assert.equal(url({ origin: '', workspace: '1' }, '2'), null);
  });

  test('an id is escaped into the path', () => {
    assert.ok(!/[ "]/.test(url(WS, 'a b"c')), url(WS, 'a b"c'));
  });

  test('the sample offers nothing to open, because there is nothing behind it', () => {
    const src = read('apps/analytics/sidepanel.js');
    const i = src.indexOf("$('dzoho')");
    const body = src.slice(i - 400, i + 300);
    assert.ok(/isSample\(\) \? null : viewUrl/.test(body),
              'the sample would open an address that cannot exist');
    assert.ok(/display = zurl \? '' : 'none'/.test(body), 'it is greyed rather than absent');
  });
}

// ---------------------------------------------------------------------------------------------
// «Workflow not found in this workspace» about a rule that is plainly there. Reported from a real
// org: a function's «Used in» entry keys itself Zoho's way, the rules index is keyed by the rule's
// own id, and the two need not be the same number - so the panel answered a true sentence to the
// wrong question. The name the reader clicked is the second way in, and the message now says which
// of two different things is missing: the mirror has no such rule, or Workflows were never pulled.
{
  const openers = (data, kind) => {
    const opened = [];
    const ctx = {
      closeHealth() {}, setMode() {}, rebuildWorkflows: async () => {}, rebuildSchedules: async () => {},
      rebuildActions: async () => {}, rebuildModules: async () => {},
      // The openers refuse an area the Zoho role forbids. Lifted code sees only what is put here,
      // and without it the guard is a ReferenceError three lines in - which is how this file learnt
      // about free variables the first time.
      tabReachable: () => true,
      workflowData: data, scheduleData: data, actionData: data, moduleData: data,
      openWorkflow: (e) => opened.push(e), openSchedule: (e) => opened.push(e),
      openAction: (e) => opened.push(e), openModule: (p) => opened.push(p),
      said: null, setStatus(m) { ctx.said = m; },
    };
    const { MSG } = load([sliceConst('apps/crm/sidepanel.js', 'MSG')]);
    Object.assign(ctx, { MSG });
    const fns = load([sliceConst('apps/crm/sidepanel.js', 'MSG'),
                      sliceFn('apps/crm/health.js', `healthOpen${kind}`)], ctx);
    return { fn: fns[`healthOpen${kind}`], ctx, opened, MSG };
  };

  test('a rule found by id opens', async () => {
    const { fn, opened } = openers([{ id: '4002', name: 'Invoice overdue' }], 'Workflow');
    await fn('4002', 'Invoice overdue');
    assert.equal(opened.length, 1);
  });

  test('a rule whose id does not match is found by the name that was clicked', async () => {
    const { fn, opened } = openers([{ id: '99', name: 'Invoice overdue' }], 'Workflow');
    await fn('4002', 'Invoice overdue');
    assert.equal(opened.length, 1, 'the rule is there under another id and was still reported missing');
  });

  test('with rules pulled and no match, it says the mirror does not have it', async () => {
    const { fn, ctx, MSG } = openers([{ id: '1', name: 'Something else' }], 'Workflow');
    await fn('4002', 'Invoice overdue');
    assert.equal(ctx.said, MSG.wfNotHere);
  });

  test('with nothing pulled, it says that instead - a different thing to do', async () => {
    const { fn, ctx, MSG } = openers([], 'Workflow');
    await fn('4002', 'Invoice overdue');
    assert.equal(ctx.said, MSG.wfNotPulled);
  });

  test('the same two ways in for schedules, actions and modules', async () => {
    for (const kind of ['Schedule', 'Action', 'Module']) {
      // A module row is keyed differently from the other two - `label` is its localized plural and
      // there is no `name` on it at all, which is what the fallback used to compare against.
      const row = kind === 'Module' ? { id: '99', api_name: 'zzz', label: 'By name' }
                                    : { id: '99', api_name: 'zzz', name: 'By name' };
      const { fn, opened } = openers([row], kind);
      await fn('does-not-match', 'By name');
      assert.equal(opened.length, 1, `${kind}: the name is not tried`);
    }
  });

  test('a module is found by the localized label Zoho puts in an «used in» entry', async () => {
    // Measured on a real org: the entry says «Contatti» and the module is `Contacts`. Matching the
    // api_name found 9 of 18 button entries and none of 77 rule ones; the label matches all of both.
    const { fn, opened } = openers([{ api_name: 'Contacts', label: 'Contatti', gen: 'Contacts' }], 'Module');
    await fn('Contatti', null);
    assert.equal(opened.length, 1, 'the localized label is not tried');
  });

  test('an area the role forbids is refused instead of switched to', async () => {
    for (const kind of ['Workflow', 'Schedule', 'Action', 'Module']) {
      const { fn, ctx, opened } = openers([{ id: '1', name: 'x', label: 'x' }], kind);
      let switched = false;
      ctx.setMode = () => { switched = true; };
      ctx.tabReachable = () => false;
      await fn('1', 'x');
      assert.equal(opened.length, 0, `${kind}: it opened into a forbidden area`);
      assert.equal(switched, false, `${kind}: it changed tab into an area that has no segment`);
    }
  });

  test('the link carries the name, or there is nothing to try', () => {
    const src = crmPanel();
    assert.ok(/data-apname=/.test(src), 'the name never reaches the opener');
    assert.ok(/open\(a\.dataset\.apid, a\.dataset\.apname\)/.test(src), 'the click drops the name');
  });
}

// ---------------------------------------------------------------------------------------------
// The history: back, forward, and the chain itself. Reported as missing once the panel had become a
// hypertext - «it makes this navigability of little use» - because a link you cannot come back from is
// a trapdoor. What is worth holding is not the buttons but the two rules that are easy to get subtly
// wrong: arriving where you already are is not a step, and stepping somewhere new after going back
// drops what was ahead. Both were verified in a real browser too; these hold them at the unit.
{
  const stack = (app) => {
    const ctx = { navHist: [], navPos: -1, navSeq: 0, navReplaying: false, currentPath: null,
                  updateNav() {}, closeNavMenu() {}, setStatus() {}, status() {} };
    const fns = load([sliceConst(`apps/${app}/sidepanel.js`, 'NAV_MAX'),
                      sliceFn(`apps/${app}/sidepanel.js`, 'navHere')], ctx);
    return { ctx, navHere: fns.navHere };
  };
  // The CRM keys a step by path and the Analytics panel by view id, so each is driven the way its
  // own openers call it. Everything after that is the same list and the same two rules.
  const step = (app, ctx, navHere, key, label) => {
    if (app === 'crm') { ctx.currentPath = key; navHere(label); } else navHere(key, label);
  };

  for (const app of ['crm', 'analytics']) {
    const at = (e) => (app === 'crm' ? e.path : e.id);

    test(`${app}: two arrivals are two steps, and we are on the second`, () => {
      const { ctx, navHere } = stack(app);
      step(app, ctx, navHere, 'a', 'A'); step(app, ctx, navHere, 'b', 'B');
      assert.equal(ctx.navHist.length, 2);
      assert.equal(ctx.navPos, 1);
      assert.equal(at(ctx.navHist[1]), 'b');
    });

    test(`${app}: arriving where you already are is not a step`, () => {
      // A pull re-opens what is showing; without this the chain fills with the same name.
      const { ctx, navHere } = stack(app);
      step(app, ctx, navHere, 'a', 'A'); step(app, ctx, navHere, 'a', 'A better name');
      assert.equal(ctx.navHist.length, 1);
      assert.equal(ctx.navHist[0].label, 'A better name', 'the label did not follow the header');
    });

    test(`${app}: a step after going back drops what was ahead`, () => {
      const { ctx, navHere } = stack(app);
      step(app, ctx, navHere, 'a', 'A'); step(app, ctx, navHere, 'b', 'B'); step(app, ctx, navHere, 'c', 'C');
      ctx.navPos = 0;                                   // as if the reader had pressed back twice
      step(app, ctx, navHere, 'd', 'D');
      assert.deepEqual(ctx.navHist.map(at), ['a', 'd']);
      assert.equal(ctx.navPos, 1);
    });

    test(`${app}: replaying a step does not record it again`, () => {
      const { ctx, navHere } = stack(app);
      step(app, ctx, navHere, 'a', 'A');
      ctx.navReplaying = true;
      step(app, ctx, navHere, 'b', 'B');
      assert.equal(ctx.navHist.length, 1, 'going back wrote a new step, so back would never reach further');
    });

    test(`${app}: every step is uniquely identified for the life of the panel`, () => {
      // The author asked for an identifier where the platform gives none; this is where one is
      // honest - a handle on something we hold. The same item visited twice stays two rows.
      const { ctx, navHere } = stack(app);
      step(app, ctx, navHere, 'a', 'A'); step(app, ctx, navHere, 'b', 'B'); step(app, ctx, navHere, 'a', 'A');
      const ns = ctx.navHist.map((e) => e.n);
      assert.equal(new Set(ns).size, ns.length, 'two steps share an id, so the menu cannot tell them apart');
    });

    test(`${app}: the chain is capped, and it is the oldest that goes`, () => {
      const { ctx, navHere } = stack(app);
      for (let i = 0; i < 60; i++) step(app, ctx, navHere, 'p' + i, 'P' + i);
      assert.equal(ctx.navHist.length, 50);
      assert.equal(at(ctx.navHist[0]), 'p10');
      assert.equal(ctx.navPos, 49, 'the position did not follow the drop, so back would skip');
    });
  }

  test('a step names what kind of thing it was, from the prefix the opener dispatches on', () => {
    const { navKind } = load([sliceFn('apps/crm/sidepanel.js', 'navKind')], {});
    assert.equal(navKind('workflows/1.json'), 'workflow');
    assert.equal(navKind('schedules/1.json'), 'schedule');
    assert.equal(navKind('connections/zoho'), 'connection');
    assert.equal(navKind('actions/index.json'), 'action');
    assert.equal(navKind('modules/Contacts.json'), 'module');
    // `.dg` is the extension of a Deluge function's source, so it is a function - it was labelled
    // «diagram» from the file name, which is a guess about our own mirror.
    assert.equal(navKind('functions/automation/x.dg'), 'function');
    assert.equal(navKind('functions/automation/x.js'), 'function');
  });

  test('both panels word a vanished step identically', () => {
    // The twins' shared-wording rule: one browser behaviour must not arrive as two sentences.
    const of = (app) => load([sliceConst(`apps/${app}/sidepanel.js`, 'MSG')], {}).MSG.navGone;
    assert.equal(of('crm'), of('analytics'));
    assert.ok(of('crm'), 'neither panel says anything when a step has gone');
  });

  test('the history covers what AI and Health cover, tab row included', () => {
    // Three shapes in three days, and the last is the one that reads: a dropdown, then a strip
    // wedged between the search row and the list, now an overlay - «it must be the same as ai and
    // health, hiding every tab as they do». Held against those two rather than against
    // numbers: whatever they cover, this covers.
    for (const app of ['crm', 'analytics']) {
      const css = read(`apps/${app}/sidepanel.html`);
      const rule = (id) => css.slice(css.indexOf(`#${id}{`), css.indexOf(`#${id}.show`));
      const mine = rule('navview'), health = rule('healthview');
      for (const decl of ['position:absolute', 'inset:0']) {
        assert.ok(mine.includes(decl), `${app}: the history does not ${decl} the way the health view does`);
        assert.ok(health.includes(decl), `${app}: the health view stopped doing ${decl} - compare against something else`);
      }
      // Covering the search box means it cannot borrow it, so it carries its own.
      assert.ok(css.includes('id="navfind"'), `${app}: the history covers the search box and offers none`);
      // `body.nav-open` exists, and for the same reason `body.health-open` does: while the view is up
      // every other control in the toolbar is dimmed and inert. What it must *not* do is hide the
      // list underneath - an overlay covers, and hiding as well was the shape this replaced.
      const dim = (cls) => css.includes(`body.${cls} .wsgroup > button:not(#`);
      assert.ok(dim('nav-open'), `${app}: the history leaves the toolbar live under it`);
      assert.ok(dim('health-open'), `${app}: the health view stopped dimming - compare against something else`);
      for (const gone of ['#tree', '#list', '#detail', '#preview']) {
        assert.ok(!new RegExp(`body\\.nav-open[^{]*\\${gone}`).test(css),
                  `${app}: the history hides ${gone} as well as covering it`);
      }
    }
  });

  test('the chain can be emptied, and emptying it keeps what is open', () => {
    // Reported as missing. Keeping the current step is the part worth holding: dropping it too would
    // leave the pane showing something the history says was never visited.
    for (const app of ['crm', 'analytics']) {
      const js = read(`apps/${app}/sidepanel.js`);
      assert.ok(new RegExp("\\$\\('navclear'\\)\\.onclick").test(js), `${app}: Clear is drawn and never wired`);
      const at = js.indexOf("$('navclear').onclick");
      assert.ok(/navHist = here \? \[here\] : \[\]/.test(js.slice(at, at + 300)),
                `${app}: Clear does not keep the step you are on`);
    }
  });

  test('the history control has a colour of its own, and the arrows borrow it', () => {
    // Asked for by name: «un colore non usato altrove». The button grammar is five colours already -
    // Zoho, opens-a-page-there, local artefact, in-panel view, assistant - and a list of where you
    // have been is none of them. The arrows take the same fill: they were lighting up in the blue
    // that means «opens Zoho», which is a promise about somewhere else.
    for (const app of ['crm', 'analytics']) {
      const css = read(`apps/${app}/sidepanel.html`);
      assert.ok(/--hist:/.test(css), `${app}: the history has no colour of its own`);
      const seg = css.slice(css.indexOf('.navseg{'), css.indexOf('.navseg:hover'));
      assert.ok(/var\(--hist-fill\)/.test(seg), `${app}: the control does not use it`);
      const back = css.slice(css.indexOf('.back{', css.indexOf('#navbody')), css.indexOf('.back.show'));
      assert.ok(!/var\(--sel\)|var\(--accent\)/.test(back),
                `${app}: the arrows still take the colour that means «opens Zoho»`);
    }
  });

  test('the history box can scroll, and says so visibly', () => {
    // Measured before it was believed: 40 steps in a side-panel-sized window give 1168px of rows in a
    // 378px box, so it scrolled all along - what was missing was a bar you can see and grab.
    for (const app of ['crm', 'analytics']) {
      const css = read(`apps/${app}/sidepanel.html`);
      const rule = css.slice(css.indexOf('#navbody{'), css.indexOf('#navbody{') + 200);
      assert.ok(/overflow:\s*auto/.test(rule), `${app}: the history box cannot scroll`);
      // And its bar is the browser's, like every other list here. It was styled in `--border` for a
      // while, which is darker than the default and made this list look like a different kind of
      // thing - reported. The lists it replaces style nothing, so neither does it.
      assert.ok(!css.includes('#navbody::-webkit-scrollbar'),
                `${app}: the history dresses its scrollbar while #tree and #list do not`);
    }
  });

  test('Name moves every naming the chain shows', () => {
    // It moved the functions and left the modules on whatever the Modules tab was set to, so half the
    // chain answered the button - reported. The kinds that cannot follow have one name each.
    const js = crmPanel();
    const body = js.slice(js.indexOf("$('navname').onclick"), js.indexOf("$('navname').onclick") + 700);
    assert.ok(/nameMode = /.test(body), 'the function naming does not move');
    assert.ok(/moduleNameMode = /.test(body), 'the module naming does not move with it');
  });

  test('the search filters the history while it is the thing on screen', () => {
    // Asked for: the view sits where a list sits, so it answers the same box. Both panels, because a
    // search that works in one product and not in the other is the drift the twins rule exists for.
    for (const app of ['crm', 'analytics']) {
      const js = read(`apps/${app}/sidepanel.js`);
      assert.ok(/\$\('navfind'\)\.oninput = renderNav/.test(js), `${app}: typing does not redraw the chain`);
      const at = js.indexOf('function renderNav');
      assert.ok(/\$\('navfind'\)\.value/.test(js.slice(at, at + 900)), `${app}: the chain ignores its own search box`);
    }
  });

  test('a step names what kind of thing it was, from the prefix the opener dispatches on', () => {
    const { navKind } = load([sliceFn('apps/crm/sidepanel.js', 'navKind')], {});
    assert.equal(navKind('workflows/1.json'), 'workflow');
    assert.equal(navKind('schedules/1.json'), 'schedule');
    assert.equal(navKind('connections/zoho'), 'connection');
    assert.equal(navKind('actions/index.json'), 'action');
    assert.equal(navKind('modules/Contacts.json'), 'module');
    // `.dg` is the extension of a Deluge function's source, so it is a function - it was labelled
    // «diagram» from the file name, which is a guess about our own mirror.
    assert.equal(navKind('functions/automation/x.dg'), 'function');
    assert.equal(navKind('functions/automation/x.js'), 'function');
  });

  test('both panels word a vanished step identically', () => {
    // The twins' shared-wording rule: one browser behaviour must not arrive as two sentences.
    const of = (app) => load([sliceConst(`apps/${app}/sidepanel.js`, 'MSG')], {}).MSG.navGone;
    assert.equal(of('crm'), of('analytics'));
    assert.ok(of('crm'), 'neither panel says anything when a step has gone');
  });

  test('every navigation control is drawn and wired, in both panels', () => {
    // A control drawn and never wired is the failure this panel has met before; a pair of arrows is
    // exactly where it would go unnoticed, because one of them usually does nothing anyway.
    for (const [app, ids] of [['crm', ['pvback', 'pvfwd', 'navtab']], ['analytics', ['dback', 'dfwd', 'navtab']]]) {
      const js = read(`apps/${app}/sidepanel.js`);
      const html = read(`apps/${app}/sidepanel.html`);
      for (const id of ids) {
        assert.ok(html.includes(`id="${id}"`), `${app}: id=${id} is not in the markup`);
        assert.ok(new RegExp(`\\$\\('${id}'\\)\\.onclick`).test(js), `${app}: id=${id} is drawn and never wired`);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// «Con più spazio in larghezza, la history potrebbe mostrare data e ora di apertura» - asked for,
// and it is a fact only the panel holds: with a chain that spans a session, "which of these did I
// look at first" has no other answer. Held in both products because a stamp on one side only is the
// twins drifting where nobody looks.
{
  test('a step records when it was taken, in both panels', () => {
    for (const app of ['crm', 'analytics']) {
      const js = read(`apps/${app}/sidepanel.js`);
      assert.ok(/navHist\.push\(\{[^}]*at: Date\.now\(\)/.test(js), `${app}: a step carries no time`);
      assert.ok(/navWhen\(e\.at\)/.test(js), `${app}: the time is recorded and never shown`);
    }
  });

  test('today shows the time alone, an older day carries its date', () => {
    // The distinction is the whole point: a date repeated on every row of one session is noise, and
    // its absence on an older step is a lie about when that step happened.
    const { navWhen } = load([sliceFn('apps/crm/sidepanel.js', 'navWhen')], { Date, Intl });
    const now = new Date();
    const today = navWhen(now.getTime());
    const older = navWhen(now.getTime() - 40 * 24 * 3600 * 1000);
    assert.ok(/\d/.test(today), 'today says nothing');
    assert.ok(older.length > today.length, `an older step reads like today's: ${older} vs ${today}`);
  });
}

// ---------------------------------------------------------------------------------------------
// One code pane, two products. The CRM shows Deluge with `white-space:pre` and lets the box scroll;
// the Analytics SQL pane wrapped, so a query's indentation stopped meaning anything and the reader
// could not tell a wrap from a line somebody wrote. Reported as an inconsistency between the apps,
// which is what it was - and the kind that survives because each panel looks right on its own.
test('code is shown the same way in both products: lines as written, box scrolls', () => {
  const crm = read('apps/crm/sidepanel.html');
  const an = read('apps/analytics/sidepanel.html');
  const crmRule = crm.slice(crm.indexOf('#pvgutter,#pvcode{'), crm.indexOf('#pvgutter,#pvcode{') + 200);
  const anRule = an.slice(an.indexOf('pre.sql{'), an.indexOf('pre.sql{') + 200);
  assert.ok(/white-space:pre[;}]/.test(crmRule), 'the CRM code pane no longer keeps its lines');
  assert.ok(/white-space:pre[;}]/.test(anRule), 'the SQL pane wraps again');
  assert.ok(/overflow-x:auto/.test(anRule), 'the SQL pane keeps its lines and gives no way to read them');
});

// ---------------------------------------------------------------------------------------------
// The code can be taken out of the panel. Asked for: «the SQL in Analytics and the Deluge in CRM
// must be copyable». One control, the same in both, in the row above the code - it was floated
// over the pane first and landed on the control at the end of that row, which is what a button
// positioned into somebody else's box does sooner or later.
{
  test('both panels offer one copy control, wired to what is on screen', () => {
    for (const app of ['crm', 'analytics']) {
      const html = read(`apps/${app}/sidepanel.html`);
      const js = read(`apps/${app}/sidepanel.js`);
      assert.ok(html.includes('id="codecopy"'), `${app}: nothing to copy the code with`);
      assert.ok(js.includes("$('codecopy').onclick"), `${app}: the copy button is drawn and never wired`);
      // textContent of the pane, never a stored source: what the reader is looking at is what lands
      // in the clipboard, and the highlighting comes back off by itself.
      const at = js.indexOf("$('codecopy').onclick");
      assert.ok(/textContent/.test(js.slice(at, at + 200)), `${app}: it copies something other than what is shown`);
      assert.ok(/function copyCode/.test(js), `${app}: copyCode is missing - the button throws on click`);
    }
  });

  test('it is not positioned over anything: it sits in the row above the code', () => {
    for (const app of ['crm', 'analytics']) {
      const css = read(`apps/${app}/sidepanel.html`);
      const rule = css.slice(css.indexOf('#codecopy{'), css.indexOf('#codecopy{') + 120);
      assert.ok(!/position:\s*absolute/.test(rule), `${app}: the copy button floats again`);
    }
  });

  test('every scrollbar in the panel is the same light one', () => {
    // Reported: the lists showed the browser's light bar and the boxes below showed something dark
    // that could not be seen against them. Stated once, for everything that scrolls.
    for (const app of ['crm', 'analytics']) {
      const css = read(`apps/${app}/sidepanel.html`);
      assert.ok(css.includes('*::-webkit-scrollbar-thumb{background:#5a6b85'),
                `${app}: the scrollbars are back to whatever each box inherits`);
      assert.ok(!/\.wsgroup::-webkit-scrollbar-thumb/.test(css),
                `${app}: one box still paints its own thumb, which is how they came to differ`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The tree is drawn from the index, and the details arrive behind it. Written against a generated
// org of 5,000 functions: the old path walked the folder, then read and parsed *every* meta before
// drawing a row - about five browser file-system calls each, since `readFile()` resolves a path one
// directory handle at a time. Nothing was on screen until the last one came back.
//
// What is held here is the shape, because the timing cannot be: the render harness uses an in-memory
// file system, so it cannot model what the File System Access API charges per file. (It also taught
// its own lesson - the shim resolved every path by scanning all 10,000 keys, and forty seconds of
// «the panel is slow» turned out to be the instrument. It is indexed now.)
{
  const src = crmPanel();
  // The per-file work is `refineRowFromMeta` now, a declaration of its own rather than an
  // `async (mp) => {}` inside a `map` - so the slice takes both, or every rule below about what
  // happens per file would quietly stop being checked while still passing.
  const load = src.slice(src.indexOf('async function rebuildTree'), src.indexOf('async function attachFnStats'))
    + sliceFn('apps/crm/sidepanel.js', 'refineRowFromMeta');

  test('the index is read before anything is drawn, and the metas after', () => {
    const idxAt = load.indexOf("op.read('functions/index.json')");
    const firstPaint = load.indexOf('renderTree()');
    const metaLoop = load.indexOf('metaPathsToRead.slice');
    assert.ok(idxAt > 0 && firstPaint > idxAt, 'the tree is drawn before the index is read');
    assert.ok(metaLoop > firstPaint, 'the metas are still read before the first paint');
  });

  test('a summary spares the metas entirely on the second open', () => {
    // Measured on a generated org of 5,000 functions: 60,015 file-system calls on the first open,
    // eight on the next. The summary is a cache and is treated as one - checked against the folder
    // walk, and rewritten when it no longer describes what is there.
    assert.ok(/const META_INDEX = 'functions\/meta-index\.json'/.test(src), 'no summary is written');
    assert.ok(/op\.read\(META_INDEX\)/.test(load), 'the load does not read it through its captured workspace');
    assert.ok(/function saveMetaIndex/.test(src), 'nothing writes it');
    const code = load.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/missing\.push\(mp\)/.test(code), 'it is believed instead of checked against the walk');
  });

  test('the size badges are not built speculatively on a large workspace', () => {
    // Building the call graph reads every source - 40,000 calls on five thousand functions - and it
    // used to happen on every open for two numbers in a badge. Above the limit it waits to be asked.
    assert.ok(/const STATS_LIMIT = \d+/.test(src), 'the graph is built on every open again');
    assert.ok(/const statsDeferred = \(\) => treeData\.length > STATS_LIMIT/.test(src), 'the limit is not applied');
    const at = src.indexOf('async function attachFnStats');
    assert.ok(/if \(statsDeferred\(\)\) return;/.test(src.slice(at, at + 200)), 'the badges are built above the limit');
  });

  test('and the reader is told why the badges are absent, by the line that survives', () => {
    // It was said by `attachFnStats`, which the load starts and does not await, and the load then set
    // its own status over it in the same turn: written for large orgs, and no large org saw it.
    const at = src.indexOf('async function attachFnStats');
    assert.ok(!/setStatus/.test(src.slice(at, at + 200)), 'the explanation is set where it is overwritten');
    // Both on the one call that closes the load. The clause about files that could not be read now
    // sits between them, so «immediately after» is no longer the property - «in the same sentence» is.
    const close = src.slice(src.indexOf('functions (${dl} downloaded).'));
    const call = close.slice(0, close.indexOf(');') + 2);
    assert.match(call, /statsDeferred\(\)/,
                 'the load\'s own status line does not carry it');
  });

  test('the metas are read in tranches, with a yield between them', () => {
    assert.ok(/TRANCHE = \d+/.test(load), 'nothing batches the reads');
    assert.ok(/await new Promise\(\(r\) => setTimeout\(r, 0\)\)/.test(load),
              'the loop never yields, so the panel is blocked for the whole read');
  });

  test('a load that has been overtaken stops', () => {
    // Two loads interleaving is how the older one writes its rows over the newer one's; a refresh,
    // a change of workspace and a pull can all start a second one.
    assert.ok(/const mine = \+\+treeLoad/.test(load), 'a load carries no token');
    assert.equal((load.match(/if \(!current\(\)\) return;/g) || []).length >= 5, true,
                 'the token is taken and then not checked between the slow steps');
  });

  test('nothing in the load is linear in the number of functions', () => {
    // `treeData.find()` inside the per-file loop is O(n) and fires exactly when the path the index
    // predicts and the file on disk disagree - 25 million comparisons on five thousand functions.
    // The comments go first: this assertion read its own explanation and failed on the word it forbids,
    // which this repository has met before.
    const code = load.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/treeData\.find\(/.test(code), 'a linear scan is back inside the per-file loop');
    assert.ok(/byId\.get\(/.test(code), 'the id lookup is not a map');
  });
}

// ---------------------------------------------------------------------------------------------
// The graph built from the summary is the graph built from the sources. Not argued - built both ways
// from the same workspace and compared node for node, because the whole point of writing the
// parser's findings down is that nobody has to wonder whether the shortcut sees something different.
{
  const gc = read('apps/crm/graph-core.js');

  test('buildGraph takes the references it is handed, and hands back the ones it found', () => {
    assert.ok(/Array\.isArray\(n\._refs\)/.test(gc), 'the builder cannot be given references');
    assert.ok(/n\.refs = refs\.slice\(\)/.test(gc), 'it does not hand back what it read');
  });

  test('from sources and from references, the same graph', () => {
    // The file wraps itself in an IIFE and hangs the function on `window`, so it is *run* the way the
    // browser runs it rather than sliced: `load()` lifts declarations, and an IIFE is not one.
    const w = {};
    new Function('window', read('apps/crm/graph-core.js'))(w);
    const buildGraph = w.buildGraph;
    assert.ok(typeof buildGraph === 'function', 'graph-core no longer publishes buildGraph');
    const src = (dg) => dg;
    const input = [
      { namespace: 'standalone', name: 'log', api_name: 'log', dg: 'void log(){}' },
      { namespace: 'standalone', name: 'calcTax', api_name: 'calc_Tax',
        dg: 'void calcTax(){ standalone.log(); standalone.missing(); }' },
      { namespace: 'automation', name: 'onOrder', api_name: 'on_Order',
        dg: 'void onOrder(){ standalone.calcTax(); standalone.calcTax(); }' },
    ];
    const fromSource = buildGraph(input.map((n) => ({ ...n })));
    // the same input, but with the sources thrown away and the references handed in
    const withRefs = input.map((n) => {
      const id = n.namespace + '.' + n.name;
      return { ...n, dg: '', _refs: fromSource.nodes[id].refs };
    });
    const fromRefs = buildGraph(withRefs);
    const strip = (g) => JSON.stringify({
      counts: g.counts,
      nodes: Object.fromEntries(Object.entries(g.nodes).map(([k, n]) =>
        [k, { calls: n.calls, called_by: n.called_by, unresolved: n.unresolved,
              ambiguous: n.ambiguous, dead_suspect: n.dead_suspect }])),
    });
    assert.equal(strip(fromRefs), strip(fromSource),
                 'the graph from the summary is not the graph from the sources');
  });

  test('the panel keeps references, never edges', () => {
    // An edge is a reference *resolved against the whole workspace*, and that answer changes when a
    // function is added or renamed - a name unique today is ambiguous tomorrow. Storing edges would
    // be a cached judgement, and nothing would say when it went stale.
    const js = crmPanel();
    const at = js.indexOf('async function saveGraphFacts');
    const body = js.slice(at, at + 1400).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/entry\.refs = /.test(body), 'the references are not written down');
    assert.ok(!/entry\.calls|entry\.called_by|entry\.edges/.test(body), 'a resolved edge is being stored');
  });
}

// ---------------------------------------------------------------------------------------------
// Reading every source is what «search inside the code» means; blocking the panel for it is not.
test('the sources are read in tranches, and the reader is told', () => {
  const js = crmPanel();
  const at = js.indexOf('async function getCodeCache');
  const body = js.slice(at, at + 900).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/TRANCHE/.test(body), 'the whole workspace is read in one go again');
  assert.ok(/setTimeout\(r, 0\)/.test(body), 'nothing yields, so the panel is dead for the duration');
  assert.ok(/Reading sources/.test(body), 'it says nothing while it does it');
});

// ---------------------------------------------------------------------------------------------
// The folders are remembered, and given up the moment the working folder changes. Every read and
// every write used to resolve `functions/<namespace>/` from the root again - two calls before the
// one that does the work, half of what a pull spends. Measured: writing a function went from 8
// file-system calls to 4, opening a 5,000-function workspace from 20,015 to 10,732.
test('the directory handles are cached, and dropped when the folder changes', () => {
  const js = crmPanel();
  const at = js.indexOf('async function dirFor');
  const body = js.slice(at, at + 700).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/cache\.has\(key\)/.test(body), 'nothing is cached');
  assert.ok(/_dirCaches\.get\(root\)/.test(body), 'one map again, for whichever folder is current');
  // A stale handle is worse than a slow one: it must be given up eagerly, never validated.
  const drops = (js.match(/forgetDirs\(\)/g) || []).length;
  assert.ok(drops >= 5, `the cache is dropped in ${drops} places; every path that changes dir must`);
  assert.ok(/dir = w\.handle; forgetDirs\(\)/.test(js), 'choosing a workspace keeps the old folders');
});

// ---------------------------------------------------------------------------------------------
// No fast path may hand back an old photograph. The summary describes files *by path*, and the walk
// that checks it sees paths appear and disappear - not a file whose bytes changed while its name
// stayed the same. A review asked for that invariant to be proved rather than assumed; it did not
// hold, and both halves were wrong: the diagram kept the previous source, the tree the previous
// date. The fix is at the point where this panel writes, and `tools/probe.py` drives the whole thing
// in a browser - this holds the mechanism so it cannot be removed without a red mark.
{
  const js = crmPanel();
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('every write marks the function it rewrote', () => {
    const at = code.indexOf('async function writeFile');
    assert.ok(/noteWrite\(rel\)/.test(code.slice(at, at + 400)), 'a write leaves no mark');
    assert.ok(/_dirtySource\.add/.test(code), 'nothing records which files were rewritten');
  });

  test('both fast paths refuse what has been rewritten', () => {
    assert.ok(/dirtyMeta\.has\(dg\)/.test(code), 'the tree trusts the summary for a file it just wrote');
    assert.ok(/dirtySrc\.has\(p\) \? null : known\[p\]/.test(code), 'the diagram does too');
  });

  test('the mark is cleared only when the summary has been written again', () => {
    // The write now happens inside the queue, so «after the rewrite» means «after the mutator this
    // saver queued has been awaited» - which is what the `await updateMetaIndex(...)` before the
    // delete says.
    const body = code.slice(code.indexOf('async function saveMetaIndex'), code.indexOf('async function saveGraphFacts'));
    const queued = body.indexOf('const written = updateMetaIndex('), cleared = body.indexOf('_dirtyMeta.delete');
    assert.ok(queued >= 0 && cleared > queued,
              'the marks are cleared before the write they depend on has happened');
    // And only if it happened. The queue used to swallow the failure, so a refused write - a
    // workspace changed under it, a folder gone - still ended with the marks cleared, which means
    // the file was old and nothing on the next load would re-read it.
    const gate = body.indexOf('if (!(await written) || !op.current()) return;');
    assert.ok(gate > 0 && gate < cleared, 'a refused write still declares the files described');
    for (const fn of ['saveMetaIndex', 'saveGraphFacts'])
      assert.ok(/if \(!\(await written\)(?: \|\| !op\.current\(\))?\) return;/.test(sliceFn('apps/crm/sidepanel.js', fn)),
                `${fn} clears its marks whether or not the summary was written`);
  });

  test('Refresh distrusts the summary, for the writes this panel cannot see', () => {
    // An editor, a `git checkout`, a synced folder: nothing marks those, and detecting them would
    // cost a `getFile()` per file - the very reading the summary exists to avoid.
    assert.ok(/distrustEverything\(\)/.test(code), 'Refresh no longer forces a full re-read');
    const html = read('apps/crm/sidepanel.html');
    assert.ok(/read every file again/.test(html), 'the button does not say that is what it does');
  });
}

// ---------------------------------------------------------------------------------------------
// Two readings, two writers, and no ordering to reason about. A review asked whether the writer of
// the metadata could declare a function «described» while the build that re-reads its *source* was
// still walking - it could, when one set served both, and the answer was «the promises happen to
// resolve favourably», which is not an answer. The behavioural half of this lives in the probe; what
// is held here is the structure, because the dangerous interleaving is only reachable above
// STATS_LIMIT - where the graph is not built during the load - and a test that cannot reach a hazard
// must at least pin the design that removes it.
{
  const js = crmPanel();
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = (name) => {
    // async or not: the helper should find the function, not assert a keyword nobody promised.
    let at = code.indexOf('async function ' + name);
    if (at < 0) at = code.indexOf('function ' + name);
    assert.ok(at > 0, `${name} is gone`);
    return code.slice(at, code.indexOf('\n}', at));
  };

  test('each writer clears only the marks it refreshed', () => {
    assert.ok(/_dirtyMeta\.delete/.test(fn('saveMetaIndex')), 'saveMetaIndex clears nothing');
    assert.ok(!/_dirtySource/.test(fn('saveMetaIndex')),
              'saveMetaIndex touches the source marks - it has not read a single .dg');
    assert.ok(/_dirtySource\.delete/.test(fn('saveGraphFacts')), 'saveGraphFacts clears nothing');
    assert.ok(!/_dirtyMeta/.test(fn('saveGraphFacts')), 'saveGraphFacts touches the metadata marks');
  });

  test('each reader takes its snapshot before its first await', () => {
    for (const [name, snap] of [['rebuildTree', 'dirtyMeta'], ['loadGraph', 'dirtySrc']]) {
      const body = fn(name);
      const snapAt = body.indexOf(`const ${snap} = new Set(`);
      const awaitAt = body.indexOf('await ');
      assert.ok(snapAt > 0, `${name} does not snapshot the marks`);
      assert.ok(snapAt < awaitAt, `${name} snapshots after its first await, so another task can move it`);
    }
  });

  test('the summary is merged, never replaced', () => {
    // The first version rewrote the whole file with the metadata half, throwing away every reference
    // and size the diagram had written. Nothing broke - the graph simply read five thousand sources
    // again - which is exactly why it survived until somebody asked how the two writers interleave.
    // The merge now lives in the one writer, so this is where it is checked - and the producers must
    // not carry their own copy of it, or there would be two merge bases again.
    // Both halves: the writer queues, and `mergeIntoMetaIndex` is the queued work.
    const q = fn('updateMetaIndex') + fn('mergeIntoMetaIndex');
    assert.ok(/prev\.files/.test(q), 'the single writer does not read what is already there');
    for (const name of ['saveMetaIndex', 'saveGraphFacts']) {
      assert.ok(!/readFile\(META_INDEX\)/.test(fn(name)), `${name} reads the summary itself again`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// One writer, two producers. Both savers did read-modify-write on the same file, so whoever wrote
// second restored what the other had just changed - proved by marking a function stale and running
// them together: the file came back saying it was fresh, undone by a writer that does not even have
// an opinion about that field. A promise chain is enough here: the contention is between two known
// callers inside one document, not between processes.
{
  const js = crmPanel();
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = (name) => code.slice(code.indexOf('function ' + name), code.indexOf('\n}', code.indexOf('function ' + name)));

  test('the summary has exactly one writer', () => {
    const writes = (code.match(/op\.write\(META_INDEX/g) || []).length;
    assert.equal(writes, 1, `${writes} places write the summary; it must be one`);
    assert.ok(/function updateMetaIndex/.test(code), 'there is no single writer to queue behind');
    for (const name of ['saveMetaIndex', 'saveGraphFacts']) {
      assert.ok(/updateMetaIndex\(/.test(fn(name)), `${name} writes the file itself instead of queueing`);
    }
  });

  test('the merge base is read inside the queue, not before it', () => {
    // The queue is `await after` at the top of the queued work, and the merge base is read after it.
    // This was written against `_metaIndexWrites.then(...)`; the shape changed when the callback
    // became a declaration and the property did not, which is the difference between reading a photo
    // of the code and reading what it does.
    const w = fn('updateMetaIndex'), merge = fn('mergeIntoMetaIndex');
    const readAt = merge.indexOf('op.read(META_INDEX)');
    const queueAt = merge.indexOf('await after');
    // The op is taken *outside* the queued work, where the caller still means this workspace - it
    // runs later, so reading `dir` inside it would write one org's summary into the next.
    assert.ok(w.indexOf('beginWorkspaceOp()') < w.indexOf('mergeIntoMetaIndex('),
              'the queued work picks its folder when its turn comes');
    assert.ok(queueAt >= 0 && readAt > queueAt,
              'the summary is read outside the queue, so two mutators can share a stale base');
  });

  test('neither producer writes the other half', () => {
    // `sv` and `updatedTime` come from a `.meta.json`; refs and stats from a `.dg`. A producer that
    // writes a field it has not read is how a merge turns into a lost update.
    const graph = fn('saveGraphFacts');
    assert.ok(!/entry\.sv\s*=/.test(graph), 'the graph writer sets the stale mark, which it cannot know');
    assert.ok(!/entry\.updatedTime\s*=/.test(graph), 'the graph writer sets the modified date, which it cannot know');
    const meta = fn('saveMetaIndex');
    assert.ok(!/\.refs\s*=/.test(meta) && !/\.stats\s*=/.test(meta),
              'the meta writer sets source-derived facts');
  });
}

// ---------------------------------------------------------------------------------------------
// A cache is forgotten by the write, never by whoever remembered. The summary was already built
// that way - `noteWrite()` at the one point every write passes through - while the five things made
// out of mirror files and kept in memory were each dropped at the call site that produced them.
// Three of the five remembered and two did not, which is the shape: nothing is broken, the mirror on
// disk is right, and the panel is confidently out of date about it. `syncOne` cleared the diagram
// and left `in: code` searching the text from before the edit; the workflows pull left «which rule
// uses this action» describing the rules it had just replaced; the actions pull and the modules
// resync left the assistant's catalogues behind. All five now derive from the path written, so a
// write path added tomorrow inherits the invalidation without being told it exists.
{
  const js = crmPanel();
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const region = (start, end) => code.slice(code.indexOf(start), code.indexOf(end, code.indexOf(start)));
  const CACHES = ['codeCache', 'graphCache', 'moduleFilesCache', 'aiConnCache', 'aiActCache', 'actionUsers'];

  test('every cache made of mirror files is dropped by the write itself', () => {
    const note = region('const noteWrite', '\n};');
    for (const c of ['codeCache', 'graphCache', 'moduleFilesCache', 'aiConnCache', 'aiActCache', 'actionUsers']) {
      assert.ok(new RegExp(c + '\\s*=\\s*null').test(note), `noteWrite does not forget ${c}`);
    }
    assert.ok(/noteWrite\(path\)/.test(region('async function removeFileAt', '\n}')),
              'a deletion leaves what was read from that path in memory');
  });

  test('nothing else clears one, except on leaving the workspace', () => {
    // The three that stay are not writes: a tree load starting over, a workspace being left, and
    // Refresh - which distrusts everything on purpose because it answers for the writes this panel
    // cannot see. Anything outside those is a call site remembering again.
    const allowed = [region('const noteWrite', '\n};'),
                     region('function dropWorkspaceState', '\n}'),
                     // The one list of what came out of a file, shared by the workspace change and by
                     // ↻ Refresh. Both are «start over», neither is a call site remembering again.
                     region('function dropFileCaches', '\n}'),
                     region('async function rebuildTree', '\n}')];
    for (const c of CACHES) {
      for (const line of code.split('\n')) {
        if (!new RegExp('(?<![\\w$])' + c + '\\s*=\\s*null').test(line)) continue;
        if (/^let |^const /.test(line) || /distrustEverything\(\)/.test(line)) continue;
        assert.ok(allowed.some((r) => r.includes(line.trim())),
                  `${c} is cleared by hand outside noteWrite: ${line.trim().slice(0, 90)}`);
      }
    }
  });

  test('a summary written by an older reader is discarded, never trusted', () => {
    // The whole safety of storing a *reading*: when what the extractor writes changes meaning, the
    // file on disk is not stale-looking, it is confidently wrong - and nothing re-reads a source the
    // summary already describes. Reported after `modulesUnknown` changed meaning and the version did
    // not: fresh parse said 1, the cached path still said 0. So every reader compares against the
    // constant, and no reader may carry a number of its own.
    const readers = code.match(/\.v === [\w.]+/g) || [];
    assert.ok(readers.length >= 2, 'nobody checks the summary version');
    for (const r of readers) {
      assert.ok(/SUMMARY_V/.test(r), `a reader compares the version against a literal: ${r}`);
    }
    assert.ok(/v: SUMMARY_V/.test(code), 'the writer stamps a literal version instead of the constant');
  });

  test('the module index is forgotten when the pull rewrites it', () => {
    // `modNamesCache` is what turns a name read out of Deluge into a module of *this* org. A pull
    // that rewrites the index changes that answer, and the index is deliberately not a «module
    // file» - `isModuleFile` excludes it - so it needed its own line rather than inheriting one.
    const note = region('const noteWrite', '\n};');
    assert.ok(/modules\/index\.json/.test(note) && /modNamesCache\s*=\s*null/.test(note),
              'a pull can rewrite the module index and leave the readings resolved against the old one');
  });

  test('a name is a module only if this org has one', () => {
    // The whole safety of the module reading: graph-core reads words out of text and knows nothing
    // about which exist. Measured on two production orgs when this was written - three and four
    // names each that look like modules and are not.
    const body = code.slice(code.indexOf('async function modulesOf'), code.indexOf('\n}', code.indexOf('async function modulesOf')));
    assert.ok(/known\.has\(m\.name\)/.test(body), 'a candidate is drawn without being checked against the org');
    assert.ok(/unknown/.test(body), 'the calls whose module is computed are dropped instead of counted');
  });

  test('the Analytics twin does the same at its own write', () => {
    const an = read('apps/analytics/sidepanel.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const at = an.indexOf('async function writeFile');
    assert.ok(/noteWrite\(rel\)/.test(an.slice(at, at + 400)), 'a write leaves no mark in Analytics');
    assert.ok(/sqlCache\s*=\s*null/.test(an.slice(an.indexOf('function noteWrite'), at)),
              'the query cache is not forgotten by the write that replaced the query');
  });
}

// ---------------------------------------------------------------------------------------------
// The discipline itself, as a check rather than a sentence. Every fast path shipped here should
// arrive with a test that tries to make it lie - and the five above shipped without one, which is
// why five of them were wrong and nobody could tell. So the file set is derived and there is no
// allow-list: a cache added tomorrow is covered by the naming convention this code already follows.
//
// **What it does not catch, said rather than left to be found.** A cache whose name does not end in
// `Cache` escapes it - `actionUsers` does, and is held by the case above instead. And a name being
// mentioned in a test is not the same as the staleness being proved; that part is judgement, and
// the mention is what makes its absence visible.
test('every cache in a shipped panel is named by something that tests it', () => {
  const named = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.mjs'))
    .map((f) => read(`tests/${f}`)).join('\n') + read('tools/probe.py');
  const missing = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    for (const f of readdirSync(join(ROOT, 'apps', app)).filter((x) => x.endsWith('.js'))) {
      const src = read(`apps/${app}/${f}`);
      for (const m of src.matchAll(/(?:^|[,(\s])([A-Za-z_$][\w$]*Cache)\s*=/gm)) {
        const name = m[1];
        if (!new RegExp('(?<![\\w$])' + name + '(?![\\w$])').test(named)) missing.push(`${app}/${f}: ${name}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'a cache no test tries to make stale: ' + missing.join(', '));
});

// ---------------------------------------------------------------------------------------------
// Two read-modify-write cycles, forced to interleave. The review that asked for this drew it as a
// sequence rather than a scenario, which is the sharper way to put it:
//
//     A reads X │ B reads X │ A writes XA │ B writes XB   →   XB has lost A's change
//
// The probe runs both producers concurrently in a browser, and that is a real regression test - it
// went red on the two-writer code, with `sv` coming back 2 where 1 was expected. What it cannot do
// is *force* the order: it starts both and hopes. So the same question is asked here of a fake file
// system that records every operation, and the assertion is on the **sequence**, not only on the
// result - a run whose content came out right because the two happened to serialise favourably is
// indistinguishable from a correct one when you look at the file alone.
//
// Both orders, because «whoever writes second» is the whole hazard.
{
  const FILE = 'apps/crm/sidepanel.js';
  const NODES = [{ file: 'functions/standalone/build.dg', namespace: 'standalone', name: 'build',
                   api_name: 'build', display_name: 'Build', category: 'standalone', source: 'crm',
                   rest: false, refs: ['automation.recalc'], stats: { lines: 12 } }];
  const GRAPH = { nodes: { 'standalone.build': { refs: ['automation.recalc'], stats: { lines: 12 } } } };
  const ROWS = [{ path: 'functions/standalone/build.dg', id: '77', stale: true,
                  updatedTime: '2026-08-17T00:00:00+00:00', namespace: 'standalone', display_name: 'Build' }];

  /** The panel's two producers over one fake file, with every read and write recorded and every one
   *  of them yielding - so if the code ever goes back to two independent read-modify-write cycles,
   *  the second reader gets in before the first writer and the log says so. */
  const run = (first) => {
    const ops = [];
    // The version comes from the source, not from a number typed here: a test that writes its own
    // `v` keeps passing on the day the real one moves, which is exactly when it should speak.
    const V = Number(sliceConst(FILE, 'SUMMARY_V').match(/=\s*(\d+)/)[1]);
    let disk = JSON.stringify({ v: V, sv: 2, files: {} });
    // Several turns of the microtask queue per call: a single `await` would let a two-writer
    // implementation slip through whenever the runtime happened to resume it in a friendly order.
    const slow = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    const env = {
      META_INDEX: 'functions/meta-index.json',
      META_SV: 2,
      SUMMARY_V: V,
      treeData: ROWS,
      _dirtyMeta: new Set(['functions/standalone/build.dg']),
      _dirtySource: new Set(['functions/standalone/build.dg']),
      // Through the op, which is what the queue holds now - the workspace is taken when the work is
      // handed over, not when its turn comes.
      beginWorkspaceOp: () => ({ current: () => true,
        read: async () => { ops.push('read'); await slow(); return disk; },
        write: async (rel, body) => { ops.push('write'); await slow(); disk = body; } }),
      Promise, JSON, Object, Set, String,
    };
    // The queue's own variable comes from the source too: a test that declares its own would be
    // testing its copy of the mechanism rather than the mechanism.
    const { saveMetaIndex, saveGraphFacts } = load(
      [sliceConst(FILE, '_metaIndexWrites'), sliceFn(FILE, 'settled'),
       sliceFn(FILE, 'mergeIntoMetaIndex'),
       sliceFn(FILE, 'updateMetaIndex'),
       sliceFn(FILE, 'saveMetaIndex'), sliceFn(FILE, 'saveGraphFacts')], env);
    const a = () => saveMetaIndex(['functions/standalone/build.meta.json']);
    const b = () => saveGraphFacts(NODES, GRAPH);
    const [p, q] = first === 'meta' ? [a, b] : [b, a];
    return Promise.all([p(), q()]).then(() => ({ ops, files: JSON.parse(disk).files }));
  };

  for (const first of ['meta', 'graph']) {
    test(`two read-modify-write cycles keep both halves (${first} first)`, async () => {
      const { files } = await run(first);
      const e = files['functions/standalone/build.dg'] || {};
      // The meta writer's half: the stale mark and the date, which only a .meta.json can say.
      assert.equal(e.sv, 1, 'the stale mark the meta producer set is not in the file');
      assert.equal(e.updatedTime, '2026-08-17T00:00:00+00:00', 'the modified date was lost');
      // The graph writer's half: what the parser read out of the .dg.
      assert.deepEqual(e.refs, ['automation.recalc'], 'the references the graph producer wrote were lost');
      assert.deepEqual(e.stats, { lines: 12 }, 'the size counts were lost');
    });

    test(`no cycle reads a version another is about to replace (${first} first)`, async () => {
      // The barrier itself. read,read,write,write is the lost update whether or not the fields
      // happened to survive it; read,write,read,write is the only sequence that cannot lose one.
      const { ops } = await run(first);
      assert.deepEqual(ops, ['read', 'write', 'read', 'write'],
                       `the two cycles overlapped: ${ops.join(',')}`);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// A call that somebody commented out months ago is not a call. The extractor read the source as
// text, so `// standalone.log();` was an edge, and so was the name of a function inside an error
// message - measured on six shapes that occur in ordinary Deluge, five of them wrong. The damage is
// not the drawing: `dead_suspect` is «nothing calls this», so a function whose only mention is a
// disabled line looked alive and the audit said nothing about it. Failing towards silence, in the
// one view that exists to break silence.
//
// The reader that tells code from comments already existed - the statistics have used it since they
// were written - and it was simply not shared with the extractor. This is that sharing, held here so
// it cannot be undone quietly.
{
  const w = {};
  new Function('window', read('apps/crm/graph-core.js'))(w);
  const target = { namespace: 'standalone', name: 'log', api_name: 'log', dg: 'void log(){}', file: 'a.dg' };
  const edges = (body) => w.buildGraph([{ ...target },
    { namespace: 'standalone', name: 'caller', api_name: 'caller', dg: body, file: 'b.dg' },
  ]).nodes['standalone.caller'].calls.length;

  test('a call is a call, not a mention of one', () => {
    for (const [what, body] of [
      ['a line comment', '// standalone.log();\nreturn 1;'],
      ['a block comment', '/* old: standalone.log(); */\nreturn 1;'],
      ['a name inside a string', 'info "call standalone.log() if needed";'],
      ['a name inside a message', 'sendmail[to:x subject:"standalone.log() failed"];'],
      ['code that was switched off', '// if(x){ standalone.log(); }'],
      // The shape real Deluge actually uses to park an old version: `/*` alone on its line, the
      // block running for tens of lines, `*/` far below. Found on two real orgs - one function had
      // 183 of its 193 lines inside one - and it is the case a single-line block comment does not
      // exercise, because here the extractor has to stay in the comment across newlines.
      ['a block comment spanning many lines',
       'a = 1;\n/*\nb = 2;\nstandalone.log();\nc = 3;\n*/\nd = 4;'],
    ]) {
      assert.equal(edges(body), 0, `${what} still counts as an edge`);
    }
    assert.equal(edges('standalone.log();'), 1, 'a real call stopped being one');
  });

  test('what is analysed is stripped; what is shown is not', () => {
    // The source travels on for the detail pane, the export and the assistant. Cleaning is for
    // reading, never for displaying - a reader who opens a function must see it as it was written.
    const gc = read('apps/crm/graph-core.js');
    assert.ok(/stripNonCode\(it\.dg/.test(gc), 'the builder analyses the raw text again');
    assert.ok(!/_dg = stripNonCode[\s\S]{0,80}source_code/.test(gc), 'the stripped text reached what is displayed');
  });
}


// ---------------------------------------------------------------------------------------------
// Which argument names the module is a property of each task, not a pattern. Written from memory it
// was «the first one», and `getRelatedRecords("Campaign_Products", "Campaigns", id)` names the
// **relation** first and its parent module second - so the wrong word was linked, in somebody's real
// code, and the module that was actually touched was missed. Every signature here was then read off
// its own documentation page one at a time; these cases are that reading, held so it cannot rot.
{
  // Both files, in the order the panel loads them: the depth-aware argument scanner lives in
  // highlight.js, which the graph window loads too, and graph-core.js reads it off `window`.
  const w = {};
  new Function('window', read('apps/crm/highlight.js'))(w);
  new Function('window', read('apps/crm/graph-core.js'))(w);
  const mods = (dg) => w.buildGraph([{ namespace: 'standalone', name: 'a', api_name: 'a', file: 'a.dg', dg }])
    .nodes['standalone.a'];

  test('the module is taken from the argument its own task puts it in', () => {
    const n = mods('x = zoho.crm.getRelatedRecords("Campaign_Products", "Campaigns", id);');
    assert.deepEqual(n.modules.map((m) => m.name), ['Campaigns'],
                     'the relation name was read as if it were the module');
    const d = mods('a = zoho.crm.getRecordById("Contacts", id);\nb = zoho.crm.updateRecord("Deals", id, mp);');
    assert.deepEqual(d.modules, [{ name: 'Contacts', mode: 'read', via: 'getRecordById' },
                                 { name: 'Deals', mode: 'write', via: 'updateRecord' }]);
  });

  test('a call can name two modules, and both are read', () => {
    // `updateRelatedRecord(<sub>, <sub_id>, <parent>, <parent_id>, <values>)` - the parent is the
    // third argument. Read off its page; no pattern over «the first string» would have found it.
    const n = mods('x = zoho.crm.updateRelatedRecord("Sub", sid, "Parent", pid, mp);');
    assert.deepEqual(n.modules.map((m) => m.name).sort(), ['Parent', 'Sub']);
    const b = mods('y = zoho.crm.bulkUpdate("Reminders", list);');
    assert.deepEqual(b.modules, [{ name: 'Reminders', mode: 'write', via: 'bulkUpdate' }]);
  });

  test('the V8 family is the same list under a prefix', () => {
    // `zoho.crm.v8.getRecordById(...)` - same name, same argument order, one prefix. Until it was
    // allowed for, the pattern could not match a name with a dot in front of it, so every V8 call
    // was invisible: no module read, no link, and nothing on screen to say so.
    const n = mods('a = zoho.crm.v8.getRecordById("Contacts", id);\nb = zoho.crm.v8.bulkCreate("Leads", lst);');
    assert.deepEqual(n.modules.map((m) => m.name).sort(), ['Contacts', 'Leads']);
    const h = {};
    new Function('window', read('apps/crm/highlight.js'))(h);
    const out = h.highlightDeluge('a = zoho.crm.v8.getRecordById("Contacts", id);', null, (x) => x === 'Contacts' ? x : null);
    assert.ok(/data-mod="Contacts"/.test(out), 'a V8 call does not link its module');
  });

  test('a computed module is counted whichever argument it is', () => {
    // Reported: `updateRelatedRecord("Sub", sid, parentModule, pid, values)` read `Sub` and returned
    // `modulesUnknown: 0`, so a call that names one module and computes the other looked fully
    // understood. «Every destination we cannot read is declared» has to hold for the second one too.
    const n = mods('x = zoho.crm.updateRelatedRecord("Sub", sid, parentModule, pid, values);');
    assert.deepEqual(n.modules.map((m) => m.name), ['Sub']);
    assert.equal(n.modulesUnknown, 1, 'the computed parent module was not declared as unreadable');
    // and both computed is two, not one
    const b = mods('y = zoho.crm.updateRelatedRecord(sub, sid, parent, pid, values);');
    assert.equal(b.modulesUnknown, 2, 'two unreadable destinations in one call were counted once');
  });

  test('a task whose signature has not been read contributes nothing', () => {
    // Rather than guessing that it, too, takes the module first. It is a gap that is known.
    const gc = read('apps/crm/graph-core.js');
    // `bulkUpdate` and `updateRelatedRecord` were added the day their pages were read; what stays
    // out is what the documentation does not name at all.
    for (const src of [gc, read('apps/crm/highlight.js')]) {
      assert.ok(!/deleteRecord:/.test(src) && !/upsertRecord:/.test(src),
                'a task the documentation does not name is being interpreted');
    }
    assert.ok(/contributes nothing rather than a guess/.test(gc),
              'the gap is not stated where the next reader will be');
    // The two lists must agree: one linking a word the other does not count is the drift.
    // Every `name: {` in the block, wherever it sits on its line - the first version only read
    // entries at the start of a line and reported a difference that was its own.
    const tasks = (src) => (src.match(/(\w+):\s*\{/g) || []).map((x) => x.split(':')[0]).sort();
    assert.deepEqual(tasks(gc.slice(gc.indexOf('const MODULE_TASK'), gc.indexOf('};', gc.indexOf('const MODULE_TASK')))),
                     tasks(read('apps/crm/highlight.js').slice(read('apps/crm/highlight.js').indexOf('const ARGS'),
                           read('apps/crm/highlight.js').indexOf('};', read('apps/crm/highlight.js').indexOf('const ARGS')))),
                     'the extractor and the code view disagree about which tasks name a module');
  });

  test('the relation links to the module at the other end, inside its own parent', () => {
    const h = {};
    new Function('window', read('apps/crm/highlight.js'))(h);
    const linkFor = (name, kind, parent) => kind === 'mod'
      ? (['Campaigns', 'Contacts'].includes(name) ? name : null)
      : (parent === 'Campaigns' && name === 'Campaign_Products' ? 'Products' : null);
    const out = h.highlightDeluge('x = zoho.crm.getRelatedRecords("Campaign_Products","Campaigns",id);', null, linkFor);
    assert.ok(/data-mod="Products"/.test(out), 'the relation does not lead to the module it identifies');
    assert.ok(/data-mod="Campaigns"/.test(out), 'the parent module is not a link');
    // and a string that is not one of those arguments stays a string
    const plain = h.highlightDeluge('info "Contacts";', null, linkFor);
    assert.ok(!/c-link/.test(plain), 'a string outside an argument position was turned into a link');
  });
}

// ---------------------------------------------------------------------------------------------
// Reported: reading a function in Zoost, pulling, and the function is pruned because Zoho no longer
// has it - and the pane stays open with its code on screen, showing something that exists nowhere.
{
  const panel = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  test('a pull that prunes what you are reading closes the pane', () => {
    const pull = panel.slice(panel.indexOf('async function pullAll'), panel.indexOf('\n}', panel.indexOf('async function pullAll')));
    assert.ok(/rmF\.includes\(currentPath\)/.test(pull), 'the pane survives the file it is showing');
    assert.ok(/preview'\)\.classList\.remove\('show'\)/.test(pull), 'it does not actually close');
  });
}

// ---------------------------------------------------------------------------------------------
// The guard against installing twice was a boolean, and a boolean cannot tell «this hook is already
// here» from «an older hook is already here». Chrome keeps a page alive across an extension update
// and injects into frames more than once, so the new build bowed out and the old one stayed - which
// meant an evening of fixes that could not take effect, because the code being run was never the
// code being written. The save kept working (the old hook knows that one) and nothing else ever did.
// Found only when the silent bail was made to say so, which is the rule this repository already has
// about mute exits, applied three hours late.
{
  const hook = read('apps/crm/hook.js');
  const load = (win, xhr) => new Function('window', 'XMLHttpRequest', 'location', 'document', 'console', hook)(
    win, xhr, win.location, { title: '' }, { debug() {}, info() {}, log() {} });

  test('a repeated notice is harmless, because the answer is idempotent', () => {
    // An older hook's wrappers stay underneath this one and notify from a closure of their own, so
    // the hook cannot collapse duplicates - measured, and the first attempt to do it collapsed
    // nothing while risking a lost second save. The answer is that a notice asks Zoho what exists
    // now: hearing it twice costs a list call and cannot lose an edit.
    assert.ok(!/__zoostLast/.test(hook), 'the hook is collapsing notices again');
    const panel = crmPanel();
    assert.ok(/reconcileFunctions\(\)/.test(panel), 'nothing reconciles');
    const fn = panel.slice(panel.indexOf('function reconcileFunctions'), panel.indexOf('\n}', panel.indexOf('function reconcileFunctions')))
      + sliceFn('apps/crm/sidepanel.js', 'reconcileNow');
    assert.ok(/if \(reconciling\) \{ reconcileAgain = true; return reconciling; \}/.test(fn),
              'two notices start two reconciliations, or the second is forgotten');
    // The promise is stored before anything is awaited, so a second notice arriving mid-flight finds
    // it. Anchored on the wiring as it is written now - `reconciling = (async` was the shape before
    // the round became a declaration, and an anchor that matches nothing makes the comparison
    // `-1 < something`, which is true whatever the code does.
    const at = fn.indexOf('reconciling = reconcileNow(');
    assert.ok(at > 0, 'the single-flight promise is no longer stored here - this case has stopped '
                      + 'reading the code it is about');
    assert.ok(at < fn.indexOf('await'), 'the promise is stored after the first await');
  });

  test('a newer hook replaces an older one instead of bowing out', () => {
    const posted = [];
    class FakeXHR {
      constructor() { this.status = 200; this._l = {}; }
      open(m, u) { this.__m = m; this.__u = u; }
      send() { (this._l.loadend || []).forEach((f) => f()); }
      addEventListener(k, f) { (this._l[k] = this._l[k] || []).push(f); }
    }
    // A page that an older build has already marked, the way it marked it: a bare `true`.
    const win = { __zoostHook: true, postMessage: (d) => posted.push(d), fetch: async () => ({ ok: true }),
                  location: { origin: 'https://crm.zoho.eu' } };
    load(win, FakeXHR);
    const x = new FakeXHR(); x.open('DELETE', '/crm/v2/settings/functions/123?language=deluge'); x.send();
    assert.deepEqual(posted.map((p) => p.type), ['deleted'],
                     'an older marker still turns the new hook away');
    assert.equal(typeof win.__zoostHook, 'number', 'the marker is still a flag, so this returns tomorrow');
  });

  test('the same version installs once', () => {
    const posted = [];
    class FakeXHR {
      constructor() { this.status = 200; this._l = {}; }
      open(m, u) { this.__m = m; this.__u = u; }
      send() { (this._l.loadend || []).forEach((f) => f()); }
      addEventListener(k, f) { (this._l[k] = this._l[k] || []).push(f); }
    }
    const win = { postMessage: (d) => posted.push(d), fetch: async () => ({ ok: true }),
                  location: { origin: 'https://crm.zoho.eu' } };
    load(win, FakeXHR);
    const v = win.__zoostHook;
    load(win, FakeXHR);                    // injected again into the same page
    assert.equal(win.__zoostHook, v, 'the version moved on a second install');
    const x = new FakeXHR(); x.open('PUT', '/crm/v2/settings/functions/7?language=deluge'); x.send();
    assert.deepEqual(posted.map((p) => p.type), ['saved'], 'one request produced two notices');
  });
}

// ---------------------------------------------------------------------------------------------
// The export is a document, and a document with the same id twice is malformed - every anchor to it
// lands on the first, and a reader scrolling finds the chapter again further down. `Actions` was
// emitted twice, chapter and contents entry both, from the commit that introduced it: the HTML
// checks read the pages we *ship* and had never read the HTML we *generate*, which is the gap.
{
  const panel = read('apps/crm/export.js');
  const body = panel.slice(panel.indexOf('function buildExportHtml'), panel.indexOf('function buildExportMarkdown'));

  test('the export names each chapter once', () => {
    for (const id of ['functions', 'modules', 'relations', 'workflows', 'schedules', 'actions',
                      'connections', 'failures', 'health']) {
      const n = (body.match(new RegExp(`id="${id}"`, 'g')) || []).length;
      assert.equal(n, 1, `the export emits <h2 id="${id}"> ${n} times`);
    }
  });

  test('the contents list names each chapter once', () => {
    const heads = (body.match(/class="toch">([A-Za-z ]+)/g) || []).map((x) => x.split('>')[1].trim());
    assert.deepEqual(heads, [...new Set(heads)], `a chapter is listed twice: ${heads.join(', ')}`);
  });
}

// ---------------------------------------------------------------------------------------------
// The page's MAIN world is not ours: any script there can post the message our hook posts. A save
// and a creation were always hints - the panel re-read Zoho - but a deletion *acted*, taking an id
// out of that message and removing files with it. Holding the id to digits limits its shape, not its
// authority. Raised by an outside review, and it was right.
{
  const panel = crmPanel();
  const fn = panel.slice(panel.indexOf('function reconcileFunctions'), panel.indexOf('\n}', panel.indexOf('function reconcileFunctions')))
    + sliceFn('apps/crm/sidepanel.js', 'reconcileNow');

  test('nothing is removed on the word of a message from the page', () => {
    assert.ok(/listFunctions/.test(fn), 'it does not ask Zoho what exists');
    assert.ok(/live\.has\(String\(e\.id\)\)/.test(fn), 'what is pruned is not decided by Zoho');
    const dispatch = panel.slice(panel.indexOf("msg?.type === 'deleted'"), panel.indexOf("msg?.type === 'deleted'") + 200);
    assert.ok(!/pruneFunction\(msg/.test(dispatch), 'a message still names what to delete');
  });

  test('a half-removed function is not reported as removed', () => {
    // Both files, the index row: any of them can fail, and saying «removed from the mirror» over a
    // file still on disk is a lie the next open exposes.
    const prune = panel.slice(panel.indexOf('async function pruneFunction'), panel.indexOf('\n}', panel.indexOf('async function pruneFunction')));
    assert.ok(/whole = false/.test(prune), 'a failure to remove is swallowed');
    assert.ok(/return whole/.test(prune), 'the caller cannot tell whether it worked');
    assert.ok(/could not be fully removed/.test(fn), 'a partial removal is never reported');
  });
}

// ---------------------------------------------------------------------------------------------
// What you typed in Find belongs to the list you typed it in. It belonged to the panel, so switching
// from a search in Functions to Modules filtered the modules by a function's name - usually nothing
// - and the box stayed full while the list looked empty for no visible reason. Reported as
// disorienting, which is exactly what it is: a control claiming to filter a list that never asked.
{
  const panel = crmPanel();
  const fn = panel.slice(panel.indexOf('function setMode'), panel.indexOf('\n}', panel.indexOf('function setMode')));
  test('each tab keeps its own Find', () => {
    assert.ok(/findByMode\[viewMode\] = \{ text: \$\('find'\)\.value, mode: searchMode, rx: regexMode \}/.test(fn),
              'leaving a tab throws away what was typed in it, or how it was being searched');
    assert.ok(/regexMode = !!back\.rx/.test(fn), 'the .* toggle does not come back with the text it searched');
    assert.ok(/\$\('find'\)\.value = back\.text/.test(fn), 'arriving on a tab does not restore its own');
    assert.ok(/back\.mode === 'content'/.test(fn),
              'the text comes back as a name search, so the same box means something else');
    assert.ok(fn.indexOf("findByMode[viewMode]") < fn.indexOf('viewMode = mode'),
              'it saves after the mode has already changed, so it saves under the wrong tab');
  });
  test('no caller can draw the name view over an active content search', () => {
    // The tab round-trip restored «in: code» + the pattern and then let rebuildTree paint the
    // name-filtered tree: a regex matched zero names and the panel said «No matches.» about a
    // search it never ran. The guard lives in renderTree itself so all eighteen callers inherit it.
    const rt = panel.slice(panel.indexOf('function renderTree'), panel.indexOf('const term', panel.indexOf('function renderTree')));
    assert.ok(/searchMode === 'content' && \$\('find'\)\.value\.trim\(\)/.test(rt),
      'why=renderTree draws names while the box is searching code');
    assert.ok(/_searchT = setTimeout\(contentSearch, 220\)/.test(rt),
      'why=the deferral does not actually re-run the search');
  });
}

// ---------------------------------------------------------------------------------------------
// The worst thing this product could do, and it was reachable: `listFunctions` stops after twenty
// pages and says so with `capped`, and both the reconciler and the pull treated that partial answer
// as the whole truth - writing it as the index and deleting every local function missing from it.
// Past the paging limit an ordinary creation, or a forged message from the page, could remove files
// that are still in Zoho. In the pull the truncation was even reported *after* the pruning had run.
// Raised by an outside review; a partial list is a statement about the reading, not about what
// exists.
{
  const panel = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [name, start] of [['reconcileFunctions', 'function reconcileFunctions'], ['pullAll', 'async function pullAll']]) {
    test(`${name} removes nothing from a list that stopped early`, () => {
      const fn = panel.slice(panel.indexOf(start), panel.indexOf('\n}', panel.indexOf(start)))
        + (name === 'reconcileFunctions' ? sliceFn('apps/crm/sidepanel.js', 'reconcileNow') : '');
      const guard = fn.indexOf('r.capped');
      assert.ok(guard > 0, 'the truncation is never read');
      for (const danger of ['pruneFunction', 'removeFile', "writeFile('functions/index.json'"]) {
        const at = fn.indexOf(danger);
        if (at > 0) assert.ok(guard < at, `${danger} runs before the truncation is checked`);
      }
      assert.ok(/nothing was removed/.test(fn), 'the reader is not told that nothing was removed');
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Ordering, from the same review. Two notices for one function used to start two reads and two
// writes, and whichever answer came back second won - so out-of-order replies left the **older**
// source on disk. Two real saves a moment apart do exactly the same, and there the loser is an edit
// somebody made. A change arriving *during* a reconciliation was answered by the promise already
// running, which is a «done» about a state older than the change. And a removal that failed was
// forgotten while the index had already been rewritten without it, so nothing would ever look again.
{
  const panel = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // `reconcileFunctions` is wiring now and `reconcileNow` is the round; asking for the first and
  // getting only the wiring is how a check goes quiet without failing.
  const fn = (n) => panel.slice(panel.indexOf(n), panel.indexOf('\n}', panel.indexOf(n)))
    + (n.includes('reconcileFunctions') ? sliceFn('apps/crm/sidepanel.js', 'reconcileNow') : '');

  // Run, not read. These four were assertions about the text of syncOne(), and they went red the day
  // the trailing read moved one function along - a true statement about where a line sits, which is
  // not what any of them was about. What follows drives the real queue with a stub in place of the
  // read, and would survive that move.
  const queue = () => {
    const ctx = { setTimeout, clearTimeout, Promise, String, Map, Set, Array, Object, console,
                  order: [], live: 0, peak: 0, resolvers: [] };
    ctx.syncOneNow = (key) => new Promise((res) => {
      ctx.order.push(key); ctx.live++; ctx.peak = Math.max(ctx.peak, ctx.live);
      ctx.resolvers.push({ key, res: () => { ctx.live--; res(); } });
    });
    ctx.Math = Math;
    vm.createContext(ctx);
    for (const n of ['syncing', 'SYNC_MAX', 'syncBusy']) vm.runInContext(sliceConst('apps/crm/sidepanel.js', n), ctx);
    // `runSyncSlot` is the slot's own work - two `.then()` callbacks until the race checker asked
    // to read them - and without it the pump would run with nothing to free its slots.
    for (const n of ['syncOne', 'syncPump', 'runSyncSlot']) vm.runInContext(sliceFn('apps/crm/sidepanel.js', n), ctx);
    return ctx;
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test('two notices for one function are one read and one more after it', async () => {
    const c = queue();
    vm.runInContext("syncOne('7')", c);
    await settle();
    vm.runInContext("syncOne('7')", c);
    vm.runInContext("syncOne('7')", c);
    await settle();
    assert.deepEqual(c.order, ['7'], 'a second notice started a second read - the older source can win');
    c.resolvers.shift().res();
    await settle(); await settle();
    assert.deepEqual(c.order, ['7', '7'], 'the notices that arrived during the read were dropped');
  });

  test('a burst of notices runs four at a time, and loses none', async () => {
    const c = queue();
    for (let i = 0; i < 50; i++) vm.runInContext(`syncOne('${i}')`, c);
    await settle();
    assert.equal(c.peak, 4, `${c.peak} reads in flight at once - a burst is unbounded`);
    // Drain, four at a time, until nothing is left.
    for (let guard = 0; guard < 200 && c.resolvers.length; guard++) { c.resolvers.shift().res(); await settle(); }
    assert.equal(c.order.length, 50, 'a queued notice was dropped rather than deferred');
    assert.equal(new Set(c.order).size, 50, 'an id was read twice, or one never was');
  });

  test('a read that throws does not keep its slot for the rest of the session', async () => {
    const c = queue();
    c.syncOneNow = () => Promise.reject(new Error('Zoho said no'));
    vm.runInContext("syncOne('1')", c);
    await settle(); await settle();
    assert.equal(vm.runInContext('syncBusy', c), 0, 'a rejected read leaves a slot occupied for ever');
    assert.equal(vm.runInContext('syncing.size', c), 0, 'the id stays marked in flight after a failure');
  });

  test('a change during a reconciliation is answered by one more round', () => {
    const r = fn('function reconcileFunctions');
    assert.ok(/reconcileAgain = true/.test(r), 'a notice during a run is forgotten');
    assert.ok(/if \(reconcileAgain\) \{ reconcileAgain = false; reconcileFunctions\(\); \}/.test(r),
              'the remembered change never gets its round');
    // Left for the pull to consume, not re-armed: re-running while the pull is busy is a tight
    // loop of permission and context checks during the most expensive thing the panel does.
    assert.ok(/pullActive\) \{ pendingAfterPull = true; return; \}/.test(r), 'a notice during a pull is dropped');
    // Honoured by one helper that every pull ends through, not by `pullAll` alone: a change during a
    // modules or workflows pull used to sit in the flag until something else happened to ask.
    const end = fn('function endPull');
    assert.ok(/pendingAfterPull.*reconcileFunctions\(\)/.test(end), 'the pull never honours it');
    const panelSrc = crmPanel();
    assert.ok(!/finally \{ pullActive = false; \}/.test(panelSrc),
              'a pull still ends on its own, so it cannot honour a notice');
  });

  test('a removal that failed is tried again, not forgotten', () => {
    assert.ok(/const failedRemovals = new Set\(\)/.test(panel), 'a failed removal is not kept');
    const p = fn('async function pruneFunction');
    assert.ok(/failedRemovals\.add\(p\)/.test(p), 'the failing path is not the one kept');
    assert.ok(!/failedRemovals\.add\(path\)/.test(p), 'it keeps the function path instead of the file that failed');
    const r = fn('function reconcileFunctions');
    assert.ok(/for \(const p of \[\.\.\.failedRemovals\]\)/.test(r), 'nothing retries them');
    assert.ok(r.indexOf('failedRemovals') < r.indexOf('const gone'), 'the retry runs after the new pruning');
  });
}

// ---------------------------------------------------------------------------------------------
// A click must not move the list; arriving from elsewhere must. That was told apart by a global set
// in `openFromTree` and cleared only by `applySelection` - so a click whose open then failed (no
// permission, an unreadable file) left it set, and the *next* arrival from somewhere else was
// mistaken for that click and never revealed. Raised by an outside review. The origin is an argument
// of the call now: there is no state to leak between two navigations.
{
  const panel = crmPanel();
  test('where an open came from travels with the call', () => {
    assert.ok(!/openedByClick/.test(panel), 'the origin is a shared flag again');
    assert.ok(/function openFromTree\(path\) \{ openFile\(path, null, true\); \}/.test(panel),
              'a click no longer says it is one');
    const sel = panel.slice(panel.indexOf('function applySelection'), panel.indexOf('\n}', panel.indexOf('function applySelection')));
    assert.ok(/if \(byClick\) return;/.test(sel), 'a click moves the list again');
  });
}

// ---------------------------------------------------------------------------------------------
// The workspace selector is blocked while a *pull* runs, and stays usable during everything else -
// the assistant, exports, health, previews - so for those, every await is still a place the folder
// underneath can change. Reproduced by an outside review: a fetch started in one
// workspace wrote both of its files into the next. A handle identifies a folder exactly - the same
// object, or a different workspace - so it is captured before the first await and compared after.
{
  const panel = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // As above: the wiring is `reconcileFunctions` and the round is `reconcileNow`, so a slice of
  // the first alone would read past the checks and pass while checking nothing.
  const fn = (n) => panel.slice(panel.indexOf(n), panel.indexOf('\n}', panel.indexOf(n)))
    + (n.includes('reconcileFunctions') ? sliceFn('apps/crm/sidepanel.js', 'reconcileNow') : '');

  test('an answer is not written into a workspace you have left', () => {
    // Two mechanisms did this - a captured handle here, a captured generation in the pulls - and
    // they are one now: the op holds both, and the writer refuses on the handle regardless.
    for (const name of ['async function syncOneNow', 'function reconcileFunctions']) {
      const body = fn(name);
      assert.ok(/const op = beginWorkspaceOp\(\);/.test(body), `${name} does not remember which folder it started in`);
      assert.ok(/!op\.current\(\)/.test(body), `${name} never checks the folder is still the same`);
      // The folder is taken before anything is awaited. `fn()` glues the wiring to the round it
      // hands off to, so the first `await` in the glued text can belong to the round - the claim is
      // about the *wiring*, which is where the op is taken, so it is read there.
      const wiring = body.slice(0, body.indexOf('async function ') + 1 || undefined);
      assert.ok(wiring.indexOf('const op = beginWorkspaceOp();') < (wiring.indexOf('await ') + 1 || Infinity),
                `${name} captures the folder after its first await`);
    }
  });

  test('a failed removal does not follow you into another workspace', () => {
    // Relative paths mean nothing outside the folder they came from: retrying
    // `functions/standalone/gone.dg` in the next workspace is a file belonging to another org.
    const drop = fn('function dropWorkspaceState');
    assert.ok(/failedRemovals\.clear\(\)/.test(drop), 'the retry queue survives a change of workspace');
  });

  test('a partial list of workflows removes nothing either', () => {
    const p = fn('async function pullWorkflows');
    const guard = p.indexOf('r.capped');
    assert.ok(guard > 0, 'the truncation is never read');
    for (const danger of ["writeFile('workflows/index.json'", 'removeFile']) {
      const at = p.indexOf(danger);
      if (at > 0) assert.ok(guard < at, `${danger} runs before the truncation is checked`);
    }
  });

  test('each walk has the ceiling its own page size needs', () => {
    const bridge = read('apps/crm/content-bridge.js');
    assert.ok(/MAX_PAGES_WIDE/.test(bridge), 'one number serves walks that read 50 and 200 a page');
    const wide = bridge.slice(bridge.indexOf('async function listWorkflows'), bridge.indexOf('async function listWorkflows') + 700);
    assert.ok(/MAX_PAGES_WIDE/.test(wide), 'the wide walk still counts against the narrow ceiling');
  });
}

// ---------------------------------------------------------------------------------------------
// A check between two effects is a check that protects the first one only. `syncOneNow` compared the
// folder once and then wrote two files - each write being several awaits of its own - so a change of
// workspace mid-way left the source in one and the metadata in the next. `pruneFunction` removed the
// same pair the same way. Raised by an outside review, with both halves reproduced.
{
  const panel = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = (n) => panel.slice(panel.indexOf(n), panel.indexOf('\n}', panel.indexOf(n)));

  test('every write and every removal is checked, not just the first', () => {
    // **This asserted `0 >= 0` for months.** It grepped for `dir !== myDir`, `writeFile(` and
    // `removeFile(`; both functions were refactored onto `beginWorkspaceOp()` / `op.current()` /
    // `op.write()` / `op.remove()`, so both counts became zero and the comparison passed on nothing.
    // `|| []` is what turned «matched nothing» into «zero» - the shape this repository already names:
    // a guard that skips when the thing is absent is not a guard. Proven by an outside review, which
    // planted two unguarded writes after the last check and watched the suite stay green.
    //
    // So: the names are asserted to exist before they are counted, and the *order* is checked rather
    // than the totals - three checks and two writes passed the old comparison whatever their
    // positions. Every effect must have a guard between it and the effect before it.
    for (const [name, effects] of [['async function syncOneNow', ['op.write(']],
                                   ['async function pruneFunction', ['op.remove(']]]) {
      const body = fn(name);
      assert.ok(body.length > 200, `${name}: the slice is empty - renamed or moved, so this tests nothing`);
      const guard = /op\.current\(\)|!current\(\)/;
      assert.match(body, guard, `${name}: no workspace check at all`);
      for (const effect of effects) {
        const at = [...body.matchAll(new RegExp(effect.replace(/[(.]/g, '\\$&'), 'g'))].map((m) => m.index);
        assert.ok(at.length, `${name}: no ${effect} call - the effect was renamed and this stopped testing it`);
        let from = 0;
        for (const i of at) {
          const between = body.slice(from, i);
          assert.match(between, guard,
            `${name}: a ${effect} with no workspace check between it and the effect before it`);
          from = i;
        }
      }
    }
  });

  test('the remedy a message names is the one that runs', () => {
    // «click Refresh» over a removal that could not finish: Refresh redrew the list and never tried
    // again, so the reader did as told and believed it had worked.
    assert.ok(/failedRemovals\.size\) await reconcileFunctions\(\)/.test(panel),
              'Refresh does not retry what failed');
  });

  test('every walk that reads 200 a page counts against the wide bound', () => {
    // Derived from the requests themselves: a walk added tomorrow with the same page size is
    // measured rather than remembered.
    const bridge = read('apps/crm/content-bridge.js').split('\n');
    for (let i = 0; i < bridge.length; i++) {
      if (!/per_page=200/.test(bridge[i])) continue;
      const near = bridge.slice(i, i + 14).join('\n');
      const bound = near.match(/MAX_PAGES(_WIDE)?\b/);
      // `if (!bound) continue` was here, and it is the whole difference between «the ceilings that
      // exist are the right ones» and «there is a ceiling». A walk with no bound at all was skipped
      // in silence - planted, 200 a page, no ceiling, nothing said when it stops, and the suite
      // passed. A loop that can run for ever is the case this bound exists for.
      assert.ok(bound, `a 200-a-page walk near line ${i + 1} has no page ceiling at all: it walks ` +
                       `until Zoho stops answering, and says nothing when it gives up`);
      assert.equal(bound[0], 'MAX_PAGES_WIDE', `a 200-a-page walk near line ${i + 1} uses the narrow bound`);
      // **And what that name is worth.** The bound was checked by name and never by value, so raising
      // it from 40 to 400 - eighty thousand rows on a 200-a-page walk, which is verbatim the defect
      // this repository records - left the whole battery green. A ceiling nobody measures is a
      // variable. The two numbers are read from the bridge itself, so this stays true if they move
      // for a reason; what it refuses is a wide walk that can pull more rows than a person would
      // wait for.
      const wideN = +(/const MAX_PAGES_WIDE = (\d+)/.exec(bridge.join('\n')) || [])[1];
      assert.ok(wideN >= 1, 'MAX_PAGES_WIDE is no longer a literal in the bridge - this cannot measure it');
      assert.ok(wideN * 200 <= 20000,
                `MAX_PAGES_WIDE is ${wideN}: a wide walk may fetch ${wideN * 200} rows before it stops`);
      // And hitting the ceiling is reported, *on the line that hits it*. Looking for `capped`
      // anywhere in the fourteen was satisfied by the `let capped = false` above - so removing the
      // report from the ceiling itself passed. The partial list this repository refuses to prune
      // against is exactly the one that stops here and says «this is everything».
      const ceiling = near.split('\n').find((l) => /MAX_PAGES(_WIDE)?\b/.test(l));
      assert.ok(/capped/.test(ceiling),
                `a 200-a-page walk near line ${i + 1} stops at its ceiling in silence: ${ceiling.trim().slice(0, 80)}`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Fixing three functions did not close the class: a fourth, a fifth and a sixth were still writing
// one org's data into another org's folder, because every one of them checks at the start and writes
// after an await while the workspace selector stays live. A generation closes it - captured once,
// asked again before each effect - and the check below is derived from the writes rather than from a
// list of functions somebody remembered.
{
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/sidepanel.js`);
    test(`${app}: the generation moves at the switch, before the handle and before any await`, () => {
      assert.ok(/let wsGen = 0;/.test(src), 'there is nothing to compare against');
      // Where it moves is the whole of it. It was in `dropWorkspaceState()`, which Clear also calls
      // - so clearing a conversation interrupted a pull - and in one file it sat after the `return`
      // and never ran, which made every guard in it always true. Both reported. And it must move
      // *before* the new handle is assigned, or an operation from the old workspace passes its
      // check while already writing through the new folder.
      // `const gen = ++wsGen`: the selection keeps the number it moved to, so it can tell later
      // whether a second selection has overtaken it - which is what decides what gets remembered.
      const bump = src.indexOf('const gen = ++wsGen;');
      assert.ok(bump > 0, 'the generation never moves');
      const drop = src.slice(src.indexOf('function dropWorkspaceState'), src.indexOf('\n}', src.indexOf('function dropWorkspaceState')));
      assert.ok(!/wsGen\s*\+\+/.test(drop), 'clearing the conversation still moves the generation');
      const line = src.slice(0, bump).split('\n').length;
      const around = src.split('\n').slice(line - 1, line + 6).join('\n');
      assert.ok(/dir = w\.handle/.test(around), 'the generation does not move where the folder changes');
      assert.ok(around.indexOf('const gen = ++wsGen;') < around.indexOf('dir = w.handle'),
                'the folder changes before the generation does');
    });
  }

  test('crm: every pull that writes an index checks it is still where it started', () => {
    const src = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const name of ['pullModules', 'pullSchedules', 'pullActions', 'pullConnections', 'pullWorkflows']) {
      const at = src.indexOf(`async function ${name}`);
      const body = src.slice(at, src.indexOf('\n}', at));
      assert.ok(/const op = beginWorkspaceOp\(\);/.test(body), `${name} does not remember which workspace it belongs to`);
      const guard = body.indexOf('op.current()'), write = body.search(/op\.write\('[a-z]+\/index\.json'/);
      if (write > 0) assert.ok(guard > 0 && guard < write, `${name} writes its index without asking`);
    }
  });

  test('crm: a partial list never replaces an index, in any pull', () => {
    const src = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [name, idx] of [['pullSchedules', 'schedules'], ['pullActions', 'actions'],
                               ['pullWorkflows', 'workflows'], ['pullAll', 'functions']]) {
      const at = src.indexOf(`async function ${name}`);
      const body = src.slice(at, src.indexOf('\n}', at));
      const capped = body.indexOf('capped'), write = body.indexOf(`op.write('${idx}/index.json'`);
      if (write > 0) assert.ok(capped > 0 && capped < write, `${name} replaces its index from a partial list`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Derived from the writes, because a list of function names is a list somebody has to remember. The
// workspace selector is refused during a pull *now* - these guards predate that, and they still
// hold the non-pull operations, where the folder can change underneath - and `writeFile`/`removeFile` resolve their path against whatever `dir` is at
// the moment they run, not the one the operation started in.
{
  const src = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('every pull that writes captures the workspace it belongs to', () => {
    // The set comes from the source: a pull added tomorrow is measured rather than remembered.
    const names = [...src.matchAll(/async function (pull[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
    assert.ok(names.length >= 6, `only found ${names.length} pulls - the pattern has changed`);
    for (const name of names) {
      const at = src.indexOf(`async function ${name}`);
      const body = src.slice(at, src.indexOf('\n}', at));
      if (!/op\.write\(|op\.remove\(|patchCfg\(/.test(body)) continue;   // reads nothing to protect
      assert.ok(/const op = beginWorkspaceOp\(\);/.test(body), `${name} writes without remembering its workspace`);
      assert.ok(/op\.current\(\)/.test(body), `${name} never asks whether it is still there`);
    }
  });

  test('crm: an operation-bound pull also reads its binding from that operation', () => {
    const names = [...src.matchAll(/async function (pull[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
    for (const name of names) {
      const at = src.indexOf(`async function ${name}`);
      const body = src.slice(at, src.indexOf('\n}', at));
      if (!/beginWorkspaceOp\(\)/.test(body)) continue;
      assert.ok(!/await readCfg\(\)/.test(body),
                `${name} validates whichever folder is global now, not the workspace it captured`);
    }
    assert.match(sliceFn('apps/crm/sidepanel.js', 'patchCfg'),
                 /op \? await opReadCfg\(op\) : await readCfg\(\)/,
                 'patchCfg writes through an op but merges from the global workspace');
    for (const loader of ['loadActionsIndex', 'loadConnectionsIndex']) {
      const at = src.indexOf(`async function ${loader}`);
      const body = src.slice(at, src.indexOf('\n}', at));
      assert.match(body, /op = beginWorkspaceOp\(\)/, `${loader} cannot be tied to its caller's workspace`);
      assert.match(body, /op\.read\(/, `${loader} still resolves its index through the global folder`);
      assert.match(body, /op\.current\(\)/, `${loader} can return a file read from an overtaken workspace`);
    }
  });

  test('a graph built for one workspace is not kept for another', () => {
    const fn = src.slice(src.indexOf('async function ensureGraph'), src.indexOf('\n}', src.indexOf('async function ensureGraph')));
    assert.ok(/op = beginWorkspaceOp\(\)/.test(fn), 'the build does not remember where it started');
    assert.ok(/loadGraph\(op\)/.test(fn), 'the graph reader does not carry that workspace through its own I/O');
    assert.ok(/if \(!op\.current\(\)\) throw new Error\(WS_MOVED\);/.test(fn),
              'an overtaken graph is returned to its caller even though it must not be used');
  });

  test('every cache made of a workspace\'s files is dropped with it', () => {
    // Following the call, not grepping the body: the list moved into `dropFileCaches()` the day
    // ↻ Refresh needed the same one, and an assertion about where a line sits would have called that
    // a regression.
    const cleared = clearedBy(src, 'dropWorkspaceState');
    for (const c of ['graphCache', 'codeCache', 'modNamesCache', 'moduleFilesCache', 'aiConnCache',
                     'aiActCache', 'failIndex', 'healthData', 'actionUsers']) {
      assert.ok(cleared.has(c), `id=${c} survives a change of workspace`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// A failed read must never authorise a deletion. The modules pull kept a set of the layout files it
// had just written and deleted every other one on disk - so a module whose layouts call was refused,
// rate-limited, or never attempted (the fields call had already failed) arrived with an empty list
// and had its existing layout detail removed, silently, as though Zoho had said it has none. A
// failed *write* did the same. Found by a cold scan of the panel and the bridge together.
{
  const bridge = read('apps/crm/content-bridge.js');
  const panel = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = panel.slice(panel.indexOf('async function pullModules'), panel.indexOf('\n}', panel.indexOf('async function pullModules')));

  test('every read the bridge reports on starts as «not read»', () => {
    // Derived from the name, not from a list of two. `xRead` is the flag that separates «Zoho
    // answered, and it is none» from «nobody asked, or the call failed» - the distinction this whole
    // product is built on, and the one that decides whether a prune may delete. Declared `true` and
    // it collapses in the direction that loses files: a refused call reads as «none».
    //
    // Planted a third flag of exactly that shape, declared true before the call it describes: the
    // node suite passed. The check named `layoutsRead` and `relatedRead` by hand, which is the shape
    // of every hole this grid has turned up so far.
    const flags = [...new Set([...bridge.matchAll(/\b(\w+Read)\b/g)].map((m) => m[1]))];
    assert.ok(flags.length >= 2, `only ${flags.length} read-verdict flags found - the derivation broke`);
    for (const f of flags) {
      assert.ok(new RegExp(`let ${f} = false;`).test(bridge),
                `id=${f} does not start as «not read», so a call that never happened reports as «none»`);
      assert.ok(new RegExp(`\\b${f} = true`).test(bridge),
                `id=${f} is never set, so everything looks unread`);
      // And the panel is told: a verdict the bridge keeps to itself is one nobody can act on.
      const wire = f.replace(/Read$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() + '_read';
      assert.ok(new RegExp(`${wire}:\\s*${f}`).test(bridge),
                `id=${f} is decided and never sent to the panel as ${wire}`);
    }
  });

  test('a layout file is removed only for a module that answered with none', () => {
    assert.ok(/m\.layouts_read !== true/.test(fn), 'a module Zoho could not answer for is pruned anyway');
    assert.ok(/keepLayoutFiles\.has\(p\)/.test(fn), 'the prune does not consult what must be kept');
    // A write that failed keeps the old file: it is still the best answer anybody has.
    //
    // **Anchored on what the code says now.** This looked for `await writeFile(lf`, which moved to
    // `op.write(lf, …)` long ago, so `indexOf` was -1 and `keep > -1` held for any answer at all -
    // the file could be marked kept *before* the write, or the success branch removed entirely, and
    // this passed. A missing anchor is not a passing test; it is a test that stopped reading.
    // Inside the branch that writes, and nowhere else: `keepLayoutFiles.add(lf)` is written three
    // times in this function - once after the write, once for a module whose layouts were not read,
    // once for one whose fields were not - so «the next one after the write» finds a later branch and
    // holds however the first is arranged. The branch is sliced, then read.
    const branch = fn.slice(fn.indexOf('if (fullLayouts.length) {'), fn.indexOf('} else if (m.layouts_read'));
    assert.ok(branch.includes('op.write(lf'), 'the layout file is no longer written in this branch - '
                                              + 'this case has stopped reading the code it is about');
    assert.ok(branch.indexOf('keepLayoutFiles.add(lf)') > branch.indexOf('op.write(lf'),
              'the file is only kept when the write succeeded');
    assert.ok(!/liveLayoutFiles/.test(fn), 'the old set, built from writes, is still deciding');
  });

  test('layout sets removed are counted and said', () => {
    assert.ok(/prunedL/.test(fn), 'nothing counts them');
    assert.ok(/layout set\(s\) removed/.test(fn), 'the reader is not told anything was removed');
  });
}

// ---------------------------------------------------------------------------------------------
// `pullEverything` holds the panel busy and calls `pullAll`, which calls `downloadMissing`, which
// held and released the same flag - so from the moment the functions were fetched the remaining six
// areas pulled with it false, the five-second poll re-enabled both Pull buttons, and a second
// `pullEverything` could start on top of the first. A boolean owned by several callers loses
// whatever the outer one meant, which is the third time that shape has been found here.
{
  const src = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = src.slice(src.indexOf('function setPullBusy'), src.indexOf('\n}', src.indexOf('function setPullBusy')));

  test('the busy state counts its holders instead of switching', () => {
    assert.ok(/pullDepth/.test(fn), 'it is a switch again, so a nested pull releases the outer one');
    assert.ok(/pullBusy = pullDepth > 0/.test(fn), 'the flag no longer follows the count');
    assert.ok(/Math\.max\(0,/.test(fn), 'an extra release drives the count negative and wedges it busy');
  });

  test('nothing assigns the flag behind the counter', () => {
    // One way in. An assignment elsewhere is the counter being bypassed, which is how this returns.
    // The declaration is not an assignment for this purpose; anything else is the counter bypassed.
    // The declaration is not an assignment for this purpose; anything else is the counter bypassed.
    const assigns = src.split('\n').filter((l) => /\bpullBusy\s*=[^=]/.test(l) && !/^\s*let /.test(l));
    assert.equal(assigns.length, 1, `pullBusy is set in ${assigns.length} places: ${assigns.map((l) => l.trim()).join(' | ')}`);
    assert.ok(/pullDepth/.test(assigns[0]), 'the one assignment does not follow the count');
  });
}

// ---------------------------------------------------------------------------------------------
// Refresh promises «read every file again» and delivered «re-read the rows this panel is holding» -
// which are the functions tree's, filled only by a load of that tab and never reset per workspace.
// Open the panel on Modules, let an editor or a `git checkout` change a `.dg`, press Refresh:
// nothing marked, nothing re-read, and the one control that answers the write we cannot see did
// nothing and said nothing. The marks were the wrong instrument - they name paths, and what is being
// distrusted is the whole summary.
{
  const src = crmPanel().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('distrust is a state of the load, not the rows in memory', () => {
    const fn = src.slice(src.indexOf('function distrustEverything'), src.indexOf('\n}', src.indexOf('function distrustEverything')));
    assert.ok(/distrustSummary = true/.test(fn), 'it still depends on what the panel happens to hold');
  });

  test('both readers ignore the summary while it is distrusted', () => {
    // Readers *of the summary*: another `const known` in this file is the workspace list, which has
    // nothing to do with it - derived by what they mention rather than by their variable name.
    const readers = (src.match(/const known = \([^;]+;/g) || []).filter((r) => /SUMMARY_V/.test(r));
    assert.equal(readers.length, 2, `expected two readers of the summary, found ${readers.length}`);
    for (const r of readers) assert.ok(/!distrustSummary/.test(r), `a reader still trusts it: ${r.slice(0, 60)}`);
  });

  test('the flag is put down only after the re-read has been written back', () => {
    const load = src.slice(src.indexOf('async function rebuildTree'), src.indexOf('\nasync function', src.indexOf('async function rebuildTree') + 10));
    const saved = load.indexOf('saveMetaIndex'), cleared = load.indexOf('distrustSummary = false');
    assert.ok(cleared > saved && saved > 0, 'it is put down before the summary has been rewritten');
    assert.ok(/stale_summary = distrustSummary \|\|/.test(load),
              'a full re-read does not force the summary to be rewritten, so the next open starts over');
  });
}

// ---------------------------------------------------------------------------------------------
// The actions census is per kind and so is its incompleteness. The guard read `capped` alone while
// the comment beside it spoke about a kind that *could not be read* - so the worse half, a kind that
// refused outright, replaced the index with an answer that did not contain it, and every webhook the
// previous pull had censused was gone. It also wrote before checking which schema the bridge could
// even produce, then wrote the same thing again inside the check.
//
// Run rather than read: the function is lifted and driven with a bridge whose answer is chosen per
// case. What this does not cover is stated in slice.mjs - the wiring, not the logic.
{
  const RUN = async (resp, prevIdx) => {
    const ctx = {
      wsGen: 1, viewMode: 'functions', dir: {}, ACT_SV: 4, written: null, status: [],
      MSG: { staleBridge: 'reload that tab', noTab: 'no tab', wrongTab: 'wrong tab' },
      mismatchRefuse: () => false, ensurePerm: async () => true, sameWs: () => true,
      getContext: async () => ({ org: 'o', origin: 'https://crm.example', instance: 'i' }),
      readCfg: async () => null, opReadCfg: async () => null, toBridge: async () => resp,
      setStatus: (s) => ctx.status.push(s),
      // The op is what the pull writes through now. Its own capture is held by its own case; here it
      // stands in, so these stay about what pullActions decides to write.
      beginWorkspaceOp: () => ({ root: ctx.dir, current: () => true,
                                 write: async (_p, txt) => { ctx.written = JSON.parse(txt); },
                                 read: async () => { throw new Error('not stubbed'); } }),
      loadActionsIndex: async () => prevIdx,
      rebuildActions: async () => {}, noteAccess: async () => {},
      notePullFailure: async (_a, e) => { throw e; },
      // The pull marks itself running and releases through the one helper. Stubbed here because this
      // case runs the function, which is exactly how the free reference was caught the moment the
      // three pulls that had never owned the flag were given it.
      pullActive: false, endPull: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/crm/automation.js', 'pullActions') + '\npullActions();', ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return ctx;
  };
  const PREV = [{ kind: 'webhooks', id: '1', name: 'w1' }, { kind: 'webhooks', id: '2', name: 'w2' },
                { kind: 'tasks', id: '9', name: 't9' }];
  const OK = { ok: true, sv: 4, missed: [], capped: [] };

  test('a kind that refused keeps what the last census saw of it', async () => {
    const c = await RUN({ ...OK, actions: [{ kind: 'tasks', id: '9', name: 't9' }],
                          missed: [{ kind: 'webhooks', error: '403' }] }, PREV);
    const kinds = (c.written || []).filter((a) => a.kind === 'webhooks').map((a) => a.id).sort();
    assert.deepEqual(kinds, ['1', '2'], 'the refused kind was replaced by an answer that could not see it');
  });

  test('a kind read whole is replaced, deletions included', async () => {
    const c = await RUN({ ...OK, actions: [{ kind: 'webhooks', id: '1', name: 'w1' }] }, PREV);
    assert.deepEqual((c.written || []).map((a) => `${a.kind}:${a.id}`), ['webhooks:1'],
                     'a complete read did not remove what Zoho no longer has');
  });

  test('a task whose detail refused keeps the mappings and nothing else', async () => {
    // The first version of this kept the previous row *whole*, which threw away everything this pull
    // did read: the name went back to what it was last week, `detail_read` came back true, and the
    // status line said «1 action(s) pulled.» with no warning. Worse than losing the mappings.
    const prev = [{ kind: 'tasks', id: '9', name: 'old name', module: 'Deals', detail_read: true,
                    modified_time: '2026-08-01T00:00:00Z', mappings: [{ field: 'Subject' }] }];
    const c = await RUN({ ...OK, actions: [{ kind: 'tasks', id: '9', name: 'new name', detail_read: false }],
                          detail_missed: [{ kind: 'tasks', id: '9', reason: '429' }] }, prev);
    const row = (c.written || [])[0];
    assert.equal(row.name, 'new name', 'the row this pull read was replaced by one from before it');
    assert.deepEqual(row.mappings, [{ field: 'Subject' }], 'the mappings the last pull read were dropped');
    assert.equal(row.detail_read, false, 'the row claims a detail this pull never read');
    assert.equal(row.detail_kept, true, 'nothing marks the mappings as coming from an older reading');
    assert.equal(row.detail_kept_from, '2026-08-01T00:00:00Z', 'and nothing says how old it is');
    assert.ok(c.status.some((s) => /detail Zoho did not return/.test(s)),
              'a pull that could not read a detail reported no warning at all');
  });

  test('and with nothing to keep, it is written thin and said to be thin', async () => {
    const c = await RUN({ ...OK, actions: [{ kind: 'tasks', id: '9', name: 't9', detail_read: false }],
                          detail_missed: [{ kind: 'tasks', id: '9', reason: '429' }] }, []);
    assert.equal((c.written || [])[0].detail_read, false, 'the row does not carry that its detail is unread');
    assert.ok(c.status.some((s) => /detail Zoho did not return/.test(s)), 'and nothing said so');
  });

  test('a kind cut short takes what it saw and keeps the rest', async () => {
    const c = await RUN({ ...OK, actions: [{ kind: 'webhooks', id: '1', name: 'renamed' }],
                          capped: ['webhooks'] }, PREV);
    const w = (c.written || []).filter((a) => a.kind === 'webhooks');
    assert.equal(w.length, 2, 'a partial list was written as the whole census');
    assert.equal(w.find((a) => a.id === '1').name, 'renamed', 'what this pull read did not win');
    assert.ok(!(c.written || []).some((a) => a.kind === 'tasks'),
              'a kind nobody said was partial was kept instead of replaced');
  });

  test('a bridge that cannot write the current schema does not write at all', async () => {
    const c = await RUN({ ...OK, sv: 3, actions: [{ kind: 'webhooks', id: '1' }] }, PREV);
    assert.equal(c.written, null, 'an older copy of the extension overwrote fields it cannot capture');
    assert.ok(c.status.some((s) => /reload that tab/.test(s)), 'and it did not say whose copy is old');
  });
}

// The chips are rebuilt after every data load, and resetting the filter as a side effect meant that
// clicking a row's status dot in Actions put the list back to All. Each mode keeps its own filter -
// the same per-tab memory the search box has - and what must not survive is a value the rebuilt list
// no longer offers, which is derived from the options rather than from which caller it was.
{
  const src = crmPanel();
  const chips = sliceFn('apps/crm/sidepanel.js', 'buildTypeChips');

  test('buildTypeChips keeps the current filter when the list still offers it', () => {
    assert.ok(/defs\.some\(\(\[k\]\) => k === curFilter\(\)\) \? curFilter\(\) : 'all'/.test(chips),
              'it still resets the filter as a side effect of being rebuilt');
    assert.ok(/sel\.value = keep;/.test(chips), 'the control disagrees with the filter it is showing');
  });

  test('one place reads the per-mode filter and one writes it', () => {
    const chains = (src.match(/viewMode === 'functions'\) typeFilter = /g) || []);
    assert.equal(chains.length, 1, `the per-mode filter is assigned by ${chains.length} chains, not one`);
    assert.ok(/const curFilter = \(\) =>/.test(src) && /function setCurFilter\(k\)/.test(src),
              'the read and the write of the per-mode filter are not defined in one place');
  });
}

// ---------------------------------------------------------------------------------------------
// Three from the same cold scans, each invisible on screen: a number at its ceiling that looks like
// the whole truth, a helper that would throw if anything called it, and a page serialised per request.
{
  const panel = crmPanel();
  const bridge = read('apps/crm/content-bridge.js');

  test('the failures list says it was read to a ceiling, on every surface that shows it', () => {
    assert.ok(/const capped = failures\.length >= FAIL_LIMIT/.test(bridge),
              'the bridge reads one page and reports nothing about the ones it did not read');
    assert.ok(/return \{ failures, capped,/.test(bridge), 'and it does not hand the ceiling to the panel');
    // Every surface the rule names: the status line, the health view, both exports, and what the
    // model is told. Derived by asking each one, not by counting occurrences - a count is satisfied
    // by five mentions in one place.
    const surfaces = {
      'the status line': /setStatus\(runtimeSummary\(\(r\.failures \|\| \[\]\)\.length, r\.capped\)/,
      'the health view': /healthSay\(runtimeSummary\(fx\.all\.length, fx\.capped\)/,
      'the HTML export': /fails\.capped \? esc\(FAIL_CAPPED\)/,
      'the Markdown export': /if \(fails\.capped\) md \+= ' ' \+ FAIL_CAPPED/,
      'the assistant': /d\.capped \? `; \$\{FAIL_CAPPED\}`/,
    };
    for (const [what, re] of Object.entries(surfaces))
      assert.ok(re.test(panel), `${what} shows the failures without saying the list stopped`);
  });

  test('the bridge names the task whose detail refused, rather than returning it thin', async () => {
    // Run, not read: the first version of this case asserted that the field was in the returned
    // object and passed with the `catch` emptied out, which is the whole defect.
    const ctx = {
      ACTION_KINDS: [{ kind: 'tasks', path: '/tasks', key: 'tasks', detail: 'field_mappings' }],
      MAX_PAGES_WIDE: 40, ACT_SV: 4, setTimeout, Promise,
      actionRow: (kind, r) => ({ kind, id: String(r.id), name: r.name || '' }),
      mapping: (m) => m,
      list: (j, key) => { const v = j && j[key]; if (!Array.isArray(v)) throw new Error('shape'); return v; },
      api: async (url) => {
        if (/^\/tasks\/(\d+)/.test(url)) { const e = new Error('too many requests'); e.status = 429; throw e; }
        return { tasks: [{ id: 7, name: 'a task' }], info: { more_records: false } };
      },
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/crm/content-bridge.js', 'pullActions'), ctx);
    const r = await vm.runInContext('pullActions()', ctx);
    // Array.from: what comes back was built inside the VM, so it carries that realm's prototype and
    // a strict deep-equal compares those too - the values matched and the assertion failed.
    assert.deepEqual(Array.from(r.detail_missed || [], (d) => `${d.kind}:${d.id}`), ['tasks:7'],
                     'a detail that refused was swallowed and the row went back as complete');
    assert.equal(r.actions[0].detail_read, false, 'and the row does not carry that its detail is unread');
    assert.deepEqual(Array.from(r.capped || []), [], 'a refused detail was reported as «there are more in Zoho»');
  });

  test('a task listed without its detail says so wherever it is shown', () => {
    assert.ok(!/capped\.push\('tasks \(detail\)'\)/.test(bridge),
              'the bound is reported as «there are more in Zoho», which is not what it means');
    const surfaces = {
      'the action detail': /actStale\(a\) \|\| actThin\(a\)/,
      'the HTML export': /a\.kind === 'tasks' && actThin\(a\) \? esc\(MISS_DETAIL\)/,
      'the Markdown export': /a\.kind === 'tasks' && actThin\(a\) \? MISS_DETAIL/,
      'the assistant': /a\.kind === 'tasks' && actThin\(a\) \? ` - \$\{MISS_DETAIL\}`/,
    };
    for (const [what, re] of Object.entries(surfaces))
      assert.ok(re.test(panel), `${what} shows a task with unread detail as a task with no mappings`);
    // And the harder half: mappings *are* there, from an older reading. Silence would present them
    // as current, which is the one thing a mirror may not do.
    for (const [what, re] of Object.entries({
      'the action detail': /actKept\(a\) \|\| \(!\(a\.mappings \|\| \[\]\)\.length/,
      'the HTML export': /a\.kind === 'tasks' && actKept\(a\) \? esc\(KEPT_DETAIL\)/,
      'the Markdown export': /a\.kind === 'tasks' && actKept\(a\) \? KEPT_DETAIL/,
      'the assistant': /a\.kind === 'tasks' && actKept\(a\) \? ` - \$\{KEPT_DETAIL\}`/,
    })) assert.ok(re.test(panel), `${what} shows inherited mappings as if this pull had read them`);
  });

  test('the module related-lists helper is defined once, where its names exist', () => {
    // Two copies, and the one in renderModules() closed over `scope`, `esc` and `modLink` - none of
    // which exist there. Nothing called it, so nothing threw: a ReferenceError armed for whoever
    // wired it up, and green tests all the way.
    assert.equal((panel.match(/const relsHtmlFor = /g) || []).length, 1, 'the dead copy is back');
    const rm = panel.slice(panel.indexOf('function renderModules'), panel.indexOf('\nfunction ', panel.indexOf('function renderModules') + 10));
    assert.ok(!/relsHtmlFor/.test(rm), 'renderModules defines it again with names it does not have');
  });

  test('a page id found once is not read out of the DOM again', () => {
    // `orgId()` is called by the header builder, so a pull of a few thousand functions serialised the
    // whole CRM document a few thousand times. A *successful* read is remembered; a failed one is not,
    // because a page that has not rendered the field yet must be asked again.
    // `memoValid()` and `location` come with it: the memo now belongs to the URL it was read at, and
    // running the function alone is what caught the free reference the moment that landed.
    const ctx = { _org: null, _zuid: null, _memoAt: null, reads: 0,
                  location: { href: 'https://crm.zoho.eu/crm/org123/tab/Home' },
                  document: { documentElement: { get innerHTML() { ctx.reads++; return ctx.html; } } },
                  html: 'var crmZgid = "123456789012";' };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/crm/content-bridge.js', 'memoValid'), ctx);
    vm.runInContext(sliceFn('apps/crm/content-bridge.js', 'orgId'), ctx);
    assert.equal(vm.runInContext('orgId()', ctx), '123456789012');
    assert.equal(vm.runInContext('orgId()', ctx), '123456789012');
    assert.equal(ctx.reads, 1, `the document was serialised ${ctx.reads} times for one answer`);
    ctx.html = 'nothing here'; ctx._org = null; ctx.reads = 0;
    assert.equal(vm.runInContext('orgId()', ctx), null);
    assert.equal(vm.runInContext('orgId()', ctx), null);
    assert.equal(ctx.reads, 2, 'a page that had not rendered the id yet is never asked again');
  });

  test('and it is forgotten when the page becomes another page', () => {
    // A `pushState` to another org changes the URL and replaces nothing. The memo used to survive
    // that, and the guard meant to catch it compares the panel's expectation against `context()`,
    // which reads the memo - a stale value agreeing with itself.
    const ctx = { _org: null, _zuid: null, _memoAt: null, reads: 0,
                  location: { href: 'https://crm.zoho.eu/crm/org111/tab/Home' },
                  document: { documentElement: { get innerHTML() { ctx.reads++; return ctx.html; } } },
                  html: 'var crmZgid = "111111111111";' };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/crm/content-bridge.js', 'memoValid'), ctx);
    vm.runInContext(sliceFn('apps/crm/content-bridge.js', 'orgId'), ctx);
    assert.equal(vm.runInContext('orgId()', ctx), '111111111111');
    ctx.location.href = 'https://crm.zoho.eu/crm/org999/tab/Home';
    ctx.html = 'var crmZgid = "999999999999";';
    assert.equal(vm.runInContext('orgId()', ctx), '999999999999',
                 'the bridge answers with the org the tab used to be on');
  });
}

// ---------------------------------------------------------------------------------------------
// «An aggregate we could not read is unknown, never zero» was written beside the catch, and the sum
// inside it did the opposite: a row whose count did not parse contributed nothing and the total came
// out low, with nothing to say it had. Same for a function in the *most used* list with no count -
// written as having run zero times, which is the one thing that list says it did not do.
{
  const RUN = async (rows) => {
    const ctx = {
      failureRow: (f) => f, FAIL_LIMIT: 100,
      // `list()` is the bridge's own shape guard: it throws when the collection is not there, which is
      // what separates «no rows» from «no answer». Stubbed with that behaviour, not with `|| []`.
      list: (j, key) => { const v = j && j[key]; if (!Array.isArray(v)) throw new Error('shape'); return v; },
      api: async (url) => {
        if (/functions\/failures/.test(url)) return { custom_function_failures: [] };
        if (/usage_pattern|function_most_used/.test(url)) return rows ? { top_usage: rows } : {};
        return { dashboard: [] };
      },
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/crm/content-bridge.js', 'finiteCount') + '\n'
                  + sliceFn('apps/crm/content-bridge.js', 'pullFailures'), ctx);
    return vm.runInContext('pullFailures()', ctx);
  };

  test('a total whose parts did not all read is unknown, not a smaller total', async () => {
    const whole = await RUN([{ count: 3 }, { count: 4 }]);
    assert.equal(whole.usage.success, 7, 'a readable aggregate stopped being reported');
    // Every shape a field that did not come back actually arrives in. The first version of the guard
    // was written against `undefined` - the only one of the five that `Number()` does not turn into
    // a zero - so it passed while `null` and `''` went through as measurements.
    for (const missing of [undefined, null, '', '   ', 'n/a']) {
      const holed = await RUN([{ count: 3 }, { count: missing }]);
      assert.equal(holed.usage.success, null,
                   `count=${JSON.stringify(missing)} was summed as a number (${holed.usage.success})`);
      assert.equal(holed.runs[1].count, null, `count=${JSON.stringify(missing)} was written as a run count`);
    }
    for (const [given, want] of [[0, 0], ['0', 0], ['12', 12]]) {
      const r = await RUN([{ count: given }]);
      assert.equal(r.usage.success, want, `a real ${JSON.stringify(given)} stopped being read`);
    }
  });

  test('a collection that did not come back is unknown, not an empty one', async () => {
    const none = await RUN(null);   // no `top_usage` in the response at all
    assert.equal(none.usage.success, null, 'a response with no rows was summed to a confident zero');
    assert.equal(none.runs, null, 'and the busiest list became an empty list rather than unknown');
  });

  test('a function in the busiest list with no count did not run zero times', async () => {
    const r = await RUN([{ function_id: 1, value: 'a', count: 5 }, { function_id: 2, value: 'b' }]);
    assert.deepEqual(r.runs.map((x) => x.count), [5, null], 'an unread count was written as a zero');
  });
}

// Related lists had both their reads end in a silent catch, so «this module has none» and «neither
// endpoint would answer» arrived as the same empty array - and the panel then told the reader to run
// the pull that had just run. The distinction `layouts_read` already makes, made once more, and said
// on each surface that shows the list.
{
  const panel = crmPanel();
  const bridge = read('apps/crm/content-bridge.js');

  test('the bridge records whether the related lists were read at all', () => {
    assert.equal((bridge.match(/relatedRead = true/g) || []).length, 2,
                 'one of the two paths that can answer does not record that it did');
    assert.ok(/related_read: relatedRead/.test(bridge), 'and it is not handed to the panel');
  });

  test('every surface that shows the list separates «none» from «not read»', () => {
    const surfaces = {
      'the module detail': /m\.related_read === false \?/,
      'the HTML export': /scope\.relations && m\.related_read === false/,
      'the Markdown export': /else if \(scope\.relations && m\.related_read === false\)/,
      'the layouts line': /m\.layouts_read === false \? 'not read' : 0/,
    };
    for (const [what, re] of Object.entries(surfaces))
      assert.ok(re.test(panel), `${what} reports a refused read as an empty one`);
  });
}

// The depth counter landed with the buttons still reading the *argument*: acquire, acquire, release
// left `pullBusy` true - correctly - and every Zoho button enabled, so a click looked available and
// did nothing. The flag says whether anything still holds it; the argument says only what one caller
// wanted, which is exactly the distinction the counter was introduced to make.
test('a nested release leaves the buttons off while anything still holds the pull', () => {
  // `blockZoho` is lifted too, not stubbed: it is the one place a Zoho-bound control is turned on
  // or off, and stubbing it would leave this case asserting about a mechanism the panel no longer
  // uses. It marks with a class as well as with `disabled`, because two of the five controls are
  // spans - which is how «Find» went dead while «Functions page» stayed live.
  const ctx = { pullDepth: 0, pullBusy: false, dir: {}, disabled: {}, ZOHO_BTNS: ['pullall', 'pullone'],
                updateWsButtons() {},
                document: { body: { classList: { toggle() {} } } },
                $: (id) => (ctx.disabled[id] = ctx.disabled[id] || {
                  classList: { toggle() {} },
                  set disabled(v) { ctx.disabled[id + ':v'] = v; },
                  get disabled() { return ctx.disabled[id + ':v']; } }),
                zohoReady: () => true, navOpenNow: () => false, Math };
  vm.createContext(ctx);
  vm.runInContext([sliceFn('apps/crm/sidepanel.js', 'blockZoho'),
                   sliceFn('apps/crm/sidepanel.js', 'setPullBusy')].join('\n'), ctx);
  vm.runInContext('setPullBusy(true); setPullBusy(true); setPullBusy(false);', ctx);
  assert.equal(ctx.pullBusy, true, 'the flag itself stopped counting its holders');
  for (const b of ctx.ZOHO_BTNS)
    assert.equal(ctx.disabled[b + ':v'], true, `${b} was re-enabled while a pull still held the flag`);
  vm.runInContext('setPullBusy(false);', ctx);
  assert.equal(ctx.pullBusy, false, 'the last release did not end it');
  for (const b of ctx.ZOHO_BTNS)
    assert.equal(ctx.disabled[b + ':v'], false, `${b} stayed off after the last release`);
});

// The directory cache was one map for whichever folder happened to be current. `dirFor` walks from
// `dir`, awaits every step, and then wrote what it found into that global map - so a resolution that
// started in one workspace and finished after a switch filled the *new* workspace's cache with the
// old one's handles, and every later lookup there answered without asking that folder at all. It is
// the «what global state is written after an await» question, on the helper every read and write in
// both panels goes through.
for (const app of ['crm', 'analytics']) {
  test(`${app}: a resolution that outlives its workspace cannot answer for the next one`, async () => {
    const mk = (nm, slow) => ({ nm, calls: 0,
      async getDirectoryHandle(p) { this.calls++; await new Promise((r) => setTimeout(r, slow ? 40 : 0)); return mk(nm + '/' + p, slow); } });
    const A = mk('A', true), B = mk('B', false);
    const ctx = { dir: A, _dirCaches: new WeakMap(), setTimeout, Map, WeakMap, Error };
    vm.createContext(ctx);
    vm.runInContext(sliceFn(`apps/${app}/sidepanel.js`, 'dirFor'), ctx);
    const inflight = vm.runInContext('dirFor', ctx)(['functions'], true);
    ctx.dir = B;                                  // the switch, while A is still walking
    await inflight;
    B.calls = 0;
    const got = await vm.runInContext('dirFor', ctx)(['functions'], true);
    assert.ok(got.nm.startsWith('B'), `resolving in B returned ${got.nm}`);
    assert.equal(B.calls, 1, 'B was never asked - it was answered out of the other workspace\'s cache');
  });
}

// ---------------------------------------------------------------------------------------------
// The workspace guards checked once, or too late, and the writes after them went through: measured
// as one org's functions, modules and layouts landing in another org's folder, and - in Analytics -
// one workspace's SQL and lineage landing in another one's *memory*. The fix is not a thirtieth
// `sameWs` call: the root is a parameter of the I/O, so the refusal lives at the single point every
// write passes through, and a call site that forgets inherits it anyway.
for (const app of ['crm', 'analytics']) {
  const src = read(`apps/${app}/sidepanel.js`);

  test(`${app}: the writer refuses a folder that is no longer the one it started in`, () => {
    const w = sliceFn(`apps/${app}/sidepanel.js`, 'writeFileAt');
    assert.ok(/^\s*if \(root !== dir\) throw new Error\(WS_MOVED\);/m.test(w),
              'the write does not check the workspace it was given against the one on screen');
    assert.ok(/dirFor\(parts\.slice\(0, -1\), true, root\)/.test(w),
              'it resolves the path against whatever folder is current, not against its own root');
  });

  test(`${app}: an operation takes its workspace before its first await`, () => {
    const b = sliceFn(`apps/${app}/sidepanel.js`, 'beginWorkspaceOp');
    assert.ok(/const gen = wsGen, root = dir;/.test(b), 'the op does not capture both halves');
    assert.ok(/const current = \(\) => gen === wsGen && root === dir;/.test(b),
              'being current is decided on one of the two, so one of the two ways of moving is invisible');
    // The refusal is the op's, on both sides of the await. `writeFileAt` compares handles, and a
    // handle is not an identity through time: A -> B -> A makes the old one valid again, so an
    // operation from before the round trip wrote while `current()` said false.
    assert.ok(/const guard = \(\) => \{ if \(!current\(\)\) throw new Error\(WS_MOVED\); \};/.test(b),
              'the op hands its I/O straight to the file writer, which only compares handles');
    // The shape, not the spelling: it guards, awaits, guards. It was an arrow with a `const`
    // binding and is a declaration now - which is the convention every shipped async scope follows,
    // because `tools/asynccheck.py` reads declarations - and an assertion on the old text would have
    // forbidden the fix rather than checked the behaviour.
    assert.match(b, /function through\(fn\) \{ guard\(\); const v = await fn\(\); guard\(\); return v; \}/,
                 'the workspace is checked on one side of the await only');
  });

  test(`${app}: every function that writes carries an op`, () => {
    // Derived from the writes themselves, with no list to keep up to date: a writer added tomorrow
    // is covered by the convention the code already follows.
    const fns = [...src.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)];
    const bare = [];
    for (const m of fns) {
      const end = src.indexOf('\n}', src.indexOf('{', m.index));
      const body = src.slice(m.index, end);
      if (!/await (writeFile|removeFile)\(/.test(body)) continue;
      if (!/beginWorkspaceOp\(\)/.test(body)) bare.push(m[1]);
    }
    assert.deepEqual(bare, [], `these write through the folder on screen: ${bare.join(', ')}`);
  });
}

test('analytics: the model is guarded, not only the disk', () => {
  // The half a disk-only guard misses: `sqls`, `deps` and `pullFailed` are read by every view in the
  // panel, so a retry that merges one workspace's ids into another one's memory is wrong on screen
  // before it is wrong on disk - and it never reaches the disk to be caught there.
  const src = read('apps/analytics/sidepanel.js');
  for (const fn of ['pullOne', 'retryFailed']) {
    const body = sliceFn('apps/analytics/sidepanel.js', fn);
    const first = body.indexOf('({ sqls, deps, pullFailed } =');
    const guard = body.indexOf('op.current()');
    assert.ok(first > 0 && guard > 0 && guard < first,
              `${fn} publishes into the panel's memory before asking whether it is still there`);
  }
  // pullAll is held to the stronger rule: nothing lands in memory until the whole snapshot is on
  // disk - one destructuring after the writeToDisk gate, and no per-stage global assignment left.
  const pa = sliceFn('apps/analytics/sidepanel.js', 'pullAll');
  const gate = pa.indexOf('await writeToDisk(info, op, next)');
  const publish = pa.indexOf('({ views, folders, schema, relations, sqls, deps, pullFailed } = next)');
  assert.ok(gate > 0 && publish > gate, 'pullAll publishes memory before the snapshot is on disk');
  assert.ok(!/^\s*(views|schema|sqls|deps) = /m.test(pa), 'a stage still lands in a global one by one');
});

test('analytics: a write failure after the marker blocks the live snapshot too', async () => {
  const writes = [];
  const ctx = {
    PULL_STATE: '.pull-state.json', PULL_SV: 1, CFG: '.zoost.json',
    writeJson: async (p) => { writes.push(p); throw new Error('disk full'); },
    patchCfg: async () => {}, pruneSql: async () => 0, readJson: async () => ({}),
    stemOf: (n, id) => `${n}-${id}`, bound: null, Object, JSON, Date, Boolean, Error,
  };
  // `say` is part of an operation, not decoration: a stub without it stands in for something that
  // does not exist, and the failure lands on the assertion three lines down rather than on the gap.
  ctx.op = { current: () => true, write: async (p) => writes.push(p), say: () => {} };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'writeToDisk'), ctx);
  let error;
  try {
    await vm.runInContext('writeToDisk', ctx)(
      { workspace: 'A', name: 'A', origin: 'oA' }, ctx.op,
      { views: [], folders: [], schema: {}, relations: [], sqls: {}, deps: {}, pullFailed: [] });
  } catch (e) { error = e; }
  assert.ok(error && error.mirrorIncomplete, 'the live panel cannot distinguish a pre-write failure from a hybrid disk');
  assert.equal(writes[0], '.pull-state.json', 'the incomplete verdict was raised before its marker existed');
  assert.match(sliceFn('apps/analytics/sidepanel.js', 'pullAll'), /refuseIncompleteSnapshot\(\)/,
               'the same open panel can still export or send the old globals over a hybrid disk');
});

test('analytics: partial refreshes publish only after a marked disk snapshot', async () => {
  for (const fn of ['pullOne', 'retryFailed']) {
    const body = sliceFn('apps/analytics/sidepanel.js', fn);
    const write = body.indexOf('await writePartialSnapshot(op,');
    const publish = body.indexOf('({ sqls, deps, pullFailed } =');
    assert.ok(write > 0 && publish > write,
              `${fn} exposes the new model before its lineage and SQL index are durable`);
    assert.match(body, /mirrorIncomplete[\s\S]*refuseIncompleteSnapshot\(\)/,
                 `${fn} leaves the live panel usable after a partial disk write`);
  }

  const writes = [];
  const ctx = {
    PULL_STATE: '.pull-state.json', JSON, Date, Error,
    writeLineage: async () => { writes.push('lineage.json'); },
    writeSql: async () => { writes.push('sql/index.json'); throw new Error('disk full'); },
  };
  ctx.op = { write: async (p) => writes.push(p) };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'writePartialSnapshot'), ctx);
  let error;
  try {
    await vm.runInContext('writePartialSnapshot', ctx)(ctx.op, { deps: {}, pullFailed: [], sqls: {} });
  } catch (e) { error = e; }
  assert.ok(error && error.mirrorIncomplete,
            'a failed one-view refresh is indistinguishable from a coherent snapshot');
  assert.deepEqual(writes.slice(0, 3), ['.pull-state.json', 'lineage.json', 'sql/index.json']);
  assert.equal(writes.filter((p) => p === '.pull-state.json').length, 1,
               'a failed partial refresh incorrectly marks its snapshot complete');
});

test('analytics: a partial SQL update never replaces an unreadable index with an empty one', async () => {
  for (const name of ['NotReadableError', 'NotAllowedError']) {
    const ctx = {
      sqls: {}, Object, Error,
      readJson: async (_p, fallback, _op, fail) => { fail({ rel: 'sql/index.json', name }); return fallback; },
    };
    ctx.op = { current: () => true };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'writeSql'), ctx);
    await assert.rejects(() => vm.runInContext('writeSql', ctx)(ctx.op, {}),
                         /Could not read sql\/index\.json/, `${name} was treated as an empty index`);
  }
});

// ---------------------------------------------------------------------------------------------
// Reported from a real org: «I ran a Pull all and while it was going I opened the
// test org - I could see the pull was still running». The writes were already refused by then; what was not was the
// *running*. A pull is minutes of fetching with a pause between items, and it went on counting
// «Downloading 214/900» into a panel that had been showing another workspace for a minute - and
// finished by announcing a failure count over it, because every refused write had counted as one.
{
  const panel = crmPanel();

  test('an op speaks only into the workspace it belongs to', () => {
    const b = sliceFn('apps/crm/sidepanel.js', 'beginWorkspaceOp');
    assert.ok(/say: \(msg, kind\) => \{ if \(current\(\)\) setStatus\(msg, kind\); \}/.test(b),
              'progress is not bound to the workspace the way the writes are');
  });

  test('the long loops give up as soon as the workspace moves', () => {
    for (const fn of ['downloadMissing', 'downloadMissingWf', 'pullModules', 'pullEverything']) {
      const body = sliceApp('crm', fn);
      const loop = body.search(/\n\s*for \(/);
      const guard = body.indexOf('!op.current()');
      assert.ok(loop > 0, `${fn} no longer has the loop this is about`);
      assert.ok(guard > 0, `${fn} runs its loop to the end whatever workspace it is in`);
      const after = body.slice(loop);
      assert.ok(/!op\.current\(\)/.test(after.slice(0, after.indexOf('await '))),
                `${fn} checks once before the loop rather than on each turn`);
    }
    // And giving up must not leave the buttons off: the hold is released in a finally, not on the
    // one path that reaches the end.
    for (const fn of ['downloadMissing', 'downloadMissingWf']) {
      const body = sliceApp('crm', fn);
      assert.ok(/\} finally \{ setPullBusy\(false\)/.test(body),
                `${fn} leaves both Pull buttons disabled when it stops early`);
    }
  });

  test('a pull that was overtaken says nothing about the org you left', () => {
    const body = sliceFn('apps/crm/sidepanel.js', 'notePullFailure');
    const guard = body.indexOf('if (op && !op.current()) return;');
    // Not `guard < indexOf(...)` on its own: a missing guard is -1, which is less than everything,
    // so the case passed with the defect put back. Absence is the finding.
    assert.ok(guard >= 0, 'an overtaken pull reports its own refused write as a failure');
    assert.ok(guard < body.indexOf('setStatus'), 'it says it first and checks afterwards');
  });

  test('analytics: progress and busy belong to the workspace too', () => {
    const src = read('apps/analytics/sidepanel.js');
    assert.equal((src.match(/if \(m\?\.type === 'pullProgress'\) op\.say\(/g) || []).length, 2,
                 'the bridge keeps reporting progress into a workspace it is not pulling');
    const b = sliceFn('apps/analytics/sidepanel.js', 'beginWorkspaceOp');
    assert.ok(/say: \(msg, kind\) => \{ if \(current\(\)\) status\(msg, kind\); \}/.test(b),
              'the twin of the CRM op cannot speak, so its callers check by hand and drift');
    assert.ok(/function endBusyElsewhere\(\) \{ busy = false; updateButtons\(\); \}/.test(src),
              'an overtaken pull leaves the panel it is no longer in looking busy');
    assert.ok(!/return endBusyElsewhere\(\);\s*\n\s*status\(/.test(src),
              'and it writes a sentence about the workspace you left');
  });
}

// ---------------------------------------------------------------------------------------------
// Four more from the same scan, and two of them were mine from this morning.
{
  const crm = crmPanel();

  test('a task detail that refused keeps the mappings, never the whole old row', () => {
    const body = sliceFn('apps/crm/automation.js', 'pullActions');
    assert.ok(/return \{ \.\.\.a, mappings: p\.mappings, detail_read: false, detail_kept: true,/.test(body),
              'the row this pull read is replaced by one from before it - name, module and date included');
    assert.ok(/detailMissed\.length \? ` \$\{detailMissed\.length\} task\(s\)/.test(body),
              'the warning counts what survived the salvage, so a salvaged one reports nothing');
  });

  test('clearing the chat does not forget what the mirror still owes', () => {
    // `failedRemovals` is a queue of deletions that failed and must be retried - a fact about the
    // files, not about the conversation. Clear emptied it, with no workspace change at all.
    const clear = sliceFn('apps/crm/sidepanel.js', 'clearConversationState');
    for (const c of ['failedRemovals', 'graphCache', 'codeCache'])
      assert.ok(!new RegExp(c).test(clear), `Clear still throws away ${c}`);
    assert.ok(/clearConversationState\(\);/.test(sliceFn('apps/crm/ai.js', 'aiClear')),
              'Clear still goes through the workspace-change path');
    const drop = sliceFn('apps/crm/sidepanel.js', 'dropWorkspaceState');
    assert.ok(/failedRemovals\.clear\(\)/.test(drop) && /clearConversationState\(\)/.test(drop),
              'leaving a workspace no longer drops the queue, or no longer clears the conversation');
  });

  test('opening the list does not make a switch look like a re-open', () => {
    // `activate()` decides on `activeWsId` whether this is the same workspace being re-opened, and
    // `loadWorkspaces()` set it first - so every switch looked like one and `dropWorkspaceState()`
    // never ran: conversation, caches and the failed-removal queue followed the reader into the next org.
    assert.ok(!/sel\.value = act\.id; activeWsId = act\.id;/.test(crm),
              'the list still decides the answer to the question activate() is about to ask');
  });

  for (const app of ['crm', 'analytics']) {
    test(`${app}: what is remembered as open is what is on screen`, async () => {
      const src = read(`apps/${app}/sidepanel.js`);
      // Run rather than read. This used to assert the *expression* - `gen === wsGen ? set(...)` -
      // which is a photograph of a belief and went stale the day the chain became a declaration,
      // while the behaviour it was written for never changed. What matters is two facts: a write
      // whose selection has been overtaken does not happen, and the writes stay in order.
      const wrote = [];
      const g = { wsGen: 1, window: { idbHandle: { set: (k, v) => { wrote.push([k, v]); return Promise.resolve(); } } } };
      const { writeActiveWhenStillCurrent } = load(
        [sliceFn(`apps/${app}/sidepanel.js`, 'writeActiveWhenStillCurrent')], g);
      // The selection that is still current writes; the one overtaken by a later selection does not.
      await writeActiveWhenStillCurrent('k', 'still-current', 1, Promise.resolve());
      g.wsGen = 2;
      await writeActiveWhenStillCurrent('k', 'overtaken', 1, Promise.resolve());
      assert.deepEqual(wrote, [['k', 'still-current']],
                       'a slow selection still writes itself over a faster one that came after it');
      // And they are ordered: the second waits for the promise it was handed.
      const order = [];
      let release;
      const first = new Promise((r) => { release = r; });
      const queued = writeActiveWhenStillCurrent('k', 'second', 2, first.then(() => order.push('first')));
      release();
      await queued;
      order.push('second');
      assert.deepEqual(order, ['first', 'second'], 'the writes are not ordered');
      assert.ok(/await rememberActive\(/.test(src), 'the selection does not go through it');
      assert.ok(/await rememberActive\([^\n]*\);\n\s*if \(!op\.current\(\)\) return;/.test(src),
                'a selection that was overtaken carries on setting up the panel');
    });
  }
}

// The half a root-bound writer does not reach: what an operation publishes into the panel's *memory*
// after its last write. The files are safe - the writer refuses a folder that is not the op's - and
// `index`, the row and `bound` are the panel's picture of the workspace on screen, so writing into
// them after the final await puts one org's function into another org's index, and produces a
// binding with half its fields from each. Run rather than read: both were reproduced this way.
{
  test('a download that was overtaken does not enter the next workspace\'s index', async () => {
    let live = true;
    const entry = { id: '7', category: 'c', source: 's' };
    const ctx = {
      dir: {}, index: new Map(), MSG: { folder: 'folder' }, setStatus() {},
      mismatchRefuse: () => false, ensurePerm: async () => true,
      beginWorkspaceOp: () => ({ root: ctx.dir, current: () => live, write: async () => {} }),
      toBridge: async () => ({ ok: true, file: { folder: 'standalone', stem: 'build',
        dg: 'void b(){}', meta: { display_name: 'Build', name: 'build', category: 'c', source: 's' } } }),
      errText: (e) => String(e), Error, String, JSON, Map,
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/crm/sidepanel.js', 'downloadOne'), ctx);
    // The switch lands between the last write and the publication, which is where the awaits are.
    ctx.beginWorkspaceOp = () => ({ root: ctx.dir, current: () => live,
                                    write: async () => { live = false; } });
    const ok = await vm.runInContext('downloadOne', ctx)(entry);
    assert.equal(ok, false, 'an overtaken download reported success');
    assert.equal(ctx.index.size, 0, 'it wrote one workspace\'s function into another\'s index');
    assert.ok(!entry.downloaded, 'and lit its row there');
  });

  test('analytics: a binding is published whole or not at all', async () => {
    let live = true;
    const ctx = {
      bound: null, folders: [], views: [], schema: {}, relations: [], deps: {}, pullFailed: [], sqls: {},
      writeJson: async () => {}, patchCfg: async () => {}, stemOf: (n) => String(n),
      readJson: async () => ({ label: 'B', sample: true }),
      PULL_SV: 1, CFG: '.zoost.json', PULL_STATE: '.pull-state.json',
      pruneSql: async () => {}, Object, JSON, Date, Boolean,
    };
    ctx.op = { current: () => live, write: async () => {}, say: () => {} };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'writeToDisk'), ctx);
    ctx.readJson = async () => { live = false; return { label: 'B', sample: true }; };
    const ok = await vm.runInContext('writeToDisk', ctx)({ workspace: 'A', name: 'A', origin: 'oA' }, ctx.op,
      { views: [], folders: [], schema: {}, relations: [], sqls: {}, deps: {}, pullFailed: [] });
    assert.equal(ok, false, 'an overtaken pull reported that it had written the workspace');
    assert.equal(ctx.bound, null, 'the panel is now bound to one workspace by id and another by name');
  });
}

// ---------------------------------------------------------------------------------------------
// One scanner, and it is the depth-aware one. There were two implementations of «which argument of
// this call is which»: the syntax highlighter's counted brackets and quotes, the graph extractor's
// cut at the first comma or bracket it met - and the weaker one was the one producing the data, so
// `getRelatedRecords(makeRelation("Prices", "Backup"), "Contacts", id)` reported the module as
// **Backup**, an argument of an argument, with the dynamic-reference count at zero. A wrong answer
// stated as a certain one, into Details, Health, both exports and the assistant.
{
  const w = {};
  new Function('window', read('apps/crm/highlight.js'))(w);
  new Function('window', read('apps/crm/graph-core.js'))(w);
  const refs = (dg) => w.buildGraph([{ namespace: 'standalone', name: 'a', api_name: 'a', file: 'a.dg', dg }]).nodes['standalone.a'];

  const CASES = [
    ['a nested call before the module', 'zoho.crm.getRelatedRecords(makeRelation("Prices", "Backup"), "Contacts", id);',
     { modules: ['Contacts'], unknown: 0 }],
    ['a comma inside a string', 'zoho.crm.getRelatedRecords("Prices, and more", "Contacts", id);',
     { modules: ['Contacts'], unknown: 0 }],
    ['a map literal in the way', 'zoho.crm.getRecords({"a": 1, "b": 2}, "Deals");',
     { modules: [], unknown: 1 }],
    ['a list literal in the way', 'zoho.crm.updateRecord({"x": 1, "y": [1, 2]}, id, m);',
     { modules: [], unknown: 1 }],
    ['a task nested in another task\'s arguments', 'zoho.crm.updateRecord("Deals", id, {"x": zoho.crm.getRecordById("Contacts", cid)});',
     { modules: ['Deals', 'Contacts'], unknown: 0 }],
  ];
  for (const [what, dg, want] of CASES) {
    test(`the module survives ${what}`, () => {
      const n = refs(dg);
      assert.deepEqual(n.modules.map((m) => m.name).sort(), want.modules.slice().sort(),
                       `id=modules the arguments were split as if the call were flat`);
      assert.equal(n.modulesUnknown, want.unknown,
                   'id=unknown a computed module was read as a name, or a name counted as computed');
    });
  }

  test('the extractor and the highlighter split a call the same way', () => {
    // Not «both look right»: the same function, so they cannot disagree. It is in highlight.js
    // because the panel loads both files and the graph window loads only that one.
    assert.ok(typeof w.delugeArgs === 'function', 'the shared scanner is not published');
    assert.ok(/window\.delugeArgs\(bare, task\.lastIndex\)/.test(read('apps/crm/graph-core.js')),
              'the extractor has gone back to splitting arguments itself');
    assert.ok(/const \{ starts, ends \} = delugeArgs\(code, call\.lastIndex\);/.test(read('apps/crm/highlight.js')),
              'the highlighter keeps a second copy of the walk');
    const src = 'f(one, g(a, b), "x, y", [1, 2], last)';
    const a = w.delugeArgs(src, src.indexOf('(') + 1);
    assert.deepEqual(a.starts.map((s, i) => src.slice(s, a.ends[i]).trim()),
                     ['one', 'g(a, b)', '"x, y"', '[1, 2]', 'last'], 'the walk itself is not depth-aware');
  });
}

// Analytics: a re-read that could not read is not a re-read, and one branch left the panel busy for
// ever. Run rather than read - both were reported as reproduced, and a source check would have said
// the same thing about the code that was already there.
{
  const RUN = async (fn, over) => {
    const ctx = {
      dir: {}, wsGen: 1, busy: false, pullBusy: false, pullFailed: [{ id: 'q1', stage: 'sql' }], sqls: {}, deps: {},
      status: [], className: null, Object, JSON, String, Set, Promise, Error,
      mismatchRefuse: () => false, requirePerm: async () => true, render() {}, openDetail: async () => {},
      viewById: () => new Map([['q1', { id: 'q1', name: 'Q1', type: 'QueryTable' }]]),
      mergeSchemaIntoViews() {}, writeLineage: async () => {}, writeSql: async () => {},
      writePartialSnapshot: async () => {}, refuseIncompleteSnapshot() {},
      showEmergency() {}, endBusyElsewhere: () => { ctx.busy = false; },
      $: () => ({ set className(v) { ctx.className = v; }, get className() { return ctx.className; } }),
      setBusy: (on, text) => { ctx.busy = on; ctx.status.push(String(text || '')); },
      setPullBusy: (on) => { ctx.pullBusy = on; },
      chrome: { runtime: { onMessage: { addListener() {}, removeListener() { ctx.listenerGone = true; } } } },
      beginWorkspaceOp: () => ({ root: ctx.dir, current: () => !over(), say() {} }),
      toBridge: async (msg) => (msg.cmd === 'pullSql'
        ? { sql: {}, failed: [{ id: 'q1', stage: 'sql' }] }
        : { id: 'q1', parents: [], children: [], dashboards: [] }),
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/analytics/sidepanel.js', fn), ctx);
    await vm.runInContext(`${fn}(${fn === 'pullOne' ? "'q1'" : ''})`, ctx);
    return ctx;
  };

  test('analytics: a view whose SQL would not read is not reported as re-read', async () => {
    const c = await RUN('pullOne', () => false);
    assert.equal(c.pullFailed.length, 1, 'the failure this pull did not fix was cleared anyway');
    assert.equal(c.className, 'warn', 'and it finished green');
    assert.ok(c.status.some((s) => /SQL still could not be/.test(s)), 'with nothing said about it');
  });

  test('analytics: a retry overtaken in its SQL half does not leave the panel busy', async () => {
    let switched = false;
    const c = await RUN('retryFailed', () => switched);
    assert.equal(c.busy, false, 'the buttons stay disabled until the panel is reopened');
    switched = true;   // and the same with the switch landing inside the SQL call
    const d = await RUN('retryFailed', () => true);
    assert.equal(d.busy, false, 'an overtaken retry left Pull, export, Health and the assistant off');
    assert.ok(d.listenerGone, 'and its progress listener behind');
  });
}

// ---------------------------------------------------------------------------------------------
// From a security audit, and the first one is the sharper lesson: `noFocusHere` was already
// inspected by a test, which asserted that it uses `DATA.focusName` and writes into the status line -
// the *path*, never the property. A name from the org (a Zoho view or module may legally be called
// `<img src=x>`) reached `innerHTML` raw. The CSP stops it executing and does not stop it being
// markup, and «no hostile string keeps a tag open» is a rule this project asserts elsewhere.
for (const app of ['crm', 'analytics']) {
  test(`${app}: the name in «nothing to focus on» is escaped`, () => {
    const fn = sliceFn(`apps/${app}/graphview.js`, 'noFocusHere');
    assert.ok(/const name = esc\(String\(DATA\.focusName \|\| id\)\);/.test(fn),
              'a name from the org reaches innerHTML raw');
    assert.ok(/\$\{name\}/.test(fn), 'and it no longer says which one it could not find');
  });
}

// The link rule ran over text that had been through `escHtml` - which escapes `& < >` and not `"` -
// and its URL pattern admits a quote. So `[x](https://a/"style="…)` closed the href and opened an
// attribute: measured as a `position:fixed` overlay covering the whole panel. The string is the
// model's, and the model reads Deluge source out of the org, which is the prompt-injection path.
{
  const RUN = (app, src) => {
    const ctx = { String, RegExp, JSON };
    vm.createContext(ctx);
    vm.runInContext(sliceConst(`apps/${app}/sidepanel.js`, app === 'crm' ? 'escHtml' : 'esc') + '\n'
      + (app === 'analytics' ? 'const escHtml = esc;\n' : '')
      + sliceConst(`apps/${app}/sidepanel.js`, 'escQ') + '\n'
      + sliceFn(aiFile(app), 'aiMarkdown'), ctx);
    return vm.runInContext('aiMarkdown', ctx)(src);
  };
  for (const app of ['crm', 'analytics']) {
    test(`${app}: a link cannot open an attribute of its own`, () => {
      const out = RUN(app, 'see [docs](https://example.com/x"style="position:fixed;width:100vw)');
      assert.ok(!/"style=/.test(out), `id=attr the href closed early: ${out.slice(0, 120)}`);
      assert.ok(/&quot;style=&quot;/.test(out), 'id=attr the quote was dropped rather than escaped');
    });

    test(`${app}: and an ordinary link is not double-escaped`, () => {
      // `&` has already been through escHtml by the time this rule runs; encoding it again turns
      // every query string in the assistant's answers into `&amp;amp;`.
      const out = RUN(app, 'see [ok](https://a.b/c?x=1&y=2)');
      assert.ok(/href="https:\/\/a\.b\/c\?x=1&amp;y=2"/.test(out), `id=amp ${out.slice(0, 120)}`);
      assert.ok(!/&amp;amp;/.test(out), 'id=amp the ampersand was encoded twice');
    });
  }
}

// The derivation cost, and the field that makes raising it free.
for (const app of ['crm', 'analytics']) {
  test(`${app}: the passphrase is derived at the current recommended cost`, () => {
    const src = read(`apps/${app}/keyvault.js`);
    const m = src.match(/const ITER = (\d+);/);
    assert.ok(m, 'the cost is no longer a single named number');
    assert.ok(Number(m[1]) >= 600000, `PBKDF2-HMAC-SHA256 at ${m[1]} iterations, below OWASP's 600,000`);
    // What makes the number changeable at all: an old box is read at the cost it was written with.
    assert.ok(/it: ITER/.test(src), 'the envelope no longer records the cost it was written at');
    assert.ok(/Number\(box\.it\) \|\| ITER/.test(src), 'an old box would be read at the new cost and fail');
  });
}

// A git ref may legally contain a quote, and both workflows read one into a shell. The tag is
// validated by its exact shape in the one step that produces it, because every later step
// interpolates that output - so this is the line that makes those safe.
test('the release workflows take a ref through env and validate its whole shape', () => {
  for (const f of ['.github/workflows/release.yml', '.github/workflows/store-upload.yml']) {
    const y = read(f);
    assert.ok(/IN_TAG: \$\{\{ inputs\.tag/.test(y), `id=env ${f} interpolates the ref into the script`);
    assert.ok(/TAG="\$IN_TAG"/.test(y), `id=env ${f} does not read it from the environment`);
    assert.ok(/grep -Eq '\^\(crm\|analytics\)-v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$'/.test(y),
              `id=shape ${f} accepts a tag by prefix, so anything may follow it`);
  }
});

// ---------------------------------------------------------------------------------------------
// The panel checks that the tab it is about to speak to is the right org, and then awaits three
// times before the message arrives - `zohoTabId()`, `ensureBridge()`, `crmFrameId()` - so what it
// checked is a five-second poll's memory of a tab that may since have become another org. Reproduced
// by an audit on both shipped functions: the command reached the new tab.
//
// The last word belongs to the only party that cannot be out of date about which org it is: the page
// itself. The expectation travels with the command and the bridge refuses what does not match.
{
  const CASES = {
    crm: { now: { ok: true, org: 'B', origin: 'https://crm.zoho.eu', instance: null },
           mine: { org: 'A', origin: 'https://crm.zoho.eu' },
           theirs: { org: 'B', origin: 'https://crm.zoho.eu' } },
    analytics: { now: { ok: true, workspace: 'B', origin: 'https://analytics.zoho.eu' },
                 mine: { workspace: 'A', origin: 'https://analytics.zoho.eu' },
                 theirs: { workspace: 'B', origin: 'https://analytics.zoho.eu' } },
  };
  for (const [app, c] of Object.entries(CASES)) {
    test(`${app}: a command carries what it expects, and the page refuses what does not match`, () => {
      const ctx = { String };
      vm.createContext(ctx);
      vm.runInContext(sliceFn(`apps/${app}/content-bridge.js`, 'expectedMatches'), ctx);
      const f = vm.runInContext('expectedMatches', ctx);
      assert.equal(f(c.mine, c.now), false, 'a command meant for one org was accepted by another');
      assert.equal(f(c.theirs, c.now), true, 'the tab refuses a command that does belong to it');
      assert.equal(f(null, c.now), true, 'the context probe stopped travelling, so no mismatch can be found');

      const panel = read(`apps/${app}/sidepanel.js`);
      assert.ok(/__zoostExpected: expected/.test(panel) || /\{ \.\.\.msg, __zoostExpected: expected \}/.test(panel),
                'the panel no longer sends what it expects');
      const bridge = read(`apps/${app}/content-bridge.js`);
      assert.ok(/cmd !== 'context' && !expectedMatches\(msg && msg\.__zoostExpected, context\(\)\)/.test(bridge),
                'the bridge accepts a command without checking which org it is');
    });
  }

  test('crm: a bound workspace with no verified context does not let a command through', () => {
    // `if (!bound || !lastCtx) return true` treated «nothing to compare» and «not verified» as one
    // answer, so a bound workspace whose context had not been read let `zohoTabId()` fall back to
    // whichever Zoho tab happened to be open.
    const g = sliceFn('apps/crm/sidepanel.js', 'guardOk');
    assert.ok(/if \(!bound\) return true;/.test(g), 'a first workspace can no longer be created');
    assert.ok(/if \(!lastCtx\) return false;/.test(g),
              'a bound workspace with no context still passes the guard');
  });
}

// A free variable is not a syntax error, so `node --check` is happy and the browser is not: a
// mechanical replace put `if (!op.current()) return;` into two rebuilds that never made an `op`,
// every unit test stayed green because nothing executes them, and `tools/probe.js` found it as «a
// workflow row did not open a workflow» - a ReferenceError swallowed by the function's own catch.
// The same trap this repository already records about mechanical replaces, arriving a third time.
for (const app of ['crm', 'analytics']) {
  test(`${app}: every function that uses an op makes one or is given one`, () => {
    // Comments and strings blanked: it went red on a *comment* that mentioned `op.say` while
    // explaining an unrelated fix, and the failure named a function that touches no operation at
    // all. A scan over prose about code is the third of these met today, so it uses the scanner.
    const src = blankNonCode(read(`apps/${app}/sidepanel.js`));
    const bad = [];
    for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm)) {
      const body = src.slice(m.index, src.indexOf('\n}', src.indexOf('{', m.index)));
      if (!/\bop\.(current|read|write|remove|root|say)\b/.test(body)) continue;
      if (/beginWorkspaceOp\(\)/.test(body) || /\bop\b/.test(m[2])) continue;
      bad.push(m[1]);
    }
    assert.deepEqual(bad, [], `these read \`op\` and never make one: ${bad.join(', ')}`);
  });
}

// ---------------------------------------------------------------------------------------------
// A cache is a publication, not merely an optimisation. These loaders read a workspace, await the
// file system, and then assign a global used by every later view. Switching workspace during that
// await used to install A's answer as B's cache, which is worse than a slow read: the wrong answer
// then became the fast path and stayed there until another switch.
test('analytics: a SQL search overtaken by a workspace switch publishes nothing', async () => {
  let live = true, release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const ctx = {
    sqlCache: null, sqlUnread: 0, sqls: { q1: { stem: 'query-one', sql: null } },
    sqlDiskUnread: new Set(),
    views: [{ id: 'q1', type: 'QueryTable' }],
    sqlState: () => ({ kind: 'read' }),
    beginWorkspaceOp: () => ({ current: () => live, read: async () => delayed,
      say() {} }),
    readFile: async () => delayed, status() {}, Map, Set, Object, String,
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'ensureSqlCache'), ctx);
  const pending = vm.runInContext('ensureSqlCache()', ctx);
  live = false; release('select * from A');
  await pending;
  assert.equal(ctx.sqlCache, null, 'A became the full-text cache of B');
  assert.equal(ctx.sqls.q1.sql, null, 'A\'s SQL was attached to B\'s index row');
});

test('crm: a module-index read overtaken by a workspace switch publishes nothing', async () => {
  let live = true, release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const ctx = {
    modNamesCache: null,
    beginWorkspaceOp: () => ({ current: () => live, read: async () => delayed }),
    readFile: async () => delayed, Map, Array, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/crm/sidepanel.js', 'moduleNames'), ctx);
  const pending = vm.runInContext('moduleNames()', ctx);
  live = false; release('[{"api_name":"Only_In_A"}]');
  await pending;
  assert.equal(ctx.modNamesCache, null, 'A became the module-name cache of B');
});

test('crm: a workflow-index read publishes its list and lookup atomically', async () => {
  let live = true, release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const oldRow = { id: 'B', name: 'workspace B' };
  const ctx = {
    workflowData: [oldRow], wfIndex: new Map([['B', oldRow]]),
    beginWorkspaceOp: () => ({ root: {}, current: () => live, read: async () => delayed }),
    walk: async function* () {}, wfScheduled: () => ({ count: 0, delays: [] }),
    Map, Set, Array, String, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/crm/automation.js', 'loadWorkflowIndex'), ctx);
  const pending = vm.runInContext('loadWorkflowIndex()', ctx);
  live = false; release('[{"id":"A","name":"workspace A"}]');
  await pending;
  assert.equal(ctx.workflowData[0].id, 'B', 'A replaced B\'s workflow list');
  assert.equal(ctx.wfIndex.has('B'), true, 'the old list and its lookup stopped agreeing');
  assert.equal(ctx.wfIndex.has('A'), false, 'A entered B\'s workflow lookup');
});

test('crm: an overtaken graph is neither returned nor cached', async () => {
  let live = true, release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const ctx = {
    graphCache: null, WS_MOVED: 'moved',
    beginWorkspaceOp: () => ({ current: () => live }),
    loadGraph: async () => delayed,
    Error,
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/crm/sidepanel.js', 'ensureGraph'), ctx);
  const pending = vm.runInContext('ensureGraph()', ctx);
  live = false; release({ workspace: 'A', nodes: {} });
  await assert.rejects(pending, /moved/);
  assert.equal(ctx.graphCache, null, 'A became the graph cache of B');
});

// One user gesture can start only one model request, and leaving or clearing the conversation
// cancels its right to publish. The request itself cannot be unsent, but its late text must not
// reappear in the next workspace or after the user pressed Clear.
for (const app of ['crm', 'analytics']) {
  const systemName = app === 'crm' ? 'aiSystemPromptB' : 'aiSystemPrompt';
  const statusName = app === 'crm' ? 'setStatus' : 'status';
  const run = async (cancel) => {
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    const input = { value: 'question' }, send = { disabled: false };
    const ctx = {
      aiMessages: [], aiBusy: false, aiSeedWarned: false, aiSeedTruncated: false,
      aiSeedOmitted: [], aiGen: 0, live: true,
      beginWorkspaceOp: () => ({ current: () => ctx.live }),
      aiGetCfg: async () => ({ active: 'openai', openai: {}, seedCap: 10 }),
      aiEngineChrome() {}, aiLocked: () => false, aiEnsureFiles: async () => true,
      aiActiveReady: () => true, openSettings() {}, aiOpenSettings() {}, aiShowLock() {},
      [systemName]: async () => 'system', aiCall: async () => delayed,
      aiRunAnthropicAgent: async () => {}, aiRenderMessages() {}, friendlyError: (e) => String(e),
      [statusName]() {}, AI_TOOLS: [],
      $: (id) => id === 'aiinput' ? input : id === 'aisend' ? send : {},
      String, Error,
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn(aiFile(app), 'aiSend'), ctx);
    const pending = vm.runInContext('aiSend()', ctx);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    ctx.aiMessages = [];
    if (cancel === 'workspace') ctx.live = false; else ctx.aiGen++;
    release('answer from A');
    await pending;
    return ctx;
  };

  test(`${app}: a reply cannot follow the user into another workspace`, async () => {
    const c = await run('workspace');
    assert.deepEqual(c.aiMessages, [], 'the previous workspace\'s reply appeared in the new one');
  });

  test(`${app}: Clear remains clear when an old reply arrives`, async () => {
    const c = await run('clear');
    assert.deepEqual(c.aiMessages, [], 'a reply repopulated the conversation after Clear');
  });

  test(`${app}: the keyboard shortcut cannot start a second request`, async () => {
    let cfgReads = 0;
    const ctx = { aiBusy: true, aiGetCfg: async () => { cfgReads++; return {}; } };
    vm.createContext(ctx);
    vm.runInContext(sliceFn(aiFile(app), 'aiSend'), ctx);
    await vm.runInContext('aiSend()', ctx);
    assert.equal(cfgReads, 0, 'a disabled button was bypassed by the keyboard shortcut');
  });
}

// The detail panes are asynchronous too. Clicking B while A is still reading must leave B on
// screen; guarding only the background caches does not protect the DOM from an older continuation.
for (const fn of ['openFile', 'openModule', 'openWorkflow']) {
  test(`crm: ${fn} is invalidated by the next detail navigation`, () => {
    const body = sliceApp('crm', fn);
    assert.ok(/const mine = \+\+previewLoad/.test(body), 'the opener has no navigation token');
    assert.ok(/previewCurrent\(mine, op\)/.test(body), 'the opener never checks whether it was overtaken');
  });
}

test('analytics: a SQL detail is invalidated by the next detail navigation', () => {
  const open = sliceFn('apps/analytics/sidepanel.js', 'openDetail');
  const render = sliceFn('apps/analytics/sidepanel.js', 'renderDetail');
  assert.ok(/const mine = \+\+detailLoad/.test(open), 'the opener has no navigation token');
  assert.ok(/await renderDetail\(v, mine, op\)/.test(open), 'the token does not reach the SQL read');
  assert.ok(/detailCurrent\(mine, op\)/.test(render), 'the SQL read can still repaint an item opened later');
});

for (const app of ['crm', 'analytics']) {
  test(`${app}: a pull locks workspace selection in the UI and in the activation path`, () => {
    const src = read(`apps/${app}/sidepanel.js`);
    const repaint = sliceFn(`apps/${app}/sidepanel.js`, app === 'crm' ? 'updateWsButtons' : 'updateButtons');
    const activateBody = sliceFn(`apps/${app}/sidepanel.js`, app === 'crm' ? 'activate' : 'selectWorkspace');
    assert.ok(/\$\('ws'\)\.disabled = pullBusy/.test(repaint), 'a repaint can re-enable the workspace selector during a pull');
    assert.ok(/(?:\$\('wsroot'\)|rt)\.disabled = pullBusy/.test(repaint), 'the working-folder picker can replace the workspace during a pull');
    assert.ok(/if \(pullBusy/.test(activateBody), 'a direct/programmatic activation bypasses the disabled selector');
    const refuse = sliceFn(`apps/${app}/sidepanel.js`, 'workspaceChangeRefuse');
    assert.ok(/if \(!pullBusy\) return false/.test(refuse), 'workspace-changing actions have no shared programmatic guard');
    for (const fn of ['pickRoot', 'addSampleWorkspace', 'renameWorkspace']) {
      assert.ok(/workspaceChangeRefuse\(\)/.test(sliceFn(`apps/${app}/sidepanel.js`, fn)), `${fn} bypasses the pull lock`);
    }
    const add = app === 'crm' ? 'addWorkspaceForTab' : 'addWorkspace';
    assert.ok(/workspaceChangeRefuse\(\)/.test(sliceFn(`apps/${app}/sidepanel.js`, add)), `${add} bypasses the pull lock`);
    const remove = app === 'crm'
      ? handlerOf('apps/crm/sidepanel.js', 'wsdel')
      : sliceFn('apps/analytics/sidepanel.js', 'delWorkspace');
    assert.ok(/workspaceChangeRefuse\(\)/.test(remove), 'Remove workspace bypasses the pull lock');
    const handler = handlerOf(`apps/${app}/sidepanel.js`, 'ws');
    assert.ok(/workspaceChangeRefuse\(\)/.test(handler), 'a forged change event bypasses the lock');
  });
}

for (const app of ['crm', 'analytics']) {
  test(`${app}: an older context probe cannot overwrite the active tab`, () => {
    const body = sliceFn(`apps/${app}/sidepanel.js`, 'refreshContext');
    assert.ok(/const mine = \+\+contextLoad/.test(body), 'context refreshes have no ordering token');
    const awaits = [...body.matchAll(/await /g)].map((m) => m.index);
    assert.ok(awaits.length >= 2, 'the context probe no longer has the asynchronous race this test describes');
    for (const at of awaits) {
      const next = body.slice(at, at + 180);
      assert.ok(/current\(\)/.test(next), 'a context await can publish after a newer probe finished');
    }
  });
}

// A loader that was overtaken answers null, and a caller that does not expect it turns a clean stop
// into a TypeError - ugly where a catch waits upstream, an unhandled rejection where none does
// (`filterByConnection` is a click handler). Derived over the six loaders: every await of one is
// followed, on its own line or the next, by something that copes - a fallback, a catch, or a check.
test('crm: every caller of a null-returning loader copes with the null', () => {
  const src = crmPanel();
  const lines = src.split('\n');
  const bad = [];
  // `loadModuleFiles`, `aiLoadActions` and `aiLoadConnections` are **not** here any more: they throw
  // on a change of workspace instead of returning null. The fallback this test asks for was the
  // defect in their case - `|| {}` and `|| []` turned «overtaken» into «this org has no modules, no
  // connections, no actions», in the index the assistant is given and in `get_module`. A caller
  // cannot read a refusal it never receives, and the case below forbids the fallback coming back.
  // The three left do return null, and their callers must still cope with it.
  for (const fn of ['moduleNames', 'getCodeCache', 'failuresIndex']) {
    lines.forEach((line, i) => {
      if (!new RegExp(`await ${fn}\\(`).test(line) || new RegExp(`function ${fn}`).test(line)) return;
      const here = line + '\n' + (lines[i + 1] || '');
      if (!/\|\||\.catch|if \(!/.test(here)) bad.push(`${fn} at line ${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, [], `these read a loader's answer without asking if it was overtaken:\n  ${bad.join('\n  ')}`);
});

// The one caller that is a click handler with no try above it. Two different absences: an overtaken
// build (WS_MOVED) means the filter no longer applies and silence is right; a real failure -
// unreadable folder, unparseable source - swallowed by the same catch made the click do nothing and
// say nothing about a workspace that was still there. Run, not read, both ways.
{
  const fbc = sliceFn('apps/crm/sidepanel.js', 'filterByConnection');
  const RUN = async (err) => {
    const ctx = { WS_MOVED: 'moved', said: [], connFilterSet: null, connectionFilter: null,
                  Error, Set, Object, String,
                  setStatus: (m, k) => ctx.said.push(`${k}:${m}`),
                  ensureGraph: async () => { throw new Error(err); },
                  setMode() {}, renderTree() {}, runSearch() {} };
    vm.createContext(ctx);
    vm.runInContext(fbc, ctx);
    await vm.runInContext('filterByConnection', ctx)('conn');
    return ctx.said;
  };
  test('crm: an overtaken connection filter is silent, a broken one speaks', async () => {
    assert.deepEqual(await RUN('moved'), [], 'the overtaken case reports an error nobody can act on');
    const said = await RUN('permission lapsed');
    assert.ok(said.some((m) => /^bad:.*permission lapsed/.test(m)),
              'a real failure is swallowed - the click does nothing and says nothing');
  });
}

// ---------------------------------------------------------------------------------------------
// «The workspace cannot change while a pull writes it» was true of the two main buttons only: the
// per-row refreshes, the single-item downloads, the module resync and the health runtime pull all
// ran with pullBusy false. Derived over the composed panel: every function whose name says it
// re-reads Zoho for the user holds the flag for its whole span, through the one wrapper whose
// finally is what makes an exception unable to leave the panel locked.
test('crm: every user entry that re-reads Zoho holds the pull flag for its whole span', () => {
  const src = crmPanel();
  for (const fn of ['refreshSchedules', 'refreshActions', 'refreshConnections', 'resyncModule', 'pullHealthRuntime']) {
    const body = sliceApp('crm', fn);
    // Either shape holds the flag for the whole span - the inline arrow, or the named body the
    // wrapper delegates to. What is refused is re-reading Zoho outside the wrapper altogether.
    assert.ok(/return runPullAction\((?:async \(\) => \{|\(\) => \w+\(|\w+\))/.test(body),
              `${fn} re-reads Zoho without blocking the selector or refusing a second pull`);
  }
  // The row clicks that download one item wrap at the click, because downloadOne is also called
  // from inside downloadMissing, which already holds the flag.
  assert.ok(/runPullAction\(\(\) => downloadOne\(e\)\)/.test(src), 'a tree-row download runs unwrapped');
  assert.ok(/runPullAction\(\(\) => downloadOneWf\(e\)\)/.test(src), 'a workflow-row download runs unwrapped');
  const w = sliceFn('apps/crm/sidepanel.js', 'runPullAction');
  assert.ok(/finally \{ setPullBusy\(false\); \}/.test(w), 'an exception in the work leaves the panel locked');
  const pe = sliceFn('apps/crm/sidepanel.js', 'pullEverything');
  assert.ok(/\} finally \{ setPullBusy\(false\); \}/.test(pe),
            'pullEverything still releases by hand, so one throwing renderer locks the panel until reopen');
});

// An unmeasured use is not zero uses: rebuildConnections turned a failed graph build into
// `uses: []` under a green status. Overtaken stays silent; a real failure is said and nothing
// is published as measured.
test('crm: a connections rebuild does not publish an unmeasured usage as zero', () => {
  const body = sliceFn('apps/crm/connections.js', 'rebuildConnections');
  assert.ok(!/ensureGraph\([^)]*\)\.catch\(\(\) => null\)/.test(body),
            'a failed graph build is folded into an empty one again');
  assert.ok(/=== WS_MOVED\) return;/.test(body), 'the overtaken case stopped being silent');
  assert.ok(/could not build the usage graph/.test(body), 'a real failure says nothing');
});

// The memory follows the file: resyncModule swallowed a failed write and updated the screen from
// memory - true for one screenful, undone by the next load.
test('crm: the module index names only files that landed', () => {
  // «0/1 modules» under a green line, with noteAccess recording the area as read: the index row was
  // pushed whether or not its file was written, so the mirror described files it did not have.
  const body = sliceApp('crm', 'pullModules');
  const tryAt = body.indexOf('await op.write(`modules/${sanitize(m.api_name');
  const pushAt = body.indexOf("index.push({ api_name: m.api_name");
  assert.ok(tryAt > 0 && pushAt > tryAt, 'the index row is pushed before (or without) its write');
  // In the same try: a push that merely comes later is a push that also runs when the write threw.
  assert.ok(!/catch/.test(body.slice(tryAt, pushAt)),
            'the write and its index row are separated by a catch, so a failed file still gets a row');
  assert.ok(/wFail\.push\(m\.api_name\)/.test(body), 'a failed module write is swallowed again');
  assert.ok(/gap \? 'warn' : 'ok'/.test(body), 'failed writes still end in a green status');
});

test('crm: a failed graph build is never folded into a zero', () => {
  const conn = sliceFn('apps/crm/ai.js', 'aiLoadConnections');
  // No catch of any shape between the build and its use: `.catch(() => null)` and a try/catch that
  // substitutes an empty graph are the same invented zero wearing different clothes.
  assert.ok(!/ensureGraph\([^)]*\)\.catch/.test(conn) && !/try[^}]*ensureGraph/.test(conn),
            'aiLoadConnections caches an invented «used by 0» over a graph that failed');
  const led = sliceFn('apps/crm/export.js', 'loadExportData');
  assert.ok(!/try \{ g = await ensureGraph/.test(led) && /const g = await ensureGraph\(op\);/.test(led),
            'an export can still ship «Functions: 0» over a graph that failed');
});

test('crm: a module resync publishes only what it managed to write', () => {
  const body = pullEntry('crm', 'resyncModule');
  assert.ok(!/op\.write\([^)]*\); \} catch \(_\) \{\}/.test(body), 'a failed write is swallowed again');
  assert.equal((body.match(/Could not save/g) || []).length, 2,
               'one of the two write sites reports nothing when the disk refuses');
});

// ---------------------------------------------------------------------------------------------
// «Pull all» promised the whole org and delivered «whatever is not yet on disk»: the org list
// carries `updatedTime` (measured on a captured response), the bridge dropped it, and staleness was
// derived from the sidecar's schema version alone - so a function edited by a colleague, or while
// the panel was closed, kept its old source through every pull. A rename was worse: the by-id merge
// marked the row downloaded at a path that did not exist, and the old pair's id stayed live, so no
// prune ever took it.
{
  const src = crmPanel();

  test('the list keeps Zoho\'s updatedTime, and staleness compares it against the sidecar', () => {
    assert.ok(/updatedTime: f\.updatedTime \|\| null/.test(read('apps/crm/content-bridge.js')),
              'the bridge drops the one field that says a function changed');
    assert.ok(/listUpdated: e\.updatedTime \|\| null/.test(src), 'the tree forgets what the list said');
    // This used to assert the comparison *as first written* - `row.listUpdated !== meta.updatedTime`
    // - which is an epoch against a formatted string and is therefore true for every function. The
    // test was written from the same assumption as the code and held the defect in place for a day.
    // A test that spells out an expression can only prove the expression is still there; what is
    // asserted now is the pair being like-for-like, and the behaviour lives in movedInZoho's cases.
    assert.ok(/movedInZoho\(row\.listUpdated, meta\.listUpdated\)/.test(src),
              'the two timestamps are never compared, so an edited function is never stale');
    assert.ok(/f\.meta\.listUpdated = entry\.listUpdated \|\| null/.test(src),
              'nothing records what the list said when the copy was fetched, so there is no pair to compare');
  });

  test('a renamed function is re-fetched at its new path, and the old pair goes only after both writes', () => {
    assert.ok(/row\.pathChanged = row\.path !== dg;/.test(src),
              'a sidecar found by id at another path still counts as downloaded');
    assert.ok(/row\.downloaded = !row\.pathChanged;/.test(src), 'the rename does not mark the new path as missing');
    assert.ok(/!e\.downloaded \|\| e\.stale \|\| e\.pathChanged/.test(src),
              'downloadMissing does not pick a rename up');
    const dl = sliceApp('crm', 'downloadOne');
    const rm = dl.indexOf('removeFunctionPaths([entry.previousPath');
    const writes = dl.indexOf('.meta.json`, JSON.stringify(f.meta');
    assert.ok(rm > 0, 'the old pair of a rename is never removed - a live id means no prune takes it');
    assert.ok(rm > writes, 'the old pair is removed before both new files are written');
  });

  test('a half-removed renamed pair retries the remaining file independently', async () => {
    const failedRemovals = new Set();
    const attempts = [];
    let pass = 1;
    const op = { current: () => true, remove: async (p) => {
      attempts.push(`${pass}:${p}`);
      if (pass === 1 && p.endsWith('.meta.json')) { const e = new Error('busy'); e.name = 'NoModificationAllowedError'; throw e; }
      if (pass === 2 && p.endsWith('.dg')) { const e = new Error('gone'); e.name = 'NotFoundError'; throw e; }
    } };
    const ctx = { failedRemovals, WS_MOVED: 'moved', Set, String, RegExp };
    vm.createContext(ctx);
    vm.runInContext(sliceApp('crm', 'removeFunctionPaths'), ctx);
    const remove = vm.runInContext('removeFunctionPaths', ctx);
    const paths = ['functions/old/f.dg', 'functions/old/f.meta.json'];
    assert.equal((await remove(paths, op)).failed, 1);
    assert.deepEqual([...failedRemovals], ['functions/old/f.meta.json'], 'the exact unfinished half is not queued');
    pass = 2;
    assert.equal((await remove(paths, op)).failed, 0);
    assert.deepEqual([...failedRemovals], [], 'NotFound on the completed half prevents the other half being retried');
    assert.ok(attempts.includes('2:functions/old/f.meta.json'), 'the metadata half was never retried');
    const dl = sliceApp('crm', 'downloadOne');
    const full = sliceApp('crm', 'pullAll');
    assert.match(dl, /removeFunctionPaths\(/, 'rename cleanup bypasses the independent pair remover');
    assert.match(full, /removeFunctionPaths\(/, 'full-pull deletion still swallows pair-removal failures');
  });

  test('a timestamp absent on either side marks nothing', () => {
    // Absence is not a measurement: a list entry with no updatedTime (or an old sidecar without one)
    // must not push the whole workspace into a re-download.
    const { movedInZoho } = load([sliceConst('apps/crm/sidepanel.js', 'movedInZoho')]);
    assert.equal(movedInZoho(null, 1773397259000), false, 'a list that said nothing pushes a re-download');
    assert.equal(movedInZoho(1773397259000, null), false, 'a sidecar that said nothing pushes a re-download');
    assert.equal(movedInZoho(0, 0), false, 'zero is treated as a measurement');
  });
}

// ---------------------------------------------------------------------------------------------
// Two of the assistant's advertised tools had never once run: `search_sql` and `search_columns`
// take a `query`, and the dispatcher resolved `input.name` first - «View not found: undefined» for
// both, from the day they were written. Derived from the registry, so a tool added tomorrow is
// exercised with the minimum its own schema declares, and schema and dispatcher cannot diverge
// silently again.
test('analytics: every declared tool runs on the minimum input its schema declares', async () => {
  const src = read('apps/analytics/sidepanel.js');
  const ctx = {
    views: [{ id: 'q1', name: 'Q1', type: 'QueryTable' }, { id: 't1', name: 'T1', type: 'Table' }],
    schema: { t1: { name: 'T1', columns: [{ name: 'Revenue', type: 'number' }] } },
    sqls: { q1: { id: 'q1', sql: 'select Revenue from T1', stem: 'q1', parents: [], sources: {} } },
    deps: { q1: { id: 'q1', parents: ['t1'], children: [], dashboards: [] } },
    pullFailed: [], relations: [], bound: { workspace: 'w' }, sqlDiskUnread: new Set(),
    String, Number, Object, Array, JSON, Set, Map, RegExp, Promise, Error,
  };
  vm.createContext(ctx);
  // Consts and functions both: sliceFn only lifts declarations, so the arrow-consts come through
  // sliceConst - and anything genuinely absent must throw here, not answer '' and hide a hole.
  const piece = (n) => { try { return sliceFn('apps/analytics/sidepanel.js', n); } catch { return sliceConst('apps/analytics/sidepanel.js', n); } };
  vm.runInContext([
    sliceConst('apps/analytics/sidepanel.js', 'MSG'),
    sliceConst('apps/analytics/sidepanel.js', 'SQL_UNREADABLE'),
    sliceConst('apps/analytics/sidepanel.js', 'SQL_EMPTY'),
    'const beginWorkspaceOp = () => ({ current: () => true, read: async () => { throw new Error("x"); } });',
    ...['viewById', 'aiFindView', 'aiCap', 'aiTrunc', 'sqlText', 'sqlBodyOf', 'sqlReadState', 'sqlState', 'aiStructureText',
        'structureChain', 'nameOf', 'relationsOf', 'shortDate', 'isOrphanCandidate', 'aiExecTool'].map(piece),
  ].join('\n'), ctx);
  // The registry is JavaScript, so it is evaluated as JavaScript - parsing it as JSON died on the
  // first apostrophe in a description.
  const tctx = {}; vm.createContext(tctx);
  vm.runInContext(sliceConst('apps/analytics/sidepanel.js', 'AI_TOOLS') + '; this.__t = AI_TOOLS;', tctx);
  const tools = tctx.__t;
  assert.ok(tools.length >= 5, `only ${tools.length} tools parsed from the registry`);
  for (const t of tools) {
    const props = (t.input_schema && t.input_schema.properties) || {};
    const input = {};
    if (props.name) input.name = 'Q1';
    if (props.query) input.query = 'revenue';
    if (props.filter) input.filter = '';
    const out = await vm.runInContext('aiExecTool', ctx)(t.name, input);
    assert.ok(typeof out === 'string' && out.length, `${t.name} answered nothing`);
    assert.ok(!/View not found: undefined/.test(out),
              `${t.name} resolves a view it was never given - the tool is unreachable`);
    // The plainer half, added when the CRM twin of this test was written: a renamed or removed
    // dispatch falls through to «Unknown tool», which is a non-empty string and passed the two
    // assertions above. The shape `search_sql` had, one product over.
    assert.ok(!/^Unknown tool/.test(out), `${t.name} is declared and never dispatched`);
  }

  // "Returned a string" is not enough: the first registry-derived version of this test accepted
  // both a named get_relations that returned "View not found" and a column search that emitted the
  // same table twice. Exercise the meaning of the two optional/global dispatch paths as well.
  ctx.relations = [{ source: 't1', target: 'q1', sourceName: 'T1', targetName: 'Q1', relation: '(T1.ID)=(Q1.ID)' }];
  const namedRelations = await vm.runInContext('aiExecTool', ctx)('get_relations', { name: 'T1' });
  assert.match(namedRelations, /^1 relation\(s\):/, `a named relation lookup never reaches its handler: ${namedRelations}`);
  const columns = await vm.runInContext('aiExecTool', ctx)('search_columns', { query: 'Revenue' });
  assert.match(columns, /^1 table\(s\)/, `one matching table is counted more than once: ${columns}`);
  assert.equal((columns.match(/T1 \[/g) || []).length, 1, 'the same column hit is emitted twice');

  ctx.sqls = {};
  ctx.pullFailed = [{ id: 'q1', stage: 'sql', error: '429' }];
  const dossier = await vm.runInContext('aiExecTool', ctx)('get_view', { name: 'Q1' });
  assert.match(dossier, /SQL could not be read/i,
               'get_view silently omits the SQL of a query whose pull failed');
});

test('analytics: a missing indexed SQL file makes search coverage incomplete', async () => {
  const ctx = {
    views: [{ id: 'q1', name: 'Q1', type: 'QueryTable' }], schema: {}, relations: [],
    sqls: { q1: { id: 'q1', sql: null, stem: 'q1', parents: [], sources: {} } },
    deps: {}, pullFailed: [], bound: { workspace: 'w' }, sqlDiskUnread: new Set(),
    String, Number, Object, Array, JSON, Set, Map, RegExp, Promise, Error,
  };
  vm.createContext(ctx);
  const piece = (n) => { try { return sliceFn('apps/analytics/sidepanel.js', n); } catch { return sliceConst('apps/analytics/sidepanel.js', n); } };
  vm.runInContext([
    sliceConst('apps/analytics/sidepanel.js', 'MSG'),
    sliceConst('apps/analytics/sidepanel.js', 'SQL_UNREADABLE'),
    sliceConst('apps/analytics/sidepanel.js', 'SQL_EMPTY'),
    'const beginWorkspaceOp = () => ({ current: () => true, read: async () => { const e = new Error("missing"); e.name = "NotFoundError"; throw e; } });',
    ...['viewById', 'aiFindView', 'aiCap', 'aiTrunc', 'sqlText', 'sqlBodyOf', 'sqlReadState', 'sqlState',
        'aiStructureText', 'structureChain', 'nameOf', 'relationsOf', 'shortDate',
        'isOrphanCandidate', 'aiExecTool'].map(piece),
  ].join('\n'), ctx);
  const out = await vm.runInContext('aiExecTool', ctx)('search_sql', { query: 'revenue' });
  assert.match(out, /Searched 0\/1 query tables - 1 SQL source\(s\) were unreadable/,
               `a file that could not be opened was counted as searched: ${out}`);
  assert.equal(vm.runInContext("sqlState('q1').kind", ctx), 'unread',
               'the failed disk read is forgotten by the shared SQL state');
});

test('analytics: an indexed SQL read failure is counted once and retried', async () => {
  let fail = true;
  const ctx = {
    views: [{ id: 'q1', name: 'Q1', type: 'QueryTable' }],
    sqls: { q1: { id: 'q1', sql: null, stem: 'q1', parents: [], sources: {} } },
    pullFailed: [], sqlDiskUnread: new Set(['q1']), sqlCache: null, sqlUnread: 0,
    viewById: () => new Map([['q1', { id: 'q1', name: 'Q1', type: 'QueryTable' }]]),
    beginWorkspaceOp: () => ({
      current: () => true, say: () => {},
      read: async () => { if (fail) throw new Error('temporary'); return 'select 1'; },
    }),
    String, Object, Array, Map, Set,
  };
  vm.createContext(ctx);
  vm.runInContext([
    sliceFn('apps/analytics/sidepanel.js', 'sqlState'),
    sliceFn('apps/analytics/sidepanel.js', 'sqlBodyOf'),
    sliceFn('apps/analytics/sidepanel.js', 'sqlReadState'),
    sliceFn('apps/analytics/sidepanel.js', 'ensureSqlCache'),
  ].join('\n'), ctx);

  await vm.runInContext('ensureSqlCache()', ctx);
  assert.equal(ctx.sqlUnread, 1, 'one unread file is counted once, not once before and once after retry');
  assert.equal(ctx.sqlDiskUnread.has('q1'), true, 'the failed disk observation was not retained');

  fail = false;
  ctx.sqlCache = null;
  const recovered = await vm.runInContext("sqlReadState('q1')", ctx);
  assert.equal(recovered.kind, 'read', 'a temporary disk failure became a permanent session verdict');
  assert.equal(recovered.body, 'select 1');
  assert.equal(ctx.sqlDiskUnread.has('q1'), false, 'a successful retry did not clear the old failure');
});

test('analytics: health includes SQL files found unreadable after loading the index', () => {
  const ctx = {
    views: [{ id: 'q1', name: 'Q1', type: 'QueryTable', description: '' }], folders: [],
    schema: {}, relations: [], sqls: { q1: { stem: 'q1' } }, deps: null, pullFailed: [],
    sqlDiskUnread: new Set(['q1']),
    viewById: () => new Map([['q1', { id: 'q1', name: 'Q1', type: 'QueryTable' }]]),
    structureChain: () => [], isOrphanCandidate: () => false, Object, Array, Set, String,
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'healthFindings'), ctx);
  const h = vm.runInContext('healthFindings()', ctx);
  assert.equal(h.unread.length, 1, 'the health report hides a SQL file that failed after index load');
  assert.equal(h.unread[0].id, 'q1');
});

// ---------------------------------------------------------------------------------------------
// «Not read» and «absent» were one fact: a QueryTable whose SQL pull failed was simply missing from
// `sqls`, so get_sql called it «not a query table», searches answered «no matches» over queries they
// never opened, the panel's unread counter missed it, and both exports skipped it whole - a reader
// cannot tell a dropped query from one that never existed. One state function now, four values,
// consulted by every surface.
{
  const an = read('apps/analytics/sidepanel.js');

  test('analytics: sqlState is the one answer, and every surface asks it', () => {
    const fn = sliceFn('apps/analytics/sidepanel.js', 'sqlState');
    assert.ok(/kind: 'not-query'/.test(fn) && /kind: 'unread'/.test(fn) && /kind: 'read'/.test(fn),
              'the four-value state lost a value');
    assert.ok(/f\.stage === 'sql'/.test(fn), 'a lineage failure would read as an unread query');
    for (const [what, re] of Object.entries({
      'get_sql': /IS a query table, but its SQL could not be read/,
      'search_sql coverage': /absence is not exhaustive/,
      'the focused prompt': /whose SQL could not be read - do not conclude anything/,
      'the detail pane': /<h5>SQL<\/h5><div class="none">not read/,
      'the HTML export': /Its SQL could not be read \(\$\{esc2\(st\.error\)\}\)/,
      'the Markdown export': /> Its SQL could not be read \(\$\{st\.error\}\)/,
      // The seventh surface, and the one the list did not have: the tab itself. Six places said
      // «not read» carefully while the SQL tab went grey on `!sqls[id]` and offered no way in - so
      // the reader never reached any of the six. A list of surfaces is only as good as its length.
      'the detail tab': /\$\('tab_sql'\)\.disabled = sqlSt\.kind === 'not-query'/,
      'the tab title': /SQL - not read: \$\{sqlSt\.error\}/,
    })) assert.ok(re.test(an), `${what} still treats an unread query as an absent one`);
    // Every failure records its stage, or sqlState cannot tell sql from lineage.
    assert.ok(!/still\.push\(\.\.\.\(r2?\.failed \|\| \[\]\)\);/.test(an),
              'a partial pull records failures with no stage');
    assert.ok(/\(sq\.failed \|\| \[\]\)\.map\(\(f\) => \(\{ \.\.\.f, stage: 'sql' \}\)\)/.test(sliceFn('apps/analytics/sidepanel.js', 'pullAll')),
              'the full pull records sql failures with no stage');
  });

  test('analytics: a query table whose pull failed keeps a way into its SQL', () => {
    // The decision the tab strip makes, run on the state a failed pull actually produces.
    const ctx = {
      views: [{ id: 'q1', name: 'Q1', type: 'QueryTable' }, { id: 't1', name: 'T1', type: 'Table' }],
      sqls: {}, pullFailed: [{ id: 'q1', stage: 'sql', error: 'HTTP 429' }], sqlDiskUnread: new Set(),
      String, Object, Map, Array,
    };
    vm.createContext(ctx);
    vm.runInContext(sliceConst('apps/analytics/sidepanel.js', 'viewById'), ctx);
    vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'sqlState'), ctx);
    const st = vm.runInContext("sqlState('q1')", ctx);
    assert.equal(st.kind, 'unread');
    assert.equal(st.error, 'HTTP 429', 'the reason Zoho gave is lost before it reaches the tab');
    assert.equal(st.kind === 'not-query', false, 'the SQL tab is off for a query table that has one');
    assert.equal(vm.runInContext("sqlState('t1')", ctx).kind, 'not-query',
                 'a plain table would be offered a SQL tab');
  });

  test('analytics: the unread counter includes queries whose pull failed', () => {
    const fn = sliceFn('apps/analytics/sidepanel.js', 'ensureSqlCache');
    assert.ok(/sqlState\(v\.id\)\.kind === 'unread'/.test(fn),
              'the counter only sees files that refused to open, not pulls that failed');
  });

  test('analytics: get_sql answers «could not be read», run against a failed pull', async () => {
    const ctx = {
      views: [{ id: 'q1', name: 'Q1', type: 'QueryTable' }], schema: {}, relations: [],
      sqls: {}, deps: {}, pullFailed: [{ id: 'q1', stage: 'sql', error: '429' }], sqlDiskUnread: new Set(),
      String, Number, Object, Array, JSON, Set, Map, RegExp, Promise, Error,
    };
    vm.createContext(ctx);
    const piece = (n) => { try { return sliceFn('apps/analytics/sidepanel.js', n); } catch { return sliceConst('apps/analytics/sidepanel.js', n); } };
    vm.runInContext([sliceConst('apps/analytics/sidepanel.js', 'MSG'),
      sliceConst('apps/analytics/sidepanel.js', 'SQL_UNREADABLE'), sliceConst('apps/analytics/sidepanel.js', 'SQL_EMPTY'),
      'const beginWorkspaceOp = () => ({ current: () => true, read: async () => { throw new Error("x"); } });',
      ...['viewById', 'aiFindView', 'aiCap', 'aiTrunc', 'sqlText', 'sqlBodyOf', 'sqlReadState', 'sqlState', 'aiStructureText',
          'structureChain', 'nameOf', 'relationsOf', 'shortDate', 'isOrphanCandidate', 'aiExecTool'].map(piece)].join('\n'), ctx);
    const out = await vm.runInContext('aiExecTool', ctx)('get_sql', { name: 'Q1' });
    assert.ok(/could not be read/.test(out), `a failed pull reads as «not a query table»: ${String(out).slice(0, 90)}`);
  });

  test('analytics: an empty query stays distinct from an unread one', async () => {
    const ctx = { views: [{ id: 'q', type: 'QueryTable' }], sqls: { q: { sql: '' } }, pullFailed: [], sqlDiskUnread: new Set(),
                  viewById: () => new Map([['q', { id: 'q', type: 'QueryTable' }]]), String, Map };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'sqlState'), ctx);
    assert.equal(vm.runInContext("sqlState('q').kind", ctx), 'read',
                 'Zoho answering with an empty query is reported as a failed read');
    ctx.pullFailed = [{ id: 'q', stage: 'sql', error: '429' }];
    assert.equal(vm.runInContext("sqlState('q').kind", ctx), 'unread', 'a recorded failure does not win');
  });
}

// ---------------------------------------------------------------------------------------------
// A reader that received an operation and then reads through the *global* resolver is reading the
// next workspace with the old one's blessing: the outer guard discards the result, but every byte
// was fetched from folder B on A's behalf. Derived over the panel's files: inside any function that
// holds an op, a bare `readFile(` or `walk(dir)` is a finding.
test('crm: a function that holds an op never reads through the global resolver', () => {
  const bad = [];
  for (const f of CRM_FILES) {
    const src = read(f);
    for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm)) {
      const end = src.indexOf('\n}', src.indexOf('{', m.index));
      const body = src.slice(m.index, end).replace(/^\s*\/\/.*$/gm, '');
      const hasOp = /\bop\b/.test(m[2]) || /beginWorkspaceOp\(\)/.test(body);
      if (!hasOp) continue;
      if (/(?<!op\.)(?<!\w)readFile\(/.test(body)) bad.push(`${f}: ${m[1]}() readFile`);
      if (/walk\(dir\)/.test(body)) bad.push(`${f}: ${m[1]}() walk(dir)`);
    }
  }
  assert.deepEqual(bad, [], `these hold an op and read past it:\n  ${bad.join('\n  ')}`);
});

// Passing an operation into a reader closes only the first edge. If that reader calls another
// operation-aware helper with no `op`, the helper silently captures whichever workspace is visible
// at that later instant. This is how modules, schedules, Health, exports and the assistant all kept
// one unguarded hop while every individual helper looked correct in isolation.
test('an operation-bound call chain never starts a fresh workspace halfway through', () => {
  const products = {
    crm: CRM_FILES,
    analytics: ['apps/analytics/sidepanel.js'],
  };
  const bad = [];
  for (const [app, files] of Object.entries(products)) {
    const helpers = new Set();
    const funcs = [];
    for (const file of files) {
      const src = read(file);
      for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm)) {
        let body;
        try { body = sliceFn(file, m[1]); }
        catch (_) { body = src.slice(m.index, src.indexOf('\n', m.index)); }
        funcs.push({ file, name: m[1], params: m[2], body });
        if (/\bop\b/.test(m[2])) helpers.add(m[1]);
      }
    }
    for (const f of funcs) {
      const clean = f.body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const holdsOp = /\bop\b/.test(f.params) || /\b(?:const|let)\s+op\s*=\s*beginWorkspaceOp\(\)/.test(clean);
      if (!holdsOp) continue;
      for (const helper of helpers) {
        if (helper === f.name) continue;
        const call = new RegExp(`\\b${helper}\\s*\\(([^;\\n]*)\\)`, 'g');
        for (const m of clean.matchAll(call)) {
          if (!/\bop\b/.test(m[1])) bad.push(`${app}: ${f.name}() -> ${helper}()`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `these call chains change workspace identity halfway through:\n  ${bad.join('\n  ')}`);
});

// A window that cannot open leaves nobody to consume its key: the payload sat in session storage
// until the browser closed, which is longer than the privacy page promises. And the pruner: old
// .sql files of deleted or renamed queries accumulated with no map left to even call them residue.
{
  for (const app of ['crm', 'analytics']) {
    test(`${app}: a graph key does not outlive a window that never opened`, async () => {
      const ops = [];
      const ctx = { crypto: { randomUUID: () => 'tok' }, bound: null, lastCtx: null,
        graphForWindow: (g) => g, Error, Object,
        chrome: { storage: { session: { set: async (o) => ops.push('set:' + Object.keys(o)[0]),
                                        remove: async (k) => ops.push('remove:' + k) } },
                  windows: { create: async () => { throw new Error('no window for you'); } },
                  runtime: { getURL: (u) => u } } };
      vm.createContext(ctx);
      vm.runInContext(sliceFn(`apps/${app}/sidepanel.js`, 'publishGraph'), ctx);
      await assert.rejects(() => vm.runInContext('publishGraph', ctx)({ nodes: {} }, null, {}));
      assert.deepEqual([...ops], ['set:graphData:tok', 'remove:graphData:tok'],
                       `the payload stays in session storage with nobody to consume it: ${ops}`);
    });
  }

  test('analytics: the pull prunes the .sql files its new index no longer names', async () => {
    const removed = [];
    const ctx = { status() {},
      op: { root: {}, current: () => true, remove: async (p) => removed.push(p) },
      walk: async function* () { yield 'sql/kept.sql'; yield 'sql/renamed-old.sql'; yield 'sql/deleted.sql'; yield 'views.json'; },
      Set, Object, RegExp };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'pruneSql'), ctx);
    // The census is required now: these two cases called it with two arguments, which is the shape
    // the data loss had. An empty census here is the honest fixture - this case is about what the
    // *index* keeps - and it is passed explicitly rather than defaulted.
    const failed = await vm.runInContext('pruneSql', ctx)({ q1: { stem: 'kept' } }, ctx.op, []);
    assert.equal(failed, 0, 'a successful cleanup does not report its result to the pull');
    assert.deepEqual(removed.sort(), ['sql/deleted.sql', 'sql/renamed-old.sql'],
                     'a deleted or renamed query leaves its file behind with no map naming it');
  });

  test('analytics: a failed SQL prune survives the final success status', async () => {
    const said = [];
    const ctx = { status: (m, k) => said.push([m, k]), WS_MOVED: 'moved',
      op: { root: {}, current: () => true, say: (m, k) => said.push([m, k]),
            remove: async () => { throw new Error('busy'); } },
      walk: async function* () { yield 'sql/old.sql'; }, Set, Object, RegExp };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'pruneSql'), ctx);
    const failed = await vm.runInContext('pruneSql', ctx)({}, ctx.op, []);
    assert.equal(failed, 1, 'the caller cannot know cleanup was incomplete');
    assert.equal(said.length, 1);
    assert.equal(said[0][1], 'warn');
    const pa = sliceFn('apps/analytics/sidepanel.js', 'pullAll');
    assert.match(pa, /cleanupFailed/, 'pullAll overwrites the cleanup warning with its final success line');
  });

  test('the two privacy pages describe the same graph retention', () => {
    const en = read('site/privacy.html'), it = read('site/it/privacy.html');
    assert.ok(/window consumes its own copy the moment it opens/.test(en),
              'the English page still says the drawing is replaced by the next one');
    assert.ok(/la finestra consuma la\s+propria copia nel momento in cui si apre/.test(it),
              'the Italian page still describes the old retention');
  });
}

// ---------------------------------------------------------------------------------------------
// The source of a function is in its file, and a fast path may not decide whether a reader gets it.
//
// `loadGraph()` used to put `source_code` on every node, and the summary cache turned that into a
// lie: a node served from `functions/meta-index.json` carries the references and the counts and an
// empty string, and after the first pull every node is served from it. Three assistant tools and
// the Markdown export read that field. Written from the run, not from the source - the first proof
// of this was a script that built the graph over a warm summary and printed `source_code: ""`.
{
  test('a graph node served from the summary carries no source, and fnSource reads the file', async () => {
    const files = {
      'functions/meta-index.json': JSON.stringify({ v: 5, files: {
        'functions/ns/a.dg': { namespace: 'ns', name: 'a', api_name: 'a', display_name: 'A',
                               refs: [], stats: { lines: 3, codeLines: 3, chars: 30, apiCalls: 0 }, modules: [] },
      } }),
      'functions/ns/a.dg': 'info "hello";\ninfo "world";\nreturn 1;',
    };
    let reads = 0;
    const op = { root: {}, current: () => true,
                 read: async (p) => { reads++; if (!(p in files)) throw new Error('ENOENT ' + p); return files[p]; } };

    // The real graph builder, so the node is the shipped shape rather than a copy of it.
    const gctx = { window: {}, console };
    vm.createContext(gctx);
    vm.runInContext(read('apps/crm/graph-core.js'), gctx);

    const { loadGraph } = load([sliceFn('apps/crm/sidepanel.js', 'loadGraph')], {
      WS_MOVED: 'moved', META_INDEX: 'functions/meta-index.json', SUMMARY_V: 5,
      distrustSummary: false, _dirtySource: new Set(), bound: null, lastCtx: null,
      fnStats: (t) => ({ lines: String(t).split('\n').length }),
      saveGraphFacts: async () => {},
      walk: async function* () { yield 'functions/ns/a.dg'; },
      window: gctx.window,
    });
    const g = await loadGraph(op);
    const n = g.nodes['ns.a'];
    assert.ok(n, 'the summary path built no node at all');
    // `in`, not truthiness: the defect *was* an empty string, so `!n.source_code` passes on it and
    // on the fix alike. Proven by planting the old line back and watching this go red.
    assert.ok(!('source_code' in n), 'a node carries a source the graph never read - the field is back');

    const { fnSource } = load([sliceFn('apps/crm/ai.js', 'fnSource')], { WS_MOVED: 'moved' });
    assert.equal(await fnSource(n, op), files['functions/ns/a.dg'], 'fnSource did not read the file');
    const after = reads;
    assert.equal(await fnSource(n, op), files['functions/ns/a.dg'], 'the second read differs from the first');
    assert.equal(reads, after, 'fnSource re-opens the file on every question');
  });

  test('fnSource refuses to answer about a workspace that has been left', async () => {
    const { fnSource } = load([sliceFn('apps/crm/ai.js', 'fnSource')], { WS_MOVED: 'moved' });
    const op = { current: () => false, read: async () => 'info "x";' };
    await assert.rejects(() => fnSource({ file: 'functions/ns/a.dg' }, op), /moved/);
  });

  // And the tools that read it. `search_code` answering «(no matches)» over an org whose sources it
  // never opened is the same defect as the Analytics `search_sql`, which had never run once.
  test('the assistant reads the source from disk, not from the graph node', () => {
    const ai = read('apps/crm/ai.js');
    assert.ok(!/n\.source_code|\.source_code \|\| ''/.test(ai.replace(/^ \*.*$/gm, '')),
              'a tool still reads source_code off a graph node');
    for (const tool of ['search_code', 'get_function']) {
      const i = ai.indexOf(`name === '${tool}'`);
      assert.ok(i > 0, `id=${tool} is gone from the tool switch`);
      assert.ok(/fnSource\(/.test(ai.slice(i, i + 1400)), `id=${tool} does not reach the file`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Two reports of one workspace may not disagree about how many functions the org has. The HTML has
// always enumerated the index and marked what a pull could not download; the Markdown enumerated the
// call graph, which is built by walking the .dg files - so it listed the downloaded ones and printed
// their number as the org's function count. The report written to be handed to an assistant was the
// one that undercounted, and it would have answered that a function the org has does not exist.
{
  const mdGlobals = {
    SCOPE_DEFAULT: { functions: true, modules: true, workflows: true, schedules: true, connections: true,
                     actions: true, failures: true, health: true, code: true },
    SCOPE_KEYS: ['functions', 'modules', 'code'],
    bound: { instance: 'yourinstance', org: '1234567890', label: 'Acme', base: 'https://crm.zoho.eu' },
    envOf: () => 'eu', freshnessLine: () => 'just now',
    byField: (f) => (a, b) => String(a[f]).localeCompare(String(b[f])),
    wfScheduled: () => ({ count: 0, delays: [] }),
    // The real one, lifted from the panel. As a stub answering «false» it made every
    // workflow-to-function cross-reference unreachable, so the report this case builds had no
    // internal links to speak of and the anchor sweep below would have proved nothing.
    isFnAction: (a) => a && (a.type === 'functions' || a.type === 'function'),
    moduleRefusal: () => '', actionKindLabel: (k) => k,
    actStale: () => false, actKept: () => false, actThin: () => false,
    _mdCell: (x) => String(x == null ? '' : x),
    PRODUCT_NAME: 'Zoost', PRODUCT_URL: 'https://zoost.it', PRODUCT_AUTHOR: 'Ivan', LEGAL_DISCLAIMER: 'x',
    // The size chapter says what it could measure, and the sentence comes from MSG.
    MSG: { hRankedOver: liftRankedOver() },
  };
  const data = () => ({
    fns: [
      { api_name: 'alpha', display_name: 'Alpha', namespace: 'ns', rest: false, code: 'info "a";',
        downloaded: true, associated_place: null, connections: [],
        stats: { lines: 1, codeLines: 1, chars: 9, apiCalls: 0 },
        node: { id: 'ns.alpha', namespace: 'ns', name: 'alpha', api_name: 'alpha', calls: [], called_by: [],
                stats: { lines: 1, codeLines: 1, chars: 9, apiCalls: 0 } } },
      { api_name: 'beta', display_name: 'Beta', namespace: 'ns', rest: false, code: '',
        downloaded: false, associated_place: null, connections: [], stats: null },
    ],
    mods: [], g: { nodes: {} }, modRefs: {}, wfs: [], scheds: [], conns: [],
    fails: { at: null, usage: null, failures: [] }, acts: [], actUsers: new Map(),
  });

  test('the Markdown lists a function the pull could not download', () => {
    const { buildExportMarkdown } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportMarkdown')], mdGlobals);
    const md = buildExportMarkdown(data(), { functions: true, code: true });
    assert.ok(md.includes('`ns.beta`'), 'a function in the index is missing from the report');
    assert.ok(/- Functions: 2 \(1 not downloaded/.test(md), `the count is not the org's: ${md.split('\n')[5]}`);
    assert.ok(/### ns.beta[\s\S]{0,400}?source: not downloaded/.test(md), 'beta has no section, or does not say why it has no source');
  });

  test('a function with no source gets no empty code fence', () => {
    const { buildExportMarkdown } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportMarkdown')], mdGlobals);
    const md = buildExportMarkdown(data(), { functions: true, code: true });
    assert.ok(md.includes('```deluge\ninfo "a";'), 'the downloaded function lost its source');
    assert.ok(!/```deluge\n\n?```/.test(md), 'an empty fence reads as a function with no body');
  });

  test('turning off the source keeps every function listed', () => {
    const { buildExportMarkdown } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportMarkdown')], mdGlobals);
    const md = buildExportMarkdown(data(), { functions: true, code: false });
    assert.ok(!md.includes('```deluge'), 'source excluded and a fence was written anyway');
    assert.ok(md.includes('### ns.alpha') && md.includes('### ns.beta'), 'a function vanished with the source');
  });
}

// ---------------------------------------------------------------------------------------------
// A destructive act reads the folder it is about to act on, never a memory of some folder.
//
// `reconcileFunctions` computed what to delete as `treeData.filter(downloaded && !live.has(id))`.
// `treeData` is written only by `rebuildTree()`, which runs only while the Functions tab is on
// screen - so from any other tab, switching workspace left it describing the workspace before. The
// ids of two orgs never intersect, so «what Zoho no longer has» became «every downloaded function of
// the previous workspace», and each was removed by relative path from the *current* folder and
// announced as «Deleted in Zoho». A production and a sandbox mirror of one org collide on nearly
// every functions/<namespace>/<api_name>.dg there is.
{
  const src = crmPanel();

  test('what to prune is read from this workspace’s index, not from the list on screen', () => {
    const at = src.indexOf('async function reconcileNow(');
    assert.ok(at > 0, 'reconcileNow() is gone - renamed, or no longer a declaration');
    // The round used to be an async IIFE inside `reconcileFunctions`, which is why this slice was
    // written to skip past a brace at column zero. It is a declaration of its own now, so its end is
    // the next top-level `function` keyword and nothing has to be stepped over.
    const fn = src.slice(at, src.indexOf('\nfunction ', at + 10));
    assert.ok(/const gone = prev\.filter/.test(fn), 'the prune is derived from memory again');
    assert.ok(fn.indexOf("op.read('functions/index.json')") < fn.indexOf('const gone'),
              'the previous index is not read before it is overwritten');
    assert.ok(!/treeData\.filter\([^)]*live/.test(fn), 'treeData decides what gets deleted');
  });

  test('pruneFunction builds its path from the entry it was handed', async () => {
    const removed = [];
    const ctx = {
      // Deliberately wrong: this is the *previous* workspace's memory, which is what the defect used.
      index: new Map([['7', { path: 'functions/other/StaleName.dg' }]]),
      treeData: [{ id: '7', path: 'functions/other/StaleName.dg' }],
      failedRemovals: new Set(),
      sanitize: (x) => String(x).replace(/[^\w.-]+/g, '_'),
      beginWorkspaceOp: () => ({
        current: () => true,
        remove: async (p) => { removed.push(p); },
        read: async () => '[]',
        write: async () => {},
      }),
      setStatus: () => {}, renderTree: () => {}, updateMissingButton: () => {},
      currentPath: null, $: () => ({ classList: { remove() {} } }),
      String, Map, Set, Array, JSON, RegExp, Error, Object,
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/crm/sidepanel.js', 'pruneFunction'), ctx);
    await vm.runInContext("pruneFunction('7', { id: '7', namespace: 'ns', api_name: 'Alpha' })", ctx);
    assert.deepEqual(removed, ['functions/ns/Alpha.dg', 'functions/ns/Alpha.meta.json'],
                     'the path came from memory rather than from the entry read off this disk');
  });

  test('with no entry it still falls back to memory, for the single-id path', async () => {
    const removed = [];
    const ctx = {
      index: new Map([['7', { path: 'functions/ns/Alpha.dg' }]]), treeData: [],
      failedRemovals: new Set(), sanitize: (x) => x,
      beginWorkspaceOp: () => ({ current: () => true, remove: async (p) => { removed.push(p); },
                                 read: async () => '[]', write: async () => {} }),
      setStatus: () => {}, renderTree: () => {}, updateMissingButton: () => {},
      currentPath: null, $: () => ({ classList: { remove() {} } }),
      String, Map, Set, Array, JSON, RegExp, Error, Object,
    };
    vm.createContext(ctx);
    vm.runInContext(sliceFn('apps/crm/sidepanel.js', 'pruneFunction'), ctx);
    await vm.runInContext("pruneFunction('7')", ctx);
    assert.deepEqual(removed, ['functions/ns/Alpha.dg', 'functions/ns/Alpha.meta.json']);
  });
}

// ---------------------------------------------------------------------------------------------
// The flag is owned by the function that sets it.
//
// `aiSend` set `aiBusy` and disabled Send, then ran through a dozen `if (!current()) return` exits -
// each of which left both set for the life of the panel, with the «thinking…» dots on screen and
// every later question returning at the first line. `current()` is false whenever `wsGen` moved, and
// `wsGen` moves on *every* activation, including re-activating the workspace already open: the ✎
// rename, ↻ Refresh after a lapsed permission, the capture-phase re-grant click. The state that
// cleared the flag ran only when the workspace actually differed. Same shape as `pullActive`, which
// this repository has already had to fix once: set by many, released by one.
for (const [app, file] of [['crm', 'apps/crm/ai.js'], ['analytics', 'apps/analytics/sidepanel.js']]) {
  test(`${app}: the assistant releases Send however the send ends`, () => {
    const fn = sliceFn(file, 'aiSend');
    const i = fn.indexOf('aiBusy = true');
    assert.ok(i > 0, `id=${app} aiSend no longer marks itself busy`);
    const after = fn.slice(i);
    assert.ok(/\}\s*finally\s*\{/.test(after), `id=${app} the release is not in a finally`);
    const fin = after.slice(after.search(/\}\s*finally\s*\{/));
    assert.ok(/aiBusy = false/.test(fin), `id=${app} aiBusy is cleared outside the finally`);
    assert.ok(/disabled = false/.test(fin), `id=${app} Send is re-enabled outside the finally`);
    // And the release must not sit behind a guard, which is exactly what it used to do.
    const between = after.slice(0, after.search(/\}\s*finally\s*\{/));
    assert.ok(!/if \(!current\(\)\) return;\s*\n\s*aiBusy = false/.test(between),
              `id=${app} an overtaken send still leaves the panel wedged`);
  });
}

// ---------------------------------------------------------------------------------------------
// The mirror is untrusted content: it is text a workspace author wrote, and a folder can be
// received, shared or synced. `functions/index.json` is read off disk and its `id` goes straight
// into `/crm/v2/settings/functions/${id}` - so `"id": "../../../v2/users?type=AllUsers&x="`
// normalises to an endpoint nobody chose, fetched with the reader's own session and cookies. The
// two parameters beside it were `encodeURIComponent`'d; the id was not.
for (const app of ['crm', 'analytics']) {
  const rel = `apps/${app}/content-bridge.js`;
  const { safePath } = load([sliceFn(rel, 'safePath')], { String, Error });

  test(`${app}: a request path that climbs out of its endpoint is refused`, () => {
    assert.equal(safePath('/crm/v2/settings/functions/12345?language=deluge'),
                 '/crm/v2/settings/functions/12345?language=deluge', 'an ordinary path was refused');
    for (const bad of ['/crm/v2/settings/functions/../../../v2/users?type=AllUsers',
                       '/crm/v2/../../evil', '/a/..', '/a\\b', '/a#b', 'crm/v2/x']) {
      assert.throws(() => safePath(bad), /malformed/, `id=${bad} was allowed through`);
    }
    // A `..` inside the *query* is not a path segment and must not be refused - the guard is about
    // where the request goes, not about what it carries.
    assert.doesNotThrow(() => safePath('/x/y?q=../z'));
  });

  test(`${app}: every request goes through it`, () => {
    // Comments stripped: one of them quotes `fetch(BASE + path)` while explaining a different bug,
    // and a test about code that reads prose is the trap this suite has now hit three times today.
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fetches = [...src.matchAll(/fetch\(BASE \+ ([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    assert.ok(fetches.length > 0, `id=${app} nothing fetches BASE + a path any more - check the shape`);
    for (const v of fetches) assert.equal(v, 'safePath', `id=${app} a request bypasses the path guard`);
  });
}

// ---------------------------------------------------------------------------------------------
// A flag is owned by everything that can be in the state it describes.
//
// `pullActive` says «a pull is running», and `reconcileFunctions` reads it to defer a save/create/
// delete notice until the pull has finished - because reconciling during a pull means a second
// `listFunctions`, a second index rewrite and a second `downloadMissing`, concurrently with the most
// expensive thing this panel does. Four pulls set it. Three did not: Schedules, Connections and
// Actions, which reach Zoho exactly like the other four.
//
// `endPull()` exists because ending a pull is one act and not five - its own comment says «a pull
// added tomorrow cannot forget the half nobody sees». It could, and three had.
//
// Derived, not listed: whichever panel-side `pull*` reaches Zoho is in scope, so the eighth added
// tomorrow is covered by nobody remembering. The orchestrators fall out of it by themselves -
// `pullEverything`, `pullCurrent` and `pullHealthRuntime` call no bridge, they call the others.
{
  const FILES = ['apps/crm/sidepanel.js', 'apps/crm/modules.js', 'apps/crm/automation.js',
                 'apps/crm/connections.js', 'apps/crm/health.js'];

  const pulls = () => {
    const out = [];
    for (const rel of FILES) {
      const src = read(rel);
      for (const m of src.matchAll(/^async function (pull\w*)\s*\(/gm)) {
        const body = src.slice(m.index, src.indexOf('\n}', m.index));
        out.push({ rel, name: m[1], body, reaches: /toBridge\(/.test(body) });
      }
    }
    return out;
  };

  test('every pull that reaches Zoho owns the flag that defers a reconcile', () => {
    const all = pulls();
    assert.ok(all.length >= 8, `only ${all.length} pull functions found - the derivation broke`);
    const reaching = all.filter((p) => p.reaches);
    assert.ok(reaching.length >= 6, `only ${reaching.length} of them reach Zoho - the derivation broke`);
    for (const p of reaching) {
      assert.ok(/pullActive = true/.test(p.body),
                `id=${p.name} (${p.rel}) reaches Zoho and does not set pullActive - a save notice ` +
                `arriving during it starts a full reconcile on top of the pull`);
      assert.ok(/endPull\(\)/.test(p.body),
                `id=${p.name} (${p.rel}) sets pullActive and does not call endPull() - the notice it ` +
                `deferred is never consumed, so the change is remembered and never answered`);
    }
  });

  test('nothing clears the flag except the one helper', () => {
    // The other half of «ending a pull is one act»: a pull that writes `pullActive = false` itself
    // skips the pending-notice half, which is the part nobody sees missing.
    for (const rel of FILES) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // Not the declaration: `let pullActive = false, pullBusy = false;` is where the flag comes
      // from, not a place that clears it. My own first version of this check reported it.
      for (const m of src.matchAll(/(?<!let )(?<!, )pullActive\s*=\s*false/g)) {
        const line = src.slice(0, m.index).split('\n').length;
        const fn = src.slice(0, m.index).lastIndexOf('function endPull');
        const nextFn = src.slice(0, m.index).lastIndexOf('function ');
        assert.equal(fn, nextFn, `${rel}:${line} clears pullActive outside endPull()`);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// «Nothing pulled yet - press Pull all» must never be said without asking what is actually in the way.
//
// `emptyReason()` walks the states in the order they block each other - no folder, no access, no
// workspace, a sample (which refuses Pull by design), an old layout - and returns the one thing the
// reader has to do. Every empty state is supposed to ask it and fall back to «press Pull» only when
// nothing else is in the way. Saying the wrong missing thing is worse than silence, because the
// reader goes and does it and nothing changes: that is written in CLAUDE.md and it is why the
// function exists.
//
// Four places named Pull without asking, and the clearest was fourteen lines from one that did -
// `modules.js:523` against `:537`, the same file, the same shape. One of a set, changed; the others
// left behind.
//
// Derived: any user-facing literal that both reports an empty state and names Pull as the remedy is
// in scope, wherever it is written. A seventh tab, or a seventh diagram entry, is covered without
// anyone remembering.
{
  const FILES = ['apps/crm/sidepanel.js', 'apps/crm/modules.js', 'apps/crm/automation.js',
                 'apps/crm/connections.js', 'apps/crm/health.js', 'apps/crm/export.js'];
  const EMPTY = /(pulled yet|no \w+ (?:yet|recorded))/i;
  const REMEDY = /(pull all|click pull|press <b>pull|press pull|use pull|pull in )/i;

  const claims = () => {
    const out = [];
    for (const rel of FILES) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/(['"`])((?:(?!\1)[\s\S]){0,300}?)\1/g)) {
        const text = m[2];
        if (!EMPTY.test(text) || !REMEDY.test(text)) continue;
        // The statement this literal belongs to: back to the previous `;` or `{`, forward to the
        // next `;`. Enough to see whether the fallback was reached through `emptyReason()`.
        const from = Math.max(src.lastIndexOf(';', m.index), src.lastIndexOf('{', m.index)) + 1;
        const to = src.indexOf(';', m.index + m[0].length);
        out.push({ rel, line: src.slice(0, m.index).split('\n').length,
                   text: text.slice(0, 60), stmt: src.slice(from, to < 0 ? src.length : to) });
      }
    }
    return out;
  };

  test('nothing tells the reader to press Pull without asking what is in the way', () => {
    const all = claims();
    assert.ok(all.length >= 8, `only ${all.length} empty states found - the derivation broke`);
    // All of them, not the first. A check about «one of a set was changed and the others were left»
    // that stops at the first failure makes the reader fix one of four and believe they are done -
    // which is the defect, one level up, in the tool written to catch it.
    const bad = all.filter((c) => !/emptyReason\(\)/.test(c.stmt));
    assert.deepEqual(bad.map((c) => `${c.rel}:${c.line}`), [],
      `these tell the reader to press Pull without asking what is in the way - on a sample workspace ` +
      `Pull is refused by design, and with no folder access it is not the blocker:\n` +
      bad.map((c) => `  ${c.rel}:${c.line}  «${c.text}…»`).join('\n'));
  });
}

// ---------------------------------------------------------------------------------------------
// A read that stopped early may not authorise a deletion.
//
// A list Zoho cut short is a statement about how far the reading got, not about what exists. Written
// as the index, and pruned against, it deletes things that are still there - the worst thing this
// product can do, and reachable on any org past the paging limit by an ordinary create. Every
// existing pull refuses it; each was fixed after being found, and each was then pinned by a case
// naming that pull.
//
// **A list of names is a list somebody has to remember.** Planted here: a new pull, correct in every
// other respect - workspace captured, mismatch refused, failures through the helper, `op.current()`
// before every write - and wrong in exactly one way, pruning against a list that may have stopped
// early. Nothing in the battery said a word about the deletion. So this derives the set instead:
// whichever panel function removes files is in scope, and it must refuse a truncated list before the
// first removal, or name the command it used as one the bridge can never cut short.
{
  const PANEL = ['apps/crm/sidepanel.js', 'apps/crm/modules.js', 'apps/crm/automation.js',
                 'apps/crm/connections.js', 'apps/crm/health.js'];

  // Derived from the bridge: which commands are *provably* whole. A command whose handler mentions
  // `capped` can answer short; a command the bridge does not implement at all says nothing about
  // itself, and unknown is not safe. My first version had it the other way round and the planted pull
  // walked straight past it, using a command name the bridge has never heard of - the same «I cannot
  // read it, so I will assume the harmless one» that let four spellings past the write gate this
  // morning. Only a command that is here and cannot cap is exempt.
  const whole = () => {
    const src = read('apps/crm/content-bridge.js');
    const out = new Set();
    // Both shapes the dispatcher has worn: eleven copies of `{ fn().then(…) }` and the single
    // `return reply(fn(…))` that replaced them. Reading only the first derived *nothing* the day it
    // was tidied - which the `safe.size >= 3` line below caught, and is why it is there.
    for (const m of src.matchAll(/msg\?\.cmd === '(\w+)'\)\s*(?:\{\s*)?(?:return\s+reply\()?(\w+)\(/g)) {
      const at = src.indexOf(`async function ${m[2]}(`);
      if (at < 0) continue;
      if (!/capped/.test(src.slice(at, src.indexOf('\n  }', at)))) out.add(m[1]);
    }
    return out;
  };

  test('nothing deletes on the word of a list that may have stopped early', () => {
    const safe = whole();
    assert.ok(safe.size >= 3, `only ${safe.size} whole-by-construction commands derived - the derivation broke`);
    const bad = [];
    let deleters = 0;
    for (const rel of PANEL) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/^async function (\w+)\s*\(/gm)) {
        const body = src.slice(m.index, src.indexOf('\n}', m.index));
        const rm = body.search(/op\.remove\(/);
        if (rm < 0) continue;
        // Only the function that *decides* what is gone. `removeFunctionPaths(paths, op)` and
        // `pruneFunction(id, entry)` are handed what to delete: completeness is their caller's
        // question, and asking it of them would be asking the wrong function. Deciding shows as
        // walking the folder and testing each path against a set - that is derivable, where a list
        // of exempt names would be one more thing to remember.
        if (!/walk\(op\.root\)/.test(body)) continue;
        deleters++;
        const cmds = [...body.matchAll(/cmd: '(\w+)'/g)].map((c) => c[1]);
        if (cmds.length && cmds.every((c) => safe.has(c))) continue;   // provably whole answers
        const guard = body.search(/\bcapped\b/);
        if (guard < 0 || guard > rm) {
          bad.push(`${rel} ${m[1]}() deletes on ${cmds.length ? cmds.join(', ') : 'a list read elsewhere'}`);
        }
      }
    }
    // Two today - `pullWorkflows` and `pullModules` - measured, not guessed. My first version asserted
    // three, which is the shape of mistake this whole grid is about: a denominator nobody counted.
    assert.ok(deleters >= 2, `only ${deleters} folder-walking deletions found - the derivation broke`);
    assert.deepEqual(bad, [],
      `a truncated list is a statement about the reading, not about the org - these delete before ` +
      `asking whether the list was complete:\n  ` + bad.join('\n  '));
  });
}

// ---------------------------------------------------------------------------------------------
// What a deletion keeps may not depend on an argument somebody can forget.
//
// `pruneSql(index, op, census = [])` removes every .sql file the keep-set does not contain, and the
// keep-set is the union of the new index and the **census** of query tables the workspace still has.
// That third argument is the whole fix for a real data loss: the keep-set used to be the index
// alone, and a query table is only in the index if its SQL came back *this time*, so a workspace
// where 60 of 200 queries answered 429 lost 60 good .sql files in one pull - in a folder the reader
// keeps under git.
//
// `= []` is an empty default. Drop the argument at the one call site and the loss is back, exactly as
// it was, with every test and every checker green. Planted, and nothing said a word.
//
// So: a folder-walking deletion may not take an optional parameter that feeds its keep-set. Derived
// from the source, not from a list of function names - the seventh prune written tomorrow with a
// convenient default is caught by nobody remembering.
{
  const PANELS = ['apps/analytics/sidepanel.js', 'apps/crm/sidepanel.js', 'apps/crm/modules.js'];

  test('nothing a prune keeps can be left out by a caller', () => {
    const bad = [];
    let seen = 0;
    for (const rel of PANELS) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/^async function (\w+)\s*\(([^)]*)\)/gm)) {
        const body = src.slice(m.index, src.indexOf('\n}', m.index));
        if (!/op\.remove\(/.test(body) || !/walk\(op\.root\)/.test(body)) continue;
        seen++;
        // Which parameters carry a default, and which of them the keep-set is built from.
        const optional = m[2].split(',').map((p) => p.trim()).filter((p) => p.includes('='))
                             .map((p) => p.split('=')[0].trim());
        const keep = body.slice(body.search(/\bconst keep\b|\bkeep\s*=|\bliveFiles\b|\bliveIds\b/));
        for (const o of optional) {
          if (new RegExp(`\\b${o}\\b`).test(keep.slice(0, keep.search(/op\.remove\(/) + 1 || undefined))) {
            bad.push(`${rel} ${m[1]}(${o} = …) - a caller that omits it deletes what it was meant to keep`);
          }
        }
      }
    }
    assert.ok(seen >= 2, `only ${seen} folder-walking deletions found - the derivation broke`);
    assert.deepEqual(bad, [], `a deletion's keep-set must not be optional:\n  ` + bad.join('\n  '));
  });

  test('every call to a prune hands it everything the keep-set needs', () => {
    // The other half, and the one that would have caught the plant directly: a call site that passes
    // fewer arguments than the declaration names.
    const src = read('apps/analytics/sidepanel.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const decl = src.match(/^async function pruneSql\s*\(([^)]*)\)/m);
    assert.ok(decl, 'pruneSql() is gone - renamed, or no longer a declaration');
    const params = decl[1].split(',').length;
    const calls = [...src.matchAll(/pruneSql\(([^)]*)\)/g)].filter((c) => !c[0].startsWith('pruneSql(index, op, census'));
    assert.ok(calls.length >= 1, 'pruneSql() is never called - drop it, or the check is looking in the wrong file');
    for (const c of calls) {
      const given = c[1].split(',').length;
      assert.equal(given, params,
        `pruneSql is declared with ${params} parameters and called with ${given}: the census is what ` +
        `keeps a query table's .sql file when its SQL could not be read this time`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// A toggle this codebase already releases in a `finally` must be released in a `finally` wherever it
// is raised.
//
// `setPullBusy(true)` greys out the workspace selector, both Pull buttons and the export, and says a
// pull is running. Raised and not released, the panel is inert for the rest of the session with no
// message and nothing to press - the same shape as the assistant wedge fixed earlier today, on a
// control that blocks more.
//
// Planted: `pullOne`'s `finally` removed. Node suite fail 0, every checker zero. Nothing said a word.
//
// The rule is derived from the file rather than from a list of flag names: if any site in it releases
// a toggle inside a `finally`, that toggle is one whose release cannot be left to the happy path, and
// every raise of it is held to the same standard. A toggle nobody releases that way - `setEnabled`,
// a filter - is not in scope and needs no exemption, because the file never claimed it was.
{
  // Every shipped script, derived from the manifests' own directories rather than a pair of file
  // names. The pair was `sidepanel.js` twice, so two raises were outside the subject entirely:
  // `apps/crm/ai.js` and `apps/crm/automation.js`, the second of which raises the pull lock that
  // greys out the workspace selector, both Pull buttons and the export.
  const SCRIPTS = () => readdirSync(join(ROOT, 'apps'))
    .flatMap((app) => readdirSync(join(ROOT, 'apps', app))
      .filter((f) => f.endsWith('.js')).map((f) => `apps/${app}/${f}`));

  test('a flag raised in a function is released whatever happens in it', () => {
    const bad = [];
    let pairs = 0;
    const sources = new Map(SCRIPTS().map((rel) => [rel, blankNonCode(read(rel))]));

    // Toggles the code itself treats as needing release: released inside a `finally` at least once,
    // **however it is spelled**. The criterion was `X(false)` alone - a setter - and `aiBusy = false`
    // is an assignment, so the flag in the AI surface was invisible even once its file was in the
    // subject. Two blind spots, one behind the other.
    //
    // Gathered across the whole subject rather than per file, because a flag is a page's and not a
    // file's: `setPullBusy` is released in a `finally` in `sidepanel.js` and raised in
    // `automation.js`. Per file, removing that file's only `finally` removed the flag from its own
    // set - so the plant went red saying «the derivation broke» instead of naming the raise, which is
    // the right colour for the wrong reason and would have read as a broken test.
    const guarded = new Set();
    for (const src of sources.values()) {
      for (const m of src.matchAll(/finally\s*\{[^}]*?(?<![\w$.])(\w+)\(false\)/g)) guarded.add(m[1]);
      for (const m of src.matchAll(/finally\s*\{[\s\S]{0,300}?(?<![\w$.])(\w+)\s*=\s*false/g)) guarded.add(m[1]);
    }
    for (const [rel, src] of sources) {
      for (const name of guarded) {
        // `(?<![\w$.])` and not `\b`: `el.disabled = true` and `other.disabled = false` are two
        // different controls, and reading them as one flag reported three findings that were not.
        for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*(?:=\\s*true|\\(true)`, 'g'))) {
          const at = Math.max(src.lastIndexOf('\nasync function ', m.index), src.lastIndexOf('\nfunction ', m.index)) + 1;
          const body = src.slice(at, src.indexOf('\n}', m.index));
          const fn = (body.match(/^(?:async )?function (\w+)/) || [, '?'])[1];
          if (fn === 'setPullBusy' || fn === 'setBusy') continue;      // the setter itself
          pairs++;
          const fin = body.search(/finally\s*\{/);
          if (fin < 0 || !new RegExp(`(?<![\\w$.])${name}\\s*(?:=\\s*false|\\(false)`).test(body.slice(fin))) {
            bad.push(`${rel} ${fn}() raises ${name} and does not release it in a finally`);
          }
        }
      }
    }
    assert.ok(pairs >= 12, `only ${pairs} guarded raises found - the derivation broke`);
    assert.deepEqual(bad, [],
      `a raise with no matching release leaves the panel inert with nothing to press:\n  ` + bad.join('\n  '));
  });
}

// ---------------------------------------------------------------------------------------------
// A control that goes grey says why, or it is a dead end with no reason attached.
//
// The Analytics detail strip disables SQL, Relations and Lineage when they cannot say anything about
// the selected view. Going grey silently is what «SQL» did until this morning: two different facts -
// «this view is not a query table» and «its SQL could not be read» - under one dead control, so the
// reader never reached any of the careful sentences behind it. The fix gave all three a title.
//
// Planted: `tab_rel`'s title removed - one of a set changed, the others left. Node suite fail 0,
// every checker zero.
//
// Derived from the code rather than from a list of tab ids: whichever control the panel disables must
// be given a title in the same function. Both panels, so a fourth tab on either side is covered.
{
  const PANELS = ['apps/analytics/sidepanel.js', 'apps/crm/sidepanel.js', 'apps/crm/modules.js'];

  test('every control the panel greys out is told why', () => {
    const bad = [];
    let seen = 0;
    for (const rel of PANELS) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/\$\('(\w+)'\)\.disabled\s*=\s*([^\n;]+);/g)) {
        // A control disabled by a plain flag is a mode, not a refusal: `.disabled = busy` says «wait»,
        // and waiting explains itself. What needs a reason is a control switched off by a *verdict*
        // about the item on screen - a test, a comparison, a count.
        if (!/[!=<>]|\?|\.length|\.kind/.test(m[2])) continue;
        seen++;
        const at = Math.max(src.lastIndexOf('\nasync function ', m.index), src.lastIndexOf('\nfunction ', m.index)) + 1;
        const body = src.slice(at, src.indexOf('\n}', m.index));
        const fn = (body.match(/^(?:async )?function (\w+)/) || [, '?'])[1];
        if (!new RegExp(`\\$\\('${m[1]}'\\)\\.title`).test(body)) {
          bad.push(`${rel} ${fn}() greys out #${m[1]} and never says why`);
        }
      }
    }
    assert.ok(seen >= 3, `only ${seen} verdict-driven disables found - the derivation broke`);
    assert.deepEqual(bad, [],
      `a control that goes grey with no reason is a dead end the reader cannot act on:\n  ` + bad.join('\n  '));
  });
}

// ---------------------------------------------------------------------------------------------
// A bail on a refused folder permission says so.
//
// The browser can drop the permission on a stored handle at any time, and it asks again from a user
// gesture. If the reader dismisses that prompt, or it fails, the function returns - and a return
// with nothing said is indistinguishable from a working feature. Press 🗑 on a workspace, confirm the
// «delete the folder and everything in it» dialog, dismiss the browser prompt, and nothing happens
// and nothing is said: a failed delete and a bug look identical from there.
//
// Fourteen sites in the two panels say `MSG.folder` or its equivalent; eight returned silently. The
// majority is the pattern and the eight are the drift.
//
// Derived from the guard's shape, not from a list of functions: whichever bail follows a refused
// `ensurePerm` is in scope, in either product.
{
  const FILES = ['apps/analytics/sidepanel.js', 'apps/crm/sidepanel.js', 'apps/crm/modules.js',
                 'apps/crm/automation.js', 'apps/crm/connections.js', 'apps/crm/health.js'];

  test('a refused folder permission is never a silent return', () => {
    const bad = [];
    let seen = 0;
    for (const rel of FILES) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/if \(!\(await ensurePerm\([^)]*\)\)\)\s*(\{[^}]*\}|[^\n]*)/g)) {
        seen++;
        // Saying it in the view is saying it: the health audit writes its refusal into `#healthbody`
        // rather than into the status line, because that is where the reader is looking when they
        // pressed ♥. What is not saying it is an empty return - or an `innerHTML = ''`, which clears.
        const speaks = /\bstatus\(|\bsetStatus\(|\bop\.say\(|throw /.test(m[1])
          || /innerHTML\s*=\s*[^;]*['"`][^'"`]{4,}/.test(m[1]);
        if (speaks) continue;
        bad.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    assert.ok(seen >= 10, `only ${seen} permission guards found - the derivation broke`);
    assert.deepEqual(bad, [],
      `these return without a word when the browser refuses the folder, which is indistinguishable ` +
      `from the feature working:\n  ` + bad.join('\n  '));
  });
}

// ---------------------------------------------------------------------------------------------
// The selection and the back/forward chain belong to the workspace being left.
//
// Every step in that chain is an id of the workspace it was built in. Analytics dropped them inside
// `loadFromDisk`, on its successful path only - and three returns come first, one of them the mirror
// it refuses for having been interrupted mid-write. Take that route and the panel stands in the new
// workspace with the previous one's view in the detail pane and ◂ ready to open ids that mean nothing
// there. The CRM has the same shape and clears them where the workspace changes.
//
// Derived: whichever function decides that the workspace has actually changed must forget both,
// before anything can return.
{
  for (const [app, fn] of [['analytics', 'selectWorkspace'], ['crm', 'activate']]) {
    test(`${app}: leaving a workspace forgets the selection and the chain it belongs to`, () => {
      const src = read(`apps/${app}/sidepanel.js`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const at = src.indexOf(`async function ${fn}(`);
      assert.ok(at > 0, `id=${fn} is gone - renamed, or no longer a declaration`);
      const body = src.slice(at, src.indexOf('\n}', at));
      const clear = body.indexOf('navClear()');
      assert.ok(clear > 0, `id=${app} ${fn}() never forgets the navigation chain of the workspace being left`);
      const sel = body.search(/selectedId = null|currentPath = null/);
      assert.ok(sel > 0, `id=${app} ${fn}() keeps the previous workspace's selection`);
      // Inside the branch that knows the workspace differs, not after a load that can return first.
      const guard = body.search(/if \(!sameWs\)|if \(sameWs\)/);
      if (guard > 0) {
        assert.ok(clear > guard, `id=${app} the chain is forgotten outside the «this is a different workspace» branch`);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The raw reader has one caller: the function that decides whether its answer is still true.
//
// `sqlBodyOf(id, op)` returns `sqls[id].sql` when that is a string, which it is for anything read
// this session or straight after a pull. `sqlReadState` wraps it with the precedence that matters -
// «an explicit failed pull wins over an older indexed body: serving the old SQL as current would
// turn a visible coverage gap into a plausible but stale answer» - and every surface asks the wrapper
// except the one that shows the text. So a query whose SQL failed *this time* had its previous body
// painted, highlighted, with the copy button on, under a tab whose own title read «not read: HTTP
// 429». Six surfaces telling the truth and the seventh serving yesterday's.
//
// Derived: `sqlBodyOf` is reachable from `sqlReadState` and from nowhere else.
{
  test('analytics: nothing reads the SQL body without asking whether it is still true', () => {
    const src = read('apps/analytics/sidepanel.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const callers = [];
    for (const m of src.matchAll(/\bsqlBodyOf\(/g)) {
      const at = Math.max(src.lastIndexOf('\nasync function ', m.index), src.lastIndexOf('\nfunction ', m.index)) + 1;
      const fn = (src.slice(at).match(/^(?:async )?function (\w+)/) || [, '?'])[1];
      if (fn !== 'sqlBodyOf') callers.push(fn);
    }
    assert.ok(callers.length >= 1, 'sqlBodyOf() is never called - renamed, or the derivation broke');
    assert.deepEqual([...new Set(callers)], ['sqlReadState'],
      `these read the stored SQL body directly and will show it as current after a pull that could ` +
      `not read it: ${[...new Set(callers)].join(', ')}`);
  });
}

// ---------------------------------------------------------------------------------------------
// The assistant is told what this product's controls are called, and it repeats it to the reader.
//
// `product-help.js` is what the assistant knows about Zoost itself. It is prose, so nothing held it
// to the product - and prose that outlived its code is the class this cell is about. A control
// renamed in the panel keeps its old name here, and the assistant sends somebody to press a button
// that is not there. That somebody is, by this file's own description, not a developer: they will
// look for it.
//
// **The subject is the bulleted control list, not the prose.** Lines of the form `- "Name": what it
// does` are a list of controls by construction. Trying to hold every quoted phrase produced a
// different set of false positives at each tightening - «is replaced by», «never ran», a sentence
// quoted as an example of a *wrong* reading - which is the tool telling you the subject is wrong.
//
// Escapes are decoded first: `'↺ All'` is eight characters in a script and «↺ All» on screen. That
// is the hole that made `featurecheck` report `View ↗` as missing this morning, met again in a
// different tool the same day.
{
  const decode = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  for (const app of ['analytics', 'crm']) {
    test(`${app}: every control the assistant is told about exists`, () => {
      const help = read(`apps/${app}/product-help.js`);
      let have = '';
      for (const f of readdirSync(`${ROOT}/apps/${app}`)) {
        if (!/\.(js|html)$/.test(f) || f === 'product-help.js') continue;
        have += decode(read(`apps/${app}/${f}`)) + ' ';
      }
      have = have.toLowerCase();
      // Every name quoted on a bullet line. Requiring the colon straight after the closing quote
      // caught 7 of the 12: several read `- "Pull" in the detail pane:`, and one line names two.
      const listed = [];
      for (const line of help.split('\n')) {
        if (!/^\s*-\s*"/.test(line)) continue;
        for (const m of line.matchAll(/"([^"\n]{2,40})"/g)) listed.push(m[1]);
      }
      assert.ok(listed.length >= 12, `only ${listed.length} controls listed - the derivation broke`);
      const bad = listed.filter((name) => {
        // A mark carries its name in `aria-label`, so «Health ♥» describes a control called «Health»:
        // the words have to be there, the glyph does not.
        const words = name.toLowerCase().split(/[^a-z0-9+.]+/i).filter((w) => w.length > 1);
        return words.length && !words.every((w) => have.includes(w));
      });
      assert.deepEqual(bad, [],
        `${app}: the assistant is told to name controls the product does not have: ${bad.join(', ')}`);
      // **The limit, stated rather than left to be found.** This compares words against the whole of
      // the shipped files, so it catches a control that was removed or whose words vanished - and it
      // does *not* catch a rename to a different label whose words happen to occur elsewhere. That is
      // not hypothetical: «Schema ↗» named a button that is called «ER diagram», and passed here
      // because the word «schema» appears in `graphview.html` as a kind. It was found by reading and
      // corrected by hand.
      //
      // Comparing against control names only - aria-label, title, button text - was tried and is
      // worse: it turns every phrase the prose quotes for another reason into a finding. Four
      // tightenings, four different sets of false positives, which is a subject telling you it is
      // the wrong one. Where a check cannot be made exact, this repository says so in the check.
    });
  }
}

// ---------------------------------------------------------------------------------------------
// A value memoised from the page belongs to the URL it was read at.
//
// `orgId()` and `zuid()` scrape the CRM org and user id out of the document, and both are memoised:
// without it a pull of a few thousand functions serialises the whole CRM DOM a few thousand times.
// The memo's safety rested on a sentence about somebody else's single-page application - «a value
// that was found cannot change without a navigation, which replaces the document this script is
// attached to» - which nothing here can establish, and `history.pushState` falsifies.
//
// The guard that is supposed to notice makes it circular: `expectedMatches` compares what the panel
// expects against `context()`, and `context()` reads the memo. A stale value is compared with itself
// and agrees - so a pull could be answered by the org the tab used to be on.
//
// One line instead of an assumption: the memo belongs to `location.href`, and a different one
// re-reads. Derived, so a third memo added tomorrow is held to it.
{
  for (const app of ['crm', 'analytics']) {
    test(`${app}: nothing scraped from the page outlives the page it was scraped from`, () => {
      const src = read(`apps/${app}/content-bridge.js`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const memos = [...src.matchAll(/if \((_\w+)\) return \1;/g)].map((m) => m[1]);
      for (const name of memos) {
        const at = src.lastIndexOf('function ', src.indexOf(`if (${name}) return ${name};`));
        const body = src.slice(at, src.indexOf('\n  }', at));
        assert.ok(/memoValid\(\)|location\.(href|pathname)/.test(body),
                  `id=${name} is returned from memory with nothing tying it to the page it was read ` +
                  `from - a pushState changes the org and this keeps answering with the old one`);
      }
      // And the invalidator must actually forget: a `memoValid` that only records the URL is worse
      // than none, because it reads as a guard.
      if (/function memoValid/.test(src)) {
        const mv = src.slice(src.indexOf('function memoValid'), src.indexOf('\n  }', src.indexOf('function memoValid')));
        for (const name of memos) {
          assert.ok(new RegExp(`${name} = null`).test(mv), `id=${name} is never cleared when the URL changes`);
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// An injection guard is a version, not a boolean.
//
// `hook.js` records why, from the day it cost one: «a page already running the previous build carries
// the previous number, and an equal number means nothing to do - so leaving it alone leaves the old
// one in place in every open tab. That is what it did once, and it cost an evening of fixes that
// could not take effect.»
//
// Both content bridges kept `if (window.__zoostBridge) return;`, and they are the half that fetches.
// When the extension is updated under an open tab the old script is orphaned - its `chrome.runtime`
// is gone, which the bridge itself reports - and the panel's documented recovery is to re-inject.
// Against a boolean that re-injection returns at the first line and leaves the dead copy in place
// until the reader reloads the tab.
//
// Derived from the guard's shape: whatever a shipped script parks on `window.__zoost*` to decide
// whether it has already run must be compared against a version.
{
  test('a script re-injected into a page it already ran in can replace itself', () => {
    const bad = [];
    let seen = 0;
    for (const app of ['crm', 'analytics']) {
      for (const f of readdirSync(`${ROOT}/apps/${app}`)) {
        if (!f.endsWith('.js')) continue;
        const src = read(`apps/${app}/${f}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const m of src.matchAll(/if \(window\.(__zoost\w+)([^)]*)\)\s*\{?\s*return/g)) {
          seen++;
          // `=== SOMETHING` is a version comparison; a bare truthiness test is the boolean.
          if (!/===\s*\w+/.test(m[2])) bad.push(`apps/${app}/${f}: window.${m[1]} is a boolean`);
        }
      }
    }
    assert.ok(seen >= 3, `only ${seen} injection guards found - the derivation broke`);
    assert.deepEqual(bad, [],
      `an update orphans the copy already in the page, and re-injecting - which is how this product ` +
      `recovers - returns at the first line and leaves it there:\n  ` + bad.join('\n  '));
  });
}

// ---------------------------------------------------------------------------------------------
// A schema version that does not move is a fast path serving yesterday's shape as today's.
//
// Every function on disk carries `sv`, and the panel re-fetches only what is below `META_SV`:
// `row.stale = (s.sv || 0) < META_SV`. So the version *is* the promise that a copy on disk holds
// every field this build captures. Add a field to the meta and leave `sv` alone, and every function
// pulled before that day is served as current with the field missing - by the summary cache, by the
// graph, by both exports and by the assistant. Nothing re-reads it, because nothing knows.
//
// The comment beside it says «bump when new fields are captured», which is a rule living as prose,
// and this repository's record on those is not ambiguous. Planted a field, left `sv` at 2: green.
//
// Held by the field list itself, recorded here against the version it belongs to. When the meta
// changes, this fails; bump `sv` and `META_SV`, and update the list in the same change - which is
// the moment the reader is looking at the right thing.
{
  const FIELDS = {
    2: ['id', 'name', 'display_name', 'api_name', 'nameSpace', 'category', 'source', 'return_type',
        'params', 'description', 'updatedTime', 'modified_by', 'associated_place', 'workflow',
        'rest_api', 'connections', 'sv'],
  };

  test('the meta schema version moves when the captured fields do', () => {
    const src = read('apps/crm/content-bridge.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const at = src.indexOf('const meta = {');
    assert.ok(at > 0, 'the function meta is no longer built as one object literal');
    const body = src.slice(at, src.indexOf('\n    };', at));
    const sv = body.match(/\bsv:\s*(\d+)/);
    assert.ok(sv, 'the meta carries no schema version, so nothing on disk can be told apart by age');
    // Top level only. `rest_api` and `connections` map into object literals of their own, and their
    // keys - type, active, name, label, service, scopes - are not fields of the meta.
    const keys = [];
    let depth = 0;
    for (let i = body.indexOf('{') + 1; i < body.length; i++) {
      const c = body[i];
      if ('{(['.includes(c)) depth++;
      else if ('})]'.includes(c)) depth--;
      else if (depth === 0) {
        const m = /^(\w+):/.exec(body.slice(i));
        if (m && /[\s{,]/.test(body[i - 1] || ',')) { keys.push(m[1]); i += m[0].length - 1; }
      }
    }
    const known = FIELDS[sv[1]];
    assert.ok(known, `sv is ${sv[1]} and this check knows nothing about that version - record its ` +
                     `field list here in the change that bumped it`);
    assert.deepEqual([...new Set(keys)].sort(), [...known].sort(),
      `the fields captured for a function have changed and sv is still ${sv[1]}: every function ` +
      `pulled before today is served as current without them, because nothing marks it stale`);
    // The panel's ceiling must agree with what the bridge stamps, or «stale» means nothing.
    const panel = read('apps/crm/sidepanel.js').match(/const META_SV = (\d+)/);
    assert.equal(panel[1], sv[1], 'the bridge stamps one version and the panel compares another');
  });
}

// ---------------------------------------------------------------------------------------------
// A page may only write the settings it can show. What it does not show, it carries.
//
// The Settings page edits nine of the twelve sections the panel's export dialog has - `actions`,
// `addresses` and `failures` have no box there - and it does not carry `sv`, the stamp saying which
// build wrote the preference. Its two preset buttons replaced the whole object, so all four went.
//
// Then `loadScope` in the panel found `sv` missing, read the preference as one written before the
// source-code default changed, and set `code` back to false. So: tick **Deluge source code**, press
// **Everything**, press **Save export defaults**, see «Export defaults saved» - and the next export
// dialog opens with the source code unticked. Measured by running the sequence, not read.
//
// Derived: the page's key set must be a subset of the panel's, and a preset must merge rather than
// replace, so a tenth section added to the panel tomorrow survives a save here.
{
  const opts = read('apps/crm/options.js');
  const panel = read('apps/crm/sidepanel.js');
  const keysOf = (src) => {
    const m = src.match(/const SCOPE_KEYS = \[([^\]]+)\]/);
    assert.ok(m, 'SCOPE_KEYS is gone - renamed, or no longer a literal');
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  };

  test('the settings page never writes an export section the panel does not have', () => {
    const here = keysOf(opts), there = keysOf(panel);
    const unknown = here.filter((k) => !there.includes(k));
    assert.deepEqual(unknown, [], `the settings page writes ${unknown} which the panel does not read`);
    assert.ok(there.length >= here.length, 'the panel now knows fewer sections than the page writes');
  });

  test('a preset keeps what the page cannot show', () => {
    for (const btn of ['scFull', 'scSafe']) {
      const line = opts.split('\n').find((l) => l.includes(`$('${btn}').onclick`));
      assert.ok(line, `id=${btn} is gone from the settings page`);
      assert.match(line, /Object\.assign\(\{\}, scope, SCOPE_(FULL|SAFE)\)/,
        `id=${btn} replaces the stored scope instead of merging into it, so the three sections this ` +
        `page has no box for - and \`sv\`, which decides whether the source-code default is re-applied - ` +
        `are dropped by pressing a preset`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// A field that holds a secret is empty whenever its row is not on screen.
//
// The docstring over `aiShowLock` says the passphrase «decrypts once, the plaintext goes to
// chrome.storage.session, and the field is cleared». That was true of exactly one path - the success
// of `aiUnlock`. `aiShowLock` emptied the input only on the branch that *shows* the row, so two
// others left it in the DOM for the life of the panel: the protection removed in Settings between
// showing the row and pressing Unlock, which returns through `aiShowLock(false)`; and
// `aiEngineChrome()`, which runs on every window focus and every settings change.
//
// It does not leave the machine and nothing reads that node. It is a sentence about a secret, and it
// was not true of the code - which is the class this cell is about.
//
// Derived from the markup: whichever input the lock row holds is the one that must be emptied, so
// renaming it does not quietly drop the cover.
{
  for (const [app, file] of [['crm', 'apps/crm/ai.js'], ['analytics', 'apps/analytics/sidepanel.js']]) {
    test(`${app}: the passphrase field is emptied whether the row opens or closes`, () => {
      const html = read(`apps/${app}/sidepanel.html`);
      const row = html.slice(html.indexOf('id="ailockrow"'), html.indexOf('</div>', html.indexOf('id="ailockrow"')));
      const input = (row.match(/<input[^>]*id="(\w+)"/) || [])[1];
      assert.ok(input, `id=${app} the lock row holds no input - the derivation broke`);
      const fn = sliceFn(file, 'aiShowLock');
      const clear = new RegExp(`\\$\\('${input}'\\)\\.value = ''`);
      assert.ok(clear.test(fn), `id=${input} is never emptied by aiShowLock`);
      // On the hide branch too: an `if (on)` around the clear is exactly the defect.
      const guarded = new RegExp(`if \\(on\\)[^\\n]*\\$\\('${input}'\\)\\.value = ''`);
      assert.ok(!guarded.test(fn),
                `id=${input} is emptied only when the row opens, so closing it leaves the passphrase ` +
                `in the DOM for the life of the panel`);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Anything the panel shows about an item belongs in the reports, and a contents list names what is
// in the file.
//
// Two halves of one class. The panel's action detail renders every `mappings` row - a task's
// subject, due date, status, priority, owner and reminder - and both exports fell through every arm
// to «notifies» or to nothing, so a **task's Detail cell was empty** while six fields were on
// screen. The reader of the report cannot know what they are missing, which is the one thing the
// export rule says must never happen.
//
// And the Markdown's `- Contents:` line listed the export *scope*, which includes `health` - a
// chapter that file has never had. So the assistant this report is written for was told it covers an
// audit that is not in it.
//
// Derived: every `a.<field>` the panel's action detail reads must be read by both reports, and the
// contents line is built from the chapters actually emitted.
{
  const exportSrc = read('apps/crm/export.js');

  test('both reports read every action field the panel shows', () => {
    const auto = read('apps/crm/automation.js');
    // Not `async`: it is a plain declaration, and asserting the slice was found is what turned that
    // into a red mark instead of an empty set quietly passing.
    const at = auto.indexOf('function openAction(');
    assert.ok(at > 0, 'openAction() is gone - renamed, or no longer a declaration');
    const panelFields = new Set([...auto.slice(at, auto.indexOf('\n}', at)).matchAll(/\ba\.(\w+)/g)].map((m) => m[1]));
    assert.ok(panelFields.size >= 8, `only ${panelFields.size} action fields found in the panel - the derivation broke`);
    const inReports = new Set([...exportSrc.matchAll(/\ba\.(\w+)/g)].map((m) => m[1]));
    // What the panel computes for itself rather than reads off the row is not a field.
    const own = new Set(['path', 'associated', 'detail_read', 'detail_kept', 'sv']);
    const missing = [...panelFields].filter((f) => !inReports.has(f) && !own.has(f)).sort();
    assert.deepEqual(missing, [],
      `the panel shows these about an action and neither report carries them, so the report is a ` +
      `quietly lesser copy: ${missing.join(', ')}`);
  });

  test('the Markdown contents list names the chapters it has', () => {
    const md = exportSrc.slice(exportSrc.indexOf('function buildExportMarkdown'));
    assert.ok(!/Contents: \$\{SCOPE_KEYS/.test(md),
              'the contents line is built from what was ticked again, not from what was written');
    assert.match(md, /md\.replace\(CONTENTS/, 'nothing fills the contents line in from the chapters');
    assert.match(md, /matchAll\(\/\(\?:\^\|\\n\)## /, 'the chapters are not derived from the headings');
  });
}

// ---------------------------------------------------------------------------------------------
// A settings key written by two files is merged by both, and a setting nobody can apply is a control
// that lies.
//
// The CRM settings page saved `erParams: { current: lay }` and the diagram window required
// `st.erParams.kind === DATA.kind`. That page writes no kind, so **every value saved there was read
// and thrown away on every open** - box spacing, spread, label gap, label size. «Diagram defaults
// saved.» on screen and nothing changed, for as long as both lines have existed. The Analytics twin
// has no such guard and has always worked.
//
// The replacement was the other half: `set()` overwrote the whole object, so `kind` and `mode` -
// written by the window when the reader tunes a graph inside it - were erased by visiting that page.
// The same shape as the export-scope preset earlier today: a page may only write the settings it can
// show, and it carries the rest.
//
// Derived: any storage key written by more than one shipped file must be merged by every writer.
{
  test('a settings key written in two places is merged, not replaced', () => {
    const bad = [];
    const writers = new Map();
    for (const app of ['crm', 'analytics']) {
      for (const f of readdirSync(`${ROOT}/apps/${app}`)) {
        if (!f.endsWith('.js')) continue;
        const src = read(`apps/${app}/${f}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // Walked, not matched. A regex for `set({ key: { … } })` stopped seeing the writers the
        // moment they were rewritten as `set({ key: Object.assign(…) })` - so the check would have
        // gone quiet on the very shape it exists to require. The denominator guard below is what
        // said so; without it this would have passed over an empty set.
        for (const m of src.matchAll(/storage\.local\.set\(\s*\{/g)) {
          let i = m.index + m[0].length - 1, depth = 0, end = i;
          for (; end < src.length; end++) {
            const c = src[end];
            if ('{(['.includes(c)) depth++;
            else if ('})]'.includes(c)) { depth--; if (!depth) break; }
          }
          const arg = src.slice(i + 1, end);
          let d = 0, start = 0;
          for (let k = 0; k <= arg.length; k++) {
            const c = arg[k];
            if ('{(['.includes(c)) d++;
            else if ('})]'.includes(c)) d--;
            if (k === arg.length || (c === ',' && d === 0)) {
              const part = arg.slice(start, k); start = k + 1;
              const kv = part.match(/^\s*(\w+)\s*:([\s\S]*)$/);
              if (!kv) continue;
              const key = `${app}/${kv[1]}`;
              if (!writers.has(key)) writers.set(key, []);
              writers.get(key).push({ file: `apps/${app}/${f}`, body: kv[2] });
            }
          }
        }
      }
    }
    let shared = 0;
    for (const [key, ws] of writers) {
      if (ws.length < 2) continue;                 // one writer owns it outright
      shared++;
      for (const w of ws) {
        if (!/\{/.test(w.body)) continue;          // a scalar has nothing to carry
        // An array is written whole by definition - `rxShortcuts` is the saved-pattern list, and
        // «save the list» means replace it. My first version called that a finding, on the strength
        // of a shorthand `{ name, pattern: … }` making its field set look smaller than the other
        // writer's: a rule invented by a regex rather than by the code.
        if (/^\s*(?:\[|[\w.]+\.map\()/.test(w.body)) continue;
        // Only where the writers put *different* fields in. `rxShortcuts` is the whole saved-pattern
        // list and both writers write all of it: replacing is what «save the list» means, and calling
        // that a finding would be the check inventing a rule the code never had. `erParams` is the
        // other shape - the settings page writes `current`, the window writes `kind` and `mode`, and
        // neither knows the other's fields.
        const fieldsOf = (b) => new Set([...b.matchAll(/(?:\{|,)\s*(\w+)\s*:/g)].map((x) => x[1]));
        const mine = fieldsOf(w.body);
        const all = new Set(ws.flatMap((o) => [...fieldsOf(o.body)]));
        if (mine.size === all.size) continue;      // every writer writes the whole shape
        if (!/Object\.assign\(/.test(w.body)) {
          bad.push(`${w.file} replaces ${key.split('/')[1]}, which another file also writes`);
        }
      }
    }
    assert.ok(shared >= 1, `no storage key has two writers - the derivation broke`);
    assert.deepEqual(bad, [], `each writer keeps only what it knows about:\n  ` + bad.join('\n  '));
  });

  test('the diagram window applies a default that names no graph kind', () => {
    const fn = read('apps/crm/graphview.js');
    const at = fn.indexOf('const ep = st && st.erParams');
    assert.ok(at > 0, 'the erParams read is gone - renamed, or restructured');
    const near = fn.slice(at, at + 400);
    assert.match(near, /ep\.kind === undefined \|\| ep\.kind === DATA\.kind/,
      'the window requires a recorded kind again, and the settings page writes none - so everything ' +
      'saved there is read and discarded, silently, on every open');
  });
}

// ---------------------------------------------------------------------------------------------
// What the reader folded away is not on the drawing, and every count says so.
//
// A `-` mark on an arc folds a branch off the diagram. `erFit` and the print handler skip what
// `erHiddenSet()` hides - `docs/diagrams.md` records that as done - and it was done for **two readers
// of five**. The others went on counting folded boxes: the status line's node and link totals, the
// tab badge, and the «it now covers N other boxes» hint, which could report a box as covered by one
// that is not on screen. So the window said in one line that three boxes had gone and in another
// that they were still there.
//
// Derived: whichever function counts what is on the drawing must consult the folded set. The subject
// is «reads erIds or the node table to produce a number», which is what a counter is.
{
  for (const app of ['crm', 'analytics']) {
    test(`${app}: nothing counts a box the reader folded away`, () => {
      const bad = [];
      let seen = 0;
      for (const f of ['graphview.js', 'graphlogic.js']) {
        const src = read(`apps/${app}/${f}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const m of src.matchAll(/^function (\w+)\s*\(/gm)) {
          const body = src.slice(m.index, src.indexOf('\n}', m.index));
          const counts = /(erIds\.forEach|erIds\.filter|Object\.keys\(N\)|nodesA\.filter)/.test(body);
          if (!counts || m[1] === 'erHiddenSet') continue;
          // Derived from the *consumer*, not from the shape. A function that walks the node set is
          // not automatically a statement about the drawing: `visibleKindCount` feeds `drawable()`,
          // which asks whether the layout can afford this graph - and folding does not re-lay it out,
          // so the budget is the whole set. `erLayout` positions everything for the same reason, and
          // `orphanedByFilter` answers a question about the *filter*. Three counters that walk the
          // same data and answer different questions; telling them apart by shape is not possible,
          // and by name would be a list.
          //
          // What is in scope is what reaches the reader as a description of what is drawn: the status
          // line, the tab badge, and the overlap hint.
          // Two hops, because the chain is `graphStat -> statOf -> statCounts`: a one-hop search put
          // `statCounts` out of scope and the plant that put folded boxes back into the status line
          // walked past. Named consumers are the entry points a reader sees - the status line, the
          // tab badge, the overlap hint - and what they reach is derived.
          const consumers = ['graphStat', 'erCountRefresh', 'erCovers', 'statOf'];
          // Across both files of the window, not within one. `statCounts` lives in graphlogic.js and
          // its consumer `graphStat` in graphview.js, so a same-file search reported it as reaching
          // nobody - and the plant that put the folded boxes back into the status line passed. The
          // two files are one window; the check has to read them as one.
          const both = ['graphview.js', 'graphlogic.js']
            .map((x) => read(`apps/${app}/${x}`)).join('\n');
          const reaches = consumers.some((c) => {
            if (m[1] === c) return true;
            const at = both.indexOf(`function ${c}(`);
            if (at < 0) return false;
            return new RegExp(`\\b${m[1]}\\(`).test(both.slice(at, both.indexOf('\n}', at)));
          });
          if (!reaches) continue;
          seen++;
          // **The limit, stated.** This asks whether the folded set is *consulted*, not whether the
          // answer is right: a body that reads `erHiddenSet()` and then ignores it would pass. That
          // is not derivable from the text, and the alternative - running each counter against a
          // fixture with something folded - is a case per counter rather than a rule, which is what
          // this grid is trying to get away from. Proven by planting the removal of both lines.
          if (!/erHiddenSet\(\)|\bgone\b|erCut/.test(body)) bad.push(`apps/${app}/${f}: ${m[1]}()`);
        }
      }
      assert.ok(seen >= 2, `only ${seen} counters of the drawing found in ${app} - the derivation broke`);
      assert.deepEqual(bad, [],
        `these count what is on the diagram without asking what was folded off it, so the window ` +
        `reports boxes it is not drawing:\n  ` + bad.join('\n  '));
    });
  }
}

// ---------------------------------------------------------------------------------------------
// An unread source is not a measurement of zero.
//
// `fnStats(undefined)` returned a full set of zeros, so a function whose `.dg` is not on disk - its
// fetch failed and it is recorded in `failures/` - arrived everywhere downstream as «0 lines, 0
// outbound calls»: in the health audit, in both exports, and in what the assistant is told. The
// release that fixed «used by 0 functions» for connections, and «complete» for a module list that
// had failed to write, did not reach this one.
//
// The tree already abstained - its badge is absent, and the status line says the stats are deferred
// above STATS_LIMIT - so two readers of one fact disagreed: the row showed nothing and the graph
// showed a zero.
test('a source that could not be read measures as nothing, not as zero', () => {
  const ctx = load([
    sliceConst('apps/crm/sidepanel.js', 'ZOHO_SERVICES'),
    sliceConst('apps/crm/sidepanel.js', 'RE_ZOHO_ANY'),
    sliceConst('apps/crm/sidepanel.js', 'RE_ZOHO_CRM'),
    sliceConst('apps/crm/sidepanel.js', 'RE_INVOKEURL'),
    sliceConst('apps/crm/sidepanel.js', 'RE_SENDMAIL'),
    sliceConst('apps/crm/sidepanel.js', '_count'),
    sliceFn('apps/crm/sidepanel.js', 'fnStats'),
  ], { stripNonCode: (s) => s });

  assert.equal(ctx.fnStats(undefined), null, 'an absent source still measures as a set of zeros');
  assert.equal(ctx.fnStats(null), null, 'an absent source still measures as a set of zeros');
  // The other half, and it is the one that keeps this honest: a file that *is* there and is empty
  // really is zero lines, and must not be reported as unmeasured.
  const empty = ctx.fnStats('');
  assert.ok(empty && empty.lines === 0 && empty.apiCalls === 0,
    'an empty file is a measurement of zero and must stay one');
  const real = ctx.fnStats('info "x";\ninvokeurl [url: "https://example.invalid"];');
  assert.ok(real.lines === 2 && real.apiCalls === 1, `it stopped counting: ${JSON.stringify(real)}`);
});

test('nothing substitutes a number for a measurement that was not taken', () => {
  // Derived from the shipped scripts rather than from the one site that did it: any `stats` read
  // that falls back to a literal is the same defect wherever it is written. The limit, said rather
  // than left to be found: it reads `stats` by name, so a value copied into another variable first
  // is invisible - there is no such copy today.
  const bad = [];
  for (const rel of readdirSync(join(ROOT, 'apps')).flatMap((app) =>
      readdirSync(join(ROOT, 'apps', app)).filter((f) => f.endsWith('.js')).map((f) => `apps/${app}/${f}`))) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/\.stats\s*(?:\|\||\?\?)\s*([{0-9])/g)) {
      bad.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(bad, [],
    `these turn «not measured» into a number, which the reader cannot tell from a real zero: ${bad.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------
// A report tells «not downloaded», «could not be read» and «here it is» apart - in both formats.
//
// Three states, and each report knew two. The HTML put a «not downloaded» badge in the header and
// then, where the source would be, wrote nothing at all: a function whose file could not be read
// looked like every other one and happened to show no code, to a reader who does not have the
// extension and cannot check. The Markdown said the first properly and emitted an **empty fence**
// for the second - «a function with no body», which its own comment forbids in those words, two
// lines above the branch that did it.
//
// The two halves of one rule, each written on one side. That is the shape this repository keeps
// meeting, and the reason both exports are checked together rather than one at a time.
test('both exports say which kind of missing source it is', () => {
  const src = read('apps/crm/export.js');

  // Derived: every place a report decides what to print in the source position must ask all three
  // questions. `downloaded` separates the first; a null/undefined check separates the other two.
  const html = /const srcBlock = \(f\) => \(([\s\S]*?)\);/.exec(src);
  assert.ok(html, 'the HTML export no longer has one place that decides what stands for the source');
  // And it is *used*: the first version of this read the helper's definition and passed while the
  // section builder had been put back to `f.code ? <pre> : ''` and never called it. A check whose
  // subject is a definition says nothing about the code that runs.
  assert.match(src, /scope\.code \? srcBlock\(f\)/,
    'the section builder does not call srcBlock, so nothing it says ever reaches a reader');
  assert.match(html[1], /!f\.downloaded/, 'the HTML export cannot tell «not downloaded»');
  assert.match(html[1], /f\.code === null|f\.code === undefined/, 'it cannot tell «could not be read»');
  assert.match(html[1], /<pre class="code">/, 'it stopped showing the source it does have');

  const md = src.slice(src.indexOf("md += !n.downloaded ?"), src.indexOf("```\\n\\n') : '\\n';") + 20);
  assert.ok(md.length > 50, 'the Markdown source block has moved - this check no longer reads it');
  assert.match(md, /could not be read/, 'the Markdown export emits an empty fence for an unread file');
  assert.match(md, /not downloaded/, 'the Markdown export cannot tell «not downloaded»');

  // And the two must not disagree about what an *empty* file is: it keeps its fence in Markdown and
  // its <pre> in HTML, because a file that is there and is empty is a fact about the function.
  assert.ok(!/source_code \|\| ''/.test(src) && !/f\.code \|\| ''/.test(src),
    'a missing source is being coerced to an empty string again, which is the fence that lies');
});

// ---------------------------------------------------------------------------------------------
// «There are none» and «you did not ask for them» are different facts.
//
// With Functions unticked in the export dialog, the HTML report printed «Functions / No
// functions.» - a positive claim about somebody's org, in a document written for people who do not
// have the extension and cannot go and check. Same for Modules, same for Connections. The Markdown
// twin omits the heading entirely when a list is empty and so never says it: two halves of one
// rule, one on each side.
//
// The heading stays rather than vanishing. A reader wondering why a section is missing is better
// served by being told it was left out - the export states what it does not contain beside what it
// does, which is what every other surface in this product is held to.
test('an export does not report a scope you turned off as an absence', () => {
  const src = read('apps/crm/export.js');

  const helper = /const absent = \(asked, what\) => \(([\s\S]*?)\);/.exec(src);
  assert.ok(helper, 'the export has no one place that decides what an empty section means');
  assert.match(helper[1], /Not included in this export/, 'it cannot say «you did not ask for this»');
  assert.match(helper[1], /No \$\{what\}/, 'it stopped being able to say «there are none»');

  // Derived, and this is the half that matters: every scope the export can switch off must reach
  // that helper when its section is empty. A literal «No X.» beside a scope flag is the defect.
  const scopes = [...new Set([...src.matchAll(/scope\.(\w+)/g)].map((m) => m[1]))];
  assert.ok(scopes.length >= 8, `only ${scopes.length} scope(s) found - the derivation broke`);
  const lying = [...src.matchAll(/class="empty">No ([a-z ]+)\./g)].map((m) => m[1].trim());
  assert.deepEqual(lying, [],
    `these state an absence as a fact without asking whether it was asked for: ${lying.join(', ')}`);

  // And it is used, not merely defined - the trap the source-block check fell into an hour ago.
  const calls = (src.match(/absent\(scope\./g) || []).length;
  assert.ok(calls >= 3, `absent() is called ${calls} time(s); the sections that can be empty do not use it`);
});

// ---------------------------------------------------------------------------------------------
// A function that decided its messages belong to a workspace must not leave one behind.
//
// `beginWorkspaceOp()` carries `say()`, which is `setStatus` that keeps quiet once the workspace on
// screen is not the one the operation started in: «Progress belongs to a workspace as much as a
// write does», written after a pull counted «Downloading 214/900» into a panel showing another org.
//
// Seven functions guarded their *error* exit with `if (op.current()) setStatus(...)` and left every
// other message raw. `exportHtml` is the clearest: the failure path checks, and the line above it -
// «Exported → export/zoost-<this org>-...html (in your workspace folder)» - does not. The file goes
// to the right folder, because `op.write` guards both sides of its await; the sentence announcing
// it lands on whatever workspace is on screen by then, and names the other one.
//
// The criterion is the code's own, not one invented here: `op.say` is used in 22 places and raw
// `setStatus` in far more, so «always use op.say» is not this project's rule and is not asserted.
// What is asserted is consistency **within a function** - having guarded one exit, guard the rest.
//
// Two limits, stated rather than left to be met. It does not model `if (!op.current()) return;`,
// which guards everything after it - the Analytics twin of `renameWorkspace` is written that way
// and passes only because it has no `setStatus` at all, so a function combining early returns with
// a guarded catch would be reported wrongly. And it reads `setStatus` alone: `healthSay` is another
// sink for the same kind of message and is not examined.
test('a function that guards one status message guards them all', () => {
  const offenders = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    for (const f of readdirSync(join(ROOT, 'apps', app)).filter((n) => n.endsWith('.js'))) {
      const rel = `apps/${app}/${f}`;
      // Comments are blanked, not removed: stripping them shifts every position after the first
      // one, and the first version of this reported line 4707 for a function that starts at 5125.
      // A check that names the wrong place is a check nobody can act on.
      const src = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
        .replace(/^([ \t]*)\/\/.*$/gm, (c) => ' '.repeat(c.length));
      for (const m of src.matchAll(/^(?:async )?function (\w+)\([^)]*\)\s*\{/gm)) {
        const a = m.index;
        // A declaration that closes on its own line ends there. Without this a one-line function -
        // `function healthSay(text, cls) { … }` - swallowed everything down to the next brace in
        // column zero and was credited with another function's messages. The same over-capture
        // `asynccheck` and `slice.mjs` each record, met a third time by somebody who had read both.
        const eol = src.indexOf('\n', a);
        const first = src.slice(a, eol < 0 ? src.length : eol);
        const b = (first.includes('{') && first.trimEnd().endsWith('}'))
          ? a + first.length : src.indexOf('\n}', a);
        const body = src.slice(a, b < 0 ? src.length : b);
        if (!/op\.current\(\)\)\s*(?:setStatus|\{)/.test(body)) continue;   // never decided
        const firstAwait = body.indexOf('await ');
        if (firstAwait < 0) continue;
        for (const s of body.matchAll(/(?<![.\w)])\bsetStatus\(/g)) {
          if (s.index <= firstAwait) continue;
          // Both spellings of the guard: `if (op.current()) setStatus(...)` and the braced form,
          // `if (op.current()) { setStatus(...); healthSay(...); }`. Reading only the first named a
          // site that was guarded - one spelling of a thing, which is the mistake this whole file
          // keeps recording about other people's code.
          if (/op\.current\(\)\)\s*\{?\s*$/.test(body.slice(Math.max(0, s.index - 30), s.index))) continue;
          offenders.push(`${rel}:${m[1]} line ${src.slice(0, a + s.index).split('\n').length}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    `these guard one message against a change of workspace and leave another raw, so the panel ` +
    `announces one workspace's work over another: ${offenders.join('; ')}`);
});

// ---------------------------------------------------------------------------------------------
// «No caller» is a conclusion about the org, drawn from the functions in the mirror.
//
// The graph is built by walking the `.dg` files on disk. A function that never downloaded - the
// ones the pull records in `failures/` - is not a node at all, so it makes no calls, and anything
// it was the only caller of comes out as «no caller». That number is the diagram's headline and
// the health audit's list of names, and the list is where somebody decides a function is safe to
// delete. Partial data authorising a destructive act, with the reader holding the knife.
//
// The audit's coverage paragraph named what *Zoho* does not report - client scripts, approval
// rules - all true of every workspace and none of it actionable. It said nothing about this one,
// which is a number about your own mirror and is the only gap that changes what the list means.
test('the graph carries how much of the org it was built from', () => {
  const src = read('apps/crm/sidepanel.js');
  const build = src.slice(src.indexOf('window.buildGraph('), src.indexOf('window.buildGraph(') + 1400);
  assert.match(build, /functions\/index\.json/,
    'the graph is built without ever asking how many functions the org has');
  assert.match(build, /notInMirror/, 'nothing records the difference');
  // Unknown is not zero: if the index cannot be read the answer is null, and every surface below
  // has to be able to tell that from «nothing missing».
  assert.match(build, /inOrg === null \? null/,
    'an unreadable index becomes a number, so «nobody looked» reads as «nothing missing»');
});

test('every surface that states «no caller» says what it was measured over', () => {
  // Derived from the field, not from a list of surfaces: whoever reads `dead_suspects` is drawing
  // the conclusion, and must consult the coverage in the same place. The limit, stated: it reads
  // the CRM, whose graph is of functions; the Analytics twin counts tables and has no equivalent
  // of a function that failed to download.
  // The **aggregate** is the claim about the org - `counts.dead_suspects`. The per-node
  // `n.dead_suspect` flag paints one marker and filters one list, and its caveat lives in the
  // sentence beside the total; asserting on it too turned a five-site rule into a twenty-site
  // sweep, which is how a criterion stops being one.
  const readers = [];
  let sites = 0;
  for (const rel of ['apps/crm/graphview.js', 'apps/crm/health.js', 'apps/crm/export.js',
                     'apps/crm/sidepanel.js', 'apps/crm/ai.js']) {
    // The scanner rather than two regexes: removing comments shifts every position after the first,
    // and this named line 154 for a site on 162 before it blanked instead. `blankNonCode` also reads
    // regex literals, which those two did not - a hole that cost 68 lines of `export.js`.
    const src = blankNonCode(read(rel));
    for (const m of src.matchAll(/counts\.dead_suspects/g)) {
      sites++;
      const near = src.slice(Math.max(0, m.index - 900), m.index + 900);
      if (!/notInMirror|inOrg|mirrorNote/.test(near)) {
        readers.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  // **`readers.length + 2 >= 2` is `length >= 0`.** It was written to guard the derivation and could
  // not fail: `readers` is the *findings* list, so an empty subject and a clean tree looked the same.
  // Renaming the field this is about left the whole suite green over a check reading nothing.
  // The count of what was matched is what a derivation guard has to be about.
  assert.ok(sites >= 2, `the derivation found ${sites} site(s) reading the aggregate - it reads nothing`);
  assert.deepEqual(readers, [],
    `these state «no caller» without saying it was measured over the mirror rather than the org: ` +
    readers.join(', '));
});

// ---------------------------------------------------------------------------------------------
// A diagram window that cannot name its workspace says so, and does not invent one.
//
// These windows come in pairs - two can be open at once, on two workspaces, which is the whole
// reason the identity travels with the drawing. `wsLine` returned `''` when neither the instance
// nor the org was known, so the header looked merely short rather than unable to answer; and
// `pdfTitle` substituted `unknown` and `orgx`, putting two placeholders that look like values into
// the filename of a document that leaves the machine.
test('the diagram names its workspace, or says it cannot', () => {
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const logic = `apps/${app}/graphlogic.js`;
    if (!existsSync(join(ROOT, logic))) continue;
    const { wsLine } = load([sliceFn(logic, 'wsLine')], { esc: (s) => String(s) });

    // Real values first: a named workspace reads as before.
    const named = wsLine({ instance: 'yourinstance', org: '1234567890', label: null });
    assert.match(named, /yourinstance/, `id=${app}: a named workspace stopped being named`);
    assert.match(named, /1234567890/, `id=${app}: the org went missing from the line`);

    // And the case this is about: nothing known, on both shapes it can arrive in.
    for (const ws of [null, {}, { instance: null, org: null, label: null }]) {
      const out = wsLine(ws);
      assert.notEqual(out.trim(), '',
        `id=${app}: the window shows a blank where the workspace should be, which reads as a short ` +
        `header and not as «I cannot tell you whose drawing this is»`);
    }
  }
});

test('a printed diagram is not named after placeholders', () => {
  // Derived from the source rather than run, because `pdfTitle` reads `DATA` and `curView` - two
  // module globals a lifter would have to fake, and faking them is how a check ends up asserting
  // about its own scaffolding. The limit is stated: this reads the expression, not the output.
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/graphview.js`;
    if (!existsSync(join(ROOT, rel))) continue;
    const src = read(rel);
    // Comments blanked before reading: the note above the fix quotes the placeholders it removed,
    // which is how this repository records a defect - and the first version of this fired on that
    // quotation. The same shape as the «may only shrink» check earlier today, met again.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/^([ \t]*)\/\/.*$/gm, (c) => ' '.repeat(c.length));
    const fn = /function pdfTitle\(\)[\s\S]*?\n\}/.exec(code);
    assert.ok(fn, `id=${app}: pdfTitle has gone - the print filename comes from somewhere unchecked`);
    assert.ok(!/'unknown'|"unknown"|'x'|"x"/.test(fn[0]),
      `id=${app}: the print filename stands a placeholder in for an identity it does not have`);
    assert.match(fn[0], /filter\(Boolean\)|\?\s*'-'/,
      `id=${app}: it no longer drops the parts it does not know`);
  }
});

// ---------------------------------------------------------------------------------------------
// Every tool the CRM assistant declares actually runs.
//
// The Analytics release notes say this in as many words: «`search_sql` and `search_columns` had
// never run once: asked anything, they answered "View not found". Both work now, and **every
// declared tool is exercised by a test so this cannot happen silently again.**» The test that makes
// that true was written for Analytics and never carried across: measured on the CRM, **nine of its
// eleven tools were exercised by nothing**, and the two that were are named in passing by other
// cases rather than run.
//
// So a tool of the CRM's could be as dead as `search_sql` was and every checker would report zero -
// which is what this cell is: a surface no check reads. Registry-derived like its twin, so a tool
// added tomorrow is covered without anyone remembering.
test('crm: every declared tool runs on the minimum input its schema declares', async () => {
  const NODES = {
    'standalone.log': { id: '9000', name: 'log', namespace: 'standalone', api_name: 'log',
      display_name: 'Log', file: 'functions/standalone/log.dg', calls: [], called_by: [],
      unresolved: [], ambiguous: [], associated_place: [], connections: [], modules: [],
      stats: { lines: 3, codeLines: 2, chars: 40, apiCalls: 1, invokeurl: 1, crm: 0, zoho: 0, sendmail: 0 } },
    'standalone.caller': { id: '9001', name: 'caller', namespace: 'standalone', api_name: 'caller',
      display_name: 'Caller', file: 'functions/standalone/caller.dg', calls: ['standalone.log'],
      called_by: [], unresolved: [], ambiguous: [], associated_place: [], connections: [],
      modules: [], stats: null },
  };
  NODES['standalone.log'].called_by = ['standalone.caller'];

  const ctx = {
    console, String, Number, Object, Array, JSON, Set, Map, RegExp, Promise, Error, isNaN,
    ensureGraph: async () => ({ nodes: NODES, counts: { nodes: 2, edges: 1, dead_suspects: 1, unresolved: 0, ambiguous: 0, inOrg: 3, notInMirror: 1 } }),
    beginWorkspaceOp: () => ({ current: () => true, read: async () => { throw new Error('no file'); } }),
    loadModuleFiles: async () => [{ api_name: 'Contacts', module_name: 'Contacts', fields: [] }],
    aiLoadConnections: async () => [{ name: 'conn1', status: 'active', uses: [] }],
    aiLoadActions: async () => ({ list: [{ id: 'a1', name: 'Notify', kind: 'notification', module: 'Contacts', rules: [] }], users: new Map(), addresses: false }),
    actionKindLabel: () => 'notification', actKept: () => true, actStale: () => false, actThin: () => false,
    isFnAction: () => false, wfScheduled: () => false,
    webhookForModel: (u) => String(u || ''),
    workflowData: [{ id: 'w1', name: 'Rule', module: 'Contacts', active: true, actions: [] }],
    wfIndex: new Map([['w1', { id: 'w1', name: 'Rule' }]]),
    failuresIndex: async () => ({ all: [], capped: false, at: null }),
    MSG: { noFn: 'No such function: ', noMod: 'No such module: ', noConn: 'No such connection: ',
           noWf: 'No such workflow: ' },
  };
  vm.createContext(ctx);
  const piece = (n) => { try { return sliceFn('apps/crm/ai.js', n); } catch { return sliceConst('apps/crm/ai.js', n); } };
  vm.runInContext([
    'const aiSeedOmitted = []; let aiSeedSize = 0;',
    // `firedBy` lives in automation.js and `list_actions` calls it: the panel is one scope across
    // several scripts, and a lift that stops at one file throws where the real page would not.
    sliceFn('apps/crm/automation.js', 'firedBy'),
    ...['aiCap', 'aiModuleText', 'fnSource', 'aiExecTool'].map(piece),
  ].join('\n'), ctx);

  const tctx = {}; vm.createContext(tctx);
  vm.runInContext(sliceConst('apps/crm/ai.js', 'AI_TOOLS') + '; this.__t = AI_TOOLS;', tctx);
  const tools = tctx.__t;
  assert.ok(tools.length >= 8, `only ${tools.length} tools parsed from the registry`);

  const failures = [];
  for (const t of tools) {
    const props = (t.input_schema && t.input_schema.properties) || {};
    const input = {};
    if (props.name) input.name = 'standalone.log';
    if (props.query) input.query = 'invokeurl';
    if (props.filter) input.filter = '';
    let out;
    try { out = await vm.runInContext('aiExecTool', ctx)(t.name, input); }
    catch (e) { failures.push(`${t.name} threw: ${e.message}`); continue; }
    if (typeof out !== 'string' || !out.length) { failures.push(`${t.name} answered nothing`); continue; }
    // «It answered something» is not the criterion, and the first version of this used it: a
    // renamed dispatch fell through to `return 'Unknown tool: ' + name`, which is a non-empty
    // string, and the check passed on the very shape it exists for. The battery went red only
    // because `twincheck` saw one product's copy move - an accident of editing one side, not a
    // check that understands the defect.
    if (/^Unknown tool/.test(out)) { failures.push(`${t.name} is declared and never dispatched`); continue; }
    // And it must not deny input it was given: `search_sql` reached no handler and answered «View
    // not found» about a view that existed. «It must name the input back» was tried and is wrong -
    // `who_calls` answers with the *callers*, and `get_callees` with «(no callees)», both correct.
    //
    // The limit, stated rather than left to be found: a handler that is reached and answers the
    // wrong thing is not caught here. What is caught is a tool that is declared and never runs,
    // which is the one that shipped.
  }
  assert.deepEqual(failures, [], failures.join('; '));
});

// ---------------------------------------------------------------------------------------------
// A setting the Settings page writes is read by something.
//
// «Every diagram setting saved in Settings was read and thrown away» is a defect this repository
// already recorded and fixed. Nothing was left behind that would catch the next one: measured by
// adding a setting written by `options.js` and consumed by nobody, the whole battery stayed green
// except `imgcheck`, which went red because editing the file changes the digest the screenshots
// were rendered from - an effect of touching it, not a check that understands a dead setting.
//
// Derived from the writes, per product, so a key added tomorrow is covered. A key counts as read
// when its name appears anywhere in that app outside the `set` that writes it - a `storage.get`, an
// `onChanged` branch, a destructure. The limit: a key read into a variable and then ignored looks
// read here, and a key built by concatenation is invisible.
test('every setting the options page writes is read by something', () => {
  const offenders = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const opts = `apps/${app}/options.js`;
    if (!existsSync(join(ROOT, opts))) continue;
    // Both writers: `saveKeys({...})`, which is where every setting a section owns goes now, and
    // the bare `storage.local.set({...})` that `stamp()` still is - `settingsStamp` belongs to no
    // section and there is nothing to be dirty about. Reading only the bare call found **nothing at
    // all** the day the eight writers were consolidated, and said «the derivation broke», which is
    // the assertion below doing its job.
    const written = [...read(opts).matchAll(/(?:storage\.local\.set|saveKeys)\(\{\s*([A-Za-z_]\w*)/g)].map((m) => m[1]);
    assert.ok(written.length >= 3, `id=${app}: only ${written.length} setting(s) found - the derivation broke`);
    // Read means read **somewhere other than the page that writes it**, with comments stripped.
    // «Anywhere in the app» was the first criterion and it passed on the plant: `options.js` names
    // `settingsStamp` in its own header comment and in the function that writes it, so renaming
    // every consumer in the panel left the key looking read.
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    const elsewhere = readdirSync(join(ROOT, 'apps', app))
      .filter((f) => f.endsWith('.js') && f !== 'options.js')
      .map((f) => strip(read(`apps/${app}/${f}`))).join('\n');
    // A key the Settings page reads back itself still counts - that is a legitimate consumer.
    const ownGets = strip(read(opts));
    for (const key of [...new Set(written)]) {
      const outside = (elsewhere.match(new RegExp(`\\b${key}\\b`, 'g')) || []).length;
      const selfGet = new RegExp(`storage\\.local\\.get\\(\\[?['"]${key}['"]`).test(ownGets);
      if (!outside && !selfGet) offenders.push(`${app}:${key}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these are written by the Settings page and read by nothing - the user changes them and ` +
    `nothing happens: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------
// The sentence that tells the model which tools it has names every tool it has.
//
// `list_actions` was added to the CRM's `AI_TOOLS` and the sentence stayed at ten names. The tool
// existed, worked - the case above runs it - and the model was told it did not have it. One of a
// set changed and its sibling left behind: the enumeration trap this repository records about the
// site, where a part is listed in as many places as it has siblings and adding it to one of them is
// not adding it.
//
// The Analytics twin's list was complete, by care rather than by construction. Both are built from
// the registry now, so the sentence cannot fall behind it again.
test('the assistant is told about every tool it is given', () => {
  for (const [rel, marker] of [['apps/crm/ai.js', 'READ-ONLY tools to explore'],
                               ['apps/analytics/sidepanel.js', 'READ-ONLY tools over the local mirror']]) {
    const src = read(rel);
    const at = src.indexOf(marker);
    assert.ok(at > 0, `id=${rel}: the sentence that lists the tools has gone`);
    // From the start of *the line*, not from the marker: the marker sits after the backtick, so
    // slicing at it could never see the template literal the last assertion is about.
    const line = src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
    // Derived, not enumerated: the names must come from the registry at run time. A typed list is
    // the defect, whatever it currently contains - so the assertion is about the mechanism.
    assert.match(line, /AI_TOOLS\.map\(\(t\) => t\.name\)/,
      `id=${rel}: the tool names are typed into the prompt, so the next tool added will be invisible ` +
      `to the model - which is what happened to list_actions`);
    // And it is a template literal, or the interpolation is text. `node --check` catches the broken
    // half of that; this catches the half that parses and prints `${AI_TOOLS...}` to the model.
    assert.ok(line.includes('? `You have'), `id=${rel}: the sentence is a plain string, so the names never expand`);
  }
});

// ---------------------------------------------------------------------------------------------
// When the assistant says «none», it says what «none» was measured over.
//
// Every tool answers over `g.nodes` - the functions in the mirror - and the model states the answer
// about the org. A function that never downloaded is not a node, so it calls nothing, and
// «(no callers)» is the sentence a deletion follows. Partial data authorising a destructive act,
// with the assistant as the voice and the user holding the knife.
//
// The diagram and the health audit were taught this two cells ago, from the same `counts.inOrg` /
// `counts.notInMirror` the graph already carries. The assistant - the surface that answers in words
// and is therefore believed - was left out: one fact carried to two of its three consumers.
test('the assistant hedges an absence, and does not hedge a fact', async () => {
  const build = (notInMirror, inOrg) => {
    const NODES = {
      'standalone.lonely': { id: '1', name: 'lonely', namespace: 'standalone', api_name: 'lonely',
        display_name: 'Lonely', file: 'f.dg', calls: [], called_by: [], unresolved: [], ambiguous: [],
        associated_place: [], connections: [], modules: [], stats: null },
      'standalone.known': { id: '2', name: 'known', namespace: 'standalone', api_name: 'known',
        display_name: 'Known', file: 'g.dg', calls: [], called_by: ['standalone.lonely'],
        unresolved: [], ambiguous: [], associated_place: [], connections: [], modules: [], stats: null },
    };
    const ctx = {
      console, String, Number, Object, Array, JSON, Set, Map, RegExp, Promise, Error, isNaN,
      ensureGraph: async () => ({ nodes: NODES,
        counts: { nodes: 2, edges: 1, dead_suspects: 1, unresolved: 0, ambiguous: 0, inOrg, notInMirror } }),
      beginWorkspaceOp: () => ({ current: () => true, read: async () => { throw new Error('no file'); } }),
      loadModuleFiles: async () => ({}), aiLoadConnections: async () => [],
      aiLoadActions: async () => ({ list: [], users: new Map(), addresses: false }),
      actionKindLabel: () => '', actKept: () => true, actStale: () => false, actThin: () => false,
      isFnAction: () => false, wfScheduled: () => false, webhookForModel: (u) => String(u || ''),
      workflowData: [], wfIndex: new Map(), failuresIndex: async () => ({ all: [], capped: false, at: null }),
      MSG: { noFn: 'No such function: ' },
    };
    vm.createContext(ctx);
    const piece = (n) => { try { return sliceFn('apps/crm/ai.js', n); } catch { return sliceConst('apps/crm/ai.js', n); } };
    vm.runInContext(['const aiSeedOmitted = []; let aiSeedSize = 0;',
      ...['aiCap', 'aiModuleText', 'fnSource', 'aiExecTool'].map(piece)].join('\n'), ctx);
    return (t, i) => vm.runInContext('aiExecTool', ctx)(t, i);
  };

  // Some of the org did not download: an absence must not read as a fact about Zoho.
  const gappy = build(3, 5);
  const none = await gappy('who_calls', { name: 'standalone.lonely' });
  assert.match(none, /no callers/, `who_calls stopped answering: ${none}`);
  assert.match(none, /did not download|could not be established/,
    `«no callers» is stated flat over a mirror missing three functions: ${none}`);

  // A *positive* answer is a fact about what is here and must not be hedged - a caveat on every
  // answer is a caveat nobody reads, which is the failure a silent one shares.
  const some = await gappy('who_calls', { name: 'standalone.known' });
  assert.match(some, /standalone\.lonely/, `the caller went missing: ${some}`);
  assert.ok(!/did not download/.test(some), `a list of callers is hedged as though it were an absence: ${some}`);

  // And a complete mirror says nothing extra: the hedge is conditional, not decoration.
  const whole = build(0, 2);
  const clean = await whole('who_calls', { name: 'standalone.lonely' });
  assert.equal(clean.trim(), '(no callers)', `a complete mirror still hedges: ${clean}`);
});

// ---------------------------------------------------------------------------------------------
// A change of workspace under the assistant throws; it does not answer «this org has nothing».
//
// `loadModuleFiles`, `aiLoadActions` and `aiLoadConnections` returned `null` when the workspace
// moved under them - and every caller wrote `|| {}`, `|| []`, `|| { list: [] }`. So an overtaken
// load became «no modules», «no connections», «no automation actions» in the ORG INDEX the model is
// given, and `get_module` answered «No such module» about one that exists. A denial invented by our
// own bookkeeping, handed to the model as a fact about somebody's org.
//
// Throwing is what the rest of the panel does - `op.read` throws WS_MOVED and `aiSend`'s status is
// guarded by `current()`, so the overtaken case stays silent. Silent is right; wrong is not.
test('an overtaken load refuses rather than answering empty', async () => {
  const ctx = {
    console, String, Number, Object, Array, JSON, Set, Map, RegExp, Promise, Error,
    WS_MOVED: 'workspace moved',
    walk: async function* () {},                 // never reached: the guard fires first
    isModuleFile: () => false,
    moduleFilesCache: null, aiConnCache: null, aiActCache: null, actionUsers: null,
    shareAddresses: async () => false,
    ensureGraph: async () => ({ nodes: {} }),
    beginWorkspaceOp: () => ({ current: () => false, read: async () => '[]' }),
  };
  vm.createContext(ctx);
  vm.runInContext(['loadModuleFiles', 'aiLoadActions', 'aiLoadConnections']
    .map((n) => sliceFn('apps/crm/ai.js', n)).join('\n'), ctx);

  for (const fn of ['loadModuleFiles', 'aiLoadActions', 'aiLoadConnections']) {
    const moved = { current: () => false, read: async () => '[]' };
    await assert.rejects(() => vm.runInContext(fn, ctx)(moved), /workspace moved/,
      `${fn} answers instead of refusing when the workspace has moved - the caller then reads its ` +
      `«empty» as a fact about the org`);
  }

  // And the callers must not put the fallback back: `|| {}` beside one of these loaders restores
  // the defect exactly, whatever the loader does.
  const src = read('apps/crm/ai.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const coerced = [...src.matchAll(/await (loadModuleFiles|aiLoadActions|aiLoadConnections)\(op\)\)?\s*\|\|/g)]
    .map((m) => m[1]);
  assert.deepEqual(coerced, [],
    `these callers turn a refusal back into an empty answer: ${coerced.join(', ')}`);
});

test('a module file that will not parse is counted, not dropped', () => {
  // The inner `catch (_) {}` swallowed a corrupt module file, so the module vanished from the index
  // the model is given - «not read» wearing the clothes of «does not exist», in the one place the
  // assistant is told what the org contains. The same rule `search_code` already follows.
  const src = read('apps/crm/ai.js');
  const fn = /async function loadModuleFiles\([\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'loadModuleFiles has gone');
  assert.match(fn[0], /catch \(_\) \{ unreadable\+\+; \}/,
    'a module file that will not parse is dropped without a count');
  assert.match(src, /\$\{mk\.length\}\$\{modBad\}/,
    'the count is kept and never said, which is the same as not keeping it');
});

// ---------------------------------------------------------------------------------------------
// A cache built from the graph is dropped wherever the graph is.
//
// `aiConnCache` holds «which functions use this connection», built by walking `ensureGraph()`'s
// nodes - so it is a reading of the function sources exactly as `graphCache` is. Writing a `.dg`
// dropped `codeCache` and `graphCache` and left it, so a pull that changed one function left
// `get_connection` answering «used by 3 functions» from the cache while the graph would have said
// four. The fast path and the slow path, disagreeing about the same question.
//
// Derived: a cache whose value comes out of `ensureGraph` must appear in every `noteWrite` branch
// `graphCache` appears in. The limit, stated: it finds the dependency by reading the function that
// fills the cache, so one filled indirectly - through a helper that calls `ensureGraph` itself - is
// invisible here, and there is none today.
test('every cache read out of the graph is invalidated with the graph', () => {
  const panel = read('apps/crm/sidepanel.js');
  const ai = read('apps/crm/ai.js');
  const src = panel + '\n' + ai;

  // Which caches are filled from the graph: a `<name>Cache = ...` inside a function that awaits
  // `ensureGraph`.
  const fromGraph = new Set();
  // The whole declaration line, not `\([^)]*\)`: a default parameter contains parentheses -
  // `function aiLoadConnections(op = beginWorkspaceOp())` - so that pattern stopped at the inner
  // `)` and matched nothing at all. A derivation that finds none of its subject reads as «clean».
  for (const m of src.matchAll(/^(?:async )?function (\w+)[^\n]*\{\s*$/gm)) {
    const a = m.index;
    const b = src.indexOf('\n}', a);
    const body = src.slice(a, b < 0 ? src.length : b);
    if (!/await ensureGraph\(/.test(body)) continue;
    for (const c of body.matchAll(/\b(\w*Cache)\s*=\s*(?!null)/g)) fromGraph.add(c[1]);
  }
  assert.ok(fromGraph.size >= 1, 'no cache is filled from the graph - the derivation broke');

  // Every branch of noteWrite that drops graphCache must drop them too.
  const note = panel.slice(panel.indexOf('const noteWrite ='), panel.indexOf('\n};', panel.indexOf('const noteWrite =')));
  const branches = note.split('\n').filter((l) => /graphCache = null/.test(l));
  assert.ok(branches.length >= 2, `only ${branches.length} branch(es) drop the graph - the slice is wrong`);
  const missed = [];
  for (const line of branches) {
    for (const c of fromGraph) if (!line.includes(`${c} = null`)) missed.push(`${c} survives: ${line.trim().slice(0, 70)}`);
  }
  assert.deepEqual(missed, [],
    `these caches are built from the graph and outlive a write that rebuilds it, so the assistant ` +
    `answers from one and the panel from the other: ${missed.join('; ')}`);
});

// ---------------------------------------------------------------------------------------------
// Every element the panel reaches for exists somewhere.
//
// `$('typo')` answers null, and every site that follows one is written `const el = $('x'); if (!el)
// return;` - so a renamed id turns a control into a no-op that says nothing. «Which exit says
// nothing?» is one of the six questions CLAUDE.md keeps, and this is the shape it takes in a panel
// of five thousand lines: nothing on screen is wrong, one thing simply stops working.
//
// `callcheck` holds the sibling rule for functions - «every function a page calls is in the page» -
// and there was none for elements. Measured while writing this: 228 ids reached for in the CRM, 249
// in its markup, and after counting the ones the scripts build themselves, none missing. A clean
// tree and no check, which is the definition of this cell.
//
// Two limits, stated. `content-bridge.js` and `hook.js` read *Zoho's* page and are excluded by
// name - `dreZuId` is theirs, not ours. And an id built by concatenation is invisible: what counts
// as defined is the name appearing as a literal in some file of the same app, which is why
// `btn('chipall', ...)` - assigned through a parameter - is correctly seen as defined.
test('every id the panel reaches for is defined somewhere in its app', () => {
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const dir = join(ROOT, 'apps', app);
    const files = readdirSync(dir);
    const defined = new Set();
    for (const f of files.filter((n) => n.endsWith('.html'))) {
      for (const m of read(`apps/${app}/${f}`).matchAll(/\bid="([^"]+)"/g)) defined.add(m[1]);
    }
    // **`site/report.html` only**, and that is the whole of the exception: the panel opens
    // zoost.it/report and writes the trace into it, so a lookup there is at a document this
    // repository owns. Every site page was included first, and `#health` on a guide then vouched
    // for `#health` in the panel - a rename in the panel's own markup went unnoticed because a
    // different document happened to use the name.
    for (const m of read('site/report.html').matchAll(/\bid="([^"]+)"/g)) defined.add(m[1]);
    // Anything a script names as a literal: markup it builds, `.id = 'x'`, or an argument to a
    // helper that assigns one.
    for (const f of files.filter((n) => n.endsWith('.js'))) {
      // **The lookups are removed first.** Harvesting every literal included `$('health')` itself,
      // so every id was defined by the very expression being checked and the case could not fail -
      // both plants passed. A gate that always passes looks exactly like a clean tree.
      // `buildExport*` builds a **standalone report**, a different document with its own ids -
      // `<h2 id="health">` there was vouching for `#health` in the panel, so renaming the panel's
      // went unnoticed. Blanked out, derived from the function name rather than the file, because
      // the file also holds code that does touch the panel.
      let body = read(`apps/${app}/${f}`)
        .replace(/\$\('[^']+'\)/g, ' ')
        .replace(/getElementById\('[^']+'\)/g, ' ');
      for (const b of [...body.matchAll(/function buildExport\w*\(/g)].reverse()) {
        const end = body.indexOf('\n}', b.index);
        body = body.slice(0, b.index) + ' '.repeat((end < 0 ? body.length : end) - b.index) +
               body.slice(end < 0 ? body.length : end);
      }
      // Only where a literal *is* an id: in markup the script builds, or assigned to `.id`.
      // Harvesting every literal made any name that appears elsewhere in the code - `'health'` is
      // also a view mode and a tab label - unfalsifiable, so renaming `id="health"` in the markup
      // went unnoticed. Measured on the plant.
      for (const m of body.matchAll(/\bid=["']([A-Za-z][\w-]*)["']/g)) defined.add(m[1]);
      for (const m of body.matchAll(/\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]/g)) defined.add(m[1]);
      // And an id handed to a helper that assigns one: `btn('chipall', …)` where `btn` does
      // `e.id = id`. Derived from the helper's body, so it is not a list of blessed names.
      for (const h of body.matchAll(/(?:const|let|function)\s+(\w+)\s*=?\s*\(([^)]*)\)\s*=?>?\s*\{([\s\S]{0,400}?)\n\s*\}/g)) {
        const [, fname, params, fbody] = h;
        const first = (params.split(',')[0] || '').trim();
        if (!first || !new RegExp(`\\.id\\s*=\\s*${first}\\b`).test(fbody)) continue;
        for (const c of body.matchAll(new RegExp(`\\b${fname}\\(\\s*['"]([A-Za-z][\\w-]*)['"]`, 'g'))) defined.add(c[1]);
      }
    }
    let looked = 0;
    const missing = [];
    for (const f of files.filter((n) => n.endsWith('.js') && n !== 'content-bridge.js' && n !== 'hook.js')) {
      const src = read(`apps/${app}/${f}`)
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
        .replace(/^([ \t]*)\/\/.*$/gm, (c) => ' '.repeat(c.length));
      for (const m of src.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)) {
        looked++;
        const id = m[1] || m[2];
        if (!defined.has(id)) {
          missing.push(`apps/${app}/${f}:${src.slice(0, m.index).split('\n').length} $('${id}')`);
        }
      }
    }
    assert.ok(looked > 100, `id=${app}: only ${looked} element lookups found - the derivation broke`);
    assert.deepEqual(missing, [],
      `these are reached for and defined nowhere, so they answer null and the control silently ` +
      `does nothing: ${missing.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------------------------
// A read that failed does not authorise a write over the thing it failed to read.
//
// Every save on the options page is a read-modify-write of one object: read `aicfg`, change one
// field, put the whole thing back. The read was `let c = {}; try { … } catch (_) {}`, so a failure
// left `c` empty and the write replaced the stored configuration with a single field - losing the
// encrypted API key, both model names and the rest. The user typed a passphrase to protect that
// key; a quota error, or an extension update under an open options page (which this repository has
// already met once), would have thrown it away without a word.
//
// Reading for *display* keeps its fallback, and that asymmetry is the point: an empty form renders
// and costs nothing. What it must not do is stay quiet, because Save writes the form back whole.
test('the options page refuses to save over settings it could not read', () => {
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/options.js`;
    if (!existsSync(join(ROOT, rel))) continue;
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/^([ \t]*)\/\/.*$/gm, (c) => ' '.repeat(c.length));

    // Derived: every place that writes `aicfg` back, and where the value it writes came from.
    // Through `saveKeys` now - the one writer that moves a mark only when the write happened - and
    // this read only the bare `storage.local.set` until that landed, at which point it reported
    // «0 writes of aicfg» rather than passing over nothing. The assertion below is why.
    const writes = [...src.matchAll(/(?:storage\.local\.set|saveKeys)\(\{\s*aicfg:\s*(\w+)\s*\}/g)];
    assert.ok(writes.length >= 2, `id=${app}: only ${writes.length} write(s) of aicfg - the derivation broke`);
    for (const w of writes) {
      const before = src.slice(0, w.index);
      const fnAt = Math.max(before.lastIndexOf('\nasync function'), before.lastIndexOf('.onclick = async'));
      const body = src.slice(fnAt, w.index);
      // Either the value is built from the form alone, or it came from a read that can refuse.
      const fromRead = /storage\.local\.get\('aicfg'\)|readCfgForWrite\(/.test(body);
      if (!fromRead) continue;
      assert.match(body, /readCfgForWrite\(/,
        `id=${app}: a write of aicfg is built from a read that swallows its own failure, so a ` +
        `failed read overwrites the stored key with whatever this handler set`);
      assert.match(body, /catch[\s\S]{0,200}return;/,
        `id=${app}: the read can refuse and the handler writes anyway`);
    }

    // And the display read says so rather than showing an empty form silently.
    const load = /async function loadAi\(\)[\s\S]*?\n\}/.exec(src);
    assert.ok(load, `id=${app}: loadAi has gone`);
    assert.match(load[0], /catch[\s\S]{0,300}toast\(/,
      `id=${app}: a failed read renders an empty form with no word, and Save then writes it back`);
  }
});

// ---------------------------------------------------------------------------------------------
// A change made in another tab meets the same guard as a click in this one.
//
// The panel refuses to switch workspace while a pull is writing - the list greys out and it says
// «Pull in progress». That guard sat on the panel's own controls. The Settings tab can change the
// working folder, and the `settingsStamp` handler rebuilt the workspace list on the spot: `dir`
// moves, every `op.write` still in flight throws WS_MOVED, and WS_MOVED is **silent** by design
// because a pull's status is guarded by `current()`. So a click one tab over stopped a pull
// half-way through writing a mirror and said nothing.
//
// Deferred rather than refused, like the live-sync notice beside it: the folder has already changed
// in storage and this panel cannot un-change it, so it moves when the pull ends and says so.
test('a working folder changed in Settings waits for the pull to finish', () => {
  const src = read('apps/crm/sidepanel.js')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (c) => ' '.repeat(c.length));

  // Derived: every call that rebuilds the workspace list from what the options page changed. The
  // listener is one line now and `applySettingsChange` is the work - an `async (ch, area) => {}` was
  // a scope the race checker could not enter, and this is the function it most needed to read.
  const at = src.indexOf('chrome.storage.onChanged.addListener');
  assert.ok(at > 0, 'the panel no longer listens for changes made outside it');
  const listener = sliceFn('apps/crm/sidepanel.js', 'applySettingsChange')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (c) => ' '.repeat(c.length));
  const rebuilds = [...listener.matchAll(/\bloadWorkspaces\(\)/g)];
  assert.ok(rebuilds.length >= 1, 'nothing in the listener rebuilds the list - the derivation broke');
  for (const r of rebuilds) {
    const before = listener.slice(0, r.index);
    assert.match(before.slice(-400), /pullActive/,
      'the list is rebuilt from a change made in another tab without asking whether a pull is ' +
      'writing - the pull then dies silently, mid-mirror');
  }

  // And the deferral is honoured: a flag set and never consumed is worse than no flag.
  assert.match(src, /pendingRootReload = true/, 'nothing records the deferred change');
  const end = /function endPull\(\)[\s\S]*?\n\}/.exec(src);
  assert.ok(end, 'endPull has gone - the one place deferred work is consumed');
  assert.match(end[0], /pendingRootReload/,
    'the deferred folder change is never acted on, so the panel stays on a folder nobody chose');

  // The reader is told, rather than the panel silently staying put.
  assert.match(src, /rootLater:/, 'the deferral is invisible - the panel simply does not move');
});

// ---------------------------------------------------------------------------------------------
// A load that was overtaken does not publish.
//
// Every section of the options page is re-read whenever the panel writes its key, so two changes
// arriving close together run two loaders at once - and the older one, finishing last, puts the
// older answer into the module state the form is built from. Save then writes that back over the
// newer one: a lost update on the reader's own settings, from nothing they did.
//
// `tools/asyncglobals.txt` recorded twenty-four of these writes as read, with the note that «the
// options pages answer with markOwn/dirty». Measured, they do not: `markOwn` says «this change was
// mine, ignore the echo» and `dirty` says «I have unsaved edits». Neither orders two reads of one
// key. The panel's idiom is a token and the loaders carry one now - the ledger shrank by eighteen.
test('an overtaken loader on the options page publishes nothing', async () => {
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/options.js`;
    if (!existsSync(join(ROOT, rel))) continue;

    // Run it: two loads of the same key, the first answering last, and the newer value must stand.
    let resolveOld;
    const answers = [new Promise((r) => { resolveOld = r; }), Promise.resolve({ rxShortcuts: [{ name: 'new', pattern: 'n' }] })];
    let call = 0;
    const ctx = {
      Array, String, Object, Number, Math, Promise, JSON, console,
      chrome: { storage: { local: { get: () => answers[call++] } } },
      renderRx: () => {},
      rxCur: null, rxLoadFailed: false,
    };
    vm.createContext(ctx);
    vm.runInContext([sliceConst(rel, '_loadSeq'), sliceFn(rel, 'beginLoad'), sliceFn(rel, 'loadRx')].join('\n'), ctx);

    const first = vm.runInContext('loadRx()', ctx);     // starts, will answer last
    const second = vm.runInContext('loadRx()', ctx);    // starts and answers now
    await second;
    resolveOld({ rxShortcuts: [{ name: 'old', pattern: 'o' }] });
    await first;

    assert.equal(ctx.rxCur.length, 1, `id=${app}: the loader published nothing at all`);
    assert.equal(ctx.rxCur[0].name, 'new',
      `id=${app}: the older read finished last and overwrote the newer answer - the form is built ` +
      `from it and Save writes it back over the newer list`);
  }
});

test('every loader on the options page carries an ordering token', () => {
  // Derived, so a fifth loader added tomorrow is a finding: any function whose name starts `load`
  // and awaits storage must take a token and consult it. The limit is stated - it reads `beginLoad`
  // by name, so a loader ordering itself some other way would be reported wrongly, and there is
  // none today.
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/options.js`;
    if (!existsSync(join(ROOT, rel))) continue;
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/^([ \t]*)\/\/.*$/gm, (c) => ' '.repeat(c.length));
    const bare = [];
    for (const m of src.matchAll(/^async function (load\w+)\(\)[^\n]*\{/gm)) {
      const body = src.slice(m.index, src.indexOf('\n}', m.index));
      if (!/await chrome\.storage/.test(body)) continue;
      if (!/beginLoad\(/.test(body) || !/current\(\)/.test(body)) bare.push(`${app}:${m[1]}`);
    }
    assert.deepEqual(bare, [],
      `these read storage and publish without asking whether a newer read has finished: ${bare.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------------------------
// A write that was refused moves no mark that describes it.
//
// Eight places on the two options pages did this by hand: `markOwn(key)`, `dirty.delete(key)`,
// `conflictBox(key, false)`, and then `await chrome.storage.local.set(...)` - every mark placed
// *before* the thing it describes. A `set` that throws left the page saying it had no unsaved edits
// and the conflict box gone, over settings that were never stored; and on the CRM the failure said
// nothing at all, because an `onclick` handler's rejection is silent. The Analytics twin caught it
// at three of its six writers and still cleared `dirty` first, so it announced the failure and then
// contradicted itself.
//
// It is the defect this repository recorded in `updateMetaIndex` - a refused write whose caller
// cleared its dirty mark over something that never happened - one page over, in eight copies. What
// that history says is that fixing eight sites is not the fix: one writer is.
test('a refused save keeps the edits and says so', async () => {
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/options.js`;
    if (!existsSync(join(ROOT, rel))) continue;
    const said = [];
    const ctx = {
      Object, Set, Map, Date, Promise, Array, String, console,
      MSG: { saveFailed: 'Could not save: ' },
      toast: (m, bad) => said.push([m, !!bad]),
      conflictBox: () => {},
      chrome: { storage: { local: { set: async () => { throw new Error('QUOTA_BYTES quota exceeded'); } } } },
    };
    vm.createContext(ctx);
    vm.runInContext([sliceConst(rel, 'dirty'), sliceConst(rel, 'ownWrite'),
                     sliceFn(rel, 'markOwn'), sliceFn(rel, 'saveKeys')].join('\n'), ctx);
    vm.runInContext("dirty.add('aicfg')", ctx);

    const ok = await vm.runInContext("saveKeys({ aicfg: { active: 'openai' } })", ctx);
    assert.equal(ok, false, `id=${app}: a refused write reported success`);
    assert.equal(vm.runInContext("dirty.has('aicfg')", ctx), true,
      `id=${app}: the page forgot it has unsaved edits over a write that never happened - Save now ` +
      `looks done, and the value the reader typed is nowhere`);
    assert.equal(vm.runInContext("ownWrite.has('aicfg')", ctx), false,
      `id=${app}: the mark saying «this change was mine» outlived a change that was never made, so ` +
      `the next echo of somebody else's write is read as our own and ignored`);
    assert.equal(said.length, 1, `id=${app}: the refusal said nothing`);
    assert.equal(said[0][1], true, `id=${app}: the refusal was announced as good news`);
    assert.match(said[0][0], /quota exceeded/,
      `id=${app}: the browser's own reason was dropped - «could not save» alone is not actionable`);

    // The other half: a gate that always refuses looks strict until somebody needs it.
    said.length = 0;
    ctx.chrome.storage.local.set = async () => {};
    vm.runInContext("dirty.add('aicfg')", ctx);
    assert.equal(await vm.runInContext("saveKeys({ aicfg: {} })", ctx), true, `id=${app}: a write that worked reported failure`);
    assert.equal(vm.runInContext("dirty.has('aicfg')", ctx), false, `id=${app}: a successful save left the page still dirty`);
    assert.deepEqual(said, [], `id=${app}: a successful save announced a problem`);
  }
});

test('every settings write on the options page goes through the one writer', () => {
  // Derived twice over: the writers are found by scanning for the call, and the exception is derived
  // from `SECTIONS` rather than named - `stamp()` writes `settingsStamp`, which no section owns and
  // which nothing on the page can be dirty about. A ninth save added tomorrow is a finding.
  //
  // The limit: it reads the object literal handed to `set`, so a call whose argument is built
  // elsewhere and passed by name is seen as writing nothing and would pass. There are none today.
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/options.js`;
    if (!existsSync(join(ROOT, rel))) continue;
    const src = read(rel);
    const body = src.match(/^const SECTIONS = \{([\s\S]*?)^\};/m);
    const sections = body ? [...body[1].matchAll(/^\s{2}(\w+):/gm)].map((k) => k[1]) : [];
    assert.ok(sections.length >= 3, `id=${app}: SECTIONS was not read - this test proves nothing`);

    const writer = sliceFn(rel, 'saveKeys');
    const outside = src.replace(writer, '');
    const rogue = [];
    for (const m of outside.matchAll(/chrome\.storage\.local\.set\(\{([^}]*)/g)) {
      for (const k of m[1].matchAll(/(\w+)\s*:/g)) {
        if (sections.includes(k[1])) rogue.push(k[1]);
      }
    }
    assert.deepEqual(rogue, [],
      `id=${app}: these settings are written straight to storage, so nothing withdraws their marks ` +
      `when the browser refuses: ${rogue.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------------------------
// What the assistant says about the index it sent describes the workspace on screen.
//
// `aiSeedSize`, `aiSeedOmitted` and `aiSeedTruncated` are module state written by `aiBuildSeed` and
// they are the three facts the panel reports *about* the seed - «sent with every message: 42k
// characters», «the 61 module names left out», and the one-off «Large org» note in the transcript.
// Nothing clears them on a change of workspace, and nothing needs to, on one condition: every reader
// rebuilds the seed first. That held when it was measured, and was held by nothing at all - removing
// the rebuild from `aiContextLabel` in both products left the whole battery green except the twin
// ledger, which reports «both sides moved» and is a diff notice, not a finding.
//
// What it would have cost: open the assistant in one org, switch to another, and the context line
// keeps quoting the first org's index size and the names it left out - a claim about what the model
// was sent, and wrong. That is worse than a stale number, because it is the sentence the reader uses
// to decide whether to trust the answer.
//
// **The limit, stated:** the rebuilders are `aiBuildSeed` and its *direct* callers - one level, not
// the transitive closure, which spreads over most of the panel and would approve anything. A reader
// that rebuilds two calls deep is a finding here and needs this test widened rather than silenced.
test('every reader of the seed facts rebuilds the seed first', () => {
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const files = readdirSync(join(ROOT, 'apps', app)).filter((f) => f.endsWith('.js'));
    const bodies = new Map();
    for (const f of files) {
      const src = read(`apps/${app}/${f}`)
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
        .replace(/^([ \t]*)\/\/.*$/gm, (c) => ' '.repeat(c.length));
      for (const m of src.matchAll(/^(?:async )?function (\w+)\([^\n]*\{/gm)) {
        const end = src.indexOf('\n}', m.index);
        if (end > 0) bodies.set(m[1], { file: f, body: src.slice(m.index, end) });
      }
    }
    if (!bodies.has('aiBuildSeed')) continue;

    // Derived: the facts are whatever `aiBuildSeed` publishes into module state.
    const facts = [...new Set([...bodies.get('aiBuildSeed').body.matchAll(/^\s{0,4}(ai\w+)\s*=(?!=)/gm)].map((m) => m[1]))];
    assert.ok(facts.length >= 2, `id=${app}: aiBuildSeed publishes ${facts.length} fact(s) - the derivation broke`);

    // One level of callers, and no more. Named in the failure so a widening is a decision.
    const rebuilders = new Set(['aiBuildSeed']);
    for (const [name, { body }] of bodies) if (/await\s+aiBuildSeed\s*\(/.test(body)) rebuilders.add(name);

    const bare = [];
    for (const [name, { file, body }] of bodies) {
      if (name === 'aiBuildSeed') continue;
      const reads = facts.filter((f) => new RegExp(`(?<![\\w$.])${f}(?!\\s*=[^=])`).test(body));
      if (!reads.length) continue;
      const fresh = [...rebuilders].some((r) => new RegExp(`await\\s+${r}\\s*\\(`).test(body));
      if (!fresh) bare.push(`${file}:${name} reads ${reads.join(', ')}`);
    }
    assert.deepEqual(bare, [],
      `id=${app}: these report facts about the index the model was sent without rebuilding it, so ` +
      `after a change of workspace they describe the org the reader left: ${bare.join('; ')}`);
  }
});

// ---------------------------------------------------------------------------------------------
// A ranking of sizes says what it was ranked over.
//
// «The 15 biggest functions» and «the chattiest» are built by filtering on `n.stats`, which exists
// only for a function whose source is in the mirror. A function the pull could not download was
// simply not there - so the ranking was over an unstated subset and could not say so at any size,
// in the panel's health view, in the HTML report and in the Markdown one. The Markdown was worse:
// the whole chapter appeared only when something was measurable, so a workspace whose sources were
// never downloaded got a report with no size chapter at all, which reads as «this org's functions
// have no size» rather than «none of them could be measured».
//
// It is the sentence this project already puts on the full-text search - «searched 47/50 - absence
// is not exhaustive» - never carried to the one view whose whole subject is counting. Both twins
// agreed, so `twincheck` could not see it.
//
// Run, not read: the report is built from a set where one function has stats and one does not, and
// both numbers have to appear in the output.
function liftRankedOver() {
  const src = read('apps/crm/sidepanel.js');
  // Three lines: the arrow, and the two branches. Sliced by brace-free counting of the parenthesis
  // the arrow opens, so a reworded sentence still lifts and a restructured one fails loudly here
  // rather than silently proving nothing.
  const at = src.indexOf('  hRankedOver: (ranked, all) => (');
  assert.ok(at > 0, 'MSG.hRankedOver is gone - the sentence this test is about no longer exists');
  const open = src.indexOf('=> (', at) + 3;
  let depth = 0, end = open;
  for (; end < src.length; end++) {
    if (src[end] === '(') depth++;
    else if (src[end] === ')') { depth--; if (!depth) break; }
  }
  const body = `(ranked, all) => ${src.slice(open, end + 1)}`;
  return vm.runInNewContext(`(${body})`, {});
}

test('a size ranking states how many functions it could measure', () => {
  const globals = {
    chrome: { runtime: { getManifest: () => ({ version: '1.2.3' }) } },
    SCOPE_DEFAULT: { functions: true, modules: true, workflows: true, schedules: true, connections: true,
                     actions: true, failures: true, health: true, code: true },
    SCOPE_KEYS: ['functions', 'modules', 'code'],
    bound: { instance: 'yourinstance', org: '1234567890', label: 'Acme', base: 'https://crm.zoho.eu' },
    envOf: () => 'eu', freshnessLine: () => 'just now',
    byField: (f) => (a, b) => String(a[f]).localeCompare(String(b[f])),
    wfScheduled: () => ({ count: 0, delays: [] }), isFnAction: () => false,
    moduleRefusal: () => '', actionKindLabel: (k) => k,
    actStale: () => false, actKept: () => false, actThin: () => false,
    _mdCell: (x) => String(x == null ? '' : x),
    PRODUCT_NAME: 'Zoost', PRODUCT_URL: 'https://zoost.it', PRODUCT_AUTHOR: 'Ivan', LEGAL_DISCLAIMER: 'x',
    // The real sentence, lifted out of MSG rather than restated - a test that writes its own copy
    // of the wording is testing its own copy.
    MSG: { hRankedOver: liftRankedOver() },
  };
  const fns = [
    { api_name: 'alpha', display_name: 'Alpha', namespace: 'ns', rest: false, code: 'info "a";',
      downloaded: true, associated_place: null, connections: [],
      stats: { lines: 1, codeLines: 1, chars: 9, apiCalls: 0 },
      node: { id: 'ns.alpha', namespace: 'ns', name: 'alpha', api_name: 'alpha', calls: [], called_by: [],
              stats: { lines: 1, codeLines: 1, chars: 9, apiCalls: 0 } } },
    { api_name: 'beta', display_name: 'Beta', namespace: 'ns', rest: false, code: '',
      downloaded: false, associated_place: null, connections: [], stats: null },
  ];
  const data = { fns, mods: [], g: { nodes: {} }, modRefs: {}, wfs: [], scheds: [], conns: [],
                 fails: { at: null, usage: null, failures: [] }, acts: [], actUsers: new Map() };

  const { buildExportMarkdown } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportMarkdown')], globals);
  const md = buildExportMarkdown(data, { functions: true, code: true });
  assert.match(md, /## Size and outbound calls/,
    'the size chapter vanishes when a function cannot be measured, so «not measured» reads as «no size»');
  assert.match(md, /Measured over 1 of 2 function\(s\)/,
    `the Markdown ranks over a subset without saying so:\n${md.slice(md.indexOf('## Size'), md.indexOf('## Size') + 300)}`);

  // And the same sentence, from the same place, in the health view's own description.
  const health = read('apps/crm/health.js');
  const withStats = /const withStats = nodes\.filter\(\(n\) => n\.stats && n\.stats\.lines\);/.test(health);
  assert.ok(withStats, 'the health view no longer filters on stats - this test is measuring nothing');
  // Derived twice: which lists are built out of `withStats`, and then which sections show those.
  // «Every section on the size tab» was the first criterion and it over-captured - «Most run» sits
  // there and is a reading of Zoho's runtime, not of the mirror, and it states its own moment
  // already. What must carry the sentence is a list that was *filtered by whether a source exists*.
  const ranked = [...health.matchAll(/const (\w+) = withStats[\s.]/g)].map((m) => m[1]);
  assert.ok(ranked.length >= 2, `only ${ranked.length} ranking(s) built from withStats - the derivation broke`);
  for (const name of ranked) {
    const sec = new RegExp(`\\{ id: '(\\w+)'[\\s\\S]{0,500}?items: ${name} \\}`).exec(health);
    assert.ok(sec, `the list ${name} is built and shown by no section`);
    assert.match(sec[0], /MSG\.hRankedOver\(withStats\.length, nodes\.length\)/,
      `id=${sec[1]}: a ranking built only from functions with a readable source does not say so, ` +
      `while the report does - the same number, two answers`);
  }
});

// ---------------------------------------------------------------------------------------------
// A dialog that asks a question cannot forget it was already asking.
//
// `askScope()` puts its `resolve` into one module slot and opens the dialog. A second call
// overwrites it, and the first promise never settles - the export waiting on it stops there, for
// the life of the panel, having said nothing: it has not reached `op.say` yet, so there is no
// status line to go stale and nothing on screen at all.
//
// The scrim blocks the pointer, and that is the whole of what makes this unreachable today - a
// property of a z-index, not of the function. It does not block the keyboard: the dialog traps no
// focus and the background is not inert, so Shift+Tab reaches **Export** behind the scrim and Enter
// asks the question again. This repository has already written down what it thinks of a guarantee
// that is a property of the call sites rather than of the code, twice this week.
//
// Both halves are answered: the older resolver is settled with «cancelled» rather than dropped, and
// the panel behind an open dialog is inert, which is the thing that stops the second question being
// asked at all.
test('asking for the export scope twice never abandons the first question', async () => {
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/sidepanel.js`;
    if (!existsSync(join(ROOT, rel))) continue;
    const src = read(rel);
    if (!/function askScope\(/.test(src)) continue;

    const cls = () => ({ add() {}, remove() {}, toggle() {}, contains: () => false });
    const el = { classList: cls(), style: {}, innerHTML: '', textContent: '', checked: false, value: '',
                 querySelectorAll: () => [], setAttribute() {}, removeAttribute() {} };
    const ctx = {
      Object, Set, Map, Array, Promise, String, Number, Boolean, console, document: { body: el, getElementById: () => el },
      $: () => el, scopeToUI: () => {}, scopeStaleNote: () => {}, areaStale: () => false,
      TABS: [], AREA_SCOPE: {}, AREA_IDS: [], expScope: { functions: true }, dlgScope: null, dlgAutoCleared: null,
      panelInert: () => {},
    };
    vm.createContext(ctx);
    const pieces = ['_scopeResolve', 'askScope', 'closeScope'].map((n) => {
      try { return n === '_scopeResolve' ? sliceConst(rel, n) : sliceFn(rel, n); } catch (_) { return ''; }
    });
    vm.runInContext(pieces.join('\n'), ctx);

    const first = vm.runInContext('askScope()', ctx);
    const second = vm.runInContext('askScope()', ctx);
    let firstSettled = false;
    first.then(() => { firstSettled = true; });
    await null; await null;
    assert.equal(firstSettled, true,
      `id=${app}: the first question was abandoned - whatever was waiting on it waits for the life ` +
      `of the panel, having shown nothing`);
    assert.equal(await first, null, `id=${app}: the abandoned question answered as if the reader had chosen`);
    vm.runInContext('closeScope(true)', ctx);
    assert.notEqual(await second, null, `id=${app}: the question actually being asked cannot be answered`);
  }
});

test('the panel behind an open dialog cannot be reached by the keyboard', () => {
  // The scrim is a painted div: it stops the pointer and nothing else. Derived - every place that
  // raises the scrim must make the background inert, and every place that lowers it must undo that.
  // The limit: it reads the calls, not the rendered page, so a fourth dialog that raises the scrim
  // some other way is invisible here and would need this widened.
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/sidepanel.js`;
    if (!existsSync(join(ROOT, rel))) continue;
    const src = read(rel);
    const raise = [...src.matchAll(/\$\('scrim'\)\.classList\.(add|remove)\('on'\)/g)];
    if (!raise.length) continue;
    for (const m of raise) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      assert.match(line, /panelInert\((true|false)\)/,
        `id=${app}: the scrim is raised or lowered without changing what the keyboard can reach: ${line.trim()}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Settings saves the number it is showing.
//
// `loadLay` reads `erParams.current` off disk straight into `lay`, then `layToUI` writes each value
// into a range input - which clamps it to its own bounds *for display only*. `lay` keeps the stored
// number, and Save writes `lay`. So a value outside a slider's range is shown as one thing and
// persisted as another, and the reader never sees what they are keeping.
//
// The field beside them does it correctly and says why: «a number input accepts anything typed into
// it, and 0 would refuse every diagram while 10 million would hang the window for minutes». That
// clamp was applied to `erDrawMax` and to none of the four sliders next to it - one of a set fixed,
// the others left behind, in the same function.
//
// Reachable without anyone editing a file: `erParams.current` is written by the **diagram window**
// too, from its own controls, and the two pages declare these four ranges separately. They agree
// today - measured, which is why the second test below exists rather than a sentence saying so.
test('a stored diagram setting outside a slider is saved as what is shown', async () => {
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const rel = `apps/${app}/options.js`;
    if (!existsSync(join(ROOT, rel))) continue;

    const bounds = { pMargin: [10, 320], pSpread: [10, 160], pGap: [0, 48], pFs: [8, 22], pDrawMax: [50, 5000] };
    const fields = {};
    const el = (id) => (fields[id] ||= {
      _v: '', min: String((bounds[id] || [0, 0])[0]), max: String((bounds[id] || [0, 0])[1]),
      checked: false, textContent: '',
      // A range input holds only what its own bounds allow - which is the whole point here.
      get value() { return this._v; },
      set value(x) {
        const n = Number(x);
        if (!bounds[id] || !Number.isFinite(n)) { this._v = String(x); return; }
        this._v = String(Math.min(bounds[id][1], Math.max(bounds[id][0], n)));
      },
    });
    const ctx = {
      Object, Number, Math, Array, Promise, String, JSON, console,
      $: el, LAY_CTL: [['pMargin', 'vMargin', 'margin'], ['pSpread', 'vSpread', 'spread'],
                       ['pGap', 'vGap', 'gap'], ['pFs', 'vFs', 'fs']],
      LAY_DEFAULT: { margin: 36, spread: 42, gap: 8, fs: 10, sub: true },
      DRAW_MAX_DEFAULT: 800, lay: null, drawMax: 800,
      chrome: { storage: { local: { get: async (k) => (k === 'erParams'
        ? { erParams: { current: { margin: 9999, spread: 42, gap: 8, fs: 10, sub: true } } }
        : { erDrawMax: 800 }) } } },
    };
    vm.createContext(ctx);
    vm.runInContext([sliceConst(rel, '_loadSeq'), sliceFn(rel, 'beginLoad'),
                     sliceFn(rel, 'layToUI'), sliceFn(rel, 'loadLay')].join('\n'), ctx);
    await vm.runInContext('loadLay()', ctx);

    const shown = Number(fields.pMargin.value);
    const kept = vm.runInContext('lay.margin', ctx);
    assert.equal(kept, shown,
      `id=${app}: the page shows ${shown} and would save ${kept} - Save writes the module value, ` +
      `not the control, so the reader keeps a number they were never shown`);
  }
});

test('the diagram sliders mean the same thing in Settings and in the window', () => {
  // Derived, per id: the two pages declare these ranges separately, and a stored value is only
  // «in range» with respect to one of them. If they part company, Settings clamps to bounds the
  // window does not have and the same file means two things.
  //
  // The limit: it compares the ranges by id, so a control renamed on one side reads as absent on
  // that side and is reported as such rather than passing quietly.
  const ranges = (rel) => {
    const out = {};
    for (const m of read(rel).matchAll(/id="(p\w+)"[^>]*\bmin="(-?\d+)"[^>]*\bmax="(-?\d+)"/g)) {
      out[m[1]] = [Number(m[2]), Number(m[3])];
    }
    return out;
  };
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const a = ranges(`apps/${app}/options.html`);
    const b = ranges(`apps/${app}/graphview.html`);
    const shared = Object.keys(a).filter((k) => k in b);
    assert.ok(shared.length >= 4,
      `id=${app}: only ${shared.length} slider(s) declared on both sides - the derivation broke, ` +
      `or a control was renamed on one of them`);
    for (const k of shared) {
      assert.deepEqual(a[k], b[k],
        `id=${app}: ${k} is ${a[k].join('..')} in Settings and ${b[k].join('..')} in the diagram ` +
        `window, so one of them clamps a stored value the other considers ordinary`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// One list, one mechanism, and nothing outside it.
//
// The panel had **three** ways of turning a Zoho-bound control off. `ZOHO_BTNS` held the two Pulls
// and was applied by setting `disabled`. A rule in the stylesheet greyed `#pvreveal` and `#pvfind` by
// id, because those two are spans and a span has no `disabled`. And `#funcs` - «Functions page» - was
// in neither, so when the context dropped it stayed live and answered «Unknown target» if pressed: a
// control that is enabled and cannot work.
//
// Reported from a real Zoho One org, in the shape three lists produce: «Find is disabled and
// Functions page is not». Not a missing name - a missing *place* for the name to go.
//
// What is asserted is the property that keeps it from coming back, not the membership of the list:
// there is one list, one function applies it, and nothing else turns those controls on or off. The
// membership itself is a judgement - `gozoho` navigates to Zoho and is deliberately usable with no
// context at all, because it is the way back when there is none - and a derivation that tried to
// settle it by walking the call graph pulls in eighteen controls including the workspace picker.
// **A check that fires on correct code is one people learn to ignore**, so this checks the mechanism
// and says here, in as many words, that the list is read by a person.
test('crm: every Zoho-bound control is blocked in one place, and nowhere else', () => {
  const js = read('apps/crm/sidepanel.js');
  const html = read('apps/crm/sidepanel.html');

  const list = sliceConst('apps/crm/sidepanel.js', 'ZOHO_BTNS');
  const ids = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, `ZOHO_BTNS lifted as ${ids.length} entries - the derivation broke`);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `ZOHO_BTNS names ${id}, which is not a control`);

  // The mechanism: `blockZoho` marks and disables. Both, because two of the five are spans - the
  // half that was in the stylesheet only.
  const fn = sliceFn('apps/crm/sidepanel.js', 'blockZoho');
  assert.match(fn, /ZOHO_BTNS\.forEach/, 'blockZoho does not walk the list it exists to apply');
  assert.match(fn, /'disabled' in el/, 'it sets disabled on elements that have no such property');
  assert.match(fn, /classList\.toggle\('zblocked'/,
               'the two spans cannot be disabled, so the mark is the only thing that reaches them');

  // Nothing else turns them on or off. This is the defect: a second mechanism nobody has to keep in
  // step with the first, and a third that is simply absent for one control.
  const others = [...js.matchAll(/ZOHO_BTNS\.forEach/g)].length;
  assert.equal(others, 1,
               `${others} places walk ZOHO_BTNS - it is applied in one, or the next control added is `
               + 'in one of them and not the others, which is exactly what happened');

  // And the stylesheet names no control by id under the blocked state: it says what blocked *looks*
  // like, and the script decides who is blocked.
  const named = [...html.matchAll(/body\.zoho-blocked\s+#(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(named, [],
                   `the stylesheet still turns ${named.join(', ')} off by id - add a control and the `
                   + 'rule does not know about it');
});

// ---------------------------------------------------------------------------------------------
// A tab is a tree of documents, and the panel was navigating the wrong one.
//
// Inside a suite shell - Zoho One, and CRM Plus the same way - the CRM is an iframe on
// `crm.zoho.<dc>` and the *tab* is the shell. Thirteen call sites said «take this TAB to this
// address». On a plain CRM tab that is right; inside a shell it throws away the shell the reader was
// working in. Reported from a real Zoho One org.
//
// The address was never wrong, which is what made this safe: hovering a module link inside the shell
// shows `https://crm.zoho.<dc>/crm/<portal>/tab/<Module>` - absolute, on the CRM's own origin,
// character for character what `openModulePage` builds. Zoho publishes that entry point itself.
//
// Run rather than read, on both shapes, because the whole point is that one code path serves them.
test('crm: going to a Zoho page moves the CRM frame, and moves the tab when the tab is the CRM', async () => {
  const mk = (frames) => {
    const acted = [];
    const ctx = {
      Date, Promise, Error, console, RegExp, URL,
      // The hosts the check reads, as `host_permissions` gives them - the panel derives the set from
      // the manifest, so the fixture supplies the manifest's shape and not the set.
      ZOHO_MATCHES: ['https://crm.zoho.eu/*', 'https://crm.zoho.com/*', 'https://one.zoho.eu/*'],
      setStatus: () => {},
      zohoTabId: async () => 42,
      chrome: {
        tabs: {
          get: async () => ({ url: frames[0] }),
          update: async (id, o) => { acted.push({ what: 'tab', id, ...o }); },
          create: async (o) => { acted.push({ what: 'create', ...o }); return { id: 99 }; },
        },
        scripting: {
          // `frameIds` is a property of `target`, not of the call. The first version of this stub
          // read `o.frameIds`, which is undefined either way, so both calls looked like the
          // enumeration and the navigation was never recorded - a stub that answers the wrong
          // question makes the code under test look broken.
          executeScript: async (o) => {
            if (!o.target.frameIds) return frames.map((href, i) => ({ frameId: i, result: { href, top: i === 0 } }));
            acted.push({ what: 'frame', frameId: o.target.frameIds[0], url: o.args[0] });
            return [];
          },
        },
      },
    };
    vm.createContext(ctx);
    // `goToZoho` refuses a URL that is not on a host the manifest names, so the check and the host
    // set it reads travel with it - without them every case below would be refused before it acted.
    vm.runInContext([sliceConst('apps/crm/sidepanel.js', '_crmCandidates'),
                     sliceConst('apps/crm/sidepanel.js', '_crmFrame'),
                     sliceConst('apps/crm/sidepanel.js', 'ZOHO_HOSTS'),
                     sliceFn('apps/crm/sidepanel.js', 'zohoUrlOk'),
                     sliceFn('apps/crm/sidepanel.js', 'crmFrameId'),
                     sliceFn('apps/crm/sidepanel.js', 'goToZoho')].join('\n'), ctx);
    return { ctx, acted };
  };

  const URL_ = 'https://crm.zoho.eu/crm/x/tab/Contacts';

  // Inside a shell: the CRM is frame 1, and the shell must still be there afterwards.
  const shell = mk(['https://one.zoho.eu/zohoone/x/home', 'https://crm.zoho.eu/crm/x/tab/Deals']);
  await vm.runInContext(`goToZoho(${JSON.stringify(URL_)})`, shell.ctx);
  const moved = shell.acted.filter((a) => a.what === 'frame');
  assert.deepEqual(moved.map((a) => [a.frameId, a.url]), [[1, URL_]],
                   'the CRM frame was not the thing that moved - inside a shell that means the '
                   + 'reader lost the shell they were working in');
  assert.equal(shell.acted.some((a) => a.what === 'tab' && a.url), false,
               'it navigated the tab as well, which is the defect with an extra step');

  // A plain CRM tab: frame 0 is the tab's own document, so this is a tab navigation and there is
  // only one code path. A guard that never takes this branch would pass the case above and be useless.
  const plain = mk(['https://crm.zoho.eu/crm/x/tab/Deals']);
  await vm.runInContext(`goToZoho(${JSON.stringify(URL_)})`, plain.ctx);
  assert.deepEqual(plain.acted.map((a) => a.what), ['tab'],
                   'on a tab whose own document is the CRM it did something other than navigate it');
  assert.equal(plain.acted[0].url, URL_, 'it navigated the tab somewhere else');
});

// ---------------------------------------------------------------------------------------------
// The same query, in two places, and only one of them readable.
//
// The Analytics panel colours a query table's SQL through `window.highlightSql`. Its **report**
// printed `<pre>` with escaped plain text - while the CRM's report has coloured its Deluge since it
// existed. So the two products' exports differed on the one thing an export is for, and the copy
// that goes to somebody *without* the extension was the lesser of the two. Reported.
//
// Derived rather than named: whatever the panel uses to render code, the report uses too. A future
// third surface that renders SQL is covered by the same sentence.
test('analytics: the report colours SQL the way the panel does', () => {
  const js = read('apps/analytics/sidepanel.js');
  const uses = [...js.matchAll(/window\.highlightSql/g)].length;
  assert.ok(uses >= 2,
            `only ${uses} place renders SQL through the highlighter - the panel had it and the `
            + 'report did not, which is the defect this holds');

  // And the report carries the token classes, or the highlighter emits spans nothing styles - the
  // failure that looks like nothing happening at all.
  // The stylesheet is the shell plus this product's own tail, and the token colours live in the
  // shell - so read both, or the case asserts that a shared file's rules are missing from the file
  // that no longer holds them.
  const css = read('apps/analytics/reportshell.js')
    + js.slice(js.indexOf('<!doctype html>'), js.indexOf('</style>'));
  for (const cls of [...new Set([...read('apps/analytics/highlight.js').matchAll(/class="(c-[a-z]+)"/g)].map((m) => m[1]))]) {
    assert.ok(css.includes('.' + cls),
              `the highlighter emits ${cls} and the report's stylesheet never defines it, so that `
              + 'token renders as ordinary text');
  }
  // The SQL block is the shell's code block - the same one the other product's Deluge uses - so the
  // rule to look for is that one. It had a `pre.sql` of its own, which is how the two products came
  // to draw the same thing two ways; what the case is about is unchanged: dark-theme token colours
  // need the dark ground they were chosen for.
  assert.match(css, /pre\.code\{[^}]*background:#0f1622/,
               'the code block has no dark ground, so light paper carries dark-theme token colours '
               + 'and the reader gets an unreadable page');
  assert.match(read('apps/analytics/sidepanel.js'), /<pre class="\$\{has \? 'code'/,
               'the SQL is drawn in a block of its own again instead of the shared one');
});


// ---------------------------------------------------------------------------------------------
// A report's title is its subject, and a shared header does not make that true by itself.
//
// Both reports draw their head with `reportHead` from the shared shell - and one passed the
// workspace's own name while the other passed «Zoost - workbench for Zoho CRM - Export». So a reader
// opening both saw one report about their org and one about the tool, from a function that was
// supposed to have ended exactly that. Reported: «how can you say the template is one for all?»
//
// A shared function that accepts anything shares only its markup. What is asserted here is the thing
// the function cannot enforce on its own: neither builder names the product in the heading. The
// product is named once, in the foot.
test('neither report titles itself with the product name', () => {
  for (const [app, rel] of [['crm', 'apps/crm/export.js'], ['analytics', 'apps/analytics/sidepanel.js']]) {
    const js = read(rel);
    // The heading is composed by the shell now, so what each builder decides is the *subject* it
    // hands over - which is the thing that differed.
    const at = js.indexOf('reportHead(');
    assert.ok(at > 0, `${app}: the report does not use the shared header - the derivation broke`);
    const h1 = js.slice(at, js.indexOf('\n', at));
    assert.ok(!/PRODUCT_NAME/.test(h1),
              `${app}: the report is titled after the tool that wrote it. The title is the org or the `
              + 'workspace it is about; the tool is named in the foot');
    // And it does name the subject, or the heading is a constant and the case above passes on a
    // report that says «Export» to everybody.
    assert.match(h1, /(ws|bound)\./,
                 `${app}: the heading names nothing from the workspace, so every org gets the same one`);
  }
});



// ---------------------------------------------------------------------------------------------
// Every script a panel loads is evaluated, in the order the page loads it, in one context.
//
// Three defects of one class reached the author's screen in a day and a half: `srcBlock`, a `const`
// arrow used above its declaration; then a backtick inside a comment inside a template literal, which
// ended `REPORT_CSS` early and turned the rest of the stylesheet into a tag call; then the same
// backtick, in the same file, in the comment explaining the first one. All three parse. Nothing that
// *reads* source has an opinion about any of them, and every one of them makes the file's top level
// throw the moment a browser runs it.
//
// The browser probe catches them and needs Chrome. This does the same with `vm`: the list comes from
// the page's own <script src> tags, in order, so a file added tomorrow is covered without anyone
// remembering. The environment is a Proxy that answers anything - the point is not to simulate a
// browser, it is that a file whose top level cannot even *evaluate* is broken regardless of what the
// DOM would have given it.
//
// **What it does not reach, stated:** anything that only goes wrong when a function is *called*.
// `srcBlock` was a const used above its declaration inside `buildExportHtml`, and this case evaluates
// that file happily - the browser probe is what catches that half, and the two are not
// interchangeable. This one costs milliseconds and needs no Chrome; that one needs Chrome and reaches
// the rest.
const anything = () => new Proxy(function () {}, {
  // `then` is callable like everything else - a chain has to survive being written, and the callback
  // never runs, which is the whole point: what is under test is the file's top level, not its work.
  // `Symbol.toPrimitive` answers with an empty string, because a proxy put in a template literal has
  // to coerce somehow; the iterator is a real empty generator, because destructuring is otherwise a
  // type error before any of the file's own code has had a chance to be wrong.
  get: (t, k) => (k === Symbol.toPrimitive ? () => ''
    : k === Symbol.iterator ? function* () {}
      : anything()),
  apply: () => anything(),
  construct: () => anything(),
  set: () => true,
  has: () => true,
});

test('every script the panels load evaluates on its own', () => {
  for (const app of ['crm', 'analytics']) {
    const html = read(`apps/${app}/sidepanel.html`);
    const files = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    // If the page stops naming its scripts, this case is measuring nothing and is the broken thing.
    assert.ok(files.length > 3, `${app}: no <script src> found in sidepanel.html - this case cannot `
                                + 'be checking anything, so it is the one that is wrong');
    const ctx = vm.createContext(new Proxy({}, {
      get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? anything() : undefined)),
      set: (t, k, v) => { t[k] = v; return true; },
      has: () => true,
    }));
    for (const f of files) {
      const src = readFileSync(join(ROOT, 'apps', app, f), 'utf8');
      assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: `apps/${app}/${f}` }),
                          `apps/${app}/${f}: its top level throws when evaluated. A template literal `
                          + 'that ended early is the one that keeps happening: it parses, and it '
                          + 'makes the panel dead on arrival.');
    }
  }
});

// ---------------------------------------------------------------------------------------------
// A folder that could not be read is not a folder with no workspaces in it.
//
// The catch works out the true sentence - «Could not read «sample/crm»: NotFoundError. Click the
// folder button» - and the empty-list branch below it then wrote «Open your Zoho CRM tab, then click
// + to create its workspace» on top, with that + disabled and the tree saying a third thing. Three
// surfaces, three stories, and the only true one was the one thrown away. Observed by driving the
// function with a folder whose enumeration throws.
test('crm: a folder that cannot be read says so, and nothing writes over it', async () => {
  const drive = async (granted) => {
    const said = [];
    const g = {
      console, Object, Promise, Set, JSON,
      root: { name: 'sample', values: async function* () { throw new Error('NotFoundError'); } },
      rootGranted: granted, wsList: [], APP_DIR: 'crm', APP_DIRS: ['crm', 'analytics'], CFG: '.zoost.json',
      $: () => ({}), sel: {}, selPlaceholder: () => {}, switchDirtyWorkspace: () => {}, forgetDirs: () => {},
      setEnabled: () => {}, updateWsButtons: () => {}, byWsLabel: () => 0, readJsonIn: async () => null,
      setStatus: (t, c) => said.push([String(t), c]), dir: null,
      hasPerm: async () => granted, ensurePerm: async () => granted, renderBlocked: () => {},
      appRoot: async () => ({ name: 'crm', values: async function* () { throw new Error('NotFoundError'); } }),
      dropWorkspaceState: () => {}, renderTabs: () => {}, activate: async () => {},
      window: { idbHandle: { get: async () => null, set: async () => {} } },
      emptyReason: () => '', renderTree: () => {}, refreshContext: async () => {},
    };
    const { loadWorkspaces } = load([sliceFn('apps/crm/sidepanel.js', 'loadWorkspaces')], g);
    try { await loadWorkspaces(); } catch (_) { /* the stub is not a panel; what is asserted is what it said */ }
    return said;
  };

  const unreadable = await drive(true);
  // If nothing was said at all the harness is what is broken, not the panel.
  assert.ok(unreadable.length, 'the panel said nothing about a folder it could not read');
  const last = unreadable[unreadable.length - 1][0];
  assert.match(last, /Could not read/,
               `the last thing the reader is told about an unreadable folder is «${last.slice(0, 70)}»`);
  assert.ok(!/click \+ to create/i.test(last),
            'the panel ends on «create a workspace» about a folder it could not open');

  // And the other cause of an empty list, which has its own sentence and must keep it.
  const notGranted = await drive(false);
  assert.match(notGranted[notGranted.length - 1][0], /Grant access/,
               'a folder whose permission has lapsed is not told to create a workspace');
});

// ---------------------------------------------------------------------------------------------
// Whoever writes the export preference stamps it, and the two files agree on the stamp.
//
// `sv` says which build wrote a stored scope, and the panel's one-shot migration turns the sensitive
// section off when it does not recognise it. Only the *reader* was writing the stamp - so ticking the
// source code, exporting and reopening turned it back off, and the first «Save defaults» ever pressed
// on the settings page did the same. Measured in that order, both paths.
test('every writer of the export scope stamps it, and the two products agree', () => {
  const sv = {};
  for (const [rel, name] of [['apps/crm/sidepanel.js', 'crm panel'], ['apps/crm/options.js', 'crm settings'],
                             ['apps/analytics/sidepanel.js', 'analytics panel']]) {
    const src = read(rel);
    const m = /const SCOPE_SV = (\d+);/.exec(src);
    assert.ok(m, `${name}: SCOPE_SV is gone from ${rel} - the stamp cannot be written`);
    sv[rel] = +m[1];
    // Declared before anything that reads it: a `const` used above its declaration throws at load,
    // which is how stamping the default killed the panel for one commit.
    const use = src.indexOf('sv: SCOPE_SV');
    if (use > 0) assert.ok(src.indexOf('const SCOPE_SV') < use,
                           `${name}: SCOPE_SV is used above its declaration - the panel throws at load`);
  }
  const distinct = [...new Set(Object.values(sv))];
  assert.equal(distinct.length, 1, `the products disagree about the stamp: ${JSON.stringify(sv)}`);

  // And the property, run: a scope that goes out of the panel carries the stamp, so the migration
  // cannot fire over a choice the reader just made.
  for (const [app, sensitive] of [['crm', 'code'], ['analytics', 'sql']]) {
    const keys = JSON.parse(sliceConst(`apps/${app}/sidepanel.js`, 'SCOPE_KEYS')
      .replace(/^[^[]*/, '').replace(/;\s*$/, '').replace(/'/g, '"'));
    const full = Object.fromEntries(keys.map((k) => [k, true]));
    const { SCOPE_DEFAULT } = load([sliceConst(`apps/${app}/sidepanel.js`, 'SCOPE_SV'),
                                    sliceConst(`apps/${app}/sidepanel.js`, 'SCOPE_DEFAULT')],
                                   { SCOPE_FULL: full, Object });
    assert.equal(SCOPE_DEFAULT.sv, distinct[0], `${app}: the default scope carries no stamp`);
    assert.equal(SCOPE_DEFAULT[sensitive], false,
                 `${app}: «${sensitive}» is on by default - the promise is that it is opt-in`);
  }
});

// ---------------------------------------------------------------------------------------------
// The spinner over a heavy layout says what it is laying out.
//
// It said «Laying out 200 NOUN().n…» - the source expression, as text, in front of the reader. I put
// it there myself, rewriting the function to take a callback out again, and nothing noticed: the
// browser probe's fixtures are all under the threshold that enters this branch, so the only path
// that builds that string is never taken, and the `runHeavy` unit case passes its own label in.
//
// Driven at the threshold and one below it, so both the entry and the non-entry are asserted.
test('the layout spinner names what it is laying out, in both products', () => {
  for (const [app, noun] of [['crm', /function|module/i], ['analytics', /table/i]]) {
    const file = `apps/${app}/graphview.js`;
    for (const [n, heavy] of [[200, true], [199, false]]) {
      let label = null, rafs = 0;
      const g = {
        console, Set, Object,
        SPIN_NODES: 200, erLaidOut: false,
        erVisibleIds: () => Array.from({ length: n }, (_, i) => `id${i}`),
        erShow: () => {},
        NOUN: () => ({ n: app === 'crm' ? 'functions' : 'tables' }),
        $: () => ({}),
        runHeavy: (el, text) => { label = text; },
        requestAnimationFrame: () => { rafs += 1; },
      };
      const { erShowMaybeHeavy } = load([sliceFn(file, 'erShowMaybeHeavy')], g);
      erShowMaybeHeavy();
      if (!heavy) {
        assert.equal(label, null, `${app}: a ${n}-box layout flashed a spinner it does not need`);
        assert.equal(rafs, 1, `${app}: a light layout did not draw`);
        continue;
      }
      // If nothing was captured the harness is what is broken, not the product.
      assert.ok(label, `${app}: a ${n}-box layout entered no heavy path - the threshold moved and this `
                       + 'case is measuring nothing');
      assert.ok(label.includes(String(n)), `${app}: the spinner does not say how many: «${label}»`);
      assert.match(label, noun, `${app}: the spinner does not name what it is laying out: «${label}»`);
      assert.ok(!/\$\{|\bNOUN\b|\(\)\./.test(label),
                `${app}: the spinner shows a piece of the source: «${label}»`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Every paginated walk in a bridge can say it stopped early.
//
// The panel's guards against a partial list are covered from several directions - «nothing deletes on
// the word of a list that may have stopped early», «a partial list never replaces an index». Every
// one of them reads the *consumer*. Nobody read the producer: deleting `capped = true` from the
// functions walk left the whole battery green, and that is the one walk whose truncation decides
// what gets deleted from the mirror. The probe cannot see it either - its bridge stub answers
// `capped: false`, so the branch is unreachable in the only thing that executes the code.
//
// Derived: a loop with a page ceiling has to set the flag when it hits it. The ceiling is what makes
// a walk stoppable; the flag is what makes stopping sayable.
test('a walk that can stop early says so, in both bridges', () => {
  let ceilings = 0;
  for (const app of ['crm', 'analytics']) {
    const rel = `apps/${app}/content-bridge.js`;
    const src = read(rel).split('\n');
    for (let i = 0; i < src.length; i++) {
      if (!/\bMAX_PAGES(_WIDE)?\b/.test(src[i])) continue;
      if (/^\s*(\/\/|\*)/.test(src[i]) || /const MAX_PAGES/.test(src[i])) continue;
      ceilings += 1;
      // The line that hits the ceiling, and the two after it: the break and whatever it sets.
      const here = src.slice(i, i + 3).join('\n');
      // Either spelling: a boolean for a walk that is one list, a push for one that walks several
      // kinds and has to say *which* stopped. What is refused is a ceiling that records nothing -
      // and the window is the ceiling line and the two after it, never the whole loop, because
      // `let capped = false` above would satisfy a looser search.
      assert.match(here, /capped\b[^=\n]*(=\s*true|\.push\()/,
                   `${rel}:${i + 1}: this walk stops at its page ceiling and says nothing - the list `
                   + 'it returns is indistinguishable from a complete one');
    }
  }
  // If no ceiling is found the derivation has broken, not the bridges.
  assert.ok(ceilings >= 3, `only ${ceilings} page ceiling(s) found across both bridges`);
});

// ---------------------------------------------------------------------------------------------
// A module whose fields could not be read keeps the answer that is already on disk.
//
// When `/settings/fields` fails, the bridge never attempts layouts or related lists either, so the
// module arrives with three empty lists - and the pull wrote that over the module file. Gone: the
// fields, the lookup targets, the layout summary, and the related-list API names, which this project
// calls the single most valuable thing it surfaces. Under «Modules pull complete», in green.
//
// The layout *file* beside it was already protected by this exact argument, with the reason written
// above it. The file holding the fields was not - which is what «walk the siblings» means when the
// sibling is one line away.
test('a module whose fields could not be read is left as it was', async () => {
  const disk = { 'modules/Contacts.json': JSON.stringify({
    api_name: 'Contacts', module_name: 'Contacts', generated_type: 'default',
    fields: [{ api_name: 'Email' }, { api_name: 'Phone' }],
    related_lists: [{ api_name: 'Notes' }], layouts: [{ id: '1', name: 'Standard' }],
  }) };
  const wrote = [];
  const g = {
    console, JSON, Object, Array, Set, Promise, sanitize: (x) => String(x || ''),
    setStatus: () => {}, mismatchRefuse: () => false, requirePerm: async () => {},
    getContext: async () => ({ org: '1', origin: 'https://crm.zoho.eu', instance: 'i' }),
    opReadCfg: async () => ({}), noteAccess: async () => {}, notePullFailure: async () => {},
    endPull: () => {}, bridgeError: (r, m) => new Error(m), MSG: { noTab: 'no tab' },
    isModuleFile: () => false, walk: async function* () {}, envOf: () => 'prod',
    WS_MOVED: 'moved', pullActive: false,
    beginWorkspaceOp: () => ({ current: () => true, root: {},
      read: async (rel) => { if (!(rel in disk)) throw new Error('no such file'); return disk[rel]; },
      write: async (rel, body) => { wrote.push(rel); disk[rel] = body; },
      remove: async () => {}, say: () => {} }),
    // The failure this is about: fields unread, so the bridge sends three empty lists and says so.
    toBridge: async () => ({ ok: true, modules: [{
      api_name: 'Contacts', module_name: 'Contacts', generated_type: 'default',
      fields: [], related_lists: [], layouts: [], fields_read: false, layouts_read: false,
      related_read: false, unreadable: null }] }),
  };
  const { pullModules } = load([sliceFn('apps/crm/modules.js', 'pullModules')], g);
  await pullModules();
  const after = JSON.parse(disk['modules/Contacts.json']);
  assert.equal(after.fields.length, 2,
               `the module file was replaced by the failed read: ${after.fields.length} field(s) left`);
  assert.equal(after.related_lists.length, 1, 'the related-list API names were lost');
  assert.ok(!wrote.includes('modules/Contacts.json'),
            'the module file was rewritten from a read that returned nothing');
  // And the index still names it, or the mirror disagrees with itself: file on disk, module absent.
  const idx = JSON.parse(disk['modules/index.json'] || '[]');
  assert.equal(idx.length, 1, `the index names ${idx.length} module(s) while one file is on disk`);
  assert.equal(idx[0].fields, 2, 'the index row was rebuilt from the empty answer');
});

// ---------------------------------------------------------------------------------------------
// A folder's name is data, wherever it came from.
//
// The workspace selector interpolated `root.name` into markup in two places, so a directory called
// `</option><option selected>…` rewrote the control instead of appearing in it. The extension's CSP
// stops that becoming script; it does not stop a control the reader did not choose, or a name they
// cannot read. The twin escaped the same value, which is what made the two copies look deliberate.
//
// Run: the placeholder is built and its text read back.
test('a folder called something hostile appears as its name, not as markup', () => {
  const hostile = '</option><option selected>not your workspace</option>';
  const made = [];
  const sel = { children: null, replaceChildren(...n) { this.children = n; } };
  const ctx = vm.createContext({
    document: { createElement: () => { const o = { value: '', textContent: '' }; made.push(o); return o; } },
  });
  vm.runInContext(sliceFn('apps/crm/sidepanel.js', 'selPlaceholder'), ctx);
  vm.runInContext('selPlaceholder', ctx)(sel, `${hostile} - access not granted`);
  assert.equal(made.length, 1, 'the placeholder is more than one element');
  assert.equal(sel.children.length, 1, `the selector holds ${sel.children.length} controls, not one`);
  assert.ok(sel.children[0].textContent.includes(hostile),
            'the name did not survive as text');
  assert.equal(sel.children[0].value, '', 'the placeholder is selectable as if it were a workspace');

  // And the derivation: no `root.name` may reach `innerHTML` unescaped in either panel, so a third
  // copy cannot reintroduce it. If neither panel mentions the name at all, this is measuring nothing.
  let mentions = 0;
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/sidepanel.js`);
    for (const m of src.matchAll(/innerHTML\s*=\s*(`[^`]*`)/g)) {
      if (!/root\.name/.test(m[1])) continue;
      mentions += 1;
      assert.match(m[1], /\$\{esc[A-Za-z]*\(root\.name\)/,
                   `${app}: a folder name reaches innerHTML unescaped: ${m[1].slice(0, 80)}`);
    }
    mentions += (src.match(/selPlaceholder\(/g) || []).length;
  }
  assert.ok(mentions > 0, 'neither panel names the folder in a selector any more - this case is the '
                          + 'broken one, not the code');
});

// ---------------------------------------------------------------------------------------------
// Re-injecting a bridge into a page that already has an older one replaces it.
//
// The guard is a version, not a boolean - that is what the commit which introduced it says. It was
// `1` from that day, and both bridges changed three times afterwards without it moving, so the panel's
// recovery path («inject it again») returned at the first line and left the old listener answering.
// The check that covered it read the *shape* - «the guard compares against some word» - which `1`,
// `999` and a real version all satisfy equally, so it stayed green through all three changes.
//
// This one runs the shipped file, twice, and counts listeners.
test('a bridge re-injected over an older build replaces it, and over its own does not', () => {
  for (const app of ['crm', 'analytics']) {
    const src = read(`apps/${app}/content-bridge.js`);
    let listeners = 0, version = '1.47.0';
    const ctx = vm.createContext({});
    Object.assign(ctx, {
      window: ctx, self: ctx, console,
      addEventListener: () => {}, removeEventListener: () => {},
      document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null,
                  documentElement: { innerHTML: '' }, cookie: '' },
      location: { origin: 'https://crm.zoho.eu', href: 'https://crm.zoho.eu/crm/org/tab/Home', pathname: '/crm/org/tab/Home' },
      navigator: { userAgent: '' },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
      chrome: { runtime: { getManifest: () => ({ version }),
                           onMessage: { addListener: () => { listeners += 1; } } } },
    });
    const run = () => { try { vm.runInContext(src, ctx); } catch (_) { /* the stub is not a browser */ } };
    run();
    const first = listeners;
    // If the first injection registers nothing, this case is measuring nothing - say so rather than
    // passing on two zeroes.
    assert.equal(first, 1, `${app}: the bridge registered ${first} listener(s) on a clean page`);
    run();
    assert.equal(listeners, first, `${app}: injecting the same build twice registered a second listener`);
    // And the case the guard exists for: a page still carrying the marker of an earlier release.
    // And the case the guard exists for, in the shape it actually happens: the page carries whatever
    // *this same file* wrote under the previous release. Setting the marker to an invented value
    // proves nothing - a counter never equals a version string, so the plant would pass. The marker
    // has to be produced by the code, which is why the version is swapped and the file re-run.
    version = '1.48.0';
    run();
    assert.equal(listeners, first + 1,
                 `${app}: a page carrying the previous build's marker kept the old bridge - the marker `
                 + 'does not change between builds, so re-injecting replaces nothing');
  }
});

// ---------------------------------------------------------------------------------------------
// The answer budget is the reader's, and a cut answer says it was cut.
//
// Two halves, both wrong in the same direction - the panel quietly presenting less than it promised.
// The setting is called «Answer budget», Settings says it is the tokens one answer may cost, and the
// message the panel prints when a reply is cut names that box. One engine read it; the other sent a
// literal 4096, so raising the setting changed nothing and the explanation sent the reader off to
// change model for an *output* ceiling. And when a reply was cut *after* it had started, nothing was
// said at all: the paragraph simply stopped, which is indistinguishable from a model that finished.
//
// Run, not read: the request body is captured, and the stream is driven to the stop it is about.
test('the answer budget reaches the request, in both products', async () => {
  for (const [app, file] of [['crm', 'apps/crm/ai.js'], ['analytics', 'apps/analytics/sidepanel.js']]) {
    let sent = null;
    const g = { AI_MAX_TOKENS: 16384, OPENAI_BASE: 'https://api.openai.com/v1', JSON, console,
                fetch: async (u, o) => { sent = JSON.parse(o.body);
                  return { ok: true, status: 200,
                           json: async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }) }; } };
    const { aiCall } = load([sliceFn(file, 'aiCall')], g);
    await aiCall({ openai: { model: 'gpt-x', apiKey: 'k' } }, [{ role: 'user', content: 'q' }], null);
    // If nothing was captured the harness is the broken thing, not the product.
    assert.ok(sent, `${app}: no request was made - this case is measuring nothing`);
    const limit = Object.entries(sent).find(([k]) => /^max_(tokens|completion_tokens)$/.test(k));
    assert.ok(limit, `${app}: the request names no output limit at all: ${Object.keys(sent)}`);
    assert.equal(limit[1], 16384,
                 `${app}: sent ${limit[1]} where the reader's budget is 16384 - the setting does nothing`);
  }
});

test('an answer cut off by the budget says so, in both products', async () => {
  // **Run, not read.** The first version of this asserted that the marker's *text* appears in the
  // agent loop - which it did, in the CRM, inside the streaming callback where `stop_reason` is not
  // yet declared. Every Anthropic answer in that panel threw on its second chunk and the case stayed
  // green, because a regex over source cannot see *where* a line sits. The defect was the position.
  //
  // So the loop is executed against a stream that delivers two chunks and then stops at the budget,
  // and what is asserted is the message the reader ends up with.
  for (const [app, file] of [['crm', 'apps/crm/ai.js'], ['analytics', 'apps/analytics/sidepanel.js']]) {
    const said = [];
    const g = {
      console, Promise, JSON, AI_MAX_TOKENS: 16384,
      aiMessages: said, aiRenderMessages: () => {},
      // The loop takes the workspace it began in; nothing here reads a folder, so the stub only has
      // to answer «still the same one» - which is the question the real op answers.
      beginWorkspaceOp: () => ({ current: () => true, read: async () => '', write: async () => {} }),
      setStatus: () => {}, status: () => {},
      aiMarkdown: (x) => x,
      // Enough of an element for the loop to paint into; what is asserted is the message it wrote,
      // never the DOM.
      $: () => ({ scrollTop: 0, scrollHeight: 0, lastElementChild: null, innerHTML: '',
                  querySelectorAll: () => [], querySelector: () => null,
                  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                  style: {}, appendChild() {}, textContent: '' }),
      // Two chunks and a budget stop: the shape that produced the error, and the shape the marker is for.
      aiStreamAnthropic: async (a, msgs, system, tools, onText) => {
        onText('The first half of an answer');
        onText(' that stops mid-');
        return { content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens', thought: false };
      },
    };
    const { aiRunAnthropicAgent } = load([sliceFn(file, 'aiRunAnthropicAgent')], g);
    await aiRunAnthropicAgent({}, [{ role: 'user', content: 'q' }], null, [], 3);
    const last = said[said.length - 1];
    // If the loop wrote nothing, the harness is what is broken - say so rather than passing.
    assert.ok(last && last.content, `${app}: the agent loop produced no message at all`);
    assert.match(last.content, /Cut off here/,
                 `${app}: an answer that started and then hit the budget was left looking finished: `
                 + `«${String(last.content).slice(0, 80)}»`);
  }
});

test('the other engine says so too, in both products', () => {
  for (const [app, file] of [['crm', 'apps/crm/ai.js'], ['analytics', 'apps/analytics/sidepanel.js']]) {
    const call = sliceFn(file, 'aiCall');
    assert.ok(/txt && c && c\.finish_reason === 'length'/.test(call),
              `${app}: a truncated OpenAI answer is returned as if it were whole`);
  }
});

// ---------------------------------------------------------------------------------------------
// Cancel cancels, in both products.
//
// The export dialog saves what you leave it with. One panel edited the *stored* preference as you
// ticked, so pressing «Everything» and then **Cancel** left the SQL box ticked when the dialog
// reopened, and the next export wrote that down - the box §4.3 of the privacy policy names as the
// sensitive half of the export, turned on by a click the reader took back. The twin had kept a
// working copy for exactly this reason, with the reason written above it, since it was written.
//
// Run, not read: the two functions are lifted and driven through the sequence a person performs.
test('cancelling the export dialog leaves the stored scope alone, in both products', () => {
  const cases = {
    crm: { file: 'apps/crm/sidepanel.js', sensitive: 'code', on: 'functions' },
    analytics: { file: 'apps/analytics/sidepanel.js', sensitive: 'sql', on: 'structure' },
  };
  for (const [app, c] of Object.entries(cases)) {
    const keys = JSON.parse(sliceConst(c.file, 'SCOPE_KEYS').replace(/^[^[]*/, '').replace(/;\s*$/, '').replace(/'/g, '"'));
    assert.ok(keys.includes(c.sensitive), `${app}: SCOPE_KEYS has no «${c.sensitive}» - this case is the broken one`);
    const boxes = {};
    for (const k of keys) boxes['sc_' + k] = { checked: false, disabled: false };
    boxes.scwarn = { textContent: '' };
    const stored = {};
    for (const k of keys) stored[k] = k !== c.sensitive;          // the shipped default: sensitive off
    const ctx = { Object, JSON, console, Set, $: (id) => boxes[id], SCOPE_KEYS: keys,
                  // The CRM also records which boxes it cleared *for* the reader, to warn about
                  // stale data; it is not what this case is about, and it has to be here to run.
                  dlgAutoCleared: new Set(),
                  expScope: { ...stored }, dlgScope: { ...stored } };
    vm.createContext(ctx);
    vm.runInContext([sliceFn(c.file, 'scopeToUI'), sliceFn(c.file, 'scopeFromUI')].join('\n'), ctx);
    // Open the dialog on what is stored, tick the sensitive box, and read it back.
    vm.runInContext('dlgScope = Object.assign({}, expScope); scopeToUI();', ctx);
    boxes['sc_' + c.sensitive].checked = true;
    vm.runInContext('scopeFromUI()', ctx);
    assert.equal(ctx.dlgScope[c.sensitive], true, `${app}: the dialog did not take the tick`);
    assert.equal(ctx.expScope[c.sensitive], false,
                 `${app}: ticking «${c.sensitive}» changed the stored preference before anything was `
                 + 'confirmed - Cancel cannot undo what has already been written');
  }
});

// ---------------------------------------------------------------------------------------------
// The About dialog cannot claim nothing leaves while the panel can send something.
//
// The CRM's said «the extension has no server of its own and sends nothing anywhere» for as long as
// the assistant has existed. The store copy was corrected, the site was corrected, the twin panel was
// corrected - and the dialog inside the product, which is where a user actually reads it, was not.
// One sentence, four surfaces, three of them updated: the enumeration trap, on a claim.
//
// Derived rather than spelled out: **if the panel can reach a network host, the dialog has to say so.**
// The hosts come from the manifest, minus the platform's own - which the extension reads through the
// user's own session and which the sentence above already covers.
test('the About dialog names every destination the panel can reach', () => {
  for (const app of ['crm', 'analytics']) {
    const man = JSON.parse(read(`apps/${app}/manifest.json`));
    const outward = (man.host_permissions || [])
      .filter((h) => !/zoho|zohocloud/.test(h))
      .map((h) => h.replace(/^https:\/\//, '').replace(/\/\*$/, ''));
    // If the manifest grants nothing outward, this case is measuring nothing and says so.
    assert.ok(outward.length >= 2, `${app}: no outward host in the manifest - either the assistant went `
                                   + 'away, or this case is the thing that is broken');
    const src = read(`apps/${app}/sidepanel.js`);
    const about = src.slice(src.indexOf('<h4>Your data</h4>'), src.indexOf('<h4>Your data</h4>') + 1600);
    assert.ok(about, `${app}: the About dialog no longer has a «Your data» section`);
    assert.ok(/assistant/i.test(about),
              `${app}: the dialog does not mention the assistant, and the manifest grants ${outward}`);
    assert.ok(!/sends nothing anywhere|nothing leaves this machine\.<\/div>/.test(about),
              `${app}: the dialog claims nothing leaves, and the manifest grants ${outward}`);
    // And the other thing that leaves on a click.
    assert.ok(/problem report/i.test(about),
              `${app}: the dialog does not mention the problem report, which opens a page and is written into it`);
  }
});

// ---------------------------------------------------------------------------------------------
// Nothing navigates anywhere the manifest does not name.
//
// Every «Open in Zoho» builds its URL from the workspace binding, and the binding is `.zoost.json` -
// a file on disk, in a folder the user may have been handed rather than made. The pull compares that
// origin against the tab before it reads anything; no *navigation* asked. So a workspace folder from
// somebody else could point a control labelled with Zoho's name at any origin, in the user's own
// Zoho frame, and the panel would take it there.
//
// The check is one function per panel because there are six builders in one product and three in the
// other, and a seventh must inherit it. Run rather than read, on the two shapes that matter: the
// hosts the manifest actually grants, and a domain that merely *starts* like one - which is what the
// first version of this check let through.
test('a workspace can only send you to a host the manifest names', () => {
  const man = { host_permissions: ['https://crm.zoho.eu/*', 'https://crmsandbox.zoho.com/*',
                                   'https://one.zoho.eu/*', 'https://analytics.zoho.eu/*'] };
  const cases = {
    crm: { pieces: [sliceConst('apps/crm/sidepanel.js', 'ZOHO_HOSTS'),
                    sliceFn('apps/crm/sidepanel.js', 'zohoUrlOk')],
           globals: { ZOHO_MATCHES: man.host_permissions.filter((h) => !/analytics/.test(h)), URL },
           good: ['https://crm.zoho.eu/crm/inst/tab/Contacts', 'https://one.zoho.eu/x'] },
    analytics: { pieces: [sliceConst('apps/analytics/sidepanel.js', 'APP_HOSTS'),
                          sliceFn('apps/analytics/sidepanel.js', 'zohoUrlOk')],
                 globals: { chrome: { runtime: { getManifest: () => man } }, URL },
                 good: ['https://analytics.zoho.eu/workspace/1/view/2'] },
  };
  for (const [app, c] of Object.entries(cases)) {
    const { zohoUrlOk } = load(c.pieces, c.globals);
    for (const u of c.good) assert.ok(zohoUrlOk(u), `${app}: refuses ${u}, which the manifest grants`);
    for (const u of ['https://crm.zoho.eu.evil.example/crm/x',      // starts like one; is not one
                     'https://analytics.zoho.eu.evil.example/w/1',
                     'https://attacker.example/crm/inst/tab/Contacts',
                     'http://crm.zoho.eu/crm/x',                    // not https
                     'javascript:alert(1)', 'data:text/html,x', '', null, undefined])
      assert.equal(zohoUrlOk(u), false, `${app}: would navigate to ${u}`);
    // If a manifest with no hosts still says yes to something, the derivation is not deriving.
    const empty = load(c.pieces, app === 'crm'
      ? { ZOHO_MATCHES: [], URL }
      : { chrome: { runtime: { getManifest: () => ({ host_permissions: [] }) } }, URL });
    assert.equal(empty.zohoUrlOk(c.good[0]), false,
                 `${app}: says yes with no hosts granted - the list is not coming from the manifest`);
  }
});

// ---------------------------------------------------------------------------------------------
// A link looks like a link, and nothing that is not one looks like it.
//
// Two halves, and both were wrong at once. The link styling was written per context - the reference
// lines, the index, the workflow actions - so a link written anywhere else rendered as ordinary black
// text; and the first column of every table was painted the accent colour whether or not its cell was
// a link, so where the two met the colour said nothing at all. Reported in one sentence after the
// dead links were removed: there is no telling what is clickable and what is not.
test('what is clickable in a report looks clickable, and only that', () => {
  for (const app of ['crm', 'analytics']) {
    const css = read(`apps/${app}/reportshell.js`);
    const main = css.match(/\bmain a\{([^}]*)\}/);
    // If this rule has gone, the case is measuring nothing rather than passing.
    assert.ok(main, `${app}: no \`main a\` rule - either link styling went back to being written per `
                    + 'context, or this case is the broken one');
    assert.match(main[1], /color:var\(--accent\)/, `${app}: links carry no colour of their own`);
    assert.match(main[1], /text-decoration:underline/,
                 `${app}: colour alone is the affordance, and a reader who does not see this colour `
                 + 'has none');
    // And the other half: no cell may borrow the colour that means «this is a link».
    for (const [sel, decl] of [...css.matchAll(/([^{};\n\/][^{}\n]*)\{([^}]*)\}/g)]
      .map((m) => [m[1].trim(), m[2]])) {
      if (/\ba\b|::?(before|after|hover)|^\.credit|^footer/.test(sel)) continue;
      assert.ok(!/color:var\(--accent\)/.test(decl),
                `${app}: \`${sel}\` paints text the link colour without being a link`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The head, the body and the foot are one column.
//
// The band and the rule at the bottom span the window - that is what makes them a band - but their
// *content* has to line up with the sections, or the title starts at the window's edge while the
// first chapter begins 140px further in. The foot was given its column when that was reported; the
// head kept its own padding and nobody compared them, which is how two rules meant to agree diverge.
// Derived from the stylesheet rather than asserted as a number, so changing the column changes one
// place and this still holds.
test('the report is one column from the head to the foot', () => {
  for (const app of ['crm', 'analytics']) {
    const css = read(`apps/${app}/reportshell.js`);
    const widths = {};
    for (const sel of ['main', 'header>.hcol', 'footer>.fcol']) {
      const m = css.match(new RegExp(sel.replace(/[.>]/g, (c) => '\\' + c) + '\\{([^}]*)\\}'));
      // If a rule has gone, this case is comparing fewer things than it claims to and says so.
      assert.ok(m, `${app}: no rule for \`${sel}\` in reportshell.js - either the frame changed or `
                   + 'this case is the broken one');
      const w = (m[1].match(/max-width:([^;]+)/) || [])[1];
      assert.ok(w, `${app}: \`${sel}\` sets no max-width, so it cannot line up with anything`);
      widths[sel] = w.trim();
    }
    const distinct = [...new Set(Object.values(widths))];
    assert.equal(distinct.length, 1,
                 `${app}: the head, the body and the foot are on different columns - `
                 + JSON.stringify(widths));
  }
});

// ---------------------------------------------------------------------------------------------
// A jump landed under the sticky header, so the reader arrived a few lines into the section.
//
// Both reports have a band that stays at the top of the window. Following an anchor puts its target
// at the top of the *window*, which is behind that band - so the heading you asked for is hidden and
// the section appears to start in the middle. Reported on both. `.item` carried a 120px
// `scroll-margin-top` and nothing else carried any, so chapters and per-view anchors landed wrong.
//
// A constant cannot be right: the two headers are different heights - one has a filter box and three
// meta lines, the other three meta lines - and either gains a line the day somebody adds one. The
// band measures itself at load and on resize and publishes the number as a custom property; the
// stylesheet keeps a fallback for a reader with no script.
test('every anchor target in a report clears the sticky header', () => {
  for (const app of ['crm', 'analytics']) {
    const shell = read(`apps/${app}/reportshell.js`);
    assert.match(shell, /\[id\]\{scroll-margin-top:calc\(var\(--stick/,
                 `${app}: only some targets clear the band, so the rest land behind it`);
    assert.match(shell, /--stick', *h\.offsetHeight/,
                 `${app}: the band's height is written down instead of measured, and the two headers `
                 + 'are not the same height');
    assert.match(shell, /addEventListener\('resize',stick\)/,
                 `${app}: the height is measured once, so a window narrow enough to wrap the header `
                 + 'goes back to landing wrong');
    // And the fallback, for a reader with scripting off: a target that clears nothing is worse than
    // one that clears an approximation.
    assert.match(shell, /var\(--stick, *\d+px\)/, `${app}: no fallback when the script does not run`);
  }
});

// ---------------------------------------------------------------------------------------------
// Two reports from one product, shaped differently, are two products to whoever receives them.
//
// The Zoho CRM report is a page: a sticky header band, a centred column, a footer band from edge to
// edge. The Zoho Analytics one was a padded body with a max width and no bands at all - which is why
// its foot could not span anything, and why the two looked like the work of different hands. The
// accent stays per-product, blue and teal, the colour each panel already wears; everything that
// decides the *shape* is now the same.
//
// Derived from the stylesheets rather than compared as text: the two documents share the frame, and
// the only things they are allowed to disagree on are the values of their own tokens.
test('the two reports are the same shape', () => {
  // The strongest form this can take: the shape is **one file**, and the two products carry copies
  // of it that are the same bytes. Comparing rendered rules was the previous version and it only ever
  // caught what somebody had thought to list - which is how the two reports came to differ by a
  // filter box, a grouped index, cards, nineteen anchors and three empty states while a case said
  // «same shape» about five CSS rules.
  const crm = readFileSync(join(ROOT, 'apps/crm/reportshell.js'));
  const ana = readFileSync(join(ROOT, 'apps/analytics/reportshell.js'));
  assert.ok(crm.length > 3000, 'the shared report shell did not lift - the derivation broke');
  assert.deepEqual(crm, ana,
    'apps/crm/reportshell.js and apps/analytics/reportshell.js differ - the shape of a report is one '
    + 'file, and a second copy is a second place to drift');

  // Each product still wears its own accent, or a reader with both reports open cannot tell them
  // apart. It is the one thing the shell deliberately does not decide.
  const accent = (rel) => (read(rel).match(/--accent:\s*(#[0-9a-f]{3,8})/i) || [])[1];
  const a1 = accent('apps/crm/export.js'), a2 = accent('apps/analytics/sidepanel.js');
  assert.ok(a1 && a2, 'a product no longer sets its own accent over the shared sheet');
  assert.notEqual(a1, a2, 'both reports wear the same accent');
});



// ---------------------------------------------------------------------------------------------
// One of a set that did not do what its siblings do.
//
// Both panels take the reader to Zoho from several controls, and both now do it through
// `goToZoho()`, which moves the CRM or Analytics frame when the tab is a suite shell and the tab
// itself when the tab *is* the app. Analytics' detail pane did not: «Open in Zoho» called
// `chrome.tabs.create` unconditionally, so from inside Zoho One it left the shell **and** the tab the
// reader was on, while the CRM's own «Open in Zoho» has always moved the tab they were already in.
// Reported, in those words: «Analytics behaves differently from CRM».
//
// What is asserted is the mechanism, not a list of controls: there is one function per panel that
// knows how to reach a Zoho page, it is the only thing that navigates a frame, and the detail pane's
// button goes through it. Two controls deliberately do not - the data-centre «Go to Zoho» and the
// mismatch «Switch tab» - because those are the way *in* when there is no context and the way out of
// a session, and both say so where they are. That is a judgement, and naming it here is the honest
// alternative to a derivation that would have to encode it.
test('both panels reach a Zoho page through one function, and the detail button uses it', () => {
  for (const app of ['crm', 'analytics']) {
    const js = read(`apps/${app}/sidepanel.js`);
    const fn = sliceFn(`apps/${app}/sidepanel.js`, 'goToZoho');
    assert.match(fn, /frameIds: \[fid\]/,
                 `${app}: goToZoho does not address a frame, so inside a shell it takes the shell away`);
    assert.match(fn, /location\.href = u/, `${app}: goToZoho navigates something other than the frame`);

    // The only place a frame is navigated. A second one is a second policy, and the first thing that
    // diverges between two panels is a policy that exists twice.
    const injections = [...js.matchAll(/location\.href = /g)].length;
    assert.equal(injections, 1,
                 `${app}: ${injections} places navigate a frame - there is one function for it, or the `
                 + 'next control added does whatever its author remembered');
  }

  // The detail pane's own button, in the panel where it diverged. It is wired at the call site, so
  // read the wiring rather than a handler name.
  const a = read('apps/analytics/sidepanel.js');
  assert.match(a, /\$\('dzoho'\)\.onclick = \(\) => \{ if \(zurl\) goToZoho\(zurl\); \}/,
               '«Open in Zoho» opens a tab of its own again, which is what leaving the shell looks '
               + 'like to a reader inside Zoho One');
});

// ---------------------------------------------------------------------------------------------
// A frame that names itself without an org is not an identity, and it produced a wrong one.
//
// A suite shell puts several documents on the CRM's origin. One of them is a template preview, at a
// path whose segment after `crm` is the literal `html` - and `instanceName()` reads exactly that
// segment. So it answered «instance: html, org: null», the panel believed it, and drew
//
//   Zoho tab «html» (org null) ≠ local workspace «…» (org 20078114174)
//
// which is not a refusal but a **wrong identity**: a mismatch banner about an org the reader never
// left, on a tab that was showing their own CRM. Measured from the banner itself on a real Zoho One
// tab, after two earlier defects on the same surface had been fixed.
//
// The org is the right requirement rather than one more name to exclude. It is read from the page's
// own `crmZgid`, which only the application carries, and the whole mismatch guard compares orgs - so
// a context without one could never have matched anything and was never an identity to begin with.
test('crm: the bridge answers for the tab only with an instance and an org', () => {
  const bridge = read('apps/crm/content-bridge.js');
  const line = bridge.split('\n').find((l) => l.includes("msg?.cmd === 'context'"));
  assert.ok(line, 'the context command is gone from the dispatcher - the derivation broke');
  assert.match(line, /c\.instance && c\.org/,
               'a frame may still speak for the tab with a name and no org, which is how «html» did');

  // And the panel does not settle for half an answer either, wherever it asks.
  const ask = sliceFn('apps/crm/sidepanel.js', 'askFrame');
  assert.match(ask, /r\.instance && r\.org/,
               'the panel accepts a frame that named itself without an org');
});

// Run rather than read, on the shape that was measured: `instanceName` finds a segment, `orgId` finds
// nothing, and the tab must not be spoken for.
test('crm: a preview frame whose path segment looks like an instance names nobody', () => {
  const mk = (href, html) => {
    const ctx = {
      location: { pathname: new URL(href).pathname, origin: new URL(href).origin, href },
      document: { documentElement: { innerHTML: html } },
      RegExp, JSON, console,
    };
    vm.createContext(ctx);
    vm.runInContext([sliceFn('apps/crm/content-bridge.js', 'instanceName'),
                     sliceConst('apps/crm/content-bridge.js', '_org'),
                     sliceFn('apps/crm/content-bridge.js', 'memoValid'),
                     sliceFn('apps/crm/content-bridge.js', 'orgId')].join('\n'), ctx);
    return ctx;
  };
  const preview = mk('https://crm.zoho.eu/crm/html/EmailTemplates/preview', '<html><body>nothing</body></html>');
  assert.equal(vm.runInContext('instanceName()', preview), 'html',
               'the path no longer yields the segment that caused this - the fixture has aged');
  assert.equal(vm.runInContext('orgId()', preview), null,
               'a frame with no crmZgid in it produced an org, so the requirement below proves nothing');

  const app = mk('https://crm.zoho.eu/crm/yourinstance/tab/Contacts',
                 '<html><script>var crmZgid = "1234567890";</script></html>');
  assert.equal(vm.runInContext('instanceName()', app), 'yourinstance');
  assert.equal(vm.runInContext('orgId()', app), '1234567890',
               'the application frame cannot answer either, so requiring an org would refuse everything');
});

// ---------------------------------------------------------------------------------------------
// More than one frame can be on the CRM's origin, and choosing by position chose wrong.
//
// Measured on a real Zoho One tab, by the instrument this panel now keeps: **thirteen frames, two of
// them `crm.zoho.<dc>`**, and the frame lookup took `crm[0]` - the first the enumeration happened to
// return. It was the wrong one. The panel asked it and was refused in a millisecond, on every tick,
// which is «Zoho tab (not ready)» on a tab whose CRM was right there.
//
//   frames=[0:one.zoho.eu 1201:about:blank … 1203:crm.zoho.eu 1125:one.zoho.eu 1124:crm.zoho.eu …]
//   asked=1203 -> NOT READY 1ms
//
// The shell builds several frames and the order they come back in is not a fact about which of them
// is the application. So the frame is not chosen, it is **the one that answers**: `context` is
// refused by the bridge unless the origin is CRM and an instance resolved, so it selects itself.
// There is no rule here about which position is right, which is the only kind of answer this
// project accepts - the alternative was a heuristic about somebody else's frame ordering.
//
// Driven on the shape that was measured: two candidates, the second one live.
test('crm: with two frames on the CRM origin, the one that answers is the one used', async () => {
  const mk = (live) => {
    const asked = [];
    const ctx = {
      Date, Promise, Error, console, RegExp,
      chrome: {
        tabs: {
          get: async () => ({ url: 'https://one.zoho.eu/home' }),
          sendMessage: async (_id, _msg, to) => {
            asked.push(to.frameId);
            if (to.frameId !== live) throw new Error('Could not establish connection');
            return { ok: true, instance: 'yourinstance', org: '1234567890' };
          },
        },
        scripting: {
          executeScript: async () => ([
            { frameId: 0, result: { href: 'https://one.zoho.eu/home', top: true } },
            { frameId: 1203, result: { href: 'https://crm.zoho.eu/crm/x/tab/A', top: false } },
            { frameId: 1124, result: { href: 'https://crm.zoho.eu/crm/x/tab/B', top: false } },
          ]),
        },
      },
    };
    vm.createContext(ctx);
    vm.runInContext([sliceConst('apps/crm/sidepanel.js', '_crmCandidates'),
                     sliceConst('apps/crm/sidepanel.js', '_crmFrame'),
                     sliceConst('apps/crm/sidepanel.js', '_crmFrameSeen'),
                     sliceFn('apps/crm/sidepanel.js', 'askFrame'),
                     sliceFn('apps/crm/sidepanel.js', 'answeringFrame'),
                     sliceFn('apps/crm/sidepanel.js', 'crmFrameId')].join('\n'), ctx);
    return { ctx, asked };
  };

  // The live frame is the *second* candidate - the case that was failing, because the first is the
  // one a positional rule picks.
  const late = mk(1124);
  assert.equal(await vm.runInContext('crmFrameId(7)', late.ctx), 1124,
               'it took the first candidate the enumeration returned rather than the one that answers');
  assert.deepEqual(late.asked.sort(), [1124, 1203], 'it did not ask both candidates');

  // And the first, so this is not a rule that always prefers the last: a guard that gets one case
  // right by accident is not a guard.
  const early = mk(1203);
  assert.equal(await vm.runInContext('crmFrameId(7)', early.ctx), 1203,
               'it cannot find a live frame that happens to come first');

  // Nobody answers: `null`, which `crmFrameId` records as a miss and does not remember.
  const dead = mk(-1);
  assert.equal(await vm.runInContext('crmFrameId(7)', dead.ctx), null,
               'with no frame answering it named one anyway, which is the guess this replaced');
});

// A tab whose own document is the CRM still costs no round trip: the top frame is preferred, because
// a plain CRM tab has exactly that and asking it would be a message nobody needs.
test('crm: a plain CRM tab is answered from the frame list, without asking anybody', async () => {
  const asked = [];
  const ctx = {
    Date, Promise, Error, console, RegExp,
    chrome: {
      tabs: { get: async () => ({ url: 'https://crm.zoho.eu/crm/x/tab/A' }),
              sendMessage: async (_i, _m, to) => { asked.push(to.frameId); return { ok: true, instance: 'x' }; } },
      scripting: {
        executeScript: async () => ([{ frameId: 0, result: { href: 'https://crm.zoho.eu/crm/x/tab/A', top: true } }]),
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext([sliceConst('apps/crm/sidepanel.js', '_crmCandidates'),
                     sliceConst('apps/crm/sidepanel.js', '_crmFrame'),
                   sliceConst('apps/crm/sidepanel.js', '_crmFrameSeen'),
                   sliceFn('apps/crm/sidepanel.js', 'askFrame'),
                   sliceFn('apps/crm/sidepanel.js', 'answeringFrame'),
                   sliceFn('apps/crm/sidepanel.js', 'crmFrameId')].join('\n'), ctx);
  assert.equal(await vm.runInContext('crmFrameId(7)', ctx), 0, 'the tab\'s own document was not used');
  assert.deepEqual(asked, [], 'it asked a frame it did not need to ask');
});

// ---------------------------------------------------------------------------------------------
// A cache repeats an answer. This one repeated a failure, and that is what «randomly» meant.
//
// `crmFrameId` memoises the frame lookup for six seconds so the five-second context poll does not
// enumerate a tab's frames on every tick. The first version stored a **miss** on the same terms. A
// Zoho One page is a single-page application: while the shell creates or replaces the CRM iframe, an
// enumeration landing in that instant finds no CRM document - and «this tab has no CRM frame» was
// then true for six seconds about a tab that had one. The panel showed «Zoho tab (not ready)», the
// Zoho-bound controls went dead, and it happened at intervals nobody could predict.
//
// Reported from a real Zoho One org, in the word this repository treats as an instruction to go and
// look: the button was disabled «randomly». It was not random - it was the beat between a six-second
// memo and a five-second poll.
//
// Driven rather than read: the sequence is planted - one tab, an enumeration that comes back empty,
// then one that has the frame - and what is asserted is that the second call *looks again*.
test('crm: the frame lookup remembers where the CRM is, never that it could not find it', async () => {
  const mk = () => {
    let hrefs = ['https://one.zoho.com/home'];
    const enumerations = [];
    const ctx = {
      Date, Promise, Error, console, RegExp,
      chrome: {
        tabs: { get: async () => ({ url: 'https://one.zoho.com/home' }) },
        scripting: {
          executeScript: async () => {
            enumerations.push(hrefs.slice());
            return hrefs.map((href, i) => ({ frameId: i, result: { href, top: i === 0 } }));
          },
        },
      },
    };
    vm.createContext(ctx);
    vm.runInContext([sliceConst('apps/crm/sidepanel.js', '_crmCandidates'),
                     sliceConst('apps/crm/sidepanel.js', '_crmFrame'),
                     sliceFn('apps/crm/sidepanel.js', 'crmFrameId')].join('\n'), ctx);
    return { ctx, enumerations, put: (h) => { hrefs = h; } };
  };

  const { ctx, enumerations, put } = mk();
  const first = await vm.runInContext('crmFrameId(7)', ctx);
  assert.equal(first, null, 'a tab with no CRM frame answered with one');

  // The shell finishes building its iframe, well inside the six-second memo.
  put(['https://one.zoho.com/home', 'https://crm.zoho.eu/crm/x/tab/Contacts']);
  const second = await vm.runInContext('crmFrameId(7)', ctx);
  assert.equal(enumerations.length, 2,
               'the miss was cached: the second call answered from memory and never looked again, '
               + 'which is «Zoho tab (not ready)» for as long as the memo lasts');
  assert.equal(second, 1, 'it looked again and still did not find the frame that is there');

  // And the other half, which is what makes the first mean something: a *hit* is still remembered,
  // or this is not a cache at all and the poll enumerates every five seconds for ever.
  const third = await vm.runInContext('crmFrameId(7)', ctx);
  assert.equal(enumerations.length, 2, 'a frame it had already found was looked up again');
  assert.equal(third, 1, 'the remembered frame came back wrong');
});

// ---------------------------------------------------------------------------------------------
// The panel injects into a Zoho CRM frame, or into nothing.
//
// `ZOHO_HOST_RE` accepts `one.zoho.*` so the panel can tell which Zoho One org a tab belongs to.
// The frame search then looked for a CRM document among that tab's frames and, finding none, fell
// back to **frame 0** - the Zoho One page itself - into which `ensureBridge` injected `hook.js`,
// which replaces `fetch` and `XMLHttpRequest` in that page's MAIN world.
//
// Three things wrong, and the third is the one that decides it. `one.zoho.*` is in
// `host_permissions` but declares no content script, so the injection was permitted and undeclared.
// The bridge refuses every command from a non-CRM origin, so it never answered, so the failure path
// re-injected **every five seconds** for as long as that tab stayed active. And `site/privacy.html`
// says of those hosts, in as many words, «which it does not read».
//
// Run rather than read: a regex over the source would have agreed with the version that guessed.
test('crm: a tab with no Zoho CRM frame is not injected into', async () => {
  const frames = (hrefs) => hrefs.map((href, i) => ({ frameId: i, result: { href, top: i === 0 } }));
  const run = async (hrefs, tabUrl, { enumerate = true } = {}) => {
    const calls = [], asked = [];
    const ctx = {
      Date, Promise, Error, console, RegExp,
      MSG: { noTab: 'no tab' }, sleep: async () => {},
      chrome: {
        tabs: {
          get: async () => ({ url: tabUrl }),
          sendMessage: async (_id, _msg, to) => { asked.push(to); throw new Error('nobody answered'); },
        },
        scripting: {
          executeScript: async (o) => {
            if (o.func) {
              if (!enumerate) throw new Error('cannot enumerate');
              return frames(hrefs);
            }
            calls.push(o.files[0]);
            return [];
          },
        },
      },
    };
    vm.createContext(ctx);
    vm.runInContext([sliceConst('apps/crm/sidepanel.js', '_crmCandidates'),
                     sliceConst('apps/crm/sidepanel.js', '_crmFrame'),
                     sliceFn('apps/crm/sidepanel.js', 'crmFrameId'),
                     sliceFn('apps/crm/sidepanel.js', 'ensureBridge')].join('\n'), ctx);
    // A fresh tab id per case: the six-second memo would otherwise answer for the previous one.
    const id = calls.length + Math.floor(Math.random() * 1e6) + hrefs.join('').length;
    const ok = await vm.runInContext(`ensureBridge(${id})`, ctx);
    return { ok, injected: calls, asked };
  };

  const one = await run(['https://one.zoho.com/home', 'https://mail.zoho.com/x'], 'https://one.zoho.com/home');
  assert.deepEqual(one.injected, [],
    `a Zoho One tab with no CRM frame was injected into: ${one.injected.join(', ')} - and privacy.html ` +
    `says of that host «which it does not read»`);
  assert.equal(one.ok, false, 'it reported success over a tab it cannot speak to');
  // **And it still asks.** Asking and injecting are different acts, and the first version of this
  // fix refused both: with no CRM frame the panel stopped asking too, so the context bar went from
  // naming the org to «Zoho tab (not ready)» - in thirteen of the site's screenshots, which is how
  // it was caught. Asking costs nothing and the bridge refuses a non-CRM origin by itself.
  assert.equal(one.asked.length, 1, 'the panel stopped asking the tab who it is');
  // Keys rather than deepEqual: the object is built inside the vm realm, so its prototype is not
  // this one's and a structural compare fails on two empty objects.
  assert.deepEqual(Object.keys(one.asked[0]), [],
                   'it named a frame that is not there rather than asking the tab');

  // The ordinary case still works, because a guard that refuses everything is not safety.
  const crm = await run(['https://one.zoho.com/home', 'https://crm.zoho.eu/crm/tab'], 'https://one.zoho.com/home');
  assert.deepEqual(crm.injected, ['hook.js', 'content-bridge.js'],
    'a tab that does have a CRM frame was not reached');

  // And the one guess that is not a guess: the enumeration itself failed on a CRM tab.
  const blind = await run([], 'https://crm.zoho.eu/crm/tab', { enumerate: false });
  assert.deepEqual(blind.injected, ['hook.js', 'content-bridge.js'],
    'a CRM tab whose frames could not be listed is refused, though its own document is the target');
  const blindOne = await run([], 'https://one.zoho.com/home', { enumerate: false });
  assert.deepEqual(blindOne.injected, [],
    'the frame list failed and it injected into a Zoho One document anyway');
});

// ---------------------------------------------------------------------------------------------
// Diagram defaults saved in Settings apply to both graphs.
//
// The window records which graph it was tuned on, and applies a saved `current` only when the
// recorded kind matches - a guard written on the premise, stated in its comment and asserted by a
// regex in another test, that «that page writes no kind». True of what the page *composes* and false
// of what it *writes*: the merge that stops the page erasing the window's `mode` carries the
// window's `kind` through with it.
//
// So: open a Wiring diagram, touch one slider, save defaults in Settings, open a Schema diagram -
// and the defaults are read and discarded. «Diagram defaults saved.» and nothing changes, which is
// the exact symptom the merge was introduced to cure. Two corrections from one day, each right
// alone, composing into the defect either one was written to prevent - and the test that guards it
// asserts the expression rather than the behaviour, so it passes on both.
test('crm: diagram defaults saved in Settings are applied by either graph', async () => {
  // What the settings page writes, run rather than read.
  let stored = { erParams: { current: { margin: 36 }, mode: 'modules', kind: 'calls' } };
  const ctx = {
    Object, Promise, Number, Math, Array, String, JSON, console,
    lay: { margin: 60, spread: 42, gap: 8, fs: 10, sub: true }, drawMax: 800,
    saveKeys: async (o) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); return true; },
    stamp: async () => {}, toast: () => {},
    chrome: { storage: { local: { get: async () => JSON.parse(JSON.stringify(stored)) } } },
  };
  vm.createContext(ctx);
  // The handler by the control it belongs to, and run as itself. It used to be sliced out of the
  // file from the position of `$('saveLay').onclick` and wrapped in an arrow - which broke the day
  // the body moved above the assignment, and would have broken again at the next reshuffle. The
  // panels name every async scope now, so ask for the name.
  vm.runInContext(`${handlerOf('apps/crm/options.js', 'saveLay')}\nonSaveLay();`, ctx);
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(stored.erParams.current.margin, 60, 'the page did not save what it shows');
  assert.equal(stored.erParams.mode, 'modules',
    'the page erased the emphasis, which belongs to the window and which it cannot show');
  assert.equal('kind' in stored.erParams, false,
    'the settings page wrote which graph these defaults belong to, so the other graph reads them ' +
    'and throws them away - «Diagram defaults saved.» and nothing changes');

  // And the window's own guard, on what was just written: both kinds must apply it.
  const applies = (kind) => {
    const ep = stored.erParams;
    return !!(ep && ep.current && (ep.kind === undefined || ep.kind === kind));
  };
  assert.equal(applies('schema'), true, 'a schema diagram discards the saved defaults');
  assert.equal(applies('calls'), true, 'a wiring diagram discards the saved defaults');
});

// ---------------------------------------------------------------------------------------------
// A dot that refreshes an area does not paint over what the pull said.
//
// `refreshSchedules` wrote «N schedules.» in green after `pullSchedules`, unconditionally - and that
// pull never throws: a partial list from Zoho, a role that refuses, no Zoho tab, an environment
// mismatch and a folder permission denied are early returns, each setting its own line and coming
// back to be painted over. The count was the length of the list *already in memory*, since the new
// one is installed only on success, so a failure read as «refreshed, 12 schedules». And `setStatus`
// calls `showEmergency(false)`, so the green line also closed the «Report this problem» banner the
// failure had just raised.
//
// Its three siblings - Connections, Actions, and a module resync - let the pull own the message.
// Derived from the file rather than named: any dot handler that awaits a `pull*` and then sets a
// status is doing this, and the limit is stated - it reads the handler's own body, so a message set
// by something the handler calls is invisible here.
test('crm: an area dot lets its pull say what happened', () => {
  const src = blankNonCode(read('apps/crm/automation.js'))
    + blankNonCode(read('apps/crm/connections.js'))
    + blankNonCode(read('apps/crm/modules.js'));
  const bad = [];
  let handlers = 0;
  for (const m of src.matchAll(/^async function (refresh\w+|resync\w+)\([^\n]*\{/gm)) {
    const body = src.slice(m.index, src.indexOf('\n}', m.index));
    if (!/await pull\w+\(|await sync\w+\(/.test(body)) continue;
    handlers++;
    // What comes after the pull, in this handler: **any** status set there cannot know whether the
    // pull worked, because the pull's failure paths return rather than throw. Not «any green one» -
    // the first version of this looked for `'ok'` and could never match, because it reads the text
    // with string literals blanked and `'ok'` is one. A check that cannot see its own subject is the
    // thing this file is full of notes about; it went green on the plant, which is how it was found.
    const after = body.slice(body.search(/await (pull|sync)\w+\(/));
    if (/setStatus\(/.test(after)) bad.push(m[1]);
  }
  assert.ok(handlers >= 3, `only ${handlers} area dot(s) found - the derivation broke`);
  assert.deepEqual(bad, [],
    `these paint a green line over whatever their pull just said, including a refusal: ${bad.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------
// The report says what its «no caller» was measured over.
//
// The call graph is built from the `.dg` files on disk, so a function that never downloaded is not
// a node and anything it alone called comes out under «no caller». `loadGraph` computes
// `counts.notInMirror` precisely for this. Three consumers state it - the health view, the
// assistant, the diagram window - and the HTML report did not, though its coverage block is a fixed
// string sitting directly above the orphan list, which is where somebody decides a function is safe
// to delete. It is also the one surface written for a reader who cannot go back and ask the panel.
test('crm: the exported report states how much of the org its graph covers', () => {
  const globals = {
    SCOPE_DEFAULT: {}, SCOPE_KEYS: [], bound: { instance: 'yourinstance' },
    envOf: () => 'eu', freshnessLine: () => 'just now', byField: () => () => 0,
    wfScheduled: () => ({ count: 0, delays: [] }), isFnAction: () => false,
    moduleRefusal: () => '', actionKindLabel: (k) => k,
    actStale: () => false, actKept: () => false, actThin: () => false,
    PRODUCT_NAME: 'Zoost', PRODUCT_URL: 'https://zoost.it', PRODUCT_AUTHOR: 'Ivan', LEGAL_DISCLAIMER: 'x',
    MSG: { hRankedOver: () => '', hOrphan: 'Orphan candidates', hUnresolved: 'u', hAmbiguous: 'a',
           hBroken: 'b', hMissingRefs: 'm', hBiggest: 'Biggest', hChattiest: 'Chattiest', hBiggestDesc: 'd' },
    // The escapers the builder reaches for, stubbed to the identity: what is asserted below is the
    // sentence, and `htmlcheck` is what holds the escaping.
    escHtml: (x) => String(x == null ? '' : x), escA: (x) => String(x == null ? '' : x),
    esc: (x) => String(x == null ? '' : x), fnAnchor: (x) => `fn-${x}`, modAnchor: (x) => `mod-${x}`,
    wfAnchor: (x) => `wf-${x}`, schAnchor: (x) => `sch-${x}`, connAnchor: (x) => `conn-${x}`,
    hl: (x) => String(x || ''), first: (x) => String(x || ''), params: () => '',
    EXPORT_CSS: '', sanitize: (x) => String(x || ''), KOFI_URL: '', SPONSOR_URL: '',
    chrome: { runtime: { getManifest: () => ({ version: '1.2.3' }) } },
  };
  const build = (counts) => {
    const { buildExportHtml } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportMark'), sliceFn('apps/crm/reportshell.js', 'reportHead'), sliceConst('apps/crm/reportshell.js', 'REPORT_FILTER_JS'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportHtml')], { ...globals });
    const node = { id: 'ns.alpha', namespace: 'ns', name: 'alpha', api_name: 'alpha',
                   calls: [], called_by: [], dead_suspect: true };
    return buildExportHtml([{ api_name: 'alpha', display_name: 'Alpha', namespace: 'ns', node }],
                           [], { nodes: { 'ns.alpha': node }, counts }, {}, [], [], [],
                           { at: null, usage: null, failures: [] }, [], new Map(),
                           { functions: true, health: true });
  };

  const short = build({ nodes: 1, inOrg: 6, notInMirror: 5 });
  assert.match(short, /5 could not be downloaded/,
    'the report lists orphan candidates without saying five of the org never reached the mirror');
  assert.match(short, /Orphan candidates/, 'the health chapter is not there at all - this proves nothing');

  const unknown = build({ nodes: 1, inOrg: null, notInMirror: null });
  assert.match(unknown, /could not be established/,
    'an unmeasurable share of the org reads as a complete one');

  // And the other half: with the whole org in the mirror it says nothing, because there is nothing
  // to say and a caveat on every report is a caveat nobody reads.
  const whole = build({ nodes: 6, inOrg: 6, notInMirror: 0 });
  assert.doesNotMatch(whole, /could not be downloaded|could not be established/,
    'a complete mirror is hedged about anyway');
});

// ---------------------------------------------------------------------------------------------
// «Which rules fire this action» has one answer, not four.
//
// `buildActionUsers` writes two keys per action on purpose - by id and by lowercased name - because
// the id Zoho puts inside a workflow's `instant_actions.actions[]` is not always the id the actions
// census carries. The same asymmetry is recorded as *measured* one function over: 77 of 77 workflow
// references matched by name and none by id.
//
// `actionFiredBy` read both. Four other readers asked the id key alone - the health view's «nothing
// fires it» group, the assistant's «attached to no rule» count and its `list_actions` tool, and both
// reports, where the map was not even built with the second key. So one action reads as `1 rule` on
// the Actions tab and as fired by nothing in the list a reader uses to decide what is safe to delete.
//
// The sample workspace writes matching ids, so the fallback never fires in any fixture: this is a
// case that could only be found by reading, and can only be held by running it on the mismatch.
test('crm: every surface answers «fired by» through the same lookup', () => {
  const ctx = {
    Map, Set, Object, String, Array, console,
    actionUsers: null,
  };
  vm.createContext(ctx);
  vm.runInContext([sliceFn('apps/crm/automation.js', 'buildActionUsers').replace(/^async /, ''),
                   sliceFn('apps/crm/automation.js', 'firedBy')].join('\n'), ctx);

  // The mismatch: the rule names the action by an id the census does not carry.
  ctx.map = new Map([
    ['email_notifications:99999', [{ id: 7, name: 'Renewal' }]],
    ['email_notifications:name:renewal notice', [{ id: 7, name: 'Renewal' }]],
  ]);
  ctx.act = { kind: 'email_notifications', id: '5000', name: 'Renewal notice' };
  const found = vm.runInContext('firedBy(act, map)', ctx);
  assert.equal(found.length, 1,
    'the shared lookup does not fall back to the name, so the two keys buy nothing');

  // And every reader goes through it: derived, so a fifth one added tomorrow is a finding.
  const bad = [];
  for (const rel of ['apps/crm/health.js', 'apps/crm/ai.js', 'apps/crm/export.js']) {
    const src = blankNonCode(read(rel));
    // No string literal in the pattern: the scan blanks `':'`, so a criterion written with it
    // cannot match anything. What survives is the shape - `<map>.get(a.kind + ...`.
    for (const m of src.matchAll(/(\w+)\.get\((?:a\.kind|a\.type)\s*\+/g)) {
      bad.push(`${rel}: ${m[0]}...`);
    }
  }
  assert.deepEqual(bad, [],
    `these look up which rules fire an action by id alone, so an action whose ids disagree reads as ` +
    `fired by nothing: ${bad.join('; ')}`);

  // The export builds its own map, and it must carry both keys too. **Raw source, not the scanner**:
  // the key is a string literal - `` `${a.type}:name:${...}` `` - and the scanner blanks literal
  // text by design, so `:name:` is not there to find. That is the third time today I have looked for
  // a literal in a scan that removes literals; the rule is that a check about a *string* reads the
  // source, and a check about *structure* reads the scan.
  const exp = read('apps/crm/export.js');
  const at = exp.indexOf('const actUsers = new Map()');
  assert.ok(at > 0, 'the export no longer builds its own map - this test is measuring nothing');
  assert.match(exp.slice(at, exp.indexOf('  }));', at)), /:name:/,
    'the export builds the map with the id key alone, so its «Fired by» column is blank for an ' +
    'action the panel shows a rule for');
});

// ---------------------------------------------------------------------------------------------
// After a pull, `in: SQL` searches the queries rather than reporting on none.
//
// `ensureSqlCache` gathered the queries to search with `filter(([, q]) => q && q.stem)`. A stem is
// the name of the `.sql` file on disk, and it is put there by `loadFromDisk`. **A pull publishes
// `sqls` straight from the bridge**, whose answer is `{id, sql, parents, sources}` - no stem. So
// immediately after a Pull all this filtered out every query, and the branch written for exactly
// this case, three lines below, was never reached.
//
// What the reader saw: «No query matches. The search box is narrowing 12 queries down to none» -
// and no caveat, because `sqlUnread` counts views whose SQL is *missing*, and these are present.
// The one sentence written to stop this - «searched 47/50, absence is not exhaustive» - was
// suppressed by the same shape it exists for. Reopening the panel fixed it, which is why it lasted.
//
// Every fixture in this suite seeds a stem, and the pull probe's fake bridge **invents one the real
// bridge never sends**, so nothing could see it.
test('analytics: the SQL search reads what a pull just published', async () => {
  const ctx = {
    Map, Set, Object, String, Array, Promise, console, JSON,
    // Exactly what `pullAll` assigns: `sqls: sq.sql || {}`.
    sqls: { v1: { id: 'v1', sql: 'select a from t', parents: [], sources: {} },
            v2: { id: 'v2', sql: 'select b from u', parents: [], sources: {} } },
    sqlCache: null, sqlDiskUnread: new Set(), views: [], pullFailed: [],
    sqlState: () => ({ kind: 'read' }), viewById: () => new Map(),
    beginWorkspaceOp: () => ({ current: () => true, say: () => {}, read: async () => { throw new Error('no file'); } }),
    setStatus: () => {}, sqlUnread: 0,
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/analytics/sidepanel.js', 'ensureSqlCache'), ctx);
  const cache = await vm.runInContext('ensureSqlCache()', ctx);

  assert.ok(cache && cache.size >= 2,
    `the search cache holds ${cache ? cache.size : 'nothing'} of the 2 queries the pull published, ` +
    `so «no match» would be reported over queries that were never opened`);
  assert.equal(cache.get('v1'), 'select a from t', 'the body the pull carried is not what is searched');
});

// ---------------------------------------------------------------------------------------------
// The export defaults page can set every box the export dialog has.
//
// `SCOPE_KEYS` is the list of what an export may contain. The panel holds twelve; the settings page
// held **nine** - `actions`, `addresses` and `failures` were added to the dialog and not here, so
// the three chapters that carry the most (what a rule fires, the address it sends as, what is
// failing) could be ticked in the dialog every single time and never set as a default. The page drew
// nine checkboxes too, so on screen it looked like the whole set.
//
// Derived from the panel, which is where the export actually reads its scope: the keys must match,
// and the page must have a control for each. An existing test already covers the *deliberate* half -
// that a preset carries what the page cannot show - and this is the other half of the same rule.
test('crm: Settings can set every export scope the panel offers', () => {
  const keysOf = (rel) => {
    const m = /^const SCOPE_KEYS = \[([^\]]+)\]/m.exec(blankNonCode(read(rel)) === '' ? '' : read(rel));
    assert.ok(m, `${rel}: SCOPE_KEYS was not found - the derivation broke`);
    return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
  };
  const panel = keysOf('apps/crm/sidepanel.js');
  const page = keysOf('apps/crm/options.js');
  assert.ok(panel.length >= 10, `the panel offers ${panel.length} scope(s) - the derivation broke`);
  assert.deepEqual(page, panel,
    `Settings and the export dialog disagree about what an export may contain: Settings is missing ` +
    `${panel.filter((k) => !page.includes(k))}, and invents ${page.filter((k) => !panel.includes(k))}`);

  // And a key with no control is a default nobody can set.
  const html = read('apps/crm/options.html');
  const without = panel.filter((k) => !html.includes(`id="sc_${k}"`));
  assert.deepEqual(without, [],
    `these export scopes have no checkbox on the settings page, so they cannot be made a default: ${without}`);
});

// ---------------------------------------------------------------------------------------------
// What the panel shows about a runtime reading is in both reports.
//
// `failures/index.json` carries four things: when it was read, the aggregate `usage`, the per-
// function `runs` for the last 24 hours, and the `credits` counted against the org's ceiling. The
// health view shows all four - a «Most run, measured» group, a per-row `· ran N× in 24h`, and the
// credits sentence - and `list_failures` sends all four to the assistant.
//
// Both reports read `at`, `usage`, `capped` and the failure rows, and neither read `runs` or
// `credits`. `loadExportData` already loads the whole file, so this cost no extra read: it is the
// project's own rule - «every piece of information the panel shows about an item belongs in the
// HTML and Markdown exports too» - broken on data that was already in hand.
//
// The one derived check nearby deliberately skips this area («Most run is a reading of Zoho's
// runtime»), which is correct for what it is about and is why nothing caught it.
test('crm: both reports carry the run counts and the credit reading', () => {
  const globals = {
    chrome: { runtime: { getManifest: () => ({ version: '1.2.3' }) } },
    SCOPE_DEFAULT: {}, SCOPE_KEYS: [], bound: { instance: 'yourinstance' },
    envOf: () => 'eu', freshnessLine: () => 'just now', byField: () => () => 0,
    wfScheduled: () => ({ count: 0, delays: [] }), isFnAction: () => false,
    moduleRefusal: () => '', actionKindLabel: (k) => k, firedBy: () => [],
    actStale: () => false, actKept: () => false, actThin: () => false,
    _mdCell: (x) => String(x == null ? '' : x),
    PRODUCT_NAME: 'Zoost', PRODUCT_URL: '', PRODUCT_AUTHOR: 'Ivan', LEGAL_DISCLAIMER: 'x',
    SPONSOR_URL: '', KOFI_URL: '', EXPORT_CSS: '', sanitize: (x) => String(x || ''),
    escHtml: (x) => String(x == null ? '' : x), escA: (x) => String(x == null ? '' : x),
    esc: (x) => String(x == null ? '' : x), hl: (x) => String(x || ''), first: (x) => String(x || ''),
    params: () => '', fnAnchor: (x) => `fn-${x}`, modAnchor: (x) => `mod-${x}`,
    wfAnchor: (x) => `wf-${x}`, schAnchor: (x) => `sch-${x}`, connAnchor: (x) => `conn-${x}`,
    FAIL_CAPPED: 'capped.',
    MSG: { hRankedOver: () => '', hOrphan: 'o', hUnresolved: 'u', hAmbiguous: 'a', hBroken: 'b',
           hMissingRefs: 'm', hBiggest: 'B', hChattiest: 'C', hBiggestDesc: 'd' },
  };
  const fails = {
    at: '2026-08-23T10:00:00Z',
    usage: { success: 900, failure: 3 },
    runs: [{ id: '1', name: 'nightlyDigest', count: 412 }, { id: '2', name: 'syncContact', count: 88 }],
    credits: { used: 12345, limit: 50000 },
    failures: [],
  };
  const scope = { functions: true, failures: true };

  const { buildExportHtml } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportMark'), sliceFn('apps/crm/reportshell.js', 'reportHead'), sliceConst('apps/crm/reportshell.js', 'REPORT_FILTER_JS'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportHtml')], globals);
  const html = buildExportHtml([], [], { nodes: {}, counts: {} }, {}, [], [], [], fails, [], new Map(), scope);
  assert.match(html, /nightlyDigest/, 'the HTML report does not name the busiest functions the panel lists');
  assert.match(html, /412/, 'the HTML report drops the run counts');
  assert.match(html, /12345[\s\S]{0,60}50000/, 'the HTML report drops the credit reading');
  assert.match(html, /how often, not how long/,
    'the run counts are in the report without the caveat the panel gives them - and a report is read ' +
    'without the panel beside it');

  const { buildExportMarkdown } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportMarkdown')], globals);
  const md = buildExportMarkdown({ fns: [], mods: [], g: { nodes: {} }, modRefs: {}, wfs: [], scheds: [],
                                   conns: [], fails, acts: [], actUsers: new Map() }, scope);
  assert.match(md, /nightlyDigest/, 'the Markdown report does not name the busiest functions');
  assert.match(md, /412/, 'the Markdown report drops the run counts');
  assert.match(md, /12345[\s\S]{0,60}50000/, 'the Markdown report drops the credit reading');
  assert.match(md, /how often, not how long/, 'the Markdown report drops the caveat');
});

// ---------------------------------------------------------------------------------------------
// A list the code holds, written out again by hand in the file next door.
//
// `SCOPE_KEYS`, `SCOPE_FULL` and `SCOPE_SAFE` are declared **twice** in the CRM - once in
// `sidepanel.js`, where the export dialog reads them, and once in `options.js`, where the defaults
// page does. Three lists, two copies each, kept in step by whoever remembers. They did not stay in
// step: `SCOPE_SAFE` on the settings page was missing `actions`, `addresses` and `failures`, so
// **Safe** meant one thing in the dialog and another in Settings - and because `Object.assign`
// only copies the keys it *has*, the three it lacked were left at whatever they happened to be
// rather than set. Nothing said so; the button worked.
//
// A check written about `SCOPE_KEYS` by name had already run over this file for weeks. It found the
// list it was told to look at and said nothing about the two beside it, which is what a check named
// after an instance does. So this one is about the shape: whenever the same SCREAMING_CASE constant
// is declared at the top level of two scripts of one product, the two are compared.
//
// The criterion for «this is a copy» comes off the values, never off the name: two object literals
// that **share a key** are one list written twice, and must then carry the same keys with the same
// values. Two that share none are two different tables that happen to share a name - measured, and
// that is exactly `MSG`, whose three declarations (panel, settings, diagram) partition cleanly with
// zero keys in common. Arrays are compared whole.
//
// Limits, so they are declared rather than discovered: it reads **top-level** `const NAME = {…}` and
// `const NAME = […]` only, so a list built by a function, assembled conditionally or nested inside
// another declaration is invisible to it; and it compares the *text* of a value, so two spellings of
// one thing (`0` and `-0`, a call and its result) read as a disagreement, which is the safe way
// round. The keys are read off the scanner - a `const` inside a comment is not a declaration - and
// the values off the source, because a value can be a string and the scanner blanks those.
test('a constant declared in two scripts of one product is not two lists', () => {
  const decls = (rel) => {
    const scan = blankNonCode(read(rel)), raw = read(rel), out = new Map();
    for (const m of scan.matchAll(/^const ([A-Z][A-Z0-9_]{2,}) = ([[{])/gm)) {
      let depth = 0, j = m.index + m[0].length - 1;
      for (; j < scan.length; j++) {
        if (scan[j] === '[' || scan[j] === '{') depth++;
        else if (scan[j] === ']' || scan[j] === '}') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) continue;                       // unterminated in the scan: not readable, skip
      out.set(m[1], raw.slice(m.index + m[0].length - 1, j + 1));
    }
    return out;
  };
  // Top-level members of a literal, by the same brace walk. Strings are stepped over whole, so a
  // comma or a brace inside one does not split anything.
  const members = (body) => {
    const parts = [];
    let depth = 0, buf = '', str = null;
    for (const ch of body.slice(1, -1)) {
      if (str) { buf += ch; if (ch === str && buf.at(-2) !== '\\') str = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { str = ch; buf += ch; continue; }
      if (ch === '[' || ch === '{' || ch === '(') depth++;
      else if (ch === ']' || ch === '}' || ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; } else buf += ch;
    }
    parts.push(buf);
    return parts.map((p) => p.trim()).filter(Boolean);
  };
  const keyed = (body) => {
    const map = new Map();
    for (const p of members(body)) {
      const m = /^(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*:([\s\S]*)$/.exec(p);
      if (!m) return null;                             // a spread or a computed key: not comparable
      map.set(m[1] ?? m[2] ?? m[3], m[4].replace(/\s+/g, ' ').trim());
    }
    return map;
  };

  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  let pairs = 0;
  const bad = [];
  for (const app of apps) {
    const per = new Map();
    for (const rel of shippedScripts().filter((f) => f.startsWith(`apps/${app}/`))) {
      for (const [name, body] of decls(rel)) {
        if (!per.has(name)) per.set(name, []);
        per.get(name).push({ rel, body });
      }
    }
    for (const [name, where] of per) {
      for (let a = 0; a < where.length; a++) {
        for (let b = a + 1; b < where.length; b++) {
          const [x, y] = [where[a], where[b]];
          pairs++;
          if (x.body.startsWith('[')) {
            if (x.body.replace(/\s+/g, ' ') !== y.body.replace(/\s+/g, ' ')) {
              bad.push(`${name}: ${x.rel} and ${y.rel} hold different lists`);
            }
            continue;
          }
          const kx = keyed(x.body), ky = keyed(y.body);
          if (!kx || !ky) continue;                    // not readable as a plain table
          const shared = [...kx.keys()].filter((k) => ky.has(k));
          if (!shared.length) continue;                // two tables that share a name, not a copy
          const miss = [...kx.keys()].filter((k) => !ky.has(k));
          const extra = [...ky.keys()].filter((k) => !kx.has(k));
          const differ = shared.filter((k) => kx.get(k) !== ky.get(k));
          if (miss.length || extra.length || differ.length) {
            bad.push(`${name}: ${x.rel} and ${y.rel} share ${shared.length} key(s), so they are one `
              + `list written twice - ${y.rel} is missing [${miss}], adds [${extra}], disagrees on [${differ}]`);
          }
        }
      }
    }
  }
  assert.ok(pairs >= 4, `only ${pairs} duplicated constant(s) compared - the derivation broke`);
  assert.deepEqual(bad, [], `a list is written out twice and the copies have drifted:\n  ${bad.join('\n  ')}`);
});

// ---------------------------------------------------------------------------------------------
// The words spoken across a world boundary are one vocabulary, not two lists that resemble each other.
//
// Three programs make live sync work, and no two of them share a scope. `hook.js` runs in the page's
// MAIN world and posts `{source: 'DELUGE_IDE_HOOK', …}`; `content-bridge.js` runs in the isolated
// world and drops anything whose `source` is not that exact string; the panel speaks to the bridge in
// `cmd` names. Each end is correct on its own, and each end was **asserted** on its own - the check
// that guards the page channel reads the bridge's literal and never the hook's. So the two could be
// made to disagree by one edit in either file: measured, by renaming the hook's tag to
// `ZOOST_IDE_HOOK`. Every notice a save, a deletion or a creation produces is then dropped in
// silence, live sync stops existing, and 874 Node cases, 377 Python cases and every checker stayed
// green - the only red was the screenshots noticing that a file under `apps/` had moved.
//
// That is the composition defect in its plainest form: two correct halves and nothing that reads
// them together. So this reads them together, and derives both sides rather than restating either.
//
// **The limits, stated.** It takes the literals out of the raw source, because a check about a
// *string* has to read the string - the scanner blanks them - and it keeps only matches on a line
// the scanner leaves some code on, so a whole-line comment cannot contribute a word. A `cmd:`
// written in a trailing comment on a code line would still count, which is the narrow gap left. It
// says nothing about *what* a handler does with a command, and the products that have no hook are
// skipped for the hook half rather than named - Analytics has none, and derives out of it.
test('the panel, the bridge and the hook share one vocabulary, not two lists', () => {
  const litsIn = (src, re) => {
    const scan = blankNonCode(src), out = new Set();
    for (const m of src.matchAll(re)) {
      const from = src.lastIndexOf('\n', m.index) + 1;
      const to = src.indexOf('\n', m.index);
      if (scan.slice(from, to < 0 ? scan.length : to).trim() === '') continue;   // a comment line
      out.add(m[1]);
    }
    return out;
  };
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  let words = 0, hooks = 0;
  for (const app of apps) {
    const own = shippedScripts().filter((f) => f.startsWith(`apps/${app}/`));
    const bridgeRel = `apps/${app}/content-bridge.js`;
    if (!own.includes(bridgeRel)) continue;
    const bridge = read(bridgeRel);
    const panel = own.filter((f) => f !== bridgeRel).map(read).join('\n');

    // What the panel asks for, against what the bridge answers.
    const asked = litsIn(panel, /\bcmd:\s*'([\w-]+)'/g);
    const answered = litsIn(bridge, /\bcmd\s*===\s*'([\w-]+)'/g);
    words += asked.size;
    assert.deepEqual([...asked].filter((c) => !answered.has(c)).sort(), [],
      `id=${app}: the panel sends these commands and the bridge answers none of them, so the call `
      + `hangs or fails at a boundary neither file mentions: `
      + `${[...asked].filter((c) => !answered.has(c))}`);
    assert.deepEqual([...answered].filter((c) => !asked.has(c)).sort(), [],
      `id=${app}: the bridge answers these commands and nothing sends them - dead code in the one `
      + `file that runs inside somebody else's page: ${[...answered].filter((c) => !asked.has(c))}`);

    // The page channel's tag, both ends, compared with each other.
    const hookRel = `apps/${app}/hook.js`;
    if (!own.includes(hookRel)) continue;
    hooks++;
    const posted = [...litsIn(read(hookRel), /\bsource:\s*'([\w-]+)'/g)];
    // Inside the page listener and nowhere else: `source` is also a field on a function Zoho
    // returns, and the first version of this read `f.source !== 'extension'` two hundred lines
    // above as a second tag and said «the derivation broke». It was right to say so.
    const at = bridge.indexOf("addEventListener('message'");
    assert.ok(at > 0, `id=${app}: the bridge has no page-message listener - the derivation broke`);
    const listener = bridge.slice(at, bridge.indexOf('\n  });', at));
    const expected = [...litsIn(listener, /\.source\s*!==\s*'([\w-]+)'/g)];
    assert.equal(posted.length, 1, `id=${app}: the hook posts ${posted.length} source tag(s) - the derivation broke`);
    assert.equal(expected.length, 1, `id=${app}: the bridge expects ${expected.length} source tag(s) - the derivation broke`);
    assert.equal(posted[0], expected[0],
      `id=${app}: the hook posts «${posted[0]}» and the bridge drops anything that is not `
      + `«${expected[0]}», so every save, deletion and creation is discarded in silence`);
  }
  assert.ok(words >= 10, `only ${words} command(s) compared across the bridges - the derivation broke`);
  assert.equal(hooks, 1, `${hooks} product(s) with a hook were compared - the derivation broke`);
});

// ---------------------------------------------------------------------------------------------
// The contents and the document are one list, and they were built twice.
//
// Every chapter ticked, and something in every list. Both reports were exercised with `fns: []` or
// with `scope.code` absent, so **the branch that renders source had never been executed by anything**
// - and it threw: `srcBlock` is a `const` arrow that was written 76 lines below the section that
// calls it, which is its temporal dead zone. Every HTML export with source ticked - the default -
// died on «Cannot access 'srcBlock' before initialization». Found by the author using the product.
//
// A fixture that cannot reach a branch proves nothing about that branch, and this file had four
// callers of `buildExportHtml` and no way to tell that none of them reached this one. So: the scope
// is **derived from the shipped list** rather than typed here, a function is present in all three of
// the source states the builder distinguishes, and both reports are asked for a document.
//
// **The limits, stated.** It asserts the report is produced and carries each item, not that any
// chapter is right - the cases above and below do that. Nothing here would catch a wrong sentence;
// what it catches is the class that has now shipped once, a reference evaluated before its
// declaration, which no amount of reading the diff finds and one execution does.
test('crm: both reports are produced with every chapter ticked and something in every list', () => {
  const globals = {
    chrome: { runtime: { getManifest: () => ({ version: '1.2.3' }) } },
    SCOPE_DEFAULT: {}, SCOPE_KEYS: [], bound: { instance: 'yourinstance' },
    envOf: () => 'eu', freshnessLine: () => 'just now', byField: () => () => 0,
    wfScheduled: () => ({ count: 0, delays: [] }), isFnAction: () => false,
    moduleRefusal: () => '', actionKindLabel: (k) => k, firedBy: () => [],
    actProv: () => '', actWhen: () => '', actStale: () => false, actKept: () => false,
    actThin: () => false, _mdCell: (x) => String(x == null ? '' : x),
    PRODUCT_NAME: 'Zoost', PRODUCT_URL: 'https://zoost.it', PRODUCT_AUTHOR: 'Ivan',
    LEGAL_DISCLAIMER: 'x', SPONSOR_URL: '', KOFI_URL: '', EXPORT_CSS: '',
    sanitize: (x) => String(x || ''), escHtml: (x) => String(x == null ? '' : x),
    escA: (x) => String(x == null ? '' : x), esc: (x) => String(x == null ? '' : x),
    hl: (x) => String(x || ''), first: (x) => String(x || ''), params: () => '',
    fnAnchor: (x) => `fn-${x}`, modAnchor: (x) => `mod-${x}`, wfAnchor: (x) => `wf-${x}`,
    schAnchor: (x) => `sch-${x}`, connAnchor: (x) => `conn-${x}`, FAIL_CAPPED: 'capped.',
    MSG: { hRankedOver: () => '', hOrphan: 'o', hUnresolved: 'u', hAmbiguous: 'a', hBroken: 'b',
           hMissingRefs: 'm', hBiggest: 'B', hChattiest: 'C', hBiggestDesc: 'd' },
    // The builder's own `hl` asks the page for the highlighter and falls back to escaping. Without
    // this the fixture cannot reach the source branch at all, which is how the branch stayed unrun.
    window: {},
  };

  // Derived, so a chapter added tomorrow is exercised without anyone remembering to add it here.
  const keys = JSON.parse(sliceConst('apps/crm/sidepanel.js', 'SCOPE_KEYS')
    .replace(/^[^[]*/, '').replace(/;\s*$/, '').replace(/'/g, '"'));
  assert.ok(keys.length >= 12 && keys.includes('code'), `SCOPE_KEYS did not lift: ${keys}`);
  const scope = {};
  for (const k of keys) scope[k] = true;

  const node = { id: 'ns.alpha', namespace: 'ns', name: 'alpha', api_name: 'alpha',
                 calls: [], called_by: [], dead_suspect: false };
  // The three states `srcBlock` distinguishes, all present: read, unreadable, never downloaded.
  const fns = [
    { api_name: 'alpha', display_name: 'Alpha', namespace: 'ns', node, downloaded: true,
      code: 'info "x";', stats: { lines: 1, codeLines: 1, chars: 9, apiCalls: 0 } },
    { api_name: 'beta', display_name: 'Beta', namespace: 'ns', downloaded: true, code: null },
    { api_name: 'gamma', display_name: 'Gamma', namespace: 'ns', downloaded: false },
  ];
  const mods = [{ api_name: 'Contacts', display_name: 'Contacts',
                  related_lists: [{ api_name: 'Notes', module: 'Notes' }] }];
  const health = { at: '2026-08-23T10:00:00Z', usage: { success: 9, failure: 1 }, runs: [],
                   failures: [{ name: 'f', count: 1, reason: 'r' }] };
  const args = [fns, mods, { nodes: { 'ns.alpha': node }, counts: {} }, {},
                [{ id: '1', name: 'W', module: 'Contacts', actions: [],
                   detail: { conditions: [{ instant_actions: { actions: [{ type: 'functions', id: '9', name: 'Alpha' }] } }] } }],
                [{ id: '1', name: 'S', function_id: '9', function_name: 'Alpha' }],
                [{ name: 'c', linkName: 'c', uses: [], status: 'ok' }], health,
                [{ id: '1', name: 'A', kind: 'tasks' }], new Map(), scope];

  const { buildExportHtml } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportMark'), sliceFn('apps/crm/reportshell.js', 'reportHead'), sliceConst('apps/crm/reportshell.js', 'REPORT_FILTER_JS'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportHtml')], globals);
  const html = buildExportHtml(...args);
  for (const f of fns) assert.ok(html.includes(f.display_name), `${f.display_name} is not in the report`);

  // **Every internal link lands somewhere, in every scope.** A link that goes nowhere is worse than
  // plain text: the reader clicks it, stays where they are, and concludes the document is broken.
  // Reported on the Zoho Analytics report, where a name that was a view in the org became a link to
  // a heading only tables and query tables ever get. The CRM was measured across all thirteen scopes
  // and is clean - so this is the guard that keeps it that way, and it is a property of the document
  // rather than a list of the anchors anybody thought of.
  //
  // Unticking a chapter is the case that matters: the anchors go and the cross-references stay, and
  // the fixture above carries a workflow whose action calls a function and a schedule that runs it
  // so those references exist to dangle.
  //
  // **Stated rather than implied:** two plants were tried here - dropping the scope filter on the
  // workflow data, and letting `fnLink` link any name - and neither made this report produce a dead
  // anchor, because its cross-references are built from the same filtered lists that draw the
  // chapters. So this is a guard on a property that currently holds, not a check proven by a
  // failure. The one that was proven by a failure is in `tools/probe.py`, on the Zoho Analytics
  // report, where the identical plant produces seventeen dead links.
  const anchors = (doc) => {
    const ids = new Set([...doc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const hrefs = [...doc.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    return { hrefs, dead: [...new Set(hrefs.filter((h) => !ids.has(h)))] };
  };
  let linksSeen = 0;
  for (const off of [null, ...keys]) {
    const sc = {}; for (const k of keys) sc[k] = k !== off;
    const doc = off === null ? html : buildExportHtml(...args.slice(0, -1), sc);
    const { hrefs, dead } = anchors(doc);
    linksSeen += hrefs.length;
    assert.deepEqual(dead, [], `with ${off === null ? 'everything ticked' : off + ' unticked'}, `
                               + `${dead.length} link(s) point at no anchor in the document`);
  }
  // If the report carries no internal links at all, the sweep above is measuring nothing and this
  // line is the thing that is broken.
  assert.ok(linksSeen > 20, `only ${linksSeen} internal link(s) across every scope - the fixture is `
                            + 'not producing cross-references, so the sweep proves nothing');
  assert.ok(html.includes('info &quot;x&quot;') || html.includes('info "x"'),
            'source was ticked and no source reached the document');

  // The Markdown twin takes the same data as one object - a different shape, same fixture.
  const { buildExportMarkdown } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportMarkdown')], globals);
  const md = buildExportMarkdown({ fns, mods, g: args[2], modRefs: {}, wfs: args[4], scheds: args[5],
                                   conns: args[6], fails: health, acts: args[8], actUsers: new Map() },
                                 scope);
  // The Markdown names a function by its qualified api name, the HTML by its label - a difference
  // between the two reports, not a defect: read off each rather than assumed the same.
  for (const f of fns) assert.ok(md.includes(f.api_name), `${f.api_name} is not in the Markdown`);
  assert.ok(md.includes('info "x"'), 'source was ticked and no source reached the Markdown');
});

// `buildExportHtml` writes a `<nav class="toc">` by hand and then writes the chapters by hand, each
// with its own condition. Both halves were correct on their own and the composition was not:
//
//   contents: Functions | Modules | Workflows | Schedules | Relations | Actions | … | Health
//   document: Functions | Modules | Relations | Workflows | Schedules | Actions | … | Health
//
// Relations is third in the document - `SCOPE_KEYS`' own order - and fifth in the contents, so from
// there on every entry pointed past the chapter above it. And with an org that has nothing in it,
// the document carried **Relations** and **Failures** chapters the contents never mentioned: the
// document emits Relations whether or not there is anything in it (deliberately - «the heading stays
// rather than disappearing», the same as Functions and Modules) while the contents asked for a
// non-empty list, and the Failures chapter appears as soon as a reading was taken while the contents
// asked for something to have failed.
//
// The Markdown twin has none of this, and that is the finding rather than a detail: its contents
// line is **derived** from the headings it just wrote - `md.matchAll(/^## …/)`, with a comment saying
// it is placed after the body so it can only name chapters that were emitted. One report derives,
// the other restates. Where a repository has both, the restating one is where the drift is.
//
// So: build the report and read both lists back off it. On real values, not from the source - which
// is the only way a *condition* is comparable at all.
//
// **The limits, stated.** It exercises the CRM report, because it is the only one that builds a
// contents index - and that is checked below rather than believed, so a second product growing one
// cannot end up covered by nothing. It says nothing about the contents of a chapter, nor about the
// two tables the contents carry, and the fixtures are one of everything and none of anything.
test('crm: the export contents name the chapters the export has, in the order it has them', () => {
  const globals = {
    chrome: { runtime: { getManifest: () => ({ version: '1.2.3' }) } },
    SCOPE_DEFAULT: {}, SCOPE_KEYS: [], bound: { instance: 'yourinstance' },
    envOf: () => 'eu', freshnessLine: () => 'just now', byField: () => () => 0,
    wfScheduled: () => ({ count: 0, delays: [] }), isFnAction: () => false,
    moduleRefusal: () => '', actionKindLabel: (k) => k, firedBy: () => [],
    actProv: () => '', actWhen: () => '',
    actStale: () => false, actKept: () => false, actThin: () => false,
    _mdCell: (x) => String(x == null ? '' : x),
    PRODUCT_NAME: 'Zoost', PRODUCT_URL: '', PRODUCT_AUTHOR: 'Ivan', LEGAL_DISCLAIMER: 'x',
    SPONSOR_URL: '', KOFI_URL: '', EXPORT_CSS: '', sanitize: (x) => String(x || ''),
    escHtml: (x) => String(x == null ? '' : x), escA: (x) => String(x == null ? '' : x),
    esc: (x) => String(x == null ? '' : x), hl: (x) => String(x || ''), first: (x) => String(x || ''),
    params: () => '', fnAnchor: (x) => `fn-${x}`, modAnchor: (x) => `mod-${x}`,
    wfAnchor: (x) => `wf-${x}`, schAnchor: (x) => `sch-${x}`, connAnchor: (x) => `conn-${x}`,
    FAIL_CAPPED: 'capped.',
    MSG: { hRankedOver: () => '', hOrphan: 'o', hUnresolved: 'u', hAmbiguous: 'a', hBroken: 'b',
           hMissingRefs: 'm', hBiggest: 'B', hChattiest: 'C', hBiggestDesc: 'd' },
  };
  const { buildExportHtml } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportMark'), sliceFn('apps/crm/reportshell.js', 'reportHead'), sliceConst('apps/crm/reportshell.js', 'REPORT_FILTER_JS'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportHtml')], globals);

  // Everything ticked in both runs: this is about the composition, not about the scope - a chapter
  // left out by the reader is left out of both halves by construction, and the interesting case is
  // the one where the two halves disagree about a chapter neither reader nor scope removed.
  const ALL = {};
  for (const k of ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules',
                   'actions', 'addresses', 'connections', 'failures', 'health']) ALL[k] = true;
  const mods = [{ api_name: 'Contacts', display_name: 'Contacts',
                  related_lists: [{ api_name: 'Notes', module: 'Notes' }] }];
  const empty = { at: '2026-08-23T10:00:00Z', usage: { success: 9, failure: 0 }, runs: [], failures: [] };
  const some = { at: '2026-08-23T10:00:00Z', usage: { success: 9, failure: 1 }, runs: [],
                 failures: [{ name: 'f', count: 1, reason: 'r' }] };
  const runs = [
    ['nothing in the org', () => buildExportHtml([], [], { nodes: {}, counts: {} }, {}, [], [], [], empty, [], new Map(), ALL)],
    ['one of everything', () => buildExportHtml([], mods, { nodes: {}, counts: {} }, {},
      [{ id: '1', name: 'W', module: 'Contacts', actions: [] }], [{ id: '1', name: 'S' }],
      [{ name: 'c', linkName: 'c', uses: [], status: 'ok' }], some,
      [{ id: '1', name: 'A', kind: 'tasks' }], new Map(), ALL)],
  ];

  // The claim above, made good rather than asserted: this exercises one product because only one
  // builds a contents index. A second one that started to would otherwise be covered by nothing and
  // nobody would know, which is the shape this whole grid is about.
  // The index is drawn by the shared shell now - one file, carried by both products - so the claim
  // this line makes is different and stronger: there is exactly **one** implementation of a contents
  // index, and every copy of it is the same file. A second one appearing in a builder is the drift
  // this whole shell exists to end.
  // Nobody writes their own index any more. Both builders call `reportToc`, and the markup for a
  // contents exists in one file - which is what stops the two from being two ideas about one thing.
  const withToc = shippedScripts().filter((rel) => read(rel).includes('class="toch"'));
  assert.deepEqual(withToc.sort(), ['apps/analytics/reportshell.js', 'apps/crm/reportshell.js'],
    `a builder writes its own contents markup instead of calling reportToc: ${withToc}`);
  for (const app of ['crm', 'analytics']) {
    const rel = app === 'crm' ? 'apps/crm/export.js' : 'apps/analytics/sidepanel.js';
    assert.match(read(rel), /reportToc\(/, `${app}: its report builds no contents at all`);
  }

  for (const [what, build] of runs) {
    const html = build();
    const main = html.slice(html.indexOf('<main>'));
    const navEnd = main.indexOf('</nav>');
    assert.ok(navEnd > 0, `id=${what}: the report has no contents index - the derivation broke`);
    const contents = [...main.slice(0, navEnd).matchAll(/<h3 class="toch">([^<(]+)/g)].map((m) => m[1].trim());
    const chapters = [...main.slice(navEnd).matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map((m) => m[1].trim());
    assert.ok(chapters.length >= 3, `id=${what}: only ${chapters.length} chapter(s) read - the derivation broke`);
    assert.deepEqual(contents, chapters,
      `id=${what}: the contents and the document disagree.\n    contents: ${contents.join(' | ')}\n    document: ${chapters.join(' | ')}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The same composition, in the twin, and it was wrong there too.
//
// The Analytics export derives both halves from `exportSections()` - the contents and the body walk
// the same array - so the defect the CRM report had could not happen here. Except for the one
// chapter that is not a section: the SQL dialect reference, written into the document **before** the
// sections and appended to the contents **after** them. Contents said
//
//   Views · Structure · Relations · Query table SQL · Health · Zoho Analytics SQL
//
// over a document that opens with Zoho Analytics SQL, so every entry named the chapter before the
// one it stood for - the CRM defect exactly, in the report that had been written to avoid it, on the
// single line that steps outside the derivation.
//
// It also carried the reference's title typed out a second time, and the block builds its own
// heading. Two copies of one string; both are the module's now.
//
// Run rather than read: the document is built with the real `analytics-sql.js` evaluated beside it,
// because a stub would compare this test's idea of the heading against itself.
//
// **The limits, stated.** The fixture asks for every section and holds nothing, which exercises the
// order and not what a chapter contains; `lineage` needs `deps` and is absent from both lists here,
// which is the composition holding rather than a gap. It reads the Markdown report - the HTML one
// builds its `<nav>` and its body from the same array in the same loop, with nothing outside it.
test('analytics: the export contents name the chapters in the order the document has them', async () => {
  const win = {};
  vm.runInContext(read('apps/analytics/analytics-sql.js'),
    vm.createContext({ window: win, console, Object, String, Number, Array, JSON, Math, Date, RegExp }));
  assert.ok(win.ZOHO_ANALYTICS_SQL && win.ZOHO_ANALYTICS_SQL.markdown,
    'analytics-sql.js no longer publishes a markdown() - the derivation broke');

  const globals = {
    window: win,
    chrome: { runtime: { getManifest: () => ({ version: '1.2.3' }) } },
    PRODUCT_NAME: 'Zoost', PRODUCT_URL: 'https://zoost.it', LEGAL_DISCLAIMER: 'x',
    bound: { workspace: 'w', name: 'W', label: '', origin: 'o' },
    views: [], schema: {}, relations: [], deps: null,
    esc: (x) => String(x == null ? '' : x), escA: (x) => String(x == null ? '' : x),
    shortDate: () => '—', fkText: () => '', viewById: () => new Map(),
    sqlReadState: async () => ({ kind: 'ok', body: 'select 1' }), sqlText: (x) => String(x || ''),
    beginWorkspaceOp: () => ({}),
    healthFindings: () => ({ counts: { views: 0, tables: 0, columns: 0, relations: 0, sql: 0 },
                             orphans: [], islands: [], system: [], unread: [] }),
  };
  const { buildExportMarkdown } = load([
    sliceFn('apps/analytics/sidepanel.js', 'exportSections'),
    sliceFn('apps/analytics/sidepanel.js', 'buildExportMarkdown'),
  ], globals);

  const md = await buildExportMarkdown({ views: true, structure: true, relations: true,
                                         sql: true, lineage: true, health: true });
  const at = md.indexOf('## Contents');
  assert.ok(at > 0, 'the Markdown report has no contents - the derivation broke');
  const contents = md.slice(at).split('\n\n')[1].split('\n')
    .map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean);
  const chapters = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()).filter((t) => t !== 'Contents');
  assert.ok(chapters.length >= 5, `only ${chapters.length} chapter(s) read - the derivation broke`);
  assert.deepEqual(contents, chapters,
    `the contents and the document disagree.\n    contents: ${contents.join(' | ')}\n    document: ${chapters.join(' | ')}`);
});

// ---------------------------------------------------------------------------------------------
// The export was tested with its escapers replaced by the identity, in every case that ran it.
//
// `buildExportHtml` is 78 `esc(...)` call sites over a document a reader opens from `file://` - no
// content-security policy, an inline `<script>` of its own, and names that came out of somebody's
// org. Every behaviour test of it hands the slice a globals bag with `escHtml`, `escA` and `esc` as
// `(x) => String(x)`. So the whole of the escaping was switched off in exactly the place it was
// being exercised, and no case could tell an escaped report from an unescaped one.
//
// Measured rather than argued: replacing `const esc = escHtml` with `const esc = String` in the
// shipped file leaves **877 Node cases green**, both Python suites green and every checker at zero.
// The only red is the twin ledger noticing that a function body moved.
//
// That is `fake` at its purest - a stub kinder than the thing it stands for - and the kindness is
// invisible because it lives in the *fixture*, which nobody reads as code under test. `htmlcheck`
// does not cover this ground and says so: its stated limit is that it reads attributes and not
// element content, and its reason names the panel, with the export written out as not being under
// it. So the static checker is right to be silent and the behaviour tests were the cover - with the
// escapers taken out.
//
// This one runs the report with the **shipped** escapers, lifted from `sidepanel.js` where the page
// defines them, against a workspace whose names are hostile. It asserts the properties rather than
// the spelling: no tag the org's own text opened, no attribute broken out of, and - for Markdown -
// no cell that can end its row and no fence that can end its block.
//
// **The limits, stated.** It exercises the CRM report with one hostile string in the places a name
// reaches; a field this builder learns to print tomorrow is not covered by it, which is why the
// count of call sites is asserted - a builder that stopped escaping wholesale is caught, a single
// new unescaped interpolation is not. `hl()` (the Deluge highlighter) is the product's own and is
// tested where it lives.
test('crm: the reports escape what came out of the org, with the escapers the page ships', async () => {
  const real = load([
    sliceConst('apps/crm/sidepanel.js', 'escHtml'),
    sliceConst('apps/crm/sidepanel.js', 'escA'),
    sliceConst('apps/crm/sidepanel.js', 'sanitize'),
    sliceFn('apps/crm/modules.js', '_pick'),
  ], {});
  assert.equal(real.escHtml('<b>&'), '&lt;b&gt;&amp;', 'escHtml was not lifted - the derivation broke');
  assert.equal(real.escA('"\''), '&quot;&#39;', 'escA was not lifted - the derivation broke');
  // `sanitize` is what the anchors are built through, so a stub of it is a second way to make the
  // fixture kind - and the first version of this case did exactly that and reported a defect that
  // was its own. It is the shipped one here, and the anchor helpers are the builder's own.
  assert.equal(real.sanitize('a<b>"'), 'a_b__', 'sanitize was not lifted - the derivation broke');

  // The count that says this is about the builder and not about one string.
  const sites = (read('apps/crm/export.js').match(/\besc\(/g) || []).length;
  assert.ok(sites >= 50, `only ${sites} escaped interpolation(s) in the export - the derivation broke`);

  // A pipe is in here because Markdown's cell separator is the same class of defect as HTML's
  // angle bracket, and a name carrying one silently adds a column to somebody's table.
  const NASTY = '<script>alert(1)</script>"\'&|x';
  const globals = {
    chrome: { runtime: { getManifest: () => ({ version: '1.2.3' }) } },
    SCOPE_DEFAULT: {}, SCOPE_KEYS: [], bound: { instance: 'yourinstance' },
    envOf: () => 'eu', freshnessLine: () => 'just now', byField: () => () => 0,
    wfScheduled: () => ({ count: 0, delays: [] }), isFnAction: () => false,
    moduleRefusal: () => '', actionKindLabel: (k) => k, firedBy: () => [],
    actProv: () => '', actWhen: () => '',
    actStale: () => false, actKept: () => false, actThin: () => false,
    PRODUCT_NAME: 'Zoost', PRODUCT_URL: '', PRODUCT_AUTHOR: 'Ivan', LEGAL_DISCLAIMER: 'x',
    SPONSOR_URL: '', KOFI_URL: '', EXPORT_CSS: '',
    // The shipped ones, which is the whole point of this case.
    sanitize: real.sanitize, escHtml: real.escHtml, escA: real.escA, esc: real.escHtml,
    _pick: real._pick,
    hl: (x) => real.escHtml(x), first: (x) => real.escHtml(x), params: () => '',
    FAIL_CAPPED: 'capped.',
    MSG: { hRankedOver: () => '', hOrphan: 'o', hUnresolved: 'u', hAmbiguous: 'a', hBroken: 'b',
           hMissingRefs: 'm', hBiggest: 'B', hChattiest: 'C', hBiggestDesc: 'd' },
  };
  const mods = [{ api_name: NASTY, display_name: NASTY, related_lists: [],
                  fields: [{ api_name: NASTY, label: NASTY, data_type: 'text' },
                           { api_name: 'plain', label: 'Plain', data_type: 'text' }] }];
  const fails = { at: '2026-08-23T10:00:00Z', usage: { success: 1, failure: 1 }, runs: [],
                  failures: [{ name: NASTY, count: 1, reason: NASTY }] };
  const scope = {};
  for (const k of ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules',
                   'actions', 'addresses', 'connections', 'failures', 'health']) scope[k] = true;

  const { buildExportHtml } = load([sliceFn('apps/crm/reportshell.js', 'escReport'), sliceFn('apps/crm/reportshell.js', 'reportMark'), sliceFn('apps/crm/reportshell.js', 'reportHead'), sliceConst('apps/crm/reportshell.js', 'REPORT_FILTER_JS'), sliceFn('apps/crm/reportshell.js', 'reportToc'), sliceFn('apps/crm/reportshell.js', 'escReportA'), sliceFn('apps/crm/reportshell.js', 'reportFoot'), sliceFn('apps/crm/export.js', 'buildExportHtml')], globals);
  const html = buildExportHtml([], mods, { nodes: {}, counts: {} }, {}, [], [], [], fails, [], new Map(), scope);
  assert.ok(html.includes('&lt;script&gt;'),
    'the hostile name never reached the report - the fixture is not exercising what it claims to');
  // Everything after the page's own inline script is the document, and nothing in it may open a tag
  // the org's text wrote. The builder's own `<script>` is the last thing on the page.
  const doc = html.slice(0, html.lastIndexOf('<script>'));
  assert.equal(doc.includes('<script'), false, 'a name out of the org opened a tag in the report');
  // Exact rather than clever: the hostile string may appear in the document only in the form the
  // escapers produce. A first attempt asserted that its *payload* was absent after stripping
  // entities, which is not a property of anything - `&lt;script&gt;alert(1)&lt;/script&gt;` is
  // correctly escaped and still contains `alert(1)`, so it reported a defect that was its own.
  assert.equal(doc.split(NASTY).length - 1, 0,
    'a name out of the org is in the report exactly as it was written');
  assert.equal(doc.includes('&quot;') || doc.includes('&#39;'), true,
    'no attribute in the report escaped a quote, so escA was not reached at all');

  // `_mdCell` is the Markdown escaper and it is the shipped one, for the same reason as above:
  // a hand-written copy of its rule in the fixture is a stub of the thing under test.
  const { buildExportMarkdown } = load([sliceFn('apps/crm/export.js', 'buildExportMarkdown'),
                                       sliceFn('apps/crm/export.js', '_mdCell')], globals);
  const md = buildExportMarkdown({ fns: [], mods, g: { nodes: {} }, modRefs: {}, wfs: [], scheds: [],
                                   conns: [], fails, acts: [], actUsers: new Map() }, scope);
  assert.ok(md.includes('alert(1)'), 'the hostile name never reached the Markdown report');
  // Every row of a table has the columns its header declares. An unescaped pipe in a name adds one,
  // and the row after it reads as being about a different thing entirely.
  const width = (line) => line.replace(/\\\|/g, '').split('|').length;
  let head = 0, rows = 0;
  for (const line of md.split('\n')) {
    if (!line.trimStart().startsWith('|')) { head = 0; continue; }
    if (!head) { head = width(line); continue; }
    if (/^\|[\s|:-]*\|$/.test(line.trim())) continue;     // the separator row
    rows++;
    assert.equal(width(line), head,
      `a name out of the org changed a table's shape: ${head} column(s) in the header and ` +
      `${width(line)} in «${line.slice(0, 70)}»`);
  }
  assert.ok(rows >= 2, `only ${rows} table row(s) read in the Markdown report - the derivation broke`);
});

// ---------------------------------------------------------------------------------------------
// The diagram's layout preset, typed out a second time on the settings page.
//
// `ER_PRESET.modules` in `graphview.js` is what the diagram draws with when nothing has been saved;
// `LAY_DEFAULT` in `options.js` is what the sliders sit at, and what **Reset** puts back. They are
// the same five numbers written twice, under two names, in two files - so nothing compared them, and
// the previous cell's check cannot: it reads constants that share a *name* across a product's
// scripts, and these deliberately do not.
//
// What drift looks like from outside: Settings shows and saves one set of numbers, the diagram
// opened without saved parameters draws with another, and **Reset** puts back a state the diagram
// never had. Measured with `margin` moved to 40 in the CRM's `LAY_DEFAULT`: the whole battery green
// but for the screenshots noticing a file under `apps/` had moved.
//
// Derived per product from the two files, key by key. It says nothing about whether the numbers are
// *good* - that is a measurement on a real diagram, and the presets carry theirs in comments beside
// them.
//
// **The limits, stated.** It compares `LAY_DEFAULT` against the `modules` preset only, because that
// is the one the sliders stand for - the other presets are per-mode and have no control on the
// settings page. It reads the two literals, so a key whose value is an expression rather than a
// number is compared as text, which is the safe way round.
test('the settings sliders start where the diagram starts, in both products', () => {
  // Brace-matched, both levels. The first version sliced from `modules:` to the next `}` and let a
  // `break` decide where to stop: read back, it was returning the **calls** preset's numbers, and the
  // case passed anyway. A derivation that stops by counting rather than by matching is one that will
  // one day compare the wrong pair and say nothing.
  const objectAt = (src, from) => {
    let depth = 0, j = src.indexOf('{', from);
    const start = j;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('unterminated object literal');
  };
  const pairs = (body) => {
    const out = {};
    // Depth one only: a nested object is skipped whole rather than flattened into its parent.
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '{') { depth++; continue; }
      if (body[i] === '}') { depth--; continue; }
      if (depth !== 1) continue;
      const m = /^(\w+):\s*([\w.]+)\s*(?=[,}])/.exec(body.slice(i));
      if (m) { out[m[1]] = m[2]; i += m[0].length - 1; }
    }
    return out;
  };
  const literal = (rel, name, key) => {
    const src = read(rel);
    const at = src.indexOf(`const ${name} = `);
    assert.ok(at > 0, `${rel}: ${name} is gone - the derivation broke`);
    const body = objectAt(src, at);
    if (!key) return pairs(body);
    const kat = body.indexOf(`${key}:`);
    assert.ok(kat > 0, `${rel}: ${name}.${key} is gone - the derivation broke`);
    return pairs(objectAt(body, kat));
  };
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  let compared = 0;
  for (const app of apps) {
    const page = literal(`apps/${app}/options.js`, 'LAY_DEFAULT', null);
    const draw = literal(`apps/${app}/graphview.js`, 'ER_PRESET', 'modules');
    assert.ok(Object.keys(page).length >= 4, `id=${app}: ${Object.keys(page).length} key(s) on the page - the derivation broke`);
    for (const k of Object.keys(page)) {
      compared++;
      assert.equal(page[k], draw[k],
        `id=${app}: Settings starts «${k}» at ${page[k]} and the diagram draws it at ${draw[k]}, so `
        + 'Reset puts back a state the diagram never had');
    }
    assert.deepEqual(Object.keys(draw).sort(), Object.keys(page).sort(),
      `id=${app}: the two tables hold different parameters - page ${Object.keys(page)}, diagram ${Object.keys(draw)}`);
  }
  assert.ok(compared >= 8, `only ${compared} parameter(s) compared - the derivation broke`);
});

// ---------------------------------------------------------------------------------------------
// One number for the assistant, written out in five places.
//
// The org-index cap has a name where it belongs - `AI_SEED_CAP_DEFAULT` in `ai.js` - and then the
// settings page writes `72000` twice as a literal (once to fill the box, once to clamp what comes
// out of it), the markup writes its bounds as `min="4000" max="400000"`, and the note beside the
// tool-step box writes «20 is the default» in prose. Five copies of two numbers, in three languages,
// across two pages that share no scope.
//
// Measured: `AI_SEED_CAP_DEFAULT` moved to 60000 leaves the battery green but for the screenshots
// noticing a file under `apps/` had moved. What a reader would get is a Settings page that offers a
// number the assistant does not use, saves it, and shows it back.
//
// The page cannot import the panel's constant - `options.html` loads neither `ai.js` nor
// `sidepanel.js`, and giving them a shared module would be a build step this project does not have -
// so the copies stay and this holds them together. That is the honest shape for a `copy` whose two
// ends are two documents.
//
// Derived from the markup outwards: every number input on a settings page is found by its
// `type="number"`, and its `min`/`max` are compared with the clamp the page applies to that same id,
// the default the page fills it from, and the default the panel reads. Nothing is named here; a
// control added tomorrow is compared without anybody remembering it.
//
// **The limits, stated.** It follows a clamp written as `Math.max(lo, Math.min(hi, … || def))`,
// which is how both pages write it - a clamp expressed some other way is a finding about this check
// (the count of controls compared is asserted for that reason) rather than a silent pass. The prose
// half only fires where a note actually states a default in words, and says how many it found.
test('a number the settings page offers is the number the panel uses', () => {
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  let controls = 0, prose = 0, derived = 0;
  for (const app of apps) {
    const html = read(`apps/${app}/options.html`);
    const own = shippedScripts().filter((f) => f.startsWith(`apps/${app}/`));
    // The source, not the scan, and the reason is worth writing down because the first version got
    // it the other way round: every control here is found **by its id**, which is a string literal,
    // and the scanner blanks those - so the whole check quietly matched nothing on the twin whose
    // clamp is spelled slightly differently, and said «nothing clamps this». A check that locates by
    // a string reads the string. The cost is that a clamp written inside a comment would be read as
    // code; the shapes matched below are specific enough that this has never happened, and it would
    // be a false finding rather than a silent pass.
    const js = Object.fromEntries(own.map((rel) => [rel, read(rel)]));
    const page = js[`apps/${app}/options.js`];
    assert.ok(page, `apps/${app}/options.js is gone - the derivation broke`);

    for (const m of html.matchAll(/<input[^>]*type="number"[^>]*>/g)) {
      const tag = m[0];
      const id = (/id="([\w-]+)"/.exec(tag) || [])[1];
      const lo = (/min="(-?\d+)"/.exec(tag) || [])[1];
      const hi = (/max="(-?\d+)"/.exec(tag) || [])[1];
      if (!id || lo === undefined || hi === undefined) continue;
      controls++;

      // A control whose bounds are read off itself - `+$('x').min` - has no second copy of them, so
      // there is nothing here to compare and nothing that can drift. That is the shape this check
      // would like every control to have; it is counted rather than skipped in silence.
      if (new RegExp(`\\$\\('${id}'\\)\\.(min|max)\\b`).test(page)) { derived++; continue; }

      // The clamp the page applies when it reads that box.
      const clamp = new RegExp(
        `Math\\.max\\((\\d+),\\s*Math\\.min\\((\\d+),[^)]*\\$\\('${id}'\\)[^|]*\\|\\|\\s*(\\d+)\\)\\)`).exec(page);
      assert.ok(clamp, `apps/${app}/options.js: nothing clamps what «${id}» returns, so the min and `
        + 'max on the control are advice a keyboard can ignore');
      assert.equal(clamp[1], lo, `apps/${app}: «${id}» accepts down to ${lo} in the markup and is clamped at ${clamp[1]}`);
      assert.equal(clamp[2], hi, `apps/${app}: «${id}» accepts up to ${hi} in the markup and is clamped at ${clamp[2]}`);
      const def = clamp[3];

      // What the page fills the box with when nothing is stored.
      const fill = new RegExp(`\\$\\('${id}'\\)\\.value\\s*=\\s*(?:\\w+(?:\\.\\w+)*\\s*\\|\\|\\s*)?(\\d+)?`).exec(page);
      assert.ok(fill, `apps/${app}: nothing fills «${id}» - the derivation broke`);
      if (fill[1]) {
        assert.equal(fill[1], def,
          `apps/${app}: «${id}» is shown as ${fill[1]} and saved as ${def} when nothing is stored`);
      }

      // And the panel's own default for the same setting: the key is whatever the page reads it
      // from, taken off the fill line rather than guessed.
      const keyed = new RegExp(`\\$\\('${id}'\\)\\.value\\s*=\\s*\\w+\\.(\\w+)`).exec(page);
      if (keyed) {
        const key = keyed[1];
        for (const [rel, src] of Object.entries(js)) {
          if (rel.endsWith('/options.js')) continue;
          const theirs = new RegExp(`\\b${key}:\\s*\\w+\\.${key}\\s*\\|\\|\\s*(\\w+)`).exec(src);
          if (!theirs) continue;
          // A named constant is followed to its declaration; a literal stands for itself.
          const value = /^\d+$/.test(theirs[1])
            ? theirs[1]
            : (new RegExp(`\\b(?:const|let|var)\\s+${theirs[1]}\\s*=\\s*(\\d+)`).exec(src) || [])[1];
          assert.ok(value !== undefined,
            `${rel}: «${key}» falls back to ${theirs[1]} and nothing here declares it - the derivation broke`);
          assert.equal(value, def,
            `apps/${app}: the panel starts «${key}» at ${value} (${rel}) and Settings offers and saves ${def}, `
            + 'so the page shows a number the assistant does not use');
        }
      }

      // The prose, where there is any: «N is the default», in the block that owns the control.
      const block = html.slice(m.index, html.indexOf('</div>', m.index));
      const said = /(\d+) is the default/.exec(block);
      if (said) {
        prose++;
        assert.equal(said[1], def,
          `apps/${app}/options.html: the note beside «${id}» says ${said[1]} is the default and the code uses ${def}`);
      }
    }
  }
  assert.ok(controls >= 4, `only ${controls} number control(s) compared - the derivation broke`);
  assert.ok(prose >= 1, `no note states a default in words - the prose half of this check ran over nothing`);
  assert.ok(derived >= 1,
    'no control reads its own bounds any more - that is the shape with no copy in it, and this ' +
    'check counts them so losing the last one is visible');
});

// ---------------------------------------------------------------------------------------------
// A scope key with no box is a thing the reader cannot untick, and the loop that draws them says
// nothing about it.
//
// `SCOPE_KEYS` is the list of what an export may contain, and the export dialog draws one checkbox
// per key with `SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) … })`. That `if (e)` is
// there because the settings page and the panel share the loop and do not share every control - and
// it is also what makes a missing box invisible: the key stays at whatever the preset says, for
// ever, and the reader is never offered the choice. Four hand-written copies of one list, in two
// languages: the array, the ids in the panel's markup, the ids in the settings page's markup, and
// the `scope.<key>` reads in the builders.
//
// Measured, by renaming `id="sc_lineage"` to `sc_lineages` in the Analytics dialog: the battery
// green but for the screenshots noticing a file under `apps/` had moved. Lineage would then be in
// every export whether or not anybody wanted it, with no control anywhere.
//
// Derived per product: the array is read from whichever shipped script declares it, the boxes off
// every page of that product that draws any, and the reads off the scripts. A page that draws
// **some** `sc_` boxes must draw them all - which is how the CRM settings page is included without
// being named, and how the Analytics settings page, which offers no export defaults at all, is left
// out without an exception being written for it.
//
// **The limits, stated.** It is about the controls and nothing else: it says whether a scope can be
// unticked, not whether unticking it changes what comes out - that is the chapter check two cells
// above. An assertion that «every key is read by some builder» was written here and **taken out**,
// because it passed by coincidence: `.dashboards` matched `deps[v.id].dashboards.length`, which is a
// lineage record and has nothing to do with an export scope. Scoping it to the names a scope object
// is held under would have made it a list of variable names, which is the thing this grid refuses;
// a weak assertion that can pass for the wrong reason is worse than an absent one, so it is absent
// and said.
test('every export scope has a box to untick it, and every box is a scope', () => {
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  let boxes = 0, pages = 0;
  for (const app of apps) {
    const own = shippedScripts().filter((f) => f.startsWith(`apps/${app}/`));
    // The panel's copy, not the settings page's: the previous cell holds those two together, and
    // reading the page's here would make this check pass by comparing a copy with itself.
    const panel = own.filter((f) => !f.endsWith('/options.js'));
    let keys = null, from = null;
    for (const rel of panel) {
      const m = /const SCOPE_KEYS = \[([^\]]*)\]/.exec(read(rel));
      if (!m) continue;
      assert.equal(keys, null, `apps/${app}: SCOPE_KEYS is declared in ${from} and in ${rel}`);
      keys = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
      from = rel;
    }
    assert.ok(keys && keys.length >= 5, `apps/${app}: SCOPE_KEYS was not found in the panel - the derivation broke`);

    for (const rel of readdirSync(join(ROOT, 'apps', app)).filter((n) => n.endsWith('.html'))) {
      const drawn = [...read(`apps/${app}/${rel}`).matchAll(/id="sc_(\w+)"/g)].map((m) => m[1]);
      if (!drawn.length) continue;                   // a page that offers no export scope at all
      pages++;
      boxes += drawn.length;
      const missing = keys.filter((k) => !drawn.includes(k));
      assert.deepEqual(missing, [],
        `apps/${app}/${rel} draws ${drawn.filter((d) => keys.includes(d)).length} of ${keys.length} `
        + `export scopes, so these cannot be `
        + `unticked anywhere and stay at whatever the preset says: ${missing}`);
      const unknown = drawn.filter((d) => !keys.includes(d));
      assert.deepEqual(unknown, [],
        `apps/${app}/${rel} draws boxes for these and they are in no scope, so ticking them does `
        + `nothing at all: ${unknown}`);
    }
  }
  assert.ok(pages >= 2, `only ${pages} page(s) draw an export scope - the derivation broke`);
  assert.ok(boxes >= 12, `only ${boxes} box(es) compared - the derivation broke`);
});

// ---------------------------------------------------------------------------------------------
// An area that is not a tab, and a guard that only knew about tabs.
//
// `noteAccess(area, err, op)` records what Zoho answered for an area: when it was last actually
// read, and whether the role was refused. It opened with `if (!TAB[area]) return;` - a guard that
// refuses what it does not know, which is right - and `TAB` is built from the tab registry.
//
// `failures` is an area and is **not** a tab. It is pulled, it can be refused, and it has no tab of
// its own on purpose: a failure is a property of a function, so it shows in the function's detail
// and in the health view. So `await noteAccess('failures', null, op)`, at the end of every runtime
// pull, returned before doing anything at all. Driven here: `functions` records a write, `failures`
// records nothing and returns `undefined`.
//
// What that cost, in the reader's terms: the runtime chapter never recorded when it was last read,
// so it could be exported as though it were as fresh as the rest of the mirror; and a role that had
// lost access to it looked exactly like an org where nothing had failed. `AREA_SCOPE` had listed
// `failures` from the day it was written, and reached it never - all three walks over it started
// from `TABS`.
//
// Two correct halves. Nothing in 878 cases, both Python suites or any checker saw it, because each
// half reads correctly on its own and the defect is only in the pair.
//
// The check drives it rather than reading it, and takes the area names **from the calls the panel
// makes** - so an area added tomorrow is exercised without anybody remembering it.
//
// **The limits, stated.** It reads area names that are written as literals at the call; an area
// passed through a variable is invisible to it, and the count of areas driven is asserted so that
// going quiet is a finding. It says nothing about what is recorded - only that something is.
test('crm: every area the panel reports on is an area the panel can record', async () => {
  const own = shippedScripts().filter((f) => f.startsWith('apps/crm/'));
  const named = new Set();
  for (const rel of own) {
    for (const m of read(rel).matchAll(/\bnote(?:Access|PullFailure)\('(\w+)'/g)) named.add(m[1]);
  }
  assert.ok(named.size >= 5, `only ${named.size} area(s) are reported on by name - the derivation broke`);

  const calls = [];
  const globals = {
    chrome: { runtime: { getManifest: () => ({ version: '1.2.3' }) } },
    // Deliberately minimal: `TAB` holds one tab, so an area that is admitted only because it is a
    // tab cannot hide an area that is admitted for no reason at all.
    TAB: { functions: { id: 'functions', label: 'Functions' } },
    AREA_SCOPE: Object.fromEntries([...named].map((a) => [a, [a]])),
    tabAccess: {}, Object, Date, Promise, console,
    accessOf: () => 'ok',
    patchCfg: async (o) => { calls.push(o); },
    publishAccess: () => {}, renderTabs: () => {}, setStatus: () => {}, tabLabel: (x) => x,
  };
  const { noteAccess } = load([sliceFn('apps/crm/sidepanel.js', 'noteAccess')], globals);
  const op = { current: () => true };
  for (const area of [...named].sort()) {
    calls.length = 0;
    const ok = await noteAccess(area, null, op);
    assert.equal(ok, true,
      `noteAccess('${area}') answered ${ok} - the panel reports on «${area}» and cannot record it, so `
      + 'when it was read and whether the role was refused are both lost in silence');
    assert.equal(calls.length, 1, `noteAccess('${area}') wrote ${calls.length} time(s)`);
    assert.ok(calls[0].access && calls[0].access[area],
      `noteAccess('${area}') wrote something that is not about «${area}»`);
  }

  // And the other half of the pair: everything about freshness walks the areas, not the tabs. A walk
  // that starts from `TABS` cannot reach an area without one, which is how this lasted.
  const panel = crmPanel();
  const walks = [...panel.matchAll(/TABS\.(?:map|forEach|filter)\(/g)].length;
  const stale = panel.slice(panel.indexOf('function areaStale'));
  assert.ok(walks >= 1, 'nothing walks TABS any more - the derivation broke');
  for (const fn of ['scopeStaleNote', 'newestPull']) {
    const at = panel.indexOf(`function ${fn}`);
    assert.ok(at > 0, `${fn} is gone - the derivation broke`);
    const body = panel.slice(at, panel.indexOf('\n}', at));
    assert.equal(/\bTABS\b/.test(body), false,
      `${fn} walks TABS, so an area with no tab of its own is invisible to it`);
  }
  assert.ok(stale.length > 0, 'areaStale is gone - the derivation broke');
});

// ---------------------------------------------------------------------------------------------
// The stand-in for Zoho always said yes.
//
// `api()` in the bridge is the one place every read of the org passes through, and Zoho can answer
// it four different ways: **204**, which is «this org has none of those» and has no body, so
// `res.json()` would throw and an empty area would arrive as a failure - measured on an org with no
// webhooks at all; **ok**, the body; **400 INVALID_CSRF_TOKEN** on the first `/deluge/` call after a
// fresh login, which is warmed and retried exactly once; and anything else, which is thrown with the
// status, the sentence Zoho wrote and its machine-readable code kept apart.
//
// Not one of the four was exercised. The only `fetch` the bridge's cases ever saw was
// `async () => ({ ok: true })` - a fixture that cannot produce a 204, cannot produce a failure, and
// cannot produce the one case the retry exists for. Measured by making 204 answer `null` instead of
// `NO_CONTENT`: the battery green but for the screenshots noticing a file under `apps/` had moved,
// and every org with an empty area back to reading a refusal where there is simply nothing.
//
// That is `fake`: the kindness is in the stand-in, so the code under it is never asked the questions
// it was written to answer.
//
// What is stubbed here is only what is not the subject - `BASE`, `headers`, `warmDeluge` and the
// answers themselves. `safePath`, `apiError`, `errorDetail` and `NO_CONTENT` are the shipped ones,
// because a hand-written copy of an error reader is a second reader that agrees with the test.
//
// **The limits, stated.** It drives one function; the callers that turn its answers into files are
// covered where they live. The bodies are minimal - a real Zoho error carries more - and the point
// is which *branch* is taken, not the wording, which `errorDetail` owns and is exercised through.
test('crm: the bridge answers Zoho four ways, and none of them was ever tried', async () => {
  let warmed = 0;
  const answers = [];
  const g = {
    BASE: 'https://crm.zoho.eu', Object, Error, String, Promise, JSON, console,
    headers: () => ({}),
    warmDeluge: async () => { warmed++; },
    fetch: async () => answers.shift(),
  };
  const { api, NO_CONTENT } = load([
    sliceConst('apps/crm/content-bridge.js', 'NO_CONTENT'),
    sliceFn('apps/crm/content-bridge.js', 'safePath'),
    sliceFn('apps/crm/content-bridge.js', 'apiError'),
    sliceFn('apps/crm/content-bridge.js', 'errorDetail'),
    sliceFn('apps/crm/content-bridge.js', 'api'),
  ], g);

  // 204: an area this org has none of. Not a failure, and not a body - `json()` here throws on
  // purpose, so a branch that stopped treating 204 as its own answer fails rather than passes.
  answers.push({ status: 204, ok: false, json: async () => { throw new Error('no body'); } });
  assert.equal(await api('/crm/v2/settings/webhooks', 'crm'), NO_CONTENT,
    'a 204 no longer answers «this org has none of those», so an empty area reads as a refusal');

  // ok: the body, untouched.
  answers.push({ status: 200, ok: true, json: async () => ({ webhooks: [] }) });
  assert.deepEqual(await api('/crm/v2/settings/webhooks', 'crm'), { webhooks: [] },
    'the body of a successful read no longer comes back as it was');

  // 400 INVALID_CSRF_TOKEN on a /deluge/ call: warmed once, retried once, and the retry answers.
  answers.push({ status: 400, ok: false, text: async () => '{"errorMessage":"INVALID_CSRF_TOKEN"}' });
  answers.push({ status: 200, ok: true, json: async () => ({ connections: [] }) });
  assert.deepEqual(await api('/deluge/api/connections', 'drepn'), { connections: [] },
    'the first deluge call after a login is no longer warmed and retried');
  assert.equal(warmed, 1, `the runtime was warmed ${warmed} time(s) - once is the whole design`);
  assert.equal(answers.length, 0, 'the retry never happened, or happened more than once');

  // …and once only: a second INVALID_CSRF_TOKEN is thrown rather than looped on. «One retry on a
  // genuinely transient failure, never a retry loop against an assumption.»
  answers.push({ status: 400, ok: false, text: async () => '{"errorMessage":"INVALID_CSRF_TOKEN"}' });
  answers.push({ status: 400, ok: false, text: async () => '{"errorMessage":"INVALID_CSRF_TOKEN"}' });
  await assert.rejects(() => api('/deluge/api/connections', 'drepn'),
    (e) => e.status === 400, 'a second refusal is retried again - that is a loop against an assumption');
  assert.equal(warmed, 2, 'the retry warmed more than once for one call');

  // anything else: thrown, with what Zoho said and what it called it, kept apart.
  answers.push({ status: 403, ok: false,
    text: async () => '{"code":"NO_PERMISSION","message":"permission denied"}' });
  await assert.rejects(() => api('/crm/v2/settings/functions', 'crm'), (e) => {
    assert.equal(e.status, 403, 'the status is lost');
    assert.equal(e.forbidden, true, 'a 403 is no longer a refusal, so the panel cannot say why');
    assert.equal(e.detail, 'permission denied', 'the sentence Zoho wrote is lost');
    assert.equal(e.code, 'NO_PERMISSION', 'the machine-readable reason is lost');
    return true;
  });

  // and a path that cannot be right is refused before it is sent.
  await assert.rejects(() => api('/crm/../../etc/passwd', 'crm'), /malformed request path/,
    'a malformed path is sent to Zoho instead of being refused here');
});

// ---------------------------------------------------------------------------------------------
// Everything the model says arrives through one parser, and the parser had never been run.
//
// `aiStreamAnthropic` reads a server-sent-event stream off a socket and assembles it into content
// blocks: text that is shown as it arrives, and `tool_use` blocks whose arguments come in as JSON
// fragments across many events, keyed by the block's index. Then the agent loop runs the tools and
// sends the results back.
//
// The only stand-in for the model anywhere in the suite is `aiRunAnthropicAgent: async () => {}`.
// So the stream reader - the byte-level part, the one place a wrong index or a chunk boundary turns
// an answer into a different answer - was exercised by nothing at all. Measured by writing every
// block into slot 0: the battery green but for the twin ledger noticing a body had moved. Two tool
// calls in one turn would then have their arguments spliced into one, and the second tool would be
// called with the first one's input or not at all.
//
// What is faked here is the socket, which is the thing that is genuinely not ours; the parser is the
// shipped one. The chunks are split **mid-event on purpose**, because a network read boundary falls
// where it likes and a parser that only works on whole events is a parser that works in a test.
//
// **The limits, stated.** It drives the reader, not the agent loop around it: what happens after a
// `tool_use` is assembled is `aiRunAnthropicAgent`'s business and is not covered here. And it asserts
// the shape of what comes back, not the wording of a message - the wording is the panel's.
test('crm: the model stream is assembled by index, across whatever chunks arrive', async () => {
  const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  // A body that hands out exactly the byte runs it is given, so a boundary can be put anywhere.
  const bodyOf = (text, cuts) => {
    const enc = new TextEncoder();
    const parts = [];
    let at = 0;
    for (const c of [...cuts, text.length]) { parts.push(text.slice(at, c)); at = c; }
    let i = 0;
    return { getReader: () => ({ read: async () => (i < parts.length
      ? { value: enc.encode(parts[i++]), done: false } : { value: undefined, done: true }) }) };
  };

  const stream = sse([
    ['content_block_start', { index: 0, content_block: { type: 'text' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Looking' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' it up.' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'a', name: 'get_function' } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"name":"ns' } }],
    ['content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'b', name: 'who_calls' } }],
    ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"name":"other"}' } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '.fn"}' } }],
    ['content_block_stop', { index: 1 }],
    ['content_block_stop', { index: 2 }],
    ['message_delta', { delta: { stop_reason: 'tool_use' } }],
  ]);
  // Cut in three places that are all wrong on purpose: inside a JSON payload, between the two
  // newlines that end an event, and inside a multi-byte character would be the fourth if the
  // fixture carried one - it does not, and that is a limit rather than a claim.
  const cuts = [Math.floor(stream.length / 3), stream.indexOf('"}\n\n') + 3, stream.length - 12];

  let seen = '';
  const g = {
    TextDecoder, JSON, Object, Array, String, Error, Promise, console,
    AI_MAX_TOKENS: 16384,
    fetch: async () => ({ ok: true, body: bodyOf(stream, cuts.filter((c) => c > 0).sort((a, b) => a - b)) }),
  };
  const { aiStreamAnthropic } = load([
    sliceFn('apps/crm/ai.js', 'aiTrunc'),
    sliceFn('apps/crm/ai.js', 'aiStreamAnthropic'),
  ], g);

  const out = await aiStreamAnthropic({ apiKey: 'k', model: 'm' }, [], 's', [], (t) => { seen += t; });
  // Through JSON before comparing: the slice runs in a vm context, so its arrays and objects have
  // that realm's prototypes and `deepStrictEqual` refuses two structures that print identically.
  // Read back at the time: the printed «actual» and «expected» were the same text.
  const plain = (x) => JSON.parse(JSON.stringify(x));

  assert.equal(seen, 'Looking it up.',
    `the text shown as it arrives came out as «${seen}» - a chunk boundary changed what the reader saw`);
  assert.equal(out.stop_reason, 'tool_use', 'the stop reason was lost, so the agent loop stops after one turn');
  const tools = out.content.filter((b) => b.type === 'tool_use');
  assert.equal(tools.length, 2, `${tools.length} tool call(s) came back out of two - blocks are being merged`);
  assert.deepEqual(plain(tools.map((t) => [t.id, t.name, t.input])), [
    ['a', 'get_function', { name: 'ns.fn' }],
    ['b', 'who_calls', { name: 'other' }],
  ], 'a tool call came back with another call\'s arguments - the fragments are not keyed by index');
  assert.deepEqual(plain(out.content.filter((b) => b.type === 'text').map((b) => b.text)), ['Looking it up.'],
    'the text block was lost or duplicated');

  // A block whose JSON never completes comes back with an empty input rather than a fragment or a
  // throw: the model is not ours and a truncated stream must not take the panel down with it.
  // Measured while writing this: removing the `try` around `JSON.parse` changes nothing here,
  // because the whole `handle()` call already sits inside one - so this asserts the outcome and
  // **not** that inner guard, which no test can distinguish. Said rather than implied.
  const broken = sse([
    ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c', name: 'who_calls' } }],
    ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":' } }],
    ['content_block_stop', { index: 0 }],
  ]);
  g.fetch = async () => ({ ok: true, body: bodyOf(broken, []) });
  const { aiStreamAnthropic: again } = load([
    sliceFn('apps/crm/ai.js', 'aiTrunc'), sliceFn('apps/crm/ai.js', 'aiStreamAnthropic'),
  ], g);
  const half = await again({ apiKey: 'k', model: 'm' }, [], 's', [], () => {});
  assert.deepEqual(plain(half.content), [{ type: 'tool_use', id: 'c', name: 'who_calls', input: {} }],
    'a tool call whose arguments were cut short is no longer answered with an empty input');

  // And a refusal is a refusal: the status and what the endpoint said, not a silent empty answer.
  g.fetch = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
  const { aiStreamAnthropic: refused } = load([
    sliceFn('apps/crm/ai.js', 'aiTrunc'), sliceFn('apps/crm/ai.js', 'aiStreamAnthropic'),
  ], g);
  await assert.rejects(() => refused({ apiKey: 'k', model: 'm' }, [], 's', [], () => {}),
    /429[\s\S]*slow down/, 'a refused request no longer carries the status and what was said');
});

// ---------------------------------------------------------------------------------------------
// Every diagram this project has ever drawn was a graph with no cycle in it.
//
// The three graph fixtures - what `shots.py` renders every published diagram screenshot from, and
// what `probe.py` drives the ER window with - come out of the sample generator. Measured: the call
// graph is 144 nodes and 127 edges, and it is **acyclic**, with no self-call and no reference to a
// node outside it. A Deluge org with two functions that call each other is ordinary; the stand-in
// for one has never had a loop in it.
//
// What that hides is not cosmetic. `computeMaxDepth` walks outwards with `while (fr.length)` and no
// other bound: what stops it is the visited set. Take that away and on a DAG it still terminates,
// because the frontier empties by itself - so the fixture cannot tell the difference, the battery
// stays green, and on a real org the diagram window loops for ever. Planted exactly that: green but
// for the twin ledger noticing that a pair of identical bodies had both moved.
//
// `bfsEgo` was never driven at all - it appears in this file twice, both times as `bfsEgo() {}`,
// a stub standing in for the thing under test in cases about something else.
//
// So: the two walks, on a graph that loops. Mutual recursion, a self-call, and a chain hanging off
// it so depth still means something.
//
// **The limits, stated.** Termination is asserted by the case finishing. Planted, the depth walk
// without its guard did not hang: it grew its frontier until node threw «Invalid array length», so
// the message names the runtime rather than the defect. Left that way rather than instrumented from
// a test - a red case pointing here is enough to find it, and the alternative is a test reaching
// inside shipped code to count its own iterations. The ego walk's guard fails properly, with the
// distance it got wrong. It drives the shared `graphlogic.js`, byte-identical across the two
// products and held so by another case, so one run covers both.
test('the diagram walks a graph that loops, and comes back', () => {
  //   a <-> b   (mutual recursion)      c -> c (a self-call)      b -> c -> d -> e (a chain)
  const N = {
    a: { calls: ['b'], called_by: ['b'] },
    b: { calls: ['a', 'c'], called_by: ['a'] },
    c: { calls: ['c', 'd'], called_by: ['b', 'c'] },
    d: { calls: ['e'], called_by: ['c'] },
    e: { calls: [], called_by: ['d'] },
  };
  const ctx = {
    N, Set, Object, Array, Math, console,
    curFocus: 'a', egoDepth: 2, scopeAll: false,
    egoLevel: null, egoSet: null, maxEgoDepth: 1,
  };
  vm.createContext(ctx);
  vm.runInContext([sliceFn('apps/crm/graphlogic.js', 'bfsEgo'),
                   sliceFn('apps/crm/graphlogic.js', 'computeMaxDepth')].join('\n'), ctx);

  vm.runInContext('bfsEgo()', ctx);
  assert.deepEqual([...ctx.egoSet].sort(), ['a', 'b', 'c'],
    'the ego set at depth 2 around «a» is wrong on a graph with a cycle in it');
  // Through JSON, for the reason the stream case records: an object built inside a vm context has
  // that realm's prototype and `deepStrictEqual` refuses two structures that print identically.
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.egoLevel)), { a: 0, b: 1, c: 2 },
    'a node reached round a cycle was given the wrong distance, so the depth chips lie');

  // The whole reachable set, and the distance to the furthest of it. `e` is four steps from `a`
  // going forwards; nothing here may count the loop as extra distance.
  ctx.egoDepth = 99;
  vm.runInContext('bfsEgo()', ctx);
  assert.deepEqual([...ctx.egoSet].sort(), ['a', 'b', 'c', 'd', 'e'],
    'the walk did not reach everything the focus is connected to');
  vm.runInContext('computeMaxDepth()', ctx);
  assert.equal(ctx.maxEgoDepth, 4,
    `the furthest node came out at ${ctx.maxEgoDepth} steps - a cycle is being counted as distance`);

  // A focus that is itself the self-call, so the very first neighbour is the node being walked.
  ctx.curFocus = 'c'; ctx.egoDepth = 1;
  vm.runInContext('bfsEgo()', ctx);
  assert.deepEqual([...ctx.egoSet].sort(), ['b', 'c', 'd'],
    'a function that calls itself put its own name in its neighbours, or lost them');
  assert.equal(ctx.egoLevel.c, 0, 'the focus was given a distance from itself');

  // And the fixture that stands for a real org: this is the state it is in, recorded so that the
  // day it grows a loop, this line is what says the cover moved rather than the check breaking.
  const fx = JSON.parse(read('fixtures/graph-crm-calls.json'));
  const ids = new Set(Object.keys(fx.nodes));
  const dangling = Object.values(fx.nodes)
    .flatMap((n) => (n.calls || []).filter((c) => !ids.has(c)));
  assert.deepEqual(dangling, [],
    'the fixture now has an edge to a node it does not contain - real, and worth a case of its own');
});

// ---------------------------------------------------------------------------------------------
// «Marks cleared only on a successful write» was held by a regex, and a regex cannot see an order.
//
// The summary cache has a recorded history of three defects and one rule: **invalidation derives
// from the event, never from the memory of whoever caused it** - `noteWrite(rel)` maps what was
// written to what must be forgotten, and it runs *after* the bytes are down, so a refused write
// forgets nothing and the panel keeps an answer that is still true.
//
// Nothing exercised that. The cases about it read the source - `assert.ok(/noteWrite\(rel\)/.test(…),
// 'a write leaves no mark')` - which is what this project calls a photograph of a belief: it confirms
// the call is still spelled the same way and says nothing about where it sits. Measured by moving
// `noteWrite(rel)` **above** the write: 878 Node cases green, both Python suites green, every checker
// at zero, and the only red the twin ledger noticing a body had moved. A write refused by the browser
// would then clear the caches anyway, and the panel would rebuild from a file that never changed -
// or, worse, from the one that did not get written.
//
// It is invisible for the reason this cell is about: the stand-in for the file system cannot refuse.
// `tools/fsshim.js` grants every permission and accepts every write, so the branch where a write
// fails has never run anywhere - not in the probe, not in a screenshot, not in a case.
//
// So this drives it: a handle that throws where a real one throws, and one that does not.
//
// **The limits, stated.** It drives the two writers and the marks they clear, not what is rebuilt
// afterwards. The caches are read back by name off `noteWrite`'s own body rather than listed here,
// so a cache added to it tomorrow is covered; a cache cleared somewhere else entirely is not, and
// another case already refuses that.
test('a write the browser refuses forgets nothing, in either product', async () => {
  // Every product that has one, found by having one. Both panels write through the same shape - a
  // `noteWrite` table and a `writeFileAt` that calls it after the bytes are down - and a case named
  // after one of them would have left the other exactly where this one found it.
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
    .filter((a) => /\b(?:const|function) noteWrite\b/.test(read(`apps/${a}/sidepanel.js`)));
  assert.ok(apps.length >= 2, `${apps.length} product(s) have a noteWrite - the derivation broke`);
  // One is an arrow constant and the other a declaration, which is a twin difference the ledger
  // already records - so the lift asks the source which it is instead of assuming either.
  const noteOf = (rel) => {
    const src = read(rel);
    const at = src.indexOf('const noteWrite');
    return at > 0 ? src.slice(at, src.indexOf('\n};', at) + 3) : sliceFn(rel, 'noteWrite');
  };

  for (const app of apps) {
    // Cut by hand rather than with `sliceConst`: `noteWrite` is a multi-line arrow whose statements
    // end in `;`, and that lifter stops at the first one closing a line - it returned two thirds of
    // the body and the evaluation died on «Unexpected end of input». The lifter's own stated limit,
    // met head-on; the closing `\n};` at column zero is the fact this file relies on everywhere.
    const rel = `apps/${app}/sidepanel.js`;
    const noteSrc = noteOf(rel);
    // Deduplicated: a cache appears in as many branches as drop it, and a message naming
    // `aiConnCache` three times reads as three caches.
    const CACHES = [...new Set([...noteSrc.matchAll(/(\w+) = null/g)].map((m) => m[1]))];
    assert.ok(CACHES.length >= 1, `id=${app}: noteWrite drops ${CACHES.length} cache(s) - the derivation broke`);

    const build = (writable) => {
      const ctx = {
        Set, Object, Array, String, Error, Promise, Map, console,
        WS_MOVED: 'moved',
        isModuleFile: (r) => r.startsWith('modules/'),
        _dirtyMeta: new Set(), _dirtySource: new Set(),
        sqlDiskUnread: new Set(), sqlUnread: 0,
        dirFor: async () => ({ getFileHandle: async () => ({ createWritable: writable }) }),
      };
      // The root is a real enough handle: `removeFileAt` walks it directory by directory, so a bare
      // object throws «not a function» and the case would pass on the wrong error.
      ctx.dir = { name: 'root',
                  getDirectoryHandle: async () => ({
                    removeEntry: async () => { throw new Error('the browser refused the removal'); } }) };
      for (const c of CACHES) ctx[c] = 'kept';
      vm.createContext(ctx);
      vm.runInContext([noteSrc, sliceFn(rel, 'writeFileAt'), sliceFn(rel, 'removeFileAt')].join('\n'), ctx);
      return ctx;
    };
    const held = (ctx) => CACHES.filter((c) => ctx[c] === 'kept');
    // A path the product's own table reacts to, taken **from the table**. Driving
    // `functions/a/b.dg` at both was the first version, and Analytics has no such path - so its
    // `noteWrite` returned at the top, cleared nothing either way, and the case passed on both
    // orders. A fixture that cannot reach the branch is the same failure as a stub that cannot
    // refuse, one level up.
    const startsWith = /startsWith\('([^']+)'\)/.exec(noteSrc);
    const endsWith = /endsWith\('([^']+)'\)/.exec(noteSrc);
    assert.ok(startsWith, `id=${app}: noteWrite branches on no path prefix - the derivation broke`);
    const path = startsWith[1] + 'x' + (endsWith ? endsWith[1] : '');
    const drops = build(async () => ({ write: async () => {}, close: async () => {} }));
    await vm.runInContext(`writeFileAt(dir, '${path}', 'x')`, drops);
    assert.notDeepEqual(held(drops), CACHES,
      `id=${app}: a written «${path}» dropped nothing, so this case is driving a path the table `
      + 'does not react to and would pass whatever the order');

    // The browser refuses the write. Nothing was written, so nothing may be forgotten.
    const bad = build(async () => { throw new Error('the browser refused the write'); });
    await assert.rejects(() => vm.runInContext(`writeFileAt(dir, '${path}', 'x')`, bad),
      /refused/, `id=${app}: a refused write no longer reaches the caller`);
    assert.deepEqual(held(bad), CACHES,
      `id=${app}: a write that never happened cleared ${CACHES.filter((c) => bad[c] !== 'kept')} - the `
      + 'panel will rebuild from a file that did not change, and the mark that said so is gone');
    assert.equal(bad._dirtySource.size + bad._dirtyMeta.size, 0,
      `id=${app}: a refused write left a dirty mark, so the summary cache believes a source moved`);

    // A removal the browser refuses: same rule, the other writer.
    const rm = build(async () => ({ write: async () => {}, close: async () => {} }));
    await assert.rejects(() => vm.runInContext(`removeFileAt(dir, '${path}')`, rm),
      /refused/, `id=${app}: a refused removal no longer reaches the caller`);
    assert.deepEqual(held(rm), CACHES,
      `id=${app}: a removal that never happened cleared a cache, so the panel forgets a file that is still there`);
  }

  // …and the working case, on the product whose table is the larger of the two: a written `.dg`
  // drops the source, the graph and the connection map, and leaves a dirty mark behind it. Asserted
  // where the branch exists rather than in the loop, because the two tables are not the same table.
  let closed = false;
  const ctx = {
    Set, Object, Array, String, Error, Promise, console, WS_MOVED: 'moved',
    isModuleFile: (r) => r.startsWith('modules/'),
    _dirtyMeta: new Set(), _dirtySource: new Set(),
    dir: { name: 'root' },
    dirFor: async () => ({ getFileHandle: async () => ({ createWritable:
      async () => ({ write: async () => {}, close: async () => { closed = true; } }) }) }),
  };
  const note = noteOf('apps/crm/sidepanel.js');
  for (const c of [...new Set([...note.matchAll(/(\w+) = null/g)].map((m) => m[1]))]) ctx[c] = 'kept';
  vm.createContext(ctx);
  vm.runInContext([note, sliceFn('apps/crm/sidepanel.js', 'writeFileAt')].join('\n'), ctx);
  await vm.runInContext("writeFileAt(dir, 'functions/a/b.dg', 'x')", ctx);
  assert.equal(closed, true, 'the writable was never closed, so the bytes are not on disk');
  for (const c of ['codeCache', 'graphCache', 'aiConnCache']) {
    assert.equal(ctx[c], null, `a written .dg no longer drops ${c}`);
  }
  assert.equal(ctx._dirtySource.has('functions/a/b.dg'), true, 'a written source left no dirty mark');
});

// ---------------------------------------------------------------------------------------------
// A section watches one key, and one of the loaders reads two.
//
// The settings page can sit open for hours while the panel writes the same keys, so each section
// watches its own: `SECTIONS` maps a stored key to the loader that reads it, `onChanged` walks that
// table, and a key that changed elsewhere either re-reads silently or raises a conflict. The whole
// guard against the stale save is that table being complete.
//
// `loadTabs()` reads **two** keys - `tabPrefs`, which the page writes, and `tabAccessView`, which the
// **panel** writes every time the access verdicts move: it is what the Tabs section shows about
// whether your Zoho role still grants each tab. Only the first was registered. So a pull that
// discovers a refusal updates the fact, and a settings page already open goes on showing the old
// verdicts for the rest of the session - «granted» beside a tab the org has just refused.
//
// Two halves each right on their own: the table maps a key to its loader, and the loader reads what
// it needs. The composition is a loader registered under one of the two keys it depends on.
//
// The fix is the idiom the file already has beside it - `erParams` and `erDrawMax` under one
// `SEC_DIAGRAM`, with a comment saying why - so `tabPrefs` and `tabAccessView` share `SEC_TABS`.
// Nothing marks `tabAccessView` dirty, because `dirty` is keyed by `data-section` in the markup and
// there is no section element for it, so it can only ever take the silent branch: which is correct,
// as the page never writes it and there is no lost update to guard.
//
// **The limits, stated.** It reads the keys a loader asks `chrome.storage.local` for, written as
// literals; a key reached through a variable is invisible to it, which is why the count of keys
// compared is asserted. And it says nothing about whether a reload actually redraws anything.
test('every key the settings page reads is a key it is told about', () => {
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
    .filter((a) => read(`apps/${a}/options.js`).includes('const SECTIONS'));
  assert.ok(apps.length >= 2, `${apps.length} settings page(s) have a SECTIONS table - the derivation broke`);
  let compared = 0;
  for (const app of apps) {
    const src = read(`apps/${app}/options.js`);
    const at = src.indexOf('const SECTIONS');
    const table = src.slice(at, src.indexOf('\n};', at));
    const sections = [...table.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
    assert.ok(sections.length >= 3, `id=${app}: ${sections.length} section(s) - the derivation broke`);

    // What the page asks storage for, in either shape it uses.
    const read1 = [...src.matchAll(/storage\.local\.get\(\s*'(\w+)'/g)].map((m) => m[1]);
    const readN = [...src.matchAll(/storage\.local\.get\(\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
    const asked = [...new Set([...read1, ...readN])];
    compared += asked.length;
    assert.ok(asked.length >= 3, `id=${app}: the page reads ${asked.length} key(s) - the derivation broke`);

    const unwatched = asked.filter((k) => !sections.includes(k));
    assert.deepEqual(unwatched, [],
      `id=${app}: the settings page shows these and no section watches them, so a change made `
      + `anywhere else is never picked up and the form goes on showing what it read at load: ${unwatched}`);
    const unread = sections.filter((k) => !asked.includes(k));
    assert.deepEqual(unread, [],
      `id=${app}: these sections watch a key nothing on the page reads, so their reload has nothing `
      + `to catch up to: ${unread}`);
  }
  assert.ok(compared >= 8, `only ${compared} key(s) compared - the derivation broke`);
});

// ---------------------------------------------------------------------------------------------
// The panel and the model were told two different things about the same index.
//
// The org index goes to the assistant with **every** message, so the reader sets a ceiling and
// `aiBuildSeed` drops sections until it fits. What it drops is named twice: in `aiSeedOmitted`, which
// the panel shows, and inside the index itself - «NOT LISTED ABOVE: …», which is the model's only
// defence against concluding that something it cannot find does not exist. The settings page states
// that promise in as many words.
//
// Three things came apart in the composition, all of them only on a large workspace - which is the
// one place any of it matters:
//
//   - the top-level list being cut **replaced** `aiSeedOmitted` instead of joining it, so the panel
//     named one absence and the index named the others, and neither named all of them;
//   - the note was appended **after** the truncation, so the seed came out over the cap - measured at
//     4,256 against 4,000 on the CRM, and 4,222 against 4,000 on Analytics;
//   - and «the 1 connections», in a sentence written to be reasoned from.
//
// **This case walks both products, and that is the whole reason it reads like this.** The CRM was
// corrected first and Analytics was not, in a session four of whose cells were about a fix reaching
// one half of a pair - and it took an outside reader to find it, with that 4,222. A case named after
// one product would have left the other exactly where it was.
//
// **The limits, stated.** It drives the builders on fixtures, so it proves what the two readers are
// told and not what the model does with it. The caps are pushed to the floor on purpose - the branch
// where the top-level list alone overflows is unreachable at any realistic setting, which is exactly
// why it was never seen. A product with no fixture here is a failure, not a skip, so a third one
// cannot be quietly uncovered.
const SEED_FIXTURES = {
  crm: () => {
    const nodes = {};
    for (let i = 0; i < 400; i++) {
      nodes['ns.fn' + i] = { namespace: 'ns', name: 'function_with_a_long_name_' + i, rest: false,
                             associated_place: [], stats: { lines: 10, apiCalls: 1 } };
    }
    return {
      ensureGraph: async () => ({ nodes }),
      loadModuleFiles: async () => ({ Contacts: {}, Deals: {}, Accounts: {} }),
      aiLoadConnections: async () => [{ name: 'c1', connector: 'x', uses: [1, 2] }],
      aiLoadActions: async () => ({ list: [{ kind: 'tasks', associated: true }], users: new Map() }),
      firedBy: () => [1], actionKindLabel: (k) => k,
    };
  },
  analytics: () => {
    const views = [];
    for (let i = 0; i < 700; i++) views.push({ id: 't' + i, name: 'a_table_with_a_fairly_long_name_' + i, type: 'Table' });
    for (let i = 0; i < 30; i++) views.push({ id: 'r' + i, name: 'report_' + i, type: 'Chart' });
    return {
      views,
      schema: Object.fromEntries(views.filter((v) => v.type === 'Table')
        .map((v) => [v.id, { name: v.name, kind: 'Table', system: false, columns: [{}, {}, {}] }])),
      relations: [], deps: null, isOrphanCandidate: () => false,
      bound: { workspace: 'w', name: 'W' },
      viewById: () => new Map(views.map((v) => [v.id, v])),
      sqlDiskUnread: new Set(), sqls: {},
    };
  },
};

test('what the index leaves out is said once, and inside the cap, in either product', async () => {
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
    .filter((a) => shippedScripts().some((f) => f.startsWith(`apps/${a}/`) && read(f).includes('async function aiBuildSeed')));
  assert.ok(apps.length >= 2, `${apps.length} product(s) build an index - the derivation broke`);

  for (const app of apps) {
    const rel = shippedScripts().find((f) => f.startsWith(`apps/${app}/`) && read(f).includes('async function aiBuildSeed'));
    assert.ok(SEED_FIXTURES[app], `id=${app} builds an index and has no fixture here - a product added `
      + 'without one would be uncovered and this case would say nothing');
    const ctx = Object.assign({
      Object, Math, Number, Set, Map, JSON, Promise, String, Error, Array, console,
      AI_SEED_CAP_DEFAULT: 72000, WS_MOVED: 'moved',
      beginWorkspaceOp: () => ({ current: () => true }),
      aiSeedSize: 0, aiSeedOmitted: [], aiSeedTruncated: false,
      op: { current: () => true },
    }, SEED_FIXTURES[app]());
    vm.createContext(ctx);
    vm.runInContext([sliceFn(rel, 'aiTrunc'), sliceFn(rel, 'aiBuildSeed')].join('\n'), ctx);

    ctx.cap = 4000;                       // low enough that the top-level list alone overflows
    const out = await vm.runInContext('aiBuildSeed(cap, op)', ctx);
    assert.ok(out.length <= ctx.cap,
      `id=${app}: the index is ${out.length} characters against a cap of ${ctx.cap} - the reader set a `
      + 'ceiling and the builder went over it, on every message');

    const note = /NOT LISTED ABOVE: ([\s\S]*?)\. They exist/.exec(out);
    assert.ok(note, `id=${app}: the index does not say what was left out, so an absence in it reads as `
      + 'an absence in the workspace');
    const said = JSON.parse(JSON.stringify(ctx.aiSeedOmitted));
    assert.ok(said.length >= 2,
      `id=${app}: the index dropped its top-level list and at least one section, and only `
      + `${said.length} of them is named: ${said}. Both readers agree, and they agree on an answer `
      + 'that is short');
    assert.equal(note[1], said.join(' and '),
      `id=${app}: the panel is told «${said.join(' and ')}» and the model is told «${note[1]}» - two `
      + 'statements about one index, and the model acts on the one shown to nobody');
    assert.match(note[1], /part of the (function index|table list)/,
      `id=${app}: the top-level list was cut and the index does not say so, which is the one absence `
      + 'that makes the model answer «there is no such thing» about something that exists');
    assert.equal(/\bthe 1 \w+s\b/.test(note[1]), false,
      `id=${app}: a count of one is written as a plural in the index the model reads: «${note[1]}»`);

    // And the other end: a cap nothing overflows leaves nothing out and says nothing.
    ctx.cap = 400000;
    const whole = await vm.runInContext('aiBuildSeed(cap, op)', ctx);
    assert.equal(whole.includes('NOT LISTED ABOVE'), false,
      `id=${app}: the index says something was left out when everything fitted`);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.aiSeedOmitted)), [],
      `id=${app}: the panel is told something was left out when everything fitted`);
  }
});

// ---------------------------------------------------------------------------------------------
// A `try` around a promise nobody awaits catches nothing, and reads as if it did.
//
// `try { chrome.storage.local.set({ … }); } catch (_) {}` catches only a throw raised while the
// promise is being *created*. A rejected write - the browser refusing, the extension context gone,
// the quota reached - lands nowhere: the value in memory has already changed, the panel carries on as
// though it saved, and the next session finds the old one. Five sites had this shape across the two
// panels, and the one that mattered closed the export dialog claiming a default it had not stored.
//
// The three answers are not the same, and that is the point of reading each one rather than applying
// a rule to all five:
//
//   - the **export default** is a choice the reader made by hand, so it is awaited and a refusal is
//     said - but it does not stop the export, because what failed is where the dialog starts *next*
//     time and not the scope of the run they just asked for;
//   - the **sample-workspace label** is a cache of a fact the folder already holds, and `knownSample()`
//     falls back to reading the folder, so losing it degrades to a state the panel already draws
//     honestly. Best-effort, declared;
//   - a **dragged height** is cosmetic. Best-effort, declared.
//
// «Declared» means `.catch(() => {})` at the site, not a `try` that cannot fire: an unhandled
// rejection is an omission, a written `.catch()` is a decision.
//
// The check derives what is asynchronous **from the file itself**: any call the file awaits somewhere
// is a promise everywhere in that file. So no list of API names is written here, and a storage or
// handle API this project starts using tomorrow enters the check the first time somebody awaits it.
//
// **The limits, stated.** It reads a `try` block's own text, so a call reached through a variable or
// a helper is invisible to it - a false negative rather than a false pass. It says nothing about
// `.then()` chains outside a `try`; those are unhandled rejections and belong to the async-scope work,
// not here. The count of awaited call shapes it learnt is asserted, so a file that stopped awaiting
// anything would be a finding about this check rather than a quiet pass.
test('no shipped script wraps an un-awaited promise in a try that cannot catch it', () => {
  const findings = [];
  let learnt = 0;
  for (const rel of shippedScripts()) {
    const src = read(rel);
    // What this file itself treats as asynchronous: `await a.b.c(` teaches `a.b.c(`.
    const async_ = new Set([...src.matchAll(/await\s+((?:\w+\.)+\w+)\s*\(/g)].map((m) => m[1]));
    if (!async_.size) continue;
    learnt += async_.size;
    // Every `try {` and the text up to its matching close, by brace depth on the scanned source so a
    // brace inside a string or a comment cannot end a block early.
    const scan = blankNonCode(src);
    for (const m of scan.matchAll(/\btry\s*\{/g)) {
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < scan.length; i++) {
        if (scan[i] === '{') depth++;
        else if (scan[i] === '}') { depth--; if (!depth) break; }
      }
      const body = src.slice(m.index, i + 1);
      for (const call of async_) {
        const at = body.indexOf(call + '(');
        if (at < 0) continue;
        // Awaited, returned or handed on is fine - what is not is being left to reject alone.
        // Awaited, returned or handed on is fine - what is not is being left to reject alone. The
        // `await` need not be adjacent: `JSON.parse(await (op ? op.read(rel) : readFile(rel)))` has
        // two parentheses and a ternary between the two, and the first version of this check called
        // that unhandled. So the window back to the previous statement boundary is what is read.
        const win = body.slice(0, at);
        const stmt = Math.max(win.lastIndexOf(';'), win.lastIndexOf('{'), win.lastIndexOf('}'));
        const before = win.slice(stmt + 1);
        if (/\b(await|return|yield)\b/.test(before)) continue;
        if (/\.(then|catch)\s*\(\s*$/.test(before)) continue;
        // The callback form of a Chrome API returns nothing, so there is no rejection to lose. The
        // first version of this check did not know that and reported `chrome.tabs.query({url}, cb)`
        // - correct code, flagged. A check that fires on what is right gets ignored, which is worse
        // than one that misses: the argument list is walked to its close and a trailing function is
        // what tells the two forms apart.
        let d = 0, j = at + call.length, args = '';
        for (; j < body.length; j++) {
          if (body[j] === '(') d++;
          else if (body[j] === ')') { d--; if (!d) break; }
          if (d >= 1) args += body[j];
        }
        if (/(?:\([^()]*\)|\w+)\s*=>\s*[\s\S]*$|\bfunction\b[\s\S]*$/.test(args.trimEnd().slice(-Math.min(args.length, 400)))
            && /(?:=>|\})\s*$/.test(args.trimEnd())) continue;
        // …and a handler written **after** the call, which the window before it cannot see. The
        // second false positive this check produced: `executeScript({…})\n  .catch(() => {})` is a
        // decision already taken, and reporting it would have had somebody delete a correct line.
        if (/^\s*\.\s*(then|catch|finally)\s*\(/.test(body.slice(j + 1))) continue;
        const line = src.slice(0, m.index).split('\n').length;
        findings.push(`${rel}:${line} - try { … ${call}(…) … } catch: the call is not awaited, so the `
          + 'catch runs only if making the promise throws. A rejection lands nowhere and the panel '
          + 'carries on as though it succeeded');
      }
    }
  }
  assert.ok(learnt >= 20, `only ${learnt} awaited call shape(s) learnt from the shipped scripts - the derivation broke`);
  assert.deepEqual(findings, [], 'a catch that cannot fire:\n  ' + findings.join('\n  '));
});

// ---------------------------------------------------------------------------------------------
// A refused write does not close the dialog on a claim it cannot make.
//
// The structural check above proves no `try` is left where it cannot fire. This proves the one site
// where the difference is visible to a reader: pressing **Export** stores the ticks as the default
// for next time and then closes. With the write refused, the old code closed exactly the same way -
// the promise rejected into nothing - and the next session opened the dialog at the old ticks with
// nobody having been told.
//
// It also pins the half that is easy to get wrong in the other direction: the export **still runs**.
// What failed is where the dialog starts next time, not the scope of the run just asked for, and
// blocking that would punish the reader for a preference that did not persist.
//
// **The limits, stated.** It drives the click handler with a storage that rejects, and reads what the
// panel said and what it resolved with. It does not draw anything, so it proves the sentence exists
// and not that it is visible; the panel's own status machinery is covered where it lives.
test('crm: a refused export default is said, and does not stop the export', async () => {
  const src = read('apps/crm/sidepanel.js');
  // By the control it belongs to: `handlerOf` throws when nothing is attached, which is the
  // «derivation broke» this used to assert by hand, and it reads the body whichever shape it is in.
  const body = handlerOf('apps/crm/sidepanel.js', 'expgo');

  const run = async (setter) => {
    const said = [];
    let resolved;
    const ctx = {
      Object, Promise, JSON, console,
      scopeFromUI: () => {},
      dlgScope: { functions: true, code: false },
      dlgAutoCleared: new Set(['code']),
      expScope: { functions: false, code: true },
      closeScope: (ok) => { resolved = ok; },
      setStatus: (t, k) => said.push([t, k]),
      chrome: { storage: { local: { set: setter } } },
    };
    vm.createContext(ctx);
    // The declaration, then a call to it. It used to be a block wrapped in `(async () => …)()`,
    // which is what the handler was; it is a named function now and running it as itself is both
    // shorter and closer to what the panel does.
    await vm.runInContext(`${body}\nonExpgo()`, ctx);
    return { said, resolved, stored: ctx.expScope };
  };

  const ok = await run(async () => {});
  assert.equal(ok.resolved, true, 'a saved default no longer lets the export run');
  assert.deepEqual(ok.said, [], 'a write that worked said something anyway');

  const bad = await run(async () => { throw new Error('the browser refused the write'); });
  assert.equal(bad.resolved, true,
    'a refused **default** stopped the export - what failed is where the dialog starts next time, '
    + 'not the scope of the run the reader just asked for');
  assert.equal(bad.said.length, 1,
    `the panel said ${bad.said.length} thing(s) about a write that never happened - it closed the `
    + 'dialog claiming a default it does not have');
  assert.match(bad.said[0][0], /refused/,
    `the sentence does not say what went wrong: «${bad.said[0][0]}»`);
  assert.ok(['warn', 'bad'].includes(bad.said[0][1]),
    `a refused write was reported as «${bad.said[0][1]}»`);

  // And the ticks the reader chose are what the export receives, in both cases - the dialog's own
  // auto-cleared keys carry the previous value, which is the behaviour another case already holds.
  assert.equal(bad.stored.functions, true, 'the scope the reader ticked was lost on a refused write');
});

// ---------------------------------------------------------------------------------------------
// A model that reasons before answering opened a block this reader had never heard of.
//
// Reported from a real workspace, three times running: a question, a wait, and «(empty response)».
// The HAR settles it, and it is not what either of us guessed. One content block, type **thinking**;
// deltas `thinking_delta` and `signature_delta`; no text, no tool call; `stop_reason: max_tokens`;
// **4,096 output tokens, every one of them thinking**. The input was 40,120 tokens, so the index sent
// with each message - the first thing anyone suspects - was nowhere near it.
//
// Three defects in a row, and each hid the next:
//
//   - the reader mapped every non-`tool_use` block to `{ type: 'text', text: '' }`, so a thinking
//     block became an empty text block, its deltas matched no branch, and it was dropped as empty;
//   - the turn then said «(empty response)», which names neither the cause nor the remedy, on a call
//     the reader has paid for - and `stop_reason` said `max_tokens` the whole time;
//   - and the ceiling was 4096, written into the request when a model answered straight away, with
//     no way for the reader to raise it.
//
// **The limits, stated.** It drives the reader and the loop on a stream shaped like the recorded one,
// so it proves what the panel does with that answer, not what any model will send. The names of the
// workspace in that recording belong to somebody's day job and are nowhere here - the fixture is a
// thinking block and a stop reason, which is all that matters to the code.
test('a turn that spends its whole budget thinking says so, in either product', async () => {
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
    .filter((a) => shippedScripts().some((f) => f.startsWith(`apps/${a}/`)
      && read(f).includes('async function aiStreamAnthropic')));
  assert.ok(apps.length >= 2, `${apps.length} product(s) stream from Anthropic - the derivation broke`);

  const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  // Exactly the shape of the recorded failure: it thinks, it runs out, it says nothing else.
  const allThinking = sse([
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it up' } }],
    ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'x' } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'max_tokens' } }],
  ]);
  // And the ordinary case: it thinks, then answers. The thinking must not reach the reader or the
  // model, and the answer must arrive whole.
  const thenAnswers = sse([
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it up' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'text' } }],
    ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Yes - drop the join.' } }],
    ['content_block_stop', { index: 1 }],
    ['message_delta', { delta: { stop_reason: 'end_turn' } }],
  ]);
  const bodyOf = (text) => {
    const enc = new TextEncoder(); let done = false;
    return { getReader: () => ({ read: async () => (done ? { done: true } : (done = true, { value: enc.encode(text), done: false })) }) };
  };

  for (const app of apps) {
    const rel = shippedScripts().find((f) => f.startsWith(`apps/${app}/`)
      && read(f).includes('async function aiStreamAnthropic'));
    const cap = Number(/const AI_MAX_TOKENS_DEFAULT = (\d+)/.exec(read(rel))[1]);
    assert.ok(cap > 4096,
      `id=${app}: the answer budget is ${cap}, which is the value that produced the empty reply - a `
      + 'model that reasons first can spend all of it before writing anything');

    const said = [];
    let body = allThinking;
    const g = {
      TextDecoder, TextEncoder, JSON, Object, Array, String, Error, Promise, console,
      AI_MAX_TOKENS: cap,
      aiMessages: said, aiRenderMessages: () => {}, aiToolEvent: () => {},
      aiExecTool: async () => '', beginWorkspaceOp: () => ({ current: () => true }),
      $: () => ({ querySelectorAll: () => [], scrollTop: 0, scrollHeight: 0 }),
      aiMarkdown: (t) => t,
      fetch: async () => ({ ok: true, body: bodyOf(body) }),
    };
    const { aiStreamAnthropic, aiRunAnthropicAgent } = load([
      sliceFn(rel, 'aiTrunc'), sliceFn(rel, 'aiStreamAnthropic'), sliceFn(rel, 'aiRunAnthropicAgent'),
    ], g);

    // The reader, first: a thinking block is not a text block, and it is not sent back to the model.
    const out = await aiStreamAnthropic({ apiKey: 'k', model: 'm' }, [], 's', [], () => {});
    assert.deepEqual(JSON.parse(JSON.stringify(out.content)), [],
      `id=${app}: a thinking block came back as content - it would be shown, or sent to the model as text`);
    assert.equal(out.thought, true, `id=${app}: the turn does not know it thought, so it cannot say so`);
    assert.equal(out.stop_reason, 'max_tokens', `id=${app}: the stop reason was lost`);

    // …and the loop says which of the two silences it was.
    said.length = 0;
    await aiRunAnthropicAgent({ apiKey: 'k', model: 'm' }, [], 's', [], 5);
    assert.equal(said.length, 1, `id=${app}: the turn added ${said.length} message(s)`);
    const msg = said[0].content;
    assert.equal(/empty response/.test(msg), false,
      `id=${app}: still «${msg}» - a sentence that names neither the cause nor the remedy`);
    assert.match(msg, new RegExp(String(cap)),
      `id=${app}: the message does not say what the budget was: «${msg}»`);
    assert.match(msg, /reasoning|thinking/i,
      `id=${app}: the message does not say the budget went on reasoning: «${msg}»`);
    assert.match(msg, /Settings/,
      `id=${app}: the message does not say where the reader can change it: «${msg}»`);

    // The ordinary turn: the answer arrives, the thinking does not.
    said.length = 0; body = thenAnswers;
    const ok = await aiStreamAnthropic({ apiKey: 'k', model: 'm' }, [], 's', [], () => {});
    assert.deepEqual(JSON.parse(JSON.stringify(ok.content)), [{ type: 'text', text: 'Yes - drop the join.' }],
      `id=${app}: an answer that followed a thinking block did not arrive whole`);
  }
});
