#!/usr/bin/env python3
"""tools/probe.py - drive the shipped panels in a real browser and fail if they misbehave.

A rendered page proves it loads. It does not prove that a button does what its tooltip says, and the
panels are 5000 lines of DOM-bound code that `tests/slice.mjs` can only reach one function at a time:
«a correct helper called from the wrong place still passes» is written in the notes, and this is the
half that was missing. What is checked here is *wiring* - a click, a keypress, the state afterwards.

No new machinery: the shot stub already runs a script after load and turns a throw into a
`SHOT ERROR:` title that `shots.capture()` refuses, so a script that asserts is a test. Chrome is the
only requirement, and where there is none this says so and exits 0 rather than reporting a pass it
did not earn - the same rule `tools/totest.sh` follows for a folder that is not mounted.

Every case here is a defect that happened. Following a link and being unable to come back (reported).
Going back after a jump and landing nowhere. A step recorded while replaying, which makes `back`
walk on the spot. A jump into a tab hidden in Settings leaving the row with no segment lit - which
was real, and which the unit tests could not see because it lives in the gap between two functions.
"""
import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
spec = importlib.util.spec_from_file_location("shots", ROOT / "tools" / "shots.py")
shots = importlib.util.module_from_spec(spec); spec.loader.exec_module(shots)

CRM = """
  const say = (m) => { throw new Error(m); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    const rows = () => [...document.querySelectorAll('#tree .f')];
    const first = rows().find((e) => /Build invoice/.test(e.textContent));
    const second = rows().find((e) => /Sync contact/.test(e.textContent)) || rows().find((e) => e !== first);
    if (!first || !second) say('the fixture tree has fewer than two functions');
    first.click(); await wait(600);
    const a = currentPath;
    second.click(); await wait(600);
    const b = currentPath;
    if (a === b) say('two different rows opened the same path');
    if (navHist.length !== 2) say('two steps should be two entries, got ' + navHist.length);
    if (!$('pvback').classList.contains('show')) say('back is not offered after two steps');
    if ($('pvfwd').classList.contains('show')) say('forward is offered with nothing ahead');

    // back
    $('pvback').click(); await wait(900);
    if (currentPath !== a) say('back did not return to the first function: ' + currentPath);
    if (!$('pvfwd').classList.contains('show')) say('forward is not offered after going back');

    // forward
    $('pvfwd').click(); await wait(900);
    if (currentPath !== b) say('forward did not return to the second function: ' + currentPath);

    // the chain itself, and a jump to a specific step
    $('pvchain').click(); await wait(200);
    const menu = [...document.querySelectorAll('#pvchainmenu .nvrow')];
    if (menu.length !== 2) say('the chain shows ' + menu.length + ' steps, expected 2');
    if (!menu[0].classList.contains('at')) say('the newest row is not marked as where we are');
    menu[1].click(); await wait(900);
    if (currentPath !== a) say('clicking a step in the chain did not go there: ' + currentPath);

    // across a change of tab: the whole point of a history that is not per-list
    const seg = [...document.querySelectorAll('.seg')].find((s) => /Workflows/.test(s.textContent));
    if (seg) {
      seg.click(); await wait(1200);
      const wf = [...document.querySelectorAll('#tree .f')][0];
      if (wf) {
        wf.click(); await wait(900);
        if (!/^workflows\\//.test(currentPath || '')) say('a workflow row did not open a workflow');
        // Having gone back to step 0 and then somewhere new, what was ahead is gone - a browser
        // does exactly this - so the chain is two long and we are at its end.
        if (navHist.length !== 2 || navPos !== 1) say('the forward tail was not dropped: ' + navHist.length + '@' + navPos);
        if (navHist[0].path !== a) say('the step behind is not the function we came from');
        $('pvback').click(); await wait(1500);
        if (currentPath !== a) say('back across tabs landed on ' + currentPath);
        if (viewMode !== 'functions') say('back across tabs did not return to the Functions tab');
      }
    }
    // A tab the reader hid in Settings is still somewhere a link can land. The row must show it
    // while we are on it, or the panel reads as having lost its place.
    tabPrefs.hidden = ['workflows'];
    renderTabs(); await wait(400);
    if ([...document.querySelectorAll('.seg')].some((s) => s.dataset.tab === 'workflows'))
      say('a hidden tab still has a segment when we are not on it');
    setMode('workflows'); await wait(600);
    const seg2 = [...document.querySelectorAll('.seg')].find((s) => s.dataset.tab === 'workflows');
    if (!seg2) say('jumping to a hidden tab left the row without its segment');
    if (!seg2.classList.contains('active')) say('the segment is there but nothing is lit');

    // And an area the Zoho role forbids is refused rather than opened.
    tabPrefs.hidden = [];
    tabAccess.schedules = { state: 'forbidden' };
    const before = viewMode;
    healthOpenSchedule('1', 'x'); await wait(500);
    if (viewMode !== before) say('it switched into an area the role forbids');

    document.title = 'HISTORY OK';
  })().catch((e) => { document.title = 'SHOT ERROR: ' + e.message; });
"""

