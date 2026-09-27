// @ts-check
/* Reaching Zoho Analytics from the workbench: which addresses are ours, and where one opens.
 *
 * **Extracted from `workbench.js` on 27 September 2026, and not because that file is long.** The
 * churn was measured first: over four months the functions that moved most in it were `toBridge`,
 * `tabWorkspace`, `refreshContext`, `offerTwin`, `isZohoUrl` and `goToZoho` - a navigation and
 * context cluster, not a spread. And the twin already had this module: `apps/crm/zoho-navigation.js`
 * holds the CRM's URL builders and a navigator built from explicit options, while this side kept
 * the same logic inline, reading the panel's globals. So the split follows a sibling rather than
 * inventing a boundary, which is the one argument this repository accepts for a split.
 *
 * What it buys, concretely: every one of these decisions can now be exercised without a panel -
 * an address on a look-alike host, a modifier key, a tab that is already open - and a change to
 * how «Go to» behaves stops touching the file that also owns the views, the pulls and the exports.
 *
 * What it deliberately does **not** take: anything that writes panel state. The navigator reads a
 * manifest, is handed a `chrome`, and says what it did. `status()` reaches it as `refused`, one
 * callback, because a module that calls the panel's status line is the panel with extra steps.
 */

/** @typedef {{hostPatterns: string[], chromeApi: any, refused: (url: string) => void}} AnalyticsNavigatorOptions */

/** @param {AnalyticsNavigatorOptions} options */
function createAnalyticsZohoNavigator(options) {
  // The application's own hosts, exactly, out of `host_permissions` - not a prefix. A prefix test
  // lets `https://analytics.zoho.eu.evil.com/` through, which is the whole point of the check.
  const allowedHosts = new Set((options.hostPatterns || [])
    .filter((h) => /^https:\/\/analytics\./.test(h))
    .map((h) => { try { return new URL(h.replace(/\*$/, '')).host; } catch (_) { return null; } })
    .filter(Boolean));

  /** @param {string} url */
  function allowed(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && allowedHosts.has(u.host);
    } catch (_) { return false; }
  }

  /** Where the reader asked for it to open, from the modifiers the whole web already teaches.
   *
   *  Word for word the twin's: Ctrl or Cmd is a new tab in the background, Shift is a new window
   *  that comes forward. Nothing to learn, and the context menu is left alone - which a right-click
   *  override would not be. It matters since Zoost left the side panel: on two screens, «open this
   *  in a second Zoho window» is a thing somebody actually wants.
   */
  function howFrom(ev) {
    if (!ev) return null;
    if (ev.shiftKey) return 'window';
    return (ev.ctrlKey || ev.metaKey) ? 'tab' : null;
  }

  async function openElsewhere(url, how) {
    if (how === 'window') { await options.chromeApi.windows.create({ url, focused: true }); return true; }
    await options.chromeApi.tabs.create({ url, active: false });
    return true;
  }

  async function focusTab(tabId, props) {
    const tab = await options.chromeApi.tabs.update(tabId, props);
    try {
      if (tab && tab.windowId != null) await options.chromeApi.windows.update(tab.windowId, { focused: true });
    } catch (_) { /* the window refused focus; the tab is still the current one in it */ }
    return tab;
  }

  /** @param {string} url @param {string|null} [how] */
  async function open(url, how) {
    if (!allowed(url)) { options.refused(url); return null; }
    // A modifier means «not here», so the tab-reuse below is skipped: asking for a new window is
    // not asking to navigate the one you have. The host check above still runs first.
    if (how) return await openElsewhere(url, how) ? true : null;
    // **A tab of its own, unless that page is already open** - see the twin, which met this first.
    // It navigated the Analytics tab the reader already had, which was right while Zoost lived
    // inside the browser window and is not from a window of its own: the tab it takes over is one
    // of the reader's others, and «Go to» on a view they are half-way through editing threw the
    // edit away. What is given up is the suite shell, and that is the smaller loss - a shell to
    // come back to costs a click. Already open is focused rather than opened twice, the way every
    // outward link in this panel is; a lookup that cannot answer still gets its tab.
    let already = [];
    try { already = await options.chromeApi.tabs.query({ url: new URL(url).href }); } catch (_) { already = []; }
    if (already && already[0]) { await focusTab(already[0].id, { active: true }); return already[0].id; }
    const tab = await options.chromeApi.tabs.create({ url, active: true });
    try {
      if (tab && tab.windowId != null) await options.chromeApi.windows.update(tab.windowId, { focused: true });
    } catch (_) { /* the window refused focus; the tab is open either way */ }
    return tab.id;
  }

  return { allowed, howFrom, openElsewhere, focusTab, open };
}
