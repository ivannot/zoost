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
 * findFrame: (tabId: number) => Promise<number|null>,
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

  /** Take the reader to a URL inside Zoho: reuse the tab they have open, or make one.
   *
   * It used to take an options object with `newTab` and `active`. **Neither was ever passed.** Nine
   * call sites: eight give no options at all, and the ninth - `openTargetZoho` - was itself only ever
   * called as `openTargetZoho(false)`, so `newTab` was constantly false and its branch could not
   * run, while `active` was constantly `undefined` and the three `!== false` tests it fed were
   * constantly true. Two dead fields, a dead branch and a parameter every caller agreed on: this
   * always opens in the tab the reader already has, and brings it to the front.
   *
   * @param {string} url */
  async function open(url) {
    if (!allows(url)) {
      options.refused(url);
      return null;
    }
    let tabId = await options.findTab();
    if (!tabId) {
      const tab = await options.chromeApi.tabs.create({ url, active: true });
      return tab.id;
    }
    const frameId = await options.findFrame(tabId);
    if (frameId) {
      try {
        await options.chromeApi.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          func: (destination) => { location.href = destination; },
          args: [url],
        });
        await options.chromeApi.tabs.update(tabId, { active: true });
        return tabId;
      } catch (_) { /* frame navigation refused: preserve the established tab fallback */ }
    }
    await options.chromeApi.tabs.update(tabId, { url, active: true });
    return tabId;
  }

  return { allows, open };
}
