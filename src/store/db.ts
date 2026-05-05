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

    // Create tables and triggers
    try {
      db.exec(SCHEMA_SQL);
    } catch (err) {
      if (!this.isLegacyMemoriesCategoryError(err)) {
        throw err;
      }

      // Legacy DB from pre-v0.6 can have memories table without the category
      // and failure metadata columns. Add missing columns, then retry schema.
      this.ensureMemoriesColumns(db);
      db.exec(SCHEMA_SQL);
    }

    // Extra safety: always ensure the legacy memories columns exist, even when
    // schema execution succeeds (idempotent on upgraded DBs).
    this.ensureMemoriesColumns(db);

    return db;
  }

  private isLegacyMemoriesCategoryError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('no such column: category') || msg.includes('memories(category)');
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
