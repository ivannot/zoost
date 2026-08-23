/*
 * graphlogic.js - everything the graph window works out, as opposed to draws.
 *
 * The two products ship two graph windows that are different *shapes* - one draws a call graph and a
 * schema, the other a schema and its lineage - and identical *arithmetic*. That was costing a
 * double edit on nearly every change: measured over one day of layout work, twenty functions were
 * touched and twelve of them had to be typed twice, including every one of the six that carry the
 * arrangement format. `tools/twincheck.py` has held those pairs byte-identical for a while, so the
 * drift was reported rather than silent - but reporting a double edit is not the same as not making
 * one.
 *
 * **What lives here is derived, not chosen**: a function belongs in this file when it is
 * byte-identical in both products and touches no DOM handle. That criterion is mechanical, so a test
 * can hold it and a function that becomes shared tomorrow is caught without anyone remembering - the
 * failure mode a hand-kept list has, and this repository has already met twice.
 *
 * What is deliberately *not* here is anything that reads the page. `erLayout` asks the boxes how big
 * they are and `erFit` asks the panel how big it is, so both stay next to the drawing they serve and
 * call into this. The proposal that started this described a pure engine taking `(ids, sizes, edges)`
 * and returning positions; that interface does not exist, and pretending it did would have meant a
 * rewrite dressed as a move. This is a move: the functions are byte-for-byte what they were, and the
 * proof is that every rendered picture is unchanged.
 *
 * The file exists twice on disk because extensions cannot share one, and the two copies are held
 * identical by the twin ledger - which is what makes editing one of them, and copying it across, a
 * mechanical step rather than a second act of typing.
 */
function entitiesPresent() {
  const seen = new Set(Object.values(N).map(entityOf));
  return Object.keys(ENTITY_LABEL).filter((e) => seen.has(e))
    .concat([...seen].filter((e) => !(e in ENTITY_LABEL)).sort());
}

function wsLine(ws) {
  // Not blank. A window that cannot name the workspace it is drawing looks exactly like one whose
  // header happens to be short - and these windows come in pairs: two can be open at once, on two
  // workspaces, which is the whole reason the identity travels with the drawing at all. Saying so
  // costs a few words and is the rule this project applies to every other empty state.
  if (!ws || !(ws.instance || ws.org)) return '\u00b7 <b>workspace not recorded</b>';
  const inst = esc(ws.instance || '?'), org = esc(ws.org || '?');
  // A label the same as the derived name is not a label: printing both would say the one word
  // twice, which is what a sample workspace does by construction and what a user is free to do by
  // hand.
  const label = ws.label && ws.label !== ws.instance ? esc(ws.label) : null;
  return label
    ? `\u00b7 <b>${label}</b> \u00b7 ${inst} \u00b7 org ${org}`
    : `\u00b7 <b>${inst}</b> \u00b7 org ${org}`;
}

function hueFor(k) {
  const need = allKinds().filter((x) => x && !declaredHue(x)).sort();
  const key = need.join('\n');
  if (_huesKey !== key) {
    _hues = {};
    const used = new Set();
    for (const x of need) {
      let h = 0; for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0;
      const start = h % FALLBACK_HUES.length;
      let idx = start;
      for (let n = 0; n < FALLBACK_HUES.length; n++) {
        const j = (start + n) % FALLBACK_HUES.length;
        if (!used.has(j)) { idx = j; break; }
      }
      used.add(idx); _hues[x] = FALLBACK_HUES[idx];
    }
    _huesKey = key;
  }
  return _hues[k] || FALLBACK_HUES[0];
}

function applyFilter() {
  render();
  statRefresh();
  if (curView === 'rel') relRender();
  // Not just a repaint: erLayout re-runs the force settle for the set that is left, so the diagram
  // closes up around what survives instead of keeping the extent of the graph it no longer is.
  erLaidOut = false;
  if (curView === 'er') erShowMaybeHeavy();
}

// The node card in this window carries no source, and cannot.
//
// It used to: `srcBlock(n)` rendered the Deluge (or the SQL) with line numbers under the calls and
// callers. On 14 August the payload handed to this window stopped carrying `source_code` - the whole
// org's source was crossing into storage for a card that shows a few dozen lines - and the commit
// that did it recorded «`source_code` appears nowhere in either graphview.js, so it was pure
// carriage». That grep was right about graphview.js and a day out of date: the renderer had moved
// into graphlogic.js the commit before. So the panel went quiet instead of the payload, and the card
// has shown no source since.
//
// It is removed rather than restored, because the strip was the right decision and both privacy
// pages now describe the smaller payload. Source is read in the side panel, which holds the folder.
//
// The rule: a grep scoped to a file name is invalidated by any refactor that moved code, and the
// only claim it can support is about that file. Verify the *behaviour*, or grep the tree.

