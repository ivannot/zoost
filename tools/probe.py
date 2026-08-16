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
    // Declared before anything uses it: open the history view only if it is not already open.
    // Clicking a toggle blind is how this check once read rows out of a panel it had just closed.
    const openChain = async () => { if (!$('navview').classList.contains('show')) { $('navtab').click(); await wait(300); } };
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
    const shown = (id) => getComputedStyle($(id)).display !== 'none';
    if (!shown('pvback')) say('back is not offered after two steps');
    if (shown('pvfwd')) say('forward is painted with nothing ahead');
    if (!shown('navtab')) say('the history is not offered from the tab row with two steps in it');
    const mk = $('pvback').querySelector('svg.nvmk');
    if (!mk) say('the arrows are font glyphs again');
    if (mk.getBoundingClientRect().width < 15) say('the arrows are smaller than asked for: ' + mk.getBoundingClientRect().width);
    // Reported as «not looking clickable»: the pointer was already right over the drawing, so what
    // is checked is the hit area and that nothing about the cursor differs between the span and the
    // mark inside it.
    const bb = $('pvback').getBoundingClientRect();
    if (bb.width < 20 || bb.height < 20) say(`back is a ${bb.width}x${bb.height} target`);
    if (getComputedStyle($('pvback')).cursor !== 'pointer') say('back does not say it is clickable');
    if (getComputedStyle($('pvback').querySelector('svg')).cursor !== 'pointer') say('back: the cursor changes over the mark');
    // The history control belongs to the tab row, so it is measured against the tabs beside it - the
    // arrows' 22px square would be wrong here and a number of its own would be a number nobody chose.
    const oneTab = document.querySelector('#modebar .seg'), nav = $('navtab').getBoundingClientRect();
    if (oneTab && Math.abs(nav.height - oneTab.getBoundingClientRect().height) > 1)
      say(`the history control is ${nav.height}px against the tabs' ${oneTab.getBoundingClientRect().height}px`);
    if (nav.width < 24) say(`the history control is only ${nav.width}px wide`);

    // back - and the pane must not close on the way. Reported: it shut, selected the row and
    // reopened, which is what calling setMode() for a tab you are already on does.
    let blinked = 0;
    const watch = new MutationObserver(() => { if (!$('preview').classList.contains('show')) blinked++; });
    watch.observe($('preview'), { attributes: true, attributeFilter: ['class'] });
    $('pvback').click(); await wait(900);
    watch.disconnect();
    if (blinked) say('the detail pane closed ' + blinked + ' time(s) during a step on the same tab');
    if (currentPath !== a) say('back did not return to the first function: ' + currentPath);
    if (!$('pvfwd').classList.contains('show')) say('forward is not offered after going back');

    // forward
    $('pvfwd').click(); await wait(900);
    if (currentPath !== b) say('forward did not return to the second function: ' + currentPath);

    // the chain itself, and a jump to a specific step
    await openChain();
    const menu = [...document.querySelectorAll('#navbody .nvrow')];
    if (menu.length !== 2) say('the chain shows ' + menu.length + ' steps, expected 2');
    if (!menu[0].classList.contains('at')) say('the newest row is not marked as where we are');
    menu[1].click(); await wait(900);
    if (currentPath !== a) say('clicking a step in the chain did not go there: ' + currentPath);
    if ($('navview').classList.contains('show')) say('the history stayed open over what it just opened');

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
    // The history is a view, not a layer: opened from the tab row it covers everything that row
    // controls - the pull bar, the search box and the list - and there is nothing positioned left to
    // be misplaced by a resize, which is what was reported.
    $('navtab').click(); await wait(300);
    if (!$('navview').classList.contains('show')) say('the history view did not open');
    // It replaces the list and the pane, and keeps the chrome a list needs: the search box and Name
    // stay, the pull bar stays but goes dead, the chip row goes.
    for (const sel of ['#tree', '#chiprow', '#preview']) {
      const el = document.querySelector(sel);
      // offsetParent, not computed display: an element inside a hidden parent still reports its own
      // display, which is how this check passed over a list that was plainly gone.
      if (el && el.offsetParent !== null) say(`${sel} is still on screen behind the history`);
    }
    for (const id of ['modebar', 'find', 'nameToggle']) {
      if ($(id).offsetParent === null) say(`${id} went away with the list`);
    }
    // and Name acts on the chain while the chain is what is on screen - on a row that *is* a
    // function, since a rule has one name and could never follow it.
    const fRow = () => [...document.querySelectorAll('#navbody .nvrow')]
      .find((r) => r.querySelector('.nvk').textContent === 'function');
    if (!fRow()) say('no function in the chain to try Name against');
    const wasNamed = fRow().querySelector('.nvl').textContent;
    $('nameToggle').click(); await wait(300);
    if (fRow().querySelector('.nvl').textContent === wasNamed) say('Name did nothing to the history');
    $('nameToggle').click(); await wait(300);
    for (const id of ['pull', 'pullone', 'refresh']) {
      if (!$(id).disabled) say(`${id} is still live over a list of where you have been`);
    }
    // the box filters the chain rather than the list underneath
    $('find').value = 'zzzznothing'; $('find').dispatchEvent(new Event('input')); await wait(300);
    if (document.querySelectorAll('#navbody .nvrow').length) say('the search does not filter the history');
    $('find').value = ''; $('find').dispatchEvent(new Event('input')); await wait(300);
    if (!document.querySelectorAll('#navbody .nvrow').length) say('clearing the box did not bring the chain back');
    // It takes the height it can: whatever is left under the rows above it, with nothing collapsed
    // beside it. Reported as «deve occupare tutto lo spazio possibile anche in altezza».
    const vb = $('navview').getBoundingClientRect();
    const room = innerHeight - vb.top;
    if (vb.height < room - 60) say(`the history uses ${Math.round(vb.height)}px of the ${Math.round(room)}px below it`);
    document.body.style.width = '420px'; await wait(250);
    const box = $('navview').getBoundingClientRect(), bar = $('modebar').getBoundingClientRect();
    if (box.top < bar.bottom - 2) say('a narrower panel put the history over the tabs');
    document.body.style.width = '';
    $('navtab').click(); await wait(300);
    if ($('navview').classList.contains('show')) say('the history view did not close again');

    // Each step says when it was taken, and today's steps say only the time.
    const row = document.querySelector('#navbody .nvrow .nvw');
    if (!row || !/\\d{1,2}[:.]\\d{2}/.test(row.textContent)) say('a step does not say when it was taken: ' + (row && row.textContent));

    // The chain names things the way the tree does, and follows the name toggle. Reported: it kept
    // the name captured when the step was taken, so the two lists disagreed about the same item.
    // Open it if it is not already: clicking a toggle blind is how this check spent an afternoon
    // reading rows from a panel it had just closed.
    await openChain();
    // On the row that *is* a function: a workflow has one name and could never follow the toggle,
    // so asserting on whatever happens to be newest tests the fixture rather than the panel.
    const fnRow = () => [...document.querySelectorAll('#navbody .nvrow')]
      .find((r) => r.querySelector('.nvk').textContent === 'function');
    if (!fnRow()) say('no function in the chain to check the name toggle against');
    const named1 = fnRow().querySelector('.nvl').textContent;
    $('nameToggle').click(); await wait(500);
    const named2 = fnRow().querySelector('.nvl').textContent;
    if (named1 === named2) say('the chain did not follow the name toggle: still ' + named2);
    const inTree = [...document.querySelectorAll('#tree .f[aria-selected="true"]')][0];
    if (inTree && !inTree.textContent.includes(named2)) say(`the chain says «${named2}» and the tree «${inTree.textContent.trim()}»`);
    $('nameToggle').click(); await wait(400);

    // And it keeps saying so from another tab, where the list it could be derived from is a
    // different list entirely - which is how the chain came to show raw `.dg` file names.
    const bad = navHist.filter((x) => !x.path);
    if (bad.length) say('a step with no path: ' + JSON.stringify(navHist.map((x) => [x.path, x.label])));
    const seg0 = [...document.querySelectorAll('.seg')].find((s) => /Workflows/.test(s.textContent));
    if (seg0) {
      seg0.click(); await wait(1000);
      await openChain();
      const r = fnRow();
      if (r && /\\.dg$/.test(r.querySelector('.nvl').textContent))
        say('from another tab the chain fell back to a file name: ' + r.querySelector('.nvl').textContent);
      [...document.querySelectorAll('.seg')].find((s) => /Functions/.test(s.textContent)).click();
      await wait(900);
    }

    // Clear empties the chain and keeps what is open.
    const showing = currentPath;
    await openChain();
    document.querySelector('#navclear').click(); await wait(300);
    if (navHist.length !== 1) say('Clear left ' + navHist.length + ' steps');
    if (currentPath !== showing) say('Clear closed what was open');
    if (shown('pvback')) say('back is still painted after Clear');

    // A function is a function in the chain, whatever its file is called.
    if (currentPath && navKind(currentPath) !== 'function') say('a function is classified as ' + navKind(currentPath));

    // The callers are chips, and each is a link.
    const chip = document.querySelector('#pvcallers .fnchips a.wf-fn');
    if (chip && !/\u0192/.test(chip.textContent)) say('the caller chip has lost its mark');

    // The caller chip must stay readable under the mouse: an id selector in this container beat the
    // chip's own hover colour and the label went blue on blue. Reported with a picture.
    const chip2 = document.querySelector('#pvcallers .fnchips a.wf-fn');
    if (chip2) {
      const ink = getComputedStyle(chip2).color, fill = getComputedStyle(chip2).backgroundColor;
      const rgb = (s) => (s.match(/\\d+/g) || []).slice(0, 3).map(Number);
      const [r1, g1, b1] = rgb(ink), [r2, g2, b2] = rgb(fill);
      if (Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) < 90)
        say(`the caller chip is ${ink} on ${fill} - unreadable`);
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
  })().catch((e) => { document.title = 'SHOT ERROR: ' + e.message + ' @@ ' + (e.stack || '').split('\\n').slice(0, 3).join(' / '); });
