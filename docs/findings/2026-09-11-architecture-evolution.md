# 2026-09-11 — tranche di razionalizzazione architetturale

## What changed

- Declarative roles for the 69 distributed scripts, with a green and red self-test.
- Pure pull lifecycle with explicit states, operation ids and late-progress rejection.
- Immutable mirror plan that forbids deletion after an incomplete census.
- Common structured error model classified by area, retryability and UI key.
- External configuration check and transfer runbook with no secrets in the repository.
- Controlled read-only Zoho canary, inert without explicit environment variables and always checked
  against the reviewed nested contract fixture (an override is allowed only at execution time).
- Macro budgets for small, medium and large workspaces, using temporary directories.
- Battery updated to execute the new checks.

The independent review then found two integration defects in the new boundaries and both were
fixed before the final run: pull completion tried to skip required lifecycle states, and an HTTP
500 whose URL merely contained the digits `401` was misclassified as authentication. The controller
now closes through the explicit planning/writing/refreshing states (or fails on a real bad status),
and authentication matching uses the response status or a bounded status token.

## Deliberate limits

The live canary requires a synthetic organisation and credentials supplied at execution time; the
battery verifies only its dry-run path. The CRM monolith was not rewritten in one risky tranche: new
boundaries were added without changing behaviour. ES modules and React remain conditional on measurable
benefit.

## The rules it left behind

Every new module declares its role, follows the contracts and passes architecture, performance and
suite checks before it is connected to a page.

## Follow-up integration

The canary now has independent CRM and Analytics profiles, verifies the configured CRM org/instance
through the same instance-scoped read and org/CSRF headers as the bridge, keeps credentials out of
output, and compares nested response shapes against `tools/zoho-canary-contract.json` by default.
Strict contract entries can detect added fields and every array element is checked for later shape
variants. Analytics SQL pruning now receives the immutable mirror plan; an incomplete census cannot
authorize a deletion, and mirror comparisons use canonical key ordering. Bridge command/reply unions
and the error model cover the principal request variants and distinguish configuration, permission,
authentication and upstream failures.
