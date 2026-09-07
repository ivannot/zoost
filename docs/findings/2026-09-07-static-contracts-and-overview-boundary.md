# Static contracts and Overview have executable boundaries

The checked JSDoc introduced in the pure panel modules was being run by hand. A contract that CI
never reads can decay while the official battery stays green. `tools/typecheck.sh` now derives every
`// @ts-check` file, checks CRM and Analytics as separate classic-script worlds with TypeScript
5.9.2, and emits nothing. The push workflow runs it after the dependency-free battery. There is
still no package manifest, installed runtime dependency or generated extension file.

The first clean-run execution also removed an environmental assumption from the gate itself: the
GitHub runner did not contain `rg`, so discovery now uses `git grep`, which is supplied by the same
checkout the command is inspecting. The failed run occurred after the product battery had passed and
before TypeScript ran; the replacement was exercised locally and then by a new remote run.

The Workspace Overview had a model boundary but left its markup and event wiring duplicated inside
both orchestration files. Each app now owns an app-local, byte-identical `overview-view.js`. It
receives a model, escaping functions, current control state and callbacks; it reads no Chrome,
filesystem, Zoho or workspace global. The existing browser probe executes the composed page, so the
new script order is checked in the product rather than inferred from source.

CRM's Pull all also asked four policy questions inside the stateful panel: explicit recheck,
permission verdict, pull preference and the verdict timestamp. `pull-plan.js` now turns one snapshot
of those facts into an immutable plan before the first await, and separately derives which rechecks
were actually answered. The panel still owns status, filesystem writes and Zoho adapters; the pure
module owns only the decision that must not move during a run.

The public source counts moved to 28 CRM scripts and 22 Analytics scripts. The site, translations,
surface inventory, manual-check coverage and twin ledger moved with them. The newly recorded twin is
deliberate app-local ownership, not a shared runtime dependency.

The release gap reported against the previous audit was rechecked rather than acted on: the remote
already carries `crm-v1.49.0` and `analytics-v1.31.0`, both at the commit their manifests describe.
No new release was cut. Repository rules require an explicitly named product and manual evidence on
a real organisation before tagging.

Real multi-data-centre Zoho response fixtures were not invented. No captured, anonymised responses
were available in this checkout, and synthetic objects would not prove the external contract the
recommendation is about. Existing shape validation remains in both bridges; adding a fixture set is
blocked on real, sanitised inputs rather than on code.

React remains excluded. The existing executed pilot found runtime and build cost without removing
the adapters changed here, while the native extraction achieved the boundary with no shipped
dependency.

## The rules it left behind

An opt-in contract enters the official gate in the same act, a view receives facts and actions
instead of reaching into product state, and a long-running operation decides its plan once before
its first await. External contract fixtures come from measured, anonymised responses rather than
objects invented to make a test exist.
