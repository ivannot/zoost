#!/usr/bin/env bash
# Static contracts for the plain-JavaScript modules that opt in with `// @ts-check`.
#
# This is deliberately a CI/development check, not a build: it emits nothing, changes nothing under
# apps/, and leaves the extensions dependency-free. The compiler version is part of the command so
# a newer TypeScript release cannot silently change the gate.
set -euo pipefail
cd "$(dirname "$0")/.."

TYPESCRIPT_VERSION=5.9.2
GLOBALS=tools/typecheck-globals.d.ts

# Analytics' application and integration boundary is now closed: every module that participates in
# pull, mirror, bridge, lifecycle, workspace or persistence contracts is listed here. DOM-only
# surfaces (the two graph windows, options and the legacy panel renderer) remain outside this gate
# until they are converted to explicit modules; they do not define application contracts. Keeping
# that boundary in a versioned manifest prevents the denominator from silently shrinking back to
# whichever files happen to carry a comment.
ANALYTICS_BOUNDARY=(
  analytics-sql.js analytics-mirror-writer.js analytics-view-model.js bootstrap.js bridge-contract.js
  content-bridge.js error-model.js filesystem-adapter.js idb.js keyvault.js list-model.js mirror-plan.js
  navigation.js pull-adapter.js pull-lifecycle.js pull-usecase.js search-state.js workspace.js
)
ANALYTICS_DOM_ONLY=(
  ai.js background.js export.js graphlogic.js graphview.js health.js highlight.js options.js
  overview-view.js product-help.js report.js reportshell.js sample-org.js sidepanel.js
)

for app in crm analytics; do
  # Plain `grep` is present on the GitHub runner and, unlike `git grep`, sees a new opted-in module
  # before it has been staged. That makes the local gate test the same files the next commit ships.
  if [ "$app" = analytics ]; then
    all="$(for path in apps/analytics/*.js; do basename "$path"; done | sort)"
    declared="$(printf '%s\n' "${ANALYTICS_BOUNDARY[@]}" "${ANALYTICS_DOM_ONLY[@]}" | sort)"
    [ "$all" = "$declared" ] || { echo "analytics: typecheck scope does not account for every script" >&2; diff -u <(printf '%s\n' "$all") <(printf '%s\n' "$declared") >&2 || true; exit 1; }
    files=""
    for name in "${ANALYTICS_BOUNDARY[@]}"; do
      path="apps/analytics/$name"
      [ -f "$path" ] || { echo "analytics: boundary module missing: $path" >&2; exit 1; }
      grep -q '^// @ts-check' "$path" || { echo "analytics: boundary module is not @ts-check: $path" >&2; exit 1; }
      files+="$path"
      files+=$'\n'
    done
  else
    files=$(grep -l '^// @ts-check' apps/"$app"/*.js | sort || true)
  fi
  if [ -z "$files" ]; then
    echo "$app: no @ts-check modules found" >&2
    exit 1
  fi
  # The two extensions are separate classic-script worlds. Checking them together would invent
  # duplicate globals that no browser page ever loads together.
  #
  # `DOM.Iterable` because without it `for (const el of qsa(...))` - which every panel writes - is an
  # error on correct code, and a gate that refuses what the product legitimately does is one somebody
  # works around: the next module to iterate a NodeList would have been opted *out* to get green.
  # Measured by planting that loop in an opted-in module and reading the exit code: 2 before, 0 after.
  npx --yes --package "typescript@$TYPESCRIPT_VERSION" tsc \
    --allowJs --checkJs --noEmit --skipLibCheck --target ES2022 --lib ES2022,DOM,DOM.Iterable "$GLOBALS" $files
  # The count names a deliberate boundary. Analytics' application, bridge, persistence and pure
  # model modules are an explicit 18/18 contract set; DOM-only surfaces remain outside until they
  # are converted to modules with their own contracts. CRM retains its incremental opt-in list.
  # This is not a claim that every line of UI is typed: it is a gate that cannot silently lose a
  # required application module when a file is renamed or a script tag is removed.
  if [ "$app" = analytics ]; then
    echo "analytics: $(printf '%s\n' "${ANALYTICS_BOUNDARY[@]}" | wc -l | tr -d ' ') / $(printf '%s\n' "${ANALYTICS_BOUNDARY[@]}" | wc -l | tr -d ' ') boundary module(s) checked (100%); all $(printf '%s\n' "$all" | sed '/^$/d' | wc -l | tr -d ' ') scripts classified, DOM-only surfaces remain outside the contract gate"
  else
    echo "$app: $(printf '%s\n' "$files" | wc -l | tr -d ' ') of $(ls apps/"$app"/*.js | wc -l | tr -d ' ') script(s) opted in;" \
         "their internals and the calls between them are checked, call sites in the rest are NOT"
  fi
done
