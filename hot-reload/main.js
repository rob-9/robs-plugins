const { Plugin, Notice } = require("obsidian");
const fs = require("fs");
const path = require("path");

class HotReloadPlugin extends Plugin {
  async onload() {
    this.watchers = new Map();
    this.reloadTimers = new Map();

    // Wait for layout to be ready before watching
    this.app.workspace.onLayoutReady(() => this.startWatching());
  }

  onunload() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.reloadTimers.values()) clearTimeout(t);
    this.reloadTimers.clear();
  }

  startWatching() {
    const pluginsDir = path.join(
      this.app.vault.adapter.basePath,
      ".obsidian",
      "plugins"
    );

    // Watch each enabled plugin folder (skip ourselves)
    const enabled = this.app.plugins.enabledPlugins;
    for (const id of enabled) {
      if (id === this.manifest.id) continue;
      this.watchPlugin(pluginsDir, id);
    }
  }

  watchPlugin(pluginsDir, pluginId) {
    // Resolve symlinks to watch the real directory
    let pluginDir = path.join(pluginsDir, pluginId);
    try {
      pluginDir = fs.realpathSync(pluginDir);
    } catch {
      return; // plugin dir doesn't exist
    }

    try {
      const watcher = fs.watch(pluginDir, { recursive: false }, (event, filename) => {
        if (!filename) return;
        // Only reload on changes to plugin files
        if (!filename.endsWith(".js") && !filename.endsWith(".css") && !filename.endsWith(".json")) return;

        // Debounce — wait 500ms for writes to finish
        if (this.reloadTimers.has(pluginId)) {
          clearTimeout(this.reloadTimers.get(pluginId));
        }
        this.reloadTimers.set(
          pluginId,
          setTimeout(() => {
            this.reloadTimers.delete(pluginId);
            this.reloadPlugin(pluginId);
          }, 500)
        );
      });

      this.watchers.set(pluginId, watcher);
    } catch (err) {
      console.error(`[hot-reload] Failed to watch ${pluginId}:`, err);
    }
  }

  async reloadPlugin(pluginId) {
    try {
      // Disable then re-enable the plugin
      await this.app.plugins.disablePlugin(pluginId);
      await this.app.plugins.enablePlugin(pluginId);
      new Notice(`Hot-reloaded: ${pluginId}`);
      console.log(`[hot-reload] Reloaded ${pluginId}`);
    } catch (err) {
      console.error(`[hot-reload] Failed to reload ${pluginId}:`, err);
      new Notice(`Hot-reload failed: ${pluginId}`);
    }
  }
}

module.exports = HotReloadPlugin;
