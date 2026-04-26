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
- [ ] `src/types.ts` — add `autoConsolidate: boolean` to `MemoryConfig`; add `ConsolidationResult` interface
- [ ] `src/config.ts` — add `autoConsolidate: true` default + parsing
- [ ] `src/constants.ts` — add `CONSOLIDATION_PROMPT`

### Implementation
- [ ] `src/store/memory-store.ts` — make `add()` async, add `setConsolidator()` injection method; after consolidation: `await this.loadFromDisk()` before retry (critical — child process modifies disk, parent arrays are stale)
- [ ] `src/tools/memory-tool.ts` — `await store.add(target, content)` (trivial async change)
- [ ] `src/handlers/auto-consolidate.ts` — `triggerConsolidation()` using `pi.exec()` pattern
- [ ] `src/handlers/consolidate-command.ts` — `/memory-consolidate` command via `pi.registerCommand()`
- [ ] `src/index.ts` — wire consolidator via `store.setConsolidator()` + register command

### Tests
- [ ] `tests/handlers/auto-consolidate.test.ts` — consolidation trigger, pi.exec call, success/failure paths, reload-after-consolidation
- [ ] `tests/store/memory-store.test.ts` — migrate all `store.add()` calls to `await store.add()` (async change ripple); add tests for consolidator with/without

---

## Epic 3: Correction Detection + Immediate Save

_Done when: user corrections are detected in real-time and trigger an immediate memory save (not waiting for nudge interval)._

### Config
- [ ] `src/types.ts` — add `correctionDetection: boolean` to `MemoryConfig`
- [ ] `src/config.ts` — add `correctionDetection: true` default + parsing
- [ ] `src/constants.ts` — add `CORRECTION_SAVE_PROMPT`, strong/weak/negative pattern arrays (two-pass filter to reduce false positives like "no worries", "actually looks great")

### Implementation
- [ ] `src/handlers/correction-detector.ts` — two-pass filter: strong patterns trigger directly, weak patterns require directive clause; negative patterns suppress false positives
- [ ] Rate limiting — `turnsSinceLastCorrection >= 3` and `!correctionInProgress` guard
- [ ] `src/index.ts` — wire `setupCorrectionDetector()`

### Tests
- [ ] `tests/handlers/correction-detector.test.ts` — pattern matching (strong, weak, negative), rate limiting, pi.exec trigger, disabled via config, false positive regression tests ("no worries", "actually looks great")

---

## Epic 4: Tool-Call-Aware Nudge

_Done when: background review triggers based on EITHER turn count OR tool call count, whichever comes first._

### Config
- [ ] `src/types.ts` — add `nudgeToolCalls: number` to `MemoryConfig`
- [ ] `src/config.ts` — add `nudgeToolCalls: 15` default + parsing

### Implementation
- [ ] `src/handlers/background-review.ts` — count tool-use entries from `ctx.sessionManager.getBranch()` at `turn_end`; OR trigger logic; reset both counters on review

### Tests
- [ ] `tests/handlers/background-review.test.ts` — tool-call trigger, combined trigger, counter reset

---

## Epic 1: Skill Tool + Procedural Memory

_Done when: the agent can create/update/delete skill documents, skills appear in a progressive index in the system prompt, and skills are auto-created after complex tasks._

### Research & Design
- [ ] Read Pi's skill discovery API — how does `~/.pi/agent/skills/` work? What SKILL.md format does Pi expect?
- [ ] Decide: write to `~/.pi/agent/memory/skills/` (plan default — isolated from user skills)
- [ ] Read Hermes `skill_manage` tool source for reference patterns

### Store
- [ ] `src/store/skill-store.ts` — `SkillStore` class with `loadIndex()`, `loadSkill()`, `create()`, `patch()`, `edit()`, `delete()`, `formatIndexForSystemPrompt()`
- [ ] SKILL.md format — frontmatter (name, description, version, created, updated) + markdown body
- [ ] File naming — `slugify(name) + ".md"` (lowercase, dashes, no special chars)
- [ ] Frontmatter parsing — regex-based (no yaml dependency)
- [ ] Content scanning — all writes go through `scanContent()`
- [ ] Atomic writes — temp+rename pattern (same as MemoryStore)

### Tool
- [ ] `src/tools/skill-tool.ts` — `registerSkillTool()` with actions: `create`, `view`, `patch`, `edit`, `delete`
- [ ] `src/constants.ts` — add `SKILL_TOOL_DESCRIPTION` and `DEFAULT_SKILL_TRIGGER_TOOL_CALLS` (= 8)
- [ ] Rewrite `COMBINED_REVIEW_PROMPT` — explicitly tell the agent to use the `skill` tool with `create` action (see PLAN.md for exact prompt text)

### Progressive Disclosure
- [ ] Skill index (name + description only) injected into system prompt at `before_agent_start`
- [ ] `view` action loads full skill content on demand
- [ ] Frozen snapshot — index captured at `session_start`, consistent throughout session

### Auto-Trigger
- [ ] `src/handlers/skill-auto-trigger.ts` — track tool calls per turn, trigger skill extraction at **8+ tool calls** with **2+ distinct tool types** (5 was too aggressive — read→bash→edit→bash→read is already 5)
- [ ] Rate limit — max 1 auto-trigger per session

### Command
- [ ] `src/handlers/skills-command.ts` — `/memory-skills` command listing all skills

### Wiring
- [ ] `src/index.ts` — wire SkillStore (pass `config.memoryDir + "/skills/"` directly), registerSkillTool, setupSkillAutoTrigger, registerSkillsCommand

### Tests
- [ ] `tests/store/skill-store.test.ts` — CRUD, frontmatter parsing, content scanning, index format, slug generation
- [ ] `tests/tools/skill-tool.test.ts` — tool registration, action dispatch, parameter validation
- [ ] `tests/handlers/skill-auto-trigger.test.ts` — threshold trigger, rate limiting, disabled state

---

## Epic 5: Documentation & Release

_Done when: v0.2.0 is tagged and released with updated docs._

- [ ] Update `README.md` — skill tool, auto-consolidation, correction detection, new config, new commands
- [ ] Update `src/constants.ts` — verify all new prompts are finalized
- [ ] Update `docs/ROADMAP.md` — mark v0.2 as complete
- [ ] Bump `package.json` version to `0.2.0`
- [ ] `npm run check` passes with zero errors
- [ ] `npm test` — all existing + new tests pass
- [ ] Tag v0.2.0 release

---

## Summary

| Epic | Priority | Est. Complexity | New Files | Modified Files |
|---|---|---|---|---|
| 2: Auto-Consolidation | HIGH | Low | 3 (src + test) | 5 (types, config, constants, memory-store, memory-tool, index) |
| 3: Correction Detection | HIGH | Low | 2 (src + test) | 3 (types, config, constants, index) |
| 4: Tool-Call Nudge | MEDIUM | Low | 0 | 3 (types, config, background-review, test) |
| 1: Skill Tool | CRITICAL | High | 8 (4 src + 4 test) | 3 (constants, index, memory-store) |
| 5: Documentation | NORMAL | Low | 0 | 4 (README, constants, ROADMAP, package.json) |
