/*
 * graphview.test.mjs — erFit(), the one place the diagrams turn a measurement into a scale.
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
