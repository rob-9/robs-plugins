const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require("obsidian");

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "claude-sonnet-4-6",
  dailiesFolder: "-1 Dailies",
  interests:
    "agentic AI, multi-agent systems, MCP, RAG, LLMs, cybersecurity, distributed systems",
  storyCount: 40,
  runOnStartup: false,
  lastRunDate: "",
};

const SYSTEM_PROMPT = `You are a research assistant for a UC Irvine Computer Science student \
(specialization: Intelligent Systems) who is deeply interested in agentic AI, \
multi-agent systems, MCP (Model Context Protocol), RAG, LLMs, cybersecurity, \
and distributed systems. They are an incoming AI Engineering intern at \
CrowdStrike and have built projects with LangGraph, vector databases, \
knowledge graphs, and open-source agent frameworks.`;

// ---------------------------------------------------------------------------
// HackerNews helpers
// ---------------------------------------------------------------------------

async function fetchHNStories(limit) {
  const topRes = await requestUrl({
    url: "https://hacker-news.firebaseio.com/v0/topstories.json",
  });
  const ids = topRes.json.slice(0, limit);

  const stories = [];
  // Fetch in parallel batches of 10
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const items = await Promise.all(
      batch.map(async (id) => {
        try {
          const r = await requestUrl({
            url: `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
          });
          return r.json;
        } catch {
          return null;
        }
      })
    );
    for (const item of items) {
      if (item && item.type === "story" && item.url) {
        stories.push({
          title: item.title || "",
          url: item.url || "",
          score: item.score || 0,
          comments: item.descendants || 0,
        });
      }
    }
  }
  return stories;
}

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------

async function generateResearch(apiKey, model, stories, interests) {
  const today = new Date().toISOString().slice(0, 10);

  const storiesText = stories
    .map(
      (s) =>
        `- [${s.title}](${s.url}) — score: ${s.score}, comments: ${s.comments}`
    )
    .join("\n");

  const userPrompt = `Here are today's (${today}) trending tech stories from HackerNews:

${storiesText}

Pick the ONE most impactful story relevant to: ${interests}. Prioritize:
- Breaking news or newly announced developments
- Agentic AI, LLMs, MCP, multi-agent systems, RAG, or cybersecurity topics
- Things likely to shape the field

Write a concise research note in EXACTLY this markdown format:

### Daily Research: [Topic Title]
**Source:** [url]
**Why it matters:** [1-2 sentences]

**Key takeaways:**
- [3-5 bullet points]

**Connections:** [1-2 sentences tying this to agentic RAG, MCP, multi-agent systems, cybersecurity, or the student's projects]

**Further reading:** [1-2 related search terms or topics]

Keep it under 250 words. Be specific and technical.`;

  const res = await requestUrl({
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (res.status !== 200) {
    throw new Error(
      `Claude API error ${res.status}: ${JSON.stringify(res.json)}`
    );
  }
  return res.json.content[0].text;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class DailyResearchPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Ribbon icon
    this.addRibbonIcon("search", "Generate daily research", async () => {
      await this.runResearch();
    });

    // Command palette
    this.addCommand({
      id: "generate-daily-research",
      name: "Generate daily research note",
      callback: async () => {
        await this.runResearch();
      },
    });

    this.addSettingTab(new DailyResearchSettingTab(this.app, this));

    // Optional auto-run on startup (once per day)
    if (this.settings.runOnStartup) {
      const today = new Date().toISOString().slice(0, 10);
      if (this.settings.lastRunDate !== today) {
        // Delay to let vault fully load
        this.registerInterval(
          window.setTimeout(async () => {
            await this.runResearch();
          }, 5000)
        );
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // -----------------------------------------------------------------------
  // Core logic
  // -----------------------------------------------------------------------

  async runResearch() {
    if (!this.settings.apiKey) {
      new Notice("Daily Research: Set your Anthropic API key in settings.");
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    // Check if research already exists
    const dailyPath = `${this.settings.dailiesFolder}/${today}.md`;
    const existing = this.app.vault.getAbstractFileByPath(dailyPath);
    if (existing) {
      const content = await this.app.vault.read(existing);
      if (content.includes("Daily Research:")) {
        new Notice("Daily Research: Already generated for today.");
        return;
      }
    }

    new Notice("Daily Research: Fetching trending stories…");

    try {
      const stories = await fetchHNStories(this.settings.storyCount);
      if (stories.length === 0) {
        new Notice("Daily Research: No stories fetched — check your network.");
        return;
      }

      new Notice(
        `Daily Research: Analyzing ${stories.length} stories with Claude…`
      );

      const research = await generateResearch(
        this.settings.apiKey,
        this.settings.model,
        stories,
        this.settings.interests
      );

      await this.appendToDaily(today, dailyPath, research);

      // Track last run
      this.settings.lastRunDate = today;
      await this.saveSettings();

      new Notice("Daily Research: Done! Check your daily note.");
    } catch (err) {
      console.error("Daily Research error:", err);
      new Notice(`Daily Research: Error — ${err.message}`);
    }
  }

  async appendToDaily(today, dailyPath, research) {
    const existing = this.app.vault.getAbstractFileByPath(dailyPath);

    if (existing) {
      const content = await this.app.vault.read(existing);
      await this.app.vault.modify(existing, content.trimEnd() + "\n\n" + research + "\n");
    } else {
      // Ensure dailies folder exists
      const folder = this.app.vault.getAbstractFileByPath(
        this.settings.dailiesFolder
      );
      if (!folder) {
        await this.app.vault.createFolder(this.settings.dailiesFolder);
      }

      const note =
        `## ${today}\n` +
        `[[Daily]]\n\n` +
        `Ticks\n- [ ] \n\n` +
        `Goals\n- [ ] \n\n` +
        research +
        "\n";

      await this.app.vault.create(dailyPath, note);
    }
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class DailyResearchSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Daily Research" });

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Your Claude API key from console.anthropic.com")
      .addText((text) =>
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Claude model to use for research generation")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("claude-sonnet-4-6", "Claude Sonnet 4.6")
          .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5 (cheaper)")
          .addOption("claude-opus-4-6", "Claude Opus 4.6 (best)")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Dailies folder")
      .setDesc("Path to your daily notes folder in the vault")
      .addText((text) =>
        text
          .setPlaceholder("-1 Dailies")
          .setValue(this.plugin.settings.dailiesFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailiesFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Interests")
      .setDesc(
        "Comma-separated topics to prioritize when picking the daily story"
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("agentic AI, MCP, RAG, cybersecurity…")
          .setValue(this.plugin.settings.interests)
          .onChange(async (value) => {
            this.plugin.settings.interests = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Story count")
      .setDesc("Number of top HackerNews stories to fetch (10–50)")
      .addSlider((slider) =>
        slider
          .setLimits(10, 50, 5)
          .setValue(this.plugin.settings.storyCount)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.storyCount = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Run on startup")
      .setDesc(
        "Automatically generate research when Obsidian opens (once per day)"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.runOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.runOnStartup = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = DailyResearchPlugin;
