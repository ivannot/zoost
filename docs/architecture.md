# Architecture and boundaries

The declarative map in `tools/architecture.json` assigns every distributed CRM and Analytics script
to a role: domain, ports, application, adapters, UI or bootstrap. `tools/architecturecheck.py`
verifies that no file is unclassified or assigned twice and that pure modules do not introduce DOM,
network, Chrome, filesystem or IndexedDB effects.

The check is intentionally small: it does not replace semantic JavaScript review. It makes dependency
direction visible and blocks the most dangerous drift as soon as it is introduced.

## Operating rules

The target direction is UI → use cases → domain/ports → adapters, with browser APIs, Zoho,
filesystem and AI confined to adapter boundaries. The map is transitional: legacy controllers still
contain some UI-side effects, so the checker reports role ownership and protects the pure boundaries
but does not claim that every historical dependency has already moved. Functions shared by both
extensions remain deliberate and are governed by `tools/twincheck.py` and `tools/twins.txt`.

ES modules and React remain deferred: the runtime stays readable, dependency-free and build-free until
a pilot screen demonstrates a measurable net benefit.
