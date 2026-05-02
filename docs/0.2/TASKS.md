# Tasks — v0.2.0: Skills + Smart Curation

> **Workflow**: When you start a task, change `[ ]` to `[~]`. When done, change to `[x]` and note the commit hash.
>
> **Implementation order**: Epic 2 → Epic 3 → Epic 4 → Epic 1 → Epic 5 (quick wins first, then the largest piece)
>
> **Plan**: See `docs/0.2/PLAN.md` for full implementation details and architectural decisions.

---

## Epic 2: Auto-Consolidation

_Done when: memory full no longer returns an error — it triggers automatic consolidation and retries the add._

### Shared Config (Epics 2-4 touch these files — do once, extend per epic)
- [x] `src/types.ts` — add `autoConsolidate: boolean` to `MemoryConfig`; add `ConsolidationResult` interface (`c6317dd`)
- [x] `src/config.ts` — add `autoConsolidate: true` default + parsing (`c6317dd`)
- [x] `src/constants.ts` — add `CONSOLIDATION_PROMPT` (`c6317dd`)

### Implementation
- [x] `src/store/memory-store.ts` — make `add()` async, add `setConsolidator()` injection method; after consolidation: `await this.loadFromDisk()` before retry (`c6317dd`)
- [x] `src/tools/memory-tool.ts` — `await store.add(target, content)` (`c6317dd`)
- [x] `src/handlers/auto-consolidate.ts` — `triggerConsolidation()` using `pi.exec()` pattern (`c6317dd`)
- [x] `src/handlers/consolidate-command.ts` — `/memory-consolidate` command (`c6317dd` — combined into `auto-consolidate.ts`)
- [x] `src/index.ts` — wire consolidator via `store.setConsolidator()` + register command (`c6317dd`)

### Tests
- [x] `tests/handlers/auto-consolidate.test.ts` — consolidation trigger, pi.exec call, success/failure paths (`83e7c46`)
- [x] `tests/store/memory-store.test.ts` — migrate all `store.add()` calls to `await store.add()`; consolidator tests (`83e7c46`)

---

## Epic 3: Correction Detection + Immediate Save

_Done when: user corrections are detected in real-time and trigger an immediate memory save._

### Config
- [x] `src/types.ts` — add `correctionDetection: boolean` to `MemoryConfig` (`c6317dd`)
- [x] `src/config.ts` — add `correctionDetection: true` default + parsing (`c6317dd`)
- [x] `src/constants.ts` — add `CORRECTION_SAVE_PROMPT`, strong/weak/negative pattern arrays (`c6317dd`)

### Implementation
- [x] `src/handlers/correction-detector.ts` — two-pass filter: strong/weak/negative patterns (`c6317dd`)
- [x] Rate limiting — `turnsSinceLastCorrection >= 3` and `!correctionInProgress` guard (`c6317dd`)
- [x] `src/index.ts` — wire `setupCorrectionDetector()` (`c6317dd`)

### Tests
- [x] `tests/handlers/correction-detector.test.ts` — 35 tests: strong/weak/negative patterns, rate limiting, false positives (`83e7c46`)

---

## Epic 4: Tool-Call-Aware Nudge

_Done when: background review triggers based on EITHER turn count OR tool call count._

### Config
- [x] `src/types.ts` — add `nudgeToolCalls: number` to `MemoryConfig` (`c6317dd`)
- [x] `src/config.ts` — add `nudgeToolCalls: 15` default + parsing (`c6317dd`)

### Implementation
- [x] `src/handlers/background-review.ts` — count toolCall entries from branch; OR trigger logic; reset both counters (`c6317dd`)

### Tests
- [x] `tests/handlers/background-review.test.ts` — 6 new tests: tool-call trigger, combined trigger, counter reset, text-only, crash recovery (`83e7c46`)

---

## Epic 1: Skill Tool + Procedural Memory

_Done when: the agent can create/update/delete skill documents, skills appear in a progressive index in the system prompt, and skills are auto-created after complex tasks._