// The clamp, named and out of the drag so it can be tested without a DOM: never below MIN, and
// never so wide that the detail beside it has less than KEEP. A container reporting no width is not
// a reason to snap the column to its minimum - that is a measurement, not a constraint - so the
// upper bound is only applied when there is a width to apply it from.
function asideWidth(want, wrapW) {
  const w = Math.max(MIN, Math.round(want));
  const max = wrapW - KEEP;
  return max > MIN ? Math.min(max, w) : w;
}

function visibleKindCount() { return nodesA.filter((id) => N[id] && passKind(N[id])).length; }

// The node and edge arrays, and a ring of starting positions for the force layout. This was
// initCanvas and it set up a canvas as well - the Visual view is gone, and what the boxed diagram
// actually needed from it was only ever this.
function initPositions() {
  nodesA = Object.keys(N);
  const es = new Set();
  Object.values(N).forEach((n) => n.calls.forEach((c) => es.add(n.id + '\u0000' + c)));
  edgesA = [...es].map((e) => { const [a, b] = e.split('\u0000'); return [a, b]; });
  seedRing(nodesA);
}

// The starting ring, sized for the list it is given rather than for the whole graph - which is what
// makes a filtered layout compact instead of a sparse copy of the unfiltered one.
//
// The scatter is a hash of the id, not Math.random(): the same set has to come out the same way
// every time, or switching a chip off and back on would rearrange a diagram the reader had already
// learnt to read. It also makes the PDF reproducible, which is worth having on its own.
function seedRing(list) {
  const R = Math.min(400, 60 + list.length * 2);
  list.forEach((id, i) => {
    const a = (i / list.length) * Math.PI * 2;
    posX[id] = Math.cos(a) * R + jitter(id, 'x');
    posY[id] = Math.sin(a) * R + jitter(id, 'y');
    vx[id] = 0; vy[id] = 0;
  });
}

function jitter(id, salt) {
  let h = 2166136261; const s = id + salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967295 - 0.5) * 40;
}

function settle(list, edges) {
  // Fruchterman-Reingold. The ideal edge length is derived from the area the drawing has to fill, so
  // the same code behaves at twenty nodes and at five hundred.
  //
  // What was here before was a hand-tuned spring model with three constants - a repulsion of 5200,
  // a rest length of 90, and a radius clamp of 120 + 3n. It looked right at about fifty nodes, which
  // is where it was tuned, and above that repulsion overwhelmed attraction and the clamp caught
  // every node on the way out: measured on a 700-node graph, **100% of the boxes ended up on the
  // clamp radius**, which is to say the diagram was a circle of boxes - and the mean edge came out
  // as long as the distance between two nodes picked at random, which is a drawing that carries no
  // information at all. That is why filtering it did not make it more readable: there was no
  // structure in it to reveal.
  //
  // Nothing here is tuned by eye. The two forces are the published ones and the only free parameter
  // is the area, which cancels out downstream - erLayout normalises the extent before drawing.
  const n = list.length;
  if (n < 2) return;
  // Typed arrays, not the posX/posY objects. This is the one O(n^2) loop in the window and it runs
  // on the main thread behind a spinner, so the cost of a string key lookup is paid n^2 * iterations
  // times: measured, moving the inner loop off the objects took a 352-node layout from 2.2s to a
  // fraction of it. The positions are read in and written back once.
  const X = new Float64Array(n), Y = new Float64Array(n), DX = new Float64Array(n), DY = new Float64Array(n);
  const idx = new Map();
  for (let i = 0; i < n; i++) { idx.set(list[i], i); X[i] = posX[list[i]] || 0; Y[i] = posY[list[i]] || 0; }
  const E = [];
  for (const [a, b] of edges) {
    const i = idx.get(a), j = idx.get(b);
    if (i !== undefined && j !== undefined && i !== j) E.push(i, j);
  }
  const area = 1000 * 1000;
  const L = Math.sqrt(area / n);          // ideal distance between two nodes
  const iter = 300;
  let t = Math.sqrt(area) / 8;            // maximum displacement, cooled linearly to zero
  const cool = t / (iter + 1);
  for (let it = 0; it < iter; it++) {
    DX.fill(0); DY.fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i], yi = Y[i];
      let ax = 0, ay = 0;
      for (let j = i + 1; j < n; j++) {
        let ex = xi - X[j], ey = yi - Y[j];
        let d2 = ex * ex + ey * ey;
        // Two nodes on the same point have no direction to push apart in, so give them one that
        // depends on which they are - a random nudge would make the layout different every time.
        if (d2 < 1e-4) { ex = jitter(list[i] + list[j], 'r'); ey = jitter(list[j] + list[i], 'r'); d2 = ex * ex + ey * ey || 1; }
        const f = (L * L) / d2;
        ax += ex * f; ay += ey * f; DX[j] -= ex * f; DY[j] -= ey * f;
      }
      DX[i] += ax; DY[i] += ay;
    }
    for (let e = 0; e < E.length; e += 2) {
      const i = E[e], j = E[e + 1];
      const ex = X[i] - X[j], ey = Y[i] - Y[j];
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
      const f = d / L;
      DX[i] -= ex * f; DY[i] -= ey * f; DX[j] += ex * f; DY[j] += ey * f;
    }
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(DX[i] * DX[i] + DY[i] * DY[i]);
      if (!d) continue;
      const s = (d < t ? d : t) / d;
      X[i] += DX[i] * s; Y[i] += DY[i] * s;
    }
    t -= cool;
  }
  for (let i = 0; i < n; i++) { posX[list[i]] = X[i]; posY[list[i]] = Y[i]; vx[list[i]] = 0; vy[list[i]] = 0; }
}

