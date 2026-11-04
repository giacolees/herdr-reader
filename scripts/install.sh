#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/reader"
mkdir -p "$dest"
cp "$repo/mods/reader/main.js" "$repo/mods/reader/mod.json" "$dest/"
mkdir -p "$dest/renderer"
cp "$repo/renderer/package.json" "$repo/renderer/package-lock.json" "$repo/renderer/render.mjs" "$repo/renderer/open-browser.mjs" "$dest/renderer/"
npm ci --prefix "$dest/renderer" --no-audit --no-fund
# Keep existing pane references and per-pane drafts working after the rename.
legacy="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/md-viewer"
if [ -d "$legacy" ]; then
  cp "$dest/main.js" "$dest/mod.json" "$legacy/"
fi
herdr-app check "$dest"
printf 'Installed Reader in %s\n' "$dest"
if [ "${1:-}" = "--files" ]; then
  python3 "$repo/scripts/install-files.py"
fi