AN = """
  const say = (m) => { throw new Error(m); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    await wait(1600);
    const rows = () => [...document.querySelectorAll('#list tbody tr')];
    if (rows().length < 2) say('the fixture list has fewer than two views');
    rows()[0].click(); await wait(700);
    const a = selectedId;
    rows()[1].click(); await wait(700);
    const b = selectedId;
    if (a === b) say('two different rows selected the same view');
    if (navHist.length !== 2) say('two steps should be two entries, got ' + navHist.length);
    if (!$('dback').classList.contains('show')) say('back is not offered after two steps');
    if ($('dfwd').classList.contains('show')) say('forward is offered with nothing ahead');

    $('dback').click(); await wait(800);
    if (String(selectedId) !== String(a)) say('back did not return to the first view: ' + selectedId);
    $('dfwd').click(); await wait(800);
    if (String(selectedId) !== String(b)) say('forward did not return to the second view: ' + selectedId);

    $('dchain').click(); await wait(200);
    const menu = [...document.querySelectorAll('#dchainmenu .nvrow')];
    if (menu.length !== 2) say('the chain shows ' + menu.length + ' steps, expected 2');
    menu[1].click(); await wait(800);
    if (String(selectedId) !== String(a)) say('clicking a step in the chain did not go there');

    // a link inside the detail is a step too - that is what the history exists for
    const link = document.querySelector('#dbody a.fk[data-go]');
    if (link) {
      const target = link.dataset.go;
      link.click(); await wait(800);
      if (String(selectedId) !== String(target)) say('a lineage link did not open its view');
      if (navHist.length !== 2 || navPos !== 1) say('the forward tail was not dropped: ' + navHist.length + '@' + navPos);
      if (String(navHist[0].id) !== String(a)) say('the step behind is not the view we came from');
      $('dback').click(); await wait(800);
      if (String(selectedId) !== String(a)) say('back from a link landed on ' + selectedId);
    }
    document.title = 'HISTORY OK';
  })().catch((e) => { document.title = 'SHOT ERROR: ' + e.message; });
"""


def main() -> int:
    if not shots.have_chrome():
        print("probe: no Chrome here - nothing driven, and nothing claimed.", flush=True)
        return 0
    shots._browser_for(1280, 800, 1.0)
    try:
        for key, app, ws, script in (("probe-crm", "crm", "crm/sampleorg-1234567890", CRM),
                                     ("probe-analytics", "analytics", "analytics/sample-workspace", AN)):
            print(f"  {key:18s} driving\u2026", flush=True)
            dest = shots.render_panel((key, app, ws, script))
            dest.unlink(missing_ok=True)          # a probe is not a picture to publish
            print(f"  {key:18s} ok", flush=True)
    finally:
        shots._browser_stop()
    print("probe: both panels navigate as documented.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
