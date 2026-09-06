/* Workspace entry points, without DOM or Chrome state.
 *
 * The panel supplies facts and adapters; this file owns the order of the use case and turns state
 * into the view a renderer consumes. A future renderer can use both without becoming a second owner
 * of the workspace rules.
 */

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

/** A renderer-independent summary of one local workspace.
 *
 * The panel supplies only facts it has already read from disk. In particular, an absent count is
 * kept absent: the overview must not turn an unreadable or never-pulled area into a zero.
 */
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
    issues: (input.issues || []).filter(Boolean).map(String),
    ready: areas.filter((area) => area.status === 'ready').length,
  };
}
