// CRM panel bootstrap and runtime wiring.
// ---------- boot + tab reactivity ----------
$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
$('wsrename').onclick = renameWorkspace;
$('wsadd').onclick = () => addWorkspaceForTab();
$('wssample').onclick = () => addSampleWorkspace();
$('offsample').onclick = () => addSampleWorkspace();
$('ws').onchange = onWs;
$('wsdel').onclick = onWsdel;
document.addEventListener('click', regrantOnAnyClick, true);
// **Any click puts the export offer away, and the line that carried it with it.** Opening an item
// does it through `clearItemStatus`, but a button does not - and the report was that after an export
// «any click on an item or on any other control» should clear both. Capture, so it runs before the
// control's own handler; everything inside `#expopen` is excluded, or the offer would clear itself
// on the way to being pressed. Nothing else is touched: while the offer is up, the sentence on the
// row is the export's own, because any other status write has already taken the offer away.
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.closest && t.closest('#expopen')) return;
  if (!$('expopen').classList.contains('on')) return;
  if ($('status').className) setStatus('', '');
  offerExportOpen(null);
}, true);
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
$('scrim').onclick = () => { if ($('expscope').classList.contains('on')) closeScope(false); else if ($('fieldlist').classList.contains('on')) closeFieldList(); else closeAbout(); };
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
  const h = e.target.closest('.thsort');
  if (h && fieldListShown) {
    const key = h.dataset.sort;
    fieldSort = nextFieldSort(key);
    // Both maps, or sorting by any header redraws the table without the blueprints and the BP column
    // empties on the first click - the table would be telling the truth once and then stopping.
    $('laybody').innerHTML = renderFieldsTable(fieldListShown.m, fieldListShown.found, fieldListShown.bpFound);
    const again = [...$('laybody').querySelectorAll('.thsort')].find((x) => x.dataset.sort === key); if (again) again.focus();
    return;
  }
  // Delegated for the same reason the picklist buttons are: the fields table is rebuilt by the
  // layout picker and by every column sort, so a handler attached once per open is one that dies on
  // the second render - which is what happened to the lookup chips, drawn and dead.
  const md = e.target.closest('[data-mod]'); if (md) { healthOpenModule(md.dataset.mod); return; }
  const b = e.target.closest('.plbtn'); if (b) openFieldList(b.dataset.list, b.dataset.f, b);
});
$('fieldlistx').onclick = closeFieldList;
$('fieldlistbody').addEventListener('click', (e) => {
  const wl = e.target.closest('.wflink'); if (!wl) return;
  closeFieldList();
  // One class, two kinds of row: the layer lists the rules that touch a field and the blueprints
  // that do, and each opens where it lives. Without this branch a blueprint row is a button that
  // does nothing - the defect the module chip and the function chip have each been fixed for.
  if (wl.dataset.bpid) healthOpenBlueprint(wl.dataset.bpid, wl.textContent || '');
  else openWorkflowById(wl.dataset.wfid);
});
// Escape closes the list before anything else hears it: it is on top of everything, and the
// panel's own Escape would otherwise close a view underneath the layer the reader is looking at.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('fieldlist').classList.contains('on')) { e.preventDefault(); e.stopImmediatePropagation(); closeFieldList(); }
}, true);
document.querySelectorAll('#pvtabs .dtab').forEach((b) => (b.onclick = () => setPvTab(b.dataset.pv)));
$('pull').onclick = pullEverything; $('pullone').onclick = () => pullCurrent({ full: true }); $('pulllist').onclick = () => pullCurrent({ full: false }); // One group in the health view is read from Zoho; the rest is computed from the mirror. Before this
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
  try { r = await chrome.storage.local.get(['previewH', 'previewW']); } catch (_) { return; }
  if (r?.previewH) $('preview').style.height = r.previewH;
  // The width is only read in the two-column mode, where the stylesheet overrides the height
  // anyway - so both can be restored without either having to know which mode is showing.
  if (r?.previewW) $('preview').style.setProperty('--splitw', r.previewW);
  clampSplit();                    // a size from another window is a size this one may not have
}
void restorePreviewHeight();

/** The chrome's fold: the reader's choice if they have made one, otherwise the screen's answer.
 *
 *  **Stored beats measured, and the measurement only ever decides the first time.** A default that
 *  re-asserted itself would undo a choice every time the panel is resized, which is the shape of
 *  defect this panel has already met - a state that has to hold across time is a term in the
 *  condition, never something re-imposed by a later event.
 *
 *  The unset default is folded on a short panel, because the reader it was asked for is the one on
 *  a laptop who will never find the control: 720px is where the list stops being the majority of
 *  what is on screen, measured on the render rather than chosen.
 */