function bfsEgo() {
  egoLevel = {};
  if (scopeAll) { egoSet = null; return; }
  if (!curFocus || !N[curFocus]) { egoSet = null; return; }
  const keep = new Set([curFocus]); egoLevel[curFocus] = 0; let fr = [curFocus];
  for (let d = 0; d < egoDepth; d++) {
    const nx = [];
    fr.forEach((k) => { const n = N[k]; if (!n) return; [...(n.calls || []), ...(n.called_by || [])].forEach((nb) => { if (N[nb] && !keep.has(nb)) { keep.add(nb); egoLevel[nb] = d + 1; nx.push(nb); } }); });
    fr = nx; if (!fr.length) break;
  }
  egoSet = keep;
}

function computeMaxDepth() {
  maxEgoDepth = 1;
  if (!curFocus || !N[curFocus]) return;
  const keep = new Set([curFocus]); let fr = [curFocus], lvl = 0;
  while (fr.length) {
    const nx = [];
    fr.forEach((k) => { const n = N[k]; if (!n) return; [...(n.calls || []), ...(n.called_by || [])].forEach((nb) => { if (N[nb] && !keep.has(nb)) { keep.add(nb); nx.push(nb); } }); });
    if (nx.length) lvl++;
    fr = nx;
  }
  maxEgoDepth = Math.max(1, lvl);
}

function statCounts(set) {
  // Folded boxes are out of the count for the same reason they are out of `erCovers` - see there.
  const gone = erHiddenSet();
  const inSet = (id) => (!set || set.has(id)) && !gone.has(id);
  const nodes = Object.keys(N).filter((id) => inSet(id) && passKind(N[id]));
  const keep = new Set(nodes);
  let e = 0;
  Object.values(N).forEach((n) => { if (!keep.has(n.id)) return; n.calls.forEach((c) => { if (keep.has(c)) e++; }); });
  return { n: nodes.length, e };
}

function statRefresh() { if (curFocus) egoStat(); else graphStat(); }

function setDepth(d) {
  egoDepth = Math.max(1, Math.min(maxEgoDepth, d));
  updateDepthUI(); bfsEgo(); egoStat(); erLaidOut = false;
  if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
}

function clearFocus() {
  // Back to the pristine whole-graph view - the state you get opening via "Schema".
  curFocus = null; scopeAll = false; egoSet = null; egoLevel = {}; erCut = new Map();
  updateScopeUI(); erLaidOut = false;
  graphStat();
  if (curView === 'er') erShow(); else if (curView === 'rel') relRender();
}

function erPick(a, b) { erSelEdge = (erSelEdge === ekey(a, b)) ? null : ekey(a, b); erRender(); }

function erClearPick() { if (erSelEdge) { erSelEdge = null; erRender(); } }

/** Which boxes `from` can still get to, over a given set.
 *
 * The set is a parameter because the two callers ask different questions. **Offering** a fold is
 * about the drawing in front of the reader - «this arc would take four boxes away» must count the
 * four they can see - so it walks `erIds`. **Applying** a fold is about a decision they already
 * made, and a decision cannot be allowed to depend on what happens to be drawn now: it walks the
 * whole graph, so the branch stays away when the depth changes and takes with it anything that only
 * ever hung off it.
 *
 * Defaulted rather than passed at both sites: the offer is the ordinary case and reads better
 * without an argument, and the one caller that means something else says so.
 */
function erReach(from, skip, base = erIds) {
  const inPlay = new Set(base);
  const adj = new Map();
  edgesA.forEach(([a, b]) => {
    if (!inPlay.has(a) || !inPlay.has(b)) return;
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  });
  const seen = new Set([from]), q = [from];
  while (q.length) {
    const c = q.pop();
    for (const nb of (adj.get(c) || [])) if (!seen.has(nb) && !skip.has(nb)) { seen.add(nb); q.push(nb); }
  }
  return seen;
}

