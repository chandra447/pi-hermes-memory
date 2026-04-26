# Test Plan — v0.2.0: Skills + Smart Curation

> This document defines the test strategy for v0.2.0. Each section maps to an epic in the implementation plan.

## Current State

- **119 existing tests** — all passing after `add()` async migration
- **Zero new tests** yet for v0.2 features
- **Type check**: `npm run check` passes with zero errors

---

## Epic 2: Auto-Consolidation

### Unit Tests: `tests/handlers/auto-consolidate.test.ts`

| Test | What | Expected |
|---|---|---|
| `triggerConsolidation builds correct prompt` | Verify prompt includes current entries + CONSOLIDATION_PROMPT | Prompt contains entry text and consolidation instructions |
| `triggerConsolidation returns consolidated on success` | Mock `pi.exec()` to return code 0 | `{ consolidated: true }` |
| `triggerConsolidation returns error on failure` | Mock `pi.exec()` to return code 1 | `{ consolidated: false, error: "..." }` |
| `triggerConsolidation returns error on exception` | Mock `pi.exec()` to throw | `{ consolidated: false, error: "Consolidation failed..." }` |
| `/memory-consolidate consolidates both targets` | Mock handler, verify both "memory" and "user" get consolidated | UI notification contains both results |
| `/memory-consolidate skips empty targets` | Store has empty user entries | Report shows "(empty, nothing to consolidate)" for that target |

### Integration Tests: `tests/store/memory-store.test.ts` (extend existing)

| Test | What | Expected |
|---|---|---|
| `add() triggers consolidation when over limit` | Config `autoConsolidate: true`, mock consolidator returns success, entry exceeds limit | `add()` succeeds after consolidation + reload |
| `add() retries once after consolidation` | Verify consolidator called once, then `loadFromDisk()` called, then add succeeds | Entry appears in entries |
| `add() falls through to error if consolidation fails` | Mock consolidator returns `{ consolidated: false }` | Error about exceeding limit |
| `add() skips consolidation when disabled` | Config `autoConsolidate: false` | Error about exceeding limit (no consolidator call) |
| `add() skips consolidation when no consolidator set` | `setConsolidator()` not called | Error about exceeding limit |
| `add() consolidates for user target too` | Same test but target is "user" | Works identically |

---

## Epic 3: Correction Detection

### Unit Tests: `tests/handlers/correction-detector.test.ts`

#### Pattern Matching: `isCorrection()`

**Strong patterns (always trigger):**
| Input | Expected |
|---|---|
| `"don't do that"` | `true` |
| `"not like that"` | `true` |
| `"I said use yarn"` | `true` |
| `"I told you already"` | `true` |
| `"we already discussed this"` | `true` |
| `"please don't commit yet"` | `true` |
| `"that's not what I asked for"` | `true` |

**Weak patterns (need directive clause):**
| Input | Expected | Why |
|---|---|---|
| `"no, use yarn instead"` | `true` | "use" is directive |
| `"wrong, the file is in src/"` | `true` | "the" is directive |
| `"actually, don't use that"` | `true` | "don't" is directive |
| `"stop, fix the test first"` | `true` | "fix" is directive |
| `"no worries, I'll handle it"` | `false` | Negative pattern suppresses |
| `"no problem"` | `false` | Negative pattern suppresses |
| `"no thanks"` | `false` | Negative pattern suppresses |
| `"no need to change that"` | `false` | Negative pattern suppresses |
| `"actually, that looks great"` | `false` | Negative pattern suppresses |
| `"actually, perfect"` | `false` | Negative pattern suppresses |
| `"stop there"` | `false` | Negative pattern suppresses |

**Non-corrections (should NOT trigger):**
| Input | Expected |
|---|---|
| `"yes, do that"` | `false` |
| `"looks good"` | `false` |
| `"can you also check the tests?"` | `false` |
| `""` | `false` |
| `"thanks"` | `false` |

#### Handler Behavior

| Test | What | Expected |
|---|---|---|
| `triggers pi.exec on correction` | Emit user message "no, don't use npm", then turn_end | `pi.exec()` called with CORRECTION_SAVE_PROMPT |
| `does not trigger on normal message` | Emit user message "looks good", then turn_end | `pi.exec()` NOT called |
| `rate limits: 1 per 3 turns` | Emit correction at turn 1, correction at turn 2 | Only first correction triggers save |
| `rate limit resets after 3 turns` | Emit correction at turn 1, then normal turns 2-4, then correction at turn 5 | Both corrections trigger save |
| `does not trigger when in progress` | Emit correction, then another correction before first completes | Only first triggers |
| `disabled via config` | Config `correctionDetection: false` | No handler registered |
| `includes recent context (last 6 exchanges)` | Verify prompt content | Prompt includes recent messages + current memory |

---

## Epic 4: Tool-Call-Aware Nudge

### Unit Tests: `tests/handlers/background-review.test.ts` (extend existing)

| Test | What | Expected |
|---|---|---|
| `triggers on turn count threshold` | `turnsSinceReview >= 10`, `toolCallsSinceReview < 15` | Review triggers |
| `triggers on tool call count threshold` | `turnsSinceReview < 10`, `toolCallsSinceReview >= 15` | Review triggers |
| `triggers when both thresholds met` | Both thresholds exceeded | Review triggers |
| `does not trigger when neither threshold met` | Both below threshold | No review |
| `resets both counters after review` | After review completes | Both counters = 0 |
| `counts toolCall blocks from branch` | Branch has 3 assistant messages with 2 toolCall blocks each | `toolCallsSinceReview = 6` |
| `ignores text blocks in content` | Branch has text blocks only | `toolCallsSinceReview = 0` |
| `falls back gracefully if branch access fails` | `sessionManager.getBranch()` throws | No crash, continues with turn-based only |

