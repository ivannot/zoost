// CRM context bar and Zoho-tab guard.
// ---------- context bar + off-zoho overlay ----------
let contextLoad = 0;
// What a sample's workspace half says, in one place: the on-platform branch and the
// off-platform one both need it, and a third copy is how the two came apart.
const SAMPLE_CHIP = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">sample - generated, never pulled</span>';
let _ctxErr = null;
/** The overlay's twin group: shown only on the twin's tab, and it carries the whole answer.
 *
 *  Three groups with three purposes - «you are on the other product's tab», «go to Zoho CRM»,
 *  «look at an example». They were one flat column of five equal-looking choices, reported as
 *  «tutti ammassati e non hanno una logica», and the reader had to work out which was which.
 *
 *  What this group may promise is bounded by what Chrome allows, which was measured rather than
 *  assumed: a message crosses between the two extensions, a user gesture does not. So it can say
 *  «click its icon in the toolbar» and it cannot do it for them.
 */
/** The same way out, on the context bar - which is the only thing that speaks while a sample is
 *  open, because the overlay is deliberately down there. Reported as the hardest case to read:
 *  «This is a Zoho Analytics tab» over a workspace of invented data, with nothing to do about it.
 *
 *  The mark carries it, not a sentence: `#ctx .who` is nowrap with an ellipsis, so a longer line is
 *  a line nobody finishes reading. The explanation lives in the title, where a long string belongs.
 */
function offerCtxTwin(twin) {
  const a = $('ctxtwin');
  if (!a) return;
  a.style.display = twin ? '' : 'none';
  if (!twin) return;
  const img = a.querySelector('img');
  if (img && !img.getAttribute('src')) img.src = img.dataset.src;
  // It uses the answer it asked for. This said «or get it from the Chrome Web Store» and linked
  // there whatever the twin had replied - on the one surface that speaks while a sample is open,
  // which is where the reader is least able to work it out for themselves.
  a.title = `This is a Zoho Analytics tab and this panel reads Zoho CRM only. `
    + (twin.installed
      ? `${twin.product} reads it - click its icon in your toolbar.`
      /* **«No answer» is not «not installed», and this surface used to say it was.** The
         overlay next door already words it honestly; this one sent a reader who has the twin
         to go and buy it - and until both products ship the listening half, every installed
         copy is silent. Two surfaces, one aligned, one not: the twin defect again. */
      : `${twin.product} reads it - open it from your toolbar, or click for the Web Store.`);
  if (twin.installed) a.removeAttribute('href');
  else a.href = `${twin.store}?utm_source=zoost-crm&utm_medium=extension&utm_campaign=twin-tab`;
}
function offerTwin(twin) {
  const grp = $('offtwingrp');
  if (!grp) return;
  grp.style.display = twin ? '' : 'none';
  // **The lead says what is on the screen, and only that.** With the twin's box drawn there are
  // three ways out; without it there are two, and a sentence promising a box that is not there is
  // the same defect this whole screen was built to remove, one layer up.
  $('offtitle').textContent = twin ? `This is a Zoho Analytics tab` : `Not on a Zoho CRM tab`;
  $('offlead').textContent = twin
    ? 'Three ways on: open the other Zoost, go to Zoho CRM, or work in a sample workspace.'
    : 'Two ways on: go to Zoho CRM, or work in a sample workspace.';
  if (!twin) return;
  $('offtwins').textContent = `You are on Zoho Analytics and this panel reads Zoho CRM only. `
    + (twin.installed
      ? `Click the ${twin.product} icon in your toolbar - it reads this tab.`
      /* Never «you do not have it»: nothing here can establish that. An unanswered ask is also what
         an older copy of the twin looks like - which is every installed copy until both products
         ship the listening half. */
      : `${twin.product} reads it: open it from your toolbar if you have it, or get it below.`);
  const link = $('offtwin');
  // Fetched on the first draw that shows it, never on load: a hidden <img src> is still a request,
  // and the endpoint probe caught exactly that.
  const img = link.querySelector('img');
  if (img && !img.getAttribute('src')) img.src = img.dataset.src;
  // **No link where the twin answered.** Nothing can open another extension's panel - measured -
  // so a button reading «Open Zoost Analytics» could only ever go to the Store, next to a sentence
  // telling the reader to click its toolbar icon: two instructions, neither of which opens anything.
  // The explanation above says what to do; the link is for the case where there is nothing to open.
  link.style.display = twin.installed ? 'none' : '';
  link.querySelector('span').textContent = `${twin.product} on the Web Store \u2197`;
  // **One source for the address.** It lived in the markup as an href as well, which was harmless
  // while it was a bare URL and two things to keep in step the moment it gained parameters.
  link.href = `${twin.store}?utm_source=zoost-crm&utm_medium=extension&utm_campaign=twin-tab`;
}


