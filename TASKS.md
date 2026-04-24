# Tasks — Pi Hermes Memory Extension

> **Workflow**: When you start a task, change `[ ]` to `[~]`. When done, change to `[x]` and note the commit hash.
> Progress is tracked per-epic. Each epic has a clear definition of done.

---

## Epic 1: Project Scaffold & Repo Setup

_Done when: repo is on GitHub, TypeScript compiles clean, extension loads in Pi without errors._

- [x] `PLAN.md` — Full implementation plan with Hermes source file reference map — `efddcc4`
- [x] `AGENTS.md` — Project context and architecture docs — `efddcc4`
- [x] `.gitignore` — Exclude node_modules, dist, .codegraph, hermes-agent — `efddcc4`
- [x] `package.json` — Minimal config, no runtime deps — `efddcc4`
- [x] `tsconfig.json` — Strict TypeScript config — `efddcc4`
- [x] `src/types.ts` — Shared interfaces (`MemoryConfig`, `MemoryResult`, `MemorySnapshot`) + `getMessageText()` helper — `efddcc4`
- [x] `src/constants.ts` — Prompts, defaults, delimiter — `efddcc4`
- [x] `src/store/content-scanner.ts` — Injection/exfiltration pattern detection — `efddcc4`
- [x] `src/store/memory-store.ts` — Core `MemoryStore` class with CRUD, atomic writes, frozen snapshot — `efddcc4`
- [x] `src/tools/memory-tool.ts` — `registerMemoryTool()` with Pi tool API — `efddcc4`
- [x] `src/handlers/background-review.ts` — Learning loop via `pi.exec()` — `efddcc4`
- [x] `src/handlers/session-flush.ts` — Pre-compaction/shutdown flush — `efddcc4`
- [x] `src/handlers/insights.ts` — `/memory-insights` command — `efddcc4`
- [x] `src/index.ts` — Extension entry point wiring everything — `efddcc4`
- [x] GitHub repo created and initial commit pushed — `efddcc4`
- [x] `npm install` + `npm run check` passes with zero errors
- [x] Extension loads in Pi via `pi -e ./src/index.ts` without runtime errors — verified

---

## Epic 2: Core Memory — Store & Tool

_Done when: agent can add/replace/remove entries, they persist to disk, and survive a Pi session restart._

- [x] `MemoryStore.loadFromDisk()` correctly reads existing MEMORY.md and USER.md — `24151a0`
- [x] `MemoryStore.add()` validates content, enforces char limit, persists atomically — `24151a0`
- [x] `MemoryStore.replace()` finds entry by substring, replaces, re-checks limit — `24151a0`
- [x] `MemoryStore.remove()` finds entry by substring, removes, persists — `24151a0`
- [x] `MemoryStore.formatForSystemPrompt()` returns frozen snapshot (not live state) — `24151a0`
- [x] Atomic write works: temp file → `fs.rename()` (verify no corruption on crash simulation) — `24151a0`
- [x] Character limits enforced: reject writes that exceed `memoryCharLimit` / `userCharLimit` — `24151a0`
- [x] Deduplication: adding an identical entry is a no-op — `24151a0`
- [x] Multi-match ambiguity: replace/remove error when multiple distinct entries match — `24151a0`
- [x] `memory` tool registered with correct name, parameters, and guidelines — `tests/tools/memory-tool.test.ts`
- [x] Tool execute returns JSON with `usage` field showing char budget — `tests/tools/memory-tool.test.ts`
- [ ] LLM can call `memory` tool with `add` action and entry appears in MEMORY.md — **manual verification required**
- [ ] LLM can call `memory` tool with `target: "user"` and entry appears in USER.md — **manual verification required**

---

## Epic 3: Content Scanning & Security

_Done when: all injection/exfiltration patterns are blocked, invisible unicode is blocked, and safe content passes through._

- [x] `scanContent()` blocks prompt injection patterns (e.g. "ignore previous instructions") — `3f61b61`
- [x] `scanContent()` blocks role hijacking (e.g. "you are now...") — `3f61b61`
- [x] `scanContent()` blocks secret exfiltration (e.g. `curl ${API_KEY...`) — `3f61b61`
- [x] `scanContent()` blocks invisible unicode (U+200B, U+FEFF, U+202A-U+202E) — `3f61b61`
- [x] `scanContent()` returns `null` for safe/normal content — `3f61b61`
- [x] Blocked writes return `{ success: false, error: "Blocked: ..." }` to the LLM — `3f61b61`
- [x] Edge case: empty string passes (handled by empty check before scanner) — `3f61b61`
- [x] Edge case: very long content with pattern at end is still caught — `3f61b61`

---

## Epic 4: System Prompt Injection

_Done when: memory snapshot appears in system prompt at session start and does NOT update mid-session._

- [x] `before_agent_start` handler appends memory block to `event.systemPrompt` — `028c5ad`
- [x] Memory block includes header with usage percentage and char count — `028c5ad`
- [x] Block format matches Hermes: `═` separator, header line, then content — `028c5ad`
- [x] Frozen snapshot: write to memory mid-session → system prompt unchanged — `028c5ad`
- [x] Empty memory files → no block appended (system prompt untouched) — `028c5ad`
- [ ] Second session: memory saved in session 1 appears in session 2's system prompt
---

