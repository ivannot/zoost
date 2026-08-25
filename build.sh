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

# macOS ships `shasum`, most Linux ships `sha256sum`, and WSL has both only sometimes. The hash is
# the thing this whole chain rests on, so it must not depend on which of the two is installed.
sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi; }
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
# **And the modes, which `zip` records in the central directory.** `-X` drops the *extra* field and
# keeps the Unix mode, and `cp -R` gives each staged file `source_mode & ~umask` - so the archive's
# bytes depend on two properties of the machine: the mode of the file in the checkout, and the umask
# of whoever runs this.
#
# Measured, because the claim arrived overstated and the overstatement is instructive: **umask alone
# changes nothing** on a tree whose files are 644, since a umask only takes bits away. Nor does a 664
# file alone, because umask 022 takes that bit straight back off. It takes *both* - a permissive
# umask and a file that carries the group-write bit, which is what a `core.sharedRepository=group`
# clone or a copy through a Windows drive gives you - and then the same commit produces two different
# SHA-256s: 6d495d99… against 98534e81…, reproduced here.
#
# That falsifies the guarantee the whole chain rests on, and it fails in the direction that costs
# most: `release.sh` prints the local hash and says to stop if it does not match what CI publishes,
# so one such machine would make every release look tampered with. Everything else was pinned
# already - LC_ALL, the sort order, the timestamps; this was the last property of the machine still
# getting into the bytes.
find .build -type d -exec chmod 755 {} + && find .build -type f -exec chmod 644 {} +

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
# Which archiver produced this. Determinism is verified on Info-ZIP 3.0 (macOS) and on ubuntu-latest
# in CI, not asserted for every zip implementation in existence, so the log has to say which one ran.
echo "  archiver:   $(zip -v 2>/dev/null | sed -n '2p' | cut -d, -f1)"
echo "  sha256:     $(sha256 "$OUT" | cut -d' ' -f1)"
unzip -l "$OUT" | tail -3