async function restoreChromeFold() {
  let r = null;
  try { r = await chrome.storage.local.get('chromeFolded'); } catch (_) { /* a default is not worth a sentence */ }
  const folded = r && typeof r.chromeFolded === 'boolean' ? r.chromeFolded : window.innerHeight < 720;
  applyChromeFold(folded);
}
const FOLD_SHOW = 'Show the workspace and tools rows again';
const FOLD_HIDE = 'Fold the workspace and tools rows away';
/** **The fold is for a panel that is working, and it stays open on one that is not.**
 *
 *  Folded, the chrome takes `#wsroot`, the workspace picker, `+ Workspace`, `+ Sample`, `Pull all`
 *  and every tool with it - measured, all of them zero-sized. And `emptyReason()` names exactly
 *  those: «Press Sample … or use + Workspace», «press + … or press + Sample», «Press Pull all». A
 *  reader on a short screen gets the fold by default, with no working folder yet, and is told to
 *  press three buttons that are not on the screen - the guide's own «wrong missing thing», which is
 *  the one empty-state failure this project treats as worse than silence, arriving on the very
 *  first run. So the choice is remembered and honoured, and it is *applied* only once there is a
 *  workspace open: the fold buys room for a list, and with no list there is nothing to buy it for.
 */
let chromeFoldWanted = false;
function syncChromeFold() {
  document.body.classList.toggle('chromefolded', chromeFoldWanted && !!dir);
}
function applyChromeFold(folded) {
  chromeFoldWanted = folded;
  syncChromeFold();
  const b = $('chromefold');
  if (!b) return;
  // The mark turns with the state - `body.chromefolded` rotates it in the stylesheet - so there is
  // no glyph to keep in step here. What this must still say is the part a mark cannot: the label a
  // screen reader gets, and the sentence on hover.
  b.setAttribute('aria-expanded', folded ? 'false' : 'true');
  // The name follows the state too: a label reading «fold» on a control that unfolds is worse than
  // none, because a screen reader says it with confidence. One sentence, one name - the tooltip is
  // the same words plus what the reader gets out of it.
  b.setAttribute('aria-label', folded ? FOLD_SHOW : FOLD_HIDE);
  b.title = folded ? FOLD_SHOW : `${FOLD_HIDE} - the list gets the room`;
}
$('chromefold').onclick = () => {
  const folded = !chromeFoldWanted;
  applyChromeFold(folded);
  // Best-effort by declaration, like the split's size beside it: a refusal costs the reader one
  // click next session and nothing else.
  void chrome.storage.local.set({ chromeFolded: folded }).catch(() => {});
};

/** On a first run the window places itself, instead of landing wherever Chrome decides.
 *
 *  **The document knows what the service worker cannot.** `screen.availWidth` and its siblings are
 *  readable by any page for nothing; the worker that created this window would need
 *  `chrome.system.display` to learn the same thing, which is a permission asked for a cosmetic
 *  fact. So the window is created at a readable size and moves itself once it can see.
 *
 *  The right half of the screen it was born on, full height - beside the browser rather than over
 *  the page being read. It runs **only** while nothing has been remembered: the moment the reader
 *  moves or resizes it, that is where it belongs, and a default that re-asserted itself would undo
 *  a choice on every open. The same rule as the folded chrome, one surface up.
 */
/** The right-hand half of the screen, which is where this window starts life. */
function halfTheScreen() {
  const half = Math.round(screen.availWidth / 2);
  return { left: Math.round(screen.availLeft + half), top: Math.round(screen.availTop),
           width: half, height: Math.round(screen.availHeight) };
}
/** Is enough of this window on a screen to grab hold of? A window is dragged by its top edge, so
 *  the test is about that edge and not about area: 120x40 of it inside the work area is a title bar
 *  somebody can reach. */
