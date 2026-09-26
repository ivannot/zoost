#!/usr/bin/env python3
"""tools/probe.py - drive the shipped panels in a real browser and fail if they misbehave.

A rendered page proves it loads. It does not prove that a button does what its tooltip says, and the
panels are 5000 lines of DOM-bound code that `tests/slice.mjs` can only reach one function at a time:
«a correct helper called from the wrong place still passes» is written in the notes, and this is the
half that was missing. What is checked here is *wiring* - a click, a keypress, the state afterwards.

No new machinery: the shot stub already runs a script after load and turns a throw into a
`SHOT ERROR:` title that `shots.capture()` refuses, so a script that asserts is a test. Chrome is the
only requirement. A local machine without it says so and exits without claiming a pass; the official
CI sets `ZOOST_REQUIRE_CHROME=1`, so the same absence is a failure there rather than a quietly empty
product check.

Every case here is a defect that happened. Following a link and being unable to come back (reported).
Going back after a jump and landing nowhere. A step recorded while replaying, which makes `back`
walk on the spot. A jump into a tab hidden in Settings leaving the row with no segment lit - which
was real, and which the unit tests could not see because it lives in the gap between two functions.
"""
import importlib.util
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
spec = importlib.util.spec_from_file_location("shots", ROOT / "tools" / "shots.py")
shots = importlib.util.module_from_spec(spec); spec.loader.exec_module(shots)

