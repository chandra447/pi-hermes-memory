import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { AtomicLockCoordinator, type AtomicLockLease } from "./store/atomic-lock-coordinator.js";
import { canonicalStoragePathSync } from "./store/canonical-storage-path.js";

const DATABASE_FILES = ["sessions.db", "sessions.db-wal", "sessions.db-shm"] as const;
const DATABASE_MIGRATION_PENDING_FILE = ".sessions-db-migration-pending";

export interface ExtensionRootMigrationResult {
  moved: number;
  merged: number;
  skipped: number;
  warnings: string[];
  criticalFailures: Array<{
    name: string;
    source: string;
    target: string;
    message: string;
  }>;
}

export interface ExtensionRootMigrationOptions {
  moveFile?: (source: string, target: string) => Promise<void>;
  publishDatabaseFile?: (source: string, target: string) => Promise<void>;
  retireDatabaseFile?: (source: string, target: string) => Promise<void>;
  backupDatabase?: (source: string, staged: string, onProgress?: () => void) => Promise<void>;
  onDatabaseBackupProgress?: () => void;
}

const MIGRATION_LOCK_WAIT_MS = 5000;
const MIGRATION_LOCK_POLL_MS = 50;

export function isDatabaseMigrationPending(legacyRoot: string, targetRoot: string): boolean {
  return existsSync(path.join(targetRoot, DATABASE_MIGRATION_PENDING_FILE))
    || (existsSync(path.join(legacyRoot, "sessions.db")) && !existsSync(path.join(targetRoot, "sessions.db")));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function databaseFilesAt(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const name of DATABASE_FILES) {
    if (await pathEntryExists(path.join(root, name))) names.push(name);
  }
  return names;
}

async function moveFileSafe(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });

  try {
    await fs.rename(source, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EXDEV") throw error;
  }

  await fs.copyFile(source, target);
  await fs.unlink(source);
}

async function stageDatabaseSnapshot(
  source: string,
  staged: string,
  onProgress?: () => void,
): Promise<void> {
  const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(staged, {
      progress: () => {
        onProgress?.();
        return 64;
      },
    });
  } finally {
    sourceDb.close();
  }

  const stagedDb = new Database(staged, { readonly: true, fileMustExist: true });
  try {
    const check = stagedDb.pragma("integrity_check", { simple: true });
    if (check !== "ok") throw new Error(`staged SQLite snapshot failed integrity_check: ${String(check)}`);
  } finally {
    stagedDb.close();
  }
}

function isDatabaseCorruption(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("database disk image is malformed")
    || message.includes("file is not a database")
    || message.includes("database schema is corrupt")
    || message.includes("malformed database schema")
    || message.includes("failed integrity_check");
}

