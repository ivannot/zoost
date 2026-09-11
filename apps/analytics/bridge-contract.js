// @ts-check
/* The message contract between a panel and its content bridge.
 *
 * Chrome transports plain objects: these helpers preserve the workspace identity on commands,
 * distinguish a missing listener from a negative reply, and rebuild the facts carried by errors.
 */

/** @typedef {{[field: string]: unknown}} BridgeIdentity */
/** @typedef {{__zoostExpected?: BridgeIdentity} & ({cmd: 'context'} | {cmd: 'workspaceInfo'} | {cmd: 'listViews'} | {cmd: 'workspaceErd'} |
 * {cmd: 'pullSql', ids: string[]} | {cmd: 'viewDependencies', id: string} | {cmd: 'scanDependencies', ids: string[]})} BridgeCommand */
/** @typedef {{ok: true, origin: string, workspace: string, name?: string}} AnalyticsContextReply */
/** @typedef {{ok: true, workspace: string, folders: object[], views: object[]}} AnalyticsViewsReply */
/** @typedef {{ok: true, workspace: string, tables: Record<string, object>, relations: object[], count: number}} AnalyticsErdReply */
/** @typedef {{ok: true, sql: Record<string, object>, failed: object[]}} AnalyticsSqlReply */
/** @typedef {{ok: true, id: string, parents: object[], children: object[], dashboards: string[]}} AnalyticsDependenciesReply */
/** @typedef {{ok: false, error: string, status?: number, forbidden?: boolean, area?: string, note?: string, diag?: unknown,
 * code?: string, detail?: unknown}} BridgeErrorReply */
/** @typedef {AnalyticsContextReply | AnalyticsViewsReply | AnalyticsErdReply | AnalyticsSqlReply |
 * AnalyticsDependenciesReply | BridgeErrorReply} BridgeReply */
/** @typedef {Error & {status: number, forbidden: boolean, note: unknown, diag: unknown, upstreamCode: string|null, detail: unknown}} BridgeReplyError */

/** @param {BridgeCommand} message @param {BridgeIdentity|null} identity @returns {BridgeCommand} */
function bridgeCommand(message, identity) {
  return identity && message.cmd !== 'context'
    ? { ...message, __zoostExpected: identity }
    : message;
}

/** @param {unknown} reply @returns {BridgeReply|null} */
function bridgeContext(reply) {
  return !!reply && typeof reply === 'object' && /** @type {BridgeReply} */ (reply).ok === true
    ? /** @type {BridgeReply} */ (reply) : null;
}

/**
 * Validate the common bridge envelope at the message boundary. Payload fields stay specific to the
 * command in the typedefs above; this runtime check catches a missing envelope without pretending
 * that arbitrary Zoho JSON is a valid typed payload.
 * @param {unknown} command @param {unknown} reply @returns {BridgeReply}
 */
function validateBridgeReply(command, reply) {
  if (!reply || typeof reply !== 'object') throw new Error('bridge returned no response');
  const r = /** @type {BridgeReply} */ (reply);
  if (r.ok === false && typeof r.error !== 'string') throw new Error('bridge returned an invalid error response');
  if (r.ok !== true && r.ok !== false) throw new Error('bridge returned an invalid response envelope');
  if (r.ok === true && command && typeof command === 'object') {
    const cmd = /** @type {{cmd?: string}} */ (command).cmd;
    const required = {
      workspaceInfo: ['workspace', 'origin'], listViews: ['views', 'folders'], workspaceErd: ['tables', 'relations'],
      pullSql: ['sql', 'failed'], viewDependencies: ['parents', 'children', 'dashboards'], scanDependencies: ['deps', 'failed'],
    }[cmd];
    if (required && required.some((key) => !(key in r))) throw new Error(`bridge ${cmd} response is incomplete`);
    const types = {
      context: { origin: 'string', workspace: 'string' }, workspaceInfo: { workspace: 'string', origin: 'string' },
      listViews: { views: 'array', folders: 'array' }, workspaceErd: { tables: 'object', relations: 'array' },
      pullSql: { sql: 'object', failed: 'array' }, viewDependencies: { parents: 'array', children: 'array', dashboards: 'array' },
      scanDependencies: { deps: 'object', failed: 'array' },
    }[cmd];
    if (types) for (const [key, type] of Object.entries(types)) {
      const value = r[key];
      if ((type === 'array' && !Array.isArray(value)) || (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))
          || (type !== 'array' && type !== 'object' && typeof value !== type)) throw new Error(`bridge ${cmd} response has invalid ${key}`);
    }
    // Container checks alone let a malformed row reach the mirror.  Validate the stable identity
    // fields consumed by the list, SQL and lineage code while leaving Zoho's optional metadata open.
    const rows = {
      listViews: ['views', 'folders'], workspaceErd: ['relations'],
      pullSql: ['failed'], scanDependencies: ['failed'],
    }[cmd];
    for (const key of rows || []) {
      const value = r[key];
      if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error(`bridge ${cmd} response has invalid ${key} item`);
      }
    }
    const payload = /** @type {any} */ (r);
    if (cmd === 'listViews' && payload.views.some((view) => typeof view.id !== 'string' || !view.id)) {
      throw new Error('bridge listViews response has invalid view id');
    }
    if (cmd === 'pullSql' && Object.keys(payload.sql).some((id) => !id || !payload.sql[id] || typeof payload.sql[id] !== 'object')) {
      throw new Error('bridge pullSql response has invalid sql entry');
    }
  }
  return r;
}

/** @param {BridgeReply|null|undefined} reply @param {unknown} fallback @param {string} stale
 * @returns {BridgeReplyError} */
function bridgeResponseError(reply, fallback, stale) {
  const negative = reply && reply.ok !== true ? /** @type {BridgeErrorReply} */ (reply) : null;
  const error = /** @type {BridgeReplyError} */ (new Error(String(negative ? (negative.error || fallback) : stale)));
  error.status = Number(negative && negative.status) || 0;
  error.forbidden = !!(negative && negative.forbidden);
  error.note = (negative && negative.note) || null;
  error.diag = (negative && negative.diag) || null;
  error.upstreamCode = (negative && negative.code) || null;
  error.detail = (negative && negative.detail) || null;
  if (typeof classifyZoostError === 'function') {
    const classified = classifyZoostError(error, (negative && negative.area) || 'bridge');
    for (const key of ['code', 'area', 'severity', 'retryable', 'uiKey']) error[key] = classified[key];
  }
  return error;
}