"""

AN = """
  const say = (m) => { throw new Error(m); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    const openChain = async () => { if (!$('navview').classList.contains('show')) { $('navtab').click(); await wait(300); } };
    await wait(1600);
    const rows = () => [...document.querySelectorAll('#list tbody tr')];
    if (rows().length < 2) say('the fixture list has fewer than two views');
    rows()[0].click(); await wait(700);
    const a = selectedId;
    rows()[1].click(); await wait(700);
    const b = selectedId;
    if (a === b) say('two different rows selected the same view');
    if (navHist.length !== 2) say('two steps should be two entries, got ' + navHist.length);
    const shown = (id) => getComputedStyle($(id)).display !== 'none';
    if (!shown('dback')) say('back is not offered after two steps');
    if (shown('dfwd')) say('forward is painted with nothing ahead');
    const mk = $('dback').querySelector('svg.nvmk');
    if (!mk) say('the arrows are font glyphs again');
    const mw = mk.getBoundingClientRect();
    if (mw.width < 15) {
      const d = $('detail').getBoundingClientRect(), sb = $('dback').getBoundingClientRect();
      say(`mark ${mw.width}x${mw.height} | span ${sb.width}x${sb.height} | detail ${d.width}x${d.height} show=${$('detail').className} | svgw=${getComputedStyle(mk).width}`);
    }

    $('dback').click(); await wait(800);
    if (String(selectedId) !== String(a)) say('back did not return to the first view: ' + selectedId);
    $('dfwd').click(); await wait(800);
    if (String(selectedId) !== String(b)) say('forward did not return to the second view: ' + selectedId);

    await openChain();
    const menu = [...document.querySelectorAll('#navbody .nvrow')];
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
