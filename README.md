# Herdr Markdown Viewer

A native Markdown reader and editor pane for [Herdr](https://herdr.dev). Renders `.md` and `.markdown` files directly with Herdr's built-in `TextView`, with selectable text, scrolling, theme colors, automatic refresh every three seconds, and local file editing with explicit saves. Images and Mermaid diagrams are rendered by a local Node.js helper.

![Markdown reader preview](preview.png)

Available to the Herdr community through the `herdr-mod` topic. [RECIPE.md](RECIPE.md) describes how to build and install it from an empty folder.

## Install

With Herdr, Node.js 22+ and npm installed:

```sh
./scripts/install.sh
```

To also connect the Files pane in the active layout:

```sh
./scripts/install.sh --files
```

This clones Herdr's shipped Files mod into `md-files`, installs the companion, and changes the active personal layout's Files reference. A shipped layout is cloned first. The original layout file is backed up under `~/.config/herdr-app/backups/md-viewer/`. Other layouts retain their own Files mod. Requires Python 3 for this optional integration.

The basic install copies this mod into `${HERDR_APP_HOME:-~/.config/herdr-app}/mods/md-viewer` and runs Herdr's checker. Run again after updating the repository.

## Open a file beside your terminal

```sh
herdr-app do pane.split '{"direction":"right","mod":"md-viewer","props":{"file":"/absolute/path/README.md"}}'
```

Or open an empty viewer and type a path or drop a Markdown file into it:

```sh
herdr-app do pane.split '{"direction":"right","mod":"md-viewer"}'
```

Press Enter or Open to load a path. Relative paths resolve against the terminal folder focused when the viewer starts. Local `~/` paths are supported. Refresh reloads immediately; changes are otherwise picked up within three seconds. Empty documents render as empty documents; unreadable files display an error and are retried automatically. Each pane holds its own document. Files are written only when you press Save.

For a remote file, pass an absolute path and `"on":"machine-name"` in props. Drag-and-drop paths refer to local files, so use that with local viewers.

## Open from Files

In the connected Files pane, select a `.md` or `.markdown` file, then click **Open in reader** in the preview header. This opens a new reader pane beside the focused pane. Non-Markdown files keep the normal preview. The companion includes the Files mod from Herdr 0.1.12 and its native file browser behavior; Herdr updates do not replace this personal clone.

## Edit and save

Click **Edit** to edit Markdown source. **Preview** renders the current draft without saving. When changes exist, **Save** writes them to the local file and **Discard** abandons the draft and reloads from disk. Save checks that the file still matches the version originally read; conflicting external changes leave both the disk file and your draft intact. Copy the draft elsewhere before discarding if you need to reconcile a conflict.

Automatic refresh pauses while editing or when unsaved changes exist. Opening another path or refreshing cannot discard a dirty draft. Drafts are stored per file within the pane's local storage, so they can recover after a hot reload or app restart while that pane remains. Removing the pane removes its copy of state; save before closing it. Remote files are read only because Herdr's `writeTextFile` API writes locally only.

## Validate

```sh
herdr-app check mods/md-viewer
herdr-app check ~/.config/herdr-app/mods/md-files
node --test tests/viewer.test.mjs
```

Herdr must provide the `gpui-kit`, `gpui-base`, and `herdr` runtime modules. This is a native mod, not a browser or Node application. Text and links use Herdr’s native Markdown renderer.

## Images and Mermaid

The installer installs a local rendering helper and Chromium through Mermaid CLI. PNG, JPEG, SVG and other Sharp-supported images are converted to native previews. Relative paths resolve against the Markdown file’s folder; HTTP(S), file URLs, data URLs and reference-style Markdown images are supported. Images appear as separate blocks, including images embedded in a paragraph or list; HTML `<img>` tags are not handled by this helper.

Fenced `mermaid` blocks render locally as images at 2× resolution with transparent backgrounds and the current light/dark appearance. Failed images and diagrams show an error; invalid diagrams retain their source. Ordinary code blocks remain code. Rendered diagrams are images, so their labels are not selectable. Media previews currently support local documents only. Assets are cached under Herdr’s `data/md-viewer/media`; generated cache files unused for 24 hours are removed automatically after rendering a document. Reusing a diagram renews its retention period. Cleanup runs when a document renders, rather than while the reader is idle. You can also remove that folder to clear the cache. Refreshing a clean document picks up Markdown changes; press Refresh to reload image-only changes.

Open `examples/media-test.md` to check local images, remote images, flowcharts and sequence diagrams. Renderer tests require `npm ci --prefix renderer`, followed by `node --test tests/renderer.test.mjs`.
