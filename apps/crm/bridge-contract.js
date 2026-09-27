// @ts-check
/* The message contract between a panel and its content bridge.
 *
 * Chrome transports plain objects: these helpers preserve the workspace identity on commands,
 * distinguish a missing listener from a negative reply, and rebuild the facts carried by errors.
 */

// Optional on the wire for one-release compatibility: an older bridge ignores the extra field,
// while a newer bridge can refuse a future protocol instead of interpreting it as an old command.
const BRIDGE_PROTOCOL_V = 2;

/** @typedef {{[field: string]: unknown}} BridgeIdentity */
/** @typedef {{__zoostExpected?: BridgeIdentity, __zoostProtocol?: number} & ({cmd: "context"} | {cmd: "listFunctions"} | {cmd: "functionUiIds"} |
 * {cmd: "functionRuntime", id: string, language?: string, period?: string, from?: string, to?: string} |
 * {cmd: "listWorkflows"} | {cmd: "fetchWorkflow", id: string} | {cmd: "workflowUsage", id: string, from?: string, till?: string} |
 * {cmd: "listSchedules"} | {cmd: "listBlueprints"} | {cmd: "fetchBlueprint", id: string} |
 * {cmd: "fetchBlueprintInternal", id: string} |
 * {cmd: "fetchTransition", id: string} | {cmd: "fetchFunctionAction", id: string} |
 * {cmd: "fetchModuleFields", apiName: string} |
 * {cmd: "fetchOne", id: string, category?: string, source?: string, language?: string, runtime?: string} |
 * {cmd: "pullModules"} | {cmd: "listModules"} | {cmd: "pullFailures"} | {cmd: "pullActions", taskDetails?: boolean} | {cmd: "pullConnections"})} BridgeCommand */
/** @typedef {{ok: true, origin: string, org: string, instance: string}} CrmContextReply */
/** @typedef {{ok: true, entries: object[], total: number, capped?: boolean}} CrmListReply */
/** @typedef {{ok: true, file: object}} CrmFileReply */
/** @typedef {{ok: true, rule?: object, blueprint?: object, transition?: object, action?: object, usage?: object, fields?: object[], window?: object, logs?: object, revisions?: object}} CrmDetailReply */
/** @typedef {{ok: false, error: string, status?: number, forbidden?: boolean, area?: string, note?: string, diag?: unknown,
 * code?: string, detail?: unknown}} BridgeErrorReply */
/** @typedef {{__zoostProtocol?: number} & (CrmContextReply | CrmListReply | CrmFileReply | CrmDetailReply | BridgeErrorReply)} BridgeReply */
/** @typedef {Error & {status: number, forbidden: boolean, note: unknown, diag: unknown, upstreamCode: string|null, detail: unknown}} BridgeReplyError */

/** @param {BridgeCommand} message @param {BridgeIdentity|null} identity @returns {BridgeCommand} */
function bridgeCommand(message, identity) {
  // Keep the value local as well as global: the panel lifter tests this function in isolation.
  const versioned = { ...message, __zoostProtocol: 2 };
  return identity && message.cmd !== 'context'
    ? { ...versioned, __zoostExpected: identity }
    : versioned;
}

/** @param {unknown} reply @returns {BridgeReply|null} */
function bridgeContext(reply) {
  return !!reply && typeof reply === 'object' && /** @type {BridgeReply} */ (reply).ok === true
    ? /** @type {BridgeReply} */ (reply) : null;
}

/** What each command's positive reply must carry, declared once.
 *
 * **Only the fields this panel actually reads**, because a validator that reproduces Zoho's schema
 * is a second copy of somebody else's contract and will be wrong the week they extend it. What is
 * here was derived twice over: from the call sites that consume each reply, and from the bridge's
 * own `return` statements - the two agree, and where they did not the consumer was the one guessing.
 *
 * `'object?'` means «an object, or `null`, and nothing else». That is not a convenience: `fetchOne`
 * answers `file: null` when Zoho no longer has the function - deleted between the census and the
 * download, the ordinary race a pull survives - and refusing it once replaced «detail not found»
 * with a sentence carrying no HTTP code, which the retry logic then read as transient. The four
 * detail commands answer the same way for the same reason.
 *
 * `objects` names the arrays whose *items* must be plain objects. It matters where the array is
 * written to the mirror: a list of strings would be serialised into an index file that every later
 * read then has to survive.
 *
 * **The commands that prune are the reason this exists.** `listBlueprints` builds the set of live
 * ids from `entries` and deletes every blueprint file outside it; `pullConnections` writes
 * `connections/index.json` from `connections`; `pullModules` reads `modules.length` with no guard
 * at all. A reply that arrives `{ok: true}` and nothing else would, respectively, delete the whole
 * blueprints folder, empty the connections index, and throw a TypeError with no area attached to
 * it. That is the question this repository already asks of every pull - «does partial data
 * authorise a destructive act?» - asked at the boundary instead of at the call site.
 */
