/* Workspace entry points, without DOM or Chrome state.
 *
 * The panel supplies facts; this file turns them into the view a renderer consumes. Keeping that
 * boundary pure means a different renderer can use it later without becoming a second owner of the
 * workspace rules.
 */

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

function addWorkspaceView(existing, pullBusy, context, rootName, rootGranted) {
  const hasContext = !!(context && context.org);
  const instance = context && context.instance;
  return {
    hidden: !!existing,
    disabled: !!pullBusy || !hasContext,
    label: instance ? `+ ${instance}` : '+ Workspace',
    title: !context ? 'Open a Zoho CRM tab first'
      : !rootName ? `Choose a working folder and create the workspace for «${instance}»`
        : !rootGranted ? `Grant access to ${rootName}, then open or create «${instance}»`
          : `Create a workspace folder for «${instance}» inside ${rootName}`,
  };
}
