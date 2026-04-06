# Vibetime

## Project Overview

Session analytics CLI for AI-assisted coding. Wraps tools like claude and codex, tracks sessions, prints endcard summaries. Zero config, zero account, local data in `~/.vibe/`.

## Setup

```
npm install
npm run build
npm link        # for local testing
```

## Development

```
npm run build   # compile ts
npm run dev     # watch mode
vibe status     # test after build
```

## Architecture

- `config.ts` owns `VIBE_DIR`, `ensureVibeDir`, and all config I/O
- `db.ts` imports from config.ts for paths — never redefines them
- `render.ts` owns all display helpers (`formatDuration`, `stripAnsi`, `pad`) — share.ts imports from render.ts
- `git.ts` and `score.ts` are pure — no side effects, no filesystem writes
- `share.ts` handles terminal card + HTML card generation
- `wrap.ts` handles session lifecycle (spawn, track, endcard on exit)
- `init.ts` handles shell hook installation

## Conventions

### TypeScript style

- Explicit return types on all exported functions
- Inferred types on private/local functions
- No `as any` casts — if you need one, the abstraction is wrong
- No unnecessary interfaces — use them for exports and cross-module contracts, not for local variables
- Prefer ternaries over `let x; if/else` when the branches are simple assignments
- Spread over repetition: `{ ...diffStats, exitCode }` not `{ commits: diffStats.commits, ... }`

### Code organization

- One source of truth for shared constants and helpers — never duplicate across files
- `VIBE_DIR` and `ensureVibeDir` live in config.ts
- Display helpers (`formatDuration`, `stripAnsi`, `pad`) live in render.ts
- No `utils.ts` — shared code lives in the module that owns the concept

### What not to do

- Don't strip type annotations to "look human" — explicit types on exports are standard TypeScript
- Don't add `as any` to shorten code — type safety > brevity
- Don't add comments that narrate what the code does — only comment why
- Don't duplicate functions across files — import from the owner
- Don't use em dashes or special Unicode in markdown files
- No AI attribution in commits, PRs, or code comments