function erWouldGo(from, away, gone, base = erIds) {
  const before = erReach(from, gone, base);
  if (!before.has(away)) return new Set();
  const after = erReach(from, new Set([...gone, away]), base);
  const out = new Set();
  before.forEach((id) => { if (!after.has(id)) out.add(id); });
  return out;
}

/** What the reader has folded away, and it stays away.
 *
 * **A fold survives a relayout.** Taking a branch off the drawing is a decision; changing the depth
 * is not a request to bring it back. Chosen deliberately over the other defensible answer - that a
 * relayout is a fresh sheet - because the arrangement file already assumes this one: it saves
 * `folds` beside `positions`, which reads as folds belonging to what the reader arranged rather than
 * to one drawing.
 *
 * Before, the fold was *remembered and stopped taking effect*, which is neither answer. The cascade
 * below is computed over `erIds`, and after a relayout the folded box is no longer in it - the
 * layout had excluded it using this very set - so `erWouldGo` found nothing to take away and
 * returned empty. Three things were then true at once: the fold was still recorded, it hid nothing,
 * and the box counted as visible again, while the badge said otherwise only because nothing had
 * refreshed it. Which number a surface reported depended on when it asked.
 *
 * So the box the reader clicked goes unconditionally, and the cascade - everything that hung off it
 * and nothing else - is still computed from the drawing as it stands. The order matters: `away` is
 * added **after** `erWouldGo`, because adding it first would make the reachability walk skip it and
 * answer that nothing was ever attached.
 */
function erHiddenSet() {
  if (!erCut.size) return new Set();
  return new Set(erFoldedBy().keys());
}

function erWouldShowSet(k) {
  const before = erHiddenSet();
  const keep = erCut;
  erCut = new Map(erCut); erCut.delete(k);
  const after = erHiddenSet();
  erCut = keep;
  const out = new Set();
  before.forEach((id) => { if (!after.has(id)) out.add(id); });
  return out;
}

function erWouldShow(k) { return erWouldShowSet(k).size; }

function erTipIds(set, first) {
  const ids = [...set];
  const nameOf = (id) => (N[id] ? label(N[id]) : id);
  const all = (ids.includes(first) ? [first] : [])
    .concat(ids.filter((id) => id !== first).sort((x, y) => nameOf(x).localeCompare(nameOf(y))));
  return { shown: all.slice(0, TIP_MAX), more: Math.max(0, all.length - TIP_MAX) };
}

function erTipText(set, first, back) {
  const { shown, more } = erTipIds(set, first);
  return (back ? MSG.backTip : MSG.cutTip)(shown.map((id) => (N[id] ? label(N[id]) : id)), more);
}

// A short wait, because a pointer crossing a rim of twenty marks on its way somewhere else has not
// asked about any of them. Long enough not to flash, shorter than the browser's own second.
function erTipOn(anchor, get) {
  // `_tipT` is declared in graphview.js: classic scripts on one page share a scope, and both
  // are on graphview.html and nowhere else. The wait moved here with the code; the sentence
  // above it did not, and sat for ten days in the other file over an unrelated function.
  clearTimeout(_tipT);
  const { set, first, back } = get();
  erFlag(set);                         // the outline is immediate: it answers about what is on screen
  _tipT = setTimeout(() => erTipShow(anchor, set, first, back), 120);
}

/** Which fold took each box away - one walk, shared by everything that asks about folds.
 *
 * `erHiddenSet` and `erUnhide` used to run the same loop twice, separately, and the day one of them
 * learnt that a fold survives a relayout the other did not: the set said the box was away and the
 * unhide could not find who had taken it, so a fold became impossible to undo. A fold that will not
 * come back is worse than one that does not stick.
 */
function erFoldedBy() {
  const gone = new Set(), by = new Map();
  erCut.forEach((away, k) => {
    const [a, b] = k.split('\u0000');
    if (!N[a] || !N[b]) return;
    const from = away === a ? b : a;
    if (gone.has(from) || gone.has(away)) return;
    // Over the whole graph, not over what is drawn: see `erReach`.
    const went = erWouldGo(from, away, gone, nodesA);
    went.add(away);
    went.forEach((x) => { gone.add(x); if (!by.has(x)) by.set(x, k); });
  });
  return by;
}

function erUnhide(id) {
  for (let guard = erCut.size; guard >= 0; guard--) {
    const culprit = erFoldedBy().get(id);
    if (culprit === undefined) return;
    erCut.delete(culprit);
  }
}

