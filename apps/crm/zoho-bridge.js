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

  async function tabId() {
    const [active] = await options.chromeApi.tabs.query({ active: true, currentWindow: true });
    if (active && options.zohoHost.test(active.url || '')) return active.id;
    if (active && (await tabHasCrmFrame(active.id))) return active.id;
    const tabs = await options.chromeApi.tabs.query({ url: options.zohoMatches });
    return tabs[0]?.id ?? null;
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
    if (message && message.cmd !== 'context' && bound && !options.guardOk()) {
      throw new Error(options.mismatchMessage);
    }
    const id = await tabId();
    if (!id) throw new Error(options.noTabMessage);
    await ensure(id);
    const found = await frameId(id);
    const target = found === null ? {} : { frameId: found };
    const expected = message && message.cmd !== 'context' && bound
      ? { org: bound.org, origin: bound.base, instance: bound.instance } : null;
    return options.chromeApi.tabs.sendMessage(id, options.command(message, expected), target);
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
