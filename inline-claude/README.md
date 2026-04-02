# Inline Claude

Obsidian plugin that lets you highlight text, ask Claude about it, and chat in a persistent sidebar panel.

## Usage

1. Highlight any text in a note
2. A floating **"Ask Claude"** button appears near your cursor — click it
3. The chat panel opens in the right sidebar with your selection as context
4. Type your question and press Enter — Claude responds with markdown
5. Keep asking follow-up questions in the same panel

You can also trigger it via the command palette: **"Ask Claude about selection"**.

## Settings

| Setting | Description |
|---------|-------------|
| **API key** | Anthropic API key (leave blank to use daily-research plugin's key) |
| **Model** | Claude model — Sonnet 4.6, Haiku 4.5, or Opus 4.6 |
| **System prompt** | Instructions sent to Claude with every query |

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/inline-claude/`, then enable in Settings > Community Plugins.