function erToggleCut(a, b, away) {
  const k = ekey(a, b);
  const before = erHiddenSet().size;
  if (erCut.has(k)) erCut.delete(k);
  else if (away) erCut.set(k, away);
  else return;
  const after = erHiddenSet().size;
  erRender();                             // a drawing filter: nothing is laid out again
  // And the two numbers beside the drawing. `erRender` redraws the boxes; it does not re-run the
  // counts, so folding thirteen boxes away left the tab badge and the status line both saying 18
  // while five were drawn - and the hint on the same screen said «13 boxes off the diagram». The
  // note in `erCovers` has described exactly that for months; teaching `entityBreakdown` to skip
  // what is folded made the *computation* right and changed nothing, because nobody ran it again.
  // Found by driving the window rather than reading it.
  graphStat();
  if (after !== before) erHint(after > before ? MSG.folded(after - before) : MSG.unfolded(before - after));
}

function linkedUnderFilter() {
  const linked = new Set();
  edgesA.forEach(([a, b]) => {
    if (erCandidate(a) && erCandidate(b)) { linked.add(a); linked.add(b); }
  });
  return linked;
}

function collideBoxes(list, margin, pinned) {
  if (list.length < 2) return;
  const isPin = pinned && pinned.size ? (id) => pinned.has(id) : () => false;
  let cw = 0, ch = 0;
  list.forEach((id) => { const p = erPos[id]; if (p) { cw = Math.max(cw, p.w); ch = Math.max(ch, p.h); } });
  cw += margin; ch += margin;
  const snapshot = () => list.map((id) => ({ x: erPos[id].x, y: erPos[id].y }));
  const spanOf = () => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    list.forEach((id) => {
      const p = erPos[id];
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h);
    });
    return (x1 - x0) * (y1 - y0);
  };
  const PASSES = 400;
  let best = null;
  for (let pass = 0; pass < PASSES; pass++) {
    const start = snapshot(), area = spanOf();
    // Insertion order is `list` order, so the cells - and therefore the whole pass - are
    // deterministic: the same set has to come out the same way every time, or the PDF stops being
    // reproducible and a chip switched off and back on rearranges a diagram the reader had learnt.
    const cells = new Map();
    list.forEach((id) => {
      const p = erPos[id];
      const key = Math.floor((p.x + p.w / 2) / cw) + ',' + Math.floor((p.y + p.h / 2) / ch);
      const bucket = cells.get(key);
      if (bucket) bucket.push(id); else cells.set(key, [id]);
    });
    let hits = 0, moved = false;
    const damp = 0.55 + 0.45 * (1 - pass / PASSES);
    for (const [key, bucket] of cells) {
      const comma = key.indexOf(',');
      const cx = +key.slice(0, comma), cy = +key.slice(comma + 1);
      const near = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const other = cells.get((cx + dx) + ',' + (cy + dy));
        if (other) for (const id of other) near.push(id);
      }
      for (const a of bucket) for (const b of near) {
        if (a >= b) continue;             // each pair once, and never a box against itself
        const A = erPos[a], B = erPos[b];
        const dx = (B.x + B.w / 2) - (A.x + A.w / 2), dy = (B.y + B.h / 2) - (A.y + A.h / 2);
        const ox = (A.w + B.w) / 2 + margin - Math.abs(dx), oy = (A.h + B.h) / 2 + margin - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        // `ox` carries the margin, so the boxes themselves overlap only once it exceeds it. Sitting
        // inside the margin is close, not hidden, and close is not what this counts.
        if (ox > margin && oy > margin) hits++;
        const pa = isPin(a), pb = isPin(b);
        if (pa && pb) continue;           // theirs to keep: counted above, and left where they are
        moved = true;
        const share = pa || pb ? 2 : 1;   // one side cannot move, so the other takes the whole push
        if (ox < oy) { const p = (dx < 0 ? -1 : 1) * ox / 2 * damp * share; if (!pa) A.x -= p; if (!pb) B.x += p; }
        else { const p = (dy < 0 ? -1 : 1) * oy / 2 * damp * share; if (!pa) A.y -= p; if (!pb) B.y += p; }
      }
    }
    if (!best || hits < best.hits || (hits === best.hits && area < best.area)) best = { hits, area, snap: start };
    if (!moved) break;
  }
  list.forEach((id, i) => { erPos[id].x = best.snap[i].x; erPos[id].y = best.snap[i].y; });
}

function erSideOf(A, B) {
  const acx = A.x + A.w / 2, acy = A.y + A.h / 2, bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
  if (Math.abs(bcy - acy) > Math.abs(bcx - acx)) return bcy >= acy ? 'b' : 't';
  return bcx >= acx ? 'r' : 'l';
}

