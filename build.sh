#!/usr/bin/env bash
# Build the Zoost extension package.
#   ./build.sh            -> dist/zoost-<version>-store.zip     (manifest at archive root)
#   ./build.sh --unpacked -> dist/zoost-<version>-unpacked.zip  (folder-wrapped, for Load unpacked)
#
# LICENSE and NOTICE live at the repo root (so GitHub picks them up) and are copied into the
# package at build time, because they must ship with the extension.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json;print(json.load(open('src/manifest.json'))['version'])")
STAGE=.build/zoost
rm -rf .build && mkdir -p "$STAGE" dist
cp -R src/. "$STAGE"/
cp LICENSE NOTICE "$STAGE"/
find .build -name '.DS_Store' -delete

if [[ "${1:-}" == "--unpacked" ]]; then
  OUT="dist/zoost-${VERSION}-unpacked.zip"
  rm -f "$OUT"
  (cd .build && zip -r -q -X "../$OUT" zoost)
else
  OUT="dist/zoost-${VERSION}-store.zip"
  rm -f "$OUT"
  (cd "$STAGE" && zip -r -q -X "../../$OUT" .)
fi

rm -rf .build
echo "built $OUT"
unzip -l "$OUT" | tail -3
