#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/md-viewer"
mkdir -p "$dest"
cp "$repo/main.js" "$repo/mod.json" "$dest/"
herdr-app check "$dest"
printf 'Installed md-viewer in %s\n' "$dest"
if [ "${1:-}" = "--files" ]; then
  python3 "$repo/scripts/install-files.py"
fi
