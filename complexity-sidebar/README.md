# Complexity Sidebar

Obsidian plugin that extracts Big-O complexity annotations from code blocks and surrounding prose and displays them in a sidebar panel.

## Usage

Annotate your code blocks with complexity information anywhere in the surrounding prose, inline comments, or HTML comments:

```
<!-- O(n log n) time, O(n) space -->
```python
def merge_sort(arr):
    ...
```
```

Open the sidebar via the ribbon icon or the command palette to see a summary of all code blocks and their complexities.

### Detected patterns

| Pattern | Example |
|---------|---------|
| Standard Big-O | `O(n)`, `O(n log n)`, `O(n^2)` |
| Theta / Omega | `Θ(n)`, `Ω(log n)` |
| HTML comments | `<!-- O(n) time, O(1) space -->` |
| Inline comments | `// O(n) time` inside code blocks |
| Prose annotations | "runs in O(n^2) time" near a code block |
| Constraint tables | `| n < 3000 | O(n^2) |` |

### Complexity color coding

| Complexity | Color |
|-----------|-------|
| O(1), O(log n) | Green |
| O(n), O(n log n) | Yellow |
| O(n^2), O(n^3) | Orange |
| O(2^n), O(n!) | Red |

## Features

- **Sidebar panel** showing all code blocks with their time and space complexity
- **Auto-detection** of Big-O, Theta, and Omega notation from prose, comments, and tables
- **Time/Space separation** using keyword proximity ("time", "space", "memory")
- **Constraint table detection** for competitive programming input-size-to-complexity mappings
- **Annotate command** inserts a `<!-- O(?) time, O(?) space -->` template above the nearest code block
- **Live updates** when switching files or editing content

## Settings

No settings required. The plugin works out of the box.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/complexity-sidebar/`, then enable in Settings > Community Plugins.
