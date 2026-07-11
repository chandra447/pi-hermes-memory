import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  isDatabaseMigrationPending,
  migrateExtensionRoot,
} from "../src/extension-root-migration.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-root-migration-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrateExtensionRoot", () => {
  it("moves legacy files into new extension root", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(path.join(legacy, "skills", "abc"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "MEMORY.md"), "legacy memory", "utf-8");
    fs.writeFileSync(path.join(legacy, "skills", "abc", "SKILL.md"), "legacy skill", "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.ok(fs.existsSync(path.join(target, "MEMORY.md")));
    assert.ok(fs.existsSync(path.join(target, "skills", "abc", "SKILL.md")));
    assert.strictEqual(result.warnings.length, 0);
    assert.ok(result.moved >= 1);
  });

  it("does not overwrite existing target files", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });

    fs.writeFileSync(path.join(legacy, "MEMORY.md"), "legacy memory", "utf-8");
    fs.writeFileSync(path.join(target, "MEMORY.md"), "new memory", "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.strictEqual(fs.readFileSync(path.join(target, "MEMORY.md"), "utf-8"), "new memory");
    assert.ok(result.skipped >= 1);
  });

  it("reports a failed sessions database move as critical", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();

    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async () => {
        throw new Error("injected sessions.db move failure");
      },
    });

    assert.deepStrictEqual(
      result.criticalFailures.map((failure) => failure.name),
      ["sessions.db"],
    );
    assert.equal(fs.existsSync(path.join(target, "sessions.db")), false);
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), true);
  });

  it("publishes the complete SQLite generation and removes the legacy set", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    try {
      sourceDb.pragma("journal_mode = WAL");
      sourceDb.pragma("wal_autocheckpoint = 0");
      sourceDb.exec("CREATE TABLE memories (content TEXT)");
      sourceDb.pragma("wal_checkpoint(TRUNCATE)");
      sourceDb.prepare("INSERT INTO memories VALUES (?)").run("committed only in WAL");
      assert.equal(fs.existsSync(path.join(legacy, "sessions.db-wal")), true);

      const result = await migrateExtensionRoot(legacy, target);

      assert.deepStrictEqual(result.criticalFailures, []);
      const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
      try {
        assert.equal(
          (migrated.prepare("SELECT content FROM memories").get() as { content: string }).content,
          "committed only in WAL",
        );
      } finally {
        migrated.close();
      }
      for (const name of ["sessions.db", "sessions.db-wal", "sessions.db-shm"]) {
        assert.equal(fs.existsSync(path.join(legacy, name)), false);
      }
    } finally {
      sourceDb.close();
    }
  });

  it("migrates one SQLite snapshot while a checkpoint runs", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    let checkpointTriggered = false;
    try {
      sourceDb.pragma("journal_mode = WAL");
      sourceDb.pragma("wal_autocheckpoint = 0");
      sourceDb.pragma("busy_timeout = 0");
      sourceDb.exec("CREATE TABLE memories (content TEXT)");
      sourceDb.pragma("wal_checkpoint(TRUNCATE)");
      const insert = sourceDb.prepare("INSERT INTO memories VALUES (?)");
      const insertMany = sourceDb.transaction(() => {
        for (let index = 0; index < 500; index++) insert.run(`committed-${index}-${"x".repeat(1024)}`);
      });
      insertMany();

      const result = await migrateExtensionRoot(legacy, target, {
        onDatabaseBackupProgress: () => {
          if (checkpointTriggered) return;
          checkpointTriggered = true;
          sourceDb.pragma("wal_checkpoint(TRUNCATE)");
        },
      });

      assert.equal(checkpointTriggered, true);
      assert.deepStrictEqual(result.criticalFailures, []);
      assert.equal(fs.existsSync(path.join(target, "sessions.db-wal")), false);
      assert.equal(fs.existsSync(path.join(target, "sessions.db-shm")), false);
      const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
      try {
        assert.equal(
          (migrated.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number }).count,
          500,
        );
        assert.deepStrictEqual(migrated.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      } finally {
        migrated.close();
      }
    } finally {
      sourceDb.close();
    }
  });

  it("holds a write exclusion through snapshot publication and source retirement", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    let concurrentWriteCode = "";
    try {
      sourceDb.pragma("journal_mode = WAL");
      sourceDb.pragma("busy_timeout = 0");
      sourceDb.exec("CREATE TABLE memories (content TEXT); INSERT INTO memories VALUES ('before migration')");

      const result = await migrateExtensionRoot(legacy, target, {
        onDatabaseBackupProgress: () => {
          if (concurrentWriteCode) return;
          try {
            sourceDb.prepare("INSERT INTO memories VALUES (?)").run("raced migration");
          } catch (error) {
            concurrentWriteCode = (error as { code?: string }).code ?? "unknown";
          }
        },
      });

      assert.equal(concurrentWriteCode, "SQLITE_BUSY");
      assert.deepStrictEqual(result.criticalFailures, []);
      const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
      try {
        assert.deepStrictEqual(
          migrated.prepare("SELECT content FROM memories ORDER BY rowid").all(),
          [{ content: "before migration" }],
        );
      } finally {
        migrated.close();
      }
      assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), false);
    } finally {
      sourceDb.close();
    }
  });

  it("rolls back a failed source retirement so migration can retry", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();

    const failed = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        await fs.promises.rename(source, destination);
        throw new Error("injected source retirement failure");
      },
    });

    assert.deepStrictEqual(failed.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), true);
    assert.equal(fs.existsSync(path.join(target, "sessions.db")), false);

    const retried = await migrateExtensionRoot(legacy, target);
    assert.deepStrictEqual(retried.criticalFailures, []);
    const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(migrated.prepare("SELECT value FROM retained").all(), [{ value: "legacy" }]);
    } finally {
      migrated.close();
    }
  });

  it("does not delete a destination created while source retirement fails", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();

    const failed = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        await fs.promises.rename(source, destination);
        const concurrent = new Database(path.join(target, "sessions.db"));
        concurrent.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('concurrent')");
        concurrent.close();
        throw new Error("injected source retirement failure");
      },
    });

    assert.deepStrictEqual(failed.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    const concurrent = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(concurrent.prepare("SELECT value FROM retained").all(), [{ value: "concurrent" }]);
    } finally {
      concurrent.close();
    }
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), true);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
    const retried = await migrateExtensionRoot(legacy, target);
    assert.deepStrictEqual(retried.criticalFailures.map(({ name }) => name), ["sessions.db"]);
  });

  it("keeps corrupt generation publication behind the pending boundary", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "sessions.db"), "not sqlite", "utf-8");
    fs.writeFileSync(path.join(legacy, "sessions.db-wal"), "legacy wal", "utf-8");
    const observations: boolean[] = [];

    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async (source, destination) => {
        observations.push(isDatabaseMigrationPending(legacy, target));
        await fs.promises.link(source, destination);
      },
    });

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.ok(observations.length >= 1);
    assert.ok(observations.every(Boolean));
    assert.equal(isDatabaseMigrationPending(legacy, target), false);
    assert.equal(fs.readFileSync(path.join(target, "sessions.db"), "utf-8"), "not sqlite");
  });

  it("preserves the retirement directory when rollback restoration is incomplete", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();

    const failed = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        await fs.promises.rename(source, destination);
        fs.writeFileSync(source, "concurrent legacy successor", "utf-8");
        throw new Error("injected retirement failure after move");
      },
    });

    assert.deepStrictEqual(failed.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    const retirementDirs = fs.readdirSync(legacy).filter((name) => name.startsWith(".sessions-db-retirement-"));
    assert.equal(retirementDirs.length, 1);
    assert.equal(fs.existsSync(path.join(legacy, retirementDirs[0], "sessions.db")), true);
    assert.equal(fs.readFileSync(path.join(legacy, "sessions.db"), "utf-8"), "concurrent legacy successor");
    assert.match(failed.criticalFailures[0].message, /recovery artifacts preserved at/);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
  });

  it("preserves the raw generation when backup detects corruption after locking", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('raw generation')");
    sourceDb.close();
    let backupAttempted = false;

    const result = await migrateExtensionRoot(legacy, target, {
      backupDatabase: async () => {
        backupAttempted = true;
        throw Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
      },
    });

    assert.equal(backupAttempted, true);
    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), false);
    const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(migrated.prepare("SELECT value FROM retained").all(), [{ value: "raw generation" }]);
    } finally {
      migrated.close();
    }
  });

  it("leaves the legacy SQLite generation retryable when snapshot publish fails", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.pragma("journal_mode = WAL");
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();
    let publishes = 0;

    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async (source, destination) => {
        publishes++;
        if (publishes === 1) throw new Error("injected snapshot publish failure");
        await fs.promises.link(source, destination);
      },
    });

    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.equal(publishes, 1);
    for (const name of ["sessions.db", "sessions.db-wal", "sessions.db-shm"]) {
      if (name === "sessions.db") assert.equal(fs.existsSync(path.join(legacy, name)), true);
      assert.equal(fs.existsSync(path.join(target, name)), false);
    }
  });

  it("never mixes legacy sidecars into an existing destination generation", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, "sessions.db"), "legacy database", "utf-8");
    fs.writeFileSync(path.join(legacy, "sessions.db-wal"), "legacy wal", "utf-8");
    fs.writeFileSync(path.join(target, "sessions.db"), "destination database", "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.readFileSync(path.join(target, "sessions.db"), "utf-8"), "destination database");
    assert.equal(fs.existsSync(path.join(target, "sessions.db-wal")), false);
    assert.equal(fs.readFileSync(path.join(legacy, "sessions.db-wal"), "utf-8"), "legacy wal");
  });
});
