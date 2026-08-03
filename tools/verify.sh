#!/usr/bin/env bash
# tools/verify.sh <app> <version>
#
# For someone who does not know us. Rebuilds a published package from its tag and says whether the
# bytes match what RELEASES.md claims — and, if the GitHub CLI is present, whether GitHub itself
# attests that the archive on the Release came from this repository and that commit.
#
# It answers one question: is the extension on the Chrome Web Store built from this source, and
# nothing else? Run it on your machine, against a clean clone, and decide for yourself.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-}"; VERSION="${2:-}"
[[ -n "$APP" && -n "$VERSION" ]] || { echo "usage: tools/verify.sh <crm|analytics> <version>"; exit 1; }
TAG="$APP-v$VERSION"
ZIP="dist/zoost-$APP-$VERSION-store.zip"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || {
  echo "No tag $TAG in this clone. Fetch tags first:  git fetch --tags"; exit 1; }

CLAIMED=$(python3 - "$APP" "$VERSION" <<'PY'
import sys, re, pathlib
app, version = sys.argv[1:3]
for line in pathlib.Path('RELEASES.md').read_text(encoding='utf-8').splitlines():
    cells = [c.strip().strip('`') for c in line.split('|')]
    if len(cells) > 5 and cells[1] == app and cells[2] == version:
        print(cells[5]); break
else:
    print('')
PY
)
[[ -n "$CLAIMED" ]] || { echo "RELEASES.md has no row for $APP $VERSION."; exit 1; }
[[ "$CLAIMED" == *"not reproducible"* ]] && { echo "RELEASES.md says this one predates the reproducible build and publishes no hash. Nothing to check."; exit 1; }

# Build in a throwaway worktree rather than checking the tag out here. Verification must not touch
# the repository it is run in: `git checkout` moves your HEAD, refuses outright if you have local
# changes, and restoring "the branch you were on" is not even well defined when you started detached.
# A worktree is a separate directory sharing the object store — nothing about your checkout changes.
WT=$(mktemp -d)
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"' EXIT
git worktree add -q --detach "$WT" "$TAG"
( cd "$WT" && ./build.sh "$APP" >/dev/null )
ZIP="$WT/$ZIP"
BUILT=$(shasum -a 256 "$ZIP" 2>/dev/null | cut -d' ' -f1 || sha256sum "$ZIP" | cut -d' ' -f1)

echo "  tag       $TAG  ($(git rev-parse --short "$TAG^{commit}"))"
echo "  claimed   $CLAIMED"
echo "  rebuilt   $BUILT"
if [[ "$CLAIMED" == "$BUILT" ]]; then
  echo "  MATCH — the published package is this source and nothing else."
else
  echo "  MISMATCH — do not install it, and say so publicly."
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  echo
  echo "  Asking GitHub whether it built that archive:"
  gh attestation verify "$ZIP" --repo ivannot/zoost || {
    echo "  No attestation, or it does not match. Releases before this mechanism existed have none."; }
else
  echo
  echo "  (Install the GitHub CLI to also check GitHub's own provenance attestation:"
  echo "     gh attestation verify $ZIP --repo ivannot/zoost)"
fi
