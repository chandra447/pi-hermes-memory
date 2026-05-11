import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENTRY_DELIMITER } from "../src/constants.js";
import { migrateLegacyProjectMemoryDirs } from "../src/project-memory-migration.js";

describe("migrateLegacyProjectMemoryDirs", () => {
  let tmpDir: string;
  let agentRoot: string;
  let globalDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-migration-test-"));
    agentRoot = path.join(tmpDir, "agent");
    globalDir = path.join(agentRoot, "memory");
    fs.mkdirSync(globalDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("copies legacy project memory into projects-memory without deleting the legacy file", () => {
    const legacyDir = path.join(agentRoot, "project-a");
    const legacyFile = path.join(legacyDir, "MEMORY.md");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyFile, "legacy project memory", "utf-8");

    const result = migrateLegacyProjectMemoryDirs(globalDir);

    const migratedFile = path.join(agentRoot, "projects-memory", "project-a", "MEMORY.md");
    assert.strictEqual(fs.readFileSync(migratedFile, "utf-8"), "legacy project memory");
    assert.strictEqual(fs.readFileSync(legacyFile, "utf-8"), "legacy project memory");
    assert.deepStrictEqual(
      { scanned: result.scanned, copied: result.copied, merged: result.merged, skipped: result.skipped },
      { scanned: 1, copied: 1, merged: 0, skipped: 0 },
    );
  });

  it("merges legacy-only entries when the new project memory file already exists", () => {
    const legacyDir = path.join(agentRoot, "project-a");
    const migratedDir = path.join(agentRoot, "projects-memory", "project-a");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(migratedDir, { recursive: true });

    fs.writeFileSync(
      path.join(legacyDir, "MEMORY.md"),
      ["shared", "legacy only"].join(ENTRY_DELIMITER),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(migratedDir, "MEMORY.md"),
      ["shared", "new only"].join(ENTRY_DELIMITER),
      "utf-8",
    );

    const result = migrateLegacyProjectMemoryDirs(globalDir);
    const merged = fs.readFileSync(path.join(migratedDir, "MEMORY.md"), "utf-8");

    assert.deepStrictEqual(merged.split(ENTRY_DELIMITER), ["shared", "new only", "legacy only"]);
    assert.deepStrictEqual(
      { scanned: result.scanned, copied: result.copied, merged: result.merged, skipped: result.skipped },
      { scanned: 1, copied: 0, merged: 1, skipped: 0 },
    );
  });

  it("skips global memory and the new projects-memory directory", () => {
    fs.writeFileSync(path.join(globalDir, "MEMORY.md"), "global memory", "utf-8");
    fs.mkdirSync(path.join(agentRoot, "projects-memory", "project-a"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "projects-memory", "project-a", "MEMORY.md"), "new memory", "utf-8");

    const result = migrateLegacyProjectMemoryDirs(globalDir);

    assert.deepStrictEqual(
      { scanned: result.scanned, copied: result.copied, merged: result.merged, skipped: result.skipped },
      { scanned: 0, copied: 0, merged: 0, skipped: 0 },
    );
  });
});
