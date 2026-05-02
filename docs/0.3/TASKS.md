# Tasks — v0.3.0: Interview + Hardening

> **Workflow**: When you start a task, change `[ ]` to `[~]`. When done, change to `[x]` and note the commit hash.
>
> **Implementation order**: Epic 1 → Epic 2 → Epic 3 → Epic 4 → Epic 5
>
> **Plan**: See `docs/0.3/PLAN.md` for full implementation details and architectural decisions.

---

## Epic 1: `/memory-interview` Command

_Done when: a new user can type `/memory-interview`, answer 5-7 questions, and have USER.md pre-filled with their preferences._

### Constants
- [ ] `src/constants.ts` — add `INTERVIEW_PROMPT` with structured question flow (one-at-a-time, conversational, aware of existing entries)

### Implementation
- [ ] `src/handlers/interview.ts` — `registerInterviewCommand()` via `pi.registerCommand()`
- [ ] Handler sends interview prompt via `ctx.sendUserMessage()` as a steering message
- [ ] Agent acknowledges existing entries if USER.md is not empty (offers update/skip)
- [ ] Interview uses existing `memory` tool for writes (goes through content scanner)
- [ ] `src/index.ts` — wire `registerInterviewCommand(pi, store)`

### Tests
- [ ] `tests/handlers/interview.test.ts` — command registered, prompt contains key questions, existing entries check, sends user message

---

## Epic 2: Context Fencing

_Done when: all memory blocks in the system prompt are wrapped in `<memory-context>` XML tags with a guard note._

### Implementation
- [ ] `src/store/memory-store.ts` — update `renderBlock()` to wrap output in `<memory-context>` + guard note + closing tag
- [ ] `src/store/memory-store.ts` — update `renderProjectBlock()` same treatment
- [ ] `src/store/memory-store.ts` — update `formatForSystemPrompt()` if needed (the blocks come from `renderBlock`, so this may be automatic)
- [ ] `src/store/skill-store.ts` — update `formatIndexForSystemPrompt()` to use same fencing pattern

### Tests
- [ ] `tests/store/memory-store.test.ts` — update `formatForSystemPrompt()` assertions to check for `<memory-context>` tags and guard note
- [ ] `tests/store/skill-store.test.ts` — update `formatIndexForSystemPrompt()` assertions for fencing
- [ ] `tests/handlers/system-prompt.test.ts` — update system prompt block format assertions

---

## Epic 3: Memory Aging

_Done when: entries carry `created_at` and `last_referenced` timestamps, consolidation prompt uses age to identify stale entries, and old entries without metadata load correctly._

### Metadata Encoding
- [ ] `src/store/memory-store.ts` — add `encodeEntry(text, created, lastReferenced)` helper
- [ ] `src/store/memory-store.ts` — add `decodeEntry(raw)` helper with backward-compatible fallback for legacy entries
- [ ] `src/store/memory-store.ts` — `add()` encodes metadata on new entries (both dates = today)
- [ ] `src/store/memory-store.ts` — `readFile()` decodes entries on load, strips metadata for display
- [ ] `src/store/memory-store.ts` — `formatForSystemPrompt()` strips metadata comments from rendered output (clean display)
- [ ] `src/store/memory-store.ts` — `replace()` preserves original `created` date, updates `last_referenced` to today
- [ ] `src/store/memory-store.ts` — add `touchEntry(target, text)` method that updates `last_referenced` timestamp

### Consolidation Prompt
- [ ] `src/constants.ts` — update `CONSOLIDATION_PROMPT` to mention entry age and staleness heuristics ("entries older than 30 days without recent references are candidates")

### Tests
- [ ] `tests/store/memory-store.test.ts` — metadata encode/decode round-trip
- [ ] `tests/store/memory-store.test.ts` — backward compatibility: legacy entry (no metadata) loads with today's date
- [ ] `tests/store/memory-store.test.ts` — `formatForSystemPrompt()` output does NOT contain metadata comments
- [ ] `tests/store/memory-store.test.ts` — `replace()` preserves `created` date, updates `last_referenced`
- [ ] `tests/store/memory-store.test.ts` — `add()` sets both dates to today

---

## Epic 4: Project Memory Polish

_Done when: project-scoped memory is tested, documented, has a visible `/memory-insights` section, and has a `/memory-switch-project` command._

### Insights Command
- [ ] `src/handlers/insights.ts` — add separator between global and project sections
- [ ] `src/handlers/insights.ts` — show per-section usage stats and file paths
- [ ] `src/handlers/insights.ts` — handle `projectStore === null` gracefully (hide section, don't show "empty")

### Switch Project Command
- [ ] `src/handlers/switch-project.ts` — register `/memory-switch-project` command
- [ ] Handler accepts project name argument, switches active project directory
- [ ] Command shows current project and available projects (list subdirectories of `~/.pi/agent/` that have MEMORY.md)

### Index Cleanup
- [ ] `src/index.ts` — extract project detection into `detectProject(cwd, homeDir)` helper function
- [ ] Handle edge cases: cwd === homeDir, cwd === "/", empty cwd, missing directory

### Tests
- [ ] `tests/handlers/insights.test.ts` — project section shown when projectStore available
- [ ] `tests/handlers/insights.test.ts` — project section hidden when projectStore is null
- [ ] `tests/handlers/insights.test.ts` — usage stats shown in project section
- [ ] `tests/handlers/system-prompt.test.ts` — project block injected when available
- [ ] `tests/handlers/system-prompt.test.ts` — project block NOT injected when projectStore is null

### Docs
- [ ] `README.md` — add "Two-Tier Memory Architecture" section explaining global vs project memory
- [ ] `README.md` — document `/memory-switch-project` command

---

## Epic 5: Documentation & Release

_Done when: v0.3.0 is tagged and released with updated docs._

- [ ] Update `README.md` — interview command usage, context fencing note, two-tier memory diagram
- [ ] Update `docs/ROADMAP.md` — mark v0.3 complete, restructure v0.4 (Session Search + MemoryBackend interface)
- [ ] `npm run check` passes with zero errors
- [ ] `npm test` — all tests pass (per-file runner)
- [ ] Bump `package.json` version to `0.3.0`
- [ ] Tag v0.3.0 release
- [ ] `npm publish`

---

## Summary

| Epic | Priority | Est. Complexity | New Files | Modified Files |
|---|---|---|---|---|
| 1: Interview | 🔴 HIGH | Low | 2 (src + test) | 2 (constants, index) |
| 2: Fencing | 🟡 MEDIUM | Low | 0 | 5 (memory-store, skill-store, 3 test files) |
| 3: Aging | 🟡 MEDIUM | Medium | 0 | 4 (memory-store, constants, memory-tool, test) |
| 4: Project Polish | 🟢 LOW | Low | 2 (src + test) | 4 (insights, index, system-prompt test, README) |
| 5: Docs + Release | 🟢 LOW | Low | 0 | 3 (README, ROADMAP, package.json) |
