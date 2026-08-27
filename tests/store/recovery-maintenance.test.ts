/**
 * Regression tests for the dormant-store snapshot retention sweep (#202).
 *
 * Seeds .recovery-* / .retired-* sidecar files directly on disk and proves
 * caps converge without any MemoryStore write.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  listMemoryStoreDirs,
  runRecoveryMaintenance,
} from "../../src/store/recovery-maintenance.js";
import { DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

const TEST_MARKER = "[RECOVERY-MAINTENANCE-TEST]";
let tmpDir = "";
let globalDir = "";
let projectsRoot = "";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    consolidationTimeoutMs: 30000,
    memoryDir: globalDir,
    projectsMemoryDir: projectsRoot,
    ...overrides,
  };
}

function recoveryPathFor(memoryDir: string, basename = "MEMORY.md"): string {
  return path.join(memoryDir, `.${basename}.recovery-${Date.now()}-${randomUUID()}`);
}

function retiredPathFor(memoryDir: string, basename = "MEMORY.md"): string {
  return path.join(memoryDir, `.${basename}.retired-${Date.now()}-${randomUUID()}`);
}

async function writeRaw(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function countFiles(dir: string, prefix: string): Promise<number> {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.startsWith(prefix)).length;
}

describe("recovery maintenance sweep", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-maintenance-test-"));
    globalDir = path.join(tmpDir, "global");
    projectsRoot = path.join(tmpDir, "projects-memory");
    await fs.mkdir(globalDir, { recursive: true });
    await fs.mkdir(projectsRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("bounds dormant recovery snapshots by count without a write", async () => {
    const projectDir = path.join(projectsRoot, "project-a");
    for (let index = 0; index < 40; index++) {
      await writeRaw(recoveryPathFor(projectDir), `${TEST_MARKER} recovery ${index}`);
    }

    const result = await runRecoveryMaintenance({ config: makeConfig(), globalDir });
    assert.equal(result.storesMaintained, 2);
    assert.deepEqual(result.failedStores, []);

    const recoveryCount = await countFiles(projectDir, ".MEMORY.md.recovery-");
    assert.ok(recoveryCount <= 32, `expected <= 32 recovery files, found ${recoveryCount}`);
    assert.ok(recoveryCount > 0, "newest active recovery must be retained");

    const retiredCount = await countFiles(projectDir, ".MEMORY.md.retired-");
    assert.ok(retiredCount <= 32, `expected <= 32 retired files, found ${retiredCount}`);

    const sizes = await Promise.all(
      (await fs.readdir(projectDir))
        .filter((name) => name.startsWith(".MEMORY.md.recovery-"))
        .map((name) => fs.stat(path.join(projectDir, name))),
    );
    const totalBytes = sizes.reduce((total, stat) => total + stat.size, 0);
    assert.ok(totalBytes <= 64 * 1024 * 1024);
  });

  it("removes retired snapshots past the age cap in a dormant store", async () => {
    const staleRetiredPath = retiredPathFor(globalDir);
    await writeRaw(staleRetiredPath, `${TEST_MARKER} stale retired`);
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(staleRetiredPath, stale, stale);

    const freshPath = retiredPathFor(globalDir);
    await writeRaw(freshPath, `${TEST_MARKER} fresh retired`);

    await runRecoveryMaintenance({ config: makeConfig(), globalDir });

    await assert.rejects(
      fs.stat(staleRetiredPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    assert.equal(await fs.readFile(freshPath, "utf-8"), `${TEST_MARKER} fresh retired`);
  });

  it("sweeps every enumerated store directory", async () => {
    const dirs = [
      path.join(projectsRoot, "project-one"),
      path.join(projectsRoot, "project-two"),
    ];
    for (const dir of dirs) {
      for (let index = 0; index < 35; index++) {
        await writeRaw(recoveryPathFor(dir, "USER.md"), `${TEST_MARKER} user recovery`);
      }
    }

    const discovered = await listMemoryStoreDirs({ config: makeConfig(), globalDir });
    assert.deepEqual(discovered.sort(), [globalDir, ...dirs].sort());

    await runRecoveryMaintenance({ config: makeConfig(), globalDir });
    for (const dir of dirs) {
      const userRecoveryCount = await countFiles(dir, ".USER.md.recovery-");
      assert.ok(userRecoveryCount <= 32, `expected <= 32 in ${dir}, found ${userRecoveryCount}`);
    }
  });

  it("never follows symlinked project directories", async () => {
    if (process.platform === "win32") return;
    const outsideDir = path.join(tmpDir, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await writeRaw(recoveryPathFor(outsideDir), `${TEST_MARKER} outside decoy`);

    await fs.symlink(outsideDir, path.join(projectsRoot, "linked-project"));

    const discovered = await listMemoryStoreDirs({ config: makeConfig(), globalDir });
    assert.deepEqual(discovered, [globalDir]);
  });

  it("is idempotent across repeated sweeps", async () => {
    const resultA = await runRecoveryMaintenance({ config: makeConfig(), globalDir });
    assert.deepEqual(resultA.failedStores, []);
    const siblingsAfterFirst = (await fs.readdir(globalDir)).length;

    const resultB = await runRecoveryMaintenance({ config: makeConfig(), globalDir });
    assert.deepEqual(resultB.failedStores, []);
    const siblingsAfterSecond = (await fs.readdir(globalDir)).length;

    assert.equal(siblingsAfterSecond, siblingsAfterFirst);
  });
});
