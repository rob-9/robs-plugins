const obsidian = require("obsidian");

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = "complexity-panel";

// Matches O(...), Theta(...), Omega(...) with various inner expressions
// Captures: full match like "O(n log n)" or "Theta(n^2)"
const BIGO_REGEX = /[O\u0398\u03A9]\s*\(\s*([^)]*)\s*\)/g;

// Common complexity classes for color coding
const COMPLEXITY_COLORS = {
  "1": "green",
  "log n": "green",
  "logn": "green",
  "log(n)": "green",
  "sqrt(n)": "yellow",
  "n": "yellow",
  "n log n": "yellow",
  "nlogn": "yellow",
  "n log(n)": "yellow",
  "n^2": "orange",
  "n^3": "orange",
  "2^n": "red",
  "n!": "red",
  "n^n": "red",
};

function getComplexityColor(inner) {
  const normalized = inner.replace(/\s+/g, " ").trim().toLowerCase();
  if (COMPLEXITY_COLORS[normalized]) return COMPLEXITY_COLORS[normalized];

  // Heuristic fallbacks
  if (/^1$/.test(normalized)) return "green";
  if (/log/.test(normalized) && !/n\s*log/.test(normalized)) return "green";
  if (/^n$/.test(normalized)) return "yellow";
  if (/n\s*log/.test(normalized)) return "yellow";
  if (/n\s*\^\s*2/.test(normalized)) return "orange";
  if (/n\s*\^\s*3/.test(normalized)) return "orange";
  if (/2\s*\^\s*n/.test(normalized) || /n!/.test(normalized)) return "red";

  return "gray";
}

// ─── Complexity Extraction ────────────────────────────────────────────────────

function extractCodeBlocks(content) {
  const blocks = [];
  const lines = content.split("\n");
  let inBlock = false;
  let blockStart = -1;
  let blockLang = "";
  let blockTitle = "";
  let blockLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openMatch = line.match(/^```(\w*)\s*(.*)?$/);

    if (!inBlock && openMatch) {
      inBlock = true;
      blockStart = i;
      blockLang = openMatch[1] || "";
      blockTitle = (openMatch[2] || "").replace(/^title:?\s*/i, "").trim();
      blockLines = [];
    } else if (inBlock && line.trim() === "```") {
      blocks.push({
        lang: blockLang,
        title: blockTitle,
        code: blockLines.join("\n"),
        lineStart: blockStart,
        lineEnd: i,
      });
      inBlock = false;
      blockLang = "";
      blockTitle = "";
      blockLines = [];
    } else if (inBlock) {
      blockLines.push(line);
    }
  }

  return blocks;
}

function findAnnotationsForBlock(content, block) {
  const lines = content.split("\n");
  let time = null;
  let space = null;

  // Search window: 5 lines before the code block, the code block itself, and 5 lines after
  const searchStart = Math.max(0, block.lineStart - 5);
  const searchEnd = Math.min(lines.length - 1, block.lineEnd + 5);

  const searchRegion = lines.slice(searchStart, searchEnd + 1).join("\n");

  // Also search inside the code block for comments containing Big-O
  const codeRegion = block.code;

  const regions = [searchRegion, codeRegion];

  for (const region of regions) {
    BIGO_REGEX.lastIndex = 0;
    let match;
    while ((match = BIGO_REGEX.exec(region)) !== null) {
      const fullMatch = match[0];
      const inner = match[1].trim();
      const surroundingStart = Math.max(0, match.index - 40);
      const surrounding = region.slice(surroundingStart, match.index + fullMatch.length + 40).toLowerCase();

      if (/time/i.test(surrounding)) {
        if (!time) time = { notation: fullMatch, inner: inner };
      } else if (/space|memory/i.test(surrounding)) {
        if (!space) space = { notation: fullMatch, inner: inner };
      } else {
        // No keyword - assign to time if time is empty, then space
        if (!time) {
          time = { notation: fullMatch, inner: inner };
        } else if (!space) {
          space = { notation: fullMatch, inner: inner };
        }
      }
    }
  }

  return { time, space };
}

