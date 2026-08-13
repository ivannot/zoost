#!/usr/bin/env bash
# tools/totest.sh [--auto|--force] [destination]
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
# of one machine - a drive letter, a mount point, whichever folder that machine shares - so a path
# committed here is a path that is wrong on the next machine while looking perfectly right on this
# one. It has already moved once, from a cloud-sync folder to a share on the network, and nothing in
# this file changed with it. It lives in `tools/machine.env`, which is git-ignored, and every tracked file uses a
# placeholder; a test reads the values out of that file and fails if any of them has leaked into
# something tracked.
#
#   tools/machine.env       ZOOST_TEST_DIR='/path/to/the/folder/the/browser/can/see'
#
# `--auto` is how `tests/run.sh` calls it: do nothing, quietly, where there is nothing to do. Asked
# directly it says what is missing and how to fix it, because a copy that reports success over a
# folder it never wrote to is the failure this repository keeps naming.
set -euo pipefail
cd "$(dirname "$0")/.."

AUTO=''
[ "${1:-}" = '--auto' ] && { AUTO=1; shift; }

# `--force` rewrites every file even when the content already matches. The recovery path for the one
# thing this script cannot see: whether the sync client on the other side of that folder actually
# noticed. Writing only what changed is right - it is what stopped two dozen delete-and-recreate
# cycles a day - but it has a tail: a write the client missed is never made again, because there is
# nothing left to write. This regenerates the change events without deleting anything, which is the
# difference between it and the fallback below.
# It has to *replace* the comparison, not add to it: `--ignore-times` alongside `--checksum` still
# skips a file whose content matches, which is every file in the case this exists for.
COMPARE='--checksum'
[ "${1:-}" = '--force' ] && { COMPARE='--ignore-times'; shift; }

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
  echo "  ZOOST_TEST_DIR='/path/to/the/folder/the/browser/can/see'"
  echo "or pass the destination as an argument."
  exit 1
fi
if [ ! -d "$(dirname "$DEST")" ]; then
  # A destination is configured and it is not there. That is *not* «nothing to do» - it is the one
  # thing this script exists for, not happening - so it is said even in --auto, in one line and
  # without failing the battery. The distinction is the whole of it: no destination at all is a
  # machine that never asked for a mirror and stays quiet; a destination that has gone missing is a
  # mirror that has quietly stopped being written, and the extension on the other machine is then
  # tested at whatever version it last received. Which was the state this repository was actually in
  # for a whole afternoon, while the battery printed «not mirrored» and no reason.
  echo "$(dirname "$DEST") is not mounted" >&2
  [ -n "$AUTO" ] && exit 0
  echo "  the synced folder is not mounted on this machine, or ZOOST_TEST_DIR in tools/machine.env is stale." >&2
  exit 1
fi
# And the check above cannot see the state that actually happened. With `x-systemd.automount` the
# mount point answers stat() whether or not the mount behind it works: the kernel triggers the mount
# on the first access, and when the host's sync client is not running the device is simply absent -
# «special device ... does not exist», in the journal and nowhere this script can see - leaving an
# empty directory that is a directory by every test it can make. So `-d` passes, and what fails is
# the first write.
#
# Left to `set -e` that failure leaves the battery printing a raw mkdir error, which reads as this
# script being broken rather than as the mirror not being written. It is the same distinction as
# above and gets the same treatment: one line saying which of the two it is, and never a failure of
# the battery, because a cloud drive that is not running is not a defect in this repository.
#
# **The question is asked with a write, and only once something has already gone wrong.** It used to
# be `mkdir -p "$DEST/apps"`, which wrote only by accident - that layer did not exist yet - and with
# the extensions now at the top of the folder there is nothing left to create, so `mkdir -p` succeeds
# without touching the filesystem and would answer "yes" for a share gone read-only and for the empty
# directory an automount leaves behind.
#
# A file created and removed does answer it, and doing that on every run is the wrong place for it:
# the far side of this folder is watched by a sync client, so a probe on the happy path is two events
# per battery run, forwarded to another machine, about a question nobody asked. The copy below is
# itself a write - when it works there was nothing to establish - so the probe lives in the failure
# branch, where it separates «this share cannot be written» from «rsync could not do it this way».
probe_writable() { ( : > "$DEST/.zoost-writable" ) 2>/dev/null && rm -f "$DEST/.zoost-writable"; }
mkdir -p "$DEST" 2>/dev/null || true

