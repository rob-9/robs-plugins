const obsidian = require("obsidian");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = "inline-claude-chat";

const DEFAULT_SETTINGS = {
  systemPrompt:
    "You are a helpful assistant embedded in an Obsidian note editor. The user will ask questions about selected text from their notes. Be concise. You have full access to their files via Claude Code.",
  chatHue: "155, 114, 207",
  selectionHue: "155, 114, 207",
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

function formatToolUse(name, input) {
  const file = input?.file_path?.split("/").pop();
  switch (name) {
    case "Read": return `Reading ${file || "file"}…`;
    case "Edit": return `Editing ${file || "file"}…`;
    case "Write": return `Writing ${file || "file"}…`;
    case "MultiEdit": return `Editing ${file || "file"}…`;
    case "Bash": return `Running command…`;
    case "Grep": return `Searching files…`;
    case "Glob": return `Finding files…`;
    case "WebSearch": return `Searching the web…`;
    case "WebFetch": return `Fetching page…`;
    case "TodoWrite": return `Updating tasks…`;
    default: return `Using ${name}…`;
  }
}

/**
 * Discover Claude Code sessions for a given project cwd by reading
 * ~/.claude/projects/<project-dir>/*.jsonl files.
 */
async function discoverSessions(cwd) {
  const projectDir = path.join(
    process.env.HOME || "",
    ".claude",
    "projects",
    cwd.replace(/\//g, "-")
  );

  let files;
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const sessions = [];
  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const filePath = path.join(projectDir, file);
    try {
      const stat = fs.statSync(filePath);
      // Read first few lines to find the first user message
      const stream = fs.createReadStream(filePath, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream });
      let label = "";
      let linesRead = 0;
      for await (const line of rl) {
        if (++linesRead > 10) break;
        try {
          const event = JSON.parse(line);
          if (event.type === "user" && event.message?.content) {
            const content = typeof event.message.content === "string"
              ? event.message.content
              : event.message.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("");
            // Extract the actual question if prompt has ## Question section
            const qMatch = content.match(/## Question\n([\s\S]*)/);
            if (qMatch) {
              label = qMatch[1].trim().split("\n")[0];
            } else {
              label = content.replace(/^#+\s*/gm, "").trim().split("\n")[0];
            }
            if (label.length > 50) label = label.slice(0, 50) + "…";
            break;
          }
        } catch {}
      }
      rl.close();
      stream.destroy();

      sessions.push({
        id: sessionId,
        label: label || sessionId.slice(0, 8),
        mtime: stat.mtimeMs,
      });
    } catch {}
  }

  // Sort by most recently modified
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

/**
 * Load conversation history from a session's JSONL file.
 * Returns an array of { role, content, display? } messages.
 */
async function loadSessionHistory(cwd, sessionId) {
  const projectDir = path.join(
    process.env.HOME || "",
    ".claude",
    "projects",
    cwd.replace(/\//g, "-")
  );
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);

  const messages = [];
  try {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === "user" && event.message?.content) {
          const raw = typeof event.message.content === "string"
            ? event.message.content
            : event.message.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("");
          // Skip tool result messages (no text content)
          if (!raw.trim()) continue;
          // Extract display text — use question part if prompt has context prefix
          const qMatch = raw.match(/## Question\n([\s\S]*)/);
          const display = qMatch ? qMatch[1].trim() : raw.split("\n")[0];
          messages.push({ role: "user", content: raw, display });
        }

        if (event.type === "assistant" && event.message?.content) {
          const text = (Array.isArray(event.message.content)
            ? event.message.content : [event.message.content])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (text) {
            messages.push({ role: "assistant", content: text });
          }
        }
      } catch {}
    }

    rl.close();
    stream.destroy();
  } catch {}

  return messages;
}

function callClaudeCode(prompt, sessionId, cwd, onStream, onToolUse, systemPrompt) {
  const controller = { proc: null };

  const promise = new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const claudePath = findClaude();
    const proc = spawn(claudePath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.end();
    controller.proc = proc;

    let buffer = "";
    let stderr = "";
    let resultSessionId = null;

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();

      // Parse newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant" && event.message?.content) {
            // Surface tool usage as progress indicators
            for (const block of event.message.content) {
              if (block.type === "tool_use" && onToolUse) {
                onToolUse(block.name, block.input);
              }
            }
            // Extract text from content blocks
            const text = event.message.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (text && onStream) onStream(text);
          }

          if (event.type === "result") {
            resultSessionId = event.session_id || null;
          }
        } catch {}
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => reject(err));

    proc.on("close", (code) => {
      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") {
            resultSessionId = event.session_id || null;
            resolve({
              text: event.result || "",
              sessionId: resultSessionId,
            });
            return;
          }
        } catch {}
      }

      if (code !== 0) {
        reject(new Error(stderr || `Claude Code exited with code ${code}`));
        return;
      }

      resolve({ text: "", sessionId: resultSessionId });
    });
  });

  promise.cancel = () => {
    if (controller.proc) controller.proc.kill();
  };
  return promise;
}