function erSideCounts(pairs) {
  const c = new Map();
  const bump = (id, side) => {
    const e = c.get(id) || { t: 0, b: 0, l: 0, r: 0 };
    e[side]++; c.set(id, e);
  };
  pairs.forEach(([a, b]) => {
    const A = erPos[a], B = erPos[b];
    if (!A || !B) return;
    bump(a, erSideOf(A, B)); bump(b, erSideOf(B, A));
  });
  return c;
}

function erFitToArcs(pairs) {
  const counts = erSideCounts(pairs);
  counts.forEach((c, id) => {
    const p = erPos[id];
    if (!p) return;
    p.w = Math.max(p.w, (Math.max(c.t, c.b) + 1) * ARC_GAP);
    p.h = Math.max(p.h, (Math.max(c.l, c.r) + 1) * ARC_GAP);
  });
}

function erComputeSlots(pairs) {
  const groups = new Map();
  const push = (id, side, key, along) => {
    const k = id + '\u0001' + side;
    const g = groups.get(k);
    if (g) g.push({ key, along }); else groups.set(k, [{ key, along }]);
  };
  pairs.forEach(([a, b]) => {
    const A = erPos[a], B = erPos[b];
    if (!A || !B) return;
    const sa = erSideOf(A, B), sb = erSideOf(B, A), key = ekey(a, b);
    push(a, sa, key, (sa === 't' || sa === 'b') ? B.x + B.w / 2 : B.y + B.h / 2);
    push(b, sb, key, (sb === 't' || sb === 'b') ? A.x + A.w / 2 : A.y + A.h / 2);
  });
  const slots = new Map();
  groups.forEach((list, k) => {
    const id = k.slice(0, k.indexOf('\u0001'));
    // by where the other end lies, then by key so the order cannot depend on iteration accidents
    list.sort((p, q) => p.along - q.along || (p.key < q.key ? -1 : 1));
    list.forEach((e, i) => slots.set(e.key + '\u0001' + id, { i, n: list.length }));
  });
  return slots;
}

function erEdgePoints(A, B, sa, sb) {
  // A share of the side rather than its middle. (i+1)/(n+1) keeps the first and last off the corners
  // and gives a lone arc exactly the middle, which is where it used to be.
  const fa = sa ? (sa.i + 1) / (sa.n + 1) : 0.5, fb = sb ? (sb.i + 1) / (sb.n + 1) : 0.5;
  const acx = A.x + A.w / 2, acy = A.y + A.h / 2;
  const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
  if (Math.abs(bcy - acy) > Math.abs(bcx - acx)) {
    const down = bcy >= acy;
    return [A.x + A.w * fa, down ? A.y + A.h : A.y, B.x + B.w * fb, down ? B.y : B.y + B.h, 'v'];
  }
  const right = bcx >= acx;
  return [right ? A.x + A.w : A.x, A.y + A.h * fa, right ? B.x : B.x + B.w, B.y + B.h * fb, 'h'];
}

function erMarkD(S, other, slot) {
  const side = erSideOf(S, other);
  const along = (side === 't' || side === 'b') ? S.w : S.h;
  const gap = along / ((slot ? slot.n : 1) + 1);
  return Math.max(MARK_MIN, Math.min(MARK_D, gap - 1));
}

function erNodeCol(n) {
  return n ? NSCOL(KINDOF(n)) : '';
}

function erInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return '#0f172a';
  const v = parseInt(m[1], 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    .map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return (0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]) > 0.45 ? '#0f172a' : '#ffffff';
}

function erResize() {
  if (!erIds.length) return;
  erIds.forEach((id) => {
    const p = erPos[id];
    if (!p) return;
    const s = erBoxSize(N[id]);
    p.w = s.w; p.h = s.h;
  });
  erFitToArcs(edgesAmong(erIds));
  // Deliberately not pinned, unlike the layout above: this overlap was made by the labels changing
  // size, not by the reader, and a box hidden under another is a correctness problem whoever caused
  // it. What the reader placed is still never placed *again* - only nudged clear of what grew.
  collideBoxes(erIds, erP.margin);
  erRender();
}

// Canonical on purpose: keys sorted, coordinates whole pixels, one box to a line. Two saves of the
// same arrangement have to produce the same bytes, or "you can diff two of these" is a claim the
// format does not keep - and sub-pixel jitter on every line is what it would produce instead.
function serializeArrangement(st) {
  const q = JSON.stringify;
  const moved = new Set(st.moved || []);
  const ids = Object.keys(st.positions || {}).sort();
  const pos = ids.map((id) => `    ${q(id)}: [${Math.round(st.positions[id].x)}, ${Math.round(st.positions[id].y)}, ${moved.has(id) ? 1 : 0}]`);
  const folds = (st.folds || []).map((f) => `    [${q(f[0])}, ${q(f[1])}, ${q(f[2])}]`).sort();
  const wrap = (lines) => (lines.length ? '\n' + lines.join(',\n') + '\n  ' : '');
  return [
    '{',
    `  "zoost": "arrangement",`,
    `  "v": ${ARR_V},`,
    `  "app": ${q(st.app)},`,
    `  "kind": ${q(st.kind)},`,
    `  "workspace": ${q(st.workspace || '')},`,
    `  "context": {"focus": ${q(st.focus || '')}, "depth": ${st.depth | 0}, `
      + `"emphasis": ${q(st.emphasis || '')}, "names": ${q(st.names || '')}, "arcs": ${st.arcs | 0}},`,
    `  "positions": {${wrap(pos)}},`,
    `  "folds": [${wrap(folds)}],`,
    `  "saved_at": ${q(st.savedAt || '')}`,
    '}',
    '',
  ].join('\n');
}