CRM = """
  const say = (m) => { throw new Error(m); };
  // **A click on a control that is not on screen neither throws nor works**, which is the worst
  // shape a step in a driver can have: the ER scenario opened by clicking the diagram tab, which
  // carries `display:none` until the graph lands, and a run that lost that race failed three lines
  // later saying «the fixture draws 0 boxes» - a sentence about the fixture, describing a race.
  //
  // This was a static sweep first, and the static sweep could not see it: the click goes through a
  // helper, so of the 75 in these scenarios it read 40 and could judge 2. Deleting the guard it was
  // written for changed its answer not at all. Text cannot answer «is this element on screen»; the
  // page can, so the question is asked here, where a wrong answer is a thrown error naming the
  // control instead of a failure three lines later about something else.
  (() => {
    const real = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function clickOnScreen() {
      const cs = getComputedStyle(this);
      const why = !this.isConnected ? 'not in the document'
        : cs.display === 'none' ? 'display:none'
        : cs.visibility === 'hidden' ? 'visibility:hidden'
        : '';
      // `offsetParent === null` was tried as a fourth condition and taken out again: it is also null
      // for a `position:fixed` element, for one inside a `display:contents` box, and before the first
      // layout - so it reported controls that are on screen. The three above are unambiguous and are
      // exactly «the product is hiding this», which is the thing that made a click a silent no-op.
      if (why) say(`clicked a control that is not on screen (${why}): ${this.id || this.className || this.tagName}`);
      return real.apply(this, arguments);
    };
  })();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wait for the thing, with the same ceiling as the sleep it replaces.
  //
  // A click, a fixed sleep, then a read is a bet that the panel finished inside that sleep. (Written
  // without the code, because the counter below reads this text and a quoted example counted as a
  // fifth bet in every scenario - a check reading its own prose, which this repository has met
  // three times.)
  // It is the shape this repository has already written down and condemned - «read scrollTop after a
  // second is the 1990s junior's sleep, and it produces a fix of the same shape: one that waits
  // instead of knowing» - living in the tool built to catch exactly that class. A bet costs the full
  // number every run when it wins, and reads unsettled state when it loses; a condition costs a few
  // milliseconds and, when it does time out, says which condition never came true instead of failing
  // three lines later about something else.
  const until = async (cond, what, ms = 2500) => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = cond(); } catch (_) { ok = false; }
      if (ok) return;
      if (Date.now() - t0 > ms) say('waited ' + ms + 'ms and ' + what);
      await wait(25);
    }
  };
  // **«The panel has stopped changing» is a condition; «300ms» is a bet.** Most waits in these
  // scenarios are a click followed by a sleep followed by a read, which is the shape this repository
  // has already condemned in the product and kept in the tool built to catch it. This watches the
  // document and returns as soon as it has been quiet for a moment - so a fast machine costs
  // milliseconds, a slow one is still correct, and a panel that never redraws says so by name
  // instead of failing three lines later on whatever the click was supposed to have produced.
  //
  // What it does not cover, stated: work that finishes without touching the DOM. Those stay sleeps,
  // and the counter at the end of the run prints how many are left.
  let _lastMut = 0;
  new MutationObserver(() => { _lastMut = Date.now(); })
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  const settle = async (what, quiet = 150, ms = 4000) => {
    _lastMut = Date.now();
    await until(() => Date.now() - _lastMut > quiet, what || 'the panel never stopped redrawing', ms);
  };
  let copied = null;
  const navState = () => navHistory.snapshot();
  (async () => {
    // Declared before anything uses it: open the history view only if it is not already open.
    // Clicking a toggle blind is how this check once read rows out of a panel it had just closed.
    const openChain = async () => {
      if ($('navview').classList.contains('show')) return;
      $('navtab').click(); await settle();
      await until(() => $('navview').classList.contains('show'), 'the history view never opened');
    };
    await until(() => !$('overview').disabled, 'the workspace overview never became available');
    $('overview').click();
    await until(() => $('overviewview').classList.contains('show') && document.querySelectorAll('.ovcard').length === 7,
      'the CRM overview never drew its seven areas');
    if (!document.body.classList.contains('overview-open')) say('the CRM overview did not own the panel');
    for (const card of document.querySelectorAll('.ovcard')) {
      if (!/^[0-9]+$/.test(card.querySelector('.ovcount').textContent.trim()))
        say('the CRM sample overview presented an area count as unknown: ' + card.textContent);
    }
    if (document.querySelectorAll('.ovstep').length !== 3) say('the CRM sample did not draw the three-step onboarding path');
    if (!document.querySelector('.ovstep[data-step="mirror"].done')) say('the CRM sample did not say its invented mirror is ready');
    if (!$('ovbrowse').classList.contains('next')) say('the CRM sample did not identify Browse as the next action');
    if (getComputedStyle($('ovpull')).display !== 'none') say('the CRM sample overview offered a pull from Zoho');
    // **A grant that comes back has to take the views with it.** Reported, in this order: the folder
    // grant lapses, the overview says so, a click anywhere in the panel restores access, the status
    // line clears - and the overview goes on showing every area as «Not available» over a sentence
    // about access that is no longer true. The defect is in the call site, which nothing can lift:
    // `resetView()` rebuilds the open views and is reached only when the workspace *changed*, so
    // re-activating the same one redrew nothing.
    {
      const heldDir = dir.getDirectoryHandle, heldAsk = dir.queryPermission;
      // What a lapsed grant does, on the handle the panel holds. The question the adapter asks on a
      // failed read is answered the way the API answers it.
      dir.getDirectoryHandle = async () => { const e = new Error('permission'); e.name = 'NotAllowedError'; throw e; };
      dir.queryPermission = async () => 'prompt';
      forgetDirs();
      $('overview').click(); await settle();          // closed
      $('overview').click();                          // and open again, on a folder that refuses
      await until(() => [...document.querySelectorAll('.ovcard .ovstate')].every((s) => /Not available/.test(s.textContent)),
                  'a refusing folder did not reach the overview at all');
      if (![...document.querySelectorAll('.ovissue')].some((b) => /Folder access has lapsed/.test(b.textContent)))
        say('the overview blamed the local files for a folder that had stopped answering');
      // The remedy the panel advertises, exercised as a user does it: one click, anywhere.
      dir.getDirectoryHandle = heldDir; dir.queryPermission = heldAsk;
      document.body.click();
      await until(() => [...document.querySelectorAll('.ovcard .ovcount')].every((c) => /^[0-9]+$/.test(c.textContent.trim())),
                  'access came back and the overview stayed on the refusal', 6000);
      if ([...document.querySelectorAll('.ovissue')].some((b) => /Folder access has lapsed/.test(b.textContent)))
        say('the overview still says access has lapsed after it was granted');
    }
    $('ovbrowse').click();
    await until(() => !$('overviewview').classList.contains('show'), 'Browse did not close the CRM overview');
    const rows = () => [...document.querySelectorAll('#tree .f')];
    // Drive the panel adapter around the pure list model. Counting only would miss an order that is
    // right in memory and wrong on screen, so the flat sort compares every path in sequence.
    {
      const type = [...document.querySelectorAll('#typechips select')]
        .find((select) => select.getAttribute('aria-label') === 'Type filter');
      if (!type) say('the Functions type filter is not on screen');
      const option = [...type.options].map((item) => item.value).find((value) => {
        if (value === 'all') return false;
        const picked = selectFunctionRows(treeData, { typeFilter: value, langFilter,
          languageFamily: langFamily, languageLabel: langFamilyLabel, label: labelOf });
        return picked.rows.length > 0 && picked.rows.length < treeData.length;
      });
      if (!option) say('the sample has no function type that narrows the list - the case cannot run');
      type.value = option; type.onchange(); await settle('the function filter never finished drawing');
      const expectedCount = selectFunctionRows(treeData, { typeFilter: option, langFilter,
        languageFamily: langFamily, languageLabel: langFamilyLabel, label: labelOf }).rows.length;
      if (rows().length !== expectedCount)
        say(`the type filter drew ${rows().length} row(s), its model selected ${expectedCount}`);
      type.value = 'all'; type.onchange(); await settle('clearing the function filter never finished drawing');

      const sort = [...document.querySelectorAll('#typechips select')]
        .find((select) => select.getAttribute('aria-label') === 'Sort functions');
      if (!sort) say('the Functions sort is not on screen');
      sort.value = 'lines'; sort.onchange(); await settle('the function sort never finished drawing');
      const expected = selectFunctionRows(treeData, { typeFilter, langFilter,
        languageFamily: langFamily, languageLabel: langFamilyLabel, label: labelOf,
        sortKey: treeSort, sortDir: treeSortDir }).rows.map((row) => row.path).join('|');
      const actual = rows().map((row) => row.dataset.path).join('|');
      if (actual !== expected) say('the function order on screen is not the order its model returned');
      sort.value = 'name'; sort.onchange(); await settle('restoring the function sort never finished drawing');
    }
    const first = rows().find((e) => /Build invoice/.test(e.textContent));
    const second = rows().find((e) => /Sync contact/.test(e.textContent)) || rows().find((e) => e !== first);
    if (!first || !second) say('the fixture tree has fewer than two functions');
    const path0 = currentPath;
    first.click();
    await until(() => currentPath && currentPath !== path0, 'the first row never opened anything');
    const a = currentPath;
    second.click();
    await until(() => currentPath && currentPath !== a, 'the second row never opened anything');
    const b = currentPath;
    if (a === b) say('two different rows opened the same path');
    if (navState().entries.length !== 2) say('two steps should be two entries, got ' + navState().entries.length);
    const shown = (id) => getComputedStyle($(id)).display !== 'none';
    if (!shown('pvback')) say('back is not offered after two steps');
    if (shown('pvfwd')) say('forward is painted with nothing ahead');
    if (!shown('navtab')) say('the history is not offered from the tab row with two steps in it');
    // It stands with AI and Health, not near them: same row, same height. It was in the tab strip,
    // where `fitTabs()` shrinks the segments by measuring and left it the odd one out - and the first
    // move out of there dragged the whole tab row into the toolbar with it, which this would have
    // caught on the spot.
    const bx = (id) => $(id).getBoundingClientRect();
    for (const id of ['askai', 'health']) {
      if (Math.abs(bx('navtab').top - bx(id).top) > 1) say(`the history control is ${Math.round(bx('navtab').top - bx(id).top)}px off ${id}`);
      if (Math.abs(bx('navtab').height - bx(id).height) > 1) say(`the history control is ${bx('navtab').height}px against ${id}'s ${bx(id).height}px`);
    }
    // At the panel's minimum width every icon in the toolbar has to be reachable without scrolling
    // the row sideways - a control that is one drag off-screen is a control most people never find.
    // Measured: 335px of content in a 322px row before the separators and the export group were
    // trimmed, 305 after. Held here because nothing else would notice one more button arriving.
    //
    // **The one number this harness cannot read off the page: the gap.** The body is narrowed inside
    // a window that stays 1280px wide, so every `vw` in the stylesheet still resolves against 1280 -
    // and this row's gap is `clamp(3px, 1.4vw, 8px)`, which lands on 8px here and on about 4.8px in
    // a real 340px panel. Across eight gaps that is ~26px the check counted and the product never
    // spends: it reported «344px needed in 322» for a row that fits, and the answer to that was very
    // nearly to make the product's spacing smaller to satisfy the instrument. The window cannot be
    // narrowed instead - Chrome refuses a viewport below 500px, measured.
    //
    // So the gap is computed for the width being tested rather than read from a page laid out for
    // another one, and everything else - the controls' own widths - is measured as it is. The one
    // number copied out of the stylesheet is the clamp, and `tests/panel.test.mjs` fails if the
    // stylesheet stops saying it, so the copy cannot drift in silence.
    const wide = document.body.style.width;
    document.body.style.width = '340px'; await settle('the panel never finished reflowing');
    const grp = document.querySelector('.wsgroup');
    const items = [...grp.children].filter((c) => getComputedStyle(c).display !== 'none');
    const gap = Math.min(8, Math.max(3, 0.014 * 340));      // clamp(3px, 1.4vw, 8px) at 340px
    const needs = Math.round(items.reduce((w, c) => w + c.getBoundingClientRect().width, 0)
                             + Math.max(0, items.length - 1) * gap);
    if (needs > grp.clientWidth + 1) {
      // What it is made of, because «10px too wide» is a number nobody can act on.
      const parts = items.map((c) => (c.id || c.className) + '=' + Math.round(c.getBoundingClientRect().width)).join(' ');
      say(`the toolbar needs ${needs}px in ${grp.clientWidth}px - an icon is off-screen at the `
          + `minimum width. It holds: ${parts}`);
    }
    document.body.style.width = wide; await settle('the panel never finished reflowing');
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
    $('pvback').click(); await settle();
    watch.disconnect();
    if (blinked) say('the detail pane closed ' + blinked + ' time(s) during a step on the same tab');
    if (currentPath !== a) say('back did not return to the first function: ' + currentPath);
    if (!$('pvfwd').classList.contains('show')) say('forward is not offered after going back');

    // forward
    $('pvfwd').click(); await settle();
    if (currentPath !== b) say('forward did not return to the second function: ' + currentPath);

    // the chain itself, and a jump to a specific step
    await openChain();
    const menu = [...document.querySelectorAll('#navbody .nvrow')];
    if (menu.length !== 2) say('the chain shows ' + menu.length + ' steps, expected 2');
    if (!menu[0].classList.contains('at')) say('the newest row is not marked as where we are');
    menu[1].click(); await settle();
    if (currentPath !== a) say('clicking a step in the chain did not go there: ' + currentPath);
    if ($('navview').classList.contains('show')) say('the history stayed open over what it just opened');

    // across a change of tab: the whole point of a history that is not per-list
    const seg = [...document.querySelectorAll('.seg')].find((s) => /Workflows/.test(s.textContent));
    if (seg) {
      seg.click(); await settle();
      const wf = [...document.querySelectorAll('#tree .f')][0];
      if (wf) {
        wf.click(); await settle();
        if (!/^workflows\\//.test(currentPath || '')) say('a workflow row did not open a workflow');
        if (getComputedStyle($('codecopy')).display !== 'none') say('the copy button lingers over a workflow, which has no code');
        // Having gone back to step 0 and then somewhere new, what was ahead is gone - a browser
        // does exactly this - so the chain is two long and we are at its end.
        if (navState().entries.length !== 2 || navState().position !== 1) say('the forward tail was not dropped: ' + navState().entries.length + '@' + navState().position);
        if (navState().entries[0].path !== a) say('the step behind is not the function we came from');
        $('pvback').click(); await settle();
        if (currentPath !== a) say('back across tabs landed on ' + currentPath);
        if (viewMode !== 'functions') say('back across tabs did not return to the Functions tab');
      }
    }
    // The history is a view, not a layer: opened from the tab row it covers everything that row
    // controls - the pull bar, the search box and the list - and there is nothing positioned left to
    // be misplaced by a resize, which is what was reported.
    $('navtab').click();
    if (!$('navview').classList.contains('show')) say('the history view did not open');
    // Held against Health itself, not against numbers: «it must be identical to the one in ai and health,
    // behave the same way, and disable every other control». So the health
    // view is opened, measured, closed - and the history has to match it rectangle for rectangle and
    // dim the same set of controls.
    $('health').click();
    await until(() => $('healthview').classList.contains('show'), 'the health view never opened');
    const hBox = $('healthview').getBoundingClientRect();
    const dimmed = (skip) => [...document.querySelectorAll('.wsgroup > button')]
      .filter((b) => b.id !== skip).map((b) => getComputedStyle(b).pointerEvents).join(',');
    const hDim = dimmed('health');
    $('healthx').click();
    await until(() => !$('healthview').classList.contains('show'), 'the health view never closed');
    await openChain();
    const nBox = $('navview').getBoundingClientRect();
    for (const side of ['top', 'left', 'right', 'bottom']) {
      if (Math.abs(nBox[side] - hBox[side]) > 1)
        say(`the history is ${Math.round(nBox[side] - hBox[side])}px off the health view on ${side}`);
    }
    const nDim = dimmed('navtab');
    if (nDim !== hDim) say(`the history leaves the toolbar live: ${nDim} against health's ${hDim}`);
    if (getComputedStyle($('health')).pointerEvents !== 'none') say('Health itself is still clickable under the history');
    // and it carries its own search, since it covers the one the list uses
    $('navfind').value = 'zzzznothing'; $('navfind').dispatchEvent(new Event('input')); await settle();
    if (document.querySelectorAll('#navbody .nvrow').length) say('the search does not filter the history');
    $('navfind').value = ''; $('navfind').dispatchEvent(new Event('input')); await settle();
    if (!document.querySelectorAll('#navbody .nvrow').length) say('clearing the box did not bring the chain back');
    // Narrower: it still covers its host exactly. It is meant to be *over* the tab row now, so the
    // old check - that it stayed below the tabs - was asserting the shape this one replaced.
    document.body.style.width = '420px'; await settle('the panel never finished reflowing');
    const box = $('navview').getBoundingClientRect(), h2 = $('belowbar').getBoundingClientRect();
    if (Math.abs(box.width - h2.width) > 1 || Math.abs(box.top - h2.top) > 1)
      say(`a narrower panel left the history at ${Math.round(box.width)}px over a ${Math.round(h2.width)}px host`);
    document.body.style.width = '';
    $('navtab').click(); await settle();
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
    $('navname').click(); await settle();
    const named2 = fnRow().querySelector('.nvl').textContent;
    if (named1 === named2) say('the chain did not follow the name toggle: still ' + named2);
    const inTree = [...document.querySelectorAll('#tree .f[aria-selected="true"]')][0];
    if (inTree && !inTree.textContent.includes(named2)) say(`the chain says «${named2}» and the tree «${inTree.textContent.trim()}»`);
    $('navname').click(); await settle();

    // And it keeps saying so from another tab, where the list it could be derived from is a
    // different list entirely - which is how the chain came to show raw `.dg` file names.
    const bad = navState().entries.filter((x) => !x.path);
    if (bad.length) say('a step with no path: ' + JSON.stringify(navState().entries.map((x) => [x.path, x.label])));
    const seg0 = [...document.querySelectorAll('.seg')].find((s) => /Workflows/.test(s.textContent));
    if (seg0) {
      seg0.click(); await settle();
      await openChain();
      const r = fnRow();
      if (r && /\\.dg$/.test(r.querySelector('.nvl').textContent))
        say('from another tab the chain fell back to a file name: ' + r.querySelector('.nvl').textContent);
      [...document.querySelectorAll('.seg')].find((s) => /Functions/.test(s.textContent)).click();
      await settle('the Functions segment never drew');
    }

    // Clear empties the chain and keeps what is open.
    const showing = currentPath;
    await openChain();
    document.querySelector('#navclear').click(); await settle();
    if (navState().entries.length !== 1) say('Clear left ' + navState().entries.length + ' steps');
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


    // The code can be taken out of the panel. Reported as missing, and the clipboard is stubbed here
    // because a headless page has no permission to write to the real one - what is proven is that the
    // button is offered where there is code, absent where there is none, and that what it hands over
    // is exactly what is on screen.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (x) => { copied = x; } }, configurable: true });
    if (getComputedStyle($('codecopy')).display === 'none') say('no copy button over a function');
    $('codecopy').click(); await settle();
    if (copied !== $('pvcode').textContent) say('what was copied is not the code on screen');
    // It stands in a row of buttons, so it is the height of that row - measured against a neighbour
    // rather than given a number, which is how it came out 28px beside their 22.
    const cb = $('codecopy').getBoundingClientRect(), nb = $('pvtab_code').getBoundingClientRect();
    if (Math.abs(cb.height - nb.height) > 1) say(`the copy button is ${cb.height}px against the row's ${nb.height}px`);
    if (Math.abs(cb.top - nb.top) > 1) say('the copy button is not on the same line as the tabs beside it');
    if (!$('codecopy').querySelector('svg')) say('the mark is gone after a copy');
    // It belongs to the pane that holds code, so it goes away with it: on «Details», and on a module,
    // which has no code at all. It stayed lit on both - visible in a picture published on the site.
    $('pvtab_info').click(); await settle();
    if (getComputedStyle($('codecopy')).display !== 'none') say('the copy button is still there on Details');

    // **One vocabulary for «a reference you can open».** Every rule, schedule, blueprint, action and
    // button a function's «Used in» names carried `aplink`, a class emitted in four places and
    // defined in none - so it rendered as bare coloured text through `#pvcallers a`, beside chips
    // that mean exactly the same thing. Reported as disorder, from a screenshot. Nothing that reads
    // source has an opinion about it: only the page can say what a box looks like.
    //
    // The function is chosen here rather than inherited from whatever the scenario left on screen,
    // so this cannot start measuring a pane with no references in it. Absence is the finding: the
    // sample gives `build_Invoice` a custom button, so an empty pane means the join broke.
    {
      // By `data-path`, not by the row's text: a row shows the *display name* - «Build invoice» -
      // and matching the api name against it found nothing, so this said «the sample no longer
      // carries it» while the function was on screen. The path is the key the row is built from.
      const row = document.querySelector('#tree .f[data-path$="build_Invoice.dg"]');
      if (!row) say('the sample no longer carries build_Invoice, so «Used in» cannot be measured here');
      row.click(); await settle();
      $('pvtab_info').click(); await settle();
      const ap = $('pvcallers').querySelector('.aplink');
      if (!ap) say('the detail pane names no «Used in» reference for a function the sample wires to a button');
      const cs = getComputedStyle(ap);
      if (parseFloat(cs.borderTopWidth) < 1)
        say('a «Used in» reference is drawn as bare text while the references beside it are chips');
      // And it wears the same clothes as the chip vocabulary, not merely some border of its own.
      // Conditional on purpose: a function with no callers has no chip to compare against, and that
      // is a state of the fixture rather than a defect - the assertion above is the unconditional one.
      const chip = $('pvcallers').querySelector('.wf-fn:not(.aplink)');
      if (chip) {
        const cc = getComputedStyle(chip);
        if (cs.borderTopColor !== cc.borderTopColor || cs.backgroundColor !== cc.backgroundColor)
          say(`two kinds of reference in one pane are dressed differently: ${cs.borderTopColor} on `
              + `${cs.backgroundColor} against ${cc.borderTopColor} on ${cc.backgroundColor}`);
      }
    }
    $('pvtab_code').click(); await settle();
    if (getComputedStyle($('codecopy')).display === 'none') say('the copy button did not come back with the code');

    // No fast path may hand back an old photograph. A file rewritten at the same path is what the
    // summary cannot see by walking the folder, and a review asked for the invariant to be proved
    // rather than assumed - it did not hold when it was asked. Both halves are checked: the source
    // behind the diagram, and the meta behind the tree.
    const victim = treeData.find((e) => e.downloaded && e.path.endsWith('.dg'));
    if (victim) {
      graphCache = null; await ensureGraph();
      const idOf = (g) => Object.keys(g.nodes).find((k) => g.nodes[k].file === victim.path);
      const g0 = await ensureGraph(); const before = g0.nodes[idOf(g0)].stats.lines;
      await writeFile(victim.path, 'void v(){ standalone.log(); }\\n// one more line\\n');
      graphCache = null;
      const g1 = await ensureGraph(); const after = g1.nodes[idOf(g1)];
      if (!after || after.stats.lines === before) say('the diagram still shows the source as it was before it was rewritten');
      if (!after.refs.includes('standalone.log')) say('the references were not read again after the file changed');
      const mp = victim.path.replace(/\\.dg$/, '.meta.json');
      const meta = JSON.parse(await readFile(mp));
      meta.updatedTime = '2099-01-01T00:00:00+00:00';
      await writeFile(mp, JSON.stringify(meta, null, 2));
      await rebuildTree(); await settle('the tree never finished drawing');
      const row = treeData.find((e) => e.path === victim.path);
      if (!row || row.updatedTime !== '2099-01-01T00:00:00+00:00') say('the tree still shows the date from the previous meta');
    }

    // And the ordering itself: the tree load starts the graph build without awaiting it, and then
    // writes the summary. A review asked whether the writer of the metadata could declare a function
    // «described» while the build that has to re-read its *source* was still walking - it could,
    // when one set served both. Reproduced here by starting a load and building the diagram into it
    // rather than after it: the diagram must show what the file says now, whoever finished first.
    const race = treeData.find((e) => e.downloaded && e.path.endsWith('.dg') && e.path !== victim.path);
    if (race) {
      graphCache = null; await ensureGraph();                       // summary describes the old source
      await writeFile(race.path, 'void r(){ automation.recalcTotals(); }\\n');
      // The dangerous order is not «during» but «after»: the tree load finishes, its writer declares
      // the metadata described, and the reader opens the diagram a second later. With one set for
      // both readings that clear also wiped the mark that says «this source changed», and the
      // diagram came back with the references from before the file was rewritten.
      await rebuildTree(); await settle('the tree never finished drawing');
      graphCache = null;
      const g = await ensureGraph();
      const node = Object.values(g.nodes).find((n) => n.file === race.path);
      const summaryNow = JSON.parse(await readFile('functions/meta-index.json'));
      const e = summaryNow.files[race.path] || {};
      if (!node || !node.refs.includes('automation.recalcTotals'))
        say(`the diagram used the summary written before the file changed: refs=${JSON.stringify(node && node.refs)}`);
      // and the summary itself must carry the new reading, not just the graph in memory - this is
      // what the two writers used to take from each other, one replacing the file the other had
      // just written.
      if (!Array.isArray(e.refs) || !e.refs.includes('automation.recalcTotals'))
        say(`the summary lost the references the diagram had written: ${JSON.stringify(e.refs)}`);
    }

    // Two producers, one file. Both used to do read-modify-write on the summary, so whoever wrote
    // second restored the fields the other had just changed - the oldest race there is, and it was
    // reachable on any cold open, where the tree load and the diagram build both write. Run together
    // in both orders: each half must survive the other.
    {
      const g2 = await ensureGraph();
      const p2 = treeData.find((e) => e.downloaded && e.path.endsWith('.dg')).path;
      const metaPaths2 = treeData.filter((e) => e.downloaded).map((e) => e.path.replace(/\\.dg$/, '.meta.json'));
      const nodes2 = Object.values(g2.nodes).filter((n) => n.file).map((n) => ({
        namespace: n.namespace, name: n.name, api_name: n.api_name, display_name: n.display_name,
        category: n.category, source: n.source, rest: n.rest, file: n.file, refs: n.refs, stats: n.stats }));
      const row2 = treeData.find((e) => e.path === p2);
      const was = row2.stale;
      row2.stale = true;
      await Promise.all([saveMetaIndex(metaPaths2), saveGraphFacts(nodes2, g2)]);
      let s2 = JSON.parse(await readFile('functions/meta-index.json'));
      let e2 = s2.files[p2] || {};
      if (e2.sv !== 1) say(`the graph writer put back the stale mark the meta writer had just set (sv=${e2.sv})`);
      if (!Array.isArray(e2.refs)) say('the meta writer dropped the references the graph writer had just written');
      row2.stale = false;
      await Promise.all([saveGraphFacts(nodes2, g2), saveMetaIndex(metaPaths2)]);
      s2 = JSON.parse(await readFile('functions/meta-index.json'));
      e2 = s2.files[p2] || {};
      if (e2.sv !== META_SV || !Array.isArray(e2.refs)) say(`the other order loses something too: sv=${e2.sv} refs=${Array.isArray(e2.refs)}`);
      row2.stale = was;
    }

    // The two halves of the mirror, one click apart. A function's detail names the modules its code
    // reads and writes - read out of the source, resolved against the module index, and never shown
    // for a name this org does not have. Held here because the wiring is the half a unit test cannot
    // see: the chips have to be in the pane, and clicking one has to land on the module.
    {
      const fn = treeData.find((e) => e.downloaded && e.path.endsWith('.dg'));
      await writeFile(fn.path, 'void m(){\\n  c = zoho.crm.getRecordById("Contacts", id);\\n'
        + '  u = zoho.crm.updateRecord("Deals", id, mp);\\n  g = zoho.crm.getRecordById("NotAModuleHere", id);\\n'
        + '  v = zoho.crm.getRecordById(computed, id);\\n}\\n');
      graphCache = null; modNamesCache = null;
      const r = rows().find((e) => e.dataset.path === fn.path) || rows()[0];
      r.click(); await settle();
      $('pvtab_info').click(); await settle();
      const chips = [...document.querySelectorAll('#pvcallers .mod')].map((c) => c.dataset.mod);
      if (!chips.includes('Contacts')) say('the module the function reads is not shown: ' + JSON.stringify(chips));
      if (chips.includes('NotAModuleHere')) say('a name that is not a module of this org was drawn as one');
      const w = [...document.querySelectorAll('#pvcallers .mod.w')].map((c) => c.dataset.mod);
      if (w.length && !w.includes('Deals')) say('what is written is not marked as written: ' + JSON.stringify(w));
      if (!/not determinable/.test($('pvcallers').textContent)) say('the call whose module is computed is not reported');
    }

    // The module named inside a call is hypertext, like the call itself. Reported as an expectation
    // rather than a defect - «mi aspetto che Dossier sia cliccabile e porti al modulo Dossier» - and
    // the three cases that must stay apart are held here: the argument that names a module, a string
    // in the same call that does not, and a name that is not a module of this workspace.
    {
      const fn2 = treeData.find((e) => e.downloaded && e.path.endsWith('.dg'));
      await writeFile(fn2.path, 'void h(){\\n  a = zoho.crm.getRecordById("Contacts", id);\\n'
        + '  b = zoho.crm.getRecordById(mod, "Contacts");\\n  c = zoho.crm.getRecordById("NotAModuleHere", id);\\n}\\n');
      graphCache = null; modNamesCache = null;
      const r2 = rows().find((e) => e.dataset.path === fn2.path) || rows()[0];
      r2.click(); await settle();
      $('pvtab_code').click(); await settle();
      const links = [...document.querySelectorAll('#pvcode a.c-link[data-mod]')];
      if (links.length !== 1) say('module links in code: ' + links.length + ', expected exactly one');
      if (links[0].dataset.mod !== 'Contacts') say('the wrong string was linked: ' + links[0].dataset.mod);
      if (getComputedStyle(links[0]).cursor !== 'pointer') say('the module link does not say it is clickable');
      links[0].click(); await settle();
      if (viewMode !== 'modules') say('clicking the module in the code did not open the Modules tab');
      const back2 = [...document.querySelectorAll('.seg')].find((s) => /Functions/.test(s.textContent));
      if (back2) { back2.click(); await settle(); }
    }

    // Two loads of the same list, started together. `rebuildModules()` used to empty `moduleData`
    // and fill it a file at a time, so the second run emptied what the first had put in and both
    // kept pushing - every module twice, and the selection on two rows. Reported from a jump that
    // arrived while the tab was still loading, which is the window a jump lands in.
    {
      await Promise.all([rebuildModules(), rebuildModules()]);
      const paths = (moduleData || []).map((m) => m.path);
      if (paths.length !== new Set(paths).size)
        say(`two module loads produced ${paths.length} rows for ${new Set(paths).size} modules`);
    }

    // and the same fact from the other side: open the module and see what writes it. This is the
    // question the platform cannot answer at all, so it is the one worth holding down.
    {
      const seg = [...document.querySelectorAll('.seg')].find((s) => /Modules/.test(s.textContent));
      if (seg) {
        seg.click(); await settle();
        const row = [...document.querySelectorAll('#tree .f')].find((e) => /Contacts/.test(e.textContent));
        if (row) {
          row.click(); await settle();
          // and it has to be visible even when its group is **closed**, which is the case that was
          // reported next: the row is not drawn at all, so there is nothing to scroll to. Closed
          // here on purpose before jumping, because that is the state a reader leaves behind.
          // **One at a time, re-asked each time.** Collecting them all and clicking the list closed
          // the first group, which redraws the tree - so every other element in that NodeList was
          // detached from the document and its click did nothing at all. The scenario believed it
          // had closed every group and had closed one, and the assertions after it were about a
          // state it never reached. Found the day clicking something not on screen started throwing.
          // Quiet **first**, then look, then click. Collapsing one redraws the tree, and the redraw
          // can land after `settle`'s quiet window - so a node found before it was detached by the
          // time the click reached it, and the click did nothing. Asking after the document has
          // settled, and skipping a node that went away while we held it, is the difference between
          // «the reader closed the groups» and «the reader closed one».
          for (let k = 0; k < 40; k++) {
            await settle('the groups never collapsed');
            const g = $('tree').querySelector('.grp:not(.collapsed)');
            if (!g) break;
            if (!g.isConnected) continue;
            g.click();
          }
          const link3 = document.querySelector('#pvcode a.c-link[data-mod]');
          if (link3) { link3.click(); await settle(); }
          // and it has to be *visible*: a jump that selects a row below the fold is a jump the
          // reader has to go looking for. Reported that way, on a module opened from the code.
          // Absence is the finding, not a reason to skip: with the group left closed the row is not
          // drawn at all, and a check that only looks when it is there passes on the very case it
          // was written for.
          const sel = document.querySelector('#tree .f[aria-selected="true"]');
          if (!sel) say('nothing is selected in the list after the jump - the row was never drawn');
          const b = $('tree').getBoundingClientRect(), r = sel.getBoundingClientRect();
          if (r.bottom < b.top + 1 || r.top > b.bottom - 1)
            say('the selected module is outside the list box - it has to be scrolled to');
          $('pvtab_info').click(); await settle();
          // A «Read by» chip opens a function, which lives on the other tab: the tab has to come
          // with it, or the list shows modules while the detail shows a function. Reported.
          const rb = $('pvcallers').querySelector('a.wf-fn[data-file]');
          if (rb) {
            rb.click(); await settle();
            if (viewMode !== 'functions') say('a function opened from a module left the tab on ' + viewMode);
            const segM = [...document.querySelectorAll('.seg')].find((s) => /Modules/.test(s.textContent));
            if (segM) { segM.click(); await settle(); }
            const row2 = [...document.querySelectorAll('#tree .f')].find((e) => /Contacts/.test(e.textContent));
            if (row2) { row2.click(); await settle(); $('pvtab_info').click(); await settle(); }
          }
          const txt = $('pvcallers').textContent || '';
          if (!/Read by|Written by|No function reads/.test(txt))
            say('the module detail does not say what code does with it: ' + txt.slice(0, 80));
          // The Buttons pane, and the one thing about it nothing that reads source can answer: a row
          // holds a `.wf-fn` chip - inline-block, bordered, padded, with a top margin and no bottom
          // one - beside cells of plain text, and against the shared `vertical-align:top` the two
          // sat at different heights. Reported from a screenshot, which is the only instrument that
          // had seen it. Absence is the finding here too: the sample gives Contacts two buttons, so
          // an empty pane means the tab, the pull or the join broke, not that there is nothing to
          // measure.
          const btab = $('pvtab_btn');
          if (!btab) say('the module has no Buttons tab: the pane is gone or the tab was renamed');
          else {
            btab.click(); await settle();
            const brow = $('pvbtns').querySelector('.ftbl tbody tr');
            if (!brow) say('the Buttons pane is empty for a sample module that carries two buttons');
            else {
              const chip = brow.querySelector('.wf-fn');
              if (!chip) say('the Runs cell holds no function chip, so the way back to the function is gone');
              // **Against the plain text beside it, not against its own cell.** The first version of
              // this compared the chip with the `<td>` holding it and passed in both states: the chip
              // is the tallest thing in the row, so it sets the row height and stays centred in its
              // own cell whatever the alignment. What the screenshot showed is the chip against
              // «view» and «Standard» - and a cell's rect is the whole row, so the text's own box is
              // what has to be measured. A `Range` over the cell contents is the only thing that
              // gives it.
              const where = brow.children[2];
              const rg = document.createRange(); rg.selectNodeContents(where);
              const cb = chip.getBoundingClientRect(), tb = rg.getBoundingClientRect();
              const off = Math.abs((cb.top + cb.height / 2) - (tb.top + tb.height / 2));
              if (off > 1.5)
                say(`the Runs chip sits ${off.toFixed(1)}px off the text beside it in the same row, `
                    + 'so the line reads crooked');
              // **What is deliberately not checked here: that a long chip stays inside its cell.**
              // `#pvbtns .wf-fn` bounds its width because the cell's `text-overflow` cannot elide an
              // inline-block, so on a real org a long function name was cut off mid-box - reported
              // from a screenshot. Two measurements were written for it and both passed with the
              // bound removed: the sample's names are short, and narrowing the panel to 340px does
              // not squeeze the cell past them either. Lengthening one would mean renaming a function
              // woven through the call graph, the connections, a rule and six committed fixture
              // files. So the rule ships without a check rather than with one that cannot go red -
              // a measurement that passes in both states is not evidence, and saying so here is
              // worth more than the line it replaces.
            }
          }
        }
        const back = [...document.querySelectorAll('.seg')].find((s) => /Functions/.test(s.textContent));
        if (back) { back.click(); await settle(); }
      }
    }

    // A compiled function is a project, not the one file chosen as its primary source. The sample
    // carries Java, Python and Node projects so this drives the actual selector: every mirrored
    // source appears, and choosing a companion file opens that exact path without losing the
    // function row that owns it.
    {
      const project = treeData.find((e) => e.downloaded
        && (e.mirrorFiles || []).filter((p) => !p.endsWith('.meta.json')).length > 1);
      if (!project) say('the sample has no multi-file function project to open');
      else {
        await openFile(project.path); await settle();
        const files = project.mirrorFiles.filter((p) => !p.endsWith('.meta.json'));
        // The files are a tab now, not a bar above the code: it has to be *offered* and it has to
        // open. A pane nothing can reach is the dead-control shape this panel has had twice.
        const tab = $('pvtab_files');
        if (!tab || tab.style.display === 'none') say('a project function offers no Files tab');
        tab.click(); await settle();
        const rows = () => [...$('pvfiles').querySelectorAll('.pfrow')];
        const fileRows = () => rows().filter((e) => !e.classList.contains('pfdir'));
        if (!rows().length) say('the Files tab is empty on a function that has a project');
        const other = files.find((p) => p !== project.path);
        if (other) {
          // Every folder open, so the file is reachable: what is asserted is that choosing it opens
          // that exact nested path and keeps the function row that owns it.
          const target = fileRows().find((e) => other.endsWith(e.textContent.trim()));
          if (!target) say('a companion project file has no row in the Files tree');
          else {
            target.click(); await settle();
            if (currentPath !== other) say('choosing a companion project file did not open that file');
            if (!functionRowForPath(currentPath) || functionRowForPath(currentPath).id !== project.id)
              say('a companion project file lost the function row that owns it');
            if ($('pvbody').style.display === 'none') say('choosing a file left the reader on the tree');
          }
        }
        // A folder closes and takes its children with it, and opens again. A tree that only draws is
        // a list with markers on it.
        tab.click(); await settle();
        const dir = rows().find((e) => e.classList.contains('pfdir'));
        if (dir) {
          const before = fileRows().length;
          dir.click(); await settle();
          if (fileRows().length >= before) say('closing a project folder hid none of its files');
          const dir2 = rows().find((e) => e.classList.contains('pfdir'));
          if (dir2) { dir2.click(); await settle(); }
          if (fileRows().length !== before) say('re-opening a project folder did not bring its files back');
        }
      }
    }

    // Refresh says «read every file again». It used to re-read only the rows the panel was holding -
    // the functions tree's - so pressing it from another tab did nothing at all. Driven here from
    // Modules, with a source rewritten behind the panel's back, which is exactly the write Refresh
    // exists to answer.
    {
      const fn3 = treeData.find((e) => e.downloaded && e.path.endsWith('.dg'));
      await ensureGraph();
      await writeFile(fn3.path, 'void r(){ standalone.log(); }  // rewritten behind the panel\\n');
      // Forget that we know a write happened: this is the case where somebody else made it.
      _dirtySource.clear(); _dirtyMeta.clear();
      const segM2 = [...document.querySelectorAll('.seg')].find((s) => /Modules/.test(s.textContent));
      if (segM2) { segM2.click(); await settle(); }
      // The reported state: the panel opened on another tab, so the functions tree was never loaded
      // in this workspace and there are no rows for the old mechanism to mark.
      treeData = [];
      $('refresh').click(); await settle();
      const segF2 = [...document.querySelectorAll('.seg')].find((s) => /Functions/.test(s.textContent));
      if (segF2) { segF2.click(); await settle(); }
      graphCache = null;
      const g3 = await ensureGraph();
      const n3 = Object.values(g3.nodes).find((n) => n.file === fn3.path);
      if (!n3 || !(n3.refs || []).includes('standalone.log'))
        say('Refresh from another tab did not re-read a file changed behind the panel');
    }

    // The whole path, not its parts: a summary written by an older reader on disk, an ordinary open,
    // and the numbers that come back. `modulesUnknown` changed meaning without the version moving,
    // and a workspace indexed before that answered the old number for ever - because nothing re-reads
    // a source the summary already describes. Nothing is marked dirty here on purpose: the only
    // reason the old file must be refused is its version.
    {
      graphCache = null;
      const g0 = await ensureGraph();
      const node0 = Object.values(g0.nodes).find((n) => n.file && n.modules);
      if (!node0) say('no node carries a module reading to write down');
      const truth = node0.modulesUnknown || 0;
      const summary = JSON.parse(await readFile('functions/meta-index.json'));
      const files = {};
      for (const [k, v] of Object.entries(summary.files)) files[k] = { ...v, modulesUnknown: 99 };
      // written as a *previous* version would have written it
      await writeFile('functions/meta-index.json', JSON.stringify({ v: 3, sv: summary.sv, files }, null, 2));
      graphCache = null;
      const g1 = await ensureGraph();
      const node1 = g1.nodes[node0.id];
      if (!node1 || node1.modulesUnknown === 99)
        say('a summary from an older reader was trusted: modulesUnknown came back 99');
      if ((node1.modulesUnknown || 0) !== truth)
        say(`the recomputed count is ${node1.modulesUnknown}, the source says ${truth}`);
      const after = JSON.parse(await readFile('functions/meta-index.json'));
      if (after.v === 3) say('the old summary was read and left on disk at its old version');
    }

    // Clicking a row you can already see must not move the list. Reported: the row jumped to the
    // top under the finger that had just touched it.
    //
    // **With the detail pane already open**, and that is the whole check rather than a detail of it.
    // Run with the pane closed, the click opens it, the list goes from 372px to 68px, and the reveal
    // then brings the selected row into a box that is a fifth of the size - which moved `scrollTop`
    // by 13 and was reported here as the defect. It is not one: it is this panel's oldest recorded
    // sequence, «list drawn -> reveal -> pane opens -> box 401..469», and a check that cannot tell
    // it from a jump is a check that fires on correct behaviour. The pane is opened first so the
    // only thing left that can move the list is the click.
    {
      const anyRow = rows()[0];
      if (anyRow) { anyRow.click(); await settle(); }
      const vis = rows().filter((e) => {
        const r = e.getBoundingClientRect(), b = $('tree').getBoundingClientRect();
        return r.top >= b.top && r.bottom <= b.bottom;
      });
      if (vis.length > 1) {
        const before = $('tree').scrollTop;
        const target = vis[vis.length - 1];
        const grp = [...$('tree').querySelectorAll('.grp')]
          .map((g) => g.getBoundingClientRect()).find((r) => r.height);
        const tr = target.getBoundingClientRect();
        const seq = 'row ' + Math.round(tr.top) + '..' + Math.round(tr.bottom)
          + ', sticky header ' + (grp ? Math.round(grp.top) + '..' + Math.round(grp.bottom) : 'none')
          + ', box ' + Math.round($('tree').getBoundingClientRect().top) + '..'
          + Math.round($('tree').getBoundingClientRect().bottom);
        const hBefore = $('tree').scrollHeight, rhBefore = Math.round(tr.height);
        target.click(); await settle();
        const after2 = target.getBoundingClientRect();
        if ($('tree').scrollTop !== before)
          say(`clicking a visible row moved the list from ${before} to ${$('tree').scrollTop} - ${seq}`
              + `; list height ${hBefore} -> ${$('tree').scrollHeight}`
              + `; row height ${rhBefore} -> ${Math.round(after2.height)}`
              + `; row now ${Math.round(after2.top)}..${Math.round(after2.bottom)}`
              + `; box now ${Math.round($('tree').getBoundingClientRect().top)}..${Math.round($('tree').getBoundingClientRect().bottom)}`);
      }
    }

    // Nothing to clear, nothing to click. Reported, and held here because a rule that hides a
    // control is exactly the kind that renders as nothing the day the markup moves.
    {
      $('find').value = ''; $('find').dispatchEvent(new Event('input')); await settle();
      if (getComputedStyle($('findx')).display !== 'none') say('the clear mark is shown over an empty box');
      $('find').value = 'x'; $('find').dispatchEvent(new Event('input')); await settle();
      if (getComputedStyle($('findx')).display === 'none') say('the clear mark stays hidden with text in the box');
      $('find').value = ''; $('find').dispatchEvent(new Event('input')); await settle();
    }

    // Search text, its interpretation and the .* toggle are one state. Walk the controls rather
    // than assigning the engine: this catches an adapter that changes the button but not the state,
    // or the state but not the input a reader sees. CRM also promises one search per tab.
    {
      $('find').value = 'void'; $('find').dispatchEvent(new Event('input')); await settle();
      $('smode').click(); await settle();
      if (searchState.snapshot().mode !== 'content') say('in: code did not change the search interpretation');
      $('rxmode').click(); await settle();
      if (!searchState.snapshot().regex || $('find').value !== 'void') say('turning .* on did not keep the code-search seed');
      const modules = [...$('modebar').querySelectorAll('[data-tab]')].find((b) => b.dataset.tab === 'modules');
      const functions = [...$('modebar').querySelectorAll('[data-tab]')].find((b) => b.dataset.tab === 'functions');
      if (modules && functions) {
        modules.click(); await settle();
        if ($('find').value || searchState.snapshot().mode !== 'name') say('the Functions search leaked into Modules');
        $('find').value = 'Accounts'; $('find').dispatchEvent(new Event('input')); await settle();
        functions.click(); await settle();
        const restored = searchState.snapshot();
        if ($('find').value !== 'void' || restored.mode !== 'content' || !restored.regex)
          say('the Functions search did not come back with its text, interpretation and .* toggle');
      }
      $('rxmode').click(); await settle();
      if ($('find').value || searchState.snapshot().regex) say('turning .* off left a pattern as a literal search');
      $('smode').click(); await settle();
    }

    // The sources kept in memory for `in: code` are a photograph too, and this one was invalidated
    // by whoever remembered to. `syncOne` - the panel following a save made in Zoho - writes the new
    // source and clears the diagram beside it, so a search after an edit answered with the text from
    // before. The cache is not asked to be clever here: it is asked to know that a write happened.
    const src = treeData.find((e) => e.downloaded && e.path.endsWith('.dg'));
    if (src) {
      const c0 = await getCodeCache();
      if (!c0.get(src.id)) say('the source cache does not hold the function it was asked about');
      await writeFile(src.path, 'void s(){ standalone.log(); }  // rewritten by the probe\\n');
      const c1 = await getCodeCache();
      const reread = c1.get(src.id) || [];
      if (!reread.some((source) => /rewritten by the probe/.test(source.code)))
        say('searching in: code still holds the text from before the file was rewritten');
    }

    // Set the Kind filter in Actions, then make the list reload the way clicking a row's status dot
    // does. The chips are rebuilt from the data - the kinds are derived - and rebuilding them reset
    // the filter, so the answer to «show me the webhooks» was the whole list a moment later.
    {
      const segA = [...document.querySelectorAll('.seg')].find((s) => /Actions/.test(s.textContent));
      if (segA) {
        segA.click(); await settle();
        const sel = document.querySelector('#typechips .filtersel');
        const opt = sel && [...sel.options].map((o) => o.value).find((v) => v !== 'all' && v !== 'unused');
        if (!opt) say('the Actions tab offers no kind to filter by - the case cannot run');
        else {
          sel.value = opt; sel.onchange(); await settle('the layout never finished drawing');
          await rebuildActions(); await settle('the actions list never finished drawing');
          const now = document.querySelector('#typechips .filtersel');
          if (actionFilter !== opt) say(`reloading the actions list reset the kind filter (${opt} -> ${actionFilter})`);
          if (now && now.value !== opt) say('the kind control shows All while the list is filtered');
        }
      }
    }

    // The same question asked of what the assistant is handed. Its catalogues are read off the
    // mirror once and kept: the actions pull rebuilt them, the workflows pull did not, and the
    // modules resync cleared the diagram beside them and not the schema the model is told about. So
    // the assistant answered about a field list, or a set of rules, that the panel had replaced a
    // second earlier - the one place where being confidently out of date is invisible, because
    // there is nothing on screen to compare it against.
    {
      const cat0 = await aiLoadActions();
      await writeFile('actions/index.json', JSON.stringify([...(cat0.list || []),
        { kind: 'webhook', id: '999999', name: 'Probe webhook' }], null, 2));
      const cat1 = await aiLoadActions();
      if (!(cat1.list || []).some((a) => a.name === 'Probe webhook'))
        say('the assistant still holds the actions from before the pull that replaced them');
      const mods0 = await loadModuleFiles();
      const some = Object.keys(mods0)[0];
      if (some) {
        const mf = 'modules/' + some + '.json';
        let raw = null; try { raw = JSON.parse(await readFile(mf)); } catch (_) {}
        if (raw) {
          raw.fields = (raw.fields || []).concat([{ api_name: 'Probe_Field', label: 'Probe field' }]);
          await writeFile(mf, JSON.stringify(raw, null, 2));
          const mods1 = await loadModuleFiles();
          if (!(mods1[some].fields || []).some((f) => f.api_name === 'Probe_Field'))
            say('the assistant still holds the module as it was before the resync');
        }
      }
    }

    // A tab the reader hid in Settings is still somewhere a link can land. The row must show it
    // while we are on it, or the panel reads as having lost its place.
    tabPrefs.hidden = ['workflows'];
    renderTabs(); await settle('the tab row never finished drawing');
    if ([...document.querySelectorAll('.seg')].some((s) => s.dataset.tab === 'workflows'))
      say('a hidden tab still has a segment when we are not on it');
    setMode('workflows'); await settle('the workflows view never finished drawing');
    const seg2 = [...document.querySelectorAll('.seg')].find((s) => s.dataset.tab === 'workflows');
    if (!seg2) say('jumping to a hidden tab left the row without its segment');
    if (!seg2.classList.contains('active')) say('the segment is there but nothing is lit');

    // And an area the Zoho role forbids is refused rather than opened.
    tabPrefs.hidden = [];
    tabAccess.schedules = { state: 'forbidden' };
    const before = viewMode;
    healthOpenSchedule('1', 'x'); await settle('the jump from health never landed');
    if (viewMode !== before) say('it switched into an area the role forbids');

    // A module's detail: three tabs, the names before what uses them, and one scrolling region.
    tabAccess.schedules = {};
    // Through the segment, the way a reader gets there: setMode() alone does not rebuild the list.
    const modSeg = [...document.querySelectorAll('.seg')].find((x) => /Modules/.test(x.textContent));
    if (!modSeg) say('there is no Modules segment to click');
    modSeg.click(); await settle();
    const modRow = [...document.querySelectorAll('#tree .f')].find((e) => /Orders/.test(e.textContent))
      || [...document.querySelectorAll('#tree .f')][0];
    if (!modRow) say('the modules tree is empty in the fixture');
    modRow.click(); await settle();
    if (!$('pvdetails')) say('clicking a module row did not open a module detail');
    for (const id of ['pvtab_code', 'pvtab_rel', 'pvtab_info']) {
      if (getComputedStyle($(id)).display === 'none') say(`a module's detail is missing ${id}`);
    }
    $('pvtab_info').click(); await settle();
    const det = $('pvdetails'), cal = $('pvcallers');
    // What the thing *is* comes before what uses it: the names block was below «read by / written by»,
    // under the fold. Read from the DOM order rather than from the markup, because the element is
    // moved at open time and only the result is the answer.
    if (!det.contains(cal)) say('read by / written by is not inside the Details pane');
    if (det.firstElementChild === cal) say('what uses the module comes before what the module is');
    // One region scrolls. Two stacked boxes with a scrollbar each is what this replaced.
    const scrolls = [...det.querySelectorAll('*'), det].filter((e) => {
      const o = getComputedStyle(e).overflowY; return o === 'auto' || o === 'scroll';
    });
    if (scrolls.length) say(scrolls.length + ' box(es) inside Details scroll on their own: ' + scrolls.map((e) => e.id || e.className).join(', '));
    // A field's rules are counted in a column of their own; that count, like a picklist's, opens a
    // layer with one entry per line; the table sorts by any column; a rule opens on the Workflows tab.
    // Asked for on a real org, then reshaped after the first version: the lists sat side by side
    // under the field and were hard to read.
    {
      const acc = [...document.querySelectorAll('#tree .f')].find((e) => /Accounts/.test(e.textContent));
      if (!acc) say('the fixture has no Accounts module to open');
      acc.click(); await until(() => currentPath === 'modules/Accounts.json', 'Accounts never opened');
      $('pvtab_code').click(); await settle();
      // The layout bar holds still when a table wider than the panel scrolls sideways - reported: it
      // travelled with the columns, taking the picker and View with it.
      {
        const box = $('pvtable'), bar = $('pvfields').querySelector('.laybar');
        if (!bar) say('Accounts has no layout bar to hold still');
        const w = box.style.width; box.style.width = '220px'; await settle();
        if (box.scrollWidth <= box.clientWidth) say('the fields table does not overflow even at 220px - this case measures nothing');
        const x0 = bar.getBoundingClientRect().left, v0 = $('laymod').getBoundingClientRect().right;
        box.scrollLeft = 120;   // read back at once: a rect forces layout, sticky offsets included
        const moved = bar.getBoundingClientRect().left - x0, viewMoved = $('laymod').getBoundingClientRect().right - v0;
        box.scrollLeft = 0; box.style.width = w; await settle();
        if (Math.abs(moved) > 1 || Math.abs(viewMoved) > 1) say(`the layout bar scrolled sideways with the table (bar ${moved}px, View ${viewMoved}px)`);
        // Growing the box to its table must not grow it to a sentence: a note laid on one line would
        // make the panel scroll sideways by itself. And the box keeps the width of the pane.
        const probeNote = document.createElement('div'); probeNote.className = 'ftnote';
        probeNote.textContent = 'a note long enough to be wider than any panel this runs in '.repeat(6);
        $('pvfields').appendChild(probeNote); await settle();
        const noteW = probeNote.getBoundingClientRect().width; probeNote.remove(); await settle();
        if (noteW > box.clientWidth + 1) say(`a note under the fields table is laid on one line, ${Math.round(noteW)}px wide in a ${box.clientWidth}px pane`);
        if (box.clientWidth < $('preview').clientWidth - 20) say(`the fields pane is narrower than the preview (${box.clientWidth} of ${$('preview').clientWidth})`);
      }
      const heads = [...$('pvfields').querySelectorAll('thead th')].map((t) => t.textContent.trim());
      // Two count columns now, in this order: the rules that touch a field, then the blueprints that
      // do. Both are checked, because a column silently lost is exactly what this assertion is for.
      if (!/^WF/.test(heads[heads.length - 2] || '')) say('the rules count has no column of its own: ' + heads.join(' | '));
      if (!/^BP/.test(heads[heads.length - 1] || '')) say('the blueprints count has no column of its own: ' + heads.join(' | '));
      const items = () => [...$('fieldlistbody').querySelectorAll('li')];
      const oneEach = (li) => li.every((x, i) => i === 0 || x.getBoundingClientRect().top >= li[i - 1].getBoundingClientRect().bottom - 1);

      const vb = $('pvfields').querySelector('.plbtn[data-list="values"]');
      if (!vb) say('no picklist in Accounts offers its values');
      const want = Number((vb.textContent.match(/[0-9]+/) || [0])[0]);
      vb.focus(); vb.click(); await until(() => $('fieldlist').classList.contains('on'), 'the values layer never opened');
      if (items().length !== want) say(`the layer lists ${items().length} of ${want} values`);
      if (!oneEach(items())) say('the values in the layer are not one per line');
      if (document.activeElement !== $('fieldlistx')) say('the layer opened and the keyboard stayed behind it');
      // Alt+Left walks the history - and walked it behind the layer, which stayed open over another
      // module. Found by review; the same hole was open behind About and the export dialog.
      if (navHistory.snapshot().position < 1) say('no step to go back to - this case would pass on nothing');
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
      await settle();
      if (currentPath !== 'modules/Accounts.json') say('Alt+Left changed the panel behind the open layer');
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await until(() => !$('fieldlist').classList.contains('on'), 'Escape never closed the layer');
      if (document.activeElement !== vb) say('closing the layer did not give the keyboard back to the count that opened it');
      if (currentPath !== 'modules/Accounts.json') say('Escape on the layer closed something underneath it');
      // The table drawn again while the layer is open - a pull ending underneath it - takes away the button
      // that opened it; closing gives the keyboard to its successor, not to the page. Seen by review.
      {
        const opener = $('pvfields').querySelector('.plbtn[data-list="values"]');
        opener.focus(); opener.click(); await until(() => $('fieldlist').classList.contains('on'), 'the values layer never reopened');
        $('laybody').innerHTML = renderFieldsTable(fieldListShown.m, fieldListShown.found);
        $('fieldlistx').click(); await until(() => !$('fieldlist').classList.contains('on'), 'Close never closed the layer');
        const f = document.activeElement;
        if (!(f && f.matches && f.matches('.plbtn[data-list="values"]') && f.dataset.f === opener.dataset.f))
          say('closing the layer over a redrawn table left the keyboard on ' + (f ? f.tagName : 'nothing'));
      }

      const rb = $('pvfields').querySelector('.plbtn[data-list="rules"]');
      if (!rb) say('no field in Accounts counts the workflow rules it fires');
      const nRules = Number(rb.textContent);
      rb.click(); await until(() => $('fieldlist').classList.contains('on'), 'the workflows layer never opened');
      const listed = new Set(items().map((x) => (x.querySelector('.wflink') || { dataset: {} }).dataset.wfid));
      if (listed.size !== nRules) say(`the layer names ${listed.size} rule(s) and the count says ${nRules}`);
      if (!oneEach(items())) say('the rules in the layer are not one per line');
      $('fieldlistx').click(); await until(() => !$('fieldlist').classList.contains('on'), 'Close never closed the layer');

      // The ladders: offered on the module that has them, absent on the one that does not, with the
      // stages in order and the module's leftovers named. Measured shapes; see renderPipelines.
      {
        if ($('pvtab_pipe').style.display !== 'none') say('Accounts has no pipelines and offers the tab anyway');
        await openModule('modules/Deals.json'); await until(() => currentPath === 'modules/Deals.json', 'Deals never opened');
        if ($('pvtab_pipe').style.display === 'none') say('the module with pipelines does not offer the tab');
        $('pvtab_pipe').click(); await settle();
        const pipe = $('pvpipes');
        if (getComputedStyle(pipe).display === 'none') say('the Pipelines tab opened nothing');
        const heads = [...pipe.querySelectorAll('.secttl')].map((h) => h.textContent);
        if (heads.length < 3) say('the pipelines pane draws ' + heads.length + ' section(s): ' + heads.join(' | '));
        if (!heads.some((h) => /on no pipeline/.test(h))) say('the stages on no pipeline are not shown: ' + heads.join(' | '));
        if (!pipe.querySelector('.pipedef')) say('no pipeline is marked as the default one');
        const first = [...pipe.querySelectorAll('table tbody tr')].slice(0, 5).map((tr) => tr.children[0].textContent);
        if (first.join(',') !== '1,2,3,4,5') say('the stages are not numbered in order: ' + first.join(','));
        await openModule('modules/Accounts.json'); await until(() => currentPath === 'modules/Accounts.json', 'Accounts never reopened');
        $('pvtab_code').click(); await settle();
      }

      // A rule's field update is a second way to touch a field: the sample's merge rule writes
      // Contacts.Status, so that layer has a «Writes it» group naming what it writes.
      {
        modSeg.click(); await settle();
        // Opened directly: the tree is narrowed by whatever an earlier case typed into the search box,
        // and this case is about the layer, not about finding a row. A narrowed tree with an empty box
        // would be a defect of its own, so that much is asked.
        if (![...document.querySelectorAll('#tree .f')].some((e) => /Contacts/.test(e.textContent)) && !$('find').value.trim())
          say('the modules tree is narrowed with nothing in the search box: ' + [...document.querySelectorAll('#tree .f')].map((e) => e.textContent.trim().slice(0, 24)).join(' | '));
        await openModule('modules/Contacts.json'); await until(() => currentPath === 'modules/Contacts.json', 'Contacts never opened');
        $('pvtab_code').click(); await settle();
        const row = [...$('pvfields').querySelectorAll('tbody tr')].find((tr) => tr.querySelector('.plbtn[data-list="values"][data-f="Status"]'));
        const wb = row && row.querySelector('.plbtn[data-list="rules"]');
        if (!wb) say('Contacts.Status, which a rule writes, has no workflow count');
        wb.click(); await until(() => $('fieldlist').classList.contains('on'), 'the Contacts.Status layer never opened');
        const heads2 = [...$('fieldlistbody').querySelectorAll('.flrole')].map((h) => h.textContent);
        if (!heads2.some((h) => /^Writes it/.test(h))) say('the layer has no Writes it group: ' + heads2.join(' | '));
        if (!/writes Negotiation/.test($('fieldlistbody').textContent)) say('the layer does not say what the rule writes');
        // And the rule's condition on the same field, in words: the sample checks «Status is not empty».
        if (!heads2.some((h) => /^Checks it/.test(h))) say('the layer has no Checks it group: ' + heads2.join(' | '));
        if (!/checks is not empty/.test($('fieldlistbody').textContent)) say('the layer does not say what the rule checks');
        $('fieldlistx').click(); await until(() => !$('fieldlist').classList.contains('on'), 'Close never closed the layer');
        await openModule('modules/Accounts.json'); await until(() => currentPath === 'modules/Accounts.json', 'Accounts never reopened');
        $('pvtab_code').click(); await settle();
      }

      const sortBtn = () => $('pvfields').querySelector('.thsort[data-sort="wf"]');
      const counts = () => [...$('pvfields').querySelectorAll('tbody tr')]
        .map((tr) => Number((tr.querySelector('.plbtn[data-list="rules"]') || { textContent: '0' }).textContent));
      sortBtn().click(); await settle();
      const c1 = counts();
      if (!c1[0] || c1.some((x, i) => i && x > c1[i - 1])) say('sorting by Workflows did not put the largest first: ' + c1.join(','));
      if (document.activeElement !== sortBtn()) say('sorting took the keyboard off the header that was pressed');
      sortBtn().click(); await settle(); sortBtn().click(); await settle();
      if (sortBtn().closest('th').hasAttribute('aria-sort')) say('a third press did not give Zoho its order back');

      $('pvfields').querySelector('.plbtn[data-list="rules"]').click();
      await until(() => $('fieldlist').classList.contains('on'), 'the workflows layer never reopened');
      const link = $('fieldlistbody').querySelector('.wflink');
      const wid = link && link.dataset.wfid;
      if (!wid) say('a rule in the layer is not a link');
      link.click();
      await until(() => viewMode === 'workflows' && currentPath === 'workflows/' + wid + '.json', 'the rule in the layer never opened on the Workflows tab', 4000);
      if ($('fieldlist').classList.contains('on')) say('the layer stayed open over the rule it opened');
      await settle();
      // What the pane *says*: the collapsed Raw JSON beside it is the file verbatim and rightly holds
      // the placeholder, and textContent reads a closed <details> as readily as an open one.
      const shown = $('pvtable').cloneNode(true); shown.querySelectorAll('.wfraw').forEach((x) => x.remove());
      const said = shown.textContent;
      if (said.includes('ANYVALUE')) say('the opened rule prints its watched field as a condition');
      if (!/fields: /.test(said)) say('the opened rule does not say which field starts it');

      // A write under workflows/ drops the map, and «All fields» from the layout picker drew the table
      // without it: every count gone, and the note that explains an absence gone too. Found by review.
      modSeg.click(); await settle();
      const acc2 = [...document.querySelectorAll('#tree .f')].find((e) => /Accounts/.test(e.textContent));
      acc2.click(); await until(() => currentPath === 'modules/Accounts.json', 'Accounts never reopened');
      $('pvtab_code').click(); await settle();
      await writeFile('workflows/index.json', await readFile('workflows/index.json'));
      if (fieldTriggers !== null) say('a write under workflows/ left the field map cached');
      const sel = $('laysel');
      if (!sel || sel.options.length < 2) say('Accounts has no layout to pick');
      sel.value = sel.options[1].value; await sel.onchange();
      sel.value = '__all__'; await sel.onchange(); await settle();
      if (!$('pvfields').querySelector('.plbtn[data-list="rules"]'))
        say('after a workflows write, All fields from the layout picker lost the rules its fields fire');
    }

    // «Pull list» is offered where a list and its items are read apart, and nowhere else.
    for (const [tab, shown] of [['functions', true], ['modules', true], ['workflows', true], ['actions', true], ['schedules', false], ['connections', false]]) {
      setMode(tab); await settle('the ' + tab + ' view never finished drawing');
      if (($('pulllist').style.display !== 'none') !== shown) say('Pull list is ' + (shown ? 'missing from ' : 'offered on ') + tab);
      // And the full pull says it reads every item where the quick one sits beside it.
      const named = $('pullone').getAttribute('aria-label');
      if (named !== (shown ? 'Pull list + details' : 'Pull')) say('the full pull on ' + tab + ' is named «' + named + '»');
      if (!$('pullone').title) say('the full pull on ' + tab + ' lost its title');
    }

    // And a function has no Related lists tab at all - absent, not disabled.
    setMode('functions'); await settle('the functions view never finished drawing');
    const fn = [...document.querySelectorAll('#tree .f')][0];
    if (fn) {
      fn.click(); await settle();
      if (getComputedStyle($('pvtab_rel')).display !== 'none') say('a function offers Related lists');
    }


    // ---- the export dialog: what it remembers, and what it writes ----
    //
    // Ten of the panel's eighty-nine controls were driven and these were not, on a path that has now
    // produced four defects in two days - a builder that could not run, a report full of links to
    // nothing, a filter nobody could predict. The dialog is where a reader decides what the report
    // contains, and what it *remembers* is the part nothing had ever exercised: a tick that does not
    // survive being reopened is a choice silently discarded.
    const fsx = window.__fsshim;
    $('export').click(); await settle('the export dialog never opened');
    if (!$('expscope').classList.contains('on')) say('the export dialog did not open');
    const wasHealth = $('sc_health').checked;
    $('sc_health').checked = !wasHealth;
    $('sc_health').dispatchEvent(new Event('change')); await settle();
    $('expgo').click();
    // The write goes through the file system shim, so «it finished» is the file appearing.
    await until(() => fsx.dump().some((x) => /export.*[.]html$/.test(x)), 'no report was written', 8000);
    await settle('the dialog never closed after exporting');
    if ($('expscope').classList.contains('on')) say('the dialog stayed open after Export');
    $('export').click(); await settle('the export dialog never reopened');
    if ($('sc_health').checked === wasHealth)
      say('the export dialog opened back on the old ticks - the choice was discarded');
    $('sc_health').checked = wasHealth; $('sc_health').dispatchEvent(new Event('change'));
    $('expcancel').click(); await settle('Cancel never closed the dialog');
    if ($('expscope').classList.contains('on')) say('Cancel left the dialog open');

    // ---- landing on a row brings its column names with it ----
    //
    // **382 of the links in a Zoho CRM report point at a row, and a row carries no title of its own.**
    // A card names itself in its own head; a row is seven cells. Measured on a real org's report:
    // the row landed with its column headers 19,563px above it, so the reader arrived on cells with
    // nothing naming them.
    //
    // The band is a row of the page now and `main` is the scrollport, so every offset is a plain
    // number in the stylesheet and nothing measures anything at run time. That shape came from a
    // reader whose window forbids inline script - the panel opens a report as a `blob:` in the
    // extension's own origin, where `script-src 'self'` applies - and there every measured offset
    // was simply absent. So what has to hold is arithmetic: the constant a row carries must cover
    // the head it has to clear, and both numbers are read from the *rendered* report, because a
    // head's height is a fact about fonts and padding rather than about the CSS text.
    {
      const written = fsx.dump().filter((x) => /export.*[.]html$/.test(x)).pop();
      if (!written) say('no HTML report was written, so the row landings cannot be judged');
      const fr = document.createElement('iframe');
      fr.style.cssText = 'width:1240px;height:900px;border:0';
      document.body.appendChild(fr);
      const d = fr.contentDocument;
      d.open(); d.write(fsx.read(written)); d.close();
      await settle();
      const scrollport = d.querySelector('main');
      if (!scrollport || getComputedStyle(scrollport).overflowY !== 'auto')
        say('main is not the scrollport of this report, so a jump lands against the window and every '
            + 'target goes behind the band');
      if (getComputedStyle(d.querySelector('header')).position === 'sticky')
        say('the band is sticky over the content again, which is what put every target behind it');
      const rowAnchors = d.querySelectorAll('tr[id]').length;
      let rowLinks = 0;
      const deepest = new Map();
      for (const ra of [...d.querySelectorAll('a[href^="#"]')]) {
        const rt = d.getElementById(ra.getAttribute('href').slice(1));
        if (!rt || rt.tagName !== 'TR') continue;
        rowLinks += 1;
        const tbl = rt.closest('table');
        if (!tbl) continue;
        const depth = [...tbl.querySelectorAll('tbody tr')].indexOf(rt);
        const held = deepest.get(tbl);
        if (!held || depth > held.depth) deepest.set(tbl, { ra, rt, depth });
      }
      // The deepest anchored row of each table, because a table's first rows sit under their own
      // head whatever the rules say - judging those is how an earlier version of this check passed
      // with the head rule deleted.
      const judged = [...deepest.values()].sort((a, b) => b.depth - a.depth).slice(0, 3);
      let rowJumps = 0;
      for (const { ra, rt } of judged) {
        const tbl = rt.closest('table'), thd = tbl && tbl.querySelector('thead');
        if (!thd) { say(`${ra.getAttribute('href')} lands on a row in a table with no head`); continue; }
        const margin = parseFloat(getComputedStyle(rt).scrollMarginTop) || 0;
        const headH = thd.getBoundingClientRect().height;
        if (margin < headH + 13)
          say(`a row carries ${Math.round(margin)}px of scroll-margin against a ${Math.round(headH)}px `
              + 'head: it lands behind its own column names, and no script is coming to fix it');
        ra.click(); await settle();
        rowJumps += 1;
        const head = thd.getBoundingClientRect(), top = scrollport.getBoundingClientRect().top;
        if (head.bottom <= top + 1)
          say(`landing on ${ra.getAttribute('href')} left the table's column names off screen `
              + `(head bottom ${Math.round(head.bottom)} against a scrollport starting at ${Math.round(top)})`);
        const clear = Math.round(rt.getBoundingClientRect().top - Math.max(head.bottom, top));
        if (clear < -1) say(`landing on ${ra.getAttribute('href')} left the row ${-clear}px under what covers it`);
      }
      if (!rowAnchors || !rowJumps)
        say(`no row landing was judged - ${rowAnchors} anchored row(s), ${rowLinks} link(s) at one, `
            + `${rowJumps} judged: this measured nothing and cannot be read as a pass`);
      fr.remove();
    }

    // ---- About ----
    $('about').click(); await settle('About never opened');
    if (!/licen[cs]e|Zoho/i.test($('aboutbody').textContent)) say('About says nothing about what it is');
    $('aboutok').click(); await settle('About never closed');

    // ---- Escape closes what is on top ----
    // Written because the code for it can be read and still be wrong: `escapeCloses()` asks the page
    // what is open, and nothing that reads source can tell whether the listener is reached, whether
    // a class name matches the one the product actually sets, or whether the overlay is still there
    // afterwards. Before this, Escape closed the history view alone - every dialog had to be
    // dismissed with a mouse, because its ✕ was a span no keyboard could focus.
    $('about').click(); await settle('About never reopened for the Escape case');
    if (!$('aboutdlg').classList.contains('on')) say('About did not open, so Escape has nothing to close');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle('Escape never reached the dialog');
    if ($('aboutdlg').classList.contains('on')) say('Escape left About open');
    if ($('scrim').classList.contains('on')) say('Escape closed About and left its backdrop behind');

    // ---- The keyboard focus ring is legible ----
    // **The first version of this case could not fail, and was planted against to find out.** It
    // asserted «the outline is not `none` and is at least 1px»; with the panel's rule removed it
    // stayed green, because Chrome draws a ring of its own - measured in this panel as `auto 1px
    // rgb(16,16,16)`, against the rule's `solid 2px rgb(59,130,246)`. Both satisfied the condition,
    // so the gate had no ability to say no. What made it one was asserting the *spelling*: `solid`
    // versus `auto` is how a rule is written, not what a reader receives.
    //
    // What a reader receives is contrast, so that is what is asked. The backdrop is derived rather
    // than named - the first painted ancestor - because the ring is offset and therefore lands
    // behind the control instead of on it, and a hardcoded colour here would be a second copy of the
    // palette waiting to disagree with it. Measured: the browser default reads 1.02:1 on this
    // background, the CRM accent 5.10:1 and the Analytics accent 4.19:1. The bar is the 3:1 asked of
    // a non-text indicator, which refuses the default and passes both products.
    {
      const el = document.querySelector('button:not(:disabled)');
      if (!el) say('no enabled control to focus - the panel is not in the state this case assumes');
      el.focus({ focusVisible: true });
      if (!el.matches(':focus-visible')) say('a focused control does not match :focus-visible, so no ring can be measured');
      const rgb = (s) => (String(s).match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
      const lum = (c) => {
        const f = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
        return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
      };
      const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
      let node = el.parentElement, back = null, backEl = null;
      while (node && !back) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) { back = rgb(bg); backEl = node; }
        node = node.parentElement;
      }
      if (!back) say('nothing is painted behind the focused control, so the ring has no measurable backdrop');
      const cs = getComputedStyle(el);
      const ring = contrast(rgb(cs.outlineColor), back);
      if (!(ring >= 3))
        say('the focus ring is not legible: ' + ring.toFixed(2) + ':1 against '
            + (backEl.id || backEl.className || backEl.tagName) + ' (outline ' + cs.outlineStyle
            + ' ' + cs.outlineWidth + ' ' + cs.outlineColor + ')');
      el.blur();
    }
    document.title = 'HISTORY OK';
  })().catch((e) => { document.title = 'SHOT ERROR: ' + e.message + ' @@ ' + (e.stack || '').split('\\n').slice(0, 3).join(' / '); });
"""

