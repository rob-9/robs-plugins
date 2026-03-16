# Dataview Lite

A simple, beginner-friendly query language for Obsidian notes. Lightweight alternative to Dataview with a straightforward syntax and zero configuration.

## Query Syntax

Write queries inside fenced code blocks with the `query` language tag:

````
```query
LIST FROM "/" SORT file.mtime DESC LIMIT 10
```
````

### Commands

**LIST** - Bullet list of matching notes

```
LIST FROM "3 UC Irvine" WHERE course = "ICS46" SORT date DESC
LIST file.mtime FROM "/" SORT file.mtime DESC LIMIT 5
```

**TABLE** - Table with columns for each field

```
TABLE date, course FROM "3 UC Irvine" SORT date DESC
TABLE tags, file.size FROM "/" WHERE tags contains "project" LIMIT 20
```

**COUNT** - Single number showing how many notes match

```
COUNT FROM "3 UC Irvine" WHERE course = "ICS46"
COUNT FROM "/" WHERE tasks = incomplete
```

### Clauses

| Clause | Required | Description |
|--------|----------|-------------|
| `FROM "folder"` | No | Restrict to a folder path |
| `WHERE condition` | No | Filter by field conditions |
| `SORT field ASC/DESC` | No | Sort results (default ASC) |
| `LIMIT n` | No | Cap number of results |

### Supported Fields

- `file.name` - Note filename (without extension)
- `file.path` - Full vault path
- `file.ctime` - Creation time
- `file.mtime` - Last modified time
- `file.size` - File size in bytes
- Any frontmatter key (e.g., `date`, `tags`, `course`, `status`)

### WHERE Conditions

| Condition | Example |
|-----------|---------|
| Equals | `course = "ICS46"` |
| Not equals | `status != "done"` |
| Greater/less than | `file.mtime > "2026-01-01"` |
| Contains (substring) | `tags contains "project"` |
| Exists/missing | `course exists` / `author missing` |
| Task state | `tasks = incomplete` / `tasks = complete` |
| Combine with AND/OR | `course = "ICS46" AND date > "2026-01-01"` |

## Pre-built Templates

Use the command palette: **Dataview Lite: Insert query template**

Available templates:
- **Recent notes** - 10 most recently modified notes
- **Notes by tag** - Filter by a specific tag
- **Unchecked tasks** - Notes with incomplete checkboxes
- **Notes this week** - Recently modified notes
- **Course notes** - Table of course notes with date and course fields

## Error Handling

Queries with typos show helpful suggestions:

> Unknown field "statsu". Did you mean "status"?

Empty results display the query for debugging.

## Dataview Lite vs Dataview

| | Dataview Lite | Dataview |
|---|---|---|
| Syntax | Simple, SQL-like | DQL + JS support |
| Learning curve | Minutes | Hours |
| Features | LIST, TABLE, COUNT | Full query engine, inline, JS views |
| Dependencies | None | None |
| Best for | Quick queries, simple lists | Complex data views, dashboards |

## Install

1. Copy the `dataview-lite` folder into your vault's `.obsidian/plugins/` directory
2. Enable the plugin in Settings > Community plugins
3. Start writing `query` code blocks in your notes
