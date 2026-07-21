import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';
import { AtomicLockCoordinator } from './atomic-lock-coordinator.js';
import { canonicalStoragePathSync } from './canonical-storage-path.js';

type StatementLike = {
  run: (...args: any[]) => any;
  get: (...args: any[]) => any;
  all: (...args: any[]) => any;
  iterate?: (...args: any[]) => Iterable<Record<string, unknown>>;
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
  pragma?: (query: string, options?: any) => any;
  transaction?: (fn: any) => any;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;
type BunDatabaseInstance = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: (throwOnError?: boolean) => void;
  transaction?: (fn: any) => any;
};

type DatabaseFileSuffix = '' | '-wal' | '-shm';

type MovedDatabaseFile = {
  original: string;
  backup: string;
};

export interface DatabaseRecoveryResult {
  strategy: 'rebuilt' | 'recreated-empty' | 'reused';
  backupPaths: string[];
  recoveredRows?: Record<string, number>;
  error?: string;
}

export interface DatabaseRecoveryOptions {
  recoveryLockWaitMs?: number;
  recoveryLockPollMs?: number;
  recoveryLockStaleMs?: number;
  recoveryCircuitLimit?: number;
  recoveryCircuitWindowMs?: number;
  recoveryBackupRetention?: number;
}

interface ResolvedDatabaseRecoveryOptions {
  recoveryLockWaitMs: number;
  recoveryLockPollMs: number;
  recoveryLockStaleMs: number;
  recoveryCircuitLimit: number;
  recoveryCircuitWindowMs: number;
  recoveryBackupRetention: number;
}

class DatabaseCorruptionError extends Error {
  code = 'SQLITE_CORRUPT';

  constructor(message: string) {
    super(message);
    this.name = 'DatabaseCorruptionError';
  }
}

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;

