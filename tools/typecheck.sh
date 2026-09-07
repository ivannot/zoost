#!/usr/bin/env bash
# Static contracts for the plain-JavaScript modules that opt in with `// @ts-check`.
#
# This is deliberately a CI/development check, not a build: it emits nothing, changes nothing under
# apps/, and leaves the extensions dependency-free. The compiler version is part of the command so
# a newer TypeScript release cannot silently change the gate.
set -euo pipefail
cd "$(dirname "$0")/.."

TYPESCRIPT_VERSION=5.9.2

for app in crm analytics; do
  # Plain `grep` is present on the GitHub runner and, unlike `git grep`, sees a new opted-in module
  # before it has been staged. That makes the local gate test the same files the next commit ships.
  files=$(grep -l '^// @ts-check' apps/"$app"/*.js | sort || true)
  if [ -z "$files" ]; then
    echo "$app: no @ts-check modules found" >&2
    exit 1
  fi
  # The two extensions are separate classic-script worlds. Checking them together would invent
  # duplicate globals that no browser page ever loads together.
  npx --yes --package "typescript@$TYPESCRIPT_VERSION" tsc \
    --allowJs --checkJs --noEmit --skipLibCheck --target ES2022 --lib ES2022,DOM $files
  # **The count, its denominator, and what it does not read.** «13 contract module(s)» said nothing
  # about the 26 it skips, which is the shape this project already names: a headline that counts what
  # was opened and is silent about what was examined. The denominator is derived by a cruder method
  # than the check itself - a plain file count - so it cannot drift with the checker's own idea of
  # what a module is.
  #
  # The stated limit, because a limit that is not written down is a blind spot: this checks each
  # opted-in module's internals and the calls *between* opted-in modules. It does not read the call
  # sites in the files that are not opted in, which is where the wiring lives - a wrong argument
  # passed from `sidepanel.js` is invisible here and caught only by the same call inside a checked
  # module. Measured, not assumed.
  echo "$app: $(printf '%s\n' "$files" | wc -l | tr -d ' ') of $(ls apps/"$app"/*.js | wc -l | tr -d ' ') script(s) opted in;" \
       "their internals and the calls between them are checked, call sites in the rest are NOT"
done
