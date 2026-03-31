const obsidian = require("obsidian");
const { spawn } = require("child_process");

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = "inline-claude-panel";

const DEFAULT_SETTINGS = {
  systemPrompt:
    "You are a helpful assistant embedded in an Obsidian note editor. Answer questions about the user's selected text using the surrounding document for context. Be concise.",
};

// ─── Claude CLI Helper ───────────────────────────────────────────────────────

function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p"], { env: { ...process.env } });
    let out = "",
      err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || out))
    );
    proc.on("error", (e) => reject(e));
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

class InlineClaudeView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.selection = "";
    this.document = "";
    this.editor = null;
    this.lastResponse = "";
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Ask Claude";
  }

  getIcon() {
    return "message-circle";
  }

  async onOpen() {
    this.contentEl.addClass("inline-claude-panel");
    this.renderPanel();
  }

  async onClose() {
    this.contentEl.empty();
  }

  setContext(selection, document, editor) {
    this.selection = selection;
    this.document = document;
    this.editor = editor;
    this.renderPanel();
  }

  renderPanel() {
    const container = this.contentEl;
    container.empty();
    this.lastResponse = "";

    // Header
    container.createEl("h4", { text: "Ask Claude" });

    if (!this.selection) {
      container.createDiv({
        cls: "inline-claude-selection",
        text: "Select some text and run the command to get started.",
      });
      return;
    }

    // Selected text preview
    const selLabel = container.createDiv({
      text: "Selected text",
      cls: "setting-item-description",
    });
    selLabel.style.marginBottom = "4px";
    const selBox = container.createDiv({ cls: "inline-claude-selection" });
    selBox.textContent = this.selection;

    // Question textarea
    const textarea = container.createEl("textarea", {
      cls: "inline-claude-input",
      attr: { placeholder: "Ask a question about this text...", rows: 3 },
    });

    // Ask button
    const askBtn = container.createEl("button", {
      cls: "inline-claude-submit",
      text: "Ask",
    });

    // Response area (hidden initially)
    const responseEl = container.createDiv({ cls: "inline-claude-response" });
    responseEl.style.display = "none";

    // Action buttons (hidden initially)
    const actionsEl = container.createDiv({ cls: "inline-claude-actions" });
    actionsEl.style.display = "none";

    // Loading indicator
    const loadingEl = container.createDiv({ cls: "inline-claude-loading" });
    loadingEl.style.display = "none";
    loadingEl.textContent = "Thinking...";

    // Enter to submit, Shift+Enter for newline
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        askBtn.click();
      }
    });

    const submitQuestion = async () => {
      const question = textarea.value.trim();
      if (!question) return;

      askBtn.disabled = true;
      textarea.disabled = true;
      loadingEl.style.display = "block";
      responseEl.style.display = "none";
      actionsEl.style.display = "none";

      const prompt = this.buildPrompt(question);

      try {
        const response = await askClaude(prompt);
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
          cls: "inline-claude-error",
          text: "Error: " + err.message,
        });
      } finally {
        loadingEl.style.display = "none";
        askBtn.disabled = false;
        textarea.disabled = false;
        textarea.focus();
      }
    };

    askBtn.addEventListener("click", submitQuestion);

    // Focus textarea on open
    setTimeout(() => textarea.focus(), 50);
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

    // Insert Below
    const insertBtn = container.createEl("button", { text: "Insert Below" });
    insertBtn.addEventListener("click", () => {
      if (!this.editor || !this.lastResponse) return;
      const cursor = this.editor.getCursor("to");
      const line = this.editor.getLine(cursor.line);
      this.editor.replaceRange(
        "\n\n" + this.lastResponse,
        { line: cursor.line, ch: line.length }
      );
      new obsidian.Notice("Inserted below selection.");
    });

    // Replace Selection
    const replaceBtn = container.createEl("button", { text: "Replace" });
    replaceBtn.addEventListener("click", () => {
      if (!this.editor || !this.lastResponse) return;
      this.editor.replaceSelection(this.lastResponse);
      new obsidian.Notice("Selection replaced.");
    });

    // Copy
    const copyBtn = container.createEl("button", { text: "Copy" });
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

    this.registerView(VIEW_TYPE, (leaf) => new InlineClaudeView(leaf, this));

    this.addRibbonIcon("message-circle", "Ask Claude about selection", () => {
      this.activateFromActiveEditor();
    });

    this.addCommand({
      id: "ask-claude-about-selection",
      name: "Ask Claude about selection",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new obsidian.Notice("Select some text first.");
          return;
        }
        const document = editor.getValue();
        this.revealPanel(selection, document, editor);
      },
    });

    this.addSettingTab(new InlineClaudeSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  activateFromActiveEditor() {
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
    this.revealPanel(selection, editor.getValue(), editor);
  }

  async revealPanel(selection, document, editor) {
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
      if (view instanceof InlineClaudeView) {
        view.setContext(selection, document, editor);
      }
    }
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
  }
}

module.exports = InlineClaudePlugin;
