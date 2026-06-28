import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseManager, SQLITE_WAL_AUTOCHECKPOINT_PAGES } from '../../src/store/db.js';

describe('DatabaseManager', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function assertQuickCheckOk(db: InstanceType<typeof Database>): void {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    assert.deepStrictEqual(rows.map((row) => Object.values(row)[0]), ['ok']);
  }

  function corruptSqliteError(): Error & { code: string } {
    const err = new Error('SQLITE_CORRUPT: database disk image is malformed') as Error & { code: string };
    err.code = 'SQLITE_CORRUPT';
    return err;
  }

  function corruptRecoverableIndexPage(dbPath: string, indexName: string): void {
    const db = new Database(dbPath);
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const row = db.prepare(`
      SELECT pageno
      FROM dbstat
      WHERE name = ? AND pagetype IN ('internal', 'leaf')
      ORDER BY pageno ASC
      LIMIT 1
    `).get(indexName) as { pageno: number } | undefined;
    db.close();

    assert.ok(row, `dbstat did not find index page for ${indexName}`);
    assert.ok(row.pageno > 1, 'will not corrupt sqlite database header page');

    const buffer = fs.readFileSync(dbPath);
    const offset = (row.pageno - 1) * pageSize;
    for (let i = 0; i < 16 && offset + i < buffer.length; i++) {
      buffer[offset + i] ^= 0xff;
    }
    fs.writeFileSync(dbPath, buffer);

    const checkDb = new Database(dbPath);
    try {
      const rows = checkDb.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
      const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok';
      assert.equal(ok, false, 'test fixture must produce a quick_check failure');
      assert.doesNotThrow(() => {
        checkDb.prepare('SELECT COUNT(*) as count FROM sessions NOT INDEXED').get();
        checkDb.prepare('SELECT COUNT(*) as count FROM messages NOT INDEXED').get();
        checkDb.prepare('SELECT COUNT(*) as count FROM memories NOT INDEXED').get();
      }, 'test fixture must leave core table scans readable');
    } finally {
      checkDb.close();
    }
  }

  describe('initialization', () => {
    it('should create database file on first getDb() call', () => {
      assert.strictEqual(dbManager.exists(), false);
      const db = dbManager.getDb();
      assert.ok(db);
      assert.strictEqual(dbManager.exists(), true);
    });

    it('should create sessions.db in the specified directory', () => {
      dbManager.getDb();
      const expectedPath = path.join(tmpDir, 'sessions.db');
      assert.strictEqual(dbManager.getPath(), expectedPath);
      assert.ok(fs.existsSync(expectedPath));
    });

    it('should return same db instance on multiple getDb() calls', () => {
      const db1 = dbManager.getDb();
      const db2 = dbManager.getDb();
      assert.strictEqual(db1, db2);
    });

    it('should create parent directory if it does not exist', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'dir');
      const manager = new DatabaseManager(nestedDir);
      manager.getDb();
      assert.ok(fs.existsSync(path.join(nestedDir, 'sessions.db')));
      manager.close();
    });
  });

  describe('schema', () => {
    it('should create all required tables', () => {
      const db = dbManager.getDb();
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `).all() as { name: string }[];

      const tableNames = tables.map(t => t.name);
      assert.ok(tableNames.includes('sessions'), 'sessions table missing');
      assert.ok(tableNames.includes('messages'), 'messages table missing');
      assert.ok(tableNames.includes('memories'), 'memories table missing');
    });

    it('should create FTS5 virtual tables', () => {
      const db = dbManager.getDb();
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'
      `).all() as { name: string }[];

      const tableNames = tables.map(t => t.name);
      assert.ok(tableNames.includes('message_fts'), 'message_fts table missing');
      assert.ok(tableNames.includes('memory_fts'), 'memory_fts table missing');
    });

    it('should create triggers for FTS sync', () => {
      const db = dbManager.getDb();
      const triggers = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='trigger'
      `).all() as { name: string }[];

      const triggerNames = triggers.map(t => t.name);
      assert.ok(triggerNames.includes('messages_ai'), 'messages_ai trigger missing');
      assert.ok(triggerNames.includes('messages_ad'), 'messages_ad trigger missing');
      assert.ok(triggerNames.includes('messages_au'), 'messages_au trigger missing');
      assert.ok(triggerNames.includes('memories_ai'), 'memories_ai trigger missing');
      assert.ok(triggerNames.includes('memories_ad'), 'memories_ad trigger missing');
      assert.ok(triggerNames.includes('memories_au'), 'memories_au trigger missing');
    });

    it('should be idempotent — running schema twice does not error', () => {
      const db = dbManager.getDb();
      // The schema uses IF NOT EXISTS, so running it again should be safe
      assert.doesNotThrow(() => {
        dbManager.close();
        dbManager = new DatabaseManager(tmpDir);
        dbManager.getDb();
      });
    });

    it('should migrate legacy memories table without category column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          content TEXT NOT NULL,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.close();

      const migratedManager = new DatabaseManager(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('category'));
      assert.ok(names.includes('failure_reason'));
      assert.ok(names.includes('tool_state'));
      assert.ok(names.includes('corrected_to'));

      migratedManager.close();
    });

    it('should migrate legacy sessions table without project column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          message_count INTEGER DEFAULT 0
        );
      `);
      legacyDb.prepare(`
        INSERT INTO sessions (id, cwd, started_at)
        VALUES (?, ?, ?)
      `).run('legacy-session', '/work/my-app', '2026-05-03T00:00:00Z');
      legacyDb.close();

      const migratedManager = new DatabaseManager(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('project'));

      const row = migratedDb.prepare('SELECT project FROM sessions WHERE id = ?').get('legacy-session') as { project: string };
      assert.strictEqual(row.project, 'my-app');

      assert.doesNotThrow(() => {
        migratedDb.prepare(`
          INSERT INTO sessions (id, project, cwd, started_at)
          VALUES (?, ?, ?, ?)
        `).run('new-session', 'new-project', '/work/new-project', '2026-05-04T00:00:00Z');
      });

      migratedManager.close();
    });

    it('should migrate legacy memories table without project column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          content TEXT NOT NULL,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (target, content, created, last_referenced)
        VALUES (?, ?, ?, ?)
      `).run('memory', 'legacy memory entry', '2026-05-09', '2026-05-09');
      legacyDb.close();

      const migratedManager = new DatabaseManager(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('project'));

      const row = migratedDb.prepare('SELECT project, content FROM memories').get() as {
        project: string | null;
        content: string;
      };
      assert.strictEqual(row.project, null);
      assert.strictEqual(row.content, 'legacy memory entry');

      migratedManager.close();
    });

    it('should migrate legacy target CHECK constraint to allow failure entries', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          category TEXT,
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(null, 'memory', null, 'existing memory', null, null, null, '2026-05-09', '2026-05-09');
      legacyDb.close();

      const migratedManager = new DatabaseManager(tmpDir);
      const migratedDb = migratedManager.getDb();

      assert.doesNotThrow(() => {
        migratedDb.prepare(`
          INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(null, 'failure', 'failure', 'failed setup', 'legacy check fixed', null, null, '2026-05-09', '2026-05-09');
      });

      const rows = migratedDb.prepare(`SELECT target, content FROM memories ORDER BY id ASC`).all() as Array<{ target: string; content: string }>;
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].content, 'existing memory');
      assert.strictEqual(rows[1].target, 'failure');

      migratedManager.close();
    });
  });

  describe('corruption recovery', () => {
    it('repairs recoverable corruption on open and preserves readable rows', () => {
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('recover-session', 'recover-project', '/work/recover', '2026-05-03T00:00:00Z');

      const insertMessage = db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 50; i++) {
        insertMessage.run(`recover-msg-${i}`, 'recover-session', i % 2 === 0 ? 'user' : 'assistant', `message ${i}`, `2026-05-03T00:${String(i).padStart(2, '0')}:00Z`);
      }

      db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `).run(null, 'memory', 'recoverable memory', '2026-05-03', '2026-05-03');
      dbManager.close();

      corruptRecoverableIndexPage(path.join(tmpDir, 'sessions.db'), 'idx_messages_timestamp');

      dbManager = new DatabaseManager(tmpDir);
      const repairedDb = dbManager.getDb();

      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'rebuilt');
      assert.deepStrictEqual(dbManager.getLastRecovery()?.recoveredRows, {
        extension_metadata: 0,
        sessions: 1,
        messages: 50,
        session_files: 0,
        memories: 1,
      });
      assert.deepStrictEqual(dbManager.getStats(), { sessions: 1, messages: 50, memories: 1 });
      const memory = repairedDb.prepare('SELECT content FROM memories WHERE content = ?').get('recoverable memory') as { content: string } | undefined;
      assert.ok(memory);
      assertQuickCheckOk(repairedDb as InstanceType<typeof Database>);
      assert.ok(fs.readdirSync(tmpDir).some((name) => name.startsWith('sessions.db.corrupt-')), 'corrupt DB should be quarantined');
    });

    it('quarantines unrecoverable files and recreates an empty database', () => {
      dbManager.close();
      const dbPath = path.join(tmpDir, 'sessions.db');
      fs.writeFileSync(dbPath, 'not a sqlite database');

      dbManager = new DatabaseManager(tmpDir);
      const db = dbManager.getDb();

      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
      assert.deepStrictEqual(dbManager.getStats(), { sessions: 0, messages: 0, memories: 0 });
      assertQuickCheckOk(db as InstanceType<typeof Database>);
      assert.ok(fs.readdirSync(tmpDir).some((name) => name.startsWith('sessions.db.corrupt-')), 'unrecoverable DB should be quarantined');
    });

    it('retries a corrupt operation once after self-healing', () => {
      dbManager.getDb();
      let attempts = 0;

      const result = dbManager.withCorruptionRecovery(() => {
        attempts++;
        if (attempts === 1) throw corruptSqliteError();
        return 'ok';
      });

      assert.strictEqual(result, 'ok');
      assert.strictEqual(attempts, 2);
      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'rebuilt');
    });
  });

  describe('close', () => {
    it('should close database connection', () => {
      const db = dbManager.getDb();
      assert.ok(db);
      dbManager.close();
      // After close, getDb should create a new connection
      const db2 = dbManager.getDb();
      assert.ok(db2);
      assert.notStrictEqual(db, db2);
    });

    it('should be safe to call close multiple times', () => {
      dbManager.getDb();
      assert.doesNotThrow(() => {
        dbManager.close();
        dbManager.close();
      });
    });

    it('should truncate the WAL file on close so it is not retained across sessions', () => {
      const db = dbManager.getDb();
      const walPath = `${dbManager.getPath()}-wal`;

      // Generate enough WAL traffic to materialize a non-trivial WAL file.
      const insert = db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 500; i++) {
        insert.run(null, 'memory', `entry ${i} ${'x'.repeat(200)}`, '2026-05-03', '2026-05-03');
      }
      assert.ok(fs.existsSync(walPath), 'WAL file should exist after writes');
      assert.ok(fs.statSync(walPath).size > 0, 'WAL should be non-empty before close');

      // close() runs PRAGMA wal_checkpoint(TRUNCATE), which shrinks the WAL to 0.
      dbManager.close();

      const walSizeAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      assert.strictEqual(walSizeAfter, 0, 'WAL should be truncated to 0 bytes after close');
    });
  });

  describe('getStats', () => {
    it('should return zero counts for empty database', () => {
      dbManager.getDb();
      const stats = dbManager.getStats();
      assert.strictEqual(stats.sessions, 0);
      assert.strictEqual(stats.messages, 0);
      assert.strictEqual(stats.memories, 0);
    });

    it('should count inserted records', () => {
      const db = dbManager.getDb();

      // Insert a session
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('test-session-1', 'test-project', '/test/cwd', '2026-05-03T00:00:00Z');

      // Insert a message
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-msg-1', 'test-session-1', 'user', 'Hello', '2026-05-03T00:01:00Z');

      // Insert a memory
      db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `).run(null, 'memory', 'prefers pnpm', '2026-05-03', '2026-05-03');

      const stats = dbManager.getStats();
      assert.strictEqual(stats.sessions, 1);
      assert.strictEqual(stats.messages, 1);
      assert.strictEqual(stats.memories, 1);
    });
  });

  describe('WAL mode', () => {
    it('should enable WAL mode for concurrent reads', () => {
      const db = dbManager.getDb();
      const result = db.pragma('journal_mode', { simple: true }) as string;
      assert.strictEqual(result, 'wal');
    });

    it('should use SQLite default-size WAL autocheckpoints', () => {
      const db = dbManager.getDb();
      const result = db.pragma('wal_autocheckpoint', { simple: true }) as number;
      assert.strictEqual(result, SQLITE_WAL_AUTOCHECKPOINT_PAGES);
    });
  });

  describe('foreign keys', () => {
    it('should enforce foreign key constraints', () => {
      const db = dbManager.getDb();
      const result = db.pragma('foreign_keys', { simple: true }) as number;
      assert.strictEqual(result, 1);

      // Inserting a message with non-existent session_id should fail
      assert.throws(() => {
        db.prepare(`
          INSERT INTO messages (id, session_id, role, content, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run('bad-msg', 'nonexistent-session', 'user', 'test', '2026-05-03T00:00:00Z');
      }, /FOREIGN KEY/);
    });
  });
});
