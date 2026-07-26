import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { isBunRuntime, loadBetterSqlite3 } from './sqlite-native.js';

type StatementLike = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;

export interface AtomicLockOptions {
  staleMs: number;
}

export interface AtomicLockLease {
  token: string;
  release: () => void;
}

export interface AtomicLockCoordinatorOptions {
  pid?: number;
  incarnation?: string;
  probeIncarnation?: (pid: number) => string | null;
}

let cachedDatabaseCtor: DatabaseCtor | null = null;

/**
 * Resolved on first use, never at import time — see the same note in db.ts.
 * Compiled Pi cannot resolve better-sqlite3 at all, so Bun must take bun:sqlite.
 */
function getDatabaseCtor(): DatabaseCtor {
  if (!cachedDatabaseCtor) {
    const require = createRequire(import.meta.url);
    if (isBunRuntime()) {
      const bunSqlite = require('bun:sqlite') as { Database: DatabaseCtor };
      cachedDatabaseCtor = bunSqlite.Database;
    } else {
      cachedDatabaseCtor = loadBetterSqlite3({ requireImpl: require }) as DatabaseCtor;
    }
  }
  return cachedDatabaseCtor;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function probeProcessIncarnation(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      return fields[19] || null;
    } catch {
      return null;
    }
  }

  if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 250,
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`],
    { encoding: 'utf-8', timeout: 500 },
  );
  return result.status === 0 ? result.stdout.trim() || null : null;
}

const currentProcessIncarnation = probeProcessIncarnation(process.pid);
const RELEASE_ATTEMPTS = 3;
const pendingReleases = new Map<string, () => void>();
const sharedCoordinators = new Map<string, AtomicLockCoordinator>();

export class AtomicLockCoordinator {
  private readonly pid: number;
  private readonly incarnation: string | null;
  private readonly probeIncarnation: (pid: number) => string | null;
  private cachedDb: DatabaseLike | null = null;

  constructor(private readonly dbPath: string, options: AtomicLockCoordinatorOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.probeIncarnation = options.probeIncarnation
      ?? ((pid) => pid === process.pid ? currentProcessIncarnation : probeProcessIncarnation(pid));
    this.incarnation = options.incarnation
      ?? this.probeIncarnation(this.pid)
      ?? null;
  }

  tryAcquire(key: string, options: AtomicLockOptions): AtomicLockLease | null {
    this.retryPendingReleases(key);
    const token = randomUUID();
    const now = Date.now();
    const db = this.open();
    let acquired = false;

    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = db.prepare(`
          SELECT token, pid, incarnation, acquired_at
          FROM locks
          WHERE lock_key = ?
        `).get(key) as { token: string; pid: number; incarnation: string | null; acquired_at: number } | undefined;

        if (!owner) {
          db.prepare(`
            INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(key, token, this.pid, this.incarnation, now);
          acquired = true;
        } else {
          const observedIncarnation = this.probeIncarnation(owner.pid);
          const alive = observedIncarnation !== null || processIsAlive(owner.pid);
          const sameIncarnation = alive
            && owner.incarnation !== null
            && observedIncarnation !== null
            && owner.incarnation === observedIncarnation;
          const unknownIncarnation = alive && (owner.incarnation === null || observedIncarnation === null);
          // A lease is reclaimable once it has been held for longer than staleMs,
          // regardless of whether the owning process is still alive — it may be
          // making no progress (blocked I/O, wedged, suspended) rather than dead.
          // This is the sole backstop for that case: liveness/incarnation checks
          // alone cannot distinguish "alive and working" from "alive and stuck".
          // staleMs <= 0 disables time-based takeover (liveness checks only).
          const stale = options.staleMs > 0 && now - owner.acquired_at >= options.staleMs;
          if (stale || (!sameIncarnation && !unknownIncarnation)) {
            db.prepare(`
              UPDATE locks
              SET token = ?, pid = ?, incarnation = ?, acquired_at = ?
              WHERE lock_key = ? AND token = ?
            `).run(token, this.pid, this.incarnation, now, key, owner.token);
            acquired = true;
          }
        }

        db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction is still open on a connection we are about to hand
        // to the next caller, whose BEGIN IMMEDIATE would then fail forever.
        // Drop the handle so open() rebuilds it.
        this.discardCachedDb();
      }
      throw error;
    }

    if (!acquired) return null;
    return {
      token,
      release: () => this.release(key, token),
    };
  }

  /**
   * Fencing check for destructive operations that lack their own independent
   * compare-and-swap (e.g. a plain fs.renameSync with no content/inode
   * verification). A lease can be legitimately stolen from a stale-but-alive
   * holder (see tryAcquire); a holder resuming after being stuck must verify
   * it is still the current owner immediately before publishing, or abort.
   * This narrows — it cannot fully close — the check-then-act race, since
   * synchronous work between this call and the actual write is not atomic
   * with it.
   */
  isCurrentOwner(key: string, token: string): boolean {
    const db = this.open();
    const row = db.prepare('SELECT token FROM locks WHERE lock_key = ?').get(key) as { token: string } | undefined;
    return row?.token === token;
  }

  release(key: string, token: string): void {
    const pendingKey = this.pendingReleaseKey(key, token);
    for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
      try {
        this.deleteOwnedLock(key, token);
        pendingReleases.delete(pendingKey);
        return;
      } catch {
      }
    }
    pendingReleases.set(pendingKey, () => this.release(key, token));
  }

  private deleteOwnedLock(key: string, token: string): void {
    const db = this.open();
    db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(key, token);
  }

  private retryPendingReleases(key: string): void {
    const prefix = `${path.resolve(this.dbPath)}\0${key}\0`;
    for (const [pendingKey, release] of [...pendingReleases.entries()]) {
      if (pendingKey.startsWith(prefix)) release();
    }
  }

  private pendingReleaseKey(key: string, token: string): string {
    return `${path.resolve(this.dbPath)}\0${key}\0${token}`;
  }

  private discardCachedDb(): void {
    const db = this.cachedDb;
    this.cachedDb = null;
    if (db) {
      try { db.close(); } catch {}
    }
  }

  private open(): DatabaseLike {
    if (this.cachedDb) return this.cachedDb;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const existed = fs.existsSync(this.dbPath);
    const db = new (getDatabaseCtor())(this.dbPath);
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS locks (
          lock_key TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          pid INTEGER NOT NULL,
          incarnation TEXT,
          acquired_at INTEGER NOT NULL
        );
      `);
      const columns = db.prepare('PRAGMA table_info(locks)').all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === 'incarnation')) {
        try {
          db.exec('ALTER TABLE locks ADD COLUMN incarnation TEXT');
        } catch (error) {
          const refreshed = db.prepare('PRAGMA table_info(locks)').all() as Array<{ name: string }>;
          if (!refreshed.some(({ name }) => name === 'incarnation')) throw error;
        }
      }
      if (!existed) fs.chmodSync(this.dbPath, 0o600);
      this.cachedDb = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * Process-wide coordinator for `dbPath`.
   *
   * Each instance now pins its SQLite connection for its own lifetime, so a
   * caller that constructs a fresh coordinator per operation would leak one
   * open WAL connection per call. Every default-options caller must share.
   * The option-carrying constructor stays public for tests, which pass a
   * synthetic pid/incarnation that a dbPath-keyed cache would silently ignore.
   */
  static shared(dbPath: string): AtomicLockCoordinator {
    const key = path.resolve(dbPath);
    let coordinator = sharedCoordinators.get(key);
    if (!coordinator) {
      coordinator = new AtomicLockCoordinator(dbPath);
      sharedCoordinators.set(key, coordinator);
    }
    return coordinator;
  }
}
