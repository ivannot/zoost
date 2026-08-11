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

# `rsync` is in the WSL image and on macOS; `cp -R` is the fallback that keeps this working anywhere.
if command -v rsync >/dev/null; then
  rsync -a --delete apps/crm apps/analytics "$DEST/apps/"
else
  rm -rf "$DEST/apps/crm" "$DEST/apps/analytics"
  cp -R apps/crm apps/analytics "$DEST/apps/"
fi

printf '%s\n' "$DEST/apps/crm" "$DEST/apps/analytics"
echo "  $(git rev-parse --short HEAD)$([ -n "$(git status --porcelain apps/)" ] && echo ' + uncommitted changes under apps/')"
