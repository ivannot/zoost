#!/usr/bin/env bash
# tools/release.sh <app>
#
# Records a Web Store submission so that it can be verified by someone who does not know us.
#
# It refuses to run on a dirty tree, builds the package reproducibly, tags the commit
# <app>-v<version>, appends the row to RELEASES.md, and prints what to do by hand. It does not push
# and does not upload: the last two steps are yours, and both are outward-facing.
#
# The point of the whole thing is the hash. A published SHA-256 only means something if a reviewer
# can rebuild the same bytes from the tag — which is why build.sh is deterministic and why this
# script verifies that before writing anything down. If two builds of the same tree disagree, the
# hash proves nothing and the script stops rather than record a number nobody can check.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-}"
[[ -n "$APP" && -f "apps/$APP/manifest.json" ]] || { echo "usage: tools/release.sh <crm|analytics>"; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "The tree is dirty. A release has to be a commit someone else can check out — commit or stash first."
  git status --short
  exit 1
fi

VERSION=$(python3 -c "import json;print(json.load(open('apps/$APP/manifest.json'))['version'])")
TAG="$APP-v$VERSION"
COMMIT=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)
ZIP="dist/zoost-$APP-$VERSION-store.zip"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists — bump the version in apps/$APP/manifest.json first."; exit 1; }

./build.sh "$APP" >/dev/null
H1=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
./build.sh "$APP" >/dev/null
H2=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
if [[ "$H1" != "$H2" ]]; then
  echo "The build is not reproducible on this machine — two runs of the same commit differ:"
  echo "  $H1"
  echo "  $H2"
  echo "Publishing a hash now would be a number nobody can verify. Fix build.sh first."
  exit 1
fi

git tag -a "$TAG" -m "Zoost for $APP $VERSION — submitted to the Chrome Web Store

package  zoost-$APP-$VERSION-store.zip
sha256   $H1
commit   $COMMIT

Reproduce with:  git checkout $TAG && ./build.sh $APP"

TODAY=$(date '+%Y-%m-%d')
python3 - "$APP" "$VERSION" "$TAG" "$SHORT" "$H1" "$TODAY" <<'PY'
import sys, re, pathlib
app, version, tag, short, sha, today = sys.argv[1:7]
p = pathlib.Path('RELEASES.md')
row = f'| {app} | {version} | `{tag}` | `{short}` | `{sha}` | {today} |\n'
s = p.read_text(encoding='utf-8')
marker = '<!-- release rows are appended here, newest last -->\n'
assert marker in s, 'RELEASES.md lost its marker'
p.write_text(s.replace(marker, marker + row, 1), encoding='utf-8')
print(f'  RELEASES.md  + {app} {version}')
PY

cat <<EOF

  tag        $TAG        (local — not pushed)
  commit     $SHORT
  package    $ZIP
  sha256     $H1

  Left to do, by hand:
    git add RELEASES.md && git commit -m "Record $TAG" && git push --follow-tags
    upload $ZIP to the Chrome Web Store
    attach the same file to a GitHub Release for $TAG
EOF
