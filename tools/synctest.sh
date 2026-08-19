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
if [ -f "$STAMP" ] \
   && [ -z "$(find apps -type f -newer "$STAMP" -print -quit 2>/dev/null)" ] \
   && [ -z "$(find dist/store -type f -newer "$STAMP" -print -quit 2>/dev/null)" ]; then
  exit 0
fi

bash tools/totest.sh >/dev/null 2>&1 || true
touch "$STAMP"
