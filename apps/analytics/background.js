// **The toolbar icon opens Zoost's own window.** It opened a side panel until now, and the panel
// is gone: Chrome caps a side panel at two thirds of its window
// (`kMaxContentsHeightSidePanelFraction = 2/3`), it cannot leave that window, and it therefore
// cannot go on a second monitor - which is how this product is actually used, Zoho on one screen
// and Zoost on the other. A window is resizable, movable and has none of those limits, and the
// `sidePanel` permission leaves the manifest with it: a permission that goes away is silent for
// everybody who has the extension, and one fewer thing to justify on the listing.
//
// **One window, and the browser is the authority on whether it is still there.** The id in storage
// is a note and not a claim, so it is checked against `windows.get` rather than against a flag that
// can outlive what it describes.
//
// **`windows.update` rejecting is not the window being gone, and reading it that way makes a second
// one.** The first version of this had one `try` around the storage read and the raise together, and
// a comment saying «it is gone; fall through and make one» - true of one of the two reasons that
// block can fail and false of every other, minimising and a transient refusal included. `windows.get`
// answers the question that was actually being asked, and a raise that fails leaves the window that
// exists alone: failing to bring a window forward is a nuisance, and opening a duplicate on top of
// it is a second copy of the product writing into the same mirror folder.
let opening = null;
/** One at a time. Between reading the id and storing a new one sits the whole of `windows.create`,
 *  and two clicks inside that gap both read «no window» and both make one - which is not a rare
 *  race but the ordinary impulse: the window takes a beat to appear, so the second click is the
 *  reflex of somebody who thinks the first did nothing. The loser of the race joins the winner
 *  instead of starting again, so the icon still answers every click. */
function openWindow() {
  // **It resolves to whether a window had to be built, and it rejects when none could be.**
  // `reportOpenFailure` used to swallow the error, so every caller was told the window had opened -
  // including the hand-over from Chrome's Options entry, which then closed its own tab over a window
  // that was not there and left the sentence written for that case unreachable.
  if (!opening) opening = openOnce().finally(() => { opening = null; });
  return opening;
}
/** Named declarations, not arrows in a `.then()`: `tools/asynccheck.py` reads declarations, and a
 *  scope it cannot enter is a scope nobody is checking for a global written after an await. */