async function refreshContext() {
  const mine = ++contextLoad;
  const current = () => mine === contextLoad;
  const ctxEl = $('ctx'), who = $('who'), bnd = $('bound');
  // **The tab this panel will talk to, which is not necessarily the one in front of you.**
  // `zohoTabId()` is the resolution every Zoho command already goes through - the active tab when it
  // is Zoho, otherwise any Zoho tab in any window - and the guard now asks about *that* tab, because
  // that is the one a command will reach. Asking the active tab instead was a convention and never
  // a guarantee: **the guarantee is at the far end**, where the page refuses a command whose expected
  // org is not its own (`expectedMatches` in the content bridge, which is «the only party in the
  // exchange that cannot be out of date about which org it is»). Nothing here weakens that, and
  // nothing here may.
  //
  // Reported, and the argument is his: the panel was denying a local mirror to somebody standing in
  // the wrong place. A pull is read-only towards Zoho; what has to be protected is the *mirror*, and
  // what protects it is the match - not which window has the focus.
  const activeId = await activeZohoTabId();
  if (!current()) return;
  const zohoId = activeId || await zohoTabId();
  if (!current()) return;
  // **Two independent facts, and they were one for an hour.** «Which tab are you looking at» decides
  // whether the other product's mark is offered; «is there a tab of ours anywhere» decides what is
  // enabled. Collapsing them is what the branch below used to do, and the moment the panel stopped
  // blocking on a foreign tab the twin offer disappeared with the block - reported, and it is the
  // feature that was asked for whole. Somebody standing on a Zoho Analytics tab is looking at Zoho
  // Analytics whether or not a CRM tab is open two windows away, and the extension that reads what
  // they are looking at is the other one.
  const twin = await twinTab();
  if (!current()) return;
  offerCtxTwin(twin);
  if (!zohoId) {                           // no Zoho CRM tab anywhere, not just not in front
    lastCtx = null; $('mmbar').classList.remove('show'); updateWsButtons();
    // **The overlay is for having nothing to read, not for standing in the wrong place.** A mirror
    // is local files: browsing it, searching it, drawing it, exporting it and asking the assistant
    // about it need no tab at all, and covering it because no Zoho tab is open denied the product to
    // somebody who had done nothing wrong. The sample exception already made this argument - «a
    // sample has nothing to say to Zoho, so a Zoho tab is not a precondition for reading it» - and it
    // was true of every pulled mirror the whole time.
    //
    // What is left for the overlay is the case it was written for: a panel with nothing in it, where
    // the three ways on - the other product, Zoho itself, a sample - are the whole content.
    // `sampleBusy` belongs here and not only at the click. This panel re-derives its whole state on
    // a five-second poll, so anything set imperatively on top of that is undone by the next tick -
    // reported as the overlay coming back in the middle of writing the sample and then leaving
    // again. A state that has to hold across time is a term in the condition, never an assignment.
    $('offoverlay').classList.toggle('show', !dir && !sampleBusy);
    // **It says which platform, because the reader may well be on a Zoho tab.** Reported: someone
    // opened this panel from a Zoho Analytics tab and was told «Not on a Zoho tab», which is false
    // about where they were standing and silent about what is needed. The overlay two files away has
    // always said «Not on a Zoho CRM tab» and the guide quotes it that way, so this line was also the
    // odd one out inside its own product. A precondition names the thing it requires.
    // **And when the tab belongs to the twin, say so and say what to do about it.** «Not on a Zoho
    // CRM tab» is true there and useless: it describes what this panel wants and not where the
    // reader is standing, which is how somebody who clicked the wrong icon is left to work it out.
    // The URL was already being read one step earlier and thrown away; `twinTab()` keeps it - and it
    // is asked above now, on every pass, because it answers a question about the tab in front rather
    // than about this branch.
    ctxEl.className = 'offzoho';
    // With a workspace open the panel is *working*, so the line says what is off rather than where
    // the reader is standing: everything local reads, and everything Zoho-bound is disabled until a
    // tab exists. Without one, the old sentence is still the right one - there is nothing else to say.
    who.innerHTML = twin
      ? escHtml(twin.installed ? MSG.twinInstalled(twin) : MSG.twinMissing(twin))
      : (dir ? MSG.noZohoTab : 'Not on a Zoho CRM tab');
    offerTwin(twin);        // the overlay's group, which only exists on this branch
    // **A sample is never presented as a live binding.** Its `.zoho.json` carries an invented org
    // and instance, so this line read «prod «sampleorg» org 1234567890» the moment the reader left a
    // Zoho tab - invented data dressed as production, with the overlay deliberately down and nothing
    // on screen to correct it. The on-platform branch has always said what it is.
    bnd.innerHTML = isSample() ? SAMPLE_CHIP
      : (bound ? `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)}` : '');
    blockZoho(true);
    return;
  }
  $('offoverlay').classList.remove('show');
  await ensureBridge(zohoId);
  if (!current()) return;
  const cfid = await crmFrameId(zohoId);
  if (!current()) return;
  const _t0 = Date.now();
  // A Zoho One tab with no CRM frame in it has nothing to read, and asking would mean naming a frame
  // that is not there. Same answer as a tab that did not reply - no context - and it **falls through**
  // rather than returning: the line below is what puts «Zoho tab (not ready)» on screen, and a return
  // here would leave the previous tab's identity showing. Which is the silent exit this repository
  // refuses, one line from being written by the fix for a different one.
  try {
    const r = await chrome.tabs.sendMessage(zohoId, { cmd: 'context' }, cfid === null ? {} : { frameId: cfid });
    if (!current()) return;
    validateBridgeReply({ cmd: 'context' }, r);
    lastCtx = bridgeContext(r);
  } catch (e) { if (!current()) return; lastCtx = null; _ctxErr = (e && e.message) || String(e); }
  // No instance name: this line is written to be pasted into a chat, and the instance is the
  // customer's own portal. Whether it answered is the whole diagnostic value; who answered is not.
  // `info` and not `debug`: Chrome's console hides the Verbose level by default, so an instrument
  // written with `console.debug` is one the person reproducing the fault cannot see. An instrument
  // nobody can read is not an instrument.
  // The sequence, one line per tick, in the order things happened. «Not ready» is a *state the panel
  // arrives at*, and until now the only record of arriving at it was the words on screen - which say
  // that it happened and nothing about why. Whoever reads this next has the tab, the frames that
  // were there, the frame we asked, and what the answer was.
  console.info(`[zoost] ctx tab=${zohoId}${activeId ? '' : ' (not in front)'} frames=[${crmZohoBridge.seenFrames()}] asked=${cfid === null ? 'any' : cfid}`
    + ` -> ${lastCtx ? 'ok' : 'NOT READY' + (_ctxErr ? ' (' + _ctxErr + ')' : '')}`
    + ` ${Date.now() - _t0}ms`);
  _ctxErr = null;
  // Named and actionable, the way the twin says it: «not ready» on its own tells the reader a state
  // and no way out of it, and reloading that tab is the way out.
  if (!lastCtx) { ctxEl.className = 'offzoho'; who.innerHTML = 'Zoho CRM tab (not ready - reload it)'; bnd.textContent = ''; blockZoho(true); updateWsButtons(); return; }
  // On a sample workspace the tab half is true and irrelevant: the tab really is on that org, and
  // this folder has nothing to do with it. Saying so is better than leaving the two halves side by
  // side implying a relationship - reported as «switching to the test org leaves ZOHO TAB on the
  // previous one», which it does, correctly, and read as a bug because nothing said it did not matter.
  // **And it says when the tab it is reading is not the one you are looking at.** This is the price
  // of the widening and it is paid here rather than skipped: the protection against pulling one org
  // into another workspace's mirror used to rest on the org being in front of the reader's eyes.
  // It rests on the match now - checked by the page itself - so the panel has to *say* which org it
  // has resolved, every time, or the reader has no way to notice that it is not the one on screen.
  // **And when the tab it resolved is neither in front nor the right one, it says that in the
  // reader's terms and not in its own.** Reported, and the argument is his: which tab the panel was
  // opened from is clear to whoever built it and is a technicality to everybody else - for the
  // reader that bond does not exist. Standing on a tab that has nothing to do with Zoho, an amber bar accusing a background
  // tab of being the wrong org is a sentence about a relationship the reader never agreed to. What
  // is true *for them* is that nothing is open for the workspace they are working in, so that is
  // what the line says, and the bar stays down.
  const behindAndWrong = !activeId && !!bound && !isSample() && !guardOk();
  const behind = !activeId ? '<span class="rlbl remote">not in front</span>' : '';
  who.innerHTML = behindAndWrong
    ? escHtml(MSG.noTabForWorkspace(wsShown(bound)))
    : `<span class="rlbl remote">Zoho CRM tab</span><b>${escHtml(lastCtx.instance || '?')}</b> <span>· org ${escHtml(lastCtx.org || '?')} · ${envOf(lastCtx.origin)}${isSample() ? ' · not related to the sample' : ''}</span>${behind}`;
  if (!bound) { ctxEl.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">not bound yet</span>'; }
  else if (guardOk()) { ctxEl.className = 'match'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✓`; }
  else if (isSample()) { ctxEl.className = 'unbound'; bnd.innerHTML = SAMPLE_CHIP; }
  else { ctxEl.className = 'mismatch'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>≠ ${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✗`; }
  // The discrepancy is stated in both cases, and the sample is one of them. Suppressing the bar for
  // it was wrong: reading invented data while looking at a real org is exactly what this bar is for,
  // and one muted line in the workspace half is too quiet to carry it. Reported.
  //
  // What differs is the **blocking**, and only that. A sample is never going to match anything,
  // everything Zoho-bound is already refused for it, and blocking it would make it unusable the
  // whole time a Zoho tab is open - which is always. So: say it, do not stop it.
  //
  // **And a real mismatch no longer closes what is open either.** It used to, on the argument that
  // «browsing until it is resolved would mean reading org A's mirror while looking at org B» - and
  // that argument died the day this panel was told to work with no Zoho tab at all, because that is
  // the same reading with no tab to compare against. The bar's own sentence has been saying so the
  // whole time: «what is already mirrored stays readable». The code was contradicting the message
  // it draws one line above, which is the class this repository refuses ahead of any other.
  //
  // Reported from the panel: a detail pane that vanished while resizing on a mismatched tab - the
  // five-second poll re-deriving the state and closing it, which looks like the layout losing your
  // place rather than like a rule being applied. The Analytics twin never did this.
  const sampleMm = !!(bound && lastCtx && isSample());
  // The loud bar belongs to the tab you are looking at: it offers «switch tab» and «switch
  // workspace», two actions about a thing on screen. Raised over a tab in another window it is an
  // alarm about something the reader is not doing.
  const mm = !!(activeId && bound && lastCtx && !guardOk() && !isSample());
  const mmbar = $('mmbar');
  mmbar.classList.toggle('show', mm || sampleMm);
  mmbar.classList.toggle('soft', sampleMm);
  if (mm || sampleMm) {
  // **The sample is a state the user chose, and it was being announced like an accident.** Three
  // sentences on one screen said the same fact - the status line's «not related to the sample», the
  // workspace chip's «sample - generated, never pulled», and a full paragraph in the bar - and the
  // bar then offered a full-width «Create workspace for ...», which is the control the workspace row
  // already carries and has enabled in exactly this state. One fact three times, one action twice.
  //
  // What the bar alone was carrying is the *reason*: `guardOk()` is false for a sample, so Pull is
  // disabled, and nothing else on screen says why. So it keeps that and loses the rest - one line,
  // no call to action. A real mismatch is unchanged: that one is accidental, it can be resolved, and
  // the two buttons are how.
    $('mmtext').textContent = sampleMm
      ? `Sample workspace - invented data. Pulling is off: nothing here comes from \u00ab${lastCtx.instance || '?'}\u00bb (org ${lastCtx.org}), and nothing here can reach it.`
      : `Zoho tab \u00ab${lastCtx.instance || '?'}\u00bb (org ${lastCtx.org}) \u2260 local workspace \u00ab${wsShown(bound)}\u00bb (org ${bound.org}). Pulling is off until they match; what is already mirrored stays readable.`;
    // «Switch tab» is meaningless for a sample: there is no Zoho org to switch to.
    $('mmgo').style.display = sampleMm ? 'none' : '';
    $('mmgo').textContent = `Switch tab \u2192 \u00ab${wsShown(bound)}\u00bb \u2197`;
    $('mmgo').onclick = () => switchTab();
    const match = (wsList || []).find((w) => w.id !== activeWsId && w.binding && w.binding.org === lastCtx.org && (!w.binding.base || !lastCtx.origin || w.binding.base === lastCtx.origin));
    const sw = $('mmsw'); sw.style.display = sampleMm ? 'none' : '';
    if (match) { sw.textContent = `Switch workspace \u2192 \u00ab${wsShown(match)}\u00bb`; sw.onclick = () => { $('ws').value = match.id; activate(match, true); }; }
    else { sw.textContent = `Create workspace for \u00ab${lastCtx.instance || '?'}\u00bb`; sw.onclick = () => addWorkspaceForTab(); }
  }
  // inhibit all Zoho-bound operations unless the active tab matches the workspace (tab-navigation stays allowed)
  blockZoho(!zohoReady());
  blockZoho(pullBusy || !zohoReady() || !dir || navOpenNow());   // a pull in progress - or the history view - keeps them blocked even as the 5s refresh runs
  updateWsButtons();
}
function guardOk() {
  // Everything Zoho-bound funnels through here, so this is the one place a sample workspace has to
  // be refused - rather than a condition repeated at each button, where one of them is eventually
  // forgotten. It is not a mismatch, though, and refreshContext keeps the two apart: the mismatch
  // bar and its overlay are for two environments that could match, and this one never will.
  if (isSample()) return false;
  // A workspace with no binding yet is creating its first one, and there is nothing to compare
  // against. A workspace that *is* bound and has no context is a different statement: it means the
  // destination has not been verified, and returning true there let a command go to whatever Zoho
  // tab `zohoTabId()` happened to find. «Do what you're certain of, or stop.»
  if (!bound) return true;
  if (!lastCtx) return false;
  if (bound.org !== lastCtx.org) return false;                                   // different org
  if ((bound.base || '') !== (lastCtx.origin || '')) return false;               // different host/env
  if (bound.instance && lastCtx.instance && bound.instance !== lastCtx.instance) return false; // different specific (sandbox) instance
  return true;
}
