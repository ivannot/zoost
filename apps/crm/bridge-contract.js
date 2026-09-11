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
/** @typedef {{ok: true, [field: string]: unknown} | {ok: false, error: string, status?: number, forbidden?: boolean,
 * note?: string, diag?: unknown}} BridgeReply */
/** @typedef {Error & {status: number, forbidden: boolean, note: unknown, diag: unknown}} BridgeReplyError */

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

/** @param {BridgeReply|null|undefined} reply @param {unknown} fallback @param {string} stale
 * @returns {BridgeReplyError} */
function bridgeResponseError(reply, fallback, stale) {
  const error = /** @type {BridgeReplyError} */ (new Error(String(reply ? (reply.error || fallback) : stale)));
  error.status = Number(reply && reply.status) || 0;
  error.forbidden = !!(reply && reply.forbidden);
  error.note = (reply && reply.note) || null;
  error.diag = (reply && reply.diag) || null;
  if (typeof classifyZoostError === 'function') {
    const classified = classifyZoostError(error, 'bridge');
    for (const key of ['code', 'area', 'severity', 'retryable', 'uiKey']) error[key] = classified[key];
  }
  return error;
}
