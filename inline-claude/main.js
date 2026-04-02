const obsidian = require("obsidian");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  systemPrompt:
    "You are a helpful assistant embedded in an Obsidian note editor. Answer questions about the user's selected text using the surrounding document for context. Be concise.",
  claudePath: path.join(os.homedir(), ".local", "bin", "claude"),
};

// ─── Claude CLI Helper ───────────────────────────────────────────────────────

function askClaude(claudePath, prompt) {
  const proc = spawn(claudePath, ["-p"], {
    env: { ...process.env, PATH: process.env.PATH + ":/usr/local/bin:/opt/homebrew/bin" },
  });
  let out = "",
    err = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (err += d));
  const promise = new Promise((resolve, reject) => {
    proc.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || out))
    );
    proc.on("error", (e) =>
      reject(new Error(`Failed to run claude CLI: ${e.message}`))
    );
  });
  proc.stdin.write(prompt);
  proc.stdin.end();
  promise.proc = proc;
  return promise;
}

// ─── Modal ───────────────────────────────────────────────────────────────────

class InlineClaudeModal extends obsidian.Modal {
  constructor(app, plugin, selection, document, editor) {
    super(app);
    this.plugin = plugin;
    this.selection = selection;
    this.document = document;
    this.editor = editor;
    this.lastResponse = "";
    this._activeProc = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("inline-claude-modal");

    // Selection preview
    const selSection = contentEl.createDiv({ cls: "ic-section" });
    selSection.createEl("label", { text: "Selected text", cls: "ic-label" });
    const selBox = selSection.createDiv({ cls: "ic-selection" });
    const selText = typeof this.selection === "string" ? this.selection : JSON.stringify(this.selection);
    selBox.setText(selText.length > 500 ? selText.slice(0, 500) + "…" : selText);

    // Question input
    const inputSection = contentEl.createDiv({ cls: "ic-section" });
    const textarea = inputSection.createEl("textarea", {
      cls: "ic-input",
      attr: { placeholder: "Ask a question about this text…", rows: 2 },
    });

    // Loading
    const loadingEl = contentEl.createDiv({ cls: "ic-loading" });
    loadingEl.style.display = "none";
    const spinner = loadingEl.createSpan({ cls: "ic-spinner" });
    loadingEl.createSpan({ text: "Thinking…" });

    // Response
    const responseEl = contentEl.createDiv({ cls: "ic-response" });
    responseEl.style.display = "none";

    // Actions
    const actionsEl = contentEl.createDiv({ cls: "ic-actions" });
    actionsEl.style.display = "none";

    // Submit handler
    const submit = async () => {
      const question = textarea.value.trim();
      if (!question) return;

      textarea.disabled = true;
      loadingEl.style.display = "flex";
      responseEl.style.display = "none";
      actionsEl.style.display = "none";

      const prompt = this.buildPrompt(question);

      if (this._activeProc) this._activeProc.kill();

      try {
        const request = askClaude(this.plugin.settings.claudePath, prompt);
        this._activeProc = request.proc;
        const response = await request;
        this.lastResponse = response.trim();

        responseEl.empty();
        responseEl.style.display = "block";
        await obsidian.MarkdownRenderer.render(
          this.app,
          this.lastResponse,
          responseEl,
          "",
          this.plugin
        );

        this.renderActions(actionsEl);
        actionsEl.style.display = "flex";
      } catch (err) {
        responseEl.style.display = "block";
        responseEl.empty();
        responseEl.createDiv({
          cls: "ic-error",
          text: err.message,
        });
      } finally {
        this._activeProc = null;
        loadingEl.style.display = "none";
        textarea.disabled = false;
        textarea.focus();
      }
    };

    // Enter to submit
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    // Focus
    requestAnimationFrame(() => textarea.focus());
  }

  onClose() {
    if (this._activeProc) this._activeProc.kill();
    this.contentEl.empty();
  }

  buildPrompt(question) {
    const sys = this.plugin.settings.systemPrompt;
    return (
      sys +
      "\n\n## Document Context\n" +
      this.document +
      "\n\n## Selected Text\n" +
      this.selection +
      "\n\n## Question\n" +
      question
    );
  }

  renderActions(container) {
    container.empty();

    const insertBtn = container.createEl("button", {
      text: "Insert below",
      cls: "ic-btn",
    });
    insertBtn.addEventListener("click", () => {
      if (!this.editor || !this.lastResponse) return;
      const cursor = this.editor.getCursor("to");
      const line = this.editor.getLine(cursor.line);
      this.editor.replaceRange("\n\n" + this.lastResponse, {
        line: cursor.line,
        ch: line.length,
      });
      new obsidian.Notice("Inserted below selection.");
      this.close();
    });

    const replaceBtn = container.createEl("button", {
      text: "Replace",
      cls: "ic-btn",
    });
    replaceBtn.addEventListener("click", () => {
      if (!this.editor || !this.lastResponse) return;
      this.editor.replaceSelection(this.lastResponse);
      new obsidian.Notice("Selection replaced.");
      this.close();
    });

    const copyBtn = container.createEl("button", {
      text: "Copy",
      cls: "ic-btn",
    });
    copyBtn.addEventListener("click", () => {
      if (!this.lastResponse) return;
      navigator.clipboard.writeText(this.lastResponse);
      new obsidian.Notice("Copied to clipboard.");
    });
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class InlineClaudePlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "ask-claude-about-selection",
      name: "Ask Claude about selection",
      editorCallback: () => this.openModal(),
    });

    // Right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) => {
          item
            .setTitle("Ask Claude")
            .setIcon("message-circle")
            .onClick(() => this.openModal());
        });
      })
    );

    this.addSettingTab(new InlineClaudeSettingTab(this.app, this));
  }

  openModal() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view) {
      new obsidian.Notice("Open a markdown file first.");
      return;
    }
    const editor = view.editor;
    const selection = editor.getSelection();
    if (!selection) {
      new obsidian.Notice("Select some text first.");
      return;
    }
    const doc = editor.getValue();
    new InlineClaudeModal(this.app, this, selection, doc, editor).open();
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
      .setDesc("Instructions sent to Claude with every query")
      .addTextArea((text) =>
        text
          .setPlaceholder("You are a helpful assistant...")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("Claude CLI path")
      .setDesc("Full path to the claude binary")
      .addText((text) =>
        text
          .setPlaceholder("/Users/you/.local/bin/claude")
          .setValue(this.plugin.settings.claudePath)
          .onChange(async (value) => {
            this.plugin.settings.claudePath = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = InlineClaudePlugin;
