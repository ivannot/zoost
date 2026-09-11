// @ts-check
/* CRM pull orchestration, independent of panel globals.
 *
 * The product supplies readers, writers and renderers. This controller owns the lock shared by
 * every user-initiated read, the immutable Pull all walk, and the one release path that must run
 * after success, refusal or an exception.
 */

/** @typedef {{id: string, [field: string]: unknown}} PullControllerArea */
/** @typedef {{areas: PullControllerArea[], skipped: string[], asked: string[], askedBefore: Record<string, unknown>}} PullControllerPlan */
/** @typedef {{current: () => boolean, say: (text: string, kind?: string) => void}} PullControllerOperation */
/** @typedef {{text: string, kind: string}} PullControllerStatus */
/** @typedef {{
 * busy: () => boolean,
 * publishBusy: (busy: boolean) => void,
 * blockZoho: (blocked: boolean) => void,
 * zohoReady: () => boolean,
 * hasDirectory: () => boolean,
 * navigationOpen: () => boolean,
 * updateWorkspaceButtons: () => void,
 * restoreWorkspaceSelection: () => void,
 * setStatus: (text: string, kind?: string) => void,
 * currentView: () => string,
 * tabLabel: (id: string) => string,
 * runners: () => Record<string, () => Promise<unknown>>,
 * statusKind: () => string,
 * rebuildActive: () => Promise<unknown>,
 * beginOperation: () => PullControllerOperation,
 * plan: () => PullControllerPlan,
 * answeredRechecks: (plan: PullControllerPlan) => string[],
 * takeRechecks: (ids: string[]) => Promise<unknown>,
 * renderTabs: () => void,
 * forbiddenNote: () => string,
 * consumePreferencesChanged: () => boolean,
 * preferencesChangedNote: string,
 * takeListGap: () => string,
 * statusSnapshot: () => PullControllerStatus,
 * errorText: (error: unknown) => string,
 * }} PullControllerOptions */

/** @param {PullControllerOptions} options */
function createCrmPullController(options) {
  let depth = 0;
  const lifecycle = typeof createPullLifecycle === 'function' ? createPullLifecycle() : null;

  function setPullBusy(hold) {
    if (hold && depth === 0) {
      const id = lifecycle?.begin();
      if (id != null) lifecycle?.transition('reading', id);
    }
    depth = Math.max(0, depth + (hold ? 1 : -1));
    if (!hold && depth === 0 && lifecycle) {
      const state = lifecycle.snapshot().state;
      if (options.statusKind() === 'bad') lifecycle.fail();
      else if (state !== 'failed' && state !== 'cancelled') {
        // Short pulls do not expose each internal phase, so close the explicit machine through
        // the remaining phases rather than leaving it in `reading` forever.
        lifecycle.transition('planning');
        lifecycle.transition('writing');
        lifecycle.transition('refreshing');
        lifecycle.finish(options.statusKind() === 'warn');
      }
    }
    options.publishBusy(depth > 0);
    options.blockZoho(options.busy() || !options.zohoReady()
      || !options.hasDirectory() || options.navigationOpen());
    options.updateWorkspaceButtons();
  }

  function workspaceChangeRefuse() {
    if (!options.busy()) return false;
    options.restoreWorkspaceSelection();
    options.setStatus('Pull in progress - workspace unchanged.', 'warn');
    options.updateWorkspaceButtons();
    return true;
  }

  /** @param {() => Promise<unknown>} work */
  async function runPullAction(work) {
    if (options.busy()) return false;
    setPullBusy(true);
    try { await work(); return true; } finally { setPullBusy(false); }
  }

  async function pullCurrent() {
    if (options.busy()) return;
    const view = options.currentView() || 'functions';
    const label = options.tabLabel(view).toLowerCase();
    const runners = options.runners();
    setPullBusy(true);
    options.setStatus('Pulling ' + label + '\u2026', 'busy');
    try {
      await (runners[view] || runners.functions)();
      if (options.statusKind() === 'busy') {
        try { await options.rebuildActive(); }
        catch (_) { options.setStatus('Pull complete.', 'ok'); }
      }
    } catch (error) {
      options.setStatus('Pull error: ' + options.errorText(error), 'bad');
    } finally { setPullBusy(false); }
  }

  async function pullEverything() {
    if (options.busy()) return;
    const operation = options.beginOperation();
    const planned = options.plan();
    const runners = options.runners();
    setPullBusy(true);
    try {
      let done = 0;
      for (const area of planned.areas) {
        if (!operation.current()) return;
        lifecycle?.progress({ stage: 'reading', done, total: planned.areas.length });
        operation.say(`${options.tabLabel(area.id)}: ${done + 1} of ${planned.areas.length}\u2026`, 'busy');
        try { await runners[area.id](); }
        catch (_) { /* every runner records its own verdict and states its own message */ }
        done++;
      }
      if (!operation.current()) return;
      await options.takeRechecks(options.answeredRechecks(planned));
      if (!operation.current()) return;

      const summary = options.statusSnapshot();
      operation.say('Rebuilding the list\u2026', 'busy');
      try { await options.rebuildActive(); } catch (_) {}
      options.renderTabs();
      const changed = options.consumePreferencesChanged();
      const note = options.forbiddenNote()
        + (planned.skipped.length
          ? ` · ${planned.skipped.map(options.tabLabel).join(', ')} skipped by your settings` : '')
        + (changed ? ` · ${options.preferencesChangedNote}` : '')
        + options.takeListGap();
      if (operation.current()) options.setStatus(summary.text + note, note ? 'warn' : summary.kind);
    } finally { setPullBusy(false); }
  }

  return { setPullBusy, workspaceChangeRefuse, runPullAction, pullCurrent, pullEverything,
    pullLifecycle: () => lifecycle ? lifecycle.snapshot() : null };
}