async function openOnce() {
  let built;
  try { built = await raiseOrOpen(); } catch (e) { await reportOpenFailure(e); throw e; }
  await clearOpenFailure();
  return built;
}
async function raiseOrOpen() {
  const win = await existingWindow();
  if (win) {
    // Restoring is part of raising when it is minimised, and `state` is only sent then: passing
    // `normal` unconditionally would un-maximise a window the reader had maximised on purpose.
    try {
      await chrome.windows.update(win.id, win.state === 'minimized'
        ? { focused: true, state: 'normal' } : { focused: true });
    } catch (_) { /* it is there and it would not come forward - never a reason to open a second */ }
    return;
  }
  // Where it is *not* placed on a first run: over the page you are reading. The service worker has
  // no idea how big the screen is - `chrome.system.display` would say, and it is a new permission
  // for a cosmetic fact - so the window is created at a readable size and **places itself** once it
  // is open, from `screen.availWidth`, which its own document can read for nothing. The same
  // document is what rescues a window whose remembered place is no longer on any screen.
  // **A popup: no tab strip, no address bar.** It was briefly a normal window on a diagnosis of
  // mine that turned out to be wrong - the folder grant did nothing on the first run of this
  // window, and I read that as «a popup has no tab, so `requestPermission()` has nowhere to ask».
  // The source I leaned on was about the *action popup*, which is a different surface, and the
  // measurement says otherwise: the folder prompt appears here exactly as it did in the panel.
  // Written down because the wrong reason was more confident than the right one, and the only
  // thing that separated them was asking the browser instead of the search results.
  const bounds = await rememberedBounds();
  const bare = { url: 'workbench.html', type: 'popup', focused: true };
  const plain = { ...bare, width: 1200, height: 900 };
  // A maximised window is re-created maximised and not at the rectangle maximising gave it: Chrome
  // refuses `state` together with a rectangle, and the two are alternatives rather than a pair.
  //
  // **Which is why this branch spreads `bare` and not `plain`.** It spread `plain`, so it handed
  // Chrome `state:'maximized'` *and* the 1200x900 default in the same call - the exact pair the
  // sentence above forbids - and `windows.create` rejected every single time. The fallback then
  // opened a plain window and deleted the remembered place as collateral, so maximising once and
  // closing was enough to lose it. Invisible because the icon still opened something.
  const placed = !bounds ? plain
    : bounds.state === 'maximized' ? { ...bare, state: 'maximized' }
      : { ...bare, left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
  let made;
  try {
    made = await chrome.windows.create(placed);
  } catch (e) {
    // **The one entry point the whole product has, so it may not fail in silence.** A remembered
    // place Chrome will not accept is re-read on every click, so without this the icon is dead for
    // ever and nothing anywhere says why. The place is what was refused: drop it and open plainly.
    if (placed === plain) throw e;
    try { await chrome.storage.local.remove('zoostWindowBounds'); } catch (_) {}
    made = await chrome.windows.create(plain);
  }
  try { await chrome.storage.session.set({ zoostWindowId: made.id }); } catch (_) {}
  return true;                   // built, so whoever asked may leave it a note
}
/** Our window, or `null` - and `null` only when the browser says the id names nothing. */
async function existingWindow() {
  let id = null;
  try { ({ zoostWindowId: id } = await chrome.storage.session.get('zoostWindowId')); } catch (_) { return null; }
  if (id == null) return null;
  try { return await chrome.windows.get(id); } catch (_) { return null; }
}
async function rememberedBounds() {
  try {
    const { zoostWindowBounds: b } = await chrome.storage.local.get('zoostWindowBounds');
    if (!b) return null;
    return b.state === 'maximized' || (b.width > 0 && b.height > 0) ? b : null;
  } catch (_) { return null; }
}
/** The badge is cleared by the click that works, or a refusal that is over would sit on the icon
 *  for the life of the profile. */
async function clearOpenFailure() {
  try {
    await chrome.action.setBadgeText({ text: '' });
    // **Back to the manifest's title, not to nothing.** `setTitle({title: ''})` does not restore
    // `default_title`, it replaces it - so the first successful click of a profile's life took the
    // product's name off the toolbar tooltip and never gave it back.
    await chrome.action.setTitle({ title: chrome.runtime.getManifest().action?.default_title || chrome.runtime.getManifest().name });
  } catch (_) {}
}
/** Both halves of «it did nothing»: the badge is what a reader sees, the log is what they can send.
 *  A click that cannot be answered says so on the icon it was aimed at. */
async function reportOpenFailure(e) {
  console.error('Zoost: the window would not open', e);
  try {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    await chrome.action.setTitle({ title: `Zoost could not open its window: ${e && e.message ? e.message : e}` });
  } catch (_) {}
}
chrome.action.onClicked.addListener(() => { void openWindow(); });

/** The one ask this worker answers from a page: «open Zoost, on this view».
 *
 *  `options.html` is the page Chrome's own «Options» entry points at, and all it does is send this.
 *  The worker is the only party that can *raise* a window that already exists instead of opening a
 *  second one, which is why the ask comes here rather than the page trying it for itself.
 *
 *  The view is left in session storage as well as announced, because a window that has just been
 *  created is not listening yet - the message would arrive before its scripts had run. The panel
 *  reads the note on load and clears it; an already-open panel hears the announcement instead. Both
 *  halves, because either one alone is wrong on one of the two paths.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.zoost !== 'open') return undefined;
  void answerOpenAsk(msg, sendResponse);
  return true;                 // the answer comes later
});
/** Named, and at this file's top level: `tools/asynccheck.py` reads declarations, and an inline
 *  `async () => {}` is a scope nothing looks inside - so a global written after an await in there
 *  is a global nobody is checking. */
async function answerOpenAsk(msg, sendResponse) {
  try {
    // **The note is only for a window that does not exist yet.** It used to be written on every
    // ask: a window already open hears the message instead, so nothing ever consumed the note and
    // it sat in session storage until the *next* plain click on the toolbar icon, which then opened
    // straight into Settings for no reason the reader could see. One wrong open per visit to
    // Chrome's Options entry, which is exactly the shape that reads as «random».
    const built = await openWindow();
    if (msg.view) {
      if (built) await chrome.storage.session.set({ zoostPendingView: msg.view });
      else { try { await chrome.runtime.sendMessage({ zoost: 'view', view: msg.view }); } catch (_) { /* it went while we asked; the next open has no note and that is right */ } }
    }
    sendResponse({ ok: true });
  } catch (e) { sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }); }
}
// Where the reader leaves it is where it comes back. Saved from the browser's own event rather than
// from a resize handler in the page, because a window is moved as often as it is resized and only
// one of those reaches the document.
chrome.windows.onBoundsChanged.addListener((win) => { void rememberBounds(win); });
async function rememberBounds(win) {
  try {
    const { zoostWindowId } = await chrome.storage.session.get('zoostWindowId');
    if (win.id !== zoostWindowId) return;
    // **Only a window sitting where the reader put it says where the reader put it.** This event
    // fires for a change of state as well as for a drag, and a minimised window's rectangle is not
    // a place on a screen - remembering one and handing it back to `windows.create` is how the
    // toolbar icon would come to open a window nobody can see. Maximised is remembered as a state,
    // which is what it is, and the normal rectangle underneath it stays whatever it last was.
    if (win.state === 'minimized') return;
    if (win.state === 'maximized') {
      const { zoostWindowBounds: had } = await chrome.storage.local.get('zoostWindowBounds');
      await chrome.storage.local.set({ zoostWindowBounds: Object.assign({}, had, { state: 'maximized' }) });
      return;
    }
    await chrome.storage.local.set({
      zoostWindowBounds: { left: win.left, top: win.top, width: win.width, height: win.height, state: 'normal' },
    });
  } catch (_) {}
}
// And forgotten when it closes, so the next click makes one instead of trying to raise a ghost.
chrome.windows.onRemoved.addListener((id) => { void forgetWindow(id); });
async function forgetWindow(id) {
  try {
    // Read, then read again: this runs for *every* window the browser closes, and between the two
    // steps `raiseOrOpen` may have stored a brand new id. Erasing that one leaves the live window
    // unowned, and the next click makes a second Zoost on the same mirror folder. The class is the
    // one CLAUDE.md enumerates - global state written after an await - and the guard is the re-read.
    const { zoostWindowId } = await chrome.storage.session.get('zoostWindowId');
    if (id !== zoostWindowId) return;
    const { zoostWindowId: still } = await chrome.storage.session.get('zoostWindowId');
    if (id === still) await chrome.storage.session.remove('zoostWindowId');
  } catch (_) {}
}

