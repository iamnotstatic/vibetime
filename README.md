<h1 align="center">◆ Vibetime</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/vibetime-cli"><img src="https://img.shields.io/npm/v/vibetime-cli" alt="npm version" /></a>
</p>

<p align="center">Track what you actually ship with AI.</p>

<p align="center">Vibetime wraps Claude Code, Codex, Gemini, Aster, and Opencode and prints a session summary every time you're done. Cursor Desktop is tracked through session hooks. No config, no daemon, no account by default.</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/iamnotstatic/vibetime/main/assets/status.png" alt="vibe status" />
</p>

## Install

```
npm install -g vibetime-cli
```

## Setup

```
vibe
source ~/.zshrc   # or ~/.bashrc / ~/.config/fish/config.fish
```

Running `vibe` with nothing after it sets up everything: shell hooks that wrap `claude`, `codex`, `gemini`, `aster`, and `opencode` in the terminal, plus desktop session hooks for the Claude Code, Codex, and Cursor apps (see [Desktop apps](#desktop-apps)). The tools work exactly the same — Vibetime tracks your git state while you code and prints the endcard when you're done.

Fish, Bash, and Zsh are detected automatically, and the matching syntax is written to that shell's rc file. `vibe init` does the same thing explicitly, and re-running it is always safe.

## What you get

Every time you close a Claude Code, Codex, Gemini, Aster, Opencode, or Cursor session:

```
╭─────────────────────────────────────────────╮
│  ◆ vibe  ·  api  ·  2h 14m                  │
├─────────────────────────────────────────────┤
│                                             │
│  3 commits  ·  +847 −231  ·  12 files       │
│                                             │
│  ████████░░  shipped  ✦                     │
│                                             │
╰─────────────────────────────────────────────╯
```

Every `shipped` session counts on the leaderboard.

Sessions are scored by what happened in git:

| tier | bar | meaning |
|---|---|---|
| shipped | `████████░░` | commits + meaningful changes |
| progressed | `██████░░░░` | commits, small changes |
| tinkering | `████░░░░░░` | changes but no commits |
| exploring | `██░░░░░░░░` | a few lines touched |
| idle | `░░░░░░░░░░` | nothing changed |
| interrupted | `░░░░░░░░░░` | session killed or crashed |

**How duration works** — Vibetime polls your git state every 30 seconds. If no file changes, commits, or staging activity are detected for 30 minutes, the idle time is excluded from your session duration. Laptop sleep and background idle are automatically handled. Non-git projects use wall-clock time.

## Desktop apps

The Claude Code, Codex, and Cursor **Desktop** apps never run the wrapped terminal commands, so the shell wrapper can't see them. Vibetime tracks them through session hooks instead — `vibe init` sets these up automatically. If you ran `vibe init` before desktop support existed, either re-run it or use:

```
vibe hooks install
```

Either way it registers session hooks in `~/.claude/settings.json`, `~/.codex/hooks.json`, and `~/.cursor/hooks.json` for all three apps, including one you haven't installed yet: hooks are inert config until the app exists, so if you switch apps months from now you're already tracked without re-running anything. Hooks Vibetime didn't create are never touched. From then on, every Desktop session is recorded and shows up in `vibe status`, `vibe log`, `vibe share`, and the leaderboard, exactly like a terminal session.

- **Claude Code** hot-reloads its settings: just open a new Desktop session.
- **Codex** loads the hooks at your next session. Depending on your Codex version it may first ask you to review and trust them; if codex sessions don't show up in `vibe status`, that's the cause: open Settings → Hooks in the desktop app (or run `/hooks` in the CLI), review the vibe hooks, and trust them. Needs a Codex build from May 2026 or later (when hooks became generally available). Tested on macOS and Linux. Windows is untested: the hooks include a Windows command variant, reports welcome. If Codex imported your Claude Code hooks, `vibe hooks install` replaces those copies with the Codex versions, which tag sessions as Codex and fit its 3-second SessionEnd limit.
- **Cursor** hot-reloads `~/.cursor/hooks.json`: just open a new Agent session. Confirm the vibe hooks in Customize → Hooks if sessions don't show up. Cursor can also import Claude Code hooks when third-party configs are enabled; those copies are tagged as Cursor, not Claude. User-level hooks don't run in cloud agents. Tested on macOS. Windows and Linux reports welcome.

Duration is measured the same way as the terminal: active coding time, with idle gaps over 30 minutes excluded.

**Working across several repos?** Start the session wherever you like. If that directory isn't a repo itself, vibetime picks up the repos sitting directly inside it and measures all of them, so a session that touches `api/` and `web/` is scored on both. A directory with no repos in or under it isn't tracked — there'd be nothing to measure.

If you use **both** the terminal wrapper and Desktop hooks, terminal sessions are counted once, not twice — the hooks stand down when the shell wrapper is already tracking.

> **Why hooks use absolute paths** — the Desktop app, when launched from the Dock, doesn't inherit your shell `PATH`, so a bare `vibe` wouldn't resolve. `vibe hooks install` pins the absolute path to Node and the CLI so tracking works regardless of how Desktop is launched.
>
> If you switch Node versions (e.g. an `nvm` upgrade) and remove the old one, re-run `vibe hooks install` so the pinned path points at your current Node.

Stop tracking Desktop at any time:

```
vibe hooks uninstall
```

## Leaderboard (opt-in)

Live at **[vibetime.club/leaderboard](https://vibetime.club/leaderboard)**. Public web view, no CLI required to browse.

```
vibe login        sign in with github
vibe leaderboard  view the leaderboard from your terminal
vibe logout       sign out and stop submitting
```

The leaderboard ranks by ships: each time a session lands a commit with meaningful changes (more than 50 lines or more than 3 files). The squares show which days you shipped. Tabs on the web view switch between this week (Monday to Sunday, UTC), this month, and all time.

Sign-in uses the GitHub device flow: no browser callback, just a short code you paste on github.com. Until you run `vibe login`, no network requests are made.

Once logged in, the endcard renders as usual and the session submits in the background. If you're offline the submit retries at the end of the next session, so anything you ship will eventually appear.

**When you show up.** Signing in doesn't put you on the leaderboard, your first ship does: a session of at least a minute that lands a commit with meaningful changes. Terminal sessions submit as soon as Vibetime sees that, usually within a minute of the commit, so you appear while you're still working. Desktop sessions submit when the session ends. The page itself caches for a minute on top of that.

Signed in after you'd already been tracking? Nothing is lost. Sessions from the last two weeks submit on the next flush, and `vibe leaderboard` triggers one immediately.

Still not there? Run `vibe status`. A session marked `progressed` or `tinkering` didn't qualify, and that's the point: only shipping scores. If ended sessions are still waiting on the server, `vibe status` says so — run `vibe leaderboard` to retry the upload.

**Submitted fields:** `tool`, `startedAt`, `endedAt`, `durationSeconds`, `commits`, `linesAdded`, `linesRemoved`, `filesTouched`, `momentum`, a SHA-256 hash of the project name, and a salted hash of the branch name. The branch salt is random, generated on your machine, and never sent, so the hash only says whether two of your sessions were on the same branch and cannot be turned back into a name. Branch names, raw repo names, exit codes, and your local handle never leave the machine.

`vibe logout` removes `~/.vibe/auth.json` and submission stops immediately.

## Share your week

Run `vibe share` to print your weekly card. Press `h` to open the HTML version — copy it, screenshot it, post it.

Streaks track consecutive days you shipped. If you shipped yesterday but not yet today, your streak shows ⏳ — you still have time.

<p align="center">
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
vibe login                   sign in to the leaderboard via github
vibe logout                  sign out of the leaderboard
vibe leaderboard             ships, this week
vibe config show             current settings
vibe config set handle <name> set your @handle (shown on share cards)
vibe config add-tool <name>  track a new AI CLI tool
vibe hooks install           track Claude Code, Codex, and Cursor Desktop sessions
vibe hooks uninstall         stop tracking Desktop sessions
vibe uninstall               remove shell hooks and desktop hooks
```

Sessions belong to the day they started — a session that runs past midnight appears under the previous day.

## Uninstall

```
vibe uninstall
npm uninstall -g vibetime-cli
```

`vibe uninstall` removes everything `vibe init` set up: the shell hooks in your rc file and Vibetime's desktop hooks in `~/.claude/settings.json`, `~/.codex/hooks.json`, and `~/.cursor/hooks.json`, preserving hooks it didn't create. To stop desktop tracking alone, run `vibe hooks uninstall`. Your session data in `~/.vibe/` is preserved — delete it manually if you want a clean removal.

## Privacy

Vibetime has no telemetry and no account by default. Everything stays on your machine unless you opt in to the leaderboard with `vibe login`.

It reads **git metadata only** — commit counts, line counts, file counts. It never reads file contents, environment variables, API keys, or anything you type into the wrapped tool. The AI CLI's stdin/stdout are passed straight through via `spawn` with `stdio: 'inherit'`.

The Claude Code, Codex, and Cursor Desktop hooks are held to the same standard: they read only the session id and working directory from the hook payload — never the transcript, your prompts, or the model's output — and derive the same git metadata from there.

All data is stored locally in `~/.vibe/`. If you've signed in to the leaderboard, see the section above for the exact fields submitted.

## License

[MIT](LICENSE)
