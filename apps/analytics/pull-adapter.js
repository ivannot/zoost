// @ts-check
/* Typed boundary for the Analytics Pull all bridge calls.  The panel no longer constructs raw
 * command objects inside the use-case wiring; this is the single place where the command contract
 * meets Chrome's message transport. */
/** @typedef {{cmd: 'workspaceInfo'} | {cmd: 'listViews'} | {cmd: 'workspaceErd'} |
 * {cmd: 'pullSql', ids: string[]} | {cmd: 'scanDependencies', ids: string[]}} PullBridgeCommand */
/** @typedef {(command: PullBridgeCommand) => Promise<unknown>} PullBridgeSend */
/** @typedef {{workspace: string, origin: string, name?: string}} PullWorkspace */
/** @typedef {{views?: Array<{id: string, type?: string}>, folders?: object[]}} PullViews */
/** @typedef {{tables?: Record<string, object>, relations?: object[]}} PullErd */
/** @typedef {{sql?: Record<string, object>, failed?: object[]}} PullSql */
/** @typedef {{deps?: Record<string, object>, failed?: object[]}} PullDependencies */
/** @param {PullBridgeSend} send */
function createAnalyticsPullAdapter(send) {
  /** @param {PullBridgeCommand} command */
  async function ask(command) {
    const reply = await send(command);
    const envelope = /** @type {any} */ (reply);
    // Even an isolated adapter must reject a malformed envelope; the optional richer validator is
    // an optimisation for the shipped bridge-contract script, never a fail-open escape hatch.
    if (!reply || typeof reply !== 'object' || (envelope.ok !== true && envelope.ok !== false)) {
      throw new Error(`bridge ${command.cmd} returned an invalid response envelope`);
    }
    if (envelope.ok === false && typeof envelope.error !== 'string') throw new Error(`bridge ${command.cmd} returned an invalid error response`);
    return typeof validateBridgeReply === 'function' ? validateBridgeReply(command, reply) : reply;
  }
  /** @returns {Promise<PullWorkspace>} */
  async function readWorkspace() { return /** @type {PullWorkspace} */ (await ask({ cmd: 'workspaceInfo' })); }
  /** @returns {Promise<PullViews>} */
  async function readViews() { return /** @type {PullViews} */ (await ask({ cmd: 'listViews' })); }
  /** @returns {Promise<PullErd>} */
  async function readErd() { return /** @type {PullErd} */ (await ask({ cmd: 'workspaceErd' })); }
  /** @param {string[]} ids @returns {Promise<PullSql>} */
  async function readSql(ids) { return /** @type {PullSql} */ (await ask({ cmd: 'pullSql', ids })); }
  /** @param {string[]} ids @returns {Promise<PullDependencies>} */
  async function readDependencies(ids) { return /** @type {PullDependencies} */ (await ask({ cmd: 'scanDependencies', ids })); }
  return Object.freeze({ readWorkspace, readViews, readErd, readSql, readDependencies });
}
