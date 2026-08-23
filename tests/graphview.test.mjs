/*
 * graphview.test.mjs — the three places the diagrams turn measurements into a drawing: the fit that
 * chooses a scale, the concentric radius, and the pass that stops one box being drawn over another.
 *
 * The first section is erFit().
 *
 * Every case here comes from one investigation, and the investigation's first two conclusions were
 * both wrong, which is why the cover is written the way it is rather than around a symptom.
 *
 * What was actually found: `const vw = $('v-er').clientWidth || 1000, vh = ... || 700` invented a
 * viewport whenever the panel measured 0 - and 0 is a real state, because a `.view` without `.on` is
 * `display:none`. Measured on the sample schema at 1280x800 the panel is 1280x583, the true fit is
 * 1.018 centred at x=358, and the invented pair gives 1.255 at x=153: a diagram 23% too big.
 *
 * What was *not* found, said here because a test file is where a coverage claim can be checked: no
 * reachable path hit that fallback (all four call sites are guarded by `curView === 'er'`, measured
 * by instrumenting erFit across all six rendered shots), and no stale scale was ever observed - the
 * panel does change height at a fixed window size, 542 -> 512 -> 482 in the wiring shot, but a fit
 * follows each time because the handlers update the header before calling erShow. So this file holds
 * the arithmetic and the refusal to guess. It does not hold a claim about re-fitting on reflow,
 * because none was proven.
 *
 * The two apps are one case each, deliberately rather than by a loop over a list: the twins carry
 * this function word for word, and a divergence in either is a red mark on that app's name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceFn, sliceConst, read, load } from './slice.mjs';
import vm from 'node:vm';

/** A named function out of the graph window, wherever it now lives.
 *
 * Everything both products compute identically and that touches no DOM moved into graphlogic.js, so
 * a test that named graphview.js would have gone red for a file split rather than for a defect. It
 * still throws when neither file has it: a rename must not quietly drop the cover, which is the one
 * property sliceFn is there for.
 */
function gfn(app, name) {
  try { return sliceFn(`apps/${app}/graphlogic.js`, name); }
  catch { return sliceFn(`apps/${app}/graphview.js`, name); }
}

/** erFit() lifted out of an app's graph window, over a panel of a stated size.
 *
 * The globals are the ones the function reads. `state` is the context object itself, so an
 * assignment inside the slice is visible on it afterwards - that is how the assertions read back
 * erScale without the function returning anything, which it does not.
 */
function fitter(app, panel, geom = { maxX: 553, maxY: 494 }, hidden = []) {
  let applied = 0;
  const state = {
    erMaxX: geom.maxX, erMaxY: geom.maxY, erIds: geom.ids || [], erPos: geom.pos || {},
    // Where the drawing starts. It was framed from the origin, which is only the same thing while
    // every box sits right of and below it - false the moment a reader drags one, and the reported
    // symptom was Fit resizing without centring.
    erMinX: geom.minX || 0, erMinY: geom.minY || 0,
    // A folded box keeps its position, so the fit has to be told what is not drawn. Stubbed rather
    // than lifted: erHiddenSet reaches for the cuts, the edges and every node, and what this file is
    // about is the arithmetic that turns a measurement into a scale.
    erHiddenSet: () => new Set(hidden),
    // Values nothing would ever compute, so "untouched" is distinguishable from "recomputed".
    erScale: -1, erTx: -1, erTy: -1, erUserMoved: true,
    $: () => ({ clientWidth: panel.w, clientHeight: panel.h }),
    erApply: () => { applied++; },
  };
  const ctx = vm.createContext(state);
  vm.runInContext(gfn(app, 'erFit'), ctx);
  return { fit: () => vm.runInContext('erFit()', ctx), state, applied: () => applied };
}

// The measured numbers from the render: the sample schema draws 553x494 of boxes into a 1280x583
// panel. `pad` is 40 a side, so the scale is min((1280-80)/553, (583-80)/494) = min(2.170, 1.018).
const REAL = { w: 1280, h: 583 };
const REAL_SCALE = 1.0182;

for (const app of ['crm', 'analytics']) {
  test(`${app}: a box folded away does not size the frame`, () => {
    // Folding is a filter on the drawing and not on the layout - a folded box keeps its position, so
    // that a fold composes with an arrangement - and this walk reads positions. Left alone it framed
    // the window for boxes nobody can see: fold a branch at the far edge and Fit zooms out to it.
    const geom = { maxX: 553, maxY: 494, ids: ['near', 'far'],
                   pos: { near: { x: 0, y: 0, w: 553, h: 494 }, far: { x: 2000, y: 0, w: 190, h: 80 } } };
    const wide = fitter(app, REAL, geom); wide.fit();
    const folded = fitter(app, REAL, geom, ['far']); folded.fit();
    assert.ok(wide.state.erScale < 0.6, `the far box is meant to drag the fit down, it gave ${wide.state.erScale}`);
    assert.ok(Math.abs(folded.state.erScale - REAL_SCALE) < 0.001,
      `a folded box still sized the frame: ${folded.state.erScale} rather than ${REAL_SCALE}`);
  });
}

for (const app of ['crm', 'analytics']) {
  test(`${app}: a measured panel gives the measured fit`, () => {
    const f = fitter(app, REAL);
    f.fit();
    assert.ok(Math.abs(f.state.erScale - REAL_SCALE) < 0.001,
      `expected ~${REAL_SCALE} from a ${REAL.w}x${REAL.h} panel, got ${f.state.erScale}`);
    // Centred: the leftover space either side of the scaled drawing, halved.
    assert.ok(Math.abs(f.state.erTx - (REAL.w - 553 * f.state.erScale) / 2) < 0.5, 'erTx centres');
    assert.ok(Math.abs(f.state.erTy - (REAL.h - 494 * f.state.erScale) / 2) < 0.5, 'erTy centres');
    assert.equal(f.applied(), 1, 'a fit applies the transform once');
    assert.equal(f.state.erUserMoved, false, 'a fit is the view nobody has moved yet');
  });

  test(`${app}: a panel that measures 0 is not a viewport of 1000x700`, () => {
    // The regression this file exists for. Named as the wrong answer rather than as "no answer", so
    // that reintroducing the fallback fails here and not in a screenshot three commits later.
    const invented = Math.min((1000 - 80) / 553, (700 - 80) / 494);
    for (const panel of [{ w: 0, h: 0 }, { w: 1280, h: 0 }, { w: 0, h: 583 }]) {
      const f = fitter(app, panel);
      f.fit();
      assert.notEqual(f.state.erScale, invented,
        `${panel.w}x${panel.h}: invented a ${invented.toFixed(4)} scale out of a 1000x700 viewport`);
      assert.equal(f.state.erScale, -1, `${panel.w}x${panel.h}: erScale was written from nothing`);
      assert.equal(f.state.erTx, -1, `${panel.w}x${panel.h}: erTx was written from nothing`);
      assert.equal(f.state.erTy, -1, `${panel.w}x${panel.h}: erTy was written from nothing`);
      assert.equal(f.applied(), 0, `${panel.w}x${panel.h}: drew a transform with nothing to measure`);
      assert.equal(f.state.erUserMoved, true,
        `${panel.w}x${panel.h}: a fit that did not happen must not claim the view is unmoved`);
    }
  });

  test(`${app}: the guessed viewport is gone from the source`, () => {
    // The assertions above run a slice; this one reads the file, because the defect was a literal
    // and a literal is what a careless edit puts back. Comment lines are dropped first: the fix's
    // own comment quotes the expression it removed, and the first version of this test failed on it
    // - a check that cannot tell code from prose about code would have to be answered by rewording
    // the explanation, which is the wrong way round.
    const src = read(`apps/${app}/graphview.js`)
      .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    assert.ok(!/clientWidth\s*\|\|\s*\d/.test(src), 'clientWidth || <number> is back in graphview.js');
    assert.ok(!/clientHeight\s*\|\|\s*\d/.test(src), 'clientHeight || <number> is back in graphview.js');
  });

  test(`${app}: the ceiling is a default the reader can raise, and it is read as one`, () => {
    // The measured 400 is the built-in value, not the rule: what is being traded is the reader's own
    // patience against how much of the graph they get. Three things have to hold for that to be true
    // rather than decorative, and each has been wrong at some point in a setting on this page.
    const gv = read(`apps/${app}/graphview.js`), oj = read(`apps/${app}/options.js`);
    const oh = read(`apps/${app}/options.html`);
    // it is read from storage, and the predicate reads the variable rather than the constant
    assert.ok(/const drawable = \(n\) => n <= drawMax;/.test(gv),
      'the ceiling predicate reads the built-in constant, so the setting cannot move it');
    assert.ok(/erDrawMax/.test(gv), 'the graph window never reads the setting');
    // it is its own key: erSaveParams writes the whole erParams object whenever a slider moves, so a
    // ceiling parked inside it would be dropped silently on the next drag of Box spacing
    // Named precisely, because the first version of this line read "erParams within 80 characters of
    // drawMax" and failed on the correct code: the two keys sit side by side in one set() call, which
    // is the point. What must hold is that the erParams object carries nothing but the layout values.
    // The intent, not the shape. This read `erParams: { current: lay }` literally and went red the
    // day that write became a merge - which is what stops the settings page erasing `kind` and
    // `mode`, and is more correct rather than less. What must hold is that the ceiling is its own
    // top-level key and is not parked inside the layout object.
    // The write itself, whatever it is called. `saveLay` used to call `storage.local.set({...})`
    // directly and now hands its object to `saveKeys`, the one writer that moves a mark only when
    // the write happened - and this line searched for the old spelling, found nothing, and asserted
    // over an empty string. Both spellings, and it fails loudly when neither is there.
    const from = oj.indexOf('saveLay');
    const at = Math.min(...[oj.indexOf('storage.local.set({', from), oj.indexOf('saveKeys({', from)]
      .filter((i) => i >= 0).concat([Infinity]));
    assert.ok(Number.isFinite(at), 'saveLay writes nothing that this test can find');
    const set = oj.slice(at);
    assert.match(set.slice(0, 200), /erDrawMax: drawMax/, 'the ceiling is not written as its own key');
    const inParams = set.slice(set.indexOf('erParams:'), set.indexOf('erDrawMax:'));
    assert.ok(!/drawMax/i.test(inParams),
      'the ceiling is parked inside erParams, where a slider drag would drop it');
    assert.ok(/erDrawMax: drawMax/.test(oj), 'the ceiling is not stored under a key of its own');
    // and the field is bounded, because a number input accepts whatever is typed into it
    assert.ok(/id="pDrawMax"[^>]*min="\d+"[^>]*max="\d+"/.test(oh),
      'the ceiling field has no bounds, so 0 refuses every diagram and a huge value hangs the window');
    assert.ok(/Math\.min\(hi, Math\.max\(lo, raw\)\)/.test(oj),
      'the typed value is trusted rather than clamped to the field own bounds');
  });

  test(`${app}: the scale stays inside its clamp`, () => {
    // 0.02 and 1.4 are the floor and the ceiling in the shipped expression. A window narrower than
    // the padding would otherwise produce a negative scale, which draws the diagram mirrored.
    const tiny = fitter(app, { w: 90, h: 90 });
    tiny.fit();
    assert.equal(tiny.state.erScale, 0.02, 'a panel smaller than its own padding floors at 0.02');
    const huge = fitter(app, { w: 4000, h: 4000 }, { maxX: 100, maxY: 100 });
    huge.fit();
    assert.equal(huge.state.erScale, 1.4, 'a small diagram in a large panel is not magnified past 1.4');
  });

  test(`${app}: an empty diagram does not divide by zero`, () => {
    const f = fitter(app, REAL, { maxX: 0, maxY: 0 });
    f.fit();
    assert.ok(Number.isFinite(f.state.erScale) && f.state.erScale > 0,
      `nothing to draw gave ${f.state.erScale}`);
  });
}