const DATABASE_FILE_SUFFIXES: readonly DatabaseFileSuffix[] = ['', '-wal', '-shm'];
const MEMORY_TARGETS = new Set(['memory', 'user', 'failure']);
const MEMORY_CATEGORIES = new Set(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk']);
const DEFAULT_RECOVERY_OPTIONS: ResolvedDatabaseRecoveryOptions = {
  recoveryLockWaitMs: 5000,
  recoveryLockPollMs: 50,
  recoveryLockStaleMs: 300000,
  recoveryCircuitLimit: 3,
  recoveryCircuitWindowMs: 300000,
  recoveryBackupRetention: 3,
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function createBunCompatDatabaseCtor(require: NodeRequire): DatabaseCtor {
  const bunSqlite = require('bun:sqlite') as { Database: new (dbPath: string) => BunDatabaseInstance };

  return class BunCompatDatabase implements DatabaseLike {
    private readonly db: BunDatabaseInstance;

    constructor(dbPath: string) {
      this.db = new bunSqlite.Database(dbPath);
    }

    prepare(sql: string): StatementLike {
      return this.db.prepare(sql);
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    close(): void {
      this.db.close();
    }

    transaction(fn: any): any {
      if (!this.db.transaction) {
        return undefined;
      }
      return this.db.transaction(fn);
    }
  };
}

function loadDatabaseCtor(): DatabaseCtor {
  const require = createRequire(import.meta.url);
  const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

  if (isBunRuntime) {
    return createBunCompatDatabaseCtor(require);
  }

  try {
    const mod = require('better-sqlite3') as { default?: DatabaseCtor } | DatabaseCtor;
    return (mod as { default?: DatabaseCtor }).default ?? (mod as DatabaseCtor);
  } catch (err) {
    throw err;
  }
}

const Database = loadDatabaseCtor();

export class DatabaseManager {
  private db: DatabaseLike | null = null;
  private readonly displayDbPath: string;
  private canonicalDbPath: string | null = null;
  private readonly recoveryOptions: ResolvedDatabaseRecoveryOptions;
  private lastRecovery: DatabaseRecoveryResult | null = null;
  private openGuard: (() => void) | null = null;
  private activeRecoveryLease: { coordinator: AtomicLockCoordinator; key: string; token: string } | null = null;

  constructor(memoryDir: string, recoveryOptions: DatabaseRecoveryOptions = {}) {
    this.displayDbPath = path.join(memoryDir, 'sessions.db');
    this.recoveryOptions = { ...DEFAULT_RECOVERY_OPTIONS, ...recoveryOptions };
  }

  private get dbPath(): string {
    if (!this.canonicalDbPath) {
      this.canonicalDbPath = canonicalStoragePathSync(this.displayDbPath);
    }
    return this.canonicalDbPath;
  }

  setOpenGuard(guard: (() => void) | null): void {
    this.openGuard = guard;
  }

  /**
   * True when an error indicates SQLite file/page corruption rather than a
   * normal constraint, migration, or query failure.
   */
  static isCorruptionError(err: unknown): boolean {
    if (!err) return false;

    const code = typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true;

    const message = DatabaseManager.errorMessage(err).toLowerCase();
    return message.includes('database disk image is malformed')
      || message.includes('file is not a database')
      || message.includes('database schema is corrupt')
      || message.includes('malformed database schema')
      || message.includes('btreeinitpage')
      || message.includes('sqlite_corrupt')
      || message.includes('sqlite_notadb');
  }

  private static errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  /**
   * Get the database instance. Creates/opens on first call.
   */
  getDb(): DatabaseLike {
    if (!this.db) {
      this.openGuard?.();
      this.db = this.open();
    }
    return this.db;
  }

  /**
   * Last self-heal performed by this manager, if any. Exposed for diagnostics
   * and tests; normal callers do not need it.
   */
  getLastRecovery(): DatabaseRecoveryResult | null {
    return this.lastRecovery;
  }

  /**
   * Retry a DB operation once after quarantining/rebuilding a corrupt DB.
   */
  withCorruptionRecovery<T>(operation: () => T): T {
    try {
      return operation();
    } catch (err) {
      if (!DatabaseManager.isCorruptionError(err)) {
        throw err;
      }
      this.recoverFromCorruption(err);
      return operation();
    }
  }

  /**
   * Close any open handle, rebuild/quarantine the DB file set, and let the next
   * getDb() reopen a clean database.
   */
  recoverFromCorruption(cause?: unknown): DatabaseRecoveryResult {
    this.close();
    let verifiedDb: DatabaseLike | null = null;
    let recovery: DatabaseRecoveryResult;
    try {
      recovery = this.recoverDatabaseFile(cause, () => {
        verifiedDb = this.openUnchecked();
      });
    } finally {
      if (verifiedDb) this.safeClose(verifiedDb);
    }
    this.lastRecovery = recovery;
    return recovery;
  }

  /**
   * Open the database and initialize schema.
   */
  private open(): DatabaseLike {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      return this.openUnchecked();
    } catch (err) {
      if (!DatabaseManager.isCorruptionError(err)) {
        throw err;
      }

      let recoveredDb: DatabaseLike | null = null;
      let recovery: DatabaseRecoveryResult;
      try {
        recovery = this.recoverDatabaseFile(err, () => {
          recoveredDb = this.openUnchecked();
        });
      } catch (error) {
        if (recoveredDb) this.safeClose(recoveredDb);
        throw error;
      }
      this.lastRecovery = recovery;
      if (!recoveredDb) throw new Error(`SQLite recovery verification did not open ${this.displayDbPath}`);
      return recoveredDb;
    }
  }

  private openUnchecked(): DatabaseLike {
    const existed = this.hasExistingMainDatabaseFile();
    const db = new Database(this.dbPath);
    let ok = false;

    try {
      if (existed) {
        this.assertIntegrityOk(db, 'quick_check', 'before schema initialization');
      }

      this.configureConnection(db);
      this.initializeSchema(db);
      this.assertIntegrityOk(db, 'quick_check', 'after schema initialization');
      ok = true;
      return db;
    } finally {
      if (!ok) {
        this.safeClose(db);
      }
    }
  }

  private configureConnection(db: DatabaseLike): void {
    // Wait briefly for concurrent writers across Pi processes instead of failing
    // immediately with SQLITE_BUSY. Connection-local; applies before WAL/schema.
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    // Enable WAL mode + FK enforcement for each connection. Keep SQLite's
    // default WAL autocheckpoint size; a very aggressive checkpoint cadence
    // increases the chance that abrupt VM/host shutdown catches a checkpoint.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}`);
    db.exec('PRAGMA journal_size_limit = 5242880');
    db.exec('PRAGMA foreign_keys = ON');
  }

  private initializeSchema(db: DatabaseLike): void {
    // Create tables and triggers
    try {
      db.exec(SCHEMA_SQL);
    } catch (err) {
      if (!this.isLegacySchemaError(err)) {
        throw err;
      }

      // Legacy DBs can be missing v0.6 failure-memory columns and/or the project
      // column on sessions/memories. Add missing columns, then retry schema.
      this.ensureLegacySchemaColumns(db);
      db.exec(SCHEMA_SQL);
    }

    // Extra safety: always ensure legacy columns exist, then migrate legacy
    // CHECK(target IN ('memory','user')) constraints to include 'failure'.
    this.ensureLegacySchemaColumns(db);
    this.migrateLegacyMemoriesTargetConstraint(db);
    this.rebuildMemoryFts(db);
  }

  private hasExistingMainDatabaseFile(): boolean {
    try {
      return fs.existsSync(this.dbPath) && fs.statSync(this.dbPath).size > 0;
    } catch {
      return false;
    }
  }

  private databaseFileSetExists(): boolean {
    return DATABASE_FILE_SUFFIXES.some((suffix) => fs.existsSync(`${this.dbPath}${suffix}`));
  }

  private assertIntegrityOk(
    db: DatabaseLike,
    check: 'quick_check' | 'integrity_check' = 'quick_check',
    context = '',
  ): void {
    const rows = db.prepare(`PRAGMA ${check}`).all() as Record<string, unknown>[];
    const messages = rows.map((row) => String(Object.values(row)[0] ?? ''));
    const failures = messages.filter((message) => message.toLowerCase() !== 'ok');

    if (rows.length === 0 || failures.length > 0) {
      const detail = failures.length > 0 ? failures.slice(0, 5).join('\n') : 'no result rows';
      const suffix = context ? ` ${context}` : '';
      throw new DatabaseCorruptionError(`SQLite ${check} failed${suffix}: ${detail}`);
    }
  }

  private assertForeignKeysOk(db: DatabaseLike): void {
    const rows = db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[];
    if (rows.length > 0) {
      throw new Error(`SQLite foreign_key_check failed after rebuild (${rows.length} violation${rows.length === 1 ? '' : 's'})`);
    }
  }

  private recoverDatabaseFile(cause: unknown, verify: () => void): DatabaseRecoveryResult {
    const coordinator = new AtomicLockCoordinator(path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite'));
    const lockKey = `recovery:${this.dbPath}`;
    const deadline = Date.now() + Math.max(0, this.recoveryOptions.recoveryLockWaitMs);

    while (true) {
      const lease = coordinator.tryAcquire(lockKey, { staleMs: this.recoveryOptions.recoveryLockStaleMs });
      if (!lease) {
        if (Date.now() >= deadline) {
          throw new Error(`SQLite recovery already in progress for ${this.displayDbPath}; timed out after ${this.recoveryOptions.recoveryLockWaitMs}ms`);
        }
        DatabaseManager.sleepSync(Math.min(
          this.recoveryOptions.recoveryLockPollMs,
          Math.max(1, deadline - Date.now()),
        ));
        continue;
      }

      this.activeRecoveryLease = { coordinator, key: lockKey, token: lease.token };
      try {
        if (this.currentDatabaseIsHealthy()) {
          try {
            verify();
            this.clearRecoveryFailuresBestEffort();
            return { strategy: 'reused', backupPaths: [] };
          } catch (error) {
            this.recordRecoveryFailure();
            throw error;
          }
        }

        this.assertRecoveryCircuitClosed();
        try {
          this.cleanupRecoveryArtifactsBestEffort();
          const result = this.recoverDatabaseFileUnlocked(cause);
          verify();
          this.cleanupRecoveryArtifactsBestEffort();
          this.clearRecoveryFailuresBestEffort();
          return result;
        } catch (error) {
          this.recordRecoveryFailure();
          throw error;
        }
      } finally {
        this.activeRecoveryLease = null;
        lease.release();
      }
    }
  }

  private recoverDatabaseFileUnlocked(cause?: unknown): DatabaseRecoveryResult {
    const backupBase = this.corruptBackupBase();
    let rebuildError: unknown;

    if (this.databaseFileSetExists()) {
      try {
        return this.rebuildDatabaseFromReadableRows(backupBase);
      } catch (err) {
        rebuildError = err;
      }
    }

    const moved = this.moveDatabaseFilesToBackup(backupBase);
    return {
      strategy: 'recreated-empty',
      backupPaths: moved.map((file) => file.backup),
      error: DatabaseManager.errorMessage(rebuildError ?? cause ?? 'unknown corruption'),
    };
  }

  private currentDatabaseIsHealthy(): boolean {
    if (!this.hasExistingMainDatabaseFile()) return false;
    let db: DatabaseLike | null = null;
    try {
      db = new Database(this.dbPath);
      this.assertIntegrityOk(db, 'quick_check', 'while joining corruption recovery');
      return true;
    } catch {
      return false;
    } finally {
      if (db) this.safeClose(db);
    }
  }

  private recoveryCircuitPath(): string {
    return `${this.dbPath}.recovery-state.json`;
  }

  private recentRecoveryFailures(): number[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recoveryCircuitPath(), 'utf-8')) as { failures?: unknown };
      if (!Array.isArray(parsed.failures)) return [];
      const cutoff = Date.now() - Math.max(0, this.recoveryOptions.recoveryCircuitWindowMs);
      return parsed.failures.filter((value): value is number => typeof value === 'number' && value >= cutoff);
    } catch {
      return [];
    }
  }

  private assertRecoveryCircuitClosed(): void {
    if (this.recentRecoveryFailures().length >= Math.max(1, this.recoveryOptions.recoveryCircuitLimit)) {
      throw new Error(
        `SQLite recovery circuit is open for ${this.displayDbPath}: too many failed recovery attempts within ${this.recoveryOptions.recoveryCircuitWindowMs}ms`,
      );
    }
  }

  private recordRecoveryFailure(): void {
    const statePath = this.recoveryCircuitPath();
    const tempPath = `${statePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    const failures = [...this.recentRecoveryFailures(), Date.now()];
    try {
      fs.writeFileSync(tempPath, JSON.stringify({ failures }), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tempPath, statePath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }

  private clearRecoveryFailures(): void {
    fs.rmSync(this.recoveryCircuitPath(), { force: true });
  }

  private clearRecoveryFailuresBestEffort(): void {
    try { this.clearRecoveryFailures(); } catch {}
  }

  private cleanupRecoveryArtifactsBestEffort(): void {
    try { this.cleanupRecoveryArtifacts(); } catch {}
  }

  private cleanupRecoveryArtifacts(): void {
    const dir = path.dirname(this.dbPath);
    const databaseName = path.basename(this.dbPath);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      if (name.startsWith(`${databaseName}.rebuild-`)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }

    const backupGroups = new Map<string, number>();
    for (const name of names) {
      if (!name.startsWith(`${databaseName}.corrupt-`)) continue;
      const group = name.replace(/-(?:wal|shm)$/, '');
      try {
        const mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
        backupGroups.set(group, Math.max(backupGroups.get(group) ?? 0, mtimeMs));
      } catch {
        // Artifact disappeared while scanning.
      }
    }

    const retained = Math.max(0, this.recoveryOptions.recoveryBackupRetention);
    const expired = [...backupGroups.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(retained);
    for (const [group] of expired) {
      for (const suffix of DATABASE_FILE_SUFFIXES) {
        fs.rmSync(path.join(dir, `${group}${suffix}`), { force: true });
      }
    }
  }

  private static sleepSync(milliseconds: number): void {
    if (milliseconds <= 0) return;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, milliseconds);
  }

  private rebuildDatabaseFromReadableRows(backupBase: string): DatabaseRecoveryResult {
    const tempPath = this.rebuildTempPath();
    this.removeDatabaseFileSet(tempPath);

    let source: DatabaseLike | null = null;
    let target: DatabaseLike | null = null;
    let recoveredRows: Record<string, number> | undefined;
    let rebuildOk = false;

    try {
      source = new Database(this.dbPath);
      target = new Database(tempPath);
      target.exec('PRAGMA journal_mode = DELETE');
      target.exec('PRAGMA foreign_keys = OFF');
      target.exec(SCHEMA_SQL);

      recoveredRows = this.copyRecoverableRows(source, target);
      this.rebuildFtsTables(target);
      this.assertForeignKeysOk(target);
      this.assertIntegrityOk(target, 'quick_check', 'after corruption rebuild');
      rebuildOk = true;
    } finally {
      if (source) this.safeClose(source);
      if (target) this.safeClose(target);
      if (!rebuildOk) this.removeDatabaseFileSet(tempPath);
    }

    const moved = this.swapRebuiltDatabase(tempPath, backupBase);
    this.removeDatabaseFileSet(tempPath);

    return {
      strategy: 'rebuilt',
      backupPaths: moved.map((file) => file.backup),
      recoveredRows,
    };
  }

  private copyRecoverableRows(source: DatabaseLike, target: DatabaseLike): Record<string, number> {
    return {
      extension_metadata: this.copyExtensionMetadata(source, target),
      sessions: this.copySessions(source, target),
      messages: this.copyMessages(source, target),
      session_files: this.copySessionFiles(source, target),
      memories: this.copyMemories(source, target),
    };
  }

  private copyExtensionMetadata(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare('INSERT OR REPLACE INTO extension_metadata (key, value) VALUES (?, ?)');
    let copied = 0;

    for (const row of this.readTableRows(source, 'extension_metadata', ['key', 'value'])) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string') continue;
      insert.run(row.key, row.value);
      copied++;
    }

    return copied;
  }

  private copySessions(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO sessions (id, project, cwd, started_at, ended_at, message_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'sessions', ['id', 'project', 'cwd', 'started_at', 'ended_at', 'message_count'])) {
      if (typeof row.id !== 'string' || typeof row.cwd !== 'string' || typeof row.started_at !== 'string') continue;
      const project = typeof row.project === 'string' && row.project ? row.project : (path.basename(row.cwd) || 'unknown');
      insert.run(
        row.id,
        project,
        row.cwd,
        row.started_at,
        this.nullableString(row.ended_at),
        this.integerOr(row.message_count, 0),
      );
      copied++;
    }

    return copied;
  }

  private copyMessages(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp, tool_calls)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'messages', ['id', 'session_id', 'role', 'content', 'timestamp', 'tool_calls'])) {
      if (
        typeof row.id !== 'string'
        || typeof row.session_id !== 'string'
        || (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system')
        || typeof row.content !== 'string'
        || typeof row.timestamp !== 'string'
      ) {
        continue;
      }

      insert.run(row.id, row.session_id, row.role, row.content, row.timestamp, this.nullableString(row.tool_calls));
      copied++;
    }

    return copied;
  }

  private copySessionFiles(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO session_files (path, session_id, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'session_files', ['path', 'session_id', 'size', 'mtime_ms', 'indexed_at'])) {
      if (typeof row.path !== 'string' || typeof row.session_id !== 'string') continue;
      insert.run(
        row.path,
        row.session_id,
        this.integerOr(row.size, 0),
        this.integerOr(row.mtime_ms, 0),
        typeof row.indexed_at === 'string' ? row.indexed_at : new Date(0).toISOString(),
      );
      copied++;
    }

    return copied;
  }

  private copyMemories(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO memories (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'memories', [
      'id',
      'project',
      'target',
      'category',
      'content',
      'failure_reason',
      'tool_state',
      'corrected_to',
      'created',
      'last_referenced',
    ])) {
      const id = this.integerOr(row.id, NaN);
      if (!Number.isFinite(id) || typeof row.content !== 'string') continue;

      const targetName = typeof row.target === 'string' && MEMORY_TARGETS.has(row.target) ? row.target : 'memory';
      const category = typeof row.category === 'string' && MEMORY_CATEGORIES.has(row.category) ? row.category : null;
      const created = typeof row.created === 'string' ? row.created : new Date(0).toISOString();
      const lastReferenced = typeof row.last_referenced === 'string' ? row.last_referenced : created;

      insert.run(
        id,
        this.nullableString(row.project),
        targetName,
        category,
        row.content,
        this.nullableString(row.failure_reason),
        this.nullableString(row.tool_state),
        this.nullableString(row.corrected_to),
        created,
        lastReferenced,
      );
      copied++;
    }

    return copied;
  }

  private readTableRows(source: DatabaseLike, table: string, desiredColumns: string[]): Iterable<Record<string, unknown>> {
    const columns = this.getColumnNames(source, table);
    const selected = desiredColumns.filter((column) => columns.has(column));
    if (selected.length === 0) return [];

    const sql = `SELECT ${selected.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} NOT INDEXED`;
    const statement = source.prepare(sql);
    if (statement.iterate) {
      return statement.iterate() as Iterable<Record<string, unknown>>;
    }
    return statement.all() as Record<string, unknown>[];
  }

  private getColumnNames(db: DatabaseLike, table: string): Set<string> {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name?: unknown }[];
    return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'));
  }

  private nullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private integerOr(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  private rebuildFtsTables(db: DatabaseLike): void {
    db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')");
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }

  private corruptBackupBase(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const nonce = Math.random().toString(16).slice(2, 8);
    return `${this.dbPath}.corrupt-${stamp}-${process.pid}-${nonce}`;
  }

  private rebuildTempPath(): string {
    const stamp = Date.now();
    const nonce = Math.random().toString(16).slice(2, 8);
    return `${this.dbPath}.rebuild-${process.pid}-${stamp}-${nonce}.tmp`;
  }

  private swapRebuiltDatabase(tempPath: string, backupBase: string): MovedDatabaseFile[] {
    const moved = this.moveDatabaseFilesToBackup(backupBase);
    try {
      fs.renameSync(tempPath, this.dbPath);
      return moved;
    } catch (err) {
      this.restoreMovedDatabaseFiles(moved);
      this.removeDatabaseFileSet(tempPath);
      throw err;
    }
  }

  private moveDatabaseFilesToBackup(backupBase: string): MovedDatabaseFile[] {
    this.assertStillRecoveryOwner();
    const moved: MovedDatabaseFile[] = [];
    for (const suffix of DATABASE_FILE_SUFFIXES) {
      const original = `${this.dbPath}${suffix}`;
      if (!fs.existsSync(original)) continue;

      const backup = `${backupBase}${suffix}`;
      fs.rmSync(backup, { force: true });
      fs.renameSync(original, backup);
      moved.push({ original, backup });
    }
    return moved;
  }

  /**
   * Verifies this instance still holds the recovery lease immediately before
   * a destructive rename that has no independent compare-and-swap of its
   * own (unlike the Markdown mutation path, which re-checks a content
   * fingerprint at publish time). If the lease was reclaimed as stale while
   * this call was in flight, abort rather than race the new owner.
   */
  private assertStillRecoveryOwner(): void {
    const active = this.activeRecoveryLease;
    if (!active) return;
    if (!active.coordinator.isCurrentOwner(active.key, active.token)) {
      throw new Error(`SQLite recovery lease lost for ${this.displayDbPath}; another process took over`);
    }
  }

  private restoreMovedDatabaseFiles(moved: MovedDatabaseFile[]): void {
    for (const file of [...moved].reverse()) {
      try {
        if (!fs.existsSync(file.backup)) continue;
        fs.rmSync(file.original, { force: true });
        fs.renameSync(file.backup, file.original);
      } catch {
        // Best effort. The backup path remains available if restoration fails.
      }
    }
  }

  private removeDatabaseFileSet(basePath: string): void {
    for (const suffix of DATABASE_FILE_SUFFIXES) {
      fs.rmSync(`${basePath}${suffix}`, { force: true });
    }
  }

  private safeClose(db: DatabaseLike): void {
    try { db.close(); } catch { /* best effort */ }
  }

  private isLegacySchemaError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('no such column: category')
      || msg.includes('memories(category)')
      || msg.includes('no such column: project')
      || msg.includes('sessions(project)')
      || msg.includes('memories(project)');
  }

  private ensureLegacySchemaColumns(db: DatabaseLike): void {
    this.ensureMemoriesColumns(db);
    this.ensureSessionsColumns(db);
  }

  private ensureMemoriesColumns(db: DatabaseLike): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const names = this.getColumnNames(db, 'memories');

    if (!names.has('project')) {
      db.exec('ALTER TABLE memories ADD COLUMN project TEXT');
    }
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

  private ensureSessionsColumns(db: DatabaseLike): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const names = this.getColumnNames(db, 'sessions');
    if (!names.has('project')) {
      db.exec('ALTER TABLE sessions ADD COLUMN project TEXT');
    }

    this.backfillSessionsProject(db);
  }

  private backfillSessionsProject(db: DatabaseLike): void {
    const names = this.getColumnNames(db, 'sessions');
    if (!names.has('project') || !names.has('cwd') || !names.has('id')) return;

    const rows = db.prepare('SELECT id, cwd, project FROM sessions').all() as Array<{
      id?: unknown;
      cwd?: unknown;
      project?: unknown;
    }>;
    const update = db.prepare('UPDATE sessions SET project = ? WHERE id = ?');

    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      if (typeof row.project === 'string' && row.project.trim()) continue;

      const project = typeof row.cwd === 'string' && row.cwd.trim()
        ? (path.basename(row.cwd) || 'unknown')
        : 'unknown';
      update.run(project, row.id);
    }
  }

  private migrateLegacyMemoriesTargetConstraint(db: DatabaseLike): void {
    const tableSqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql ?? '';
    if (!tableSql) return;

    // Legacy schema allowed only memory/user. New schema must allow failure too.
    const hasLegacyTargetCheck = /target\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*target\s+IN\s*\(\s*'memory'\s*,\s*'user'\s*\)\s*\)/i.test(tableSql);
    if (!hasLegacyTargetCheck) return;

    if (!db.transaction) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(`
          CREATE TABLE memories_new (
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
        `);

        db.exec(`
          INSERT INTO memories_new (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          SELECT id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced
          FROM memories;
        `);

        db.exec('DROP TABLE memories');
        db.exec('ALTER TABLE memories_new RENAME TO memories');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
      return;
    }

    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE memories_new (
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
      `);

      db.exec(`
          INSERT INTO memories_new (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          SELECT id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced
          FROM memories;
        `);

      db.exec('DROP TABLE memories');
      db.exec('ALTER TABLE memories_new RENAME TO memories');
    });

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private rebuildMemoryFts(db: DatabaseLike): void {
    const ftsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get() as { name?: string } | undefined;
    if (!ftsTable) return;

    // Keep FTS index consistent after table rebuild/migrations.
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      try { this.db.close(); } catch { /* best effort — close may throw on a corrupt handle */ }
      this.db = null;
    }
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.displayDbPath;
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
