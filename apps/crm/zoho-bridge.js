// @ts-check
/* CRM tab and frame adapter.
 *
 * A suite tab can contain several CRM-origin frames. The application frame is selected by asking
 * every candidate for its self-validating context, misses are never cached, and bridge injection is
 * limited to the CRM-origin candidates discovered in that tab.
 */

/** @typedef {{org?: unknown, base?: unknown, instance?: unknown}|null} CrmBoundWorkspace */
/** @typedef {{cmd: string, [field: string]: unknown}} CrmBridgeCommand */
/** @typedef {{
 * chromeApi: any,
 * zohoMatches: string[],
 * zohoHost: RegExp,
 * bound: () => CrmBoundWorkspace,
 * guardOk: () => boolean,
 * mismatchMessage: string,
 * noTabMessage: string,
 * sleep: (milliseconds: number) => Promise<unknown>,
 * command: (message: CrmBridgeCommand, identity: Record<string, unknown>|null) => CrmBridgeCommand,
 * validateReply?: (message: CrmBridgeCommand, reply: unknown) => unknown,
 * context: (reply: unknown) => any,
 * log?: (message: string) => void,
 * }} CrmZohoBridgeOptions */

/** @param {CrmZohoBridgeOptions} options */
function createCrmZohoBridge(options) {
  let candidates = { tabId: null, ids: [] };
  let frame = { tabId: null, frameId: 0, ts: 0 };
  let seenFrames = '(not enumerated)';
  const crmOrigin = /^https:\/\/crm(sandbox)?\.zoho/;
  const log = options.log || (() => {});

  async function tabHasCrmFrame(tabId) {
    try {
      const reply = await options.chromeApi.tabs.sendMessage(tabId, { cmd: 'context' });
      return !!(reply && reply.ok && reply.origin);
    } catch (_) { return false; }
  }

  /** Which org a candidate tab is on, or `null` when it will not say.
   *
   *  A named declaration and not an arrow inside the `map`: every async scope shipped here is one,
   *  because that is the only shape `asynccheck` can read, and a scope it cannot read is a scope
   *  nobody is checking for a global written after an await.
   */
  async function tabOrg(t) {
    try {
      const reply = await options.chromeApi.tabs.sendMessage(t.id, options.command({ cmd: 'context' }, null));
      const ctx = reply && options.context(reply);
      if (ctx && ctx.org) return { id: t.id, ctx };
    } catch (_) { /* fall through and try to revive our own script in that tab */ }
    try {
      if (!(await ensure(t.id))) return null;
      const again = await options.chromeApi.tabs.sendMessage(t.id, options.command({ cmd: 'context' }, null));
      const ctx = again && options.context(again);
      return ctx && ctx.org ? { id: t.id, ctx } : null;
    } catch (_) { return null; }                   // it will not answer even after a repair
  }

  async function tabId() {
    const [active] = await options.chromeApi.tabs.query({ active: true, currentWindow: true });
    if (active && options.zohoHost.test(active.url || '')) return active.id;
    if (active && (await tabHasCrmFrame(active.id))) return active.id;
    const tabs = await options.chromeApi.tabs.query({ url: options.zohoMatches });
    if (tabs.length < 2) return tabs[0]?.id ?? null;
    // **More than one candidate, so ask which one this workspace belongs to.**
    //
    // «The first tab the query returns» is a coin toss, and production plus a sandbox both open is
    // the ordinary case rather than an exotic one: step onto a third tab that is not Zoho at all and
    // the panel announced a mismatch about a tab the reader was not using, while the right one sat
    // open two tabs away. Reported from exactly that arrangement.
    //
    // **And a candidate that does not answer is repaired before it is written off.** The first
    // version skipped it, on the argument that injecting into a tab nobody has used in order to
    // decide whether to use it is the wrong order. That argument was wrong about what is being
    // injected: this content script is *declared in the manifest* for these hosts and loads on
    // every such page already, so `ensure` revives our own script rather than reaching anywhere new.
    //
    // And the case it was getting wrong is the ordinary one: **reloading an unpacked extension
    // orphans the content scripts in tabs that are already open.** Reported from exactly that -
    // production open in a tab, the panel reloaded, and only the sandbox answered, so the one tab
    // that matched was invisible and the bar named the one that did not.
    //
    // The answer is only a preference - whichever tab is chosen, the page at the far end still
    // refuses a command whose expected org is not its own, so this cannot widen what may be reached.
    const asked = await Promise.all(tabs.map(tabOrg));
    const bound = options.bound();
    const match = bound && asked.find((a) => a && String(a.ctx.org) === String(bound.org)
      && (!bound.base || a.ctx.origin === bound.base)
      && (!bound.instance || !a.ctx.instance || a.ctx.instance === bound.instance));
    return match ? match.id : (asked.find((a) => a) || {}).id ?? tabs[0].id;
  }

  async function activeTabId() {
    const [active] = await options.chromeApi.tabs.query({ active: true, currentWindow: true });
    if (!active) return null;
    if (options.zohoHost.test(active.url || '')) return active.id;
    return (await tabHasCrmFrame(active.id)) ? active.id : null;
  }

  async function askFrame(tabId, frameId) {
    try {
      const reply = await options.chromeApi.tabs.sendMessage(tabId, { cmd: 'context' }, { frameId });
      return {
        frameId,
        ok: !!(reply && reply.ok && reply.instance && reply.org),
        why: !reply ? 'declined' : reply.ok
          ? (reply.instance && reply.org ? 'ok' : 'half') : 'refused',
      };
    } catch (_) { return { frameId, ok: false, why: 'no-listener' }; }
  }

  async function answeringFrame(tabId, frameIds) {
    const asked = await Promise.all(frameIds.map((frameId) => askFrame(tabId, frameId)));
    log(`[zoost] frames asked [${asked.map((answer) => answer.frameId + ':' + answer.why).join(' ')}]`);
    const answer = asked.find((candidate) => candidate && candidate.ok);
    return answer ? answer.frameId : null;
  }

  async function frameId(tabId) {
    const now = Date.now();
    if (frame.tabId === tabId && frame.frameId !== null && now - frame.ts < 6000) {
      return frame.frameId;
    }
    let found = null;
    try {
      const results = await options.chromeApi.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => ({ href: location.href, top: window === window.top }),
      });
      const seen = (results || []).map((result) => ({ frameId: result.frameId, ...(result.result || {}) }));
      const crm = seen.filter((candidate) => crmOrigin.test(candidate.href || ''));
      candidates = { tabId, ids: crm.map((candidate) => candidate.frameId) };
      const top = crm.find((candidate) => candidate.top);
      if (top) found = top.frameId;
      else if (crm.length === 1) found = crm[0].frameId;
      else if (crm.length) found = await answeringFrame(tabId, candidates.ids);
      seenFrames = seen.map((candidate) => `${candidate.frameId}:${(candidate.href || '')
        .split('/').slice(0, 3).join('/')}`).join(' ');
    } catch (_) {
      try {
        const tab = await options.chromeApi.tabs.get(tabId);
        if (crmOrigin.test((tab && tab.url) || '')) found = 0;
      } catch (_) {}
    }
    if (found !== null) frame = { tabId, frameId: found, ts: now };
    return found;
  }

  async function ensure(tabId) {
    const found = await frameId(tabId);
    const target = found === null ? {} : { frameId: found };
    try {
      await options.chromeApi.tabs.sendMessage(tabId, { cmd: 'context' }, target);
      return true;
    } catch (_) {
      const ids = candidates.tabId === tabId ? candidates.ids : (found === null ? [] : [found]);
      if (!ids.length) return false;
      try {
        await options.chromeApi.scripting.executeScript({
          target: { tabId, frameIds: ids }, world: 'MAIN', files: ['hook.js'],
        });
        await options.chromeApi.scripting.executeScript({
          target: { tabId, frameIds: ids }, files: ['content-bridge.js'],
        });
        log(`[zoost] bridge injected into [${ids.join(' ')}]`);
        await options.sleep(60);
        frame = { tabId: null, frameId: 0, ts: 0 };
        return true;
      } catch (error) {
        log(`[zoost] bridge injection REFUSED for [${ids.join(' ')}]: ${(error && error.message) || error}`);
        return false;
      }
    }
  }

  /** @param {CrmBridgeCommand} message */
  async function send(message) {
    const bound = options.bound();
    // **Two states, and they had one sentence between them.** With no Zoho tab open at all the
    // guard is false - there is nothing to match against - so a pull was refused with «the active
    // tab is a different workspace», which is a claim about a tab that does not exist. Reported
    // after closing the Zoho tab and pressing Pull. The tab is resolved first now, and *that*
    // decides which of the two refusals the reader is owed.
    const id = await tabId();
    if (message && message.cmd !== 'context' && bound && !options.guardOk()) {
      throw new Error(id ? options.mismatchMessage : options.noTabMessage);
    }
    if (!id) throw new Error(options.noTabMessage);
    await ensure(id);
    const found = await frameId(id);
    const target = found === null ? {} : { frameId: found };
    const expected = message && message.cmd !== 'context' && bound
      ? { org: bound.org, origin: bound.base, instance: bound.instance } : null;
    const command = options.command(message, expected);
    const reply = await options.chromeApi.tabs.sendMessage(id, command, target);
    return options.validateReply ? options.validateReply(command, reply) : reply;
  }

  async function getContext() {
    try { return options.context(await send({ cmd: 'context' })); }
    catch (_) { return null; }
  }

  async function waitTabComplete(tabId, timeout = 9000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        const tab = await options.chromeApi.tabs.get(tabId);
        if (tab.status === 'complete') return true;
      } catch (_) { return false; }
      await options.sleep(200);
    }
    return false;
  }

  return {
    tabHasCrmFrame, tabId, activeTabId, askFrame, answeringFrame, frameId, ensure, send,
    getContext, waitTabComplete, seenFrames: () => seenFrames,
  };
}