AN = """
  const say = (m) => { throw new Error(m); };
  // **A click on a control that is not on screen neither throws nor works**, which is the worst
  // shape a step in a driver can have: the ER scenario opened by clicking the diagram tab, which
  // carries `display:none` until the graph lands, and a run that lost that race failed three lines
  // later saying «the fixture draws 0 boxes» - a sentence about the fixture, describing a race.
  //
  // This was a static sweep first, and the static sweep could not see it: the click goes through a
  // helper, so of the 75 in these scenarios it read 40 and could judge 2. Deleting the guard it was
  // written for changed its answer not at all. Text cannot answer «is this element on screen»; the
  // page can, so the question is asked here, where a wrong answer is a thrown error naming the
  // control instead of a failure three lines later about something else.
  (() => {
    const real = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function clickOnScreen() {
      const cs = getComputedStyle(this);
      const why = !this.isConnected ? 'not in the document'
        : cs.display === 'none' ? 'display:none'
        : cs.visibility === 'hidden' ? 'visibility:hidden'
        : '';
      // `offsetParent === null` was tried as a fourth condition and taken out again: it is also null
      // for a `position:fixed` element, for one inside a `display:contents` box, and before the first
      // layout - so it reported controls that are on screen. The three above are unambiguous and are
      // exactly «the product is hiding this», which is the thing that made a click a silent no-op.
      if (why) say(`clicked a control that is not on screen (${why}): ${this.id || this.className || this.tagName}`);
      return real.apply(this, arguments);
    };
  })();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wait for the thing, with the same ceiling as the sleep it replaces.
  //
  // A click, a fixed sleep, then a read is a bet that the panel finished inside that sleep. (Written
  // without the code, because the counter below reads this text and a quoted example counted as a
  // fifth bet in every scenario - a check reading its own prose, which this repository has met
  // three times.)
  // It is the shape this repository has already written down and condemned - «read scrollTop after a
  // second is the 1990s junior's sleep, and it produces a fix of the same shape: one that waits
  // instead of knowing» - living in the tool built to catch exactly that class. A bet costs the full
  // number every run when it wins, and reads unsettled state when it loses; a condition costs a few
  // milliseconds and, when it does time out, says which condition never came true instead of failing
  // three lines later about something else.
  const until = async (cond, what, ms = 2500) => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = cond(); } catch (_) { ok = false; }
      if (ok) return;
      if (Date.now() - t0 > ms) say('waited ' + ms + 'ms and ' + what);
      await wait(25);
    }
  };
  // **«The panel has stopped changing» is a condition; «300ms» is a bet.** Most waits in these
  // scenarios are a click followed by a sleep followed by a read, which is the shape this repository
  // has already condemned in the product and kept in the tool built to catch it. This watches the
  // document and returns as soon as it has been quiet for a moment - so a fast machine costs
  // milliseconds, a slow one is still correct, and a panel that never redraws says so by name
  // instead of failing three lines later on whatever the click was supposed to have produced.
  //
  // What it does not cover, stated: work that finishes without touching the DOM. Those stay sleeps,
  // and the counter at the end of the run prints how many are left.
  let _lastMut = 0;
  new MutationObserver(() => { _lastMut = Date.now(); })
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  const settle = async (what, quiet = 150, ms = 4000) => {
    _lastMut = Date.now();
    await until(() => Date.now() - _lastMut > quiet, what || 'the panel never stopped redrawing', ms);
  };
  let copied = null;
  const navState = () => navHistory.snapshot();
  (async () => {
    const openChain = async () => {
      if ($('navview').classList.contains('show')) return;
      $('navtab').click();
      await until(() => $('navview').classList.contains('show'), 'the history view never opened');
    };
    await wait(1600);
    await until(() => !$('overview').disabled, 'the workspace overview never became available');
    $('overview').click();
    await until(() => $('overviewview').classList.contains('show') && document.querySelectorAll('.ovcard').length === 4,
      'the Analytics overview never drew its four areas');
    if (!document.body.classList.contains('overview-open')) say('the Analytics overview did not own the panel');
    for (const card of document.querySelectorAll('.ovcard')) {
      if (!/^[0-9]+$/.test(card.querySelector('.ovcount').textContent.trim()))
        say('the Analytics sample overview presented an area count as unknown: ' + card.textContent);
    }
    if (document.querySelectorAll('.ovstep').length !== 3) say('the Analytics sample did not draw the three-step onboarding path');
    if (!document.querySelector('.ovstep[data-step="mirror"].done')) say('the Analytics sample did not say its invented mirror is ready');
    if (!$('ovbrowse').classList.contains('next')) say('the Analytics sample did not identify Browse as the next action');
    if (getComputedStyle($('ovpull')).display !== 'none') say('the Analytics sample overview offered a pull from Zoho');
    $('ovbrowse').click();
    await until(() => !$('overviewview').classList.contains('show'), 'Browse did not close the Analytics overview');
    const rows = () => [...document.querySelectorAll('#list tbody tr')];
    // The filter and both directions of a sort cross the new model/UI boundary here. Compare ids,
    // not labels: two equal names are legal and would make the weaker assertion pass by accident.
    {
      const choice = [...$('typesel').options].map((option) => option.value).find((value) => {
        if (!value || value === ORPHANS) return false;
        const picked = selectAnalyticsViews(views, { typeFilter: value, orphanToken: ORPHANS,
          search: searchState.snapshot(), schema, sqlCache, dependencies: deps,
          isOrphan: isOrphanCandidate, sortKey, sortDir, compileRegex: rxCompile, sqlMatches: sqlHit });
        return picked.length > 0 && picked.length < views.length;
      });
      if (!choice) say('the sample has no view type that narrows the list - the case cannot run');
      $('typesel').value = choice; $('typesel').onchange(); await settle('the view filter never finished drawing');
      const expectedFiltered = selectAnalyticsViews(views, { typeFilter, orphanToken: ORPHANS,
        search: searchState.snapshot(), schema, sqlCache, dependencies: deps,
        isOrphan: isOrphanCandidate, sortKey, sortDir, compileRegex: rxCompile, sqlMatches: sqlHit });
      if (rows().map((row) => row.dataset.id).join('|') !== expectedFiltered.map((view) => String(view.id)).join('|'))
        say('the view filter on screen is not the selection its model returned');
      $('typesel').value = ''; $('typesel').onchange(); await settle('clearing the view filter never finished drawing');

      $('sort').value = 'dataModifiedAt'; $('sort').onchange(); await settle('the view sort never finished drawing');
      const expectedOrder = () => selectAnalyticsViews(views, { typeFilter, orphanToken: ORPHANS,
        search: searchState.snapshot(), schema, sqlCache, dependencies: deps,
        isOrphan: isOrphanCandidate, sortKey, sortDir, compileRegex: rxCompile, sqlMatches: sqlHit })
        .map((view) => String(view.id)).join('|');
      if (rows().map((row) => row.dataset.id).join('|') !== expectedOrder())
        say('the ascending view order on screen is not the order its model returned');
      $('sortdir').click(); await settle('reversing the view sort never finished drawing');
      if (rows().map((row) => row.dataset.id).join('|') !== expectedOrder())
        say('the descending view order on screen is not the order its model returned');
      $('sort').value = 'name'; $('sort').onchange(); await settle('restoring the view sort never finished drawing');
      if (sortDir !== 1) { $('sortdir').click(); await settle('restoring the view direction never finished drawing'); }
    }
    if (rows().length < 2) say('the fixture list has fewer than two views');
    rows()[0].click(); await settle();
    const a = selectedId;
    rows()[1].click(); await settle();
    const b = selectedId;
    if (a === b) say('two different rows selected the same view');
    if (navState().entries.length !== 2) say('two steps should be two entries, got ' + navState().entries.length);
    const shown = (id) => getComputedStyle($(id)).display !== 'none';
    if (!shown('dback')) say('back is not offered after two steps');
    if (shown('dfwd')) say('forward is painted with nothing ahead');
    // It stands with AI and Health, not near them: same row, same height. It was in the tab strip,
    // where `fitTabs()` shrinks the segments by measuring and left it the odd one out - and the first
    // move out of there dragged the whole tab row into the toolbar with it, which this would have
    // caught on the spot.
    const bx = (id) => $(id).getBoundingClientRect();
    for (const id of ['askai', 'health']) {
      if (Math.abs(bx('navtab').top - bx(id).top) > 1) say(`the history control is ${Math.round(bx('navtab').top - bx(id).top)}px off ${id}`);
      if (Math.abs(bx('navtab').height - bx(id).height) > 1) say(`the history control is ${bx('navtab').height}px against ${id}'s ${bx(id).height}px`);
    }
    // At the panel's minimum width every icon in the toolbar has to be reachable without scrolling
    // the row sideways - a control that is one drag off-screen is a control most people never find.
    // Measured: 335px of content in a 322px row before the separators and the export group were
    // trimmed, 305 after. Held here because nothing else would notice one more button arriving.
    //
    // **The one number this harness cannot read off the page: the gap.** Written up in full beside
    // the CRM's copy of this check - the body is narrowed inside a window that stays 1280px wide, so
    // `clamp(3px, 1.4vw, 8px)` measures 8px here and is about 4.8px in a real 340px panel, and the
    // difference across the row was ~26px of overstatement. Computed for the width being tested now;
    // `tests/panel.test.mjs` holds the copy of the clamp to the stylesheet.
    const wide = document.body.style.width;
    document.body.style.width = '340px'; await settle('the panel never finished reflowing');
    const grp = document.querySelector('.wsgroup');
    const items = [...grp.children].filter((c) => getComputedStyle(c).display !== 'none');
    const gap = Math.min(8, Math.max(3, 0.014 * 340));      // clamp(3px, 1.4vw, 8px) at 340px
    const needs = Math.round(items.reduce((w, c) => w + c.getBoundingClientRect().width, 0)
                             + Math.max(0, items.length - 1) * gap);
    if (needs > grp.clientWidth + 1) {
      // What it is made of, because «10px too wide» is a number nobody can act on.
      const parts = items.map((c) => (c.id || c.className) + '=' + Math.round(c.getBoundingClientRect().width)).join(' ');
      say(`the toolbar needs ${needs}px in ${grp.clientWidth}px - an icon is off-screen at the `
          + `minimum width. It holds: ${parts}`);
    }
    document.body.style.width = wide; await settle('the panel never finished reflowing');
    const mk = $('dback').querySelector('svg.nvmk');
    if (!mk) say('the arrows are font glyphs again');
    const mw = mk.getBoundingClientRect();
    if (mw.width < 15) {
      const d = $('detail').getBoundingClientRect(), sb = $('dback').getBoundingClientRect();
      say(`mark ${mw.width}x${mw.height} | span ${sb.width}x${sb.height} | detail ${d.width}x${d.height} show=${$('detail').className} | svgw=${getComputedStyle(mk).width}`);
    }

    $('dback').click(); await settle();
    if (String(selectedId) !== String(a)) say('back did not return to the first view: ' + selectedId);
    $('dfwd').click(); await settle();
    if (String(selectedId) !== String(b)) say('forward did not return to the second view: ' + selectedId);

    await openChain();
    const menu = [...document.querySelectorAll('#navbody .nvrow')];
    if (menu.length !== 2) say('the chain shows ' + menu.length + ' steps, expected 2');
    menu[1].click(); await settle();
    if (String(selectedId) !== String(a)) say('clicking a step in the chain did not go there');

    // The SQL is shown the way the CRM shows Deluge: lines as the author wrote them, and the box
    // scrolls. It wrapped here and not there - reported as an inconsistency between the two products,
    // and a wrapped query is one whose indentation has stopped meaning anything.
    const sqlTab = [...document.querySelectorAll('.dtab')].find((x) => /SQL/.test(x.textContent));
    if (sqlTab) {
      sqlTab.click(); await settle();
      const pre = document.querySelector('pre.sql');
      if (pre) {
        const s = getComputedStyle(pre);
        if (s.whiteSpace !== 'pre') say(`the SQL still wraps: white-space is ${s.whiteSpace}`);
        if (s.overflowX !== 'auto' && s.overflowX !== 'scroll') say(`the SQL cannot scroll sideways: overflow-x is ${s.overflowX}`);
        // The copy control belongs to code, so it is only asked for where there is code - the view
        // this probe happens to have open may be a table, which has none.
        if (getComputedStyle($('codecopy')).display === 'none') say('no copy button over the SQL');
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (x) => { copied = x; } }, configurable: true });
        $('codecopy').click(); await settle();
        if (copied !== pre.textContent) say('what was copied is not the SQL on screen');
        const cb = $('codecopy').getBoundingClientRect(), nb = $('tab_sql').getBoundingClientRect();
        if (Math.abs(cb.height - nb.height) > 1) say(`the copy button is ${cb.height}px against the row's ${nb.height}px`);
        if (Math.abs(cb.top - nb.top) > 1) say('the copy button is not on the same line as the tabs beside it');
      }
      const cols = [...document.querySelectorAll('.dtab')].find((x) => /Columns/.test(x.textContent));
      if (cols) { cols.click(); await settle(); }
      if (getComputedStyle($('codecopy')).display !== 'none') say('the copy button lingers where there is no code');
    }

    // The twin of the CRM's source cache, and the same defect: `in: SQL` reads every query once and
    // keeps it, while «Re-read this view» and «Retry the failures» replace the SQL in memory, write
    // it out, and left the search holding the previous text. Reproduced the way those two paths do
    // it - the new SQL arrives from the bridge, then it is written.
    const qid = Object.keys(sqls).find((id) => sqls[id] && sqls[id].stem);
    if (qid) {
      const c0 = await ensureSqlCache();
      if (typeof c0.get(qid) !== 'string') say('the SQL cache does not hold the query it was asked about');
      sqls[qid].sql = 'select 1 -- rewritten by the probe\\n';
      await writeSql(beginWorkspaceOp());   // the writers take the workspace they belong to
      const c1 = await ensureSqlCache();
      if (!/rewritten by the probe/.test(c1.get(qid) || ''))
        say('searching in: SQL still holds the query from before it was re-read');
    }

    // a link inside the detail is a step too - that is what the history exists for
    const link = document.querySelector('#dbody a.fk[data-go]');
    if (link) {
      const target = link.dataset.go;
      link.click(); await settle();
      if (String(selectedId) !== String(target)) say('a lineage link did not open its view');
      if (navState().entries.length !== 2 || navState().position !== 1) say('the forward tail was not dropped: ' + navState().entries.length + '@' + navState().position);
      if (String(navState().entries[0].id) !== String(a)) say('the step behind is not the view we came from');
      $('dback').click(); await settle();
      if (String(selectedId) !== String(a)) say('back from a link landed on ' + selectedId);
    }
    // **Every internal link in the report lands somewhere.** A link that goes nowhere is worse than
    // plain text: the reader clicks it, arrives at the same place, and concludes the document is
    // broken. It happened - `#v-<id>` for every report and dashboard named in a table cell, because
    // the link was decided by «this name is a view in the org» while the anchor exists only for the
    // views that get a heading of their own. Reported from a real workspace with the dead link.
    //
    // Driven on the *real* builder against the sample, and across several scopes, because unticking
    // a chapter is the second way to produce it: the anchors go and the links stay. The scopes are
    // built from SCOPE_KEYS, so a chapter added tomorrow is exercised without anyone remembering.
    const scopes = [Object.fromEntries(SCOPE_KEYS.map((k) => [k, true]))];
    for (const off of SCOPE_KEYS) scopes.push(Object.assign({}, scopes[0], { [off]: false }));
    let anchorsSeen = 0;
    for (const sc of scopes) {
      const doc = await buildExportHtml(sc);
      const ids = new Set([...doc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
      const hrefs = [...doc.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
      anchorsSeen += hrefs.length;
      const dead = [...new Set(hrefs.filter((h) => !ids.has(h)))];
      if (dead.length)
        say(dead.length + ' link(s) point at nothing with scope ' + JSON.stringify(sc) + ', e.g. #' + dead[0]);
    }
    // **A jump lands its target inside the scrollport, which is what puts it below the band.**
    // Reported: clicking an internal link arrived on a row half hidden under the band. The offset
    // used to be a custom property the report measured at load, on resize and at every click, plus a
    // correction after the jump - three moving parts, and all three absent for the reader who met
    // the defect, because the panel opens a report as a `blob:` in the extension's own origin where
    // an inline script is forbidden. The band is a row of the page now and `main` scrolls, so a
    // fragment lands below the band by construction.
    //
    // What this is and is not: it renders a real report and asserts that property. It is not where
    // the shape was proved - that was measured on a real export served with the extension's own
    // policy, script blocked, before and after the change.
    {
      const fr = document.createElement('iframe');
      fr.style.cssText = 'width:1240px;height:900px;border:0';
      document.body.appendChild(fr);
      const d = fr.contentDocument;
      d.open(); d.write(await buildExportHtml(Object.fromEntries(SCOPE_KEYS.map((k) => [k, true])))); d.close();
      await settle();
      const w = fr.contentWindow, scroller = d.querySelector('main');
      if (!scroller || getComputedStyle(scroller).overflowY !== 'auto')
        say('main is not the scrollport of this report, so every jump lands against the window');
      if (getComputedStyle(d.querySelector('header')).position === 'sticky')
        say('the band is sticky over the content again, which is what put every target behind it');
      const a = [...d.querySelectorAll('a[href^="#"]')].find((x) => d.getElementById(x.getAttribute('href').slice(1)));
      if (!a) say('the report has no internal link, so the jump cannot be measured');
      const target = d.getElementById(a.getAttribute('href').slice(1));
      a.click(); await settle();
      const gap = Math.round(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
      if (gap < -1) say(`a jump left its target ${-gap}px above the top of the scrollport`);
      // And a jump nobody clicked: from the address, the history, or a link that arrives with the
      // window. Nothing re-measures anything now, so it must hold identically.
      scroller.scrollTo(0, 0);
      w.location.hash = '';
      w.location.hash = a.getAttribute('href');
      await settle();
      const g2 = Math.round(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
      if (g2 < -1) say(`a jump made without a click left its target ${-g2}px above the scrollport`);
      fr.remove();
      void w;
    }
    // If a report has no internal links at all, this loop proves nothing and is the broken thing.
    if (!anchorsSeen) say('no internal links in any scope - this check is measuring nothing');


    // ---- the export dialog: what it remembers, and what it writes ----
    //
    // The twin of the block in the other panel's scenario, for the same reason: this is where a
    // reader decides what the report contains, and nothing had ever exercised what it remembers.
    const fsx = window.__fsshim;
    $('export').click(); await settle('the export dialog never opened');
    if (!$('expscope').classList.contains('on')) say('the export dialog did not open');
    const wasHealth = $('sc_health').checked;
    $('sc_health').checked = !wasHealth;
    $('sc_health').dispatchEvent(new Event('change')); await settle();
    $('expgo').click();
    await until(() => fsx.dump().some((x) => /export.*[.]html$/.test(x)), 'no report was written', 8000);
    await settle('the dialog never closed after exporting');
    if ($('expscope').classList.contains('on')) say('the dialog stayed open after Export');
    $('export').click(); await settle('the export dialog never reopened');
    if ($('sc_health').checked === wasHealth)
      say('the export dialog opened back on the old ticks - the choice was discarded');
    $('sc_health').checked = wasHealth; $('sc_health').dispatchEvent(new Event('change'));
    $('expcancel').click(); await settle('Cancel never closed the dialog');
    if ($('expscope').classList.contains('on')) say('Cancel left the dialog open');

    // ---- About ----
    $('about').click(); await settle('About never opened');
    if (!/licen[cs]e|Zoho/i.test($('aboutbody').textContent)) say('About says nothing about what it is');
    $('aboutok').click(); await settle('About never closed');

    // ---- a single view re-read, and what the workspace picker may do while it runs ----
    //
    // «Pull one» and changing workspace during a pull were both on the list of things only a person
    // could try. The first is the narrow path a reader takes after one query failed; the second has
    // already produced a defect here - work that followed the reader into the next workspace.
    const firstRow = $('list').querySelector('tr[data-id]');
    if (firstRow) {
      firstRow.click(); await settle('the detail pane never opened');
      // Exercise the stable detail-tab controls themselves, not only a text-labelled tab found by
      // the earlier check. A view without SQL, relations or lineage legitimately keeps that tab
      // unavailable, so only click controls the product says are usable.
      for (const id of ['tab_sql', 'tab_rel', 'tab_lin']) {
        const tab = $(id);
        if (tab && getComputedStyle(tab).display !== 'none' && !tab.disabled) {
          tab.click(); await settle('Analytics detail tab ' + id + ' never finished drawing');
          if (!tab.classList.contains('active')) say('Analytics detail did not select ' + id);
        }
      }
      // A relational view offers an ER entry point from the detail header. Open and close it
      // through the visible button so both the guard and the return path are exercised.
      if ($('dgraph') && !$('dgraph').disabled && getComputedStyle($('dgraph')).display !== 'none') {
        $('dgraph').click();
        await until(() => $('graphview').classList.contains('show'), 'the detail ER diagram never opened');
        $('graphx').click();
        await until(() => !$('graphview').classList.contains('show'), 'closing the detail ER diagram failed');
      }
      $('dclose').click();
      await until(() => !$('detail').classList.contains('show'), 'closing Analytics detail failed');
      const reopenedRow = $('list').querySelector('tr[data-id]');
      if (!reopenedRow) say('closing Analytics detail removed the list row');
      reopenedRow.click(); await settle('reopening Analytics detail failed');
      if (!$('dpull').disabled) {
        $('dpull').click();
        await until(() => !pullBusy, 'the single re-read never finished', 15000);
        await settle('the panel never redrew after the re-read');
        if (/could not|failed/i.test($('statustext').textContent))
          say('a single re-read of a view the fixture holds ended on: ' + $('statustext').textContent);
      }
    }
    // The picker, while a pull is running: the change is refused and the box goes back to the
    // workspace that is actually open, rather than showing one the panel is not reading.
    setPullBusy(true);
    const shownWs = $('ws').value;
    $('ws').value = 'not-a-workspace';
    const refusedWs = workspaceChangeRefuse();
    setPullBusy(false);
    if (!refusedWs) say('a workspace change during a pull was not refused');
    if ($('ws').value !== shownWs) say('the picker was left showing a workspace the panel is not reading');
    if (!/pull in progress/i.test($('statustext').textContent))
      say('the refusal was silent: ' + $('statustext').textContent);
    // **Retry, with nothing failed, is not offered** - and this used to click it anyway. The control
    // carries `display:none` until something has failed, so the click was a no-op and the assertion
    // under it compared a status line with itself: it could not have failed. A driver clicking what
    // the product is hiding is the shape this whole guard exists for, and it was in the guard's own
    // file. What holds instead is the product's actual behaviour: nothing to retry, nothing offered.
    if (getComputedStyle($('retry')).display !== 'none')
      say('Retry is offered with nothing failed - pressing it can only produce a refusal');

    // ---- Escape closes what is on top ----
    // The twin of the CRM case, and for the same reason: the decider reads the page, so only the
    // page can say whether it is reached and whether the class it tests is the one the product sets.
    $('about').click(); await settle('About never reopened for the Escape case');
    if (!$('aboutdlg').classList.contains('on')) say('About did not open, so Escape has nothing to close');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle('Escape never reached the dialog');
    if ($('aboutdlg').classList.contains('on')) say('Escape left About open');
    if ($('scrim').classList.contains('on')) say('Escape closed About and left its backdrop behind');

    // ---- The keyboard focus ring is legible ----
    // The twin of the CRM case, in the same shape so the two panels cannot answer differently by
    // accident. The reasoning is written there: the first version asserted the spelling of the rule
    // and stayed green with the rule removed, because the browser draws a ring of its own; this one
    // asks what a reader receives, which is contrast against whatever is painted behind the control.
    // This product's accent is the pink one and reads 4.19:1 where the CRM's blue reads 5.10:1 -
    // both above the 3:1 a non-text indicator is asked for, and the browser default is 1.02:1.
    {
      const el = document.querySelector('button:not(:disabled)');
      if (!el) say('no enabled control to focus - the panel is not in the state this case assumes');
      el.focus({ focusVisible: true });
      if (!el.matches(':focus-visible')) say('a focused control does not match :focus-visible, so no ring can be measured');
      const rgb = (s) => (String(s).match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
      const lum = (c) => {
        const f = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
        return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
      };
      const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
      let node = el.parentElement, back = null, backEl = null;
      while (node && !back) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) { back = rgb(bg); backEl = node; }
        node = node.parentElement;
      }
      if (!back) say('nothing is painted behind the focused control, so the ring has no measurable backdrop');
      const cs = getComputedStyle(el);
      const ring = contrast(rgb(cs.outlineColor), back);
      if (!(ring >= 3))
        say('the focus ring is not legible: ' + ring.toFixed(2) + ':1 against '
            + (backEl.id || backEl.className || backEl.tagName) + ' (outline ' + cs.outlineStyle
            + ' ' + cs.outlineWidth + ' ' + cs.outlineColor + ')');
      el.blur();
    }
    document.title = 'HISTORY OK';
  })().catch((e) => { document.title = 'SHOT ERROR: ' + e.message; });
"""


