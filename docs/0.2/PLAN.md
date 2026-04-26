# v0.2.0 Implementation Plan — Skills + Smart Curation

> **Goal**: Close the two biggest Hermes gaps — procedural memory (skills) and intelligent memory management (auto-consolidation, correction detection, tool-call-aware nudges).

## Implementation Order

```
Epic 2 (Auto-Consolidation)  → standalone, modifies MemoryStore.add()
Epic 3 (Correction Detection) → standalone, new handler
Epic 4 (Tool-Call Nudge)      → modifies background-review.ts
Epic 1 (Skill Tool)           → largest: new store + tool + handlers
Epic 5 (Docs + Release)       → depends on all above
```

Epics 2, 3, 4 are independent but done sequentially to avoid merge conflicts in shared files (`types.ts`, `config.ts`, `constants.ts`, `index.ts`).

---

## Epic 2: Auto-Consolidation

**Problem**: When `add()` exceeds char limit, we return an error. Hermes auto-consolidates.

### New Files

**`src/handlers/auto-consolidate.ts`** (~120 lines)
```typescript
export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: "memory" | "user",
  signal?: AbortSignal,
): Promise<ConsolidationResult>
```
- Builds prompt from `CONSOLIDATION_PROMPT` + current entries for the target
- Calls `pi.exec("pi", ["-p", "--no-session", prompt], { signal, timeout: 60000 })`
- Returns `{ consolidated: true }` on success, `{ consolidated: false, error }` on failure

**`src/handlers/consolidate-command.ts`** (~30 lines)
- Registers `/memory-consolidate` via `pi.registerCommand()`
- Runs consolidation for both targets, reports via `ctx.ui.notify()`

**`tests/handlers/auto-consolidate.test.ts`** (~120 lines)

### Modified Files

**`src/constants.ts`** — Add `CONSOLIDATION_PROMPT`

**`src/types.ts`** — Add `autoConsolidate: boolean` to `MemoryConfig`; add `ConsolidationResult` interface

**`src/config.ts`** — Add `autoConsolidate: true` default + parsing

**`src/store/memory-store.ts`** — Key changes:
- `add()` becomes **async** (returns `Promise<MemoryResult>`)
- Add `setConsolidator()` method for dependency injection (avoids circular import)
- When over limit + consolidator set: call consolidator, **reload from disk** (`await this.loadFromDisk()`), then retry once
- **Critical**: The `pi.exec()` child process modifies files on disk. The parent's in-memory arrays become stale after consolidation. We MUST reload before retrying `add()` or the retry will overwrite consolidated entries with stale data.

**`src/tools/memory-tool.ts`** — `await store.add(target, content)` (line ~58)

**`src/index.ts`** — Wire consolidator + register command

**Test migration**: Making `add()` async means all existing tests calling `store.add()` must use `await`. Without `await`, tests get a Promise object instead of `MemoryResult`, causing assertion failures. Update all `store.add()` calls in `tests/store/memory-store.test.ts` to `await store.add()`.

### Key Decision: Consolidator Injection via Setter
MemoryStore cannot import from handlers (circular). Instead, `index.ts` injects a consolidator function via `store.setConsolidator()` after both `store` and `pi` are available.

### Key Decision: No memoryDirPath Getter
SkillStore receives its directory path directly from config (`config.memoryDir + "/skills/"`) in `index.ts`. No need to expose MemoryStore internals.

---

## Epic 3: Correction Detection + Immediate Save

**Problem**: User says "no, don't do that" — we only save it 8 turns later at the next nudge. Hermes detects immediately.

### New Files

**`src/handlers/correction-detector.ts`** (~100 lines)
```typescript
export function setupCorrectionDetector(
  pi: ExtensionAPI,
  store: MemoryStore,
  config: MemoryConfig,
): void
```

**Design**:
1. On `message_end` (role=user): check text against `CORRECTION_PATTERNS`, set `pendingCorrection = true`
2. On `turn_end`: if `pendingCorrection`, trigger `pi.exec()` with `CORRECTION_SAVE_PROMPT` + recent messages + current memory
3. Rate limit: `turnsSinceLastCorrection >= 3` and `!correctionInProgress`

**Why turn_end, not message_end**: We need the full context (user correction + what agent said wrong) for the save prompt.

**`tests/handlers/correction-detector.test.ts`** (~150 lines)

