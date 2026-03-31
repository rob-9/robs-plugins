# Daily Research

Obsidian plugin that fetches trending stories from HackerNews and Google News, uses Claude to pick the most impactful story, and appends a research brief to your daily note.

## Usage

Run the **"Daily Research: Generate"** command from the command palette. The plugin will:

1. Fetch top stories from HackerNews and Google News (filtered by your interests)
2. Send them to Claude to identify the most significant story
3. Generate a concise research brief with key takeaways
4. Append it to today's daily note

The plugin can also run automatically on startup (once per day).

## Settings

- **Anthropic API key** — your Claude API key
- **Model** — Claude model to use (Sonnet, Haiku, or Opus)
- **Dailies folder** — path to your daily notes folder
- **Interests** — comma-separated topics used to filter stories and search Google News
- **HackerNews story count** — number of top stories to fetch (10-50)
- **Run on startup** — auto-generate when Obsidian opens

The plugin tracks previously covered topics to avoid repetition.

## Install

Copy `main.js` and `manifest.json` to `.obsidian/plugins/daily-research/`, then enable in Settings > Community Plugins.
