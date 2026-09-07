/*
 * workspace-controller.js - CRM working-folder and workspace lifecycle.
 *
 * This is the stateful counterpart to workspace.js: it owns selection, creation, sample
 * materialisation, naming and removal. It is loaded before sidepanel.js; function bodies
 * receive the panel globals through the shared classic-script scope at runtime.
 */
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

function emptyReason(area) {
  if (!root) {
    return '<b>No working folder yet.</b> Press <b>Sample</b> to try invented data, or use '
      + '<b>+ Workspace</b> from a Zoho CRM tab. Either action asks for a dedicated folder and '
      + 'continues from there; every workspace lives inside it.';
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
  // **What Zoho last answered about *this* area, when it was not «yes».** Reported from a real org:
  // Connections was refused with a 400, the pull said so on the status line, and the tab then read
  // «No connections pulled yet - click Pull all» - the wrong missing thing, and advice that had just
  // been refused. The area *was* pulled; what came back was a refusal, which is a different fact
  // from never having asked.
  //
  // Last of the branches because every one above blocks *all* areas and this blocks a single tab -
  // the order this function has always been in. Plain text on purpose: it is shown on the status
  // line as well as in the list, and the status line renders text and not markup.
  const a = area && tabAccess[area];
  if (a && a.state && a.state !== 'ok') {
    return `${a.note || (a.state === 'forbidden'
      ? 'Your Zoho role does not grant access to this area'
      : 'The last pull of this area did not succeed')}`
      + `${a.status ? ` (Zoho answered ${a.status})` : ''}${a.at ? `, asked ${String(a.at).slice(0, 10)}` : ''}. `
      + 'Nothing is stored for it, and pulling again re-asks Zoho.';
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
  if (!on) closeOverview();
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
  const view = sampleWorkspaceView(knownSample(), sampleKnowable(), pullBusy || sampleBusy);
  const sb = $('wssample');
  if (sb) {
    sb.hidden = false;
    sb.disabled = view.disabled;
    sb.textContent = view.buttonLabel;
    sb.title = view.title;
  }
  // The overlay's copy covers the workspace list, so hiding it there would leave a sample on disk
  // unreachable. It changes what it says instead.
  const ob = $('offsample');
  if (ob) {
    ob.disabled = view.disabled;
    // Three states, because «+» and «Open» are both claims and there is a moment when neither can be
    // made. `+` says «there is none» and `Open` says «there is one»; with the folder unread the
    // honest label asserts nothing and the tooltip says the click will find out. This project does
    // not state what it has not measured, and a button label is a statement like any other.
    ob.textContent = view.overlayLabel;
    ob.title = view.title;
  }
}

let sampleBusy = false;
async function refreshWorkspaceEntryAfterGrant() {
  rootGranted = true;
  await loadWorkspaces();
}
async function openSampleWorkspace(have) {
  $('ws').value = have.id;
  $('offoverlay').classList.remove('show');
  return activate(have, true);
}
async function createSampleWorkspace() {
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
async function addSampleWorkspace() {
  if (sampleBusy) return;
  return runWorkspaceEntry({
    refuse: workspaceChangeRefuse,
    root: () => root,
    pickRoot,
    ensurePermission: ensurePerm,
    permissionRefused: () => setStatus(MSG.folder, 'warn'),
    folderWasGranted: () => rootGranted,
    refreshAfterGrant: refreshWorkspaceEntryAfterGrant,
    context: () => true,
    contextMissing: () => {},
    findExisting: () => (wsList || []).find((w) => w.binding && w.binding.sample),
    openExisting: openSampleWorkspace,
    create: createSampleWorkspace,
  });
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
    openOverview();
  } catch (e) { setStatus('Could not write the sample: ' + e.message, 'bad'); }
}

async function createWorkspaceForContext(ctx) {
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
    openOverview();
  } catch (e) { setStatus('Add failed: ' + e.message, 'warn'); }
}
async function openWorkspaceForContext(have) {
  $('ws').value = have.id;
  return activate(have, true);
}
async function crmWorkspaceContextForEntry() {
  return lastCtx && lastCtx.org ? lastCtx : getContext();
}
async function addWorkspaceForTab() {
  return runWorkspaceEntry({
    refuse: workspaceChangeRefuse,
    root: () => root,
    pickRoot,
    ensurePermission: ensurePerm,
    permissionRefused: () => setStatus(MSG.folder, 'warn'),
    folderWasGranted: () => rootGranted,
    refreshAfterGrant: refreshWorkspaceEntryAfterGrant,
    context: crmWorkspaceContextForEntry,
    contextMissing: () => setStatus('Open a Zoho CRM tab first - the workspace is created for the org you are signed in to.', 'warn'),
    findExisting: (ctx) => (wsList || []).find((w) => w.binding && w.binding.org === ctx.org),
    openExisting: openWorkspaceForContext,
    create: createWorkspaceForContext,
  });
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
  // These two describe the list of *a* workspace, and survived into the next one: pick another org,
  // or press + Sample - which never contacts Zoho at all - and its tree line closed on «Zoho would
  // not list one of this org's function languages». The sixth question this repository asks of every
  // change is what survives a change of workspace, and these were two more answers to it.
  listGap = null; listGapWho = ''; listProbe = null; unreadableMetas = [];
  // Access and freshness are workspace facts too. Clear them before any renderer can run; the
  // replacement is read from the new workspace below. Otherwise an open Overview can briefly and,
  // because its render is asynchronous, permanently publish the previous org's verdicts.
  tabAccess = {}; wsLastPull = null;
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
  // The Language filter is derived from what the workspace holds, so it belongs to the workspace:
  // carried across, Language = Java in an all-Deluge org drew an empty list under advice naming a
  // control that was not even on screen. The fold state of a project's Files tree goes with it -
  // the root is a workspace-relative path, identical across two mirrors of the same org, so the
  // next workspace's project arrived with this one's folders closed.
  langFilter = 'all'; projCollapsed = new Set(); projRootOpen = '';
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
  // The saved searches are per *tab*, not per workspace: restored across an org change they would
  // run one org's text, mode and pattern toggle against another. All of it goes together.
  paintSearchControls(searchState.reset());
  connectionFilter = null; connFilterSet = null;
  currentPath = null; navClear();
  $('preview').classList.remove('show'); $('resizer').classList.remove('show');
  // An overlay is a view of the workspace too. Health is rebuilt rather than closed, because
  // closing it would answer «what is wrong here» by taking the question away; the assistant's
  // context line is re-measured, since the index it reports is the new org's.
  if ($('healthview').classList.contains('show')) openHealth();
  if ($('aiview').classList.contains('show')) aiContextLabel();
  if ($('overviewview').classList.contains('show')) void renderOverview();
}

async function renderOverview() {
  const op = beginWorkspaceOp();
  const counts = {};
  const dates = {};
  const unreadIndexes = new Set();
  for (const tab of TABS) {
    try {
      const rows = JSON.parse(await op.read(`${tab.id}/index.json`));
      counts[tab.id] = Array.isArray(rows) ? rows.length : null;
      dates[tab.id] = pulledAt(tab.id);
    } catch (e) {
      counts[tab.id] = null;
      // A missing index is the normal representation of an area excluded before its first pull.
      // It is damaged only when this workspace explicitly records that the area was once written;
      // the workspace-wide legacy date cannot establish that for a file that does not exist.
      dates[tab.id] = (tabAccess[tab.id] && tabAccess[tab.id].pulledAt) || null;
      if ((e && e.name) !== 'NotFoundError' || dates[tab.id]) unreadIndexes.add(tab.id);
    }
  }
  if (!op.current()) return;
  const selected = $('ws').selectedOptions && $('ws').selectedOptions[0];
  const model = workspaceOverviewModel({
    workspace: dir,
    name: selected ? selected.textContent : (bound && (bound.label || bound.instance)),
    sample: isSample(),
    lastPull: wsLastPull,
    areas: TABS.map((tab) => ({
      id: tab.id, label: tab.label, count: counts[tab.id], pulledAt: dates[tab.id],
      unavailable: isForbidden(tab.id) || unreadIndexes.has(tab.id), behind: areaStale(tab.id),
      partial: tab.id === 'functions' && unreadableMetas.length > 0,
    })),
    issues: [unreadableMetas.length ? { text: `${unreadableMetas.length} local function file(s) could not be read.`, action: 'pull' } : '',
      // **Say which of the two it is.** Every area refusing at once is almost never six damaged
      // files; it is the folder grant having lapsed, which the adapter has just asked about. Blaming
      // the files there sent the reader to a pull that would refuse for the same reason, and hid the
      // one-click remedy - reported: open the overview, open the diagram window, come back.
      unreadIndexes.size ? (rootGranted
        ? { text: `${unreadIndexes.size} local index file(s) could not be read.`, action: 'pull' }
        : { text: 'Folder access has lapsed - nothing local can be read until it is granted again.', action: 'refresh' }) : '',
      listGap ? { text: 'The functions census has a coverage gap.', action: 'health' } : ''],
  });
  const onboarding = workspaceOnboardingModel({ sample: model.sample, mirrorReady: model.sample || !!model.lastPull });
  renderOverviewView(model, onboarding, {
    body: $('overviewbody'), escapeText: escHtml, escapeAttribute: escA,
    graphDisabled: $('graph').disabled, healthDisabled: $('health').disabled, graphLabel: 'Wiring',
    issueLabel: (action) => action === 'health' ? 'Review' : action === 'refresh' ? 'Grant access' : 'Repair',
    browse: closeOverview,
    pull: () => { closeOverview(); void pullEverything(); },
    graph: () => { closeOverview(); void openGraph(); },
    health: () => { closeOverview(); void openHealth(); },
    issue: (action) => {
      const run = workspaceOverviewAction(action, {
        pull: () => { void pullEverything(); }, refresh: () => { void onRefresh(); },
        health: () => { void openHealth(); },
      });
      if (!run) return;
      closeOverview();
      run();
    },
  });
}
function openOverview() {
  if (!dir) return;
  closeAI(); closeHealth(); navShow(false);
  $('overviewview').classList.add('show'); $('overview').classList.add('on');
  document.body.classList.add('overview-open');
  void renderOverview();
}
function closeOverview() {
  $('overviewview').classList.remove('show'); $('overview').classList.remove('on');
  document.body.classList.remove('overview-open');
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
  // Overview, Health and assistant context consume the access verdicts and freshness dates, so
  // rebuild them only after those workspace facts have arrived.
  if (!sameWs) resetView();
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
  // stays visible. Choosing or re-granting the folder is part of this action, not a prerequisite.
  const known = (wsList || []).find((w) => lastCtx && w.binding && w.binding.org === lastCtx.org);
  const view = addWorkspaceView(known, pullBusy, lastCtx, root && root.name, rootGranted);
  add.hidden = view.hidden;
  // The handler grants first, refreshes the workspace list and only then decides whether it needs to
  // create or merely open the org. That makes the first click useful without trusting an unread list.
  add.disabled = view.disabled;
  add.textContent = view.label;
  add.title = view.title;
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

// A stored folder handle loses its permission between sessions and can only be re-granted from a
// user gesture. Any click in the panel counts, so the first thing the user does restores access -
// except on the controls that would themselves ask, on a dialog, on the mismatch overlay, or in the
// chat. The two panels excluded different subsets of those and neither list was wrong, which is how
// a divergence survives: both looked deliberate. It is the union now, and the same on both sides.
// Named, like every async scope this project ships: `tools/asynccheck.py` reads function
// declarations, so an inline callback is a scope nothing looks inside.
/** The grant lapsed while the panel was open, and the panel had believed otherwise.
 *
 * `rootGranted` was written when the workspace was opened and re-read nowhere: a memory of a check,
 * which is the shape this repository has already paid for elsewhere. Every remedy the panel offers
 * for a lapsed folder is gated on it - `↻ Refresh` re-grants only when it is false, and so does the
 * click-anywhere listener below - so the moment the grant went, both switched themselves off and
 * the panel started reporting damaged files instead. The filesystem adapter asks the API on any
 * failed operation and calls this; from here the two remedies are true again, and the status line
 * says which one to use.
 */
function noteFolderAccessLost() {
  if (!root || !rootGranted) return;
  rootGranted = false;
  updateWsButtons();
  setStatus(MSG.folder, 'warn');
}
async function regrantOnAnyClick(e) {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('#pfoot') || t.closest('.dlg') || t.closest('#aiview') || t.closest('#offoverlay'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await loadWorkspaces(); } } catch (_) {}
}
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
// The same action from the off-Zoho overlay, which is where somebody who has just installed
// Zoost and is not signed in to anything actually is.
// One call for both copies of the button: addSampleWorkspace() decides whether there is one to
// open or one to write, so the two cannot disagree and neither can act on a stale label.
// Named, like every async scope this project ships: `tools/asynccheck.py` reads function
// declarations, so an inline callback is a scope nothing looks inside.
async function onWs() {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value); if (w) await activate(w, true);
}
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
