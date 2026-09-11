# Architecture closure pass — 2026-09-11

This pass closes the concrete gaps identified against `acf834e987e23202c88127daa8b8a9b1b1670880`.

## The rules it left behind

Every architectural safeguard introduced here must be enforced at the production boundary, fail
closed when its required dependency is missing, and be covered by a test that first demonstrates the
unprotected behaviour.  A passing unit test is not evidence that an otherwise unused scaffold
governs the shipped flow.

- Canary records are now verified per product, against the current contract digest and exact ordered
  route set; stale, incomplete, duplicated or unsuccessful records are rejected.
- Mirror plans reject unsafe paths and are required before destructive work; CRM bootstrap and the
  Analytics pull require an available lifecycle instead of silently continuing without one.
- Bridge adapters reject malformed envelopes even when loaded in isolation, and response validators
  check stable payload containers and identities.
- Analytics pull transitions enter planning, writing and refreshing at the real stage boundaries.
- Analytics view derivations are in `analytics-view-model.js`, a pure module with explicit snapshots;
  the panel keeps only stateful wrappers.
- The architecture checker validates panel script existence, uniqueness and composition order. The
  performance budget writes a realistic temporary mirror and reports file/byte work separately from
  fixture generation.
- Canary bases are restricted to HTTPS Zoho hosts for the selected product, unknown `--app` values
  fail even in dry-run mode, and Analytics context replies are validated before entering panel state.

The live Zoho canary remains `never-run`: credentials and a controlled synthetic organisation are not
available in this environment, so no live evidence is fabricated.
