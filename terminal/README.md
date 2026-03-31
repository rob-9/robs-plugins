# Terminal

Third-party Obsidian plugin ([polyipseity/obsidian-terminal](https://github.com/polyipseity/obsidian-terminal)) that integrates terminals into Obsidian. Included here with a custom profile configuration for tmux auto-attach.

## Configuration

The bundled `data.json` includes a **Persistent Terminal** profile that:

- Launches `/bin/zsh --login` via `/usr/bin/env`
- Sets `OBSIDIAN_TERMINAL=1` environment variable (useful for shell conditionals like auto-attaching tmux)
- Supports macOS and Linux

## Usage

Open a terminal via the command palette or context menu. The terminal opens as a horizontal split in the workspace.

## Install

Copy `main.js`, `manifest.json`, `styles.css`, and `data.json` to `.obsidian/plugins/terminal/`, then enable in Settings > Community Plugins.
