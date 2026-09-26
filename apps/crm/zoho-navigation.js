// @ts-check
/* Constructed Zoho CRM destinations and the only adapter that opens them.
 *
 * Workspace files are untrusted input. A destination is accepted only when its complete host is in
 * the manifest-derived allow-list; navigation inside a suite shell targets the CRM frame already
 * selected by the bridge adapter and falls back to the tab when Chrome refuses that frame.
 */

/** @typedef {{base?: string|null, instance?: string|null}} CrmNavigationContext */
/** @typedef {{kind?: string, id?: string|number, template?: {id?: string|number}}} CrmActionTarget */
/** @typedef {{
 * chromeApi: any,
 * hostPatterns: string[],
 * findTab: () => Promise<number|null>,
 * refused: (url: string) => void,
 * }} CrmNavigatorOptions */

const CRM_ACTION_PATH = {
  email_notifications: 'alerts',
  field_updates: 'field-updates',
  tasks: 'tasks',
  webhooks: 'webhooks',
};

/** Where each tab's subject lives in Zoho's own settings.
 *
 *  The panel offered this for functions and for nothing else, so every other tab was a list you
 *  could read here and had to find by hand over there. Reported with the six addresses, which is
 *  what these are - Zoho's own paths, not a guess: a tab with no row is simply not offered the
 *  control rather than being sent somewhere plausible. `functions` keeps its own builder below
 *  because it lands on a sub-page, `myFunctions`, that none of the others has. */
const CRM_TAB_PATH = {
  modules: 'modules',
  workflows: 'workflow-rules',
  schedules: 'schedules',
  actions: 'alerts',
  connections: 'connections',
  blueprints: 'blueprint',
};

/** @param {CrmNavigationContext} context @param {string} tab */
function crmTabUrl(context, tab) {
  const path = CRM_TAB_PATH[String(tab)];
  return context.base && context.instance && path
    ? `${context.base}/crm/${context.instance}/settings/${path}` : null;
}

/** @param {CrmNavigationContext} context */
function crmFunctionsUrl(context) {
  return context.base && context.instance
    ? `${context.base}/crm/${context.instance}/settings/functions/myFunctions` : null;
}

/** @param {CrmNavigationContext} context @param {unknown} uiId */
function crmFunctionUrl(context, uiId) {
  return context.base && context.instance && uiId
    ? `${context.base}/crm/${context.instance}/settings/functions?functionId=${encodeURIComponent(String(uiId))}&tab=overview`
    : null;
}

/** @param {CrmNavigationContext} context @param {CrmActionTarget|null|undefined} action */
function crmActionUrl(context, action) {
  const segment = action && CRM_ACTION_PATH[action.kind || ''];
  return context.base && context.instance && segment && action && action.id
    ? `${context.base}/crm/${context.instance}/settings/${segment}/${action.id}` : null;
}

/** @param {CrmNavigationContext} context @param {CrmActionTarget|null|undefined} action */
function crmTemplateUrl(context, action) {
  const id = action && action.template && action.template.id;
  return context.base && context.instance && id
    ? `${context.base}/crm/${context.instance}/settings/templates?type=email&templateId=${encodeURIComponent(String(id))}`
    : null;
}

/** @param {CrmNavigationContext} context @param {unknown} moduleName */
function crmModuleUrl(context, moduleName) {
  return context.base && context.instance && moduleName
    ? `${context.base}/crm/${context.instance}/tab/${moduleName}` : null;
}

/** @param {CrmNavigationContext} context @param {unknown} moduleName @param {unknown} layoutId */
function crmLayoutUrl(context, moduleName, layoutId = null) {
  if (!context.base || !context.instance || !moduleName) return null;
  const base = `${context.base}/crm/${context.instance}/settings/modules/${moduleName}/layouts`;
  return layoutId ? `${base}/${layoutId}` : base;
}

/** @param {unknown} dataCentre */
function crmHomeUrl(dataCentre) {
  return `https://crm.${String(dataCentre || '')}/crm/ShowHomePage.do`;
}

