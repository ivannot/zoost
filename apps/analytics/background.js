// Opens the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[zoost/analytics] setPanelBehavior:', e));

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
