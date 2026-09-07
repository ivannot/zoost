# CRM panel responsibility slices — 7 September 2026

## What remained concentrated

After the I/O and Zoho adapters were extracted, `apps/crm/sidepanel.js` still owned three complete
subsystems that did not belong to its composition role: the working-folder/workspace lifecycle, the
live-page reconciliation state machine, and the persisted export-scope dialog. Their state and
handlers were interleaved with function browsing and pull composition, leaving the file at 6,639
lines even though the lower-level boundaries had moved out.

## What changed

`workspace-controller.js` now owns choosing and re-granting the working folder, enumerating,
activating, creating, naming and removing workspaces, and materialising the sample. It remains the
stateful counterpart of the pure contracts in `workspace.js`.

`live-sync.js` now owns notices from the Zoho page, single-flight reconciliation, per-function
refresh and deferred work at the end of a pull. A page notice remains only a hint: the controller
re-reads Zoho before it mutates the local mirror.

`export-scope.js` owns the stored export policy and the modal that edits one export. `export.js`
therefore receives a frozen scope and workspace snapshot and contains only report loading,
construction and writing. The first attempt placed both responsibilities in `export.js`; the
late-global checker rejected that boundary, and the policy/UI code was separated rather than
weakening the checker.

The panel test harness now resolves historical `sidepanel.js` subjects against the scripts actually
loaded by `sidepanel.html`. A moved subject still fails when absent from the composed application,
but changing its file no longer turns a behavioural test into a file-layout test.

## Measured result

CRM `sidepanel.js` fell from 6,639 to 4,968 lines in this tranche: 1,671 lines removed from the
composition root, and 2,142 below the 7,110-line baseline before the pull-controller work. The
extension still ships readable classic JavaScript with no dependency, bundler or generated runtime.

The application now has 36 CRM JavaScript files and 24 Analytics files. The public verification
pages and the Italian translations derive and state those counts. The panel suite passes all 851
cases, including composed-script evaluation and the workspace/pull race cases. The browser probe
initially caught an extracted controller starting its remembered-sample read before `sidepanel.js`
had declared the shared workspace state. Startup was moved back to the composition root, as were the
eight DOM bindings, and the fixture shim is now inserted after `idb.js` rather than immediately
before the historically monolithic file. All six driven CRM/Analytics panel and diagram paths then
completed without a page exception.

## What deliberately did not change

No user-visible workflow, stored format, permission, host or Zoho request changed. The modules share
the existing classic-script scope because replacing the runtime architecture in the same change
would mix a behavioural migration into a responsibility-only refactor.

React was not introduced. The removed complexity was lifecycle and asynchronous orchestration, not
repeated component rendering; React would add a build and dependency surface without simplifying
these boundaries.

## The rules it left behind

- A composition root coordinates complete use cases; it does not own their folder lifecycle,
  reconciliation state machine or preference dialog.
- Export policy and export construction are separate subjects: the first may read UI preferences,
  while the second must write from a snapshot taken before its asynchronous work begins.
- Tests about a composed classic-script page follow the page's declared script set; only tests about
  a file format or file-local invariant name an implementation file.
- An extracted classic script loaded before the composition root may declare functions and state,
  but it may not start asynchronous work or bind the DOM before that root has finished declaring the
  shared program.
- When an existing checker rejects a proposed module boundary, repair the boundary before considering
  a narrower checker.
- A framework is adopted only when the complexity it removes is UI complexity visible in the code,
  not as a reward for reducing a large file.
