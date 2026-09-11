// @ts-check
/* Typed boundary for the Analytics Pull all bridge calls.  The panel no longer constructs raw
 * command objects inside the use-case wiring; this is the single place where the command contract
 * meets Chrome's message transport. */
/** @typedef {{cmd: 'workspaceInfo'} | {cmd: 'listViews'} | {cmd: 'workspaceErd'} |
 * {cmd: 'pullSql', ids: string[]} | {cmd: 'scanDependencies', ids: string[]}} PullBridgeCommand */
/** @typedef {(command: PullBridgeCommand) => Promise<unknown>} PullBridgeSend */
/** @param {PullBridgeSend} send */
function createAnalyticsPullAdapter(send) {
  /** @param {PullBridgeCommand} command */
  async function ask(command) {
    const reply = await send(command);
    return typeof validateBridgeReply === 'function' ? validateBridgeReply(command, reply) : reply;
  }
  return Object.freeze({
    readWorkspace: () => ask({ cmd: 'workspaceInfo' }),
    readViews: () => ask({ cmd: 'listViews' }),
    readErd: () => ask({ cmd: 'workspaceErd' }),
    readSql: (ids) => ask({ cmd: 'pullSql', ids }),
    readDependencies: (ids) => ask({ cmd: 'scanDependencies', ids }),
  });
}