function withinReach() {
  const l = window.screenX, t = window.screenY, r = l + window.outerWidth, b = t + window.outerHeight;
  const al = screen.availLeft, at = screen.availTop;
  const ar = al + screen.availWidth, ab = at + screen.availHeight;
  return Math.min(r, ar) - Math.max(l, al) >= 120 && Math.min(b, ab) - Math.max(t, at) >= 40;
}
/** Place it on the first run, and bring it back if where it was left is no longer anywhere.
 *
 *  **The remembered place is handed straight back to `windows.create`, and a place can stop
 *  existing.** Work with Zoost on a second monitor, undock, click the icon: the window is created
 *  off the side of the only screen there is. A `popup` has no tab strip and no address bar, so
 *  there is nothing in it to navigate with, and the only way back would be clearing the extension's
 *  storage - which is not a recovery, it is an uninstall with extra steps. The service worker
 *  cannot check this (it would need `system.display`, a permission for a cosmetic fact); this
 *  document can, for nothing, because `screen` is already its own. So the check lives where the
 *  knowledge is, and it runs on every load rather than only on the first: the run that needs it is
 *  by definition one where a place was already remembered.
 */
async function placeWindow() {
  try {
    const { zoostWindowBounds } = await chrome.storage.local.get('zoostWindowBounds');
    const self = await chrome.windows.getCurrent();
    if (zoostWindowBounds && zoostWindowBounds.width) {
      if (withinReach()) return;
    } else if (zoostWindowBounds) {
      return;                              // maximised and nothing else remembered: the browser placed it
    }
    const bounds = halfTheScreen();
    await chrome.windows.update(self.id, bounds);
    // Every field named, not spread: two files write this key and the check that holds them to
    // «keep what you do not know about» reads the fields it can see.
    await chrome.storage.local.set({ zoostWindowBounds: {
      left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, state: 'normal' } });
  } catch (_) { /* a window that will not move is still a window; nothing here is worth a sentence */ }
}
// **In this order, and awaited.** The unset fold default is decided from
// `window.innerHeight`, and on a first run the window is created at 1200x900 and then
// placed at the height of the screen - so asking before the placing measured a window that
// was about to stop existing, and a short screen got the unfolded chrome the default is
// there to avoid. Right from the second run on, which is exactly how a first-run defect
// stays invisible.
void placeWindow().then(restoreChromeFold);

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

/** **A floor under the window's size.** Chrome has no `minWidth` on a window it creates, so the
 *  reader can drag a popup down to a sliver - reported with a picture of Zoost about 190px wide,
 *  where the toolbar has become a column of stacked buttons and the panel is of no use to anybody.
 *  The browser will not stop it, so the document does: it is the only party that can see how small
 *  it has got.
 *
 *  The numbers are the layout's own. Below the 720px breakpoint the list and the detail stack, and
 *  the narrow layout was drawn for the 400px side panel this product used to be - so 420 is the
 *  width at which every control in the toolbar is still reachable, and 420 in height keeps the
 *  chrome, the find row and a few rows of list on screen together.
 *
 *  Corrected after the drag rather than during it: `windows.update` inside a live resize fights the
 *  pointer, and the reader feels the window stick. This waits for the gesture to stop.
 */
const WIN_MIN_W = 420, WIN_MIN_H = 420;
let _sizeFloorT = null;
function holdTheSizeFloor() {
  clearTimeout(_sizeFloorT);
  _sizeFloorT = setTimeout(() => { void applySizeFloor(); }, 180);
}
async function applySizeFloor() {
  const w = window.outerWidth, h = window.outerHeight;
  if (w >= WIN_MIN_W && h >= WIN_MIN_H) return;
  try {
    const self = await chrome.windows.getCurrent();
    // Only the axis that is short, so correcting one does not undo the reader's choice on the other.
    await chrome.windows.update(self.id, { width: Math.max(w, WIN_MIN_W), height: Math.max(h, WIN_MIN_H) });
  } catch (_) { /* a window that will not resize is still a window */ }
}
window.addEventListener('resize', holdTheSizeFloor);
// And once on the way in, because a window remembers the size it was left at: a reader who
// dragged it down to a sliver yesterday would otherwise meet the sliver again today and have
// to resize it before the floor had anything to correct.
void applySizeFloor();

/** A view asked for from outside this window - Chrome's own «Options» entry, by way of
 *  `options.html` and the service worker. Two ways in, because a window that has just been created
 *  is not listening when the ask is made and an already-open one will never read a note it has
 *  already passed: the note covers the first, the message covers the second.
 */
async function openPendingView() {
  let view = null;
  try {
    ({ zoostPendingView: view } = await chrome.storage.session.get('zoostPendingView'));
    if (view) await chrome.storage.session.remove('zoostPendingView');
  } catch (_) { return; }
  if (view === 'settings') await openSettingsView();
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.zoost === 'view' && msg.view === 'settings') void openSettingsView();
  return undefined;
});
void openPendingView();
