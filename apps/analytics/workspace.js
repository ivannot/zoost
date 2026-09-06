// @ts-check
/* Workspace entry points, without DOM or Chrome state.
 *
 * The panel supplies facts and adapters; this file owns the order of the use case and turns state
 * into the view a renderer consumes. A future renderer can use both without becoming a second owner
 * of the workspace rules.
 */

/** @typedef {{
 * refuse: () => boolean, root: () => any, pickRoot: () => Promise<void>,
 * ensurePermission: (folder: any) => Promise<boolean>, permissionRefused: () => void,
 * folderWasGranted: () => boolean, refreshAfterGrant: () => Promise<void>,
 * context: () => Promise<any>, contextMissing: () => void,
 * findExisting: (context: any) => any, openExisting: (workspace: any) => Promise<any>,
 * create: (context: any) => Promise<any>
 * }} WorkspaceEntrySteps */

/** @param {WorkspaceEntrySteps} step */
async function runWorkspaceEntry(step) {
  if (step.refuse()) return { outcome: 'refused' };
  let folder = step.root();
  if (!folder) {
    await step.pickRoot();
    folder = step.root();
    if (!folder) return { outcome: 'cancelled' };
  }
  if (!(await step.ensurePermission(folder))) {
    step.permissionRefused();
    return { outcome: 'permission-refused' };
  }
  if (!step.folderWasGranted()) await step.refreshAfterGrant();
  const context = await step.context();
  if (!context) {
    step.contextMissing();
    return { outcome: 'context-missing' };
  }
  const existing = step.findExisting(context);
  if (existing) {
    await step.openExisting(existing);
    return { outcome: 'opened', workspace: existing };
  }
  const value = await step.create(context);
  return { outcome: 'create-attempted', value };
}

/** @param {any} have @param {boolean} knowable @param {boolean} busy */
function sampleWorkspaceView(have, knowable, busy) {
  const mode = have ? 'open' : knowable ? 'create' : 'unknown';
  return {
    workspace: have || null,
    knowable: !!knowable,
    disabled: !!busy,
    buttonLabel: mode === 'open' ? 'Open sample' : mode === 'create' ? '+ Sample' : 'Sample',
    overlayLabel: mode === 'open' ? 'Open sample workspace'
      : mode === 'create' ? '+ Sample workspace' : 'Sample workspace',
    title: mode === 'open'
      ? 'Open the sample workspace already in your working folder - invented data, nothing is fetched'
      : mode === 'create'
        ? 'Write a workspace of invented data into the working folder and open it - nothing is fetched, and it can be deleted like any other'
        : 'Opens the sample workspace, or writes one if there is none. Clicking asks for access to the working folder first, which is what the panel needs before it can tell.',
  };
}

/** @param {any} existing @param {boolean} actionBusy
 * @param {{workspace?: string}|null} context @param {string|null} rootName
 * @param {boolean} rootGranted @param {string|null} busyReason */
function addWorkspaceView(existing, actionBusy, context, rootName, rootGranted, busyReason) {
  const hasContext = !!(context && context.workspace);
  const disabled = !!actionBusy || !hasContext;
  const blockedByBusy = !!actionBusy;
  return {
    hidden: !!existing,
    disabled,
    label: '+ Workspace',
    title: !disabled
      ? !rootName ? 'Choose a working folder and create the workspace in the active tab'
        : !rootGranted ? `Grant access to ${rootName}, then open or create the workspace in the active tab`
          : 'Create a workspace for the one in the active tab'
      : `Cannot create a workspace: ${blockedByBusy ? busyReason : 'the active tab is not on a Zoho Analytics workspace'}`,
  };
}

/**
 * @typedef {'ready'|'partial'|'behind'|'unavailable'|'not-read'} WorkspaceAreaStatus
 * @typedef {'pull'|'refresh'|'retry'|'health'|null} WorkspaceIssueAction
 * @typedef {{text: string, action: WorkspaceIssueAction}} WorkspaceIssue
 * @typedef {{id?: string, label?: string, count?: number|null, pulledAt?: string|null,
 *   unavailable?: boolean, partial?: boolean, behind?: boolean}} WorkspaceAreaInput
 * @typedef {{workspace?: any, name?: string, sample?: boolean, lastPull?: string|null,
 *   areas?: WorkspaceAreaInput[], issues?: Array<string|{text: string, action?: WorkspaceIssueAction}>}} WorkspaceOverviewInput
 */

/** A renderer-independent summary of one local workspace.
 *
 * The panel supplies only facts it has already read from disk. In particular, an absent count is
 * kept absent: the overview must not turn an unreadable or never-pulled area into a zero.
 */
/** @param {WorkspaceOverviewInput} input */
function workspaceOverviewModel(input = {}) {
  const areas = (input.areas || []).map((area) => {
    const status = area.unavailable ? 'unavailable'
      : area.partial ? 'partial'
        : area.behind ? 'behind'
          : area.pulledAt ? 'ready' : 'not-read';
    return {
      id: String(area.id || ''),
      label: String(area.label || area.id || ''),
      count: Number.isFinite(area.count) ? area.count : null,
      pulledAt: area.pulledAt || null,
      status,
    };
  });
  return {
    visible: !!input.workspace,
    name: String(input.name || 'Workspace'),
    sample: !!input.sample,
    lastPull: input.lastPull || null,
    areas,
    issues: (input.issues || []).filter((issue) => typeof issue === 'string' ? !!issue : !!(issue && issue.text))
      .map((issue) => typeof issue === 'string'
        ? { text: issue, action: null }
        : { text: String(issue.text), action: issue.action || null }),
    ready: areas.filter((area) => area.status === 'ready').length,
  };
}

/**
 * The short first-use path shown inside Overview. This is deliberately a projection of facts the
 * panel already has, not a saved tutorial flag: closing a tip must never become evidence that a
 * pull or an exploration happened.
 *
 * @param {{sample?: boolean, mirrorReady?: boolean}} input
 * @returns {{visible: boolean, nextAction: 'pull'|'browse', steps: Array<{
 *   id: 'workspace'|'mirror'|'explore', label: string, detail: string,
 *   state: 'done'|'current'|'pending'
 * }>}}
 */
function workspaceOnboardingModel(input = {}) {
  const sample = !!input.sample;
  const mirrorReady = !!input.mirrorReady;
  return {
    // A returning real workspace opens where the reader left it. The sample remains the guided
    // tour: it is explicitly chosen for learning and cannot be pulled from Zoho.
    visible: sample || !mirrorReady,
    nextAction: mirrorReady ? 'browse' : 'pull',
    steps: [
      { id: 'workspace', label: 'Workspace ready', detail: 'Local folder selected', state: 'done' },
      { id: 'mirror', label: sample ? 'Sample ready' : 'Copy from Zoho',
        detail: sample ? 'Invented data is already local' : mirrorReady ? 'Local mirror created' : 'Run Pull all',
        state: mirrorReady ? 'done' : 'current' },
      { id: 'explore', label: 'Open the first item',
        detail: mirrorReady ? 'Browse, search or open the diagram' : 'Available after the first pull',
        state: mirrorReady ? 'current' : 'pending' },
    ],
  };
}

/** Resolve an Overview action without giving the renderer ownership of the use case.
 * @param {string} action @param {Record<string, Function>} handlers */
function workspaceOverviewAction(action, handlers = {}) {
  if (!['pull', 'refresh', 'retry', 'health', 'browse'].includes(action)) return null;
  return typeof handlers[action] === 'function' ? handlers[action] : null;
}
