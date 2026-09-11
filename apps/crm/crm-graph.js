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
