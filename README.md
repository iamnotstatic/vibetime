<h1 align="center">◆ Vibetime</h1>

<p align="center">Track what you actually ship with AI.</p>

<p align="center">Vibetime wraps Claude Code, Codex, and Gemini and prints a session summary every time you're done. No config, no account, no daemon.</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/iamnotstatic/vibetime/main/assets/status.png" alt="vibe status" />
</p>

## Install

```
npm install -g vibetime-cli
```

## Setup

```
vibe init
source ~/.zshrc   # or ~/.bashrc — or restart your terminal
```

Adds shell hooks that wrap `claude`, `codex`, and `gemini`. The tools work exactly the same — Vibetime tracks your git state while you code and prints the endcard when you're done.

## What you get

Every time you close a Claude Code, Codex, or Gemini session:

```
╭─────────────────────────────────────────────╮
│  ◆ vibe  ·  acme/api  ·  2h 14m      │
├─────────────────────────────────────────────┤
│                                             │
│  3 commits  ·  +847 −231  ·  12 files      │
│                                             │
│  ████████░░  shipped  ✦                     │
│                                             │
╰─────────────────────────────────────────────╯
```

Sessions are scored by what happened in git:

| tier | bar | meaning |
|---|---|---|
| shipped | `████████░░` | commits + meaningful changes |
| progressed | `██████░░░░` | commits, small changes |
| tinkering | `████░░░░░░` | changes but no commits |
| exploring | `██░░░░░░░░` | a few lines touched |
| idle | `░░░░░░░░░░` | nothing changed |

## Share your week

Run `vibe share` to print your weekly card. Press `h` to open the HTML version — copy it, screenshot it, post it.

Streaks track consecutive days you shipped. If you shipped yesterday but not yet today, your streak shows ⏳ — you still have time.

<p>
  <img src="https://raw.githubusercontent.com/iamnotstatic/vibetime/main/assets/share-terminal.png" width="400" alt="vibe share terminal" />
  <img src="https://raw.githubusercontent.com/iamnotstatic/vibetime/main/assets/share-card.png" width="400" alt="vibe share html card" />
</p>

## Adding more tools

Vibetime wraps any AI CLI. To track a tool not listed above:

```
vibe config add-tool aider
```

## Commands

```
vibe status                  today's sessions (includes active sessions)
vibe log                     last 20 sessions
vibe share                   weekly summary card
vibe share --html            shareable HTML card
vibe config show             current settings
vibe config set handle       set your @handle
vibe config add-tool <name>  track a new AI CLI tool
vibe uninstall               remove shell hooks
```

Sessions belong to the day they started — a session that runs past midnight appears under the previous day.

## Uninstall

```
vibe uninstall
npm uninstall -g vibetime-cli
```

`vibe uninstall` removes all shell hooks from your rc file. Your session data in `~/.vibe/` is preserved — delete it manually if you want a clean removal.

## Privacy

Vibetime has no telemetry, no network calls, and no account. Everything stays on your machine.

It reads **git metadata only** — commit counts, line counts, file counts. It never reads file contents, environment variables, API keys, or anything you type into the wrapped tool. The AI CLI's stdin/stdout are passed straight through via `spawn` with `stdio: 'inherit'`.

All data is stored locally in `~/.vibe/`. The full source is ~400 lines of TypeScript across 9 files.

## License

[MIT](LICENSE)