# A whole pull, through the shipped panel, in a browser. This is the case that did not exist.
#
# `pruneSql()` called `walk()`, which is a CRM panel function and was in no script the Analytics panel
# loads. Every Pull all threw, inside the try that marks the mirror incomplete, so the panel reported
# «the last pull was interrupted mid-write» over files it had written correctly - and the repair it
# advised hit the same wall. It reached a tagged, submitted package, because nothing in this
# repository executed a pull: the unit tests lift one function at a time, and the probe drove a
# workspace that was already on disk.
#
# What makes it a test rather than a demonstration: the fixture for «what Zoho answers» is built from
# the sample workspace itself - the one the shipped generator writes - so the assertion at the end is
# that the mirror the pull produced is the workspace it started from. A pull that stops early, writes
# half, or throws cannot pass it.
PULL_AN = r"""
  const say = (m) => { throw new Error(m); };
  // **A click on a control that is not on screen neither throws nor works**, which is the worst
  // shape a step in a driver can have: the ER scenario opened by clicking the diagram tab, which
  // carries `display:none` until the graph lands, and a run that lost that race failed three lines
  // later saying «the fixture draws 0 boxes» - a sentence about the fixture, describing a race.
  //
  // This was a static sweep first, and the static sweep could not see it: the click goes through a
  // helper, so of the 75 in these scenarios it read 40 and could judge 2. Deleting the guard it was
  // written for changed its answer not at all. Text cannot answer «is this element on screen»; the
  // page can, so the question is asked here, where a wrong answer is a thrown error naming the
  // control instead of a failure three lines later about something else.
  (() => {
    const real = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function clickOnScreen() {
      const cs = getComputedStyle(this);
      const why = !this.isConnected ? 'not in the document'
        : cs.display === 'none' ? 'display:none'
        : cs.visibility === 'hidden' ? 'visibility:hidden'
        : '';
      // `offsetParent === null` was tried as a fourth condition and taken out again: it is also null
      // for a `position:fixed` element, for one inside a `display:contents` box, and before the first
      // layout - so it reported controls that are on screen. The three above are unambiguous and are
      // exactly «the product is hiding this», which is the thing that made a click a silent no-op.
      if (why) say(`clicked a control that is not on screen (${why}): ${this.id || this.className || this.tagName}`);
      return real.apply(this, arguments);
    };
  })();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wait for the thing, with the same ceiling as the sleep it replaces.
  //
  // A click, a fixed sleep, then a read is a bet that the panel finished inside that sleep. (Written
  // without the code, because the counter below reads this text and a quoted example counted as a
  // fifth bet in every scenario - a check reading its own prose, which this repository has met
  // three times.)
  // It is the shape this repository has already written down and condemned - «read scrollTop after a
  // second is the 1990s junior's sleep, and it produces a fix of the same shape: one that waits
  // instead of knowing» - living in the tool built to catch exactly that class. A bet costs the full
  // number every run when it wins, and reads unsettled state when it loses; a condition costs a few
  // milliseconds and, when it does time out, says which condition never came true instead of failing
  // three lines later about something else.
  const until = async (cond, what, ms = 2500) => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = cond(); } catch (_) { ok = false; }
      if (ok) return;
      if (Date.now() - t0 > ms) say('waited ' + ms + 'ms and ' + what);
      await wait(25);
    }
  };
  // **«The panel has stopped changing» is a condition; «300ms» is a bet.** Most waits in these
  // scenarios are a click followed by a sleep followed by a read, which is the shape this repository
  // has already condemned in the product and kept in the tool built to catch it. This watches the
  // document and returns as soon as it has been quiet for a moment - so a fast machine costs
  // milliseconds, a slow one is still correct, and a panel that never redraws says so by name
  // instead of failing three lines later on whatever the click was supposed to have produced.
  //
  // What it does not cover, stated: work that finishes without touching the DOM. Those stay sleeps,
  // and the counter at the end of the run prints how many are left.
  let _lastMut = 0;
  new MutationObserver(() => { _lastMut = Date.now(); })
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  const settle = async (what, quiet = 150, ms = 4000) => {
    _lastMut = Date.now();
    await until(() => Date.now() - _lastMut > quiet, what || 'the panel never stopped redrawing', ms);
  };
  (async () => {
    const fs = window.__fsshim;
    const base = 'analytics/sample-workspace/';
    const J = (p) => JSON.parse(fs.read(base + p));
    const before = fs.dump().filter((p) => p.startsWith(base));
    // Prefixed, every one of them: `views`, `schema` and `deps` are the panel's own globals, and a
    // local of the same name shadows the thing the last assertion has to read. It shadowed it, and
    // the assertion read `window.views` instead - which is undefined, because a module-scope `let`
    // is not a property of the window. Two ways to be wrong about one name, in three lines.
    const fxViews = J('views.json'), fxSchema = J('schema.json'), fxLineage = J('lineage.json');
    const fxIndex = J('sql/index.json'), cfg = J('.zoost.json');
    // Read now, not when the bridge is asked: the tree is cleared below, and a closure that reads it
    // lazily hands the pull an empty string for every query - which the panel would faithfully write
    // out as an empty .sql. Caught by the assertion at the end, which is why it reads contents and
    // not only names.
    const bodies = {};
    for (const id of Object.keys(fxIndex)) bodies[id] = fs.read(base + 'sql/' + fxIndex[id].stem + '.sql');

    // The bridge, answering out of the workspace that was on disk. Every command the pull sends is
    // here; one that is missing falls through to `{ ok: true }`, which is why the assertions below
    // read the *result* instead of trusting that each call was made.
    window.__bridge = {
      workspaceInfo: () => ({ ok: true, workspace: cfg.workspace, name: cfg.name, origin: cfg.origin }),
      listViews: () => ({ ok: true, views: fxViews.views, folders: fxViews.folders }),
      workspaceErd: () => ({ ok: true, tables: fxSchema.tables, relations: fxSchema.relations }),
      pullSql: (m) => {
        const sql = {};
        for (const id of m.ids) {
          const e = fxIndex[id]; if (!e) continue;
          // **No `stem`**, because the real bridge sends none: its answer is
          // `{ id, sql, parents, sources }`. Inventing one here made the pull probe drive a shape the
          // product never sees, and it hid a defect for as long as it existed - after a real pull the
          // SQL search filtered every query out and reported «no match» over queries it had never
          // opened. A fake that is kinder than the thing it stands for is worse than none.
          sql[id] = { id, sql: bodies[id], parents: e.parents || [], sources: e.sources || {} };
        }
        return { ok: true, sql, failed: [] };
      },
      scanDependencies: () => ({ ok: true, deps: fxLineage.deps, failed: fxLineage.failed || [] }),
    };

    // Start from an empty workspace that is bound to this org and is *not* a sample: a sample refuses
    // to pull, which is correct and would make this pass by never running.
    fs.clear();
    const real = Object.assign({}, cfg); delete real.sample; delete real.sampleAt;
    fs.load({ [base + '.zoost.json']: JSON.stringify(real, null, 2) });
    await restoreRoot();
    await refreshWorkspaces();
    await settle('the workspace list never drew');
    const w = wsList.find((x) => String(x.id) === String(cfg.workspace));
    if (!w) say('the workspace is not in the list after refreshWorkspaces: ' + wsList.map((x) => x.id));
    await selectWorkspace(w);
    await settle('the selected workspace never drew');

    // Exercise the workspace label and the non-destructive cancellation of Remove. The dialog
    // result is supplied by the harness, but the click, persistence and cancellation remain the
    // shipped Analytics handlers and filesystem adapter.
    const oldPrompt = window.prompt;
    window.prompt = () => 'Probe Analytics workspace';
    $('wsrename').click();
    await until(() => /Probe Analytics workspace/.test(fs.read(base + '.zoost.json') || ''), 'Analytics workspace rename did not persist');
    window.prompt = oldPrompt;
    const oldConfirm = window.confirm;
    window.confirm = () => false;
    $('wsdel').click();
    await settle('Cancel Analytics workspace removal left the panel redrawing');
    window.confirm = oldConfirm;
    if (!fs.read(base + '.zoost.json')) say('Cancel Analytics workspace removal discarded the local config');

    // Exercise the control the reader actually presses. Calling pullAll() directly proves the
    // use case but skips the disabled-state guard and the DOM wiring on #pull.
    const clickPullAll = async (what = 'Pull all') => {
      await until(() => !$('pull').disabled, what + ' never became available');
      $('pull').click();
      await until(() => JSON.parse(fs.read(base + '.pull-state.json') || '{}').state === 'complete',
                  what + ' never reached a complete marker', 20000);
      await settle(what + ' left the panel redrawing');
    };
    await clickPullAll();

    // A transient item failure must expose Retry and a successful retry must remove it. Pick a
    // query that really exists in the fixture, fail it once at the bridge boundary, then restore
    // the normal answer. This exercises the failure state and the visible Retry control, not just
    // the no-failure branch that correctly hides it.
    const retryId = Object.keys(fxIndex).find((id) => fxViews.views.some((v) => String(v.id) === String(id) && v.type === 'QueryTable'));
    if (!retryId) say('the Analytics fixture has no query suitable for a retry path');
    const normalPullSql = window.__bridge.pullSql;
    let failRetryOnce = true;
    window.__bridge.pullSql = (m) => {
      const answer = normalPullSql(m);
      if (failRetryOnce && m.ids.map(String).includes(String(retryId))) {
        failRetryOnce = false;
        delete answer.sql[retryId];
        answer.failed = [{ id: retryId, error: 'synthetic transient failure' }];
      }
      return answer;
    };
    $('pull').click();
    await until(() => !pullBusy, 'the pull with a transient item failure never finished', 20000);
    await settle('the failed pull never rendered its retry state');
    await until(() => getComputedStyle($('retry')).display !== 'none', 'the failed pull did not expose Retry');
    $('retry').click();
    await until(() => !pullBusy, 'Retry never finished', 20000);
    await settle('Retry never redrew the Analytics panel');
    if (getComputedStyle($('retry')).display !== 'none') say('Retry remained visible after the failed item was recovered');
    window.__bridge.pullSql = normalPullSql;

    // Refresh is a separate control from Pull all: it distrusts the local mirror and reads it again.
    await until(() => !$('refresh').disabled, 'Refresh never became available after a completed pull');
    $('refresh').click();
    await until(() => !pullBusy, 'Refresh never finished', 20000);
    await settle('Refresh left the Analytics panel redrawing');

    // The main graph button is a user-facing entry point, distinct from the graph window probe
    // below. Verify that the click opens the inline diagram and that its close control returns to
    // the workbench rather than leaving an invisible overlay behind.
    await until(() => !$('graph').disabled, 'the Analytics graph control never became available');
    $('graph').click();
    await until(() => $('graphview').classList.contains('show'), 'the Analytics graph never opened');
    $('graphx').click();
    await until(() => !$('graphview').classList.contains('show'), 'closing the Analytics graph failed');

    // Markdown is the export path intended for hand-off to an external AI tool. Exercise its
    // dedicated button, not only the HTML dialog, and verify that a file was actually written.
    await until(() => !$('exportmd').disabled, 'Markdown export never became available');
    $('exportmd').click();
    await until(() => $('expscope').classList.contains('on'), 'Markdown export did not open its scope dialog');
    $('expgo').click();
    await until(() => fs.dump().some((x) => /export.*[.]md$/.test(x)),
                'Markdown export did not write a file', 10000);
    await settle('Markdown export left the panel redrawing');

    // The Analytics search has the same state transitions, with SQL as its full-text subject.
    // Drive the visible controls so both the engine and its DOM adapter have to agree.
    $('find').value = 'SELECT'; $('find').dispatchEvent(new Event('input')); await settle();
    $('smode').click(); await settle();
    if (searchState.snapshot().mode !== 'sql') say('in: SQL did not change the search interpretation');
    $('rxmode').click(); await settle();
    if (!searchState.snapshot().regex || $('find').value !== 'SELECT') say('turning .* on did not keep the SQL-search seed');
    $('rxmode').click(); await settle();
    if ($('find').value || searchState.snapshot().regex) say('turning .* off left a pattern as a literal search');
    $('smode').click(); await settle();

    // 1. It finished. The panel says so and the marker on disk says so - those two came apart exactly
    //    when this broke, which is why both are read.
    const line = document.getElementById('statustext').textContent;
    if (/interrupted|could not|failed/i.test(line)) say('the pull ended on: ' + line);
    const state = JSON.parse(fs.read(base + '.pull-state.json') || '{}').state;
    if (state !== 'complete') say('the marker on disk says ' + state);

    // 2. It wrote the same workspace it was given. Names first: a missing file is the shape a
    //    half-finished pull leaves, and it reads better than a diff of contents.
    const after = fs.dump().filter((p) => p.startsWith(base));
    const missing = before.filter((p) => !after.includes(p) && !/[.]zoost[.]json$/.test(p));
    if (missing.length) say(missing.length + ' file(s) the pull did not write, e.g. ' + missing[0]);

    // 3. And the SQL is the SQL, not an empty file with the right name.
    const anyStem = Object.values(fxIndex)[0].stem;
    const wrote = fs.read(base + 'sql/' + anyStem + '.sql');
    if (!wrote || !wrote.trim()) say('sql/' + anyStem + '.sql came out empty');
    if (Object.keys(J('sql/index.json')).length !== Object.keys(fxIndex).length)
      say('the SQL index does not carry every query');

    // 4. The panel is showing what it just pulled, not its memory of what was there before.
    if (fxViews.views.length !== views.length)
      say('the panel holds ' + views.length + ' views against ' + fxViews.views.length + ' pulled');

    // 5. Every stage of the pull said what it was doing. Read from the *events* - what the status
    //    line actually became, in order - and not sampled at chosen instants, which is this
    //    repository's own rule about intermittent behaviour. The stage that writes to disk is the one
    //    that was silent, and «looks stuck» is a bug report we have already had.
    const seen = [];
    const statusEl = () => document.getElementById('statustext');
    const obs = new MutationObserver(() => { const t = statusEl().textContent; if (seen[seen.length - 1] !== t) seen.push(t); });
    obs.observe(statusEl(), { childList: true, characterData: true, subtree: true });

    // 6. A second pull, over the workspace the first one wrote. This is where a half-written mirror
    //    shows: the prune has something to do, every file is rewritten, and the marker has to come
    //    back to complete. It was a thing only a person could try.
    await clickPullAll('The second Pull all');
    obs.disconnect();
    const line2 = statusEl().textContent;
    if (/interrupted|could not|failed/i.test(line2)) say('the second pull ended on: ' + line2);
    if (JSON.parse(fs.read(base + '.pull-state.json') || '{}').state !== 'complete')
      say('the second pull left the marker at ' + JSON.parse(fs.read(base + '.pull-state.json') || '{}').state);
    // 7. **A finished pull never leaves the panel on a busy line.** It did, and it was reported from
    //    a real org: «Rebuilding the list…» is a busy status, and when there was nothing to append to
    //    it nothing ever replaced it - so a pull that had completed sat on a spinner for ever. From
    //    outside, a finished operation showing a spinner and a hung one are the same thing, which is
    //    the one thing this panel is not allowed to be. Asserted as the property rather than as that
    //    sentence: the class says «working», and a trailing ellipsis promises a next line.
    if (document.getElementById('status').className === 'busy' || /\u2026$/.test(line2))
      say('the second pull finished on a busy line: ' + line2);

    const after2 = fs.dump().filter((p) => p.startsWith(base));
    if (after2.length !== after.length)
      say('a second pull changed the file count from ' + after.length + ' to ' + after2.length);
    for (const stage of ['Reading the view list', 'Reading SQL', 'Reading lineage', 'Writing the mirror', 'Writing SQL files']) {
      if (!seen.some((t) => t.indexOf(stage) === 0 || t.indexOf(stage) >= 0))
        say('the pull never said «' + stage + '» - it is a stage that runs in silence: ' + JSON.stringify(seen));
    }

    // 7. The tab moves to another workspace, and the panel refuses to read Zoho for it. The guard is
    //    what stops one org's data landing in another's folder, and it had never been exercised.
    window.__bridge.context = () => ({ ok: true, origin: cfg.origin, workspace: '99000999', view: null });
    await refreshContext();
    await settle('the panel never reacted to the tab it was given');
    const bytes = fs.dump().length;
    // A mismatch is intentionally a disabled control: clicking a disabled button cannot produce a
    // refusal message. Verify the UI explains why, then call the guarded entry point once to prove
    // the same protection still refuses a programmatic or stale event without writing the mirror.
    if (!$('pull').disabled) say('Pull all stayed enabled on a different workspace');
    if (!/different workspace/i.test($('pull').title))
      say('the disabled Pull all does not explain the workspace mismatch: ' + $('pull').title);
    await pullAll();
    await settle('the refusal never reached the status line');
    if (!/refus|different workspace|until they match/i.test(statusEl().textContent))
      say('a pull on a mismatched tab was not refused: ' + statusEl().textContent);
    if (fs.dump().length !== bytes) say('a refused pull still wrote to the workspace');
    document.title = 'PULL OK';
  })().catch((e) => { document.title = 'SHOT ERROR: ' + e.message; });
"""