async function acquireMigrationLease(legacyRoot: string, targetRoot: string): Promise<AtomicLockLease> {
  const coordinator = new AtomicLockCoordinator(path.join(targetRoot, ".pi-hermes-locks.sqlite"));
  const sourceIdentity = canonicalStoragePathSync(path.join(legacyRoot, "sessions.db"));
  const targetIdentity = canonicalStoragePathSync(path.join(targetRoot, "sessions.db"));
  const key = `extension-root-migration:${sourceIdentity}:${targetIdentity}`;
  const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS;

  while (true) {
    const lease = coordinator.tryAcquire(key, { staleMs: 300_000 });
    if (lease) return lease;
    if (Date.now() >= deadline) {
      throw new Error(`SQLite extension-root migration already in progress for ${targetIdentity}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_MS));
  }
}

class DatabaseGenerationMoveError extends Error {
  constructor(message: string, readonly moved: string[], options: { cause: unknown }) {
    super(message, options);
  }
}

async function moveDatabaseGeneration(
  names: string[],
  sourceRoot: string,
  holdingRoot: string,
  move: (source: string, target: string) => Promise<void>,
): Promise<string[]> {
  const moved: string[] = [];
  await fs.mkdir(holdingRoot, { mode: 0o700 });
  const orderedNames = [...names].sort((left, right) => Number(left === "sessions.db") - Number(right === "sessions.db"));
  try {
    for (const name of orderedNames) {
      const source = path.join(sourceRoot, name);
      const target = path.join(holdingRoot, name);
      try {
        await move(source, target);
        moved.push(name);
      } catch (error) {
        if (await pathEntryExists(target)) moved.push(name);
        throw error;
      }
    }
    return moved;
  } catch (error) {
    throw new DatabaseGenerationMoveError(
      error instanceof Error ? error.message : String(error),
      moved,
      { cause: error },
    );
  }
}

async function restoreDatabaseGeneration(names: string[], holdingRoot: string, sourceRoot: string): Promise<string[]> {
  const failures: string[] = [];
  for (const name of [...names].reverse()) {
    const held = path.join(holdingRoot, name);
    if (!await pathEntryExists(held)) continue;
    try {
      await fs.link(held, path.join(sourceRoot, name));
      await fs.unlink(held);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const stat = await fs.lstat(filePath);
  return { dev: stat.dev, ino: stat.ino };
}

async function unlinkIfOwned(filePath: string, identity: FileIdentity): Promise<void> {
  try {
    const current = await fileIdentity(filePath);
    if (current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function stageDatabaseSymlink(source: string, staged: string): Promise<void> {
  const before = await fs.readlink(source);
  await fs.symlink(path.resolve(path.dirname(source), before), staged);
  const after = await fs.readlink(source);
  if (before !== after) throw new Error("sessions.db symlink changed while staging");
}

async function moveDirContents(
  sourceDir: string,
  targetDir: string,
  result: ExtensionRootMigrationResult,
  moveFile: (source: string, target: string) => Promise<void>,
  relativeDir = "",
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!relativeDir && DATABASE_FILES.includes(entry.name as typeof DATABASE_FILES[number])) {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (!await pathExists(targetPath)) {
      try {
        await moveFile(sourcePath, targetPath);
        result.moved++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.warnings.push(`${sourcePath}: ${message}`);
      }
      continue;
    }

    if (entry.isDirectory()) {
      await moveDirContents(
        sourcePath,
        targetPath,
        result,
        moveFile,
        path.join(relativeDir, entry.name),
      );
      result.merged++;
      try {
        const remaining = await fs.readdir(sourcePath);
        if (remaining.length === 0) await fs.rmdir(sourcePath);
      } catch {
        // best effort
      }
      continue;
    }

    result.skipped++;
  }
}

async function publishDatabaseFile(source: string, target: string): Promise<void> {
  if ((await fs.lstat(source)).isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), target);
    return;
  }
  await fs.link(source, target);
}

async function migrateDatabaseGeneration(
  legacyRoot: string,
  targetRoot: string,
  result: ExtensionRootMigrationResult,
  publish: (source: string, target: string) => Promise<void>,
  retire: (source: string, target: string) => Promise<void>,
  backup: (source: string, staged: string, onProgress?: () => void) => Promise<void>,
  onBackupProgress?: () => void,
): Promise<void> {
  let lease: AtomicLockLease | null = null;
  try {
    lease = await acquireMigrationLease(legacyRoot, targetRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push(`${path.join(legacyRoot, "sessions.db")}: ${message}`);
    result.criticalFailures.push({
      name: "sessions.db",
      source: path.join(legacyRoot, "sessions.db"),
      target: path.join(targetRoot, "sessions.db"),
      message,
    });
    return;
  }

  try {
  const pendingMarker = path.join(targetRoot, DATABASE_MIGRATION_PENDING_FILE);
  const hadPendingMarker = await pathEntryExists(pendingMarker);
  const sourceNames = await databaseFilesAt(legacyRoot);
  const targetNames = await databaseFilesAt(targetRoot);
  if (sourceNames.length === 0) {
    if (!hadPendingMarker) return;
    if (targetNames.includes("sessions.db")) {
      await fs.unlink(pendingMarker);
      return;
    }
    const retirementDirs = (await fs.readdir(legacyRoot))
      .filter((name) => name.startsWith(".sessions-db-retirement-"));
    const message = retirementDirs.length > 0
      ? `an interrupted migration preserved recovery artifacts at ${retirementDirs.map((name) => path.join(legacyRoot, name)).join(", ")}`
      : "an interrupted migration has no complete source or destination SQLite generation";
    result.warnings.push(`${path.join(legacyRoot, "sessions.db")}: ${message}`);
    result.criticalFailures.push({
      name: "sessions.db",
      source: path.join(legacyRoot, "sessions.db"),
      target: path.join(targetRoot, "sessions.db"),
      message,
    });
    return;
  }

  if (targetNames.includes("sessions.db")) {
    if (hadPendingMarker) {
      const message = "an incomplete migration left both legacy and destination SQLite generations; manual recovery is required";
      result.warnings.push(`${path.join(legacyRoot, "sessions.db")}: ${message}`);
      result.criticalFailures.push({
        name: "sessions.db",
        source: path.join(legacyRoot, "sessions.db"),
        target: path.join(targetRoot, "sessions.db"),
        message,
      });
      return;
    }
    result.skipped += sourceNames.length;
    return;
  }

  if (!sourceNames.includes("sessions.db") || targetNames.length > 0) {
    const message = targetNames.length > 0
      ? `destination contains a partial SQLite generation: ${targetNames.join(", ")}`
      : "legacy SQLite sidecars exist without sessions.db";
    result.warnings.push(`${path.join(legacyRoot, "sessions.db")}: ${message}`);
    result.criticalFailures.push({
      name: "sessions.db",
      source: path.join(legacyRoot, "sessions.db"),
      target: path.join(targetRoot, "sessions.db"),
      message,
    });
    return;
  }

  await fs.mkdir(targetRoot, { recursive: true });
  const stagingDir = path.join(targetRoot, `.sessions-db-migration-${randomUUID()}`);
  const retirementDir = path.join(legacyRoot, `.sessions-db-retirement-${randomUUID()}`);
  const published = new Map<string, FileIdentity>();
  let retired: string[] = [];
  let preserveRetirement = false;
  let keepPendingMarker = false;
  let writeLock: {
    pragma: (query: string) => unknown;
    exec: (sql: string) => void;
    close: () => void;
  } | null = null;
  let corruptGeneration = false;
  let generationNames = sourceNames;
  try {
    await fs.writeFile(pendingMarker, `${process.pid}:${randomUUID()}\n`, { mode: 0o600 });
    await fs.mkdir(stagingDir, { mode: 0o700 });
    const source = path.join(legacyRoot, "sessions.db");
    const staged = path.join(stagingDir, "sessions.db");
    const sourceState = await fs.lstat(source);
    try {
      writeLock = new Database(source, { fileMustExist: true, timeout: 0 });
      writeLock.pragma("busy_timeout = 0");
      writeLock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!isDatabaseCorruption(error)) throw error;
      if (writeLock) {
        try { writeLock.close(); } catch {}
        writeLock = null;
      }
      corruptGeneration = true;
    }
    generationNames = await databaseFilesAt(legacyRoot);

    if (sourceState.isSymbolicLink()) {
      if (sourceNames.length !== 1) {
        throw new Error("symlinked sessions.db cannot be combined with legacy SQLite sidecars");
      }
      await stageDatabaseSymlink(source, staged);
      corruptGeneration = false;
    } else if (sourceState.isFile()) {
      if (!corruptGeneration) {
        try {
          await backup(source, staged, onBackupProgress);
        } catch (error) {
          if (!isDatabaseCorruption(error)) throw error;
          corruptGeneration = true;
          try { await fs.unlink(staged); } catch {}
        }
      }
      if (corruptGeneration) {
        try {
          retired = await moveDatabaseGeneration(generationNames, legacyRoot, retirementDir, retire);
        } catch (error) {
          if (error instanceof DatabaseGenerationMoveError) retired = error.moved;
          throw error;
        }
        for (const name of retired) {
          const target = path.join(targetRoot, name);
          await publish(path.join(retirementDir, name), target);
          published.set(target, await fileIdentity(target));
        }
      }
    } else {
      throw new Error("sessions.db is not a regular file or symlink");
    }

    if (!corruptGeneration) {
      try {
        retired = await moveDatabaseGeneration(generationNames, legacyRoot, retirementDir, retire);
      } catch (error) {
        if (error instanceof DatabaseGenerationMoveError) retired = error.moved;
        throw error;
      }
      const target = path.join(targetRoot, "sessions.db");
      await publish(staged, target);
      published.set(target, await fileIdentity(target));
    }

    if (writeLock) writeLock.exec("COMMIT");
    result.moved += generationNames.length;
  } catch (error) {
    for (const [target, identity] of [...published.entries()].reverse()) {
      try { await unlinkIfOwned(target, identity); } catch {}
    }
    let restoreFailures: string[] = [];
    if (retired.length > 0) {
      restoreFailures = await restoreDatabaseGeneration(retired, retirementDir, legacyRoot);
      preserveRetirement = restoreFailures.length > 0;
      keepPendingMarker = preserveRetirement;
    }
    const destinationPreserved = await pathEntryExists(path.join(targetRoot, "sessions.db"));
    if (destinationPreserved) keepPendingMarker = true;
    if (writeLock) {
      try { writeLock.exec("ROLLBACK"); } catch {}
    }
    const baseMessage = error instanceof Error ? error.message : String(error);
    let message = restoreFailures.length > 0
      ? `${baseMessage}; recovery artifacts preserved at ${retirementDir} (${restoreFailures.join("; ")})`
      : baseMessage;
    if (destinationPreserved) {
      message += `; an unowned destination generation was preserved at ${path.join(targetRoot, "sessions.db")}`;
    }
    result.warnings.push(`${path.join(legacyRoot, "sessions.db")}: ${message}`);
    result.criticalFailures.push({
      name: "sessions.db",
      source: path.join(legacyRoot, "sessions.db"),
      target: path.join(targetRoot, "sessions.db"),
      message,
    });
  } finally {
    if (writeLock) {
      try { writeLock.close(); } catch {}
    }
    try { await fs.rm(stagingDir, { recursive: true, force: true }); } catch {}
    if (!preserveRetirement) {
      try { await fs.rm(retirementDir, { recursive: true, force: true }); } catch {}
    }
    if (!keepPendingMarker) {
      try { await fs.unlink(pendingMarker); } catch {}
    }
  }
  } finally {
    lease.release();
  }
}

/**
 * Move legacy extension assets from ~/.pi/agent/memory into
 * ~/.pi/agent/pi-hermes-memory. Existing destination files win.
 */
export async function migrateExtensionRoot(
  legacyRoot: string,
  targetRoot: string,
  options: ExtensionRootMigrationOptions = {},
): Promise<ExtensionRootMigrationResult> {
  const result: ExtensionRootMigrationResult = {
    moved: 0,
    merged: 0,
    skipped: 0,
    warnings: [],
    criticalFailures: [],
  };

  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) return result;
  if (!existsSync(legacyRoot)) return result;

  await fs.mkdir(targetRoot, { recursive: true });
  await migrateDatabaseGeneration(
    legacyRoot,
    targetRoot,
    result,
    options.publishDatabaseFile ?? options.moveFile ?? publishDatabaseFile,
    options.retireDatabaseFile ?? moveFileSafe,
    options.backupDatabase ?? stageDatabaseSnapshot,
    options.onDatabaseBackupProgress,
  );
  if (result.criticalFailures.some((failure) => failure.name === "sessions.db")) return result;
  await moveDirContents(legacyRoot, targetRoot, result, options.moveFile ?? moveFileSafe);

  try {
    const remaining = await fs.readdir(legacyRoot);
    if (remaining.length === 0) {
      await fs.rmdir(legacyRoot);
    }
  } catch {
    // best effort
  }

  return result;
}
