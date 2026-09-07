// @ts-check
/* The message contract between a panel and its content bridge.
 *
 * Chrome transports plain objects: these helpers preserve the workspace identity on commands,
 * distinguish a missing listener from a negative reply, and rebuild the facts carried by errors.
 */

/** @typedef {{[field: string]: unknown}} BridgeIdentity */
/** @typedef {{cmd: string, __zoostExpected?: BridgeIdentity, [field: string]: unknown}} BridgeCommand */
/** @typedef {{ok?: boolean, error?: unknown, status?: unknown, forbidden?: unknown,
 * note?: unknown, diag?: unknown, [field: string]: unknown}} BridgeReply */
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
  return error;
}
