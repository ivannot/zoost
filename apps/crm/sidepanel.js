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

// ---------- exports ----------
// In export.js, loaded just before this file - the second slice of the split.

// ---------- schedules / workflows / actions ----------
// In automation.js - the fourth slice. Three views that lean on each other, moved together.

// ---------- connections ----------
// In connections.js - the sixth slice.

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
