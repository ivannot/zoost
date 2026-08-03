// Apre il side panel quando clicchi l'icona della toolbar.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[zoost] setPanelBehavior:', e));