/* ---------------------------------------------------------------------------------------------
 * The concentric radius. `ringR = max(L * erP.ring, needed)` made a ring the same size for eight
 * boxes as for eighty, and erFit then scaled the drawing down to fit a circle that was mostly
 * empty. Measured on the lifted layout, old formula against the derived one - the fill column is
 * the share of the bounding box the boxes actually occupy, which is the defect stated as a number:
 *
 *     levels     old extent   fill      derived     fill
 *     1+1        190x484     26.4%     190x164     78.0%
 *     1+3        917x712      9.0%     416x300     47.2%
 *     1+8       1030x904     16.2%     642x583     40.2%
 *     1+12      1361x1253    12.9%     785x862     32.5%
 *     1+30      3102x3019     5.6%    1655x1666    19.0%
 *     1+3+4     1870x1762     3.9%     716x608     29.4%
 *
 * Which of these actually discriminate was measured, not assumed, by putting the old formula back
 * with its own preset: **four of the ten go red** - the fill ratio and the slider removal, one each
 * per app. The other six pass on both formulas and are guards, which is said at each of them rather
 * than left for whoever next wonders what the suite is claiming. Getting this wrong in the first
 * draft is how a test file ends up asserting its author's intentions instead of the code's behaviour.
 *
 * Both apps are asserted separately: they carry erLayout word for word, and a divergence in either is
 * a red mark on that app's name.
 */

/** erLayout() lifted out of an app, over a synthetic ego graph of `levels` boxes per BFS level. */
function laidOut(app, levels, margin = 36) {
  const N = {}, egoLevel = {}, ids = [];
  levels.forEach((count, L) => {
    for (let i = 0; i < count; i++) {
      const id = `L${L}n${i}`; ids.push(id);
      N[id] = { rows: 2 + (i % 4) };            // boxes of four different heights, as a real one has
      egoLevel[id] = L;
    }
  });
  const state = {
    erSelEdge: 'stale', erIds: [], erPos: {}, egoLevel, N,
    erP: { margin, spread: 42, gap: 8, fs: 10, sub: true },
    // erLayout hands a hand-arranged position back before the collision pass, so it reads these. The
    // free-variable trap, for the third time in one day: a slice runs in a bare context and anything
    // the function reaches for has to be there or it throws three lines in.
    erArranged: false, erHeld: {}, erLastKept: 0,
    // null is the live state: everything the reader is holding is held against the layout. A
    // loaded arrangement narrows it to the boxes the file says somebody actually chose.
    erPinOnly: null,
    // erLayout grows a box until its arcs have room to land apart, so it reaches for these too.
    edgesAmong: () => [],
    erVisibleIds: () => ids,
    erConcentric: () => true,                   // the branch under test; the free one is not entered
    erBoxSize: (n) => ({ w: 190, h: 28 + n.rows * 18 }),
  };
  const ctx = vm.createContext(state);
  // `collideBoxes` goes with it. erLayout calls it, and a slice that leaves a callee behind throws a
  // ReferenceError three lines in - the free-variable trap this repository has already recorded once,
  // and it fired again here the moment the pass was extracted into its own function. The suite caught
  // it, which is the argument for the suite.
  // erPinnedNow went the same way the moment a loaded arrangement needed a narrower pinned set than
  // a live one: erLayout calls it, and the slice that left it behind threw three lines in.
  vm.runInContext(['erLayout', 'collideBoxes', 'erFitToArcs', 'erSideCounts', 'erSideOf', 'erPinnedNow']
    .map((f) => gfn(app, f)).join('\n\n'), ctx);
  vm.runInContext('erLayout()', ctx);
  const p = state.erPos;
  const ext = {
    x: Math.max(...ids.map((i) => p[i].x + p[i].w)) - Math.min(...ids.map((i) => p[i].x)),
    y: Math.max(...ids.map((i) => p[i].y + p[i].h)) - Math.min(...ids.map((i) => p[i].y)),
  };
  const area = ids.reduce((t, i) => t + p[i].w * p[i].h, 0);
  return { pos: p, ids, ext, egoLevel, fill: area / (ext.x * ext.y) };
}

/** How deep the worst overlapping pair overlaps, in pixels. 0 means nothing overlaps anything. */
function worstOverlap({ pos, ids }) {
  let worst = 0, pair = '';
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const A = pos[ids[a]], B = pos[ids[b]];
    const ox = (A.w + B.w) / 2 - Math.abs((B.x + B.w / 2) - (A.x + A.w / 2));
    const oy = (A.h + B.h) / 2 - Math.abs((B.y + B.h / 2) - (A.y + A.h / 2));
    if (ox > 0 && oy > 0 && Math.min(ox, oy) > worst) { worst = Math.min(ox, oy); pair = `${ids[a]}/${ids[b]}`; }
  }
  return { worst, pair };
}

const SHAPES = [[1, 1], [1, 3], [1, 8], [1, 12], [1, 30], [1, 3, 4], [1, 3, 9, 20]];