function findConstraintTables(content) {
  const tables = [];
  const lines = content.split("\n");

  // Look for markdown tables with constraint patterns
  // e.g. | n < 3000 | O(n^2) |
  const constraintRowRegex = /\|\s*(n\s*[<≤]\s*[\d,]+)\s*\|\s*([O\u0398\u03A9]\s*\([^)]*\))\s*\|/gi;

  let match;
  while ((match = constraintRowRegex.exec(content)) !== null) {
    const constraint = match[1].trim();
    const complexity = match[2].trim();

    BIGO_REGEX.lastIndex = 0;
    const cMatch = BIGO_REGEX.exec(complexity);
    const inner = cMatch ? cMatch[1].trim() : complexity;

    tables.push({ constraint, complexity, inner });
  }

  return tables;
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

class ComplexityPanelView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Complexity";
  }

  getIcon() {
    return "gauge";
  }

  async onOpen() {
    this.contentEl.addClass("complexity-panel");
    this.renderPanel();
  }

  async onClose() {
    this.contentEl.empty();
  }

  renderPanel() {
    const container = this.contentEl;
    container.empty();

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      container.createDiv({ cls: "complexity-empty", text: "No active note." });
      return;
    }

    this.app.vault.cachedRead(activeFile).then((content) => {
      this.renderContent(container, content, activeFile.basename);
    }).catch(() => {
      container.createDiv({ cls: "complexity-empty", text: "Unable to read note." });
    });
  }

  renderContent(container, content, filename) {
    container.empty();

    // Header
    const header = container.createDiv({ cls: "complexity-header" });
    header.createEl("h4", { text: filename });

    const blocks = extractCodeBlocks(content);
    const constraintTable = findConstraintTables(content);

    if (blocks.length === 0 && constraintTable.length === 0) {
      container.createDiv({
        cls: "complexity-empty",
        text: "No code blocks or complexity annotations found.",
      });
      return;
    }

    // Render constraint table if found
    if (constraintTable.length > 0) {
      const tableSection = container.createDiv({ cls: "complexity-section" });
      tableSection.createEl("h5", { text: "Constraint Table" });
      const tableEl = tableSection.createDiv({ cls: "complexity-constraint-table" });

      for (const row of constraintTable) {
        const rowEl = tableEl.createDiv({ cls: "complexity-constraint-row" });
        rowEl.createSpan({ cls: "complexity-constraint", text: row.constraint });
        rowEl.createSpan({ text: " \u2192 " });
        const color = getComplexityColor(row.inner);
        const badge = rowEl.createSpan({
          cls: `complexity-badge complexity-${color}`,
          text: row.complexity,
        });
      }
    }

    // Render code block cards
    if (blocks.length > 0) {
      const blocksSection = container.createDiv({ cls: "complexity-section" });
      blocksSection.createEl("h5", { text: "Code Blocks" });

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const annotations = findAnnotationsForBlock(content, block);

        const card = blocksSection.createDiv({ cls: "complexity-card" });

        // Card header: language + title
        const cardHeader = card.createDiv({ cls: "complexity-card-header" });
        if (block.lang) {
          cardHeader.createSpan({
            cls: "complexity-lang",
            text: block.lang,
          });
        }
        const titleText = block.title || `Block ${i + 1}`;
        cardHeader.createSpan({
          cls: "complexity-title",
          text: titleText,
        });

        // Line range
        cardHeader.createSpan({
          cls: "complexity-line-range",
          text: `L${block.lineStart + 1}\u2013${block.lineEnd + 1}`,
        });

        // Complexity badges
        const badgeRow = card.createDiv({ cls: "complexity-badges" });

        if (annotations.time) {
          const color = getComplexityColor(annotations.time.inner);
          const timeEl = badgeRow.createDiv({ cls: "complexity-badge-group" });
          timeEl.createSpan({ cls: "complexity-badge-label", text: "Time" });
          timeEl.createSpan({
            cls: `complexity-badge complexity-${color}`,
            text: annotations.time.notation,
          });
        } else {
          const timeEl = badgeRow.createDiv({ cls: "complexity-badge-group" });
          timeEl.createSpan({ cls: "complexity-badge-label", text: "Time" });
          timeEl.createSpan({
            cls: "complexity-badge complexity-unknown",
            text: "unknown",
          });
        }

        if (annotations.space) {
          const color = getComplexityColor(annotations.space.inner);
          const spaceEl = badgeRow.createDiv({ cls: "complexity-badge-group" });
          spaceEl.createSpan({ cls: "complexity-badge-label", text: "Space" });
          spaceEl.createSpan({
            cls: `complexity-badge complexity-${color}`,
            text: annotations.space.notation,
          });
        } else {
          const spaceEl = badgeRow.createDiv({ cls: "complexity-badge-group" });
          spaceEl.createSpan({ cls: "complexity-badge-label", text: "Space" });
          spaceEl.createSpan({
            cls: "complexity-badge complexity-unknown",
            text: "unknown",
          });
        }
      }
    }
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class ComplexitySidebarPlugin extends obsidian.Plugin {
  async onload() {
    // Register the sidebar view
    this.registerView(VIEW_TYPE, (leaf) => new ComplexityPanelView(leaf, this));

    // Ribbon icon to toggle sidebar
    this.addRibbonIcon("gauge", "Toggle Complexity Sidebar", () => {
      this.togglePanel();
    });

    // Command: toggle sidebar
    this.addCommand({
      id: "toggle-complexity-panel",
      name: "Toggle complexity panel",
      callback: () => {
        this.togglePanel();
      },
    });

    // Command: annotate complexity
    this.addCommand({
      id: "annotate-complexity",
      name: "Annotate complexity",
      editorCallback: (editor, view) => {
        const cursor = editor.getCursor();
        const lineCount = editor.lineCount();

        // Walk upward from cursor to find the opening ``` of the enclosing code block
        let codeBlockStart = -1;
        for (let i = cursor.line; i >= 0; i--) {
          const lineText = editor.getLine(i);
          if (/^```/.test(lineText)) {
            // Check if this is an opening fence (not a closing one)
            // Count ``` fences above this line: if odd count, this is a closing fence
            let fenceCount = 0;
            for (let j = 0; j < i; j++) {
              if (/^```/.test(editor.getLine(j))) fenceCount++;
            }
            if (fenceCount % 2 === 0) {
              // This is an opening fence
              codeBlockStart = i;
            }
            break;
          }
        }

        if (codeBlockStart === -1) {
          // Not inside a code block; find the next code block below cursor
          for (let i = cursor.line; i < lineCount; i++) {
            if (/^```\w/.test(editor.getLine(i))) {
              codeBlockStart = i;
              break;
            }
          }
        }

        if (codeBlockStart === -1) {
          new obsidian.Notice("No code block found near cursor.");
          return;
        }

        const annotation = "<!-- O(?) time, O(?) space -->";
        editor.replaceRange(
          annotation + "\n",
          { line: codeBlockStart, ch: 0 },
          { line: codeBlockStart, ch: 0 }
        );

        // Place cursor at the first ? to let user fill in
        editor.setCursor({ line: codeBlockStart, ch: 5 });
      },
    });

    // Update sidebar when active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshPanel();
      })
    );

    // Update sidebar when editor content changes
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        // Debounce slightly so we don't re-parse on every keystroke
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
          this.refreshPanel();
        }, 500);
      })
    );
  }

  onunload() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async togglePanel() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      existing.forEach((leaf) => leaf.detach());
      return;
    }

    const rightLeaf = this.app.workspace.getRightLeaf(false);
    if (rightLeaf) {
      await rightLeaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(rightLeaf);
    }
  }

  refreshPanel() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof ComplexityPanelView) {
        view.renderPanel();
      }
    }
  }
}

module.exports = ComplexitySidebarPlugin;
