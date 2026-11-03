#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/md-viewer"
mkdir -p "$dest"
cp "$repo/mods/md-viewer/main.js" "$repo/mods/md-viewer/mod.json" "$dest/"
mkdir -p "$dest/renderer"
cp "$repo/renderer/package.json" "$repo/renderer/package-lock.json" "$repo/renderer/render.mjs" "$dest/renderer/"
npm ci --prefix "$dest/renderer" --no-audit --no-fund
herdr-app check "$dest"
printf 'Installed md-viewer in %s\n' "$dest"
if [ "${1:-}" = "--files" ]; then
  python3 "$repo/scripts/install-files.py"
fi
