# Markdown, right beside your terminal

Read project notes, review a plan, and edit documentation without leaving **Herdr**.

## From Files to Reader

1. Click a Markdown or image file in **Files** to open Reader in place.
2. Read the document, or choose **Edit** for Markdown source.
3. Choose **← Files** to return to the file list.

## A clear writing workflow

| Control | What it does |
| --- | --- |
| **Edit** | Work on Markdown source with line numbers and soft wrapping |
| **Read** | See the rendered draft before saving |
| **Save** | Write your changes after checking for external edits |
| **Discard** | Abandon the draft and reload the file |

> Your draft stays separate from the file on disk until you press Save.

## Code belongs in documentation

```sh
herdr-app do pane.split '{"direction":"right","mod":"reader"}'
```

- Selectable text and native Markdown rendering
- Theme colors that follow your Herdr appearance
- Automatic refresh for clean previews
- Draft recovery and conflict protection for local edits
- Read-only viewing of remote Markdown files

[View the project on GitHub](https://github.com/giacolees/herdr-reader)