// Declared keys only, and every number checked. A file is the one thing here that arrives from
// outside the extension, so it is read the way `erKnownParams` reads a stored blob: what is not
// recognised is dropped rather than trusted, and a malformed one produces a sentence rather than an
// exception nobody sees.
function parseArrangement(text, cap) {
  let o;
  try { o = JSON.parse(text); } catch (e) { return { ok: false, reason: 'notJson' }; }
  if (!o || typeof o !== 'object' || o.zoost !== 'arrangement') return { ok: false, reason: 'notOurs' };
  if (!(o.v <= ARR_V)) return { ok: false, reason: 'newer' };
  const src = (o.positions && typeof o.positions === 'object') ? o.positions : null;
  if (!src) return { ok: false, reason: 'noPositions' };
  const positions = {}, moved = [];
  let n = 0;
  for (const id of Object.keys(src)) {
    const p = src[id];
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (cap && ++n > cap) return { ok: false, reason: 'tooBig' };
    positions[id] = { x, y };
    if (p[2]) moved.push(id);
  }
  if (!Object.keys(positions).length) return { ok: false, reason: 'noPositions' };
  const ctx = (o.context && typeof o.context === 'object') ? o.context : {};
  const folds = Array.isArray(o.folds) ? o.folds.filter((f) => Array.isArray(f) && f.length === 3
    && f.every((s) => typeof s === 'string')) : [];
  return { ok: true, file: {
    v: o.v | 0,
    app: typeof o.app === 'string' ? o.app : '',
    kind: typeof o.kind === 'string' ? o.kind : '',
    workspace: typeof o.workspace === 'string' ? o.workspace : '',
    focus: typeof ctx.focus === 'string' ? ctx.focus : '',
    depth: Number.isFinite(ctx.depth) ? ctx.depth | 0 : 0,
    emphasis: typeof ctx.emphasis === 'string' ? ctx.emphasis : '',
    names: typeof ctx.names === 'string' ? ctx.names : '',
    arcs: Number.isFinite(ctx.arcs) ? ctx.arcs | 0 : 0,
    savedAt: typeof o.saved_at === 'string' ? o.saved_at : '',
    positions, moved, folds,
  } };
}

// The graph is the truth and the file is an intention applied to it, so every id is sorted into one
// of three piles and every loss is a number somebody is told. Nothing is guessed: a box that was
// renamed is a box that went and a box that arrived, because a position moved onto a renamed box
// would put it where a *different* one used to be - which misstates the topology the reader built.
// Between losing work and inventing meaning, this loses the work.
function matchArrangement(file, drawn) {
  const here = new Set(drawn);
  const moved = new Set(file.moved || []);
  const matched = [], fresh = [], stale = [];
  for (const id of Object.keys(file.positions)) (here.has(id) ? matched : stale).push(id);
  for (const id of drawn) if (!file.positions[id]) fresh.push(id);
  return { matched, fresh, stale, pinned: matched.filter((id) => moved.has(id)) };
}

function erBoxUnder(t) { return t && t.closest ? t.closest('.erbox') : null; }

function erCovers(id) {
  // How many boxes this one is drawn over. The boxes themselves, not their margins: sitting close is
  // not hiding anything, and it is not what the reader is being told about.
  const A = erPos[id];
  if (!A) return 0;
  // What the reader has folded away is not on the drawing, so it is not counted, not covered and not
  // in the badge. `erFit` and the print handler already skip it - «Both skip what erHiddenSet hides
  // now», says docs/diagrams.md - and that was done for two readers of five. Fold a branch with a
  // `-` mark and the hint said «3 boxes off the diagram» while the status line above it and the tab
  // badge beside it went on counting them: the window stating in one line that three boxes went and
  // in another that they are still there. All five read it now - this one, `erFit`, the print
  // handler, `erVisibleIds` behind the badge, and `entityBreakdown` behind the status line, which
  // was the last and was found by reading this paragraph and checking whether it was still true.
  const gone = erHiddenSet();
  if (gone.has(id)) return 0;
  let k = 0;
  erIds.forEach((other) => {
    if (other === id || gone.has(other)) return;
    const B = erPos[other];
    if (!B) return;
    const ox = (A.w + B.w) / 2 - Math.abs((B.x + B.w / 2) - (A.x + A.w / 2));
    const oy = (A.h + B.h) / 2 - Math.abs((B.y + B.h / 2) - (A.y + A.h / 2));
    if (ox > 0 && oy > 0) k++;
  });
  return k;
}

