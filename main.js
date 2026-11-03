import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, TextView } from "gpui-base";
import { focused, home, props, readTextFile, theme } from "herdr";

export default class MarkdownViewer extends View {
  init(_props, cx) {
    const options = props() || {};
    this.base = focused()?.cwd || home();
    this.machine = options.on ?? null;
    this.file = "";
    this.text = null;
    this.error = "";
    this.loading = false;
    this.generation = 0;
    this.input = InputState.new({ placeholder: "Markdown file path…", value: options.file || "" });
    this.input.on("submit", (_event, cx) => this.open(this.input.value(), cx));
    if (options.file) this.open(options.file, cx);
    cx.timer.every(3000, (cx) => this.reload(cx));
  }

  open(path, cx) {
    path = String(path || "").trim();
    if (!/\.(md|markdown)$/i.test(path)) {
      this.error = "Choose a .md or .markdown file.";
      cx.notify();
      return;
    }
    if (path.startsWith("~/") && !this.machine) path = home() + path.slice(1);
    if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path)) path = this.base + "/" + path;
    this.file = path;
    this.input.set_value(path);
    this.generation++;
    this.text = null;
    this.error = "";
    this.loading = false;
    this.reload(cx);
  }

  reload(cx) {
    if (!this.file || this.loading) return;
    const generation = this.generation;
    const file = this.file;
    this.loading = true;
    cx.spawn(async (cx) => {
      let text = null;
      let error = "";
      try {
        text = await readTextFile(file, { on: this.machine });
        if (text === null) error = "Could not read this file. Check the path and permissions.";
      } catch (e) {
        error = String(e?.message || e);
      }
      if (generation !== this.generation) return;
      const changed = text !== this.text || error !== this.error;
      this.text = text;
      this.error = error;
      this.loading = false;
      if (changed) cx.notify();
    });
    if (this.text === null) cx.notify();
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
      .when(Boolean(this.error), el => el.child(div().p(12).text_color(t.blocked).child(this.error)))
      .child(div().id("document").flex_1().min_h(0).overflow_y_scrollbar().p(20)
        .child(this.text !== null
          ? TextView.markdown("markdown-" + this.file, this.text).selectable(true).scrollable(false)
          : div().text_color(t.muted).child(this.loading ? "Loading Markdown…" : "Open a Markdown file above or drop one into this pane.")));
  }
}
