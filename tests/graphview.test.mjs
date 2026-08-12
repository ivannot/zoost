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
import { sliceFn, read } from './slice.mjs';
import vm from 'node:vm';

/** erFit() lifted out of an app's graph window, over a panel of a stated size.
 *
 * The globals are the ones the function reads. `state` is the context object itself, so an
 * assignment inside the slice is visible on it afterwards - that is how the assertions read back
 * erScale without the function returning anything, which it does not.
 */
function fitter(app, panel, geom = { maxX: 553, maxY: 494 }) {
  let applied = 0;
  const state = {
    erMaxX: geom.maxX, erMaxY: geom.maxY, erIds: [], erPos: {},
    // Values nothing would ever compute, so "untouched" is distinguishable from "recomputed".
    erScale: -1, erTx: -1, erTy: -1, erUserMoved: true,
    $: () => ({ clientWidth: panel.w, clientHeight: panel.h }),
    erApply: () => { applied++; },
  };
  const ctx = vm.createContext(state);
  vm.runInContext(sliceFn(`apps/${app}/graphview.js`, 'erFit'), ctx);
  return { fit: () => vm.runInContext('erFit()', ctx), state, applied: () => applied };
}

// The measured numbers from the render: the sample schema draws 553x494 of boxes into a 1280x583
// panel. `pad` is 40 a side, so the scale is min((1280-80)/553, (583-80)/494) = min(2.170, 1.018).
const REAL = { w: 1280, h: 583 };
const REAL_SCALE = 1.0182;

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
    assert.ok(/erParams: \{ current: lay \}/.test(oj),
      'the erParams object carries something besides the layout values');
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
    erVisibleIds: () => ids,
    erConcentric: () => true,                   // the branch under test; the free one is not entered
    erBoxSize: (n) => ({ w: 190, h: 28 + n.rows * 18 }),
  };
  const ctx = vm.createContext(state);
  // `collideBoxes` goes with it. erLayout calls it, and a slice that leaves a callee behind throws a
  // ReferenceError three lines in - the free-variable trap this repository has already recorded once,
  // and it fired again here the moment the pass was extracted into its own function. The suite caught
  // it, which is the argument for the suite.
  vm.runInContext(['erLayout', 'collideBoxes']
    .map((f) => sliceFn(`apps/${app}/graphview.js`, f)).join('\n\n'), ctx);
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

function collide(app, { pos, ids }, margin = 28) {
  const ctx = vm.createContext({ erPos: pos });
  vm.runInContext(sliceFn(`apps/${app}/graphview.js`, 'collideBoxes'), ctx);
  ctx.list = ids; ctx.margin = margin;
  vm.runInContext('collideBoxes(list, margin)', ctx);
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
    });
    vm.runInContext(sliceFn(`apps/${app}/graphview.js`, 'erCovers'), ctx);
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
    const lay = sliceFn(`apps/${app}/graphview.js`, 'erLayout');
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
      erArranged: true, erHeld: held, erLastKept: 0,
    };
    const ctx = vm.createContext(state);
    vm.runInContext(['erLayout', 'collideBoxes']
      .map((f) => sliceFn(`apps/${app}/graphview.js`, f)).join('\n\n'), ctx);
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
