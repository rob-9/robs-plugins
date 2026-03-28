const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require("obsidian");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "claude-sonnet-4-6",
  dailiesFolder: "-1 Dailies",
  interests:
    "agentic AI, multi-agent systems, MCP, RAG, LLMs, cybersecurity, distributed systems",
  storyCount: 30,
  runOnStartup: false,
  lastRunDate: "",
  topicHistory: [],
};

const MAX_HISTORY = 30;

const SYSTEM_PROMPT = `You are a tech industry analyst who identifies the most \
significant and broadly impactful stories in software engineering, AI, and \
technology each day. You prioritize stories by their real-world importance — \
major product launches, breakthrough research, significant security incidents, \
industry shifts, policy changes, and notable open-source developments. \
You do NOT inflate niche library bugs or minor updates into top stories. \
A story about a small proxy tool having a bug is NOT as important as a major \
model release, a significant acquisition, or a broadly impactful policy change.`;

// ---------------------------------------------------------------------------
// Source: HackerNews
// ---------------------------------------------------------------------------

async function fetchHNStories(limit) {
  const topRes = await requestUrl({
    url: "https://hacker-news.firebaseio.com/v0/topstories.json",
  });
  const ids = topRes.json.slice(0, limit);

  const stories = [];
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
          source: "HackerNews",
          score: item.score || 0,
          snippet: `${item.score} points, ${item.descendants || 0} comments`,
        });
      }
    }
  }
  return stories;
}

// ---------------------------------------------------------------------------
// Source: Google News RSS
// ---------------------------------------------------------------------------

