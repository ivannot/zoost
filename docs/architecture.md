# Architecture and boundaries

The declarative map in `tools/architecture.json` assigns every distributed CRM and Analytics script
to a role: domain, ports, application, adapters, UI or bootstrap. `tools/architecturecheck.py`
verifies that no file is unclassified or assigned twice and that pure modules do not introduce DOM,
network, Chrome, filesystem or IndexedDB effects. It also checks that every panel script exists exactly
once and that required composition-root ordering is preserved.

The check is intentionally conservative: it does not replace semantic JavaScript review or prove every
classic-script global. It makes declared direction and load-time composition visible, and blocks missing
providers, duplicate scripts and the most dangerous pure-boundary drift as soon as it is introduced.

## Operating rules

The target direction is UI → use cases → domain/ports → adapters, with browser APIs, Zoho,
filesystem and AI confined to adapter boundaries. The map is transitional: legacy controllers still
contain some UI-side effects, so the checker reports role ownership and protects the pure boundaries
but does not claim that every historical dependency has already moved. Functions shared by both
extensions remain deliberate and are governed by `tools/twincheck.py` and `tools/twins.txt`.

Analytics view derivations now live in `analytics-view-model.js` and receive snapshots explicitly; the
panel retains stateful wrappers and presentation wiring. ES modules and React remain deferred: the
runtime stays readable, dependency-free and build-free until a pilot screen demonstrates a measurable
net benefit.
