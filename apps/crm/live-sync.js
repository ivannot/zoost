/*
 * live-sync.js - CRM notices from the live Zoho page and mirror reconciliation.
 *
 * Page events are hints, never authority: this slice re-reads Zoho, serialises overlapping
 * notices and applies their result to the workspace operation that initiated the read.
 */
// ---------- save-sync ----------

/** Build the graph the diagram window asked for and hand it back through the message port. */
async function sendGraphWhenBuilt(kind, token, sendResponse) {
  sendResponse(await buildGraphFor(kind, token));
}

/** What the panel does with a message from the content bridge or the diagram window.
 *
 *  **Declared here, registered by the composition root.** This file is loaded four scripts
 *  before `sidepanel.js`, and it used to call `addListener` at load time - so a `saved`,
 *  `created`, `deleted` or `pullProgress` arriving in that window ran a handler whose
 *  `pullActive` and `beginWorkspaceOp` are lexical globals still in the temporal dead zone,
 *  and threw inside the listener where nobody sees it. No sender exists in those few
 *  milliseconds today, so nothing was observed; it is the load-order rule this project
 *  states - a script before the root declares state and functions only - and a rule with
 *  one exception is the one that gets broken next.
 */
function onPanelMessage(msg, _sender, sendResponse) {

  if (msg?.type === 'saved') syncOne(msg.id);
  // A deletion and a creation both mean «the list has changed»; neither is trusted with what
  // changed. Duplicates are harmless because reconciling is idempotent, which is why the hook no
  // longer needs to collapse them.
  if (msg?.type === 'deleted' || msg?.type === 'created') reconcileFunctions();
  if (msg?.type === 'pullProgress' && (pullActive || pullBusy)) {
    const stage = String(msg.stage || '').trim();
    setStatus(`${stage ? stage[0].toUpperCase() + stage.slice(1) : 'Pulling'}… ${msg.done}/${msg.total}`, 'busy');
  }
  // The diagram window asking for the other drawing. It has no folder access of its own - by design,
  // and it stays that way - so the graph is built here and left in storage for it to reload from.
  // Through a declaration: `.then(sendResponse)` is a scope nothing can read, and what it carries
  // is a whole graph built after an await.
  if (msg?.type === 'graphSwitch') { void sendGraphWhenBuilt(msg.kind, msg.token, sendResponse); return true; }
}
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
    // **A list that came back short says so.** The org list is asked once per language, and the
    // second ask is deliberately allowed to fail without taking the pull down with it - which is
    // only defensible if the failure is stated. Otherwise a role that does not grant Node
    // functions produces exactly the silent, complete-looking mirror this change is undoing.
    if (op.current()) noteListGap(r.otherFailed, r.unanswered);   // the answer describes the workspace we asked from
    noteListProbe(r);
    // A list that stopped early is not a statement about what exists: it is a statement about how
    // far the reading got. Writing it as the index, or pruning what is missing from it, deletes
    // functions that are still in Zoho - the worst thing this product could do, and reachable on
    // any org past the paging limit by an ordinary create. Raised by an outside review.
    if (r.capped) {
      await rebuildTree();
      // Which of the two made it partial: a page limit is «try again», a refused language is «that
      // area of your org would not answer», and they are not the same thing to do next.
      setStatus(`Zoho returned a partial list (stopped at ${r.total}) - nothing was removed. Click Pull all.`, 'warn');
      return;
    }
    // Computed here, above its first reader. Put beside the write - which is further down - it was a
    // temporal dead zone: `node --check` accepted it and the case that drives this function said
    // «Cannot access 'merged' before initialization», which is the only thing that ever says so.
    const merged = await mergeUnanswered(r.entries, r.unanswered, op);
    if (!op.current()) return;
    const live = new Set(merged.map((e) => String(e.id)));
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
    await op.write('functions/index.json', JSON.stringify(merged, null, 2));
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
    await downloadMissing(true);   // a reconcile is a pull: it re-asks what Zoho refused last time
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
    ? `functions/${sanitize(entry.namespace)}/${sanitize(entry.api_name)}${(!entry.language || /^deluge/i.test(String(entry.language))) ? '.dg' : '.files'}` : null;
  const path = fromEntry || (info && info.path) || (row && row.path);
  if (!path) return true;
  let whole = true;
  // The folder this removal belongs to. Two files, two removals, awaits inside each: without this
  // the source went from one workspace and the metadata from the next.
  const language = (entry && entry.language) || (row && row.language) || 'deluge';
  const deluge = !language || /^deluge/i.test(String(language));
  const metaPath = entry && entry.namespace && entry.api_name
    ? `functions/${sanitize(entry.namespace)}/${sanitize(entry.api_name)}.meta.json`
    : (row && row.metaPath) || (deluge ? path.replace(/\.dg$/, '.meta.json') : path.replace(/\.files(?:\/.*)?$/, '.meta.json'));
  let paths = (row && row.mirrorFiles) || (entry && entry.mirrorFiles);
  let directories = (row && row.mirrorDirectories) || (entry && entry.mirrorDirectories) || [];
  if (!paths && deluge) paths = [path, metaPath];
  if (!paths) {
    // The sidecar is the authoritative manifest of every mirrored file and explicit directory.
    // Directories are removed deepest first and never recursively, so a local file Zoho did not
    // return cannot be erased as collateral damage.
    try {
      const meta = JSON.parse(await op.read(metaPath));
      paths = pathsFromMeta(meta, metaPath);
      directories = directoriesFromMeta(meta, metaPath);
    }
    catch (_) {
      if (op.current()) op.say(`Could not read ${metaPath.split('/').pop()} - project files were left untouched.`, 'warn');
      return false;
    }
  }
  const sources = paths.filter((p) => p !== metaPath);
  const projectRoot = deluge ? null : metaPath.replace(/\.meta\.json$/, '.files');
  const removals = sources.concat(directories.slice().sort((a, b) => b.split('/').length - a.split('/').length));
  if (projectRoot) removals.push(projectRoot);
  removals.push(metaPath); // last: until then the manifest can still describe a partial removal
  for (const p of removals) {
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
  if (paths.includes(currentPath)) { $('preview').classList.remove('show'); $('resizer').classList.remove('show'); currentPath = null; }
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
    const r = await toBridge({ cmd: 'fetchOne', id, category: info?.category, source: info?.source, language: info?.language, runtime: info?.runtime });
    if (!op.current()) return;             // you moved: this answer belongs to a folder we have left
    if (!r?.ok || !r.file) throw new Error(r?.error || 'detail not found');
    const f = r.file;
    // Before **each** effect, not once before the pair: a write is several awaits of its own, so the
    // folder can change between the source and its metadata - and it did, leaving one file in each
    // workspace. Checked again rather than trusted from a moment ago.
    if (!op.current()) return;
    // Deliberately nothing: this ran because the function was *just saved* in Zoho, so the org list
    // this panel holds predates the save. Writing that value would claim this copy had been checked
    // against a list that has not seen the change - a claim in the direction that hides one. The
    // next pull refreshes both sides and the pair becomes meaningful again.
    const written = await writeFunctionMirror(f, op, null);
    // The memory is an effect too: after the last write the row looked up in `treeData` is the new
    // workspace's, and marking it downloaded gave one org's row the other org's path.
    if (!op.current()) return;
    const ent = treeData.find((x) => x.id === String(id));
    // `null` above is deliberate and the row has to say the same thing: a summary that kept the
    // previous reading would describe a copy the sidecar describes differently.
    if (ent) { ent.path = written.primary; ent.mirrorFiles = written.paths; ent.downloaded = true; ent.error = false;
               ent.mirrorDirectories = written.directories;
               ent.fetchedAgainst = written.listUpdated; ent.updatedTime = written.updatedTime;
               updateRow(ent); updateMissingButton(); } else { await rebuildTree(); }
    if (written.paths.includes(currentPath)) await openFile(currentPath);
    setStatus(`Synced: ${written.primary}`, 'ok');
  } catch (e) { setStatus(`Sync failed for ${id}: ${e.message}`, 'warn'); }
}
