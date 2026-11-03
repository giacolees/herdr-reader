import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, TextView, Editor, EditorState } from "gpui-base";
import { focused, home, props, readTextFile, writeTextFile, theme, settings } from "herdr";

export default class MarkdownViewer extends View {
  init(_props, cx) {
    const options = props() || {};
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
    this.input = InputState.new({ placeholder: "Markdown file path…", value: options.file || "" });
    this.input.on("submit", (_event, cx) => this.open(this.input.value(), cx));
    if (options.file) this.open(options.file, cx);
    cx.timer.every(3000, (cx) => {
      if (this.mode === "preview" && !this.dirty()) this.reload(cx);
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
    if (!/\.(md|markdown)$/i.test(path)) {
      this.error = "Choose a .md or .markdown file.";
      cx.notify();
      return;
    }
    if (path.startsWith("~/") && !this.machine) path = home() + path.slice(1);
    if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path)) path = this.base + "/" + path;
    this.editor?.release();
    this.editor = null;
    this.file = path;
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
    if (this.machine || this.text === null) return;
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

  render() {
    const t = theme();
    const button = (id, label, action) => div().id(id).px(10).py(6).rounded(6)
      .cursor_pointer().bg(t.raised).hover(s => s.bg(t.hover)).on_click(action).child(label);
    return v_flex().id("markdown-viewer").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .on_drop((event, cx) => { if (event.paths?.length) this.open(event.paths[0], cx); })
      .child(h_flex().p(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(Input.new(this.input).flex_1().min_w(0).h(32).px(8).rounded(6).bg(t.background))
        .child(button("open", "Open", (_e, cx) => this.open(this.input.value(), cx)))
        .child(button("reload", "Refresh", (_e, cx) => this.reload(cx))))
      .when(this.text !== null, el => el.child(h_flex().px(10).py(6).gap(8).items_center().text_size(12)
        .child(button("mode", this.mode === "edit" ? "Preview" : this.machine ? "Read only · remote" : "Edit", (_e, cx) => {
          if (this.mode === "edit") { this.mode = "preview"; cx.notify(); } else this.edit(cx);
        }))
        .when(this.dirty(), el => el
          .child(div().text_color(t.working).child("Unsaved changes · draft kept"))
          .child(button("save", this.saving ? "Saving…" : "Save", (_e, cx) => this.save(cx)))
          .child(button("discard", "Discard", (_e, cx) => this.discard(cx))))))
      .when(Boolean(this.error), el => el.child(div().p(12).text_color(t.blocked).child(this.error)))
      .child(this.mode === "edit" && this.editor
        ? Editor.new(this.editor).flex_1().min_h(0)
        : div().id("document").flex_1().min_h(0).overflow_y_scrollbar().p(20)
          .child(this.text !== null
            ? TextView.markdown("markdown-" + this.file, this.text).selectable(true).scrollable(false)
            : div().text_color(t.muted).child(this.loading ? "Loading Markdown…" : "Open a Markdown file above or drop one into this pane.")));
  }
}
