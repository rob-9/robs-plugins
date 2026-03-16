# Spaced Rep Code

Obsidian plugin for code-aware spaced repetition flashcards. Supports code cloze, output prediction, and complexity quiz card types.

## Card Formats

### Code Cloze

Wrap answers in `==` inside fenced code blocks. During review, these become fill-in-the-blank inputs.

````
```python
def fibonacci(n):
    if n <= ==1==:
        return ==n==
    return fibonacci(n - 1) + fibonacci(n - ==2==)
```
````

### Output Prediction

Add `?output` to the language line, then put the expected output in a blockquote below the code block.

````
```python ?output
for i in range(3):
    print(i * 2)
```
> 0
> 2
> 4
````

### Complexity Quiz

Add `?complexity` to the language line, then put the answer in a blockquote below the code block.

````
```python ?complexity
def search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target: return mid
        elif arr[mid] < target: lo = mid + 1
        else: hi = mid - 1
    return -1
```
> O(log n)
````

## Review Workflow

1. Write cards in your notes using the formats above
2. Click the ribbon icon or run **Review due cards** from the command palette
3. For cloze cards: type your answers and click **Check Answers**
4. For output/complexity cards: click **Show Answer** (or press Space)
5. Rate your recall: **Again** (1), **Hard** (2), **Good** (3), **Easy** (4)
6. View your session summary when all cards are reviewed

Use **Review all cards in current file** to practice cards from a specific note regardless of schedule.

## Spaced Repetition (SM-2)

Each card tracks an ease factor and review interval. Ratings adjust the schedule:

| Rating | Effect |
|--------|--------|
| **Again** | Reset to 1 min, ease -0.20 |
| **Hard** | Interval x 1.2, ease -0.15 |
| **Good** | Interval x ease factor |
| **Easy** | Interval x ease x 1.3, ease +0.15 |

New cards start with ease 2.5 and a 1-day interval. The minimum ease is 1.3.

## Status Bar

The status bar shows the count of cards due for review. It updates automatically as you edit files and complete reviews.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/spaced-rep-code/`, then enable in Settings > Community Plugins.