### Research & Design
- [x] Read Pi's skill discovery API — Pi uses `~/.pi/agent/skills/` with SKILL.md frontmatter format (`c6317dd`)
- [x] Decide: write to `~/.pi/agent/memory/skills/` — isolated from user skills (`c6317dd`)
- [x] Read Hermes `skill_manage` tool source for reference patterns (`c6317dd`)

### Store
- [x] `src/store/skill-store.ts` — `SkillStore` class with full CRUD + `formatIndexForSystemPrompt()` (`c6317dd`)
- [x] SKILL.md format — frontmatter (name, description, version, created, updated) + markdown body (`c6317dd`)
- [x] File naming — `slugify(name) + ".md"` (`c6317dd`)
- [x] Frontmatter parsing — regex-based, no yaml dependency (`c6317dd`)
- [x] Content scanning — all writes go through `scanContent()` (`c6317dd`)
- [x] Atomic writes — temp+rename pattern (`c6317dd`)

### Tool
- [x] `src/tools/skill-tool.ts` — `registerSkillTool()` with actions: `create`, `view`, `patch`, `edit`, `delete` (`c6317dd`)
- [x] `src/constants.ts` — add `SKILL_TOOL_DESCRIPTION` and `DEFAULT_SKILL_TRIGGER_TOOL_CALLS` (= 8) (`c6317dd`)
- [x] Rewrite `COMBINED_REVIEW_PROMPT` — references skill tool with create/patch actions (`c6317dd`)

### Progressive Disclosure
- [x] Skill index (name + description only) injected into system prompt at `before_agent_start` (`c6317dd`)
- [x] `view` action loads full skill content on demand (`c6317dd`)
- [x] Frozen snapshot — index captured at `session_start`, consistent throughout session (`c6317dd`)

### Auto-Trigger
- [x] `src/handlers/skill-auto-trigger.ts` — 8+ tool calls with 2+ distinct tool types (`c6317dd`)
- [x] Rate limit — max 1 auto-trigger per session (`c6317dd`)

### Command
- [x] `src/handlers/skills-command.ts` — `/memory-skills` command (`c6317dd`)

### Wiring
- [x] `src/index.ts` — wire SkillStore, registerSkillTool, setupSkillAutoTrigger, registerSkillsCommand (`c6317dd`)

### Tests
- [x] `tests/store/skill-store.test.ts` — 27 tests: CRUD, frontmatter, progressive disclosure, atomic writes (`83e7c46`)
- [x] `tests/tools/skill-tool.test.ts` — 10 tests: registration, action dispatch, validation (`83e7c46`)
- [x] `tests/handlers/skill-auto-trigger.test.ts` — 6 tests: threshold, distinct types, session limit (`83e7c46`)

---

## Epic 5: Documentation & Release

_Done when: v0.2.0 is tagged and released with updated docs._

- [x] Update `README.md` — skill tool, auto-consolidation, correction detection, new config, new commands (`4658529`)
- [x] Update `src/constants.ts` — verify all new prompts are finalized (`c6317dd`)
- [x] Update `docs/ROADMAP.md` — v0.2 roadmap documented (`d5b7518`)
- [x] `npm run check` passes with zero errors (`c6317dd`)
- [x] `npm test` — all 218 tests pass (`83e7c46`)
- [x] Bump `package.json` version to `0.2.0`
- [x] Tag v0.2.0 release

---

## Summary

| Epic | Priority | Est. Complexity | New Files | Modified Files |
|---|---|---|---|---|
| 2: Auto-Consolidation | HIGH | Low | 3 (src + test) | 5 (types, config, constants, memory-store, memory-tool, index) |
| 3: Correction Detection | HIGH | Low | 2 (src + test) | 3 (types, config, constants, index) |
| 4: Tool-Call Nudge | MEDIUM | Low | 0 | 3 (types, config, background-review, test) |
| 1: Skill Tool | CRITICAL | High | 8 (4 src + 4 test) | 3 (constants, index, memory-store) |
| 5: Documentation | NORMAL | Low | 0 | 4 (README, constants, ROADMAP, package.json) |
