#!/usr/bin/env bash
# tools/totest.sh [destination]
#
# Copy the two extensions where the browser that loads them can see them.
#
# The repository lives on one machine and is never synced: git in a cloud-sync folder is a repo
# written file by file with no ordering, and the machine doing the work is the one that pays for it.
# What the other machine needs is not the repository - it is `apps/<app>/`, which is what Chrome reads
# when you load an unpacked extension. So that, and nothing else, goes into the synced folder.
#
# One direction, always. The destination is a **mirror**: `--delete` makes it match, so anything
# edited there is gone at the next run. Fix things in the repository; this is a copy.
#
# The destination is **not written down in this repository**, and that is the point. It is a property
# of one machine - a drive letter, a mount point, whichever cloud folder that machine syncs - so a
# path committed here is a path that is wrong on the next machine while looking perfectly right on
# this one. It lives in `tools/machine.env`, which is git-ignored, and every tracked file uses a
# placeholder; a test reads the values out of that file and fails if any of them has leaked into
# something tracked.
#
#   tools/machine.env       ZOOST_TEST_DIR='/path/to/the/synced/folder/zoost-test'
#
# `--auto` is how `tests/run.sh` calls it: do nothing, quietly, where there is nothing to do. Asked
# directly it says what is missing and how to fix it, because a copy that reports success over a
# folder it never wrote to is the failure this repository keeps naming.
set -euo pipefail
cd "$(dirname "$0")/.."

AUTO=''
[ "${1:-}" = '--auto' ] && { AUTO=1; shift; }

# Sourced, not parsed: it is a shell file on the author's own machine, and quoting the value there is
# the whole of its syntax.
#
# An argument wins over the environment, and the environment wins over the file - a value passed on
# purpose must not be replaced by the machine's own default. Sourcing alone got that backwards, and
# the two cases that pass a destination through the environment went green while copying to the real
# folder: the check said "silent when there is nothing to do" about a run that had just mirrored two
# extensions.
ENV_DEST="${ZOOST_TEST_DIR:-}"
[ -f tools/machine.env ] && . tools/machine.env
[ -n "$ENV_DEST" ] && ZOOST_TEST_DIR="$ENV_DEST"

DEST="${1:-${ZOOST_TEST_DIR:-}}"
if [ -z "$DEST" ]; then
  [ -n "$AUTO" ] && exit 0
  echo "no destination for the extensions. Write it once, in tools/machine.env (not tracked):"
  echo "  ZOOST_TEST_DIR='/path/to/the/synced/folder/zoost-test'"
  echo "or pass the destination as an argument."
  exit 1
fi
if [ ! -d "$(dirname "$DEST")" ]; then
  [ -n "$AUTO" ] && exit 0
  echo "$(dirname "$DEST") does not exist - the synced folder is not mounted on this machine,"
  echo "  or ZOOST_TEST_DIR in tools/machine.env is stale."
  exit 1
fi
mkdir -p "$DEST/apps"

# The destination is very likely a cloud-sync filesystem, and those are not ordinary ones: Google
# Drive's virtual drive refuses `chgrp` and refuses the temporary files rsync writes before renaming
# them into place. So no attributes are preserved (`-rlt` and not `-a`) and the write is `--inplace`.
# `cp -R` is the fallback for a machine with no rsync, and also for the day a destination refuses
# something else - a copy that works beats a copy that is clever.
if command -v rsync >/dev/null &&
   rsync -rlt --delete --no-perms --no-owner --no-group --inplace \
         apps/crm apps/analytics "$DEST/apps/" 2>/dev/null; then
  :
else
  rm -rf "$DEST/apps/crm" "$DEST/apps/analytics"
  cp -R apps/crm apps/analytics "$DEST/apps/"
fi

printf '%s\n' "$DEST/apps/crm" "$DEST/apps/analytics"
echo "  $(git rev-parse --short HEAD)$([ -n "$(git status --porcelain apps/)" ] && echo ' + uncommitted changes under apps/')"