// ─── Chat View (persistent sidebar) ─────────────────────────────────────────

class InlineClaudeChatView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.selectionText = "";
    this.docText = "";
    this.isLoading = false;
    this.discoveredSessions = [];
    this.sessionMessageCache = new Map();
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
    this.contentEl.addClass("ic-entering");
    this.refreshSessions();
  }

  async refreshSessions() {
    const cwd = this.app.vault.adapter.basePath;
    this.discoveredSessions = await discoverSessions(cwd);
    if (this.plugin.sessionId && this.messages.length === 0) {
      this.messages = await loadSessionHistory(cwd, this.plugin.sessionId);
    }
    this.render();
  }

  addStatus(text) {
    this.messages.push({ role: "status", content: text, _new: true });
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
    this.render();
  }

  _cacheCurrentSession() {
    const key = this.plugin.sessionId || "__new__";
    if (this.messages.length > 0) {
      this.sessionMessageCache.set(key, {
        messages: [...this.messages],
        selectionText: this.selectionText,
        docText: this.docText,
      });
    }
  }

  _restoreSession(sessionId) {
    const key = sessionId || "__new__";
    const cached = this.sessionMessageCache.get(key);
    if (cached) {
      this.messages = [...cached.messages];
      this.selectionText = cached.selectionText;
      this.docText = cached.docText;
    } else {
      this.messages = [];
      this.selectionText = "";
      this.docText = "";
    }
  }

  async switchSession(sessionId) {
    if (this.activeRequest) {
      this.activeRequest.cancel();
      this.activeRequest = null;
    }
    this.isLoading = false;
    this._cacheCurrentSession();
    this.plugin.sessionId = sessionId;
    this.plugin.saveSettings();

    // Restore from local cache, or load from JSONL on disk
    const key = sessionId || "__new__";
    const cached = this.sessionMessageCache.get(key);
    if (cached) {
      this.messages = [...cached.messages];
      this.selectionText = cached.selectionText;
      this.docText = cached.docText;
    } else if (sessionId) {
      const cwd = this.app.vault.adapter.basePath;
      this.messages = await loadSessionHistory(cwd, sessionId);
      this.selectionText = "";
      this.docText = "";
    } else {
      this.messages = [];
      this.selectionText = "";
      this.docText = "";
    }

    this.render();
  }

  newSession() {
    if (this.activeRequest) {
      this.activeRequest.cancel();
      this.activeRequest = null;
    }
    this.isLoading = false;
    this._cacheCurrentSession();
    this.plugin.sessionId = null;
    this.plugin.saveSettings();
    this.messages = [];
    this.selectionText = "";
    this.docText = "";
    this.refreshSessions();
  }

  render() {
    const container = this.contentEl;
    container.empty();

    // Header bar with session selector + new session button
    const headerBar = container.createDiv({ cls: "ic-chat-header" });

    // Session dropdown — always shown, reads from Claude Code's session files
    const select = headerBar.createEl("select", { cls: "ic-session-select" });
    select.createEl("option", { value: "", text: "New session" });
    for (const s of this.discoveredSessions.slice(0, 20)) {
      const opt = select.createEl("option", {
        value: s.id,
        text: s.label,
      });
      if (s.id === this.plugin.sessionId) opt.selected = true;
    }
    if (!this.plugin.sessionId) select.value = "";

    select.addEventListener("change", () => {
      this.switchSession(select.value || null);
    });

    // New session button
    const newBtn = headerBar.createEl("button", {
      cls: "ic-chat-header-btn",
      attr: { "aria-label": "New session" },
    });
    obsidian.setIcon(newBtn, "plus");
    newBtn.addEventListener("click", () => {
      this.newSession();
    });

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
      if (msg.role === "status") {
        const statusEl = messagesEl.createDiv({
          cls: "ic-chat-status",
          text: msg.content,
        });
        if (msg._new) statusEl.addClass("ic-new");
        msg._new = false;
        continue;
      }

      const row = messagesEl.createDiv({
        cls: `ic-chat-row ic-chat-${msg.role}`,
      });
      if (msg._new) row.addClass("ic-new");
      msg._new = false;
      const bubble = row.createDiv({ cls: "ic-chat-bubble" });

      if (msg.role === "assistant" && msg.streaming) {
        // Streaming bubble — updated in-place by renderStreamBubble
        bubble.addClass("ic-chat-stream-bubble");
        if (msg.content) {
          obsidian.MarkdownRenderer.render(
            this.app, msg.content, bubble, "", this.plugin
          );
        } else if (msg.toolActivity) {
          bubble.createEl("span", { cls: "ic-spinner" });
          bubble.createEl("span", { text: " " + msg.toolActivity });
        } else {
          bubble.createEl("span", { cls: "ic-spinner" });
          bubble.createEl("span", { text: " Thinking…" });
        }
        continue;
      }

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
          this.addStatus("Copied to clipboard.");
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
            this.addStatus("No active editor.");
            return;
          }
          const cursor = editor.getCursor("to");
          const line = editor.getLine(cursor.line);
          editor.replaceRange("\n\n" + msg.content, {
            line: cursor.line,
            ch: line.length,
          });
          this.addStatus("Inserted below cursor.");
        });

        const smartBtn = actions.createEl("button", {
          cls: "ic-chat-action-btn",
          attr: { "aria-label": "Smart add to file" },
        });
        obsidian.setIcon(smartBtn, "wand");
        smartBtn.addEventListener("click", async () => {
          const file = this.app.workspace.getActiveFile();
          if (!file) {
            this.addStatus("No active file.");
            return;
          }
          const filePath = file.path;
          this.messages.push({ role: "assistant", content: "Adding to file…", _new: true });
          this.render();

          try {
            const cwd = this.app.vault.adapter.basePath;
            const prompt =
              "Add the following content to the file `" + filePath + "` " +
              "in the most appropriate location. Match the file's existing " +
              "style and formatting. Do not remove or change existing content. " +
              "Just integrate this new content where it fits best:\n\n" +
              msg.content;
            await callClaudeCode(prompt, this.plugin.sessionId, cwd);
            this.messages.push({ role: "assistant", content: "Added to file.", _new: true });
            this.render();
          } catch (err) {
            this.messages.push({ role: "assistant", content: "**Failed:** " + err.message, _new: true });
            this.render();
          }
        });
      } else {
        bubble.innerText = msg.display || msg.content;
      }
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

    // Scroll to bottom
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  renderStreamBubble(text, toolActivity) {
    const el = this.contentEl.querySelector(".ic-chat-stream-bubble");
    if (!el) return;
    el.empty();
    if (text) {
      obsidian.MarkdownRenderer.render(this.app, text, el, "", this.plugin);
    } else if (toolActivity) {
      el.createEl("span", { cls: "ic-spinner" });
      el.createEl("span", { text: " " + toolActivity });
    } else {
      el.createEl("span", { cls: "ic-spinner" });
      el.createEl("span", { text: " Thinking…" });
    }
    // Scroll to bottom
    const messagesEl = this.contentEl.querySelector(".ic-chat-messages");
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
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

    this.messages.push({ role: "user", content: prompt, display: text, _new: true });

    // Add a streaming assistant message placeholder
    const streamMsg = { role: "assistant", content: "", streaming: true, _new: true };
    this.messages.push(streamMsg);
    this.isLoading = true;
    this.render();

    try {
      const cwd = this.app.vault.adapter.basePath;
      let accumulated = "";

      this.activeRequest = callClaudeCode(
        prompt,
        this.plugin.sessionId,
        cwd,
        (text) => {
          accumulated = text;
          streamMsg.content = text;
          streamMsg.toolActivity = null;
          this.renderStreamBubble(text);
        },
        (toolName, toolInput) => {
          const activity = formatToolUse(toolName, toolInput);
          streamMsg.toolActivity = activity;
          if (!streamMsg.content) {
            this.renderStreamBubble(null, activity);
          }
        },
        isFirst ? this.plugin.settings.systemPrompt : undefined
      );

      const result = await this.activeRequest;

      // Finalize with result text (may be more complete than streamed chunks)
      streamMsg.content = result.text || accumulated;
      streamMsg.streaming = false;

      if (result.sessionId) {
        const isNew = this.plugin.sessionId !== result.sessionId;
        this.plugin.sessionId = result.sessionId;
        if (isNew) {
          this.plugin.addSession(result.sessionId, text);
        } else {
          this.plugin.saveSettings();
        }
      }
    } catch (err) {
      streamMsg.content = `**Error:** ${err.message}`;
      streamMsg.streaming = false;
    } finally {
      this.activeRequest = null;
      this.isLoading = false;
      this.render();
    }
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class InlineClaudePlugin extends obsidian.Plugin {
  applyHues() {
    const root = document.documentElement;
    root.style.setProperty("--ic-chat-hue", this.settings.chatHue);
    root.style.setProperty("--ic-sel-hue", this.settings.selectionHue);
  }

  async onload() {
    await this.loadSettings();
    this.applyHues();

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
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.sessionId = data.sessionId || null;
    this.sessions = data.sessions || [];
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      sessionId: this.sessionId,
      sessions: this.sessions,
    });
  }

  addSession(id, label) {
    // Don't duplicate
    if (this.sessions.find((s) => s.id === id)) return;
    this.sessions.unshift({
      id,
      label: label.length > 40 ? label.slice(0, 40) + "…" : label,
      createdAt: Date.now(),
    });
    // Keep at most 30 sessions
    if (this.sessions.length > 30) this.sessions.pop();
    this.saveSettings();
  }

  removeSession(id) {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessionId === id) this.sessionId = null;
    this.saveSettings();
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

    new obsidian.Setting(containerEl)
      .setName("Chat hue")
      .setDesc("RGB values for chat bubbles, buttons, spinner (e.g. 155, 114, 207)")
      .addText((t) =>
        t
          .setPlaceholder("155, 114, 207")
          .setValue(this.plugin.settings.chatHue)
          .onChange(async (v) => {
            this.plugin.settings.chatHue = v.trim();
            await this.plugin.saveSettings();
            this.plugin.applyHues();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("Selection hue")
      .setDesc("RGB values for selected text section (e.g. 100, 160, 220)")
      .addText((t) =>
        t
          .setPlaceholder("100, 160, 220")
          .setValue(this.plugin.settings.selectionHue)
          .onChange(async (v) => {
            this.plugin.settings.selectionHue = v.trim();
            await this.plugin.saveSettings();
            this.plugin.applyHues();
          })
      );
  }
}

module.exports = InlineClaudePlugin;
InlineClaudePlugin._test = {
  InlineClaudeChatView,
  discoverSessions,
  loadSessionHistory,
  formatToolUse,
  VIEW_TYPE,
};