const CRM_REPLY_SHAPES = {
  context: { need: { origin: 'string', org: 'string', instance: 'string' } },
  listFunctions: { need: { entries: 'array', total: 'number' }, objects: ['entries'] },
  listWorkflows: { need: { entries: 'array', total: 'number' }, objects: ['entries'] },
  listSchedules: { need: { entries: 'array', total: 'number' }, objects: ['entries'] },
  listBlueprints: { need: { entries: 'array' }, objects: ['entries'] },
  functionUiIds: { need: { map: 'object' } },
  fetchModuleFields: { need: { fields: 'array' }, objects: ['fields'] },
  fetchOne: { need: { file: 'object?' } },
  listModules: { need: { modules: 'array' }, objects: ['modules'] },
  pullModules: { need: { modules: 'array' }, objects: ['modules'] },
  pullConnections: { need: { connections: 'array' }, objects: ['connections'] },
  // **`sv` is deliberately not required, and requiring it was a defect.** The panel has a branch
  // for a reply that carries no `sv` - `if ((Number(r.sv) || 0) < ACT_SV)` - and the `|| 0` exists
  // for exactly the absent case, because an older-but-present `sv` is already a number. What it
  // shows is the panel's stale-bridge sentence: «The Zoho tab is still running an older copy of this extension -
  // reload that tab, then pull again», which names the remedy and records no verdict. Declaring
  // `sv` here threw before that branch could run, so the reader got «bridge pullActions response
  // has invalid sv» in red, a «failed» access state written into their workspace for an area Zoho
  // never refused, and no remedy anywhere. A validator that replaces a precise message with a
  // generic one has made the product worse in the act of making it stricter.
  pullActions: { need: { actions: 'array' }, objects: ['actions'] },
  pullFailures: { need: { failures: 'array' }, objects: ['failures'] },
  // **`shape` and not `need`, for the five that fetch one thing.** Their callers already read an
  // absent key as «Zoho no longer has this» - `if (!r?.ok || !r.blueprint) throw 'not found'` - and
  // that sentence is the one the row shows and the retry logic understands. Requiring the key here
  // would replace it with an envelope complaint for the same condition, which is the exact trade
  // that had to be undone once for `fetchOne`. So: absence stays the caller's to word, and what is
  // refused is a *shape* nobody sends - a string, a number, an array where an object belongs.
  fetchWorkflow: { shape: { rule: 'object?' } },
  fetchBlueprint: { shape: { blueprint: 'object?' } },
  fetchBlueprintInternal: { shape: { blueprint: 'object?' } },
  fetchTransition: { shape: { transition: 'object?' } },
  fetchFunctionAction: { shape: { action: 'object?' } },
};

/** Commands whose envelope is the whole contract, each with the reason it is enough.
 *
 * Declared rather than omitted, so that a command added tomorrow and forgotten is a finding instead
 * of a silence - `tests/panel.test.mjs` derives the command list from the typedef above and fails
 * on any name that is in neither table.
 */
const CRM_REPLY_ENVELOPE_ONLY = {
  functionRuntime: 'every field is a measurement Zoho may not have - window, logs and revisions are '
    + 'each null on an org that keeps none - and the pane words their absence. It writes nothing to '
    + 'the mirror, so an incomplete answer costs a box on screen and not a file.',
  workflowUsage: 'the reply is one usage row or null by construction: the bridge already reduces '
    + 'the list to `[0] || null`, and the caller draws «no usage recorded» for the null.',
};

/** @param {unknown} value @param {string} type @returns {boolean} */
function bridgeShapeOk(value, type) {
  if (type.endsWith('?')) {
    if (value === null) return true;
    return bridgeShapeOk(value, type.slice(0, -1));
  }
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

/** @param {unknown} command @param {unknown} reply @returns {BridgeReply} */
function validateBridgeReply(command, reply) {
  if (!reply || typeof reply !== 'object') throw new Error('bridge returned no response');
  const r = /** @type {BridgeReply} */ (reply);
  if (r.__zoostProtocol !== undefined && r.__zoostProtocol !== BRIDGE_PROTOCOL_V) {
    throw new Error(`bridge protocol ${String(r.__zoostProtocol)} is not supported`);
  }
  if (r.ok === false && typeof r.error !== 'string') throw new Error('bridge returned an invalid error response');
  if (r.ok !== true && r.ok !== false) throw new Error('bridge returned an invalid response envelope');
  if (r.ok === true && command && typeof command === 'object') {
    const cmd = /** @type {{cmd?: string}} */ (command).cmd;
    const shape = CRM_REPLY_SHAPES[cmd];
    if (shape) {
      for (const [key, type] of Object.entries(shape.shape || {})) {
        if (key in r && !bridgeShapeOk(/** @type {any} */ (r)[key], type)) {
          throw new Error(`bridge ${cmd} response has invalid ${key}`);
        }
      }
      for (const [key, type] of Object.entries(shape.need || {})) {
        // Absence and the wrong shape are one finding and one sentence. They were two - «response is
        // incomplete» and «has invalid <key>» - and the first could never fire for a key the type
        // table also named, because `typeof undefined` fails the type check first. One message,
        // and it is the wording the cases already read for.
        if (!(key in r) || !bridgeShapeOk(/** @type {any} */ (r)[key], type)) {
          throw new Error(`bridge ${cmd} response has invalid ${key}`);
        }
      }
      for (const key of shape.objects || []) {
        const value = /** @type {any} */ (r)[key];
        // The array-ness is checked again rather than inherited from the `need` loop above. It is
        // true today that every `objects` key is also a `need` of `'array'`, and that is a fact
        // about this table rather than about this function: an entry added without one, or with an
        // `'array?'`, would make `value.some` a TypeError thrown from the boundary with no command
        // name in it. The old code had this guard; the rewrite dropped it on the strength of a
        // coincidence.
        if (!Array.isArray(value)
            || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
          throw new Error(`bridge ${cmd} response has invalid ${key} item`);
        }
      }
      const payload = /** @type {any} */ (r);
      if (cmd === 'listFunctions' && payload.entries.some((entry) => entry.id !== undefined && typeof entry.id !== 'string')) {
        throw new Error('bridge listFunctions response has invalid entry id');
      }
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
