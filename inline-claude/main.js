const obsidian = require("obsidian");

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = "inline-claude-chat";

const DEFAULT_SETTINGS = {
  systemPrompt:
    "You are a helpful assistant embedded in an Obsidian note editor. Answer questions about the user's selected text using the surrounding document for context. Be concise.",
  apiKey: "",
  model: "claude-sonnet-4-6",
};

// ─── Anthropic API ───────────────────────────────────────────────────────────

async function callClaude(apiKey, model, system, messages) {
  const res = await obsidian.requestUrl({
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system,
      messages,
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Claude API ${res.status}: ${JSON.stringify(res.json)}`);
  }
  return res.json.content[0].text;
}

// ─── Chat View (persistent sidebar) ─────────────────────────────────────────

class InlineClaudeChatView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.systemPrompt = "";
    this.selectionText = "";
    this.docText = "";
    this.isLoading = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Claude Chat";
  }
  getIcon() {
    return "message-circle";
  }

  async onOpen() {
    this.contentEl.addClass("ic-chat-container");
    this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  setContext(selection, doc) {
    this.systemPrompt = this.plugin.settings.systemPrompt;
    this.selectionText = selection;
    this.docText = doc;
    this.messages = [];
    this.render();
  }

  render() {
    const container = this.contentEl;
    container.empty();

    // Selection display
    if (this.selectionText) {
      const selBlock = container.createDiv({ cls: "ic-chat-selection" });
      const header = selBlock.createDiv({ cls: "ic-chat-selection-header" });
      header.createEl("span", {
        cls: "ic-chat-selection-label",
        text: "Selected text",
      });
      const toggle = header.createEl("span", {
        cls: "ic-chat-selection-toggle",
        text: "▼",
      });

      const body = selBlock.createDiv({ cls: "ic-chat-selection-body" });
      body.innerText = this.selectionText;

      header.addEventListener("click", () => {
        const collapsed = body.classList.toggle("is-collapsed");
        toggle.innerText = collapsed ? "▶" : "▼";
      });
    }

    // Messages
    const messagesEl = container.createDiv({ cls: "ic-chat-messages" });

    if (this.messages.length === 0 && !this.selectionText) {
      messagesEl.createDiv({
        cls: "ic-chat-empty",
        text: "Highlight text and click Ask Claude to start.",
      });
    }

    for (const msg of this.messages) {
      const row = messagesEl.createDiv({
        cls: `ic-chat-row ic-chat-${msg.role}`,
      });
      const bubble = row.createDiv({ cls: "ic-chat-bubble" });

      if (msg.role === "assistant") {
        obsidian.MarkdownRenderer.render(
          this.app,
          msg.content,
          bubble,
          "",
          this.plugin
        );
      } else {
        bubble.innerText = msg.display || msg.content;
      }
    }

    // Loading
    if (this.isLoading) {
      const row = messagesEl.createDiv({
        cls: "ic-chat-row ic-chat-assistant",
      });
      const bubble = row.createDiv({
        cls: "ic-chat-bubble ic-chat-loading-bubble",
      });
      bubble.createEl("span", { cls: "ic-spinner" });
      bubble.createEl("span", { text: " Thinking…" });
    }

    // Input area
    const inputArea = container.createDiv({ cls: "ic-chat-input-area" });
    const inputWrap = inputArea.createDiv({ cls: "ic-chat-input-wrap" });
    const textarea = inputWrap.createEl("textarea", {
      cls: "ic-chat-input",
      attr: {
        placeholder: this.messages.length === 0
          ? "Ask a question…"
          : "Follow up…",
        rows: 1,
      },
    });

    if (this.isLoading) textarea.disabled = true;

    // Auto-resize
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage(textarea.value.trim());
      }
    });

    // Scroll to bottom + focus
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (!this.isLoading) textarea.focus();
    });
  }

  async sendMessage(text) {
    if (!text || this.isLoading) return;

    // First message includes full document/selection context for the API
    const isFirst = this.messages.length === 0;
    const content = isFirst && this.docText
      ? "## Document Context\n" +
        this.docText +
        "\n\n## Selected Text\n" +
        this.selectionText +
        "\n\n## Question\n" +
        text
      : text;

    this.messages.push({ role: "user", content, display: text });
    this.isLoading = true;
    this.render();

    try {
      const apiKey = this.plugin.getApiKey();
      if (!apiKey) throw new Error("No API key configured.");

      // Build clean messages for API (strip display field)
      const apiMessages = this.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await callClaude(
        apiKey,
        this.plugin.settings.model,
        this.systemPrompt,
        apiMessages
      );

      this.messages.push({ role: "assistant", content: response.trim() });
    } catch (err) {
      this.messages.push({
        role: "assistant",
        content: `**Error:** ${err.message}`,
      });
    } finally {
      this.isLoading = false;
      this.render();
    }
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class InlineClaudePlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE,
      (leaf) => new InlineClaudeChatView(leaf, this)
    );

    this.addCommand({
      id: "ask-claude-about-selection",
      name: "Ask Claude about selection",
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (!sel) {
          new obsidian.Notice("Select some text first.");
          return;
        }
        this.openChat(sel, editor.getValue());
      },
    });

    // Floating "Ask Claude" tooltip on text selection
    this.tooltipEl = document.createElement("div");
    this.tooltipEl.className = "ic-selection-tooltip";
    this.tooltipEl.innerText = "Ask Claude";
    this.tooltipEl.style.display = "none";
    document.body.appendChild(this.tooltipEl);

    this.tooltipEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideTooltip();
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor) {
        const sel = editor.getSelection();
        if (sel) this.openChat(sel, editor.getValue());
      }
    });

    // Show tooltip on mouseup when there's a selection
    this.registerDomEvent(document, "mouseup", (e) => {
      // Ignore clicks on the tooltip itself
      if (this.tooltipEl.contains(e.target)) return;

      setTimeout(() => {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
          this.hideTooltip();
          return;
        }
        const sel = editor.getSelection();
        if (sel && sel.trim().length > 0) {
          this.showTooltip(e.clientX, e.clientY);
        } else {
          this.hideTooltip();
        }
      }, 10);
    });

    // Hide tooltip on mousedown (new click)
    this.registerDomEvent(document, "mousedown", (e) => {
      if (!this.tooltipEl.contains(e.target)) {
        this.hideTooltip();
      }
    });

    // Hide tooltip on scroll
    this.registerDomEvent(document, "scroll", () => this.hideTooltip(), true);

    this.addSettingTab(new InlineClaudeSettingTab(this.app, this));
  }

  showTooltip(x, y) {
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = x + "px";
    this.tooltipEl.style.top = (y - 40) + "px";

    // Keep it on screen
    requestAnimationFrame(() => {
      const rect = this.tooltipEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        this.tooltipEl.style.left = (window.innerWidth - rect.width - 8) + "px";
      }
      if (rect.top < 0) {
        this.tooltipEl.style.top = (y + 20) + "px";
      }
    });
  }

  hideTooltip() {
    this.tooltipEl.style.display = "none";
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.tooltipEl?.remove();
  }

  async openChat(selection, doc) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (view instanceof InlineClaudeChatView) {
        view.setContext(selection, doc);
      }
    }
  }

  getApiKey() {
    if (this.settings.apiKey) return this.settings.apiKey;
    const dr = this.app.plugins?.plugins?.["daily-research"];
    return dr?.settings?.apiKey || "";
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class InlineClaudeSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Inline Claude" });

    new obsidian.Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Leave blank to use daily-research plugin's key")
      .addText((text) =>
        text
          .setPlaceholder("sk-ant-… (or leave blank)")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("Model")
      .setDesc("Claude model to use for responses")
      .addDropdown((d) =>
        d
          .addOption("claude-sonnet-4-6", "Sonnet 4.6")
          .addOption("claude-haiku-4-5-20251001", "Haiku 4.5 (faster)")
          .addOption("claude-opus-4-6", "Opus 4.6 (best)")
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("System prompt")
      .setDesc("Instructions sent to Claude with every query")
      .addTextArea((t) =>
        t
          .setPlaceholder("You are a helpful assistant...")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (v) => {
            this.plugin.settings.systemPrompt = v;
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = InlineClaudePlugin;
