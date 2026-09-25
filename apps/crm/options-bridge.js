/** Hand the reader from Chrome's own «Options» entry to the settings view in the Zoost window.
 *
 *  The service worker owns the window - it is the only thing that can raise one that already exists
 *  rather than opening a second - so the ask goes there, and this page closes behind it. A tab
 *  cannot always close itself (Chrome refuses when the tab was not opened by script), so the failure
 *  is answered with a sentence rather than left as a blank page.
 */
async function handOver() {
  try {
    await chrome.runtime.sendMessage({ zoost: 'open', view: 'settings' });
    window.close();
    // Still here a moment later means the close was refused, which is a thing Chrome does and not
    // an error: say what happened instead of leaving «Opening…» on screen for ever.
    setTimeout(() => {
      const m = document.getElementById('msg');
      if (m) m.textContent = 'Zoost is open on its settings - you can close this tab.';
    }, 400);
  } catch (e) {
    const m = document.getElementById('msg');
    if (m) m.textContent = 'Could not open Zoost: ' + (e && e.message ? e.message : e);
  }
}
void handOver();
