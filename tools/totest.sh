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
# The destination defaults to Google Drive as mounted inside WSL, and `ZOOST_TEST_DIR` overrides it -
# the path is a property of one machine, not of this project.
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="${1:-${ZOOST_TEST_DIR:-/mnt/g/My Drive/zoost-test}}"
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
