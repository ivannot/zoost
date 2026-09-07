// @ts-check
/* Constructed Zoho CRM destinations and the only adapter that opens them.
 *
 * Workspace files are untrusted input. A destination is accepted only when its complete host is in
 * the manifest-derived allow-list; navigation inside a suite shell targets the CRM frame already
 * selected by the bridge adapter and falls back to the tab when Chrome refuses that frame.
 */

/** @typedef {{base?: string|null, instance?: string|null}} CrmNavigationContext */
/** @typedef {{kind?: string, id?: string|number, template?: {id?: string|number}}} CrmActionTarget */
/** @typedef {{newTab?: boolean, active?: boolean}} CrmNavigationOpenOptions */
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

  /** @param {string} url @param {CrmNavigationOpenOptions} openOptions */
  async function open(url, openOptions = {}) {
    if (!allows(url)) {
      options.refused(url);
      return null;
    }
    if (openOptions.newTab) {
      const tab = await options.chromeApi.tabs.create({ url, active: true });
      return tab.id;
    }
    let tabId = await options.findTab();
    if (!tabId) {
      const tab = await options.chromeApi.tabs.create({ url, active: openOptions.active !== false });
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
        if (openOptions.active !== false) {
          await options.chromeApi.tabs.update(tabId, { active: true });
        }
        return tabId;
      } catch (_) { /* frame navigation refused: preserve the established tab fallback */ }
    }
    await options.chromeApi.tabs.update(tabId, { url, active: openOptions.active !== false });
    return tabId;
  }

  return { allows, open };
}
