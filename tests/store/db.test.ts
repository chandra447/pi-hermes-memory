import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { DatabaseManager, SQLITE_BUSY_TIMEOUT_MS, SQLITE_WAL_AUTOCHECKPOINT_PAGES } from '../../src/store/db.js';
import { AtomicLockCoordinator } from '../../src/store/atomic-lock-coordinator.js';

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

    it('waits for a concurrent writer instead of failing immediately', async () => {
      const db = dbManager.getDb();
      const child = spawn(process.execPath, [
        '-e',
        `const Database = require('better-sqlite3');
         const db = new Database(process.argv[1]);
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked');
         setTimeout(() => { db.exec('COMMIT'); db.close(); }, 100);`,
        path.join(tmpDir, 'sessions.db'),
      ], { stdio: ['ignore', 'pipe', 'inherit'] });

      const childExit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
      });
      const childReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child did not lock database in time')), 5000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`child exited before locking database (code ${code})`));
        });
        child.stdout?.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      await childReady;
      db.prepare(`
        INSERT INTO extension_metadata (key, value)
        VALUES ('concurrent-writer', 'waited')
      `).run();
      await childExit;

      const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      assert.strictEqual(timeout.timeout, SQLITE_BUSY_TIMEOUT_MS);
    });

    it('should create parent directory if it does not exist', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'dir');
      const manager = new DatabaseManager(nestedDir);
      manager.getDb();
      assert.ok(fs.existsSync(path.join(nestedDir, 'sessions.db')));
      manager.close();
    });

    it('defers database creation while an initialization guard is active', () => {
      const guardedDir = path.join(tmpDir, 'guarded');
      const manager = new DatabaseManager(guardedDir);
      manager.setOpenGuard(() => {
        throw new Error('legacy database migration pending');
      });

      assert.throws(() => manager.getDb(), /legacy database migration pending/);
      assert.equal(fs.existsSync(path.join(guardedDir, 'sessions.db')), false);

      manager.setOpenGuard(null);
      assert.ok(manager.getDb());
      assert.equal(fs.existsSync(path.join(guardedDir, 'sessions.db')), true);
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
    it('waits for a recovery owner and reuses the healthy database it leaves behind', () => {
      dbManager.getDb();
      dbManager.close();
      const canonicalDbPath = fs.realpathSync(path.join(tmpDir, 'sessions.db'));
      const lockDbPath = path.join(path.dirname(canonicalDbPath), '.pi-hermes-locks.sqlite');
      const lockKey = `recovery:${canonicalDbPath}`;
      const coordinator = new AtomicLockCoordinator(lockDbPath);
      const lease = coordinator.tryAcquire(lockKey, { staleMs: 10_000 });
      assert.ok(lease);
      spawn(process.execPath, [
        '-e',
        `setTimeout(() => {
          const Database = require('better-sqlite3');
          const db = new Database(process.argv[1]);
          db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(process.argv[2], process.argv[3]);
          db.close();
        }, 100)`,
        lockDbPath,
        lockKey,
        lease.token,
      ], { stdio: 'ignore' });

      dbManager = new DatabaseManager(tmpDir, { recoveryLockWaitMs: 1000, recoveryLockPollMs: 10, recoveryLockStaleMs: 10_000 });
      const started = Date.now();
      const result = dbManager.recoverFromCorruption(corruptSqliteError());

      assert.strictEqual(result.strategy, 'reused');
      assert.ok(Date.now() - started >= 50, 'peer should wait for the active recovery owner');
      assert.strictEqual(fs.readdirSync(tmpDir).filter((name) => name.startsWith('sessions.db.corrupt-')).length, 0);
    });

    it('takes over a stale recovery lock', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'not a sqlite database');
      const canonicalDbPath = fs.realpathSync(path.join(tmpDir, 'sessions.db'));
      const lockDbPath = path.join(path.dirname(canonicalDbPath), '.pi-hermes-locks.sqlite');
      const coordinator = new AtomicLockCoordinator(lockDbPath);
      coordinator.tryAcquire('schema-init', { staleMs: 50 })!.release();
      const lockDb = new Database(lockDbPath);
      lockDb.prepare(`
        INSERT INTO locks (lock_key, token, pid, acquired_at)
        VALUES (?, 'dead-owner', 999999, ?)
      `).run(`recovery:${canonicalDbPath}`, Date.now() - 10_000);
      lockDb.close();

      dbManager = new DatabaseManager(tmpDir, { recoveryLockStaleMs: 50 });
      const db = dbManager.getDb();

      assertQuickCheckOk(db as InstanceType<typeof Database>);
    });

    it('aborts destructive recovery rename when the recovery lease was stolen mid-flight', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'not a sqlite database');
      dbManager = new DatabaseManager(tmpDir, { recoveryLockStaleMs: 60_000 });

      type MoveDatabaseFilesToBackup = (this: DatabaseManager, backupBase: string) => unknown;
      const prototype = DatabaseManager.prototype as unknown as {
        moveDatabaseFilesToBackup: MoveDatabaseFilesToBackup;
      };
      const originalMove = prototype.moveDatabaseFilesToBackup;
      let moveCalls = 0;
      prototype.moveDatabaseFilesToBackup = function (this: DatabaseManager, backupBase: string) {
        moveCalls++;
        if (moveCalls === 1) {
          const canonicalDbPath = fs.realpathSync(path.join(tmpDir, 'sessions.db'));
          const lockDbPath = path.join(path.dirname(canonicalDbPath), '.pi-hermes-locks.sqlite');
          const lockKey = `recovery:${canonicalDbPath}`;
          const lockDb = new Database(lockDbPath);
          try {
            lockDb.prepare('UPDATE locks SET acquired_at = ? WHERE lock_key = ?').run(Date.now() - 100_000, lockKey);
          } finally {
            lockDb.close();
          }
          const thief = new AtomicLockCoordinator(lockDbPath);
          const stolen = thief.tryAcquire(lockKey, { staleMs: 50 });
          assert.ok(stolen);
          stolen.release();
        }
        return originalMove.call(this, backupBase);
      };

      try {
        assert.throws(
          () => dbManager.getDb(),
          /SQLite recovery lease lost/,
        );
        assert.strictEqual(moveCalls, 1);
      } finally {
        prototype.moveDatabaseFilesToBackup = originalMove;
      }
    });

    it('serializes recovery through symlinked database aliases', { skip: process.platform === 'win32' }, () => {
      dbManager.close();
      const realDir = path.join(tmpDir, 'real');
      const aliasDir = path.join(tmpDir, 'alias');
      fs.mkdirSync(realDir);
      fs.symlinkSync(realDir, aliasDir, 'dir');
      fs.writeFileSync(path.join(realDir, 'sessions.db'), 'not a sqlite database');

      const canonicalDbPath = fs.realpathSync(path.join(realDir, 'sessions.db'));
      const coordinator = new AtomicLockCoordinator(path.join(path.dirname(canonicalDbPath), '.pi-hermes-locks.sqlite'));
      const lease = coordinator.tryAcquire(`recovery:${canonicalDbPath}`, { staleMs: 60_000 });
      assert.ok(lease);

      const aliasManager = new DatabaseManager(aliasDir, {
        recoveryLockWaitMs: 25,
        recoveryLockPollMs: 5,
        recoveryLockStaleMs: 60_000,
      });
      try {
        assert.throws(
          () => aliasManager.getDb(),
          /SQLite recovery already in progress/,
        );
      } finally {
        aliasManager.close();
        lease.release();
      }
    });

    it('repairs a file-symlinked database target without replacing the link', { skip: process.platform === 'win32' }, () => {
      dbManager.close();
      const realDir = path.join(tmpDir, 'real');
      const aliasDir = path.join(tmpDir, 'alias');
      fs.mkdirSync(realDir);
      fs.mkdirSync(aliasDir);
      const realDbPath = path.join(realDir, 'sessions.db');
      const aliasDbPath = path.join(aliasDir, 'sessions.db');
      fs.writeFileSync(realDbPath, 'not a sqlite database');
      fs.symlinkSync(realDbPath, aliasDbPath, 'file');

      const aliasManager = new DatabaseManager(aliasDir);
      const aliasDb = aliasManager.getDb();
      aliasDb.prepare("INSERT INTO extension_metadata (key, value) VALUES ('alias-write', 'kept')").run();
      aliasManager.close();

      assert.equal(fs.lstatSync(aliasDbPath).isSymbolicLink(), true);
      const directManager = new DatabaseManager(realDir);
      try {
        const directDb = directManager.getDb();
        assertQuickCheckOk(directDb as InstanceType<typeof Database>);
        assert.deepEqual(
          directDb.prepare("SELECT value FROM extension_metadata WHERE key = 'alias-write'").get(),
          { value: 'kept' },
        );
      } finally {
        directManager.close();
      }
    });

    it('creates and repairs a dangling absolute database symlink through its target', { skip: process.platform === 'win32' }, () => {
      dbManager.close();
      const realDir = path.join(tmpDir, 'real');
      const aliasDir = path.join(tmpDir, 'alias');
      fs.mkdirSync(realDir);
      fs.mkdirSync(aliasDir);
      const realDbPath = path.join(realDir, 'sessions.db');
      const aliasDbPath = path.join(aliasDir, 'sessions.db');
      fs.symlinkSync(realDbPath, aliasDbPath, 'file');

      const aliasManager = new DatabaseManager(aliasDir);
      aliasManager.getDb().prepare(
        "INSERT INTO extension_metadata (key, value) VALUES ('before-corruption', 'kept')",
      ).run();
      aliasManager.close();
      fs.writeFileSync(realDbPath, 'not a sqlite database');

      try {
        assertQuickCheckOk(aliasManager.getDb() as InstanceType<typeof Database>);
      } finally {
        aliasManager.close();
      }
      assert.equal(fs.lstatSync(aliasDbPath).isSymbolicLink(), true);
      const directDb = new Database(realDbPath);
      try {
        assertQuickCheckOk(directDb);
      } finally {
        directDb.close();
      }
    });

    it('rejects database symlink loops before opening SQLite', { skip: process.platform === 'win32' }, () => {
      dbManager.close();
      const loopDir = path.join(tmpDir, 'loop');
      fs.mkdirSync(loopDir);
      fs.symlinkSync('sessions.other', path.join(loopDir, 'sessions.db'), 'file');
      fs.symlinkSync('sessions.db', path.join(loopDir, 'sessions.other'), 'file');

      const manager = new DatabaseManager(loopDir);
      assert.throws(() => manager.getDb(), /symbolic link loop/i);
      manager.close();
    });

    it('cleans abandoned rebuild files and caps corrupt backup sets', () => {
      dbManager.close();
      for (let index = 0; index < 5; index++) {
        fs.writeFileSync(path.join(tmpDir, `sessions.db.corrupt-20260701-${index}`), `backup-${index}`);
      }
      fs.writeFileSync(path.join(tmpDir, 'sessions.db.rebuild-abandoned.tmp'), 'abandoned');
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'not a sqlite database');

      dbManager = new DatabaseManager(tmpDir, { recoveryBackupRetention: 3 });
      dbManager.getDb();

      const names = fs.readdirSync(tmpDir);
      assert.strictEqual(names.some((name) => name.startsWith('sessions.db.rebuild-')), false);
      assert.ok(names.filter((name) => name.startsWith('sessions.db.corrupt-')).length <= 3);
    });

    it('does not count successful recreations toward the recovery circuit', () => {
      dbManager.close();
      const dbPath = path.join(tmpDir, 'sessions.db');
      fs.writeFileSync(dbPath, 'first corrupt database');
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });
      dbManager.getDb();
      dbManager.close();

      fs.writeFileSync(dbPath, 'second corrupt database');
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });

      assert.doesNotThrow(() => dbManager.getDb());
      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
    });

    it('keeps verified recovery successful when cleanup state removal fails', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'corrupt database');
      dbManager = new DatabaseManager(tmpDir);
      let cleanupCalls = 0;
      (dbManager as any).cleanupRecoveryArtifacts = () => {
        cleanupCalls++;
        if (cleanupCalls > 1) throw new Error('injected cleanup failure');
      };
      (dbManager as any).clearRecoveryFailures = () => {
        throw new Error('injected circuit cleanup failure');
      };

      const db = dbManager.getDb();

      assert.ok(db);
      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
      assertQuickCheckOk(db as InstanceType<typeof Database>);
    });

    it('keeps verified recovery successful and clears a failed release before retry', () => {
      const prototype = AtomicLockCoordinator.prototype as any;
      const originalDeleteOwnedLock = prototype.deleteOwnedLock;
      let deleteAttempts = 0;
      prototype.deleteOwnedLock = function (key: string, token: string): void {
        deleteAttempts++;
        if (deleteAttempts <= 3) throw new Error('injected recovery release failure');
        return originalDeleteOwnedLock.call(this, key, token);
      };

      try {
        dbManager.close();
        const dbPath = path.join(tmpDir, 'sessions.db');
        fs.writeFileSync(dbPath, 'first corrupt database');
        dbManager = new DatabaseManager(tmpDir);
        assert.doesNotThrow(() => dbManager.getDb());
        assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');

        dbManager.close();
        fs.writeFileSync(dbPath, 'second corrupt database');
        dbManager = new DatabaseManager(tmpDir);
        assert.doesNotThrow(() => dbManager.getDb());
        assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
        assert.ok(deleteAttempts >= 4);
      } finally {
        prototype.deleteOwnedLock = originalDeleteOwnedLock;
      }
    });

    it('opens the recovery circuit after a failed recovery', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'corrupt database');
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });
      let recoveryCalls = 0;
      (dbManager as any).recoverDatabaseFileUnlocked = () => {
        recoveryCalls++;
        throw new Error('injected recovery failure');
      };

      assert.throws(() => dbManager.recoverFromCorruption(corruptSqliteError()), /injected recovery failure/);
      assert.throws(() => dbManager.recoverFromCorruption(corruptSqliteError()), /recovery circuit is open/i);
      assert.strictEqual(recoveryCalls, 1);
    });

    it('counts a failed post-recovery open before clearing the circuit', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'corrupt database');
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });
      const originalOpenUnchecked = (dbManager as any).openUnchecked.bind(dbManager);
      let openCalls = 0;
      (dbManager as any).openUnchecked = () => {
        openCalls++;
        if (openCalls === 2) throw new Error('injected post-recovery open failure');
        return originalOpenUnchecked();
      };

      assert.throws(() => dbManager.getDb(), /injected post-recovery open failure/);
      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'sessions.db.recovery-state.json'), 'utf-8'),
      );
      assert.strictEqual(state.failures.length, 1);
    });

    it('does not treat legacy recovery attempt state as failed recoveries', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'corrupt database');
      fs.writeFileSync(
        path.join(tmpDir, 'sessions.db.recovery-state.json'),
        JSON.stringify({ attempts: [Date.now()] }),
      );
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });

      assert.doesNotThrow(() => dbManager.getDb());
    });

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
      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'reused');
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
