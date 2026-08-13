/*
 * capture.mjs - talk to an already-running Chrome: measure its viewport, or take one screenshot.
 *
 *   node tools/capture.mjs <ws-url> --probe
 *   node tools/capture.mjs <ws-url> <page-uri> <out.png> <capMs>
 *
 * Why this exists: `chrome --headless --screenshot` starts a browser per image, and the first capture
 * in any browser costs about forty-five seconds here while the compositor produces its first frame -
 * every capture after it costs three tenths of a second. Measured inside one browser: 45s, then 0.3s,
 * 0.3s. Twenty-seven images therefore cost twenty-seven warm-ups, which is where thirty-four minutes
 * went. One browser, twenty-seven navigations, one warm-up.
 *
 * Node rather than Python because a CDP client needs a WebSocket, node has had one built in since 21,
 * and the alternatives were a dependency or hand-rolled framing. The suite already requires node.
 *
 * **The viewport is set by sizing the window at launch, never by emulating device metrics, and never
 * by `Browser.setWindowBounds`.** Neither of those is a preference:
 *
 *   - `Emulation.setDeviceMetricsOverride` lays the page out differently. The picture it produced
 *     differed from the flag version on 10.010% of its pixels, scattered over 1121 rows - measured
 *     with tools/pngsame.py, and that is what a layout shifted by a pixel looks like.
 *   - `Browser.setWindowBounds` is accepted at runtime and does nothing here: asked for 887 to get an
 *     800px viewport, the page kept reporting 713 however long it was given to settle.
 *
 * A window sized at launch produces a file byte-identical to `--screenshot`, which is the whole
 * requirement: these pictures are published. `--probe` exists so the caller can discover how much
 * bigger than its viewport this Chrome's window is, rather than carry a number an update will falsify.
 *
 * **When to capture is asked of the page, not guessed.** `--virtual-time-budget` used to answer it by
 * running the clock forward: every timer had fired by the time the capture happened. A real browser
 * has no such clock, and guessing from outside does not work - a fixed 4-6s wait left six of the
 * twenty-seven images different, and waiting for two identical captures left twenty-one, because
 * these pages are perfectly still right after load, before the shot script has run at all. The stub
 * counts the timers and frames it has outstanding in `__zoostPending`; this waits for that to reach
 * zero. `capMs` is a ceiling for a page that never settles, not a wait.
 */
import fs from 'node:fs';

const [wsUrl, arg2, out, capMs] = process.argv.slice(2);

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

let id = 0;
const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const call = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id;
  waiting.set(n, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params, sessionId }));
});

// A page of its own per capture: a shot leaves state behind - a filter, a selection, a listener on
// the window - and the next one would inherit it. Creating a target is milliseconds; the warm-up this
// file exists to avoid belongs to the browser, not to the page.
const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
const to = (method, params = {}) => call(method, params, sessionId);
const evaluate = async (expression) => (await to('Runtime.evaluate', {
  expression, returnByValue: true,
})).result.value;

if (arg2 === '--probe') {
  process.stdout.write((await evaluate('[innerWidth, innerHeight]')).join('x'));
} else {
  await to('Page.enable');
  await to('Page.navigate', { url: arg2 });
  const deadline = Date.now() + (+capMs || 20000);
  let quiet = 0;
  for (;;) {
    // Two readings of zero rather than one: a callback that reschedules drops the count to zero for
    // an instant between the two, and a single reading would take that instant for the end.
    // Fonts are asked for separately because they are not timers and the counter cannot see them:
    // a face that arrives after the capture re-renders every label, which is exactly the kind of
    // difference that showed up on the text-heavy shots and nowhere else.
    const state = await evaluate(
      '[document.readyState, (window.__zoostPending === undefined ? 0 : window.__zoostPending),'
      + ' document.fonts ? document.fonts.status : "loaded"]');
    quiet = (state && state[0] === 'complete' && state[1] === 0 && state[2] === 'loaded')
      ? quiet + 1 : 0;
    if (quiet >= 2 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  // Then, and only then, the picture itself has to hold still. The counter sees timers and frames;
  // it cannot see work driven by events - the panel shots read a fixture workspace through an
  // IndexedDB shim, and those callbacks are not timers - so two of twenty-seven still came out
  // differently between two consecutive runs of this. Neither test is sufficient alone: waiting only
  // for stillness fires before the shot script has run, because the page is perfectly still then.
  const shot = async () => (await to('Page.captureScreenshot', { format: 'png', fromSurface: true })).data;
  let data = await shot();
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const again = await shot();
    if (again === data || Date.now() > deadline) { data = again; break; }
    data = again;
  }
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
}
await call('Target.closeTarget', { targetId });
ws.close();
