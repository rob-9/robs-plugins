const obsidian = require("obsidian");

// ─── Constants ────────────────────────────────────────────────────────────────

const CARD_TYPE = {
  CLOZE: "cloze",
  OUTPUT: "output",
  COMPLEXITY: "complexity",
};

const DEFAULT_EASE = 2.5;
const DEFAULT_INTERVAL = 1; // days
const MIN_EASE = 1.3;

const RATING = {
  AGAIN: 1,
  HARD: 2,
  GOOD: 3,
  EASY: 4,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function generateCardId(filePath, codeContent) {
  const key = filePath + "::" + codeContent.slice(0, 100);
  return hashString(key);
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + Math.round(days));
  return d.toISOString().split("T")[0];
}

function formatInterval(days) {
  if (days < 1 / 24) return "<1h";
  if (days < 1) return "<1d";
  if (days === 1) return "1d";
  if (days < 30) return Math.round(days) + "d";
  if (days < 365) return Math.round(days / 30) + "mo";
  return (days / 365).toFixed(1) + "y";
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Card Scanner ─────────────────────────────────────────────────────────────

const CLOZE_REGEX = /==([^=]+)==/g;
const CODE_BLOCK_REGEX = /```(\w+)?([^\n]*)\n([\s\S]*?)```/g;
const BLOCKQUOTE_REGEX = /^>\s*(.+)$/m;

function scanFileForCards(filePath, content) {
  const cards = [];

  CODE_BLOCK_REGEX.lastIndex = 0;
  let match;
  while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {
    const lang = (match[1] || "").trim();
    const flags = (match[2] || "").trim();
    const codeBody = match[3];
    const blockEnd = match.index + match[0].length;

    // Check for blockquote after the code block
    const afterBlock = content.slice(blockEnd).trim();
    let blockquoteContent = null;
    const bqMatch = afterBlock.match(BLOCKQUOTE_REGEX);
    if (bqMatch && afterBlock.indexOf(bqMatch[0]) < 20) {
      blockquoteContent = bqMatch[1].trim();
    }

    if (flags.includes("?output") && blockquoteContent) {
      // Output prediction card
      cards.push({
        id: generateCardId(filePath, codeBody),
        type: CARD_TYPE.OUTPUT,
        filePath: filePath,
        lang: lang,
        code: codeBody.trimEnd(),
        answer: blockquoteContent,
      });
    } else if (flags.includes("?complexity") && blockquoteContent) {
      // Complexity quiz card
      cards.push({
        id: generateCardId(filePath, codeBody),
        type: CARD_TYPE.COMPLEXITY,
        filePath: filePath,
        lang: lang,
        code: codeBody.trimEnd(),
        answer: blockquoteContent,
      });
    } else if (CLOZE_REGEX.test(codeBody)) {
      // Code cloze card
      CLOZE_REGEX.lastIndex = 0;
      cards.push({
        id: generateCardId(filePath, codeBody),
        type: CARD_TYPE.CLOZE,
        filePath: filePath,
        lang: lang,
        code: codeBody.trimEnd(),
        clozes: [],
      });
      // Extract cloze answers
      let clozeMatch;
      CLOZE_REGEX.lastIndex = 0;
      while ((clozeMatch = CLOZE_REGEX.exec(codeBody)) !== null) {
        cards[cards.length - 1].clozes.push(clozeMatch[1]);
      }
    }
  }

  return cards;
}

// ─── SM-2 Algorithm ───────────────────────────────────────────────────────────

function getNextReview(cardData, rating) {
  let ease = cardData.ease || DEFAULT_EASE;
  let interval = cardData.interval || DEFAULT_INTERVAL;

  switch (rating) {
    case RATING.AGAIN:
      interval = 1 / 1440; // ~1 minute in days
      ease = Math.max(MIN_EASE, ease - 0.2);
      break;
    case RATING.HARD:
      interval = Math.max(1, interval * 1.2);
      ease = Math.max(MIN_EASE, ease - 0.15);
      break;
    case RATING.GOOD:
      interval = Math.max(1, interval * ease);
      break;
    case RATING.EASY:
      interval = Math.max(1, interval * ease * 1.3);
      ease = ease + 0.15;
      break;
  }

  const today = todayStr();
  const nextReview = addDays(today, interval);

  return { ease, interval, nextReview };
}

function getIntervalPreview(cardData, rating) {
  const result = getNextReview(cardData, rating);
  return formatInterval(result.interval);
}

// ─── Review Modal ─────────────────────────────────────────────────────────────

class ReviewModal extends obsidian.Modal {
  constructor(app, plugin, cards) {
    super(app);
    this.plugin = plugin;
    this.cards = cards;
    this.currentIndex = 0;
    this.ratings = [];
    this.answered = false;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("sr-code-modal");
    contentEl.empty();
    this.renderCard();
  }

  onClose() {
    this.contentEl.empty();
  }

  renderCard() {
    const { contentEl } = this;
    contentEl.empty();
    this.answered = false;

    if (this.currentIndex >= this.cards.length) {
      this.renderSummary();
      return;
    }

    const card = this.cards[this.currentIndex];
    const cardData = this.plugin.getCardData(card.id);

    // Progress bar
    const progress = contentEl.createDiv({ cls: "sr-code-progress" });
    const progressBar = progress.createDiv({ cls: "sr-code-progress-bar" });
    const fill = progressBar.createDiv({ cls: "sr-code-progress-fill" });
    fill.style.width = ((this.currentIndex / this.cards.length) * 100) + "%";
    progress.createDiv({
      cls: "sr-code-progress-text",
      text: (this.currentIndex + 1) + "/" + this.cards.length,
    });

    // Card body
    const cardEl = contentEl.createDiv({ cls: "sr-code-card" });

    // File info
    cardEl.createDiv({ cls: "sr-code-file-info", text: card.filePath });

    // Question
    if (card.type === CARD_TYPE.CLOZE) {
      cardEl.createDiv({ cls: "sr-code-question", text: "Fill in the blanks:" });
      this.renderClozeCard(cardEl, card, cardData);
    } else if (card.type === CARD_TYPE.OUTPUT) {
      cardEl.createDiv({ cls: "sr-code-question", text: "What does this print?" });
      this.renderQACard(cardEl, card, cardData);
    } else if (card.type === CARD_TYPE.COMPLEXITY) {
      cardEl.createDiv({ cls: "sr-code-question", text: "What's the time complexity?" });
      this.renderQACard(cardEl, card, cardData);
    }
  }

  async renderClozeCard(cardEl, card, cardData) {
    const codeBlockEl = cardEl.createDiv({ cls: "sr-code-block" });

    // Build display code: replace ==answer== with placeholder markers
    let displayCode = card.code;
    const placeholders = [];
    let idx = 0;
    displayCode = displayCode.replace(CLOZE_REGEX, (match, answer) => {
      const placeholder = `\u00AB${idx}\u00BB`;
      placeholders.push({ idx: idx, answer: answer, placeholder: placeholder });
      idx++;
      return placeholder;
    });

    // Render as markdown code block for syntax highlighting
    const lang = card.lang || "";
    const markdown = "```" + lang + "\n" + displayCode + "\n```";
    await obsidian.MarkdownRenderer.render(
      this.app, markdown, codeBlockEl, "", this.plugin
    );

    // Now replace placeholder text nodes with input elements
    const walker = document.createTreeWalker(codeBlockEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    const inputs = [];
    for (const textNode of textNodes) {
      const text = textNode.textContent;
      for (const p of placeholders) {
        const pIdx = text.indexOf(p.placeholder);
        if (pIdx !== -1) {
          const before = document.createTextNode(text.slice(0, pIdx));
          const after = document.createTextNode(text.slice(pIdx + p.placeholder.length));

          const input = document.createElement("input");
          input.type = "text";
          input.className = "sr-code-cloze-input";
          input.style.width = Math.max(40, p.answer.length * 9.5) + "px";
          input.dataset.answer = p.answer;
          input.setAttribute("autocomplete", "off");
          input.setAttribute("autocorrect", "off");
          input.setAttribute("autocapitalize", "off");
          input.setAttribute("spellcheck", "false");
          inputs.push(input);

          const parent = textNode.parentNode;
          parent.insertBefore(before, textNode);
          parent.insertBefore(input, textNode);
          parent.insertBefore(after, textNode);
          parent.removeChild(textNode);
          break;
        }
      }
    }

    // Actions area
    const actions = this.contentEl.createDiv({ cls: "sr-code-actions" });
    const showRow = actions.createDiv({ cls: "sr-code-show-answer-row" });
    const submitBtn = showRow.createEl("button", {
      cls: "sr-code-show-btn",
      text: "Check Answers",
    });

    // Focus first input
    if (inputs.length > 0) {
      setTimeout(() => inputs[0].focus(), 50);
    }

    // Tab between inputs
    inputs.forEach((input, i) => {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (i < inputs.length - 1) {
            inputs[i + 1].focus();
          } else {
            submitBtn.click();
          }
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          if (i < inputs.length - 1) {
            inputs[i + 1].focus();
          }
        }
      });
    });

    submitBtn.addEventListener("click", () => {
      if (this.answered) return;
      this.answered = true;

      let allCorrect = true;
      inputs.forEach((input) => {
        const expected = input.dataset.answer;
        const given = input.value.trim();
        if (given === expected) {
          input.classList.add("sr-correct");
        } else {
          input.classList.add("sr-incorrect");
          allCorrect = false;
          // Show correct answer next to incorrect input
          const correctSpan = document.createElement("span");
          correctSpan.className = "sr-code-cloze-correct-answer";
          correctSpan.textContent = expected;
          input.parentNode.insertBefore(correctSpan, input.nextSibling);
        }
        input.disabled = true;
      });

      // Replace submit button with rating buttons
      actions.empty();
      this.renderRatingButtons(actions, card, cardData);
    });
  }

  async renderQACard(cardEl, card, cardData) {
    const codeBlockEl = cardEl.createDiv({ cls: "sr-code-block" });

    const lang = card.lang || "";
    const markdown = "```" + lang + "\n" + card.code + "\n```";
    await obsidian.MarkdownRenderer.render(
      this.app, markdown, codeBlockEl, "", this.plugin
    );

    // Answer area (hidden initially)
    const answerEl = cardEl.createDiv({ cls: "sr-code-answer" });
    answerEl.createDiv({ cls: "sr-code-answer-label", text: "Answer" });
    answerEl.createDiv({ cls: "sr-code-answer-content", text: card.answer });

    // Actions
    const actions = this.contentEl.createDiv({ cls: "sr-code-actions" });
    const showRow = actions.createDiv({ cls: "sr-code-show-answer-row" });
    const showBtn = showRow.createEl("button", {
      cls: "sr-code-show-btn",
      text: "Show Answer",
    });

    // Keyboard shortcut: Space to reveal
    const keyHandler = (e) => {
      if (e.code === "Space" && !this.answered) {
        e.preventDefault();
        showBtn.click();
      }
    };
    document.addEventListener("keydown", keyHandler);

    // Clean up on next render
    const originalRenderCard = this.renderCard.bind(this);
    this.renderCard = () => {
      document.removeEventListener("keydown", keyHandler);
      this.renderCard = originalRenderCard;
      originalRenderCard();
    };

    showBtn.addEventListener("click", () => {
      if (this.answered) return;
      this.answered = true;

      answerEl.classList.add("sr-revealed");

      // Replace show button with rating buttons
      actions.empty();
      this.renderRatingButtons(actions, card, cardData);
    });
  }

  renderRatingButtons(container, card, cardData) {
    const btnRow = container.createDiv({ cls: "sr-code-buttons" });

    const buttons = [
      { rating: RATING.AGAIN, cls: "sr-code-btn-again", label: "Again" },
      { rating: RATING.HARD, cls: "sr-code-btn-hard", label: "Hard" },
      { rating: RATING.GOOD, cls: "sr-code-btn-good", label: "Good" },
      { rating: RATING.EASY, cls: "sr-code-btn-easy", label: "Easy" },
    ];

    buttons.forEach((b) => {
      const btn = btnRow.createEl("button", { cls: b.cls });
      btn.createSpan({ text: b.label });
      const intervalText = getIntervalPreview(cardData, b.rating);
      btn.createSpan({ cls: "sr-code-btn-interval", text: intervalText });

      btn.addEventListener("click", () => {
        this.rateCard(card, b.rating);
      });
    });

    // Keyboard shortcuts: 1-4
    const keyHandler = (e) => {
      const num = parseInt(e.key);
      if (num >= 1 && num <= 4) {
        e.preventDefault();
        document.removeEventListener("keydown", keyHandler);
        this.rateCard(card, num);
      }
    };
    document.addEventListener("keydown", keyHandler);

    // Clean up on next render
    const originalRenderCard = this.renderCard.bind(this);
    this.renderCard = () => {
      document.removeEventListener("keydown", keyHandler);
      this.renderCard = originalRenderCard;
      originalRenderCard();
    };
  }

  async rateCard(card, rating) {
    const cardData = this.plugin.getCardData(card.id);
    const updated = getNextReview(cardData, rating);
    updated.type = card.type;
    this.plugin.setCardData(card.id, updated);
    await this.plugin.savePluginData();

    this.ratings.push(rating);
    this.currentIndex++;
    this.renderCard();
  }

  renderSummary() {
    const { contentEl } = this;
    contentEl.empty();

    // Progress (full)
    const progress = contentEl.createDiv({ cls: "sr-code-progress" });
    const progressBar = progress.createDiv({ cls: "sr-code-progress-bar" });
    const fill = progressBar.createDiv({ cls: "sr-code-progress-fill" });
    fill.style.width = "100%";
    progress.createDiv({ cls: "sr-code-progress-text", text: "Done" });

    const summary = contentEl.createDiv({ cls: "sr-code-summary" });
    summary.createDiv({ cls: "sr-code-summary-title", text: "Session Complete" });

    const stats = summary.createDiv({ cls: "sr-code-summary-stats" });

    // Cards reviewed
    const reviewedStat = stats.createDiv({ cls: "sr-code-summary-stat" });
    reviewedStat.createDiv({ cls: "sr-code-summary-stat-value", text: String(this.ratings.length) });
    reviewedStat.createDiv({ cls: "sr-code-summary-stat-label", text: "Cards Reviewed" });

    // Average rating
    const avgRating = this.ratings.length > 0
      ? (this.ratings.reduce((a, b) => a + b, 0) / this.ratings.length).toFixed(1)
      : "0";
    const ratingStat = stats.createDiv({ cls: "sr-code-summary-stat" });
    ratingStat.createDiv({ cls: "sr-code-summary-stat-value", text: avgRating });
    ratingStat.createDiv({ cls: "sr-code-summary-stat-label", text: "Avg Rating" });

    // Rating names
    const ratingNames = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
    const distribution = {};
    this.ratings.forEach((r) => {
      const name = ratingNames[r];
      distribution[name] = (distribution[name] || 0) + 1;
    });

    const distStat = stats.createDiv({ cls: "sr-code-summary-stat" });
    const distParts = Object.entries(distribution).map(([k, v]) => k + ": " + v);
    distStat.createDiv({ cls: "sr-code-summary-stat-value", text: distParts.join(" / ") || "-" });
    distStat.createDiv({ cls: "sr-code-summary-stat-label", text: "Breakdown" });

    // Close button
    const closeBtn = summary.createEl("button", {
      cls: "sr-code-summary-btn",
      text: "Close",
    });
    closeBtn.addEventListener("click", () => this.close());

    // Update status bar after review
    this.plugin.updateStatusBar();
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class SpacedRepCodePlugin extends obsidian.Plugin {
  async onload() {
    this.data = { cards: {} };
    await this.loadPluginData();

    this.allCards = [];
    this.statusBarEl = this.addStatusBarItem();

    // Scan vault once layout is ready
    this.app.workspace.onLayoutReady(() => {
      this.scanVault();
      this.updateStatusBar();
    });

    // Re-scan on file changes
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof obsidian.TFile && file.extension === "md") {
          this.scanFile(file);
          this.updateStatusBar();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof obsidian.TFile && file.extension === "md") {
          this.scanFile(file);
          this.updateStatusBar();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof obsidian.TFile && file.extension === "md") {
          // Remove cards from deleted file
          this.allCards = this.allCards.filter((c) => c.filePath !== file.path);
          this.updateStatusBar();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof obsidian.TFile && file.extension === "md") {
          // Update file paths in cards
          this.allCards.forEach((c) => {
            if (c.filePath === oldPath) {
              c.filePath = file.path;
            }
          });
          this.updateStatusBar();
        }
      })
    );

    // Command: Review due cards
    this.addCommand({
      id: "review-due-cards",
      name: "Review due cards",
      callback: () => {
        const dueCards = this.getDueCards();
        if (dueCards.length === 0) {
          new obsidian.Notice("No cards due for review!");
          return;
        }
        new ReviewModal(this.app, this, dueCards).open();
      },
    });

    // Command: Review all cards in current file
    this.addCommand({
      id: "review-current-file",
      name: "Review all cards in current file",
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new obsidian.Notice("No active file");
          return;
        }
        const fileCards = this.allCards.filter(
          (c) => c.filePath === activeFile.path
        );
        if (fileCards.length === 0) {
          new obsidian.Notice("No cards found in this file");
          return;
        }
        new ReviewModal(this.app, this, fileCards).open();
      },
    });

    // Ribbon icon
    this.addRibbonIcon("layers", "Review due cards", () => {
      const dueCards = this.getDueCards();
      if (dueCards.length === 0) {
        new obsidian.Notice("No cards due for review!");
        return;
      }
      new ReviewModal(this.app, this, dueCards).open();
    });
  }

  onunload() {}

  // ─── Data Persistence ─────────────────────────────────────────────────────

  async loadPluginData() {
    const loaded = await this.loadData();
    if (loaded) {
      this.data = Object.assign({ cards: {} }, loaded);
    }
  }

  async savePluginData() {
    await this.saveData(this.data);
  }

  getCardData(cardId) {
    return this.data.cards[cardId] || {
      ease: DEFAULT_EASE,
      interval: DEFAULT_INTERVAL,
      nextReview: todayStr(),
      type: null,
    };
  }

  setCardData(cardId, updates) {
    const existing = this.getCardData(cardId);
    this.data.cards[cardId] = Object.assign(existing, updates);
  }

  // ─── Card Scanning ────────────────────────────────────────────────────────

  async scanVault() {
    const files = this.app.vault.getMarkdownFiles();
    this.allCards = [];
    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const cards = scanFileForCards(file.path, content);
        this.allCards.push(...cards);
      } catch (e) {
        // Skip files that can't be read
      }
    }
  }

  async scanFile(file) {
    // Remove old cards from this file
    this.allCards = this.allCards.filter((c) => c.filePath !== file.path);
    try {
      const content = await this.app.vault.cachedRead(file);
      const cards = scanFileForCards(file.path, content);
      this.allCards.push(...cards);
    } catch (e) {
      // Skip
    }
  }

  // ─── Due Cards ────────────────────────────────────────────────────────────

  getDueCards() {
    const today = todayStr();
    return this.allCards.filter((card) => {
      const cardData = this.getCardData(card.id);
      return !cardData.nextReview || cardData.nextReview <= today;
    });
  }

  // ─── Status Bar ───────────────────────────────────────────────────────────

  updateStatusBar() {
    const dueCount = this.getDueCards().length;
    if (dueCount > 0) {
      this.statusBarEl.setText(dueCount + " card" + (dueCount === 1 ? "" : "s") + " due");
    } else {
      this.statusBarEl.setText("");
    }
  }
}

module.exports = SpacedRepCodePlugin;
