# React pilot for Workspace Overview

## Question

Would React make the new onboarding and Workspace Overview materially easier to maintain than the
plain-JavaScript boundary already in the two extensions?

## What was executed

The pilot was built in a temporary directory, not in this repository. It used React and React DOM
19.2.8 with esbuild 0.28.2. The component received the same two inputs as the shipped view:

- an Overview model containing areas, unknown counts and actionable issues;
- an onboarding model containing the three steps and their states.

It rendered the component in Chrome under the extensions' exact content-security policy. The input
included HTML metacharacters in the workspace name and issue text, an unknown count, and a Pull
action. Chrome produced escaped text, retained the unknown count as `—`, drew all three onboarding
states, and the real button click reached the Pull handler (`data-clicked="pull"`). A separate server
render asserted the same four properties.

## Measured result

| Measurement | Result |
|---|---:|
| Pilot component source | 1,990 bytes |
| Minified browser bundle | 195,146 bytes |
| React runtime files used by the server-render probe | 300,918 bytes |
| Temporary installed packages | 7,640 KiB |
| Shipped runtime added by the current native implementation | 0 bytes |
| Native Overview model, onboarding, action contract and renderer | 6,826 bytes CRM / 7,441 bytes Analytics |

The source-size comparison is intentionally not presented as equivalent: the native figures include
filesystem facts and action wiring that the React component still needs outside the component. The
bundle figure is the relevant product cost; it is paid before React replaces any of those adapters.

## Decision

Do not add React now. The experiment proved that React can render and dispatch this view under the
MV3 policy, but it did not demonstrate a maintenance benefit large enough to justify a build step,
about 195 KB of shipped runtime, or the loss of the repository's dependency-free audit path.

Keep the UI-independent boundary that made the experiment small:

- `workspaceOverviewModel()` owns local coverage semantics;
- `workspaceOnboardingModel()` owns the first-use sequence;
- `workspaceOverviewAction()` is the closed action contract;
- the panel owns DOM rendering and product adapters only.

Repeat the experiment only if at least three independently stateful views need the same component
system, or if a larger team accepts a reproducible build pipeline as an explicit product tradeoff.
Until then, JSDoc contracts and extraction of pure state provide the useful part without changing
what the extensions ship.

## The rules it left behind

A framework enters the shipped extensions only after an executed pilot demonstrates a concrete
maintenance benefit that outweighs its runtime, build and audit costs. Compatibility by itself is
not sufficient evidence for adoption.
