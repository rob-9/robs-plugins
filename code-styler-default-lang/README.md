# Code Styler: Per-File Default Language for Inline Code

Fork of [Obsidian Code Styler](https://github.com/mayurankv/obsidian-code-styler) v1.1.7 with one addition: **per-file default language for inline code blocks**.

## Usage

Add to your note's frontmatter:

```yaml
---
code-styler-default-language: cpp
---
```

All inline code (`` `someCode` ``) in that file will be syntax highlighted as C++ automatically, no need to write `` `{cpp} someCode` `` each time.

- Works in both editing (live preview) and reading mode
- Explicit `{language}` on individual inline code still overrides the default
- No default language = unchanged behavior

## CSS Snippet (required for some themes)

Themes like **Maple** force a single color on all inline code with `!important`, which overrides syntax highlighting. Include `Inline Code Syntax.css` as an Obsidian CSS snippet to fix this.

1. Copy `Inline Code Syntax.css` to `.obsidian/snippets/`
2. Enable it in Settings > Appearance > CSS Snippets

## Install

Replace the files in `.obsidian/plugins/code-styler/` with the ones from this repo (`main.js`, `manifest.json`, `styles.css`).
