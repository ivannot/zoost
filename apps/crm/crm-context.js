// CRM context bar and Zoho-tab guard.
// ---------- context bar + off-zoho overlay ----------
let contextLoad = 0;
let _ctxErr = null;
/** What the overlay says when the tab is simply not ours - read from the markup, never copied.
 *  A second copy of a sentence is how «Not on a Zoho tab» survived in the guides after the panel had
 *  stopped saying it, and it is the defect this change exists to remove: one sentence, one place. */
const OFF_TITLE = (document.querySelector('#offoverlay .t') || {}).textContent || '';
const OFF_SUB = (document.querySelector('#offoverlay .s') || {}).textContent || '';
/** The overlay is the same state, said larger. It exists in the markup, so nothing rewrites it
 *  unless something does - and the state that reads «Not on a Zoho CRM tab» in the line above used
 *  to read it here too, unchanged, whatever the tab actually was. Two surfaces, one sentence.
 *
 *  The Store link is the half that needs no permission and no API at all: where the twin does not
 *  answer, the reader gets the page that installs it; where it does, the button would be selling
 *  them what they have, so it is not drawn. Nothing here can open the other panel - Chrome refuses
 *  it, in as many words, and that was measured rather than assumed. */
function offerTwin(twin) {
  const t = document.querySelector('#offoverlay .t');
  const s = document.querySelector('#offoverlay .s');
  const link = $('offtwin');
  if (!t || !s || !link) return;
  if (!twin) {
    t.textContent = OFF_TITLE; s.textContent = OFF_SUB; link.style.display = 'none'; return;
  }
  t.textContent = `This is a ${twin.name} tab`;
  s.textContent = twin.installed
    ? `${twin.product} reads ${twin.name}. Open it from the toolbar - Chrome does not let one extension open another.`
    : `${twin.product} reads ${twin.name}. This panel reads Zoho CRM only.`;
  link.textContent = twin.installed ? '' : `Get ${twin.product} \u2197`;
  link.href = twin.store;
  link.style.display = twin.installed ? 'none' : '';
}
async function refreshContext() {
  const mine = ++contextLoad;
  const current = () => mine === contextLoad;
  const ctxEl = $('ctx'), who = $('who'), bnd = $('bound');
  const activeId = await activeZohoTabId();
  if (!current()) return;
  if (!activeId) {                         // the ACTIVE tab is not Zoho
    lastCtx = null; $('mmbar').classList.remove('show'); updateWsButtons();
    // Not over a sample. A sample has nothing to say to Zoho, so a Zoho tab is not a precondition
    // for reading it - and covering the panel there would mean the one workspace anybody can open
    // without an account is the one you cannot open without one. Reported.
    // `sampleBusy` belongs here and not only at the click. This panel re-derives its whole state on
    // a five-second poll, so anything set imperatively on top of that is undone by the next tick -
    // reported as the overlay coming back in the middle of writing the sample and then leaving
    // again. A state that has to hold across time is a term in the condition, never an assignment.
    $('offoverlay').classList.toggle('show', !isSample() && !sampleBusy);
    // **It says which platform, because the reader may well be on a Zoho tab.** Reported: someone
    // opened this panel from a Zoho Analytics tab and was told «Not on a Zoho tab», which is false
    // about where they were standing and silent about what is needed. The overlay two files away has
    // always said «Not on a Zoho CRM tab» and the guide quotes it that way, so this line was also the
    // odd one out inside its own product. A precondition names the thing it requires.
    // **And when the tab belongs to the twin, say so and say what to do about it.** «Not on a Zoho
    // CRM tab» is true there and useless: it describes what this panel wants and not where the
    // reader is standing, which is how somebody who clicked the wrong icon is left to work it out.
    // The URL was already being read one step earlier and thrown away; `twinTab()` keeps it.
    const twin = await twinTab();
    if (!current()) return;
    ctxEl.className = 'offzoho';
    who.innerHTML = twin
      ? escHtml(twin.installed ? MSG.twinInstalled(twin) : MSG.twinMissing(twin))
      : 'Not on a Zoho CRM tab';
    offerTwin(twin);
    bnd.innerHTML = bound ? `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)}` : '';
    blockZoho(true);
    return;
  }
  $('offoverlay').classList.remove('show');
  await ensureBridge(activeId);
  if (!current()) return;
  const cfid = await crmFrameId(activeId);
  if (!current()) return;
  const _t0 = Date.now();
  // A Zoho One tab with no CRM frame in it has nothing to read, and asking would mean naming a frame
  // that is not there. Same answer as a tab that did not reply - no context - and it **falls through**
  // rather than returning: the line below is what puts «Zoho tab (not ready)» on screen, and a return
  // here would leave the previous tab's identity showing. Which is the silent exit this repository
  // refuses, one line from being written by the fix for a different one.
  try {
    const r = await chrome.tabs.sendMessage(activeId, { cmd: 'context' }, cfid === null ? {} : { frameId: cfid });
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
  console.info(`[zoost] ctx tab=${activeId} frames=[${crmZohoBridge.seenFrames()}] asked=${cfid === null ? 'any' : cfid}`
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
  who.innerHTML = `<span class="rlbl remote">Zoho CRM tab</span><b>${escHtml(lastCtx.instance || '?')}</b> <span>· org ${escHtml(lastCtx.org || '?')} · ${envOf(lastCtx.origin)}${isSample() ? ' · not related to the sample' : ''}</span>`;
  if (!bound) { ctxEl.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">not bound yet</span>'; }
  else if (guardOk()) { ctxEl.className = 'match'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✓`; }
  else if (isSample()) { ctxEl.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">sample - generated, never pulled</span>'; }
  else { ctxEl.className = 'mismatch'; bnd.innerHTML = `<span class="rlbl local">Workspace</span>≠ ${envOf(bound.base)} «${escHtml(bound.instance || '?')}» org ${escHtml(bound.org)} ✗`; }
  // The discrepancy is stated in both cases, and the sample is one of them. Suppressing the bar for
  // it was wrong: reading invented data while looking at a real org is exactly what this bar is for,
  // and one muted line in the workspace half is too quiet to carry it. Reported.
  //
  // What differs is the **blocking**, and only that. A real mismatch can be resolved - one of the
  // two is wrong - and browsing until it is would mean reading org A's mirror while looking at org
  // B. A sample is never going to match anything, everything Zoho-bound is already refused for it,
  // and blocking it would make it unusable the whole time a Zoho tab is open - which is always.
  // So: say it, do not stop it.
  const sampleMm = !!(bound && lastCtx && isSample());
  const mm = !!(bound && lastCtx && !guardOk() && !isSample());
  const mmbar = $('mmbar');
  mmbar.classList.toggle('show', mm || sampleMm);
  mmbar.classList.toggle('soft', sampleMm);
  if (mm) { $('preview').classList.remove('show'); $('resizer').classList.remove('show'); }
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
