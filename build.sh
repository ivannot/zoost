#!/usr/bin/env bash
# Build a Zoost extension package.
#   ./build.sh <app>             -> dist/zoost-<app>-<version>-store.zip     (manifest at archive root)
#   ./build.sh <app> --unpacked  -> dist/zoost-<app>-<version>-unpacked.zip  (folder-wrapped, Load unpacked)
#
# <app> is a directory under apps/ — `crm` or `analytics`. Each app is a complete, separate extension
# with its own manifest and its own version; nothing is shared at build time.
#
# LICENSE and NOTICE live at the repo root (so GitHub picks them up) and are copied into the
# package at build time, because they must ship with the extension.
#
# ---------------------------------------------------------------------------------------------
# THE BUILD IS REPRODUCIBLE, AND THAT IS THE POINT.
#
# Publishing the SHA-256 of a package is worth nothing if two builds of the same commit differ:
# a reviewer who rebuilds gets another hash and can prove nothing either way. Ours did differ —
# zip stores each file's modification time and walks the directory in whatever order the filesystem
# offers, so the archive changed between runs even when not one byte of source had.
#
# Three things make it deterministic:
#   1. every file is stamped with the commit's own date, so the timestamp is a property of the
#      source rather than of when someone happened to build it;
#   2. the file list is sorted before it is handed to zip, so the entry order cannot vary;
#   3. -X drops the extra attributes (uid, gid, native timestamps) that are machine-specific.
#
# Building outside a git checkout falls back to a fixed epoch and says so: the archive is still
# reproducible, it just cannot be tied to a commit.
#
# Verify with:  ./build.sh <app> && shasum -a 256 dist/zoost-<app>-<version>-store.zip
# and compare against RELEASES.md.
# ---------------------------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
export TZ=UTC                        # zip writes local time into the archive; pin it

APP="${1:-}"
if [[ -z "$APP" || ! -f "apps/$APP/manifest.json" ]]; then
  echo "usage: ./build.sh <app> [--unpacked]"
  echo "apps available:"
  for d in apps/*/; do [[ -f "$d/manifest.json" ]] && echo "  - $(basename "$d")"; done
  exit 1
fi

VERSION=$(python3 -c "import json;print(json.load(open('apps/$APP/manifest.json'))['version'])")
NAME="zoost-$APP"
STAGE=".build/$NAME"
rm -rf .build && mkdir -p "$STAGE" dist
cp -R "apps/$APP/." "$STAGE"/
cp LICENSE NOTICE "$STAGE"/
find .build -name '.DS_Store' -delete

# The commit's date, in the form touch wants. A dirty tree still builds; the stamp is then the
# commit it is based on, which is the honest answer to "what is this made of".
if STAMP=$(git log -1 --format=%cd --date=format:'%Y%m%d%H%M.%S' 2>/dev/null) && [[ -n "$STAMP" ]]; then
  SOURCE="commit $(git rev-parse --short HEAD)"
else
  STAMP="202001010000.00"
  SOURCE="no git checkout — fixed epoch"
fi
find .build -exec touch -t "$STAMP" {} +

if [[ "${2:-}" == "--unpacked" ]]; then
  OUT="dist/${NAME}-${VERSION}-unpacked.zip"
  rm -f "$OUT"
  (cd .build && find "$NAME" -type f | LC_ALL=C sort | zip -q -X -@ "../$OUT")
else
  OUT="dist/${NAME}-${VERSION}-store.zip"
  rm -f "$OUT"
  # From inside the stage, so manifest.json lands at the archive root — the Web Store requires that.
  (cd "$STAGE" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | zip -q -X -@ "../../$OUT")
fi

rm -rf .build
echo "built $OUT"
echo "  timestamps: $SOURCE"
echo "  sha256:     $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
unzip -l "$OUT" | tail -3