---

## Epic 1: Skill Tool + Procedural Memory

### Unit Tests: `tests/store/skill-store.test.ts`

#### CRUD Operations

| Test | What | Expected |
|---|---|---|
| `create() writes SKILL.md with correct frontmatter` | Create skill with name, description, body | File exists with `---\nname: ...\n---\n` format |
| `create() slugifies name correctly` | Name: `"Debug TypeScript Errors!"` | File: `debug-typescript-errors.md` |
| `create() returns error for duplicate name` | Create same skill twice | Second returns error about existing skill |
| `create() returns error for empty name` | `name: ""` | Error: "Skill name is required." |
| `create() returns error for empty description` | Valid name, empty description | Error: "Skill description is required." |
| `create() returns error for empty body` | Valid name/desc, empty body | Error: "Skill body is required." |
| `create() scans content for security` | Body contains injection pattern | Error: "Blocked: content matches threat pattern" |
| `loadIndex() returns all skills` | Create 3 skills, call loadIndex | Returns 3 SkillIndex entries |
| `loadIndex() returns empty array when no skills` | Empty skills dir | Returns `[]` |
| `loadSkill() returns full document` | Load specific .md file | Returns SkillDocument with all fields |
| `loadSkill() returns null for missing file` | Nonexistent file | Returns `null` |
| `loadSkill() returns null for missing frontmatter` | File without `---` frontmatter | Returns `null` |
| `patch() replaces existing section` | Skill has `## Procedure`, patch it | New content replaces old section |
| `patch() appends new section` | Skill has no `## Pitfalls`, patch it | Section appended |
| `patch() increments version` | Patch a skill | Version goes from 1 → 2 |
| `patch() scans content` | New content has injection pattern | Blocked |
| `edit() replaces description and body` | Edit with new desc + body | Both updated |
| `edit() replaces only description` | Edit with new desc, empty body | Only description changes |
| `edit() increments version` | Edit a skill | Version incremented |
| `delete() removes file` | Delete a skill | File gone, loadIndex returns one fewer |
| `delete() returns error for missing file` | Delete nonexistent | Error: "not found" |

#### Frontmatter Parsing

| Test | What | Expected |
|---|---|---|
| `parses standard frontmatter` | `---\nname: foo\ndescription: bar\n---\nbody` | `{ name: "foo", description: "bar", body: "body" }` |
| `handles value with colons` | `description: uses this: that` | Description = `"uses this: that"` |
| `handles empty body` | Frontmatter only, no body after `---` | body = `""` |
| `handles no frontmatter` | Plain markdown without `---` | Returns `{ meta: {}, body: raw }` |

#### Progressive Disclosure

| Test | What | Expected |
|---|---|---|
| `formatIndexForSystemPrompt() returns formatted index` | 2 skills | String with skill names + descriptions |
| `formatIndexForSystemPrompt() returns empty when no skills` | No skills | Returns `""` |
| `index does not include body content` | Skills have long bodies | Index only shows name + description |

#### Atomic Writes

| Test | What | Expected |
|---|---|---|
| `create() uses atomic write (file exists after create)` | Create skill, read file | File exists with correct content |
| `file content is correct after create + patch` | Create then patch | File on disk reflects patch |

### Unit Tests: `tests/tools/skill-tool.test.ts`

| Test | What | Expected |
|---|---|---|
| `registers tool with name 'skill'` | Check tool registration | Tool name = "skill" |
| `create requires name, description, content` | Missing each param | Error for each missing param |
| `view without file_name lists all skills` | No file_name param | Returns skill index |
| `view with file_name returns full document` | Valid file_name | Returns SkillDocument |
| `view with invalid file_name returns error` | Nonexistent file | Error: "not found" |
| `patch requires file_name, section, content` | Missing params | Error for each |
| `edit requires file_name` | No file_name | Error |
| `delete requires file_name` | No file_name | Error |
| `unknown action returns error` | `action: "foo"` | Error: "Unknown action" |

### Unit Tests: `tests/handlers/skill-auto-trigger.test.ts`

| Test | What | Expected |
|---|---|---|
| `triggers at 8+ tool calls with 2+ types` | Branch has 8 toolCall blocks with 3 distinct tool names | `pi.exec()` called |
| `does not trigger below 8 tool calls` | Branch has 7 toolCall blocks | Not triggered |
| `does not trigger with only 1 tool type` | 10 toolCall blocks, all same tool | Not triggered |
| `only triggers once per session` | Two turn_end events both meeting threshold | Only first triggers |
| `handles branch access failure gracefully` | `getBranch()` throws | No crash |

---

## Epic 5: Documentation & Release

### Manual Verification

| Check | Command | Expected |
|---|---|---|
| Type check passes | `npm run check` | Zero errors |
| All tests pass | `npm test` | 119+ tests, 0 failures |
| README updated | Manual review | Mentions skill tool, auto-consolidation, correction detection |
| ROADMAP updated | Manual review | v0.2 marked complete |
| Version bumped | `cat package.json \| grep version` | `"version": "0.2.0"` |
| Git tagged | `git tag -l "v0.2*"` | `v0.2.0` exists |

---

## Summary

| Area | New Tests | Existing Tests Modified |
|---|---|---|
| Auto-Consolidation | 6 + 6 | `memory-store.test.ts` (6 tests for async+consolidator) |
| Correction Detection | ~20 (patterns + handler) | — |
| Tool-Call Nudge | 8 | `background-review.test.ts` (extend) |
| Skill Store | ~25 | — |
| Skill Tool | ~10 | — |
| Skill Auto-Trigger | 5 | — |
| **Total** | **~80 new tests** | **~14 modified** |