async function fetchGoogleNews(query, limit = 10) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await requestUrl({ url });
    const parser = new DOMParser();
    const doc = parser.parseFromString(res.text, "text/xml");
    const items = doc.querySelectorAll("item");

    return Array.from(items)
      .slice(0, limit)
      .map((item) => ({
        title: item.querySelector("title")?.textContent?.trim() || "",
        url: item.querySelector("link")?.textContent?.trim() || "",
        source: "Google News",
        score: 0,
        snippet:
          item.querySelector("description")?.textContent?.trim().slice(0, 200) || "",
      }));
  } catch (err) {
    console.error("Daily Research: Google News fetch failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetch all sources in parallel
// ---------------------------------------------------------------------------

async function fetchAllSources(storyCount, interests) {
  const interestQuery = interests
    .split(",")
    .slice(0, 3)
    .map((s) => s.trim())
    .join(" OR ");

  const [hn, googleInterests, googleGeneral] = await Promise.all([
    fetchHNStories(storyCount),
    fetchGoogleNews(interestQuery, 5),
    fetchGoogleNews("technology OR artificial intelligence OR software engineering", 5),
  ]);

  return [...hn, ...googleInterests, ...googleGeneral];
}

// ---------------------------------------------------------------------------
// Claude API — single pass: pick #1, write brief, list runners-up
// ---------------------------------------------------------------------------

async function callClaude(apiKey, model, system, userMsg) {
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
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (res.status !== 200) {
    throw new Error(
      `Claude API error ${res.status}: ${JSON.stringify(res.json)}`
    );
  }
  return res.json.content[0].text;
}

async function generateResearch(apiKey, model, stories, interests, history) {
  const today = localToday();

  const storiesText = stories
    .map(
      (s, i) =>
        `${i + 1}. [${s.source}] ${s.title}\n   ${s.url}\n   ${s.snippet}`
    )
    .join("\n");

  const historyText =
    history.length > 0
      ? `\nTopics already covered recently (AVOID these):\n${history.map((h) => `- ${h}`).join("\n")}`
      : "";

  const prompt = `Here are today's (${today}) stories from HackerNews and Google News:

${storiesText}
${historyText}

Topic filter (use to break ties, NOT as primary selection criteria): ${interests}

Pick the ONE story with the biggest real-world impact on the tech industry today. \
Prefer stories that a senior engineer at any company would want to know about. \
HackerNews score/comments can signal importance but don't blindly follow it — \
a 500-point niche library bug is less important than a 200-point major industry shift.

Write a research note in this EXACT format:

### Daily Research: [Topic Title]
**Source:** [url]
**Why it matters:** [1-2 sentences on broad industry impact]

**Key takeaways:**
- [3-5 bullet points]

**What to watch:** [1-2 sentences on implications or what happens next]

**Further reading:** [1-2 related search terms or topics]

Then add a "Also trending" section listing the next 4 best stories as clickable links:

**Also trending:**
- [Title](url)
- [Title](url)
- [Title](url)
- [Title](url)

Keep the research note under 250 words. Be specific and technical.`;

  const result = await callClaude(apiKey, model, SYSTEM_PROMPT, prompt);

  // Extract topic title from the response for history tracking
  const titleMatch = result.match(/### Daily Research:\s*(.+)/);
  const topicTitle = titleMatch ? titleMatch[1].trim() : stories[0]?.title || "Unknown";

  return { brief: result, topicTitle };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class DailyResearchPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("search", "Generate daily research", async () => {
      await this.runResearch();
    });

    this.addCommand({
      id: "generate-daily-research",
      name: "Generate daily research note",
      callback: async () => {
        await this.runResearch();
      },
    });

    this.addSettingTab(new DailyResearchSettingTab(this.app, this));

    if (this.settings.runOnStartup) {
      const today = localToday();
      if (this.settings.lastRunDate !== today) {
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

  async runResearch() {
    if (!this.settings.apiKey) {
      new Notice("Daily Research: Set your Anthropic API key in settings.");
      return;
    }

    const today = localToday();

    const dailyPath = `${this.settings.dailiesFolder}/${today}.md`;
    const existingFile = this.app.vault.getAbstractFileByPath(dailyPath);
    if (existingFile) {
      const content = await this.app.vault.read(existingFile);
      if (content.includes("Daily Research:")) {
        new Notice("Daily Research: Already generated for today.");
        return;
      }
    }

    new Notice("Daily Research: Fetching from HackerNews + Google News…");

    try {
      const stories = await fetchAllSources(
        this.settings.storyCount,
        this.settings.interests
      );

      if (stories.length === 0) {
        new Notice("Daily Research: No stories fetched — check your network.");
        return;
      }

      new Notice(
        `Daily Research: Analyzing ${stories.length} stories with Claude…`
      );

      const { brief, topicTitle } = await generateResearch(
        this.settings.apiKey,
        this.settings.model,
        stories,
        this.settings.interests,
        this.settings.topicHistory
      );

      await this.appendToDaily(today, dailyPath, brief);

      this.settings.topicHistory.push(topicTitle);
      if (this.settings.topicHistory.length > MAX_HISTORY) {
        this.settings.topicHistory = this.settings.topicHistory.slice(-MAX_HISTORY);
      }
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
      await this.app.vault.modify(
        existing,
        content.trimEnd() + "\n\n" + research + "\n"
      );
    } else {
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
        "Comma-separated topics — used to filter stories and as Google News search query"
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
      .setName("HackerNews story count")
      .setDesc("Number of top HN stories to fetch (10–50)")
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

    if (this.plugin.settings.topicHistory.length > 0) {
      containerEl.createEl("h3", { text: "Recent topics" });
      containerEl.createEl("p", {
        text: "Previously covered topics (auto-avoided in future picks):",
        cls: "setting-item-description",
      });
      const list = containerEl.createEl("ul");
      for (const topic of [...this.plugin.settings.topicHistory].reverse()) {
        list.createEl("li", { text: topic });
      }

      new Setting(containerEl)
        .setName("Clear topic history")
        .setDesc("Reset the deduplication list")
        .addButton((btn) =>
          btn.setButtonText("Clear").onClick(async () => {
            this.plugin.settings.topicHistory = [];
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }
  }
}

module.exports = DailyResearchPlugin;
