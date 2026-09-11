// CRM function tree, source rows and mirror index rendering.
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

