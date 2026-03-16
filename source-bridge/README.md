# Source Bridge

Obsidian plugin that turns local filesystem paths in your notes into clickable links with expandable, syntax-highlighted code previews.

## Usage

Write a path anywhere in your note:

```
Located in: /Users/robert/project/main.py:28-42
```

Source Bridge will:
- Render it as a **clickable link** (Cmd+Click in editing mode, click in reading mode)
- Show an **expandable preview** with syntax-highlighted code from lines 28-42
- Display a **staleness indicator** (green = exists, red = missing)
- Add an **Open** button to jump to the file in your editor

### Supported formats

| Format | What happens |
|--------|-------------|
| `/path/to/file.py` | Link + full file preview (first 50 lines) |
| `/path/to/file.py:42` | Link + preview of line 42 |
| `/path/to/file.py:28-42` | Link + preview of lines 28-42 |
| `~/path/to/file.py` | Home directory shorthand |

### Recognized prefixes

Paths are detected anywhere, but these prefixes are commonly used:
`Located in:`, `Implementation:`, `Source:`, `Code:`, `File:`, `See:`, `Path:`

## Settings

- **External editor**: Choose VS Code, Cursor, or system default for the Open button

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/source-bridge/`, then enable in Settings > Community Plugins.
