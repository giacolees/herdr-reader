# Markdown, right beside your terminal

Read project notes, review a plan, and edit documentation without leaving **Herdr**.

## From a file to a reader pane

1. Select a Markdown file in the **Files** panel.
2. Choose **Open in reader**.
3. Read the rendered document, or choose **Edit** to work on the source.

## A clear writing workflow

| Control | What it does |
| --- | --- |
| **Edit** | Work on Markdown source with line numbers and soft wrapping |
| **Preview** | See the rendered draft before saving |
| **Save** | Write your changes after checking for external edits |
| **Discard** | Abandon the draft and reload the file |

> Your draft stays separate from the file on disk until you press Save.

## Code belongs in documentation

```sh
herdr-app do pane.split '{"direction":"right","mod":"md-viewer"}'
```

- Selectable text and native Markdown rendering
- Theme colors that follow your Herdr appearance
- Automatic refresh for clean previews
- Draft recovery and conflict protection for local edits
- Read-only viewing of remote Markdown files

[View the project on GitHub](https://github.com/giacolees/herdr-md-viewer)
