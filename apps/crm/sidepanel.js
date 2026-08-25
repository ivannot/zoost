/*
 * sidepanel.js - IDE orchestrator (multi-workspace).
 */
// Which tabs count as Zoho, taken from the manifest rather than copied out of it. It was eighteen
// patterns typed here as well, so adding a data centre meant remembering this file - and Zoho has
// more of them than either list had: zoho.sa, zoho.uk and zoho.ae answer exactly as the six did,
// with current certificates and a live accounts service each.
// `crmplus` is here for the same reason `one` is, and does the same nothing: it is a suite shell,
// the CRM inside it is an iframe on `crm.zoho.<dc>`, and **neither shell declares a content script**.
// Naming the host is only what lets the panel see that this tab is Zoho at all and enumerate its
// frames; everything after that happens in the CRM document, as it does on a plain CRM tab.
const ZOHO_MATCHES = (chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => /^https:\/\/(crm|crmsandbox|crmplus|one)\./.test(h));
const ZOHO_HOST_RE = /^https:\/\/(crm(sandbox|plus)?|one)\.zoho/;
const envOf = (origin) => /crmsandbox\./.test(origin || '') ? 'sandbox' : 'prod';
const CFG = '.zoost.json';
const NS = ['standalone', 'automation', 'button', 'schedule', 'validation_rule'];
// Zoho writes both. Counted in a real org's mirror: 149 actions of type `functions` and **2** of
// type `function`, same three fields, same meaning - and nine readers here compared against the
// plural only, so those two fired a function that no graph edge, no «broken automation» and no
// action count ever knew about. Silent, because a filter that matches nothing is indistinguishable
// from an org that has nothing. One predicate rather than nine comparisons, so the next form Zoho
// invents is a one-line change instead of a hunt.
const isFnAction = (a) => a && (a.type === 'functions' || a.type === 'function');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir = null, index = new Map(), bound = null, lastCtx = null;
let wsList = [], activeWsId = null;
const zohoReady = () => !!(lastCtx && guardOk());
const FN_NAMES = ['api_name', 'display_name', 'name'];   // every name a function answers to
// Which toolbar controls read from Zoho and which only read the disk. Declared here, above every
// reader, because `refreshContext` runs on a five-second poll and used to name `pull` by hand while
// this list already knew there were two: the per-type Pull stayed enabled through an environment
// mismatch and failed at the click instead, which is the one-of-a-set miss this repository keeps
// recording. Anything Zoho-bound goes in ZOHO_BTNS and is blocked in one place.
// What «Pull all» announces, derived from what it walks rather than typed beside it. It walks
// `TABS`, so this is `TABS` - the markup said «functions, modules, workflows and schedules», four
// of the six, and Actions and Connections shipped without ever reaching that sentence.
//
// **Not the runner table**: `runners` carries a seventh entry, `failures`, which that loop never
// reaches because it is not a tab - the health view pulls it on its own. Building the sentence
// from the runners would have promised an area this button does not pull, which is the mistake
// this line exists to stop, made in the other direction.
const LOCAL_BTNS = ['graph', 'refresh', 'export', 'exportmd', 'health', 'askai'];
// **Three lists, and a control in none of them.** `ZOHO_BTNS` held the two Pulls and was applied by
// setting `disabled`; a rule in the stylesheet greyed `#pvreveal` and `#pvfind` by id, because those
// two are spans and a span has no `disabled`; and `#funcs` - «Functions page» - was in neither, so it
// stayed live while everything else went dead and answered «Unknown target» when pressed, which is a
// control that is enabled and cannot work. Reported from a real Zoho One org, as «Find is disabled
// and Functions page is not», which is exactly what those three lists say.
//
// One list now, and it is applied by `blockZoho()` rather than by two mechanisms that have to be
// remembered together: `disabled` where the element has it, and a class in every case, so the
// stylesheet stops naming controls one by one and a control added tomorrow inherits both.
const ZOHO_BTNS = ['pull', 'pullone', 'funcs', 'pvreveal', 'pvfind'];
function blockZoho(on) {
  document.body.classList.toggle('zoho-blocked', on);
  ZOHO_BTNS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    if ('disabled' in el) el.disabled = on;
    el.classList.toggle('zblocked', on);
  });
  const p = $('pull');
  // **What Pull all pulls, from the list it actually runs.** The markup said «functions, modules,
  // workflows and schedules» - four of seven - and Actions, Connections and Failures shipped without
  // ever reaching that string. It is the sentence a reader sees before every pull, so it is derived
  // from `PULL_AREAS` rather than kept in step by hand.
  if (p) p.title = on ? p.title : `Pull all - ${TABS.map((t) => t.label).join(', ')}`;
}
// A workspace of invented data, written by «+ Sample» rather than pulled. It is an ordinary
// workspace in every other respect - the same list, the same walks, the same exports - and there is
// no demo *mode* anywhere: an `if (demo)` branch in rendering code is how invented data eventually
// gets shown as somebody's own. This flag exists so nothing talks to Zoho about it, and to say so.
const isSample = () => !!(bound && bound.sample);
// The one refusal every «open this in Zoho» navigation makes. A sample workspace has no Zoho org
// behind it, so a link built from its instance would open a URL that does not exist: refused with a
// reason rather than left to 404, because «nothing talks to the platform» has to be true of the
// navigations too, or it is not the claim the guide makes. It reads as `if (sampleRefuse()) return;`
// at each site - one sentence, in one place, instead of the same string copied at seven of them.
// Everything that reads or writes through Zoho asks this first, at the moment it would act. It used
// to be enough that the control was disabled or covered - which is protection by position on screen,
// and it held only until somebody put a Zoho-bound action somewhere nobody had thought about. One
// had already got out: a click on a row of the tree that is not downloaded yet fetches that function
// from Zoho, and nothing but the mismatch overlay stood in front of it. Reported as a rule rather
// than as a bug: «since Pull is disabled, everything that talks to Zoho should be».
function mismatchRefuse() {
  if (zohoReady()) return false;
  setStatus(MSG.mismatchRefused, 'warn');
  return true;
}
function sampleRefuse() {
  if (!isSample()) return false;
  setStatus(MSG.sampleNoOrg, 'warn');
  return true;
}
let treeData = [], nameMode = 'display', typeFilter = 'all', graphCache = null;
// The data centre to fall back on when the panel knows neither a workspace nor a tab. It is a
// display-only copy of a setting, so it is read into a URL and never written from here.
let zohoDc = 'zoho.com';
let connectionFilter = null, connFilterSet = null;   // when set, the functions tree shows only functions using that connection
let treeSort = 'name';        // 'name' keeps the namespace grouping; any other key sorts flat
let treeSortDir = 'asc';      // 'asc' | 'desc' - defaults per sort: A→Z for names, biggest-first for numbers
let currentPath = null;
let previewLoad = 0;
const previewCurrent = (mine, op) => mine === previewLoad && op.current();
// `viewMode` opens on whatever tab the user put first, decided once in renderTabs() the first time
// the row is drawn. It used to be hard-coded to 'functions', so reordering the tabs moved the
// segments and left the panel showing the same one it always had - the preference was honoured in
// the strip and ignored by the thing the strip is for. Null until that first render, never after.
let viewMode = null, moduleData = [], moduleFilter = 'all', moduleNameMode = 'display';
let searchMode = 'name', codeCache = null, _searchT = null;
let regexMode = false;          // the .* toggle: the search text read as a pattern, full-text mode only
let searchSeq = 0;              // every runSearch() bumps it, so a content search that finished late knows it
let workflowData = [], workflowFilter = 'all', wfIndex = new Map();
let scheduleData = [], scheduleFilter = 'all';
const collapsed = new Set();
const expandedMods = new Set();
let pullActive = false, pullBusy = false;

const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = '') => { noteStep(t); $('stxt').textContent = t; $('status').className = cls; showEmergency(false); };

// ---------- problem reports ----------
//
// Nothing here is sent by the extension. It builds a text, shows it to the reader in full, and -
// only on a click - opens zoost.it/report and writes the text **into that page**, through the DOM.
// It used to travel in the URL fragment, on the reasoning that a fragment is never transmitted to a
// server: true, and not the whole question, because the navigation itself is written to the
// browser's history and syncs with it. Nothing about the report is in any address now. The page
// shows it again, and the reader is the one who submits it. So «no telemetry, nothing automatic»
// stays true in the strong sense, and the report that does travel has been read twice by the person
// sending it.
//
// Two defences, because one is a promise and the other is a mechanism. The mechanism: what goes in
// comes from a **whitelist of known fields**, never from a sweep of state - a field added tomorrow
// is a decision, not an accident. The promise, kept honest by a test: free text passes `redact()`.

// Everything that is never collected. It was dead - declared here, read by nothing, while the
// comment claimed a test enforced it: a decoration wearing the clothes of a mechanism, found by an
// audit. `tests/panel.test.mjs` now reads this very array out of the source and checks that neither
// `reportFacts` nor `buildReport` mentions any of it, so the list and the check cannot drift.
const REPORT_NEVER = ['apiKey', 'apiKeyEnc', 'source', 'sql', 'code', 'name', 'displayName',
  'folderName', 'owner', 'org', 'instance', 'path', 'root'];

// Free text - an error message, a status line - with everything that could name your business
// taken out of it. Aggressive on purpose: a message can embed an org id, an instance, a function
// name in quotes. What it keeps is the *shape* of the sentence, which is what diagnoses.
// It cannot be proven exhaustive, and it is not the only defence: the whitelist above decides what
// is offered at all, the reader sees the result before sending, and the Worker redacts again.
// A declaration, byte-identical in both panels and in the report page: one text, one meaning.
function redact(text) {
  if (text == null) return { text: '', n: 0 };
  let n = 0;
  const out = String(text)
    // Ours, and the whole diagnostic value of a stack: kept, minus the extension id, which is noise.
    .replace(/chrome-extension:\/\/[a-z]+\//gi, '')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, () => { n++; return '<email>'; })
    .replace(/https?:\/\/[^\s)"']+/gi, () => { n++; return '<url>'; })
    .replace(/\b\d{8,}\b/g, () => { n++; return '<id>'; })
    .replace(/«[^»]*»/g, () => { n++; return '«…»'; })
    .replace(/"[^"]*"/g, () => { n++; return '"…"'; });
  return { text: out, n };
}

// Free text that this panel *interpolated names into*, treated as hostile. `redact()` is not enough
// for it and an audit proved it: the status line says `Synced: functions/Commissions/Recalc_Fees.dg`
// and `Working folder: <a client's name>`, and none of that is an email, a URL or a long number. The
// call sites are ~150 and nothing can constrain what one written tomorrow will interpolate, so this
// takes the opposite approach: anything shaped like an identifier, a path or a host goes, and what
// survives is the sentence around it - which is what actually diagnoses.
// It cannot be proven exhaustive. That is why the reader is shown the result and asked to read it,
// and why the wording on the site says «what it recognises», never «never».
function redactHard(text) {
  if (text == null) return { text: '', n: 0 };
  let n = 0;
  const hit = (mark) => () => { n++; return mark; };
  const out = String(text)
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, hit('<email>'))
    .replace(/https?:\/\/[^\s)"']+/gi, hit('<url>'))
    .replace(/[a-z]:\\[^\s"']*/gi, hit('<path>'))
    // A path, or a Zoho namespace: anything with a slash joining two names.
    .replace(/[\w.-]+(?:\/[\w.-]+)+/g, hit('<path>'))
    // Quoted, in every style the panels and the platform actually use - Chrome's own DOMException
    // messages quote with apostrophes, which the first version did not touch.
    .replace(/«[^»]*»|"[^"]*"|'[^']*'|[‘“][^’”]*[’”]|`[^`]*`/g, hit('«…»'))
    // No word boundary: an id glued to a prefix - `zcrm_349725000131663089` - kept its digits.
    .replace(/\d{6,}/g, hit('<id>'))
    // A host without a scheme, which the URL rule above never saw: `crm.zoho.eu`.
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi, hit('<host>'))
    // What is left of an identifier: dotted or underscored, which is what a function, a module api
    // name and a mirror filename all look like.
    .replace(/\b\w+[._]\w[\w._]*\b/g, hit('<name>'));
  return { text: out, n };
}

// The report as the reader will see it and as the page will re-render it: a pure function of an
// object nobody had to be trusted about. Every value it prints is either a number, a boolean, one
// of a fixed set of words, or free text that has been through `redact()`.
function buildReport(r) {
  const L = [];
  const red = { n: 0 };
  // Two levels, because the two kinds of text are not alike. The stack is ours by construction -
  // chrome-extension://<id>/sidepanel.js - so it keeps its file and line, which is the whole of its
  // value. Everything else was built by interpolating whatever was to hand, and is treated as such.
  const clean = (s) => { const o = redactHard(s); red.n += o.n; return o.text; };
  const ours = (s) => { const o = redact(s); red.n += o.n; return o.text; };
  L.push(`${r.product} ${r.version} · ${clean(r.browser)}`);
  L.push('');
  L.push('what happened');
  L.push(`  ${clean(r.message) || '(no message)'}`);
  if (r.stack) ours(r.stack).split('\n').slice(0, 12).forEach((s) => L.push(`  ${s.trim()}`));
  L.push('');
  L.push('state');
  L.push(`  tab: ${r.tab} · search: ${r.search} · pull: ${r.pullActive ? 'running' : 'idle'}`);
  L.push(`  workspace: ${r.sample ? 'the sample - invented data' : 'a real one'} · assistant: ${r.ai || 'not configured'}`);
  if (r.counts && Object.keys(r.counts).length) {
    L.push(`  counts: ${Object.entries(r.counts).map(([k, v]) => `${k} ${Number(v)}`).join(' · ')}`);
  }
  if (r.refused && r.refused.length) L.push(`  areas your Zoho role refused: ${r.refused.join(', ')}`);
  if (r.steps && r.steps.length) {
    L.push('');
    L.push('last steps, oldest first');
    r.steps.forEach((s) => L.push(`  ${clean(s)}`));
  }
  L.push('');
  L.push(`redactions: ${red.n} · no source, no SQL, no keys, and no file of yours was read to build this.`);
  L.push('Names, paths and ids are stripped where they are recognised - which is why you are being shown it.');
  return L.join('\n');
}

// The last lines the status bar said, in memory only - never written to disk, gone when the panel
// closes. Thirty because a failure is usually three or four steps after the thing that caused it,
// and a reader has to be able to read the whole buffer before deciding to publish it.
const REPORT_STEPS_MAX = 30;
const reportSteps = [];
function noteStep(text) {
  if (!text) return;
  const t = String(text);
  if (reportSteps[reportSteps.length - 1] === t) return;   // a progress line repeating itself
  reportSteps.push(t);
  if (reportSteps.length > REPORT_STEPS_MAX) reportSteps.shift();
}


// The pointer to zoost.it/emergency: a link that lives in the markup and is only ever shown or
// hidden. Nothing here is ever built from what Zoho answered, which is what keeps the status line
// safe to print a platform error into - it stays textContent, and the link stays static.
//
// Cleared by every status write and set again by the one failure path that should carry it, so it
// cannot linger over a later success. One place to clear, one place to set.
function showEmergency(on) { for (const id of ['emerg', 'repopen', 'repdismiss']) { const e = $(id); if (e) e.classList.toggle('on', !!on); } }
// Every sentence this panel says in more than one place. Not a translation layer and not a habit to
// extend to one-off wording: a message written out twice is two messages the moment somebody edits
// one of them, and that had already happened here - the same lapsed folder permission was reported
// as «needs re-granting», «denied» and «not granted» across ten sites, so the reader met three
// different problems where there was one. Naming the button is the point of the surviving wording:
// ↻ Refresh is the control that re-asks, and «denied» named a state with no action in it.
// A literal that appears once stays where it is used - a constant read by one caller is indirection
// with nothing to hold together. tests/panel.test.mjs enforces the rule in the other direction.
const MSG = {
  actNotHere: 'That action is not in this mirror - it may have been renamed or deleted in Zoho. Press Pull on Actions.',
  actNotPulled: 'Actions have not been pulled into this workspace yet - press Pull here first.',
  modNotHere: 'That module is not in this mirror - it may have been renamed or deleted in Zoho. Press Pull on Modules.',
  modNotPulled: 'Modules have not been pulled into this workspace yet - press Pull here first.',
  openInZoho: 'Open in Zoho \u2197',
  narrowNav: 'No step here matches that. Clear the box to see the whole chain.',
  copyFailed: 'Could not copy: ',
  loadingTree: 'Loading tree\u2026',
  noWorkspaceHere: 'Something changed in Zoho - no workspace is open here.',
  navGone: 'That step is not in this workspace any more.',
  wfNotHere: 'That workflow is not in this mirror - it may have been renamed or deleted in Zoho. Press Pull on Workflows.',
  wfNotPulled: 'Workflows have not been pulled into this workspace yet - press Pull here first.',
  schNotHere: 'That schedule is not in this mirror - it may have been renamed or deleted in Zoho. Press Pull on Schedules.',
  schNotPulled: 'Schedules have not been pulled into this workspace yet - press Pull here first.',
  openThis: 'Open this ',   // two places compose their own ending onto it
  mismatchRefused: 'The active tab is a different org from this workspace - nothing here reads Zoho until they match.',
  noTab: 'No Zoho CRM tab open.',
  folder: 'Folder access needs re-granting - click ↻ Refresh.',
  rootLater: 'The working folder changed in Settings - this panel will move to it when the pull finishes.',
  wrongTab: 'Active Zoho tab does not match this workspace.',
  lastModified: 'Last modified',
  sampleNoOrg: 'This is the sample workspace - there is no Zoho org to open.',
  noModuleTarget: 'Unknown module target - pull once, or open Zoho first.',
  noActionTarget: 'Zoho has no page for this kind that Zoost knows of - open it from the automation list.',
  staleBridge: 'The Zoho tab is still running an older copy of this extension - reload that tab, then pull again.',
  // The three status-dot tooltips, which say what a click will do rather than what the mark is.
  notHere: 'Not in workspace - click to download',
  hereRepull: 'In workspace - click to re-download from Zoho',
  failed: 'Failed: ',
  // The twin already had this name; the CRM had the string twice and nothing said so, because the
  // duplicate scanner had lost its place at a regex containing a quote further up the file and never
  // recovered. Fixing that regex is what made these two visible - a checker reading JavaScript
  // without parsing it can go blind for the rest of a file and still report zero.
  errPrefix: 'Error: ',
  clickRetry: ' - click to retry',
  // Prefixes, each concatenated with the platform's own sentence rather than replacing it.
  noFn: 'Function not found: ',
  readFailed: 'Read failed: ',
  graphErr: 'Graph error: ',
  exportErr: 'Export error: ',
  refreshErr: 'Refresh error: ',
  rereadErr: 'Could not re-read: ',
  namePrefix: 'Name: ',
  openingFns: 'Opening Functions list…',
  // Said by the toolbar button and by the one in a function's preview, which is why it has a
  // name: two copies of a sentence are two sentences waiting to drift apart.
  noTarget: 'Unknown target - pull this workspace once, or open Zoho manually.',
  findInCode: 'Find inside the code\u2026',
  findByName: 'Find by name…',
  // The health audit is drawn twice - the panel's view and the HTML export - and the titles are the
  // only part that has to agree word for word, because a reader moves between the two. The section
  // descriptions are deliberately shorter in the export and stay separate; this one is shared
  // because it carries the «length is verbosity» caveat, which may not be dropped from either.
  hBiggest: 'Largest functions',
  hChattiest: 'Most outbound calls',
  // Said by both groups that read from the platform: neither can distinguish «nothing to report»
  // from «never asked», so both refuse to imply the first.
  notReadYet: 'Nothing has been read yet - run Pull all, and this fills in.',
  hOrphan: 'Orphan candidates',
  hUnresolved: 'Unresolved calls',
  hAmbiguous: 'Ambiguous calls',
  hBroken: 'Broken automations',
  hMissingRefs: 'Missing module references',
  hBiggestDesc: 'By line count, longest first. Length is verbosity, not complexity - a long function is worth a look, not necessarily a problem.',
  // What a ranking of sizes was measured over. Both rankings, and the Markdown's size table, are
  // built by filtering on `n.stats` - which exists only for a function whose source is in the mirror.
  // A function the pull could not download simply was not there, so «the 15 biggest» was a ranking
  // over an unstated subset and could not say so at any size. The same sentence this project already
  // puts on the full-text search («searched 47/50 - absence is not exhaustive»), which had never been
  // carried to the one view whose whole subject is counting.
  hRankedOver: (ranked, all) => (ranked === all
    ? `Measured over all ${all} function(s) here.`
    : `Measured over ${ranked} of ${all} function(s): ${all - ranked} have no source in the mirror, so they cannot appear here at any size.`),
};
// A comparator over one field, with the `|| ''` the sites all carried: `.sort(byField('name'))`.
const byField = (k) => (a, b) => (a[k] || '').localeCompare(b[k] || '');
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// escHtml is NOT attribute-safe (it leaves " alone). Use escA inside an attribute value, or a
// double quote in the data closes it early and truncates - the trap that halved the getRelated snippet.
// Attribute-safe: `&`, `<`, `>`, and **both** quote characters. escHtml() does not escape quotes, and
// a quote inside an attribute closes it early - that is what cut the getRelatedRecords snippet in
// half. Escaping both quote styles means a reader never has to work out which one the attribute
// used, and the two graph windows already did it this way.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Already through `escHtml`, so `& < >` are encoded; what is left is the delimiter that decides
// where an attribute ends. `escA` cannot be used here - it encodes `&` too, and this value has been
// encoded once already, so the query string of every link the assistant writes would come out as
// `&amp;amp;`. Named rather than inline, because `tools/htmlcheck.py` reads the name to know an
// attribute is safe, and a check that cannot see the escaping is a check that will be argued with.
// The two delimiters written as escapes, not as themselves: a regex literal containing a quote is
// the trap this repository already records against `sliceConst`, and it bites every scanner that
// reads JavaScript without parsing it - the duplicate-message check and the slicer both lost their
// place on the first version of this line.
const escQ = (s) => String(s).replace(/[\u0022\u0027]/g, (c) => (c === '\u0022' ? '&quot;' : '&#39;'));
const sanitize = (s) => String(s).replace(/[^\w.\-]/g, '_');
// What the pull leaves so the next open does not have to read every meta. A cache beside the
// index, checked against the folder walk on every load - see rebuildTree().
const META_INDEX = 'functions/meta-index.json';
// The shape *and the reading* behind the summary. It goes up when what is written down stops being
// comparable with what this version would produce - and a mismatch discards the file wholesale,
// which is the cheapest honest answer: one slow open, then back to one read. It moved to 2 when the
// call extractor stopped counting names inside comments and strings, because every `refs` on disk
// was the previous reader's answer and nothing else would ever have said so.
// 4: `modulesUnknown` stopped meaning what a v3 file says it means - a call that names one module
// and computes the other used to count 0 unreadable destinations and now counts 1. A workspace
// indexed before that fix would have gone on serving the old number for ever, because nothing
// re-reads a source the summary already describes. Reported from a diff of the two paths:
// `{"fresh":1,"cached":0}`. **Changing what the extractor writes means moving this line, in the
// same commit** - the test below holds the readers to it, but only a person can know the meaning
// changed.
const SUMMARY_V = 5;   // 5 adds `listUpdated` per file; a 4 is re-derived from the folder rather than misread
const META_SV = 2;   // current function-meta schema version; functions on disk below this are "stale" and get re-fetched
/** Has Zoho's copy moved since this one was fetched?
 *
 * **Both arguments must come from the same source.** The org *list* reports `updatedTime` as epoch
 * milliseconds; a function's own *detail* reports it as «2026-03-13 11:20:59.0» in the org's
 * timezone. The first version of this compared one against the other with `!==`, which is true for
 * every function, for ever - shipped on 19 Aug 2026 and reported the next morning as «Refresh 1
 * outdated» that no pull could clear. So the sidecar stores the epoch it was fetched against, and
 * this compares epochs with epochs. Parsing the string instead would have worked on this machine and
 * failed for anyone whose browser sits in a different timezone from the org: the same defect, hidden.
 *
 * Absence on either side is not a measurement: a sidecar written before this field existed says
 * nothing about when it was fetched, and claiming freshness we cannot know is worse than silence.
 */
const movedInZoho = (listMs, fetchedMs) => !!(listMs && fetchedMs && Number(listMs) !== Number(fetchedMs));
// A deletion is a write: what was read from that path is no longer what is there. It goes through
// the same knowledge, so pruning a function Zoho no longer has drops it from the search and the
// diagram without the pull having to remember.
async function removeFileAt(root, path) {
  if (root !== dir) throw new Error(WS_MOVED);
  const parts = path.split('/'); const name = parts.pop();
  let d = root; for (const p of parts) d = await d.getDirectoryHandle(p);
  await d.removeEntry(name); noteWrite(path);
}
const removeFile = (path) => removeFileAt(dir, path);
// --- Attribution (set PRODUCT_URL to the Chrome Web Store URL once available) ---
const PRODUCT_NAME = chrome.runtime.getManifest().name;   // single source of truth: rename in manifest.json only
const PRODUCT_URL = 'https://zoost.it';

// Anything that is not Zoho opens in its own window, never a tab.
//
// chrome.tabs.create *activates* the new tab, so the panel suddenly finds itself looking at a
// non-Zoho page: the environment guard fires, the interface empties and the mismatch overlay
// appears. That behaviour is right when it means what it says, and here it meant nothing at all -
// the user clicked Help and the workbench looked like it had lost its place.
//
// Derived rather than listed: every link in the panel goes through here, and the only ones let
// through to a tab are Zoho's own, which are meant to land in the Zoho tab. A link added tomorrow
// is covered without anyone remembering.
// Zoho's own hosts, with or without a subdomain, and nothing that merely contains the word:
// `notzoho.com` and `evil.com/zoho.x` are not Zoho, and treating them as such would send them to
// the Zoho tab where the guard would then complain about a mismatch it did not cause.
// Zoho's own pages belong in the Zoho tab. It stays a rule about the domain rather than a list of
// granted hosts - a link to a Zoho page we do not read is still a Zoho page - and it had one
// blind spot: the Canadian data centre is `zohocloud.ca`, which is not literally «zoho.something»,
// so those links were opening in a window of their own.
function isZohoUrl(u) {
  return /^https?:\/\/(?:[^./?#]+\.)*(?:zoho\.com|zoho\.eu|zoho\.in|zoho\.com\.au|zoho\.jp|zohocloud\.ca|zoho\.sa|zoho\.uk|zoho\.ae)(?::\d+)?(?:[/?#]|$)/i.test(String(u || ''));
}

function openExternal(url) {
  try {
    chrome.tabs.query({ url }, (found) => {
      const t = found && found[0];
      // Best-effort and said so: focusing or opening a window is a courtesy, the outer catch
      // already falls back, and a rejection here costs the reader nothing. Declared with a
      // `.catch()` because an unhandled rejection is an omission and a written one is a
      // decision - the `try` around this could never have caught it, being a callback.
      if (t) { void chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        void chrome.tabs.update(t.id, { active: true }).catch(() => {}); return; }
      void chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 }).catch(() => {});
    });
  } catch (_) {
    void chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 }).catch(() => {});
  }
}
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href^="http"]');
  if (!a) return;
  if (isZohoUrl(a.href)) return;   // Zoho's own pages belong in the Zoho tab
  e.preventDefault();
  openExternal(a.href);
});

// Settings live in one window, and only ever one.
//
// `openOptionsPage()` opens a tab, and only de-duplicates within the *current* browser window -
// while the side panel is per window. Two browser windows, two settings tabs; over a working day,
// ten. That is not a tidiness problem: every one of them is a form holding a snapshot of the
// settings from the moment it opened, and saving an old one silently overwrites a newer one with
// stale values. It is the same trap as having the same Deluge function open in two tabs and being
// invited to "save your work" by the older of them.
//
// So: find any existing settings tab across all windows, focus it, and open a dedicated popup
// window only if there is none. Existing duplicates are focused, never closed - one of them may
// hold edits, and discarding those to enforce uniqueness would be committing the very mistake this
// prevents. They disappear as they are closed.
//
// Uniqueness by construction is still not enough on its own, which is why options.js also refuses to
// save over a value that changed underneath it. A window can be closed and reopened, the extension
// reloaded, and the panel itself writes some of these keys.
// `where` is a fragment - '#ai' from the assistant - so a reader sent to change one thing lands on
// it instead of at the top of a page about eight. An already-open settings window is focused *and*
// moved, because otherwise the second ask does nothing visible and reads as a broken button.
async function openSettings(where) {
  const url = chrome.runtime.getURL('options.html') + (where || '');
  try {
    const open = await chrome.tabs.query({ url: chrome.runtime.getURL('options.html') });
    if (open && open.length) {
      await chrome.windows.update(open[0].windowId, { focused: true });
      await chrome.tabs.update(open[0].id, { active: true, url });
      return;
    }
    await chrome.windows.create({ url, type: 'popup', width: 880, height: 900 });
  } catch (_) {
    chrome.runtime.openOptionsPage();   // whatever went wrong, the settings must still be reachable
  }
}

// Each app points at *its own* pages. Analytics shipped with the Help link hard-coded to the CRM
// guide, which is the kind of thing that only ever gets found by a user - so both are named here,
// once, and every surface derives from them instead of writing a path inline.
const PAGE_URL = PRODUCT_URL + '/crm.html';
const DOCS_URL = PRODUCT_URL + '/docs-crm.html';
const STORE_URL = 'https://chromewebstore.google.com/detail/flffecjpbmjfonhoojaiemgjanbjkmpj';
const CONTACT_EMAIL = 'ivan@zoost.it';
const REPO_URL = 'https://github.com/ivannot/zoost';
const SPONSOR_URL = 'https://github.com/sponsors/ivannot';
const KOFI_URL = 'https://ko-fi.com/ivannot';
const PRODUCT_AUTHOR = 'Ivan Notaristefano';
const PRODUCT_LICENSE = 'Apache License 2.0';
const LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';
const LEGAL_DISCLAIMER = 'Independent, unofficial tool. Not affiliated with, endorsed by, sponsored by or supported by Zoho Corporation. '
  + '"Zoho", "Zoho CRM" and "Deluge" are trademarks of Zoho Corporation, used here in a nominative sense only, to indicate compatibility. '
  + 'Licensed under the Apache License 2.0 and provided AS IS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. '
  + 'The author accepts no liability for any loss, damage or data issue arising from its use, and is under no obligation to provide support or maintenance. '
  + 'Deciding what may be extracted from Zoho CRM, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';

// ---------- export scope ----------
// Coarse on purpose: sections, never single modules. A per-module allow-list would be a
// permission system, and a permission system that is not enforced anywhere is theatre.
const SCOPE_KEYS = ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules', 'actions', 'addresses', 'connections', 'failures', 'health'];
// `addresses` is off in both, and that is the one default here that is a decision rather than a
// convenience: an export is a file you hand to somebody, and an address is the one thing in this
// mirror that belongs to a person rather than to a configuration. It is one tick away, and the
// report says how many it withheld so nobody reads a blank as an absence.
// `failures` was in SCOPE_KEYS and in neither preset, so the dialog drew its box and the default
// export left the chapter out - and pressing «Everything» *unticked* a box the reader had ticked,
// because the preset is assigned whole. A key in the list and not in the presets is a control that
// disagrees with itself. Found by a review; `tests/panel.test.mjs` now holds the three in step.
const SCOPE_FULL = { functions: true, code: true, modules: true, layouts: true, relations: true, workflows: true, schedules: true, actions: true, addresses: false, connections: true, failures: true, health: true };
const SCOPE_SAFE = { functions: true, code: false, modules: true, layouts: true, relations: true, workflows: false, schedules: false, actions: true, addresses: false, connections: true, failures: true, health: false };
// Which build wrote a stored preference. Declared *here*, above the default that stamps itself with
// it: a `const` used before its declaration is a temporal dead zone, and putting the stamp on
// `SCOPE_DEFAULT` while this sat forty lines below made the whole panel throw at load. Caught by the
// case that evaluates every shipped script - which exists because this class has shipped twice.
const SCOPE_SV = 2;
// **The sensitive section starts unticked, and that is a promise being kept rather than a taste.**
// The site, the README and §4.3 of the privacy policy all say the same thing - «the sensitive part is
// opt-in and flagged when selected» - and this line said the opposite: the first export a person ever
// made arrived with the whole Deluge source in it unless they noticed and cleared it. Found by an
// assistant reading the repository against the site, which is the check the front page now hands out.
// Everything else stays on: what is being defended is the source code, not the export's usefulness.
// **The stamp travels with the value.** `sv` says which build wrote a stored preference, and only the
// *reader* was writing it: so ticking the source code, exporting, and reopening turned it back off -
// the export wrote a scope with no stamp, and the next load read that as a preference from before the
// default changed and applied the one-shot migration again. Measured, in that order. Every object
// derived from this default now carries the stamp, and the migration still fires on a genuinely old
// value because it reads what was *stored*, not what was merged.
const SCOPE_DEFAULT = Object.assign({}, SCOPE_FULL, { code: false, sv: SCOPE_SV });
let expScope = Object.assign({}, SCOPE_DEFAULT);
// What the dialog is editing right now, and which of its boxes were cleared *for* the user because
// the data behind them is behind. Kept apart from expScope for one reason: the export dialog saves
// what you leave it with, so mutating the defaults to warn about staleness rewrote them - one
// export and the settings had silently lost Functions and Workflows. A transient warning must never
// become a stored preference. Same lost-update shape as two copies of the settings page.
let dlgScope = Object.assign({}, SCOPE_DEFAULT);
let dlgAutoCleared = new Set();
// **A preference saved before the default was fixed is cleared once, and only once.** The dialog used
// to open with the source ticked, so «code: true» in somebody's stored scope is at least as likely to
// be the old default as a decision - and the promise the site, the README and the privacy policy all
// make is that including it is a decision. So a scope with no `sv` has the sensitive section turned
// off, is written back stamped, and is never touched again: whatever the user chooses from then on
// stands, including turning it straight back on.
//
// Migration that deletes itself, as this repository asks: when nobody can still be carrying an
// unstamped scope, the three lines go and nothing else has to change.
async function loadScope() {
  try {
    const st = await chrome.storage.local.get('exportScope');
    if (!st || !st.exportScope) return;
    const saved = st.exportScope;
    if (saved.sv !== SCOPE_SV) {
      saved.code = false;
      saved.sv = SCOPE_SV;
      await chrome.storage.local.set({ exportScope: saved });
    }
    expScope = Object.assign({}, SCOPE_DEFAULT, saved);
  } catch (_) {}
}
// The tab preference, and the access verdicts recorded for the workspace that is open. Two sources
// because they are two different kinds of fact: what you chose (per install) and what Zoho allows
// (per org). Reading either must never throw the panel - a missing or malformed value just means
// "show everything", which is the state a first run is in anyway.
async function loadZohoDc() {
  try { const r = await chrome.storage.local.get('zohoDc'); if (r.zohoDc) zohoDc = r.zohoDc; } catch (_) {}
}
async function loadTabPrefs() {
  try {
    const st = await chrome.storage.local.get('tabPrefs');
    const p = st && st.tabPrefs;
    if (p && Array.isArray(p.order) && Array.isArray(p.hidden)) {
      tabPrefs = {
        order: p.order.filter((id) => TAB[id]),
        hidden: p.hidden.filter((id) => TAB[id]),
        // Absent in preferences saved before this existed: those said nothing about pulling, so the
        // honest reading is "pull everything", not "skip whatever happens to be hidden today".
        nopull: (Array.isArray(p.nopull) ? p.nopull : []).filter((id) => TAB[id]),
      };
    }
  } catch (_) {}
}
// Built locally and published in one go, because these two are read by every tab: emptying them
// before the first await meant an overtaken activation blanked the verdicts of the workspace that
// had already arrived, and then filled them in from the one being left.
async function loadAccess(op = beginWorkspaceOp()) {
  let access = {}, last = null;
  try {
    const cfg = await opReadCfg(op);
    if (cfg && cfg.access && typeof cfg.access === 'object') access = cfg.access;
    if (cfg && typeof cfg.lastPull === 'string') last = cfg.lastPull;
  } catch (_) {}
  if (!op.current()) return false;
  tabAccess = access; wsLastPull = last;
  publishAccess();
  return true;
}
// The settings page cannot read the workspace's `.zoost.json` - it has no folder handle and no
// business acquiring one - but it has to be able to say *why* a tab is off, or "hidden" becomes the
// silent state this whole change exists to avoid. So the panel publishes a copy for display.
//
// `.zoost.json` stays the authority: this is never read back into a decision, only into a sentence.
// It carries the workspace's name so the settings page can say which org the verdicts belong to,
// rather than implying they are universal.
function publishAccess() {
  // A copy for the settings page to read; the authority is `.zoost.json` in the workspace, and the
  // page re-reads on change. So a refused write leaves that page showing what it last saw, which is
  // the state it draws whenever it has not been told - not a wrong claim, an old one. Best-effort,
  // and declared: the `try` around this caught nothing, the call not being awaited.
  const w = (wsList || []).find((x) => x.id === activeWsId);
  void chrome.storage.local.set({ tabAccessView: { ws: (w && w.name) || null, access: tabAccess } })
    .catch(() => {});
}

// A bridge reply is a plain object, so rebuilding an Error from it drops `forbidden` unless it is
// carried across explicitly. Same boundary, same trap, third place it could have been lost: the
// content script raises it, the message channel flattens it, and this is where it becomes an Error
// again. Every `if (!r?.ok) throw …` in the pulls goes through here.
function bridgeError(r, fallback) {
  // **No answer at all is its own fact, and it has a sentence.** `chrome.tabs.sendMessage` resolves
  // `undefined` when nothing is listening - a reloaded tab, an extension that has just updated, a
  // frame the bridge never reached - and every caller passed its own internal word as the fallback,
  // so the reader was shown «Error: Error: unknown», «list failed», «pull failed». Four states, no
  // meaning, and `MSG.staleBridge` - which says the true thing and names the remedy - was reached
  // from one place. The twin has answered this with one sentence since it existed.
  const e = new Error(r ? ((r && r.error) || fallback) : MSG.staleBridge);
  e.status = (r && r.status) || 0;
  e.forbidden = !!(r && r.forbidden);
  return e;
}

// Record what Zoho answered for one area, in the workspace's own config. Per workspace, because a
// role is a property of an org: the same person can be an administrator in one and read-only in
// another, and a verdict carried between them would be a guess.
//
// The date is stored with it and shown, because "forbidden" is not a permanent truth - roles change,
// and a verdict from three months ago is a record of what was asked, not a fact about today. That is
// also why nothing here ever hides an area *without* an answer: no measurement means visible.
async function noteAccess(area, err, op) {
  // An **area**, not a tab. The two are nearly the same list and not quite: `failures` is pulled,
  // can be refused, and has no tab of its own - a failure is a property of a function, so it shows
  // in the function's detail and in the health view. This guard read `TAB[area]`, so every
  // `noteAccess('failures', ...)` returned before doing anything: the runtime chapter never
  // recorded when it was last read, and a role that had lost access to it was indistinguishable
  // from an org where nothing had failed. Two correct halves - a guard that refuses what it does
  // not know, and a caller reporting its own area - composing into a silent bail.
  if (!TAB[area] && !AREA_SCOPE[area]) return;
  // Written after a pull, which means after every await it made: without the op this records one
  // org's refusal in another org's `.zoost.json`, and the verdict is what later pulls skip on.
  if (op && !op.current()) return;
  const state = !err ? 'ok' : err.forbidden ? 'forbidden' : 'failed';
  const before = accessOf(area);
  const prev = tabAccess[area] || {};
  const nextAccess = Object.assign({}, tabAccess, { [area]: {
    state, status: (err && err.status) || 0,
    at: new Date().toISOString(),
    // `at` is when we asked; `pulledAt` is when we last actually got the data. They diverge the
    // moment an area stops being pulled, and that gap is the whole point: it is what makes a stale
    // section detectable instead of silently old.
    pulledAt: err ? (prev.pulledAt || null) : new Date().toISOString(),
  } });
  // Disk is the authority. Publishing the optimistic value first made a failed config write hide a
  // tab until the next reopen; publishing after an overtaken write put the old org's verdict beside
  // the new workspace. Keep the old in-memory answer unless the same operation commits the new one.
  try { await patchCfg({ access: nextAccess }, op); }
  catch (e) {
    if (op && !op.current()) return false;
    setStatus(`Could not record the ${tabLabel(area)} access state: ${(e && e.message) || e}`, 'bad');
    return false;
  }
  if (op && !op.current()) return false;
  tabAccess = nextAccess;
  publishAccess();
  if (before !== state && (before === 'forbidden' || state === 'forbidden')) renderTabs();   // the set of tabs just changed
  return true;
}

// What the user reads when an area is refused. Never the status line on its own: "403 on
// /crm/v2/settings/functions" reads as Zoost being broken, which is both alarming and wrong.
function pullFailMessage(area, e) {
  if (e && e.forbidden) {
    return `${tabLabel(area)}: your Zoho role does not grant access${e.status ? ` (Zoho answered ${e.status})` : ''}. `
      + 'Nothing was pulled for it, and the tab is hidden - Settings says why, and lets you check again.';
  }
  // Through `friendlyError` for the same reason as the Analytics twin: a pull is minutes of
  // network work and Chrome lets the folder permission lapse while it runs, so the last stage
  // throws `NotAllowedError: The request is not allowed by the user agent…` and this printed it
  // whole - a platform sentence naming neither the folder nor the button that fixes it.
  return `${tabLabel(area)} pull error: ${friendlyError(e)}`;
}

// The two halves of a failed pull, always taken together: record what Zoho answered for the area,
// then say it. Recording without saying leaves the user with a tab that vanished and no reason;
// saying without recording loses the verdict the next pull skips on. Six sites did both by hand.
async function notePullFailure(area, e, op) {
  // An overtaken pull ends in here, because the writer refused it. There is nothing true to say: the
  // verdict belongs to the folder we left and cannot be written to it, and the sentence would name
  // an area of an org the reader is no longer looking at. It stops, quietly.
  if (op && !op.current()) return;
  await noteAccess(area, e, op);
  setStatus(pullFailMessage(area, e), 'bad');
  // A role refusal is not a platform change and no release will fix it, so the pointer would be
  // sending the reader somewhere that cannot help. Everything else is «Zoho did not answer the way
  // this expects», which is exactly the case /emergency exists for.
  showEmergency(!(e && e.forbidden));
}

// After a full pull: one line naming the areas that were refused. Said once, plainly, rather than
// five separate alarms - and it has to be said, because the tabs have just silently gone away.
function forbiddenNote() {
  const off = TABS.map((t) => t.id).filter(isForbidden);
  if (!off.length) return '';
  return ` · ${off.length} area${off.length > 1 ? 's' : ''} not granted to your Zoho role (${off.map(tabLabel).join(', ')}) - hidden`;
}
function scopeToUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.checked = !!dlgScope[k]; });
  const e = $('sc_code'); if (e) e.disabled = !dlgScope.functions;
  const l = $('sc_layouts'); if (l) l.disabled = !dlgScope.modules;
  $('scwarn').textContent = dlgScope.code ? '\u26a0 includes full source code' : '';
}
function scopeFromUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) { if (!!e.checked !== !!dlgScope[k]) dlgAutoCleared.delete(k); dlgScope[k] = !!e.checked; } });
  if (!dlgScope.functions) dlgScope.code = false;
  if (!dlgScope.modules) { dlgScope.layouts = false; dlgScope.relations = false; }
  scopeToUI();
}
// Which export sections come from which pulled area. Not a lookup for its own sake: it is what lets
// the dialog say "this box is off because that data is four months old" instead of quietly offering
// a report whose Connections chapter is from February and looks exactly as current as the rest.
const AREA_SCOPE = {
  functions: ['functions', 'code'],
  modules: ['modules', 'layouts', 'relations'],
  workflows: ['workflows'],
  schedules: ['schedules'],
  actions: ['actions', 'addresses'],
  connections: ['connections'],
  failures: ['failures'],
};

// The areas, which is what `AREA_SCOPE` has always been the list of: the tabs, plus the ones with no
// tab of their own. Everything about freshness walks this rather than `TABS`, because an area
// without a tab is still pulled and can still be behind - `failures` was in this table from the
// day it was written and reached by nothing, since all three walks started from the tabs.
const AREA_IDS = Object.keys(AREA_SCOPE);
// The name a reader sees for an area. From the tab where there is one, and from the id itself
// otherwise - derived rather than a second table, so it cannot drift out of step with the first.
const areaLabel = (id) => (TAB[id] ? TAB[id].label : id.charAt(0).toUpperCase() + id.slice(1));

// Sections whose data is behind are cleared when the dialog opens, and why is written next to them.
// Cleared rather than removed: an old chapter is sometimes exactly what you want, so the choice
// stays yours - but it has to be a choice, and the default has to be the safe one. If you tick it
// back on, the report carries that section's own date, so the reader is told too.
//
// This makes the export follow the pull settings without a second set of switches to keep in step.
// Two lists that must agree are two lists that will not.
function scopeStaleNote() {
  const behind = AREA_IDS.filter(areaStale);
  const box = $('scstale');
  if (!box) return;
  if (!behind.length) { box.textContent = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = behind.map((id) =>
    `<div><b>${escHtml(areaLabel(id))}</b> - ${escHtml(areaAsOf(id))}, because ${escHtml(staleReason(id))}. `
    + 'Unticked; tick it to include it anyway and the report will carry that date.</div>').join('');
}
/** What the keyboard can reach while a dialog is up.
 *
 * The scrim is a painted div at z-index 85: it stops the pointer and nothing else. The dialog traps
 * no focus and the background was not inert, so Shift+Tab from an open «What goes into the export»
 * reaches **Export** behind it and Enter asks the same question again - which overwrites the one
 * resolver `askScope` has and abandons the first promise for the life of the panel.
 *
 * `inert` on the two roots rather than a focus trap: it is the platform's own answer, it covers
 * click, focus, Tab and the accessibility tree in one attribute, and it needs no bookkeeping to undo
 * beyond setting it back. The dialogs and the scrim sit outside `#wrap`, so nothing that has to stay
 * reachable is inside what is switched off.
 */
function panelInert(on) {
  // Derived, never named: everything the page is made of except the scrim and the dialogs
  // themselves. The first version listed two ids and **neither existed** - a helper written from
  // memory of a layout, which would have set `inert` on nothing at all and passed every check that
  // only reads the calls. Found by grepping the markup for the names it had invented.
  [...document.body.children].forEach((el) => {
    if (el.id === 'scrim' || el.classList.contains('dlg')) return;
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  });
}
let _scopeResolve = null;
function askScope() {
  return new Promise((resolve) => {
    // The slot holds one question. Overwriting it left whatever was waiting on the older one waiting
    // for the life of the panel, having shown nothing - it had not reached `op.say` yet, so there was
    // no status line to go stale and nothing at all on screen. Settled as «cancelled», which is what
    // it became.
    if (_scopeResolve) _scopeResolve(null);
    _scopeResolve = resolve;
    dlgScope = Object.assign({}, expScope);
    dlgAutoCleared = new Set();
    AREA_IDS.forEach((id) => { if (areaStale(id)) AREA_SCOPE[id].forEach((k) => { if (dlgScope[k]) { dlgScope[k] = false; dlgAutoCleared.add(k); } }); });
    scopeToUI();
    scopeStaleNote();
    $('scrim').classList.add('on'); panelInert(true); $('expscope').classList.add('on');
  });
}
function closeScope(ok) {
  $('scrim').classList.remove('on'); panelInert(false); $('expscope').classList.remove('on');
  const r = _scopeResolve; _scopeResolve = null;
  if (r) r(ok ? Object.assign({}, dlgScope) : null);
}
function showAbout() {
  $('aboutbody').innerHTML =
    `<div><b>${escHtml(PRODUCT_NAME)}</b> \u00b7 v${escHtml(chrome.runtime.getManifest().version)}</div>`
    + `<div style="color:var(--muted)">Created by ${escHtml(PRODUCT_AUTHOR)} (with the support of Claudio)</div>`
    + `<h4>Links</h4><div><a href="${escA(PRODUCT_URL)}" target="_blank" rel="noopener">zoost.it</a> \u00b7 <a href="${escA(PAGE_URL)}" target="_blank" rel="noopener">What it does</a> \u00b7 <a href="${escA(DOCS_URL)}" target="_blank" rel="noopener">How to use</a> \u00b7 <a href="${escA(PRODUCT_URL)}/privacy.html" target="_blank" rel="noopener">Privacy</a> \u00b7 <a href="${escA(STORE_URL)}" target="_blank" rel="noopener">Web Store</a> \u00b7 <a href="${escA(REPO_URL)}" target="_blank" rel="noopener">Source</a> \u00b7 <a href="mailto:${escA(CONTACT_EMAIL)}">${escHtml(CONTACT_EMAIL)}</a></div>`
    + `<h4>Support</h4><div>${SPONSOR_URL ? `<a href="${escA(SPONSOR_URL)}" target="_blank" rel="noopener">GitHub Sponsors</a>` : ''}${SPONSOR_URL && KOFI_URL ? ' \u00b7 ' : ''}${KOFI_URL ? `<a href="${escA(KOFI_URL)}" target="_blank" rel="noopener">\u2615 Ko-fi</a>` : ''}</div>`
    + `<h4>Licence</h4><div><a href="${escA(LICENSE_URL)}" target="_blank" rel="noopener">${escHtml(PRODUCT_LICENSE)}</a> \u00b7 \u00a9 2026 ${escHtml(PRODUCT_AUTHOR)}</div>`
    + `<h4>Legal</h4><div class="legal">${escHtml(LEGAL_DISCLAIMER)}</div>`
    // **«Sends nothing anywhere» stopped being true the day the assistant shipped**, and this dialog
    // went on saying it while the store copy, the site and the twin panel were all corrected. The
    // twin's wording is the one that survived that argument, so this is the twin's wording with this
    // product's own nouns - and both now name the report page, which neither did.
    + `<h4>Your data</h4><div class="legal">The mirror stays between your browser, your Zoho session and the local folder you picked. `
    + `Zoost has no server of its own. <b>The one exception is the AI assistant</b>: when you use it, the parts of the org it needs - function names and their Deluge source, module and field names including the values inside a picklist, workflow and schedule names, what an automation action does - the field it writes and the value, the email template it sends, a webhook's method and host - the name Zoho records as having last changed a function or a connection, connection names with their connectors and scopes, and what Zoho reports about failed runs - are sent directly from your browser to the provider you configured, and to no one else. `
    + `Records are never sent, because Zoost never reads them. Leave the assistant unconfigured and nothing leaves this machine, except a problem report you write, read in full and send yourself. `
    + `Exports are written to your workspace folder - what happens to them afterwards is up to you.</div>`;
  $('scrim').classList.add('on'); panelInert(true); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); panelInert(false); $('aboutdlg').classList.remove('on'); }

// ---------- filesystem ----------
// Which function files this panel has rewritten since the summary was last trusted.
//
// `functions/meta-index.json` describes files *by path*, and the folder walk that checks it sees
// paths appearing and disappearing - not a file whose bytes changed while its name stayed the same.
// So a pull that refreshes a function in place, or a save picked up from Zoho, would leave the
// summary describing the previous source: the tree would show the old date, and the diagram the old
// calls. Found by a review that asked for the invariant to be *proved* rather than assumed, and it
// did not hold.
//
// The fix is where the review put it first: at the point where we write. Every write through here
// marks its function, the next load re-reads exactly those and writes the summary out again, and the
// set is cleared when it has. No fingerprint, no second read to check a first one - we know what we
// wrote, because we wrote it.
//
// What this cannot see is somebody else's write: an editor, a `git checkout`, a file copied in. That
// is what ↻ Refresh is for, and it now drops the summary entirely rather than trusting it.
// Two readings, two writers, two sets. `.meta.json` is described by `saveMetaIndex()` and `.dg` by
// `saveGraphFacts()`, and they finish at different moments - one is a single write at the end of the
// tree load, the other happens whenever the diagram is built. One set for both meant the first
// writer declared the second one's work done: `saveMetaIndex()` cleared the mark while the graph
// build, started and deliberately not awaited, was still walking the folder. The ordering happened
// to be favourable, which is not the same as being correct - and an outside review said exactly
// that. Each set is now cleared by the writer that actually refreshed it, path by path, so a file
// rewritten *during* a build stays marked.
let _dirtyMeta = new Set();
let _dirtySource = new Set();
const _dirtyByRoot = new WeakMap();
function switchDirtyWorkspace(nextRoot) {
  if (dir) _dirtyByRoot.set(dir, { meta: _dirtyMeta, source: _dirtySource });
  const saved = nextRoot && _dirtyByRoot.get(nextRoot);
  _dirtyMeta = saved ? saved.meta : new Set();
  _dirtySource = saved ? saved.source : new Set();
  if (nextRoot && !saved) _dirtyByRoot.set(nextRoot, { meta: _dirtyMeta, source: _dirtySource });
}
/** ↻ Refresh: read every file again.
 *
 *  It is the answer to the write this panel cannot see - an editor, a `git checkout`, a folder
 *  synced from another machine - and it is what lets the summary be cheap the rest of the time.
 *
 *  It marks rather than raising a flag. A flag would have needed a moment to be lowered, and the
 *  only honest moment is «when every file has been read again», which is two different events for
 *  the metas and the sources - and would never arrive at all on a workspace where the diagram is
 *  never built. Marking every known path uses the machinery that already exists, and each writer
 *  gives up its own marks as it describes them. One mechanism, no lifetime to reason about. */
// Refresh says «read every file again», and it used to mean «re-read the rows this panel happens to
// be holding» - which are the functions tree's, filled only by a load of that tab. Open the panel on
// Modules, let an editor or a `git checkout` change a `.dg`, press Refresh: nothing was marked,
// nothing was re-read, and the control that exists to answer the write we cannot see did nothing
// and said nothing. Reported, and the marks were never the right instrument: they name paths, and
// what the reader is distrusting is the whole summary.
//
// So it is a state of the *load* rather than a set of paths. The two readers below treat the file as
// absent for one pass, which re-reads every meta and every source from disk, and the flag is put
// down when the tree load that honoured it finishes - not before, or a second load started in the
// middle would trust what the first has not yet rewritten.
// The sidecars this load could not open. Emptied by the load that fills it, and reported by the
// line that closes it: «read» and «could not read» are two facts and the second was silent.
let unreadableMetas = [];
let distrustSummary = false;
function distrustEverything() {
  distrustSummary = true;
  treeData.forEach((r) => { if (r.path) { _dirtyMeta.add(r.path); _dirtySource.add(r.path); } });
}
/** What a write means for everything read from that file and still held in memory.
 *
 *  This used to mark the summary and nothing else, and the six things made out of mirror files and
 *  kept in memory were each dropped by whoever remembered to at the call site. Counted rather than
 *  assumed: two were right and **four were not**. `syncOne` - the panel following a save made in
 *  Zoho - cleared the diagram and left `in: code` searching the text from before the edit;
 *  `resyncModule` left the assistant holding the field list it had replaced a second earlier; the
 *  actions pull rebuilt «which rule fires this» and forgot the catalogue beside it; the workflows
 *  pull changed the answer to «which rule fires this» and rebuilt nothing at all. None of them is a
 *  bug you can see: the mirror on disk is right in every case, and the panel is confidently out of
 *  date about it. The two that were right were right by luck - nothing would have said otherwise.
 *
 *  So the mapping from «what was written» to «what must be forgotten» lives here, at the one point
 *  every write and every deletion passes through, and a new write path inherits it without knowing
 *  it exists. `tests/panel.test.mjs` holds the shape - no cache of file contents may be cleared
 *  anywhere else - and `tools/probe.py` proves them in a browser, each one red on the defect put
 *  back. */
const noteWrite = (rel) => {
  if (isModuleFile(rel)) { graphCache = null; moduleFilesCache = null; aiConnCache = null; return; }
  // The index is what says which names are modules of this org, so a pull that rewrites it changes
  // every module reading the panel is about to resolve.
  if (rel === 'modules/index.json') { modNamesCache = null; graphCache = null; aiConnCache = null; return; }
  if (rel === 'connections/index.json') { aiConnCache = null; return; }
  if (rel === 'actions/index.json') { aiActCache = null; return; }
  // Which rule uses which action is read out of the rules themselves, so a workflows pull changes
  // the answer - and the actions pull was the only one that rebuilt it.
  if (rel.startsWith('workflows/')) { actionUsers = null; aiActCache = null; return; }
  // The runtime reading. `failIndex` was dropped at one call site - inside `pullFailures`, and only
  // when the reader happened to be standing on the Functions tab - so pulling from any other tab left
  // the panel holding the pre-pull numbers while the export, which reads the file, printed the new
  // ones. The rule this file already states: invalidation derives from the write, never from the
  // memory of whoever caused it, or the next write path added inherits nothing.
  if (rel.startsWith('failures/')) { failIndex = null; healthData = null; return; }
  if (!rel.startsWith('functions/')) return;
  if (rel.endsWith('.meta.json')) _dirtyMeta.add(rel.replace(/\.meta\.json$/, '.dg'));
  // `aiConnCache` rides with `graphCache` in **every** branch that drops it, not only where its
  // own source moved. A module write cannot change which functions use a connection, so one of
  // the three is redundant - and the redundancy costs rebuilding a small map from a graph that
  // is being rebuilt anyway, while the alternative is a per-branch judgement that has to be made
  // correctly again every time a branch is added. This file already chose that trade.
  //
  // `aiConnCache` too, and it was not. What it holds is «which functions use this connection»,
  // built by walking the graph's nodes - so it is as much a reading of the sources as `graphCache`
  // is, and a pull that changed one function left `get_connection` answering «used by 3» from the
  // cache while the graph would have said 4. The rule this function states in its own comment two
  // branches up: invalidation derives from the write, never from the memory of whoever caused it.
  else if (rel.endsWith('.dg')) { _dirtySource.add(rel); _dirtyMeta.add(rel); codeCache = null; graphCache = null; aiConnCache = null; }
};
// The folders, remembered. Every read and every write resolved `functions/<namespace>/` from the
// root again - two calls to the browser's file system before the one that does the work - so half of
// what a pull and a load spend is asking for the same directory over and over. Measured: writing a
// function cost 8 calls, of which 4 were this.
//
// Handles are per working folder, so the cache is dropped whenever that changes; a stale handle is
// worse than a slow one, and this is the kind of cache that has to be given up eagerly rather than
// checked. `removeEntry` drops it too, since a folder that has just been deleted must not be handed
// back by us.
// Keyed on the root, not one map for whichever folder is current. It walked from `dir`, awaited each
// step, and then wrote what it found into the *global* cache - so a resolution that started in one
// workspace and finished after a switch filled the new workspace's cache with the old one's handles,
// and the next lookup there answered without ever asking that folder. Reproduced in both panels: a
// path resolved in B came back holding A's handle with zero calls to B.
//
// A cache per root cannot say the wrong thing about the other one: the entry goes where it was read
// from. Handles still have to be given up eagerly rather than checked - a stale one is worse than a
// slow one - so a switch drops everything and `removeEntry` drops everything, since a folder that
// has just been deleted must not be handed back by us.
let _dirCaches = new WeakMap();
const forgetDirs = (root) => { if (root) _dirCaches.delete(root); else _dirCaches = new WeakMap(); };
async function dirFor(parts, create, root = dir) {
  if (!root) throw new Error('No workspace folder is open.');
  let cache = _dirCaches.get(root);
  if (!cache) _dirCaches.set(root, (cache = new Map()));
  const key = parts.join('/');
  // The cache answers for writes too: a folder that has been created once exists, and asking the
  // browser to create it again is the call this exists to avoid. Skipping the cache when `create`
  // was set left a pull paying full price for every file it wrote - half of the eight calls each.
  if (cache.has(key)) return cache.get(key);
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, create ? { create: true } : undefined);
  cache.set(key, d);
  return d;
}
async function ensurePerm(h) { const o = { mode: 'readwrite' }; if ((await h.queryPermission(o)) === 'granted') return true; return (await h.requestPermission(o)) === 'granted'; }
async function hasPerm(h) {
  return (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
}
// The guard every pull, graph and export opens with. It throws rather than returning false, so the
// caller's own `catch` writes the message: the nine sites that used it were already a `try` block
// each, and a helper that returned a boolean would have left the `throw` copied at all nine.
// Callers that instead want to report and carry on keep their own `ensurePerm`, and say MSG.folder:
// the wording no longer varies by call site, so a wrapper like «Export error: …» is the only thing
// that differs between one report of a lapsed permission and another.
async function requirePerm(h) { if (!(await ensurePerm(h))) throw new Error(MSG.folder); }
// The workspace an operation belongs to, taken once and carried - not read out of a global after
// every await. A pull lists from Zoho, waits, and then writes: `dir` at that moment is whatever the
// panel is showing *now*, so a switch part-way through put one org's functions, modules and layouts
// into another org's folder, and the guards that existed checked once and let the writes after them
// through. Measured, in both panels.
//
// So the root is a parameter of the I/O and the check lives in the one place every write passes
// through, rather than being remembered at each call site - the same move as `noteWrite`. `current()`
// is what a caller asks before spending effort; the writer refuses regardless, which is what makes
// the class impossible instead of merely unlikely.
const WS_MOVED = 'The workspace changed while this was running - nothing further was written to it.';
function beginWorkspaceOp() {
  const gen = wsGen, root = dir;
  const current = () => gen === wsGen && root === dir;
  // The refusal is the op's, not the file writer's. `writeFileAt` compares handles, and a handle is
  // not an identity through time: leave a workspace and come back to it and the same object is
  // current again, so an operation from before the round trip passed the check while `current()`
  // said false. Both halves, both sides of the await - the workspace can move while the browser is
  // inside `createWritable()` as easily as between two calls.
  const guard = () => { if (!current()) throw new Error(WS_MOVED); };
  async function through(fn) { guard(); const v = await fn(); guard(); return v; }
  return {
    root, gen, current,
    read: (p) => through(() => readFileAt(root, p)),
    write: (p, body) => through(() => writeFileAt(root, p, body)),
    remove: (p) => through(() => removeFileAt(root, p)),
    // Progress belongs to a workspace as much as a write does. Reported: a pull started in one org
    // kept counting «Downloading 214/900» into the panel after the user had opened another workspace,
    // so the work looked like it was happening *there*. It says nothing once it is not there.
    say: (msg, kind) => { if (current()) setStatus(msg, kind); },
  };
}
async function writeFileAt(root, rel, content) {
  if (root !== dir) throw new Error(WS_MOVED);
  const parts = rel.split('/');
  const d = await dirFor(parts.slice(0, -1), true, root);
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable(); await w.write(content); await w.close();
  noteWrite(rel);
}
async function readFileAt(root, rel) {
  const parts = rel.split('/');
  const d = await dirFor(parts.slice(0, -1), false, root);
  const fh = await d.getFileHandle(parts[parts.length - 1]);
  return (await fh.getFile()).text();
}
// The shorthands every render path uses: they read and write the workspace on screen, which is the
// one they mean. A path that survives an await must take an op instead.
const writeFile = (rel, content) => writeFileAt(dir, rel, content);
const readFile = (rel) => readFileAt(dir, rel);
async function* walk(d, prefix = '') {
  for await (const [name, h] of d.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') yield* walk(h, prefix + name + '/'); else yield prefix + name;
  }
}
async function readCfg() {
  try { return JSON.parse(await readFile(CFG)); } catch { return null; }
}
// The same read, through an operation's own workspace. `.zoost.json` is the file that says which org
// a folder mirrors, so a pull that reads it out of whichever folder is on screen can publish the
// other one's identity as its own.
async function opReadCfg(op) {
  try { return JSON.parse(await op.read(CFG)); } catch { return null; }
}
async function writeCfg(o, op) {
  return op ? op.write(CFG, JSON.stringify(o, null, 2)) : writeFile(CFG, JSON.stringify(o, null, 2));
}
// Merge rather than replace. `.zoost.json` now holds more than the binding - the access verdicts
// below live there too - and a whole-object write from any one writer silently drops what the others
// put in it. This is the `cacheBinding` trap in CLAUDE.md, arriving a second time with a new field.
// The op reaches here because `.zoost.json` is the file that says which org this folder mirrors:
// written into the wrong one, two workspaces answer to the same id and only a hand edit separates
// them again. It is optional, so the render paths that mean the folder on screen are unchanged.
async function patchCfg(o, op) {
  return writeCfg(Object.assign({}, (op ? await opReadCfg(op) : await readCfg()) || {}, o), op);
}

// ---------- tabs ----------
//
// One registry. The five tabs used to be spelled out in the markup, in five `.active` toggles, in
// five click handlers and in two label maps - which is why they could never be reordered and why a
// sixth would have to be remembered in eight places. Everything that varies per tab is here; the
// segment row is built from it.
//
// `area` is what a pull and a permission verdict are keyed on. It matches the tab id today, and is
// kept as its own field because the two are different ideas: a tab is a thing you look at, an area
// is a thing Zoho may refuse.
// The registry lives in tabs.js, which the settings page reads too - it was written twice and the
// second copy did not learn about Actions. Actions is one tab with a Kind filter rather than four,
// because notifications, field updates, tasks and webhooks answer one question and share one shape:
// the same decision the Analytics panel takes for its seven view types.
const TABS = window.ZOOST_TABS;
const TAB = Object.fromEntries(TABS.map((t) => [t.id, t]));
const tabLabel = (id) => (TAB[id] ? TAB[id].label : id);

// What the user chose: which tabs to show and in what order. A preference, stored per install and
// not per workspace - unlike the access verdicts, which are a property of one org's roles.
let tabPrefs = { order: TABS.map((t) => t.id), hidden: [], nopull: [] };
// What Zoho answered, for the workspace currently open: area -> { state, status, at }.
// 'ok' | 'forbidden' | 'failed'. Empty until a pull has actually asked.
let tabAccess = {};

const accessOf = (id) => (tabAccess[id] && tabAccess[id].state) || null;
// When an area was last read. Falls back to the workspace's own `lastPull` for anything mirrored
// before per-area dates existed: those folders hold real, current data and simply carry no record.
// Reading "no measurement" as "behind" is the inversion this project forbids everywhere else, and
// here it had teeth - it silently unticked Functions and Workflows in the export dialog, so a report
// quietly came out smaller than the user asked for.
//
// Where it must err, it errs towards *not* flagging: an over-stated freshness is visible, because
// both reports print the per-area dates whether or not anything is behind. A section dropped from a
// report is not.
let wsLastPull = null;
const pulledAt = (id) => (tabAccess[id] && tabAccess[id].pulledAt) || wsLastPull || null;

// Staleness is derived, never declared. An area is behind if the mirror holds newer data for
// something else - which is true whether it was excluded from the pull, refused by Zoho, or simply
// failed, and stays true without anyone having to remember to set a flag. The margin exists because
// a full pull writes its areas seconds apart and that is not a difference worth reporting.
const STALE_MARGIN_MS = 6 * 60 * 60 * 1000;
function newestPull() {
  return AREA_IDS.map(pulledAt).filter(Boolean).sort().slice(-1)[0] || null;
}
function areaStale(id) {
  const newest = newestPull(); if (!newest) return false;      // nothing pulled yet: nothing is behind
  const mine = pulledAt(id);
  if (!mine) return true;                                       // never pulled, while others have been
  return Date.parse(newest) - Date.parse(mine) > STALE_MARGIN_MS;
}
// The words a user reads. Never "stale" on its own - a date they can act on, and the reason.
function areaAsOf(id) {
  const mine = pulledAt(id);
  if (!mine) return 'never pulled';
  const d = new Date(mine);
  return 'as of ' + (isNaN(d) ? mine : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
}
function staleReason(id) {
  if (isForbidden(id)) return 'your Zoho role no longer grants it';
  if (!isPulled(id)) return 'you excluded it from Pull all';
  return 'the last pull did not refresh it';
}
const isForbidden = (id) => accessOf(id) === 'forbidden';
const isHiddenByUser = (id) => tabPrefs.hidden.includes(id);
// Hiding a tab and skipping its pull are separate on purpose, but they are not equally likely: most
// people who turn a tab off do it because they cannot read that area anyway, and leaving it in the
// pull chain then buys nothing but an error per pull. So the flag exists and it defaults to
// following the tab - hide one and its pull goes with it unless you say otherwise, because the
// alternative is a setting that is right for the ninth user out of ten and silently wrong for the
// other nine.
const isPulled = (id) => !tabPrefs.nopull.includes(id);
// The order is the preference's, with anything the preference has never heard of appended - so a
// tab added in a later version appears instead of vanishing for everyone who has saved a setting.
function tabOrder() {
  const known = tabPrefs.order.filter((id) => TAB[id]);
  return known.concat(TABS.map((t) => t.id).filter((id) => !known.includes(id)));
}
// A tab is shown unless the user hid it or Zoho refused the area. Both make it *absent*, not
// disabled: a control that can never do anything is noise, and a greyed one claims there is
// something here you cannot have. The reason is never lost - it is stated after a pull and again in
// Settings, which is where hiding stops being silent.
const visibleTabs = () => tabOrder().filter((id) => !isHiddenByUser(id) && !isForbidden(id));

// ---------- Zoho tab / bridge ----------
async function tabHasCrmFrame(id) { try { const r = await chrome.tabs.sendMessage(id, { cmd: 'context' }); return !!(r && r.ok && r.origin); } catch (_) { return false; } }
async function zohoTabId() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && ZOHO_HOST_RE.test(active.url || '')) return active.id;
  if (active && (await tabHasCrmFrame(active.id))) return active.id;   // wrapper (e.g. Zoho One) with a CRM iframe
  const tabs = await chrome.tabs.query({ url: ZOHO_MATCHES });
  return tabs[0]?.id ?? null;
}
async function activeZohoTabId() {
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!a) return null;
  if (ZOHO_HOST_RE.test(a.url || '')) return a.id;
  return (await tabHasCrmFrame(a.id)) ? a.id : null;                   // wrapper-agnostic detection
}
/** The frame that is Zoho CRM, or `null` when this tab has none.
 *
 * **`null` and not `0`, which is the whole finding.** `ZOHO_HOST_RE` accepts `one.zoho.*` so the
 * panel can tell which Zoho One org a tab belongs to - and on a Zoho One page with no CRM iframe
 * (the launcher, Mail, the home) the search below found nothing and fell back to frame 0, the Zoho
 * One document itself. `ensureBridge` then injected `hook.js`, which replaces `fetch` and
 * `XMLHttpRequest` in that page's MAIN world, and the content bridge beside it.
 *
 * Three things wrong with that, and the third is the one that matters. `one.zoho.*` is in
 * `host_permissions` but declares no content script, so the injection is permitted and undeclared.
 * The bridge refuses every command from a non-CRM origin, so it never answers, so `ensureBridge`
 * caught the failure and **re-injected every five seconds** for as long as that tab stayed active.
 * And `site/privacy.html` says of those hosts, in as many words, «which it does not read».
 *
 * A tab with no CRM frame has nothing for the bridge to talk to. It is refused rather than guessed
 * at. The one case that still answers 0 is the honest one: the enumeration itself failed, and the
 * tab's own top frame is CRM.
 */
// **A cache repeats an answer; this one was repeating a failure.** The lookup is memoised for six
// seconds so the five-second poll does not enumerate a tab's frames every time - and the first
// version stored `null` on the same terms. A Zoho One page is a single-page application: while the
// shell is creating or replacing the CRM iframe, an enumeration that lands in that instant finds no
// CRM frame, and «there is no CRM frame here» was then true for six seconds over a tab that had one.
// The panel showed «Zoho tab (not ready)» for a cycle, at intervals nobody could predict - reported
// from a real Zoho One org as the button being disabled «randomly», which is the word this
// repository treats as an instruction to go and look rather than to guess.
//
// So only a *found* frame is remembered. A miss costs one `executeScript` on the next poll, which is
// what it cost before anything was cached at all, and it cannot outlive the moment that produced it.
/** Which of several same-origin candidates is the CRM application, decided by asking them.
 *
 * A suite shell puts more than one document on `crm.zoho.<dc>` in the same tab - measured: two of
 * thirteen - and only one of them is the application the bridge lives in. Nothing about the order the
 * frame list comes back in says which. So each candidate is asked the one question whose answer is
 * self-validating: `context` is refused by the bridge unless the origin is CRM *and* an instance
 * resolved, so a frame that answers is the frame.
 *
 * All at once rather than in turn: they are cheap, they are bounded by the message channel itself,
 * and asking six frames one after another would put the panel's own poll behind them. A frame with
 * no listener rejects immediately - measured at 1ms - so the wait is the real one's round trip.
 *
 * `null` when none answers, which is the honest answer and the one `crmFrameId` records as a miss.
 */
async function answeringFrame(tabId, frameIds) {
  const asked = await Promise.all(frameIds.map((frameId) => askFrame(tabId, frameId)));
  console.info(`[zoost] frames asked [${asked.map((x) => x.frameId + ':' + x.why).join(' ')}]`);
  const ok = asked.find((x) => x && x.ok);
  return ok ? ok.frameId : null;
}
async function askFrame(tabId, frameId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { cmd: 'context' }, { frameId });
    // Four answers, not two, and the difference is the whole diagnosis. `no-listener` means the
    // bridge is not in that frame and injecting is the repair; `declined` means it is there and the
    // frame is not the application; `half` means it named itself without an org, which is the shape
    // that produced a *wrong* identity rather than none. Reported as one word - «not ready» - for all
    // of them, which is why three attempts at this bug went to three different causes.
    return { frameId, ok: !!(r && r.ok && r.instance && r.org),
             why: !r ? 'declined' : r.ok ? (r.instance && r.org ? 'ok' : 'half') : 'refused' };
  } catch (_) {
    return { frameId, ok: false, why: 'no-listener' };
  }
}
// The CRM-origin frames this tab has, whether or not any of them answered. **`null` from
// `crmFrameId` means two different things** and `ensureBridge` has to tell them apart: «this tab has
// no CRM document, so nothing here is ours to inject into» - the Zoho One page itself, which
// `privacy.html` says we do not read - and «it has CRM documents and none of them has our bridge
// yet», which is exactly when injecting is the right act. Conflating the two is a defect I wrote
// this afternoon and the instrument found within the hour: with several CRM frames and none
// answering, the panel stopped injecting and could never come alive, on a tab whose CRM was there.
let _crmCandidates = { tabId: null, ids: [] };
let _crmFrame = { tabId: null, frameId: 0, ts: 0 };
let _crmFrameSeen = '(not enumerated)';
async function crmFrameId(tabId) {
  const now = Date.now();
  if (_crmFrame.tabId === tabId && _crmFrame.frameId !== null && now - _crmFrame.ts < 6000) return _crmFrame.frameId;
  let fid = null;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => ({ href: location.href, top: window === window.top }) });
    const seen = (res || []).map((r) => ({ frameId: r.frameId, ...(r.result || {}) }));
    const crm = seen.filter((x) => /^https:\/\/crm(sandbox)?\.zoho/.test(x.href || ''));
    // **More than one frame can be on the CRM's origin, and choosing by position chose wrong.**
    // Measured on a real Zoho One tab: thirteen frames, two of them `crm.zoho.<dc>`, and this took
    // `crm[0]` - the first the enumeration happened to return. It was the wrong one; the panel asked
    // it and was refused in a millisecond, every tick, which is «Zoho tab (not ready)» on a tab whose
    // CRM was right there. The shell builds several frames and the order they come back in is not a
    // fact about which of them is the application.
    //
    // So the frame is not *chosen*, it is the one that **answers**. The bridge already refuses every
    // origin that is not CRM and every document with no instance resolved, so it selects itself -
    // there is no rule here about which position is the right one, which is the only kind of answer
    // this project accepts. The top frame is still preferred when there is one, because a plain CRM
    // tab has exactly that and asking it is a round trip nobody needs.
    const top = crm.find((x) => x.top);
    _crmCandidates = { tabId, ids: crm.map((x) => x.frameId) };
    if (top) fid = top.frameId;
    else if (crm.length === 1) fid = crm[0].frameId;
    else if (crm.length) fid = await answeringFrame(tabId, _crmCandidates.ids);
    // What was actually there, in the order it was seen. An intermittent report is a *sequence*, and
    // this repository has paid for the lesson that sampling at chosen instants is not measuring: five
    // changes were made to a scroll bug before anybody wrote down what happened in what order, and
    // every one of them was wrong. One line per enumeration, hosts only - no path, because a path
    // carries a portal name and a record id and this line ends up pasted into a chat.
    _crmFrameSeen = seen.map((x) => `${x.frameId}:${(x.href || '').split('/').slice(0, 3).join('/')}`).join(' ');
  } catch (_) {
    // The enumeration is the thing that failed, not the tab. A CRM tab's own document is frame 0,
    // and that is the only case where guessing it is not a guess.
    try {
      const t = await chrome.tabs.get(tabId);
      if (/^https:\/\/crm(sandbox)?\.zoho/.test((t && t.url) || '')) fid = 0;
    } catch (_) {}
  }
  // Only a hit is remembered. Recording the miss is what made a transient absence last six seconds.
  if (fid !== null) _crmFrame = { tabId, frameId: fid, ts: now };
  return fid;
}
/** Speak to the bridge, and put it there if it is not.
 *
 * **Asking and injecting are different acts and only one of them is dangerous.** The first version of
 * this fix refused both when no CRM frame was found, and that broke the case it was not about: with
 * the frame list unavailable, the panel stopped *asking* too, so the context bar went from naming the
 * org to «Zoho tab (not ready)» - visible in thirteen of the site's screenshots, which is how it was
 * caught. Asking costs nothing and is refused by the bridge itself when the origin is not CRM;
 * injecting is what puts our code into somebody else's page.
 *
 * So: ask wherever there is a frame to ask, and inject only where a CRM document actually is.
 */
async function ensureBridge(tabId) {
  const fid = await crmFrameId(tabId);
  const to = fid === null ? {} : { frameId: fid };
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'context' }, to); return true; }
  catch {
    // Every CRM-origin frame this tab has, not one of them. A shell builds several and only one is
    // the application; injecting into the one that happened to come first left the others without a
    // bridge, so the frame that *would* have answered never could. They are all on a host this
    // extension declares a content script for, so this is the declaration being applied rather than
    // a reach into anything new - and a frame that is not the application is refused by the bridge
    // itself, which is what makes «ask them all» safe.
    const ids = _crmCandidates.tabId === tabId ? _crmCandidates.ids : (fid === null ? [] : [fid]);
    // No CRM frame in this tab: nothing here is ours to inject into. See `crmFrameId`.
    if (!ids.length) return false;
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: ids }, world: 'MAIN', files: ['hook.js'] });
      await chrome.scripting.executeScript({ target: { tabId, frameIds: ids }, files: ['content-bridge.js'] });
      console.info(`[zoost] bridge injected into [${ids.join(' ')}]`);
      await sleep(60);
      // The lookup was made before any of this existed, so its answer - very likely `null` - is about
      // a tab that has since changed. Forget it and let the next caller ask the frames that are now
      // listening; remembering it is the «cache repeats a failure» defect one level up.
      _crmFrame = { tabId: null, frameId: 0, ts: 0 };
      return true;
    } catch (e) {
      // A refused injection said nothing at all, and «nothing happened» and «Chrome refused» look the
      // same from the panel: both end as «not ready». The message is what tells them apart.
      console.info(`[zoost] bridge injection REFUSED for [${ids.join(' ')}]: ${(e && e.message) || e}`);
      return false;
    }
  }
}
async function toBridge(msg) {
  // The last line, below every disabled control and every guard above it. The panel speaks to the
  // tab that is open, so a command that is not the context probe must not travel while that tab is a
  // different org from the workspace this panel is bound to - whatever removed the `disabled`, and
  // whoever called the function directly. `context` is how the mismatch is detected in the first
  // place, so it is the one thing that always goes; and a panel with nothing bound yet is creating
  // its first workspace, which is not a mismatch.
  if (msg && msg.cmd !== 'context' && bound && !guardOk()) throw new Error(MSG.mismatchRefused);
  const id = await zohoTabId(); if (!id) throw new Error(MSG.noTab);
  await ensureBridge(id); const fid = await crmFrameId(id);
  // `null` is «this tab has no Zoho CRM frame», and it is now a possible answer: ask the tab rather
  // than name a frame that is not there. The bridge refuses a non-CRM origin by itself, so the worst
  // this can do is go unanswered - which is the same as any other tab that is not ready.
  const at = fid === null ? {} : { frameId: fid };
  // The identity travels with the command and is checked *in the page that will run it*. Everything
  // above this line is a check against `lastCtx`, which is a five-second poll's memory of which org
  // the tab was showing - and between reading it and reaching the tab there are three awaits. So the
  // last word belongs to the only party that cannot be out of date about which org it is.
  const expected = (msg && msg.cmd !== 'context' && bound)
    ? { org: bound.org, origin: bound.base, instance: bound.instance } : null;
  return chrome.tabs.sendMessage(id, expected ? { ...msg, __zoostExpected: expected } : msg, at);
}
async function getContext() { try { const r = await toBridge({ cmd: 'context' }); return r?.ok ? r : null; } catch { return null; } }
async function waitTabComplete(id, timeout = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { const t = await chrome.tabs.get(id); if (t.status === 'complete') return true; } catch { return false; } await sleep(200); }
  return false;
}

// ---------- context bar + off-zoho overlay ----------
let contextLoad = 0;
let _ctxErr = null;
async function refreshContext() {
  const mine = ++contextLoad;
  const current = () => mine === contextLoad;
  const ctxEl = $('ctx'), who = $('who'), bnd = $('bound');
  const activeId = await activeZohoTabId();
  if (!current()) return;
  if (!activeId) {                         // the ACTIVE tab is not Zoho
    lastCtx = null; $('mmbar').classList.remove('show'); updateWsButtons();
    // Not over a sample. A sample has nothing to say to Zoho, so a Zoho tab is not a precondition
    // for reading it - and covering the panel there would mean the one workspace anybody can open
    // without an account is the one you cannot open without one. Reported.
    // `sampleBusy` belongs here and not only at the click. This panel re-derives its whole state on
    // a five-second poll, so anything set imperatively on top of that is undone by the next tick -
    // reported as the overlay coming back in the middle of writing the sample and then leaving
    // again. A state that has to hold across time is a term in the condition, never an assignment.
    $('offoverlay').classList.toggle('show', !isSample() && !sampleBusy);
    ctxEl.className = 'offzoho'; who.innerHTML = 'Not on a Zoho tab';
    bnd.innerHTML = bound ? `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)}` : '';
    blockZoho(true);
    return;
  }
  $('offoverlay').classList.remove('show');
  await ensureBridge(activeId);
  if (!current()) return;
  const cfid = await crmFrameId(activeId);
  if (!current()) return;
  const _t0 = Date.now();
  // A Zoho One tab with no CRM frame in it has nothing to read, and asking would mean naming a frame
  // that is not there. Same answer as a tab that did not reply - no context - and it **falls through**
  // rather than returning: the line below is what puts «Zoho tab (not ready)» on screen, and a return
  // here would leave the previous tab's identity showing. Which is the silent exit this repository
  // refuses, one line from being written by the fix for a different one.
  try {
    const r = await chrome.tabs.sendMessage(activeId, { cmd: 'context' }, cfid === null ? {} : { frameId: cfid });
    if (!current()) return;
    lastCtx = r?.ok ? r : null;
  } catch (e) { if (!current()) return; lastCtx = null; _ctxErr = (e && e.message) || String(e); }
  // No instance name: this line is written to be pasted into a chat, and the instance is the
  // customer's own portal. Whether it answered is the whole diagnostic value; who answered is not.
  // `info` and not `debug`: Chrome's console hides the Verbose level by default, so an instrument
  // written with `console.debug` is one the person reproducing the fault cannot see. An instrument
  // nobody can read is not an instrument.
  // The sequence, one line per tick, in the order things happened. «Not ready» is a *state the panel
  // arrives at*, and until now the only record of arriving at it was the words on screen - which say
  // that it happened and nothing about why. Whoever reads this next has the tab, the frames that
  // were there, the frame we asked, and what the answer was.
  console.info(`[zoost] ctx tab=${activeId} frames=[${_crmFrameSeen}] asked=${cfid === null ? 'any' : cfid}`
    + ` -> ${lastCtx ? 'ok' : 'NOT READY' + (_ctxErr ? ' (' + _ctxErr + ')' : '')}`
    + ` ${Date.now() - _t0}ms`);
  _ctxErr = null;
  if (!lastCtx) { ctxEl.className = 'offzoho'; who.innerHTML = 'Zoho tab (not ready)'; bnd.textContent = ''; blockZoho(true); updateWsButtons(); return; }
  // On a sample workspace the tab half is true and irrelevant: the tab really is on that org, and
  // this folder has nothing to do with it. Saying so is better than leaving the two halves side by
  // side implying a relationship - reported as «switching to the test org leaves ZOHO TAB on the
  // previous one», which it does, correctly, and read as a bug because nothing said it did not matter.
  who.innerHTML = `<span class="rlbl remote">Zoho tab</span><b>${escHtml(lastCtx.instance || '?')}</b> <span>· org ${escHtml(lastCtx.org || '?')} · ${envOf(lastCtx.origin)}${isSample() ? ' · not related to the sample' : ''}</span>`;
  if (!bound) { ctxEl.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">not bound yet</span>'; }
  else if (guardOk()) { ctxEl.className = 'match'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✓`; }
  else if (isSample()) { ctxEl.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">sample - generated, never pulled</span>'; }
  else { ctxEl.className = 'mismatch'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>≠ ${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✗`; }
  // The discrepancy is stated in both cases, and the sample is one of them. Suppressing the bar for
  // it was wrong: reading invented data while looking at a real org is exactly what this bar is for,
  // and one muted line in the workspace half is too quiet to carry it. Reported.
  //
  // What differs is the **blocking**, and only that. A real mismatch can be resolved - one of the
  // two is wrong - and browsing until it is would mean reading org A's mirror while looking at org
  // B. A sample is never going to match anything, everything Zoho-bound is already refused for it,
  // and blocking it would make it unusable the whole time a Zoho tab is open - which is always.
  // So: say it, do not stop it.
  const sampleMm = !!(bound && lastCtx && isSample());
  const mm = !!(bound && lastCtx && !guardOk() && !isSample());
  const mmbar = $('mmbar');
  mmbar.classList.toggle('show', mm || sampleMm);
  mmbar.classList.toggle('soft', sampleMm);
  if (mm) { $('preview').classList.remove('show'); $('resizer').classList.remove('show'); }
  if (mm || sampleMm) {
  // **The sample is a state the user chose, and it was being announced like an accident.** Three
  // sentences on one screen said the same fact - the status line's «not related to the sample», the
  // workspace chip's «sample - generated, never pulled», and a full paragraph in the bar - and the
  // bar then offered a full-width «Create workspace for ...», which is the control the workspace row
  // already carries and has enabled in exactly this state. One fact three times, one action twice.
  //
  // What the bar alone was carrying is the *reason*: `guardOk()` is false for a sample, so Pull is
  // disabled, and nothing else on screen says why. So it keeps that and loses the rest - one line,
  // no call to action. A real mismatch is unchanged: that one is accidental, it can be resolved, and
  // the two buttons are how.
    $('mmtext').textContent = sampleMm
      ? `Sample workspace - invented data. Pulling is off: nothing here comes from \u00ab${lastCtx.instance || '?'}\u00bb (org ${lastCtx.org}), and nothing here can reach it.`
      : `Zoho tab \u00ab${lastCtx.instance || '?'}\u00bb (org ${lastCtx.org}) \u2260 local workspace \u00ab${wsShown(bound)}\u00bb (org ${bound.org}). Pulling is off until they match; what is already mirrored stays readable.`;
    // «Switch tab» is meaningless for a sample: there is no Zoho org to switch to.
    $('mmgo').style.display = sampleMm ? 'none' : '';
    $('mmgo').textContent = `Switch tab \u2192 \u00ab${wsShown(bound)}\u00bb \u2197`;
    $('mmgo').onclick = () => switchTab();
    const match = (wsList || []).find((w) => w.id !== activeWsId && w.binding && w.binding.org === lastCtx.org && (!w.binding.base || !lastCtx.origin || w.binding.base === lastCtx.origin));
    const sw = $('mmsw'); sw.style.display = sampleMm ? 'none' : '';
    if (match) { sw.textContent = `Switch workspace \u2192 \u00ab${wsShown(match)}\u00bb`; sw.onclick = () => { $('ws').value = match.id; activate(match, true); }; }
    else { sw.textContent = `Create workspace for \u00ab${lastCtx.instance || '?'}\u00bb`; sw.onclick = () => addWorkspaceForTab(); }
  }
  // inhibit all Zoho-bound operations unless the active tab matches the workspace (tab-navigation stays allowed)
  blockZoho(!zohoReady());
  blockZoho(pullBusy || !zohoReady() || !dir || navOpenNow());   // a pull in progress - or the history view - keeps them blocked even as the 5s refresh runs
  updateWsButtons();
}
function guardOk() {
  // Everything Zoho-bound funnels through here, so this is the one place a sample workspace has to
  // be refused - rather than a condition repeated at each button, where one of them is eventually
  // forgotten. It is not a mismatch, though, and refreshContext keeps the two apart: the mismatch
  // bar and its overlay are for two environments that could match, and this one never will.
  if (isSample()) return false;
  // A workspace with no binding yet is creating its first one, and there is nothing to compare
  // against. A workspace that *is* bound and has no context is a different statement: it means the
  // destination has not been verified, and returning true there let a command go to whatever Zoho
  // tab `zohoTabId()` happened to find. «Do what you're certain of, or stop.»
  if (!bound) return true;
  if (!lastCtx) return false;
  if (bound.org !== lastCtx.org) return false;                                   // different org
  if ((bound.base || '') !== (lastCtx.origin || '')) return false;               // different host/env
  if (bound.instance && lastCtx.instance && bound.instance !== lastCtx.instance) return false; // different specific (sandbox) instance
  return true;
}

// ---------- tree ----------
const labelOf = (e) => (nameMode === 'display' ? (e.display_name || e.api_name) : (e.api_name || e.display_name));
// Filter the functions tree to those that use a given connection (built from the pulled function
// metadata). This is the "which/how many functions use connection X" answer, reusing the tree.
async function filterByConnection(name) {
  // Overtaken (WS_MOVED) means the filter no longer applies and silence is right. Everything else -
  // an unreadable folder, a source that will not parse - is a real failure, and swallowing it made
  // the click do nothing and say nothing about a workspace that was still there. Only the one
  // expected error is expected.
  let g; try { g = await ensureGraph(); }
  catch (e) { if ((e && e.message) === WS_MOVED) return; setStatus('Could not build the graph: ' + ((e && e.message) || e), 'bad'); return; }
  if (!tabReachable('functions')) return;   // filtering a list you have put away is a jump like any other
  connFilterSet = new Set(Object.values(g.nodes).filter((n) => (n.connections || []).some((c) => c.name === name)).map((n) => n.file));
  connectionFilter = name;
  if (viewMode !== 'functions') setMode('functions'); else renderTree();
}
function clearConnectionFilter() { connectionFilter = null; connFilterSet = null; renderTree(); }
// One row builder, shared by the grouped and the sorted-flat rendering, so the two cannot drift.
function fnRowEl(e) {
  const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path; el.dataset.id = e.id || '';
  el.setAttribute('aria-selected', e.path === currentPath);
  const stCls = e.error ? 'st-err' : e.stale ? 'st-stale' : e.downloaded ? 'st-ok' : 'st-no';
  const stCh = e.error ? '⟳' : e.stale ? '◐' : e.downloaded ? '●' : '○';
  const stTitle = e.error ? (MSG.failed + (e.errorMsg || 'unknown') + MSG.clickRetry) : e.stale ? 'Older data (no connections / author) - click to refresh' : e.downloaded ? MSG.hereRepull : MSG.notHere;
  // Every trailing slot is always emitted, empty when it has nothing to say. A slot that disappears
  // lets the next one slide into its place, and then the numbers stop lining up down the list -
  // which is the whole point of having them there.
  const st = e.stats;
  const restSlot = `<span class="rest rr">${e.rest ? 'REST' : ''}</span>`;
  const nsSlot = treeSort !== 'name'   // flat sorting drops the namespace headers, so the row carries it
    ? `<span class="rest rn" title="${escA(e.namespace || '')}">${escHtml((e.namespace || '').slice(0, 4))}</span>` : '';
  const lineSlot = `<span class="rest rfl"${st ? ` title="${st.lines} lines · ${st.codeLines} code lines · ${(st.chars / 1024).toFixed(1)} KB"` : ''}>${st ? st.lines + 'L' : ''}</span>`;
  const callSlot = `<span class="rest rc"${st && st.apiCalls ? ` title="${st.apiCalls} outbound call(s): ${st.invokeurl} invokeurl · ${st.crm} zoho.crm · ${st.zoho} other Zoho service${st.sendmail ? ' · ' + st.sendmail + ' sendmail' : ''}"` : ''}>${st && st.apiCalls ? st.apiCalls + '↗' : ''}</span>`;
  el.innerHTML = `<span class="st ${stCls}" title="${escA(stTitle)}">${stCh}</span><span class="fname">${escHtml(labelOf(e))}</span>${restSlot}${nsSlot}${lineSlot}${callSlot}`;
  // Both go through a declaration, because a `.then(cb)` is a scope the race checker cannot enter -
  // and this callback redraws a row after an await, which is the exact shape it exists to look at.
  el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); void fetchThenRedrawRow(e); };
  el.onclick = () => { if (e.downloaded) openFromTree(e.path); else void fetchThenRedrawRow(e); };
  return el;
}

/** Fetch one function's source, then bring its row and the «missing» count up to date.
 *
 * The redraw is deliberately unguarded and always runs: `updateRow` writes into the element it was
 * given, which either is still in the document or is not, and `updateMissingButton` re-reads the
 * tree it finds. A guard here would have to name a workspace, and the row already carries the only
 * identity that matters - itself.
 */
async function fetchThenRedrawRow(e) {
  await runPullAction(() => downloadOne(e));
  updateRow(e);
  updateMissingButton();
}

// Sorting by a number answers a different question from browsing by namespace, so a numeric sort
// drops the grouping and goes flat, highest first. Descending only: these are "which are the big
// ones" questions, and an ascending list of the smallest functions answers nothing anyone asks.
const TREE_SORTS = {
  name: null,
  lines: { label: 'lines', get: (e) => (e.stats ? e.stats.lines : -1) },
  calls: { label: 'outbound calls', get: (e) => (e.stats ? e.stats.apiCalls : -1) },
  size: { label: 'size in bytes', get: (e) => (e.stats ? e.stats.chars : -1) },
  modified: { label: 'last modified', get: (e) => (e.updatedTime ? (Date.parse(String(e.updatedTime).replace(' ', 'T')) || 0) : -1) },
};
function renderTree() {
  if (viewMode !== 'functions') return;
  // A content search owns the list while it is active. Every caller that repaints the tree - a
  // pull's progress, a live save, a chip, the name toggle, a tab switch restoring its stash -
  // would otherwise draw the *name* view under a box still searching code, which is how a regex
  // came back from a tab round-trip as «No matches.» over the names. Reported. Debounced through
  // the same timer as typing, so a paint storm during a pull coalesces into one search.
  if (searchMode === 'content' && $('find').value.trim()) {
    clearTimeout(_searchT); _searchT = setTimeout(contentSearch, 220);
    return;
  }
  const term = $('find').value.trim().toLowerCase();
  const shown = treeData
    .filter((e) => typeFilter === 'all' || (typeFilter === 'rest' ? e.rest : e.namespace === typeFilter))
    .filter((e) => !connFilterSet || connFilterSet.has(e.path))
  // A function carries **three** names and Zoho means a different thing by each: `display_name`
  // («LearningObjects - Upsert User DELETE»), `api_name` (a lowercased slug), and `name` - the
  // CamelCase one you actually write in Deluge as `namespace.Name(...)`. The filter checked two of
  // them, so searching for the name you had just copied out of a call found nothing. Reported.
  // Which one is *shown* is the reader's choice (Name: display / api); which ones are *searched* is
  // not a choice at all - all of them, or the box lies about what is in the workspace.
    .filter((e) => !term || FN_NAMES.some((k) => String(e[k] || '').toLowerCase().includes(term)));
  const tree = $('tree'); tree.innerHTML = '';
  if (connectionFilter) {
    const b = document.createElement('div'); b.className = 'connbanner';
    b.innerHTML = `<span><b>${shown.length}</b> function(s) use <b>${escHtml(connectionFilter)}</b></span><span class="connclear" title="Clear filter">✕</span>`;
    b.querySelector('.connclear').onclick = clearConnectionFilter;
    tree.appendChild(b);
  }
  // "No matches." is right only when there was something to match. With nothing pulled - or with the
  // folder access lapsed - it is the least useful sentence available.
  if (!shown.length) {
    const m = document.createElement('div'); m.className = 'empty';
    m.innerHTML = treeData.length ? '<b>No matches.</b>'
      : (emptyReason() || '<b>Nothing pulled yet.</b> Press <b>Pull all</b> to mirror this org.');
    tree.appendChild(m); return;
  }
  const sorter = TREE_SORTS[treeSort];
  if (sorter) {
    const dir = treeSortDir === 'asc' ? 1 : -1;
    const list = shown.slice().sort((a, b) => {
      const va = sorter.get(a), vb = sorter.get(b);
      // Rows with no data yet stay at the bottom whichever way we sort: ascending would otherwise
      // open the list with the functions we know nothing about.
      if ((va < 0) !== (vb < 0)) return va < 0 ? 1 : -1;
      if (va !== vb) return dir * (va - vb);
      return labelOf(a).localeCompare(labelOf(b));
    });
    const noData = list.filter((e) => sorter.get(e) < 0).length;
    const hdr = document.createElement('div'); hdr.className = 'srhdr';
    hdr.textContent = `${list.length} function(s) by ${sorter.label}, ${treeSortDir === 'asc' ? 'lowest' : 'highest'} first`
      + (noData ? ` · ${noData} without data (not downloaded yet)` : '');
    tree.appendChild(hdr);
    list.forEach((e) => tree.appendChild(fnRowEl(e)));
    return;
  }
  const byNs = {}; shown.forEach((e) => { (byNs[e.namespace] ||= []).push(e); });
  Object.keys(byNs).sort().forEach((ns) => {
    const list = byNs[ns].sort((a, b) => (treeSortDir === 'asc' ? 1 : -1) * labelOf(a).localeCompare(labelOf(b)));
    const isCol = collapsed.has(ns);
    const g = document.createElement('div'); g.className = 'grp' + (isCol ? ' collapsed' : '');
    g.innerHTML = `<span class="chev">▾</span><span>${escHtml(ns)}</span><span class="cnt">${list.length}</span>`;
    g.onclick = () => { isCol ? collapsed.delete(ns) : collapsed.add(ns); renderTree(); };
    tree.appendChild(g);
    if (isCol) return;
    list.forEach((e) => tree.appendChild(fnRowEl(e)));
  });
}
// Which load is the current one. A refresh, a change of workspace or a pull can overtake one that
// is still reading tranches; without a token the two interleave and the older one writes its rows
// over the newer one's.
let treeLoad = 0;


/** Fold one sidecar into the row the index already drew, or leave that row as it was.
 *
 * A declaration and not an `async (mp) => {}` inside a `map`, which is a scope the race checker
 * cannot enter - and every line here writes into the panel's picture of a workspace after an await.
 * Everything it touches is passed in: `op` owns the folder, and the three maps belong to the pass
 * that built them, so a second load starting underneath this one cannot have its rows refined by it.
 */
async function refineRowFromMeta(mp, op, byPath, byId, index) {
  try {
    const meta = JSON.parse(await op.read(mp));
    const dg = mp.replace(/\.meta\.json$/, '.dg');
    // By path, then by id - both from a Map. The second lookup used to be a `treeData.find()`,
    // which is linear, and it fires exactly when the two disagree: a file whose name the index
    // does not predict. On a workspace of five thousand that turned the load into twenty-five
    // million comparisons - forty seconds of them - while a hundred functions never noticed.
    // Measured on a generated org, which is the only place a cliff like that shows up before a
    // user finds it.
    const row = byPath.get(dg) || byId.get(String(meta.id));
    if (!row) return;
    // Found by id at another path: the function was renamed in Zoho, so the file on disk is the
    // *old* pair. Marking it downloaded - which this did - meant the new path was never fetched
    // and the old pair never pruned (its id is still live, so the pull's prune keeps it).
    row.pathChanged = row.path !== dg;
    row.previousPath = row.pathChanged ? dg : null;
    row.downloaded = !row.pathChanged;
    // Three reasons to re-fetch, each its own fact: an older sidecar schema, a rename, and a
    // source that changed in Zoho while nobody was watching - the list's `updatedTime` against
    // the sidecar's. Absence on either side is not a measurement and marks nothing.
    row.stale = row.pathChanged || (meta.sv || 0) < META_SV
      || movedInZoho(row.listUpdated, meta.listUpdated);
    row.fetchedAgainst = meta.listUpdated || null;
    row.updatedTime = meta.updatedTime || null;
    row.namespace = meta.nameSpace || row.namespace;
    if (meta.display_name) row.display_name = meta.display_name;
    const known = index.get(String(meta.id));
    if (known) { known.category = meta.category; known.source = meta.source; known.name = meta.name; }
  } catch (e) {
    // A meta that will not parse leaves its row as the index described it - and **the failure is
    // counted**, because it used to be swallowed whole: with every read failing (a file locked by a
    // sync client, an I/O error) the tree drew 120 rows all marked «in workspace» and the status line
    // closed green with «120 functions (120 downloaded)». A mirror that cannot be read is not a
    // healthy one, and the twin has said so by name since it existed.
    unreadableMetas.push(mp);
  }
}

async function rebuildTree() {
  // Before anything that can yield. Whether another task could actually clear these marks in the
  // window between the permission check and here is the sort of question nobody should have to
  // answer while reading: the snapshot goes first, and then there is nothing to answer.
  const dirtyMeta = new Set(_dirtyMeta);
  if (!dir) return;
  const op = beginWorkspaceOp();
  if (!(await ensurePerm(op.root))) { op.say(MSG.folder, 'warn'); return; }
  const mine = ++treeLoad;
  const current = () => mine === treeLoad && op.current();
  // This load's own tally of what it could not open - emptied here, read by the line that closes it.
  unreadableMetas = [];
  op.say(MSG.loadingTree, 'busy');
  graphCache = null; moduleFilesCache = null; aiConnCache = null;
  const _cfg = await opReadCfg(op); if (_cfg && current()) bound = _cfg; await cacheBinding(bound);
  if (!current()) return;

  // ---- 1. the index draws the tree ---------------------------------------------------------------
  // One read. It lists every function, downloaded or not, with the fields a row shows - so the panel
  // is usable before a single meta has been opened.
  let idx = null; try { idx = JSON.parse(await op.read('functions/index.json')); } catch (_) {}
  if (!current()) return;
  index = new Map();
  const byPath = new Map(), byId = new Map();
  if (idx && idx.length) {
    treeData = idx.map((e) => {
      const id = String(e.id);
      const path = `functions/${sanitize(e.namespace)}/${sanitize(e.api_name)}.dg`;
      index.set(id, { path, category: e.category, source: e.source, name: e.name, rest: e.rest });
      const row = { path, api_name: e.api_name, display_name: e.display_name || e.api_name,
                    namespace: e.namespace, rest: e.rest, id, category: e.category, source: e.source,
                    downloaded: false, stale: false, error: false, updatedTime: null,
                    // What Zoho's list said, kept apart from what the sidecar says: the two
                    // disagreeing is exactly the fact «stale» exists to carry.
                    listUpdated: e.updatedTime || null };
      byPath.set(path, row); byId.set(id, row);
      return row;
    });
    renderTree();
    setStatus(`${treeData.length} functions - reading what is on disk\u2026`, 'busy');
  } else {
    treeData = [];
  }

  // ---- 2. the walk says what is on disk -----------------------------------------------------------
  // Names only: `walk()` yields paths and opens nothing. A function the index does not know about is
  // still shown - a workspace pulled by an older version, or one the index has fallen behind.
  const metaPaths = [];
  for await (const p of walk(op.root)) {
    if (!p.startsWith('functions/') || !p.endsWith('.meta.json')) continue;
    metaPaths.push(p);
    const dg = p.replace(/\.meta\.json$/, '.dg');
    const row = byPath.get(dg);
    if (row) row.downloaded = true;
  }
  if (!current()) return;
  if (!treeData.length) {
    // No index: a legacy workspace, or one whose index could not be read. The tree is what is on
    // disk, and the metas below are the only source for it - so it stays empty until they arrive.
    metaPaths.forEach((p) => {
      const dg = p.replace(/\.meta\.json$/, '.dg');
      const row = { path: dg, api_name: dg.split('/').pop().replace(/\.dg$/, ''),
                    display_name: dg.split('/').pop().replace(/\.dg$/, ''), namespace: dg.split('/')[1],
                    rest: false, id: dg, category: '', source: '', downloaded: true, stale: false,
                    error: false, updatedTime: null };
      byPath.set(dg, row); treeData.push(row);
    });
  }
  renderTree(); updateMissingButton();

  // ---- 3. what only the metas know, from the summary the pull leaves behind ----------------------
  // `functions/meta-index.json` holds the stale mark, the modified date, the namespace and the
  // display name, keyed by source path. One read instead of one per function - and it is checked
  // against the walk rather than believed: anything it does not describe is read from its own meta,
  // which is what makes a hand-pulled function, an older mirror and a file copied in by somebody
  // else all come out right.
  let summary = null;
  try { summary = JSON.parse(await op.read(META_INDEX)); } catch (_) {}
  if (!current()) return;
  const known = (!distrustSummary && summary && summary.v === SUMMARY_V && summary.files) ? summary.files : {};
  const missing = [];
  for (const mp of metaPaths) {
    const dg = mp.replace(/\.meta\.json$/, '.dg');
    const s = known[dg];
    const row = byPath.get(dg);
    if (!s || !row || dirtyMeta.has(dg)) { missing.push(mp); continue; }
    row.downloaded = true;
    // The same rule as the slow path below. It was only there, so whether a workspace reported
    // anything outdated depended on which of the two paths had loaded it.
    row.stale = (s.sv || 0) < META_SV || movedInZoho(row.listUpdated, s.listUpdated);
    row.fetchedAgainst = s.listUpdated || null;
    row.updatedTime = s.updatedTime || null;
    if (s.namespace) row.namespace = s.namespace;
    if (s.display_name) row.display_name = s.display_name;
  }
  // The summary is only worth rewriting when it is wrong: something new to describe, or something it
  // still describes that has gone. Otherwise opening the panel would write to the workspace every
  // time, which is a change to a folder the reader has under version control.
  let stale_summary = distrustSummary || missing.length > 0 || Object.keys(known).length !== metaPaths.length;
  if (missing.length) setStatus(`${treeData.length} functions - reading ${missing.length} detail(s)\u2026`, 'busy');
  renderTree();

  const TRANCHE = 120;
  let done = 0, lastPaint = 0;
  const metaPathsToRead = missing;
  for (let i = 0; i < metaPathsToRead.length; i += TRANCHE) {
    if (!current()) return;
    const batch = metaPathsToRead.slice(i, i + TRANCHE);
    await Promise.all(batch.map((mp) => refineRowFromMeta(mp, op, byPath, byId, index)));
    done += batch.length;
    if (!current()) return;
    // Redrawing after every tranche is what a first version did, and on five thousand rows it cost
    // more than the reading: forty-two redraws of the whole tree, about a second each. The rows are
    // refined in place; the picture catches up four times a second, which is faster than anyone
    // reads a badge. The last redraw happens below, unconditionally, so nothing is left half-drawn.
    const now = Date.now();
    if (now - lastPaint > 250 && viewMode === 'functions') { renderTree(); lastPaint = now; }
    if (done < metaPathsToRead.length) setStatus(`${treeData.length} functions - reading details ${done}/${metaPathsToRead.length}\u2026`, 'busy');
    await new Promise((r) => setTimeout(r, 0));   // let the panel answer whatever the reader is doing
  }
  if (!current()) return;
  renderTree(); updateMissingButton(); attachFnStats();
  if (stale_summary) await saveMetaIndex(metaPaths, op);
  if (!current()) return;
  // Put down here, not when Refresh was pressed: the pass that re-read everything has now written
  // the summary back, so the next load may believe it again.
  distrustSummary = false;
  const dl = treeData.filter((e) => e.downloaded).length;
  // **What could not be read is part of the answer.** Every sidecar that failed to open used to be
  // swallowed one by one, so a mirror the browser could not read at all closed on «120 functions
  // (120 downloaded).» in green - the rows drawn from file names alone, every one marked as present.
  // A count is a measurement of what was read; saying it without saying what was not is the mirror
  // lying by omission. The twin names the file and what the browser called it, and has since it
  // existed.
  setStatus(`${treeData.length} functions (${dl} downloaded).`
    + (unreadableMetas.length
      ? ` ${unreadableMetas.length} file(s) could not be read - what they hold is not in this list.`
      : '')
    + (statsDeferred() ? ' Size and call counts appear when the diagram, the audit or a code search builds the map.' : ''),
  unreadableMetas.length ? 'warn' : 'ok');
  await refreshContext();
}

/** Write the summary the load above reads. Built from the rows in memory, which have just been
 *  brought up to date, so it costs no reading - and it is written at the end of the load rather than
 *  at the end of each pull, because every pull ends by rebuilding the tree. One hook instead of
 *  three, and no path where a pull updates the mirror and forgets the summary.
 *
 *  A failure here is not worth a message: the summary is a cache, the next load simply reads the
 *  metas again. What would be worth a message is the panel appearing to work while the mirror is
 *  wrong, which is why nothing else depends on this file. */
/** The one writer of `functions/meta-index.json`.
 *
 *  Two producers put facts in this file - what a `.meta.json` says, and what a `.dg` says - and both
 *  did read-modify-write on it. That is the oldest race there is: each reads version X, each merges
 *  its own half into X, and whoever writes second restores the fields the other had just changed.
 *  Proved rather than argued: marking a function stale and running the two savers together left the
 *  file saying it was fresh, because the graph writer's merge base predated the mark - and it does
 *  not even write that field.
 *
 *  So the file has one writer and two producers. A mutator is queued behind whatever is already in
 *  flight, and the read happens *inside* the queue, so every merge base is the file as it stands.
 *  No lock, no version field, no retry: a promise chain is enough because the contention is between
 *  two known callers in one document, not between processes.
 */
/** The queued half of `updateMetaIndex`: read the file as it stands, merge, write it back.
 *
 * A declaration rather than the `.then(async () => {})` this used to be. The chain is the thing that
 * makes the summary correct against its second writer, and it was the one part of it nothing could
 * read - three awaits and a merge, inside a callback. `after` is the queue it waits behind and `op`
 * is the workspace the caller meant, both passed in for the same reason: by the time this runs, the
 * folder on screen may be another one.
 */
async function mergeIntoMetaIndex(after, mutate, op) {
  await after;
  let files = {};
  try {
    const prev = JSON.parse(await op.read(META_INDEX));
    if (prev && prev.v === SUMMARY_V && prev.files) files = prev.files;
  } catch (_) {}
  await mutate(files);
  await op.write(META_INDEX, JSON.stringify({ v: SUMMARY_V, sv: META_SV, files }, null, 2));
  return true;
}
/** Wait for a job and swallow its outcome, so the next queued write is not cancelled by this one.
 *
 * `job.then(() => {}, () => {})` said the same thing in two callbacks nothing could read. Naming it
 * also names the intent, which the two empty arrows did not: what is being discarded here is the
 * *result*, not the error - the caller still gets the real one.
 */
async function settled(job) {
  try { await job; } catch (_) { /* the caller receives it; the queue only needs to carry on */ }
}
let _metaIndexWrites = Promise.resolve();
function updateMetaIndex(mutate, suppliedOp = null) {
  // The queue is what makes this correct against the other writer, and it is also what made it write
  // into the wrong folder: work handed to it runs *later*, so `dir` inside is whatever is on screen
  // by the time its turn comes. The workspace is taken here, where the caller still means it.
  const op = suppliedOp || beginWorkspaceOp();
  const job = mergeIntoMetaIndex(_metaIndexWrites, mutate, op);
  // The queue must survive a failure - the next caller is a different write and has done nothing
  // wrong - and the *caller* must not. It used to swallow the error here, so both savers went on to
  // clear their dirty marks over a write that had been refused: the file was old and nothing on the
  // next load would re-read it. The queue takes the caught version, the caller takes the real one.
  _metaIndexWrites = settled(job);
  return job.catch(() => false);
}

async function saveMetaIndex(metaPaths, op = beginWorkspaceOp()) {
  const onDisk = new Set(metaPaths.map((p) => p.replace(/\.meta\.json$/, '.dg')));
  const written = updateMetaIndex((files) => {
    Object.keys(files).forEach((k) => { if (!onDisk.has(k)) delete files[k]; });   // gone from the folder
    treeData.forEach((r) => {
      if (!onDisk.has(r.path)) return;
      const e = files[r.path] || (files[r.path] = {});
      e.id = String(r.id); e.sv = r.stale ? 1 : META_SV; e.updatedTime = r.updatedTime || null;
      e.listUpdated = r.fetchedAgainst || null;   // what the list said when this copy was fetched
      e.namespace = r.namespace || ''; e.display_name = r.display_name || '';
    });
  }, op);
  // Only the metas this pass actually described, and only the meta half: the source-derived facts
  // belong to `saveGraphFacts()` and are not this writer's to declare done. And only if the write
  // happened: a mark cleared over a refused write is a file nothing will ever read again.
  if (!(await written) || !op.current()) return;
  metaPaths.forEach((mp) => _dirtyMeta.delete(mp.replace(/\.meta\.json$/, '.dg')));
}

// The tree is built from .meta.json alone; the stats need the sources. Fill them in after the first
// render instead of blocking it - the graph gets built anyway the moment a function is opened.
// Above this many functions the badges wait to be asked for. Measured on a generated org: building
// the call graph reads every source - 40,000 file-system calls on five thousand functions - and it
// used to happen on every open, for two numbers in a badge nobody had asked to see. It still happens
// the moment anything actually needs the graph: the diagram, the audit, the assistant, a search
// through the sources. What is refused here is doing it *speculatively* on a workspace where it is
// expensive.
const STATS_LIMIT = 1200;

// Above this many functions the badges wait to be asked for, and that has to be *said* - a missing
// badge with no explanation reads as a defect. It used to be said by `attachFnStats`, which the load
// starts and deliberately does not await, and the load then set its own status over it in the same
// turn: the sentence was written for large orgs and no large org ever saw it. The condition is here
// so the one line that survives can carry it.
const statsDeferred = () => treeData.length > STATS_LIMIT && !graphCache;
async function attachFnStats() {
  if (statsDeferred()) return;
  try {
    const g = await ensureGraph();
    const byFile = {}; Object.values(g.nodes).forEach((n) => { if (n.file) byFile[n.file] = n.stats; });
    let any = false;
    treeData.forEach((e) => { const s = byFile[e.path]; if (s) { e.stats = s; any = true; } });
    if (any && viewMode === 'functions') renderTree();
  } catch (_) {}   // stats are an enrichment: if the graph cannot be built, the tree still works
}

// ---------- function statistics ----------
// Derived from the source we already hold in memory, never written to disk: a stored copy could
// disagree with the .dg next to it, and would cost a schema bump plus a re-pull of every function
// for a number that is free to recompute.
//
// These are counts, not a score. Length measures verbosity, not complexity, and the call counts say
// how much a function talks to the outside - how to read that is the reader's call, not ours.
// Zoho's own list of Deluge integration namespaces: zoho.com/deluge/help/integration-tasks.html
const ZOHO_SERVICES = 'crm|creator|books|invoice|inventory|billing|subscriptions|desk|projects|people|recruit|mail|calendar|sheet|writer|cliq|connect|sign|analytics|bookings|salesiq|workdrive|map|notebook';
const RE_ZOHO_ANY = new RegExp('\\bzoho\\.(?:' + ZOHO_SERVICES + ')\\.\\w+', 'gi');
const RE_ZOHO_CRM = /\bzoho\.crm\.\w+/gi;
const RE_INVOKEURL = /\binvokeurl\b/gi;
const RE_SENDMAIL = /\bsendmail\b/gi;
// Comments and string literals are removed before any of these are counted, by the one reader that
// does it - `stripNonCode()` in graph-core.js, which the call extractor uses too. Two readers of the
// same thing is the shape this repository has been bitten by; this used to be two.
const _count = (s, re) => { const m = s.match(re); return m ? m.length : 0; };
function fnStats(src) {
  // **An absent source is not a measurement of zero.** This took `undefined` - a function whose
  // `.dg` is not on disk, because its fetch failed and it is in `failures/` - and returned a full
  // set of zeros, so «could not be read» arrived everywhere downstream as «0 lines, 0 outbound
  // calls»: indistinguishable from an empty function, in the health audit, in both exports and in
  // what the assistant is told. That is the one thing this product says a mirror must never do, and
  // the release that said so fixed the connection counts and the module lists and not this.
  //
  // An empty *file* still measures as zeros, which is true of it. The difference is whether there
  // was anything to read, and only the caller knows - so it is read off the argument here rather
  // than guessed at by any of the five places that consume the result.
  if (src === null || src === undefined) return null;
  const code = String(src);
  const bare = stripNonCode(code);
  const crm = _count(bare, RE_ZOHO_CRM);
  const zohoAny = _count(bare, RE_ZOHO_ANY);
  const invokeurl = _count(bare, RE_INVOKEURL);
  return {
    lines: code ? code.split('\n').length : 0,
    codeLines: bare.split('\n').filter((l) => l.trim() !== '').length,
    chars: code.length,
    invokeurl, sendmail: _count(bare, RE_SENDMAIL),
    crm, zoho: zohoAny - crm,          // other Zoho services
    apiCalls: invokeurl + zohoAny,     // outbound calls; each one is work Zoho meters
  };
}

// ---------- graph cache ----------
// What the diagram window is given, which is less than what the panel holds. It draws names, kinds
// and arrows, so the payload carries those; what crosses into storage is what has to be justified.
//
// `source_code` is no longer on a graph node at all. It used to be put back by loadGraph() «for the
// assistant and the Markdown export», and that sentence was true only of a graph built by reading
// every .dg: a node served from the summary cache carries an empty string, and after the first pull
// every node is. So the three assistant tools that read it answered about an org whose source they
// had never seen - `search_code` said «(no matches)» over 900 functions - and the Markdown export
// wrote empty fences. Whoever wants the text reads the file: the graph is structure, the .dg is the
// source, and a fast path may not decide which of the two a reader gets.
//
// The delete below stays. Nothing puts the field on a node today, and a defensive strip on the one
// object that leaves the panel costs a line.
//
// And it goes to `chrome.storage.session`: this is a hand-off to a window opening in a moment, not a
// setting. Session storage is memory - it goes when the browser does, instead of a copy of the org's
// structure resting on disk until the next diagram replaces it.
/** The workspace identity, photographed at the entry of a graph action - not read after the build.
 *  Every diagram entry read `bound`/`lastCtx` *after* its awaits, so a build begun in one workspace
 *  could be stamped with the identity of the next: data of A presented as B, which a mirror can
 *  never do. Reproduced by an outside scan. */
const graphIdentity = () => ({ instance: bound?.instance || lastCtx?.instance || null,
                               org: bound?.org || lastCtx?.org || null, label: bound?.label || null });
/** Hand a graph to its own window: one key per window, not one slot for all of them.
 *  Two windows - a call graph and an ER - shared `graphData`, so two opens close together could each
 *  consume the other's payload. The token rides the URL; the window consumes exactly its own key.
 *  Checked against the op before the write and again before the window, and the key is removed
 *  rather than left if the workspace moved between the two. Returns false when it did. */
async function publishGraph(g, op, ws) {
  g.workspace = ws;
  const token = crypto.randomUUID();
  const key = 'graphData:' + token;
  if (op && !op.current()) return false;
  await chrome.storage.session.set({ [key]: graphForWindow(g) });
  if (op && !op.current()) { try { await chrome.storage.session.remove(key); } catch (_) {} return false; }
  // A window that cannot open leaves nobody to consume the key, so it goes at once - otherwise the
  // payload sat in session storage until the browser closed, which is longer than the privacy page
  // is allowed to promise.
  try { await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html?graph=' + token), type: 'normal', width: 1240, height: 840 }); }
  catch (e) { try { await chrome.storage.session.remove(key); } catch (_) {} throw e; }
  return true;
}
function graphForWindow(g) {
  const out = Object.assign({}, g, { nodes: {} });
  for (const [id, n] of Object.entries(g.nodes || {})) {
    const copy = Object.assign({}, n);
    delete copy.source_code;
    out.nodes[id] = copy;
  }
  return out;
}

/** The call graph, from what was written down when the sources were last read.
 *
 *  It used to read every `.dg` and every `.meta.json` - two files per function, 40,000 file-system
 *  calls on an org of five thousand - and parse the sources again each time. What the parse produces
 *  per function is now kept in `functions/meta-index.json`: the references the parser saw and the
 *  size counts. Both are *readings* of one file, so they age exactly when that file changes - and
 *  what detects that is **not** the folder walk, which sees paths appearing and disappearing and
 *  nothing about the bytes behind them. This comment used to claim the walk was enough; a review
 *  asked for the proof, the first test written for it failed, and the answer is `_dirtySource`:
 *  every write this panel makes marks the file it touched, and ↻ Refresh marks all of them for the
 *  writes it cannot see. The resolution of a reference into an edge still happens on every build,
 *  because it depends on the whole workspace.
 *
 *  A source the summary does not describe is read and parsed as before, and the summary is brought
 *  up to date afterwards. So a hand-pulled function, an older mirror or a file somebody dropped in
 *  all produce the same graph as a full read - proven in the suite by building it both ways.
 */
async function loadGraph(op = beginWorkspaceOp()) {
  if (!op.current()) throw new Error(WS_MOVED);
  const nodes = [];
  // `idWord` because the header is drawn by a file both products share - see the twin, where the
  // number is a workspace id and this one is an org.
  const workspace = { idWord: 'org', instance: bound?.instance || lastCtx?.instance || null, org: bound?.org || lastCtx?.org || null, label: bound?.label || null };
  const dirtySrc = new Set(_dirtySource);   // snapshot, as the tree load does
  let summary = null;
  try { summary = JSON.parse(await op.read(META_INDEX)); } catch (_) {}
  const known = (!distrustSummary && summary && summary.v === SUMMARY_V && summary.files) ? summary.files : {};
  let read = 0;
  for await (const p of walk(op.root)) {
    if (!op.current()) throw new Error(WS_MOVED);
    if (!p.endsWith('.dg')) continue;
    const cached = dirtySrc.has(p) ? null : known[p];
    if (cached && Array.isArray(cached.refs) && cached.stats) {
      nodes.push({ namespace: cached.namespace || p.split('/')[0],
                   name: cached.name || p.split('/').pop().replace(/\.dg$/, ''),
                   api_name: cached.api_name || p.split('/').pop().replace(/\.dg$/, ''),
                   display_name: cached.display_name, category: cached.category, source: cached.source,
                   description: cached.description || '', rest: !!cached.rest,
                   associated_place: cached.associated_place || null, file: p,
                   return_type: cached.return_type || '', params: cached.params || [],
                   connections: cached.connections || [], updatedTime: cached.updatedTime || null,
                   modified_by: cached.modified_by || null,
                   refs: cached.refs, stats: cached.stats,
                   _modules: Array.isArray(cached.modules) ? { modules: cached.modules, unknown: cached.modulesUnknown || 0 } : null,
                   dg: '' });
      continue;
    }
    read++;
    const dg = await op.read(p); let meta = {}; try { meta = JSON.parse(await op.read(p.replace(/\.dg$/, '.meta.json'))); } catch {}
    nodes.push({ namespace: meta.nameSpace || p.split('/')[0], name: meta.name || p.split('/').pop().replace(/\.dg$/, ''), api_name: meta.api_name, category: meta.category, source: meta.source, display_name: meta.display_name, description: meta.description || '', rest: (meta.rest_api || []).some((r) => r.active), associated_place: meta.associated_place || null, return_type: meta.return_type, params: meta.params || [], connections: meta.connections || [], modified_by: meta.modified_by || null, updatedTime: meta.updatedTime || null, dg, stats: fnStats(dg), file: p });
  }
  const g = window.buildGraph(nodes.map((n) => (n.refs ? { ...n, _refs: n.refs, _modules: n._modules } : n)));
  // **How much of the org this drawing is of.** The graph is built from the `.dg` files on disk, and
  // a function that never downloaded - the ones in `failures/` - is not a node at all. So it makes
  // no calls here, and anything it was the only caller of comes out as «no caller»: the number the
  // diagram prints in its headline and the list the health audit puts names in, which is where
  // somebody decides a function is safe to delete.
  //
  // `functions/index.json` is what Zoho reported, so the difference is the answer. Unknown rather
  // than zero when the index cannot be read: «nobody looked» is not «nothing missing», which is the
  // distinction this panel spent the day learning in four other places.
  let inOrg = null;
  try { const idx = JSON.parse(await op.read('functions/index.json')); if (Array.isArray(idx)) inOrg = idx.length; } catch (_) {}
  g.counts.inOrg = inOrg;
  g.counts.notInMirror = inOrg === null ? null : Math.max(0, inOrg - g.counts.nodes);
  // What the parser saw, written down for the next build. Only when something had to be read: a
  // graph built entirely from the summary has nothing new to say, and rewriting the file on every
  // open would touch a folder the reader may have under version control.
  if (read) await saveGraphFacts(nodes, g, op);
  if (!op.current()) throw new Error(WS_MOVED);
  nodes.forEach((nd) => { const id = nd.namespace + '.' + nd.name; if (g.nodes[id]) { g.nodes[id].return_type = nd.return_type; g.nodes[id].params = nd.params; g.nodes[id].connections = nd.connections; g.nodes[id].modified_by = nd.modified_by; g.nodes[id].updatedTime = nd.updatedTime; // The counts come from the source when it was read, and from the summary when it was not -
  // the same numbers either way, since `fnStats()` is a pure reading of that text and what the
  // summary holds is the result of having run it.
  g.nodes[id].stats = nd.stats || fnStats(nd.dg); } });
  g.workspace = workspace;
  return g;
}
/** Keep, per function, exactly what a source read produced: the references the parser found and the
 *  size counts. Everything else in the graph is computed from those two and from the workspace as a
 *  whole, so nothing here is a stored judgement - only a stored reading. */
async function saveGraphFacts(nodes, g, op = beginWorkspaceOp()) {
  const written = updateMetaIndex((files) => {
    nodes.forEach((nd) => {
      if (!nd.file) return;
      const node = g.nodes[nd.namespace + '.' + nd.name];
      const entry = files[nd.file] || (files[nd.file] = {});
      entry.namespace = nd.namespace; entry.name = nd.name; entry.api_name = nd.api_name;
      entry.display_name = nd.display_name; entry.category = nd.category; entry.source = nd.source;
      entry.rest = !!nd.rest; entry.associated_place = nd.associated_place || null;
      entry.return_type = nd.return_type || ''; entry.params = nd.params || [];
      entry.connections = nd.connections || []; entry.modified_by = nd.modified_by || null;
      entry.description = nd.description || '';
      entry.refs = (node && node.refs) ? node.refs : (nd.refs || []);
      // The module candidates, beside the references and for the same reason: a reading of one
      // source, never a resolution against the workspace.
      entry.modules = (node && node.modules) ? node.modules : (nd.modules || []);
      entry.modulesUnknown = (node && node.modulesUnknown) || 0;
      entry.stats = nd.stats || (node && node.stats) || null;
      // `sv` and `updatedTime` belong to the meta writer: this one has read a `.dg`, which says
      // nothing about either. Writing them here is how a merge base becomes a lost update.
    });
  }, op);
  // The sources this pass read are now described, and only those - a file rewritten while this
  // build was walking the folder keeps its mark and is read by the next one. And only if the write
  // happened, for the same reason as in the meta half.
  if (!(await written) || !op.current()) return;
  nodes.forEach((nd) => { if (nd.file) _dirtySource.delete(nd.file); });
}
async function ensureGraph(op = beginWorkspaceOp()) {
  if (!op.current()) throw new Error(WS_MOVED);
  if (graphCache) return graphCache;
  // The *result* was cached after the await, so a build begun in one workspace finished into the
  // next - and `saveGraphFacts` then wrote its readings into that workspace's summary. What comes
  // back for a folder we have left is thrown away rather than kept.
  const g = await loadGraph(op);
  if (!op.current()) throw new Error(WS_MOVED);
  graphCache = g;
  return graphCache;
}
function makeCallResolver(g) {
  const nodes = g.nodes || {}, byName = {};
  Object.values(nodes).forEach((n) => { (byName[n.name] ||= []).push(n); });
  return (ns, name) => {
    const exact = nodes[ns + '.' + name];
    if (exact) return { file: exact.file, label: exact.display_name || exact.name };
    const hits = byName[name] || [];
    if (hits.length === 1) return { file: hits[0].file, label: hits[0].display_name || hits[0].name };
    return null;   // ambiguous / unresolved -> not linked
  };
}

// ---------- preview ----------
// The preview header, written in one place so the five tabs cannot say different things.
//
// Reported: selecting a function showed `functions/<namespace>/<name>.dg` in a 400px header, so the
// ellipsis ate the file name - the one part worth reading - and left the folder. And no other tab
// named a file at all, which reads as five products rather than five tabs. So: the item's own name,
// then the file, then the whole workspace-relative path in the tooltip, which is where a long string
// belongs.
//
// Schedules and connections carry a synthetic path (`schedules/<id>`, `connections/<name>`): there is
// no such file, they are rows inside one index. Naming a file that is not there would be worse than
// naming none, so those name the file that does hold them and say what they are inside it.
function pvFileOf(path) {
  if (!path) return null;
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  if (/\.[a-z0-9]+$/i.test(last)) return { name: last, title: path };
  return { name: 'index.json', title: `${parts.slice(0, -1).join('/')}/index.json - one row inside it` };
}
// Copy the code that is on screen. `textContent` rather than the source variable: what the reader is
// looking at is what lands in the clipboard, and the highlighting comes back off by itself. The mark
// becomes a tick for a moment, because a copy that says nothing is indistinguishable from a click
// that missed.
const COPY_MARK = '<svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V10a1.5 1.5 0 0 0 1.5 1.5h1.5"/></svg>';
const COPY_TICK = '<svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
async function copyCode(text) {
  const btn = $('codecopy');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.innerHTML = COPY_TICK;
    setTimeout(() => { btn.innerHTML = COPY_MARK; }, 1200);
  } catch (e) {
    setStatus(MSG.copyFailed + friendlyError(e), 'warn');
  }
}
function setPvName(label, path) {
  navLabel(label);   // the chain shows what the header shows - one name, decided in one place
  const f = pvFileOf(path);
  // A function's name *is* its file name, so printing both would say it twice. Derived from the two
  // strings rather than decided per tab, which is how the tabs drifted apart in the first place.
  const same = !!f && label === f.name;
  $('pvname').textContent = label;
  $('pvname').title = same ? f.title : label;
  $('pvfile').textContent = f && !same ? f.name : '';
  $('pvfile').title = f && !same ? f.title : '';
}

// The list follows whatever the preview is showing. Marking the row was already here; what was
// missing is everything a reader needs for that mark to *mean* anything - it was reported as the
// selection staying uncoordinated after jumping from one function to another through a call in the
// code.
//
// Three things, and each was its own small lie: a group closed over the target stays closed and the
// row does not exist to be marked, so the tree shows nothing selected; a row far down the list is
// marked where nobody can see it; and the keyboard went on stepping from where *it* had been, so
// the next arrow jumped back to the previous function.
function syncTreeTo(path) {
  const e = treeData.find((x) => x.path === path);
  // `ns`, spelled the way the tree spells it: `collapsed` is shared with the modules list, which
  // prefixes its keys, and a test holds that difference. Same key, same name for it.
  const ns = e && e.namespace;
  if (ns && treeSort === 'name' && collapsed.has(ns)) {
    collapsed.delete(ns);                 // opened, because you asked to look at what is inside it
    renderTree();
  }
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
  stepAnchor = path;                      // the arrows carry on from what you are looking at
  const row = [...$('tree').querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === path);
  revealRow(row, $('tree'), '.grp');
}

// You clicked it, so you know where it is: opening the pane shortens the list and may push that row
// below the fold, and scrolling after your own click is the panel arguing with your finger. Arriving
// from anywhere else - a link, a health row, a step of the history - is the opposite: there the row
// has to be found for you. One flag tells the two apart, set by the only place a click starts.
function openFromTree(path) { openFile(path, null, true); }
async function openFile(path, line = null, byClick = false) {
  const mine = ++previewLoad;
  const op = beginWorkspaceOp();
  if (!(await ensurePerm(op.root))) { if (previewCurrent(mine, op)) setStatus('File access denied - click Refresh to grant.', 'bad'); return; }
  if (!previewCurrent(mine, op)) return;
  // The `push` flag is gone with the back stack it fed: whether a step is remembered is no longer
  // something each caller decides - every arrival is a step, which is what made the old one useless
  // the moment the reader changed tab.
  currentPath = path; navHere(path.split('/').pop()); if ($('status').className) setStatus('', '');
  $('pvreveal').style.display = 'none';   // "Go to" (auto-open in the editor) removed: it drove Zoho's localized DOM. Find is the deterministic way in.
  $('pvfind').style.display = ''; $('pvfind').textContent = 'Functions in Zoho \u2197'; $('pvfind').title = 'Open Zoho\u0027s own functions page. It no longer types this name into their search box: the newer functions interface is addressed by URL, and this product does not script somebody else\u0027s page.'; $('pvtable').style.display = 'none';
  syncTreeTo(path);
  const trow = treeData.find((x) => x.path === path);
  if (trow) navNames({ display: trow.display_name, api: trow.api_name });
  setPvName(path.split('/').pop(), path); $('pvcallers').className = ''; $('pvcallers').textContent = '';
  pvTabsFor('function');
  let code; try { code = await op.read(path); } catch (e) { if (previewCurrent(mine, op)) setStatus(MSG.readFailed + e.message, 'bad'); return; }
  if (!previewCurrent(mine, op)) return;
  const lines = code.split('\n').length;
  $('pvgutter').textContent = Array.from({ length: lines }, (_, k) => k + 1).join('\n');
  const _g = await ensureGraph(op).catch(() => null);
  if (!previewCurrent(mine, op)) return;
  const _resolve = _g ? makeCallResolver(_g) : null;
  // The module named inside a call is a link too, on the same principle as the call itself: a name
  // that identifies something this panel can show is hypertext. Resolved against the module index,
  // so a string that merely looks like a module stays a string.
  const _known = (await moduleNames(op).catch(() => null)) || new Map();
  if (!previewCurrent(mine, op)) return;
  // A related-list name identifies the module at the *other* end of the relation - which is what
  // the reader means by it - so it is resolved inside its parent module's own catalogue of related
  // lists, where Zoost already holds `api_name` beside the module it points at. The same name can
  // exist on two modules, which is why the parent is part of the question and not a guess.
  const _mfiles = (await loadModuleFiles(op).catch(() => null)) || {};
  if (!previewCurrent(mine, op)) return;
  const _linkFor = (name, kind, parent) => {
    if (kind === 'mod') return _known.has(name) ? name : null;
    const p = parent && _mfiles[parent];
    const rl = p && (p.related_lists || []).find((r) => (r.api_name || '') === name);
    const target = rl && (rl.module || rl.connected_module);
    return target && _known.has(target) ? target : null;
  };
  $('pvcode').innerHTML = window.highlightDeluge
    ? window.highlightDeluge(code, _resolve, _linkFor)
    : escHtml(code);
  $('pvcode').querySelectorAll('a.c-link[data-file]').forEach((a) => { a.onclick = () => openFile(a.dataset.file); });
  $('pvcode').querySelectorAll('a.c-link[data-mod]').forEach((a) => { a.onclick = () => healthOpenModule(a.dataset.mod); });
  paintFindMarks($('pvcode'), findMarkRe());
  showPreview(byClick);
  if (line) { const lh = parseFloat(getComputedStyle($('pvcode')).lineHeight) || 16; $('pvbody').scrollTop = Math.max(0, (line - 3) * lh); }
  showCallers(path, mine, op);
}
/** Two tabs rather than one long column, for the two kinds of item whose detail is crowded.
 *
 *  The first tab is *the thing you opened the item for* - the source of a function, the fields of a
 *  module - and the second is everything else, which is what had grown to seven blocks stacked above
 *  a 400px-wide pane. The first tab is therefore also the default, and the choice is not remembered:
 *  it is one click, and a remembered mode that opens on Details would hide what you came for.
 *
 *  Which panes belong to which tab is declared here rather than assigned at each opener, because the
 *  strip is one control and an opener that forgot half of it is how the module detail ended up
 *  showing a function's tabs. */
let pvTab = 'code', pvKind = null;
const PV_KINDS = {
  function: { first: 'Code', panes: { code: [['pvbody', 'flex']], info: [['pvcallers', '']] } },
  // `pvcallers` is on both kinds now: on a function it is what calls it, on a module it is what
  // reads and writes it. Same pane, same question - what relates to the thing on screen.
  //
  // A module has three. Its related lists used to sit at the bottom of «Details», under the refusal
  // banner, the names block and the layout counts, in a column that does not fit a side panel -
  // «you struggle to see the whole detail, there is no room». They carry the one string Deluge
  // actually needs, so they get their own tab rather than the bottom of somebody else's.
  module: { first: 'Fields', panes: { code: [['pvfields', '']], rel: [['pvrels', '']],
                                      info: [['pvdetails', ''], ['pvcallers', '']] } },
};
const PV_TABS = { code: 'pvtab_code', rel: 'pvtab_rel', info: 'pvtab_info' };
function setPvTab(which) {
  // Derived from the kind's own panes rather than from a pair of ids: the strip was two buttons and a
  // boolean, so a third tab meant a third `if` in four places. What a kind has is what it declares.
  const kinds = PV_KINDS[pvKind];
  pvTab = (kinds && kinds.panes[which]) ? which : 'code';
  Object.entries(PV_TABS).forEach(([tab, id]) => {
    const b = $(id); if (!b) return;
    // A tab a kind does not have is absent, not disabled: the panel's rule everywhere else, and a
    // «Related lists» on a function would lead to an empty pane.
    b.style.display = (kinds && kinds.panes[tab]) ? '' : 'none';
    b.classList.toggle('active', tab === pvTab);
  });
  // The copy control belongs to the pane that holds code, so it follows the strip like every other
  // pane rather than being switched on by the opener: set there, it stayed lit on «Details» and on a
  // module, where there is no code at all - visible in a picture published on the site. It is the
  // defect the comment above `PV_KINDS` describes, made once more by the same route.
  $('codecopy').style.display = (pvKind === 'function' && pvTab === 'code') ? '' : 'none';
  const k = PV_KINDS[pvKind]; if (!k) return;
  Object.entries(k.panes).forEach(([tab, panes]) => panes.forEach(([id, shown]) => {
    const el = $(id); if (el) el.style.display = tab === pvTab ? shown : 'none';
  }));
}
/** Showing the strip resets it to the first tab - opening a second item and landing on the tab the
 *  previous one was left on is the stale-projection problem in miniature. Called with anything else
 *  (a workflow, a schedule, a connection) it takes the strip away: those have one pane and no
 *  choice to make. `openModule` not calling it at all is what let a module show `Code | Details`. */
function pvTabsFor(kind) {
  pvKind = PV_KINDS[kind] ? kind : null;
  // `#pvcallers` belongs to a function - its own box above the code - and to a module, where it is
  // «read by / written by» and belongs *under* the names, inside the Details pane, so that the pane
  // scrolls as one region instead of two stacked boxes each with a scrollbar. Reported with a
  // picture. Moved here rather than by whoever opens a module: this runs on every open and knows the
  // kind, so nothing has to remember to put it back.
  const callers = $('pvcallers'), home = $('pvcallershome');
  if (kind !== 'module' && callers && home && callers.previousElementSibling !== home) home.after(callers);
  $('pvtabs').hidden = !pvKind;
  if (!pvKind) $('codecopy').style.display = 'none';   // a workflow, a schedule, a connection: no code
  $('pvtabsr').innerHTML = '';        // the diagram control belongs to the item being left
  if (pvKind) { $('pvtab_code').textContent = PV_KINDS[pvKind].first; setPvTab('code'); }
  else { $('pvcallers').style.display = ''; }
}

/** The modules this org actually has, by api_name, read once per workspace.
 *
 *  A module *candidate* out of a source becomes a fact only here: `graph-core` reads names out of
 *  the text and knows nothing about which of them exist, so a COQL query selecting from a word that
 *  is not a module of this org says nothing rather than drawing a box. Measured on two production
 *  orgs before this was written: three and four such names each, every one correctly refused.
 */
let modNamesCache = null;
async function moduleNames(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (modNamesCache) return modNamesCache;
  let idx = []; try { idx = JSON.parse(await op.read('modules/index.json')); } catch (_) {}
  const list = Array.isArray(idx) ? idx : (idx && idx.modules) || [];
  const m = new Map();
  list.forEach((x) => { const a = x.api_name || x.module_name || x.name; if (a) m.set(a, x); });
  if (!op.current()) return null;
  modNamesCache = m; return m;
}

/** What this function does to the modules of this org: read, written, or reached by a url whose
 *  method we have not looked at. Sorted, deduplicated, and with the count of the calls whose module
 *  is computed at run time - which is shown rather than dropped, because the answer is a lower
 *  bound and a reader deciding whether a field is safe to change has to be told so. */
async function modulesOf(node) {
  const known = await moduleNames();
  const out = { read: [], write: [], touch: [], unknown: (node && node.modulesUnknown) || 0 };
  if (!known) return out;
  for (const m of (node && node.modules) || []) {
    if (!known.has(m.name)) continue;
    const b = out[m.mode] || out.touch;
    if (!b.includes(m.name)) b.push(m.name);
  }
  // A module both read and written is a write as far as «is this safe to change» goes, but both
  // facts are true and the panel shows both - interpreting them is the reader's business.
  ['read', 'write', 'touch'].forEach((k) => out[k].sort());
  return out;
}
/** Which functions read this module, and which write it - the reading turned round.
 *
 *  This is the question the platform cannot answer at all: Zoho will show you a module's fields and
 *  its layouts, and nothing that says «this Deluge writes here». It fills the same pane a function's
 *  callers use, because it is the same kind of fact - what relates to the thing on screen - and it
 *  is drawn after the pane rather than blocking it, since it needs the call graph.
 *
 *  It is a lower bound and says so. A call whose module is computed at run time cannot be attributed
 *  to any module, so «nothing writes here» is «nothing that could be read», and the line under the
 *  lists carries that instead of leaving the reader to assume otherwise.
 */
/** A cross-tab chip stops being a way in when its tab is not there.
 *
 *  «When a tab is disabled we must not still have live references that take you there - the links
 *  stop existing for that tab, otherwise hiding it means nothing.» Reported after watching a hidden
 *  Functions tab come back by clicking a function in a module's detail. Refusing the click was the
 *  first half and it is not enough: a link that looks like a link and then says no is a worse
 *  interface than no link, because the reader learns nothing until they have pressed it.
 *
 *  So it is decided here, once, from the target the chip already declares - `data-file` and `data-fnid`
 *  mean the functions tab, `data-wf` means workflows - rather than at six render sites that would
 *  drift. What a chip becomes is plain text carrying the reason, which is the same shape the empty
 *  states in this panel use: say what is in the way and what to do about it.
 *
 *  `root` is where the chips were just drawn; `open` is what a live one does with the element. */
function wireFnChips(root, open) {
  if (!root) return;
  root.querySelectorAll('.wf-fn, a[data-file]').forEach((el) => {
    const target = el.dataset.wf != null ? 'workflows' : 'functions';
    if (tabReachable(target, true)) { el.onclick = () => open(el); return; }
    // Not a link any more, and that has to be true of the *element* and not only of its handler.
    // Removing the click left an `<a>` behind, and the containers style anchors by id - `#pvcallers a`
    // and `#healthbody a` both set a pointer and a hover, and an id selector beats any class this
    // could add. So it looked exactly like a working link that had stopped working, which is the
    // worst of the three states. Reported. The same trap is already recorded ten lines above the
    // `#pvcallers a.wf-fn` rule, one turn earlier: the container wins over the chip.
    //
    // So the anchor becomes a span. Nothing that styles `a` can reach it, in this container or in any
    // container added later, and the chip keeps its own class-based look minus the colour, which
    // `.wf-fn.gone` mutes. The text stays: what uses a module is a fact about the module.
    const why = isForbidden(target)
      ? `${tabLabel(target)}: your Zoho role does not grant access to that area.`
      : `${tabLabel(target)} is hidden in Settings, so this does not open.`;
    if (el.tagName === 'A') {
      const span = document.createElement('span');
      span.className = el.className;
      span.textContent = el.textContent;
      Object.entries(el.dataset).forEach(([k, v]) => { span.dataset[k] = v; });
      el.replaceWith(span);
      span.classList.add('gone');
      span.title = why;
      return;
    }
    el.classList.add('gone');
    el.onclick = null;
    el.title = why;
  });
}
async function showModuleUsage(api, path, mine, op) {
  const box = $('pvcallers'); box.textContent = 'reading what the code does with it\u2026'; box.className = 'show';
  try {
    const g = await ensureGraph(op);
    if (!previewCurrent(mine, op) || currentPath !== path) return;
    const read = [], write = [], touch = [];
    let blind = 0;
    for (const n of Object.values(g.nodes)) {
      if (!n.file) continue;
      blind += n.modulesUnknown || 0;
      for (const m of n.modules || []) {
        if (m.name !== api) continue;
        const b = m.mode === 'write' ? write : m.mode === 'read' ? read : touch;
        if (!b.some((x) => x.id === n.id)) b.push(n);
      }
    }
    const nm = (n) => nameMode === 'display' ? (n.display_name || n.name) : (n.api_name || n.name);
    const chips = (list) => '<div class="fnchips">' + list
      .sort((a, b) => nm(a).localeCompare(nm(b)))
      .map((n) => `<a class="wf-fn" data-file="${escA(n.file)}" title="${escA(n.namespace + '.' + n.name)}">\u0192 ${escHtml(nm(n))}</a>`)
      .join('') + '</div>';
    let html = '';
    if (read.length) html += `<b>Read by (${read.length}):</b>${chips(read)}`;
    if (write.length) html += `<b>Written by (${write.length}):</b>${chips(write)}`;
    if (touch.length) html += `<b>Reached by URL from (${touch.length}):</b>${chips(touch)}`;
    if (!html) html = '<b>No function reads or writes it</b> - as far as the code can be read';
    html += `<div class="modline">From the module names written in your Deluge`
      + (blind ? ` \u00b7 ${blind} call(s) across the org name the module in a variable and cannot be attributed` : '')
      + '</div>';
    box.innerHTML = html;
    // A function opened from a module lives on the other tab, so the tab has to move with it -
    // `openFile()` alone left the list showing modules while the detail showed a function, which is
    // the panel reading as if it had lost its place. Reported. Same two calls every other cross-tab
    // jump here makes, rather than a second way of doing it.
    wireFnChips(box, (a) => { setMode('functions'); openFromTree(a.dataset.file); });
  } catch (_) { box.className = ''; }
}
async function showCallers(path, mine = previewLoad, op = beginWorkspaceOp()) {
  const box = $('pvcallers'); box.textContent = 'computing references…'; box.className = 'show';
  try {
    const g = await ensureGraph(op); if (!previewCurrent(mine, op) || currentPath !== path) return;
    const node = Object.values(g.nodes).find((n) => n.file === path); if (!node) { box.className = ''; return; }
    const callers = node.called_by;
    const nm = (id) => nameMode === 'display' ? (g.nodes[id].display_name || g.nodes[id].name) : (g.nodes[id].api_name || g.nodes[id].name);
    // Chips, not a sentence. A comma-separated list of seven names reads as prose while the reader
    // is scanning for one of them, and this panel already has a shape for «a link to a function» -
    // the `.wf-fn` chip that workflows, schedules and connections use. Asked for by name: the same
    // layout for every function link. Not inside the code pane, where a chip would deform the line
    // it sits in; there a call stays an inline link.
    let html = callers.length
      ? `<b>Called by (${callers.length}):</b><div class="fnchips">`
        + callers.map((id) => `<a class="wf-fn" data-file="${escA(g.nodes[id].file)}" title="${escA(g.nodes[id].display_name || g.nodes[id].name || '')}">\u0192 ${escHtml(nm(id))}</a>`).join('')
        + '</div>'
      : '<b>Called by</b> - none';
    const ap = node.associated_place || [];
    if (ap.length) {
      const byType = {};
      // The whole entry is kept, not just its name: the id is what makes the name a link.
      ap.forEach((p) => (byType[p._type || 'other'] ||= []).push(p));
      // The names of the things that fire this function are links when this panel has somewhere to
      // take you: a workflow rule opens in the Workflows tab, a schedule in Schedules. `HEALTH_OPEN`
      // already maps a kind to its opener - it exists so that a group naming a new kind gets one
      // rather than silently rendering an unclickable name - and this is that map used a second
      // time. A kind with no opener stays plain, because a link that leads nowhere is worse.
      html += '<div class="apwrap">' + Object.keys(byType).sort().map((t) => `<b>Used in ${escHtml(t)} (${byType[t].length}):</b> ${byType[t].map((p) => apLink(t, p)).join(', ')}`).join('<br>') + '</div>';
    } else if (!callers.length && !node.rest) {
      html += ' <span class="orphan">\u00b7 no known usage (orphan candidate)</span>';
    }
    // What Zoho says about this function at runtime, next to what the mirror says about it
    // statically. Nothing is inferred: if it is not in the last reading, nothing is shown - «no
    // failures recorded» would be a claim about a measurement that may never have been taken.
    try {
      const fx = await failuresIndex(op);
      if (!fx || !previewCurrent(mine, op) || currentPath !== path) return;
      // Zoho reports the display name; the mirror knows three names for the same function and which
      // one matches is not ours to assume. Try them all rather than picking one and finding nothing.
      // Named `hits`, and it has to be: this was `const mine`, which shadows the *parameter* `mine`
      // for the whole block - so the `previewCurrent(mine, op)` three lines above read it in the
      // temporal dead zone and threw, every single time. The catch below swallowed it, so «what Zoho
      // says about this function at runtime» has never rendered once, silently, while the exports
      // printed it. Found by a review of this file.
      const hits = [node.display_name, node.name, node.api_name]
        .map((k) => fx.byName.get(String(k || '').toLowerCase())).find((v) => v && v.length) || [];
      if (hits.length) {
        const total = hits.reduce((n, f) => n + (f.count || 0), 0);
        const last = hits.map((f) => f.lastFailedAt).filter(Boolean).sort().pop();
        html += `<div class="failwrap"><b>Failing in Zoho:</b> ${escHtml(String(total))}\u00d7`
          + (last ? ` \u00b7 last ${escHtml(fmtDate(last))}` : '')
          + ` \u00b7 as read on ${escHtml(fmtDate(fx.at))}`
          // One line per distinct reason. Zoho returns a row per failing invocation, so a function
          // that broke the same way twice came back with the same sentence printed twice - which
          // reads as two problems and is one. The count above already says how many times.
          + [...new Map(hits.map((f) => [`${f.componentType}|${f.reason}`, f])).values()]
              .map((f) => `<div class="failrow">${escHtml(f.componentType || '?')} \u00b7 ${escHtml(f.reason || '')}</div>`).join('')
          + '</div>';
      }
    } catch (_) { /* no reading yet: say nothing rather than claim none */ }
    // Which modules this function touches, and how. The nearest sibling on this pane is the
    // connections row - a set of things outside the function that it reaches - so it is built the
    // same way, and the chips carry the module's api_name because that is what the code wrote.
    const mods = await modulesOf(node);
    if (mods.read.length || mods.write.length || mods.touch.length || mods.unknown) {
      const chips = (names, kind) => names.map((n) =>
        `<span class="mod ${kind}" data-mod="${escA(n)}" title="${escA(n + ' - click to open the module')}">${escHtml(n)}</span>`).join(' ');
      html += '<div class="modwrap">';
      if (mods.read.length) html += `<b>Reads (${mods.read.length}):</b> ${chips(mods.read, 'r')}<br>`;
      if (mods.write.length) html += `<b>Writes (${mods.write.length}):</b> ${chips(mods.write, 'w')}<br>`;
      if (mods.touch.length) html += `<b>Reached by URL (${mods.touch.length}):</b> ${chips(mods.touch, 't')}<br>`;
      // Never folded into the counts above: a number that quietly excludes what it could not read
      // is the kind of half-answer this panel exists to refuse.
      if (mods.unknown) html += `<span class="orphan">${mods.unknown} call(s) name the module in a variable - not determinable</span>`;
      html += '</div>';
    }
    const conns = node.connections || [];
    if (conns.length) {
      html += '<div class="connwrap"><b>Connections (' + conns.length + '):</b> '
        + conns.map((c) => `<span class="conn" data-conn="${escA(c.name)}" title="${escA((c.label || c.name) + (c.service ? ' \u00b7 ' + c.service : '') + ' - click to list every function that uses it')}">${escHtml(c.name)}</span>`).join(' ')
        + '</div>';
    }
    const st = node.stats;
    if (st) {
      const parts = [];
      if (st.invokeurl) parts.push(`${st.invokeurl} invokeurl`);
      if (st.crm) parts.push(`${st.crm} zoho.crm`);
      if (st.zoho) parts.push(`${st.zoho} other Zoho`);
      if (st.sendmail) parts.push(`${st.sendmail} sendmail`);
      // The caveat about what these counts mean lives in the Health audit's "Size & calls" tab and in
      // the docs: worth stating once where there is room, not on every preview in a 400px panel.
      html += `<div class="statline"><b>Size:</b> ${st.lines} lines (${st.codeLines} code) \u00b7 ${(st.chars / 1024).toFixed(1)} KB`
        + ` &nbsp;\u00b7&nbsp; <b>Outbound calls:</b> ${st.apiCalls ? escHtml(parts.join(', ')) : 'none'}</div>`;
    }
    const modBits = [];
    if (node.modified_by) modBits.push('by ' + escHtml(node.modified_by));
    if (node.updatedTime) modBits.push(escHtml(String(node.updatedTime).slice(0, 16)));
    if (modBits.length) html += `<div class="modline">Last modified ${modBits.join(' \u00b7 ')}</div>`;
    box.innerHTML = html;
    wireFnChips(box, (a) => openFile(a.dataset.file));
    box.querySelectorAll('.conn[data-conn]').forEach((c) => (c.onclick = () => filterByConnection(c.dataset.conn)));
    // A module chip opens the module, the way a function chip opens the function. It is the whole
    // point of the reading: the two halves of the mirror are one click apart instead of two lists.
    box.querySelectorAll('.mod[data-mod]').forEach((c) => (c.onclick = () => healthOpenModule(c.dataset.mod)));
    // «Used in …»: the rule or the schedule that fires this function, opened where it lives.
    box.querySelectorAll('a.aplink[data-ap]').forEach((a) => (a.onclick = () => {
      const open = HEALTH_OPEN[a.dataset.ap];
      if (open) open(a.dataset.apid, a.dataset.apname);
    }));
    // The same control the Modules preview carries, next to the same kind of fact: the references
    // are listed above it, this draws them. Absent when there is nothing to draw - a function
    // nobody calls and that calls nothing is a single box and no arrows.
    //
    // It sits on the tab strip rather than inside Details, and that is the rule the diagram window
    // already learnt about its focus: a control that acts on the item belongs to the item's chrome,
    // not to one of the views of it. Behind the second tab it was unreachable from Code - the tab
    // people open a function for. The depth travels with it, or the tooltip would name a control
    // that is on the other tab. The Modules preview keeps its own bar, because that detail has no
    // strip to move to and nothing is hiding it.
    const slot = $('pvtabsr'); slot.innerHTML = '';
    if (callers.length || (node.calls || []).length) {
      slot.innerHTML = `depth <select id="calldepth"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select><button id="callopen" class="laylocal icon" aria-label="Wiring" title="Wiring - opened on this function at the depth chosen here, in its own window"><svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5" rx="1"/><rect x="9" y="9" width="5.5" height="5" rx="1"/><path d="M7 4h3.5a1.2 1.2 0 0 1 1.2 1.2V9"/></svg></button>`;
      slot.querySelector('#callopen').onclick = () => openCallFocus(node.namespace + '.' + node.name, parseInt(slot.querySelector('#calldepth').value, 10) || 2);
    }
  } catch { box.className = ''; }
}

// Closing the pane does not forget where you have been - reopening anything continues the same
// chain, the way shutting a window does not clear a browser's history. Only leaving the workspace
// does, below, because there the steps would point at another org's files.
$('pvx').onclick = () => { previewLoad++; $('preview').classList.remove('show'); $('resizer').classList.remove('show'); currentPath = null; updateNav(); };

// resizable split
let dragY = false;
$('resizer').addEventListener('mousedown', () => { dragY = true; document.body.style.userSelect = 'none'; });
window.addEventListener('mousemove', (e) => {
  if (!dragY) return; const r = $('main').getBoundingClientRect();
  let h = Math.max(120, Math.min(r.height - 80, r.bottom - e.clientY)); $('preview').style.height = h + 'px';
});
// The height is cosmetic and its write is best-effort **by declaration**: a refusal costs the
// reader a drag next session and nothing else, so it is not worth a sentence - but an unhandled
// rejection is not a decision, it is an omission, so the intent is written where it happens.
window.addEventListener('mouseup', () => { if (dragY) { dragY = false; document.body.style.userSelect = ''; void chrome.storage.local.set({ previewH: $('preview').style.height }).catch(() => {}); } });

// ---------- reveal (auto-navigate to Functions page, then filter) ----------
function functionsUrl() {
  const base = bound?.base || lastCtx?.origin; const inst = bound?.instance || lastCtx?.instance;
  return base && inst ? `${base}/crm/${inst}/settings/functions/myFunctions` : null;
}
/** «Go to Zoho CRM» is about the platform, not about this workspace's org - and it was
 *  `${base}/crm/${instance}/`, which is a claim about which org you will land in. Reported: log out
 *  of one org to sign into another and the button takes you back to the one you just left.
 *  `ShowHomePage.do` is the account's own CRM home and resolves to whatever org the session has.
 *
 *  The host is still derived from what is known - the open workspace first, then the tab - because a
 *  data centre is a property of the account and logging out does not move it. The setting is only
 *  consulted when neither exists, which is a fresh install with nothing pulled: there the old code
 *  guessed `crm.zoho.com`, and a guess about somebody else's data centre is wrong five times out of
 *  six. */
/** The data centres, and the choice offered where the link is.
 *
 *  The destination used to be derived from whichever workspace happened to be open, on the reasoning
 *  that a data centre is a property of an account and signing out does not move it. True of one
 *  account, and false for the reader this product is most for: a consultant with clients on .eu,
 *  .com and .jp cannot have it deduced, because after signing out the next org is a choice nobody
 *  but them has made yet. Reported, and the earlier reasoning was mine and wrong.
 *
 *  So the picklist is beside the button and is always there, offering every data centre rather than
 *  the ones already mirrored - wanting to open .jp while the default is .eu is exactly the case, and
 *  a control that only offers what you have been to before cannot serve it. What it opens on is what
 *  is known: the workspace, then the tab, then the default in Settings. */
/** The data centres, derived from the manifest instead of typed.
 *
 *  It was a literal list in two places - here and the Settings form - held together by a test,
 *  which is a checker standing in for a source of truth. The manifest already *is* that source:
 *  a host this extension cannot reach is not a destination it may offer, and one it can reach is.
 *  Adding a data centre is then one edit, in the file that has to change anyway.
 *
 *  Measured while asking whether the list was complete, and it is not: Zoho answers on
 *  zoho.sa, zoho.uk, zoho.ae and zoho.com.cn with the same shape as the six here, and neither
 *  manifest grants them. That is a permissions change and is not made in passing. */
const DCS = [...new Set((chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => h.startsWith('https://crm.'))
  .map((h) => h.slice('https://crm.'.length).replace(/\/.*$/, '')))].sort();
const dcOf = (origin) => (String(origin || '').match(/^https:\/\/[^.]+\.(.+)$/) || [])[1] || null;
function renderGoDc() {
  const sel = $('gozohodc'); if (!sel) return;
  const want = sel.dataset.touched ? sel.value
    : (dcOf(bound?.base) || dcOf(lastCtx?.origin) || zohoDc);
  if (sel.options.length !== DCS.length) {
    sel.innerHTML = DCS.map((d) => `<option value="${escA(d)}">${escHtml(d)}</option>`).join('');
  }
  sel.value = DCS.includes(want) ? want : DCS[0];
}
function homeUrl() {
  const dc = ($('gozohodc') && $('gozohodc').value) || dcOf(bound?.base) || dcOf(lastCtx?.origin) || zohoDc;
  // Production, never the sandbox: this is the way *in*, and a sandbox host is a place you arrive at
  // from a workspace that already knows it is one.
  return `https://crm.${dc}/crm/ShowHomePage.do`;
}
/** Take the reader to a page of their Zoho CRM, without taking their shell away.
 *
 * **A tab is a tree of documents, and we were navigating the wrong one.** On a plain CRM tab there is
 * one document and it is the CRM. Inside a suite shell - Zoho One, and CRM Plus the same way - the
 * CRM is an iframe on `crm.zoho.<dc>` and the *tab* is the shell. Thirteen call sites said «take this
 * TAB to this address», which is right in the first case and, in the second, throws away the shell
 * the reader was working in and lands them on a bare CRM.
 *
 * The address itself was never the problem, and that is worth stating because it is what made this
 * safe to fix: hovering a module link inside the shell shows
 * `https://crm.zoho.<dc>/crm/<portal>/tab/<Module>` in the status bar - absolute, on the CRM's own
 * origin, character for character what `openModulePage` builds. **Zoho publishes that entry point
 * itself**, so nothing here is guessed about somebody else's router, which is the thing this project
 * refuses to do. We move the frame the bridge already talks to, which is what clicking that link does.
 *
 * On a plain CRM tab the CRM frame *is* the tab's document - frame 0 - so this navigates the tab and
 * one code path serves both. A tab with no CRM frame at all falls back to navigating the tab, which
 * is where it started; in that state the Zoho-bound controls are blocked anyway.
 *
 * Returns the tab id, or null when there was nothing to move.
 */
// **Nothing navigates anywhere this extension is not allowed to be.** Every «Open in Zoho» builds its
// URL from `bound.base`, and `bound` is `.zoost.json` - a file on disk, in a folder the user may have
// been given rather than made. `guardOk()` compares that origin against the tab before a *pull*; no
// navigation asked anything, so a workspace received from somebody else could point a control
// labelled with Zoho's name at any origin, in the user's own Zoho frame.
//
// The check is here and not at the six builders, because a seventh added tomorrow inherits it - the
// same argument `safePath` makes in the bridge. The families come from `host_permissions`, so this
// cannot drift from what the manifest actually grants.
// The hosts, exactly, out of `host_permissions` - not a prefix. Written as a prefix first, and
// `https://crm.zoho.eu.evil.com/` walked straight through it: `^https://crm\.zoho` is happy with any
// domain that *starts* that way. A host is a whole string or it is somebody else's.
const ZOHO_HOSTS = new Set(ZOHO_MATCHES.map((h) => {
  try { return new URL(h.replace(/\*$/, '')).host; } catch (_) { return null; }
}).filter(Boolean));
function zohoUrlOk(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ZOHO_HOSTS.has(u.host);
  } catch (_) { return false; }
}
async function goToZoho(url, opts = {}) {
  if (!zohoUrlOk(url)) {
    // Said, not swallowed: a control that does nothing is the failure this repository refuses, and
    // the reason is worth the reader's attention - it is about the workspace, not about the click.
    setStatus('This workspace points at ' + (((url || '').match(/^https?:\/\/[^/]+/) || [])[0] || 'somewhere')
      + ', which is not a Zoho address. Nothing was opened - check where this workspace folder came from.', 'bad');
    return null;
  }
  if (opts.newTab) { const t = await chrome.tabs.create({ url, active: true }); return t.id; }
  let id = await zohoTabId();
  if (!id) { const t = await chrome.tabs.create({ url, active: opts.active !== false }); return t.id; }
  const fid = await crmFrameId(id);
  // Frame 0 is the tab's own document: moving it and moving the tab are the same act, and
  // `chrome.tabs.update` is the one that also raises the tab.
  if (fid) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [fid] },
                                             func: (u) => { location.href = u; }, args: [url] });
      if (opts.active !== false) await chrome.tabs.update(id, { active: true });
      return id;
    } catch (_) {
      // A refused injection is not a reason to do nothing: fall through to the tab, which is the
      // behaviour every one of these call sites had before.
    }
  }
  await chrome.tabs.update(id, { url, active: opts.active !== false });
  return id;
}
async function openZohoHome() {
  if (sampleRefuse()) return;
  await goToZoho(homeUrl());
}
// Zoho's own page for one automation action. The paths were read off the address bar rather than
// guessed - `settings/alerts/<id>`, `settings/field-updates/<id>`, `settings/tasks/<id>`,
// `settings/webhooks/<id>` - which is the only way this project is allowed to build a URL: a
// certain path or nothing. The webhook one arrived last and was absent until it did, rather than
// being guessed from the pattern of the other three.
const ACTION_PATH = { email_notifications: 'alerts', field_updates: 'field-updates', tasks: 'tasks', webhooks: 'webhooks' };
function actionUrl(a) {
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  const seg = a && ACTION_PATH[a.kind];
  return (base && inst && seg && a.id) ? `${base}/crm/${inst}/settings/${seg}/${a.id}` : null;
}
// The template a notification sends is a page of its own, and the notification only names it -
// so the name is the link. A query string rather than a path, which is Zoho's shape here and not a
// pattern to extrapolate from the other three.
function templateUrl(a) {
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  const id = a && a.template && a.template.id;
  return (base && inst && id) ? `${base}/crm/${inst}/settings/templates?type=email&templateId=${encodeURIComponent(id)}` : null;
}
async function openZohoAt(url, what) {
  if (sampleRefuse()) return;
  if (!url) { setStatus(MSG.noActionTarget, 'warn'); return; }
  await goToZoho(url);
  setStatus(`Opened \u00ab${what}\u00bb in Zoho.`, 'ok');
}
async function openActionInZoho(a) { await openZohoAt(actionUrl(a), a.name || a.id); }
async function openModulePage(genName, navigable, label) {
  if (sampleRefuse()) return;
  if (navigable === false) { setStatus(`\u00ab${label || genName}\u00bb has no records tab (linking/subform or no access).`, 'warn'); return; }
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !genName) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  await goToZoho(`${base}/crm/${inst}/tab/${genName}`);
  setStatus(`Opened \u00ab${genName}\u00bb in Zoho.`, 'ok');
}
async function openModuleLayouts(gen) {
  if (sampleRefuse()) return;
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !gen) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  await goToZoho(`${base}/crm/${inst}/settings/modules/${gen}/layouts`);
  setStatus(`Opened ${gen} layouts in Zoho.`, 'ok');
}
async function openModuleLayout(gen, layoutId) {
  if (sampleRefuse()) return;
  const base = bound?.base || lastCtx?.origin, inst = bound?.instance || lastCtx?.instance;
  if (!base || !inst || !gen) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  await goToZoho(layoutId ? `${base}/crm/${inst}/settings/modules/${gen}/layouts/${layoutId}` : `${base}/crm/${inst}/settings/modules/${gen}/layouts`);
  setStatus(layoutId ? 'Opened the layout in Zoho.' : `Opened ${gen} layouts in Zoho.`, 'ok');
}
function moduleNavigable(m) {
  const gen = m.module_name || '', api = m.api_name || '';
  if (/^LinkingModule\d+$/i.test(gen)) return false;   // junction (many-to-many) modules
  if (/__s$/i.test(api)) return false;                  // system modules (e.g. Approval_Action_Logs__s) have no records tab
  if (['linking', 'subform'].includes(m.generated_type)) return false;
  if (m.viewable === false || m.visible === false || m.api_supported === false) return false;
  return true;
}
async function switchTab() {
  if (sampleRefuse()) return;
  if (!bound || !bound.base || !bound.instance) { setStatus('Unknown target - pull that workspace once from its own tab.', 'warn'); return; }
  const targetHome = `${bound.base}/crm/${bound.instance}/`;
  const curBase = (lastCtx && lastCtx.origin) || bound.base;
  const id = await activeZohoTabId();
  // Same Zoho account (prod <-> sandbox on the same data center) shares an SSO session: just navigate, no logout.
  const dc = (b) => (b || '').replace(/:\/\/(crm|crmsandbox)\./, '://');
  const sameAccount = dc(curBase) === dc(bound.base) && envOf(curBase) !== envOf(bound.base);
  // The tab, not the frame, and both branches of this function mean it. Ending a session is not a
  // navigation inside somebody's shell: a logout in an iframe leaves the shell around it holding a
  // session that no longer exists. `goToZoho` is for going to a *page*.
  if (sameAccount) {
    if (id) await chrome.tabs.update(id, { url: targetHome, active: true }); else await chrome.tabs.create({ url: targetHome, active: true });
    return;
  }
  // Different account: a clean logout + re-login is required. Confirm first, since it ends the current Zoho session.
  const ok = window.confirm(`Switch to «${bound.instance}» (org ${bound.org})?\n\nThis logs you out of the current Zoho session «${lastCtx?.instance || '?'}» (org ${lastCtx?.org || '?'}) and takes this tab to the login for the target org.`);
  if (!ok) return;
  const accounts = curBase.replace(/:\/\/[^.]+\./, '://accounts.');   // crm./crmsandbox. -> accounts.
  const url = `${accounts}/logout?servicename=ZohoCRM&serviceurl=${encodeURIComponent(targetHome)}`;
  if (id) await chrome.tabs.update(id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
}
async function openTargetZoho(newTab) {
  if (sampleRefuse()) return null;   // null, not undefined: the caller reads it as "no tab id"
  const url = functionsUrl();                       // prefers the ACTIVE workspace's base+instance
  if (!url) { setStatus(MSG.noTarget, 'warn'); return null; }
  return goToZoho(url, { newTab });
}
$('funcs').onclick = () => openTargetZoho(false);
// Touched by hand, so the next repaint leaves it alone: this control is redrawn on every
// workspace change, and a choice that is reset while you are looking at it is not a choice.
$('gozohodc').onchange = () => { $('gozohodc').dataset.touched = '1'; };
$('gozoho').onclick = () => openZohoHome();
$('mmgo').onclick = () => switchTab();   // mismatch: log out current session and land on the workspace's org (current tab)



// Find = fill the Zoho functions-list search box with this function's name. We wait (bounded, in
// reveal) for the search box to exist - a known, language-independent element - then fill it ONCE.
// If it is not there, we STOP and say exactly that, instead of retrying an action we are not sure of.

// Navigate to the Zoho Functions list (deterministic URL) and pre-filter it to `fn` (Find). The
// only DOM touch left is filling the class-selected search box; there is no click-and-hope here.
/** Take the reader to their functions in Zoho, and stop there.
 *
 * **This used to type into Zoho's own search box** - the single exception the first non-negotiable
 * carried, and the last thing this product wrote into somebody else's page: `focus()`, the native
 * value setter, three synthetic events. Zoho is building a functions interface addressed by URL,
 * which makes the exception unnecessary, so the panel navigates and lets their page decide what to
 * show. A reader on the old interface lands on the list, which is exactly where the typing left them
 * anyway; a reader on the new one gets whatever that address resolves to.
 *
 * **No deep link to the one function, and that is a limit rather than an oversight.** The new
 * interface addresses a function by an id from its own module, and the id this product holds is that
 * record's `dependent_id` - measured across the fifteen functions present in two captures of one
 * org, fifteen of fifteen. Sending the id we have would address the wrong function, or none. Until
 * that mapping is pulled the certain thing is the list, and the certain thing is what ships.
 */
async function reveal(fn) {
  if (sampleRefuse()) return;
  const url = functionsUrl();
  if (!url) { setStatus(MSG.noTarget, 'warn'); return; }
  let id = await zohoTabId();
  if (!id) { id = await openTargetZoho(false); if (!id) return; }
  setStatus(MSG.openingFns, 'busy');
  await goToZoho(url);
  setStatus(`Zoho\u0027s functions are open - look for \u00ab${fn.displayName || fn.name || fn.apiName}\u00bb.`, 'ok');
}



async function revealFromPreview(action) {
  if (currentPath && currentPath.startsWith('workflows/')) { await openWorkflowInZoho(currentPath.split('/').pop().replace(/\.json$/, '')); return; }
  if (currentPath && currentPath.startsWith('actions/')) { const a = actionData.find((x) => x.path === currentPath); if (a) await openActionInZoho(a); return; }
  if (currentPath && currentPath.startsWith('modules/')) {
    const m = moduleData.find((x) => x.path === currentPath); if (!m) return; if (action === 'filter') await openModuleLayouts(m.gen); else await openModulePage(m.gen, m.navigable, m.label); return;
  }
  const e = treeData.find((x) => x.path === currentPath); if (!e) return;
  const info = index.get(e.id);
  try { await reveal({ id: e.id, name: info?.name || e.api_name, displayName: e.display_name, apiName: e.api_name }); }
  catch (err) { setStatus('Find failed: ' + err.message, 'warn'); }
}
$('pvreveal').onclick = () => revealFromPreview('edit');
$('pvfind').onclick = () => revealFromPreview('filter');

// ---------- controls ----------
// Each mode keeps its own filter, and the value was read and written by two ternary chains over the
// same six variables - the shape that drifts the moment a seventh mode is added to one of them.
const curFilter = () => viewMode === 'functions' ? typeFilter : viewMode === 'modules' ? moduleFilter
  : viewMode === 'workflows' ? workflowFilter : viewMode === 'schedules' ? scheduleFilter
  : viewMode === 'actions' ? actionFilter : connCatFilter;
function setCurFilter(k) {
  if (viewMode === 'functions') typeFilter = k; else if (viewMode === 'modules') moduleFilter = k;
  else if (viewMode === 'workflows') workflowFilter = k; else if (viewMode === 'schedules') scheduleFilter = k;
  else if (viewMode === 'actions') actionFilter = k; else connCatFilter = k;
}
function buildTypeChips() {
  const wrap = $('typechips'); wrap.innerHTML = '';
  const defs = viewMode === 'functions'
    ? [['all', 'All'], ...NS.map((n) => [n, n === 'validation_rule' ? 'validation' : n]), ['rest', 'REST']]
    : viewMode === 'modules'
    ? [['all', 'All'], ['standard', 'Standard'], ['custom', 'Custom']]
    : viewMode === 'connections'
    ? [['all', 'All'], ['used', 'Used'], ['unused', 'Unused'], ['disconnected', 'Disconnected']]
    : viewMode === 'actions'
    // Derived from what is on disk, never a written list: `whatsapp`, `assign_owner` and
    // `create_record` all turned up in one real org and none of them was in anybody's list. A kind
    // Zoho adds tomorrow gets a filter without anyone remembering, and a kind with nothing in it
    // gets none - a value nothing lists is a value nothing can filter.
    ? [['all', 'All'], ...[...new Set(actionData.map((a) => a.kind))].sort().map((k) => [k, actionKindLabel(k)]), ['unused', 'Attached to nothing']]
    : viewMode === 'workflows'
    ? [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive'], ['scheduled', 'Has scheduled actions']]
    : [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive']];
  // The chips were rebuilt after every data load and reset the filter as a side effect: set Kind =
  // Webhooks, click a row's status dot, and the list was back to All with the control agreeing. The
  // filter each mode keeps is that mode's own variable, so it survives a rebuild - and a tab switch -
  // the way that tab's search text does. What must not survive is a value the new list cannot offer:
  // Actions derives its kinds from what is on disk, so a kind that has just disappeared would filter
  // everything out with no way back. Derived from the options rather than from which caller it was.
  const keep = defs.some(([k]) => k === curFilter()) ? curFilter() : 'all';
  setCurFilter(keep);
  // A one-line dropdown, not chips: in Functions mode there are 7 filters and they wrapped to a
  // second row, eating vertical space the tree/preview below needs more than the filter does.
  const lbl = document.createElement('span'); lbl.className = 'fsellbl';
  lbl.textContent = viewMode === 'functions' ? 'Type' : (viewMode === 'modules' || viewMode === 'actions') ? 'Kind' : viewMode === 'connections' ? 'Filter' : 'Status';
  const sel = document.createElement('select'); sel.className = 'filtersel'; sel.setAttribute('aria-label', lbl.textContent + ' filter');
  defs.forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; sel.appendChild(o); });
  sel.value = keep;
  sel.onchange = () => {
    const k = sel.value;
    setCurFilter(k);
    (viewMode === 'functions' ? runSearch() : viewMode === 'modules' ? renderModules() : viewMode === 'workflows' ? renderWorkflows() : viewMode === 'schedules' ? renderSchedules() : viewMode === 'actions' ? renderActions() : renderConnections());
  };
  wrap.appendChild(lbl); wrap.appendChild(sel);
  // Two lists have columns worth sorting by, and they get the same control - one built here rather
  // than a second one written beside it, or the two would drift the way every duplicated thing in
  // this panel has. What differs is the keys and the state each list keeps.
  if (viewMode === 'functions' || viewMode === 'actions') {
    const acts = viewMode === 'actions';
    const sl = document.createElement('span'); sl.className = 'fsellbl'; sl.textContent = 'Sort';
    const ss = document.createElement('select'); ss.className = 'filtersel';
    ss.setAttribute('aria-label', acts ? 'Sort actions' : 'Sort functions');
    (acts
      ? [['name', 'Kind, then name'], ['rules', 'Rules that fire it'], ['module', 'Module'], ['modified', MSG.lastModified]]
      : [['name', 'Name (grouped)'], ['lines', 'Lines'], ['calls', 'API calls'], ['size', 'Size'], ['modified', MSG.lastModified]])
      .forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; ss.appendChild(o); });
    ss.value = acts ? actionSort : treeSort;
    const dirBtn = document.createElement('button'); dirBtn.className = 'sortdir';
    const paintDir = () => {
      const asc = (acts ? actionSortDir : treeSortDir) === 'asc';
      dirBtn.textContent = asc ? '↑' : '↓';
      const byName = acts ? (actionSort === 'name' || actionSort === 'module') : treeSort === 'name';
      dirBtn.title = byName
        ? (asc ? 'A to Z - click for Z to A' : 'Z to A - click for A to Z')
        : (asc ? 'Lowest first - click for highest first' : 'Highest first - click for lowest first');
      dirBtn.setAttribute('aria-label', dirBtn.title);
    };
    // Changing what you sort by resets the direction to the one that is almost always wanted:
    // names read A→Z, numbers read biggest-first.
    ss.onchange = () => {
      if (acts) { actionSort = ss.value; actionSortDir = (actionSort === 'name' || actionSort === 'module') ? 'asc' : 'desc'; }
      else { treeSort = ss.value; treeSortDir = treeSort === 'name' ? 'asc' : 'desc'; }
      paintDir(); (acts ? renderActions() : renderTree());
    };
    dirBtn.onclick = () => {
      if (acts) actionSortDir = actionSortDir === 'asc' ? 'desc' : 'asc';
      else treeSortDir = treeSortDir === 'asc' ? 'desc' : 'asc';
      paintDir(); (acts ? renderActions() : renderTree());
    };
    paintDir();
    wrap.appendChild(sl); wrap.appendChild(ss); wrap.appendChild(dirBtn);
  }
}
$('nameToggle').onclick = () => {
  if (viewMode === 'functions') {
    nameMode = nameMode === 'internal' ? 'display' : 'internal';
    $('nameToggle').textContent = MSG.namePrefix + nameMode;
    renderTree(); if (currentPath) showCallers(currentPath); redrawNavMenu();
  } else {
    moduleNameMode = moduleNameMode === 'api' ? 'display' : moduleNameMode === 'display' ? 'generated' : 'api';
    $('nameToggle').textContent = MSG.namePrefix + moduleNameMode;
    renderModules(); redrawNavMenu();
  }
};
// ---- keyboard: the selection follows the arrows ------------------------------------------------
// The twin of the Analytics panel's, against the tree instead of a table: up and down used to
// scroll, and what a reader wants is the next function *open*. Only rows that are on screen take
// part - a collapsed group's children are not there to be stepped onto, and neither is anything the
// search or the type filter has taken away.
let stepAnchor = null;      // where the keyboard is, which the DOM learns a tick later
// Bring a row fully into view, under whatever is stuck to the top of the list. `scrollIntoView`
// with `block: 'nearest'` aligns to the container's edge and knows nothing about a sticky header -
// so stepping upwards parked the selected row exactly underneath it, half visible. Reported after
// the arrows landed: the movement was right and the row was not all there.
//
// The header is measured rather than assumed: it is a column row in one product and a group label
// in the other, both `position: sticky`, and both change height with the font a reader has set.
/** Mark a row as the selected one **and bring it into view** - one act, which was five.
 *
 *  Every list here had the first half; only the functions tree had the second, so a jump from a
 *  health row, a link in the code or a step of the history selected a module, a workflow or a
 *  connection that the reader then had to scroll to find. Reported exactly that way: «the highlighted
 *  item must always be visible». `openFile()` keeps its own two lines because it also
 *  moves the arrow anchor; everything else calls this, so the next list inherits both halves.
 */
/** Move the view to the current item. Called when the geometry is final, never by whoever opened it.
 *
 *  Measured rather than guessed, after five attempts that were not. The recorded sequence of one
 *  jump reads: the list is drawn, the reveal runs and finds the row **inside** a 376px box so it
 *  correctly does nothing, and only *then* the detail pane opens and the box becomes 68px. Nothing
 *  reveals after that, so whether the row is still on screen depends on where the scroll happened to
 *  be - which is exactly what «random» looks like from the outside.
 *
 *  So the event is not «the list has been drawn»: it is «the pane has opened», which is what changes
 *  the height. Reading the row's rect here forces the pending layout, so this sees the new geometry
 *  and not the old.
 */
function applySelection(byClick) {
  if (!currentPath) return;
  const box = $('tree'); if (!box) return;
  const row = [...box.querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === currentPath);
  if (!row) return;
  // **Arriving** is not **stepping**, and they want different things. `revealRow()` scrolls the least
  // it can - the right answer for the arrows, where a list that jumps under you is worse than one
  // that barely moves - but it means a jump lands at the top edge when you came from below and at
  // the bottom edge when you came from above, which reads as two behaviours. Reported that way.
  // A jump puts the row a couple of rows down from the top of the list instead: one place, always,
  // with what precedes it visible.
  const st = box.querySelector('.grp');
  const cover = st ? st.getBoundingClientRect().height : 0;
  // The origin travels with the call rather than in a variable shared between two navigations: a
  // click whose open then failed - no permission, an unreadable file - used to leave the flag set,
  // and the *next* arrival from somewhere else was mistaken for that click and never revealed.
  if (byClick) return;                    // your own click: the list stays put
  revealRow(row, box, '.grp');   // arrived from elsewhere: the least scroll that shows it
}

/** Open the detail pane - one function, because opening it is what shrinks the list, and the six
 *  places that used to do it by hand each left the selected row wherever it happened to be. */
function showPreview(byClick) {
  $('preview').classList.add('show');
  $('resizer').classList.add('show');
  resetPreviewScroll();
  applySelection(byClick);
}

function selectRow(path) {
  document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
  const find = () => [...$('tree').querySelectorAll('.f[data-path]')].find((r) => r.dataset.path === path);
  let row = find();
  // Not there yet, for one of two reasons, and both were reported. The row may be inside a **closed
  // group** - every list here groups its rows and `collapsed` is shared, with a different key prefix
  // per list - or the list may not have been drawn yet, because arriving here changes tab and the
  // rebuild lands a tick later. Neither is worth teaching this function about: the group headers
  // already carry the code that opens them, so the ones that are closed are *clicked*, which is what
  // the reader would have done, and each list re-renders itself its own way. Then we look again on
  // the next frame, which is also the answer to the second reason.
  if (!row) {
    $('tree').querySelectorAll('.grp.collapsed').forEach((g) => g.click());
    row = find();
  }
  if (row) { revealRow(row, $('tree'), '.grp'); return; }
  requestAnimationFrame(() => {
    document.querySelectorAll('.f').forEach((x) => x.setAttribute('aria-selected', x.dataset.path === path));
    revealRow(find(), $('tree'), '.grp');
  });
}

function revealRow(el, box, stickySel) {
  if (!el || !box) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const st = stickySel ? box.querySelector(stickySel) : null;
  const cover = st ? st.getBoundingClientRect().height : 0;
  const top = b.top + cover;              // the first line the reader can actually see
  if (r.top < top) box.scrollTop -= (top - r.top);
  else if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom);
}

function stepSelection(delta, edge) {
  const rows = [...$('tree').querySelectorAll('.f[data-path]')].filter((el) => el.offsetParent !== null);
  if (!rows.length) return;
  // The anchor is remembered here, not read back from the tree. Opening a function reads its file,
  // so `aria-selected` lands a tick later: holding the arrow down asked the DOM where it was before
  // the DOM knew, found nothing, and started from the top again - every press selecting the first
  // row. Measured by pressing twice and landing on row one. The attribute is still the truth for a
  // screen reader; this is just what the keyboard steps from.
  const cur = rows.find((r) => r.dataset.path === stepAnchor)
    || $('tree').querySelector('.f[data-path][aria-selected="true"]');
  let i;
  if (edge === 'first') i = 0;
  else if (edge === 'last') i = rows.length - 1;
  else {
    const at = cur ? rows.indexOf(cur) : -1;
    i = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
  }
  const el = rows[i];
  if (!el || el === cur) return;
  stepAnchor = el.dataset.path;
  // **The row is clicked, not opened as a function.** This list is the functions tree in one mode
  // and modules, workflows, schedules, actions or connections in the others, and each row already
  // carries what opening it means. Calling openFromTree() on all of them read an action's row as a
  // path to a .dg file and answered «A requested file or directory could not be found» - reported
  // from the Actions tab. A click is the one thing every row knows how to be.
  el.click();
  // The group header is sticky here, and it is the previous group's label that covers the row you
  // have just stepped up onto.
  revealRow(el, $('tree'), '.grp');
}

// ---------- history: the chain you have walked, and the way back up it ----------
// A browser's three: back, forward, and the list itself, because «back» alone only reaches the step
// before - the author asked to be able to «risalire la catena», which is the list.
//
// Keyed by `currentPath`, which every opener in this panel sets and whose prefix says what kind of
// thing it is; `navOpen()` is that discrimination once, in the order `aiFocusLabel()` already uses.
// A new tab joins the history by setting `currentPath` like its siblings, with nothing to add here.
const NAV_MAX = 50;
let navHist = [], navPos = -1, navReplaying = false, navSeq = 0;

/** Record where we have just arrived. Called by the openers, so every way in is covered - a click in
 *  the tree, an arrow key, a search result, a link in a code pane or in «Used in». A step onto the
 *  item already showing is not a step: re-opening after a pull would otherwise fill the chain with
 *  the same name. `n` is the unique runtime id - the menu's key, and the reason a place visited
 *  twice stays two rows rather than collapsing into one. */
function navHere(label) {
  if (navReplaying || !currentPath) return;
  const cur = navHist[navPos];
  if (cur && cur.path === currentPath) { if (label) cur.label = label; updateNav(); return; }
  // Stepping somewhere new drops what was ahead, exactly as a browser does: the forward arrow means
  // «where I came back from», and after a turn there is no such place any more.
  navHist = navHist.slice(0, navPos + 1);
  navHist.push({ n: ++navSeq, path: currentPath, label: label || currentPath.split('/').pop(), at: Date.now() });
  if (navHist.length > NAV_MAX) navHist.shift();
  navPos = navHist.length - 1;
  updateNav();
}
/** The name the header ended up showing is the name the chain shows. Openers know their item's real
 *  name at different moments - some after reading the file - so the label is taken from the one
 *  funnel they all pass through rather than from six call sites that could each forget. */
function navLabel(name) {
  const cur = navHist[navPos];
  if (cur && name) { cur.label = name; updateNav(); }
}
/** The names this item is known by, kept on the step itself.
 *
 *  Deriving them at draw time from `treeData` worked only while the reader was on the tab that holds
 *  them: in Workflows, `treeData` is the rules, so every function in the chain fell back to its file
 *  name and the panel showed `alertcompito....dg`. Reported with a picture. Recorded here instead,
 *  where the opener has just read the row, so which tab is open afterwards cannot change what a step
 *  is called.
 */
function navNames(names) {
  const cur = navHist[navPos];
  if (cur && names) { cur.names = names; updateNav(); }
}
function navClear() { navHist = []; navPos = -1; closeNavMenu(); updateNav(); }

async function navOpen(p) {
  const find = (arr) => (arr || []).find((x) => x.path === p);
  const gone = () => setStatus(MSG.navGone, 'warn');
  // Only when the tab actually changes. `setMode()` closes the detail pane - it has to, the pane is
  // showing something from the tab being left - so calling it for a step that is already on this tab
  // made every «back» close the pane, select the row and reopen it. Reported as a flicker, and it is
  // one: the reader is looking at the pane, and the pane is what blinked.
  const goMode = (m) => { if (viewMode !== m) setMode(m); };
  // A step can point into an area the role has stopped granting - the mirror still has the files,
  // the tab is gone. Same refusal as every other jump, from the one guard.
  if (!tabReachable(navKind(p) === 'function' ? 'functions' : navKind(p) + 's')) return;
  if (p.startsWith('workflows/')) { goMode('workflows'); await rebuildWorkflows(); const e = find(workflowData); return e ? openWorkflow(e) : gone(); }
  if (p.startsWith('schedules/')) { goMode('schedules'); await rebuildSchedules(); const e = find(scheduleData); return e ? openSchedule(e) : gone(); }
  if (p.startsWith('connections/')) { goMode('connections'); await rebuildConnections(); const e = find(connectionData); return e ? openConnection(e) : gone(); }
  if (p.startsWith('actions/')) { goMode('actions'); await rebuildActions(); const e = find(actionData); return e ? openAction(e) : gone(); }
  if (p.startsWith('modules/')) { goMode('modules'); await rebuildModules(); return openModule(p); }
  goMode('functions'); return openFile(p);
}

/** Go to step `i`. The position moves even when the item turns out not to be there any more - the
 *  same thing a browser does with a page that has since 404'd, and the status line says which it
 *  was. Pretending the step never existed would be worse: the chain is a record of where the reader
 *  went, not a claim that all of it still exists. */
async function navTo(i) {
  if (i < 0 || i >= navHist.length || i === navPos) return;
  const e = navHist[i];
  navPos = i; navShow(false); updateNav();
  navReplaying = true;
  try { await navOpen(e.path); } finally { navReplaying = false; }
}

// Each control is there only when it can do something, which is this panel's rule for the retry
// button, for Clear and for Forget. An arrow greyed out is a control saying «not now» in a place
// where nothing is ever going to make it work except walking somewhere first.
function updateNav() {
  $('pvback').classList.toggle('show', navPos > 0);
  $('pvfwd').classList.toggle('show', navPos >= 0 && navPos < navHist.length - 1);
  const seg = $('navtab');
  if (seg) seg.style.display = navHist.length ? '' : 'none';   // nowhere to go, nothing to offer
}
function closeNavMenu() { navShow(false); }
// Open it, or draw it again where it already is - the second is what the name toggle needs, and
// without it the chain kept the old names until it was closed and reopened.
function redrawNavMenu() { if (navOpenNow()) renderNav(); }
const navOpenNow = () => $('navview').classList.contains('show');
function navShow(on) {
  $('navview').classList.toggle('show', on);
  // The same class the health and AI views set, driving the same rules: while this is up, every
  // other control in the toolbar is dimmed and inert. Three views of the workspace, one behaviour.
  document.body.classList.toggle('nav-open', on);
  if (on) $('navname').textContent = MSG.namePrefix + nameMode;
  const seg = $('navtab');
  if (seg) { seg.classList.toggle('on', on); seg.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  if (on) renderNav();
}
function toggleNavMenu() { navShow(!navOpenNow()); }
/** The chain, drawn full width. Newest first - the reader is looking for where they were a moment
 *  ago, not for where they started - and the step they are on is marked rather than left out. */
function renderNav() {
  const body = $('navbody');
  // The same search box as every other tab, filtering the same way: by the name on screen, which is
  // the one `navLabelNow()` decides. A history that ignored the box while sitting in its place would
  // be a list that looks like the others and does not behave like them.
  const q = ($('navfind').value || '').trim().toLowerCase();
  const rows = navHist.map((e, i) => ({ e, i }))
    .filter(({ e }) => !q || navLabelNow(e).toLowerCase().includes(q) || navKind(e.path).includes(q));
  $('navcount').textContent = navHist.length
    ? `${rows.length === navHist.length ? navHist.length : rows.length + ' of ' + navHist.length} step${navHist.length > 1 ? 's' : ''}`
    : '';
  if (!navHist.length) {
    body.innerHTML = '<div class="nvnone">Nothing yet. Open a function, a rule or a module and every '
      + 'step you take is listed here - click one to go back to it.</div>';
    return;
  }
  if (!rows.length) { body.innerHTML = `<div class="nvnone">${escHtml(MSG.narrowNav)}</div>`; return; }
  body.innerHTML = rows.map(({ e, i }) => `<div class="nvrow${i === navPos ? ' at' : ''}" data-n="${escA(String(e.n))}" data-i="${escA(String(i))}" title="${escA(e.path)}">`
    + `<span class="nvk">${escHtml(navKind(e.path))}</span><span class="nvl">${escHtml(navLabelNow(e))}</span>`
    + `<span class="nvw">${escHtml(navWhen(e.at))}</span></div>`).reverse().join('');
  body.querySelectorAll('.nvrow').forEach((r) => { r.onclick = () => navTo(Number(r.dataset.i)); });
}
// What kind of thing a step was, from the same prefix navOpen() dispatches on - so the chain reads
// «workflow Invoice overdue» rather than a bare name that could be any of six things.
// When a step was taken. A real fact rather than something to fill a row with: with a chain that
// spans a session, «which of these two did I look at first» is a question the reader actually has,
// and the panel is the only thing that knows. Today's steps show the time alone - the date would be
// noise on every row - and anything older carries its day.
function navWhen(ms) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const sameDay = d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
    && d.getFullYear() === today.getFullYear();
  return sameDay ? t : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${t}`;
}
/** What to call a step *now*.
 *
 * The label captured when the step was taken is a fallback, not the answer: this panel lets the
 * reader switch between a function's display name and its api name, and between three names for a
 * module, and a chain still reading «Build invoice» while the tree reads `buildInvoice` is two lists
 * disagreeing about the same item. Reported. So the name is derived at draw time from the same rows
 * the tree and the module list derive theirs from - one source, so they cannot drift - and the
 * stored label is used only for something no longer in the mirror.
 */
function navLabelNow(e) {
  const n = e.names;
  if (e.path.startsWith('modules/')) {
    if (n) return (moduleNameMode === 'display' ? n.display : moduleNameMode === 'generated' ? n.gen : n.api) || e.label;
    const m = moduleData.find((x) => x.path === e.path);
    return m ? (moduleNameMode === 'display' ? m.label : moduleNameMode === 'generated' ? m.gen : m.api_name) : e.label;
  }
  if (e.path.startsWith('functions/')) {
    if (n) return (nameMode === 'display' ? n.display : n.api) || e.label;
    const f = treeData.find((x) => x.path === e.path);
    return f ? labelOf(f) : e.label;
  }
  return e.label;   // a rule, a schedule, an action, a connection: one name each, and it was recorded
}
function navKind(p) {
  if (p.startsWith('workflows/')) return 'workflow';
  if (p.startsWith('schedules/')) return 'schedule';
  if (p.startsWith('connections/')) return 'connection';
  if (p.startsWith('actions/')) return 'action';
  if (p.startsWith('modules/')) return 'module';
  // `.dg` is the extension Zoho gives a Deluge function's source, so every function in the chain
  // was labelled «diagram». Reported. The kinds here are the ones `navOpen()` dispatches on, and
  // functions are its default: nothing else in this panel opens a file that is not one of the five
  // above.
  return 'function';
}

// Emptying the chain does not close what is open: the reader asked to forget where they have been,
// not to lose the thing they are reading. The step they are on is kept as the only entry, so the
// next link still has something to come back to.
$('navtab').onclick = () => toggleNavMenu();
$('codecopy').onclick = () => copyCode($('pvcode').textContent);
$('navfind').oninput = renderNav;
// The history's own Name. It moves *both* namings: it used to move the functions and leave the
// modules on whatever the Modules tab was set to, so half the chain answered the button - reported.
// A module has three names and a function two, so «internal» here is the api name for both, which is
// the pair a reader is switching between. A rule, a schedule, an action and a connection have one
// name each and cannot follow; that is Zoho's doing and is said in the guide rather than hidden.
// The lists underneath are redrawn as well: there is one naming, and coming out of the history onto
// a tree still labelled the old way is two lists disagreeing about the same item.
$('navname').onclick = () => {
  nameMode = nameMode === 'internal' ? 'display' : 'internal';
  moduleNameMode = nameMode === 'internal' ? 'api' : 'display';
  $('navname').textContent = MSG.namePrefix + nameMode;
  renderNav(); renderTree(); renderModules();
};
$('navclear').onclick = () => {
  const here = navHist[navPos];
  navHist = here ? [here] : []; navPos = navHist.length - 1;
  updateNav(); renderNav();
};
$('navx').onclick = () => navShow(false);
$('pvback').onclick = () => navTo(navPos - 1);
$('pvfwd').onclick = () => navTo(navPos + 1);
// Alt+arrows, because that is what a browser answers to and the hands already know it. Left alone
// inside a field, where the arrows belong to the text.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navOpenNow()) { navShow(false); return; }
  if (!e.altKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navTo(navPos - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navTo(navPos + 1); }
});

$('tree').addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  const edge = { Home: 'first', End: 'last' }[e.key];
  if (!step && !edge) return;
  e.preventDefault();
  stepSelection(step || 0, edge);
});

$('find').oninput = runSearch;
$('findx').onclick = () => { $('find').value = ''; runSearch(); $('find').focus(); };
$('smode').onclick = () => {
  if (viewMode !== 'functions') return;   // full-text search applies to function code only
  searchMode = searchMode === 'name' ? 'content' : 'name';
  $('smode').textContent = searchMode === 'name' ? 'in: names' : 'in: code';
  $('smode').classList.toggle('on', searchMode === 'content');
  $('rxmode').style.display = $('rxpick').style.display = searchMode === 'content' ? '' : 'none';
  if (searchMode !== 'content') $('rxmenu').classList.remove('show');
  // Leaving full-text with the pattern on takes the pattern with it, like the toggle going off:
  // a regex read as a name filter is a search for text that does not exist. Reported.
  if (searchMode !== 'content' && regexMode) { regexMode = false; $('rxmode').classList.remove('on'); $('find').value = ''; }
  $('find').placeholder = searchMode === 'name' ? MSG.findByName : MSG.findInCode;
  runSearch();
};
$('rxmode').onclick = () => {
  regexMode = !regexMode;
  $('rxmode').classList.toggle('on', regexMode);
  // Switching the toggle off clears the box: a pattern read as a literal is a search for text
  // that does not exist, and the reader would be left staring at «no matches» for \b\d{18}\b.
  // Switching it on keeps what was typed - a literal is often the seed of the pattern.
  if (!regexMode) $('find').value = '';
  runSearch();
};
// The saved patterns, offered where they are used. The background seeds the first two; the list
// itself lives in Settings, where it can be added to, edited and emptied; the menu reads it
// fresh on every open, and can append to it - its Save row, when there is a pattern to save.
async function loadRxShortcuts() {
  try {
    const st = await chrome.storage.local.get('rxShortcuts');
    return Array.isArray(st.rxShortcuts)
      ? st.rxShortcuts.filter((x) => x && typeof x.name === 'string' && typeof x.pattern === 'string' && x.name && x.pattern)
      : [];
  } catch (_) { return null; }   // null, not []: a read that failed is not an empty list
}
async function openRxMenu() {
  const menu = $('rxmenu');
  const list = await loadRxShortcuts();
  // The read yielded: the tab, the mode or the workspace may have moved meanwhile, and every one of
  // those hides the button. A menu for a control that is no longer there is not opened.
  if ($('rxpick').style.display === 'none') return;
  // Alphabetical by name, the way a reader scans a menu - storage order is append order, which
  // says when a pattern was saved and nothing else. The Settings list keeps storage order: rows
  // being edited must not reshuffle under the hands renaming them.
  const items = (list || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const rawQ = $('find').value.trim();
  // The save row exists only when there is something it could do: a pattern in the box that parses,
  // regex mode on, and a list that was actually read - saving over one that was not would overwrite
  // entries nobody has seen. A control that can do nothing goes away rather than sitting there.
  const savable = list !== null && regexMode && rawQ && !!rxCompile(rawQ).re;
  // A pattern already in the list is named, not re-offered: a second copy would be two menu
  // entries that search identically, and the name is how the reader finds the one they have.
  const already = savable ? items.find((x) => x.pattern === rawQ) : null;
  menu.innerHTML = items.map((x, i) => `<button data-rx="${escA(i)}"><span>${escHtml(x.name)}</span><span class="rxpat">${escHtml(x.pattern)}</span></button>`).join('')
    + (already ? `<div class="rxsave"><span class="rxnote">This pattern is already saved as "${escHtml(already.name)}".</span></div>`
      : savable ? `<div class="rxsave"><input id="rxsavename" placeholder="Name this pattern\u2026" maxlength="60" aria-label="Name for the pattern in the search box"><button data-save="1" title="Save the pattern in the search box under this name">Save</button><div class="rxerr" id="rxsaveerr"></div></div>` : '')
    + `<button class="rxman" data-man="1">${list === null ? 'The saved patterns could not be read. ' : (items.length ? '' : 'No saved patterns yet. ')}Manage\u2026</button>`;
  menu.querySelectorAll('[data-rx]').forEach((b) => {
    b.onclick = () => {
      menu.classList.remove('show');
      // The same guard as above, one interaction later: a pattern applied into a view whose search
      // no longer offers regex would filter names by a literal `\\b\\d{18}\\b`.
      if ($('rxpick').style.display === 'none') return;
      const x = items[+b.dataset.rx];
      $('find').value = x.pattern;
      if (!regexMode) { regexMode = true; $('rxmode').classList.add('on'); }
      runSearch();
    };
  });
  const sv = menu.querySelector('[data-save]');
  if (sv) {
    const doSave = () => saveSearchPattern(items, rawQ);
    sv.onclick = doSave;
    $('rxsavename').onkeydown = (e) => {
      // The panel's own shortcuts stay out of the input; Escape still bubbles to close the menu.
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key === 'Enter') doSave();
    };
  }
  menu.querySelector('[data-man]').onclick = () => { menu.classList.remove('show'); openSettings('#rx'); };
  const r = $('rxpick').getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.classList.add('show');
}

/** Save the pattern in the box under a name, or say why it cannot be saved.
 *
 * A declaration rather than an `= async () => {}`, which is a scope the race checker cannot enter -
 * and there is an await in the middle of it. `items` is carried in rather than read again: it is the
 * list the menu was drawn from, and the whole point of the two checks above the write is that they
 * are about *that* list.
 */
async function saveSearchPattern(items, rawQ) {
  const name = $('rxsavename').value.trim();
  // The same rules the Settings page enforces, refused with the reason in place.
  if (!name) { $('rxsaveerr').textContent = 'A pattern needs a name.'; return; }
  if (items.some((x) => x.name.trim().toLowerCase() === name.toLowerCase())) {
    $('rxsaveerr').textContent = `"${name}" is already taken - the menu could not tell them apart.`;
    return;
  }
  const dupP = items.find((x) => x.pattern === rawQ);
  if (dupP) { $('rxsaveerr').textContent = `This pattern is already saved as "${dupP.name}".`; return; }
  try { await chrome.storage.local.set({ rxShortcuts: [...items, { name, pattern: rawQ }] }); }
  catch (_) { $('rxsaveerr').textContent = 'Could not write the list - try from Settings.'; return; }
  openRxMenu();   // re-read and redraw: the new entry appearing in the list is the confirmation
}

$('rxpick').onclick = (ev) => {
  ev.stopPropagation();
  const menu = $('rxmenu');
  if (menu.classList.contains('show')) { menu.classList.remove('show'); return; }
  openRxMenu();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#rxmenu') && !e.target.closest('#rxpick')) $('rxmenu').classList.remove('show');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('rxmenu').classList.remove('show'); });

function runSearch() {
  // A contentSearch cannot be cancelled once running; what can be done is make its result refuse to
  // land. Any newer search - or the render of an emptied box - moves the sequence past it.
  searchSeq++;
  // The open preview shows the same search: matches painted in the source, cleared when the search
  // empties, changes mode or stops parsing - one call, because null clears.
  paintFindMarks($('pvcode'), findMarkRe());
  if (viewMode === 'modules') { renderModules(); return; }
  if (viewMode === 'workflows') { renderWorkflows(); return; }
  if (viewMode === 'schedules') { renderSchedules(); return; }
  if (viewMode === 'actions') { renderActions(); return; }
  if (viewMode === 'connections') { renderConnections(); return; }
  if (searchMode === 'content') { clearTimeout(_searchT); _searchT = setTimeout(contentSearch, 220); }
  else renderTree();
}

// Where a pattern matches inside one text, as [start, end) pairs - the pure half of the detail
// highlighter, lifted alone by tests/slice.mjs. Zero-length matches are stepped over, the same
// guard as everywhere else a user pattern runs.
function matchSpans(text, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex > text.length) break; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Paint every match of the active full-text search inside `root`, through the CSS Custom Highlight
// API: ranges over the rendered text nodes, no DOM mutation - so the syntax colouring underneath is
// untouched, and a match that crosses its token boundaries still paints whole. Byte-identical in
// both panels; the ::highlight(zoost-find) rule in each page gives the marks their colour.
function paintFindMarks(root, re) {
  if (!('highlights' in CSS)) return;   // without the API the search still works, unpainted
  CSS.highlights.delete('zoost-find');
  if (!root || !re) return;
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ n, at: text.length }); text += n.nodeValue; }
  const spans = matchSpans(text, re);
  if (!spans.length) return;
  const ranges = [];
  let i = 0;
  for (const [a, b] of spans) {
    while (i + 1 < nodes.length && nodes[i + 1].at <= a) i++;
    let j = i;
    while (j + 1 < nodes.length && nodes[j + 1].at < b) j++;
    const r = new Range();
    r.setStart(nodes[i].n, a - nodes[i].at);
    r.setEnd(nodes[j].n, b - nodes[j].at);
    ranges.push(r);
  }
  CSS.highlights.set('zoost-find', new Highlight(...ranges));
}

// The active full-text search as a compiled pattern, or null when there is nothing to paint: name
// mode, an empty box, or a pattern that does not parse.
function findMarkRe() {
  if (searchMode !== 'content') return null;
  const q = $('find').value.trim();
  if (!q) return null;
  if (!regexMode) return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
  return rxCompile(q).re || null;
}

// The search text as a pattern, or the reason it is not one. Case-insensitive like the plain
// search, and `m` so ^ and $ mean "at a line edge", which is what a reader of code or SQL expects.
// A declaration rather than an arrow because `tests/slice.mjs` lifts it out and runs it alone, and
// byte-identical in both panels: a test holds the twins to the same source.
function rxCompile(term) {
  try { return { re: new RegExp(term, 'gim') }; } catch (e) { return { error: String((e && e.message) || e) }; }
}

// One line with every match wrapped in <mark>, escaped piece by piece - escaping first and then
// matching the escaped text would miss any pattern that touches `<` or `&`. A zero-length match is
// stepped over rather than marked: `x*` matches the empty string everywhere, and the escaper is a
// parameter because the two panels name theirs differently.
function markLine(line, re, escFn) {
  let out = '';
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(line))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex > line.length) break; continue; }
    out += escFn(line.slice(last, m.index)) + '<mark>' + escFn(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escFn(line.slice(last));
}


/** Read one function's source into the map being built, or leave it out.
 *
 * A declaration rather than an `async (e) => {}` inside a `map`: the checker cannot enter one, and a
 * read that fails silently is the shape this repository has already paid for twice. It stays silent
 * here on purpose - the map is «what could be read», the search says how many it holds, and a file
 * that has gone since the tree was drawn is not an error to report.
 */
async function readSourceInto(m, e, op) {
  try { m.set(e.id, await op.read(e.path)); } catch (_) {}
}

/** Every source, once. Searching text means having read it - there is no index that spares this, and
 *  writing one would be a second answer to «what does this function say» that could disagree with the
 *  file. What can be spared is the *waiting*: the reads happen in tranches with a yield between them,
 *  the status line counts them off, and the cache is kept for the rest of the session, so this is
 *  paid once per workspace and never again until a pull changes something.
 *
 *  Measured on a generated org of 5,000 functions: 20,000 file-system calls the first time, none
 *  after. Before this, the panel simply stopped answering for the whole of it.
 */
async function getCodeCache(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (codeCache) return codeCache;
  const m = new Map();
  const rows = treeData.filter((e) => e.downloaded);
  const TRANCHE = 120;
  for (let i = 0; i < rows.length; i += TRANCHE) {
    await Promise.all(rows.slice(i, i + TRANCHE).map((e) => readSourceInto(m, e, op)));
    if (rows.length > TRANCHE) {
      op.say(`Reading sources ${Math.min(i + TRANCHE, rows.length)}/${rows.length}\u2026`, 'busy');
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (!op.current()) return null;
  // The line this loop opened is closed by the loop: a «busy» status left standing reads as a hang,
  // and it stood - «Reading sources 150/150…» with the spinner going, over a search long finished.
  // The Analytics twin (ensureSqlCache) has always closed its own. Reported.
  if (rows.length > TRANCHE) op.say(`${m.size} source(s) read.`, 'ok');
  codeCache = m; return m;
}
async function contentSearch() {
  const op = beginWorkspaceOp();
  const term = $('find').value.trim(); const tree = $('tree');
  if (!term) { renderTree(); return; }
  const rx = regexMode ? rxCompile(term) : null;
  if (rx && rx.error) {
    // «No matches» for a pattern that never ran would be the lie this panel exists to refuse.
    tree.innerHTML = `<div class="treemsg"><b>The pattern does not parse.</b> ${escHtml(rx.error)}. Nothing was searched - fix the pattern or switch .* off.</div>`;
    return;
  }
  const mine = searchSeq;
  tree.innerHTML = '<div class="treemsg">Searching\u2026</div>';
  const cache = await getCodeCache(op); if (mine !== searchSeq || !cache || !op.current()) return;
  const tl = term.toLowerCase();
  const results = [];
  const passType = (e) => typeFilter === 'all' || (typeFilter === 'rest' ? e.rest : e.namespace === typeFilter);
  for (const e of treeData) {
    if (!e.downloaded || !passType(e)) continue;
    const code = cache.get(e.id); if (!code) continue;
    let idx = -1, count = 0;
    if (rx) {
      const re = rx.re; re.lastIndex = 0; let m;
      while ((m = re.exec(code))) {
        if (!m[0]) { re.lastIndex++; if (re.lastIndex > code.length) break; continue; }
        if (idx < 0) idx = m.index;
        count++;
      }
      if (idx < 0) continue;
    } else {
      const lc = code.toLowerCase(); idx = lc.indexOf(tl); if (idx < 0) continue;
      let i = idx; while (i >= 0) { count++; i = lc.indexOf(tl, i + tl.length); }
    }
    const ls = code.lastIndexOf('\n', idx) + 1; let le = code.indexOf('\n', idx); if (le < 0) le = code.length;
    const lineNo = code.slice(0, idx).split('\n').length;
    results.push({ e, count, lineNo, line: code.slice(ls, le).trim().slice(0, 140) });
  }
  results.sort((a, b) => b.count - a.count || labelOf(a.e).localeCompare(labelOf(b.e)));
  tree.innerHTML = '';
  if (!results.length) { tree.innerHTML = `<div class="treemsg">No matches for "${escHtml(term)}".</div>`; return; }
  const total = results.reduce((n, r) => n + r.count, 0);
  const hdr = document.createElement('div'); hdr.className = 'srhdr'; hdr.textContent = `${total} match(es) in ${results.length} file(s)`; tree.appendChild(hdr);
  const hlRe = rx ? rx.re : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
  results.forEach((r) => {
    const el = document.createElement('div'); el.className = 'sr'; el.dataset.path = r.e.path;
    const hi = markLine(r.line, hlRe, escHtml);
    el.innerHTML = `<div class="srname">${escHtml(labelOf(r.e))} <span class="srcount">${r.count}</span></div><div class="srline"><span class="srln">${r.lineNo}</span> ${hi}</div>`;
    el.onclick = () => openFile(r.e.path, r.lineNo, true);   // at the match's line, not the top
    tree.appendChild(el);
  });
}

// ---------- pull / graph ----------
async function pullAll() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    await requirePerm(op.root);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance))) throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing to avoid cross-environment mix-ups.`);
    setStatus('Listing functions…', 'busy');
    const r = await toBridge({ cmd: 'listFunctions' }); if (!r?.ok) throw bridgeError(r, 'list failed');
    // Same rule as the reconciler, and here it was worse: the truncation was reported *after* the
    // pruning had already run, so the warning described files that were already gone.
    if (r.capped) {
      // **Said after the rebuild, because the rebuild speaks too.** The sentence went first and
      // `rebuildTree` then closed with «120 functions (120 downloaded).» in green - so a census that
      // had stopped early was handed to the reader as the whole org, which is the one thing a mirror
      // may never do. Nothing was pruned, and that part was right; what was lost was the telling.
      // Measured by driving the pull with a truncated list and recording the status line in order.
      await rebuildTree();
      setStatus(`Zoho returned a partial list (stopped at ${r.total}) - nothing was removed. Try again.`, 'warn');
      endPull(); return;
    }
    await op.write('functions/index.json', JSON.stringify(r.entries, null, 2));
    // reflect deletions: remove local files for functions no longer in Zoho
    const liveIds = new Set(r.entries.map((e) => String(e.id))); const rmF = [];
    for await (const p of walk(op.root)) {
      if (!p.startsWith('functions/')) continue;   // only a function has a .meta.json to prune by
      if (p.endsWith('.meta.json')) { try { const mm = JSON.parse(await op.read(p)); if (!liveIds.has(String(mm.id))) { rmF.push(p.replace(/\.meta\.json$/, '.dg')); rmF.push(p); } } catch (_) {} }
    }
    // Each removal, not the loop: `removeFile` resolves its path against the folder that is current
    // *now*, so a switch part-way through deletes the rest out of a workspace this pull never walked.
    const removed = await removeFunctionPaths(rmF, op);
    if (removed.moved) return;
    const prunedF = removed.removed.filter((p) => p.endsWith('.dg')).length;
    // If you were reading one of the functions the pull has just pruned, the pane is showing
    // something that no longer exists - in Zoho or on disk. Reported: it stayed open, with the code
    // of a deleted function in it. It closes with the file, the same way a live deletion closes it.
    if (currentPath && rmF.includes(currentPath)) {
      $('preview').classList.remove('show'); $('resizer').classList.remove('show'); currentPath = null;
    }
    // patchCfg, not writeCfg: this file also holds the access verdicts and the workspace's own
    // name, and a whole-object write here drops both. The trap arriving a third time.
    // The org's identity is the one thing that must never land in another folder: written there,
    // two workspaces answer to the same id and only a hand-edited `.zoost.json` separates them
    // again. Checked immediately before, because everything above it awaited.
    if (!op.current()) return;
    await patchCfg({ org: ctx.org, instance: ctx.instance, base: ctx.origin, lastPull: new Date().toISOString() }, op);
    // Every field the binding carries, or the guard that reads one of them silently stops firing.
    // A pull cannot run on a sample - guardOk refuses it - so this can only ever be false here, and
    // writing it out is what stops the next field added to .zoost.json being dropped in this line.
    // Through the op, and asked again after it: `bound`, the binding cache, the tree and the
    // download queue are all about the workspace the panel is showing. The config read above and
    // this publication both travel through the operation, never through the current global folder.
    const _c = (await opReadCfg(op)) || {};
    if (!op.current()) return;
    bound = { org: ctx.org, base: ctx.origin, instance: ctx.instance, label: _c.label || '', sample: !!_c.sample };
    await cacheBinding(bound);
    await rebuildTree();
    await downloadMissing();   // fetch each function's code, resiliently (partials stay; failures can be retried)
    if (prunedF) setStatus($('stxt').textContent + ` \u00b7 ${prunedF} deleted removed`, 'ok');
    if (removed.failed) setStatus($('stxt').textContent + ` \u00b7 ${removed.failed} stale file(s) could not be removed - \u21bb Refresh retries`, 'warn');
    // **The truncation is said where it is discovered, and this line is gone.** It sat here because
    // the ceiling had been introduced without anybody reading `capped` at all - the right complaint,
    // fixed in the wrong place: the branch that handles a truncated list returns three hundred lines
    // above, so nothing could ever reach this. Two warnings about one fact, one of them unreachable,
    // is worse than one - it reads as cover that is not there. The live one refuses to prune and says
    // so after the tree is drawn, which is where a reader is looking.
    await noteAccess('functions', removed.failed ? { status: 0, message: `${removed.failed} stale function file(s) could not be removed` } : null, op);
  } catch (e) { await notePullFailure('functions', e, op); } finally { endPull(); }
}
// The call graph with everything around it: what fires the code, and what the code reaches out to.
//
// A separate function on purpose. `ensureGraph()` has eleven other readers - the health audit, the
// exports, the AI index, the connection usage counts - and every one of them assumes each node is a
// Deluge function. Widening that shape would have made all eleven quietly wrong, so the enrichment
// lives here and only the diagram window sees it.
//
// Everything it adds is already on disk. Nothing is fetched, and nothing is inferred: a workflow
// fires a function because its own JSON says so, a schedule because its index row names it, a
// connection because the function's captured meta lists it.
const CTX_ID = { wf: (id) => 'wf:' + id, sch: (id) => 'sch:' + id, conn: (name) => 'conn:' + name,
                 act: (kind, id) => 'act:' + kind + ':' + id, mod: (api) => 'mod:' + api };
/** A node that is not a Deluge function.
 *
 *  `entity` is what kind of *thing* it is and `category` is what kind of that thing: a function is
 *  `functions` + its Deluge category, an action is `actions` + `email_notifications`. The two were
 *  one field while every non-function entity had exactly one category, and the moment actions
 *  arrived - four kinds under one entity - the graph window's chips put them among the Deluge
 *  categories, which is a dimension error of the sort this file already records twice. Splitting the
 *  field is what lets the chips have an Actions box with four chips in it, the same shape as the
 *  Functions box, without anything being enumerated in the window. */
function ctxNode(id, name, category, namespace, file, extra) {
  return Object.assign({
    id, name, api_name: name, display_name: name, namespace: namespace || '', category,
    calls: [], called_by: [], rest: false, dead_suspect: false, unresolved: [], ambiguous: [],
    associated_place: null, file: file || '', source_code: '', params: [], stats: null,
    description: '', connections: [], entity: category,
  }, extra || {});
}
async function callGraphWithContext(op = beginWorkspaceOp()) {
  const g = await ensureGraph(op);
  const nodes = {};
  for (const [id, n] of Object.entries(g.nodes)) {
    nodes[id] = Object.assign({}, n, { calls: n.calls.slice(), called_by: n.called_by.slice(), entity: 'functions' });
  }
  // The same resolution the health audit uses, and for the same reason: an action names a function
  // by id when Zoho gives one and by name when it does not.
  const byId = {}, byName = {};
  Object.values(nodes).forEach((n) => { if (n.id) byId[String(n.id)] = n; [n.name, n.api_name, n.display_name].forEach((k) => { if (k) byName[String(k).toLowerCase()] = n; }); });
  const link = (from, to) => { if (!from.calls.includes(to.id)) from.calls.push(to.id); if (!to.called_by.includes(from.id)) to.called_by.push(from.id); };
  const resolveFn = (a) => byId[String(a.id)] || byName[String(a.name || '').toLowerCase()] || null;

  // The actions index, so a rule can be linked to the thing it fires rather than to a name.
  const actIndex = new Map();
  let actRows = [];
  try {
    const rows = JSON.parse(await op.read('actions/index.json'));
    if (Array.isArray(rows)) { actRows = rows; rows.forEach((r) => actIndex.set(r.kind + ':' + String(r.id), r)); }
  } catch (_) { /* not pulled: the rules still draw, with fewer edges */ }

  // A module is a node only when something names it - a workflow it fires on, an action that writes
  // to it. Drawing every module in the mirror would put forty boxes with no arrow into a diagram
  // whose whole subject is what connects to what, and «nothing automates this module» is a
  // measurement the health view already makes. The label comes from the modules index when it is on
  // disk; without it the API name is what there is, and that is what it says.
  let modIdx = []; try { modIdx = JSON.parse(await op.read('modules/index.json')); } catch (_) {}
  const modLabel = {};
  (Array.isArray(modIdx) ? modIdx : []).forEach((m) => { if (m && m.api_name) modLabel[m.api_name] = m.plural_label || m.label || m.api_name; });
  const modOf = (api) => {
    if (!api) return null;
    const id = CTX_ID.mod(api);
    if (!nodes[id]) nodes[id] = ctxNode(id, modLabel[api] || api, 'modules', '', 'modules/index.json',
      { entity: 'modules', api_name: api });
    return nodes[id];
  };

  // Every action, not only the ones a rule was found to fire. Measured on a real org, roughly half
  // are attached to nothing - and an action nothing fires is exactly the kind of thing a diagram of
  // the wiring should show as a box on its own, rather than leave out and call the picture complete.
  actRows.forEach((r) => {
    if (!r || !r.kind) return;
    const id = CTX_ID.act(r.kind, r.id);
    if (!nodes[id]) nodes[id] = ctxNode(id, r.name || String(r.id), r.kind, '', 'actions/index.json',
      { entity: 'actions', _kind: r.kind });
    const m = modOf(r.module);
    if (m) link(nodes[id], m);
  });

  // ---- workflows: their own file says which functions each condition fires -------------------
  let wfIdx = []; try { wfIdx = JSON.parse(await op.read('workflows/index.json')); } catch (_) {}
  for (const w of wfIdx) {
    let d = null; try { d = JSON.parse(await op.read(`workflows/${w.id}.json`)); } catch (_) {}
    const node = ctxNode(CTX_ID.wf(w.id), w.name || String(w.id), 'workflows', w.module || '',
      `workflows/${w.id}.json`, { entity: 'workflows', _downloaded: !!d, _active: w.status !== 'inactive' });
    nodes[node.id] = node;
    // The module a rule fires on is a different fact from the module an action writes to, and both
    // are drawn: this one is «records of this kind are what set it off».
    { const m = modOf(w.module); if (m) link(node, m); }
    if (!d) continue;   // not pulled yet: it is a node with no measured actions, never a node with none
    (d.conditions || []).forEach((c) => {
      const acts = [];
      if (c.instant_actions && c.instant_actions.actions) acts.push(...c.instant_actions.actions);
      (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) => acts.push(...(sa.actions || [])));
      acts.filter(isFnAction).forEach((a) => { const fn = resolveFn(a); if (fn) link(node, fn); });
      // What else the rule fires. Until now the chain stopped at Deluge, which in a real org is the
      // smaller half - 275 notification actions against 149 function ones - so a diagram of «what
      // happens when this fires» was missing most of what happens. The nodes come from the actions
      // index, so an action nobody pulled is not invented here.
      acts.filter((a) => a && a.type && !isFnAction(a)).forEach((a) => {
        const row = actIndex.get(a.type + ':' + String(a.id));
        if (!row) return;
        const id = CTX_ID.act(row.kind, row.id);
        if (!nodes[id]) nodes[id] = ctxNode(id, row.name || String(row.id), row.kind, '',
          'actions/index.json', { entity: 'actions', _kind: row.kind });
        link(node, nodes[id]);
      });
    });
  }

  // ---- schedules: the index row carries the function it runs ---------------------------------
  let scheds = []; try { scheds = JSON.parse(await op.read('schedules/index.json')); } catch (_) {}
  scheds.forEach((sc) => {
    const node = ctxNode(CTX_ID.sch(sc.id), sc.name || String(sc.id), 'schedules', sc.frequency || '',
      'schedules/index.json', { entity: 'schedules', _active: sc.status !== 'inactive' });
    nodes[node.id] = node;
    const fn = resolveFn({ id: sc.function_id, name: sc.function_name });
    if (fn) link(node, fn);
  });

  // ---- connections: the join key is the name inside invokeurl [...connection:"..."] ------------
  let cat = []; try { cat = JSON.parse(await op.read('connections/index.json')); } catch (_) {}
  const conn = {};
  const ensureConn = (name, meta) => {
    const id = CTX_ID.conn(name);
    if (!conn[id]) { conn[id] = ctxNode(id, (meta && meta.label) || name, 'connections', (meta && meta.service) || '', 'connections/index.json', { entity: 'connections' }); nodes[id] = conn[id]; }
    return conn[id];
  };
  cat.forEach((c) => { if (c && c.name) ensureConn(c.name, c); });
  Object.values(nodes).forEach((n) => {
    if (n.entity !== 'functions') return;
    (n.connections || []).forEach((c) => { if (c && c.name) link(n, ensureConn(c.name, c)); });
  });

  // ---- and the counts follow the graph that is actually drawn ---------------------------------
  // "Nothing calls this" is now a stronger statement than it was, because a workflow and a schedule
  // are callers. A connection with no caller is a connection nothing uses - which is the same
  // candidate, never a verdict, that the panel already states with its coverage gap beside it.
  let dead = 0;
  Object.values(nodes).forEach((n) => {
    n.calls.sort(); n.called_by.sort();
    n.dead_suspect = !n.called_by.length && !n.rest && !(n.associated_place && n.associated_place.length);
    if (n.dead_suspect) dead++;
  });
  const edges = new Set();
  Object.values(nodes).forEach((n) => n.calls.forEach((c) => edges.add(n.id + '\u0000' + c)));
  return Object.assign({}, g, {
    nodes,
    counts: Object.assign({}, g.counts, { nodes: Object.keys(nodes).length, edges: edges.size, dead_suspects: dead }),
  });
}
async function openGraph() {
  if (!dir) return;
  const op = beginWorkspaceOp(), ws = graphIdentity();
  try {
    await requirePerm(op.root);
    if (!op.current()) return;
    setStatus('Building graph…', 'busy'); await refreshContext();
    const g = await callGraphWithContext(op);
    if (!(await publishGraph(g, op, ws))) return;
    setStatus(`Graph: ${g.counts.nodes} nodes, ${g.counts.edges} edges.`, 'ok');
  } catch (e) { if ((e && e.message) !== WS_MOVED) setStatus(MSG.graphErr + e.message, 'bad'); }
}

// ---------- health / audit ----------
// In health.js - the third slice. The runtime pull stays below with the other pulls.

// ---------- AI assistant ----------
// In ai.js, loaded just before this file - the first slice of splitting this panel. The
// declarations land in the same shared scope they always had; only the file changed.

// ---------- save-sync ----------

/** Build the graph the diagram window asked for and hand it back through the message port. */
async function sendGraphWhenBuilt(kind, token, sendResponse) {
  sendResponse(await buildGraphFor(kind, token));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'saved') syncOne(msg.id);
  // A deletion and a creation both mean «the list has changed»; neither is trusted with what
  // changed. Duplicates are harmless because reconciling is idempotent, which is why the hook no
  // longer needs to collapse them.
  if (msg?.type === 'deleted' || msg?.type === 'created') reconcileFunctions();
  if (msg?.type === 'pullProgress' && pullActive) setStatus(`Pulling… ${msg.done}/${msg.total}`, 'busy');
  // The diagram window asking for the other drawing. It has no folder access of its own - by design,
  // and it stays that way - so the graph is built here and left in storage for it to reload from.
  // Through a declaration: `.then(sendResponse)` is a scope nothing can read, and what it carries
  // is a whole graph built after an await.
  if (msg?.type === 'graphSwitch') { void sendGraphWhenBuilt(msg.kind, msg.token, sendResponse); return true; }
});
async function buildGraphFor(kind, token) {
  const op = beginWorkspaceOp(), ws = graphIdentity();
  try {
    if (!dir) throw new Error('no working folder is open in the panel');
    // ensurePerm only *asks* when the permission has lapsed, and asking needs a user gesture the
    // panel does not have here. If it has lapsed the switch stops and says so, rather than throwing
    // a DOMException whose message names neither the folder nor the remedy.
    if (!(await hasPerm(dir))) throw new Error('the working folder needs re-granting - click once in the panel');
    const g = kind === 'schema' ? await buildSchemaGraph(undefined, undefined, op) : await callGraphWithContext(op);
    if (!g.counts.nodes) throw new Error(kind === 'schema' ? 'no modules pulled yet' : 'no functions pulled yet');
    if (!op.current()) throw new Error(WS_MOVED);
    g.workspace = ws;
    // The window's own key: it sent its token with the ask, and reloads the same URL afterwards.
    await chrome.storage.session.set({ ['graphData:' + token]: graphForWindow(g) });
    op.say(`Diagram switched to ${kind === 'schema' ? 'modules' : 'functions'}.`, 'ok');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}
/** A function deleted in Zoho, removed from the mirror while you watch.
 *
 *  The id is in the URL of the DELETE, so this one knows exactly what went - no re-reading and no
 *  guessing. It prunes the two files and the index row, which is what a full pull would have done
 *  eventually; until now «eventually» meant the next pull, and a function you had just deleted sat
 *  in the tree looking real.
 *
 *  Same guards as a save, and for the same reason: this writes to the workspace, so it must refuse
 *  when the tab is not the org this workspace is bound to. */
/** Any notice from the page means one thing: **go and ask Zoho what exists now.**
 *
 *  It used to mean three. A save re-read one function, a creation re-read the list, and a deletion
 *  *acted* - it took an id out of a `window.postMessage` and removed files with it. That last one was
 *  an instruction rather than a hint, and the page's MAIN world is not ours: any script there can
 *  post the same message, and holding the id to digits limits its shape, not its authority. Raised
 *  by an outside review and it was right.
 *
 *  So nothing here trusts the notice. The list comes from Zoho, what is on it is fetched, and what
 *  is **not** on it is pruned - which is what a pull has always done, on the one signal that says it
 *  is worth doing now. A forged notice can therefore cost a list call and nothing else.
 *
 *  Single-flight, and the promise is stored **before the first await**, or two notices arriving
 *  together - which is exactly what a creation sends, POST then PUT - start two reconciliations that
 *  both write the index.
 */
let reconciling = null, reconcileAgain = false, pendingAfterPull = false, pendingRootReload = false;

// Ending a pull is one act, not five. A notice that arrived while a pull was running is left for
// the pull to consume - and only `pullAll` consumed it, so a change during a modules, workflows,
// schedules or failures pull sat in the flag until something else happened to ask. One helper, used
// by everything that owns `pullActive`, so a pull added tomorrow cannot forget the half nobody sees.
function endPull() {
  pullActive = false;
  if (pendingAfterPull) { pendingAfterPull = false; reconcileFunctions(); }
  if (pendingRootReload) { pendingRootReload = false; loadWorkspaces(); }
  // A working folder changed in the Settings tab while this pull was writing. The panel refuses to
  // switch workspace during a pull when *it* is asked - the list greys out and it says «Pull in
  // progress» - and that guard was on the panel's own controls only, so the same change made one
  // tab over walked straight past it. Deferred here, like the live-sync notice above, rather than
  // refused: the folder has already changed in storage and this panel cannot un-change it.
}

/** One round of «has anything changed in Zoho», from the checks to the tree.
 *
 * A declaration rather than the `(async () => {})()` it used to be: an async IIFE is a scope the race
 * checker cannot enter, and this is the longest sequence of awaits in the panel - permission, then
 * context, then a list from Zoho, then writes into the folder. `op` is passed in because the caller
 * took it when it still meant this workspace.
 */
async function reconcileNow(op) {
  if (mismatchRefuse()) return;
  if (!dir) { setStatus(MSG.noWorkspaceHere, 'warn'); return; }
  if (!(await hasPerm(dir))) { setStatus(MSG.folder, 'warn'); return; }
  await refreshContext();
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); return; }
  // A pull is already doing this and more. Re-running until it finishes would be a tight loop of
  // permission and context checks during the most expensive thing this panel does - measured at
  // five entries in one probe - so the notice is left for the pull to consume when it ends, and
  // this round simply stops. The flag is deliberately *not* re-armed here.
  if (pullActive) { pendingAfterPull = true; return; }
  try {
    setStatus('Something changed in Zoho - checking\u2026', 'busy');
    const r = await toBridge({ cmd: 'listFunctions' });
    if (!op.current()) return;           // the answer describes the workspace we were in, not this one
    if (!r?.ok) throw bridgeError(r, 'list failed');
    // A list that stopped early is not a statement about what exists: it is a statement about how
    // far the reading got. Writing it as the index, or pruning what is missing from it, deletes
    // functions that are still in Zoho - the worst thing this product could do, and reachable on
    // any org past the paging limit by an ordinary create. Raised by an outside review.
    if (r.capped) {
      await rebuildTree();
      setStatus(`Zoho returned a partial list (stopped at ${r.total}) - nothing was removed. Click Pull all.`, 'warn');
      return;
    }
    const live = new Set((r.entries || []).map((e) => String(e.id)));
    // What the mirror said *before* this answer replaces it, read from disk. It used to be
    // `treeData`, which is module state written only by `rebuildTree()` - and `rebuildTree()` runs
    // only while the Functions tab is the one on screen. So on any other tab, switching workspace
    // left `treeData` describing the workspace before: `gone` became «every downloaded function of
    // A» (ids of two orgs never intersect), and each was removed by relative path from **B's**
    // folder, announced as «Deleted in Zoho». A production/sandbox pair collides on nearly every
    // `functions/<namespace>/<api_name>.dg` there is.
    //
    // The sixth question this repository asks of every function - what survives a change of
    // workspace - answered for the two globals nobody had added to `dropWorkspaceState`. They are
    // dropped there now as well, but the real fix is this one: a destructive act reads the folder
    // it is about to act on, never a memory of some folder.
    let prev = [];
    try { const t = JSON.parse(await op.read('functions/index.json')); if (Array.isArray(t)) prev = t; } catch (_) {}
    if (!op.current()) return;
    await op.write('functions/index.json', JSON.stringify(r.entries, null, 2));
    // Pruned from what Zoho says, never from what the page said.
    // Whatever a previous round could not finish removing, before anything else.
    // Try the removal again rather than asking whether the file is there: a read that fails for
    // any other reason would otherwise be taken for «already gone» and the entry dropped.
    // `removeFile` on something absent throws NotFound, which *is* the answer we wanted.
    for (const p of [...failedRemovals]) {
      if (!op.current()) return;
      try { await op.remove(p); failedRemovals.delete(p); }
      catch (e) { if (/NotFound/i.test(String(e && e.name))) failedRemovals.delete(p); }
    }
    const gone = prev.filter((e) => !live.has(String(e.id)));
    let failed = 0;
    for (const e of gone) { if (!op.current()) return; failed += await pruneFunction(e.id, e) ? 0 : 1; }
    await rebuildTree();
    await downloadMissing();
    if (failed) setStatus(`${failed} deleted function(s) could not be fully removed - click \u21bb Refresh.`, 'warn');
  } catch (e) { setStatus('Could not check with Zoho: ' + errText(e), 'warn'); }
}

function reconcileFunctions() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  // Single-flight is not enough on its own: a create or a delete arriving *while* the list is being
  // read is a change the answer in flight cannot contain, and returning the promise already running
  // says «done» about a state that predates it. So a notice during a run is remembered and answered
  // by one more round afterwards - which also covers the notice that arrives while a pull is busy.
  if (reconciling) { reconcileAgain = true; return reconciling; }
  reconciling = reconcileNow(op).finally(() => {
    reconciling = null;
    if (reconcileAgain) { reconcileAgain = false; reconcileFunctions(); }
  });
  return reconciling;
}

// Paths a removal could not finish. Not a log: the next round tries them again, because by then the
// index no longer mentions them and nothing else would ever look.
const failedRemovals = new Set();

/** Remove every half of one or more function pairs independently. A pair can be half gone: if the
 *  first NotFound aborts the sequence, the second half is never retried and can live on disk for
 *  ever. The source is always attempted before its metadata, so after a browser restart any residue
 *  still carries the id that lets the next full pull find and retry it. */
async function removeFunctionPaths(paths, op) {
  const removed = [];
  let failed = 0;
  for (const p of paths) {
    if (!op.current()) return { removed, failed, moved: true };
    try {
      await op.remove(p);
      if (!op.current()) return { removed, failed, moved: true };
      failedRemovals.delete(p); removed.push(p);
    } catch (e) {
      if (!op.current() || (e && e.message) === WS_MOVED) return { removed, failed, moved: true };
      if (/NotFound/i.test(String(e && e.name))) failedRemovals.delete(p);
      else { failedRemovals.add(p); failed++; }
    }
  }
  return { removed, failed, moved: false };
}

/** Take a function out of the mirror. Returns whether it went completely - a half-removed function
 *  reported as removed comes back at the next open, and the reader was told it had gone. */
/** Remove one function from the mirror. `entry` is its row in *this workspace's* `functions/index.json`
 *  - the caller has just read it off disk - and it is preferred over the in-memory maps for the same
 *  reason the caller now reads that file: `index` and `treeData` describe whichever workspace last
 *  drew the Functions tab, which is not necessarily this one. They stay as a fallback for the
 *  single-id path (`syncOneNow`), where the id came from a save notice about the workspace on screen. */
async function pruneFunction(id, entry = null) {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  const key = String(id);
  const info = index.get(key);
  const row = treeData.find((e) => String(e.id) === key);
  const fromEntry = entry && entry.namespace && entry.api_name
    ? `functions/${sanitize(entry.namespace)}/${sanitize(entry.api_name)}.dg` : null;
  const path = fromEntry || (info && info.path) || (row && row.path);
  if (!path) return true;
  let whole = true;
  // The folder this removal belongs to. Two files, two removals, awaits inside each: without this
  // the source went from one workspace and the metadata from the next.
  for (const p of [path, path.replace(/\.dg$/, '.meta.json')]) {
    if (!op.current()) return false;
    // The exact path that failed, not the function's. Keeping only the `.dg` meant a retry that
    // found it already gone, dropped the entry, and left the `.meta.json` on disk for ever.
    try { await op.remove(p); if (!op.current()) return false; failedRemovals.delete(p); }
    catch (e) {
      // After the await, not before it: the failure of a removal that started in the previous
      // workspace was being written into this one's queue, which `dropWorkspaceState` had just
      // emptied - so the retry followed the reader across.
      if (!op.current()) return false;
      if (!/NotFound/i.test(String(e && e.name))) { whole = false; failedRemovals.add(p); }
    }
  }
  if (!op.current()) return false;
  try {
    const idx = JSON.parse(await op.read('functions/index.json'));
    if (!op.current()) return false;
    if (Array.isArray(idx)) await op.write('functions/index.json',
      JSON.stringify(idx.filter((e) => String(e.id) !== key), null, 2));
  } catch (_) { whole = false; }
  if (!op.current()) return false;
  index.delete(key);
  treeData = treeData.filter((e) => String(e.id) !== key);
  if (currentPath === path) { $('preview').classList.remove('show'); $('resizer').classList.remove('show'); currentPath = null; }
  renderTree(); updateMissingButton();
  // A failure that is forgotten is a file nobody will ever come back to: the index has already been
  // rewritten without it, so the next reconciliation cannot see it is still there. Kept by path, and
  // retried at the top of the next round.
  if (whole) setStatus(`Deleted in Zoho: ${path.split('/').pop()} - removed from the mirror.`, 'ok');
  return whole;
}

// One save at a time per function, and always one more after the last notice.
//
// Two notices for the same id used to start two `fetchOne`s and two writes, and whichever answer
// arrived second won - so resolving them out of order left the **older** source on disk. Reported
// with that exact experiment. Two real saves a moment apart do the same thing, and there the loser
// is an edit the reader made.
//
// A queue per id with a trailing round: while one is in flight the id is marked, and the mark is
// answered by exactly one more read after it finishes. Never dropped, never parallel.
//
// And a bounded number of ids at once. The queue above is per id, so N notices for N different
// functions started N reads and N writes in parallel - one authenticated request each. A deploy that
// saves thirty functions is an ordinary way to reach that, and the page's MAIN world is not ours, so
// a script there can post the notice our hook posts as many times as it likes: the bridge holds the
// id to twenty digits, which bounds its shape and not how many arrive. Four at a time does the same
// total work without a burst nobody asked for, and nothing is dropped - dropping would break the
// honest bulk case, which is the one worth protecting.
const syncing = new Map(), syncAgain = new Set(), syncQueue = [];
const SYNC_MAX = 4;
let syncBusy = 0;
function syncOne(id) {
  const key = String(id);
  if (syncing.has(key)) { syncAgain.add(key); return syncing.get(key); }
  let done;
  const p = new Promise((res) => { done = res; });
  syncing.set(key, p);
  syncQueue.push({ key, done });
  syncPump();
  return p;
}

/** One slot of the sync pump: read the function, then free the slot whatever happened.
 *
 * Two `.then()` callbacks before this, neither of them readable by the race checker, and what they
 * held is the bookkeeping that decides whether the pump ever runs again - a slot that is not freed
 * is a slot occupied for the rest of the session. The failure itself is reported by `syncOneNow`;
 * what must not happen here is stopping.
 */
async function runSyncSlot(key, done) {
  try { await syncOneNow(key); } catch (_) { /* reported there; the pump must carry on regardless */ }
  syncBusy--;
  syncing.delete(key);
  done();
  if (syncAgain.delete(key)) syncOne(key);
  syncPump();
}

function syncPump() {
  while (syncBusy < SYNC_MAX && syncQueue.length) {
    const { key, done } = syncQueue.shift();
    syncBusy++;
    // The read's own failure is reported by syncOneNow; here it must not stop the pump, or one
    // rejected read would leave a slot occupied for the rest of the session.
    void runSyncSlot(key, done);
  }
}

async function syncOneNow(id) {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  // The folder this started in. Everything below awaits Zoho, and the workspace selector stays
  // usable the whole time: without this the answer for A was written into B, both files, silently.
  // A handle identifies it exactly - the same object or a different workspace, no name to compare.
  if (mismatchRefuse()) return;
  if (!dir || !(await hasPerm(dir))) return;
  await refreshContext();
  if (!guardOk()) { setStatus(`Save ignored: active ${envOf(lastCtx?.origin)}/org ${lastCtx?.org} ≠ workspace ${envOf(bound?.base)}/org ${bound?.org}.`, 'warn'); return; }
  const info = index.get(String(id));
  // A function this workspace has never heard of. Creating one in the editor issues a save straight
  // after - POST then PUT, measured in a HAR - so the save names an id the index cannot know, the
  // detail call goes out without a category, and Zoho refuses it with `PATTERN_NOT_MATCHED`. That is
  // what a reader was shown for the ordinary act of making a function. It is a creation, so it is
  // treated as one.
  if (!info) { await reconcileFunctions(); return; }
  try {
    setStatus(`Save detected (${id}), syncing…`, 'busy');
    const r = await toBridge({ cmd: 'fetchOne', id, category: info?.category, source: info?.source });
    if (!op.current()) return;             // you moved: this answer belongs to a folder we have left
    if (!r?.ok || !r.file) throw new Error(r?.error || 'detail not found');
    const f = r.file;
    // Before **each** effect, not once before the pair: a write is several awaits of its own, so the
    // folder can change between the source and its metadata - and it did, leaving one file in each
    // workspace. Checked again rather than trusted from a moment ago.
    if (!op.current()) return;
    await op.write(`functions/${f.folder}/${f.stem}.dg`, f.dg);
    if (!op.current()) return;
    // Deliberately nothing: this ran because the function was *just saved* in Zoho, so the org list
    // this panel holds predates the save. Writing that value would claim this copy had been checked
    // against a list that has not seen the change - a claim in the direction that hides one. The
    // next pull refreshes both sides and the pair becomes meaningful again.
    f.meta.listUpdated = null;
    await op.write(`functions/${f.folder}/${f.stem}.meta.json`, JSON.stringify(f.meta, null, 2));
    // The memory is an effect too: after the last write the row looked up in `treeData` is the new
    // workspace's, and marking it downloaded gave one org's row the other org's path.
    if (!op.current()) return;
    const ent = treeData.find((x) => x.id === String(id));
    if (ent) { ent.path = `functions/${f.folder}/${f.stem}.dg`; ent.downloaded = true; ent.error = false; updateRow(ent); updateMissingButton(); } else { await rebuildTree(); }
    if (currentPath === `functions/${f.folder}/${f.stem}.dg`) await openFile(currentPath);
    setStatus(`Synced: functions/${f.folder}/${f.stem}.dg`, 'ok');
  } catch (e) { setStatus(`Sync failed for ${id}: ${e.message}`, 'warn'); }
}

// ---------- workspaces ----------
// One "working folder" is picked once. Inside it, each Zoost product keeps its own subfolder, and
// each workspace lives one level below that:
//
//   <working folder>/crm/<instance>[-sandbox]-<orgid>/
//   <working folder>/analytics/<project>/
//
// One folder can therefore serve every Zoost product without the two ever colliding, and the root
// says what it holds at a glance. The folder NAME is only a label: identity is the org id inside
// each `.zoost.json`, so renaming a Zoho portal (or the folder) never orphans a workspace.
const APP_DIR = 'crm';                       // this app's subfolder
const APP_DIRS = ['crm', 'analytics'];       // known product folders - not "foreign" content
// **The blast radius, said once.** It was written three times in the CRM and nowhere at all in
// Analytics, and the three did not agree: one said the permission lasts «permanently», which is
// not true of a stored handle - Chrome drops it between sessions, which is why both panels have a
// re-grant path. A warning that overstates is read once and discounted afterwards. Same sentence
// in both products and on the settings page, held by a test that strips the markup and compares.
const BLAST_RADIUS = 'Zoost will hold read and write access to everything inside that folder, for as long '
  + 'as the browser keeps the permission. A dedicated folder is strongly recommended - not your home or '
  + 'Documents.';

let root = null, rootGranted = false;
// True when the workspace on screen still has the pre-1.13 folders. Nothing reads them - it is
// there so the empty state can name the real reason instead of saying «nothing pulled yet» about
// a folder that is visibly full.
let oldLayout = false;
/** Why a list is empty, in the order the states actually block each other.
 *
 * An empty state is never silent here: it says what is missing and what to do. Saying the *wrong*
 * missing thing is worse than silence, because the reader goes and does it and nothing changes - and
 * it is usually the step they have already done that gets repeated at them. Returns null when the
 * blocker really is that nothing has been pulled, so each tab can name its own thing.
 *
 * Word for word the Analytics panel's, because the first three states are the same product.
 */
/** Put the blocker on screen. Called from every early return in loadWorkspaces, because that is
 *  exactly where the panel used to leave whatever the previous state had drawn - and with a lapsed
 *  permission it drew nothing at all, so the CRM said in the status line what Analytics said in the
 *  list and the two looked like different products. */
function renderBlocked() {
  const t = $('tree'); if (!t) return;
  const why = emptyReason();
  t.innerHTML = why ? `<div class="empty">${why}</div>` : '';
}

function emptyReason() {
  if (!root) {
    return '<b>No working folder yet.</b> Press <b>\u{1F4C1} Set working folder\u2026</b> above and pick a '
      + 'dedicated, empty folder. Every workspace lives inside it.';
  }
  if (!rootGranted) {
    return '<b>Folder access is not granted.</b> Press <b>\u{1F513} Grant access</b> above - or simply '
      + 'click anywhere in this panel, which does the same. One click, no folder picker.';
  }
  if (!wsList.length) {
    return '<b>No workspace here yet.</b> Open a Zoho CRM tab and press <b>+</b> to create the workspace '
      + 'for that org - or press <b>+ Sample</b> to write one of invented data and look around first. '
      + 'The sample never contacts Zoho, and it is deleted like any other workspace.';
  }
  if (isSample()) {
    // A sample workspace is written by «+ Sample» and never pulled, so «Press Pull all» names a
    // control that is refused for it by design - the reader goes to press it, finds it grey, and
    // learns nothing. Reported on the Actions tab, which arrived after the sample generator did:
    // an older sample folder simply has no actions/ in it, and rewriting the sample is the only
    // thing that puts one there.
    return '<b>Nothing of this kind in the sample workspace.</b> It is invented data written by '
      + '<b>+ Sample</b> and never pulled, so <b>Pull all</b> does not apply to it. If this list '
      + 'should not be empty, the sample was written before this part existed: delete the workspace '
      + 'and press <b>+ Sample</b> again.';
  }
  if (oldLayout) {
    // Not a migration and not a fallback: nothing here reads the old paths. It is an empty state
    // telling the truth, the same way the older flat working-folder layout is reported rather than
    // adopted - «nothing pulled yet» would be a lie about a folder that is plainly full.
    return '<b>This workspace uses the old folder layout.</b> Functions now live under '
      + '<b>functions/</b> and the other folders lost their leading underscore. Press <b>Pull all</b> '
      + 'to write it again in the new shape - nothing is fetched twice that you already have '
      + '- then delete the old <b>_index</b>, <b>_modules</b>, <b>_layouts</b>, <b>_workflows</b>, '
      + '<b>_schedules</b> and <b>_connections</b> folders, and the namespace folders sitting beside '
      + 'them. Zoost never deletes files it did not just write.';
  }
  return null;
}
/** Does this workspace still carry the folders from before the layout was regularised?
 *
 * Only the names are looked at, and only at the top level: a workspace written by 1.13 or later has
 * none of them, and one written before has several. It is deliberately not a fallback - no reader
 * anywhere knows the old paths - and there is no automatic migration: a re-pull writes the new shape
 * and the old folders are the user's to delete, because Zoost does not remove files it did not write.
 */
const OLD_DIRS = ['_index', '_modules', '_layouts', '_workflows', '_schedules', '_connections'];
async function hasOldLayout(h) {
  if (!h) return false;
  try {
    for await (const e of h.values()) if (e.kind === 'directory' && OLD_DIRS.includes(e.name)) return true;
  } catch (_) { /* unreadable: not a claim either way */ }
  return false;
}

// Resolved on demand rather than cached: the handle must stay valid across permission lapses.
async function appRoot(create) {
  if (!root) return null;
  try { return await root.getDirectoryHandle(APP_DIR, { create: !!create }); } catch (_) { return null; }
}
const wsFolderName = (ctx) => `${sanitize(ctx.instance || 'workspace')}${envOf(ctx.origin) === 'sandbox' ? '-sandbox' : ''}-${sanitize(ctx.org || 'org')}`;
async function readJsonIn(h, name) { const fh = await h.getFileHandle(name); return JSON.parse(await (await fh.getFile()).text()); }

// Two groups, because they answer different questions. The local ones work on what is already on
// disk and are fine on a sample workspace; the two that read from Zoho are not, and were left
// enabled - reported. `pull` is also disabled by refreshContext on every state change, and
// `pullone` was the one nothing else covered.
function setEnabled(on) {
  LOCAL_BTNS.forEach((b) => ($(b).disabled = !on));
  blockZoho(!on || isSample());
  sayWhyDisabled();
}

/** Why each of these is grey, on the control itself.
 *
 * They went off and kept their «what I do» tooltip - `export` said «Self-contained HTML report of
 * this workspace» while disabled, `askai` said «Ask AI about this org». The twin states the rule it
 * follows: a control and the empty state under it must not name different blockers. This side applied
 * that to the three workspace buttons and to nothing else.
 *
 * The reason is asked of `emptyReason()`, the same function the lists ask, so the sentence under the
 * cursor and the sentence in the pane cannot disagree - which is the whole point of there being one.
 */
function sayWhyDisabled() {
  const why = emptyReason();
  LOCAL_BTNS.forEach((b) => {
    const el = $(b);
    if (!el) return;
    if (!el.dataset.can) el.dataset.can = el.title || '';
    el.title = el.disabled ? (why || 'Not available yet - open a workspace first.') : el.dataset.can;
  });
}

// Re-granting access to a folder we already know must NOT reopen the file picker: a lapsed
// permission is not a request to choose a different folder. This is one click, no OS dialog.
async function grantRoot() {
  if (!root) { await pickRoot(); return; }
  try {
    if (!(await ensurePerm(root))) { setStatus('Access denied - Zoost cannot read the working folder.', 'bad'); return; }
    rootGranted = true;
    setStatus(`Access granted to \u00ab${root.name}\u00bb.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Grant failed: ' + e.message, 'bad'); }
}
async function pickRoot() {
  if (workspaceChangeRefuse()) return;
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'zoost-root' });
    // Not MSG.folder: that one says «needs re-granting - click ↻ Refresh», and here nothing was ever
    // granted - the reader has just picked a folder for the first time and dismissed the prompt.
    // Naming a remedy that does not apply is the defect one door along from saying nothing. The
    // Analytics twin has always said this sentence.
    if (!(await ensurePerm(h))) { setStatus('Permission to the folder was not granted.', 'bad'); return; }
    // Blast radius: granting readwrite covers everything below this folder, permanently.
    let foreign = 0, seen = 0;
    for await (const e of h.values()) {
      if (++seen > 80) break;
      if (e.kind !== 'directory') { foreign++; continue; }
      if (APP_DIRS.includes(e.name)) continue;              // a product folder - this is our own layout
      try { await e.getFileHandle(CFG); } catch (_) { foreign++; }   // a workspace from the older flat layout
    }
    if (foreign > 6 && !confirm(`\u00ab${h.name}\u00bb already contains ${foreign} items that are not Zoost workspaces.\n\n`
      + `${BLAST_RADIUS}\n\nUse this folder anyway?`)) return;
    root = h; rootGranted = true; await window.idbHandle.set('rootDir', h);
    setStatus(`Working folder: \u00ab${h.name}\u00bb`, 'ok');
    await loadWorkspaces();
  // **A refusal does not open with the words of the success.** Both lines began «Working folder: »,
  // so a browser that said no read as one that had said yes until you got to the middle of the
  // sentence - and the platform's own words arrived raw, without going through `friendlyError` like
  // every other failure in this panel. The twin says «Could not open that folder: …» and marks it
  // `bad`; this is that.
  } catch (e) { if (e?.name !== 'AbortError') setStatus('Could not open that folder: ' + friendlyError(e), 'bad'); }
}

/** Write the sample workspace into the working folder, then open it.
 *
 * It goes through the same code every other workspace does - the files land on disk and the ordinary
 * list picks them up - so nothing downstream has to know it exists. `sample: true` in .zoost.json is
 * the whole mechanism.
 */
// Whether a sample workspace exists, kept where it can be read **without the folder handle**.
//
// This is the bug that took three reports to find, and the diagnosis was mine to make. Until the
// folder permission is granted, loadWorkspaces() returns before it enumerates anything, so `wsList`
// is empty and the panel cannot tell a sample apart from no sample - it offered to create one that
// was sitting right there. Chrome drops that permission between sessions, so the state right after
// the panel opens is exactly the state where the question is asked.
//
// Same shape as `tabAccessView`, and for the same reason: a display-only copy of a fact, in
// chrome.storage.local, for a surface that cannot reach the folder. The folder stays the authority -
// this is only ever read into a label, and the *action* re-checks after granting.
let sampleWsKnown = null;
// Best-effort, and **declared** rather than wrapped in a `try` that cannot catch it: a synchronous
// try/catch around an un-awaited promise catches only a throw while the promise is being made,
// never its rejection. What is remembered here is a cache of a fact the folder already holds -
// `knownSample()` prefers the live workspace list and falls back to this - so losing it degrades
// to «not looked yet», which is a state the panel already draws honestly. Nothing to report.
// A declaration rather than a `.then(cb)`: the callback writes a module-level variable after an
// await, which is the one shape `tools/asynccheck.py` exists to look at - and inside a callback it
// could not look at it at all. Nothing guards it because nothing has to: the value is a cache of a
// fact the folder holds, and the startup read cannot be overtaken by anything that reads it.
async function readRememberedSample() {
  let v;
  try { v = await chrome.storage.local.get('sampleWs'); } catch (_) { return; }
  sampleWsKnown = (v && v.sampleWs) || null;
  updateSampleButtons();
}
void readRememberedSample();
function noteSampleWs(id) {
  sampleWsKnown = id || null;
  void chrome.storage.local.set({ sampleWs: sampleWsKnown }).catch(() => {});   // see the read above
}
/** The one the panel can act on, or - when the folder is not readable yet - the one it remembers. */
function knownSample() {
  const w = (wsList || []).find((x) => x.binding && x.binding.sample);
  return w || (sampleWsKnown ? { id: sampleWsKnown, remembered: true } : null);
}
/** Can the panel answer «is there a sample?» at all right now?
 *
 * Only if it has read the folder. Until the permission is granted the enumeration returns early, so
 * an empty list means «not looked», not «not there» - and the button was reading it as the second
 * and offering to create a sample that existed. Four reports.
 */
const sampleKnowable = () => !!(root && rootGranted) || !!sampleWsKnown;
function updateSampleButtons() {
  const have = knownSample();
  const sb = $('wssample');
  if (sb) sb.hidden = !!have || !root || !rootGranted;
  if (sb) sb.disabled = pullBusy || sampleBusy;
  // The overlay's copy covers the workspace list, so hiding it there would leave a sample on disk
  // unreachable. It changes what it says instead.
  const ob = $('offsample');
  if (ob) {
    ob.disabled = pullBusy || sampleBusy;
    // Three states, because «+» and «Open» are both claims and there is a moment when neither can be
    // made. `+` says «there is none» and `Open` says «there is one»; with the folder unread the
    // honest label asserts nothing and the tooltip says the click will find out. This project does
    // not state what it has not measured, and a button label is a statement like any other.
    ob.textContent = have ? 'Open sample workspace'
      : sampleKnowable() ? '+ Sample workspace' : 'Sample workspace';
    ob.title = have
      ? 'Open the sample workspace already in your working folder - invented data, nothing is fetched'
      : sampleKnowable()
        ? 'Write a workspace of invented data into the working folder and open it - nothing is fetched, and it can be deleted like any other'
        : 'Opens the sample workspace, or writes one if there is none. Clicking asks for access to the working folder first, which is what the panel needs before it can tell.';
  }
}

let sampleBusy = false;
async function addSampleWorkspace() {
  if (workspaceChangeRefuse()) return;
  if (sampleBusy) return;
  if (!root) { await pickRoot(); return; }
  // **Grant first, then decide.** A click is the only context in which the permission can be
  // re-requested, and until it is granted the panel cannot see what is in the folder - so deciding
  // before this line means deciding on a list that is empty for a reason unrelated to the question.
  if (!(await ensurePerm(root))) { setStatus(MSG.folder, 'warn'); return; }
  if (!rootGranted) { rootGranted = true; await loadWorkspaces(); }
  const have = (wsList || []).find((w) => w.binding && w.binding.sample);
  if (have) { $('ws').value = have.id; $('offoverlay').classList.remove('show'); return activate(have, true); }
  sampleBusy = true;
  // The overlay is opaque and covers the status line, so it comes down before the writing starts -
  // otherwise the progress is written where nobody can read it, which is what made pressing again
  // look like the reasonable thing to do.
  $('offoverlay').classList.remove('show');
  ['wssample', 'offsample'].forEach((b) => { const e = $(b); if (e) e.disabled = true; });
  try { await writeSampleWorkspace(); }
  finally {
    sampleBusy = false;
    updateSampleButtons();
  }
}
async function writeSampleWorkspace() {
  try {
    const gen = window.SAMPLE_ORG;
    if (!gen) { setStatus('The sample generator is not loaded.', 'bad'); return; }
    const base = await appRoot(true);
    if (!base) { setStatus(`Could not create the ${APP_DIR}/ folder inside the working folder.`, 'bad'); return; }
    const h = await base.getDirectoryHandle(gen.folderName(), { create: true });
    const files = gen.files({});
    const all = Object.entries(files);
    // Three hundred files through the File System Access API take long enough to look like a hang -
    // reported as exactly that. The count is what says it is working, so it is written often enough
    // to move and rarely enough not to be the cost itself.
    setStatus(`Writing the sample workspace - 0 of ${all.length} files\u2026`, 'busy');
    for (let i = 0; i < all.length; i++) {
      const [rel, text] = all[i];
      const parts = rel.split('/');
      let d = h;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      if (i % 10 === 9 || i === all.length - 1) {
        setStatus(`Writing the sample workspace - ${i + 1} of ${all.length} files \u00b7 ${rel.split('/')[0]}\u2026`, 'busy');
        await new Promise((r) => setTimeout(r, 0));   // let the status line actually paint
      }
    }
    await window.idbHandle.set('activeWs', 'org:' + gen.org);
    setStatus(`Sample workspace written - ${Object.keys(files).length} files in \u00ab${gen.folderName()}\u00bb. Nothing was fetched from Zoho.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Could not write the sample: ' + e.message, 'bad'); }
}

async function addWorkspaceForTab() {
  if (workspaceChangeRefuse()) return;
  if (!root) { await pickRoot(); return; }
  if (!(await ensurePerm(root))) { setStatus(MSG.folder, 'warn'); return; }
  const ctx = lastCtx && lastCtx.org ? lastCtx : await getContext();
  if (!ctx || !ctx.org) { setStatus('Open a Zoho CRM tab first - the workspace is created for the org you are signed in to.', 'warn'); return; }
  try {
    const name = wsFolderName(ctx);
    const base = await appRoot(true);
    if (!base) { setStatus(`Could not create the ${APP_DIR}/ folder inside the working folder.`, 'bad'); return; }
    const h = await base.getDirectoryHandle(name, { create: true });
    // **A folder that already exists keeps what is in it.** `{create: true}` returns the existing
    // folder, and this then truncated its `.zoost.json` and wrote three fields - so pressing
    // «+ Workspace» on a folder that was already a workspace threw away the label the reader had
    // given it, when it was last pulled, whether it is the sample, and the whole per-area record of
    // what the Zoho role refused. Every other writer of this file merges through `patchCfg`; this
    // was the one that replaced, which is the lost-update trap `docs/decisions.md` records twice.
    let prev = {};
    try { prev = JSON.parse(await (await (await h.getFileHandle(CFG)).getFile()).text()) || {}; } catch (_) {}
    const fh = await h.getFileHandle(CFG, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(Object.assign({}, prev,
      { org: ctx.org, base: ctx.origin, instance: ctx.instance }), null, 2));
    await w.close();
    await window.idbHandle.set('activeWs', 'org:' + ctx.org);
    setStatus(`Workspace ready: ${name} - Pull to fill it.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Add failed: ' + e.message, 'warn'); }
}

/** Everything that belongs to the workspace you were in, dropped when you leave it.
 *
 * Two things were surviving a workspace switch, and the second is worse than the first.
 *
 * The **conversation** stayed on screen: the assistant's own replies name functions, modules and
 * connections from the org you have just left, sitting above a question about the new one, and the
 * whole thread is re-sent with every message - so the model is asked to reason about two orgs at
 * once and told nothing about the boundary.
 *
 * The **caches** stayed too, which is not confusing but wrong. `graphCache`, `moduleFilesCache` and
 * `aiConnCache` were cleared in `rebuildTree()` - which only runs if you happen to be on the
 * Functions tab. Switch workspace while looking at Workflows and the assistant answered from the
 * previous org's functions and schema, with no sign of it anywhere.
 *
 * Both are per-workspace state, so both are dropped in one place, called from the one line that
 * changes workspace. The Analytics panel has the same function, doing the same thing.
 */
// Which workspace we are in, as a number that only ever moves forward. A handle comparison closes
// one function at a time; this closes the class, because an operation captures it once and every
// effect after any `await` asks the same question - «am I still where I started?» - without knowing
// anything about folders. Reported after three functions had been fixed one by one and the fourth,
// fifth and sixth were still writing one org's data into another's folder.
let wsGen = 0;
const sameWs = (gen) => gen === wsGen;

// Clearing a conversation and leaving a workspace are two different things, and one function did
// both: Clear threw away every cache *and the queue of removals that had failed and must be retried*,
// which is a fact about the mirror on disk and has nothing to do with the chat. Reported: the queue
// went from 1 to 0 with no workspace change at all.
function clearConversationState() {
  const had = aiMessages.length;
  aiGen++;
  aiMessages = []; aiSeedWarned = false; aiBusy = false;
  const send = $('aisend'); if (send) send.disabled = false;
  aiRenderMessages();
  return had;
}
function dropWorkspaceState() {
  const had = clearConversationState();
  dropFileCaches();   // everything read out of a file - listed once, in the function below
  // Relative paths mean nothing outside the folder they came from: a removal that failed in one
  // workspace was retried against the same path in the next, which is a file belonging to another
  // org. The queue goes with the workspace it belongs to.
  failedRemovals.clear();
  // Both are keyed by Zoho ids and neither was dropped here: searching `in: code` in the next
  // workspace missed every one of its functions, and the module names resolved against the previous
  // org's index - so a module the new workspace has and the old one did not vanished from the chips
  // and from both reports, silently, as an absence.
  // Every list a tab draws from. Each is written only by its own `rebuild*`, and `activate()` runs
  // only the one for the tab that happens to be on screen - so on any other tab they described the
  // *previous* workspace for as long as the reader stayed there, and everything that consults them
  // by id (`syncOneNow`, `distrustEverything`, the prune, `updateMissingButton`, `revealFromPreview`)
  // was answering about that one.
  //
  // The first version of this cleared two of the seven, which is the defect it was fixing, one
  // instance at a time: `treeData` and `index` were the pair the report named, and the other five
  // have exactly the same shape. `downloadMissingWf` is the one that acts on it rather than drawing
  // it - it writes `workflows/<id>.json` for ids belonging to the org you left, into the folder of
  // the one you are in.
  treeData = []; index = new Map();
  moduleData = []; workflowData = []; wfIndex = new Map(); scheduleData = [];
  actionData = []; connectionData = [];
  return had;
}
/** Everything held in memory that was read out of a file in the working folder.
 *
 *  Two callers, and the second is why it exists as a function. `↻ Refresh` is the control for the
 *  write this panel cannot see - somebody restoring a file, a `git checkout` - and its tooltip says
 *  «read every file again». It cleared three of nine: `moduleFilesCache`, `aiConnCache`,
 *  `aiActCache`, `actionUsers`, `failIndex` and `healthData` all answered from before the press, so
 *  the assistant and the health view kept describing the file that had just been replaced.
 *
 *  Listed once, so a cache added tomorrow is dropped by both without anybody remembering. */
function dropFileCaches() {
  graphCache = null; codeCache = null; modNamesCache = null;
  moduleFilesCache = null; aiConnCache = null; aiActCache = null; actionUsers = null;
  failIndex = null; healthData = null;
}
/** What is on *screen* when a different workspace is opened - the other half of the above.
 *
 *  Reported: switch workspace while the Health view is open and nothing changes, because rebuilding
 *  «the active view» rebuilds the list under an overlay covering it. The same is true of everything
 *  else that outlives a switch: a search term typed for one org silently filters another, and the
 *  connection filter is a set of *file paths* from the workspace being left, so the functions list
 *  can come back empty for a reason nothing on screen explains.
 *
 *  Two functions rather than one, and the split is not cosmetic: `dropWorkspaceState()` is what
 *  **Clear** in the chat calls, and Clear must not close the reader's preview or empty their search
 *  box. Data belongs to the workspace; the view belongs to the reader - until the workspace changes
 *  underneath it, which is this. */
function resetView() {
  $('find').value = '';
  // The stashes are per *tab*, not per workspace: restored across an org change they would run one
  // org's search - text, mode and the .* toggle together - against another. All of it goes.
  Object.keys(findByMode).forEach((k) => delete findByMode[k]);
  regexMode = false; $('rxmode').classList.remove('on'); $('rxmenu').classList.remove('show');
  connectionFilter = null; connFilterSet = null;
  currentPath = null; navClear();
  $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  // An overlay is a view of the workspace too. Health is rebuilt rather than closed, because
  // closing it would answer «what is wrong here» by taking the question away; the assistant's
  // context line is re-measured, since the index it reports is the new org's.
  if ($('healthview').classList.contains('show')) openHealth();
  if ($('aiview').classList.contains('show')) aiContextLabel();
}

// Which workspace the panel should reopen on, remembered in IndexedDB. Two selections overlapping -
// a slow one, then a fast one - resolved in the order the browser finished them, so the panel showed
// the second and reopened on the first. The write is queued and the queued work asks whether it is
// still the current selection: what is persisted is what is on screen, not what finished last.
let _activeWsWrites = Promise.resolve();
// The queued work is a declaration and not a `.then(cb)`, because a callback is a scope the race
// checker cannot enter - and this one is *about* a race: it asks, after the queue has drained, whether
// the selection it was queued for is still the one on screen. A check like that is exactly what has
// to be readable.
async function writeActiveWhenStillCurrent(key, id, gen, after) {
  await after;
  if (gen !== wsGen) return;                     // another selection overtook this one; it owns the key
  await window.idbHandle.set(key, id);
}
function rememberActive(key, id, gen) {
  _activeWsWrites = writeActiveWhenStillCurrent(key, id, gen, _activeWsWrites);
  return _activeWsWrites;
}
async function activate(w, viaGesture) {
  if (pullBusy && w && w.id !== activeWsId) {
    $('ws').value = activeWsId || '';
    setStatus('Pull in progress - wait for it to finish before changing workspace.', 'warn');
    updateWsButtons();
    return false;
  }
  const sameWs = activeWsId === w.id;
  // The binding is set with the handle, not four lines later. It used to be read after
  // setEnabled(true), so `isSample()` was still answering about the *previous* workspace and the
  // per-type Pull came back on - «fields first, state second», which this repository already
  // records in its mirror image. The two are one fact about one workspace; they move together.
  // The generation moves **here**, before the handle does and before anything awaits: an operation
  // still running belongs to the workspace it started in, and it must be able to tell. It used to
  // move inside `dropWorkspaceState()`, which is also what Clear calls - so clearing a conversation
  // interrupted a pull, and in Analytics the line sat after a `return` and never ran at all, which
  // made every guard in that file always true. Both reported.
  const gen = ++wsGen;
  switchDirtyWorkspace(w.handle); dir = w.handle; forgetDirs(); activeWsId = w.id; bound = w.binding || null;
  // From here on this activation is an operation like any other: it awaits four times and every one
  // of them is a place a second activation can finish first. It used to check once, after IndexedDB,
  // and then keep going - so `oldLayout` was published from the workspace being left, and the reset,
  // the access verdicts and the rebuild all ran against the one that had already arrived.
  const op = beginWorkspaceOp();
  await rememberActive('activeWs', w.id, gen);
  if (!op.current()) return;
  setEnabled(true);
  const nextOldLayout = await hasOldLayout(op.root);
  if (!op.current()) return;
  oldLayout = nextOldLayout;
  // Not on a re-activation of the workspace already open - regranting a folder must not throw
  // away a conversation about the org you are still in.
  if (!sameWs) {
    const n = dropWorkspaceState();
    resetView();
    if (n) setStatus(`Workspace changed - the assistant's ${n}-message conversation was cleared: it was about the other org.`, 'warn');
  }
  // A different workspace: the chain is dropped, because every step in it names a file in the org
  // the reader has just left. This is the one place that forgets.
  currentPath = null; navClear(); $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  // Access verdicts belong to this workspace, so they are re-read here and the tab row rebuilt.
  // Carrying the previous org's answers over would hide a tab in an org that grants it - the same
  // class of mistake the environment guard exists to prevent, one field further in.
  if (!(await loadAccess(op))) return;
  renderTabs();
  const ok = viaGesture ? await ensurePerm(op.root) : await hasPerm(op.root);
  if (!op.current()) return;
  if (ok) await rebuildActive(); else { setStatus('Workspace found - click Refresh to grant access.', 'warn'); await refreshContext(); }
}

// In-memory only. `.zoost.json` is written when a workspace is created and on pull; rewriting
// it here would clobber fields this function does not carry (lastPull).
async function cacheBinding(b) {
  if (!b || !b.org) return;
  // `sample` travels with the rest. This function rebuilds `bound` from a listed subset, so every
  // field that lands in .zoost.json has to be added here too - the trap this repository already
  // records, and one that would have quietly re-enabled every Zoho action on a sample workspace.
  bound = { org: b.org, base: b.base, instance: b.instance, label: b.label || '', sample: !!b.sample };
  const w = (wsList || []).find((x) => x.id === activeWsId); if (w) w.binding = bound;
}

function updateWsButtons() {
  const add = $('wsadd'), rt = $('wsroot');
  $('ws').disabled = pullBusy;
  rt.disabled = pullBusy;
  // Both are temporarily unavailable, never permanently: pick a workspace and they work. Analytics
  // has disabled its Remove this way from the start; this side never did, and the two buttons sat
  // beside each other behaving differently.
  renderGoDc();                      // the list it offers is the workspaces, so it moves with them
  $('wsrename').disabled = pullBusy || !dir || !wsList.length;
  // Why it is grey, as the Analytics twin says it: a control that goes off with nothing on it is a
  // dead end the reader cannot act on.
  $('wsdel').title = !$('wsdel').disabled ? 'Remove this workspace from the folder'
    : `Cannot remove a workspace: ${pullBusy ? 'a pull is running' : 'none is selected'}`;
  $('wsrename').title = !$('wsrename').disabled ? 'Give this workspace a name of your own'
    : `Cannot name a workspace: ${pullBusy ? 'a pull is running' : 'none is selected'}`;
  $('wsdel').disabled = pullBusy || !dir || !wsList.length;
  const needsGrant = !!root && !rootGranted;
  rt.classList.toggle('needgrant', needsGrant);
  rt.textContent = !root ? '\u{1F4C1} Set working folder\u2026'
    : needsGrant ? `\u{1F513} Grant access to ${root.name}`
    : `\u{1F4C1} ${root.name}`;
  rt.title = !root ? 'Pick the folder that will contain all Zoost workspaces'
    : needsGrant ? 'Chrome dropped the file-system permission for this folder. One click restores it - no folder picker.'
    : `Working folder: ${root.name} - click to choose a different one`;
  // Absent when there is nothing to do, disabled only while it is *temporarily* unavailable.
  // A workspace already exists for this org and never will not: that is not a wait, it is a
  // permanent no, and a greyed button there reads as something broken. The other three reasons -
  // no working folder, no Zoho tab, no org on the tab - all clear on their own, so the button
  // stays visible and says what is missing.
  const known = (wsList || []).some((w) => lastCtx && w.binding && w.binding.org === lastCtx.org);
  add.hidden = known;
  // **And it may not be pressed while the list is empty for a reason that is not «there is none».**
  // `wsList` is empty whenever Chrome has dropped the folder permission - which is every browser
  // restart - so «no workspace for this org» was being answered from a list that had not been read.
  // The sample button beside it already carries `rootGranted` for exactly this, and the Analytics
  // twin states the rule: grant first, then decide, because deciding before that is deciding on a
  // list that is empty for an unrelated reason.
  add.disabled = pullBusy || !root || !rootGranted || !lastCtx || !lastCtx.org;
  add.textContent = (lastCtx && lastCtx.instance) ? `+ ${lastCtx.instance}` : '+ Workspace';
  // Why it is grey, as every other blocked control in this panel says it - and the folder comes
  // first, because it is the one the reader can act on with a single click anywhere in the panel.
  add.title = !root ? 'Set the working folder first'
    : !rootGranted ? `Grant access to ${root.name} first - the workspaces in it have not been read`
    : !lastCtx ? 'Open a Zoho CRM tab first'
    : `Create a workspace folder for \u00ab${lastCtx.instance}\u00bb inside ${root.name}`;
  // Absent once one exists, and the overlay's copy says which of the two it will do. Both are
  // decided in one place, because they were decided in two and disagreed.
  updateSampleButtons();
}


/** The one option a selector shows when there is nothing to select, built as a node.
 *
 * A folder's name is data, and it was going into markup: a directory called
 * `</option><option selected>…` rewrote the workspace selector rather than appearing in it. The CSP
 * stops that becoming script, and it does not stop a control the user did not choose or a name they
 * cannot read. The twin escaped the same value; this side had two copies that did not.
 *
 * `textContent` rather than an escaper, because the right answer to «this is not markup» is not to
 * escape it more carefully - it is not to build markup at all.
 */
function selPlaceholder(sel, text) {
  const o = document.createElement('option');
  o.value = '';
  o.textContent = text;
  sel.replaceChildren(o);
}

async function loadWorkspaces() {
  if (!root) root = await window.idbHandle.get('rootDir');
  const sel = $('ws'); sel.innerHTML = '';
  wsList = [];
  if (!root) {
    sel.innerHTML = '<option value="">No working folder</option>';
    switchDirtyWorkspace(null); dir = null; forgetDirs(); setEnabled(false); updateWsButtons();
    setStatus('Pick a working folder to start - every workspace lives inside it.', 'warn');
    renderBlocked(); await refreshContext(); return;
  }
  rootGranted = await hasPerm(root);
  if (!rootGranted) {
    selPlaceholder(sel, `${root.name} - access not granted`);
    switchDirtyWorkspace(null); dir = null; forgetDirs(); setEnabled(false); updateWsButtons();
    setStatus('Click \u00abGrant access\u00bb above, or anywhere in this panel - one click, no folder picker.', 'warn');
    renderBlocked(); await refreshContext(); return;
  }
  const base = await appRoot(false);
  // The enumeration itself can fail - a handle whose permission lapsed, a folder moved or removed
  // since the browser stored it. Unguarded, that threw out of here and left the panel with no
  // workspace list and no explanation. A folder we cannot read is a state to report, not a crash.
  if (base) {
    try {
      for await (const e of base.values()) {
        if (e.kind !== 'directory' || e.name.startsWith('.')) continue;
        let cfg = null; try { cfg = await readJsonIn(e, CFG); } catch (_) { continue; }   // not one of ours
        if (!cfg || !cfg.org) continue;
        wsList.push({ id: 'org:' + cfg.org, name: e.name, handle: e, cfg, binding: { org: cfg.org, base: cfg.base, instance: cfg.instance, sample: !!cfg.sample } });
      }
    } catch (e) {
      rootGranted = false;
      setStatus(`Could not read \u00ab${root ? root.name : '?'}/${APP_DIR}\u00bb: ${e.message || e}. Click the folder button to grant access again.`, 'warn');
    }
  }
  wsList.sort(byWsLabel);
  if (!wsList.length) {
    // Workspaces sitting directly in the working folder are the older flat layout. Say so precisely
    // instead of reporting an empty list: the folders are there, Zoost is simply not looking at that
    // level any more now that each product has its own.
    let stray = 0;
    try {
      for await (const e of root.values()) {
        if (e.kind !== 'directory' || APP_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
        try { await e.getFileHandle(CFG); stray++; } catch (_) {}
      }
    } catch (_) {}
    selPlaceholder(sel, `${root.name}/${APP_DIR} - no workspaces yet`);
    switchDirtyWorkspace(null); dir = null; forgetDirs(); setEnabled(false); updateWsButtons();
    // **Not over a folder that could not be read.** The catch above works out the true sentence -
    // \u00abCould not read \u00ab\u2026\u00bb: NotFoundError. Click the folder button\u00bb - and this wrote \u00abOpen your Zoho
    // CRM tab, then click + to create its workspace\u00bb on top of it, with that + disabled and the tree
    // below saying a third thing. An empty list has two causes and only one of them is \u00abthere are
    // none\u00bb; the other has already been said, precisely, by whoever discovered it.
    if (rootGranted) {
      setStatus(stray
        ? `${stray} workspace folder(s) sit directly in \u00ab${root.name}\u00bb. Each Zoost product now keeps its own - move them into \u00ab${root.name}/${APP_DIR}/\u00bb and click Refresh.`
        : 'Open your Zoho CRM tab, then click + to create its workspace.', 'warn');
    }
    // Same hole as the Analytics twin, found there: this return never reaches the line below that
    // refreshes the remembered sample id «including to null». Delete the sample when it is the only
    // workspace and the id stays in storage, so the button that offers to write one is hidden for
    // good - while the empty state is telling the reader to press it.
    if (rootGranted) noteSampleWs(null);   // only when the folder was read - see the Analytics twin
    renderBlocked(); await refreshContext(); return;
  }
  // The list is real now, so the remembered answer is refreshed from it - including to null,
  // which is how deleting the sample stops the button offering to open one that is gone.
  noteSampleWs((wsList.find((w) => w.binding && w.binding.sample) || {}).id || null);
  const active = await window.idbHandle.get('activeWs');
  wsList.forEach((w) => {
    const o = document.createElement('option');
    o.value = w.id; o.textContent = wsOptionText(w); o.title = wsOptionTitle(w);
    sel.appendChild(o);
  });
  const act = wsList.find((w) => w.id === active) || wsList[0];
  // `activeWsId` is what `activate()` compares against to decide whether this is the same workspace
  // being re-opened - and setting it here made every switch look like one, so `dropWorkspaceState()`
  // never ran: the conversation, every cache and the queue of failed removals followed the reader
  // into the next org. It is set by `activate()`, which is the one place that knows.
  sel.value = act.id;
  await activate(act, false);
  updateWsButtons();
}

$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
// A stored folder handle loses its permission between sessions and can only be re-granted from a
// user gesture. Any click in the panel counts, so the first thing the user does restores access -
// except on the controls that would themselves ask, on a dialog, on the mismatch overlay, or in the
// chat. The two panels excluded different subsets of those and neither list was wrong, which is how
// a divergence survives: both looked deliberate. It is the union now, and the same on both sides.
// Named, like every async scope this project ships: `tools/asynccheck.py` reads function
// declarations, so an inline callback is a scope nothing looks inside.
async function regrantOnAnyClick(e) {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('#pfoot') || t.closest('.dlg') || t.closest('#aiview') || t.closest('#offoverlay'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await loadWorkspaces(); } } catch (_) {}
}
document.addEventListener('click', regrantOnAnyClick, true);
/** What the workspace list shows, and what it must never stop showing.
 *
 * The label is a convenience; the identity is the org or workspace id. So the label is displayed and
 * the derived name is kept - in the option's tooltip, always, whether or not a label is set. A list
 * that showed only the user's name for something would be a list you cannot check against the
 * platform.
 */
function wsOptionText(w) { return ((w.cfg && w.cfg.label) || '').trim() || w.name; }
/** The workspace list is ordered by what the reader actually sees. Sorting by the derived name
 *  while displaying the user's own label produces a list that looks unsorted - «Acme» in a folder
 *  called «zzz-1234» lands at the end - and this bar is where a consultant with four clients open
 *  spends the day. Numeric, so «Client 2» comes before «Client 10»; base sensitivity, so case and
 *  accents do not split the order. */
function byWsLabel(a, b) { return wsOptionText(a).localeCompare(wsOptionText(b), undefined, { numeric: true, sensitivity: 'base' }); }
function wsOptionTitle(w) {
  const label = ((w.cfg && w.cfg.label) || '').trim();
  return label ? `${label} - folder ${w.name}` : w.name;
}

/** A name of the user's own for a workspace.
 *
 * The folder name is derived from the platform, and the platform is not always evocative: Zoho
 * Analytics names the first workspace of every account the same way, so three projects can arrive on
 * disk with the same label and nothing to tell them apart. Zoho CRM has the instance and the org id,
 * which are unambiguous and still not memorable.
 *
 * So the label is *displayed instead of* the derived name, and the derived name never disappears -
 * it stays in the option's tooltip and in the bar beneath, because the label is a convenience and the
 * identity is the org or workspace id. Storing it in `.zoost.json` (through `patchCfg`, never
 * `writeCfg`) keeps it with the workspace: it survives a re-pull, and it travels with the folder if
 * the folder does.
 */
async function renameWorkspace() {
  if (workspaceChangeRefuse()) return;
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  const w = wsList.find((x) => x.id === $('ws').value);
  if (!w || !dir) return;
  const current = (w.cfg && w.cfg.label) || '';
  const typed = window.prompt(
    `Name for this workspace.\n\nShown in the list instead of \u00ab${w.name}\u00bb, which stays visible as the tooltip.\nLeave it empty to go back to that name.`,
    current);
  if (typed === null) return;                      // cancelled: not the same as cleared
  const label = typed.trim().slice(0, 60);         // it has to fit a 400px bar; longer is not a name
  if (label === current) return;
  try {
    // Chrome lets the folder permission lapse, and this writes to disk. Asked for here because here
    // there is a click to ask under: without it getFileHandle() throws the same bare "not allowed"
    // DOMException the AI path used to. Third time this shape has surfaced - a write reached from a
    // control is a write that must re-request first.
    if (!(await ensurePerm(op.root))) { op.say(MSG.folder, 'warn'); return; }
    if (!op.current()) return;
    await patchCfg({ label }, op);
    if (!op.current()) return;
    op.say(label ? `Workspace named \u00ab${label}\u00bb.` : 'Workspace name cleared - back to the folder name.', 'ok');
    await loadWorkspaces();
  } catch (e) { if (op.current()) setStatus('Could not save the name. ' + friendlyError(e), 'bad'); }
}
$('wsrename').onclick = renameWorkspace;
$('wsadd').onclick = () => addWorkspaceForTab();
$('wssample').onclick = () => addSampleWorkspace();
// The same action from the off-Zoho overlay, which is where somebody who has just installed
// Zoost and is not signed in to anything actually is.
// One call for both copies of the button: addSampleWorkspace() decides whether there is one to
// open or one to write, so the two cannot disagree and neither can act on a stale label.
$('offsample').onclick = () => addSampleWorkspace();
// Named, like every async scope this project ships: `tools/asynccheck.py` reads function
// declarations, so an inline callback is a scope nothing looks inside.
async function onWs() {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value); if (w) await activate(w, true);
}
$('ws').onchange = onWs;
// Named, like every async scope this project ships: `tools/asynccheck.py` reads function
// declarations, so an inline callback is a scope nothing looks inside.
async function onWsdel() {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value); if (!w || !root) return;
  if (!confirm(`Delete the folder \u00ab${w.name}\u00bb and everything in it?\n\nThis removes the local mirror only - nothing in Zoho CRM is touched. You can pull it again at any time.`)) return;
  try {
    if (!(await ensurePerm(root))) { setStatus(MSG.folder, 'warn'); return; }
      const base = await appRoot(false);
      if (!base) { setStatus('Could not open the workspace folder.', 'warn'); return; }
      await base.removeEntry(w.name, { recursive: true });   // delete inside crm/, never at the root
      forgetDirs();   // the folders we remembered are gone with it
    await window.idbHandle.set('activeWs', null);
    currentPath = null; $('preview').classList.remove('show');
    setStatus(`Removed \u00ab${w.name}\u00bb.`, 'ok');
    await loadWorkspaces();
  } catch (e) { setStatus('Remove failed: ' + e.message, 'warn'); }
}
$('wsdel').onclick = onWsdel;

// ---------- view mode (Functions / Modules) ----------
// What you typed in Find belongs to the list you typed it in. It used to belong to the panel, so
// switching from a search in Functions to Modules showed the modules matching a function's name -
// usually none - and the reader had to notice the box was still full to understand why. Reported as
// disorienting, and it is: the box says «I am filtering» about a list that never asked.
const findByMode = {};

function setMode(mode) {
  // The text and *how* it is searched are one thing: putting away «needle» without «in: code» and
  // handing it back as a name search means the same box quietly means something else on the way
  // back. Reported. Saved and restored together.
  if (viewMode && viewMode !== mode) findByMode[viewMode] = { text: $('find').value, mode: searchMode, rx: regexMode };
  viewMode = mode;
  // Restored, not cleared: coming back to a tab you were searching in should find it as you left it.
  const back = findByMode[mode] || { text: '', mode: 'name' };
  $('find').value = back.text;
  regexMode = !!back.rx;
  $('rxmode').classList.toggle('on', regexMode);
  if (mode === 'functions' && back.mode === 'content') {
    searchMode = 'content'; $('smode').textContent = 'in: code'; $('smode').classList.add('on');
    $('find').placeholder = MSG.findInCode;   // the label said code and the box said name
  }
  if (mode !== 'functions') { connectionFilter = null; connFilterSet = null; }   // the connection filter is functions-only
  if (mode !== 'functions' && searchMode === 'content') { searchMode = 'name'; $('smode').textContent = 'in: names'; $('smode').classList.remove('on'); $('find').placeholder = MSG.findByName; }
  $('smode').style.display = mode === 'functions' ? '' : 'none';
  $('rxmode').style.display = $('rxpick').style.display = mode === 'functions' && searchMode === 'content' ? '' : 'none';
  if (!(mode === 'functions' && searchMode === 'content')) $('rxmenu').classList.remove('show');
  $('modebar').querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
  // A jump can land on a tab the reader hid in Settings - a health row, an «Used in» link, a step of
  // the history. `renderTabs()` gives the tab you are *on* a segment even when it is hidden, and
  // that promise was written in its comment while nothing here called it: the row kept the old set,
  // so the panel showed a list with no segment lit and read as having lost its place. Only when the
  // segment is actually missing, so an ordinary switch does not rebuild the row. Walked rather than
  // selected, because a selector built from a value is what the markup checker exists to refuse.
  if (![...$('modebar').querySelectorAll('.seg')].some((b) => b.dataset.tab === mode)) renderTabs();
  const _typeLabel = tabLabel(mode).toLowerCase();
  // The label is in the markup and stays there - writing textContent here replaced the mark with
  // the word on every mode change, so the button reverted the moment anyone touched a segment.
  // Only the title varies, because only the type does.
  $('pullone').title = `Pull only ${_typeLabel} into the local mirror - "Pull all" pulls every type`;
  buildTypeChips();
  $('funcs').style.display = mode === 'functions' ? '' : 'none';
  // It lives in the workspace bar now, beside Export and Health, so it no longer comes and goes with
  // the tab - the diagram window can switch between the two drawings by itself, so there is always
  // something for it to open. Only *which* one it opens follows the tab.
  $('nameToggle').style.display = (mode === 'functions' || mode === 'modules') ? '' : 'none';
  // The mark stays; only what it opens changes. Writing textContent here wiped it on the first
  // mode switch - the same defect as #pullone, and the general shape: a control whose label lives
  // in the markup must not have that label rebuilt by whatever updates its state.
  // Two names, because two different drawings: one is how the org is wired, the other is how it is
  // shaped. Everything else that opens this window uses one of these two and no third word -
  // «Schema», «Graph ↗» and «Open ER» were four names for one thing and the author could not keep
  // them apart. It was «Graph» until that drawing stopped being only functions: it holds workflows,
  // schedules, connections, every automation action and the modules they touch, and a name that
  // says «functions» about a picture of six kinds of thing is the label lying about its subject.
  $('graph').setAttribute('aria-label', mode === 'modules' ? 'ER diagram' : 'Wiring');
  $('graph').title = mode === 'modules'
    ? 'ER diagram - modules and the relations between them, in its own window'
    : 'Wiring - what fires what across the org: functions, workflows, schedules, actions, connections and the modules they touch, in its own window';
  $('nameToggle').textContent = MSG.namePrefix + (mode === 'functions' ? nameMode : moduleNameMode);
  // Changing tab closes the pane and keeps the chain: the whole point of a history that spans the
  // tabs is that a workflow reached from a function is one step away from it, not a fresh start.
  currentPath = null; updateNav(); $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  // Whose button this is, decided here rather than left to whoever draws the list. It was the
  // renderers that set it, and only two of the six call it - so leaving Functions with «Refresh 1
  // outdated» on screen and landing on Schedules left that button sitting over a list it says
  // nothing about, offering to refresh something the reader cannot see. Reported. Every rebuild that
  // does call it still does, and recomputes from its own data; this makes the *mode* the thing that
  // decides, which is what the function already reads on its first line.
  updateMissingButton();
  rebuildActive();
}
// Rebuild the segment row from the registry. Called whenever the set can have changed: at start-up,
// when the settings page saves, and after a pull has learned what the org's roles allow.
//
// If the active tab is no longer among the visible ones - the user just hid it, or a pull discovered
// it is refused - the panel moves to the first that is left, rather than showing an empty view whose
// segment is gone. With every tab hidden it says so instead of rendering a bare strip.
/** What to call a workspace on screen: the name its owner gave it, then the platform's, then the org.
 *
 *  The twin of the Analytics panel's, and the same defect on both sides: the mismatch bar named the
 *  *instance* over a workspace the reader had labelled themselves, in the one sentence that exists to
 *  be recognised. The org id stays beside it, because that is the fact nothing can be wrong about. */
function wsShown(b) {
  if (!b) return '';
  // Two shapes reach here and both are «a workspace»: the binding this panel holds, which carries the
  // reader's own name as `label`, and a row of the workspace list, which carries it as `cfg.label`
  // and the folder as `name`. Reading only the first left «Switch workspace -> ...» naming the
  // platform under a sentence that had just stopped doing exactly that. Reported, after the first
  // fix - and the test that held the sentence stopped at the button, so it agreed with the bug.
  const own = ((b.label || (b.cfg && b.cfg.label) || '') + '').trim();
  return String(own || (b.instance || (b.cfg && b.cfg.instance) || '').trim() || b.org
                || (b.cfg && b.cfg.org) || b.name || '');
}
function renderTabs() {
  const bar = $('modebar');
  const vis = visibleTabs();
  // The tab you are actually looking at always has a segment, even if you hid it. Health links jump
  // straight to a workflow or a schedule, and landing on a list whose segment is not in the row
  // reads as the panel having lost its place. It disappears again as soon as you leave.
  if (viewMode && TAB[viewMode] && !vis.includes(viewMode) && !isForbidden(viewMode)) {
    vis.splice(tabOrder().filter((id) => vis.includes(id) || id === viewMode).indexOf(viewMode), 0, viewMode);
  }
  bar.innerHTML = vis.map((id) =>
    `<button class="seg${id === viewMode ? ' active' : ''}" data-tab="${escA(id)}">${escHtml(tabLabel(id))}</button>`).join('')
    || '<span class="segnone">Every tab is hidden - turn one back on in Settings.</span>';
  bar.querySelectorAll('.seg').forEach((b) => (b.onclick = () => setMode(b.dataset.tab)));
  // First draw: open on the first tab the user ordered, not on a name written into the source.
  // Afterwards, only move when the tab being shown has gone away.
  if (vis.length && (viewMode === null || !vis.includes(viewMode))) setMode(vis[0]);
  fitTabs();
}
/** One row of segments or two, decided by measuring rather than by a width typed here.
 *
 *  The panel's width is Chrome's: `chrome.sidePanel` has no say in it - `getLayout()` reports which
 *  side it is on and nothing else - so a minimum width is not ours to set, and the sixth tab pushed
 *  the row onto two lines at the width the user happens to have. A threshold in a media query would
 *  not do either: the set of tabs is the user's, hidden and reordered in Settings, so the width the
 *  labels need is not a constant - measured, six need 380px and five need 300.
 *
 *  So: ask. The class comes off before measuring, so the decision is always taken from the same
 *  state and cannot oscillate; below about 330px six labels do not fit at any size worth reading and
 *  it wraps, which is the honest end of it. */
function fitTabs() {
  const bar = $('modebar');
  const segs = [...bar.querySelectorAll('.seg')];
  const wrapped = () => segs.length > 1 && segs.some((c) => c.offsetTop !== segs[0].offsetTop);
  // Two steps rather than one, and in this order: the spacing is worth less than the type size, so
  // it goes first and the labels only get smaller when closing the gaps was not enough. Measured on
  // the six shipped tabs: 400px as authored, 380 with the spacing closed, 330 at 10px.
  bar.classList.remove('tight', 'tighter');
  if (!wrapped()) return;
  bar.classList.add('tight');
  if (wrapped()) bar.classList.add('tighter');
}
// The panel is resized by dragging its edge, which fires resize continuously - debounced for the
// same reason the diagram window debounces its re-fit.
let fitTimer = null;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTabs, 120); });
/** Is this path one module's file?
 *
 * Eight walks used to spell this out, each re-stating «a .json under modules/ that is not the index»
 * - which is why nesting anything else under modules/ looked dangerous, and why the first attempt at
 * the layout rename broke three of them at once. The shape of the folders should answer to what a
 * layout *is* (a property of a module), not to how many places repeat a condition. One predicate, and
 * the objection goes away.
 */
const isModuleFile = (p) => p.startsWith('modules/') && p.endsWith('.json')
  && !p.startsWith('modules/layouts/') && p !== 'modules/index.json';
const isLayoutFile = (p) => p.startsWith('modules/layouts/') && p.endsWith('.json')
  && p !== 'modules/layouts/index.json';

async function rebuildActive() { return viewMode === 'functions' ? rebuildTree() : viewMode === 'modules' ? rebuildModules() : viewMode === 'workflows' ? rebuildWorkflows() : viewMode === 'schedules' ? rebuildSchedules() : viewMode === 'actions' ? rebuildActions() : rebuildConnections(); }
// While a pull runs, BOTH pull buttons (global "Pull all" and the per-type "Pull \u2026") stay disabled,
// so switching tabs and clicking a second pull cannot start an overlapping one. They come back only
// when the current pull has finished - success or error.
// Depth, not a switch. `pullEverything` sets it and then calls `pullAll`, which calls
// `downloadMissing`, which set and cleared the same flag - so from the moment the functions were
// fetched the remaining six areas pulled with the flag false, the five-second poll re-enabled both
// Pull buttons, and a second `pullEverything` could start on top of the first. The comment above
// promises the opposite. A count means a nested pull can raise and lower it without knowing who else
// is holding it, which is the only version of this that stays true as callers are added.
let pullDepth = 0;
function setPullBusy(b) {
  pullDepth = Math.max(0, pullDepth + (b ? 1 : -1));
  pullBusy = pullDepth > 0;
  // Both read from Zoho, so both are also off on a sample workspace - and this function is what
  // *re-enables* them when a pull ends, which is how #pullone came back on after setEnabled had
  // already turned it off. A state that is restored somewhere else has to know every reason for it.
  // `pullBusy`, not `b`: with the depth counter, the argument says what this caller wants and the
  // flag says whether anything else still holds it. Reading the argument put the buttons back on
  // while a pull was running - a click that looks available and then does nothing.
  blockZoho(pullBusy || !zohoReady() || !dir || navOpenNow());
  updateWsButtons();
}
function workspaceChangeRefuse() {
  if (!pullBusy) return false;
  $('ws').value = activeWsId || '';
  setStatus('Pull in progress - workspace unchanged.', 'warn');
  updateWsButtons();
  return true;
}
/** Every user entry that re-reads Zoho holds the pull flag for its whole span - which is what
 *  blocks the workspace selector and refuses a second pull on top. The promise «the workspace
 *  cannot change while a pull writes it» was true of the two main buttons only: the per-row
 *  refreshes, the single-item downloads and the module resync all ran with `pullBusy` false, so
 *  the selector stayed live under exactly the writes it exists to protect. Reproduced by an
 *  outside scan on refreshSchedules(). The depth counter absorbs nesting; `finally` is what makes
 *  an exception unable to leave the panel locked. */
async function runPullAction(work) {
  if (pullBusy) return false;
  setPullBusy(true);
  try { await work(); return true; } finally { setPullBusy(false); }
}
async function pullCurrent() {
  if (pullBusy) return;
  const label = tabLabel(viewMode || 'functions').toLowerCase();   // the registry is the only list of these
  setPullBusy(true); setStatus('Pulling ' + label + '\u2026', 'busy');   // immediate feedback (underlying pull sets its own progress next)
  try {
    if (viewMode === 'modules') await pullModules();
    else if (viewMode === 'workflows') await pullWorkflows();
    else if (viewMode === 'schedules') await pullSchedules();
    else if (viewMode === 'actions') await pullActions();
    else if (viewMode === 'connections') await pullConnections();
    else await pullAll();
    if ($('status').className === 'busy') { try { await rebuildActive(); } catch (_) { setStatus('Pull complete.', 'ok'); } }
  } catch (e) { setStatus('Pull error: ' + e.message, 'bad'); }
  finally { setPullBusy(false); }
}
// "Pull all" means every area this user can actually reach. An area Zoho refused last time is
// skipped rather than re-tried on every pull: re-asking a question already answered turns each pull
// into a list of failures nobody can act on. It is not written off either - Settings has "Check
// again" for exactly that, because a role can change and this verdict carries the date it was given.
//
// A hidden-by-choice area is still pulled. Hiding is about the panel being crowded, not about the
// mirror being incomplete: the export and the AI index read from disk, and quietly leaving a type
// out of them because a tab was tidied away would be a mirror that lies by omission.
async function pullEverything() {
  if (pullBusy) return;
  const op = beginWorkspaceOp();   // «Pull all» is one act, and it belongs to the workspace it began in
  setPullBusy(true);
  try {
  const runners = { functions: pullAll, modules: pullModules, workflows: pullWorkflows, schedules: pullSchedules, actions: pullActions, connections: pullConnections, failures: pullFailures };
  // The same seven the button's tooltip names - one list, so the promise and the act cannot part.
  const skipped = [];
  // What this pull will actually do, counted before it starts: the areas your Zoho role allows and
  // your settings ask for. A «3 of 6» that silently meant «3 of whatever is left» would be worse
  // than no number at all.
  const todo = TABS.filter((t) => !isForbidden(t.id) && isPulled(t.id));
  let done = 0;
  for (const t of TABS) {
    // Each area starts its own op, and an op begun *after* a switch belongs to the new workspace -
    // so without this the remaining areas would carry on pulling the tab's org into the folder the
    // user had just opened, which is only refused if that folder is already bound to another org.
    if (!op.current()) return;
    if (isForbidden(t.id)) continue;
    if (!isPulled(t.id)) { skipped.push(t.id); continue; }
    // Said here, before the runner is called, and not left to the runner to say. Every one of them
    // asks for the folder permission, then the tab's context, then reads the config - three or four
    // awaits, seconds on a cold bridge - before its own first message replaces this line. Until then
    // the panel showed the *previous* area's closing line, «All 900 functions downloaded.», with
    // nothing turning: the pull was working and looked finished, then stuck. Reported exactly that
    // way. The position is in it because «what else is left» is the other half of the question.
    op.say(`${tabLabel(t.id)}: ${done + 1} of ${todo.length}…`, 'busy');
    try { await runners[t.id](); } catch (_) { /* each records its own verdict and states its own message */ }
    done++;
  }
  if (!op.current()) return;
  // The last area closes with its own line and then this runs - rebuilding a tree of thousands of
  // rows, which is the second place the panel looked stuck at the end of a pull.
  //
  // And then its own message became the third, which is what a real org found: «Rebuilding the
  // list…» is a *busy* line, and when there was nothing to append to it - no refusal, nothing
  // skipped - nothing ever replaced it. A pull that had finished sat on a spinner indefinitely,
  // and from outside a finished pull and a hung one look the same, which is the one thing this
  // panel is not allowed to do. The twin gets it right: Zoho Analytics ends on its own summary.
  //
  // So the summary the last area wrote is held across the rebuild and put back. The note is
  // appended to *that* rather than to whatever the status happens to say by then - the same
  // defect one line down, which read «Rebuilding the list… · Workflows skipped by your settings».
  const summary = $('stxt').textContent;
  const summaryKind = $('status').className;
  op.say('Rebuilding the list\u2026', 'busy');
  try { await rebuildActive(); } catch (_) {}
  renderTabs();                                   // a refusal discovered just now changes the set
  // Both notes, because they are different facts and neither may be swallowed: one is what Zoho
  // refused, the other is what you told it not to ask for. A pull that quietly covered less than the
  // whole org without saying so is a mirror you cannot trust.
  const note = forbiddenNote()
    + (skipped.length ? ` · ${skipped.map(tabLabel).join(', ')} skipped by your settings` : '');
  if (op.current()) setStatus(summary + note, note ? 'warn' : summaryKind);
  // In a finally, because the body above calls renderers and helpers that are not individually
  // guarded - one exception used to leave `pullBusy` true and the whole panel locked until reopen.
  } finally { setPullBusy(false); }
}

// ---------- modules ----------
// In modules.js - the fifth slice: pull, tree, detail, resync, schema-graph bridge.

// ---------- resilient per-function download ----------
// A 400/401/403/404 is deterministic: retrying repeats the same failure, so we do not. Only a
// network blip or a 429/5xx is worth one retry. Matches the principle: retry what might change,
// not what we already know will fail the same way.
function isTransient(msg) {
  const m = String(msg || '').match(/\b([45]\d\d)\b/);
  if (!m) return true;                 // no HTTP status → network/unknown: a single retry is fair
  const code = +m[1];
  return code === 429 || code >= 500;
}
const errText = (e) => String((e && e.message) || e || 'unknown').replace(/["'<>]/g, '').slice(0, 140);
async function downloadOne(entry) {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return false;
  if (!dir) return false;
  if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'bad'); return false; }
  const info = index.get(entry.id) || {};
  try {
    const r = await toBridge({ cmd: 'fetchOne', id: entry.id, category: entry.category || info.category, source: entry.source || info.source });
    if (!r?.ok || !r.file) throw new Error(r?.error || 'not found');
    const f = r.file;
    await op.write(`functions/${f.folder}/${f.stem}.dg`, f.dg);
    // What the list said about this function at the moment it was fetched, kept beside what the
    // detail said. Two sources, two shapes - the comparison that decides «outdated» needs the pair.
    f.meta.listUpdated = entry.listUpdated || null;
    await op.write(`functions/${f.folder}/${f.stem}.meta.json`, JSON.stringify(f.meta, null, 2));
    // The files are safe - the writer refuses a folder that is not this op's - and `index` and the
    // row are not: they are the panel's memory of the workspace *on screen*, so publishing into them
    // after the last await puts one org's function into another org's index and lights its row.
    // Wrong indoors before it is wrong on disk, and it never reaches the disk to be caught there.
    if (!op.current()) return false;
    // A rename leaves the old pair on disk with a live id, which no prune will ever take. It goes
    // now, and only now: both new files are written, so the new path is authoritative. A removal
    // that fails keeps the old pair - readable is better than gone - and the next load will mark
    // the rename again, so the retry is free.
    if (entry.previousPath && entry.previousPath !== `functions/${f.folder}/${f.stem}.dg`) {
      const cleanup = await removeFunctionPaths([entry.previousPath, entry.previousPath.replace(/\.dg$/, '.meta.json')], op);
      if (cleanup.moved) return false;
      entry.cleanupFailed = cleanup.failed;
    }
    entry.previousPath = null; entry.pathChanged = false;
    if (!op.current()) return false;   // the removals above awaited, and the row is the panel's memory
    entry.path = `functions/${f.folder}/${f.stem}.dg`; entry.namespace = f.folder;
    entry.display_name = f.meta.display_name || entry.display_name; entry.downloaded = true; entry.stale = false; entry.error = false; entry.errorMsg = '';
    index.set(entry.id, { path: entry.path, category: f.meta.category, source: f.meta.source, name: f.meta.name, rest: (f.meta.rest_api || []).some((x) => x.active) });
    return true;
  } catch (e) { entry.error = true; entry.downloaded = false; entry.errorMsg = errText(e); return false; }
}
async function downloadMissing() {
  const op = beginWorkspaceOp();   // the workspace these functions belong to
  // It downloads, so it is refused on the wrong tab like every other pull. A guard rather than a
  // disabled button: the button is `display:none` unless something is missing, and disabling it
  // from `updateMissingButton` would be an assignment on top of the five-second re-render - set
  // once, never revisited, which measured as «still off after the tab came back into line».
  if (!zohoReady()) { setStatus(MSG.wrongTab, 'warn'); return; }
  const pending = treeData.filter((e) => !e.downloaded || e.stale || e.pathChanged);   // stale = older schema, a rename, or Zoho's updatedTime moved
  if (!pending.length) { setStatus('All functions downloaded.', 'ok'); updateMissingButton(); return; }
  setPullBusy(true); $('missing').disabled = true;   // both Pull buttons, and pullCurrent refuses to start on top
  let ok = 0, fail = 0, cleanup = 0;
  // The longest loop in the panel - one fetch and a pause per function, so minutes on a large org,
  // and every one of those minutes is a place the workspace can change underneath. It used to run to
  // the end regardless: each download refused, each refusal counted as a failure, and it finished by
  // announcing «Downloaded 0, 900 still missing» over a workspace that had nothing to do with it.
  try {
    for (let i = 0; i < pending.length; i++) {
      if (!op.current()) return;
      const e = pending[i];
      op.say(`Downloading ${i + 1}/${pending.length}\u2026${fail ? ' (' + fail + ' failed)' : ''}`, 'busy');
      let done = await downloadOne(e);
      if (!done && isTransient(e.errorMsg)) { await sleep(700); done = await downloadOne(e); }   // one backoff retry, transient failures only
      done ? ok++ : fail++;
      if (done && e.cleanupFailed) cleanup += e.cleanupFailed;
      updateRow(e);
      await sleep(140);
    }
    if (!op.current()) return;
    // The summary index describes the .meta.json files, and after a *first* pull it described none of
    // them: `rebuildTree()` writes it, and in a pull it runs before this loop - when the folder is
    // still empty. So the fast path this panel is built on was empty on disk exactly after the
    // operation that fills the workspace, and the next open re-derived it from a folder walk: right
    // answer, 60,015 file-system calls on a five-thousand-function org instead of 8, and nothing said
    // so. Found by the pull probe on its first run, which is the whole argument for that probe.
    // On one line, and it has to stay on one: the check that every op-holding caller hands its op on
    // reads a call up to the first newline, so a break here reads as a call that dropped the
    // workspace. It went red on exactly that, which is the guard being strict rather than wrong.
    const onDisk = treeData.filter((r) => r.downloaded).map((r) => r.path.replace(/\.dg$/, '.meta.json'));
    if (ok) await saveMetaIndex(onDisk, op);
    if (!op.current()) return;
    updateMissingButton();
    setStatus(fail ? `Downloaded ${ok}, ${fail} still missing - use "Complete missing".`
      : cleanup ? `All ${ok} functions downloaded; ${cleanup} old file(s) could not be removed - \u21bb Refresh retries.`
      : `All ${ok} functions downloaded.`, (fail || cleanup) ? 'warn' : 'ok');
  } finally { setPullBusy(false); $('missing').disabled = false; }
}
function updateRow(e) {
  const row = document.querySelector(`.f[data-id="${escA((window.CSS && CSS.escape) ? CSS.escape(e.id) : e.id)}"]`); if (!row) return;
  row.dataset.path = e.path;
  const st = row.querySelector('.st'); if (!st) return;
  const ok = e.downloaded || e.scanned;
  st.className = 'st ' + (e.error ? 'st-err' : ok ? 'st-ok' : 'st-no');
  st.textContent = e.error ? '\u27f3' : ok ? '\u25cf' : '\u25cb';
  st.title = e.error ? (MSG.failed + (e.errorMsg || 'unknown') + MSG.clickRetry) : ok ? 'In workspace - click to refresh' : MSG.notHere;
}
function updateMissingButton() {
  const b = $('missing'); if (!b) return;
  if (viewMode === 'modules' || viewMode === 'schedules' || viewMode === 'connections' || viewMode === 'actions') { b.style.display = 'none'; return; }
  const arr = viewMode === 'workflows' ? workflowData : treeData;
  const miss = arr.filter((e) => !e.downloaded).length;
  const stale = viewMode === 'functions' ? treeData.filter((e) => e.downloaded && e.stale).length : 0;
  const n = miss + stale;
  // It downloads from Zoho, so on a sample there is nothing it could do. Absent rather than
  // disabled: a greyed button says «there is something here you cannot have», and there is not.
  b.style.display = (n > 0 && !isSample()) ? '' : 'none';
  b.textContent = (stale && !miss) ? `Refresh ${stale} outdated` : `Complete missing (${n})`;
}

// ---------- exports ----------
// In export.js, loaded just before this file - the second slice of the split.

// ---------- schedules / workflows / actions ----------
// In automation.js - the fourth slice. Three views that lean on each other, moved together.

// ---------- connections ----------
// In connections.js - the sixth slice.

// ---------- execution failures (and the last 24 hours of run counts) ----------
//
// There is no Failures tab. A failure is not a kind of object - the tabs are functions, modules,
// workflows, schedules, connections - it is an *event about a function*, and giving it a sibling
// tab put it a level too high. It shows in the two places that dimension belongs: on the function
// itself, and in the health view, which already answers «what is wrong across this org».
let failIndex = null;   // {at, usage, byName:Map} - built once per read, dropped when a pull replaces it
async function failuresIndex(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (failIndex) return failIndex;
  let d = null; try { d = JSON.parse(await op.read('failures/index.json')); } catch (_) {}
  const byName = new Map();
  if (d && Array.isArray(d.failures)) {
    d.failures.forEach((f) => { const k = String(f.name || '').toLowerCase(); if (k) (byName.get(k) || byName.set(k, []).get(k)).push(f); });
  }
  if (!op.current()) return null;
  failIndex = { at: (d && d.at) || null, usage: (d && d.usage) || null, runs: (d && d.runs) || null,
                credits: (d && d.credits) || null, capped: !!(d && d.capped), byName, all: (d && d.failures) || [] };
  return failIndex;
}

//
// The rest of the mirror is a photograph of a structure that changes rarely, and its point is that
// `git diff` answers «what changed». This is not that: failures change hourly, and a diff of them is
// noise rather than history. It is written to disk all the same - so the export, the assistant and
// an offline read all see it - but as **one file that says when it was read**, not as a folder of
// items pretending to be durable.
//
// `params` - the input of the failed execution - is dropped in the bridge and never arrives here.
// See the comment there for why: for a REST API failure it carries a real person's name and email,
// and Zoost says on three surfaces that it does not read records.

/** «8 failing» beside a Pull reads as eight failed downloads - the opposite of what it means, since
 *  the pull worked and the number is functions Zoho reports failing at *runtime*. Reported, and the
 *  green did not save it: a colour cannot name a subject. One sentence for both readers of it, the
 *  status line and the health view's own line, so the two cannot drift. */
// The count is a reading of one page, so a full one says so wherever it is shown - here, in the
// health view, in both exports and in what the assistant is told. A number at its own ceiling and
// a number that happens to be the whole truth look identical.
const FAIL_CAPPED = 'Zoho\'s list was read to its first page - there may be more failures than these.';
function runtimeSummary(n, capped) {
  return (n ? `Read from Zoho \u00b7 ${n} function(s) failing there`
            : 'Read from Zoho \u00b7 nothing failing there')
       + (capped ? ` \u00b7 ${FAIL_CAPPED}` : '');
}
async function pullFailures() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;
    await requirePerm(op.root);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(MSG.wrongTab);
    setStatus('Reading failures\u2026', 'busy');
    const r = await toBridge({ cmd: 'pullFailures' }); if (!r?.ok) throw new Error(r?.error || 'failures read failed');
    // One file for everything Zoho knows about how this org *runs*: what failed, how much ran, and
    // what it cost. It keeps the `failures/` name because that is what a reader looks for, and the
    // shape says the rest.
    if (!op.current()) return;
    await op.write('failures/index.json', JSON.stringify({ at: r.at, usage: r.usage || null,
      runs: r.runs || null, credits: r.credits || null, capped: !!r.capped, failures: r.failures || [] }, null, 2));
    await noteAccess('failures', null, op);
    // No view of its own: a failure is a property of a function, not a kind of object, so it shows
    // where that dimension belongs - in the function's own detail, and in the health view, which is
    // already the place that answers «what is wrong across this org».
    setStatus(runtimeSummary((r.failures || []).length, r.capped), 'ok');
    if (viewMode === 'functions') { failIndex = null; await rebuildTree(); }
  } catch (e) { await notePullFailure('failures', e, op); }
  finally { endPull(); }
}

async function pullWorkflows() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;   // button state is owned by setPullBusy at the entry points (pullEverything / pullCurrent)
    await requirePerm(op.root);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(`This workspace is bound to ${envOf(cfg.base)} \u00ab${cfg.instance || '?'}\u00bb (org ${cfg.org}). Active tab is ${envOf(ctx.origin)} \u00ab${ctx.instance || '?'}\u00bb (org ${ctx.org}). Refusing.`);
    setStatus('Listing workflows\u2026', 'busy');
    const r = await toBridge({ cmd: 'listWorkflows' }); if (!r?.ok) throw new Error(r?.error || 'list failed');
    // Same rule the functions pull learned: a list that stopped early describes the reading, not the
    // org. Writing it as the index and pruning what is missing removes workflows that still exist -
    // and the warning came *after* the pruning, so it described rules already gone.
    if (r.capped) {
      setStatus(`Zoho returned a partial list of workflows (stopped at ${r.total || 'the limit'}) - nothing was removed.`, 'warn');
      if (!(await loadWorkflowIndex(op))) return; if (viewMode === 'workflows') renderWorkflows();
      return;
    }
    if (!op.current()) return;   // you changed workspace while this was reading
    await op.write('workflows/index.json', JSON.stringify(r.entries, null, 2));
    const liveIds = new Set(r.entries.map((e) => String(e.id)));
    let prunedW = 0; const wfRmFail = [];
    for await (const p of walk(op.root)) { if (p.startsWith('workflows/') && p.endsWith('.json') && !p.endsWith('/index.json')) { const wid = p.split('/').pop().replace(/\.json$/, ''); if (!liveIds.has(wid)) { try { await op.remove(p); prunedW++; } catch (e) { if ((e && e.message) === WS_MOVED) return; wfRmFail.push(p); } } } }
    if (!(await loadWorkflowIndex(op))) return;
    if (viewMode === 'workflows') { renderWorkflows(); updateMissingButton(); }
    await downloadMissingWf();
    // The writes above dropped \u00abwhich rule fires this action\u00bb - it is read out of these very rules.
    // Dropping it is the write's business; rebuilding it has to happen where there is an await, and
    // this is that place: `actionFiredBy()` is called while a row is being drawn and cannot read a
    // file, so a map that is merely absent would be drawn as \u00abno rule fires this\u00bb, which is a
    // stronger claim than the stale one it replaced.
    if (actionUsers === null) {
      const users = await buildActionUsers(op);
      if (!op.current()) return;
      actionUsers = users;
    }
    if (viewMode === 'actions') renderActions();
    if (prunedW) setStatus($('stxt').textContent + ` \u00b7 ${prunedW} deleted removed`, 'ok');
    // A removal that failed is a deleted rule still on screen: loadWorkflowIndex() reads the disk,
    // so the residue is what the reader sees - said, recorded, retried by the next pull for free.
    if (wfRmFail.length) setStatus($('stxt').textContent + ` \u00b7 ${wfRmFail.length} deleted rule(s) could not be removed - the next pull retries`, 'warn');
    if (r.capped) setStatus($('stxt').textContent + ' \u00b7 list stopped early - some workflows may be missing', 'warn');
    await noteAccess('workflows', wfRmFail.length ? { status: 0, message: `${wfRmFail.length} stale workflow file(s) could not be removed` } : null, op);
  } catch (e) { await notePullFailure('workflows', e, op); } finally { endPull(); }
}
async function openWorkflowInZoho(id) {
  if (sampleRefuse()) return;
  const ws = bound || {};
  if (!ws.base || !ws.instance) { setStatus('Unknown workspace binding - pull first.', 'warn'); return; }
  const url = `${ws.base}/crm/${ws.instance}/settings/workflow-rules/${id}`;
  try { await goToZoho(url); setStatus('Opened workflow in Zoho.', 'ok'); }
  catch (e) { setStatus('Could not open: ' + e.message, 'warn'); }
}
async function openWorkflow(e) {
  const mine = ++previewLoad;
  const op = beginWorkspaceOp();
  if (!e.downloaded) {
    const ok = await downloadOneWf(e);
    if (!previewCurrent(mine, op)) return;
    updateRow(e); updateMissingButton();
    if (!ok) { setStatus('Could not download this workflow.', 'warn'); return; }
  }
  let rule; try { rule = JSON.parse(await op.read(e.path)); } catch (err) { if (previewCurrent(mine, op)) setStatus(MSG.readFailed + err.message, 'bad'); return; }
  if (!previewCurrent(mine, op)) return;
  currentPath = e.path; navHere(e.name);
  selectRow(e.path);
  setPvName(e.name, e.path);
  $('pvcallers').className = ''; $('pvcallers').textContent = ''; pvTabsFor(null);   // else the last function's callers/connections bar lingers
  $('pvreveal').style.display = ''; $('pvreveal').textContent = MSG.openInZoho; $('pvreveal').title = 'Open the workflow in Zoho'; $('pvfind').style.display = 'none';
  $('pvbody').style.display = 'none'; $('pvtable').style.display = 'block';
  $('pvtable').innerHTML = renderWorkflowDetail(rule);
  showPreview();
  wireFnChips($('pvtable'), (sp) => openFunctionFromWorkflow(sp.dataset.fnid, sp.dataset.fnname));
  const _ub = $('pvtable').querySelector('.wfusage'); if (_ub) _ub.onclick = () => loadWorkflowUsage(_ub.dataset.wfid, $('pvtable').querySelector('.wfusage-out'), _ub);
}
function renderWorkflowDetail(rule) {
  const esc = escHtml;
  const trig = (rule.execute_when && rule.execute_when.type) || '?';
  const mod = (rule.module && rule.module.api_name) || '?';
  // recursive criteria (handles nested groups)
  const valOf = (g) => {
    const v = g.value;
    if (g.type === 'field' && v && v.api_name) return v.api_name;
    if (v === '${EMPTY}' || v === '${empty}') return 'empty';
    return v == null ? '' : String(v);
  };
  const one = (g) => `${(g.field && g.field.api_name) || '?'} ${g.comparator || ''} ${valOf(g)}`;
  const critText = (crit) => {
    if (!crit) return '';
    if (crit.group && crit.group.length) { const op = crit.group_operator || 'AND'; return crit.group.map((g) => (g.group ? '(' + critText(g) + ')' : one(g))).join(` ${op} `); }
    if (crit.comparator) return one(crit);
    return '';
  };
  const timingText = (bk) => {
    const ea = bk.execute_after;
    if (ea && ea.unit != null) return `after ${ea.unit} ${ea.period || ''}`.trim();
    const t = bk.execution_details || bk.interval || bk.schedule || bk.time || null;
    if (!t) return '';
    if (typeof t === 'object') {
      if (t.days != null) return `after ${t.days} day(s)`;
      if (t.hours != null) return `after ${t.hours} hour(s)`;
      if (t.field || t.date_field) return `based on ${esc((t.field && t.field.api_name) || t.date_field || 'a date field')}`;
      return esc(JSON.stringify(t));
    }
    return esc(String(t));
  };
  const actionSpan = (a) => isFnAction(a)
    ? `<span class="wf-fn" data-fnid="${escA(a.id)}" data-fnname="${escA(a.name)}" title="Open the function">\u0192 ${esc(a.name)}</span>`
    : `<span class="wfact">${esc(a.type)}: ${esc(a.name)}</span>`;
  const bucketHtml = (bucket, label) => {
    if (!bucket) return '';
    const buckets = Array.isArray(bucket) ? bucket : [bucket];
    let out = '';
    buckets.forEach((bk) => {
      const acts = (bk && bk.actions) || [];
      const tim = bk && typeof bk === 'object' ? timingText(bk) : '';
      if (!acts.length && !tim) return;
      out += `<div class="wfacts"><span class="wk">${label}${tim ? ` <i>(${tim})</i>` : ''}</span>${acts.map(actionSpan).join('')}</div>`;
    });
    return out;
  };
  let h = `<div class="wfd">`;
  h += `<div class="wfrow"><span class="wk">Module</span> <b>${esc(mod)}</b></div>`;
  const ew = rule.execute_when || {}, det = ew.details || {};
  const trigParts = [esc(ew.type || '?')];
  if (det.repeat != null) trigParts.push(`repeat: ${det.repeat ? 'yes' : 'no'}`);
  if (Array.isArray(det.fields) && det.fields.length) trigParts.push(`fields: ${det.fields.map((fl) => esc((fl.field && fl.field.api_name) || fl.api_name || String(fl))).join(', ')}`);
  Object.keys(det).forEach((k) => { if (['trigger_module', 'repeat', 'fields'].includes(k)) return; const v = det[k]; if (v != null && typeof v !== 'object') trigParts.push(`${esc(k)}: ${esc(String(v))}`); });
  h += `<div class="wfrow"><span class="wk">Trigger</span> ${trigParts.join(' \u00b7 ')}</div>`;
  if (rule.category && rule.category !== 'default') h += `<div class="wfrow"><span class="wk">Category</span> ${esc(rule.category)}</div>`;
  const ewCrit = critText(det.criteria || ew.criteria);
  if (ewCrit) h += `<div class="wfrow"><span class="wk">When</span> ${esc(ewCrit)}</div>`;
  h += `<div class="wfrow"><span class="wk">Status</span> ${rule.status && rule.status.active ? 'active' : 'inactive'}</div>`;
  // Same row, same words as the Schedules preview: "Last run" is one fact and must not be two names.
  if (rule.last_executed_time) h += `<div class="wfrow"><span class="wk">Last run</span> ${esc(rule.last_executed_time)}</div>`;
  if (rule.description) h += `<div class="wfrow"><span class="wk">Description</span> ${esc(rule.description)}</div>`;
  (rule.conditions || []).forEach((c, i) => {
    h += `<div class="wfcond"><div class="wfch">Condition ${c.sequence_number || i + 1}</div>`;
    const cd = c.criteria_details || {};
    const ct = critText(cd.criteria);
    if (ct) h += `<div class="wfcrit">${esc(ct)}</div>`;
    const rel = cd.relational_criteria;
    if (rel && (rel.module || rel.criteria)) h += `<div class="wfcrit"><i>related:</i> ${esc((rel.module && rel.module.api_name) || rel.module || '')} ${esc(critText(rel.criteria))}</div>`;
    h += bucketHtml(c.instant_actions, 'Instant');
    h += bucketHtml(c.scheduled_actions, 'Scheduled');
    h += `</div>`;
  });
  h += `<div class="wfusage-wrap"><button class="wfusage" data-wfid="${escA(rule.id)}">Show executions (last 30 days)</button><div class="wfusage-out"></div></div>`;
  h += `<details class="wfraw"><summary>Raw JSON</summary><pre>${esc(JSON.stringify(rule, null, 2))}</pre></details>`;
  return h + `</div>`;
}
async function loadWorkflowUsage(id, outEl, btn) {
  if (mismatchRefuse()) return;
  btn.disabled = true; outEl.textContent = 'Loading executions\u2026';
  const fmt = (d) => d.toISOString().slice(0, 10);
  const till = new Date(), from = new Date(Date.now() - 30 * 864e5);
  try {
    const r = await toBridge({ cmd: 'workflowUsage', id, from: fmt(from), till: fmt(till) });
    if (!r?.ok || !r.usage) throw new Error(r?.error || 'no data');
    outEl.innerHTML = renderUsage(r.usage); btn.style.display = 'none';
  } catch (e) { outEl.textContent = 'Could not load executions: ' + e.message; btn.disabled = false; }
}
function renderUsage(u) {
  const esc = escHtml;
  let h = `<div class="wfu"><div class="wfrow"><span class="wk">Triggered</span> <b>${u.trigger_count == null ? 0 : u.trigger_count}</b> times (last 30 days)</div>`;
  (u.conditions || []).forEach((c) => ['instant_actions', 'scheduled_actions'].forEach((bk) => {
    const bucket = c[bk]; const buckets = Array.isArray(bucket) ? bucket : (bucket && bucket.actions ? [bucket] : []);
    buckets.forEach((bb) => (bb.actions || []).forEach((a) => {
      h += `<div class="wfustat"><span class="an">${esc(a.name)}</span> <span class="ok">${a.success_count || 0} ok</span> \u00b7 <span class="fail">${a.failure_count || 0} fail</span> \u00b7 ${a.queue_count || 0} queued</div>`;
    }));
  }));
  return h + `</div>`;
}
function openFunctionFromWorkflow(id, name) {
  const nid = String(id || ''); const nm = (name || '').toLowerCase();
  let ent = treeData.find((x) => x.id === nid) || treeData.find((x) => (x.display_name || '').toLowerCase() === nm || (x.api_name || '').toLowerCase() === nm);
  if (!ent) { setStatus(`Function "${name}" not in workspace - pull functions first.`, 'warn'); return; }
  if (!tabReachable('functions')) return;
  setMode('functions'); openFromTree(ent.path);
}


/** Pick up what the options page changed, without a manual refresh.
 *
 * A declaration rather than an `async (ch, area) => {}` handed to the listener: the checker cannot
 * enter one, and this reads the folder handle and the scope and then writes both into the panel -
 * the shape that has cost this repository six identical defects.
 */
async function applySettingsChange(ch, area) {
  if (area !== 'local') return;
  if (ch.aicfg) aiEngineChrome();            // engine/model changed: refresh the badge and the notice
  if (ch.tabPrefs) {
    await loadTabPrefs();
    // Hiding the tab you are standing on has to take you off it. `renderTabs()` gives the tab you
    // are *on* a segment even when it is hidden - which is right for a jump, where a health row
    // lands you on a hidden list and a row with no segment reads as the panel having lost its
    // place - and wrong for this, where you have just said «remove that one» about the thing in
    // front of you. So two tabs turned off in Settings left one gone and one still there, and the
    // difference was which one you happened to be looking at. Reported exactly that way.
    if (viewMode && isHiddenByUser(viewMode)) {
      const next = visibleTabs()[0];
      if (next) setMode(next);            // setMode renders the row itself
      else renderTabs();                  // every tab hidden: the row says so
    } else renderTabs();
  }
  if (ch.zohoDc) zohoDc = ch.zohoDc.newValue || zohoDc;
  if (!ch.settingsStamp) return;
  await loadScope();
  aiEngineChrome();
  const prevRoot = root; root = await window.idbHandle.get('rootDir');
  if (root === prevRoot && dir) { updateWsButtons(); return; }
  if (pullActive) { pendingRootReload = true; setStatus(MSG.rootLater, 'warn'); return; }
  // Not while a pull is writing. Rebuilding the list sets `dir`, and every `op.write` still in
  // flight then throws WS_MOVED - which is *silent* by design, since a pull's status is guarded
  // by `current()`. So the pull would stop half-way and say nothing, from a click in another tab.
  await loadWorkspaces();
}

// ---------- boot + tab reactivity ----------
$('opts').onclick = () => openSettings();
$('help').href = DOCS_URL;
// The options page is a separate document: pick up its changes without a manual refresh.
try {
  chrome.storage.onChanged.addListener((ch, area) => { void applySettingsChange(ch, area); });
  // Belt and braces: the options page lives in another tab, so re-read on focus as well.
  window.addEventListener('focus', () => { aiEngineChrome(); });
} catch (_) {}
$('about').onclick = showAbout; $('aboutx').onclick = closeAbout; $('aboutok').onclick = closeAbout;
$('expx').onclick = () => closeScope(false); $('expcancel').onclick = () => closeScope(false);
// Persist what the user chose, not what staleness cleared on their behalf. A box they left
// untouched keeps whatever Settings said; one they re-ticked is theirs and is remembered.
// Named, like every async scope this project ships: `tools/asynccheck.py` reads function
// declarations, so an inline callback is a scope nothing looks inside.
async function onExpgo() {
  scopeFromUI();
  const keep = Object.assign({}, dlgScope);
  dlgAutoCleared.forEach((k) => { keep[k] = expScope[k]; });
  expScope = keep;
  // Awaited, and a refusal is said. What is stored here is where the dialog **starts next time** -
  // not the scope of the export about to run, which travels through `closeScope(true)` - so a
  // refused write must not stop the export the reader just asked for. It must not be silent either:
  // this is a choice they made by hand, and the old `try { … } catch (_) {}` around an un-awaited
  // promise caught nothing at all, so the panel closed the dialog claiming a save that never
  // happened and the next session opened it back at the old ticks.
  try { await chrome.storage.local.set({ exportScope: expScope }); }
  catch (e) { setStatus(`This export runs with what you ticked; the browser refused to remember it as `
    + `the default (${(e && e.message) || 'no reason given'}).`, 'warn'); }
  closeScope(true);
}
$('expgo').onclick = onExpgo;
$('pspFull').onclick = () => { dlgScope = Object.assign({}, SCOPE_FULL); dlgAutoCleared.clear(); scopeToUI(); };
$('pspSafe').onclick = () => { dlgScope = Object.assign({}, SCOPE_SAFE); dlgAutoCleared.clear(); scopeToUI(); };
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('scrim').onclick = () => { if ($('expscope').classList.contains('on')) closeScope(false); else closeAbout(); };
loadScope();
loadZohoDc();
// The tab set is a preference plus a per-workspace measurement, so it is built once at start-up and
// again whenever either can have moved: a workspace opening (different org, different roles) and a
// pull learning something new both call renderTabs themselves.
loadTabPrefs().then(renderTabs);
// One listener for every fields table there will ever be. The picklist cells are rebuilt by each
// module and again by the layout picker, so a handler attached after an innerHTML is one somebody
// forgets to re-attach - which is how a control ends up dead on the second render only.
$('pvtable').addEventListener('click', (e) => {
  const b = e.target.closest('.plbtn'); if (!b) return;
  const box = b.closest('tr') && b.closest('tr').nextElementSibling; if (!box || !box.classList.contains('plrow')) return;
  const opening = box.hidden;
  box.hidden = !opening;
  b.setAttribute('aria-expanded', String(opening));
  const n = b.dataset.n;
  b.textContent = `${opening ? '\u25be' : '\u25b8'} ${n} value${n === '1' ? '' : 's'}`;
});
document.querySelectorAll('#pvtabs .dtab').forEach((b) => (b.onclick = () => setPvTab(b.dataset.pv)));
$('pull').onclick = pullEverything; $('pullone').onclick = pullCurrent; // One group in the health view is read from Zoho; the rest is computed from the mirror. Before this
// existed the only way to refresh that group was «Pull all» - the whole org re-downloaded to update
// one reading, which he pointed out. It refuses on the wrong tab and on a sample like every other
// Zoho-bound control, and it rebuilds the view in place rather than closing it.
/** Beside the control, because #status is inside #belowbar and this view covers it: every
 *  setStatus() made while the health view is open is written where nobody can see it - which is why
 *  pressing Pull runtime looked as though nothing happened at all, refusal included. */
function healthSay(text, cls) { const el = $('healthmsg'); if (el) { el.textContent = text || ''; el.className = cls || ''; } }
async function pullHealthRuntimeNow() {
  // A sample is not a mismatch, and saying so is the difference between an explanation and a wrong
  // answer: there is no org behind it to re-read, and «the tab does not match» would send somebody
  // switching tabs to fix something no tab can fix.
  if (isSample()) { sampleRefuse(); healthSay(MSG.sampleNoOrg, 'warn'); return; }
  if (!guardOk()) { setStatus(MSG.wrongTab, 'warn'); healthSay(MSG.wrongTab, 'warn'); return; }
  const b = $('healthpull'); b.disabled = true;
  healthSay('Reading from Zoho\u2026');
  // One operation for the whole sequence: the selector is blocked during the *pull*, and came back
  // the moment it ended - while the audit that follows was still reading the mirror. Reproduced by
  // an outside scan: results of the workspace that was left, published into the one that arrived.
  //
  // Declared **before** the try, because the catch reads it. Inside, `catch` has a scope of its own
  // and there is no other `op` in this file - so every error from this sequence was replaced by
  // «op is not defined», thrown out of the handler that existed to report it: the health view stayed
  // on «Reading from Zoho...» for good, the real reason was lost, and «Report this problem» carried
  // the ReferenceError instead of the fault. Found by a review of this file.
  const op = beginWorkspaceOp();
  try {
    await pullFailures();
    if (!op.current()) return;
    failIndex = null;                       // the file changed under it
    const built = await buildHealth(op);
    if (!op.current()) return;
    healthData = built;
    renderHealthView();
    const fx = await failuresIndex(op);
    if (!fx || !op.current()) return;   // overtaken: the runtime it read belongs to the workspace that was left
    healthSay(runtimeSummary(fx.all.length, fx.capped), 'ok');
  } catch (e) { if (op.current()) { setStatus(MSG.rereadErr + e.message, 'bad'); healthSay(MSG.rereadErr + e.message, 'bad'); } }
  finally { b.disabled = false; }
}
async function pullHealthRuntime() {
  return runPullAction(() => pullHealthRuntimeNow());
}
$('healthpull').onclick = pullHealthRuntime;

/** ↻ Refresh: distrust everything on disk, read it again, and retry what a removal could not finish.
 *
 * A declaration rather than an `= async () => {}` written into the wiring line - the checker cannot
 * enter one, and this awaits four things in a row and redraws the panel from each.
 */
async function onRefresh() {
  if (root && !rootGranted) { await grantRoot(); return; }
  distrustEverything(); dropFileCaches(); await rebuildActive();
  // The message that reports a removal it could not finish says «click Refresh», so Refresh has
  // to be the thing that tries again - a remedy naming a control that does something else is
  // worse than no remedy, because the reader does it and believes it worked.
  if (failedRemovals.size) await reconcileFunctions();
}

$('health').onclick = toggleHealth; $('healthx').onclick = closeHealth; $('missing').onclick = () => (viewMode === 'workflows' ? downloadMissingWf() : downloadMissing()); $('export').onclick = exportHtml; $('exportmd').onclick = exportMarkdown; $('graph').onclick = () => (viewMode === 'modules' ? openSchemaGraph() : openGraph()); $('refresh').onclick = onRefresh;
$('ainotex').onclick = () => $('ainote').classList.remove('show');   // hidden for this session of the chat, back on next open
$('ailockgo').onclick = aiUnlock; $('ailockpass').onkeydown = (e) => { if (e.key === 'Enter') aiUnlock(); };
$('askai').onclick = toggleAI; $('aix').onclick = closeAI; $('aiclear').onclick = aiClear; $('aisend').onclick = aiSend; $('aigear').onclick = aiOpenSettings;
$('aiinput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiSend(); } });
buildTypeChips();
// A declaration, because a `.then(cb)` is a scope nothing can read - and small as it is, this one
// writes into the layout after an await.
async function restorePreviewHeight() {
  let r;
  try { r = await chrome.storage.local.get('previewH'); } catch (_) { return; }
  if (r?.previewH) $('preview').style.height = r.previewH;
}
void restorePreviewHeight();
chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_t, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
loadWorkspaces();
setInterval(refreshContext, 5000);

// What the report is allowed to know, gathered in one place so a reader can see the whole of it at
// once. Every value is a number, a boolean or one of a fixed set of words; the two free-text fields
// - the message and the stack - go through `redact()` inside buildReport. Nothing here reads the
// mirror, the sources, the SQL or any name.
function reportFacts(err, ai) {
  const m = chrome.runtime.getManifest();
  const ua = navigator.userAgent.match(/Chrome\/(\d+)/);
  return {
    product: m.name,
    version: m.version,
    browser: 'Chrome ' + (ua ? ua[1] : '?'),
    message: (err && (err.message || err)) || $('stxt').textContent,
    stack: (err && err.stack) || '',
    tab: viewMode || '?',
    search: searchMode === 'content' ? (regexMode ? 'code, pattern' : 'code') : 'names',
    pullActive: !!pullBusy,
    sample: isSample(),
    counts: {
      functions: (treeData || []).length,
      downloaded: (treeData || []).filter((e) => e.downloaded).length,
    },
    // The access record is «which areas your Zoho role answered for», already held for the settings
    // page. Only the refused keys travel: the names of what was refused, never anything inside it.
    // `tabAccess[k]` is an object - `{state, status, at, pulledAt}` - and never `false`, so this read
    // `=== false` and reported an empty list every time. The one fact in the report that explains a
    // whole class of «why is this tab empty» was the one it never carried. Found by a review.
    refused: Object.keys(tabAccess || {}).filter((k) => tabAccess[k] && tabAccess[k].state === 'forbidden'),
    ai,
    steps: reportSteps.slice(),
  };
}
// The last thing that actually threw. `openReport()` is opened from a button, so it has no error
// to hand - and without this the report was *only* the status buffer, which is the half that has to
// be redacted hardest and the half that says least. Two listeners, no call-site changes: an uncaught
// error and a rejected promise are exactly the failures worth a stack.
let lastThrown = null;
window.addEventListener('error', (e) => { if (e && e.error) lastThrown = e.error; });
window.addEventListener('unhandledrejection', (e) => { if (e && e.reason instanceof Error) lastThrown = e.reason; });
let reportText = '';
// Which engine is set, and nothing else about it: never the key, never the passphrase, not even
// whether one is stored - an AI failure is engine-shaped, and that is the whole of what helps.
async function aiEngineWord() {
  try {
    const r = await chrome.storage.local.get('aicfg');
    const c = (r && r.aicfg) || {};
    return c.active === 'anthropic' || c.active === 'openai' ? c.active : 'not configured';
  } catch (_) { return 'unknown'; }
}
// The report is handed to the page through the DOM, never through the address. It used to travel in
// the URL fragment, on the reasoning that a fragment is never transmitted to a server - true, and
// not the whole question: the navigation itself is written to Chrome's history and syncs with it, so
// the report would have left the machine with no click at all. Found by an audit of this feature.
//
// One click, one place to read it. The panel used to show the text in a dialog and call its button
// «Send…», which sent nothing: the reader read the same text twice and only the second copy had the
// button that mattered. What that step was defending - «read it before it leaves the machine» - is
// not what it did, because nothing leaves when the page opens: the text is written into a page in
// front of the reader and stays there until they press Send. So the reading happens once, where the
// sending is. The one thing it did cost is now stated on the site: opening the page is an ordinary
// visit to zoost.it, which a reader who changes their mind on the panel side never made.
$('repdismiss').onclick = () => showEmergency(false);
/** Open the report in a window of its own and write the text into it.
 *
 * A declaration rather than an `= async () => {}`, which is a scope the race checker cannot enter -
 * and the first thing it does is write `reportText`, a module-level value, after an await.
 */
async function onRepopen() {
  reportText = buildReport(reportFacts(lastThrown, await aiEngineWord()));
  const text = reportText;
  try {
    // A **window**, not a tab. The side panel belongs to the window it is open in, so a new tab
    // opens with this panel still down the side of it - the reader is asked to read a report with
    // the thing that produced it sitting next to the text. A fresh window has no panel in it.
    // `chrome.windows` needs no permission of its own; the writing still does, and that is the
    // `zoost.it` host already declared.
    const win = await chrome.windows.create({ url: 'https://zoost.it/report', focused: true });
    const tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
    if (!tabId) { setReportFallback(); return; }
    const put = (t) => {
      const b = document.getElementById('body');
      if (b) { b.value = t; b.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    // Once, when that tab has finished loading - and only that tab.
    const onDone = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onDone);
      chrome.scripting.executeScript({ target: { tabId }, func: put, args: [text] })
        .catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(onDone);
  } catch (_) {
    setReportFallback();
  }
}
$('repopen').onclick = onRepopen;
// If the tab cannot be opened or written to, say so and leave the reader somewhere to go - a silent
// bail here is a button that looks like it worked.
function setReportFallback() {
  // The sentence below is a claim about the clipboard, so it waits to find out whether it is
  // true. It used to be printed unconditionally beside a `try` that could not catch the
  // write's rejection - so a refused clipboard was announced as a successful one, on the one
  // path whose whole purpose is to leave the reader somewhere to go.
  void sayWhereTheReportWent();
}
// Awaited rather than chained: a `.then(ok, no)` is two scopes nothing can read, and both of them
// write the line the reader acts on.
async function sayWhereTheReportWent() {
  try {
    await navigator.clipboard.writeText(reportText);
  } catch (_) {
    setStatus('Could not open the report page, and the clipboard was refused too. The report is in the panel above - select it and copy it by hand.', 'bad');
    return;
  }
  setStatus('Could not open the report page - the report is on your clipboard. Paste it at zoost.it/report.', 'warn');
}
