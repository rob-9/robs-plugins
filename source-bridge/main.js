const obsidian = require("obsidian");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { EditorView, Decoration, ViewPlugin, WidgetType } = require("@codemirror/view");
const { StateField, RangeSetBuilder } = require("@codemirror/state");
const { syntaxTree } = require("@codemirror/language");
const { editorInfoField, editorLivePreviewField } = require("obsidian");

// ─── Path detection ───────────────────────────────────────────────────────────

// Matches: /absolute/path/to/file.ext or ~/path/to/file.ext
// Optional line range: :28 or :28-42
// Optionally preceded by prefix like "Located in:" or wrapped in backticks
const PATH_REGEX = /((?:\/[\w.\-]+)+(?:\.\w+)(?::(\d+)(?:-(\d+))?)?)(?=[\s`'",;\)\]\}]|$)/g;
const PREFIX_REGEX = /(?:Located in|Implementation|Source|Code|File|See|Path)\s*:\s*/i;

function parsePath(match) {
  const colonIdx = match.indexOf(":", 1);
  // Check if colon is part of line range (after the file extension)
  const extMatch = match.match(/\.\w+/g);
  if (!extMatch) return null;

  const lastExt = match.lastIndexOf(extMatch[extMatch.length - 1]);
  const afterExt = lastExt + extMatch[extMatch.length - 1].length;
  const rest = match.slice(afterExt);

  let filePath = match;
  let lineStart = null;
  let lineEnd = null;

  const lineMatch = rest.match(/^:(\d+)(?:-(\d+))?/);
  if (lineMatch) {
    filePath = match.slice(0, afterExt);
    lineStart = parseInt(lineMatch[1]);
    lineEnd = lineMatch[2] ? parseInt(lineMatch[2]) : lineStart;
  }

  return { filePath, lineStart, lineEnd, fullMatch: match };
}

function expandHome(filePath) {
  if (filePath.startsWith("~/")) {
    return path.join(process.env.HOME || "", filePath.slice(2));
  }
  return filePath;
}

function readFileLines(filePath, lineStart, lineEnd) {
  const resolved = expandHome(filePath);
  if (!fs.existsSync(resolved)) return { error: "File not found", content: null };

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split("\n");

    if (lineStart !== null) {
      const start = Math.max(0, lineStart - 1);
      const end = Math.min(lines.length, lineEnd || lineStart);
      return {
        error: null,
        content: lines.slice(start, end).join("\n"),
        totalLines: lines.length,
        shownRange: [start + 1, end]
      };
    }

    // No line range: show first 50 lines
    const preview = lines.slice(0, 50);
    return {
      error: null,
      content: preview.join("\n") + (lines.length > 50 ? "\n// ... (" + (lines.length - 50) + " more lines)" : ""),
      totalLines: lines.length,
      shownRange: [1, Math.min(50, lines.length)]
    };
  } catch (e) {
    return { error: e.message, content: null };
  }
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map = {
    py: "python", js: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx",
    cpp: "cpp", cc: "cpp", cxx: "cpp", c: "c", h: "c", hpp: "cpp",
    java: "java", go: "go", rs: "rust", rb: "ruby", sh: "bash", zsh: "bash",
    yaml: "yaml", yml: "yaml", json: "json", md: "markdown", sql: "sql",
    html: "html", css: "css", xml: "xml", toml: "toml", ini: "ini",
    swift: "swift", kt: "kotlin", r: "r", m: "matlab", lua: "lua",
    dockerfile: "dockerfile", tf: "hcl", proto: "protobuf"
  };
  return map[ext] || ext || "text";
}

function getFileHash(filePath) {
  const resolved = expandHome(filePath);
  if (!fs.existsSync(resolved)) return null;
  try {
    const stat = fs.statSync(resolved);
    return `${stat.size}-${stat.mtimeMs}`;
  } catch { return null; }
}

// ─── Reading Mode ─────────────────────────────────────────────────────────────

function createPreviewElement(parsed, plugin) {
  const container = createDiv({ cls: "source-bridge-container" });

  // Header bar
  const header = container.createDiv({ cls: "source-bridge-header" });

  const headerLeft = header.createDiv({ cls: "source-bridge-header-left" });

  // Chevron
  const chevron = headerLeft.createSpan({ cls: "source-bridge-chevron", text: "▶" });

  // File path (shortened)
  const displayPath = parsed.filePath.replace(process.env.HOME || "", "~");
  headerLeft.createSpan({ cls: "source-bridge-path", text: displayPath });

  // Line range badge
  if (parsed.lineStart) {
    const rangeText = parsed.lineEnd && parsed.lineEnd !== parsed.lineStart
      ? `L${parsed.lineStart}-${parsed.lineEnd}`
      : `L${parsed.lineStart}`;
    headerLeft.createSpan({ cls: "source-bridge-lines", text: rangeText });
  }

  const headerRight = header.createDiv({ cls: "source-bridge-header-right" });

  // Staleness indicator
  const hash = getFileHash(parsed.filePath);
  const staleEl = headerRight.createSpan({ cls: "source-bridge-stale" });
  if (hash === null) {
    staleEl.classList.add("is-missing");
    staleEl.setAttribute("aria-label", "File not found");
  } else {
    staleEl.classList.add("is-fresh");
    staleEl.setAttribute("aria-label", "File exists");
  }

  // Open button
  const openBtn = headerRight.createEl("button", { cls: "source-bridge-open-btn", text: "Open" });
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openFileExternally(parsed.filePath, parsed.lineStart, plugin);
  });

  // Preview pane (hidden by default)
  const preview = container.createDiv({ cls: "source-bridge-preview" });

  // Toggle expand on header click
  header.addEventListener("click", () => {
    const isExpanded = container.classList.toggle("is-expanded");
    if (isExpanded && !preview.hasChildNodes()) {
      renderPreview(preview, parsed, plugin);
    }
  });

  return container;
}

async function renderPreview(previewEl, parsed, plugin) {
  const result = readFileLines(parsed.filePath, parsed.lineStart, parsed.lineEnd);

  if (result.error) {
    previewEl.createDiv({ cls: "source-bridge-error", text: result.error });
    return;
  }

  const lang = detectLanguage(parsed.filePath);
  const codeBlock = "```" + lang + "\n" + result.content + "\n```";

  await obsidian.MarkdownRenderer.render(
    plugin.app, codeBlock, previewEl, "", plugin
  );
}

function openFileExternally(filePath, lineStart, plugin) {
  const resolved = expandHome(filePath);
  const settings = plugin.settings;

  if (settings.editor === "vscode") {
    const lineArg = lineStart ? `:${lineStart}` : "";
    try { execSync(`code --goto "${resolved}${lineArg}"`); } catch {}
  } else if (settings.editor === "cursor") {
    const lineArg = lineStart ? `:${lineStart}` : "";
    try { execSync(`cursor --goto "${resolved}${lineArg}"`); } catch {}
  } else {
    // System default
    const { shell } = require("electron");
    shell.openPath(resolved);
  }
}

// ─── Reading Mode Post-Processor ──────────────────────────────────────────────

function createReadingModeProcessor(plugin) {
  return (el, ctx) => {
    // Don't process code blocks
    if (el.querySelector("pre")) return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const replacements = [];

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const text = textNode.textContent;
      if (!text) continue;

      // Skip if inside a code element
      if (textNode.parentElement && textNode.parentElement.closest("code, pre")) continue;

      PATH_REGEX.lastIndex = 0;
      let match;
      while ((match = PATH_REGEX.exec(text)) !== null) {
        const parsed = parsePath(match[1]);
        if (!parsed) continue;

        // Verify file exists or has known extension
        const resolved = expandHome(parsed.filePath);
        if (!fs.existsSync(resolved)) continue;

        replacements.push({
          node: textNode,
          start: match.index,
          end: match.index + match[1].length,
          parsed
        });
      }
    }

    // Process replacements in reverse to maintain offsets
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { node, start, end, parsed } = replacements[i];
      const text = node.textContent;

      const before = document.createTextNode(text.slice(0, start));
      const after = document.createTextNode(text.slice(end));

      const container = createDiv({ cls: "source-bridge-inline" });

      // Clickable path link
      const link = container.createEl("span", {
        cls: "source-bridge-link",
        text: parsed.fullMatch.replace(process.env.HOME || "", "~")
      });
      link.addEventListener("click", () => {
        openFileExternally(parsed.filePath, parsed.lineStart, plugin);
      });

      // Expandable preview widget
      const previewWidget = createPreviewElement(parsed, plugin);

      const parent = node.parentNode;
      parent.insertBefore(before, node);
      parent.insertBefore(container, node);
      parent.insertBefore(previewWidget, node);
      parent.insertBefore(after, node);
      parent.removeChild(node);
    }
  };
}

// ─── Editing Mode (CM6) ──────────────────────────────────────────────────────

function createEditorExtension(plugin) {
  const pathDecoration = Decoration.mark({ class: "cm-source-bridge-link" });

  const decorationField = StateField.define({
    create(state) {
      return buildDecorations(state);
    },
    update(value, tr) {
      if (tr.docChanged || tr.selectionSet) {
        return buildDecorations(tr.state);
      }
      return value;
    },
    provide(field) {
      return EditorView.decorations.from(field);
    }
  });

  function buildDecorations(state) {
    if (!state.field(editorLivePreviewField)) return Decoration.none;

    const builder = new RangeSetBuilder();
    const doc = state.doc;

    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const text = line.text;

      // Skip lines inside code blocks
      const tree = syntaxTree(state);
      let inCodeBlock = false;
      tree.iterate({
        from: line.from,
        to: line.from,
        enter(node) {
          if (node.name.includes("CodeBlock") || node.name.includes("codeblock") ||
              node.name.includes("HyperMD-codeblock")) {
            inCodeBlock = true;
          }
        }
      });
      if (inCodeBlock) continue;

      PATH_REGEX.lastIndex = 0;
      let match;
      while ((match = PATH_REGEX.exec(text)) !== null) {
        const parsed = parsePath(match[1]);
        if (!parsed) continue;

        const resolved = expandHome(parsed.filePath);
        if (!fs.existsSync(resolved)) continue;

        const from = line.from + match.index;
        const to = line.from + match.index + match[1].length;

        // Don't decorate if cursor is in the range
        const cursorInRange = state.selection.ranges.some(
          r => r.from <= to && r.to >= from
        );
        if (!cursorInRange) {
          builder.add(from, to, pathDecoration);
        }
      }
    }

    return builder.finish();
  }

  // Click handler
  const clickHandler = EditorView.domEventHandlers({
    click(event, view) {
      if (!event.metaKey && !event.ctrlKey) return false;

      const target = event.target;
      if (!target.classList.contains("cm-source-bridge-link")) return false;

      const pos = view.posAtDOM(target);
      const line = view.state.doc.lineAt(pos);

      PATH_REGEX.lastIndex = 0;
      let match;
      while ((match = PATH_REGEX.exec(line.text)) !== null) {
        const matchFrom = line.from + match.index;
        const matchTo = line.from + match.index + match[1].length;
        if (pos >= matchFrom && pos <= matchTo) {
          const parsed = parsePath(match[1]);
          if (parsed) {
            openFileExternally(parsed.filePath, parsed.lineStart, plugin);
            return true;
          }
        }
      }
      return false;
    }
  });

  return [decorationField, clickHandler];
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  editor: "vscode"
};

class SourceBridgeSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new obsidian.Setting(containerEl)
      .setName("External editor")
      .setDesc("Which editor to open files in when clicking 'Open'")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("vscode", "VS Code")
          .addOption("cursor", "Cursor")
          .addOption("system", "System default")
          .setValue(this.plugin.settings.editor)
          .onChange(async (value) => {
            this.plugin.settings.editor = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class SourceBridgePlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    // Reading mode
    this.registerMarkdownPostProcessor(createReadingModeProcessor(this));

    // Editing mode (live preview)
    this.registerEditorExtension(createEditorExtension(this));

    // Command: Insert source reference
    this.addCommand({
      id: "insert-source-reference",
      name: "Insert source reference",
      editorCallback: async (editor) => {
        const { remote } = require("electron");
        const result = await remote.dialog.showOpenDialog({
          properties: ["openFile"],
          title: "Select source file"
        });

        if (result.canceled || result.filePaths.length === 0) return;

        let filePath = result.filePaths[0];
        // Shorten home directory
        if (process.env.HOME && filePath.startsWith(process.env.HOME)) {
          filePath = "~" + filePath.slice(process.env.HOME.length);
        }

        editor.replaceSelection("`" + filePath + "`");
      }
    });

    this.addSettingTab(new SourceBridgeSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = SourceBridgePlugin;
