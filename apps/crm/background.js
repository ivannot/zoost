// Opens the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[zoost] setPanelBehavior:', e));

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

