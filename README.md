# Vibetime

Session analytics for the vibe coding era. Every time you close a Claude Code or Codex session, Vibe prints a summary of what you shipped.

![vibe status](assets/status.png)

## Install

```
npm install -g vibetime
```

## Setup

```
vibe init
```

This adds shell hooks that wrap `claude` and `codex`. The tools work exactly the same — Vibe just snapshots your git state before and after each session, then prints the endcard when you're done.

## How it works

1. You type `claude` like normal
2. Vibe records the current git HEAD
3. Claude runs with full stdio — nothing changes for you
4. You exit Claude
5. Vibe diffs the git state, scores the session, prints the card

Sessions are scored by what happened in git:

| Tier | Meaning |
|------|---------|
| **Shipped** | Commits + meaningful changes |
| **Progressed** | Commits, small changes |
| **Tinkering** | Changes but no commits |
| **Exploring** | A few lines touched |
| **Idle** | Nothing changed |

## Share your week

Run `vibe share` to see your weekly summary in the terminal, or `vibe share --html` to generate a shareable card.

<p>
  <img src="assets/share-terminal.png" width="400" alt="vibe share terminal" />
  <img src="assets/share-card.png" width="400" alt="vibe share html card" />
</p>

## Commands

```
vibe status              Today's sessions
vibe log                 Last 20 sessions
vibe share               Weekly summary card
vibe share --html        Shareable HTML card
vibe config show         Current settings
vibe config set handle   Set your @handle
```

## License

MIT
