# v0.4 Tasks: SQLite FTS5 Session Search + Hybrid Memory

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Done

---

## Epic 1: SQLite Foundation

### Task 1.1: Install better-sqlite3 and create DB module
- [ ] Install `better-sqlite3` + `@types/better-sqlite3`
- [ ] Create `src/store/db.ts` — DatabaseManager class
  - Lazy initialization (create/open DB on first use)
  - WAL mode for concurrent reads
  - Auto-create tables if they don't exist
  - `close()` method for cleanup
- [ ] Create `tests/store/db.test.ts` — tests for DB initialization, table creation, close/reopen

### Task 1.2: Create schema and migrations
- [ ] Define schema in `src/store/schema.ts` — all CREATE TABLE statements
  - `sessions` table
  - `messages` table
  - `message_fts` FTS5 virtual table
  - `memories` table
  - `memory_fts` FTS5 virtual table
- [ ] Add triggers to keep FTS index in sync (INSERT/UPDATE/DELETE)
- [ ] Test: schema creates cleanly on fresh DB, idempotent on existing DB

---

## Epic 2: Session History Indexing

### Task 2.1: JSONL parser
- [ ] Create `src/store/session-parser.ts`
  - `parseSessionFile(path)` — read JSONL, extract session metadata + messages
  - Handle all message types: user, assistant, system, tool_result
  - Extract text content from `content` array (handle text, thinking, tool_use types)
  - Skip unknown types gracefully
  - Return structured `SessionData` with `messages: ParsedMessage[]`
- [ ] Create `tests/store/session-parser.test.ts` — test with real JSONL fixtures

### Task 2.2: Session indexer
- [ ] Create `src/store/session-indexer.ts`
  - `indexSession(db, sessionData)` — INSERT into sessions + messages tables
  - `indexAllSessions(db, projectPath?)` — bulk index all sessions for a project (or all projects)
  - Skip already-indexed sessions (by session ID)
  - `getSessionStats(db)` — count of sessions, messages, indexed projects
- [ ] Create `tests/store/session-indexer.test.ts` — test indexing, deduplication, stats

### Task 2.3: /memory-index-sessions command
- [ ] Create `src/handlers/index-sessions.ts`
  - `/memory-index-sessions` — bulk import existing JSONL sessions
  - Show progress: "Indexing 36 sessions..."
  - Show result: "Indexed 36 sessions, 1,247 messages"
  - Handle errors gracefully (corrupt JSONL, missing files)
- [ ] Wire into `src/index.ts`
- [ ] Create `tests/handlers/index-sessions.test.ts`

---

## Epic 3: Session Search

### Task 3.1: Session search store
- [ ] Add to `src/store/session-indexer.ts` (or separate `session-search.ts`)
  - `searchSessions(db, query, options?)` — FTS5 search across messages
  - Options: `limit`, `project`, `role` filter, `since` date filter
  - Returns: `SearchResult[]` with `{sessionId, role, content, timestamp, snippet, project}`
  - `snippet` — highlighted match context from FTS5 `snippet()` function
- [ ] Create `tests/store/session-search.test.ts` — test search, filters, relevance

### Task 3.2: session_search tool
- [ ] Create `src/tools/session-search-tool.ts`
  - LLM tool definition: `session_search(query, project?, limit?)`
  - Returns formatted results for the agent
  - Includes session date, project, and content snippet
- [ ] Register in `src/index.ts`
- [ ] Create `tests/tools/session-search-tool.test.ts`

---

## Epic 4: Extended Memory Store

### Task 4.1: SQLite memory store
- [ ] Create `src/store/sqlite-memory-store.ts`
  - `addMemory(db, content, project?, target?)` — INSERT into memories + memory_fts
  - `searchMemories(db, query, options?)` — FTS5 search across memories
  - `getMemories(db, project?, target?)` — list all memories (optionally filtered)
  - `removeMemory(db, id)` — DELETE by ID
  - `getMemoryStats(db)` — count by project/target
- [ ] Create `tests/store/sqlite-memory-store.test.ts`

### Task 4.2: memory_search tool
- [ ] Create `src/tools/memory-search-tool.ts`
  - LLM tool definition: `memory_search(query, project?, limit?)`
  - Searches both global and project-specific memories
  - Returns formatted results for the agent
- [ ] Register in `src/index.ts`
- [ ] Create `tests/tools/memory-search-tool.test.ts`

---

## Epic 5: Char Limit Increase

### Task 5.1: Update defaults
- [ ] Update `src/config.ts` — change defaults:
  - `memoryCharLimit`: 2200 → 5000
  - `userCharLimit`: 1375 → 5000
  - `projectCharLimit`: 2200 → 5000
- [ ] Update `src/constants.ts` — change constants if any
- [ ] Update README configuration table

### Task 5.2: Update tests
- [ ] Update all tests that depend on char limits
- [ ] Verify consolidation still works at new limits
- [ ] Verify interview still works at new limits

---

## Epic 6: Integration & Polish

### Task 6.1: Wire everything into index.ts
- [ ] Initialize DatabaseManager on extension load
- [ ] Register `session_search` and `memory_search` tools
- [ ] Register `/memory-index-sessions` command
- [ ] Auto-index session on `session_shutdown` event
- [ ] Close DB on extension unload

### Task 6.2: Add session indexing to background review
- [ ] In `session-flush.ts` — also index the session to SQLite before flushing memories
- [ ] Ensure session is indexed even if shutdown event is missed

### Task 6.3: Update README
- [ ] Add "Hybrid Memory Architecture" section
- [ ] Document `session_search` and `memory_search` tools
- [ ] Document `/memory-index-sessions` command
- [ ] Update char limit documentation
- [ ] Update configuration table

### Task 6.4: Version bump & release
- [ ] Bump version to `0.4.0`
- [ ] Update CHANGELOG.md
- [ ] Run full test suite
- [ ] Publish to npm
- [ ] Create GitHub release
