import { View, div, image } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, TextView, Editor, EditorState } from "gpui-base";
import { focused, home, props, readTextFile, writeTextFile, theme, settings, exec, appHome } from "herdr";

import { writeFile, mkdir, unlink } from "fs/promises";

export default class Reader extends View {
  init(_props, cx) {
    const options = _props?.embedded ? _props : (props() || _props || {});
    this.embedded = Boolean(options.embedded);
    this.media = null;
    this.mediaKey = "";
    this.mediaGeneration = 0;
    this.mediaBusy = false;
    this.mediaError = "";
    this.requestId = String(Date.now()) + "-" + String(Math.random()).slice(2);
    this.base = focused()?.cwd || home();
    this.machine = options.on ?? null;
    this.file = "";
    this.text = null;
    this.saved = null;
    this.error = "";
    this.mode = "preview";
    this.loading = false;
    this.saving = false;
    this.generation = 0;
    this.input = InputState.new({ placeholder: "Markdown or image file path…", value: options.file || "" });
    this.input.on("submit", (_event, cx) => this.open(this.input.value(), cx));
    if (options.file) this.open(options.file, cx);
    cx.timer.every(3000, (cx) => {
      if (!this.isImage && this.mode === "preview" && !this.dirty()) this.reload(cx);
    });
  }

  dirty() { return this.text !== null && this.text !== this.saved; }
  draftKey() { return "md-viewer:draft:" + JSON.stringify([this.machine, this.file]); }
  persistDraft() {
    if (this.dirty()) localStorage.setItem(this.draftKey(), JSON.stringify({ text: this.text, saved: this.saved }));
    else localStorage.removeItem(this.draftKey());
  }

