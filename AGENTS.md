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
|---|---|
| `src/index.ts` | Extension entry point — wires all components together |
| `src/memory-store.ts` | Core `MemoryStore` class — CRUD, persistence, frozen snapshot |
| `src/memory-tool.ts` | `registerMemoryTool()` — LLM tool definition |
| `src/background-review.ts` | `setupBackgroundReview()` — learning loop via `pi.exec` |
| `src/session-flush.ts` | `setupSessionFlush()` — pre-compaction/shutdown flush |
| `src/content-scanner.ts` | `scanContent()` — injection/exfiltration detection |
| `src/insights.ts` | `registerInsightsCommand()` — `/memory-insights` command |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/constants.ts` | Prompts, defaults, delimiter |
| `PLAN.md` | Full implementation plan with Hermes source file reference map |

## Design Decisions

1. **Frozen snapshot** — Memory is injected into system prompt once at session start, never mutated mid-session (preserves Pi's prompt caching)
2. **Atomic writes** — Temp file + `fs.rename()` for crash safety
3. **`pi.exec()` for background review** — Stays within Pi's intended extension API
4. **`§` delimiter** — Same as Hermes for consistency
5. **No SQLite** — Pi has its own `SessionManager`, we read from it directly

## Hermes Source Reference

The implementation is ported from the Hermes agent harness. See `PLAN.md` → "Hermes Source File Reference Map" for exact files and line ranges to read.

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
