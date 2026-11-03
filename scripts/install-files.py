#!/usr/bin/env python3
"""Install the Files companion and connect the active personal layout."""
import json
import os
from pathlib import Path
import shutil
import subprocess


def herdr(*args):
    return subprocess.check_output(["herdr-app", *args], text=True)


root = Path(__file__).resolve().parent.parent
config = Path(os.environ.get("HERDR_APP_HOME", str(Path.home() / ".config/herdr-app")))
dest = config / "mods/md-files"
if not dest.exists():
    herdr("do", "mod.clone", json.dumps({"name": "files", "as": "md-files"}))
# Keep the clone's assets and metadata; replace only our companion's code.
for source in (root / "mods/md-files").iterdir():
    if source.is_file():
        shutil.copyfile(source, dest / source.name)
print(herdr("check", str(dest)).strip())
name = json.loads(herdr("status"))["layout"]
if name in ("main", "terminals", "win98"):
    herdr("do", "layout.clone", json.dumps({"name": name, "as": name + "-markdown"}))
    name = json.loads(herdr("status"))["layout"]
path = config / "layouts" / (name + ".json")
layout = json.loads(path.read_text())


def connect(node):
    if isinstance(node, dict):
        if node.get("mod") == "files":
            node["mod"] = "md-files"
        for value in node.values():
            connect(value)
    elif isinstance(node, list):
        for value in node:
            connect(value)


backup = config / "backups/md-viewer" / path.name
backup.parent.mkdir(parents=True, exist_ok=True)
if not backup.exists():
    shutil.copyfile(path, backup)
connect(layout)
path.write_text(json.dumps(layout, indent=2) + "\n")
print(f"Connected md-files in layout {name}; original saved at {backup}")
