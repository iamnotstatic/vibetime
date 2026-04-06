# vibetime

session analytics for the vibe coding era. every time you close a claude code or codex session, vibe prints a summary of what you shipped.

![vibe status](assets/status.png)

## install

```
npm install -g vibetime
```

## setup

```
vibe init
```

this adds shell hooks that wrap `claude` and `codex`. the tools work exactly the same — vibe just snapshots your git state before and after each session, then prints the endcard when you're done.

## how it works

1. you type `claude` like normal
2. vibe records the current git HEAD
3. claude runs with full stdio — nothing changes for you
4. you exit claude
5. vibe diffs the git state, scores the session, prints the card

sessions are scored by what happened in git:

| tier | meaning |
|------|---------|
| **shipped** | commits + meaningful changes |
| **progressed** | commits, small changes |
| **tinkering** | changes but no commits |
| **exploring** | a few lines touched |
| **idle** | nothing changed |

## share your week

run `vibe share` to see your weekly summary in the terminal, or `vibe share --html` to generate a shareable card.

<p>
  <img src="assets/share-terminal.png" width="400" alt="vibe share terminal" />
  <img src="assets/share-card.png" width="400" alt="vibe share html card" />
</p>

## commands

```
vibe status              today's sessions
vibe log                 last 20 sessions
vibe share               weekly summary card
vibe share --html        shareable HTML card
vibe config show         current settings
vibe config set handle   set your @handle
```

## license

MIT