# The destination is very likely a cloud-sync filesystem, and those are not ordinary ones: Google
# Drive's virtual drive refuses the temporary files rsync writes before renaming them into place, and
# it refuses to set a file's times at all. So the write is `--inplace`, no attributes are preserved,
# and - the part that was wrong - **times are not asked for**.
#
# `-rlt` asked for them, so rsync failed on every single file with «failed to set times: Operation not
# permitted», returned non-zero, and the fallback below ran *every time*: a full `rm -rf` of both
# extensions followed by a fresh copy. Nothing reported it, because the errors went to /dev/null and
# the fallback is silent. Once this copy became automatic - once per battery run - that was two dozen
# delete-and-recreate cycles a day on a synced folder, and the folder is genuinely empty inside each
# one. It was noticed by the author, looking at Drive on the other machine and finding crm gone.
#
# Without times, rsync's usual size-and-date shortcut cannot work either, so it compares content:
# `--checksum` on fifty small files costs nothing and copies only what actually changed. A second run
# writes nothing at all, which is what a sync folder should see.
#
# **`--delete` reaches inside the directories being transferred and no further**, which is what makes
# writing into a folder that also holds other things safe - measured rather than assumed, because the
# destination stopped having a layer of its own to be scoped by: a bystander file left beside the two
# extensions survives, a file removed from an app is removed from its copy. The version of this
# comment that claimed otherwise was written first and disproven in ten seconds; a test now holds the
# behaviour, since the guarantee is rsync's and not ours.
RSYNC_FLAGS="-rl --delete $COMPARE --no-perms --no-owner --no-group --no-times --inplace -i"
COPIED=''
if command -v rsync >/dev/null &&
   COPIED=$(rsync $RSYNC_FLAGS apps/crm apps/analytics "$DEST/" 2>/dev/null); then
  :
else
  # Which of the two failures is it? A share that cannot be written is not a defect in this
  # repository and must not read as one - and falling back would then `rm -rf` two folders it cannot
  # replace, which is the worst available answer.
  if ! probe_writable; then
    echo "$(dirname "$DEST") is there but nothing usable is mounted on it - the share is unreachable, or the sync client on the host is not running" >&2
    [ -n "$AUTO" ] && exit 0
    echo "  bring it back, then run this again. Nothing was copied." >&2
    exit 1
  fi
  # Loud, because it deletes: whoever is watching that folder should know why it emptied.
  echo "  rsync could not write there, falling back to delete-and-copy" >&2
  rm -rf "$DEST/crm" "$DEST/analytics"
  cp -R apps/crm apps/analytics "$DEST/"
  COPIED='(everything)'
fi

# The other thing that has to reach a machine with a browser on it: the screenshots that go on the
# two Store listings. `tools/shots.py` renders them into `dist/store/<app>/1..5.png` - the whole of
# what `dist/` keeps between runs - and uploading them means opening one folder and taking what is in
# it, which cannot be done from the machine that renders them.
#
# Only ever copied when they exist. A run that has not rendered any leaves whatever is over there
# alone rather than deleting it: the last rendered set is the one that was uploaded, and an empty
# folder would say "nothing to upload" about a listing that has images on it.
#
# The same two ways of writing, because a destination that refuses rsync refuses it for these too -
# and the first version of this copied the extensions by hand and left the images to an rsync that
# was not going to run, so they would have gone missing without a word on exactly the destination the
# fallback exists for. Found by running the suite on a machine with no rsync at all.
IMGS=''
if [ -d dist/store ]; then
  if [ "$COPIED" != '(everything)' ] && out=$(rsync $RSYNC_FLAGS dist/store/ "$DEST/store/" 2>/dev/null); then
    COPIED="$COPIED$out"
  else
    rm -rf "$DEST/store"
    cp -R dist/store "$DEST/"
  fi
  IMGS=$(find "$DEST/store" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
fi

printf '%s\n' "$DEST/crm" "$DEST/analytics"
if [ -n "$IMGS" ]; then
  echo "$DEST/store  ($IMGS image(s), the set to upload)"
elif [ -z "$AUTO" ]; then
  echo "$DEST/store  (nothing rendered yet - python3 tools/shots.py writes them)"
fi
# The count is the point: "nothing to do" is what an unchanged run should say, and a number that is
# suddenly every file is the shape of the defect above coming back.
if [ "$COPIED" = '(everything)' ]; then
  echo "  wrote: everything"
else
  N=$(printf '%s' "$COPIED" | grep -c '^[<>]' || true)
  [ "$N" -eq 0 ] && echo "  wrote: nothing, already in step" || echo "  wrote: $N file(s)"
fi
echo "  $(git rev-parse --short HEAD)$([ -n "$(git status --porcelain apps/)" ] && echo ' + uncommitted changes under apps/')"
