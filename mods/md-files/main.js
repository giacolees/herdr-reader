// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, appHome } from "herdr";

import Reader from "./reader.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Reparse points keep directory attributes even when dangling; check their target.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.createInput = InputState.new({ placeholder: "Name or relative path…" });
    this.createInput.on("submit", (_e, cx) => this.createEntry(cx));
    this.dropHovered = false;
    this.renameInput = InputState.new({ placeholder: "New name…" });
    this.renameInput.on("submit", (_e, cx) => this.renameEntry(cx));
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, selectedFolder: this.selectedFolder });
      const saved = this.saved.get(next);
      this.creating = null; this.createError = ""; this.createBusy = false;
      this.renameTarget = null; this.renameBusy = false; this.renameError = "";
      this.dragFile = null; this.dragTarget = null; this.dragActive = false; this.moveBusy = false; this.moveError = ""; this.moveMessage = ""; this.browserError = ""; this.revealError = "";
      this.importBusy = false; this.importMessage = ""; this.importError = "";
      this.menu = null; this.deleteTarget = null; this.deleteError = ""; this.deleteBusy = false;
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.selectedFolder = saved?.selectedFolder || "";
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      this.resetDestination(path);
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.selectedFolder = path;
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  resetDestination(path) {
    if (this.selectedFolder === path || this.selectedFolder?.startsWith(path + "/")) {
      this.selectedFolder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    }
  }

  copyDestination() {
    return this.selectedFolder ? `${this.root}/${this.selectedFolder}` : this.root;
  }

  beginCreate(kind, cx) {
    if (this.createBusy || !this.root) return;
    this.creating = kind;
    this.createError = "";
    this.createInput.set_value("");
    cx.notify();
  }

  createEntry(cx) {
    if (!this.creating || this.createBusy || !this.root) return;
    const name = this.createInput.value().trim();
    const parts = name.split("/");
    if (!name || parts.some(p => !p || p === "." || p === "..") || /[\\\x00-\x1f]/.test(name) || /^[a-z]:/i.test(name)) {
      this.createError = "Enter a relative name, such as notes.md or docs/notes.md. Parent folders must exist.";
      cx.notify(); return;
    }
    const context = this.context, kind = this.creating;
    const path = `${context.cwd}/${name}`;
    this.createBusy = true; this.createError = "";
    cx.spawn(async cx => {
      try {
        let result;
        if (!context.on && window()?.platform === "windows") {
          const quoted = "'" + path.replaceAll("'", "''") + "'";
          const command = kind === "folder"
            ? "New-Item -ItemType Directory -ErrorAction Stop -Path " + quoted + " | Out-Null"
            : "$f=[IO.File]::Open(" + quoted + ",[IO.FileMode]::CreateNew); $f.Dispose()";
          result = await exec("powershell", ["-NoProfile", "-Command", "$ErrorActionPreference='Stop'; " + command]);
        } else {
          result = await exec("sh", ["-c", kind === "folder" ? 'mkdir -- "$1"' : 'set -C; : > "$1"', "files-create", path], { on: context.on });
        }
        if (result.code !== 0) throw new Error(result.stderr || "Could not create this item. Check the name and permissions.");
        if (!this.current(context)) return;
        this.creating = null;
        for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
        if (kind === "folder") { this.folders.add(name); this.selectedFolder = name; }
        // Refresh directly so a concurrent watcher/poll cannot skip the new entry.
        for (const folder of ["", ...this.folders]) await this.loadFolder(folder, context);
      } catch (error) {
        if (this.current(context)) this.createError = String(error.message || error).slice(0, 300);
      } finally {
        if (this.context === context) this.createBusy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  importFiles(paths, cx, folder = null) {
    if (!paths?.length || this.importBusy) return;
    this.importMessage = ""; this.importError = "";
    if (!this.root || this.on) {
      this.importError = this.on ? "Drop files into a local folder. Remote imports are not supported yet." : "Open a folder before dropping files.";
      cx.notify(); return;
    }
    const context = this.context;
    const destination = folder === null ? this.copyDestination() : `${this.root}/${folder}`;
    this.importBusy = true;
    // Run outside the mod's restricted filesystem API. Exclusive copying prevents overwrites.
    const script = `
      const fs = require('node:fs/promises');
      const { constants } = require('node:fs');
      const path = require('node:path');
      (async () => {
        const results = [];
        for (const source of process.argv.slice(2)) {
          const name = path.basename(source);
          try {
            if (!(await fs.stat(source)).isFile()) throw new Error('Only files can be imported');
            await fs.copyFile(source, path.join(process.argv[1], name), constants.COPYFILE_EXCL);
            results.push({ name, ok: true });
          } catch (e) {
            results.push({ name, error: e.code === 'EEXIST' ? 'A file or folder with this name already exists' : String(e.message) });
          }
        }
        console.log(JSON.stringify(results));
      })().catch(e => { console.error(e.message); process.exitCode = 1; });
    `;
    cx.spawn(async cx => {
      try {
        const result = await exec("node", ["-e", script, destination, ...paths]);
        if (result.code !== 0) throw new Error(result.stderr || "Import failed");
        const results = JSON.parse(result.stdout);
        if (!this.current(context)) return;
        const count = results.filter(r => r.ok).length;
        this.importMessage = count ? `Copied ${count} ${count === 1 ? "file" : "files"} into ${destination}.` : "";
        this.importError = results.filter(r => !r.ok).map(r => r.name + ": " + r.error).join("\n");
        for (const folder of ["", ...this.folders]) await this.loadFolder(folder, context);
      } catch (error) {
        if (this.current(context)) this.importError = String(error.message || error).slice(0, 500);
      } finally {
        if (this.context === context) this.importBusy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  startFileDrag(path, position, cx) {
    if (this.moveBusy || this.renameBusy || this.deleteBusy || this.importBusy) return;
    this.dragFile = { path, position, context: this.context };
    this.dragTarget = null; this.dragActive = false; this.suppressClick = false;
  }

  trackFileDrag(event, cx) {
    if (!this.dragFile) return;
    const start = this.dragFile.position;
    if (!this.dragActive && Math.hypot(event.position.x - start.x, event.position.y - start.y) >= 6) {
      this.dragActive = true; this.suppressClick = true; cx.notify();
    }
    const bounds = this.dragTarget?.bounds;
    if (bounds && (event.position.x < bounds.x || event.position.y < bounds.y || event.position.x >= bounds.x + bounds.width || event.position.y >= bounds.y + bounds.height)) {
      this.dragTarget = null; cx.notify();
    }
  }

  targetFileDrag(path, bounds, cx) {
    if (!this.dragFile || this.dragTarget?.path === path) return;
    this.dragTarget = { path, bounds };
    cx.notify();
  }

  cancelFileDrag(cx) {
    if (!this.dragFile) return;
    this.dragFile = null; this.dragTarget = null; this.dragActive = false;
    cx.notify();
  }

  finishFileDrag(cx, folder = null) {
    const source = this.dragFile, target = folder === null ? this.dragTarget : { path: folder };
    const active = this.dragActive;
    this.cancelFileDrag(cx);
    if (active && source && target) this.moveFile(source.path, target.path, source.context, cx);
  }

  async moveOnDisk(from, to, context) {
    let result;
    if (!context.on && window()?.platform === "windows") {
      const quote = value => "'" + value.replaceAll("'", "''") + "'";
      const command = "$ErrorActionPreference='Stop'; if (Test-Path -LiteralPath " + quote(to) + ") { throw 'An item with this name already exists' }; Move-Item -LiteralPath " + quote(from) + " -Destination " + quote(to) + " -ErrorAction Stop";
      result = await exec("powershell", ["-NoProfile", "-Command", command]);
    } else {
      const script = 'if [ -e "$2" ] || [ -L "$2" ]; then printf "%s\n" "An item with this name already exists" >&2; exit 1; fi; mv -n -- "$1" "$2" || exit; if [ -e "$1" ] || [ -L "$1" ]; then printf "%s\n" "Move failed; the destination may already exist" >&2; exit 1; fi';
      result = await exec("sh", ["-c", script, "files-move", from, to], { on: context.on });
    }
    if (result.code !== 0) throw new Error(result.stderr || "Could not move this item. Check permissions.");
  }

  moveFile(path, folder, context, cx) {
    if (this.moveBusy || !this.current(context)) return;
    const name = path.split("/").pop(), next = folder ? folder + "/" + name : name;
    if (path === next) return;
    this.moveBusy = true; this.moveError = ""; this.moveMessage = "";
    cx.spawn(async cx => {
      try {
        await this.moveOnDisk(`${context.cwd}/${path}`, `${context.cwd}/${next}`, context);
        if (!this.current(context)) return;
        this.moveMessage = `Moved ${name} to ${folder || "root"}.`;
        if (folder) this.folders.add(folder);
        for (const expanded of ["", ...this.folders]) await this.loadFolder(expanded, context);
      } catch (error) {
        if (this.current(context)) this.moveError = String(error.message || error).slice(0, 300);
      } finally {
        if (this.context === context) this.moveBusy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  canOpenInBrowser(item = this.menu) {
    return Boolean(item && !item.dir && !this.on && /\.html?$/i.test(item.path));
  }

  openInBrowser(cx) {
    if (!this.canOpenInBrowser()) return;
    const path = `${this.root}/${this.menu.path}`, context = this.context;
    this.menu = null; this.browserError = "";
    cx.spawn(async cx => {
      try {
        const result = await exec("node", [appHome() + "/mods/reader/renderer/open-browser.mjs", path]);
        if (result.code !== 0) throw new Error(result.stderr || "Could not open the default browser.");
      } catch (error) {
        if (this.current(context)) this.browserError = "Open in browser failed. " + String(error.message || error).slice(0, 300);
      }
      cx.notify();
    });
    cx.notify();
  }

  canRevealInFinder() {
    return Boolean(this.menu && !this.on && window()?.platform === "macos");
  }

  revealInFinder(cx) {
    if (!this.canRevealInFinder()) return;
    const path = `${this.root}/${this.menu.path}`, context = this.context;
    this.menu = null; this.revealError = "";
    cx.spawn(async cx => {
      try {
        const result = await exec("open", ["-R", path]);
        if (result.code !== 0) throw new Error(result.stderr || "Could not reveal this item.");
      } catch (error) {
        if (this.current(context)) this.revealError = "Reveal in Finder failed. " + String(error.message || error).slice(0, 300);
      }
      cx.notify();
    });
    cx.notify();
  }

  requestRename(cx) {
    if (!this.menu || this.renameBusy) return;
    this.renameTarget = { ...this.menu, context: this.context };
    this.renameInput.set_value(this.menu.path.split("/").pop());
    this.menu = null; this.renameError = "";
    cx.notify();
  }

  renameEntry(cx) {
    const target = this.renameTarget;
    if (!target || this.renameBusy || !this.current(target.context)) return;
    const name = this.renameInput.value().trim();
    if (!name || name === "." || name === ".." || /[\\/\x00-\x1f]/.test(name)) {
      this.renameError = "Enter a name without folder separators."; cx.notify(); return;
    }
    const { path, context } = target;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) + "/" : "";
    const next = parent + name;
    if (next === path) { this.renameTarget = null; cx.notify(); return; }
    this.renameBusy = true; this.renameError = "";
    cx.spawn(async cx => {
      try {
        const from = `${context.cwd}/${path}`, to = `${context.cwd}/${next}`;
        await this.moveOnDisk(from, to, context);
        if (!this.current(context)) return;
        const remap = value => value === path ? next : value?.startsWith(path + "/") ? next + value.slice(path.length) : value;
        this.folders = new Set([...this.folders].map(remap));
        this.entries = new Map([...this.entries].map(([folder, entries]) => [remap(folder), entries]));
        this.selectedFolder = remap(this.selectedFolder);
        this.renameTarget = null;
        for (const folder of ["", ...this.folders]) await this.loadFolder(folder, context);
      } catch (error) {
        if (this.current(context)) this.renameError = String(error.message || error).slice(0, 300);
      } finally {
        if (this.context === context) this.renameBusy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  requestDelete(cx) {
    if (!this.menu || this.deleteBusy) return;
    this.deleteTarget = { ...this.menu, context: this.context };
    this.menu = null; this.deleteError = "";
    cx.notify();
  }

  deleteEntry(cx) {
    const target = this.deleteTarget;
    if (!target || this.deleteBusy || !this.current(target.context)) return;
    const { path, dir, context } = target;
    if (!path || path.split("/").some(p => !p || p === "." || p === "..") || /[\\\x00-\x1f]/.test(path)) return;
    this.deleteBusy = true; this.deleteError = "";
    cx.spawn(async cx => {
      try {
        const absolute = `${context.cwd}/${path}`;
        let result;
        if (!context.on && window()?.platform === "windows") {
          const quoted = "'" + absolute.replaceAll("'", "''") + "'";
          result = await exec("powershell", ["-NoProfile", "-Command", "$ErrorActionPreference='Stop'; Remove-Item -LiteralPath " + quoted + (dir ? " -Recurse" : "") + " -ErrorAction Stop"]);
        } else {
          result = await exec("rm", dir ? ["-r", "--", absolute] : ["--", absolute], { on: context.on });
        }
        if (result.code !== 0) throw new Error(result.stderr || "Could not delete this item. Check permissions.");
        if (!this.current(context)) return;
        this.deleteTarget = null;
        this.resetDestination(path);
        for (const folder of this.folders) {
          if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
        }
        for (const folder of ["", ...this.folders]) await this.loadFolder(folder, context);
      } catch (error) {
        if (this.current(context)) this.deleteError = String(error.message || error).slice(0, 300);
      } finally {
        if (this.context === context) this.deleteBusy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  show(path, cx) {
    this.reader?.release(); this.reader = null;
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    if (/\.(md|markdown|png|jpe?g|gif|webp|svg|avif|tiff?)$/i.test(path)) {
      this.reader = cx.new(Reader, { file: `${this.root}/${path}`, on: this.on, embedded: true });
      cx.notify();
      return;
    }
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().bg(entry.dir && (this.selectedFolder === path || (this.dragActive && this.dragTarget?.path === path)) ? t.selected : t.background).hover(s => s.bg(entry.dir ? t.selected : t.hover))
        .on_mouse_down("left", (event, cx) => { this.suppressClick = false; if (!entry.dir) this.startFileDrag(path, event.position, cx); })
        .when(entry.dir, el => el.on_mouse_move((event, cx) => this.targetFileDrag(path, event.bounds, cx))
          .on_mouse_up("left", (_event, cx) => { if (this.dragActive) { cx.stop_propagation(); this.finishFileDrag(cx, path); } }))
        .when(entry.dir, el => el.on_drop((event, cx) => {
          cx.stop_propagation();
          this.importFiles(event.paths, cx, path);
        }))
        .on_click((_e, cx) => { if (this.suppressClick) return; this.menu = null; entry.dir ? this.toggle(path, cx) : this.show(path, cx); })
        .on_mouse_down("right", (_e, cx) => { if (!this.deleteBusy) { this.menu = { path, dir: entry.dir }; cx.notify(); } })
        .child(entry.dir ? svg(`mods/md-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/md-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const action = (id, label, handler) => div().id(id).px(7).py(5).rounded(5).cursor_pointer()
      .bg(t.raised).hover(s => s.bg(t.hover)).text_size(11).on_click(handler).child(label);
    return v_flex().id("files").relative().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(this.dropHovered ? t.accent : t.border).text_color(t.foreground).text_size(13)
      .on_hover((hovered, cx) => { if (!hovered) this.cancelFileDrag(cx); if (this.dropHovered !== hovered) { this.dropHovered = hovered; cx.notify(); } })
      .on_drop((event, cx) => this.importFiles(event.paths, cx))
      .on_mouse_move((event, cx) => this.trackFileDrag(event, cx))
      .on_mouse_up("left", (_event, cx) => this.finishFileDrag(cx))
      .on_mouse_down_out((_event, cx) => this.cancelFileDrag(cx))
      .when(this.dragActive, el => el.cursor_grabbing())
      .on_size_change((size, _cx) => { this.panelHeight = size.height; this.panelWidth = size.width; })
      .on_mouse_down("right", (event, cx) => { if (this.menu) { this.menuX = Math.max(4, Math.min((event.local_position?.x ?? 10) + 4, (this.panelWidth || 368) - 184)); this.menuY = Math.max(4, Math.min((event.local_position?.y ?? 42) + 4, (this.panelHeight || 600) - (112 + (this.canOpenInBrowser() ? 32 : 0) + (this.canRevealInFinder() ? 32 : 0)))); cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").px(6).py(4).rounded(5).hover(s => s.bg(t.hover)).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("← Files")))
        .when(!this.file, el => el.child(div().font_semibold().child("Files")))
        .when(!this.file && Boolean(this.root), el => el
          .child(action("new-file", svg("mods/md-files/file-plus.svg").size(16).text_color(t.muted), (_e, cx) => this.beginCreate("file", cx)))
          .child(action("new-folder", svg("mods/md-files/folder-plus.svg").size(16).text_color(t.muted), (_e, cx) => this.beginCreate("folder", cx))))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file && Boolean(this.root), el => el.child(h_flex().id("files-root-target").h(32).flex_none().px(12).gap(8).items_center()
        .bg(this.dragActive && this.dragTarget?.path === "" ? t.selected : t.surface)
        .border_b(1).border_color(this.dragActive && this.dragTarget?.path === "" ? t.accent : t.border)
        .on_mouse_move((event, cx) => this.targetFileDrag("", event.bounds, cx))
        .on_mouse_up("left", (_event, cx) => { if (this.dragActive) { cx.stop_propagation(); this.finishFileDrag(cx, ""); } })
        .on_drop((event, cx) => { cx.stop_propagation(); this.importFiles(event.paths, cx, ""); })
        .child(svg("mods/md-files/folder.svg").size(16).text_color(t.accent))
        .child(div().text_size(12).font_semibold().child("Root folder"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.root.split(/[\\/]/).pop()))))
      .when(Boolean(this.revealError), el => el.child(div().px(12).py(8).text_size(12).text_color(t.blocked).child(this.revealError)))
      .when(Boolean(this.browserError), el => el.child(div().px(12).py(8).text_size(12).text_color(t.blocked).child(this.browserError)))
      .when(Boolean(this.moveBusy || this.moveError || this.moveMessage), el => el.child(div().px(12).py(8).text_size(12).text_color(this.moveError ? t.blocked : t.muted).child(this.moveBusy ? "Moving file…" : this.moveError || this.moveMessage)))
      .when(Boolean(this.importBusy || this.importMessage || this.importError), el => el.child(v_flex().px(12).py(8).gap(4)
        .when(this.importBusy, el => el.child(div().text_size(12).text_color(t.muted).child("Copying dropped files…")))
        .when(Boolean(this.importMessage), el => el.child(div().text_size(12).text_color(t.muted).child(this.importMessage)))
        .when(Boolean(this.importError), el => el.child(div().text_size(12).text_color(t.blocked).child(this.importError)))))
      .when(!this.file && Boolean(this.renameTarget), el => el.child(v_flex().p(12).gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(12).font_semibold().child("Rename “" + this.renameTarget.path.split("/").pop() + "”"))
        .child(Input.new(this.renameInput).h(30).px(8).rounded(5).bg(t.surface))
        .child(h_flex().gap(8)
          .child(action("confirm-rename", this.renameBusy ? "Renaming…" : "Rename", (_e, cx) => this.renameEntry(cx)))
          .child(action("cancel-rename", "Cancel", (_e, cx) => { if (!this.renameBusy) { this.renameTarget = null; this.renameError = ""; cx.notify(); } })))
        .when(Boolean(this.renameError), el => el.child(div().text_size(12).text_color(t.blocked).child(this.renameError)))))
      .when(!this.file && Boolean(this.deleteTarget), el => el.child(v_flex().p(12).gap(8).border_b(1).border_color(t.border).bg(t.surface)
        .child(div().text_size(12).font_semibold().child("Delete “" + this.deleteTarget.path + "”?"))
        .child(div().text_size(12).text_color(t.muted).child(this.deleteTarget.dir ? "This permanently deletes the folder and everything inside it." : "This permanently deletes the file."))
        .child(h_flex().gap(8)
          .child(action("confirm-delete", this.deleteBusy ? "Deleting…" : "Delete permanently", (_e, cx) => this.deleteEntry(cx)).text_color(t.blocked))
          .child(action("cancel-delete", "Cancel", (_e, cx) => { if (!this.deleteBusy) { this.deleteTarget = null; this.deleteError = ""; cx.notify(); } })))
        .when(Boolean(this.deleteError), el => el.child(div().text_size(12).text_color(t.blocked).child(this.deleteError)))))
      .when(!this.file && Boolean(this.creating), el => el.child(v_flex().p(10).gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(12).child(this.creating === "folder" ? "New folder" : "New file"))
        .child(Input.new(this.createInput).h(30).px(8).rounded(5).bg(t.surface))
        .child(div().text_size(11).text_color(t.muted).child("Relative to this folder · parent folders must exist"))
        .child(h_flex().gap(6)
          .child(action("create-entry", this.createBusy ? "Creating…" : "Create", (_e, cx) => this.createEntry(cx)))
          .child(action("cancel-create", "Cancel", (_e, cx) => { if (!this.createBusy) { this.creating = null; this.createError = ""; cx.notify(); } })))))
      .when(!this.file && Boolean(this.createError), el => el.child(div().px(10).py(8).text_size(12).text_color(t.blocked).child(this.createError)))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.reader ? div().flex_1().min_h(0).child(this.reader) : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")))
      .child(h_flex().id("files-drop-hint").on_mouse_move((event, cx) => this.targetFileDrag("", event.bounds, cx))
        .on_mouse_up("left", (_event, cx) => { if (this.dragActive) { cx.stop_propagation(); this.finishFileDrag(cx, ""); } }).flex_none().h(64).px(12).py(10).gap(8).items_center()
        .border_t(1).border_color(this.dropHovered ? t.accent : t.border)
        .bg(this.dropHovered ? t.selected : t.surface)
        .child(svg("mods/md-files/import.svg").size(18).flex_none().text_color(this.dropHovered ? t.accent : t.muted))
        .child(v_flex().gap(3).flex_1().min_w(0)
          .child(div().text_size(12).text_color(this.dropHovered ? t.accent : t.muted)
            .child(this.dragActive ? (this.dragTarget ? (this.dragTarget.path === "" ? "Release to move to root" : "Release to move into this folder") : "Drag onto a folder to move") : this.importBusy ? "Copying files…" : this.on ? "Drop imports need a local folder" : "Drop files to copy here"))
          .child(div().text_size(11).truncate().text_color(t.dim).child((this.dragActive && this.dragTarget ? (this.dragTarget.path ? this.root + "/" + this.dragTarget.path : this.root) : this.copyDestination()) || "Open a folder first")))
        .when(Boolean(this.selectedFolder), el => el.child(action("copy-to-root", "Use root", (_e, cx) => { this.selectedFolder = ""; cx.notify(); }))))
      .when(!this.file && Boolean(this.menu), el => el.child(v_flex().id("file-context-menu").absolute().left(this.menuX ?? 10).top(this.menuY ?? 42).w(Math.min(180, Math.max(1, (this.panelWidth || 368) - 8))).p(5).gap(3).rounded(6).bg(t.popover).border_1().border_color(t.border)
        .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
        .child(div().px(7).py(4).text_size(11).text_color(t.muted).truncate().child(this.menu.path.split("/").pop()))
        .when(this.canOpenInBrowser(), el => el.child(action("open-in-browser", "Open in browser", (_e, cx) => { cx.stop_propagation(); this.openInBrowser(cx); })))
        .when(this.canRevealInFinder(), el => el.child(action("reveal-in-finder", "Reveal in Finder", (_e, cx) => { cx.stop_propagation(); this.revealInFinder(cx); })))
        .child(action("rename-menu-item", "Rename…", (_e, cx) => { cx.stop_propagation(); this.requestRename(cx); }))
        .child(action("delete-menu-item", "Delete…", (_e, cx) => { cx.stop_propagation(); this.requestDelete(cx); }).text_color(t.blocked))));
  }
}
