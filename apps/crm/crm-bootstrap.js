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
