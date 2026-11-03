# Herdr Markdown Viewer

A read-only native Markdown pane for [Herdr](https://herdr.dev). Renders `.md` and `.markdown` files directly with Herdr's built-in `TextView`, with selectable text, scrolling, theme colors, and automatic refresh every three seconds. No build step or dependencies.

## Install

With Herdr installed:

```sh
./scripts/install.sh
```

Copies this mod into `${HERDR_APP_HOME:-~/.config/herdr-app}/mods/md-viewer` and runs Herdr's checker. Run again after updating the repository.

## Open a file beside your terminal

```sh
herdr-app do pane.split '{"direction":"right","mod":"md-viewer","props":{"file":"/absolute/path/README.md"}}'
```

Or open an empty viewer and type a path or drop a Markdown file into it:

```sh
herdr-app do pane.split '{"direction":"right","mod":"md-viewer"}'
```

Press Enter or Open to load a path. Relative paths resolve against the terminal folder focused when the viewer starts. Local `~/` paths are supported. Refresh reloads immediately; changes are otherwise picked up within three seconds. Empty documents render as empty documents; unreadable files display an error and are retried automatically. Each pane holds its own document. The mod never writes to your Markdown files.

For a remote file, pass an absolute path and `"on":"machine-name"` in props. Drag-and-drop paths refer to local files, so use that with local viewers.

## Validate

```sh
herdr-app check .
```

Herdr must provide the `gpui-kit`, `gpui-base`, and `herdr` runtime modules. This is a native mod, not a browser or Node application. The Markdown features and link/image behavior are provided by Herdr's renderer.
