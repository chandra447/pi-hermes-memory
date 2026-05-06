/**
 * SQLite schema for pi-hermes-memory v0.4
 *
 * Tables:
 * - sessions — Pi session metadata
 * - messages — all conversation messages
 * - message_fts — FTS5 index for full-text search across messages
 * - memories — extended memory entries (unlimited, searchable)
 * - memory_fts — FTS5 index for memory search
 */

export const SCHEMA_SQL = `
  -- Session metadata
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    message_count INTEGER DEFAULT 0
  );

  -- All messages from all sessions
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    tool_calls TEXT
  );

  -- FTS5 index for full-text search across messages
  -- content='messages' + content_rowid='rowid' keeps FTS in sync with the content table
  CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
  );

  -- Triggers to keep message_fts in sync with messages table
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  -- Extended memory entries (beyond MEMORY.md limit)
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
    category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
    content TEXT NOT NULL,
    failure_reason TEXT,
    tool_state TEXT,
    corrected_to TEXT,
    created DATE NOT NULL,
    last_referenced DATE NOT NULL
  );

  -- FTS5 index for memory search
  -- content='memories' + content_rowid='id' keeps FTS in sync
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    content='memories',
    content_rowid='id'
  );

  -- Triggers to keep memory_fts in sync with memories table
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;

  -- Candidate learnings staged for review (v0.7)
  CREATE TABLE IF NOT EXISTS memory_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id TEXT,
    project TEXT,
    tag TEXT NOT NULL,
    snippet TEXT NOT NULL,
    rationale TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'promoted')) DEFAULT 'pending',
    source_type TEXT NOT NULL CHECK (source_type IN ('correction', 'failure', 'tool_sequence', 'explicit_tag')) DEFAULT 'failure',
    extractor_rule TEXT NOT NULL,
    evidence_count INTEGER NOT NULL DEFAULT 1,
    tool_state TEXT,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    promoted_skill TEXT,
    dedupe_key TEXT UNIQUE
  );

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
  CREATE INDEX IF NOT EXISTS idx_memories_target ON memories(target);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_candidates_status_created ON memory_candidates(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_candidates_project_status ON memory_candidates(project, status);
  CREATE INDEX IF NOT EXISTS idx_candidates_session ON memory_candidates(session_id);
  CREATE INDEX IF NOT EXISTS idx_candidates_tag_status ON memory_candidates(tag, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_dedupe_session_message_tag_rule ON memory_candidates(session_id, message_id, tag, extractor_rule);
`;
