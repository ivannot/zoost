# Panel I/O and Zoho adapters — 7 September 2026

## What was concentrated

The CRM panel still implemented three independent boundaries inside `sidepanel.js`: workspace file
access, Chrome tab/frame discovery and Zoho-page navigation. Each boundary mixed long-lived panel
state with mechanics that have their own invariants. The same filesystem mechanics were also copied
inside Analytics.

Moving small pure helpers would have reduced the line count without changing that concentration.
Instead, the extraction followed complete responsibilities and left policy at the caller: the panel
still decides which workspace is current, what a write invalidates, whether an org matches and what
status sentence is shown.

## What changed

`filesystem-adapter.js` now owns permission checks, directory-handle caching and guarded reads,
writes, directory creation and removals in both products. `beginOperation()` captures both the root
handle and generation, checks them before and after every asynchronous filesystem action, and scopes
progress to that operation. Cache invalidation remains a callback supplied by the panel and still
runs only after a successful write or removal.

CRM's `zoho-bridge.js` now owns active-tab discovery, CRM-frame enumeration, hit-only frame caching,
bounded bridge injection and message transport. It receives the mismatch policy, identity projection
and reply validation from the panel. `zoho-navigation.js` owns URL construction, the manifest-derived
host allow-list and frame-aware navigation with the existing tab fallback.

The shipped page loads these readable classic scripts before `sidepanel.js`; there is no dependency,
bundler or generated runtime. The panel tests execute the adapter factories with refusing filesystem
handles, multi-frame tabs, missing frames and hostile destinations rather than requiring the logic to
remain physically inside `sidepanel.js`.

## Measured result

CRM `sidepanel.js` fell from 7,016 to 6,639 lines in this pass (471 lines below the 7,110-line point
before the preceding pull-controller extraction). Analytics fell from 3,416 to 3,338 lines. The
important reduction is four boundary responsibilities removed from the CRM orchestrator, not the
number of files created.

Checked JSDoc now covers 12 CRM modules and 8 Analytics modules. The full Node suite runs 1,103
cases; the browser probe and repository gates exercise the composed pages and packages. The manual
release catalogue derives coverage for every new shipped file.

## What deliberately did not change

The public APIs of the panel helpers and all user-visible flows remain the same. The two filesystem
adapters are kept byte-identical but physically present in each independently packaged extension,
under the repository's existing twin rule. Analytics' Zoho bridge and navigation were not forced
through CRM abstractions: their platform behavior is not identical.

A generic JSON/mirror contract was considered and rejected from this pass. It removed almost no
orchestration, widened the behavioral change and made lifted tests depend on a new parsing layer.
That is line movement rather than useful separation.

React remains unjustified. These boundaries are browser and filesystem orchestration, not component
rendering; a framework would not remove them and would add a build/runtime maintenance surface.

## The rules it left behind

- Extract a boundary only when the new module owns its invariants end to end; moving a few helpers is
  not modularisation.
- Keep policy at the composition root and inject it: current workspace, mismatch decisions, cache
  invalidation and user-facing messages still belong to the panel.
- A filesystem adapter must guard identity on both sides of every await and report a write only after
  the browser has completed it.
- Frame discovery may cache a verified hit, never a miss, and bridge injection may target only frames
  discovered on the product's own origin.
- A refactor's tests follow the executable subject to its new boundary; the old file location is not
  a product contract.
