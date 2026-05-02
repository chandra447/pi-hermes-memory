# v0.4 Plan: SQLite FTS5 Session Search + Hybrid Memory

## Problem

The current memory architecture has two scaling bottlenecks:

1. **Memory capacity**: MEMORY.md is capped at 2,200 chars. Power users accumulate knowledge faster than consolidation can manage. Important facts get pruned.
2. **No session history search**: Past conversations are stored as JSONL files in `~/.pi/agent/sessions/<project>/`, but there's no way to search them. When the agent needs context from a previous session, it's gone forever.

## Solution: Hybrid Memory Architecture

### Core memory (always injected, unchanged)
- `MEMORY.md` — 5,000 chars (up from 2,200)
- `USER.md` — 5,000 chars (up from 1,375)
- Still injected into every session via `<memory-context>` tags
- Still human-readable, still editable

### Extended memory (SQLite, searchable on demand)
- `~/.pi/agent/memory/sessions.db`
- `memories` table — unlimited entries, searchable via FTS5
- Agent uses `memory_search` tool to query when it needs context
- Not automatically injected — agent must explicitly search

### Session history (SQLite, searchable on demand)
- Same `sessions.db` file
- `sessions` + `messages` tables — all past conversations indexed
- `session_fts` FTS5 index — full-text search across all sessions
- Agent uses `session_search` tool to find relevant past context

## Architecture

```
Session starts
    ↓
┌─────────────────────────────────────────────────┐
│ System Prompt (always injected)                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ <memory-context>                            │ │
│ │ MEMORY (your personal notes) [5,000 chars]  │ │
│ │ ═══ END MEMORY ═══                         │ │
│ │ </memory-context>                           │ │
│ │ <memory-context>                            │ │
│ │ USER PROFILE [5,000 chars]                  │ │
│ │ ═══ END MEMORY ═══                         │ │
│ │ </memory-context>                           │ │
│ │ <memory-context>                            │ │
│ │ PROJECT MEMORY [5,000 chars]                │ │
│ │ ═══ END MEMORY ═══                         │ │
│ │ </memory-context>                           │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘

Agent has access to tools:
    memory_search("prisma migration")
        → Searches memories table (global + project)
        → Returns top-10 relevant entries

    session_search("how we fixed the test hang")
        → Searches session history via FTS5
        → Returns relevant conversation snippets
```

## Data Model

```sql
-- Session metadata
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,           -- UUID from JSONL
  project TEXT NOT NULL,         -- decoded cwd path
  started_at TEXT NOT NULL,      -- ISO timestamp
  ended_at TEXT,                 -- ISO timestamp (null if still running)
  message_count INTEGER DEFAULT 0
);

-- All messages from all sessions
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- message ID from JSONL
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,            -- 'user', 'assistant', 'system'
  content TEXT NOT NULL,         -- extracted text content
  timestamp TEXT NOT NULL,       -- ISO timestamp
  tool_calls TEXT                -- JSON array of tool call names (for assistant messages)
);

-- FTS5 index for full-text search across messages
CREATE VIRTUAL TABLE message_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

-- Extended memory entries (beyond MEMORY.md limit)
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,                  -- NULL for global, project name for project-specific
  target TEXT NOT NULL,          -- 'memory' or 'user'
  content TEXT NOT NULL,
  created DATE NOT NULL,
  last_referenced DATE NOT NULL
);

-- FTS5 index for memory search
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  content='memories',
  content_rowid='id'
);
```

## Key Design Decisions

### 1. Session indexing is lazy (on session end)
- Don't parse JSONL files on every startup
- Index a session when `session_shutdown` fires
- Bulk import existing sessions via `/memory-index-sessions` command

### 2. FTS5 for both memories and sessions
- Keyword search is sufficient for v0.4
- Embeddings deferred to v0.5+ if search quality isn't enough
- `better-sqlite3` includes FTS5 by default

### 3. Single DB file
- `~/.pi/agent/memory/sessions.db` stores everything
- Memories + sessions + FTS indices in one file
- Simple backup (copy one file), simple cleanup

### 4. Agent-driven search
- `memory_search` and `session_search` are LLM tools
- Agent decides when to search (not automatic)
- Avoids injecting irrelevant context into every session

### 5. Char limit increase to 5,000
- MEMORY.md: 2,200 → 5,000 chars
- USER.md: 1,375 → 5,000 chars
- Project MEMORY.md: 2,200 → 5,000 chars
- More room for core memories before consolidation kicks in

## Dependencies

| Package | Purpose | Size |
|---|---|---|
| `better-sqlite3` | SQLite with FTS5 | ~1MB native addon |

## Risks

| Risk | Mitigation |
|---|---|
| `better-sqlite3` is a native C++ addon | Standard for dev tools; CI has build tools |
| FTS5 search quality | Start with keyword search, add embeddings later if needed |
| Session JSONL format changes | Parse defensively, skip unknown message types |
| Large session history (1000+ sessions) | FTS5 handles this well; add pagination to results |
| DB corruption | Atomic writes, WAL mode, backup before migrations |

## Success Criteria

1. `session_search("prisma migration")` returns relevant conversation snippets from past sessions
2. `memory_search("auth setup")` returns relevant entries from extended memory store
3. MEMORY.md limit raised to 5,000 chars without breaking existing functionality
4. Existing session files indexed without data loss
5. All tests pass, zero regressions