# The same, one product over: the CRM's functions pull, which is the longest path in that panel -
# list, prune what Zoho no longer has, write the summary index, then download every source one by one.
# `downloadMissing()` is where the panel spends minutes on a real org, and nothing here had ever run it.

# The diagram window, which nothing drove. `shots.py` renders three pictures of it and a throw there
# refuses the render - so a crash was caught - but nothing *asserted* anything about behaviour in
# 2500 lines of the most interactive code in the product. The panels had a probe; this did not.
#
# The case is the defect found by reading, hours before this was written: fold a branch away and the
# tab badge said the boxes were gone while the status line beside it went on counting them. Five
# readers of one piece of state, fixed four at a time over months. A check that folds and compares
# the two numbers would have found the fifth on the day it was written.
#
# **A fresh query per click.** Collecting the marks once and clicking them in turn folds the first
# and re-renders the drawing - and the remaining elements, now detached, still fire their listeners,
# so clicking the same pair again *unfolds* it. Forty-four clicks came back to exactly where they
# started, `erCut` at 0, and the run reported that folding does nothing: a statement about the
# harness that reads as one about the product.
ER = """
  const say = (m) => { throw new Error(m); };
  // **A click on a control that is not on screen neither throws nor works**, which is the worst
  // shape a step in a driver can have: the ER scenario opened by clicking the diagram tab, which
  // carries `display:none` until the graph lands, and a run that lost that race failed three lines
  // later saying «the fixture draws 0 boxes» - a sentence about the fixture, describing a race.
  //
  // This was a static sweep first, and the static sweep could not see it: the click goes through a
  // helper, so of the 75 in these scenarios it read 40 and could judge 2. Deleting the guard it was
  // written for changed its answer not at all. Text cannot answer «is this element on screen»; the
  // page can, so the question is asked here, where a wrong answer is a thrown error naming the
  // control instead of a failure three lines later about something else.
  (() => {
    const real = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function clickOnScreen() {
      const cs = getComputedStyle(this);
      const why = !this.isConnected ? 'not in the document'
        : cs.display === 'none' ? 'display:none'
        : cs.visibility === 'hidden' ? 'visibility:hidden'
        : '';
      // `offsetParent === null` was tried as a fourth condition and taken out again: it is also null
      // for a `position:fixed` element, for one inside a `display:contents` box, and before the first
      // layout - so it reported controls that are on screen. The three above are unambiguous and are
      // exactly «the product is hiding this», which is the thing that made a click a silent no-op.
      if (why) say(`clicked a control that is not on screen (${why}): ${this.id || this.className || this.tagName}`);
      return real.apply(this, arguments);
    };
  })();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wait for the thing, with the same ceiling as the sleep it replaces.
  //
  // A click, a fixed sleep, then a read is a bet that the panel finished inside that sleep. (Written
  // without the code, because the counter below reads this text and a quoted example counted as a
  // fifth bet in every scenario - a check reading its own prose, which this repository has met
  // three times.)
  // It is the shape this repository has already written down and condemned - «read scrollTop after a
  // second is the 1990s junior's sleep, and it produces a fix of the same shape: one that waits
  // instead of knowing» - living in the tool built to catch exactly that class. A bet costs the full
  // number every run when it wins, and reads unsettled state when it loses; a condition costs a few
  // milliseconds and, when it does time out, says which condition never came true instead of failing
  // three lines later about something else.
  const until = async (cond, what, ms = 2500) => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = cond(); } catch (_) { ok = false; }
      if (ok) return;
      if (Date.now() - t0 > ms) say('waited ' + ms + 'ms and ' + what);
      await wait(25);
    }
  };
  // **«The panel has stopped changing» is a condition; «300ms» is a bet.** Most waits in these
  // scenarios are a click followed by a sleep followed by a read, which is the shape this repository
  // has already condemned in the product and kept in the tool built to catch it. This watches the
  // document and returns as soon as it has been quiet for a moment - so a fast machine costs
  // milliseconds, a slow one is still correct, and a panel that never redraws says so by name
  // instead of failing three lines later on whatever the click was supposed to have produced.
  //
  // What it does not cover, stated: work that finishes without touching the DOM. Those stay sleeps,
  // and the counter at the end of the run prints how many are left.
  let _lastMut = 0;
  new MutationObserver(() => { _lastMut = Date.now(); })
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  const settle = async (what, quiet = 150, ms = 4000) => {
    _lastMut = Date.now();
    await until(() => Date.now() - _lastMut > quiet, what || 'the panel never stopped redrawing', ms);
  };
  (async () => {
    // **Nothing is clicked before something has waited for it.** The ER tab is in the markup from
    // the first paint and hidden until the graph arrives, so clicking it early neither throws nor
    // works: `settle` then returns on a document that has gone quiet for its own reasons, and the
    // run failed at «the fixture draws 0 boxes» - which reads as a bad fixture and is a race. It
    // passed whenever the browser was already warm, and that is the whole of what «intermittent»
    // was here. The wait names the thing that never happened instead.
    const ertab = () => document.querySelector('.tab[data-v="er"]');
    await until(() => ertab() && ertab().style.display !== 'none',
                'the diagram window never received a graph - the ER tab stayed hidden', 8000);
    ertab().click();
    await settle('the ER view never drew');
    const badge = () => parseInt(($('ertabn') || {}).textContent || '0', 10) || 0;
    const line = () => {
      const m = /<b>(\\d+)<\\/b>/.exec($('statline').innerHTML || '');
      return m ? parseInt(m[1], 10) : -1;
    };
    // **Not** «the two numbers agree»: they legitimately count different things. The badge is the
    // boxes the ER view will draw, and in Analytics that excludes an entity with no field to show,
    // so 11 against 25 is correct there and asserting equality imposed a rule the product does not
    // have. What must hold is that **both follow the drawing**: fold boxes away and neither may
    // stand still, which is the defect this exists for.
    const before = { badge: badge(), line: line() };
    if (before.badge < 2) say(`the fixture draws ${before.badge} boxes - too few to fold one away`);
    if (before.line < 2) say(`the status line reads ${before.line} - nothing to watch move`);
    let after = null, tried = 0;
    while (tried < 12) {
      const mark = document.querySelector('.ermk.fold');
      if (!mark) break;
      tried++;
      mark.click();
      await settle('the fold never took effect');
      if (badge() < before.badge) { after = { badge: badge(), line: line() }; break; }
    }
    if (!tried) say('no fold mark on the drawing - this check no longer reaches the control it is about');
    if (!after) say(`${tried} folds took no box off the drawing - badge stayed at ${before.badge}`      + ` | erCut=${erCut.size} hidden=${erHiddenSet().size} visible=${erVisibleIds().length}`      + ` line=${line()}`);
    if (after.line >= before.line) {
      say(`folding took ${before.badge - after.badge} box(es) off the drawing and the status line `
          + `beside the badge still says ${after.line} - the window is stating in one place that `
          + 'boxes went and in another that they are here');
    }

    // **The badge is the count of what is drawn, so it is asked to be exactly that.** Every defect
    // this scenario has ever found in the window was two numbers about one drawing disagreeing -
    // after a fold, after «Everything», after a scope change - and each was found by measuring one
    // transition by hand. This asserts the identity instead, after every action the scenario takes,
    // so the next transition that forgets to refresh it is caught by having been written at all.
    const agree = (what) => {
      const b = badge(); const drawn = erVisibleIds().length;
      if (b !== drawn) say(`after ${what} the tab says ${b} and the drawing has ${drawn}`);
    };
    agree('the fold');
    // **A focus first, then «Everything».** The branch that returned before refreshing the badge is
    // the one that only runs with a focus live, so widening from an unfocused diagram walks straight
    // past it - written that way first, and the planted defect went unnoticed.
    if (typeof setFocus === 'function' && erIds.length) {
      setFocus(erIds[0]);
      await settle('the focus never landed');
      agree('a focus');
      const all = $('focusall');
      if (all && !all.disabled) {
        all.click();
        await settle('the scope never widened');
        agree('Everything with a focus live');
      }
    }
    document.title = 'SHOT OK';
  })().catch((e) => { document.title = 'SHOT ERROR: ' + e.message; });
"""


