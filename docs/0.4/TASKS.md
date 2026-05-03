# v0.4 Tasks: SQLite FTS5 Session Search + Hybrid Memory

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Done

---

## Epic 1: SQLite Foundation ✅

### Task 1.1: Install better-sqlite3 and create DB module
- [x] Install `better-sqlite3` + `@types/better-sqlite3`
- [x] Create `src/store/db.ts` — DatabaseManager class
- [x] Create `tests/store/db.test.ts` — 14 tests passing

### Task 1.2: Create schema and migrations
- [x] Define schema in `src/store/schema.ts`
- [x] Add triggers to keep FTS index in sync
- [x] Test: schema creates cleanly on fresh DB, idempotent on existing DB

---

## Epic 2: Session History Indexing ✅

### Task 2.1: JSONL parser
- [x] Create `src/store/session-parser.ts`
- [x] Create `tests/store/session-parser.test.ts` — 14 tests passing

### Task 2.2: Session indexer
- [x] Create `src/store/session-indexer.ts`
- [x] Create `tests/store/session-indexer.test.ts` — 12 tests passing

### Task 2.3: /memory-index-sessions command
- [x] Create `src/handlers/index-sessions.ts`
- [x] Wire into `src/index.ts`

---

## Epic 3: Session Search ✅

### Task 3.1: Session search store
- [x] Create `src/store/session-search.ts` — FTS5 search
- [x] Create `tests/store/session-search.test.ts` — 11 tests passing

### Task 3.2: session_search tool
- [x] Create `src/tools/session-search-tool.ts`
- [x] Register in `src/index.ts`

---

## Epic 4: Extended Memory Store ✅

### Task 4.1: SQLite memory store
- [x] Create `src/store/sqlite-memory-store.ts`
- [x] Create `tests/store/sqlite-memory-store.test.ts` — 19 tests passing

### Task 4.2: memory_search tool
- [x] Create `src/tools/memory-search-tool.ts`
- [x] Register in `src/index.ts`

---

## Epic 5: Char Limit Increase ✅

### Task 5.1: Update defaults
- [x] Update `src/constants.ts` — 5000 defaults
- [x] Update `src/types.ts` — updated comments
- [x] Update README configuration table

### Task 5.2: Update tests
- [x] Updated all tests that depend on char limits
- [x] Verified consolidation still works at new limits

---

## Epic 6: Integration & Polish ✅

### Task 6.1: Wire everything into index.ts
- [x] Initialize DatabaseManager on extension load
- [x] Register `session_search` and `memory_search` tools
- [x] Register `/memory-index-sessions` command
- [x] Auto-index session on `session_shutdown` event

### Task 6.2: Add session indexing to background review
- [x] Auto-index on session_shutdown (indexes most recent session)

### Task 6.3: Update README
- [x] Added session history search and extended memory sections
- [x] Updated char limits: 2200/1375 → 5000
- [x] Updated configuration table and JSON example
- [x] Updated Where Data Lives with sessions.db
- [x] Updated Known Limitations

### Task 6.4: Version bump & release
- [x] Bump version to `0.4.0`
- [x] Run full test suite — 272 tests passing
- [x] Publish to npm
- [x] Create GitHub release

---

## Summary

| Epic | Files Created | Tests |
|---|---|---|
| 1. SQLite Foundation | db.ts, schema.ts | 14 |
| 2. Session Indexing | session-parser.ts, session-indexer.ts, index-sessions.ts | 26 |
| 3. Session Search | session-search.ts, session-search-tool.ts | 11 |
| 4. Extended Memory | sqlite-memory-store.ts, memory-search-tool.ts | 19 |
| 5. Char Limits | constants.ts, types.ts | — |
| 6. Integration | index.ts, README.md, learn-memory-tool skill | — |
| **Total** | **12 new files** | **272 tests** |
