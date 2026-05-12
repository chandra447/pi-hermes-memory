# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Configurable correction detection patterns**: Strong, weak, and negative correction patterns plus weak-pattern directive words can now be overridden with optional config fields. Omitted fields preserve the existing defaults.

### Tests

- Config loading tests now use an injected temporary config path instead of writing to `~/.pi/agent/hermes-memory-config.json`.

## [0.7.3] - 2026-05-12

### Added

- **Configurable memory policy prompt** ([#26](https://github.com/chandra447/pi-hermes-memory/pull/26)): `policy-only` mode now supports `memoryPolicyStyle` (`full`, `compact`, `custom`, or `none`) and `memoryPolicyCustomText`. The default `full` style preserves the existing v0.7 policy prompt behavior.

### Fixed

- **Bun runtime SQLite compatibility** ([#27](https://github.com/chandra447/pi-hermes-memory/pull/27), [#25](https://github.com/chandra447/pi-hermes-memory/issues/25), [#24](https://github.com/chandra447/pi-hermes-memory/issues/24)): Added a runtime fallback from `better-sqlite3` to `bun:sqlite` in `src/store/db.ts` so memory and search features do not crash when loaded in Bun contexts.
- **Safer DB initialization across runtimes** ([#27](https://github.com/chandra447/pi-hermes-memory/pull/27)): PRAGMA setup now consistently enables `journal_mode=WAL` and `foreign_keys=ON` for each connection, and legacy target-constraint migration handling is hardened to avoid partial schema updates.

## [0.7.2] - 2026-05-11

### Fixed

- **Searchable project-memory backfill**: Startup now runs the same Markdown-to-SQLite sync used by `/memory-sync-markdown` after migrating legacy project folders. This makes memories in `~/.pi/agent/projects-memory/<project>/MEMORY.md` searchable via `memory_search` automatically, including entries copied forward from the old `~/.pi/agent/<project>/MEMORY.md` layout.
- **Project-scoped correction search**: Correction/failure memories captured while a project is active are now synced into SQLite with that project scope, so `memory_search` can retrieve them using the project filter.
- **Explicit project writes**: `target="project"` now routes to the project `MEMORY.md` target explicitly before mirroring the entry into SQLite.

### Tests

- Added coverage proving new-layout project Markdown is indexed into SQLite and returned by `memory_search`.
- Added coverage for project-scoped correction memory sync and explicit project target routing.

## [0.7.1] - 2026-05-11

### Fixed

- **Legacy project memory migration**: Users upgrading from the old `~/.pi/agent/<project>/MEMORY.md` layout now keep their existing project memories. On startup, legacy project memory files are copied or merged into `~/.pi/agent/projects-memory/<project>/MEMORY.md` without deleting the old folders.
- **Markdown backfill compatibility**: `/memory-sync-markdown` now scans both the new `projects-memory/<project>` layout and legacy `~/.pi/agent/<project>` project folders, so existing project memories can still be imported into SQLite search.

### Tests

- Added migration coverage for copy, merge/dedupe, skip behavior, and legacy project backfill.

## [0.7.0] - 2026-05-11

### Added

- **Policy-only memory prompt by default**: The system prompt now appends a compact `<memory-policy>` instead of dumping full Markdown memory, project memory, recent failures, and the skill index into every new session.
- **Legacy injection escape hatch**: Set `memoryMode: "legacy-inject"` to restore the previous full prompt-injection behavior for users who rely on it.
- **Prompt context builder**: Centralized prompt assembly in `buildPromptContext()` with tests for policy-only and legacy modes.
- **Expanded `/memory-preview-context`**: Shows the active policy-only prompt by default, or the full legacy memory/skill blocks when legacy mode is enabled.
- **v0.7 docs and task plan**: Added the token-aware memory policy plan and future retrieval/router phases.

### Changed

- Memory is described and handled as searchable context, not always-on authority.
- The memory policy now accurately reflects current tool behavior:
  - `memory_search` searches durable user, global, project-scoped, and failure memories.
  - `session_search` searches indexed past conversation messages.
  - `skill` supports `list`, `view`, `create`, `patch`, `edit`, and `delete`.
- Category-filter guidance now avoids missing ordinary user/project/global memories; category filters are reserved for categorized failure/lesson memories.
- README, roadmap, in-app learning guide, Mermaid diagrams, and generated SVGs now describe policy-only as the default and `legacy-inject` as opt-in.
- Content scanner warnings now mention search and legacy prompt injection instead of implying all memory is always injected.

### Preserved From Recent PRs

- Project-scoped memory remains under `~/.pi/agent/projects-memory/<project>/`.
- Windows-safe atomic writes still use temp files next to their target files and `fs.rm()` cleanup.
- `reviewRecentMessages` and `flushRecentMessages` remain configurable and independently applied.

### Tests

- 362 automated tests across 23 test files.
- Added policy prompt tests covering default policy-only behavior, legacy prompt assembly, accurate memory tool guidance, and stale wording regressions.

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
