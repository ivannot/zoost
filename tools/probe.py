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
  let copied = null;
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
    const wide = document.body.style.width;
    document.body.style.width = '340px'; await wait(300);
    const grp = document.querySelector('.wsgroup');
    if (grp.scrollWidth > grp.clientWidth + 1)
      say(`the toolbar needs ${grp.scrollWidth}px in ${grp.clientWidth}px - an icon is off-screen at the minimum width`);
    document.body.style.width = wide; await wait(200);
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
        if (getComputedStyle($('codecopy')).display !== 'none') say('the copy button lingers over a workflow, which has no code');
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
    // Held against Health itself, not against numbers: «it must be identical to the one in ai and health,
    // behave the same way, and disable every other control». So the health
    // view is opened, measured, closed - and the history has to match it rectangle for rectangle and
    // dim the same set of controls.
    $('health').click(); await wait(600);
    const hBox = $('healthview').getBoundingClientRect();
    const dimmed = (skip) => [...document.querySelectorAll('.wsgroup > button')]
      .filter((b) => b.id !== skip).map((b) => getComputedStyle(b).pointerEvents).join(',');
    const hDim = dimmed('health');
    $('healthx').click(); await wait(400);
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
    $('navfind').value = 'zzzznothing'; $('navfind').dispatchEvent(new Event('input')); await wait(300);
    if (document.querySelectorAll('#navbody .nvrow').length) say('the search does not filter the history');
    $('navfind').value = ''; $('navfind').dispatchEvent(new Event('input')); await wait(300);
    if (!document.querySelectorAll('#navbody .nvrow').length) say('clearing the box did not bring the chain back');
    // Narrower: it still covers its host exactly. It is meant to be *over* the tab row now, so the
    // old check - that it stayed below the tabs - was asserting the shape this one replaced.
    document.body.style.width = '420px'; await wait(250);
    const box = $('navview').getBoundingClientRect(), h2 = $('belowbar').getBoundingClientRect();
    if (Math.abs(box.width - h2.width) > 1 || Math.abs(box.top - h2.top) > 1)
      say(`a narrower panel left the history at ${Math.round(box.width)}px over a ${Math.round(h2.width)}px host`);
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
    $('navname').click(); await wait(500);
    const named2 = fnRow().querySelector('.nvl').textContent;
    if (named1 === named2) say('the chain did not follow the name toggle: still ' + named2);
    const inTree = [...document.querySelectorAll('#tree .f[aria-selected="true"]')][0];
    if (inTree && !inTree.textContent.includes(named2)) say(`the chain says «${named2}» and the tree «${inTree.textContent.trim()}»`);
    $('navname').click(); await wait(400);

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


    // The code can be taken out of the panel. Reported as missing, and the clipboard is stubbed here
    // because a headless page has no permission to write to the real one - what is proven is that the
    // button is offered where there is code, absent where there is none, and that what it hands over
    // is exactly what is on screen.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (x) => { copied = x; } }, configurable: true });
    if (getComputedStyle($('codecopy')).display === 'none') say('no copy button over a function');
    $('codecopy').click(); await wait(300);
    if (copied !== $('pvcode').textContent) say('what was copied is not the code on screen');
    // It stands in a row of buttons, so it is the height of that row - measured against a neighbour
    // rather than given a number, which is how it came out 28px beside their 22.
    const cb = $('codecopy').getBoundingClientRect(), nb = $('pvtab_code').getBoundingClientRect();
    if (Math.abs(cb.height - nb.height) > 1) say(`the copy button is ${cb.height}px against the row's ${nb.height}px`);
    if (Math.abs(cb.top - nb.top) > 1) say('the copy button is not on the same line as the tabs beside it');
    if (!$('codecopy').querySelector('svg')) say('the mark is gone after a copy');
    // It belongs to the pane that holds code, so it goes away with it: on «Details», and on a module,
    // which has no code at all. It stayed lit on both - visible in a picture published on the site.
    $('pvtab_info').click(); await wait(300);
    if (getComputedStyle($('codecopy')).display !== 'none') say('the copy button is still there on Details');
    $('pvtab_code').click(); await wait(300);
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
      await rebuildTree(); await wait(700);
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
      await rebuildTree(); await wait(700);
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
      if (e2.sv !== 2 || !Array.isArray(e2.refs)) say(`the other order loses something too: sv=${e2.sv} refs=${Array.isArray(e2.refs)}`);
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
      r.click(); await wait(900);
      $('pvtab_info').click(); await wait(500);
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
      r2.click(); await wait(900);
      $('pvtab_code').click(); await wait(400);
      const links = [...document.querySelectorAll('#pvcode a.c-link[data-mod]')];
      if (links.length !== 1) say('module links in code: ' + links.length + ', expected exactly one');
      if (links[0].dataset.mod !== 'Contacts') say('the wrong string was linked: ' + links[0].dataset.mod);
      if (getComputedStyle(links[0]).cursor !== 'pointer') say('the module link does not say it is clickable');
      links[0].click(); await wait(1400);
      if (viewMode !== 'modules') say('clicking the module in the code did not open the Modules tab');
      const back2 = [...document.querySelectorAll('.seg')].find((s) => /Functions/.test(s.textContent));
      if (back2) { back2.click(); await wait(700); }
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
        seg.click(); await wait(1200);
        const row = [...document.querySelectorAll('#tree .f')].find((e) => /Contacts/.test(e.textContent));
        if (row) {
          row.click(); await wait(1200);
          // and it has to be visible even when its group is **closed**, which is the case that was
          // reported next: the row is not drawn at all, so there is nothing to scroll to. Closed
          // here on purpose before jumping, because that is the state a reader leaves behind.
          $('tree').querySelectorAll('.grp:not(.collapsed)').forEach((g) => g.click());
          await wait(400);
          const link3 = document.querySelector('#pvcode a.c-link[data-mod]');
          if (link3) { link3.click(); await wait(1200); }
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
          $('pvtab_info').click(); await wait(900);
          // A «Read by» chip opens a function, which lives on the other tab: the tab has to come
          // with it, or the list shows modules while the detail shows a function. Reported.
          const rb = $('pvcallers').querySelector('a.wf-fn[data-file]');
          if (rb) {
            rb.click(); await wait(1400);
            if (viewMode !== 'functions') say('a function opened from a module left the tab on ' + viewMode);
            const segM = [...document.querySelectorAll('.seg')].find((s) => /Modules/.test(s.textContent));
            if (segM) { segM.click(); await wait(900); }
            const row2 = [...document.querySelectorAll('#tree .f')].find((e) => /Contacts/.test(e.textContent));
            if (row2) { row2.click(); await wait(1000); $('pvtab_info').click(); await wait(600); }
          }
          const txt = $('pvcallers').textContent || '';
          if (!/Read by|Written by|No function reads/.test(txt))
            say('the module detail does not say what code does with it: ' + txt.slice(0, 80));
        }
        const back = [...document.querySelectorAll('.seg')].find((s) => /Functions/.test(s.textContent));
        if (back) { back.click(); await wait(900); }
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
      if (segM2) { segM2.click(); await wait(1000); }
      // The reported state: the panel opened on another tab, so the functions tree was never loaded
      // in this workspace and there are no rows for the old mechanism to mark.
      treeData = [];
      $('refresh').click(); await wait(1800);
      const segF2 = [...document.querySelectorAll('.seg')].find((s) => /Functions/.test(s.textContent));
      if (segF2) { segF2.click(); await wait(1400); }
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
    {
      const vis = rows().filter((e) => {
        const r = e.getBoundingClientRect(), b = $('tree').getBoundingClientRect();
        return r.top >= b.top && r.bottom <= b.bottom;
      });
      if (vis.length > 1) {
        const before = $('tree').scrollTop;
        vis[vis.length - 1].click(); await wait(900);
        if ($('tree').scrollTop !== before)
          say(`clicking a visible row moved the list from ${before} to ${$('tree').scrollTop}`);
      }
    }

    // Nothing to clear, nothing to click. Reported, and held here because a rule that hides a
    // control is exactly the kind that renders as nothing the day the markup moves.
    {
      $('find').value = ''; $('find').dispatchEvent(new Event('input')); await wait(200);
      if (getComputedStyle($('findx')).display !== 'none') say('the clear mark is shown over an empty box');
      $('find').value = 'x'; $('find').dispatchEvent(new Event('input')); await wait(300);
      if (getComputedStyle($('findx')).display === 'none') say('the clear mark stays hidden with text in the box');
      $('find').value = ''; $('find').dispatchEvent(new Event('input')); await wait(300);
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
      if (!/rewritten by the probe/.test(c1.get(src.id) || ''))
        say('searching in: code still holds the text from before the file was rewritten');
    }

    // Set the Kind filter in Actions, then make the list reload the way clicking a row's status dot
    // does. The chips are rebuilt from the data - the kinds are derived - and rebuilding them reset
    // the filter, so the answer to «show me the webhooks» was the whole list a moment later.
    {
      const segA = [...document.querySelectorAll('.seg')].find((s) => /Actions/.test(s.textContent));
      if (segA) {
        segA.click(); await wait(1200);
        const sel = document.querySelector('#typechips .filtersel');
        const opt = sel && [...sel.options].map((o) => o.value).find((v) => v !== 'all' && v !== 'unused');
        if (!opt) say('the Actions tab offers no kind to filter by - the case cannot run');
        else {
          sel.value = opt; sel.onchange(); await wait(400);
          await rebuildActions(); await wait(600);
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
  let copied = null;
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
    const wide = document.body.style.width;
    document.body.style.width = '340px'; await wait(300);
    const grp = document.querySelector('.wsgroup');
    if (grp.scrollWidth > grp.clientWidth + 1)
      say(`the toolbar needs ${grp.scrollWidth}px in ${grp.clientWidth}px - an icon is off-screen at the minimum width`);
    document.body.style.width = wide; await wait(200);
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

    // The SQL is shown the way the CRM shows Deluge: lines as the author wrote them, and the box
    // scrolls. It wrapped here and not there - reported as an inconsistency between the two products,
    // and a wrapped query is one whose indentation has stopped meaning anything.
    const sqlTab = [...document.querySelectorAll('.dtab')].find((x) => /SQL/.test(x.textContent));
    if (sqlTab) {
      sqlTab.click(); await wait(600);
      const pre = document.querySelector('pre.sql');
      if (pre) {
        const s = getComputedStyle(pre);
        if (s.whiteSpace !== 'pre') say(`the SQL still wraps: white-space is ${s.whiteSpace}`);
        if (s.overflowX !== 'auto' && s.overflowX !== 'scroll') say(`the SQL cannot scroll sideways: overflow-x is ${s.overflowX}`);
        // The copy control belongs to code, so it is only asked for where there is code - the view
        // this probe happens to have open may be a table, which has none.
        if (getComputedStyle($('codecopy')).display === 'none') say('no copy button over the SQL');
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (x) => { copied = x; } }, configurable: true });
        $('codecopy').click(); await wait(300);
        if (copied !== pre.textContent) say('what was copied is not the SQL on screen');
        const cb = $('codecopy').getBoundingClientRect(), nb = $('tab_sql').getBoundingClientRect();
        if (Math.abs(cb.height - nb.height) > 1) say(`the copy button is ${cb.height}px against the row's ${nb.height}px`);
        if (Math.abs(cb.top - nb.top) > 1) say('the copy button is not on the same line as the tabs beside it');
      }
      const cols = [...document.querySelectorAll('.dtab')].find((x) => /Columns/.test(x.textContent));
      if (cols) { cols.click(); await wait(400); }
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
