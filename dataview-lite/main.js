const obsidian = require("obsidian");

// ─── Known Fields ─────────────────────────────────────────────────────────────

const KNOWN_FIELDS = [
  "file.name", "file.path", "file.ctime", "file.mtime", "file.size",
  "date", "tags", "course", "title", "status", "type", "author",
  "aliases", "cssclass", "publish"
];

function suggestField(unknown) {
  let best = null;
  let bestDist = Infinity;
  for (const known of KNOWN_FIELDS) {
    const d = levenshtein(unknown.toLowerCase(), known.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  if (bestDist <= 3) {
    return best;
  }
  return null;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ─── Query Parser ─────────────────────────────────────────────────────────────

function tokenize(query) {
  const tokens = [];
  let i = 0;
  const str = query.trim();

  while (i < str.length) {
    // Skip whitespace
    if (/\s/.test(str[i])) {
      i++;
      continue;
    }

    // Quoted string
    if (str[i] === '"') {
      let j = i + 1;
      while (j < str.length && str[j] !== '"') j++;
      tokens.push({ type: "STRING", value: str.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    // Operators: >=, <=, !=, =, >, <
    if (str[i] === '>' && str[i + 1] === '=') {
      tokens.push({ type: "OP", value: ">=" });
      i += 2;
      continue;
    }
    if (str[i] === '<' && str[i + 1] === '=') {
      tokens.push({ type: "OP", value: "<=" });
      i += 2;
      continue;
    }
    if (str[i] === '!' && str[i + 1] === '=') {
      tokens.push({ type: "OP", value: "!=" });
      i += 2;
      continue;
    }
    if (str[i] === '=') {
      tokens.push({ type: "OP", value: "=" });
      i++;
      continue;
    }
    if (str[i] === '>') {
      tokens.push({ type: "OP", value: ">" });
      i++;
      continue;
    }
    if (str[i] === '<') {
      tokens.push({ type: "OP", value: "<" });
      i++;
      continue;
    }

    // Comma
    if (str[i] === ',') {
      tokens.push({ type: "COMMA", value: "," });
      i++;
      continue;
    }

    // Word (keyword or identifier, including dotted like file.name)
    let j = i;
    while (j < str.length && /[^\s,=<>!"]/.test(str[j])) j++;
    const word = str.slice(i, j);
    const upper = word.toUpperCase();

    if (["LIST", "TABLE", "COUNT", "FROM", "WHERE", "SORT", "LIMIT", "AND", "OR", "ASC", "DESC"].includes(upper)) {
      tokens.push({ type: "KEYWORD", value: upper });
    } else if (["contains", "exists", "missing"].includes(word.toLowerCase())) {
      tokens.push({ type: "KEYWORD", value: word.toLowerCase() });
    } else if (word.toLowerCase() === "incomplete" || word.toLowerCase() === "complete") {
      tokens.push({ type: "STRING", value: word.toLowerCase() });
    } else if (/^\d+$/.test(word)) {
      tokens.push({ type: "NUMBER", value: parseInt(word, 10) });
    } else {
      tokens.push({ type: "IDENT", value: word });
    }
    i = j;
  }

  return tokens;
}

function parseQuery(queryStr) {
  const tokens = tokenize(queryStr);
  let pos = 0;

  function peek() { return tokens[pos] || null; }
  function advance() { return tokens[pos++]; }
  function expect(type, value) {
    const t = advance();
    if (!t) throw new Error(`Unexpected end of query, expected ${value || type}`);
    if (t.type !== type || (value && t.value !== value)) {
      throw new Error(`Expected ${value || type} but got "${t.value}"`);
    }
    return t;
  }

  const result = {
    command: null,
    fields: [],
    folder: null,
    conditions: [],
    sort: null,
    limit: null
  };

  // Command
  const cmd = advance();
  if (!cmd || cmd.type !== "KEYWORD" || !["LIST", "TABLE", "COUNT"].includes(cmd.value)) {
    throw new Error('Query must start with LIST, TABLE, or COUNT');
  }
  result.command = cmd.value;

  // Fields (for TABLE, or optional for LIST)
  if (result.command === "TABLE") {
    // Must have at least one field
    const fields = [];
    while (peek() && !(peek().type === "KEYWORD" && peek().value === "FROM")) {
      const t = advance();
      if (t.type === "COMMA") continue;
      if (t.type === "IDENT" || t.type === "KEYWORD") {
        fields.push(t.value);
      } else {
        throw new Error(`Unexpected token "${t.value}" in field list`);
      }
    }
    if (fields.length === 0) throw new Error("TABLE requires at least one field");
    result.fields = fields;
  } else if (result.command === "LIST") {
    // Optional fields before FROM
    const fields = [];
    while (peek() && !(peek().type === "KEYWORD" && peek().value === "FROM")) {
      const t = advance();
      if (t.type === "COMMA") continue;
      if (t.type === "IDENT" || t.type === "KEYWORD") {
        fields.push(t.value);
      } else {
        throw new Error(`Unexpected token "${t.value}" in field list`);
      }
    }
    result.fields = fields;
  }
  // COUNT has no fields

  // FROM (optional)
  if (peek() && peek().type === "KEYWORD" && peek().value === "FROM") {
    advance(); // consume FROM
    const folderToken = advance();
    if (!folderToken) throw new Error('Expected folder path after FROM');
    if (folderToken.type === "STRING") {
      result.folder = folderToken.value;
    } else if (folderToken.type === "IDENT") {
      result.folder = folderToken.value;
    } else {
      throw new Error(`Expected folder path after FROM, got "${folderToken.value}"`);
    }
  }

  // WHERE (optional)
  if (peek() && peek().type === "KEYWORD" && peek().value === "WHERE") {
    advance(); // consume WHERE
    result.conditions = parseConditions();
  }

  // SORT (optional)
  if (peek() && peek().type === "KEYWORD" && peek().value === "SORT") {
    advance(); // consume SORT
    const fieldToken = advance();
    if (!fieldToken) throw new Error("Expected field after SORT");
    let direction = "ASC";
    if (peek() && peek().type === "KEYWORD" && (peek().value === "ASC" || peek().value === "DESC")) {
      direction = advance().value;
    }
    result.sort = { field: fieldToken.value, direction };
  }

  // LIMIT (optional)
  if (peek() && peek().type === "KEYWORD" && peek().value === "LIMIT") {
    advance(); // consume LIMIT
    const numToken = advance();
    if (!numToken || numToken.type !== "NUMBER") {
      throw new Error("Expected number after LIMIT");
    }
    result.limit = numToken.value;
  }

  if (peek()) {
    throw new Error(`Unexpected token "${peek().value}" at end of query`);
  }

  return result;

  function parseConditions() {
    const conds = [];
    conds.push(parseSingleCondition());

    while (peek() && peek().type === "KEYWORD" && (peek().value === "AND" || peek().value === "OR")) {
      const logical = advance().value;
      const nextCond = parseSingleCondition();
      nextCond.logical = logical;
      conds.push(nextCond);
    }

    return conds;
  }

  function parseSingleCondition() {
    const fieldToken = advance();
    if (!fieldToken) throw new Error("Expected field in WHERE condition");
    const field = fieldToken.value;

    // "field exists" or "field missing"
    if (peek() && peek().type === "KEYWORD" && peek().value === "exists") {
      advance();
      return { field, op: "exists", value: null, logical: null };
    }
    if (peek() && peek().type === "KEYWORD" && peek().value === "missing") {
      advance();
      return { field, op: "missing", value: null, logical: null };
    }

    // "field contains value"
    if (peek() && peek().type === "KEYWORD" && peek().value === "contains") {
      advance();
      const valToken = advance();
      if (!valToken) throw new Error(`Expected value after "${field} contains"`);
      return { field, op: "contains", value: valToken.value, logical: null };
    }

    // Comparison operators
    const opToken = advance();
    if (!opToken || opToken.type !== "OP") {
      throw new Error(`Expected operator after "${field}", got "${opToken ? opToken.value : 'end of query'}"`);
    }

    const valToken = advance();
    if (!valToken) throw new Error(`Expected value after "${field} ${opToken.value}"`);

    let value = valToken.value;

    return { field, op: opToken.value, value, logical: null };
  }
}

// ─── Query Executor ───────────────────────────────────────────────────────────

function getFieldValue(file, fileCache, field, fileContent) {
  switch (field) {
    case "file.name":
      return file.basename;
    case "file.path":
      return file.path;
    case "file.ctime":
      return new Date(file.stat.ctime);
    case "file.mtime":
      return new Date(file.stat.mtime);
    case "file.size":
      return file.stat.size;
    case "tasks": {
      if (!fileContent) return null;
      const incomplete = (fileContent.match(/- \[ \]/g) || []).length;
      const complete = (fileContent.match(/- \[x\]/gi) || []).length;
      return { incomplete, complete, total: incomplete + complete };
    }
    default: {
      // Frontmatter field
      const fm = fileCache && fileCache.frontmatter;
      if (!fm) return undefined;
      return fm[field];
    }
  }
}

function evaluateCondition(cond, file, fileCache, fileContent) {
  const field = cond.field;
  const op = cond.op;
  const value = cond.value;

  // Special handling for tasks
  if (field === "tasks") {
    const taskData = getFieldValue(file, fileCache, "tasks", fileContent);
    if (!taskData || taskData.total === 0) return false;
    if (op === "=") {
      if (value === "incomplete") return taskData.incomplete > 0;
      if (value === "complete") return taskData.incomplete === 0 && taskData.complete > 0;
    }
    return false;
  }

  const fieldValue = getFieldValue(file, fileCache, field, fileContent);

  switch (op) {
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;
    case "missing":
      return fieldValue === undefined || fieldValue === null;
    case "contains": {
      if (Array.isArray(fieldValue)) {
        // Tags array - check if any tag matches (handle both with and without #)
        return fieldValue.some(item => {
          const normalized = String(item).replace(/^#/, "");
          const target = String(value).replace(/^#/, "");
          return normalized.toLowerCase().includes(target.toLowerCase());
        });
      }
      if (typeof fieldValue === "string") {
        return fieldValue.toLowerCase().includes(String(value).toLowerCase());
      }
      return false;
    }
    case "=": {
      if (fieldValue instanceof Date) {
        const cmpDate = new Date(value);
        return fieldValue.toDateString() === cmpDate.toDateString();
      }
      return String(fieldValue) === String(value);
    }
    case "!=": {
      if (fieldValue instanceof Date) {
        const cmpDate = new Date(value);
        return fieldValue.toDateString() !== cmpDate.toDateString();
      }
      return String(fieldValue) !== String(value);
    }
    case ">": return compareValues(fieldValue, value) > 0;
    case "<": return compareValues(fieldValue, value) < 0;
    case ">=": return compareValues(fieldValue, value) >= 0;
    case "<=": return compareValues(fieldValue, value) <= 0;
    default:
      return false;
  }
}

function compareValues(a, b) {
  // Date comparison
  if (a instanceof Date) {
    const bDate = new Date(b);
    return a.getTime() - bDate.getTime();
  }
  // Try numeric
  const numA = Number(a);
  const numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB)) {
    return numA - numB;
  }
  // Date strings
  const dateA = new Date(a);
  const dateB = new Date(b);
  if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime())) {
    return dateA.getTime() - dateB.getTime();
  }
  // String comparison
  return String(a).localeCompare(String(b));
}

function evaluateAllConditions(conditions, file, fileCache, fileContent) {
  if (conditions.length === 0) return true;

  let result = evaluateCondition(conditions[0], file, fileCache, fileContent);

  for (let i = 1; i < conditions.length; i++) {
    const cond = conditions[i];
    const condResult = evaluateCondition(cond, file, fileCache, fileContent);
    if (cond.logical === "AND") {
      result = result && condResult;
    } else if (cond.logical === "OR") {
      result = result || condResult;
    }
  }

  return result;
}

async function executeQuery(app, parsed) {
  const allFiles = app.vault.getMarkdownFiles();

  // Filter by folder
  let files = allFiles;
  if (parsed.folder) {
    const folder = parsed.folder.replace(/^\/+|\/+$/g, "");
    files = files.filter(f => {
      if (folder === "/" || folder === "") return true;
      return f.path.startsWith(folder + "/") || f.path === folder;
    });
  }

  // Check if we need file content (for task conditions)
  const needsContent = parsed.conditions.some(c => c.field === "tasks");

  // Evaluate WHERE conditions
  const results = [];
  for (const file of files) {
    const fileCache = app.metadataCache.getFileCache(file);
    let fileContent = null;
    if (needsContent) {
      fileContent = await app.vault.cachedRead(file);
    }
    if (evaluateAllConditions(parsed.conditions, file, fileCache, fileContent)) {
      results.push({ file, fileCache, fileContent });
    }
  }

  // Sort
  if (parsed.sort) {
    const sortField = parsed.sort.field;
    const dir = parsed.sort.direction === "DESC" ? -1 : 1;

    results.sort((a, b) => {
      const aVal = getFieldValue(a.file, a.fileCache, sortField, a.fileContent);
      const bVal = getFieldValue(b.file, b.fileCache, sortField, b.fileContent);

      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      return compareValues(aVal, bVal) * dir;
    });
  }

  // Limit
  if (parsed.limit && parsed.limit > 0) {
    results.splice(parsed.limit);
  }

  return results;
}

// ─── Result Renderer ──────────────────────────────────────────────────────────

function formatFieldValue(value) {
  if (value === undefined || value === null) return "-";
  if (value instanceof Date) {
    return value.toISOString().split("T")[0];
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function renderList(container, results, fields, app) {
  if (results.length === 0) {
    renderEmpty(container);
    return;
  }

  const ul = container.createEl("ul", { cls: "dvl-list" });
  for (const r of results) {
    const li = ul.createEl("li");
    const link = li.createEl("a", {
      cls: "internal-link dvl-file-link",
      text: r.file.basename,
      href: r.file.path
    });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      app.workspace.openLinkText(r.file.path, "", false);
    });

    // Show extra fields if specified
    if (fields.length > 0) {
      const extras = fields
        .filter(f => f !== "file.name")
        .map(f => formatFieldValue(getFieldValue(r.file, r.fileCache, f, r.fileContent)));
      if (extras.length > 0) {
        li.createSpan({ cls: "dvl-field-values", text: " - " + extras.join(", ") });
      }
    }
  }
}

function renderTable(container, results, fields, app) {
  if (results.length === 0) {
    renderEmpty(container);
    return;
  }

  const table = container.createEl("table", { cls: "dvl-table" });

  // Header
  const thead = table.createEl("thead");
  const headerRow = thead.createEl("tr");
  headerRow.createEl("th", { text: "File" });
  for (const field of fields) {
    headerRow.createEl("th", { text: field });
  }

  // Body
  const tbody = table.createEl("tbody");
  for (const r of results) {
    const tr = tbody.createEl("tr");

    // File name cell
    const td = tr.createEl("td");
    const link = td.createEl("a", {
      cls: "internal-link dvl-file-link",
      text: r.file.basename,
      href: r.file.path
    });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      app.workspace.openLinkText(r.file.path, "", false);
    });

    // Field cells
    for (const field of fields) {
      const value = getFieldValue(r.file, r.fileCache, field, r.fileContent);
      tr.createEl("td", { text: formatFieldValue(value) });
    }
  }
}

function renderCount(container, results, parsed) {
  const wrapper = container.createDiv({ cls: "dvl-count" });
  wrapper.createDiv({ cls: "dvl-count-number", text: String(results.length) });

  let label = "notes";
  if (parsed.folder) {
    label += ` in "${parsed.folder}"`;
  }
  if (parsed.conditions.length > 0) {
    label += " matching query";
  }
  wrapper.createDiv({ cls: "dvl-count-label", text: label });
}

function renderEmpty(container) {
  const empty = container.createDiv({ cls: "dvl-empty" });
  empty.createSpan({ text: "No matching notes found." });
}

function renderError(container, message) {
  const errorDiv = container.createDiv({ cls: "dvl-error" });
  errorDiv.createSpan({ cls: "dvl-error-icon", text: "!" });
  errorDiv.createSpan({ cls: "dvl-error-message", text: message });
}

function renderLoading(container) {
  const loading = container.createDiv({ cls: "dvl-loading" });
  loading.createDiv({ cls: "dvl-loading-spinner" });
  loading.createSpan({ text: "Running query..." });
  return loading;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateFields(parsed) {
  const allFields = [...parsed.fields];
  if (parsed.sort) allFields.push(parsed.sort.field);
  for (const cond of parsed.conditions) {
    allFields.push(cond.field);
  }

  const errors = [];
  for (const field of allFields) {
    // Tasks is a special field
    if (field === "tasks") continue;
    // file.* fields and known frontmatter are always ok
    if (field.startsWith("file.") && KNOWN_FIELDS.includes(field)) continue;
    // Any non-file.* field is assumed to be frontmatter (valid)
    if (!field.startsWith("file.")) continue;
    // Unknown file.* field
    const suggestion = suggestField(field);
    if (suggestion) {
      errors.push(`Unknown field "${field}". Did you mean "${suggestion}"?`);
    } else {
      errors.push(`Unknown field "${field}".`);
    }
  }
  return errors;
}

// ─── Template Modal ───────────────────────────────────────────────────────────

const TEMPLATES = [
  {
    name: "Recent notes",
    description: "10 most recently modified notes",
    query: 'LIST FROM "/" SORT file.mtime DESC LIMIT 10'
  },
  {
    name: "Notes by tag",
    description: "All notes with a specific tag",
    query: 'LIST FROM "/" WHERE tags contains "tag"'
  },
  {
    name: "Unchecked tasks",
    description: "Notes with incomplete tasks",
    query: 'LIST FROM "folder" WHERE tasks = incomplete'
  },
  {
    name: "Notes this week",
    description: "Recently modified notes from the past week",
    query: 'LIST FROM "/" WHERE file.mtime > "2026-03-09" SORT file.mtime DESC'
  },
  {
    name: "Course notes",
    description: "Table of UC Irvine course notes",
    query: 'TABLE date, course FROM "3 UC Irvine" SORT date DESC'
  }
];

class TemplateModal extends obsidian.Modal {
  constructor(app, editor) {
    super(app);
    this.editor = editor;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("dvl-template-modal");

    contentEl.createEl("h3", { text: "Insert Query Template" });
    contentEl.createEl("p", {
      cls: "dvl-template-description",
      text: "Choose a template to insert into your note. Edit the placeholders to customize."
    });

    const list = contentEl.createDiv({ cls: "dvl-template-list" });

    for (const template of TEMPLATES) {
      const item = list.createDiv({ cls: "dvl-template-item" });
      item.createDiv({ cls: "dvl-template-name", text: template.name });
      item.createDiv({ cls: "dvl-template-desc", text: template.description });
      item.createEl("code", { cls: "dvl-template-preview", text: template.query });

      item.addEventListener("click", () => {
        const block = "```query\n" + template.query + "\n```";
        this.editor.replaceSelection(block + "\n");
        this.close();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class DataviewLitePlugin extends obsidian.Plugin {
  async onload() {
    // Register the code block processor for ```query blocks
    this.registerMarkdownCodeBlockProcessor("query", async (source, el, ctx) => {
      await this.processQueryBlock(source, el, ctx);
    });

    // Command: Insert query template
    this.addCommand({
      id: "insert-query-template",
      name: "Insert query template",
      editorCallback: (editor) => {
        new TemplateModal(this.app, editor).open();
      }
    });

    // Re-render on metadata cache resolution
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.refreshVisibleQueries();
      })
    );

    // Track active query blocks for refresh
    this._queryBlocks = new Map();
  }

  async processQueryBlock(source, el, ctx) {
    const container = el.createDiv({ cls: "dvl-result" });
    const queryStr = source.trim();

    if (!queryStr) {
      renderError(container, "Empty query. Try: LIST FROM \"/\" SORT file.mtime DESC LIMIT 10");
      return;
    }

    const loading = renderLoading(container);

    try {
      // Parse
      const parsed = parseQuery(queryStr);

      // Validate fields
      const fieldErrors = validateFields(parsed);
      if (fieldErrors.length > 0) {
        loading.remove();
        for (const err of fieldErrors) {
          renderError(container, err);
        }
        return;
      }

      // Execute
      const results = await executeQuery(this.app, parsed);

      loading.remove();

      // Render
      switch (parsed.command) {
        case "LIST":
          renderList(container, results, parsed.fields, this.app);
          break;
        case "TABLE":
          renderTable(container, results, parsed.fields, this.app);
          break;
        case "COUNT":
          renderCount(container, results, parsed);
          break;
      }

      // Store for refresh
      this._queryBlocks.set(el, { source: queryStr, el, ctx });

    } catch (err) {
      loading.remove();
      renderError(container, err.message);
    }
  }

  refreshVisibleQueries() {
    // Debounce refreshes
    if (this._refreshTimeout) clearTimeout(this._refreshTimeout);
    this._refreshTimeout = setTimeout(() => {
      for (const [el, info] of this._queryBlocks) {
        // Check if element is still in the DOM
        if (!el.isConnected) {
          this._queryBlocks.delete(el);
          continue;
        }
        // Re-render
        el.empty();
        this.processQueryBlock(info.source, el, info.ctx);
      }
    }, 500);
  }

  onunload() {
    if (this._refreshTimeout) clearTimeout(this._refreshTimeout);
    this._queryBlocks.clear();
  }
}

module.exports = DataviewLitePlugin;
