# Reader for Herdr

A native Markdown reader and local-file editor for Herdr. Open a document beside a terminal, read the rendered text, switch to source editing, and save explicitly. An optional Files companion opens Markdown and supported images directly inside Files, with a back button to return to the list.

This is a build brief: enough for another agent to rebuild the mod from an empty folder. The code alongside it is one implementation. Read the installed `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts`, and `gpui-kit.d.ts` first; those describe the person's actual runtime.

## What you see

- A full-size, theme-aware pane with a path field, Open and Refresh buttons.
- Selectable rendered Markdown in a scrollable document area, using the native renderer. Empty documents stay empty; loading and unreadable-file states are explicit.
- An Edit button for local files, switching to a native source editor. Preview renders the draft without writing it.
- Unsaved drafts show a status label, Save and Discard buttons. Errors appear below the toolbar.
- In Files, clicking Markdown or a supported image embeds Reader. The ← Files button returns to the list and preserves expanded folders.

## Behavior

1. Accept an optional `file` prop and an optional `on` machine prop. Without a file, show an empty reader. Open and Enter load the typed path; dropping a Markdown file loads its absolute path. Accept `.md` and `.markdown` case-insensitively. Resolve relative paths against the terminal directory at initialization and expand local `~/`.
2. Read UTF-8 with `readTextFile`. Render with `TextView.markdown`. Keep a document generation counter so an old read cannot replace a newer file. Never retain a callback's `cx` for later use.
3. Poll every three seconds for clean documents in Preview. Skip reads during saving, and never let a pending read overwrite a new edit. Notify only when content or a visible state changes. Do not use timer animations.
4. Create an editable `EditorState` in response to Edit, with Markdown syntax, soft wrapping and the configured code font. Change events update the draft. Keep a separate original disk snapshot. Preserve the editor when switching to Preview and back.
5. Save local files using `writeTextFile(file, draft, originalSnapshot)`. The expected snapshot protects against external changes. On failure preserve the draft, show the error and never force an overwrite. Edits made during a save remain dirty after that save completes.
6. Store dirty drafts and their original snapshots in per-copy `localStorage`, keyed by machine and file. Recover on pane initialization after a reload/restart. Clear saved/discarded drafts. State belongs to that pane; save before removing it.
7. Block opening another path or refreshing while dirty. Discard intentionally abandons the draft and reloads disk content. Remote files remain read only because the write API is local only.

## Files companion

Clone the shipped Files mod to `md-files` before customizing it; never edit Herdr's shipped folder. Retain its tree, directory tracking, remote reads, limits, icons and error handling. Create a retained Reader child with `cx.new` when a supported file is clicked, using the selected absolute path, machine and `embedded: true`. Embed the child inside the Files body instead of creating a pane. Back releases the child and restores the file list with expanded folders preserved. Drafts persist in the Files copy's local storage and recover when reopening a document. Other files keep their source previews. Copy Reader into the companion during installation so both use the same implementation.

Install into the current personal layout by changing its Files block's `content.mod` to `md-files`, preserving the block ID and other layout settings. Clone a shipped layout before changing its structure. Back up the person's original layout before editing. Do not ship a `layouts/` folder or replace their window layout. Other layouts remain as they were. Merge optional key bindings if desired; this implementation adds none.

## Built from

- `mods/reader/main.js` and `mod.json`, with `place: "none"` so discovery does not dock an extra panel.
- `mods/md-files/main.js`, `mod.json`, and SVG icons for the optional Files companion. It is based on Herdr 0.1.12's Files mod; future versions may need rebuilding from the installed shipped Files implementation.
- Native `View`/`div` from `gpui-kit`; flex elements, InputState/Input, TextView, EditorState/Editor from `gpui-base`.
- `props`, `focused`, `home`, `theme`, `settings`, `readTextFile` and `writeTextFile` from `herdr`. The companion also uses live spaces/panes, folder watching, directory and Git reads through `exec`, and pane/tab commands.
- No Node or browser APIs at runtime, no network service, no external Markdown parser, and no build step. The optional installation helper uses Python 3 outside the mod runtime.

## Install and open

Read every repository file before installing. `scripts/install.sh` copies the reader and validates it; `--files` also installs the companion and connects the active layout with a backup. Resolve existing mod name collisions before replacing personal mods. Alternatively copy the reviewed mod folders manually and connect only the optional Files block.

Open a reader beside a terminal:

```sh
herdr-app do pane.split '{"direction":"right","mod":"reader","props":{"file":"/absolute/path/README.md"}}'
```

For a remote read, add `"on":"machine-name"` to props and use an absolute remote path. Dropped file paths are local, so use them with local readers only.

## Done when

- `herdr-app check mods/reader` and `herdr-app check mods/md-files` pass. Check installed copies too, and try the asynchronous states in the running app.
- A Markdown document opens by path, Enter and drop; empty and missing files behave correctly.
- Edit, Preview and Save work on a temporary local file, and saved disk content matches the draft.
- External edits cause Save to fail without losing either version; Discard reloads the external version.
- An old read cannot overwrite a new draft; a pane reload recovers a draft with its original conflict snapshot.
- Files selection embeds Reader for supported files; Back restores the file list without opening a pane.
- Remote files render without editing controls, and existing layouts and key bindings are preserved.
