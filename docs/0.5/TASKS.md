# v0.5 Tasks: Failure Memory + Categories + Provenance

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Done

---

## Epic 1: Category Types & Schema

### Task 1.1: Add MemoryCategory type
- [ ] Add `MemoryCategory` type to `src/types.ts`
- [ ] Categories: `failure`, `correction`, `insight`, `preference`, `convention`, `tool-quirk`

### Task 1.2: Update SQLite schema
- [ ] Update `src/store/schema.ts` — add `category` column to memories table
- [ ] Add index on category for faster filtering

---

## Epic 2: Failure Memory Store

### Task 2.1: Update MemoryStore
- [ ] Add `addFailure()` method to `src/store/memory-store.ts`
- [ ] Store failures in MEMORY.md with category metadata
- [ ] Add `getFailureEntries()` to retrieve recent failures (last 7 days)
- [ ] Update `formatForSystemPrompt()` to include failure section

### Task 2.2: Update SQLite Memory Store
- [ ] Add category support to `src/store/sqlite-memory-store.ts`
- [ ] Update `addMemory()` to accept category
- [ ] Update `searchMemories()` to filter by category
- [ ] Add `getRecentFailures()` method

### Task 2.3: Tests
- [ ] Test `addFailure()` in `tests/store/memory-store.test.ts`
- [ ] Test category filtering in `tests/store/sqlite-memory-store.test.ts`
- [ ] Test `getRecentFailures()` returns only last 7 days

---

## Epic 3: Failure Detection

### Task 3.1: Update Correction Detector
- [ ] Update `src/handlers/correction-detector.ts`
- [ ] Extract failure context when correction detected
- [ ] Store: what was wrong, what is correct, category

### Task 3.2: Update Background Review Prompt
- [ ] Update `src/constants.ts` — enhance `CONSOLIDATION_PROMPT`
- [ ] Add failure extraction instructions
- [ ] Prompt to categorize findings (failure, correction, insight, etc.)

### Task 3.3: Auto-Detect Failures in Conversation
- [ ] Add failure pattern detection in `src/handlers/background-review.ts`
- [ ] Detect: "that didn't work", "use X instead", error messages
- [ ] Store failures with `tool_state` (error output)

### Task 3.4: Tests
- [ ] Test failure detection in `tests/handlers/correction-detector.test.ts`
- [ ] Test failure extraction in `tests/handlers/background-review.test.ts`

---

## Epic 4: Failure Injection

### Task 4.1: Update System Prompt Injection
- [ ] Update `src/index.ts` — add failure memory block
- [ ] Separate `<memory-context>` block for failures
- [ ] Only inject recent (7 days) and relevant (project match)
- [ ] Max 5 failure entries

### Task 4.2: Failure Injection Format
- [ ] Format:
  ```
  RECENT FAILURES & LESSONS (learn from these):
  • [failure] Tried: X — Failed: Y → Corrected to: Z
  • [correction] Use X, not Y (corrected N days ago)
  • [insight] Learned: X
  ```

### Task 4.3: Tests
- [ ] Test failure injection in `tests/handlers/system-prompt.test.ts`
- [ ] Test: only recent failures injected
- [ ] Test: max 5 entries enforced

---

## Epic 5: Search with Categories

### Task 5.1: Update Memory Search Tool
- [ ] Update `src/tools/memory-search-tool.ts`
- [ ] Add `category` parameter using `StringEnum`
- [ ] Categories: `failure`, `correction`, `insight`, `preference`, `convention`, `tool-quirk`

### Task 5.2: Update Search Implementation
- [ ] Update `src/store/sqlite-memory-store.ts` — `searchMemories()`
- [ ] Filter by category when provided
- [ ] Include category in search results

### Task 5.3: Tests
- [ ] Test category search in `tests/store/sqlite-memory-store.test.ts`
- [ ] Test: `memory_search("auth", category: "failure")` returns failures only

---

## Epic 6: Integration & Polish

### Task 6.1: Wire Everything Together
- [ ] Update `src/index.ts` — ensure all components work together
- [ ] Test end-to-end flow: detect → store → inject → search

### Task 6.2: Update README
- [ ] Add "Learning from Failures" section
- [ ] Document categories and how they work
- [ ] Add examples of failure memory

### Task 6.3: Version Bump
- [ ] Bump to `0.5.5`
- [ ] Run full test suite
- [ ] Publish to npm

---

## Summary

| Epic | Files Changed | Tests |
|---|---|---|
| 1. Category Types | types.ts, schema.ts | 2 |
| 2. Failure Store | memory-store.ts, sqlite-memory-store.ts | 6 |
| 3. Failure Detection | correction-detector.ts, background-review.ts, constants.ts | 4 |
| 4. Failure Injection | index.ts | 3 |
| 5. Category Search | memory-search-tool.ts, sqlite-memory-store.ts | 3 |
| 6. Integration | index.ts, README.md | — |
| **Total** | **8 files** | **~18 tests** |

## Implementation Order

```
Epic 1 (Types) → Epic 2 (Store) → Epic 3 (Detection) → Epic 4 (Injection) → Epic 5 (Search) → Epic 6 (Polish)
```

Each epic builds on the previous one. Epics 3-5 can be done in parallel after Epic 2.