### Modified Files

**`src/constants.ts`** — Add `CORRECTION_SAVE_PROMPT` and `CORRECTION_PATTERNS` (regex array)

**`src/types.ts`** — Add `correctionDetection: boolean` to `MemoryConfig`

**`src/config.ts`** — Add `correctionDetection: true` default + parsing

**`src/index.ts`** — Wire `setupCorrectionDetector()`

### Correction Patterns (Two-Pass Filter)

Patterns are split into **strong** (high confidence, trigger immediately) and **weak** (need a directive clause to confirm).

**Strong patterns** (always trigger):
```typescript
/don'?t do that/i, /not like that/i,
/^I said\b/i, /^I told you\b/i, /we already discussed/i,
/^please don'?t/i, /^that'?s not what I/i
```

**Weak patterns** (only trigger if followed by a directive — verb or "the/that/this"):
```typescript
/^no[,.\s!]/i, /^wrong[,.\s!]/i, /^actually[,.\s]/i, /^stop[,.\s!]/i
```

**Negative patterns** (suppress trigger even if a positive pattern matches):
```typescript
/^no worries/i, /^no problem/i, /^no thanks/i, /^no need/i,
/^actually.{0,10}(looks? great|perfect|good|correct|right)/i,
/^stop.{0,5}(there|here|for now)/i
```

This eliminates false positives like "no worries, I'll handle it" and "actually, that looks great" while still catching "no, don't use npm" and "actually, use yarn instead".

---

## Epic 4: Tool-Call-Aware Nudge

**Problem**: Nudge is purely turn-count based. Complex tasks with many tool calls generate more valuable memories.

### Modified Files

**`src/types.ts`** — Add `nudgeToolCalls: number` to `MemoryConfig`

**`src/config.ts`** — Add `nudgeToolCalls: 15` default + parsing

**`src/handlers/background-review.ts`** — Key changes:
- Count tool-use entries from `ctx.sessionManager.getBranch()` at `turn_end` time (robust — no unknown event names)
- Change trigger to OR logic: `turnsSinceReview >= nudgeInterval || toolCallsSinceReview >= nudgeToolCalls`
- Reset both counters on review

**`tests/handlers/background-review.test.ts`** — Add tool-call trigger tests

### Key Decision: Count from Branch, Not Events
Rather than depending on unknown Pi event names like `tool_end`, count tool-use entries from `ctx.sessionManager.getBranch()` at `turn_end` time. More robust and testable.

---

## Epic 1: Skill Tool + Procedural Memory

**Problem**: `COMBINED_REVIEW_PROMPT` asks about skills but there's no skill tool. This is the single highest-leverage change.

### New Files

**`src/store/skill-store.ts`** (~250 lines)
```typescript
export class SkillStore {
  constructor(private skillsDir: string) {}
  async loadIndex(): Promise<SkillIndex[]>
  async loadSkill(fileName: string): Promise<SkillDocument | null>
  async create(name: string, description: string, body: string): Promise<SkillResult>
  async patch(fileName: string, section: string, newContent: string): Promise<SkillResult>
  async edit(fileName: string, description: string, body: string): Promise<SkillResult>
  async delete(fileName: string): Promise<SkillResult>
  formatIndexForSystemPrompt(): string
}
```

**Storage**: `~/.pi/agent/memory/skills/` (isolated from user skills at `~/.pi/agent/skills/`)

**SKILL.md format**:
```markdown
---
name: debug-typescript-errors
description: Step-by-step approach to debugging TS errors in monorepos
version: 1
created: 2026-04-27
updated: 2026-04-27
---
## When to Use
## Procedure
## Pitfalls
## Verification
```

**Frontmatter parsing**: Simple regex (no yaml dependency). Split on `---`, parse key-value pairs.

**File naming**: `slugify(name) + ".md"` — lowercase, replace non-alphanum with `-`, collapse dashes.

**`src/tools/skill-tool.ts`** (~180 lines)
- Registered via `pi.registerTool()` with actions: `create`, `view`, `patch`, `edit`, `delete`
- Content scanning on all writes via `scanContent()`