  open(path, cx) {
    if (this.dirty() || this.saving) {
      this.error = "Save or discard your changes before opening another file.";
      cx.notify();
      return;
    }
    path = String(path || "").trim();
    const isImage = /\.(png|jpe?g|gif|webp|svg|avif|tiff?)$/i.test(path);
    if (!isImage && !/\.(md|markdown)$/i.test(path)) {
      this.error = "Choose Markdown or an image (PNG, JPEG, GIF, WebP, SVG, AVIF or TIFF).";
      cx.notify();
      return;
    }
    if (path.startsWith("~/") && !this.machine) path = home() + path.slice(1);
    if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path)) path = this.base + "/" + path;
    this.editor?.release();
    this.editor = null;
    this.file = path;
    this.isImage = isImage;
    this.mediaKey = "";
    this.media = null;
    this.mediaGeneration++;
    this.input.set_value(path);
    this.generation++;
    this.text = this.saved = null;
    this.error = "";
    this.mode = "preview";
    this.loading = false;
    this.reload(cx, true);
  }

  reload(cx, restore = false) {
    if (!this.file || this.loading || this.saving) return;
    if (this.isImage) {
      this.text = this.saved = "";
      this.error = "";
      cx.notify();
      return;
    }
    if (this.dirty()) {
      this.error = "Save or discard your changes before refreshing.";
      cx.notify();
      return;
    }
    const generation = this.generation;
    this.loading = true;
    cx.spawn(async (cx) => {
      let text = null, error = "";
      try {
        text = await readTextFile(this.file, { on: this.machine });
        if (text === null) error = "Could not read this file. Check the path and permissions.";
      } catch (e) { error = String(e?.message || e); }
      if (generation !== this.generation) return;
      this.loading = false;
      if (this.dirty() || this.saving) { cx.notify(); return; }
      const changed = text !== this.text || error !== this.error;
      this.text = this.saved = text;
      this.error = error;
      if (restore && !this.machine) {
        try {
          const draft = JSON.parse(localStorage.getItem(this.draftKey()) || "null");
          if (draft && typeof draft.text === "string" && typeof draft.saved === "string") {
            this.text = draft.text;
            this.saved = draft.saved;
            this.error = "Recovered unsaved draft. Save checks for external changes.";
          }
        } catch { this.error = "Could not restore the saved draft."; }
      }
      this.editor?.set_value(this.text ?? "");
      if (changed || restore) cx.notify();
    });
    if (this.text === null) cx.notify();
  }

  edit(cx) {
    if (this.machine || this.isImage || this.text === null) return;
    if (!this.editor) {
      this.editor = EditorState.new({ language: "markdown", value: this.text,
        readonly: false, soft_wrap: true, font_family: settings().font_family });
      this.editor.on("change", (_e, cx) => {
        this.text = this.editor.value();
        this.persistDraft();
        cx.notify();
      });
    }
    this.mode = "edit";
    cx.notify();
  }

  save(cx) {
    if (this.machine || !this.dirty() || this.saving || this.saved === null) return;
    const text = this.text, expected = this.saved;
    this.saving = true;
    this.error = "";
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(this.file, text, expected);
        this.saved = text;
        this.persistDraft();
      } catch (e) {
        this.error = "Save failed; your draft is kept. " + String(e?.message || e);
      }
      this.saving = false;
      cx.notify();
    });
    cx.notify();
  }

  discard(cx) {
    if (this.saving) return;
    this.text = this.saved;
    this.editor?.set_value(this.text ?? "");
    this.persistDraft();
    this.error = "";
    this.mode = "preview";
    this.reload(cx);
    cx.notify();
  }

  prepareMedia(cx) {
    if (this.text === null || this.mode === "edit") return;
    const key = JSON.stringify([this.machine, this.file, this.text, settings().dark]);
    if (key === this.mediaKey) return;
    this.mediaKey = key;
    this.media = null;
    this.mediaError = "";
    const generation = ++this.mediaGeneration;
    this.mediaBusy = true;
    const machine = this.machine;
    const request = { text: this.text, file: this.file, root: appHome(), dark: settings().dark, imageFile: Boolean(this.isImage) };
    cx.spawn(async (cx) => {
      const requestFile = appHome() + "/data/md-viewer/request-" + this.requestId + "-" + generation + ".json";
      try {
        await mkdir(appHome() + "/data/md-viewer", { recursive: true });
        if (machine) {
          await writeFile(requestFile, JSON.stringify({ ...request, listImages: true }));
          const plan = await exec("node", [appHome() + "/mods/reader/renderer/render.mjs", requestFile]);
          if (plan.code !== 0) throw new Error(plan.stderr || "Could not resolve remote images");
          request.remoteImages = {};
          for (const path of JSON.parse(plan.stdout)) {
            if (generation !== this.mediaGeneration) break;
            try {
              // exec returns UTF-8, so transfer binary bytes as base64. Stay below
              // its 8 MiB output limit and pass paths as arguments, never shell code.
              const script = 'test -f "$1" || { echo "Remote image is not a regular file" >&2; exit 1; }; size=$(wc -c < "$1") || exit 1; [ "$size" -le 5242880 ] || { echo "Remote image exceeds the 5 MiB preview limit" >&2; exit 1; }; head -c 5242881 < "$1" | base64';
              const result = await exec("sh", ["-c", script, "reader-image", path], { on: machine });
              if (result.code !== 0) throw new Error(result.stderr || "Could not read remote image");
              request.remoteImages[path] = { base64: result.stdout };
            } catch (e) {
              request.remoteImages[path] = { error: String(e?.message || e).slice(0, 300) };
            }
          }
        }
        if (generation !== this.mediaGeneration) return;
        await writeFile(requestFile, JSON.stringify(request));
        const result = await exec("node", [appHome() + "/mods/reader/renderer/render.mjs", requestFile]);
        if (result.code !== 0) throw new Error(result.stderr || "Renderer failed");
        const blocks = JSON.parse(result.stdout);
        if (generation === this.mediaGeneration) this.media = blocks;
      } catch (e) {
        if (generation === this.mediaGeneration) this.mediaError = "Media preview failed. Run scripts/install.sh to install the renderer. " + String(e?.message || e).slice(0, 250);
      } finally {
        try { await unlink(requestFile); } catch {}
      }
      if (generation === this.mediaGeneration) { this.mediaBusy = false; cx.notify(); }
    });
  }

  render(cx) {
    this.prepareMedia(cx);
    const t = theme();
    const button = (id, label, action, active = false) => div().id(id).px(10).py(6).rounded(6)
      .cursor_pointer().bg(active ? t.accent : t.raised).text_color(active ? t.accent_foreground : t.foreground)
      .hover(s => s.bg(active ? t.accent : t.hover)).on_click(action).child(label);
    const filename = this.file.split(/[\\/]/).pop();
    const kind = this.isImage ? this.file.split(".").pop().toUpperCase() : "Markdown";
    const preview = this.media?.find(b => b.type === "image");
    return v_flex().id("reader").size_full().min_h(0)
      .on_size_change((size, cx) => { if (this.width !== size.width || this.height !== size.height) { this.width = size.width; this.height = size.height; cx.notify(); } })
      .bg(t.surface).text_color(t.foreground)
      .when(!this.embedded, el => el.on_drop((event, cx) => { if (event.paths?.length) this.open(event.paths[0], cx); }))
      .when(!this.embedded, el => el.child(h_flex().px(16).py(12).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(14).font_semibold().child("Reader"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(filename || "Markdown & images"))
        .when(Boolean(this.file), el => el.child(div().px(7).py(3).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(kind)))))
      .when(!this.embedded, el => el.child(h_flex().px(16).py(10).gap(6).items_center().text_size(12)
        .child(Input.new(this.input).flex_1().min_w(0).h(32).px(10).rounded(6).bg(t.background).border_1().border_color(t.border))
        .child(button("open", "Open", (_e, cx) => this.open(this.input.value(), cx), true))
        .when(Boolean(this.file), el => el.child(button("reload", "↻", (_e, cx) => { this.mediaKey = ""; this.reload(cx); cx.notify(); })))))
      .when(this.text !== null, el => el.child(h_flex().px(12).py(10).gap(6).items_center().text_size(12)
        .when(!this.isImage && !this.machine, el => el
          .child(button("preview", "Read", (_e, cx) => { this.mode = "preview"; cx.notify(); }, this.mode === "preview"))
          .child(button("edit", "Edit", (_e, cx) => this.edit(cx), this.mode === "edit")))
        .when(Boolean(this.isImage && preview), el => el
          .child(button("image-fit", this.actualSize ? "Fit to pane" : "Actual size", (_e, cx) => { this.actualSize = !this.actualSize; cx.notify(); }))
          .child(div().text_color(t.muted).child(preview ? preview.width + " × " + preview.height : "")))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(this.dirty() ? t.working : t.muted)
          .child(this.dirty() ? "Unsaved draft" : this.machine ? "Remote · read only" : this.isImage ? "Image preview" : "Saved"))
        .when(this.dirty(), el => el
          .child(button("discard", "Discard", (_e, cx) => this.discard(cx)))
          .child(button("save", this.saving ? "Saving…" : "Save", (_e, cx) => this.save(cx), true)))))
      .when(Boolean(this.error), el => el.child(div().mx(16).mb(10).p(12).rounded(6).bg(t.raised).text_size(12).text_color(t.blocked).child(this.error)))
      .child(this.mode === "edit" && this.editor
        ? Editor.new(this.editor).flex_1().min_h(0)
        : div().id("document").flex_1().min_h(0).overflow_scroll().p(24).bg(this.isImage ? t.background : t.surface)
          .child(this.text !== null
            ? v_flex().gap(16).w_full()
              .when(this.isImage, el => el.items_center())
              .when(this.mediaBusy, el => el.child(div().text_size(12).text_color(t.muted).child("Preparing preview…")))
              .when(Boolean(this.mediaError), el => el.child(div().text_color(t.blocked).child(this.mediaError)))
              .children((this.media || [{ type: "markdown", text: this.text }]).map((block, index) => {
                if (block.type === "image") {
                  const available = Math.max(1, (this.width || 560) - 48);
                  const natural = block.width / (block.pixelRatio || 1);
                  const width = this.isImage && this.actualSize ? natural : Math.min(natural, available,
                    this.isImage ? Math.max(80, (this.height || 600) - 220) * block.width / block.height : Infinity);
                  return v_flex().gap(8).child(image(block.path).w(width).h(width * block.height / block.width))
                    .when(Boolean(block.alt) && !this.isImage, el => el.child(div().text_size(12).text_color(t.muted).child(block.alt)));
                }
                if (block.type === "error") return div().p(12).rounded(6).bg(t.raised).text_size(12).text_color(t.blocked).child(block.text);
                return TextView.markdown("markdown-" + this.file + "-" + index, block.text).selectable(true).scrollable(false);
              }))
            : v_flex().w_full().py(48).gap(12).items_center()
              .child(div().text_size(28).text_color(t.accent).child("▤"))
              .child(div().text_size(20).font_semibold().child(this.loading ? "Opening document…" : "A little room to read"))
              .child(div().text_size(13).text_color(t.muted).child("Drop Markdown or an image here"))
              .child(div().text_size(12).text_color(t.dim).child("or enter a file path above"))));
  }
}
