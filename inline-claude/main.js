const obsidian = require("obsidian");
const { spawn } = require("child_process");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = "inline-claude-chat";

const DEFAULT_SETTINGS = {
  systemPrompt:
    "You are a helpful assistant embedded in an Obsidian note editor. The user will ask questions about selected text from their notes. Be concise. You have full access to their files via Claude Code.",
};

// ─── Claude Code CLI ────────────────────────────────────────────────────────

const CLAUDE_PATHS = [
  path.join(process.env.HOME || "", ".local", "bin", "claude"),
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
];

function findClaude() {
  const fs = require("fs");
  for (const p of CLAUDE_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return "claude"; // fallback, hope it's in PATH
}

function callClaudeCode(prompt, sessionId, cwd) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--dangerously-skip-permissions",
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    const claudePath = findClaude();
    const proc = spawn(claudePath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => reject(err));

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Claude Code exited with code ${code}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve({
          text: result.result || stdout.trim(),
          sessionId: result.session_id || null,
        });
      } catch {
        resolve({ text: stdout.trim(), sessionId: null });
      }
    });
  });
}

// ─── Chat View (persistent sidebar) ─────────────────────────────────────────

class InlineClaudeChatView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.selectionText = "";
    this.docText = "";
    this.sessionId = null;
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

  setContext(selection, doc, editor) {
    this.selectionText = selection;
    this.docText = doc;
    this.editor = editor;
    this.messages = [];
    this.sessionId = null;
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

        // Action buttons
        const actions = row.createDiv({ cls: "ic-chat-actions" });

        const copyBtn = actions.createEl("button", {
          cls: "ic-chat-action-btn",
          attr: { "aria-label": "Copy" },
        });
        obsidian.setIcon(copyBtn, "copy");
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(msg.content);
          new obsidian.Notice("Copied.");
        });

        const insertBtn = actions.createEl("button", {
          cls: "ic-chat-action-btn",
          attr: { "aria-label": "Insert below" },
        });
        obsidian.setIcon(insertBtn, "arrow-down-to-line");
        insertBtn.addEventListener("click", () => {
          const editor =
            this.editor || this.app.workspace.activeEditor?.editor;
          if (!editor) {
            new obsidian.Notice("No active editor.");
            return;
          }
          const cursor = editor.getCursor("to");
          const line = editor.getLine(cursor.line);
          editor.replaceRange("\n\n" + msg.content, {
            line: cursor.line,
            ch: line.length,
          });
          new obsidian.Notice("Inserted.");
        });

        const smartBtn = actions.createEl("button", {
          cls: "ic-chat-action-btn",
          attr: { "aria-label": "Smart add to file" },
        });
        obsidian.setIcon(smartBtn, "wand");
        smartBtn.addEventListener("click", async () => {
          const file = this.app.workspace.getActiveFile();
          if (!file) {
            new obsidian.Notice("No active file.");
            return;
          }
          const filePath = file.path;
          new obsidian.Notice("Adding to " + filePath + "…");

          try {
            const cwd = this.app.vault.adapter.basePath;
            const prompt =
              "Add the following content to the file `" + filePath + "` " +
              "in the most appropriate location. Match the file's existing " +
              "style and formatting. Do not remove or change existing content. " +
              "Just integrate this new content where it fits best:\n\n" +
              msg.content;
            await callClaudeCode(prompt, this.sessionId, cwd);
            new obsidian.Notice("Added to " + filePath);
          } catch (err) {
            new obsidian.Notice("Failed: " + err.message);
          }
        });
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
        placeholder:
          this.messages.length === 0 ? "Ask a question…" : "Follow up…",
        rows: 1,
      },
    });

    if (this.isLoading) {
      textarea.disabled = true;
      inputWrap.addClass("is-disabled");
    }

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

    // First message includes selection context for display
    const isFirst = this.messages.length === 0;
    const prompt = isFirst && this.docText
      ? "## Document Context\n" +
        this.docText +
        "\n\n## Selected Text\n" +
        this.selectionText +
        "\n\n## Question\n" +
        text
      : text;

    this.messages.push({ role: "user", content: prompt, display: text });
    this.isLoading = true;
    this.render();

    try {
      const cwd = this.app.vault.adapter.basePath;
      const result = await callClaudeCode(prompt, this.sessionId, cwd);

      // Store session ID for follow-ups
      if (result.sessionId) {
        this.sessionId = result.sessionId;
      }

      this.messages.push({ role: "assistant", content: result.text });
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
        this.openChat(sel, editor.getValue(), editor);
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
        if (sel) this.openChat(sel, editor.getValue(), editor);
      }
    });

    // Show tooltip on mouseup when there's a selection
    this.registerDomEvent(document, "mouseup", (e) => {
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
    this.tooltipEl.style.top = y - 40 + "px";

    requestAnimationFrame(() => {
      const rect = this.tooltipEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        this.tooltipEl.style.left =
          window.innerWidth - rect.width - 8 + "px";
      }
      if (rect.top < 0) {
        this.tooltipEl.style.top = y + 20 + "px";
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

  async openChat(selection, doc, editor) {
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
        view.setContext(selection, doc, editor);
      }
    }
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
      .setName("System prompt")
      .setDesc("Instructions included with the first message to Claude Code")
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
