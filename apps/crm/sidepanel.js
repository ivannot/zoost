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
const LOCAL_BTNS = ['overview', 'graph', 'refresh', 'export', 'exportmd', 'health', 'askai'];
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
// Which language the list is held to. Its own variable and not a value of `typeFilter`, because the
// two are orthogonal: «the automation namespace» and «written in Python» are different questions and
// a reader wants to ask them together. `all` here means every language, the same word the other
// filters use for the same idea.
let langFilter = 'all';
// The panel is only the adapter for the pure list model. The same predicate is used by full-text
// search, while renderTree asks the model for the whole selection and its exact empty-state count.
const passRow = (e) => functionRowPasses(e, { typeFilter, langFilter, languageFamily: langFamily });
// The data centre to fall back on when the panel knows neither a workspace nor a tab. It is a
// display-only copy of a setting, so it is read into a URL and never written from here.
let zohoDc = 'zoho.com';
let connectionFilter = null, connFilterSet = null;   // when set, the functions tree shows only functions using that connection
let treeSort = 'name';        // 'name' keeps the namespace grouping; any other key sorts flat
let treeSortDir = 'asc';      // 'asc' | 'desc' - defaults per sort: A→Z for names, biggest-first for numbers
// `viewMode` opens on whatever tab the user put first, decided once in renderTabs() the first time
// the row is drawn. It used to be hard-coded to 'functions', so reordering the tabs moved the
// segments and left the panel showing the same one it always had - the preference was honoured in
// the strip and ignored by the thing the strip is for. Null until that first render, never after.
let viewMode = null, moduleData = [], moduleFilter = 'all', moduleNameMode = 'display';
const searchState = createSearchState({ scope: 'functions', fullTextScope: 'functions', fullTextMode: 'content' });
let codeCache = null, _searchT = null;
let searchSeq = 0;              // every runSearch() bumps it, so a content search that finished late knows it
let workflowData = [], workflowFilter = 'all', wfIndex = new Map();
let scheduleData = [], scheduleFilter = 'all';
const collapsed = new Set();
const expandedMods = new Set();
let pullActive = false, pullBusy = false;
// Set when a tab preference is saved while a pull is running, spent by the line that closes it.
let prefsSavedDuringPull = false;
// **The panel writes that key itself**, from inside a pull: `takeRecheck` spends a re-check by
// rewriting `tabPrefs`, and `storage.onChanged` cannot tell whose write it was. Without this the
// run closed by telling the reader they had saved something during it - a sentence about an act
// nobody performed, which is the one kind of wrong this panel is least allowed to be. Reported
// from outside. The settings page has carried the same guard, under the same name, for longer.
let ownPrefsWrite = false;

const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = '') => { noteStep(t); $('stxt').textContent = t; $('status').className = cls; showEmergency(false); };



// The pointer to zoost.it/emergency: a link that lives in the markup and is only ever shown or
// hidden. Nothing here is ever built from what Zoho answered, which is what keeps the status line
// safe to print a platform error into - it stays textContent, and the link stays static.
//
// Cleared by every status write and set again by the one failure path that should carry it, so it
// cannot linger over a later success. One place to clear, one place to set.
/** Raise the failure controls: the link to /emergency, and the report button beside it.
 *
 *  **They answer different questions and were toggled together.** «A fix may already be released» is
 *  about the platform; «Report this problem» is about telling somebody what happened. For a refusal
 *  the panel can explain, the first is wrong - it was the reader's own objection, «non e' un problema
 *  applicativo» - and hiding both took the second with it. That mattered more than it looks: the one
 *  error in this product that builds a `diag` is the one that carries a `note`, and `diag` exists for
 *  nothing but the report. So «it is carried» and «nothing carries it» became the same thing again,
 *  one commit after that exact sentence was written about the same button.
 *
 *  `report` defaults to `link`, so every caller that means «put them away» still does.
 */
function showEmergency(link, report = link) {
  const on = { emerg: !!link, repopen: !!report, repdismiss: !!report };
  for (const id of Object.keys(on)) { const e = $(id); if (e) e.classList.toggle('on', on[id]); }
}
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
  // Settings is a separate tab and nothing disables it while a pull runs - it was believed to be
  // disabled, and it is not. A pull is one act, decided when it starts, so a preference saved
  // during one belongs to the next: said here rather than left to be noticed by a run that
  // ignored it. The change *is* applied to the panel at once; it is the run in flight that keeps
  // the plan it began with.
  prefsLater: 'tab settings saved while this ran - they take effect from the next pull',
  wrongTab: 'Active Zoho tab does not match this workspace.',
  lastModified: 'Last modified',
  sampleNoOrg: 'This is the sample workspace - there is no Zoho org to open.',
  noModuleTarget: 'Unknown module target - pull once, or open Zoho first.',
  noActionTarget: 'Zoho has no page for this kind that Zoost knows of - open it from the automation list.',
  staleBridge: 'The Zoho tab is still running an older copy of this extension - reload that tab, then pull again.',
  // The three status-dot tooltips, which say what a click will do rather than what the mark is.
  notHere: 'Not in workspace - click to download',
  // Not «click to download»: there is nothing a click could fetch. Zoho compiles functions in six
  // languages and this mirror reads the source of one of them; the others are listed and named, and
  // that is all this build claims. Saying the wrong missing thing is worse than saying nothing,
  // because the reader goes and does it and nothing changes.
  notMirrored: (lang) => `${lang} function - this older workspace entry has no local source. Pull again to mirror its project files.`,
  // Listed by Zoho and refused by Zoho, which is a settled answer rather than a step still to come.
  // Not «click to retry» for the same reason as the line above: a click re-asks a question already
  // answered, once per function. A pull is the re-check, and it says so - roles do change.
  srcRefused: (at) => 'Zoho refused the source of this function to this user'
    + (at ? ` (asked ${String(at).slice(0, 10)})` : '') + '. Pull again to re-check.',
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
// Deluge is a single source file; Java, Python and Node are projects. The distinction remains useful
// for static analysis (the Deluge parser must not be run over another language), not for mirroring:
// every language Zoho lists is downloaded.
const isDeluge = (lang) => !lang || /^deluge/i.test(String(lang));
const langLabel = (lang) => (isDeluge(lang) ? 'Deluge' : String(lang).replace(/_/g, ' '));
// Zoho spells a language with its runtime in it - `java`, `java17`, `nodejs`, `nodejs_22`,
// `python_3_12` - and that is the right thing to *record*: a mirror that flattened it would lose
// which runtime a function is compiled for. It is the wrong thing to put in a menu, where it became
// six entries and two of them read «nodejs 22» and «python 3 12». The family is what somebody
// filters or sorts by; the version stays on the row, in the details and in both reports.
const LANG_FAMILY = [
  ['deluge', 'Deluge', /^deluge/i],
  ['java', 'Java', /^java/i],
  ['nodejs', 'Node.js', /^node/i],
  ['python', 'Python', /^py/i],
];
// Ordered as above rather than alphabetically: Deluge is what almost every org has, and a list that
// buries it under Java reads as though the others were the usual case.
const langFamily = (lang) => (LANG_FAMILY.find(([, , re]) => re.test(String(lang || 'deluge')))
  || [String(lang || 'deluge')])[0];
// A language nobody here has a name for keeps the name Zoho gave it: inventing a family for it
// would be a guess, and «what is this?» is better asked with their word than with ours.
const langFamilyLabel = (fam) => (LANG_FAMILY.find(([k]) => k === fam) || [])[1] || String(fam);
const fnMetaPath = (folder, stem) => `functions/${folder}/${stem}.meta.json`;
const fnProjectRoot = (folder, stem) => `functions/${folder}/${stem}.files`;
const fnDefaultPath = (folder, stem, language) => isDeluge(language)
  ? `functions/${folder}/${stem}.dg` : fnProjectRoot(folder, stem);
function pathsFromMeta(meta, metaPath) {
  const base = metaPath.replace(/\.meta\.json$/, '');
  if (isDeluge(meta && meta.language)) return [base + '.dg', metaPath];
  const root = base + '.files/';
  return (meta && Array.isArray(meta.files) ? meta.files.map((p) => root + p) : []).concat(metaPath);
}
function directoriesFromMeta(meta, metaPath) {
  if (isDeluge(meta && meta.language)) return [];
  const root = metaPath.replace(/\.meta\.json$/, '.files/');
  return meta && Array.isArray(meta.directories) ? meta.directories.map((p) => root + p) : [];
}
function primaryFromMeta(meta, metaPath) {
  if (isDeluge(meta && meta.language)) return metaPath.replace(/\.meta\.json$/, '.dg');
  const files = Array.isArray(meta && meta.files) ? meta.files : [];
  const primary = meta && meta.primary_file || files[0];
  return primary ? metaPath.replace(/\.meta\.json$/, '.files/') + primary : metaPath.replace(/\.meta\.json$/, '.files');
}
// What the second ask could not read, kept until there is a status line to put it on. One value,
// written by both pulls that list functions and consumed where the count is reported - a flag
// written by several and read by none is a shape this repository has already paid for once.
let listGap = null;
// Set *and* cleared by every list: it only ever set, so a hole from one pull outlived the pull that
// filled it - and a sentence that cannot go away is one nobody reads.
let listGapWho = '';
// **Read by whoever is last to speak, and cleared by nobody in between.** It was spent by
// `downloadMissing` - the last word of `pullCurrent` and the *first* of six areas in a Pull all -
// so on the button most people press, five summaries painted over it and the run closed green
// with a whole language of the org missing from the count. The early return for «nothing to
// download» skipped it entirely, which is every pull after the first. `takeListGap()` is what a
// closing line calls; anything that is not a closing line leaves it alone.
function noteListGap(why, which) { listGap = why ? String(why).slice(0, 120) : null; listGapWho = why ? (which || []).join(', ') : ''; }
function listGapNote() { return listGap ? ` Zoho would not list ${listGapWho ? `\u00ab${listGapWho}\u00bb` : 'one of this org\u0027s function languages'} (${listGap}) - if it has any, they are not in this count.` : ''; }
function takeListGap() { const t = listGapNote(); listGap = null; listGapWho = ''; listProbe = null; return t; }
// What the second list ask answered when it did not fail. Kept and shown because the alternative
// is what has just happened: a value chosen by analogy, a pull that surfaced nothing, and no way
// to tell «this org has none» from «that request is wrong» without a capture. It disappears from
// the line the moment the ask returns something, so a normal org says nothing about it.
let listProbe = null;
function noteListProbe(r) {
  // Two different things to say, and the second is about this build rather than about the org.
  const parts = [];
  if (r && r.otherAsked && !r.otherFailed && !r.otherNew) {
    parts.push(`Zoho listed no functions outside Deluge (asked ${r.otherAsked}; it answered with ${r.otherReturned}).`);
  }
  // **A language nobody here has heard of.** The six asked for are what Zoho's UI asks for today, so
  // a seventh is invisible to every count above - and this is the one sentence that can say it,
  // because it comes from Zoho naming the language rather than from us guessing at it.
  if (r && r.unknownLangs && r.unknownLangs.length) {
    parts.push(`Zoho lists function(s) in a language this build does not ask for: ${r.unknownLangs.join(', ')}. `
      + 'They are not in this list - tell the author.');
  }
  listProbe = parts.length ? parts.join(' ') : null;
}
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
const SUMMARY_V = 8;   // 8 carries the publish state; 7 cached the directory tree of function projects
const META_SV = 5;   // v5 adds what Zoho is running: the deploy time and whether a draft is pending
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
// Equality before arithmetic, and it is not a shortcut. `Number()` of anything that is not a number
// is `NaN`, and `NaN !== NaN` is *true* - so two readings that are the same value written the same
// way, which is exactly what a sidecar copied from the list holds, came out «moved» on every load,
// for ever, with no pull able to clear it. Reported as «Refresh 8 outdated» that always came back,
// on the functions of an org whose list gives `updatedTime` in a shape that is not milliseconds.
// It is the same rule the pair below already carries: what cannot be measured is not evidence, and
// a value identical to the one beside it is not evidence of a change either.
const movedInZoho = (listMs, fetchedMs) => !!(listMs && fetchedMs && String(listMs) !== String(fetchedMs)
  && Number(listMs) !== Number(fetchedMs));
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
  if (rel.endsWith('.meta.json')) {
    // Keep the legacy `.dg` key for Deluge summaries, and the sidecar itself for project summaries
    // whose primary file can only be learned from that sidecar.
    _dirtyMeta.add(rel.replace(/\.meta\.json$/, '.dg'));
    _dirtyMeta.add(rel);
  }
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
  else if (rel.endsWith('.dg') || rel.includes('.files/')) {
    _dirtySource.add(rel); _dirtyMeta.add(rel); codeCache = null; graphCache = null; aiConnCache = null;
  }
};
const WS_MOVED = 'The workspace changed while this was running - nothing further was written to it.';
const workspaceFilesystem = createWorkspaceFilesystem({
  root: () => dir,
  generation: () => wsGen,
  onWrite: noteWrite,
  say: setStatus,
  folderMessage: MSG.folder,
  movedMessage: WS_MOVED,
  permissionLost: noteFolderAccessLost,
});
const ensurePerm = workspaceFilesystem.ensurePermission;
const hasPerm = workspaceFilesystem.hasPermission;
const requirePerm = workspaceFilesystem.requirePermission;
const forgetDirs = workspaceFilesystem.forgetDirectories;
const beginWorkspaceOp = workspaceFilesystem.beginOperation;
const ensureDirectoryAt = workspaceFilesystem.ensureDirectoryAt;
const writeFileAt = workspaceFilesystem.writeFileAt;
const readFileAt = workspaceFilesystem.readFileAt;
const removeFileAt = workspaceFilesystem.removeFileAt;
const removeFile = (path) => removeFileAt(dir, path);

