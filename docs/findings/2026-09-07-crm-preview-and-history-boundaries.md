# CRM preview and history boundaries — 7 September 2026

## What remained concentrated

After pull, workspace and live reconciliation had moved out, `apps/crm/sidepanel.js` still
implemented the complete item-preview surface and the browser-like navigation history. That kept
file-tree projection, detail rendering, selection, keyboard movement and history replay interleaved
with the composition root, even though each already had a stable behavioural boundary.

## What changed

`preview-model.js` now contains the pure, statically checked projection from a function row to the
file and directory set shown in the preview. `preview-controller.js` owns the preview header, project
tree, item detail, selection and keyboard stepping. `history-controller.js` maps the existing pure
navigation state to CRM items and to the history overlay.

The scripts still ship as readable classic JavaScript. They are loaded before `sidepanel.js`, expose
only state and callable functions while loading, and leave DOM event binding and startup in the
composition root. The panel test harness reads the script order from `sidepanel.html`, so moving a
function does not weaken a behavioural assertion or create a second hand-maintained runtime list.

## Measured result

CRM `sidepanel.js` fell from 4,968 to 4,005 lines in this tranche: 963 lines left the composition
root. From the 7,110-line baseline before the controller work, 3,105 lines have moved behind complete
responsibility boundaries, a reduction of 43.7%. The CRM extension now ships 39 JavaScript files;
the pure preview model is the thirteenth CRM module checked by the static-contract gate.

The focused panel suite passes all 851 cases. All six driven browser paths — both panels, both pull
flows and both diagram windows — complete without a page exception. The manual-check inventory now
maps preview and history to those same item-opening and navigation paths instead of treating a new
source file as unobserved.

## What deliberately did not change

No user workflow, persisted format, permission, reachable host or Zoho request changed. The move
does not add a build step, generated runtime or dependency.

React was not introduced. This tranche removed responsibility and state ownership from a large
file using the runtime already shipped. There is no measured evidence that a framework would make
these controllers smaller, safer or faster; adding one now would increase the dependency and build
surface without addressing a remaining product problem. It stays a future experiment only for a
new, isolated and state-heavy UI whose native implementation can be compared against it.

## The rules it left behind

- A preview controller owns the complete path from a selected item to its rendered detail; its pure
  file projection remains independently checkable.
- Browser-like history is an adapter around navigation state, not composition-root state.
- A classic script loaded before the composition root declares state and functions only; the root
  owns DOM binding and startup order.
- Runtime composition is derived from the HTML page; tests and probes do not maintain shadow script
  lists.
- A framework is adopted only after an isolated comparison demonstrates a product or maintenance
  benefit greater than its build and dependency cost.
