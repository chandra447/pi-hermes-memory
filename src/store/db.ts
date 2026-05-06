import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { SCHEMA_SQL } from './schema.js';

export class DatabaseManager {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  constructor(memoryDir: string) {
    this.dbPath = path.join(memoryDir, 'sessions.db');
  }

  /**
   * Get the database instance. Creates/opens on first call.
   */
  getDb(): Database.Database {
    if (!this.db) {
      this.db = this.open();
    }
    return this.db;
  }

  /**
   * Open the database and initialize schema.
   */
  private open(): Database.Database {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db = new Database(this.dbPath);

    // Enable WAL mode for concurrent reads
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Pre-migrate legacy tables first so schema/index creation doesn't fail.
    this.ensureMemoriesColumns(db);
    this.ensureMemoryCandidatesColumns(db);

    // Create tables and triggers
    try {
      db.exec(SCHEMA_SQL);
    } catch (err) {
      if (!this.isLegacyMemoriesCategoryError(err) && !this.isLegacyMemoryCandidatesError(err)) {
        throw err;
      }

      // Retry once after idempotent migration pass.
      this.ensureMemoriesColumns(db);
      this.ensureMemoryCandidatesColumns(db);
      db.exec(SCHEMA_SQL);
    }

    // Final idempotent pass for upgraded installs.
    this.ensureMemoriesColumns(db);
    this.ensureMemoryCandidatesColumns(db);

    return db;
  }

  private isLegacyMemoriesCategoryError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('no such column: category') || msg.includes('memories(category)');
  }

  private isLegacyMemoryCandidatesError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('memory_candidates')
      && (msg.includes('extractor_rule') || msg.includes('evidence_count') || msg.includes('tag') || msg.includes('snippet') || msg.includes('rationale'));
  }

  private ensureMemoriesColumns(db: Database.Database): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const columns = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    const names = new Set(columns.map((c) => c.name));

    if (!names.has('category')) {
      db.exec('ALTER TABLE memories ADD COLUMN category TEXT');
    }
    if (!names.has('failure_reason')) {
      db.exec('ALTER TABLE memories ADD COLUMN failure_reason TEXT');
    }
    if (!names.has('tool_state')) {
      db.exec('ALTER TABLE memories ADD COLUMN tool_state TEXT');
    }
    if (!names.has('corrected_to')) {
      db.exec('ALTER TABLE memories ADD COLUMN corrected_to TEXT');
    }
  }

  private ensureMemoryCandidatesColumns(db: Database.Database): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_candidates'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const columns = db.prepare('PRAGMA table_info(memory_candidates)').all() as { name: string }[];
    const names = new Set(columns.map((c) => c.name));
    const has = (col: string) => names.has(col);

    if (!has('tag')) {
      db.exec("ALTER TABLE memory_candidates ADD COLUMN tag TEXT NOT NULL DEFAULT ''");
    }
    if (!has('snippet')) {
      db.exec("ALTER TABLE memory_candidates ADD COLUMN snippet TEXT NOT NULL DEFAULT ''");
    }
    if (!has('rationale')) {
      db.exec("ALTER TABLE memory_candidates ADD COLUMN rationale TEXT NOT NULL DEFAULT ''");
    }
    if (!has('extractor_rule')) {
      db.exec("ALTER TABLE memory_candidates ADD COLUMN extractor_rule TEXT NOT NULL DEFAULT 'unknown'");
    }
    if (!has('evidence_count')) {
      db.exec('ALTER TABLE memory_candidates ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1');
    }

    if (has('status') && has('created_at')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_candidates_status_created ON memory_candidates(status, created_at DESC)');
    }
    if (has('project') && has('status')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_candidates_project_status ON memory_candidates(project, status)');
    }
    if (has('session_id')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_candidates_session ON memory_candidates(session_id)');
    }
    if (has('tag') && has('status')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_candidates_tag_status ON memory_candidates(tag, status)');
    }
    if (has('session_id') && has('message_id') && has('tag') && has('extractor_rule')) {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_dedupe_session_message_tag_rule ON memory_candidates(session_id, message_id, tag, extractor_rule)');
    }

    // Legacy pre-epic table variants may still include this index shape.
    if (has('session_id') && has('message_id') && has('candidate_type') && has('extractor_rule') && has('normalized_snippet')) {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_dedupe ON memory_candidates(session_id, message_id, candidate_type, extractor_rule, normalized_snippet)');
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Check if the database file exists.
   */
  exists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  /**
   * Get stats about the database.
   */
  getStats(): { sessions: number; messages: number; memories: number } {
    const db = this.getDb();
    const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    const memories = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    return {
      sessions: sessions.count,
      messages: messages.count,
      memories: memories.count,
    };
  }
}
