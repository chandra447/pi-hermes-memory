# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.5] - 2026-05-03

### Fixed

- **Background review no longer blocks interactive chat** ([#10](https://github.com/chandra447/pi-hermes-memory/issues/10)): The `turn_end` handler now spawns the review subprocess as fire-and-forget instead of `await`-ing it. `reviewInProgress` is reset immediately so the next review cycle can proceed. Notifications are delivered asynchronously via `.then()`.
- **Auto-review errors silenced on Windows** ([#9](https://github.com/chandra447/pi-hermes-memory/issues/9)): The auto-review error notification (`[hermes] auto-review failed (exit=...)`) has been removed. Auto-review is best-effort — subprocess failures (non-zero exits, timeouts, spawn errors) are silently ignored. The next review cycle will retry naturally.

## [0.2.0] - 2026-04-26

### Added

**Procedural Skills (`skill` tool)**
- New `skill` tool with actions: `create`, `view`, `patch`, `edit`, `delete`
- Skills stored as SKILL.md files in `~/.pi/agent/memory/skills/`
- Progressive disclosure — skill index (name + description only) injected into system prompt, full content loaded on demand via `skill view`
- Auto-extraction after complex tasks (8+ tool calls using 2+ distinct tool types in a single turn)
- Rate limited to 1 auto-extraction per session
- All skill writes pass through the same content scanner as memory writes
- New `/memory-skills` command to list all agent-created skills

**Auto-Consolidation**
- When `add()` would exceed the character limit, automatically trigger consolidation instead of returning an error
- Consolidation spawns a one-shot `pi.exec()` process that merges related entries and removes outdated ones
- Parent process reloads from disk after consolidation to stay in sync with changes
- New `/memory-consolidate` command for manual consolidation trigger
- Configurable via `autoConsolidate` setting (default: `true`)

**Correction Detection**
- Detect user corrections in real-time and trigger immediate memory save
- Two-pass pattern filter:
  - **Strong patterns** (always trigger): "don't do that", "I said...", "please don't...", "that's not what I..."
  - **Weak patterns** (need directive clause): "no, use yarn" triggers, "no worries" does not
  - **Negative patterns** (suppress false positives): "no worries", "actually looks great", "no problem", "stop there"
- Rate limited to 1 correction save per 3 turns
- Configurable via `correctionDetection` setting (default: `true`)

**Tool-Call-Aware Nudge**
- Background review now triggers based on tool call count OR turn count, whichever comes first
- Counts `toolCall` blocks from the session branch at `turn_end` time
- Default: triggers at 15 tool calls (configurable via `nudgeToolCalls`)
- Both turn and tool-call counters reset after each review

**Updated Background Review Prompt**
- `COMBINED_REVIEW_PROMPT` now explicitly references the `skill` tool
- Tells the agent to use `create` for new skills and `patch` for updating existing ones
- Single review pass can save both memories and skills

### Changed

- `MemoryStore.add()` is now async (returns `Promise<MemoryResult>`) to support consolidation
- Consolidator injected via `setConsolidator()` to avoid circular imports
- Background review counts tool calls from session branch instead of relying on events

### Configuration

New settings in `~/.pi/agent/hermes-memory-config.json`:

| Setting | Default | Description |
|---|---|---|
| `autoConsolidate` | `true` | Auto-merge when memory hits capacity |
| `correctionDetection` | `true` | Detect user corrections and save immediately |
| `nudgeToolCalls` | `15` | Tool calls before background review triggers |

### Tests

- 218 total tests (up from 119 in v0.1.0)
- 99 new tests covering: auto-consolidation (9), correction detection (35), tool-call nudge (6), skill store (27), skill tool (10), skill auto-trigger (6)

### Files Changed

**New files (7 source + 6 test):**
- `src/store/skill-store.ts` — SkillStore class with CRUD, frontmatter parsing, progressive disclosure
- `src/tools/skill-tool.ts` — `skill` LLM tool registration and execute
- `src/handlers/auto-consolidate.ts` — Consolidation trigger and `/memory-consolidate` command
- `src/handlers/correction-detector.ts` — Two-pass correction detection and immediate save
- `src/handlers/skill-auto-trigger.ts` — Auto-extract skills after complex tasks
- `src/handlers/skills-command.ts` — `/memory-skills` command
- `tests/handlers/auto-consolidate.test.ts`
- `tests/handlers/correction-detector.test.ts`
- `tests/handlers/skill-auto-trigger.test.ts`
- `tests/store/skill-store.test.ts`
- `tests/tools/skill-tool.test.ts`

**Modified files (8):**
- `src/index.ts` — Wire all new handlers, tools, commands, and system prompt injection
- `src/types.ts` — New interfaces (`ConsolidationResult`, `SkillIndex`, `SkillDocument`, `SkillResult`) + config fields
- `src/constants.ts` — New prompts (`CONSOLIDATION_PROMPT`, `CORRECTION_SAVE_PROMPT`, `SKILL_TOOL_DESCRIPTION`), correction patterns, updated `COMBINED_REVIEW_PROMPT`
- `src/config.ts` — Parse new config fields (`autoConsolidate`, `correctionDetection`, `nudgeToolCalls`)
- `src/store/memory-store.ts` — `add()` async, `setConsolidator()` injection, reload-after-consolidation
- `src/tools/memory-tool.ts` — `await store.add()`
- `src/handlers/background-review.ts` — Tool-call counting, OR trigger logic
- `tests/store/memory-store.test.ts` — All `add()` calls migrated to `await`, new config fields in test fixtures

---

## [0.1.0] - 2026-04-20

### Added

- Persistent memory via `MEMORY.md` + `USER.md` with `§` delimiter
- Real-time `memory` tool (add / replace / remove) for the LLM
- Content scanning: prompt injection, role hijacking, secret exfiltration, invisible unicode
- Background learning loop (every N turns via `pi.exec`)
- Session flush before compaction and shutdown
- `/memory-insights` command
- Frozen snapshot injection into system prompt (preserves Pi's prompt cache)
- Atomic writes (temp + rename)
- 119 automated tests, 0 type errors
