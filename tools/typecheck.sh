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
  # `git grep` is present anywhere this repository can be checked out. `rg` is convenient locally
  # but is not part of GitHub's runner contract, and made the first official execution of this gate
  # fail before TypeScript could read a file.
  files=$(git grep -l '^// @ts-check' -- "apps/$app/*.js" | sort)
  if [ -z "$files" ]; then
    echo "$app: no @ts-check modules found" >&2
    exit 1
  fi
  # The two extensions are separate classic-script worlds. Checking them together would invent
  # duplicate globals that no browser page ever loads together.
  npx --yes --package "typescript@$TYPESCRIPT_VERSION" tsc \
    --allowJs --checkJs --noEmit --skipLibCheck --target ES2022 --lib ES2022,DOM $files
  echo "$app: $(printf '%s\n' "$files" | wc -l | tr -d ' ') contract module(s)"
done