function erConcentric() { return !!(curFocus && egoSet); }

function erPinnedNow(held) {
  return new Set(erPinOnly ? Object.keys(held).filter((id) => erPinOnly.has(id)) : Object.keys(held));
}

function erArrWorkspace() {
  const ws = (DATA && DATA.workspace) || {};
  return (ws.instance || '') + '/' + (ws.org || '');
}

function erArrState() {
  const pos = {};
  erIds.forEach((id) => { const p = erPos[id]; if (p) pos[id] = { x: p.x, y: p.y }; });
  const folds = [];
  // A NUL joins the two ids of a fold, and it is written as an escape rather than typed: as a
  // raw byte it made this file *binary* to every ordinary tool - `file` called it data and
  // `grep` skipped all 31KB of it in silence, which is how a review of the shipped code came
  // to miss it. Same value, same behaviour, and readable by everything.
  erCut.forEach((away, k) => { const [a, b] = k.split('\u0000'); folds.push([a, b, away]); });
  return {
    app: APP, kind: (DATA && DATA.kind) || '', workspace: erArrWorkspace(),
    focus: curFocus || '', depth: egoDepth, emphasis: erEmph, names: nameMode,
    arcs: edgesAmong(erIds).length,
    positions: pos, moved: [...erRaised.keys()], folds,
    savedAt: new Date().toISOString(),
  };
}

function erArrName() {
  const ws = (DATA && DATA.workspace) || {};
  return `arrangement-${ws.instance || 'org'}-${(DATA && DATA.kind) || 'diagram'}-${curFocus || 'whole'}.json`;
}

function erApplyArrangement(file) {
  if ((file.app && file.app !== APP) || (file.kind && file.kind !== ((DATA && DATA.kind) || ''))) {
    erHint(MSG.arrWrongKind(file.kind), true); return;
  }
  // The workspace before the ids, because it is the reason and they are only the symptom. Where a
  // diagram is keyed by names rather than by ids the same file is a gift - arrange against one org,
  // read it in another - so this refuses only when nothing came back, and otherwise says it plainly
  // and carries on.
  const fileWs = (file.workspace || '').split('/')[0];
  const hereWs = erArrWorkspace().split('/')[0];
  const elsewhere = !!(file.workspace && file.workspace !== erArrWorkspace());
  const m = matchArrangement(file, erIds);
  if (!m.matched.length) {
    erHint(elsewhere ? MSG.arrWrongWorkspace(fileWs, hereWs) : MSG.arrNothingMatched, true); return;
  }
  // Positions first: every box the file knows goes back where it was, whether or not it was chosen
  // by hand. What the flag decides is only who may be nudged aside to make room for a newcomer.
  erHeld = {};
  m.matched.forEach((id) => {
    const p = file.positions[id];
    erHeld[id] = { x: p.x, y: p.y };
    if (erPos[id]) { erPos[id].x = p.x; erPos[id].y = p.y; }
  });
  erArranged = true;
  erPinOnly = new Set(m.pinned);
  erRaised = new Map(); erRaiseN = 0;
  m.pinned.forEach((id) => erRaised.set(id, ++erRaiseN));
  // The folds the file carried, and only where the arc it names is still there: a fold replayed onto
  // a branch that has changed hides something the reader never chose to hide.
  erCut = new Map();
  const known = new Set(erIds);
  let foldsLost = 0;
  file.folds.forEach(([a, b, away]) => {
    if ((!known.has(a) && !known.has(b))
        || !edgesA.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) { foldsLost++; return; }
    erCut.set(ekey(a, b), away);
  });
  erLaidOut = false;
  erShow();
  // Framed, not restored: where the reader was looking is not part of what they built, but a drawing
  // they cannot see is not an arrangement either.
  erFit();
  const arcs = edgesAmong(erIds).length;
  const lost = m.stale.length || foldsLost || elsewhere || (file.arcs && arcs !== file.arcs);
  erHint(MSG.arrLoaded(m.matched.length, m.fresh.length, m.stale.length)
    + (elsewhere ? MSG.arrOtherWorkspace(fileWs) : '')
    + (foldsLost ? MSG.arrFolds(foldsLost) : '')
    + (file.arcs && arcs !== file.arcs ? MSG.arrArcs(arcs - file.arcs) : ''), !!lost);
}