/** Write one function in the shape Zoho serves it: one `.dg` for Deluge, every returned file below
 * `<name>.files/` for compiled runtimes. Metadata is written last, so a sidecar always describes
 * files whose writes have already completed. */
async function writeFunctionMirror(f, op, listUpdated) {
  const metaPath = fnMetaPath(f.folder, f.stem);
  let previous = [], previousDirectories = [];
  try {
    const old = JSON.parse(await op.read(metaPath));
    previous = pathsFromMeta(old, metaPath);
    previousDirectories = directoriesFromMeta(old, metaPath);
  } catch (_) {}
  let primary;
  if (isDeluge(f.meta && f.meta.language)) {
    primary = `functions/${f.folder}/${f.stem}.dg`;
    if (!op.current()) throw new Error(WS_MOVED);
    await op.write(primary, f.dg || '');
    f.meta.files = null; f.meta.directories = null; f.meta.primary_file = null;
  } else {
    if (!Array.isArray(f.files) || !f.files.length) throw new Error('Zoho returned no files for this function project.');
    const projectRoot = fnProjectRoot(f.folder, f.stem) + '/';
    const projectDirectories = Array.isArray(f.directories) ? f.directories
      : (Array.isArray(f.meta.directories) ? f.meta.directories : []);
    f.meta.directories = projectDirectories;
    for (const path of projectDirectories.slice().sort((a, b) => a.split('/').length - b.split('/').length)) {
      if (!op.current()) throw new Error(WS_MOVED);
      await op.mkdir(projectRoot + path);
    }
    for (const item of f.files) {
      if (!op.current()) throw new Error(WS_MOVED);
      await op.write(projectRoot + item.path, item.content);
    }
    primary = projectRoot + (f.primary || f.files[0].path);
  }
  f.meta.listUpdated = listUpdated == null ? null : listUpdated;
  if (!op.current()) throw new Error(WS_MOVED);
  await op.write(metaPath, JSON.stringify(f.meta, null, 2));
  const paths = pathsFromMeta(f.meta, metaPath);
  const keep = new Set(paths);
  const stale = previous.filter((p) => !keep.has(p) && !p.endsWith('.meta.json'));
  const cleanup = stale.length ? await removeFunctionPaths(stale, op) : { failed: 0, moved: false };
  if (cleanup.moved) throw new Error(WS_MOVED);
  const directories = directoriesFromMeta(f.meta, metaPath);
  const keepDirectories = new Set(directories);
  const staleDirectories = previousDirectories.filter((p) => !keepDirectories.has(p))
    .sort((a, b) => b.split('/').length - a.split('/').length);
  const directoryCleanup = staleDirectories.length
    ? await removeFunctionPaths(staleDirectories, op) : { failed: 0, moved: false };
  if (directoryCleanup.moved) throw new Error(WS_MOVED);
  // What went into the sidecar, handed back rather than left for the caller to remember. The row is
  // the panel's memory of this copy and the summary index is written *from the row*, so a caller
  // that updates one and not the other leaves the two files disagreeing about the same download -
  // which is what «Refresh 8 outdated» was: the sidecar carried the new reading, the summary still
  // carried the old one, and the fast path compares the summary. No pull could clear it, because
  // every pull repeated it.
  return { primary, metaPath, paths, directories, cleanupFailed: cleanup.failed + directoryCleanup.failed,
           listUpdated: f.meta.listUpdated, updatedTime: f.meta.updatedTime || null };
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
// `recheck` holds the areas the reader has asked Zoost to put back to Zoho *once*, despite a
// refusal on record. It is a preference like the other three, saved in Settings with Save, and it
// is consumed by the pull that acts on it - see `takeRecheck`.
let tabPrefs = { order: TABS.map((t) => t.id), hidden: [], nopull: [], recheck: [] };
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
// «Ask Zoho about this one again, once.» Only meaningful where there is a verdict to overturn, so a
// tick left behind on an area that is no longer refused is not an instruction to keep asking - it is
// spent by the next pull either way, and this makes it harmless in the meantime.
const wantsRecheck = (id) => isForbidden(id) && tabPrefs.recheck.includes(id);
/** Spend the requests this run has acted on, so «once» means once.
 *
 *  Written back into the same preference Settings owns, because that is where the tick is: leaving
 *  it set would turn one deliberate act into an area re-asked on every pull for ever, which is the
 *  cost the author refused when he chose this shape over «Pull all re-asks everything».
 *
 *  Best-effort and silent. Failing to clear it costs one extra request on the next pull; failing the
 *  pull over it would cost the pull.
 */
async function takeRecheck(ids) {
  const spent = ids.filter((id) => tabPrefs.recheck.includes(id));
  if (!spent.length) return;
  const next = Object.assign({}, tabPrefs, { recheck: tabPrefs.recheck.filter((id) => !spent.includes(id)) });
  try {
    ownPrefsWrite = true;   // ours, so the run does not report it as the reader's
    await chrome.storage.local.set({ tabPrefs: { order: next.order, hidden: next.hidden, nopull: next.nopull, recheck: next.recheck } });
    tabPrefs = next;
  } catch (_) { /* one more request next time is the whole cost */ }
}
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
const crmZohoBridge = createCrmZohoBridge({
  chromeApi: chrome,
  zohoMatches: ZOHO_MATCHES,
  zohoHost: ZOHO_HOST_RE,
  bound: () => bound,
  guardOk,
  mismatchMessage: MSG.mismatchRefused,
  noTabMessage: MSG.noTab,
  sleep,
  command: bridgeCommand,
  validateReply: validateBridgeReply,
  context: bridgeContext,
  log: (message) => console.info(message),
});
const tabHasCrmFrame = crmZohoBridge.tabHasCrmFrame;
const zohoTabId = crmZohoBridge.tabId;
const activeZohoTabId = crmZohoBridge.activeTabId;
const answeringFrame = crmZohoBridge.answeringFrame;
const askFrame = crmZohoBridge.askFrame;
const crmFrameId = crmZohoBridge.frameId;
const ensureBridge = crmZohoBridge.ensure;
const toBridge = crmZohoBridge.send;
// The pull path uses one typed adapter for the commands it owns.  Other panel reads remain legacy
// for now, but the census and source download no longer construct raw bridge payloads in several
// unrelated functions.
const crmPullAdapter = createCrmPullAdapter(toBridge);
/** Return the typed pull adapter, with a narrow legacy fallback for isolated diagnostics that load
 * one panel function without the HTML's script prelude.  The shipped panel always takes the first
 * branch; keeping the fallback here makes the function-level probes honest without reintroducing
 * raw command objects into the production path. */
function crmPull() {
  if (typeof crmPullAdapter !== 'undefined' && crmPullAdapter) return crmPullAdapter;
  return {
    listFunctions: () => toBridge({ cmd: 'listFunctions' }),
    functionUiIds: () => toBridge({ cmd: 'functionUiIds' }),
    fetchOne: (request) => toBridge({ cmd: 'fetchOne', ...request }),
  };
}
const getContext = crmZohoBridge.getContext;
const waitTabComplete = crmZohoBridge.waitTabComplete;
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
    lastCtx = bridgeContext(r);
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
  console.info(`[zoost] ctx tab=${activeId} frames=[${crmZohoBridge.seenFrames()}] asked=${cfid === null ? 'any' : cfid}`
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
/** What Zoho is actually running for this function, from the two fields it answers with.
 *
 *  A compiled function is written, saved and then *published*: the source on disk can be something
 *  the org has never run, and nothing on disk distinguishes the two. `deployed_on` is epoch
 *  milliseconds as a string and `"-1"` for never; `is_draft_available` says an unpublished edit
 *  exists. They are different questions, so this answers both rather than collapsing them into one
 *  word - a function can be published *and* carry a draft, which is the state a reader most needs
 *  to see and the one a single label would hide.
 *
 *  Absence is its own answer. Deluge functions do not carry these fields, and neither does a sidecar
 *  written before this existed: `null` means nobody asked, which this panel never prints as «no».
 */
function publishState(meta) {
  const raw = meta && meta.deployed_on;
  const draft = meta && meta.is_draft_available;
  if (raw == null && draft == null) return null;
  const ms = Number(raw);
  const deployed = Number.isFinite(ms) && ms > 0 ? ms : null;
  return { deployed, never: raw != null && !deployed, draft: !!draft };
}
/** The one word for a list, and the sentence for a detail. Two readers, two lengths, one source. */
function publishChip(st) {
  if (!st) return '';
  if (!st.deployed) return 'Draft';
  return st.draft ? 'Draft +' : 'Live';
}
function publishSentence(st) {
  if (!st) return '';
  if (!st.deployed) return 'Never published - Zoho is running nothing for this function yet';
  const when = new Date(st.deployed).toISOString().slice(0, 10);
  return st.draft ? `Published on ${when}, with unpublished changes`
                  : `Published on ${when}`;
}
// One function's runtime record, on request. Never in a pull and never on disk: it is per function,
// so on a real org it would be three hundred requests, and what it answers is «what happened
// lately» - a question whose answer is different a minute later. The panel says both.
// The windows the runtime box offers. The tokens are Zoho's and were measured; the labels are ours.
// Kept beside the box that shows them rather than in the bridge, which is where the tokens live: one
// list of values, one list of words, and neither invents the other.
const RUNTIME_WINDOWS = [['past_24_hours', 'Last 24 hours'], ['today', 'Today'], ['yesterday', 'Yesterday'],
                         ['last_month', 'Last 30 days'], ['custom', 'Dates\u2026']];
let runtimeWindow = 'past_24_hours', runtimeFrom = '', runtimeTo = '';
// How far back Zoho keeps a function's executions. Measured on a real org rather than documented:
// on 28 August the oldest day its own picker would accept was 29 July. It bounds the calendar, and
// nothing else - a range outside it would be refused by Zoho, and the point is not to offer it.
const RUNTIME_KEPT_DAYS = 30;
/** The two ends of a chosen range, in the shape Zoho's own page sends: a local datetime with the
 *  offset written out, the first day from midnight and the last to the second before the next.
 *
 *  One control for both of their ranged windows, because `specific_date` **is** a `custom` of one
 *  day - measured: their page sends the same pair of datetimes for it, with the same day at both
 *  ends. Offering two controls for that would be showing the reader Zoho's implementation. */
function runtimeSpan() {
  if (!runtimeFrom || !runtimeTo) return null;
  const off = -new Date().getTimezoneOffset();
  const p2 = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const zone = (off < 0 ? '-' : '+') + p2(off / 60) + ':' + p2(off % 60);
  const a = runtimeFrom <= runtimeTo ? runtimeFrom : runtimeTo;
  const b = runtimeFrom <= runtimeTo ? runtimeTo : runtimeFrom;
  // `min` and `max` constrain the picker, not text typed into the field. Hold the value to the same
  // window here before it crosses into a request, or a manually entered old date is offered even
  // though Zoho no longer keeps an answer for it.
  const day = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const today = day(new Date()), floor = day(new Date(Date.now() - RUNTIME_KEPT_DAYS * 86400000));
  if (a < floor || b > today) return null;
  return { period: a === b ? 'specific_date' : 'custom',
           from: `${a}T00:00:00${zone}`, to: `${b}T23:59:59${zone}` };
}
async function showFunctionRuntime(row, box) {
  if (!box || !row) return;
  // The same guard every other path to Zoho carries: a workspace bound to one org and a tab showing
  // another is a question this panel refuses rather than answers about the wrong one.
  if (mismatchRefuse()) return;
  if (!zohoReady()) { box.innerHTML = `<div class="rtnote">${escHtml(MSG.wrongTab)}</div>`; return; }
  const mine = previewLoad, op = beginWorkspaceOp(), viewedPath = currentPath;
  box.innerHTML = '<div class="rtnote">Asking Zoho…</div>';
  // «Dates…» is not a window on its own: it is whichever of their two ranged ones the pair of dates
  // turns out to be. Chosen here, so the bridge is handed a period it knows and a range it can check.
  const span = runtimeWindow === 'custom' ? runtimeSpan() : null;
  if (runtimeWindow === 'custom' && !span) {
    box.innerHTML = '<div class="rtnote">Pick both dates within the last 30 days.</div>'; return;
  }
  let r;
  try {
    r = await toBridge({ cmd: 'functionRuntime', id: row.id, language: row.language,
                         period: span ? span.period : runtimeWindow,
                         from: span ? span.from : null, to: span ? span.to : null });
  } catch (e) {
    if (previewCurrent(mine, op) && currentPath === viewedPath) {
      box.innerHTML = `<div class="rtnote">Could not ask Zoho: ${escHtml((e && e.message) || String(e))}</div>`;
    }
    return;
  }
  // The reader may have moved on while Zoho answered, and this box belongs to what is on screen.
  // Compare with the exact file that owned the box when the request began. In a compiled project
  // `row.path` is the entry point, while Details may have been opened from config.json or a nested
  // source: comparing those two discarded a correct answer without drawing anything.
  // Three ways for the answer to be late: another item opened, another workspace, or the box
  // itself replaced - the name toggle redraws #pvcallers while Zoho is answering, and a detached
  // box swallows the answer while the one on screen stays empty, with the window select then
  // refusing to re-ask because the box it reads is blank.
  if (!box.isConnected || !previewCurrent(mine, op) || currentPath !== viewedPath) return;
  if (!r || !r.ok) { box.innerHTML = `<div class="rtnote">Zoho did not answer: ${escHtml((r && r.error) || 'unknown')}</div>`; return; }
  const when = (s) => escHtml(String(s || '').slice(0, 16));
  // Three states per half, and they are not the same: read and empty, read and refused, not read.
  const half = (rows, why, none, draw) => (why ? `<div class="rtnote">${escHtml(why)}</div>`
    : !rows ? `<div class="rtnote">${escHtml(MSG.notReadYet)}</div>`
    : !rows.length ? `<div class="rtnote">${none}</div>` : draw(rows));
  // A range says which days it is of; a named window says its name. «Dates…» over a table would be
  // the control's word rather than an answer.
  const label = span ? `${span.from.slice(0, 10)} to ${span.to.slice(0, 10)}`
    : (RUNTIME_WINDOWS.find(([k]) => k === (r.window || runtimeWindow)) || [, 'this window'])[1];
  const logs = half(r.logs, r.logsWhy, `No execution in ${escHtml(String(label).toLowerCase())}.`, (rows) =>
    '<table class="rt"><thead><tr><th>When</th><th>From</th><th>Result</th><th>ms</th></tr></thead><tbody>'
    + rows.map((x) => `<tr><td>${when(x.at)}</td><td>${escHtml(x.from || '')}</td>`
        + `<td class="${x.status === 'success' ? 'rtok' : 'rtbad'}">${escHtml(x.status || '?')}</td>`
        + `<td>${x.ms == null ? '' : escHtml(String(x.ms))}</td></tr>`).join('')
    + '</tbody></table>');
  // Measured: a compiled function answers 204 here while a Deluge one returns its whole history, so
  // «none» is said in words rather than left as an empty table that reads like a missing feature.
  const revs = half(r.revisions, r.revisionsWhy, 'Zoho keeps no revision history for this function.', (rows) =>
    '<table class="rt"><thead><tr><th>#</th><th>When</th><th>Who</th><th>Zoho note</th></tr></thead><tbody>'
    + rows.map((x) => `<tr><td>${escHtml(String(x.n ?? ''))}</td><td>${when(x.at)}</td>`
        + `<td>${escHtml(x.by || '')}</td><td>${escHtml(x.message || '')}</td></tr>`).join('')
    + '</tbody></table>');
  box.innerHTML = `<div class="rtnote">Read from Zoho just now - not part of the mirror, and not in the reports.</div>`
    // The window is named where the rows are, not only in the control that chose it: a table headed
    // «24h» over a month of executions is the defect this panel removed a sort for.
    + `<b>Executions \u00b7 ${escHtml(label)}</b>${logs}`
    // Revisions carry no window: Zoho answers the whole history, and heading them with the period
    // the reader picked would say this is the part of it that falls inside those days.
    + `<b>Revisions \u00b7 all of them</b>${revs}`;
}

// The refusals a workspace has on record, or nothing. Its own function so the read can be exercised:
// inside `rebuildTree` it is one clause of a hundred-line load that no case can drive, and a clause
// nothing can drive is one that goes wrong quietly - which is how the mark came to be dropped there
// in the first place.
const refusalsIn = (cfg) => (cfg && cfg.srcRefused && typeof cfg.srcRefused === 'object' && !Array.isArray(cfg.srcRefused))
  ? cfg.srcRefused : null;
// Asked of the row rather than captured, because the two renderers see it at different moments: the
// builder draws before the download is attempted, `updateRow` repaints the instant it is refused,
// and a click can come after either. One question, one answer, whenever it is asked.
const isDenied = (e) => !!e && e.mirrored !== false && !e.downloaded && !!e.refused;
// One row builder, shared by the grouped and the sorted-flat rendering, so the two cannot drift.
function fnRowEl(e) {
  const el = document.createElement('div'); el.className = 'f'; el.dataset.path = e.path; el.dataset.id = e.id || '';
  el.setAttribute('aria-selected', e.path === currentPath);
  // A function whose source this mirror does not hold is its own state, ahead of every other: it is
  // not an error, it is not stale, and it is not «not here yet» - nothing is coming for it.
  const unmirrored = e.mirrored === false;
  // Refused ranks with it and above «error»: Zoho answered, and no click changes the answer. The
  // mark is the one Modules already uses for a refused row - one vocabulary for one meaning, rather
  // than a second glyph a reader has to learn twice.
  const denied = isDenied(e);
  const stCls = unmirrored ? 'st-lang' : denied ? 'st-none' : e.error ? 'st-err' : e.stale ? 'st-stale' : e.downloaded ? 'st-ok' : 'st-no';
  const stCh = unmirrored ? '◇' : denied ? '⊘' : e.error ? '⟳' : e.stale ? '◐' : e.downloaded ? '●' : '○';
  const stTitle = unmirrored ? MSG.notMirrored(langLabel(e.language)) : denied ? MSG.srcRefused(e.refusedAt) : e.error ? (MSG.failed + (e.errorMsg || 'unknown') + MSG.clickRetry) : e.stale ? 'Older data (no connections / author) - click to refresh' : e.downloaded ? MSG.hereRepull : MSG.notHere;
  // Every trailing slot is always emitted, empty when it has nothing to say. A slot that disappears
  // lets the next one slide into its place, and then the numbers stop lining up down the list -
  // which is the whole point of having them there.
  const st = e.stats;
  // Its own slot and its own class, not a widening of `.rr`: those four badge classes are shared
  // with rows in Modules and Connections, and reusing one would change two tabs nobody looked at.
  // The family on the row, Zoho's own spelling in the tooltip: «java17» is a fact about the
  // function and belongs somewhere, but `slice(0, 4)` of it put «pyth» in a column.
  const langSlot = `<span class="rest rlg" title="${escA(langLabel(e.language))}">${!isDeluge(e.language) ? escHtml(langFamilyLabel(langFamily(e.language))) : ''}</span>`;
  // Whether Zoho is running this, on the row. Its own slot for the same reason every other one has
  // one: a slot that appears and disappears moves the numbers beside it down the whole list.
  const pub = publishState(e);
  const pubSlot = `<span class="rest rpb${pub && !pub.deployed ? ' rpbd' : ''}"${pub ? ` title="${escA(publishSentence(pub))}"` : ''}>${escHtml(publishChip(pub))}</span>`;
  const restSlot = `<span class="rest rr">${e.rest ? 'REST' : ''}</span>`;
  const nsSlot = treeSort !== 'name'   // flat sorting drops the namespace headers, so the row carries it
    ? `<span class="rest rn" title="${escA(e.namespace || '')}">${escHtml((e.namespace || '').slice(0, 4))}</span>` : '';
  // **The column shows what the list is sorted by.** Sorting by Size and printing lines made a
  // correct order look broken: a sixteen-line function holding one enormous line outweighs a
  // five-hundred-line one, so `16L` sat at the top of a descending list under a header reading «by
  // size in bytes». Reported as a sorting bug, and it was not one - it was a list measured by a
  // quantity it did not show.
  //
  // The size sort is gone rather than given a column: «the sorts should mirror the columns that are
  // there» is a smaller product than one more thing to display, and the KB are still on the row's
  // own tooltip and in both reports. `modified` keeps its column, because a date sort over a line
  // count is the same defect one entry along.
  const sortShown = treeSort === 'modified' ? String(e.updatedTime || '').slice(0, 10)
    : treeSort === 'language' ? langFamilyLabel(langFamily(e.language))
    : st ? st.lines + 'L' : '';
  const wide = treeSort === 'modified' ? ' rfw' : '';
  const lineSlot = `<span class="rest rfl${wide}"${st ? ` title="${st.lines} lines · ${st.codeLines} code lines · ${(st.chars / 1024).toFixed(1)} KB"` : ''}>${escHtml(sortShown)}</span>`;
  const callSlot = `<span class="rest rc"${st && st.apiCalls ? ` title="${st.apiCalls} outbound call(s): ${st.invokeurl} invokeurl · ${st.crm} zoho.crm · ${st.zoho} other Zoho service${st.sendmail ? ' · ' + st.sendmail + ' sendmail' : ''}"` : ''}>${st && st.apiCalls ? st.apiCalls + '↗' : ''}</span>`;
  el.innerHTML = `<span class="st ${stCls}" title="${escA(stTitle)}">${stCh}</span><span class="fname">${escHtml(labelOf(e))}</span>${langSlot}${pubSlot}${restSlot}${nsSlot}${lineSlot}${callSlot}`;
  // Both go through a declaration, because a `.then(cb)` is a scope the race checker cannot enter -
  // and this callback redraws a row after an await, which is the exact shape it exists to look at.
  el.querySelector('.st').onclick = (ev) => { ev.stopPropagation(); if (unmirrored) setStatus(MSG.notMirrored(langLabel(e.language)), 'warn'); else if (isDenied(e)) setStatus(MSG.srcRefused(e.refusedAt), 'warn'); else void fetchThenRedrawRow(e); };
  // A click on one of these used to start a download that answers nothing. It says what it is
  // instead - the same sentence the dot carries, in the place a click is asking the question.
  el.onclick = () => { if (unmirrored) setStatus(MSG.notMirrored(langLabel(e.language)), 'warn'); else if (isDenied(e)) setStatus(MSG.srcRefused(e.refusedAt), 'warn'); else if (e.downloaded) openFromTree(e.path); else void fetchThenRedrawRow(e); };
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
  // **A progress line is borrowed, and it is handed back when the work that wrote it ends without a
  // sentence of its own.** The bridge now reports «files for <function> n/m» while a compiled function
  // downloads, and the panel shows it whenever the pull buttons are held - which a single row click
  // does. Nothing on this path writes a closing line: success redraws the row and a failure is said on
  // the row. So the status bar was left spinning on «Files for calc… 2/2» after the download had
  // finished, or on «1/2» after it had failed. Found by a reader with no memory of the change.
  //
  // The criterion is the class and not the words: once this has returned nothing is busy any more, so
  // a `busy` status still on screen is by definition stale, whoever wrote it. What it said before is
  // put back without `setStatus`, which would record a step in the problem report that nobody took.
  const before = { text: $('stxt').textContent, cls: $('status').className };
  await runPullAction(() => downloadOne(e));
  if ($('status').className === 'busy') { $('stxt').textContent = before.text; $('status').className = before.cls; }
  updateRow(e);
  updateMissingButton();
}

function renderTree() {
  if (viewMode !== 'functions') return;
  const search = searchState.snapshot();
  // A content search owns the list while it is active. Every caller that repaints the tree - a
  // pull's progress, a live save, a chip, the name toggle, a tab switch restoring its stash -
  // would otherwise draw the *name* view under a box still searching code, which is how a regex
  // came back from a tab round-trip as «No matches.» over the names. Reported. Debounced through
  // the same timer as typing, so a paint storm during a pull coalesces into one search.
  if (search.mode === 'content' && search.text.trim()) {
    clearTimeout(_searchT); _searchT = setTimeout(contentSearch, 220);
    return;
  }
  // A function carries three names. Which one is shown is the reader's choice; all three are always
  // searched. The pure model also applies the two filters and connection set, then owns the order.
  const selection = selectFunctionRows(treeData, {
    typeFilter,
    langFilter,
    languageFamily: langFamily,
    languageLabel: langFamilyLabel,
    connectionPaths: connFilterSet,
    term: search.text,
    label: labelOf,
    sortKey: treeSort,
    sortDir: treeSortDir,
  });
  const shown = selection.rows;
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
    // And which of the two narrowings did it: the Type filter can be excluding almost the whole
    // org while the box looks like the only thing in the way. Named, the reader clears the right
    // one; unnamed, «No matches» is a true sentence about a list that was never looked at.
    m.innerHTML = treeData.length
      ? `<b>No matches.</b>${(typeFilter !== 'all' || langFilter !== 'all')
        ? ` The ${narrowingName()} holding the list to ${selection.filterCount} of ${treeData.length} function(s) - set them to <b>All</b> to search them all.` : ''}`
      : (emptyReason('functions') || '<b>Nothing pulled yet.</b> Press <b>Pull all</b> to mirror this org.');
    tree.appendChild(m); return;
  }
  const sorter = selection.sorter;
  if (sorter) {
    const list = shown;
    const hdr = document.createElement('div'); hdr.className = 'srhdr';
    const order = sorter.text ? (treeSortDir === 'asc' ? 'A to Z' : 'Z to A')
      : `${treeSortDir === 'asc' ? 'lowest' : 'highest'} first`;
    hdr.textContent = `${list.length} function(s) by ${sorter.label}, ${order}`
      + (selection.noData ? ` · ${selection.noData} without data (not downloaded yet)` : '');
    tree.appendChild(hdr);
    list.forEach((e) => tree.appendChild(fnRowEl(e)));
    return;
  }
  selection.groups.forEach(({ namespace: ns, rows: list }) => {
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
    const dg = primaryFromMeta(meta, mp);
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
    row.pathChanged = row.metaPath ? row.metaPath !== mp : (isDeluge(meta.language) && row.path !== dg);
    row.previousPath = row.pathChanged ? dg : null;
    row.previousFiles = row.pathChanged ? pathsFromMeta(meta, mp) : null;
    if (!row.pathChanged) row.path = dg;
    row.metaPath = mp;
    row.mirrorFiles = pathsFromMeta(meta, mp);
    row.mirrorDirectories = directoriesFromMeta(meta, mp);
    row.language = meta.language || row.language || 'deluge';
    // Read from the sidecar, which is where the detail put them: the org *list* does not carry
    // them, so a row knows this only once its function has been downloaded - the same as its stats.
    row.deployed_on = meta.deployed_on ?? null;
    row.is_draft_available = meta.is_draft_available ?? null;
    row.mirrored = true;
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
  // Read from the config this load already has open, rather than kept as module state: there is then
  // no copy to forget to clear when the workspace changes, which is the defect class this panel has
  // paid for more than once.
  const denied = refusalsIn(_cfg);

  // ---- 1. the index draws the tree ---------------------------------------------------------------
  // One read. It lists every function, downloaded or not, with the fields a row shows - so the panel
  // is usable before a single meta has been opened.
  let idx = null; try { idx = JSON.parse(await op.read('functions/index.json')); } catch (_) {}
  if (!current()) return;
  index = new Map();
  const byPath = new Map(), byId = new Map(), byMeta = new Map();
  if (idx && idx.length) {
    treeData = idx.map((e) => {
      const id = String(e.id);
      const path = fnDefaultPath(sanitize(e.namespace), sanitize(e.api_name), e.language);
      index.set(id, { path, category: e.category, source: e.source, language: e.language || 'deluge', runtime: e.runtime || null, name: e.name, rest: e.rest });
      const row = { path, metaPath: fnMetaPath(sanitize(e.namespace), sanitize(e.api_name)), api_name: e.api_name, display_name: e.display_name || e.api_name,
                    namespace: e.namespace, rest: e.rest, id, category: e.category, source: e.source,
                    language: e.language || 'deluge', runtime: e.runtime || null, mirrored: true,
                    // What the newer Zoho interface calls this function, when a pull has learnt it.
                    // Absent is an ordinary state - an org on the old interface, or a pull from
                    // before this existed - and the button falls back to the list.
                    uiId: e.uiId || null,
                    downloaded: false, stale: false, error: false, updatedTime: null,
                    // **A refusal has to outlive the run that heard it.** It was set on the row and
                    // nowhere else, so this rebuild - which every pull ends with - dropped it, and
                    // «Complete missing (16)» came back over sixteen functions Zoho had just refused
                    // sixteen times. Recorded in the workspace beside the per-area verdicts, for the
                    // same reason and with the same date: a role is a property of an org, and a
                    // verdict is a record of what was asked rather than a permanent fact.
                    refused: !!(denied && denied[id]), refusedAt: (denied && denied[id] && denied[id].at) || null,
                    // What Zoho's list said, kept apart from what the sidecar says: the two
                    // disagreeing is exactly the fact «stale» exists to carry.
                    listUpdated: e.updatedTime || null };
      byPath.set(path, row); byId.set(id, row); byMeta.set(row.metaPath, row);
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
    const row = byMeta.get(p) || byPath.get(dg);
    if (row) row.downloaded = true;
  }
  if (!current()) return;
  if (!treeData.length) {
    // No index: a legacy workspace, or one whose index could not be read. The tree is what is on
    // disk, and the metas below are the only source for it - so it stays empty until they arrive.
    for (const p of metaPaths) {
      try {
        const meta = JSON.parse(await op.read(p));
        if (!current()) return;
        const path = primaryFromMeta(meta, p);
        const id = String(meta.id == null ? p : meta.id);
        const stem = p.split('/').pop().replace(/\.meta\.json$/, '');
        const row = { path, metaPath: p, mirrorFiles: pathsFromMeta(meta, p),
                      mirrorDirectories: directoriesFromMeta(meta, p),
                      api_name: meta.api_name || meta.name || stem,
                      display_name: meta.display_name || meta.api_name || meta.name || stem,
                      namespace: meta.nameSpace || p.split('/')[1], language: meta.language || 'deluge',
                      runtime: meta.runtime || null, rest: (meta.rest_api || []).some((r) => r.active),
                      id, category: meta.category || '', source: meta.source || '', mirrored: true,
                      downloaded: true, stale: (meta.sv || 0) < META_SV, error: false,
                      updatedTime: meta.updatedTime || null, fetchedAgainst: meta.listUpdated || null };
        byPath.set(path, row); byId.set(id, row); byMeta.set(p, row); treeData.push(row);
      } catch (_) {
        // `refineRowFromMeta` below records the unreadable sidecar once and keeps it out of the tree.
      }
    }
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
  const knownByMeta = new Map(Object.entries(known).map(([path, value]) => [value.metaPath || path.replace(/\.dg$/, '.meta.json'), { path, value }]));
  const missing = [];
  for (const mp of metaPaths) {
    const dg = mp.replace(/\.meta\.json$/, '.dg');
    const hit = knownByMeta.get(mp);
    const s = hit && hit.value;
    const row = byMeta.get(mp) || byPath.get(dg);
    const cachedPath = hit && hit.path;
    const cachedFiles = (s && s.mirrorFiles) || (cachedPath ? [cachedPath, mp] : []);
    if (!s || !row || dirtyMeta.has(dg) || dirtyMeta.has(mp) || dirtyMeta.has(cachedPath) || cachedFiles.some((p) => dirtyMeta.has(p))) { missing.push(mp); continue; }
    if (row.path !== cachedPath) byPath.delete(row.path);
    row.path = cachedPath; byPath.set(cachedPath, row);
    row.metaPath = mp; row.mirrorFiles = cachedFiles;
    row.mirrorDirectories = (s && s.mirrorDirectories) || [];
    if (s.language) row.language = s.language;
    row.downloaded = true;
    // The same rule as the slow path below. It was only there, so whether a workspace reported
    // anything outdated depended on which of the two paths had loaded it.
    row.stale = (s.sv || 0) < META_SV || movedInZoho(row.listUpdated, s.listUpdated);
    row.fetchedAgainst = s.listUpdated || null;
    row.updatedTime = s.updatedTime || null;
    // Same fields, same rule as `stale` two lines up: only in the slow path, whether a function
    // showed its publish state depended on which of the two paths had loaded the workspace.
    row.deployed_on = s.deployed_on ?? null;
    row.is_draft_available = s.is_draft_available ?? null;
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
  // The Language control is derived from what the workspace holds, and the filter bar is built on a
  // mode switch - which happens *before* this. Without this line the control appeared only after the
  // reader touched a tab, which is the shape of every dead control this panel has had: present in
  // the code, absent on screen, and nothing saying so. It is cheap and the values it holds survive a
  // rebuild by design, which is what the filter above was rewritten for.
  if (viewMode === 'functions') buildTypeChips();
  if (stale_summary) await saveMetaIndex(metaPaths, op);
  if (!current()) return;
  // Put down here, not when Refresh was pressed: the pass that re-read everything has now written
  // the summary back, so the next load may believe it again.
  distrustSummary = false;
  const dl = treeData.filter((e) => e.downloaded).length;
  // Listed and not mirrored is its own number, because it belongs to neither of the other two: it
  // is not «downloaded» and it is not waiting to be.
  const unmirrored = treeData.filter((e) => e.mirrored === false).length;
  // **Read, and not spent.** These used to be nulled here, and the line that carries them is written
  // by `rebuildTree` - which a pull calls *before* downloading, so the sentence lived for one tick,
  // in green, under 122 «Downloading n/121…» lines, and pressing Refresh could not bring it back
  // because the values were gone. The pull's own closing line reads them too, and only a load that
  // nobody followed with a download clears them.
  // Read, never spent: the closing line of the pull is what clears these.
  const gap = listGapNote();
  const probe = listProbe;
  // **What could not be read is part of the answer.** Every sidecar that failed to open used to be
  // swallowed one by one, so a mirror the browser could not read at all closed on «120 functions
  // (120 downloaded).» in green - the rows drawn from file names alone, every one marked as present.
  // A count is a measurement of what was read; saying it without saying what was not is the mirror
  // lying by omission. The twin names the file and what the browser called it, and has since it
  // existed.
  setStatus(`${treeData.length} functions (${dl} downloaded`
    + (unmirrored ? `, ${unmirrored} listed without source` : '') + ').'
    + gap
    + (probe ? ` ${probe}` : '')
    + (unreadableMetas.length
      ? ` ${unreadableMetas.length} file(s) could not be read - what they hold is not in this list.`
      : '')
    + (statsDeferred() ? ' Size and call counts appear when the diagram, the audit or a code search builds the map.' : ''),
  (unreadableMetas.length || gap || probe) ? 'warn' : 'ok');
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
  const metaOnDisk = new Set(metaPaths);
  const onDisk = new Set(treeData.filter((r) => metaOnDisk.has(r.metaPath || r.path.replace(/\.dg$/, '.meta.json'))).map((r) => r.path));
  const written = updateMetaIndex((files) => {
    Object.keys(files).forEach((k) => { if (!onDisk.has(k)) delete files[k]; });   // gone from the folder
    treeData.forEach((r) => {
      if (!onDisk.has(r.path)) return;
      const e = files[r.path] || (files[r.path] = {});
      e.id = String(r.id); e.sv = r.stale ? 1 : META_SV; e.updatedTime = r.updatedTime || null;
      e.listUpdated = r.fetchedAgainst || null;   // what the list said when this copy was fetched
      e.namespace = r.namespace || ''; e.display_name = r.display_name || '';
      e.metaPath = r.metaPath || r.path.replace(/\.dg$/, '.meta.json');
      e.mirrorFiles = r.mirrorFiles || [r.path, e.metaPath];
      e.mirrorDirectories = r.mirrorDirectories || [];
      e.language = r.language || 'deluge';
      // The publish state travels with the summary or it exists only until the panel is closed:
      // the fast path serves every reopen from this file, and a field stored nowhere but the
      // sidecar is a field the reopen never sees. Found by a review driving the shipped panel -
      // every chip empty on reopen, back after a Refresh, gone again on the next open.
      e.deployed_on = r.deployed_on ?? null;
      e.is_draft_available = r.is_draft_available ?? null;
    });
  }, op);
  // Only the metas this pass actually described, and only the meta half: the source-derived facts
  // belong to `saveGraphFacts()` and are not this writer's to declare done. And only if the write
  // happened: a mark cleared over a refused write is a file nothing will ever read again.
  if (!(await written) || !op.current()) return;
  treeData.forEach((r) => {
    if (!metaOnDisk.has(r.metaPath)) return;
    _dirtyMeta.delete(r.metaPath);
    _dirtyMeta.delete(r.path);
    (r.mirrorFiles || []).forEach((p) => _dirtyMeta.delete(p));
  });
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

/** Put each function's id in the newer interface on its index row, keeping what is already known.
 *
 *  Two sources, and the fresh one does not outrank the old one by being fresh: a map that answered
 *  for 100 of 300 functions is not a statement that the other 200 have no record. So a row takes the
 *  new value when there is one and keeps the previous one otherwise, and a function Zoho no longer
 *  lists is not carried at all - it is not in `entries` to begin with.
 */
async function carryUiIds(entries, map, op) {
  let previous = {};
  try {
    const old = JSON.parse(await op.read('functions/index.json'));
    if (Array.isArray(old)) old.forEach((e) => { if (e && e.uiId) previous[String(e.id)] = String(e.uiId); });
  } catch (_) { }   // no index yet, or one that will not parse: there is nothing to carry, which is not a failure
  entries.forEach((e) => {
    const fresh = map[String(e.id)];
    const kept = fresh || previous[String(e.id)];
    if (kept) e.uiId = String(kept);
  });
  return entries;
}
// ---------- reveal (auto-navigate to Functions page, then filter) ----------
const crmNavigationContext = () => ({
  base: bound?.base || lastCtx?.origin,
  instance: bound?.instance || lastCtx?.instance,
});
function functionsUrl() { return crmFunctionsUrl(crmNavigationContext()); }
function functionUrl(uiId) { return crmFunctionUrl(crmNavigationContext(), uiId); }
// Offered data centres come from the manifest; the selected one remains a user choice because a
// consultant may move between accounts hosted in different data centres.
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
  return crmHomeUrl(dc);
}
// The adapter checks the complete host against manifest permissions and navigates the CRM frame
// inside suite shells, preserving the shell instead of replacing the whole tab.
const crmZohoNavigator = createCrmZohoNavigator({
  chromeApi: chrome,
  hostPatterns: ZOHO_MATCHES,
  findTab: zohoTabId,
  findFrame: crmFrameId,
  refused: (url) => setStatus('This workspace points at '
    + (((url || '').match(/^https?:\/\/[^/]+/) || [])[0] || 'somewhere')
    + ', which is not a Zoho address. Nothing was opened - check where this workspace folder came from.', 'bad'),
});
const goToZoho = crmZohoNavigator.open;
async function openZohoHome() {
  if (sampleRefuse()) return;
  await goToZoho(homeUrl());
}
function actionUrl(a) { return crmActionUrl(crmNavigationContext(), a); }
function templateUrl(a) { return crmTemplateUrl(crmNavigationContext(), a); }
async function openZohoAt(url, what) {
  if (sampleRefuse()) return;
  if (!url) { setStatus(MSG.noActionTarget, 'warn'); return; }
  // **The refusal is the return value, and six callers threw it away.** `goToZoho` answers `null`
  // on one path only - the origin guard - and that guard has already written «This workspace points
  // at <somewhere>, which is not a Zoho address. Nothing was opened», in red, for a workspace folder
  // that came from somebody else. Announcing success on top of it left that sentence on screen for
  // microseconds and told the reader the page is open. It is not.
  if (!await goToZoho(url)) return;
  setStatus(`Opened \u00ab${what}\u00bb in Zoho.`, 'ok');
}
async function openActionInZoho(a) { await openZohoAt(actionUrl(a), a.name || a.id); }
async function openModulePage(genName, navigable, label) {
  if (sampleRefuse()) return;
  if (navigable === false) { setStatus(`\u00ab${label || genName}\u00bb has no records tab (linking/subform or no access).`, 'warn'); return; }
  const url = crmModuleUrl(crmNavigationContext(), genName);
  if (!url) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  if (!await goToZoho(url)) return;
  setStatus(`Opened \u00ab${genName}\u00bb in Zoho.`, 'ok');
}
async function openModuleLayouts(gen) {
  if (sampleRefuse()) return;
  const url = crmLayoutUrl(crmNavigationContext(), gen);
  if (!url) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  if (!await goToZoho(url)) return;
  setStatus(`Opened ${gen} layouts in Zoho.`, 'ok');
}
async function openModuleLayout(gen, layoutId) {
  if (sampleRefuse()) return;
  const url = crmLayoutUrl(crmNavigationContext(), gen, layoutId);
  if (!url) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  if (!await goToZoho(url)) return;
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
async function openTargetZoho() {
  if (sampleRefuse()) return null;   // null, not undefined: the caller reads it as "no tab id"
  const url = functionsUrl();                       // prefers the ACTIVE workspace's base+instance
  if (!url) { setStatus(MSG.noTarget, 'warn'); return null; }
  return goToZoho(url);
}
$('funcs').onclick = () => openTargetZoho();
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
 * **The deep link exists now, and it exists because the mapping is pulled rather than guessed.**
 * The newer interface addresses a function by the id of its record in the `Functions__s` module,
 * and the id this product holds is that record's `dependent_id` - measured across a whole org, 100
 * of 100 on the first page. The pull asks Zoho's own list for the pair and puts it on the index row;
 * where it is missing - an org on the old interface, a role without the module, a workspace mirrored
 * before this existed - the list is still what opens, which is what this function did for everyone
 * until today. Nothing is constructed from an id that has not been joined.
 */
async function reveal(fn) {
  if (sampleRefuse()) return;
  // The one function when the mapping is known, the list when it is not. Both are constructed
  // addresses and neither touches their page.
  const one = functionUrl(fn.uiId);
  const url = one || functionsUrl();
  if (!url) { setStatus(MSG.noTarget, 'warn'); return; }
  // **One navigation, not two.** `openTargetZoho` *is* `goToZoho(functionsUrl())`, so the second
  // call was redundant on the branch where a tab existed and worse on the branch where none did:
  // `chrome.tabs.create` resolves before the navigation commits, so the fresh tab's `url` is still
  // empty, `zohoTabId()` fails all three of its tests, and `goToZoho` opens a *second* tab. One
  // click on «Functions in Zoho» with no CRM tab open left two identical tabs.
  setStatus(MSG.openingFns, 'busy');
  // `goToZoho` already creates a tab when none exists. Going through `openTargetZoho` on that branch
  // rebuilt the old list URL and silently discarded `one`, then announced that the function itself
  // was open. One destination, handed to the one navigator on both branches.
  const at = await goToZoho(url);
  if (!at) return;
  setStatus(one ? `\u00ab${fn.displayName || fn.name || fn.apiName}\u00bb is open in Zoho.`
                : `Zoho\u0027s functions are open - look for \u00ab${fn.displayName || fn.name || fn.apiName}\u00bb.`, 'ok');
}



async function revealFromPreview(action) {
  if (currentPath && currentPath.startsWith('workflows/')) { await openWorkflowInZoho(currentPath.split('/').pop().replace(/\.json$/, '')); return; }
  if (currentPath && currentPath.startsWith('actions/')) { const a = actionData.find((x) => x.path === currentPath); if (a) await openActionInZoho(a); return; }
  if (currentPath && currentPath.startsWith('modules/')) {
    const m = moduleData.find((x) => x.path === currentPath); if (!m) return; if (action === 'filter') await openModuleLayouts(m.gen); else await openModulePage(m.gen, m.navigable, m.label); return;
  }
  const e = functionRowForPath(currentPath); if (!e) return;
  const info = index.get(e.id);
  try { await reveal({ id: e.id, uiId: e.uiId, name: info?.name || e.api_name, displayName: e.display_name, apiName: e.api_name }); }
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
// Which of the two is narrowing, named. «The type filter» over a list held down by the language one
// sends the reader to clear a control that is already at All, and «No matches» stays on screen.
function narrowingName() {
  const on = [typeFilter !== 'all' && 'type', langFilter !== 'all' && 'language'].filter(Boolean);
  return on.length === 2 ? 'type and language filters are' : `${on[0]} filter is`;
}
let _buildTypeChips = null;
function buildTypeChips() {
  if (!_buildTypeChips) _buildTypeChips = createCrmTypeChips({
    $,
    getViewMode: () => viewMode, NS, LANG_FAMILY, langFamily, langFamilyLabel,
    // automation.js is loaded after this panel. Keep the dependency lazy so the initial
    // Functions render does not touch its lexical binding before that script exists.
    actionKindLabel: (value) => actionKindLabel(value),
    getActionData: () => actionData, getCurFilter: curFilter, setCurFilter,
    getLangFilter: () => langFilter, setLangFilter: (value) => { langFilter = value; },
    getActionSort: () => actionSort, setActionSort: (value) => { actionSort = value; },
    getActionSortDir: () => actionSortDir, setActionSortDir: (value) => { actionSortDir = value; },
    getTreeSort: () => treeSort, setTreeSort: (value) => { treeSort = value; },
    getTreeSortDir: () => treeSortDir, setTreeSortDir: (value) => { treeSortDir = value; },
    TREE_SORTS, lastModified: MSG.lastModified, getTreeData: () => treeData,
    runSearch: (...args) => runSearch(...args),
    // These renderers live in scripts loaded after the panel. Pass lazy adapters so the initial
    // filter bar can be built before those classic-script bindings exist.
    renderModules: (...args) => renderModules(...args),
    renderWorkflows: (...args) => renderWorkflows(...args),
    renderSchedules: (...args) => renderSchedules(...args),
    renderActions: (...args) => renderActions(...args),
    renderConnections: (...args) => renderConnections(...args),
    renderTree: (...args) => renderTree(...args),
  });
  return _buildTypeChips();
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
  navHistory.keepCurrent();
  updateNav(); renderNav();
};
$('navx').onclick = () => navShow(false);
$('pvback').onclick = () => navTo(navHistory.snapshot().position - 1);
$('pvfwd').onclick = () => navTo(navHistory.snapshot().position + 1);
// Alt+arrows, because that is what a browser answers to and the hands already know it. Left alone
// inside a field, where the arrows belong to the text.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navOpenNow()) { navShow(false); return; }
  if (!e.altKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
  const at = navHistory.snapshot().position;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navTo(at - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navTo(at + 1); }
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

function paintSearchControls(state = searchState.snapshot()) {
  const fullText = viewMode === 'functions' && state.mode === 'content';
  $('find').value = state.text;
  $('smode').textContent = fullText ? 'in: code' : 'in: names';
  $('smode').classList.toggle('on', fullText);
  $('find').placeholder = fullText ? MSG.findInCode : MSG.findByName;
  $('rxmode').classList.toggle('on', state.regex);
  $('rxmode').style.display = $('rxpick').style.display = fullText ? '' : 'none';
  if (!fullText) $('rxmenu').classList.remove('show');
}

$('find').oninput = () => { searchState.setText($('find').value); runSearch(); };
$('findx').onclick = () => { paintSearchControls(searchState.setText('')); runSearch(); $('find').focus(); };
$('smode').onclick = () => {
  if (viewMode !== 'functions') return;   // full-text search applies to function code only
  // Leaving full-text with the pattern on takes the pattern with it, like the toggle going off:
  // a regex read as a name filter is a search for text that does not exist. Reported.
  paintSearchControls(searchState.toggleMode());
  runSearch();
};
$('rxmode').onclick = () => {
  // Switching the toggle off clears the box: a pattern read as a literal is a search for text
  // that does not exist, and the reader would be left staring at «no matches» for \b\d{18}\b.
  // Switching it on keeps what was typed - a literal is often the seed of the pattern.
  paintSearchControls(searchState.toggleRegex());
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
  const search = searchState.snapshot();
  const rawQ = search.text.trim();
  // The save row exists only when there is something it could do: a pattern in the box that parses,
  // regex mode on, and a list that was actually read - saving over one that was not would overwrite
  // entries nobody has seen. A control that can do nothing goes away rather than sitting there.
  const savable = list !== null && search.regex && rawQ && !!rxCompile(rawQ).re;
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
      paintSearchControls(searchState.usePattern(x.pattern));
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
  const search = searchState.snapshot();
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
  if (search.mode === 'content') { clearTimeout(_searchT); _searchT = setTimeout(contentSearch, 220); }
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
  const search = searchState.snapshot();
  if (search.mode !== 'content') return null;
  const q = search.text.trim();
  if (!q) return null;
  if (!search.regex) return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
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
  try {
    const paths = (e.mirrorFiles || [e.path]).filter((p) => !p.endsWith('.meta.json'));
    const sources = [];
    for (const p of paths) sources.push({ path: p, code: await op.read(p) });
    m.set(e.id, sources);
  } catch (_) {}
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
  const search = searchState.snapshot();
  const term = search.text.trim(); const tree = $('tree');
  if (!term) { renderTree(); return; }
  const rx = search.regex ? rxCompile(term) : null;
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
  // What the sentence below has to be able to say. «No matches» is the whole answer on this
  // surface, and it was given without mentioning that the Type filter had excluded 108 of 120
  // functions - a true sentence about a search that never looked. The Analytics twin names its
  // narrowing in the same situation; this is the same fact in the same voice.
  let searched = 0;
  for (const e of treeData) {
    if (!e.downloaded || !passRow(e)) continue;
    searched++;
    const cached = cache.get(e.id); if (!cached) continue;
    const sources = Array.isArray(cached) ? cached : [{ path: e.path, code: cached }];
    for (const source of sources) {
      const code = source.code; let idx = -1, count = 0;
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
      results.push({ e, path: source.path, count, lineNo, line: code.slice(ls, le).trim().slice(0, 140) });
    }
  }
  results.sort((a, b) => b.count - a.count || labelOf(a.e).localeCompare(labelOf(b.e)));
  tree.innerHTML = '';
  if (!results.length) {
    const narrowing = (typeFilter === 'all' && langFilter === 'all')
      ? 'The search box was' : `The ${narrowingName()} and the search box were`;
    tree.innerHTML = `<div class="treemsg"><b>No matches for "${escHtml(term)}".</b> `
      + `${narrowing} applied to ${searched} of ${treeData.length} function(s) - the rest were not searched. `
      + `${(typeFilter === 'all' && langFilter === 'all') ? 'Only downloaded source is searched.'
           : 'Set them to All to search them.'}</div>`;
    return;
  }
  const total = results.reduce((n, r) => n + r.count, 0);
  const hdr = document.createElement('div'); hdr.className = 'srhdr'; hdr.textContent = `${total} match(es) in ${results.length} file(s)`; tree.appendChild(hdr);
  const hlRe = rx ? rx.re : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
  results.forEach((r) => {
    const el = document.createElement('div'); el.className = 'sr'; el.dataset.path = r.path;
    const hi = markLine(r.line, hlRe, escHtml);
    const fileName = r.path === r.e.path ? '' : ` · ${r.path.split('/').pop()}`;
    el.innerHTML = `<div class="srname">${escHtml(labelOf(r.e) + fileName)} <span class="srcount">${r.count}</span></div><div class="srline"><span class="srln">${r.lineNo}</span> ${hi}</div>`;
    el.onclick = () => openFile(r.path, r.lineNo, true);   // the exact project file and line that matched
    tree.appendChild(el);
  });
}

// ---------- pull / graph ----------
// **What a pull writes when a language would not answer.** Refusing the whole write was the first
// shape of this, and on an org whose role always refuses one of them it made the product do nothing
// at all - no tree, no graph, no export, no assistant - with a message telling the reader to try
// again, for ever. What answered is complete; what did not answer is not «deleted», it is unread. So
// its rows from the previous index are carried forward, which keeps them in the tree and keeps the
// prune from taking their files. A language nobody has an old row for contributes nothing.
async function mergeUnanswered(entries, unanswered, op) {
  if (!(unanswered || []).length) return entries;
  let prev = [];
  try { const t = JSON.parse(await op.read('functions/index.json')); if (Array.isArray(t)) prev = t; } catch (_) {}
  const have = new Set(entries.map((e) => String(e.id)));
  // **Every non-Deluge row, not the ones whose language matches the ask that failed.** The ask carries
  // the query value and a row carries the response value, and the bridge's own comment says they
  // differ - `nodejs` is what is asked for and `nodejs_22` is what comes back. Comparing them for
  // equality meant that when the failing ask was spelled differently from the rows it would have
  // returned, nothing was carried and those functions were written out of the index: the deletion this
  // function exists to prevent, surviving in the one case the code documents as real.
  //
  // So the question is not «which language failed» but «can I still tell that this row is gone», and
  // with any ask refused the answer for every non-Deluge row is no. Deluge is walked on its own and
  // its failure is a failed pull, so a Deluge row missing from the list really is missing. The cost is
  // that a non-Deluge function Zoho has genuinely deleted lingers until a pull where every language
  // answers - which is the right side to err on, and the side the rest of this file already takes.
  const kept = prev.filter((e) => e && !isDeluge(e.language) && !have.has(String(e.id)));
  return kept.length ? entries.concat(kept) : entries;
}
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
    const r = await crmPull().listFunctions(); if (!r?.ok) throw bridgeError(r, 'list failed');
    // **A list that came back short says so.** The org list is asked once per language, and the
    // second ask is deliberately allowed to fail without taking the pull down with it - which is
    // only defensible if the failure is stated. Otherwise a role that does not grant Node
    // functions produces exactly the silent, complete-looking mirror this change is undoing.
    if (op.current()) noteListGap(r.otherFailed, r.unanswered);   // the answer describes the workspace we asked from
    noteListProbe(r);
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
      // Zoho answered, so the verdict moves: the record is what says «this area was asked», and a
      // bail before it left an «ask again» unspent and a refusal on record for ever. Nothing is
      // written to the mirror here; what Zoho said about access is.
      await noteAccess('functions', null, op, false);   // asked and answered; nothing was stored
      endPull(); return;
    }
    // Read the previous manifest once, before any write replaces it.  It is the baseline for the
    // plan and must not be reconstructed from treeData, which may belong to another workspace.
    let prev = [];
    try { const previousIndex = JSON.parse(await op.read('functions/index.json')); if (Array.isArray(previousIndex)) prev = previousIndex; } catch (_) {}
    const merged = await mergeUnanswered(r.entries, r.unanswered, op);
    if (!op.current()) return;
    // Which record the newer Zoho interface calls each of these functions. Optional by
    // construction: an org without that interface answers `INVALID_MODULE`, a role without the
    // module is refused, and either way the pull carries on and the panel keeps opening the
    // functions list the way it always has. Never a reason to fail a pull, and never a reason to
    // *lose* what an earlier pull learnt - a map that came back short would otherwise take away
    // every «open this function» the previous one had earned, which is the partial-data rule this
    // repository keeps re-learning in new clothes.
    let ui = null;
    try { ui = await crmPull().functionUiIds(); }
    catch (_) { /* optional: a transport failure must not turn a successful function census red */ }
    if (!op.current()) return;
    await carryUiIds(merged, (ui && ui.map) || {}, op);
    if (!op.current()) return;
    // Build the deletion authority from the old and new file manifests before replacing the
    // index.  The list is a census only when every language answered; a partial answer may keep
    // old rows, but it may not authorise removal of anything.  Existing compiled projects are
    // carried by id so their individual files remain protected until a fresh project replaces
    // them.
    const previousById = new Map(prev.map((e) => [String(e.id), e]));
    const mirrorPaths = (e) => {
      const known = Array.isArray(e && e.mirrorFiles) ? e.mirrorFiles : [];
      if (known.length) return known;
      const folder = sanitize(e && (e.namespace || e.category || 'misc'));
      const stem = sanitize(e && (e.api_name || e.name || e.id));
      const primary = fnDefaultPath(folder, stem, e && e.language);
      return [primary, fnMetaPath(folder, stem)];
    };
    const previousFiles = Object.fromEntries(prev.flatMap((e) => mirrorPaths(e)).map((p) => [p, { path: p }]));
    const nextFiles = Object.fromEntries(merged.flatMap((e) => {
      const old = previousById.get(String(e.id));
      return mirrorPaths(old && old.mirrorFiles ? old : e);
    }).map((p) => [p, { path: p }]));
    // This runner owns the real transition through planning and writing: the census and enrichment
    // above are reading, while the manifest comparison and mirror writes below are their actual
    // phases. Refreshing remains at the composite Pull all boundary so later areas are not labelled
    // as a refresh while they are still being read.
    pullController.phase('planning');
    const mirrorPlan = buildMirrorPlan(previousFiles, nextFiles,
      { complete: !r.capped && !(r.unanswered || []).length });
    if (validateMirrorPlan(mirrorPlan) !== true) throw new Error('mirror plan validation did not succeed');
    pullController.phase('writing');
    await op.write('functions/index.json', JSON.stringify(merged, null, 2));
    // reflect deletions: remove local files for functions no longer in Zoho
    const liveIds = new Set(merged.map((e) => String(e.id))); const rmF = [];
    for await (const p of walk(op.root)) {
      if (!p.startsWith('functions/')) continue;   // only a function has a .meta.json to prune by
      if (p.endsWith('.meta.json')) { try { const mm = JSON.parse(await op.read(p)); if (!liveIds.has(String(mm.id))) rmF.push(...pathsFromMeta(mm, p)); } catch (_) {} }
    }
    // Each removal, not the loop: `removeFile` resolves its path against the folder that is current
    // *now*, so a switch part-way through deletes the rest out of a workspace this pull never walked.
    // A missing or partial plan cannot silently turn the folder walk into a destructive action.
    const plannedRemovals = rmF.filter((p) => mirrorPlan.deletes.includes(p));
    const removed = await removeFunctionPaths(plannedRemovals, op);
    if (removed.moved) return;
    const prunedF = removed.removed.filter((p) => p.endsWith('.meta.json')).length;
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
    await downloadMissing(true);   // fetch each function's code, resiliently (partials stay; failures can be retried); a pull re-asks what was refused
    if (prunedF) setStatus($('stxt').textContent + ` \u00b7 ${prunedF} deleted removed`, 'ok');
    if (removed.failed) setStatus($('stxt').textContent + ` \u00b7 ${removed.failed} stale file(s) could not be removed - \u21bb Refresh retries`, 'warn');
    // **The truncation is said where it is discovered, and this line is gone.** It sat here because
    // the ceiling had been introduced without anybody reading `capped` at all - the right complaint,
    // fixed in the wrong place: the branch that handles a truncated list returns three hundred lines
    // above, so nothing could ever reach this. Two warnings about one fact, one of them unreachable,
    // is worse than one - it reads as cover that is not there. The live one refuses to prune and says
    // so after the tree is drawn, which is where a reader is looking.
    await noteAccess('functions', removed.failed ? { status: 0, message: `${removed.failed} stale function file(s) could not be removed` } : null, op, true);   // the mirror was written; the gap is what could not be tidied after it
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
    // `nodes` here counts everything the drawing holds - functions, actions, workflows, schedules,
    // connections, modules - and `mirrorNote` reads it as «functions in this mirror», which is how
    // the window came to print «over 168 of 123»: more functions in the mirror than the org has,
    // contradicting the counts on its own line. The function count is kept under its own name.
    counts: Object.assign({}, g.counts, { fnNodes: g.counts ? g.counts.nodes : undefined,
      nodes: Object.keys(nodes).length, edges: edges.size, dead_suspects: dead }),
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

// ---------- view mode (Functions / Modules) ----------
// What you typed in Find belongs to the list you typed it in. It used to belong to the panel, so
// switching from a search in Functions to Modules showed the modules matching a function's name -
// usually none - and the reader had to notice the box was still full to understand why. Reported as
// disorienting, and it is: the box says «I am filtering» about a list that never asked.
function setMode(mode) {
  viewMode = mode;
  // Text, interpretation and pattern mode are restored as one value. The pure state object also
  // guarantees that a non-function tab cannot inherit the code interpretation.
  paintSearchControls(searchState.enter(mode));
  if (mode !== 'functions') { connectionFilter = null; connFilterSet = null; }   // the connection filter is functions-only
  $('smode').style.display = mode === 'functions' ? '' : 'none';
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
function consumePullPreferenceChange() {
  const changed = prefsSavedDuringPull;
  prefsSavedDuringPull = false;
  return changed;
}
// While a pull runs, BOTH pull buttons (global "Pull all" and the per-type "Pull \u2026") stay disabled,
// so switching tabs and clicking a second pull cannot start an overlapping one. They come back only
// when the current pull has finished - success or error.
// Depth, not a switch. `pullEverything` sets it and then calls `pullAll`, which calls
// `downloadMissing`, which set and cleared the same flag - so from the moment the functions were
// fetched the remaining six areas pulled with the flag false, the five-second poll re-enabled both
// Pull buttons, and a second `pullEverything` could start on top of the first. The comment above
// promises the opposite. A count means a nested pull can raise and lower it without knowing who else
// is holding it, which is the only version of this that stays true as callers are added.
const pullController = createCrmBootstrap({
  busy: () => pullBusy,
  publishBusy: (busy) => { pullBusy = busy; },
  blockZoho,
  zohoReady,
  hasDirectory: () => !!dir,
  navigationOpen: navOpenNow,
  updateWorkspaceButtons: updateWsButtons,
  restoreWorkspaceSelection: () => { $('ws').value = activeWsId || ''; },
  setStatus,
  currentView: () => viewMode || 'functions',
  tabLabel,
  runners: () => ({ functions: pullAll, modules: pullModules, workflows: pullWorkflows,
    schedules: pullSchedules, actions: pullActions, connections: pullConnections, failures: pullFailures }),
  statusKind: () => $('status').className,
  rebuildActive,
  beginOperation: beginWorkspaceOp,
  plan: () => buildPullPlan(TABS, {
    recheck: wantsRecheck, forbidden: isForbidden, enabled: isPulled,
    verdictAt: (id) => (tabAccess[id] || {}).at,
  }),
  answeredRechecks: (planned) => answeredPullRechecks(planned, (id) => (tabAccess[id] || {}).at),
  takeRechecks: takeRecheck,
  renderTabs,
  forbiddenNote,
  consumePreferencesChanged: consumePullPreferenceChange,
  preferencesChangedNote: MSG.prefsLater,
  takeListGap,
  statusSnapshot: () => ({ text: $('stxt').textContent || '', kind: $('status').className }),
  errorText: (error) => String((error && error.message) || error),
});
function setPullBusy(b) { pullController.setPullBusy(b); }
function workspaceChangeRefuse() { return pullController.workspaceChangeRefuse(); }
/** Every user entry that re-reads Zoho holds the pull flag for its whole span - which is what
 *  blocks the workspace selector and refuses a second pull on top. The promise «the workspace
 *  cannot change while a pull writes it» was true of the two main buttons only: the per-row
 *  refreshes, the single-item downloads and the module resync all ran with `pullBusy` false, so
 *  the selector stayed live under exactly the writes it exists to protect. Reproduced by an
 *  outside scan on refreshSchedules(). The depth counter absorbs nesting; `finally` is what makes
 *  an exception unable to leave the panel locked. */
async function runPullAction(work) {
  return pullController.runPullAction(work);
}
async function pullCurrent() {
  return pullController.pullCurrent();
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
  return pullController.pullEverything();
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
  // **Whether Zoho was asked at all, this time.** The three bails below happen before any request -
  // a tab that stopped matching, a folder whose permission Chrome dropped mid-run - and they left
  // `refused` at whatever the workspace had on record. The counter then read that as «Zoho refused
  // 16 sources» about a run in which Zoho was never reached, and the record was renewed as though
  // it had been. `refused` acquired a second writer when it began to be loaded from disk, and this
  // is the reader that question was owed - «who else owns this flag».
  entry.asked = false;
  if (mismatchRefuse()) return false;
  if (!dir) return false;
  if (!(await ensurePerm(op.root))) { setStatus(MSG.folder, 'bad'); return false; }
  const info = index.get(entry.id) || {};
  try {
    entry.asked = true;
    const r = await crmPull().fetchOne({ id: entry.id, category: entry.category || info.category, source: entry.source || info.source, language: entry.language || info.language, runtime: entry.runtime || info.runtime });
    // Through `bridgeError`, like every other reply: a bare Error here dropped `forbidden`, which is
    // the fourth place that boundary could lose it and the one that mattered most - a role that can
    // list functions but not read one refuses every download, and each was counted as a failure to
    // be retried. Reported from a real org with a reduced role: 32 rows, 32 refusals, and a closing
    // line telling the reader to press a button that could only refuse them again.
    if (!r?.ok || !r.file) throw bridgeError(r, 'not found');
    const f = r.file;
    // What the list said about this function at the moment it was fetched, kept beside what the
    // detail said. Two sources, two shapes - the comparison that decides «outdated» needs the pair.
    const written = await writeFunctionMirror(f, op, entry.listUpdated || null);
    entry.cleanupFailed = written.cleanupFailed || 0;
    // The files are safe - the writer refuses a folder that is not this op's - and `index` and the
    // row are not: they are the panel's memory of the workspace *on screen*, so publishing into them
    // after the last await puts one org's function into another org's index and lights its row.
    // Wrong indoors before it is wrong on disk, and it never reaches the disk to be caught there.
    if (!op.current()) return false;
    // A rename leaves the old pair on disk with a live id, which no prune will ever take. It goes
    // now, and only now: both new files are written, so the new path is authoritative. A removal
    // that fails keeps the old pair - readable is better than gone - and the next load will mark
    // the rename again, so the retry is free.
    if (entry.previousPath && entry.previousPath !== written.primary) {
      const cleanup = await removeFunctionPaths(entry.previousFiles || [entry.previousPath, entry.previousPath.replace(/\.dg$/, '.meta.json')], op);
      if (cleanup.moved) return false;
      entry.cleanupFailed += cleanup.failed;
    }
    entry.previousPath = null; entry.pathChanged = false;
    if (!op.current()) return false;   // the removals above awaited, and the row is the panel's memory
    entry.path = written.primary; entry.mirrorFiles = written.paths; entry.mirrorDirectories = written.directories; entry.namespace = f.folder;
    entry.display_name = f.meta.display_name || entry.display_name; entry.downloaded = true; entry.stale = false; entry.error = false; entry.errorMsg = ''; entry.refused = false;
    // From what was written, never from what this function believed it was about to write.
    entry.fetchedAgainst = written.listUpdated; entry.updatedTime = written.updatedTime;
    index.set(entry.id, { path: entry.path, category: f.meta.category, source: f.meta.source, language: f.meta.language, runtime: f.meta.runtime, name: f.meta.name, rest: (f.meta.rest_api || []).some((x) => x.active) });
    return true;
  // «Refused» is kept apart from «failed» on the row for the same reason it is kept apart on an
  // area: one of them is worth trying again and the other is an answer.
  } catch (e) { entry.error = true; entry.downloaded = false; entry.errorMsg = errText(e); entry.refused = !!(e && e.forbidden); return false; }
}
/** What this run learnt about which sources Zoho will not serve, written where it survives.
 *
 *  Derived from what was just asked, never from a memory of it: every entry the run attempted is
 *  either recorded as refused or cleared, so a role that has been granted since clears itself on the
 *  next pull without anybody having to notice. Entries this run did not touch are left alone - a
 *  «Complete missing» over three functions says nothing about the other three hundred.
 *
 *  Silent on failure by design. This is a note about a note: losing it costs a button that reappears
 *  once, and a pull that fails at its last step because a config write did would be a worse trade.
 */
async function noteSourceRefusals(attempted, op) {
  if (!attempted.length) return;
  try {
    const cfg = (await opReadCfg(op)) || {};
    if (op && !op.current()) return;
    const map = Object.assign({}, (cfg.srcRefused && typeof cfg.srcRefused === 'object') ? cfg.srcRefused : {});
    let moved = false;
    for (const e of attempted) {
      const id = String(e.id || '');
      if (!id) continue;
      // Only what this run actually asked about speaks. A row skipped because the tab stopped
      // matching says nothing either way, so its record is left exactly as it was found - neither
      // renewed nor dropped.
      if (!e.asked) continue;
      // The date is refreshed on every refusal, as the per-area verdict beside it is: it is when we
      // asked, and the tooltip says «asked». Frozen at the first refusal it would name a day on
      // which the question was not put, which is the same lie one field along.
      if (e.refused && !e.downloaded) { map[id] = { at: new Date().toISOString() }; e.refusedAt = map[id].at; moved = true; }
      // Cleared only by an actual success. A failure for some other reason - a bridge that has gone
      // away, a 500 - is not evidence that the role has been granted, and dropping the record on it
      // would put the button and its sixteen refusals straight back.
      else if (e.downloaded && map[id]) { delete map[id]; moved = true; }
    }
    if (moved) await patchCfg({ srcRefused: map }, op);
  } catch (_) { /* a record of a refusal is not worth failing a pull over */ }
}
/** @param {boolean} recheck - a pull re-asks what Zoho refused; the button does not.
 *
 *  **The button's number and what pressing it does have to be the same set.** They were not: the
 *  count learnt to leave out what Zoho had refused and this queue did not, so a button reading
 *  «Complete missing (2)» walked eighteen functions, sixteen of them already answered, at a request
 *  and 140ms each - and closed by reporting refusals nobody had asked about. Reproduced by driving
 *  both from the shipped source.
 *
 *  The two callers want opposite things and that is the whole of it: a pull is the re-check the row
 *  and the settings page both promise, and if it skipped them too the record could never clear and a
 *  role that had since been granted would stay refused for ever. So the pull asks and the button
 *  does not.
 */
async function downloadMissing(recheck) {
  const op = beginWorkspaceOp();   // the workspace these functions belong to
  // It downloads, so it is refused on the wrong tab like every other pull. A guard rather than a
  // disabled button: the button is `display:none` unless something is missing, and disabling it
  // from `updateMissingButton` would be an assignment on top of the five-second re-render - set
  // once, never revisited, which measured as «still off after the tab came back into line».
  if (!zohoReady()) { setStatus(MSG.wrongTab, 'warn'); return; }
  // `mirrored` first: asking `fetchOne` for one of these answers nothing, and counting that as a
  // failed download would put a number on screen that no retry could ever bring down.
  const pending = treeData.filter((e) => e.mirrored !== false && (!e.downloaded || e.stale || e.pathChanged)
                                    && (recheck || !isDenied(e)));   // stale = older schema, a rename, or Zoho's updatedTime moved
  if (!pending.length) {
    // Nothing to fetch is a pull outcome like any other, and it is the outcome of every pull after
    // the first - so this is where a census that came back short was dropped in silence, always.
    const short = pullActive ? '' : takeListGap();
    setStatus('All functions downloaded.' + short, short ? 'warn' : 'ok');
    updateMissingButton(); return;
  }
  setPullBusy(true); $('missing').disabled = true;   // both Pull buttons, and pullCurrent refuses to start on top
  let ok = 0, fail = 0, cleanup = 0, refused = 0;
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
      if (!done && e.asked && e.refused) refused++;
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
    const onDisk = treeData.filter((r) => r.downloaded).map((r) => r.metaPath || r.path.replace(/\.dg$/, '.meta.json'));
    if (ok) await saveMetaIndex(onDisk, op);
    if (!op.current()) return;
    await noteSourceRefusals(pending, op);
    if (!op.current()) return;
    updateMissingButton();
    // A census that came back short outlives the download that followed it: it is the last thing
    // written, and it is a warning, because «all downloaded» over a list missing a whole language of
    // the org is the green sentence this project exists to refuse.
    const short = pullActive ? '' : takeListGap();   // in a Pull all, the run's own closing line says it
    // **Advice that cannot work is worse than none**, and this was giving it to everybody whose role
    // lists functions but will not open one: Zoho refuses every source, and the closing line named
    // the button that had just been refused 32 times. A refusal is an answer - said as one, with the
    // count, and \u00abComplete missing\u00bb is only offered for what pressing it could actually fetch.
    const retryable = fail - refused;
    setStatus((refused
      ? `Zoho refused the source of ${refused} function${refused > 1 ? 's' : ''} - this Zoho user can list them but not read them. `
        + `${ok ? `Downloaded ${ok}. ` : ''}${retryable ? `${retryable} other(s) still missing - use "Complete missing".` : 'Their names and details are what this workspace has.'}`
      : fail ? `Downloaded ${ok}, ${fail} still missing - use "Complete missing".`
      : cleanup ? `All ${ok} functions downloaded; ${cleanup} old file(s) could not be removed - \u21bb Refresh retries.`
      : `All ${ok} functions downloaded.`) + short,
      (fail || cleanup || short) ? 'warn' : 'ok');
  } finally { setPullBusy(false); $('missing').disabled = false; }
}
function updateRow(e) {
  const row = document.querySelector(`.f[data-id="${escA((window.CSS && CSS.escape) ? CSS.escape(e.id) : e.id)}"]`); if (!row) return;
  row.dataset.path = e.path;
  const st = row.querySelector('.st'); if (!st) return;
  const ok = e.downloaded || e.scanned;
  // The refused mark ranks above the error one here as it does in the builder: a row repainted the
  // instant Zoho refused it showed \u27f3 and \u00abclick to retry\u00bb until the next rebuild, which is the whole
  // of a pull - so the reader was invited to retry the thing that had just been answered.
  const denied = isDenied(e);
  st.className = 'st ' + (denied ? 'st-none' : e.error ? 'st-err' : ok ? 'st-ok' : 'st-no');
  st.textContent = denied ? '\u2298' : e.error ? '\u27f3' : ok ? '\u25cf' : '\u25cb';
  st.title = denied ? MSG.srcRefused(e.refusedAt) : e.error ? (MSG.failed + (e.errorMsg || 'unknown') + MSG.clickRetry) : ok ? 'In workspace - click to refresh' : MSG.notHere;
}
function updateMissingButton() {
  const b = $('missing'); if (!b) return;
  if (viewMode === 'modules' || viewMode === 'schedules' || viewMode === 'connections' || viewMode === 'actions') { b.style.display = 'none'; return; }
  const arr = viewMode === 'workflows' ? workflowData : treeData;
  // «Complete missing» offers to fetch what is missing, and nothing it can fetch is missing here:
  // counting these would put a number on the button that pressing it can never reduce.
  // A source Zoho has already refused is not «missing»: pressing the button re-asks a question that
  // has been answered, once per function, and the number it counts can never come down. The queue
  // this button drives leaves them out on the same condition, so the number and the act are one set;
  // a pull passes `recheck` and asks them all again, which is where a role that has since been
  // granted clears itself.
  const miss = arr.filter((e) => e.mirrored !== false && !e.downloaded && !e.refused).length;
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
let failIndex = null;   // {at, usage, runs, month, byName:Map} - built once per read, dropped on pull
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
                month: (d && d.month) || null,
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
    // Through `bridgeError`, like every other pull: a bare Error drops `forbidden`, `status` and
    // the refusal's own words at the message boundary, so a role that cannot read this area was
    // reported as «pull error: HTTP 403», the tab stayed, the verdict was recorded as a failure
    // rather than a refusal, and every later Pull all asked again for ever. Three pulls were still
    // doing it by hand while the helper's own comment said «every one goes through here».
    const r = await toBridge({ cmd: 'pullFailures' }); if (!r?.ok) throw bridgeError(r, 'failures read failed');
    // One file for everything Zoho knows about how this org *runs*: what failed, how much ran, and
    // what it cost. It keeps the `failures/` name because that is what a reader looks for, and the
    // shape says the rest.
    if (!op.current()) return;
    await op.write('failures/index.json', JSON.stringify({ at: r.at, usage: r.usage || null,
      runs: r.runs || null, credits: r.credits || null, capped: !!r.capped,
      // The month beside the day, and stored under its own key rather than replacing it: everything
      // that reads this file today speaks in the last twenty-four hours, and a key that quietly
      // changed window would move every number on screen without a word.
      month: r.month || null, failures: r.failures || [] }, null, 2));
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
    const r = await toBridge({ cmd: 'listWorkflows' }); if (!r?.ok) throw bridgeError(r, 'list failed');
    // Same rule the functions pull learned: a list that stopped early describes the reading, not the
    // org. Writing it as the index and pruning what is missing removes workflows that still exist -
    // and the warning came *after* the pruning, so it described rules already gone.
    if (r.capped) {
      setStatus(`Zoho returned a partial list of workflows (stopped at ${r.total || 'the limit'}) - nothing was removed.`, 'warn');
      if (!(await loadWorkflowIndex(op))) return; if (viewMode === 'workflows') renderWorkflows();
      // Zoho answered, so the verdict moves - the third of these, and the same reason each time.
      await noteAccess('workflows', null, op, false);   // asked and answered; nothing was stored
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
    await noteAccess('workflows', wfRmFail.length ? { status: 0, message: `${wfRmFail.length} stale workflow file(s) could not be removed` } : null, op, true);   // the mirror was written; the gap is what could not be tidied after it
  } catch (e) { await notePullFailure('workflows', e, op); } finally { endPull(); }
}
async function openWorkflowInZoho(id) {
  if (sampleRefuse()) return;
  const ws = bound || {};
  if (!ws.base || !ws.instance) { setStatus('Unknown workspace binding - pull first.', 'warn'); return; }
  const url = `${ws.base}/crm/${ws.instance}/settings/workflow-rules/${id}`;
  try { if (await goToZoho(url)) setStatus('Opened workflow in Zoho.', 'ok'); }
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
  // **Arriving at a row is not the same as opening a file.** This asked «is it in `treeData`» and
  // then opened its path unconditionally - so a function this mirror has no source for closed the
  // pane the reader was looking at, flashed `Read failed: NotFoundError`, had that overwritten in
  // the same tick by the tree count, and recorded a step in the history that Back/Forward replays
  // for ever. The tree row two functions over has answered this properly since it was written; every
  // *link* to the same row went round it.
  setMode('functions');
  selectRow(ent.path);
  if (ent.mirrored === false) { setStatus(MSG.notMirrored(langLabel(ent.language)), 'warn'); return; }
  if (!ent.downloaded) { void fetchThenRedrawRow(ent); return; }
  openFromTree(ent.path);
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
    // **Remembered, not said now.** Saying it here replaced whatever the pull was saying and cleared
    // `busy` with it - so a save landing inside the longest single call in the product left a static
    // warn line and no spinner for the length of a listing, and a working pull and a hung one look
    // the same, which is the one thing this panel may not do. It is appended to the line that closes
    // the run instead: visible, and at the moment the reader can act on it. `pullBusy` is the flag
    // that matches the sentence - `pullActive` is owned by each runner, so a save landing between
    // two areas missed it entirely, which is exactly the case it was written for.
    if (ownPrefsWrite) ownPrefsWrite = false;
    else if (pullBusy) prefsSavedDuringPull = true;
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
$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
$('wsrename').onclick = renameWorkspace;
$('wsadd').onclick = () => addWorkspaceForTab();
$('wssample').onclick = () => addSampleWorkspace();
$('offsample').onclick = () => addSampleWorkspace();
$('ws').onchange = onWs;
$('wsdel').onclick = onWsdel;
document.addEventListener('click', regrantOnAnyClick, true);
$('opts').onclick = () => openSettings();
$('help').href = DOCS_URL;
// Registered here and not where it is written: `live-sync.js` is loaded four scripts earlier and
// its handler reads `pullActive` and `beginWorkspaceOp`, which are lexical globals of this file and
// in the temporal dead zone until it runs. Binding it there put a message arriving in that window
// into a handler that would throw where nobody sees it. A script before the composition root
// declares; the root binds.
try { chrome.runtime.onMessage.addListener(onPanelMessage); } catch (_) {}
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
// **A preset replaces the values, not the stamp.** `SCOPE_FULL` and `SCOPE_SAFE` carry no `sv`,
// so pressing one of them stored a scope that `loadScope` then read as «written before the
// default changed» and put through the one-shot migration again - every reload, for ever. The
// source-code tick chosen through «Everything» could never be remembered, while the same tick
// made by hand was. Settings has assigned onto the stored object since it was written.
$('pspFull').onclick = () => { dlgScope = Object.assign({}, dlgScope, SCOPE_FULL); dlgAutoCleared.clear(); scopeToUI(); };
$('pspSafe').onclick = () => { dlgScope = Object.assign({}, dlgScope, SCOPE_SAFE); dlgAutoCleared.clear(); scopeToUI(); };
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('scrim').onclick = () => { if ($('expscope').classList.contains('on')) closeScope(false); else closeAbout(); };
void readRememberedSample();
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

$('overview').onclick = () => ($('overviewview').classList.contains('show') ? closeOverview() : openOverview()); $('overviewx').onclick = closeOverview;
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
  const search = searchState.snapshot();
  return {
    product: m.name,
    version: m.version,
    browser: 'Chrome ' + (ua ? ua[1] : '?'),
    message: (err && (err.message || err)) || $('stxt').textContent,
    stack: (err && err.stack) || '',
    tab: viewMode || '?',
    search: search.mode === 'content' ? (search.regex ? 'code, pattern' : 'code') : 'names',
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
    diag: (err && err.diag) || null,
    ai,
    steps: reportSteps.slice(),
  };
}
// The last thing that actually threw. `openReport()` is opened from a button, so it has no error
// to hand - and without this the report was *only* the status buffer, which is the half that has to
// be redacted hardest and the half that says least. Two listeners, no call-site changes: an uncaught
// error and a rejected promise are exactly the failures worth a stack.
// **The error the report describes, and it used to be only the ones nobody caught.** `lastThrown` was
// written by `error` and `unhandledrejection` alone, so every failure this panel *handles* - which is
// all of them, that is what `notePullFailure` is for - was invisible to the report. The one failure
// that carries a diagnostic worth having, a refused deluge call, is handled by definition: being
// handled is why the report button appears at all.
let lastThrown = null;
function noteThrown(e) { if (e instanceof Error) lastThrown = e; }
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
