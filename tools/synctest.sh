#!/usr/bin/env bash
# Put the working tree in front of the browser, the moment it changes.
#
# `tools/totest.sh` copies apps/ to the folder the other machine loads unpacked from, and CLAUDE.md
# has said for months that `tests/run.sh` does it first thing on every run. That was true and not
# enough: a UI change checked with the render probe alone, or with `node --test`, never went near the
# battery - so the folder Chrome reads was a version behind while the fix was reported as done. The
# author found it by testing something that had already been fixed, twice, and asked not to have to
# ask.
#
# So this is the second step that repository's own rule demands: **if it can be derived, the check is
# the rule.** It is wired to a hook that fires after every tool call, and it has to be cheap enough
# for that - hence the stamp: one `find -newer ... -print -quit` when nothing has moved, which is
# milliseconds, and an rsync only when something has.
#
# The stamp lives in .git/, which is machine-local and never committed - the same reasoning as
# tools/machine.env. Deleting it costs one extra sync, nothing else.
set -u
cd "$(dirname "$0")/.."

STAMP=.git/zoost-lastsync

# Nothing under apps/ or dist/store newer than the stamp: nothing to do. `-print -quit` stops at the
# first hit, so this does not walk the trees when it does not have to. dist/store is in the watch
# because it was not: shots.py rendered a new screenshot set for a release and this exited at the
# stamp without copying it, so the dashboard was about to be fed the previous version's images -
# found by the author, on the release where it mattered.
# The commit is part of what is over there now: `tools/totest.sh` writes the manual test plan into
# that folder, and the plan names the commit it is about - so a commit with no file change under
# apps/ (a fix in tools/, a rewritten note) would leave a plan claiming a commit that has moved on.
# The stamp carries it, and a mismatch syncs. The plan's own generator is watched for the same
# reason: editing the catalogue of checks changes what he has to run, and nothing under apps/ moves.
HEAD_NOW=$(git rev-parse HEAD 2>/dev/null || echo none)

if [ -f "$STAMP" ] \
   && [ "$(cat "$STAMP" 2>/dev/null)" = "$HEAD_NOW" ] \
   && [ -z "$(find apps -type f -newer "$STAMP" -print -quit 2>/dev/null)" ] \
   && [ -z "$(find dist/store -type f -newer "$STAMP" -print -quit 2>/dev/null)" ] \
   && [ -z "$(find tools/handcheck.py -newer "$STAMP" -print -quit 2>/dev/null)" ]; then
  exit 0
fi

# **The stamp records that the copy happened, so it is written only when it did.** This was
# `... || true` followed by an unconditional write: a failed copy - the share unreachable, the sync
# client on the host stopped, the disk full - advanced the stamp anyway, so every later call saw
# «nothing to do» and the mirror was never written again. One failure and this hook was over, with
# the folder Chrome loads from frozen at whatever it last received. Which is the exact defect this
# file was written to fix, in the file that fixes it.
#
# It is the third instance here of one class - a dirty mark cleared over a write that never
# happened: `updateMetaIndex` in the panel, the report endpoint's KV counter in the Worker, this.
# Wherever a mark says «done», the thing it speaks for has to have returned before it is set.
#
# **The signal is what it says, not what it returns.** `--auto` exits 0 whatever happens, by design:
# it is called from `tests/run.sh` under `set -e`, and a cloud drive that is not running must never
# fail the battery. So the exit code cannot tell the two apart - which the first version of this fix
# used, and it was measured letting a blocked destination through as a success.
#
# What `--auto` does distinguish is silence. A machine that never asked for a mirror writes nothing
# at all; a destination configured and gone, or there and unwritable, says one line on stderr. Both
# of the second kind are «should have been written and was not», and both come back on their own,
# which is exactly when a stamp must not be advanced.
ERR=$(bash tools/totest.sh --auto 2>&1 >/dev/null)
if [ -z "$ERR" ]; then
  printf '%s' "$HEAD_NOW" > "$STAMP"
  rm -f "$STAMP.failed"
else
  # Said, but not once per tool call: this hook fires after every one of them, and a wall of the
  # same line is a wall nobody reads - the failure mode a silent hook and a shouting one share.
  # Once per commit is enough to be noticed and rare enough to stay legible.
  if [ "$(cat "$STAMP.failed" 2>/dev/null)" != "$HEAD_NOW" ]; then
    echo "synctest: the mirror was not written - the extension on the other machine is at whatever it last received. $ERR" >&2
    printf '%s' "$HEAD_NOW" > "$STAMP.failed"
  fi
fi
