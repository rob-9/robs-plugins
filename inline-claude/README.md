# Inline Claude

Obsidian plugin that lets you highlight text in a document, ask Claude a question about it, and see the response in a right sidebar panel. Uses the `claude` CLI — no API key needed.

## Usage

1. Select some text in a markdown file
2. Run **"Ask Claude about selection"** from the command palette (or click the ribbon icon)
3. The sidebar opens with your selected text — type a question and press Enter
4. Claude's response renders as markdown in the panel

### Action buttons

After receiving a response:

| Button | Action |
|--------|--------|
| **Insert Below** | Inserts the response after your selection |
| **Replace** | Replaces the selected text with the response |
| **Copy** | Copies the response to clipboard |

The panel persists across interactions — highlight new text and run the command again without reopening.

## How it works

The plugin spawns `claude -p` via `child_process` and pipes a prompt containing your system prompt, the full document context, the selected text, and your question.

## Settings

- **System prompt** — instructions sent to Claude with every query

## Prerequisites

The [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) must be installed and authenticated.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/inline-claude/`, then enable in Settings > Community Plugins.
