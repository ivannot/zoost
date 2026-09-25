// **The toolbar icon opens Zoost's own window.** It opened a side panel until now, and the panel
// is gone: Chrome caps a side panel at two thirds of its window
// (`kMaxContentsHeightSidePanelFraction = 2/3`), it cannot leave that window, and it therefore
// cannot go on a second monitor - which is how this product is actually used, Zoho on one screen
// and Zoost on the other. A window is resizable, movable and has none of those limits, and the
// `sidePanel` permission leaves the manifest with it: a permission that goes away is silent for
// everybody who has the extension, and one fewer thing to justify on the listing.
//
// **One window, and the browser is the authority on whether it is still there.** The id is a note,
// not a claim: `windows.update` on a window that has been closed rejects, and that rejection is the
// answer - which is worth more than a flag in storage that can outlive what it describes.
async function openWindow() {
  try {
    const { zoostWindowId } = await chrome.storage.session.get('zoostWindowId');
    if (zoostWindowId != null) {
      // `focused` alone: `drawAttention` is documented as drawing the eye *without* changing the
      // focused window, so passing both is two instructions that contradict each other.
      await chrome.windows.update(zoostWindowId, { focused: true });
      return;
    }
  } catch (_) { /* it is gone; fall through and make one */ }
  let bounds = null;
  try { ({ zoostWindowBounds: bounds } = await chrome.storage.local.get('zoostWindowBounds')); } catch (_) {}
  // Where it is *not* placed on a first run: over the page you are reading. The service worker has
  // no idea how big the screen is - `chrome.system.display` would say, and it is a new permission
  // for a cosmetic fact - so the window is created at a readable size and **places itself** once it
  // is open, from `screen.availWidth`, which its own document can read for nothing.
  // **A popup: no tab strip, no address bar.** It was briefly a normal window on a diagnosis of
  // mine that turned out to be wrong - the folder grant did nothing on the first run of this
  // window, and I read that as «a popup has no tab, so `requestPermission()` has nowhere to ask».
  // The source I leaned on was about the *action popup*, which is a different surface, and the
  // measurement says otherwise: the folder prompt appears here exactly as it did in the panel.
  // Written down because the wrong reason was more confident than the right one, and the only
  // thing that separated them was asking the browser instead of the search results.
  const create = bounds && bounds.width
    ? { url: 'workbench.html', type: 'popup', focused: true,
        left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
    : { url: 'workbench.html', type: 'popup', focused: true, width: 1200, height: 900 };
  const win = await chrome.windows.create(create);
  try { await chrome.storage.session.set({ zoostWindowId: win.id }); } catch (_) {}
}
chrome.action.onClicked.addListener(() => { void openWindow(); });
// Where the reader leaves it is where it comes back. Saved from the browser's own event rather than
// from a resize handler in the page, because a window is moved as often as it is resized and only
// one of those reaches the document.
chrome.windows.onBoundsChanged.addListener((win) => { void rememberBounds(win); });
async function rememberBounds(win) {
  try {
    const { zoostWindowId } = await chrome.storage.session.get('zoostWindowId');
    if (win.id !== zoostWindowId) return;
    await chrome.storage.local.set({ zoostWindowBounds: { left: win.left, top: win.top, width: win.width, height: win.height } });
  } catch (_) {}
}
// And forgotten when it closes, so the next click makes one instead of trying to raise a ghost.
chrome.windows.onRemoved.addListener((id) => { void forgetWindow(id); });
async function forgetWindow(id) {
  try {
    const { zoostWindowId } = await chrome.storage.session.get('zoostWindowId');
    if (id === zoostWindowId) await chrome.storage.session.remove('zoostWindowId');
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
  if (msg && msg.zoost === 'present?') { reply({ product: 'Zoost CRM' }); return true; }
  return false;
});