PULL_CRM = r"""
  const say = (m) => { throw new Error(m); };
  // **A click on a control that is not on screen neither throws nor works**, which is the worst
  // shape a step in a driver can have: the ER scenario opened by clicking the diagram tab, which
  // carries `display:none` until the graph lands, and a run that lost that race failed three lines
  // later saying «the fixture draws 0 boxes» - a sentence about the fixture, describing a race.
  //
  // This was a static sweep first, and the static sweep could not see it: the click goes through a
  // helper, so of the 75 in these scenarios it read 40 and could judge 2. Deleting the guard it was
  // written for changed its answer not at all. Text cannot answer «is this element on screen»; the
  // page can, so the question is asked here, where a wrong answer is a thrown error naming the
  // control instead of a failure three lines later about something else.
  (() => {
    const real = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function clickOnScreen() {
      const cs = getComputedStyle(this);
      const why = !this.isConnected ? 'not in the document'
        : cs.display === 'none' ? 'display:none'
        : cs.visibility === 'hidden' ? 'visibility:hidden'
        : '';
      // `offsetParent === null` was tried as a fourth condition and taken out again: it is also null
      // for a `position:fixed` element, for one inside a `display:contents` box, and before the first
      // layout - so it reported controls that are on screen. The three above are unambiguous and are
      // exactly «the product is hiding this», which is the thing that made a click a silent no-op.
      if (why) say(`clicked a control that is not on screen (${why}): ${this.id || this.className || this.tagName}`);
      return real.apply(this, arguments);
    };
  })();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wait for the thing, with the same ceiling as the sleep it replaces.
  //
  // A click, a fixed sleep, then a read is a bet that the panel finished inside that sleep. (Written
  // without the code, because the counter below reads this text and a quoted example counted as a
  // fifth bet in every scenario - a check reading its own prose, which this repository has met
  // three times.)
  // It is the shape this repository has already written down and condemned - «read scrollTop after a
  // second is the 1990s junior's sleep, and it produces a fix of the same shape: one that waits
  // instead of knowing» - living in the tool built to catch exactly that class. A bet costs the full
  // number every run when it wins, and reads unsettled state when it loses; a condition costs a few
  // milliseconds and, when it does time out, says which condition never came true instead of failing
  // three lines later about something else.
  const until = async (cond, what, ms = 2500) => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = cond(); } catch (_) { ok = false; }
      if (ok) return;
      if (Date.now() - t0 > ms) say('waited ' + ms + 'ms and ' + what);
      await wait(25);
    }
  };
  // **«The panel has stopped changing» is a condition; «300ms» is a bet.** Most waits in these
  // scenarios are a click followed by a sleep followed by a read, which is the shape this repository
  // has already condemned in the product and kept in the tool built to catch it. This watches the
  // document and returns as soon as it has been quiet for a moment - so a fast machine costs
  // milliseconds, a slow one is still correct, and a panel that never redraws says so by name
  // instead of failing three lines later on whatever the click was supposed to have produced.
  //
  // What it does not cover, stated: work that finishes without touching the DOM. Those stay sleeps,
  // and the counter at the end of the run prints how many are left.
  let _lastMut = 0;
  new MutationObserver(() => { _lastMut = Date.now(); })
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  const settle = async (what, quiet = 150, ms = 4000) => {
    _lastMut = Date.now();
    await until(() => Date.now() - _lastMut > quiet, what || 'the panel never stopped redrawing', ms);
  };
  (async () => {
    const fs = window.__fsshim;
    const base = 'crm/sampleorg-1234567890/';
    const J = (p) => JSON.parse(fs.read(base + p));
    const fxIndex = J('functions/index.json'), cfg = J('.zoost.json');
    // Read before the tree is cleared, for the reason the Analytics one has written on it.
    const src = {};
    for (const path of fs.dump()) {
      if (!path.startsWith(base + 'functions/') || !path.endsWith('.meta.json')) continue;
      const meta = JSON.parse(fs.read(path));
      const rel = path.slice((base + 'functions/').length);
      const stem = rel.split('/').pop().replace(/\.meta\.json$/, '');
      const one = { folder: rel.split('/')[0], stem, meta };
      // A compiled function is served the way the bridge serves it - the files of the project and
      // which one is the entry point - and not as a `.dg` that is not there. The stub used to read
      // one anyway: `fs.read` answered `undefined`, the writer refused a project with no files, and
      // the pull ended «3 still missing» about the three the sample had just gained. A stub that is
      // behind the product turns a working path into a defect report, which is the way round nobody
      // catches quickly.
      if (Array.isArray(meta.files) && meta.files.length) {
        const root = path.replace(/\.meta\.json$/, '.files/');
        one.files = meta.files.map((f) => ({ path: f, content: fs.read(root + f) }));
        one.primary = meta.primary_file || meta.files[0];
      } else {
        one.dg = fs.read(path.replace(/\.meta\.json$/, '.dg'));
      }
      src[String(meta.id)] = one;
    }
    if (!Object.keys(src).length) say('the fixture has no functions to serve');

    // `capped` is a *variable* here, not a literal. Fixing it at false made the branch this pull's
    // guard exists for unreachable in the one thing that executes the code - the same shape as the
    // stub that answered «no action is ever a function action» and quietly emptied a sweep. The
    // truncated case is driven below, after the ordinary one.
    let serveCapped = false;
    window.__bridge = {
      listFunctions: () => ({ ok: true, total: fxIndex.length, readable: fxIndex.length, skipped: 0,
                              capped: serveCapped, entries: fxIndex }),
      fetchOne: (m) => (src[String(m.id)] ? { ok: true, file: src[String(m.id)] }
                                          : { ok: false, error: 'no such function: ' + m.id }),
      pullFailures: () => ({ ok: true, at: '2026-09-26T10:00:00Z', failures: [], capped: false,
                             usage: { success: 12, failure: 0 }, runs: [], credits: null, month: null }),
    };

    fs.clear();
    const real = Object.assign({}, cfg); delete real.sample; delete real.sampleAt;
    fs.load({ [base + '.zoost.json']: JSON.stringify(real, null, 2) });
    // The CRM panel has no restoreRoot(): the folder comes back through loadWorkspaces() alone,
    // which is a difference between the twins and not a mistake in either.
    await loadWorkspaces();
    await settle('the workspace list never drew');

    // Workspace management is part of the user's data boundary. Use the native-dialog hooks only
    // to supply the text a real click would receive, then cancel removal so this probe never deletes
    // even its own fixture. The rename must persist to the local config; Cancel must leave it there.
    const oldPrompt = window.prompt;
    window.prompt = () => 'Probe workspace';
    $('wsrename').click();
    await until(() => /Probe workspace/.test(fs.read(base + '.zoost.json') || ''), 'Rename workspace did not persist');
    window.prompt = oldPrompt;
    const oldConfirm = window.confirm;
    window.confirm = () => false;
    $('wsdel').click();
    await settle('Cancel remove workspace left the panel redrawing');
    window.confirm = oldConfirm;
    if (!fs.read(base + '.zoost.json')) say('Cancel remove workspace discarded the local config');

    // Exercise the control the reader actually presses. Calling pullAll() directly proves the
    // runner but skips the disabled-state guard and the DOM wiring on #pull.
    const clickPullAll = async (what = 'Pull all') => {
      await until(() => !$('pull').disabled, what + ' never became available');
      $('pull').click();
      await until(() => !pullBusy, what + ' never finished', 20000);
      await settle(what + ' left the panel redrawing');
    };
    await clickPullAll();
    // Pull list is a separate user-facing operation from Pull all. Exercise the visible control so
    // its disabled guard, progress state and completion path are covered independently.
    setMode('functions'); await settle('the functions view never finished drawing after Pull all');
    await until(() => getComputedStyle($('pulllist')).display !== 'none' && !$('pulllist').disabled,
                'Pull list never became available');
    $('pulllist').click();
    await until(() => !pullBusy, 'Pull list never finished', 20000);
    await settle('Pull list left the panel redrawing');
    // `pullAll` hands over to `downloadMissing`, which is the part that takes the time. Wait for the
    // panel to say it is done rather than for a number of seconds: a sleep long enough for a slow
    // machine is a probe that takes that long on every machine.
    for (let i = 0; i < 120 && !/downloaded|still missing/.test($('stxt').textContent); i++) await wait(250);
    await until(() => !$('graph').disabled, 'the CRM graph control never became available');
    $('graph').click();
    await until(() => $('graphview').classList.contains('show'), 'the CRM graph never opened');
    $('graphx').click();
    await until(() => !$('graphview').classList.contains('show'), 'closing the CRM graph failed');

    await until(() => !$('exportmd').disabled, 'Markdown export never became available');
    $('exportmd').click();
    await until(() => $('expscope').classList.contains('on'), 'Markdown export did not open its scope dialog');
    $('expgo').click();
    await until(() => fs.dump().some((x) => /export.*[.]md$/.test(x)),
                'Markdown export did not write a file', 10000);
    await settle('Markdown export left the panel redrawing');

    // Health is the only other CRM control that asks Zoho for a fresh reading. Open it, execute
    // the runtime pull through the visible button, and close it again so the test also checks the
    // covered-view status line rather than only the local analysis.
    $('health').click();
    await until(() => $('healthview').classList.contains('show'), 'the CRM health view never opened');
    await settle('the CRM health view never finished drawing');
    await until(() => !$('healthpull').disabled, 'Pull runtime never became available');
    $('healthpull').click();
    await until(() => !$('healthpull').disabled, 'Pull runtime never finished', 10000);
    if (!/Read from Zoho|nothing failing/i.test($('healthmsg').textContent))
      say('Pull runtime finished without a runtime verdict: ' + $('healthmsg').textContent);
    $('healthx').click();
    await until(() => !$('healthview').classList.contains('show'), 'closing the CRM health view failed');

    const line = $('stxt').textContent;
    if (/still missing|failed|could not/i.test(line)) say('the pull ended on: ' + line);
    const after = fs.dump().filter((p) => p.startsWith(base + 'functions/'));
    // One source per function, and a compiled one is a project rather than a `.dg` - counting only
    // `.dg` would report «120 against 123» about a pull that wrote all three projects correctly.
    // The count is per *function*, which is what the org lists: its sidecar plus at least one file.
    const dg = after.filter((p) => p.endsWith('.dg')).length;
    const projects = new Set(after.filter((p) => /\.files\//.test(p)).map((p) => p.split('.files/')[0])).size;
    if (dg + projects !== fxIndex.length) {
      say(dg + ' source(s) and ' + projects + ' project(s) written against ' + fxIndex.length + ' in the org');
    }
    // A sidecar belongs to a `.dg` or to a project, and the pairing is what says a write finished
    // half way. `.files/config.json` is a file *of* a project, never a sidecar, so it is not counted.
    const metas = after.filter((p) => p.endsWith('.meta.json') && !/\.files\//.test(p)).length;
    if (metas !== dg + projects) {
      say(metas + ' sidecars against ' + (dg + projects) + ' function(s) - a pair is half written');
    }
    // The summary index the panel reads on every open: written by the pull, and checked against the
    // folder walk on load. If it is missing or short, the next open re-derives it in silence and the
    // fast path this repository measured is gone without anything saying so.
    const summary = JSON.parse(fs.read(base + 'functions/meta-index.json') || '{}');
    if (Object.keys(summary.files || {}).length !== dg + projects) {
      say('the summary index names ' + Object.keys(summary.files || {}).length
          + ' of ' + (dg + projects) + ' function(s)');
    }
    // And a source is the source, not an empty file with the right name.
    const one = after.find((p) => p.endsWith('.dg'));
    if (!(fs.read(one) || '').trim()) say(one + ' came out empty');

    // 7. **A finished pull never leaves the panel on a busy line.** It did, and it was reported from
    //    a real org: «Rebuilding the list…» is a busy status, and when there was nothing to append to
    //    it nothing ever replaced it - so a pull that had completed sat on a spinner for ever. From
    //    outside, a finished operation showing a spinner and a hung one are the same thing, which is
    //    the one thing this panel is not allowed to be. Asserted as the property rather than as that
    //    sentence: the class says «working», and a trailing ellipsis promises a next line.
    if (document.getElementById('status').className === 'busy' || /\u2026$/.test($('stxt').textContent))
      say('the pull finished on a busy line: ' + $('stxt').textContent);

    // **A pull redraws the item that is open, not only the list under it.** Reported from a real
    // org: a module was open, the pull brought down a kind of data that mirror had never carried,
    // and the new section showed up only after selecting another module and coming back. The list
    // had visibly refreshed, which is what makes it worse than plain staleness - the pane the reader
    // is looking at is the one thing that did not move.
    //
    // Driven through `pullCurrent()`, because `pullAll()` above is the functions *runner* and never
    // passes through the controller that owns the end of a pull. What is observed is `previewLoad` -
    // the panel's own count of draws started, incremented by every opener on entry - so the case
    // asks «did an opener run again» rather than reading a pane's markup, and it holds for all seven
    // kinds of item instead of the one this scenario happens to open.
    const openPath = one.slice(base.length);
    await openFile(openPath);
    await until(() => currentPath === openPath, 'the function never opened');
    const drawnBefore = previewLoad;
    await until(() => !$('pullone').disabled, 'Pull for the open function never became available');
    $('pullone').click();
    await until(() => !pullBusy, 'the per-tab pull never finished', 20000);
    await settle('the panel never settled after the per-tab pull');
    if (previewLoad === drawnBefore)
      say('the pull left the open item undrawn - the list refreshed under a pane showing the mirror as it was');
    if (currentPath !== openPath) say('the redraw after a pull moved off the open item to ' + currentPath);
    // And it says nothing of its own. Every opener clears the item status - right when a person
    // opened the item, wrong for a redraw nobody asked for, because the line on screen is the
    // pull's result. A blank line after a finished pull is the «is it still working?» this panel is
    // not allowed to be, and it would have shipped invisibly: nothing else reads that line here.
    if (!$('stxt').textContent.trim())
      say('the redraw after the pull blanked the status line the pull had just written');

    // **And the same pull over a list Zoho stopped early.** This is the one branch that decides
    // whether the mirror may delete, and nothing had ever executed it: the stub answered «not
    // truncated» always. A truncated list must not prune, and the panel must say so rather than
    // presenting a short list as the org.
    const beforeCap = fs.dump().filter((p) => p.startsWith(base)).length;
    // Every status line this pull writes, in order - the sequence, not a sample at a chosen instant.
    const said = [];
    const stEl = $('stxt');
    const stObs = new MutationObserver(() => { const t = stEl.textContent; if (said[said.length - 1] !== t) said.push(t); });
    stObs.observe(stEl, { childList: true, characterData: true, subtree: true });
    serveCapped = true;
    await clickPullAll('Pull all over a truncated list');
    await until(() => !pullBusy, 'the pull over a truncated list never finished', 20000);
    await settle('the panel never redrew after the truncated pull');
    const afterCap = fs.dump().filter((p) => p.startsWith(base)).length;
    if (afterCap < beforeCap)
      say(`a truncated list deleted ${beforeCap - afterCap} file(s) - a partial answer pruned the mirror`);
    stObs.disconnect();
    const cls = document.getElementById('status').className;
    if (!/more|stopped|partial|not everything|list stopped/i.test($('stxt').textContent) && cls !== 'warn')
      say(`a truncated list was reported as a complete one: «${$('stxt').textContent}» [${cls}]`
          + ' | said, in order: ' + JSON.stringify(said.slice(-6)));
    serveCapped = false;

    document.title = 'PULL OK';
  })().catch((e) => { document.title = 'SHOT ERROR: ' + e.message; });
"""