for (const app of ['crm', 'analytics']) {
  test(`${app}: no two boxes in a concentric layout overlap`, () => {
    // The ring formula is a starting position and the collision pass finishes it, so this holds the
    // two together: tightening one without the other would show up here and nowhere else.
    for (const levels of SHAPES) {
      const { worst, pair } = worstOverlap(laidOut(app, levels));
      assert.equal(Math.round(worst), 0, `levels ${levels}: ${pair} overlap by ${Math.round(worst)}px`);
    }
  });

  test(`${app}: a ring of three is not drawn on a circle sized for thirty`, () => {
    // The defect itself, as a ratio against the formula it replaced rather than as one flat
    // threshold. A single number cannot do this job: at 1+1 the old radius already filled 26.4% and
    // at 1+3+4 it filled 3.9%, so any line that catches the second lets the first through - which
    // the first version of this test did, and it failed at 29.4% against a 30% gate I had written
    // from the other rows without checking it against that one. The old fill per shape is the datum.
    const OLD_FILL = [[[1, 1], 0.264], [[1, 3], 0.090], [[1, 8], 0.162], [[1, 12], 0.129], [[1, 3, 4], 0.039]];
    for (const [levels, was] of OLD_FILL) {
      const { fill, ext } = laidOut(app, levels);
      assert.ok(fill > was * 1.5,
        `levels ${levels}: boxes fill ${(fill * 100).toFixed(1)}% of ${Math.round(ext.x)}x`
        + `${Math.round(ext.y)}, against ${(was * 100).toFixed(1)}% on the fixed-multiple radius `
        + '- the ring is sized for something other than what sits on it');
    }
  });

  test(`${app}: the radius follows the count instead of the level`, () => {
    // A guard, not a defect check - and the difference was established by trying it. Written with a
    // comment claiming this "could not have been true before", it then passed against the old
    // formula given its real preset: `max(L * ring, n * slot / 2pi)` does grow with n once n is
    // large enough for the second term to win, so monotonicity was never the thing that was broken.
    // What was broken is the *size*, which the fill case above measures. This stays because losing
    // monotonicity is a plausible way to get the new formula wrong.
    const w = [3, 8, 12, 30].map((n) => laidOut(app, [1, n]).ext.x);
    for (let i = 1; i < w.length; i++) {
      assert.ok(w[i] > w[i - 1],
        `a ring of ${[3, 8, 12, 30][i]} is not wider than one of ${[3, 8, 12, 30][i - 1]}: ${w}`);
    }
  });

  test(`${app}: rings stay in level order`, () => {
    // Also a guard rather than a defect check: the old radii were 420/840/1260 and perfectly ordered,
    // so this passes on both formulas. It is here because deriving the radius is only worth having if
    // the diagram still reads as rings around a focus, and the tangential term is deliberately loose
    // enough for the collision pass to finish - which is the mechanism that could interleave them.
    const { pos, ids, egoLevel } = laidOut(app, [1, 3, 9, 20]);
    const c = pos['L0n0'];
    const centre = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
    const byLevel = {};
    ids.forEach((id) => {
      const d = Math.hypot(pos[id].x + pos[id].w / 2 - centre.x, pos[id].y + pos[id].h / 2 - centre.y);
      (byLevel[egoLevel[id]] = byLevel[egoLevel[id]] || []).push(d);
    });
    for (const L of [1, 2]) {
      assert.ok(Math.max(...byLevel[L]) < Math.min(...byLevel[L + 1]),
        `level ${L} reaches ${Math.round(Math.max(...byLevel[L]))} and level ${L + 1} starts at `
        + `${Math.round(Math.min(...byLevel[L + 1]))} - the rings have interleaved`);
    }
  });

  test(`${app}: the ring slider is gone, in every place it was wired`, () => {
    // It existed to compensate for the formula above, and `margin` drives the radii now. Removing a
    // control means five places, which is exactly the kind of list that gets four of five done.
    //
    // And this case is the evidence for that: its first version read the graph window only, so the
    // **options page** kept offering `Ring radius` for two commits - a control that set a value nothing
    // read any more. The surface was found by opening the file for something else, which is luck. Both
    // pages are read here now, and the lesson is the one already written down: when a control goes,
    // walk every surface that names it rather than the ones that come to mind.
    const js = ['graphview.js', 'options.js']
      .map((f) => read(`apps/${app}/${f}`)).join('\n')
      .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    const html = ['graphview.html', 'options.html'].map((f) => read(`apps/${app}/${f}`)).join('\n');
    assert.ok(!/erP\.ring\b/.test(js), 'erP.ring is still read');
    assert.ok(!/\bring:\s*\d/.test(js), 'a preset still declares a ring value');
    assert.ok(!/'ring'/.test(js), "'ring' is still named in a control or relayout table");
    for (const id of ['pRing', 'vRing', 'rowRing']) {
      assert.ok(!js.includes(id), `${id} is still wired in graphview.js`);
      assert.ok(!html.includes(id), `${id} is still in the markup`);
    }
  });
}

/* ---------------------------------------------------------------------------------------------
 * collideBoxes(), the pass that decides whether a box ends up drawn over another. It used to compare
 * every pair against every other and therefore ran *fewer* passes above 150 nodes, which left 230
 * overlapping pairs at 200 nodes and 1852 at 500 - each one a box with part of another painted over
 * it, and nothing on screen saying so. It is a grid now, and it keeps its best pass rather than its
 * last, because the push oscillates.
 *
 * Tested on scattered boxes rather than on force-layout output: the pass takes positions and gives
 * positions back, and generating them here keeps the case readable and the failure legible. What that
 * does not cover is stated - how good the *input* is, which is the force layout's job and measured
 * separately in the model under tools/, not here.
 */
function scatter(n, spanX, spanY, seed = 5) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pos = {}, ids = [];
  for (let i = 0; i < n; i++) {
    const id = `b${i}`; ids.push(id);
    pos[id] = { x: rnd() * spanX, y: rnd() * spanY, w: 190, h: 28 + (1 + Math.floor(rnd() * 5)) * 18 };
  }
  return { pos, ids };
}

function collide(app, { pos, ids }, margin = 28, pinned) {
  const ctx = vm.createContext({ erPos: pos });
  vm.runInContext(gfn(app, 'collideBoxes'), ctx);
  ctx.list = ids; ctx.margin = margin;
  // Passed through as a real Set built inside the context, because a Set made out here is a Set from
  // another realm and `pinned.size` would read fine while `pinned.has` looked at nothing.
  ctx.pinnedIds = pinned || null;
  vm.runInContext('collideBoxes(list, margin, pinnedIds ? new Set(pinnedIds) : undefined)', ctx);
  return pos;
}

function overlapCount(pos, ids) {
  let pairs = 0;
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const A = pos[ids[a]], B = pos[ids[b]];
    const ox = (A.w + B.w) / 2 - Math.abs((B.x + B.w / 2) - (A.x + A.w / 2));
    const oy = (A.h + B.h) / 2 - Math.abs((B.y + B.h / 2) - (A.y + A.h / 2));
    if (ox > 0 && oy > 0) pairs++;
  }
  return pairs;
}

for (const app of ['crm', 'analytics']) {
  test(`${app}: boxes with room are all pulled clear of each other`, () => {
    // 60 boxes over a span with room for them: the pass must leave none covering another. This is the
    // measurement the readability limit is derived from, so it is asserted rather than remembered.
    for (const seed of [5, 13, 29, 47, 83]) {
      const g = scatter(60, 2600, 1800, seed);
      const before = overlapCount(g.pos, g.ids);
      const after = overlapCount(collide(app, g), g.ids);
      assert.ok(before > 0, `seed ${seed}: nothing overlapped to begin with, the case proves nothing`);
      assert.equal(after, 0, `seed ${seed}: ${after} pair(s) still overlap, from ${before}`);
    }
  });

  test(`${app}: a crowded set is improved, never made worse`, () => {
    // Half the room, so it cannot come out clean - relaxation does not converge at this density and
    // the comment in the source says so. What must hold is that it never hands back something worse
    // than it was given, which a run that keeps its last pass instead of its best can do.
    for (const seed of [5, 13, 29]) {
      const g = scatter(220, 2600, 1800, seed);
      const before = overlapCount(g.pos, g.ids);
      const after = overlapCount(collide(app, g), g.ids);
      assert.ok(after < before, `seed ${seed}: ${before} pairs in, ${after} out`);
    }
  });

  test(`${app}: the same input comes out the same way twice`, () => {
    // Load-bearing, not tidiness: the PDF has to be reproducible, and a chip switched off and back on
    // must not rearrange a diagram the reader had already learnt to read. The grid iterates in
    // insertion order for this reason.
    const a = collide(app, scatter(90, 2600, 1800, 61));
    const b = collide(app, scatter(90, 2600, 1800, 61));
    const key = (p) => Object.keys(p).sort().map((k) => `${k}:${p[k].x.toFixed(6)},${p[k].y.toFixed(6)}`).join('|');
    assert.equal(key(a), key(b), 'two runs of the same set placed the boxes differently');
  });

  test(`${app}: one box, or none, is not a special case that throws`, () => {
    for (const n of [0, 1]) {
      const g = scatter(n, 100, 100);
      assert.doesNotThrow(() => collide(app, g), `${n} box(es) threw`);
    }
  });
}

/* ---------------------------------------------------------------------------------------------
 * Arranging by hand. The auto layout is a starting point past eighty boxes whatever it does, and the
 * reader is the one who knows which two boxes have to sit together for the PDF - which `Save PDF`
 * already exports from erPos, so an arrangement needs nothing added to leave the window.
 *
 * The drag itself is three listeners, a transform and a re-render, and none of that can be asserted
 * from source: it was driven for real in headless Chrome instead, dispatching mousedown, mousemove and
 * mouseup at a box, and the result checked - the box moves by the screen delta divided by the zoom, the
 * arcs carry the `dragging` class while it happens and lose it on the drop, the drop reports what it
 * covers, and a re-layout request is refused once and honoured the second time. What is held here is
 * the arithmetic and the wiring that a rename would break.
 */
