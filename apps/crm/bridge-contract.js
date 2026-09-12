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
/** @typedef {{ok: false, error: string, status?: number, forbidden?: boolean, area?: string, note?: string, diag?: unknown,
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
      fetchModuleFields: { fields: 'array' },
      // `fetchOne` is not here on purpose: its `file` is `null` when Zoho no longer has the function,
      // which is an answer the panel has a branch for. The shape check for it is below, where `null`
      // is allowed and a string, a number or an array is not.
    }[cmd];
    if (types) for (const [key, type] of Object.entries(types)) {
      const value = r[key];
      if ((type === 'array' && !Array.isArray(value)) || (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))
          || (type !== 'array' && type !== 'object' && typeof value !== type)) throw new Error(`bridge ${cmd} response has invalid ${key}`);
    }
    const arrays = {
      listFunctions: ['entries'], listWorkflows: ['entries'], listSchedules: ['entries'],
      fetchModuleFields: ['fields'],
    }[cmd];
    for (const key of arrays || []) {
      const value = r[key];
      if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error(`bridge ${cmd} response has invalid ${key} item`);
      }
    }
    const payload = /** @type {any} */ (r);
    if (cmd === 'listFunctions' && payload.entries.some((entry) => entry.id !== undefined && typeof entry.id !== 'string')) {
      throw new Error('bridge listFunctions response has invalid entry id');
    }
    // `null` is an answer here, and refusing it broke the case it was written to protect. The bridge
    // returns `file: null` when Zoho no longer has that function - deleted between the census and
    // the download, which is the ordinary race a pull is built to survive - and the panel has a
    // branch for it. Rejecting the envelope replaced «detail not found» with «bridge fetchOne
    // response has invalid file» on the row and in the live-sync message, and made that branch
    // unreachable; worse, the invented sentence carries no HTTP code, so the retry logic read it as
    // transient and spent a retry on a function that is gone. What must still be refused is a
    // *shape* nobody sends: a string, a number, an array.
    if (cmd === 'fetchOne' && payload.file !== null
        && (!payload.file || typeof payload.file !== 'object' || Array.isArray(payload.file))) {
      throw new Error('bridge fetchOne response has invalid file');
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