## Epic 5: Background Learning Loop

_Done when: after N turns, a background pi process reviews the conversation and saves notable facts automatically._

- [x] Turn counter increments on each `turn_end` event — `164eef9`
- [x] User turn counter increments only on user messages (not assistant/tool) — `164eef9`
- [x] Review triggers at `nudgeInterval` (default 10) turns — `164eef9`
- [x] Review does NOT trigger if `reviewEnabled` is false — `164eef9`
- [x] Review does NOT trigger if fewer than 3 user turns — `164eef9`
- [x] Review does NOT trigger if already in progress (`reviewInProgress` guard) — `164eef9`
- [x] `pi.exec("pi", ["-p", "--no-session", ...])` is called with correct review prompt — `164eef9`
- [x] Review prompt includes current memory + user profile + conversation snapshot — `164eef9`
- [x] Successful auto-save shows `💾 Memory auto-reviewed and updated` notification — `164eef9`
- [x] "Nothing to save" response → no notification shown — `164eef9`
- [x] Background review failure does NOT crash or block the main agent — `164eef9`
- [x] Counter resets to 0 after review triggers — `164eef9`
---

## Epic 6: Session Flush

_Done when: before compaction and session shutdown, agent gets one turn to save memories._

- [x] `session_before_compact` event triggers flush when `flushOnCompact` is true — `001a8d4`
- [x] `session_shutdown` event triggers flush when `flushOnShutdown` is true — `001a8d4`
- [x] Flush skips if user turn count < `flushMinTurns` (default 6) — `001a8d4`
- [x] Flush builds conversation snapshot from `ctx.sessionManager.getBranch()` — `001a8d4`
- [x] Flush uses `pi.exec("pi", ["-p", "--no-session", ...])` with flush prompt — `001a8d4`
- [x] Flush failure does NOT prevent compaction or session shutdown — `001a8d4`
- [ ] After flush, any saved memories are available in next session
---

## Epic 7: Insights Command & UX Polish

_Done when: `/memory-insights` shows formatted output and the extension is polished for users._

- [x] `/memory-insights` command registered and appears in Pi command list — `543e262`
- [x] Shows MEMORY section with numbered entries (truncated to 100 chars) — `543e262`
- [x] Shows USER PROFILE section with numbered entries — `543e262`
- [x] Shows "(empty)" when no entries exist — `543e262`
- [x] Formatted with box drawing characters (╔══╗, etc.) — `543e262`
- [ ] Notification displays correctly in Pi's TUI
---

## Epic 8: Configuration & Settings

_Done when: users can customize behavior via `~/.pi/agent/hermes-memory-config.json`._
- [x] Read config from `~/.pi/agent/hermes-memory-config.json` — `src/config.ts`
- [x] All `MemoryConfig` fields are configurable with type validation
- [x] Missing keys fall back to defaults
- [x] Documented in README.md

---

## Epic 9: Testing

_Done when: all core paths have automated tests and the extension passes a manual smoke test._

### Unit Tests
- [x] `content-scanner.ts` — 11 threat patterns + 5 invisible unicode chars tested — `3f61b61`
- [x] `memory-store.ts` — test `add` success, persistence, duplicate → no-op, exceeds limit → error — `24151a0`
- [x] `memory-store.ts` — test `replace` success, no match → error, multi-match → error — `24151a0`
- [x] `memory-store.ts` — test `remove` success, no match → error — `24151a0`
- [x] `memory-store.ts` — test frozen snapshot doesn't update after add — `24151a0`
- [x] `memory-store.ts` — test `loadFromDisk` reads existing files, handles missing files — `24151a0`
- [x] `config.ts` — test defaults, overrides, partial config, invalid values — current
- [x] `handlers/` — test background-review, session-flush, insights, system-prompt — current
- [x] `integration/` — test cross-module contracts (config→store, security pipeline, getMessageText) — current

### Integration Tests
- [x] Extension loads in Pi via `pi -e ./src/index.ts` — no errors — verified
- [ ] `memory` tool callable by LLM — manual verification required
- [ ] System prompt contains memory block after `session_start` — manual verification required
- [ ] `/memory-insights` command runs and shows output — manual verification required
- [ ] Survives Pi session restart — memory persists across `/new` — manual verification required

### Manual Smoke Tests
- [ ] Full E2E: install → use 10+ turns → verify auto-review saves memory
- [ ] Full E2E: long conversation → trigger compaction → verify flush saves memory
- [ ] Full E2E: session 1 saves memory → quit → session 2 recalls it
- [ ] Security: try injecting "ignore previous instructions" → verify blocked
- [ ] Security: try saving `curl ${API_KEY}` → verify blocked

---

## Epic 10: Documentation & Distribution

_Done when: extension is installable via `pi install` and has user-facing docs._

- [x] `README.md` — What it does, installation, usage, configuration — current
- [ ] `README.md` — Example screenshots of `/memory-insights` output — pending
- [ ] Verify `pi install github:chandra447/pi-hermes-memory` works end-to-end — pending
- [ ] Tag v0.1.0 release on GitHub — pending
