// @ts-check
/* Workspace Overview rendering, independent of product state and storage.
 *
 * workspace.js decides what the facts mean; the panel gathers them and supplies actions. This file
 * owns only the DOM projection, so neither product's orchestration file has to own the same view.
 */

const OVERVIEW_STATE = {
  ready: 'Ready', partial: 'Partial', behind: 'Behind', unavailable: 'Not available', 'not-read': 'Not read',
};

/** @typedef {{
 * body: HTMLElement,
 * escapeText: (value: unknown) => string,
 * escapeAttribute: (value: unknown) => string,
 * graphDisabled: boolean,
 * healthDisabled: boolean,
 * graphLabel: string,
 * issueLabel: (action: string) => string,
 * browse: () => void,
 * pull: () => void,
 * graph: () => void,
 * health: () => void,
 * issue: (action: string) => void,
 * }} OverviewViewOptions */

/** @param {any} model @param {any} onboarding @param {OverviewViewOptions} options
 * @param {(value: unknown) => string} [escA] */
function renderOverviewView(model, onboarding, options, escA = options.escapeAttribute) {
  const escapeText = options.escapeText;
  const when = (value) => {
    if (!value) return 'Never pulled';
    const date = new Date(value);
    return isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
  };
  const body = options.body;
  body.innerHTML = `<div class="ovtitle">${escapeText(model.name)}</div>`
    + `<div class="ovmeta">${model.sample ? 'Sample workspace - invented data' : `Last pull: ${escapeText(when(model.lastPull))}`}</div>`
    + (onboarding.visible ? `<section class="ovstart"><h3>Getting started</h3><div class="ovsteps">${onboarding.steps.map((step) => `<div class="ovstep ${escA(step.state)}" data-step="${escA(step.id)}"><i>${step.state === 'done' ? '✓' : step.state === 'current' ? '→' : ''}</i><b>${escapeText(step.label)}</b><small>${escapeText(step.detail)}</small></div>`).join('')}</div></section>` : '')
    + `<div class="ovgrid">${model.areas.map((area) => `<div class="ovcard"><div class="ovlabel">${escapeText(area.label)}</div>`
      + `<div class="ovcount">${area.count === null ? '—' : area.count}</div><div class="ovstate ${escA(area.status)}">${escapeText(OVERVIEW_STATE[area.status])}`
      + `${area.pulledAt ? ` · ${escapeText(when(area.pulledAt))}` : ''}</div></div>`).join('')}</div>`
    + (model.issues.length ? `<div class="ovissues">${model.issues.map((issue) => `<button class="ovissue" data-action="${escA(issue.action || '')}"${issue.action ? '' : ' disabled'}>${escapeText(issue.text)}${issue.action ? `<span>${escapeText(options.issueLabel(issue.action))} →</span>` : ''}</button>`).join('')}</div>` : '')
    + `<div class="ovactions"><button id="ovbrowse"${onboarding.nextAction === 'browse' ? ' class="next"' : ''}>Browse</button><button id="ovpull" class="zbtn${onboarding.nextAction === 'pull' ? ' next' : ''}"${model.sample ? ' hidden' : ''}>Pull all</button>`
    + `<button id="ovgraph" class="lbtn"${options.graphDisabled ? ' disabled' : ''}>${escapeText(options.graphLabel)}</button><button id="ovhealth" class="pbtn"${options.healthDisabled ? ' disabled' : ''}>Health</button></div>`;

  /** @param {string} selector */
  const button = (selector) => /** @type {HTMLButtonElement} */ (body.querySelector(selector));
  button('#ovbrowse').onclick = options.browse;
  button('#ovpull').onclick = options.pull;
  button('#ovgraph').onclick = options.graph;
  button('#ovhealth').onclick = options.health;
  body.querySelectorAll('.ovissue[data-action]').forEach((node) => {
    const issue = /** @type {HTMLButtonElement} */ (node);
    issue.onclick = () => options.issue(issue.dataset.action || '');
  });
}
