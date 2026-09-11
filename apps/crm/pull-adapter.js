// @ts-check
/* Typed boundary for the CRM pull path.  The rest of the panel still contains legacy readers, but
 * the census and source-download commands now have one explicit request/response contract instead
 * of rebuilding arbitrary objects at each call site. */

/** @typedef {{cmd: 'listFunctions'}} ListFunctionsRequest */
/** @typedef {{cmd: 'functionUiIds'}} FunctionUiIdsRequest */
/** @typedef {{cmd: 'fetchOne', id: string, category?: string, source?: string, language?: string, runtime?: string}} FetchOneRequest */
/** @typedef {{ok: true, entries?: Array<Record<string, unknown>>, unanswered?: string[], otherFailed?: string[], capped?: boolean, total?: number, [key: string]: unknown}} ListFunctionsReply */
/** @typedef {{ok: true, map?: Record<string, string>, [key: string]: unknown}} FunctionUiIdsReply */
/** @typedef {{ok: true, file?: Record<string, unknown>, [key: string]: unknown}} FetchOneReply */
/** @typedef {{ok: false, error?: string, code?: string, status?: number, [key: string]: unknown}} PullErrorReply */
/** @typedef {ListFunctionsRequest | FunctionUiIdsRequest | FetchOneRequest} CrmPullRequest */
/** @typedef {ListFunctionsReply | FunctionUiIdsReply | FetchOneReply | PullErrorReply} CrmPullReply */

/** @param {(request: CrmPullRequest) => Promise<CrmPullReply>} send */
function createCrmPullAdapter(send) {
  if (typeof send !== 'function') throw new Error('Zoost CRM pull adapter needs a bridge sender');
  /** @param {CrmPullRequest} request @returns {Promise<CrmPullReply>} */
  async function ask(request) { return send(request); }
  return {
    /** @returns {Promise<CrmPullReply>} */
    listFunctions: () => ask({ cmd: 'listFunctions' }),
    /** @returns {Promise<CrmPullReply>} */
    functionUiIds: () => ask({ cmd: 'functionUiIds' }),
    /** @param {Omit<FetchOneRequest, 'cmd'>} request @returns {Promise<CrmPullReply>} */
    fetchOne: (request) => ask({ cmd: 'fetchOne', ...request }),
  };
}