for (const app of ['crm', 'analytics']) {
  test(`${app}: a box knows how many others it is drawn over`, () => {
    const ctx = vm.createContext({
      erPos: {
        a: { x: 0, y: 0, w: 190, h: 80 },
        b: { x: 100, y: 20, w: 190, h: 80 },     // overlaps a
        c: { x: 400, y: 0, w: 190, h: 80 },      // clear of both
        d: { x: 30, y: 40, w: 190, h: 80 },      // overlaps a as well
      },
      erIds: ['a', 'b', 'c', 'd'],
      // Nothing folded. `erCovers` asks now, because a box the reader folded away is not on the
      // drawing and cannot be covering anything - and running it alone is what named the free
      // reference the moment that landed.
      erCut: new Map(), Set, Map, Object,
    });
    vm.runInContext(gfn(app, 'erHiddenSet'), ctx);
    vm.runInContext(gfn(app, 'erCovers'), ctx);
    assert.equal(vm.runInContext("erCovers('a')", ctx), 2, 'a covers b and d');
    assert.equal(vm.runInContext("erCovers('c')", ctx), 0, 'c covers nothing');
    assert.equal(vm.runInContext("erCovers('nope')", ctx), 0, 'a box with no position counts nothing');
  });

  test(`${app}: the drag is wired where a rename would break it`, () => {
    const js = read(`apps/${app}/graphview.js`), html = read(`apps/${app}/graphview.html`);
    // The handler has the element and not the loop variable, so the id has to be on the element. It
    // was not, the first time, and the drag read undefined and never began.
    assert.ok(/div\.dataset\.id = id;/.test(js), 'the boxes do not carry their id, so a drag cannot start');
    assert.ok(/erBoxDrag = \{ id: box\.dataset\.id/.test(js), 'the drag does not read the id off the box');
    // The screen delta is divided by the zoom, or a box lags the pointer at anything but 100%.
    assert.ok(/erScale \|\| 1/.test(js), 'the drag moves by screen pixels rather than diagram ones');
    // Arcs off for the duration, and the stylesheet has to agree with the class the script sets.
    assert.ok(/\$\('ersvg'\)\.classList\.add\('dragging'\)/.test(js), 'the arcs are not hidden during a drag');
    assert.ok(/#ersvg\.dragging\{display:none\}/.test(html), 'the class the drag sets is not styled');
    // One funnel, because eleven paths reset erLaidOut and chasing them all is the trap.
    // The whole function, not a window of characters: the first version counted 900 of them and stopped
    // short of the funnel, which sits below a long comment. sliceFn ends at the declaration's own brace.
    // An arrangement is kept across a re-layout rather than refused before one. Refusing was tried and
    // reported as a bug: the refusal fired after the control had toggled its own state, so a chip went
    // grey while its category stayed on screen. What must hold is that the positions are remembered on
    // the drop and handed back by the layout.
    // Every box, not just the dragged one: an arrangement is the relationships between boxes, so
    // holding one while the rest are placed again preserves nothing the reader can see. Reported.
    assert.ok(/erHeld\[other\] = \{ x: q\.x, y: q\.y \}/.test(js),
      'a drop remembers only the box that moved, so the arrangement around it is lost');
    const up = js.slice(js.indexOf("addEventListener('mouseup'"), js.indexOf("addEventListener('mouseup'") + 900);
    assert.ok(/erIds\.forEach/.test(up), 'the drop does not walk every box when it remembers positions');
    const lay = gfn(app, 'erLayout');
    assert.ok(/erHeld\[id\]/.test(lay) && /erPos\[id\]\.x = h\.x/.test(lay),
      'the layout does not hand a hand-placed box back to where it was put');
    assert.ok(lay.indexOf('erHeld') < lay.indexOf('collideBoxes'),
      'the positions are restored after the collision pass, so nothing tidies around them');
    assert.ok(!/erWarned/.test(js), 'the refusal that made a chip lie about itself is still here');
    assert.ok(/id="erRelay"/.test(html), 'there is no way back from an arrangement');
  });
}

for (const app of ['crm', 'analytics']) {
  test(`${app}: a double-click on empty canvas zooms and centres, and nowhere else`, () => {
    // What every interface does, and this one only had the wheel - which zooms towards the pointer and
    // never centres, so reaching a cluster meant scrolling and then dragging. Driven for real headless:
    // 0.695 becomes 1.112, which is the 1.6 step; the view is marked as the reader's own so a resize
    // does not overrule it; and a double-click on a box does not zoom. Held here is what a careless
    // edit would break - the exclusions, and the ceiling agreeing with the wheel's.
    const js = read(`apps/${app}/graphview.js`);
    const at = js.indexOf("addEventListener('dblclick'");
    assert.ok(at > 0, 'nothing listens for a double-click');
    const h = js.slice(at, js.indexOf('\n});', at));
    for (const keep of ['.erbox', '.erhit', '#ertools', '#erlay', '#erpick']) {
      assert.ok(h.includes(keep), `a double-click on ${keep} is taken over by the zoom`);
    }
    assert.ok(/erUserMoved = true/.test(h), 'the zoom does not mark the view as the reader\'s own');
    // The wheel and the double-click must not disagree about how far in they can go.
    const wheelAt = js.indexOf("addEventListener('wheel'");
    const wheel = js.slice(wheelAt, js.indexOf('\n}', wheelAt));
    const cap = (s) => (s.match(/Math\.min\((\d+(?:\.\d+)?), erScale/) || [])[1];
    assert.equal(cap(h), cap(wheel), 'the two ways of zooming stop at different scales');
    // and the hint line has to name it, or it is a gesture nobody discovers
    const hint = js + read(`apps/${app}/graphview.html`);
    assert.ok(/double-click to zoom/.test(hint), 'the hint line does not name the gesture');
  });
}

for (const app of ['crm', 'analytics']) {
  test(`${app}: a hand-placed box is handed back where it was put`, () => {
    // Reported: after moving a box, clicking a chip toggled the chip's own colour and did not apply the
    // filter - because the refusal fired downstream of the control that had already changed state. The
    // refusal is gone and the arrangement is kept instead, so nothing has to be refused. This is that
    // mechanism, run rather than read: lay out with a position held, and see it come back.
    const held = { L1n0: { x: 4242, y: 1717 } };
    const N = {}, egoLevel = {}, ids = [];
    [1, 3].forEach((count, L) => {
      for (let i = 0; i < count; i++) {
        const id = `L${L}n${i}`; ids.push(id); N[id] = { rows: 2 }; egoLevel[id] = L;
      }
    });
    const state = {
      erSelEdge: null, erIds: [], erPos: {}, egoLevel, N,
      erP: { margin: 36, spread: 42, gap: 8, fs: 10, sub: true },
      erVisibleIds: () => ids, erConcentric: () => true,
      erBoxSize: () => ({ w: 190, h: 64 }),
      erArranged: true, erHeld: held, erLastKept: 0, edgesAmong: () => [], erPinOnly: null,
    };
    const ctx = vm.createContext(state);
    vm.runInContext(['erLayout', 'collideBoxes', 'erFitToArcs', 'erSideCounts', 'erSideOf', 'erPinnedNow']
      .map((f) => gfn(app, f)).join('\n\n'), ctx);
    vm.runInContext('erLayout()', ctx);
    assert.equal(state.erLastKept, 1, 'the layout handed nothing back, so an arrangement is lost');
    // The whole drawing is shifted to a 40px origin at the end, so the held box keeps its *offset*
    // from the others rather than its absolute coordinates - which is what surviving means here.
    const others = ids.filter((i) => i !== 'L1n0').map((i) => state.erPos[i]);
    const far = Math.min(...others.map((p) => Math.hypot(p.x - state.erPos.L1n0.x, p.y - state.erPos.L1n0.y)));
    assert.ok(far > 1000, `the held box was placed back among the others, ${Math.round(far)}px from the nearest`);

    // and with nothing held, the layout is free to place everything
    state.erArranged = false; state.erLastKept = 0; state.erPos = {};
    vm.runInContext('erLayout()', ctx);
    assert.equal(state.erLastKept, 0, 'positions are handed back when nothing was arranged');
  });
}

for (const app of ['crm', 'analytics']) {
  test(`${app}: a box that was moved stays on top of the ones it was moved over`, () => {
    // Without it, dropping a box onto a cluster can put it *under* boxes it was moved to sit beside -
    // and the reader has just said which one matters. The order is kept rather than a flag, so the last
    // thing moved is the thing on top, and Re-layout clears it with the rest of the arrangement.
    const js = read(`apps/${app}/graphview.js`), html = read(`apps/${app}/graphview.html`);
    assert.ok(/erRaised\.set\(id, \+\+erRaiseN\)/.test(js), 'a drop does not raise the box it moved');
    assert.ok(/erRaised\.get\(id\)/.test(js) && /style\.zIndex/.test(js),
      'the render does not apply the order, so it is lost on the next redraw');
    const relay = js.slice(js.indexOf("$('erRelay')"), js.indexOf("$('erRelay')") + 220);
    assert.ok(/erRaised = new Map\(\)/.test(relay), 'Re-layout leaves the raised boxes raised');
    // and the one under the pointer has to be above even those
    assert.ok(/\.erbox\.dragging\{[^}]*z-index:9999/.test(html),
      'the box being dragged is not above the ones already raised');
  });
}


for (const app of ['crm', 'analytics']) {
  test(`${app}: arcs share a side instead of stacking on its middle`, () => {
    // Seven arcs arriving from above arrived at one point, so you could not tell them apart by looking
    // - the complaint this window opened with - let alone click the one you meant. Each side shares its
    // width now. Two invariants: a lone arc is where it always was, and n arcs are n distinct points,
    // ordered by where their far ends lie so the fan does not cross itself.
    const SEP = '\u0001';
    const ctx = vm.createContext({
      erPos: {
        hub: { x: 500, y: 500, w: 190, h: 80 },
        l: { x: 100, y: 100, w: 190, h: 80 },
        m: { x: 500, y: 100, w: 190, h: 80 },
        r: { x: 900, y: 100, w: 190, h: 80 },
      },
      ekey: (a, b) => a + SEP + b,
    });
    vm.runInContext(['erSideOf', 'erComputeSlots', 'erEdgePoints']
      .map((f) => gfn(app, f)).join('\n\n'), ctx);
    const at = (pairs, a, b) => {
      ctx.pairs = pairs;
      const slots = vm.runInContext('erComputeSlots(pairs)', ctx);
      ctx.A = ctx.erPos[a]; ctx.B = ctx.erPos[b];
      ctx.sa = slots.get(ctx.ekey(a, b) + SEP + a);
      ctx.sb = slots.get(ctx.ekey(a, b) + SEP + b);
      return vm.runInContext('erEdgePoints(A, B, sa, sb)', ctx)[0];
    };
    const three = [['hub', 'l'], ['hub', 'm'], ['hub', 'r']];
    const xs = three.map(([a, b]) => at(three, a, b));
    const distinct = new Set(xs.map((x) => Math.round(x))).size;
    assert.equal(distinct, 3, `three arcs leaving one side met ${distinct} point(s): ${xs}`);
    // ordered by where the far end lies: the one going left leaves further left
    const byFar = three.map(([, b], i) => [ctx.erPos[b].x, xs[i]]).sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < byFar.length; i++) {
      assert.ok(byFar[i][1] > byFar[i - 1][1], `the fan crosses itself: ${JSON.stringify(byFar)}`);
    }
    // a lone arc keeps the middle it always had
    assert.equal(at([['hub', 'm']], 'hub', 'm'), 595, 'a lone arc moved off the middle');
  });
}


/* ---- taking a box off the drawing ---------------------------------------------------------------
 *
 * The reader's requirement, in his words: a way of removing from the view what he is not looking at,
 * either broadly with the filters or pointedly, on one element - and since an arc joins two boxes, a
 * control at each of the two points where it touches them.
 *
 * The rule this replaced refused most of those points. «Hide only what becomes unreachable any other
 * way» offered nothing on an arc into a box that is referenced from somewhere else, which on a hub is
 * nearly all of them: the first case below is that measurement, kept because it is the reason the rule
 * changed and the number is the argument.
 *
 * What goes now is the box at the far end and whatever was in the drawing only through it. Not
 * «everything connected to it», which in a graph with a cycle in it is the whole component including
 * the box the reader is standing on - the difference between the two walks is what keeps a box that
 * has a life of its own on screen.
 */
function remover(app, ids, edges, focus) {
  const ctx = vm.createContext({
    erIds: ids.slice(), edgesA: edges.map((e) => e.slice()),
    N: Object.fromEntries(ids.map((i) => [i, { id: i }])),
    curFocus: focus, erCut: new Map(),
  });
  vm.runInContext(sliceConst(`apps/${app}/graphview.js`, 'ekey'), ctx);
  vm.runInContext(['erReach', 'erWouldGo', 'erHiddenSet', 'erWouldShowSet', 'erWouldShow', 'erUnhide']
    .map((f) => gfn(app, f)).join('\n\n'), ctx);
  const run = (src) => vm.runInContext(src, ctx);
  return {
    ctx,
    wouldGo: (from, away) => { ctx.f = from; ctx.w = away; return new Set(run('[...erWouldGo(f, w, erHiddenSet())]')); },
    take: (a, b, away) => { ctx.a = a; ctx.b = b; ctx.w = away; return run('erCut.set(ekey(a, b), w).size'); },
    hidden: () => new Set(run('[...erHiddenSet()]')),
    wouldShow: (a, b) => { ctx.a = a; ctx.b = b; return run('erWouldShow(ekey(a, b))'); },
    unhide: (id) => { ctx.id = id; return run('erUnhide(id)'); },
  };
}

for (const app of ['crm', 'analytics']) {
  test(`${app}: every point where an arc meets a box offers to take the other end away`, () => {
    // The reported case, as a count. A hub with forty neighbours, thirty-four of which are referenced
    // from somewhere else as well: under the old rule six of the forty arcs offered anything at all,
    // which is what the reader saw and reported. Every one of them offers now, and what it offers is
    // never nothing - the far box always goes, whatever else it is attached to.
    const ids = ['hub', 'other'], edges = [];
    for (let i = 0; i < 40; i++) {
      const id = 'n' + i; ids.push(id);
      edges.push([id, 'hub']);
      if (i < 34) edges.push([id, 'other']);
    }
    edges.push(['other', 'hub']);
    const r = remover(app, ids, edges, 'hub');
    let offered = 0;
    for (let i = 0; i < 40; i++) {
      const went = r.wouldGo('hub', 'n' + i);
      if (went.size) offered++;
      assert.ok(went.has('n' + i), `n${i}: the box the control names did not go`);
      assert.equal(went.size, 1, `n${i}: took ${went.size} boxes where only that one hangs on it`);
    }
    assert.equal(offered, 40, `only ${offered} of the 40 arcs on a hub offer anything`);
  });

  test(`${app}: what goes is what was in the drawing only through it`, () => {
    // A triangle with something hanging off one corner: A-B, B-C, C-A, and D under B. Taking B away
    // from A takes D with it and leaves C, which A can still see without going through B. The literal
    // reading of «everything connected to it» would take C and A as well, which is the whole drawing.
    const ids = ['A', 'B', 'C', 'D'], edges = [['A', 'B'], ['B', 'C'], ['C', 'A'], ['D', 'B']];
    const r = remover(app, ids, edges, 'A');
    assert.deepEqual([...r.wouldGo('A', 'B')].sort(), ['B', 'D'], 'the cascade is not what hung on it');
    assert.deepEqual([...r.wouldGo('A', 'C')].sort(), ['C'], 'C took something with it that stands on its own');
    // and from the other side of the same arc: B loses A, and nothing else, because C holds the rest
    assert.deepEqual([...r.wouldGo('B', 'A')].sort(), ['A'], 'taking A from B swallowed more than A');
  });

  test(`${app}: a second component is never swallowed, and the count is what actually goes`, () => {
    // Two graphs on one canvas - a filter leaves them all the time. Taking a box off one of them may
    // not touch the other, and the difference between the two walks is what guarantees it: what was
    // never reachable from the control's own box was not in the first walk either.
    const ids = ['A', 'B', 'C', 'X', 'Y'], edges = [['A', 'B'], ['B', 'C'], ['X', 'Y']];
    const r = remover(app, ids, edges, null);
    assert.deepEqual([...r.wouldGo('A', 'B')].sort(), ['B', 'C'], 'the chain beyond B did not go with it');
    r.take('A', 'B', 'B');
    assert.deepEqual([...r.hidden()].sort(), ['B', 'C'], 'the other component was dragged into it');
    assert.equal(r.wouldShow('A', 'B'), 2, 'the + offers back a different number from the one that went');
  });

  test(`${app}: removals compose, each against what was on screen when it was made`, () => {
    // Three branches off a hub, taken one at a time: each takes its own, none claims another's, and
    // undoing one brings back exactly what it took. The replay is in the order they were made, so a
    // removal whose own box has since gone is skipped rather than reinterpreted.
    const ids = ['hub'], edges = [];
    for (const b of ['p', 'q', 'r']) {
      ids.push(b, b + '1', b + '2');
      edges.push([b, 'hub'], [b + '1', b], [b + '2', b + '1']);
    }
    const r = remover(app, ids, edges, 'hub');
    r.take('p', 'hub', 'p');
    assert.deepEqual([...r.hidden()].sort(), ['p', 'p1', 'p2'], 'the first branch did not go whole');
    r.take('q', 'hub', 'q');
    assert.deepEqual([...r.hidden()].sort(), ['p', 'p1', 'p2', 'q', 'q1', 'q2'], 'the second removal disturbed the first');
    assert.equal(r.wouldShow('q', 'hub'), 3, 'undoing the second offers back the wrong number');
    // and the reader asking to look at something buried brings back that removal and no other
    r.unhide('q2');
    assert.deepEqual([...r.hidden()].sort(), ['p', 'p1', 'p2'], 'unhiding took away more removals than the one holding it');
  });

  test(`${app}: the marks are two per arc, on the ends, and never wider than the gap`, () => {
    // The wiring, which the slices above cannot see. Two marks per arc - one at each point where it
    // meets a box - each placed on the end that stays; the layer above the boxes, because the meeting
    // point is the box's own edge; and a width taken from the distance between two landing points on
    // that side, because the reported case was thirteen arcs on one rim with 20px circles on them.
    const js = read(`apps/${app}/graphview.js`), html = read(`apps/${app}/graphview.html`);
    assert.ok(/<div id="ermarks"><\/div>/.test(html), 'id=ermarks is not in the markup');
    assert.ok(/#ermarks\{[^}]*z-index:99999/.test(html), 'the marks are not above the boxes');
    assert.ok(/#ermarks\.dragging\{display:none\}/.test(html), 'the marks stay behind while a box is dragged');
    assert.ok(/@media print\{ \.ermk\.fold\{display:none\}/.test(html), 'a control nobody can press is printed');
    assert.ok(/closest\('#ermarks'\)/.test(js), 'pressing a mark starts a pan');
    assert.ok(/width:var\(--d,16px\);height:var\(--d,16px\)/.test(html), 'the marks are not sized from the drawing');
    assert.ok(/drawnPairs\.forEach\(\(\[a, b\]\) => \{ markAt\(a, b, b, a, false\); markAt\(a, b, a, b, false\); \}\)/.test(js),
      'an arc no longer carries a mark at each of its two ends');
    const mk = js.slice(js.indexOf('const markAt ='), js.indexOf('marks.appendChild(el)'));
    assert.ok(/stay === a \? pt\[0\] : pt\[2\]/.test(mk) && /stay === a \? pt\[1\] : pt\[3\]/.test(mk),
      'the mark is not placed on the end of the arc that stays');
    // One rule for both marks: a `-` squeezed to 11px beside a `+` at 20 reads as two controls, which
    // is what the second picture showed. Between the floor and the cap it follows the gap.
    //
    // The rule lives in erMarkD now and markAt asks it, because the arcs stop at the circle's rim and
    // therefore need the same number: two copies of it would let a mark grow while the arc did not,
    // which puts the arrowhead straight back under the control it was moved out from.
    const md = gfn(app, 'erMarkD');
    assert.ok(/Math\.max\(MARK_MIN, Math\.min\(MARK_D, gap - 1\)\)/.test(md), 'the width no longer follows the gap');
    assert.ok(/erMarkD\(S, stay === a \? B : A, slot\)/.test(mk), 'the mark is sized by its own copy of the rule');
    // The head stands off the box by the circle's width, and it is moved by refX rather than by
    // shortening the paths. That is the whole point: a path is fixed when it is drawn, while both the
    // circle and the head keep a constant size on screen - so a shortened path came apart from the
    // circle as soon as the reader zoomed, which is how the first attempt was reported.
    const sz = gfn(app, 'erSizeArrows');
    assert.ok(/refX/.test(sz), 'the arrowhead is anchored on the box edge, under the fold control');
    assert.ok(/MARK_MIN \/ 2/.test(sz) && /Math\.min\(MARK_MAX, k\)/.test(sz),
      'the setback does not follow the same counter-scaling as the circle it stands off');
    assert.ok(!/erPrintFull \? 0 : 0/.test(sz) && /erPrintFull \? 0/.test(sz),
      'a print keeps room for a circle it does not draw');
    assert.ok(/erPrintFull = true; erSizeArrows\(\)/.test(js) && /erPrintFull = false; erSizeArrows\(\)/.test(js),
      'the print state is entered or left without the arrowheads being told');
    assert.ok(!/folded \? MARK_D/.test(mk), 'the + is sized by a different rule from the -');
    assert.ok(/folded \? '\+' : '\\u2212'/.test(mk), 'the + carries something other than a +');
  });

  test(`${app}: the invisible hit corridors are cleared with the arcs they belong to`, () => {
    // `.erhit` is a 14px-wide transparent copy of every arc, and it was not in the list the render
    // clears: measured on the sample schema, six arcs on screen and thirty corridors under them after
    // five renders, each still carrying the geometry it was drawn for. Found by counting elements.
    const js = read(`apps/${app}/graphview.js`);
    assert.ok(/querySelectorAll\('\.erlink,\.erhit,\.erlabel,\.erlead'\)/.test(js),
      'the hit corridors are left behind by the render that replaces them');
  });
}

for (const app of ['crm', 'analytics']) {
  test(`${app}: a control says what it is about to take, by name`, () => {
    // A count answers «how much», and the question in front of somebody zoomed in on a crowded rim is
    // «what» - most of what a cascade takes is off screen at that zoom, so it cannot be looked at,
    // only read. Reported: «un tooltip che mi dice "stai rimuovendo a - b - c" mi aiuta molto».
    const ids = ['hub', 'Zulu', 'Alpha', 'Mike', 'far'];
    const ctx = vm.createContext({
      N: Object.fromEntries(ids.map((i) => [i, { id: i, api_name: i, name: i }])),
      label: (n) => n.api_name,
    });
    vm.runInContext([sliceConst(`apps/${app}/graphview.js`, 'MSG'),
      sliceConst(`apps/${app}/graphview.js`, 'TIP_MAX'),
      gfn(app, 'erTipIds'),
      gfn(app, 'erTipText')].join('\n\n'), ctx);
    const tip = (set, first, back) => { ctx.s = new Set(set); ctx.f = first; ctx.b = back; return vm.runInContext('erTipText(s, f, b)', ctx); };

    // one box: the name, and nothing to count
    assert.equal(tip(['Alpha'], 'Alpha', false), 'Removing Alpha');
    assert.equal(tip(['Alpha'], 'Alpha', true), 'Putting back Alpha');
    // the box the control names first, then what comes with it alphabetically, one dash per box - a
    // tooltip *does* wrap, so a long name takes several lines and only the dash says where one box
    // ends and the next begins. Reported as «it all looks stuck together», against a version with none.
    assert.equal(tip(['Zulu', 'Alpha', 'Mike'], 'Zulu', false),
      'Removing 3 boxes:\n\n- Zulu\n- Alpha\n- Mike');
    // and it is capped, with the number that stays true at any size
    const many = Array.from({ length: 30 }, (_, i) => 'n' + String(i).padStart(2, '0'));
    ctx.N = Object.fromEntries(many.map((i) => [i, { id: i, api_name: i, name: i }]));
    const long = tip(many, 'n29', false);
    const items = long.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(items.length, 11, `id=cap ${items.length} items listed for 30 boxes`);
    assert.ok(long.startsWith('Removing 30 boxes:\n\n- n29\n'), 'id=head the box being pressed is not named first');
    assert.ok(long.endsWith('\n- and 20 more'), `id=tail ${JSON.stringify(long.slice(-20))}`);
  });

  test(`${app}: hovering a control outlines what would go, and lets go of it`, () => {
    // The other half of the same answer: the list is for what is off screen, the outline for what is
    // on it. Rebuilt with the boxes, so it cannot outlive the render that drew them.
    // Both files: what draws the outline stayed with the drawing, what decides to ask for it moved
    // into graphlogic.js, and this test is about the two agreeing.
    const js = read(`apps/${app}/graphview.js`) + read(`apps/${app}/graphlogic.js`);
    const html = read(`apps/${app}/graphview.html`);
    assert.ok(/\.erbox\.willgo\{[^}]*dashed/.test(html), 'nothing marks the boxes a control would take');
    assert.ok(/erFlag = \(set\) => \{/.test(js) && /boxEl\.set\(id, div\)/.test(js),
      'the outline is not built from the boxes the render just drew');
    const mk = js.slice(js.indexOf('const markAt ='), js.indexOf('marks.appendChild(el)'));
    assert.ok(/mouseenter[\s\S]*erTipOn\(el, asked\)/.test(mk), 'hovering a mark says nothing about what it would take');
    assert.ok(/mouseleave[\s\S]*erFlag\(null\); erTipHide\(\)/.test(mk),
      'the outline or the panel is left behind when the pointer goes');
    assert.ok(/erFlag\(set\);\s+\/\/ the outline is immediate/.test(js),
      'the outline waits for the same delay as the panel, and it is about what is already on screen');
    assert.ok(/wire\(cb, isCut/.test(js) && /wire\(cb2, \(\)/.test(js),
      'the card buttons do not open the same panel');
    // and the badge wears the colour its box wears, from the one helper that decides it
    assert.ok(/if \(N\[id\]\) erPaint\(b, N\[id\]\)/.test(js), 'the names in the panel carry no colour');
    // One place is now literally one variable: both read --kind, which is set from --n-<namespace>.
    // The pair of classes this used to check were the CRM's two namespaces, and a workspace whose
    // namespaces are `table` and `query` matched neither - every box came out the same colour.
    assert.ok(/#ertip \.tb\.hued\{background:var\(--kind\)\}/.test(html)
      && /\.erbox\.hued \.erhdr\{background:var\(--kind\)\}/.test(html),
      'the badge and the box header no longer read the same colour from one place');
    assert.ok(!/--box-std|--box-cus/.test(html), 'the two-namespace colouring is back');
    assert.ok(/#ertip\{[^}]*pointer-events:none/.test(html), 'the panel can stand between the reader and the control');
  });
}

// Dragging the sheet used to leave every label it crossed highlighted, until the next click cleared
// it - reported. The cause was one line: the branch that starts a pan did not preventDefault, while
// the branch just above it, the one that drags a box, always had. The browser keeps a selection it
// was allowed to start, so the difference was invisible until somebody dragged the background.
//
// Held here as source rather than behaviour: a real drag needs a browser, and this suite has none.
// What it does hold is the pair - the same defect existed in both apps, because the two files are
// the same code - and the shape of the guard, which is a whitelist. A blacklist would have to name
// the toolbar, the layout sliders, the picker and the hint line, and a list of exclusions is exactly
// what has drifted between these two apps before.
for (const app of ['crm', 'analytics']) {
  test(`${app}: panning the ER sheet does not select the text it passes over`, () => {
    const js = read(`apps/${app}/graphview.js`);
    const at = js.indexOf('let erDown = false');
    assert.ok(at > 0, 'the pan state is not where this expects it');
    const down = js.slice(at, js.indexOf("addEventListener('mousemove'", at));
    // The whitelist: what pans is the canvas, not everything that is not a panel.
    assert.ok(/e\.target !== \$\('v-er'\) && !e\.target\.closest\('#ervp'\)/.test(down),
      'a pan can start from anywhere in the view, sliders and hint line included');
    // Two preventDefault: one in the box branch, one in the pan branch. One of them is the bug.
    assert.equal((down.match(/e\.preventDefault\(\)/g) || []).length, 2,
      'the pan branch does not preventDefault, so the drag selects the labels it crosses');
    // preventDefault keeps the focus where it was, which the default mousedown would have moved.
    assert.ok(/act\.blur\(\)/.test(down), 'clicking the drawing no longer takes the caret out of the search box');
  });
}

// A box the reader dragged there may not be moved by the collision pass. The comment in erLayout
// had claimed this for as long as arrangements have been kept - "newcomers make room around an
// arrangement rather than the arrangement being computed away" - while collideBoxes took a list and
// a margin and nothing else, so held positions were written back and then pushed around like any
// other. Found by reading the code against a proposal that assumed the pinning already existed.
for (const app of ['crm', 'analytics']) {
  const two = () => ({
    ids: ['a', 'b'],
    pos: { a: { x: 100, y: 100, w: 190, h: 80 }, b: { x: 120, y: 110, w: 190, h: 80 } },
  });

  test(`${app}: a pinned box does not move, and its neighbour takes the whole push`, () => {
    const g = two();
    const before = { ...g.pos.a };
    const out = collide(app, g, 28, ['a']);
    assert.deepEqual({ x: out.a.x, y: out.a.y }, { x: before.x, y: before.y },
      'the pass moved a box the reader had placed');
    assert.ok(Math.abs(out.b.x - 120) > 1 || Math.abs(out.b.y - 110) > 1,
      'the free box did not move, so the overlap was never resolved');
    assert.equal(overlapCount(out, g.ids), 0, 'they still overlap');
  });

  test(`${app}: two pinned boxes are left overlapping rather than tidied apart`, () => {
    // Their overlap is the reader's, and it is already reported to them when it happens. Resolving
    // it here would be the pass overruling a placement - and it must still terminate.
    const g = two();
    const out = collide(app, g, 28, ['a', 'b']);
    assert.deepEqual(out.a, { x: 100, y: 100, w: 190, h: 80 });
    assert.deepEqual(out.b, { x: 120, y: 110, w: 190, h: 80 });
  });

  test(`${app}: with nothing pinned the pass is what it always was`, () => {
    // The back-compatibility guarantee, and the reason the rendered diagrams do not move: an
    // absent set and an empty one have to be the same run.
    const omitted = collide(app, scatter(40, 900, 700), 28);
    const empty = collide(app, scatter(40, 900, 700), 28, []);
    assert.deepEqual(empty, omitted, 'an empty pinned set changed the layout');
  });

  test(`${app}: newcomers make room around an arrangement`, () => {
    // The whole point, in the shape it actually happens: a diagram the reader has arranged, then a
    // category switched on that brings boxes nobody placed.
    const g = scatter(24, 700, 500);
    const held = g.ids.slice(0, 20);
    const kept = Object.fromEntries(held.map((id) => [id, { ...g.pos[id] }]));
    const out = collide(app, g, 28, held);
    for (const id of held) {
      assert.deepEqual({ x: out[id].x, y: out[id].y }, { x: kept[id].x, y: kept[id].y },
        `${id} was placed by the reader and the pass moved it`);
    }
  });
}

// The ceiling was raised from 400 to 800 when a real org reported 725 boxes. Both settings pages
// were corrected and so were all four guides; the sentence the diagram itself shows when it refuses
// to draw kept saying 400, in both products, for as long as that took to be noticed. Nobody could
// have caught it by reading the paragraph that changed - it is the same claim in a place that does
// not look like the others, which is the enumeration trap this repository keeps meeting.
//
// So the number is not compared, it is forbidden: the message states the default by interpolating
// the constant that is the default, and a literal there cannot be right for long.
for (const app of ['crm', 'analytics']) {
  test(`${app}: the refusal states the ceiling from the constant, not from memory`, () => {
    const js = read(`apps/${app}/graphview.js`);
    // Anchored on the line start: a second message called tooMany - the one about a file being
    // bigger than the ceiling - was found first and quietly moved this check onto the wrong string.
    const msg = js.slice(js.indexOf('\n  tooMany:') + 1, js.indexOf('\n', js.indexOf('\n  tooMany:') + 1));
    assert.ok(msg, 'the refusal message is not where this expects it');
    assert.ok(/which is \$\{DRAW_MAX_NODES\} by default/.test(msg),
      'the default ceiling is written out as a number, so it can disagree with the code again');
    assert.ok(!/\b(400|800)\b/.test(msg.replace(/\$\{[^}]*\}/g, '')),
      'a bare ceiling figure is back in the message');
  });
}

// Fit resizes and does not centre - reported, and true of every diagram anyone had arranged. The
// frame was computed from the drawing's *extent from the origin* rather than from the drawing, which
// are the same number only while every box sits right of and below 0. Drag one box 600px to the left
// and the fit reserved 600px of empty canvas: measured on screen at 17px of margin against 341.
for (const app of ['crm', 'analytics']) {
  test(`${app}: the fit frames the drawing, not its distance from the origin`, () => {
    // Two diagrams of identical size, one of them shifted bodily into negative coordinates. A frame
    // that describes the drawing has to give both the same scale and put both in the middle.
    // The seeds are what the last render measured, so they carry the shift too - a drawing wholly
    // left of the origin has a negative maximum, and clamping that at 0 was the other half of the
    // same mistake.
    const geom = (dx) => ({
      maxX: dx + 500, maxY: dx + 300, minX: dx, minY: dx, ids: ['a', 'b'],
      pos: { a: { x: dx, y: dx, w: 200, h: 100 }, b: { x: dx + 300, y: dx + 200, w: 200, h: 100 } },
    });
    const at0 = fitter(app, REAL, geom(0)); at0.fit();
    const shifted = fitter(app, REAL, geom(-600)); shifted.fit();
    assert.ok(Math.abs(at0.state.erScale - shifted.state.erScale) < 1e-9,
      `moving a drawing changed its scale: ${at0.state.erScale} then ${shifted.state.erScale}`);
    // Centred means the same room either side: left is erTx + minX*scale, right is what is left over.
    for (const [name, f, dx] of [['at the origin', at0, 0], ['shifted left', shifted, -600]]) {
      const s = f.state.erScale;
      const left = f.state.erTx + dx * s;
      const right = REAL.w - (f.state.erTx + (dx + 500) * s);
      assert.ok(Math.abs(left - right) < 0.5, `${name}: ${Math.round(left)}px of margin against ${Math.round(right)}px`);
    }
  });
}

// An arrangement is work, and until now it died with the window. These three carry it to a file and
// back: pure, so they are tested here rather than reasoned about, and written word for word in both
// products so the twin ledger holds them without anyone keeping a list.
for (const app of ['crm', 'analytics']) {
  const arr = (...names) => {
    const ctx = vm.createContext({ JSON, Object, Array, Number, Math, Set });
    for (const n of ['serializeArrangement', 'parseArrangement', 'matchArrangement'])
      vm.runInContext(gfn(app, n), ctx);
    vm.runInContext(sliceConst(`apps/${app}/graphview.js`, 'ARR_V'), ctx);
    return ctx;
  };
  const state = {
    app, kind: 'schema', workspace: 'inst/1234567890', focus: 'Orders', depth: 2,
    emphasis: 'modules', names: 'display', arcs: 12, savedAt: '2026-08-13T09:00:00Z',
    positions: { b: { x: 10.4, y: 20.6 }, a: { x: -5, y: 0 } }, moved: ['a'],
    folds: [['a', 'b', 'b']],
  };

  test(`${app}: the same arrangement always writes the same bytes`, () => {
    // Diffable is a claim the format has to keep: sorted keys, whole pixels, one box to a line.
    const c = arr();
    c.st = state;
    const once = vm.runInContext('serializeArrangement(st)', c);
    const twice = vm.runInContext('serializeArrangement({...st, positions: {a: st.positions.a, b: st.positions.b}})', c);
    assert.equal(once, twice, 'two saves of one arrangement differ');
    assert.ok(once.indexOf('"a": [-5, 0, 1]') > 0, `the moved flag or the rounding is wrong:\n${once}`);
    assert.ok(once.indexOf('"b": [10, 21, 0]') > 0, 'coordinates are not rounded to whole pixels');
    assert.ok(once.indexOf('"a"') < once.indexOf('"b"'), 'the boxes are not written in a fixed order');
  });

  test(`${app}: what it writes is what it reads`, () => {
    const c = arr();
    c.st = state;
    // Through JSON on the way out: an object built inside the context belongs to another realm, and
    // a strict deepEqual compares prototypes as well as structure.
    const round = JSON.parse(vm.runInContext('JSON.stringify(parseArrangement(serializeArrangement(st)))', c));
    assert.equal(round.ok, true, `a file it wrote came back as ${round.reason}`);
    assert.deepEqual(round.file.moved, ['a']);
    assert.deepEqual(round.file.positions.b, { x: 10, y: 21 });
    assert.deepEqual(round.file.folds, [['a', 'b', 'b']]);
    assert.equal(round.file.arcs, 12, 'the arc count is what says the relationships have moved on');
    assert.equal(round.file.focus, 'Orders');
  });

  test(`${app}: a file it cannot use says which of the reasons it is`, () => {
    const c = arr();
    const why = (text, cap) => { c.t = text; c.cap = cap || 0; return vm.runInContext('parseArrangement(t, cap)', c); };
    assert.equal(why('{oops').reason, 'notJson');
    assert.equal(why('{"hello": 1}').reason, 'notOurs');
    assert.equal(why('{"zoost":"arrangement","v":99,"positions":{"a":[1,2,0]}}').reason, 'newer');
    assert.equal(why('{"zoost":"arrangement","v":1}').reason, 'noPositions');
    assert.equal(why('{"zoost":"arrangement","v":1,"positions":{"a":["x","y",0]}}').reason, 'noPositions',
      'a coordinate that is not a number was taken as one');
    assert.equal(why('{"zoost":"arrangement","v":1,"positions":{"a":[1,2,0],"b":[3,4,0]}}', 1).reason, 'tooBig',
      'a file larger than the diagram will draw was accepted');
    // and a good one is not refused, which is the half that gets forgotten
    assert.equal(why('{"zoost":"arrangement","v":1,"positions":{"a":[1,2,1]}}').ok, true);
  });

  test(`${app}: the graph is the truth and every loss is counted`, () => {
    const c = arr();
    c.file = { positions: { gone: { x: 0, y: 0 }, kept: { x: 5, y: 5 }, placed: { x: 9, y: 9 } },
               moved: ['kept'] };
    c.drawn = ['kept', 'placed', 'arrived'];
    const m = JSON.parse(vm.runInContext('JSON.stringify(matchArrangement(file, drawn))', c));
    assert.deepEqual(m.matched.sort(), ['kept', 'placed'], 'the boxes the file and the graph share');
    assert.deepEqual(m.fresh, ['arrived'], 'a box the file never saw is not handed to the layout');
    assert.deepEqual(m.stale, ['gone'], 'a position with nothing to attach to is not counted as lost');
    // Only what the reader moved is held against the layout. The rest was placed for them once and
    // may be placed for them again, which is what leaves room for a newcomer.
    assert.deepEqual(m.pinned, ['kept'], 'a box the layout placed is being pinned as if chosen');
  });

  test(`${app}: a renamed box loses its position rather than inheriting a stranger's`, () => {
    // The one case where a guess would be worse than a loss: the position is still there, and a box
    // sitting where a *different* one used to sit misstates the topology the reader built.
    const c = arr();
    c.file = { positions: { Ordini: { x: 0, y: 0 } }, moved: ['Ordini'] };
    c.drawn = ['Orders'];
    const m = JSON.parse(vm.runInContext('JSON.stringify(matchArrangement(file, drawn))', c));
    assert.deepEqual(m.stale, ['Ordini']);
    assert.deepEqual(m.fresh, ['Orders']);
    assert.deepEqual(m.pinned, [], 'a renamed box was pinned to the old one\'s place');
  });
}

// Eight controls in one row was reported as a wall. What a reader does *to a file* groups; Emphasis,
// Fields, Re-layout and Fit each state something about the drawing and have to stay legible without
// opening anything. And a menu is exactly the kind of thing that reads correctly in the markup and
// never appears, so the wiring is asserted as well as the shape.
for (const app of ['crm', 'analytics']) {
  test(`${app}: the file actions live in one menu, not loose in the toolbar`, () => {
    const html = read(`apps/${app}/graphview.html`), js = read(`apps/${app}/graphview.js`);
    const tools = html.slice(html.indexOf('<div id="ertools">'), html.indexOf('</div>', html.indexOf('<div id="ertools">')));
    assert.ok(/id="erFileBtn"/.test(tools), 'there is no File menu');
    for (const id of ['erPdf', 'erArrSave', 'erArrLoad']) {
      assert.ok(!tools.includes(`id="${id}"`), `id=${id} is still a button of its own in the toolbar`);
      assert.ok(html.slice(html.indexOf('<div id="erfile">')).includes(`id="${id}"`), `id=${id} is not in the menu`);
    }
    assert.ok(/#erfile\.on\{display:block\}/.test(html), 'the menu has no open state');
    assert.ok(/@media print\{ #erfile\{display:none !important\} \}/.test(html), 'a menu is printed');
    // Opening one popup closes the other, and using or leaving the menu closes it.
    assert.ok(/\$\('erfile'\)\.classList\.remove\('on'\)/.test(js), 'Layout opens on top of an open File menu');
    assert.ok(/\$\('erlay'\)\.classList\.remove\('on'\)/.test(js), 'File opens on top of an open Layout panel');
    assert.ok(/getBoundingClientRect\(\)\.left[\s\S]{0,120}v-er'\)\.getBoundingClientRect\(\)\.left/.test(js),
      'the menu is placed by an offset measured against the wrong box');
  });

  test(`${app}: an arrangement from another workspace says so, by name`, () => {
    // Reported: saved one, changed workspace, loaded it, and nothing on screen said the file belonged
    // somewhere else. Every id in it failed to match, which is true and is not the reason - and the
    // file is the one thing that knows the reason.
    const js = read(`apps/${app}/graphview.js`);
    const fn = gfn(app, 'erApplyArrangement');
    assert.ok(/arrWrongWorkspace/.test(fn), 'a foreign workspace is reported as "nothing matched"');
    assert.ok(fn.indexOf('elsewhere') < fn.indexOf('matchArrangement'),
      'the workspace is decided after the ids, so the symptom is reported before the cause');
    assert.ok(/erHint\(elsewhere \? MSG\.arrWrongWorkspace\(fileWs, hereWs\) : MSG\.arrNothingMatched, true\)/.test(fn),
      'a refusal is shown in the same grey as a running commentary');
    // and the line itself has a state a reader notices
    assert.ok(/h\.classList\.toggle\('warn', !!warn\)/.test(js), 'erHint cannot mark a message as one to notice');
    assert.ok(/\.hint2\.warn\{/.test(read(`apps/${app}/graphview.html`)), 'the noticeable state is not drawn');
  });
}

// ---------------------------------------------------------------------------------------------
// A focus on something the diagram does not contain. Reported from Zoho Analytics: clicking some
// query tables opened the ER window on an empty page with no count beside the chip, and other
// queries were fine - no pattern the author could see from outside.
//
// The pattern is that `schema` is built from the nodes of the ER model Zoho Analytics returns, so a
// view that model does not carry is not a node here. The window took DATA.focus on trust and
// computed the neighbourhood of an id that does not exist. The CRM's copy of that block has checked
// `N[DATA.focus]` since it was written; the Analytics one never did - a guard on one twin and not
// the other, which is the divergence this repository keeps meeting.
//
// Asserted on the source because that block is top-level code in a browser window: what it holds is
// that the guard exists on both sides, that neither is silent when it fires, and that the message
// can name the view rather than an id.
for (const app of ['crm', 'analytics']) {
  test(`${app}: an impossible focus is refused, and said`, () => {
    const src = read(`apps/${app}/graphview.js`);
    assert.ok(/DATA\.focus && N\[DATA\.focus\]/.test(src),
              `${app}: the incoming focus is taken on trust, so a missing node draws an empty sheet`);
    assert.ok(/DATA\.focus && !N\[DATA\.focus\]\) noFocusHere/.test(src),
              `${app}: the focus is dropped without a word - a blank answer to a specific question`);
    assert.ok(/function noFocusHere\(/.test(src), `${app}: nothing says it`);
    const say = src.slice(src.indexOf('function noFocusHere('), src.indexOf('function noFocusHere(') + 700);
    assert.ok(/DATA\.focusName/.test(say), `${app}: the message names an id rather than the view`);
    assert.ok(/statline/.test(say), `${app}: the message is not written anywhere a reader looks`);
  });
}

test('analytics: the panel does not offer a diagram that cannot contain the view', () => {
  const src = read('apps/analytics/sidepanel.js');
  const i = src.indexOf("$('dgraph').disabled");
  assert.ok(i > 0, 'the ER button is gone');
  const block = src.slice(i - 400, i + 700);
  assert.ok(/schema\[srcId\]/.test(block),
            'the button is offered for a view that is not in the ER model, which opens an empty window');
  assert.ok(/not in the ER model/.test(block), 'the two different «no»s are still one message');
});

test('analytics: the panel opens the diagram for an entity with no relations', () => {
  // «No relation» is not «nothing to show»: the window draws that entity alone and says nothing
  // links to it, which is the finding somebody focusing it was asking for. Greying the button out
  // hid that answer, and it was reported as a bug twice in one session - first as an empty sheet,
  // then as a button that would not open.
  const src = read('apps/analytics/sidepanel.js');
  const i = src.indexOf("$('dgraph').disabled");
  const line = src.slice(i, src.indexOf('\n', i));
  assert.ok(!/relationsOf/.test(line),
            `the button still refuses a view with no relations: ${line.trim()}`);
  assert.ok(/inDiagram/.test(line), 'the button no longer checks that the diagram contains the view');
});

// ---------------------------------------------------------------------------------------------
// Every line that counts boxes counts the same boxes.
//
// Folding a branch takes boxes off the drawing. `erFit`, the print handler, `erCovers` and the tab
// badge were each taught to skip what is folded - four readers of one piece of state, fixed one at
// a time as somebody noticed. The fifth was the status line's own breakdown, sitting *beside* the
// badge: fold three boxes and the badge said they were gone while the line next to it went on
// counting them. The note in `erCovers` describes that in exactly those words; the prose was right
// and the code was behind it.
//
// Run rather than read: the property is «the number drops when a box is folded», and a check that
// looked for the name `erHiddenSet` would pass on a call that does nothing with it.
test('crm: the status breakdown stops counting a box that was folded away', () => {
  const NODES = {
    'a.one': { id: 'a.one', name: 'one', namespace: 'a', calls: ['a.two'], called_by: [] },
    'a.two': { id: 'a.two', name: 'two', namespace: 'a', calls: [], called_by: ['a.one'] },
  };
  // The context is built here rather than through `load()` because the test *changes* two of its
  // globals between calls - `curView` and what the fold hides - and `load` hands back the values it
  // was asked for, not the context they live in. Reassigning those had no effect and the first
  // version of this reported the defect as still present after it had been fixed.
  const ctx = {
    Object, Set, String,
    N: NODES,
    entityOf: () => 'function',
    entitiesPresent: () => ['function'],
    entityWord: () => 'function',
    passKind: () => true,
    curView: 'er',
    erHiddenSet: () => new Set(),
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('apps/crm/graphview.js', 'entityBreakdown'), ctx);
  const run = () => vm.runInContext('entityBreakdown()', ctx);

  const whole = run();
  assert.match(whole, /<b>2<\/b>/, `it stopped counting what is drawn: ${whole}`);

  // Fold one away: the count must follow, and must say «of 2» so the reader is told what it is a
  // fraction of - the same shape the chips already use.
  ctx.erHiddenSet = () => new Set(['a.two']);
  const folded = run();
  assert.match(folded, /<b>1<\/b>/,
    `a folded box is still counted here while the tab badge beside it says it is gone: ${folded}`);
  assert.match(folded, /of 2/, `the reader is not told what the 1 is out of: ${folded}`);

  // And outside the ER view there is no folding, so nothing changes.
  ctx.curView = 'graph';
  assert.match(run(), /<b>2<\/b>/, 'the fold is applied where folding does not exist');
});