def coverage():
    """How many of each panel's controls these scripts actually click.

    The run used to end «both panels navigate as documented» - a sentence about the guides, printed
    after four scripted scenarios, with nothing saying how much of the panel they touch. Measured
    Before the critical-control tranche this was **21 of 105** clickable controls in the CRM and
    **18 of 89** in Analytics. The pull, graph, export, workspace and settings paths now add their
    real buttons;
    the remaining controls are still not exercised here, and a reader can see that from the report.

    The denominator is cruder than the check, which is the rule this repository states for anything
    that inspects a tree: a control is a `<button id=...>` in the panel's markup or an element given
    an `onclick` by a script. That over-counts - a button the probe reaches by a selector rather than
    by id reads as undriven - and over-counting is the safe direction for a number whose job is to
    stop a sentence from sounding complete.
    """
    import re
    out = []
    clicked = set(re.findall(r"\$\('([^']+)'\)\s*\.click\(\)", pathlib.Path(__file__).read_text(encoding="utf-8")))
    for app in sorted(d.name for d in (ROOT / "apps").iterdir() if (d / "workbench.html").exists()):
        html = (ROOT / "apps" / app / "workbench.html").read_text(encoding="utf-8")
        js = "".join(f.read_text(encoding="utf-8") for f in (ROOT / "apps" / app).glob("*.js"))
        ids = set(re.findall(r'<button[^>]*\bid="([^"]+)"', html))
        ids |= set(re.findall(r"\$\('([^']+)'\)\.onclick\s*=", js))
        out.append((app, len(ids & clicked), len(ids)))
    return out


