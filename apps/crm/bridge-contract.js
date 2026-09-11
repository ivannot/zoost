// @ts-check
/* The message contract between a panel and its content bridge.
 *
 * Chrome transports plain objects: these helpers preserve the workspace identity on commands,
 * distinguish a missing listener from a negative reply, and rebuild the facts carried by errors.
 */

/** @typedef {{[field: string]: unknown}} BridgeIdentity */
/** @typedef {{__zoostExpected?: BridgeIdentity} & ({cmd: "context"} | {cmd: "listFunctions"} | {cmd: "functionUiIds"} |
 * {cmd: "functionRuntime", id: string, language?: string, period?: string, from?: string, to?: string} |
 * {cmd: "listWorkflows"} | {cmd: "fetchWorkflow", id: string} | {cmd: "workflowUsage", id: string, from?: string, till?: string} |
 * {cmd: "listSchedules"} | {cmd: "fetchModuleFields", apiName: string} |
 * {cmd: "fetchOne", id: string, category?: string, source?: string, language?: string, runtime?: string} |
 * {cmd: "pullModules"} | {cmd: "pullFailures"} | {cmd: "pullActions"} | {cmd: "pullConnections"})} BridgeCommand */
/** @typedef {{ok: true, origin: string, org: string, instance: string}} CrmContextReply */
/** @typedef {{ok: true, entries: object[], total: number, capped?: boolean}} CrmListReply */
/** @typedef {{ok: true, file: object}} CrmFileReply */
/** @typedef {{ok: true, rule?: object, usage?: object, fields?: object[], window?: object, logs?: object, revisions?: object}} CrmDetailReply */
/** @typedef {{ok: false, error: string, status?: number, forbidden?: boolean, note?: string, diag?: unknown,
 * code?: string, detail?: unknown}} BridgeErrorReply */
/** @typedef {CrmContextReply | CrmListReply | CrmFileReply | CrmDetailReply | BridgeErrorReply} BridgeReply */
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

/** @param {unknown} command @param {unknown} reply @returns {BridgeReply} */
function validateBridgeReply(command, reply) {
  if (!reply || typeof reply !== 'object') throw new Error('bridge returned no response');
  const r = /** @type {BridgeReply} */ (reply);
  if (r.ok === false && typeof r.error !== 'string') throw new Error('bridge returned an invalid error response');
  if (r.ok !== true && r.ok !== false) throw new Error('bridge returned an invalid response envelope');
  if (r.ok === true && command && typeof command === 'object') {
    const cmd = /** @type {{cmd?: string}} */ (command).cmd;
    const required = {
      listFunctions: ['entries'], listWorkflows: ['entries'], listSchedules: ['entries'],
      fetchModuleFields: ['fields'], fetchOne: ['file'],
    }[cmd];
    if (required && required.some((key) => !(key in r))) throw new Error(`bridge ${cmd} response is incomplete`);
    const types = {
      context: { origin: 'string', org: 'string', instance: 'string' },
      listFunctions: { entries: 'array', total: 'number' }, listWorkflows: { entries: 'array', total: 'number' },
      listSchedules: { entries: 'array', total: 'number' }, functionUiIds: { map: 'object' },
      fetchModuleFields: { fields: 'array' }, fetchOne: { file: 'object' },
    }[cmd];
    if (types) for (const [key, type] of Object.entries(types)) {
      const value = r[key];
      if ((type === 'array' && !Array.isArray(value)) || (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))
          || (type !== 'array' && type !== 'object' && typeof value !== type)) throw new Error(`bridge ${cmd} response has invalid ${key}`);
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
    const classified = classifyZoostError(error, 'bridge');
    for (const key of ['code', 'area', 'severity', 'retryable', 'uiKey']) error[key] = classified[key];
  }
  return error;
}
