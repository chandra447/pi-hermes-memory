# Pi Hermes Memory Extension

## Project Overview

This is a Pi coding agent extension that brings Hermes-style persistent memory and a learning loop to any Pi user. After `pi install`, users get persistent memory across sessions, a background learning loop, and session-end flush.

## Architecture

- **Language**: TypeScript (loaded via jiti, no compilation needed at runtime)
- **Runtime**: Pi extension API (`@mariozechner/pi-coding-agent`)
- **Storage**: Two markdown files (`MEMORY.md`, `USER.md`) in `~/.pi/agent/memory/`
- **Entry point**: `src/index.ts` — registers tools, event handlers, and commands

## Key Files

| File | Purpose |
|---|---
| `src/index.ts` | Extension entry point — wires all components together |
| `src/types.ts` | Shared TypeScript interfaces + `getMessageText()` helper |
| `src/constants.ts` | Prompts, defaults, delimiter |
| `src/store/memory-store.ts` | Core `MemoryStore` class — CRUD, persistence, frozen snapshot |
| `src/store/content-scanner.ts` | `scanContent()` — injection/exfiltration detection |
| `src/tools/memory-tool.ts` | `registerMemoryTool()` — LLM tool definition |
| `src/handlers/background-review.ts` | `setupBackgroundReview()` — learning loop via `pi.exec` |
| `src/handlers/session-flush.ts` | `setupSessionFlush()` — pre-compaction/shutdown flush |
| `src/handlers/insights.ts` | `registerInsightsCommand()` — `/memory-insights` command |
| `PLAN.md` | Full implementation plan with Hermes source file reference map |

## Design Decisions

1. **Frozen snapshot** — Memory is injected into system prompt once at session start, never mutated mid-session (preserves Pi's prompt caching)
2. **Atomic writes** — Temp file + `fs.rename()` for crash safety
3. **`pi.exec()` for background review** — Stays within Pi's intended extension API
4. **`§` delimiter** — Same as Hermes for consistency
5. **No SQLite** — Pi has its own `SessionManager`, we read from it directly

## Hermes Source Reference

The implementation is ported from the Hermes agent harness. See `PLAN.md` → "Hermes Source File Reference Map" for exact files and line ranges to read.

## Task Tracking

All implementation work is tracked in **`docs/0.1/TASKS.md`** with checkboxes organized by epic.

**Workflow:**
1. Pick a task from the current epic in `docs/0.1/TASKS.md`
2. Mark it `[~]` (in progress)
3. Implement it
4. Mark it `[x]` (done) with the commit hash
5. Move to the next task

**Before starting any work, read `docs/0.1/TASKS.md` to see what's done and what's next.**

## Development

```bash
# Type check
npm run check

# Test locally
pi -e ./src/index.ts
```

## Installation (for users)

```bash
pi install github:chandra447/pi-hermes-memory
```