// The two saved search patterns everyone starts with. Seeded once, and only when the key has never
// existed: an emptied list stays empty, or the presets would be undeletable. The options page and
// the panel menu's Save row write later ones; this is the one writer of the initial state.
// A declaration, byte-identical in both apps' backgrounds: a test holds the twins to the same seed.
function rxDefaults() {
  return [
    { name: 'Email address', pattern: '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}' },
    // No documented format exists: Zoho's own community puts CRM record ids at 18 digits
    // (Creator at 19), and the bound keeps ordinary numbers out of the matches.
    { name: 'Zoho ID', pattern: '\\b\\d{18}\\b' },
  ];
}
// Named, and passed by reference. Every async scope shipped here is a function declaration - it is
// the only shape `tools/asynccheck.py` can enter, so an arrow is a scope nothing looks inside.
async function seedShortcuts() {
  try {
    const st = await chrome.storage.local.get('rxShortcuts');
    if (st.rxShortcuts === undefined) await chrome.storage.local.set({ rxShortcuts: rxDefaults() });
  } catch (_) {}
}
chrome.runtime.onInstalled.addListener(seedShortcuts);

// **«I am here.»** The other product's panel asks this when it finds itself looking at a tab that
// belongs to us, so that it can say «open it from the toolbar» instead of selling something already
// installed. Measured before it was written: a message does cross between extensions, and a user
// gesture does not - so answering is all that can be done, and opening the panel from here is not
// (`sidePanel.open() may only be called in response to a user gesture`).
//
// `externally_connectable.ids` in the manifest names exactly one sender, so this listener cannot be
// reached by a page or by anybody else's extension. It reads nothing and returns one word.
chrome.runtime.onMessageExternal.addListener((msg, _sender, reply) => {
  if (msg && msg.zoost === 'present?') { reply({ product: 'Zoost Analytics' }); return true; }
  return false;
});