**`src/handlers/skill-auto-trigger.ts`** (~80 lines)
- Track tool calls per turn
- When turn completes with **8+ tool calls** (not 5 — a typical read→bash→edit→bash→read is already 5), trigger skill extraction via `pi.exec()`
- Additionally require at least **2 distinct tool types** in the turn (e.g., read + bash, not just 8 reads) to filter trivial multi-call turns
- Rate limit: max 1 auto-trigger per session

**`src/handlers/skills-command.ts`** (~50 lines)
- `/memory-skills` command listing all skills

**Test files**: `tests/store/skill-store.test.ts`, `tests/tools/skill-tool.test.ts`, `tests/handlers/skill-auto-trigger.test.ts`

### Modified Files

**`src/constants.ts`** — Add `SKILL_TOOL_DESCRIPTION`, `DEFAULT_SKILL_TRIGGER_TOOL_CALLS` (= 8); update `COMBINED_REVIEW_PROMPT`:

```typescript
export const COMBINED_REVIEW_PROMPT = `Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — their persona, desires, preferences, or personal details? Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate? If so, save using the memory tool.

**Skills**: Was a complex, non-trivial approach used to complete a task — one that required trial and error, multiple tool calls, or changing course? If so, save a reusable procedure using the skill tool with action 'create'. Include: when to use it, step-by-step procedure, pitfalls to avoid, and how to verify success.

Only act if there's something genuinely worth saving. If nothing stands out, just say 'Nothing to save.' and stop.`;
```

**Note on pi.exec() child tools**: The child `pi` process loads the same installed extension, so it has access to both the `memory` and `skill` tools. This is the same mechanism that makes the existing memory tool work in background review.

**`src/index.ts`** — Wire SkillStore, registerSkillTool, setupSkillAutoTrigger, registerSkillsCommand; inject skill index into system prompt at `before_agent_start`. Pass `config.memoryDir + "/skills/"` directly to SkillStore constructor (no memoryDirPath getter needed).

### Progressive Disclosure
- **System prompt**: Skill index only (name + description per skill, ~3K tokens max)
- **On demand**: Agent calls `skill` tool with action `view` to load full content
- **Frozen snapshot**: Index captured at `session_start`, same as memory snapshot

### Key Decision: Frozen Snapshot for Skills
Skill index is captured at `session_start` and injected at `before_agent_start`. New skills created mid-session appear in the index on next session. This preserves Pi's prompt cache.

---

## Epic 5: Documentation & Release

- Update `README.md` with new features, config options, commands
- Update `docs/ROADMAP.md` — mark v0.2 complete
- Bump `package.json` version to `0.2.0`
- `npm run check` passes, all tests pass
- Tag `v0.2.0`

---

## File Change Summary

### New Files (12)
| File | Lines | Epic |
|---|---|---|
| `src/handlers/auto-consolidate.ts` | ~120 | 2 |
| `src/handlers/consolidate-command.ts` | ~30 | 2 |
| `src/handlers/correction-detector.ts` | ~100 | 3 |
| `src/store/skill-store.ts` | ~250 | 1 |
| `src/tools/skill-tool.ts` | ~180 | 1 |
| `src/handlers/skill-auto-trigger.ts` | ~80 | 1 |
| `src/handlers/skills-command.ts` | ~50 | 1 |
| `tests/handlers/auto-consolidate.test.ts` | ~120 | 2 |
| `tests/handlers/correction-detector.test.ts` | ~150 | 3 |
| `tests/store/skill-store.test.ts` | ~200 | 1 |
| `tests/tools/skill-tool.test.ts` | ~100 | 1 |
| `tests/handlers/skill-auto-trigger.test.ts` | ~80 | 1 |

### Modified Files (8)
| File | Epic(s) |
|---|---|
| `src/types.ts` | 2, 3, 4 |
| `src/constants.ts` | 1, 2, 3, 4 |
| `src/config.ts` | 2, 3, 4 |
| `src/store/memory-store.ts` | 1, 2 |
| `src/tools/memory-tool.ts` | 2 |
| `src/handlers/background-review.ts` | 4 |
| `src/index.ts` | 1, 2, 3, 4 |
| `tests/handlers/background-review.test.ts` | 4 |

---

## Verification

After each epic:
1. `npm run check` — zero type errors
2. `npm test` — all tests pass
3. Manual test: `pi -e ./src/index.ts` — verify the feature works in a live session

Final:
4. Full regression: all 119 existing tests + new tests pass
5. Tag v0.2.0
