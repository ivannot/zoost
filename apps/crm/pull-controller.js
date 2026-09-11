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
 * lifecycle?: {begin: () => number|null, transition: (next: string, id?: number) => boolean,
 *   progress: (event: object, id?: number) => boolean, finish: (warnings?: boolean, id?: number) => boolean,
 *   fail: (id?: number) => boolean, snapshot: () => {state: string, operationId: number}},
 * }} PullControllerOptions */

/** @param {PullControllerOptions} options */
function createCrmPullController(options) {
  let depth = 0;
  // The production bootstrap injects a lifecycle, making it a required composition dependency.
  // Keep the optional construction fallback only for this low-level factory's isolated callers
  // (some diagnostics exercise the lock without loading the browser bundle); the shipped bootstrap
  // rejects a missing lifecycle before exposing any pull action.
  const lifecycle = options.lifecycle || (typeof createPullLifecycle === 'function' ? createPullLifecycle() : null);

  function setPullBusy(hold) {
    if (hold && depth === 0) {
      if (lifecycle) {
        const id = lifecycle.begin();
        if (id == null || !lifecycle.transition('reading', id)) throw new Error('Pull lifecycle could not start');
      }
    }
    depth = Math.max(0, depth + (hold ? 1 : -1));
    options.publishBusy(depth > 0);
    options.blockZoho(options.busy() || !options.zohoReady()
      || !options.hasDirectory() || options.navigationOpen());
    options.updateWorkspaceButtons();
  }

  // Phase changes belong to the operation, not to the lock release.  Keeping them explicit makes
  // the lifecycle a useful record of what happened instead of a retrospective animation emitted
  // by setPullBusy(false).
  function phase(next) { return lifecycle ? lifecycle.transition(next) : false; }
  // A runner may own a complete vertical path and advance the lifecycle at the moment its real
  // planning/writing/refreshing work happens.  The controller still supplies those phases for the
  // older runners, but must not replay them after a vertical runner has already reached a later
  // state.  Replaying would turn an authoritative record back into the retrospective animation this
  // boundary was introduced to remove.
  function completePhasesIfStillReading() {
    if (lifecycle && lifecycle.snapshot().state !== 'reading') return false;
    phase('planning'); phase('writing'); phase('refreshing');
    return true;
  }
  function finishPull(warnings = false) {
    return lifecycle && lifecycle.snapshot().state === 'refreshing' ? lifecycle.finish(warnings) : false;
  }
  function failPull() { return lifecycle ? lifecycle.fail() : false; }

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
    try {
      phase('reading');
      await work();
      completePhasesIfStillReading();
      finishPull(options.statusKind() === 'warn');
      return true;
    } catch (error) { failPull(); throw error; }
    finally { setPullBusy(false); }
  }

  async function pullCurrent() {
    if (options.busy()) return;
    const view = options.currentView() || 'functions';
    const label = options.tabLabel(view).toLowerCase();
    const runners = options.runners();
    setPullBusy(true);
    options.setStatus('Pulling ' + label + '\u2026', 'busy');
    try {
      phase('reading');
      await (runners[view] || runners.functions)();
      if (options.statusKind() === 'busy') {
        if (!lifecycle || lifecycle.snapshot().state === 'reading') { phase('planning'); phase('writing'); }
        try { await options.rebuildActive(); }
        catch (_) { options.setStatus('Pull complete.', 'ok'); }
      }
      if (!lifecycle || lifecycle.snapshot().state === 'writing') phase('refreshing');
      finishPull(options.statusKind() === 'warn');
    } catch (error) {
      failPull();
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
      phase('reading');
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
      if (lifecycle.snapshot().state === 'reading') phase('planning');
      await options.takeRechecks(options.answeredRechecks(planned));
      if (!operation.current()) return;

      const summary = options.statusSnapshot();
      if (lifecycle.snapshot().state === 'planning') phase('writing');
      operation.say('Rebuilding the list\u2026', 'busy');
      try { await options.rebuildActive(); } catch (_) {}
      if (lifecycle.snapshot().state === 'writing') phase('refreshing');
      options.renderTabs();
      const changed = options.consumePreferencesChanged();
      const note = options.forbiddenNote()
        + (planned.skipped.length
          ? ` · ${planned.skipped.map(options.tabLabel).join(', ')} skipped by your settings` : '')
        + (changed ? ` · ${options.preferencesChangedNote}` : '')
        + options.takeListGap();
      if (operation.current()) options.setStatus(summary.text + note, note ? 'warn' : summary.kind);
      finishPull(!!note || summary.kind !== 'ok');
    } catch (error) {
      failPull();
      throw error;
    } finally { setPullBusy(false); }
  }

  return { setPullBusy, phase, finishPull, failPull, workspaceChangeRefuse, runPullAction, pullCurrent, pullEverything,
    pullLifecycle: () => lifecycle ? lifecycle.snapshot() : null };
}
