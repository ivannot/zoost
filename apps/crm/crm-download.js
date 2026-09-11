/* CRM source download, retry and missing-item state. */
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


