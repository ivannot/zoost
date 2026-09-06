# Onboarding and operational Overview

## What changed

Both extensions now derive the first-use path from facts instead of a dismissed-tutorial flag. A new
real workspace points to Pull all, the sample points to Browse, and an established real workspace is
not forced through onboarding again. Overview issues are structured values with a closed action
contract and lead to the control that can repair or inspect them.

The pure workspace modules now opt into `@ts-check` and declare the workspace-entry, coverage,
onboarding and issue-action contracts with JSDoc. TypeScript 7.0.2 was run temporarily with
`--allowJs --checkJs --noEmit` against each module; both completed with no diagnostics. TypeScript is
not a repository dependency and no build step was added.

## Defect found while re-reading the finished path

The CRM Overview button said **Pull all** and called `pullAll()`, which pulls functions only. The
sample browser path could not reveal it because Pull all is correctly hidden for a sample. A runtime
test invoked the real rendered button and observed zero calls to `pullEverything()` and one call to
the functions-only path. The button now calls `pullEverything()`; the same test observes one full
pull and zero functions-only calls.

This is also why the new actionable issue contract resolves `pull` to the product's whole-workspace
entry point, never to a similarly named lower-level function.

## Verification retained

- model cases distinguish new, sample and returning workspaces;
- unknown counts remain unknown;
- only declared issue actions can resolve;
- the CRM Overview Pull all button reaches the whole-workspace pull;
- the browser probe requires the sample's three steps, completed invented mirror and highlighted
  Browse action in both products;
- the guides describe the same first-use path in English and Italian.

The separate React experiment and its decision are recorded in
[`2026-09-06-react-overview-pilot.md`](2026-09-06-react-overview-pilot.md). The external five-person
study is specified in [`../usability.md`](../usability.md); no session is claimed until a real person
has been observed.

## The rules it left behind

A control named **Pull all** must be tested through its rendered click and must reach the
whole-workspace entry point. Exercising a lower-level pull directly, or testing only a sample where
the control is hidden, does not verify that promise.