def waits() -> tuple:
    """(bare sleeps, condition waits) across every scenario in this file.

    Derived from this file's own text rather than from a number typed beside it, so the two move
    when the scenarios do. It reads `await wait(` and `await until(`, which is the whole vocabulary;
    a third way of waiting introduced tomorrow is invisible here and would need this widened - said
    rather than left as a silence, because a count under an unstated blind spot is the number that
    gets quoted as evidence.
    """
    import ast
    tree = ast.parse(pathlib.Path(__file__).read_text(encoding="utf-8"))
    bare = cond = 0
    for node in tree.body:
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Constant):
            continue
        body = node.value.value
        # A scenario is a module-level string that defines its own `wait`. Derived, so a sixth one
        # added tomorrow is counted; naming them would be a list to keep in step by hand.
        if not isinstance(body, str) or "const wait =" not in body:
            continue
        # `settle` is `until` wearing a shorter name - it waits for the document to stop
        # changing - so counting it as a bet would report the opposite of what it is.
        bare += body.count("await wait(")
        cond += body.count("await settle(")
        cond += body.count("await until(")
    return (bare, cond)


def click_guard_installed() -> tuple:
    """(scenarios missing the on-screen guard, scenarios read).

    **This was a static sweep and the static sweep could not see the defect it was written for.**
    The ER scenario clicked the diagram tab, which carries `display:none` until the graph lands; a
    click on a hidden control neither throws nor works, so the run failed three lines later saying
    «the fixture draws 0 boxes» - a sentence about the fixture, describing a race. The sweep read the
    text before each `.click(`, and of the 75 in these scenarios it reached 40 and could judge 2:
    the click goes through a helper, and «a wait exists somewhere earlier» is true of everything
    after the first one. Deleting the guard it was written for changed its answer not at all.

    Text cannot answer «is this element on screen». The page can, so the question is asked there -
    every scenario installs a `HTMLElement.prototype.click` that refuses a control the product is
    hiding, by name. It found two real ones on its first run: a loop that believed it closed every
    group in the tree and closed one, and a click on a Retry button that is hidden precisely because
    there is nothing to retry, under an assertion that therefore compared a status line with itself.

    What is left here is the one thing a text scan can honestly hold: that every scenario installs
    it. A scenario added tomorrow without the guard is a scenario back in the dark.
    """
    import ast
    tree = ast.parse(pathlib.Path(__file__).read_text(encoding="utf-8"))
    missing, seen = [], 0
    for node in tree.body:
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Constant):
            continue
        body = node.value.value
        if not isinstance(body, str) or "const wait =" not in body:
            continue
        seen += 1
        name = node.targets[0].id if isinstance(node.targets[0], ast.Name) else "?"
        # The *install*, not the mention: `const real = HTMLElement.prototype.click` reads it, and a
        # plant that blanked that line left the marker in place and the check green - the checker
        # measuring a word instead of the act.
        if "HTMLElement.prototype.click = function" not in body:
            missing.append(name)
    return missing, seen


# **The settings, opened as a view of the panel.** They were a popup page of their own until the
# panel became a window; nothing here could drive them then, because a second page is a second
# render. They are in this document now, so one scenario asks the two things that actually broke
# while they were being moved: does the form paint from what is stored, and does the way out work.
#
# It borrows the preamble - `say`, `until`, `$`, the click guard - from a scenario that has one,
# rather than carrying a sixty-line copy that would drift from it. The steps are what is new.
SETTINGS = PULL_CRM.split('(async () => {')[0] + """(async () => {
  const view = $('settingsview');
  if (!view) say('the settings are not in this window at all');
  if (view.classList.contains('show')) say('the settings are open before anybody asked');
  // Enter through the toolbar control a reader uses. Calling openSettingsView() directly would
  // validate the view while skipping the wiring from the workbench.
  await until(() => $('opts') && getComputedStyle($('opts')).display !== 'none', 'Settings control never became visible');
  $('opts').click();
  await until(() => view.classList.contains('show'), 'the settings view to open');
  // Painted from what is stored rather than left as the markup's placeholders: `#ver` is written
  // by the paint, so an empty one means the form opened over nothing.
  await until(() => ($('ver').textContent || '').trim().length > 0, 'the version to be filled in');
  // The toolbar handler starts init asynchronously. Wait for a value written by the layout read,
  // not merely for the version label written before that read begins, before pressing Save.
  await until(() => ($('cfgvMargin').textContent || '').trim().length > 0, 'settings values to finish loading');
  // Every section reports itself unchanged straight after a paint - that is what «no unsaved
  // changes» means, and it was wrong once because the rebase ran before the reads.
  const dirty = [...document.querySelectorAll('[data-section]')].filter((x) => x.classList.contains('dirty'));
  if (dirty.length) say('a section says it has unsaved changes the moment it is opened: ' + dirty.map((x) => x.dataset.section).join(', '));
  // Exercise the settings actions that write user preferences. This scenario has its own browser
  // profile, so it can verify the dirty marker and the save result without changing a real user's
  // settings or relying on storage state from another probe.
  if ($('scSafe')) {
  $('scSafe').click(); await settle('Share-safe did not update export defaults');
  // The stored fixture may already be share-safe, so make a guaranteed edit before asserting the
  // dirty marker. The preset click above is still covered; this toggle proves a normal checkbox
  // edit follows the same save path.
  const codeBox = $('cfgsc_code');
  codeBox.checked = !codeBox.checked; codeBox.dispatchEvent(new Event('change')); await settle();
  if (!document.querySelector('[data-section="exportScope"] .unsaved')) say('Share-safe did not mark export defaults dirty');
  $('saveScope').click(); await until(() => !document.querySelector('[data-section="exportScope"] .unsaved'), 'Save defaults did not clear its dirty marker');
  }
  $('layReset').click(); await settle('Restore diagram defaults did not redraw');
  // The stored layout may already equal the built-in preset, so change one slider after exercising
  // the reset button to prove the section's ordinary edit path as well.
  const margin = $('cfgMargin');
  margin.value = String(Math.min(Number(margin.max), Number(margin.value) + Number(margin.step || 5)));
  margin.dispatchEvent(new Event('input', { bubbles: true }));
  margin.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  if (!document.querySelector('[data-section="erParams"] .unsaved')) say('Restore diagram defaults did not mark the section dirty');
  $('saveLay').click(); await until(() => !document.querySelector('[data-section="erParams"] .unsaved'), 'Save diagram defaults did not clear its dirty marker');
  if ($('tabReset')) {
  $('tabReset').click(); await settle('Show all tabs did not redraw');
  const tabToggle = document.querySelector('#tablist input[type="checkbox"]:not(:disabled)');
  if (!tabToggle) say('the Tabs settings list has no editable tab');
  tabToggle.click(); await settle('toggling a tab preference did not redraw');
  if (!document.querySelector('[data-section="tabPrefs"] .unsaved')) say('toggling a tab did not mark the section dirty');
  $('saveTabs').click(); await until(() => !document.querySelector('[data-section="tabPrefs"] .unsaved'), 'Save tabs did not clear its dirty marker');
  }
  // Saved search patterns are another settings write shared by both panels. Add one valid pattern,
  // fill the two generated fields, and verify Save consumes the section's unsaved marker.
  if ($('rxAdd')) {
    $('rxAdd').click(); await settle('Add pattern did not redraw');
    const rxInputs = [...document.querySelectorAll('#rxlist input')];
    if (rxInputs.length < 2) say('Add pattern did not create name and expression fields');
    const nameInput = rxInputs[rxInputs.length - 2], expressionInput = rxInputs[rxInputs.length - 1];
    nameInput.value = 'Probe pattern'; nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    expressionInput.value = 'probe'; expressionInput.dispatchEvent(new Event('input', { bubbles: true }));
    expressionInput.dispatchEvent(new Event('change', { bubbles: true })); await settle();
    if (!document.querySelector('[data-section="rxShortcuts"] .unsaved')) say('Add pattern did not mark saved searches dirty');
    $('saveRx').click(); await until(() => !document.querySelector('[data-section="rxShortcuts"] .unsaved'), 'Save patterns did not clear its dirty marker');
  }
  $('settingsx').click();
  await until(() => !view.classList.contains('show'), 'the settings view to close');
})();
"""

def main() -> int:
    if not shots.have_chrome():
        print("probe: no Chrome here - nothing driven, and nothing claimed.", flush=True)
        return 1 if os.environ.get("ZOOST_REQUIRE_CHROME") == "1" else 0
    # The panel pull below deliberately supplies normalized bridge answers: it isolates the writer
    # and its recovery paths. These endpoint paths own the boundary it leaves out. The same shipped
    # panels talk through Chrome-shaped messaging to the shipped content bridges; Chrome intercepts
    # every request before the network and answers with raw, invented wire fixtures derived from real
    # Pull all captures. Analytics caught PAROBJID arriving as a JSON-array string while the bridge
    # treated it as an array and durably wrote every query with no parents. CRM also replays the
    # Deluge bootstrap that Zoho's own Connections page performs before its catalogue request.
    print(f"  {'endpoint-crm':18s} driving…", flush=True)
    env = os.environ.copy()
    env["CHROME"] = shots.chrome()
    # A bound, because a probe that stops answering must fail the battery rather than hold it - and
    # the pre-push hook with it. The pull itself takes seconds; three minutes is only a ceiling.
    subprocess.run(["node", str(ROOT / "tools" / "crm-endpointprobe.mjs")], check=True, env=env, timeout=180)
    print(f"  {'endpoint-crm':18s} ok", flush=True)
    print(f"  {'endpoint-analytics':18s} driving…", flush=True)
    env["CHROME"] = shots.chrome()
    subprocess.run(["node", str(ROOT / "tools" / "endpointprobe.mjs")], check=True, env=env, timeout=180)
    print(f"  {'endpoint-analytics':18s} ok", flush=True)
    shots._browser_for(1280, 800, 1.0)
    try:
        for key, app, ws, script in (("probe-crm", "crm", "crm/sampleorg-1234567890", CRM),
                                     ("probe-analytics", "analytics", "analytics/sample-workspace", AN),
                                     ("pull-analytics", "analytics", "analytics/sample-workspace", PULL_AN),
                                     ("pull-crm", "crm", "crm/sampleorg-1234567890", PULL_CRM),
                                     ("settings-crm", "crm", "crm/sampleorg-1234567890", SETTINGS),
                                     ("settings-analytics", "analytics", "analytics/sample-workspace", SETTINGS)):
            print(f"  {key:18s} driving\u2026", flush=True)
            dest = shots.render_panel((key, app, ws, script))
            dest.unlink(missing_ok=True)          # a probe is not a picture to publish
            print(f"  {key:18s} ok", flush=True)
        # The diagram window is a different page with a different loader - `shots.render` stages it
        # from a graph fixture where `render_panel` stages a workspace - so it is driven here rather
        # than folded into the loop above.
        for key, app, fixture, script in (("er-crm", "crm", "graph-crm-schema.json", ER),
                                          ("er-analytics", "analytics", "graph-analytics.json", ER)):
            print(f"  {key:18s} driving\u2026", flush=True)
            dest = shots.render((key, app, fixture, script))
            dest.unlink(missing_ok=True)
            print(f"  {key:18s} ok", flush=True)
    finally:
        shots._browser_stop()
    for app, drove, total in coverage():
        print(f"  {app}: drove {drove} of the {total} clickable controls in the panel; "
              f"the rest are not exercised here.", flush=True)
    # What the instrument itself rests on, printed rather than left to be discovered. A bare
    # `await wait(N)` is a bet that the panel finished in N milliseconds: it costs the whole number
    # every run when it wins and reads unsettled state when it loses, and the failure then lands
    # three lines later, about something else. `await until(cond, what)` costs milliseconds and names
    # the condition that never came true. Both are counted so the ratio is visible; the bare one
    # should shrink, and tests/tools_test.py holds it so it cannot grow quietly.
    bare, cond = waits()
    # The five polling steps inside `until` itself are in the bare count and are not bets - they are
    # how a condition is watched. Said, rather than subtracted: a number with a quiet adjustment in
    # it is the kind nobody can check.
    print(f"probe: {cond} of {bare + cond} waits are for a condition; {bare} are sleeps "
          f"(5 of them the polling step inside `until`) - a sleep is a bet about how long the "
          f"panel takes.", flush=True)
    # The other bet, and the one that does not throw when it loses: clicking a control the product
    # keeps hidden until its data has arrived. The denominator is the markup's, not a list here.
    missing, scenarios = click_guard_installed()
    print(f"probe: {scenarios - len(missing)} of {scenarios} scenario(s) refuse a click on a control "
          f"the product is hiding - asked of the page, which is the only thing that can answer it.", flush=True)
    for name in missing:
        print(f"probe: {name} does not install the on-screen guard, so a click on a hidden control "
              f"there is a silent no-op and the failure lands later, about something else.", flush=True)
    late = missing
    print("probe: the scripted paths above ran without throwing.", flush=True)
    return 1 if late else 0


if __name__ == "__main__":
    raise SystemExit(main())
