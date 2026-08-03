#!/usr/bin/env bash
# Build a Zoost extension package.
#   ./build.sh <app>             -> dist/zoost-<app>-<version>-store.zip     (manifest at archive root)
#   ./build.sh <app> --unpacked  -> dist/zoost-<app>-<version>-unpacked.zip  (folder-wrapped, Load unpacked)
#
# <app> is a directory under apps/ — `crm`, and `analytics` once it exists. Each app is a complete,
# separate extension with its own manifest and its own version; nothing is shared at build time.
#
# LICENSE and NOTICE live at the repo root (so GitHub picks them up) and are copied into the
# package at build time, because they must ship with the extension.
set -euo pipefail
cd "$(dirname "$0")"

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

if [[ "${2:-}" == "--unpacked" ]]; then
  OUT="dist/${NAME}-${VERSION}-unpacked.zip"
  rm -f "$OUT"
  (cd .build && zip -r -q -X "../$OUT" "$NAME")
else
  OUT="dist/${NAME}-${VERSION}-store.zip"
  rm -f "$OUT"
  (cd "$STAGE" && zip -r -q -X "../../$OUT" .)
fi

rm -rf .build
echo "built $OUT"
unzip -l "$OUT" | tail -3
