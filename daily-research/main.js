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
  topicHistory: [], // last 30 topics for dedup
};

const MAX_HISTORY = 30;

const SYSTEM_PROMPT = `You are a research assistant for a UC Irvine Computer Science student \
(specialization: Intelligent Systems) who is deeply interested in agentic AI, \
multi-agent systems, MCP (Model Context Protocol), RAG, LLMs, cybersecurity, \
and distributed systems. They are an incoming AI Engineering intern at \
CrowdStrike and have built projects with LangGraph, vector databases, \
knowledge graphs, and open-source agent frameworks.`;

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
// Source: arXiv (recent CS.AI / CS.CL / CS.MA papers)
// ---------------------------------------------------------------------------

async function fetchArxivPapers(limit = 10) {
  const query = "cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.MA+OR+cat:cs.CR";
  const url = `https://export.arxiv.org/api/query?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;

  try {
    const res = await requestUrl({ url });
    const parser = new DOMParser();
    const doc = parser.parseFromString(res.text, "text/xml");
    const entries = doc.querySelectorAll("entry");

    return Array.from(entries).map((entry) => {
      const title = entry.querySelector("title")?.textContent?.trim().replace(/\s+/g, " ") || "";
      const link = entry.querySelector("id")?.textContent?.trim() || "";
      const summary = entry.querySelector("summary")?.textContent?.trim().replace(/\s+/g, " ") || "";
      return {
        title,
        url: link,
        source: "arXiv",
        score: 0,
        snippet: summary.slice(0, 200),
      };
    });
  } catch (err) {
    console.error("Daily Research: arXiv fetch failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source: Reddit (r/MachineLearning, r/LocalLLaMA)
// ---------------------------------------------------------------------------

async function fetchRedditPosts(subreddit, limit = 15) {
  try {
    const res = await requestUrl({
      url: `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`,
      headers: { "User-Agent": "ObsidianDailyResearch/1.0" },
    });

    return (res.json.data?.children || [])
      .filter((c) => !c.data.stickied && c.data.url)
      .map((c) => ({
        title: c.data.title || "",
        url: c.data.url.startsWith("/")
          ? `https://reddit.com${c.data.url}`
          : c.data.url,
        source: `Reddit r/${subreddit}`,
        score: c.data.score || 0,
        snippet: (c.data.selftext || "").slice(0, 200),
      }));
  } catch (err) {
    console.error(`Daily Research: Reddit r/${subreddit} fetch failed:`, err);
    return [];
  }
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
  const googleQuery = interests
    .split(",")
    .slice(0, 3)
    .map((s) => s.trim())
    .join(" OR ");

  const [hn, arxiv, redditML, redditLLM, google] = await Promise.all([
    fetchHNStories(storyCount),
    fetchArxivPapers(10),
    fetchRedditPosts("MachineLearning", 15),
    fetchRedditPosts("LocalLLaMA", 10),
    fetchGoogleNews(googleQuery, 10),
  ]);

  return [...hn, ...arxiv, ...redditML, ...redditLLM, ...google];
}

// ---------------------------------------------------------------------------
// Claude API — two-pass: rank candidates, then write full brief
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
      max_tokens: 1024,
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

async function rankAndGenerate(apiKey, model, stories, interests, history) {
  const today = new Date().toISOString().slice(0, 10);

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

  // Pass 1: rank top 5
  const rankPrompt = `Here are today's (${today}) stories from multiple sources (HackerNews, arXiv, Reddit, Google News):

${storiesText}
${historyText}

Your interests filter: ${interests}

From these, pick the TOP 5 most impactful stories for someone deeply into CS, agentic AI, and cybersecurity. Rank them 1-5.

For each, output EXACTLY this format (no extra text):
RANK 1: [story number] | [short reason, 10 words max]
RANK 2: [story number] | [short reason]
RANK 3: [story number] | [short reason]
RANK 4: [story number] | [short reason]
RANK 5: [story number] | [short reason]
PICK: [story number of your #1 choice]`;

  const rankResult = await callClaude(apiKey, model, SYSTEM_PROMPT, rankPrompt);

  // Extract the pick
  const pickMatch = rankResult.match(/PICK:\s*(\d+)/);
  const pickIdx = pickMatch ? parseInt(pickMatch[1], 10) - 1 : 0;
  const picked = stories[Math.min(pickIdx, stories.length - 1)];

  // Pass 2: generate full research brief for the winner
  const briefPrompt = `Write a concise research note about this topic:

Title: ${picked.title}
URL: ${picked.url}
Source: ${picked.source}
Context: ${picked.snippet}

The reader's interests: ${interests}

Use EXACTLY this markdown format:

### Daily Research: [Topic Title]
**Source:** [url]
**Why it matters:** [1-2 sentences]

**Key takeaways:**
- [3-5 bullet points]

**Connections:** [1-2 sentences tying this to agentic RAG, MCP, multi-agent systems, cybersecurity, or the reader's projects]

**Further reading:** [1-2 related search terms or topics]

Keep it under 250 words. Be specific and technical.`;

  const brief = await callClaude(apiKey, model, SYSTEM_PROMPT, briefPrompt);

  return { brief, topicTitle: picked.title };
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
      const today = new Date().toISOString().slice(0, 10);
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

  // -----------------------------------------------------------------------
  // Core logic
  // -----------------------------------------------------------------------

  async runResearch() {
    if (!this.settings.apiKey) {
      new Notice("Daily Research: Set your Anthropic API key in settings.");
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    const dailyPath = `${this.settings.dailiesFolder}/${today}.md`;
    const existingFile = this.app.vault.getAbstractFileByPath(dailyPath);
    if (existingFile) {
      const content = await this.app.vault.read(existingFile);
      if (content.includes("Daily Research:")) {
        new Notice("Daily Research: Already generated for today.");
        return;
      }
    }

    new Notice("Daily Research: Fetching from HackerNews, arXiv, Reddit, Google News…");

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
        `Daily Research: Ranking ${stories.length} stories across all sources…`
      );

      const { brief, topicTitle } = await rankAndGenerate(
        this.settings.apiKey,
        this.settings.model,
        stories,
        this.settings.interests,
        this.settings.topicHistory
      );

      await this.appendToDaily(today, dailyPath, brief);

      // Update history
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

    // Show topic history
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