/** @param {CrmNavigatorOptions} options */
function createCrmZohoNavigator(options) {
  const allowedHosts = new Set(options.hostPatterns.map((pattern) => {
    try { return new URL(pattern.replace(/\*$/, '')).host; } catch (_) { return null; }
  }).filter(Boolean));

  /** @param {unknown} value */
  function allows(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' && allowedHosts.has(url.host);
    } catch (_) { return false; }
  }


  /** The same address, on the shell the reader is actually standing in.
   *
   *  **Measured, not guessed.** Inside Zoho One the tab carries the suite's own path - the portal,
   *  the space, several segments none of which mean anything here - and then, at the end,
   *  `/crm/<instance>/tab/Contacts/<id>`; the direct page is
   *  `https://crm.zoho.eu/crm/<instance>/tab/Contacts/<id>`. Five real addresses, and the tail after
   *  `/crm/<instance>/` is **identical** in both. So there is nothing
   *  to construct: the part before it is a prefix, and the prefix is read off the tab the reader has
   *  open rather than assembled from anything this file claims to know about Zoho One.
   *
   *  That is what makes it safe for a shape nobody here has seen. `<space>` is a name that portal
   *  chose; CRM Plus is a different shell again. None of it is written down here - if the tab the
   *  reader is on does not carry `/crm/<instance>/`, nothing is rebuilt and the direct address is
   *  used, which is «certain, or stop» rather than a pattern that half-fits.
   *
   *  A plain CRM tab takes the same road and comes out unchanged: its prefix *is* the origin.
   */
  async function onTheSameShell(url) {
    try {
      const tail = url.match(/^https:\/\/[^/]+(\/crm\/[^/]+\/)/);
      if (!tail) return url;
      const tabId = await options.findTab();
      if (!tabId) return url;
      const tab = await options.chromeApi.tabs.get(tabId);
      const here = (tab && tab.url) || '';
      // The instance has to be in it too: the prefix of *another* org's shell would send the reader
      // somewhere that looks right and is not.
      const at = here.indexOf(tail[1]);
      if (at <= 0) return url;
      const built = here.slice(0, at) + url.slice(url.indexOf(tail[1]));
      // The host check again, on what was built rather than on what was asked for.
      return allows(built) ? built : url;
    } catch (_) { return url; }
  }

  /** Take the reader to a URL inside Zoho: **a tab of its own, unless that page is already open.**
   *
   * It navigated the Zoho tab the reader already had. That was the right default while Zoost lived
   * inside the browser window - the tab beside the panel was the one being worked in, and going
   * somewhere in it was the whole gesture. From a window of its own it is not: the tab it takes over
   * is one of the reader's other tabs, and «Go to» on a function they are half-way through editing
   * in Zoho's own editor threw the edit away. Asked for in those words, and it is the same
   * correction the workspace switch got earlier - an action that cannot be undone does not get to
   * assume which tab it may have.
   *
   * Already open is focused rather than opened twice, which is what `openExternal` does for every
   * outward link in this panel: the same idiom, so «Go to» twice is one tab and not two.
   *
   * **What this gives up, stated.** Inside Zoho One or CRM Plus the CRM is a frame of the suite
   * shell, and navigating that frame kept the reader inside the shell. A new tab lands on
   * `crm.zoho.*` directly - the ordinary CRM, outside the suite chrome. That is a real loss and it
   * is the smaller one: a shell to come back to costs a click, and an unsaved function costs the
   * work. The modifiers are unchanged, so Ctrl-click is still a background tab and Shift-click a
   * window.
   *
   * @param {string} url */
  async function open(url, how) {
    if (!allows(url)) {
      options.refused(url);
      return null;
    }
    // **A modifier means «not here»**, so the tab-reuse machinery below is skipped entirely: the
    // reader asking for a new window is not asking to navigate the one they have. The host check
    // above still runs first - «certain, or stop» does not bend for a keystroke.
    if (how) return await openElsewhere(url, how) ? true : null;
    // On the shell the reader is standing in, when they are standing in one - so a new tab keeps the
    // suite around it instead of landing on the bare CRM page. See `onTheSameShell`.
    url = await onTheSameShell(url);
    // Already there? Then this is a request to *look* at it, and a second copy is not an answer.
    // `tabs.query({url})` takes a match pattern and a bare host has no path to match, so the
    // address is normalised the way `openExternal` learnt to - and a lookup that cannot answer is
    // not a reason to do nothing: it falls through to the tab this makes anyway.
    let already = [];
    try { already = await options.chromeApi.tabs.query({ url: new URL(url).href }); } catch (_) { already = []; }
    if (already && already[0]) {
      await raise_(already[0].id, { active: true });
      return already[0].id;
    }
    // Its window is brought forward with it: made in a browser window that stays behind Zoost's
    // own, a new tab is a thing that happened where nobody is looking.
    const tab = await options.chromeApi.tabs.create({ url, active: true });
    try {
      if (tab && tab.windowId != null) await options.chromeApi.windows.update(tab.windowId, { focused: true });
    } catch (_) { /* the window refused focus; the tab is still there and current */ }
    return tab.id;
  }

  /** Make the tab current **and bring its window forward.**
   *
   *  `tabs.update({active:true})` selects the tab inside its own window and does nothing about
   *  which window you are looking at. That was invisible while Zoost lived in a side panel - the
   *  panel is *in* the browser window, so the tab it selected was already in front. With Zoost in a
   *  window of its own, and the browser possibly behind it or on another monitor, «Open in Zoho»
   *  selected a tab nobody could see and appeared to do nothing at all. Asked before it was built.
   *
   *  One function rather than the same two lines at each call site, which is where one of them
   *  eventually gets forgotten - the reason `guardOk()` and `blockZoho()` are single places too.
   */
  /** Where the reader asked for it to open, from the modifiers the whole web already teaches.
   *
   *  Ctrl or Cmd is a new tab, Shift is a new window - the idiom every browser has taught for
   *  twenty years, so there is nothing to learn and the context menu is left alone, which a
   *  right-click override would not be. It matters more since Zoost left the side panel: on two
   *  screens, «open this in a second Zoho window» is a thing somebody actually wants.
   *
   *  A new tab opens **in the background**, because that is what Ctrl-click does everywhere; a new
   *  window comes forward, because that is what Shift-click does. Following the idiom means
   *  following all of it.
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

  async function raise_(tabId, props) {
    const tab = await options.chromeApi.tabs.update(tabId, props);
    try {
      if (tab && tab.windowId != null) await options.chromeApi.windows.update(tab.windowId, { focused: true });
    } catch (_) { /* the window refused focus; the tab is still the current one in it */ }
    return tab;
  }

  return { allows, open, focusTab: raise_, howFrom, openElsewhere };
}
