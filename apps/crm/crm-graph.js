// CRM graph hand-off and function identity enrichment.
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
// **Which way it splits is asked of the page, never remembered.** The same bar divides the list
// from the detail either way; above the breakpoint the two are columns and the drag moves a
// vertical edge, below it they are stacked and it moves a horizontal one. Asking `matchMedia`
// rather than keeping a flag is the rule this panel already lives by: a state that has to hold
// across time is a term in the condition, not an assignment somebody has to keep in step.
const wideSplit = () => window.matchMedia('(min-width: 720px)').matches;
// **What was dragged in one window has to fit in the next one.** The sizes are remembered as
// pixels, and until now they were handed back raw: a pane dragged to 700px in a 1200px window and
// met again in a 900px one drew itself from 288 to 988, with its own header - the close mark and
// both «Open in Zoho» buttons - past the right-hand edge of a body that hides its overflow. The
// stylesheet lets the pane shrink now, which stops the overflow; this keeps the *stored* number
// honest, so the next drag starts from where the reader can see it. Both axes, because the
// vertical one had the same defect: a 500px pane in a 313px viewport made the whole panel scroll.
const SPLIT_LIST_MIN = 280, SPLIT_PANE_MIN = 340, SPLIT_BAR = 8;
const SPLIT_LIST_MIN_H = 80, SPLIT_PANE_MIN_H = 120;
/** The room the pane may take, on whichever axis is splitting. `null` when there is not enough of
 *  it for both minimums - the stylesheet decides that case and a number here would fight it. */
function splitRoom(r) {
  if (!r.width || !r.height) return null;              // not laid out yet
  const room = wideSplit() ? r.width - SPLIT_LIST_MIN - SPLIT_BAR : r.height - SPLIT_LIST_MIN_H;
  const floor = wideSplit() ? SPLIT_PANE_MIN : SPLIT_PANE_MIN_H;
  return room < floor ? null : room;
}
function clampSplit() {
  const el = $('preview'), room = splitRoom($('split').getBoundingClientRect());
  if (room == null) return;
  if (wideSplit()) {
    const cur = parseFloat(el.style.getPropertyValue('--splitw'));
    if (!isFinite(cur)) return;                        // never dragged: the stylesheet's share holds
    const w = Math.max(SPLIT_PANE_MIN, Math.min(room, cur));
    if (w !== cur) el.style.setProperty('--splitw', w + 'px');
    return;
  }
  const cur = parseFloat(el.style.height);
  if (!isFinite(cur)) return;
  const h = Math.max(SPLIT_PANE_MIN_H, Math.min(room, cur));
  if (h !== cur) el.style.height = h + 'px';
}
let dragY = false;
$('resizer').addEventListener('mousedown', () => { dragY = true; document.body.style.userSelect = 'none'; });
window.addEventListener('mousemove', (e) => {
  if (!dragY) return;
  // **The button is gone, so the drag is over.** There is no `mouseup` when the release happens
  // outside the window, and the clamp above stops the divider well short of the edge while the
  // cursor keeps travelling - so letting go out there left the drag live: the pane then resized
  // itself under a cursor with no button held, and text stayed unselectable, until the reader
  // clicked again, which also pressed whatever was under them. `buttons` is the browser's own
  // answer to «is anything held», asked at the only moment it matters.
  if (!e.buttons) { endSplitDrag(); return; } const r = $('split').getBoundingClientRect();
  if (wideSplit()) {
    // The list keeps 280px whatever happens, which is the minimum the tree rows were drawn for -
    // and the divider itself is 8 of the pixels being shared out, which this forgot: dragging fully
    // left overflowed by exactly that, clipping a third of the close mark.
    const w = Math.max(SPLIT_PANE_MIN, Math.min(r.width - SPLIT_LIST_MIN - SPLIT_BAR, r.right - e.clientX));
    $('preview').style.setProperty('--splitw', w + 'px');
    return;
  }
  const h = Math.max(SPLIT_PANE_MIN_H, Math.min(r.height - SPLIT_LIST_MIN_H, r.bottom - e.clientY));
  $('preview').style.height = h + 'px';
});
// The height is cosmetic and its write is best-effort **by declaration**: a refusal costs the
// reader a drag next session and nothing else, so it is not worth a sentence - but an unhandled
// rejection is not a decision, it is an omission, so the intent is written where it happens.
window.addEventListener('mouseup', () => { endSplitDrag(); });
function endSplitDrag() {
  if (!dragY) return;
  dragY = false; document.body.style.userSelect = '';
  // Two sizes, remembered separately, because they are two different readers' preferences: how
  // tall you want the code in a narrow panel says nothing about how wide you want it in a broad
  // one, and one value overwriting the other would undo a drag every time the panel is resized.
  // **Written as literals on purpose.** Handing `set()` a variable is tidier and it hid both keys
  // from the check that holds every stored key against what the privacy page tells the reader -
  // `chromeFolded` was caught and these two were not, which is a blind spot in a checker created
  // by the shape of the code it reads. Two lines is a cheap price for being visible.
  if (wideSplit()) void chrome.storage.local.set({ previewW: $('preview').style.getPropertyValue('--splitw') }).catch(() => {});
  else void chrome.storage.local.set({ previewH: $('preview').style.height }).catch(() => {});
}

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
