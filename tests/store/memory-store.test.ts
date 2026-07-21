/**
 * Unit tests for MemoryStore — core persistent memory with file-backed storage.
 *
 * Uses real file I/O via the hardcoded ~/.pi/agent/memory/ path.
 * Each test isolates via beforeEach/afterEach cleanup with aggressive settling.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";


import { MemoryStore } from "../../src/store/memory-store.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  MEMORY_FILE,
  USER_FILE,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Helpers (module-level) ───

const TEST_MARKER = "[MEMORY-TEST]";
let MEMORY_DIR = "";

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
    memoryDir: MEMORY_DIR,
    ...overrides,
  };
}

/** Read raw file content, return "" if missing. */
async function readRaw(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Write a file (creating directories if needed). */
async function writeRaw(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/** Delete a file, ignoring errors. */
async function removeFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

function failureEntry(text: string, createdDaysAgo = 0): string {
  const date = dateDaysAgo(createdDaysAgo);
  return `${text} <!-- created=${date}, last=${date} -->`;
}

// ─── Tests ───

describe("MemoryStore", { concurrency: 1 }, () => {
  let memoryPath = "";
  let userPath = "";
  let failurePath = "";

  before(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-test-"));
    memoryPath = path.join(MEMORY_DIR, MEMORY_FILE);
    userPath = path.join(MEMORY_DIR, USER_FILE);
    failurePath = path.join(MEMORY_DIR, "failures.md");
  });

  after(async () => {
    // Clean up temp directory
    try {
      await fs.rm(MEMORY_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  /** Wait for fire-and-forget atomic write to settle. */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 200));
  }

  /** Aggressively clean both memory files and wait for pending writes. */
  async function cleanSlate(): Promise<void> {
    await removeFile(memoryPath);
    await removeFile(userPath);
    await removeFile(failurePath);
    await new Promise((r) => setTimeout(r, 250));
    // Remove again in case a pending write sneaked in during the wait
    await removeFile(memoryPath);
    await removeFile(userPath);
    await removeFile(failurePath);
    await new Promise((r) => setTimeout(r, 50));
  }

  beforeEach(async () => {
    await cleanSlate();
  });

  afterEach(async () => {
    await cleanSlate();
  });

  // ─── add() tests ───

  describe("add()", () => {
    it("persists entry to file and returns success with usage stats", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} project uses pnpm`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.target, "memory");
      assert.ok(result.usage);
      assert.ok(result.usage!.includes("chars"));
      assert.equal(result.entry_count, 1);
      assert.equal(result.message, "Entry added.");
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} project uses pnpm`));
    });

    it("no-ops on duplicate entry and returns message", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} dup test entry`;
      const r1 = await store.add("memory", entry);
      assert.ok(r1.success);
      assert.equal(r1.entry_count, 1);

      const r2 = await store.add("memory", entry);
      await settle();

      assert.ok(r2.success);
      assert.equal(r2.entry_count, 1);
      assert.equal(r2.message, "Entry already exists (no duplicate added).");

      const raw = await readRaw(memoryPath);
      const count = raw.split(ENTRY_DELIMITER).filter(Boolean).length;
      assert.equal(count, 1);
    });

    it("returns error when content would exceed char limit", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 50 }));
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error);
      assert.ok(result.error!.includes("exceed the limit"));
      assert.ok(result.error!.includes("chars"));
    });

    it("rejects without consolidation when memoryOverflowStrategy is reject", async () => {
      let consolidatorCalled = false;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 50,
        memoryOverflowStrategy: "reject",
        autoConsolidate: true,
      }));
      store.setConsolidator(async () => {
        consolidatorCalled = true;
        return { consolidated: true };
      });
      await store.loadFromDisk();

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);
      await settle();

      assert.ok(!result.success);
      assert.equal(consolidatorCalled, false);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    it("evicts oldest entries in file order when memoryOverflowStrategy is fifo-evict", async () => {
      let consolidatorCalled = false;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 150,
        memoryOverflowStrategy: "fifo-evict",
        autoConsolidate: true,
      }));
      store.setConsolidator(async () => {
        consolidatorCalled = true;
        return { consolidated: true };
      });
      await store.loadFromDisk();

      const first = `${TEST_MARKER} fifo first`;
      const second = `${TEST_MARKER} fifo second`;
      const next = `${TEST_MARKER} fifo next`;

      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      const result = await store.add("memory", next);
      await settle();

      assert.ok(result.success, result.error);
      assert.equal(consolidatorCalled, false);
      assert.equal(result.message, "Memory updated. Rotated 1 older entry to stay within the limit.");
      assert.deepEqual(result.evicted_entries, [first]);
      assert.equal(result.evicted_count, 1);
      assert.equal(result.entry_count, 2);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(first));
      assert.ok(raw.includes(second));
      assert.ok(raw.includes(next));
      assert.ok(raw.indexOf(second) < raw.indexOf(next));
    });

    it("does not evict when the new entry cannot fit an empty memory", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 80,
        memoryOverflowStrategy: "fifo-evict",
      }));
      await store.loadFromDisk();

      const existing = `${TEST_MARKER} keep me`;
      assert.ok((await store.add("memory", existing)).success);

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(120)}`);
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(existing));
    });

    it("returns error for empty content", async () => {
      const store = new MemoryStore(makeConfig());

      const result = await await store.add("memory", "   ");
      assert.ok(!result.success);
      assert.equal(result.error, "Content cannot be empty.");
    });

    it("writes to USER.md for 'user' target", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("user", `${TEST_MARKER} prefers dark mode`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.target, "user");

      const raw = await readRaw(userPath);
      assert.ok(raw.includes(`${TEST_MARKER} prefers dark mode`));

      const memRaw = await readRaw(memoryPath);
      assert.equal(memRaw, "");
    });

    it("writes to MEMORY.md for 'memory' target", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} uses node 22`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.target, "memory");

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} uses node 22`));
    });

    it("handles content with § delimiter in entry", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} section divider${ENTRY_DELIMITER}continued`;
      const result = await store.add("memory", entry);
      await settle();

      // Embedded delimiters are not escaped. After the write is published we
      // re-read disk as source of truth, so the single logical add surfaces as
      // two entries (and usage/entry_count match the split file).
      assert.ok(result.success);
      assert.equal(result.entry_count, 2);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /section divider/);
      assert.match(raw, /continued/);
    });

    it("handles unicode content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} 日本語テスト 🧪`;
      const result = await await store.add("memory", entry);
      await settle();

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
    });

    it("handles very long entry near char limit", async () => {
      const limit = 250;
      const store = new MemoryStore(makeConfig({ memoryCharLimit: limit }));
      await store.loadFromDisk();

      // Account for metadata overhead (~45 chars for <!-- created=..., last=... -->)
      const entry = `${TEST_MARKER} ${"a".repeat(limit - 100)}`;
      const result = await await store.add("memory", entry);
      await settle();

      assert.ok(result.success, `Expected success but got error: ${result.error}`);
    });

    it("handles sequential adds (two in sequence)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const r1 = await store.add("memory", `${TEST_MARKER} first entry`);
      assert.ok(r1.success, `First add failed: ${r1.error}`);
      await settle();

      const r2 = await store.add("memory", `${TEST_MARKER} second entry`);
      assert.ok(r2.success, `Second add failed: ${r2.error}`);
      await settle();

      assert.equal(r2.entry_count, 2);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} first entry`));
      assert.ok(raw.includes(`${TEST_MARKER} second entry`));
    });
  });

  describe("addFailure()", () => {
    it("applies failure-target char limits", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 40 }));
      await store.loadFromDisk();

      const result = await store.addFailure(`${TEST_MARKER} ${"x".repeat(120)}`, {
        category: "failure",
      });
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    it("deduplicates exact failure memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const first = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });
      const second = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });
      await settle();

      assert.ok(first.success);
      assert.equal(first.message, "Failure memory saved: correction");
      assert.ok(second.success);
      assert.equal(second.message, "Entry already exists (no duplicate added).");
      assert.equal(second.entry_count, 1);

      const raw = await readRaw(failurePath);
      const count = raw.split(ENTRY_DELIMITER).filter(Boolean).length;
      assert.equal(count, 1);
    });

    it("keeps identical failure text in global and distinct project scopes", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const first = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        project: "project-a",
      });
      const second = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        project: "project-b",
      });
      const global = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
      });
      const duplicate = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        project: "project-a",
      });

      assert.ok(first.success);
      assert.ok(second.success);
      assert.equal(second.entry_count, 2);
      assert.ok(global.success);
      assert.equal(global.entry_count, 3);
      assert.equal(duplicate.message, "Entry already exists (no duplicate added).");
      assert.equal(duplicate.entry_count, 3);
      assert.equal(store.getRawEntriesForSync("failure").length, 3);
    });
  });

  // ─── replace() tests ───

  describe("replace()", () => {
    it("updates entry in file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} uses vim`);
      await settle();

      const result = await store.replace("memory", `${TEST_MARKER} uses vim`, `${TEST_MARKER} uses neovim`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.message, "Entry replaced.");
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} uses vim`));
      assert.ok(raw.includes(`${TEST_MARKER} uses neovim`));
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} some entry`);
      await settle();

      const result = await store.replace("memory", "nonexistent substring", "new content");
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for multiple matches", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} config: port=8080`);
      await store.add("memory", `${TEST_MARKER} config: port=9090`);
      await settle();

      const result = await store.replace("memory", "config:", `${TEST_MARKER} unified config`);
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("Multiple entries matched"));
      assert.ok(result.matches);
      assert.equal(result.matches!.length, 2);
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", "  ", "new content");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });

    it("returns error for empty new_content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", `${TEST_MARKER} some entry`, "   ");

      assert.ok(!result.success);
      assert.equal(result.error, "new_content cannot be empty. Use 'remove' to delete entries.");
    });

    it("replaces identical failure text across project scopes while preserving each scope", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.addFailure(`${TEST_MARKER} shared correction`, { category: "correction", project: "project-a" });
      await store.addFailure(`${TEST_MARKER} shared correction`, { category: "correction", project: "project-b" });

      const result = await store.replace(
        "failure",
        `[correction] ${TEST_MARKER} shared correction`,
        `[correction] ${TEST_MARKER} replacement`,
      );

      assert.equal(result.success, true);
      const entries = store.getRawEntriesForSync("failure");
      assert.equal(entries.length, 2);
      assert.ok(entries.every((entry) => entry.includes(`${TEST_MARKER} replacement`)));
      assert.deepEqual(
        entries.map((entry) => entry.match(/project64=([A-Za-z0-9_-]+)/)?.[1]).sort(),
        [
          Buffer.from("project-a", "utf-8").toString("base64url"),
          Buffer.from("project-b", "utf-8").toString("base64url"),
        ],
      );
    });
  });

  // ─── remove() tests ───

  describe("remove()", () => {
    it("removes entry from file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} to be removed`);
      await store.add("memory", `${TEST_MARKER} to keep`);
      await settle();

      const result = await store.remove("memory", `${TEST_MARKER} to be removed`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.message, "Entry removed.");
      assert.equal(result.entry_count, 1);
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} to be removed`));
      assert.ok(raw.includes(`${TEST_MARKER} to keep`));
    });

    it("accepts a pasted memory_search line for normal memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} prefers pnpm over npm`);
      await settle();

      const result = await store.remove("memory", `🧠 [global] ${TEST_MARKER} prefers pnpm over npm\n   Created: 2026-05-27 | Last used: 2026-05-27`);
      await settle();

      assert.ok(result.success);
      const raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
    });

    it("accepts a pasted memory_search line for failure memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });
      await settle();

      const result = await store.remove(
        "failure",
        `⚠️ [global] [correction] [correction] ${TEST_MARKER} use pnpm\n   Created: 2026-05-27 | Last used: 2026-05-27`,
      );
      await settle();

      assert.ok(result.success);
      const raw = await readRaw(failurePath);
      assert.equal(raw.trim(), "");
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} existing`);
      await settle();

      const result = await store.remove("memory", "nonexistent");
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.remove("memory", "  ");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });

    it("removes identical failure text across project scopes", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.addFailure(`${TEST_MARKER} shared correction`, { category: "correction", project: "project-a" });
      await store.addFailure(`${TEST_MARKER} shared correction`, { category: "correction", project: "project-b" });

      const result = await store.remove("failure", `[correction] ${TEST_MARKER} shared correction`);

      assert.equal(result.success, true);
      assert.deepEqual(store.getRawEntriesForSync("failure"), []);
      assert.equal((await readRaw(failurePath)).trim(), "");
    });
  });

  // ─── loadFromDisk() tests ───

  describe("loadFromDisk()", () => {
    it("reads existing MEMORY.md and USER.md correctly", async () => {
      // beforeEach already cleaned slate; write test data
      await writeRaw(memoryPath, `${TEST_MARKER} mem entry 1${ENTRY_DELIMITER}${TEST_MARKER} mem entry 2`);
      await writeRaw(userPath, `${TEST_MARKER} user entry 1`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const memEntries = store.getMemoryEntries();
      const userEntries = store.getUserEntries();

      assert.deepEqual(memEntries, [`${TEST_MARKER} mem entry 1`, `${TEST_MARKER} mem entry 2`]);
      assert.deepEqual(userEntries, [`${TEST_MARKER} user entry 1`]);
    });

    it("handles missing files gracefully (returns empty)", async () => {
      // beforeEach cleaned slate — files should not exist
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      assert.deepEqual(store.getMemoryEntries(), []);
      assert.deepEqual(store.getUserEntries(), []);
    });

    it("deduplicates entries preserving order", async () => {
      const entry1 = `${TEST_MARKER} dup original`;
      const entry2 = `${TEST_MARKER} dup second`;
      const entry3 = `${TEST_MARKER} dup third`;

      await writeRaw(memoryPath, [entry1, entry2, entry1, entry3].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entries = store.getMemoryEntries();
      assert.deepEqual(entries, [entry1, entry2, entry3]);
    });
  });

  // ─── formatForSystemPrompt() tests ───

  describe("formatForSystemPrompt()", () => {
    it("returns frozen snapshot — add after load does not change it", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} original note`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const before = store.formatForSystemPrompt();
      assert.ok(before.includes(`${TEST_MARKER} original note`));

      // Add a new entry — this should NOT affect the snapshot
      await store.add("memory", `${TEST_MARKER} new note after load`);

      const after = store.formatForSystemPrompt();
      assert.equal(before, after, "Snapshot should not change after add");
      assert.ok(!after.includes(`${TEST_MARKER} new note after load`));
    });

    it("returns empty string when no entries", async () => {
      // beforeEach cleaned slate — no entries exist
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.equal(result, "");
    });

    it("injects recent failure memories by default", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} failure 1`),
        failureEntry(`${TEST_MARKER} failure 2`),
        failureEntry(`${TEST_MARKER} failure 3`),
        failureEntry(`${TEST_MARKER} failure 4`),
        failureEntry(`${TEST_MARKER} failure 5`),
        failureEntry(`${TEST_MARKER} failure 6`),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes("RECENT FAILURES & LESSONS"));
      assert.ok(result.includes(`${TEST_MARKER} failure 1`));
      assert.ok(result.includes(`${TEST_MARKER} failure 5`));
      assert.ok(!result.includes(`${TEST_MARKER} failure 6`), "default should preserve existing first-5 slice behavior");
    });

    it("does not inject failure memories when disabled", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} regular memory`);
      await writeRaw(failurePath, failureEntry(`${TEST_MARKER} disabled failure`));

      const store = new MemoryStore(makeConfig({ failureInjectionEnabled: false }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} regular memory`));
      assert.ok(!result.includes("RECENT FAILURES & LESSONS"));
      assert.ok(!result.includes(`${TEST_MARKER} disabled failure`));
    });

    it("respects configured failure injection max entries", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} max entry 1`),
        failureEntry(`${TEST_MARKER} max entry 2`),
        failureEntry(`${TEST_MARKER} max entry 3`),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig({ failureInjectionMaxEntries: 2 }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} max entry 1`));
      assert.ok(result.includes(`${TEST_MARKER} max entry 2`));
      assert.ok(!result.includes(`${TEST_MARKER} max entry 3`));
    });

    it("respects configured failure injection max age days", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} recent failure`, 1),
        failureEntry(`${TEST_MARKER} old failure`, 3),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig({ failureInjectionMaxAgeDays: 2 }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} recent failure`));
      assert.ok(!result.includes(`${TEST_MARKER} old failure`));
    });

    it("includes both memory and user blocks when both have entries", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} mem data`);
      await writeRaw(userPath, `${TEST_MARKER} user data`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      // Content should be present inside fenced blocks
      assert.ok(result.includes("<memory-context>"), "should use context fencing");
      assert.ok(result.includes("PERSISTENT MEMORY"), "should have guard note");
      assert.ok(result.includes("NOT new user input"), "should disclaim as not user input");
      assert.ok(result.includes("END MEMORY"), "should close fence");
      assert.ok(result.includes("</memory-context>"), "should close XML tag");
      assert.ok(result.includes("MEMORY"), "should contain MEMORY header");
      assert.ok(result.includes("USER PROFILE"), "should contain USER PROFILE header");
      assert.ok(result.includes(`${TEST_MARKER} mem data`));
      assert.ok(result.includes(`${TEST_MARKER} user data`));
    });
  });

  // ─── Atomic writes ───

  describe("atomic writes", () => {
    it("file content is correct after write (read back and check)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entries = [
        `${TEST_MARKER} first atomic entry`,
        `${TEST_MARKER} second atomic entry`,
      ];

      await store.add("memory", entries[0]);
      await settle();
      await store.add("memory", entries[1]);
      await settle();


      const raw = await readRaw(memoryPath);
      const parsed = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);

      // Strip metadata comments for comparison (entries now include <!-- created=..., last=... -->)
      const stripped = parsed.map((e) => e.replace(/\s*<!--.*?-->\s*$/, "").trim());
      assert.deepEqual(stripped, entries);
    });

    it("file is empty after all entries are removed", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} temporary entry`);
      await settle();

      let raw = await readRaw(memoryPath);
      assert.ok(raw.length > 0);

      await store.remove("memory", `${TEST_MARKER} temporary entry`);
      await settle();

      raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
    });

    it("mutates a file-symlinked Markdown target without replacing the link", { skip: process.platform === "win32" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-symlink-test-"));
      const realDir = path.join(root, "real");
      const aliasDir = path.join(root, "alias");
      await fs.mkdir(realDir);
      await fs.mkdir(aliasDir);
      const realPath = path.join(realDir, MEMORY_FILE);
      const aliasPath = path.join(aliasDir, MEMORY_FILE);
      await fs.writeFile(realPath, `${TEST_MARKER} original`, "utf-8");
      await fs.symlink(realPath, aliasPath, "file");

      try {
        const aliasStore = new MemoryStore(makeConfig({ memoryDir: aliasDir }));
        await aliasStore.loadFromDisk();
        await aliasStore.add("memory", `${TEST_MARKER} alias write`);

        assert.equal((await fs.lstat(aliasPath)).isSymbolicLink(), true);
        const directStore = new MemoryStore(makeConfig({ memoryDir: realDir }));
        await directStore.loadFromDisk();
        await directStore.add("memory", `${TEST_MARKER} direct write`);

        const raw = await fs.readFile(realPath, "utf-8");
        assert.match(raw, /original/);
        assert.match(raw, /alias write/);
        assert.match(raw, /direct write/);
        assert.equal((await fs.lstat(aliasPath)).isSymbolicLink(), true);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it("creates a dangling relative Markdown symlink target and preserves the link", { skip: process.platform === "win32" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-dangling-symlink-test-"));
      const realDir = path.join(root, "real");
      const aliasDir = path.join(root, "alias");
      await fs.mkdir(realDir);
      await fs.mkdir(aliasDir);
      const realPath = path.join(realDir, MEMORY_FILE);
      const aliasPath = path.join(aliasDir, MEMORY_FILE);
      await fs.symlink(path.relative(aliasDir, realPath), aliasPath, "file");

      try {
        const aliasStore = new MemoryStore(makeConfig({ memoryDir: aliasDir }));
        await aliasStore.loadFromDisk();
        const aliasResult = await aliasStore.add("memory", `${TEST_MARKER} alias write`);
        assert.equal(aliasResult.success, true);

        const directStore = new MemoryStore(makeConfig({ memoryDir: realDir }));
        await directStore.loadFromDisk();
        const directResult = await directStore.add("memory", `${TEST_MARKER} direct write`);
        assert.equal(directResult.success, true);

        const raw = await fs.readFile(realPath, "utf-8");
        assert.match(raw, /alias write/);
        assert.match(raw, /direct write/);
        assert.equal((await fs.lstat(aliasPath)).isSymbolicLink(), true);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it("rejects Markdown symlink loops before mutation", { skip: process.platform === "win32" }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-symlink-loop-test-"));
      await fs.symlink(USER_FILE, path.join(root, MEMORY_FILE), "file");
      await fs.symlink(MEMORY_FILE, path.join(root, USER_FILE), "file");
      try {
        const store = new MemoryStore(makeConfig({ memoryDir: root }));
        await assert.rejects(store.loadFromDisk(), /symbolic link loop/i);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  // ─── Both targets ───

  describe("both targets", () => {
    it("add to 'user' goes to USER.md, add to 'memory' goes to MEMORY.md", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("user", `${TEST_MARKER} user fact`);
      await store.add("memory", `${TEST_MARKER} memory fact`);
      await settle();

      const userRaw = await readRaw(userPath);
      const memRaw = await readRaw(memoryPath);

      assert.ok(userRaw.includes(`${TEST_MARKER} user fact`));
      assert.ok(!userRaw.includes(`${TEST_MARKER} memory fact`));
      assert.ok(memRaw.includes(`${TEST_MARKER} memory fact`));
      assert.ok(!memRaw.includes(`${TEST_MARKER} user fact`));
    });
  });

  describe("external file changes", () => {
    async function replaceOnDiskSameSize(from: string, to: string): Promise<void> {
      assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
      const before = await readRaw(memoryPath);
      const after = before.replace(from, to);
      assert.notEqual(after, before);
      assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
      await writeRaw(memoryPath, after);
    }

    it("add preserves a same-size external rewrite", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} stale-A`);
      await settle();

      await replaceOnDiskSameSize("stale-A", "fresh-B");
      const result = await store.add("memory", `${TEST_MARKER} appended`);
      await settle();

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /fresh-B/);
      assert.match(raw, /appended/);
      assert.doesNotMatch(raw, /stale-A/);
    });

    it("replace sees a same-size external rewrite", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} stale-A`);
      await settle();

      await replaceOnDiskSameSize("stale-A", "fresh-B");
      const result = await store.replace("memory", `${TEST_MARKER} fresh-B`, `${TEST_MARKER} replaced`);
      await settle();

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /replaced/);
      assert.doesNotMatch(raw, /fresh-B|stale-A/);
    });

    it("remove sees a same-size external rewrite", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} stale-A`);
      await settle();

      await replaceOnDiskSameSize("stale-A", "fresh-B");
      const result = await store.remove("memory", `${TEST_MARKER} fresh-B`);
      await settle();

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.doesNotMatch(raw, /fresh-B|stale-A/);
    });

    it("reapplies an add when an external write lands immediately before rename", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);

      const originalSave = (store as any).saveToDisk.bind(store);
      let injected = false;
      (store as any).saveToDisk = async (target: "memory") => {
        if (!injected) {
          injected = true;
          const current = await readRaw(memoryPath);
          await writeRaw(memoryPath, `${current}${ENTRY_DELIMITER}${TEST_MARKER} external editor`);
        }
        return originalSave(target);
      };

      const result = await store.add("memory", `${TEST_MARKER} local add`);

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /external editor/);
      assert.match(raw, /local add/);
      assert.equal(raw.match(/external editor/g)?.length, 1);
      assert.equal(raw.match(/local add/g)?.length, 1);
    });

    it("reapplies an add when an external write lands after the final fingerprint read", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);

      const originalRead = (store as any).readFileState.bind(store);
      const canonicalMemoryPath = await fs.realpath(memoryPath);
      let injected = false;
      let memoryReads = 0;
      (store as any).readFileState = async (filePath: string) => {
        const state = await originalRead(filePath);
        if (filePath === canonicalMemoryPath) memoryReads++;
        if (!injected && filePath === canonicalMemoryPath && memoryReads === 2) {
          injected = true;
          const current = await readRaw(memoryPath);
          await writeRaw(memoryPath, `${current}${ENTRY_DELIMITER}${TEST_MARKER} late editor`);
        }
        return state;
      };

      const result = await store.add("memory", `${TEST_MARKER} local add`);

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /late editor/);
      assert.match(raw, /local add/);
    });

    it("recovers a write through an open descriptor after displacement", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);
      const handle = await fs.open(memoryPath, "r+");

      const originalRead = (store as any).readFileState.bind(store);
      let injected = false;
      (store as any).readFileState = async (filePath: string) => {
        if (!injected && path.basename(filePath).startsWith(`.${MEMORY_FILE}.recovery-`)) {
          injected = true;
          await handle.truncate(0);
          await handle.writeFile(`${TEST_MARKER} descriptor editor`, "utf-8");
          await handle.sync();
        }
        return originalRead(filePath);
      };

      try {
        const result = await store.add("memory", `${TEST_MARKER} local add`);
        assert.equal(result.success, true);
      } finally {
        await handle.close();
      }

      assert.equal(injected, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /descriptor editor/);
      assert.match(raw, /local add/);
    });

    it("preserves a late write through a displaced open descriptor", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);
      const handle = await fs.open(memoryPath, "r+");

      const originalRead = (store as any).readFileState.bind(store);
      let displacedReads = 0;
      (store as any).readFileState = async (filePath: string) => {
        const state = await originalRead(filePath);
        if (path.basename(filePath).startsWith(`.${MEMORY_FILE}.recovery-`)) {
          displacedReads++;
          if (displacedReads === 2) {
            await handle.truncate(0);
            await handle.writeFile(`${TEST_MARKER} late descriptor editor`, "utf-8");
            await handle.sync();
          }
        }
        return state;
      };

      try {
        const result = await store.add("memory", `${TEST_MARKER} local add`);
        assert.equal(result.success, true);
      } finally {
        await handle.close();
      }

      const siblings = await fs.readdir(MEMORY_DIR);
      const recoveryFiles = siblings.filter((name) => name.startsWith(`.${MEMORY_FILE}.recovery-`));
      assert.ok(recoveryFiles.length > 0);
      const recovered = await Promise.all(
        recoveryFiles.map((name) => fs.readFile(path.join(MEMORY_DIR, name), "utf-8")),
      );
      assert.ok(recovered.some((content) => content.includes("late descriptor editor")));
    });

    it("keeps the displaced original when either verification stage fails", async () => {
      for (const failureRead of [1, 2]) {
        await cleanSlate();
        const store = new MemoryStore(makeConfig());
        await store.loadFromDisk();
        await store.add("memory", `${TEST_MARKER} original before failure ${failureRead}`);

        const originalRead = (store as any).readFileState.bind(store);
        let displacedReads = 0;
        (store as any).readFileState = async (filePath: string) => {
          if (path.basename(filePath).startsWith(`.${MEMORY_FILE}.recovery-`)) {
            displacedReads++;
            if (displacedReads === failureRead) {
              throw new Error(`injected displaced verification failure ${failureRead}`);
            }
          }
          return originalRead(filePath);
        };

        await assert.rejects(
          store.add("memory", `${TEST_MARKER} local add`),
          new RegExp(`injected displaced verification failure ${failureRead}`),
        );

        const siblings = await fs.readdir(MEMORY_DIR);
        const recoveryFiles = siblings.filter((name) => name.startsWith(`.${MEMORY_FILE}.recovery-`));
        const recovered = await Promise.all(
          recoveryFiles.map((name) => fs.readFile(path.join(MEMORY_DIR, name), "utf-8")),
        );
        assert.ok(recovered.some((content) => content.includes(`original before failure ${failureRead}`)));
        assert.match(await readRaw(memoryPath), new RegExp(`original before failure ${failureRead}`));
      }
    });

    it("restores the authoritative file when conflict preservation fails", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} original before preservation failure`);

      const originalRead = (store as any).readFileState.bind(store);
      let displacedReads = 0;
      (store as any).readFileState = async (filePath: string) => {
        if (path.basename(filePath).startsWith(`.${MEMORY_FILE}.recovery-`)) {
          displacedReads++;
          if (displacedReads === 2) {
            throw new Error("injected post-publish verification failure");
          }
        }
        return originalRead(filePath);
      };
      (store as any).preserveConflictFile = async () => {
        throw new Error("injected conflict preservation failure");
      };

      await assert.rejects(
        store.add("memory", `${TEST_MARKER} failed local add`),
        /injected post-publish verification failure/,
      );
      assert.match(await readRaw(memoryPath), /original before preservation failure/);
      assert.doesNotMatch(await readRaw(memoryPath), /failed local add/);

      (store as any).readFileState = originalRead;
      const result = await store.add("memory", `${TEST_MARKER} later successful add`);
      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /original before preservation failure/);
      assert.match(raw, /later successful add/);
      assert.doesNotMatch(raw, /failed local add/);
    });

    it("rolls back a published mutation without copying through the temporary link", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} original before copy failure`);

      const originalRead = (store as any).readFileState.bind(store);
      let displacedReads = 0;
      (store as any).readFileState = async (filePath: string) => {
        if (path.basename(filePath).startsWith(`.${MEMORY_FILE}.recovery-`)) {
          displacedReads++;
          if (displacedReads === 2) throw new Error("injected post-publish failure");
        }
        return originalRead(filePath);
      };
      (store as any).preserveConflictFile = async (tmpPath: string) => {
        await fs.unlink(tmpPath);
        await fs.mkdir(tmpPath);
        throw new Error("injected conflict copy failure");
      };

      await assert.rejects(
        store.add("memory", `${TEST_MARKER} failed local add`),
        /injected post-publish failure/,
      );
      const raw = await readRaw(memoryPath);
      assert.match(raw, /original before copy failure/);
      assert.doesNotMatch(raw, /failed local add/);
    });

    it("does not delete an editor file recreated during rollback", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} original before rollback race`);

      const originalRead = (store as any).readFileState.bind(store);
      let displacedReads = 0;
      (store as any).readFileState = async (filePath: string) => {
        if (path.basename(filePath).startsWith(`.${MEMORY_FILE}.recovery-`)) {
          displacedReads++;
          if (displacedReads === 2) throw new Error("injected post-publish failure");
        }
        return originalRead(filePath);
      };
      (store as any).preserveConflictFile = async () => {
        await fs.rename(memoryPath, `${memoryPath}.owned-local`);
        await writeRaw(memoryPath, `${TEST_MARKER} editor successor`);
        return `${memoryPath}.owned-local`;
      };

      await assert.rejects(
        store.add("memory", `${TEST_MARKER} failed local add`),
        /injected post-publish failure/,
      );

      assert.equal(await readRaw(memoryPath), `${TEST_MARKER} editor successor`);
    });

    it("does not commit a failed add during a later mutation", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);

      const originalSave = (store as any).saveToDisk.bind(store);
      let failNextSave = true;
      (store as any).saveToDisk = async (target: "memory") => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("injected add save failure");
        }
        await originalSave(target);
      };

      await assert.rejects(
        store.add("memory", `${TEST_MARKER} failed add`),
        /injected add save failure/,
      );
      const result = await store.add("memory", `${TEST_MARKER} later add`);

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /existing/);
      assert.match(raw, /later add/);
      assert.doesNotMatch(raw, /failed add/);
    });

    it("does not commit a failed replacement during a later mutation", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} original entry`);

      const originalSave = (store as any).saveToDisk.bind(store);
      let failNextSave = true;
      (store as any).saveToDisk = async (target: "memory") => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("injected replace save failure");
        }
        await originalSave(target);
      };

      await assert.rejects(
        store.replace("memory", `${TEST_MARKER} original entry`, `${TEST_MARKER} failed replacement`),
        /injected replace save failure/,
      );
      const result = await store.add("memory", `${TEST_MARKER} later add`);

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /original entry/);
      assert.match(raw, /later add/);
      assert.doesNotMatch(raw, /failed replacement/);
    });

    it("does not commit a failed removal during a later mutation", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} retained entry`);

      const originalSave = (store as any).saveToDisk.bind(store);
      let failNextSave = true;
      (store as any).saveToDisk = async (target: "memory") => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("injected remove save failure");
        }
        await originalSave(target);
      };

      await assert.rejects(
        store.remove("memory", `${TEST_MARKER} retained entry`),
        /injected remove save failure/,
      );
      const result = await store.add("memory", `${TEST_MARKER} later add`);

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /retained entry/);
      assert.match(raw, /later add/);
    });

    it("prunes expired recovery files but retains recently active ones", async () => {
      const pathStore = new MemoryStore(makeConfig());
      const expiredPath = (pathStore as any).recoveryPathFor(memoryPath) as string;
      const activePath = (pathStore as any).recoveryPathFor(memoryPath) as string;
      await writeRaw(expiredPath, `${TEST_MARKER} expired recovery`);
      await writeRaw(activePath, `${TEST_MARKER} active recovery`);
      const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await fs.utimes(expiredPath, expired, expired);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} triggers recovery pruning`);

      await assert.rejects(fs.stat(expiredPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      assert.equal(await fs.readFile(activePath, "utf-8"), `${TEST_MARKER} active recovery`);
      const retiredFiles = (await fs.readdir(MEMORY_DIR))
        .filter((name) => name.startsWith(`.${MEMORY_FILE}.retired-`));
      const retiredContents = await Promise.all(
        retiredFiles.map((name) => fs.readFile(path.join(MEMORY_DIR, name), "utf-8")),
      );
      assert.ok(retiredContents.some((content) => content.includes("expired recovery")));
    });

    it("keeps the active recovery pathname stable for late writes within the grace period", async () => {
      const pathStore = new MemoryStore(makeConfig());
      const activePath = (pathStore as any).recoveryPathFor(memoryPath) as string;
      await writeRaw(activePath, `${TEST_MARKER} displaced original`);
      const handle = await fs.open(activePath, "r+");

      try {
        const store = new MemoryStore(makeConfig());
        await store.loadFromDisk();
        await store.add("memory", `${TEST_MARKER} triggers recovery pruning`);
        await handle.truncate(0);
        await handle.writeFile(`${TEST_MARKER} late active descriptor write`, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      assert.match(await fs.readFile(activePath, "utf-8"), /late active descriptor write/);
    });

    it("ignores generated-looking recovery symlinks during pruning", async (t) => {
      if (process.platform === "win32") {
        t.skip("symlink creation requires platform privileges");
        return;
      }
      const outsidePath = path.join(path.dirname(MEMORY_DIR), "outside-sensitive.md");
      const pathStore = new MemoryStore(makeConfig());
      const symlinkPath = (pathStore as any).recoveryPathFor(memoryPath) as string;
      await writeRaw(outsidePath, `${TEST_MARKER} outside sensitive content`);
      await fs.symlink(outsidePath, symlinkPath);
      const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await fs.utimes(outsidePath, expired, expired);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} triggers symlink-safe pruning`);

      assert.equal((await fs.lstat(symlinkPath)).isSymbolicLink(), true);
      const retiredFiles = (await fs.readdir(MEMORY_DIR))
        .filter((name) => name.startsWith(`.${MEMORY_FILE}.retired-`));
      const retiredContents = await Promise.all(
        retiredFiles.map((name) => fs.readFile(path.join(MEMORY_DIR, name), "utf-8")),
      );
      assert.equal(retiredContents.some((content) => content.includes("outside sensitive content")), false);
    });

    it("bounds retired recovery snapshots by age, count, and bytes", async () => {
      const pathStore = new MemoryStore(makeConfig());
      const staleRetiredPath = (pathStore as any).retiredRecoveryPathFor(memoryPath) as string;
      await writeRaw(staleRetiredPath, `${TEST_MARKER} stale retired snapshot`);
      const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await fs.utimes(staleRetiredPath, stale, stale);

      for (let index = 0; index < 40; index++) {
        const retiredPath = (pathStore as any).retiredRecoveryPathFor(memoryPath) as string;
        await writeRaw(retiredPath, `${TEST_MARKER} retired ${index}`);
        await fs.truncate(retiredPath, 2 * 1024 * 1024);
      }

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} triggers retired pruning`);

      const siblings = await fs.readdir(MEMORY_DIR);
      const retiredFiles = siblings.filter((name) => name.startsWith(`.${MEMORY_FILE}.retired-`));
      const retiredStats = await Promise.all(
        retiredFiles.map((name) => fs.stat(path.join(MEMORY_DIR, name))),
      );
      assert.ok(!retiredFiles.includes(path.basename(staleRetiredPath)));
      assert.ok(retiredFiles.length <= 32);
      assert.ok(retiredStats.reduce((total, stat) => total + stat.size, 0) <= 64 * 1024 * 1024);
    });

    it("bounds generated conflict artifacts without following lookalike symlinks", async () => {
      const externalPath = path.join(MEMORY_DIR, "outside-conflict-data");
      await writeRaw(externalPath, `${TEST_MARKER} outside data`);
      const symlinkPath = path.join(
        MEMORY_DIR,
        `.${MEMORY_FILE}.conflict-local-${Date.now()}-${randomUUID()}`,
      );
      if (process.platform !== "win32") await fs.symlink(externalPath, symlinkPath, "file");

      for (let index = 0; index < 40; index++) {
        const conflictPath = path.join(
          MEMORY_DIR,
          `.${MEMORY_FILE}.conflict-local-${Date.now() - index}-${randomUUID()}`,
        );
        await writeRaw(conflictPath, `${TEST_MARKER} conflict ${index}`);
        await fs.truncate(conflictPath, 2 * 1024 * 1024);
      }
      const stalePath = path.join(
        MEMORY_DIR,
        `.${MEMORY_FILE}.conflict-local-${Date.now()}-${randomUUID()}`,
      );
      await writeRaw(stalePath, `${TEST_MARKER} stale conflict`);
      const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await fs.utimes(stalePath, stale, stale);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} triggers conflict pruning`);

      const names = await fs.readdir(MEMORY_DIR);
      const conflicts = names.filter((name) => /^\.MEMORY\.md\.conflict-local-\d+-[0-9a-f-]{36}$/.test(name));
      const regularConflicts = [];
      for (const name of conflicts) {
        const artifactPath = path.join(MEMORY_DIR, name);
        if ((await fs.lstat(artifactPath)).isFile()) regularConflicts.push(artifactPath);
      }
      const stats = await Promise.all(regularConflicts.map((artifactPath) => fs.stat(artifactPath)));
      assert.ok(!names.includes(path.basename(stalePath)));
      assert.ok(regularConflicts.length <= 32);
      assert.ok(stats.reduce((total, stat) => total + stat.size, 0) <= 64 * 1024 * 1024);
      assert.equal(await fs.readFile(externalPath, "utf-8"), `${TEST_MARKER} outside data`);
      if (process.platform !== "win32") assert.equal((await fs.lstat(symlinkPath)).isSymbolicLink(), true);
    });

    it("commits and observes a mutation when published-link cleanup fails", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing before cleanup failure`);

      let cleanupAttempted = false;
      let observed = false;
      (store as any).unlinkPublishedTempLink = async () => {
        cleanupAttempted = true;
        throw new Error("injected published-link cleanup failure");
      };
      store.setMutationObserver(async () => {
        observed = true;
        return null;
      });

      const result = await store.add("memory", `${TEST_MARKER} committed despite cleanup failure`);

      assert.equal(result.success, true);
      assert.equal(cleanupAttempted, true);
      assert.equal(observed, true);
      assert.match(await readRaw(memoryPath), /committed despite cleanup failure/);
    });

    it("replays when an editor recreates the path after displacement", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);

      const originalRead = (store as any).readFileState.bind(store);
      let injected = false;
      (store as any).readFileState = async (filePath: string) => {
        const state = await originalRead(filePath);
        if (!injected && path.basename(filePath).startsWith(`.${MEMORY_FILE}.recovery-`)) {
          injected = true;
          await writeRaw(memoryPath, `${TEST_MARKER} recreated editor`);
        }
        return state;
      };

      const result = await store.add("memory", `${TEST_MARKER} local add`);

      assert.equal(result.success, true);
      assert.equal(injected, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /recreated editor/);
      assert.match(raw, /local add/);
    });

    it("serializes concurrent mutations of the same canonical target", async () => {
      const firstStore = new MemoryStore(makeConfig());
      const secondStore = new MemoryStore(makeConfig());
      await Promise.all([firstStore.loadFromDisk(), secondStore.loadFromDisk()]);

      const originalSave = (firstStore as any).saveToDisk.bind(firstStore);
      let releaseFirst!: () => void;
      const firstCanSave = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const firstEnteredSave = new Promise<void>((resolve) => { firstEntered = resolve; });
      (firstStore as any).saveToDisk = async (target: "memory") => {
        firstEntered();
        await firstCanSave;
        await originalSave(target);
      };

      const first = firstStore.add("memory", `${TEST_MARKER} first writer`);
      await firstEnteredSave;
      const second = secondStore.add("memory", `${TEST_MARKER} second writer`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseFirst();
      await Promise.all([first, second]);

      const raw = await readRaw(memoryPath);
      assert.match(raw, /first writer/);
      assert.match(raw, /second writer/);
    });

    it("allows different targets to mutate concurrently", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const originalSave = (store as any).saveToDisk.bind(store);
      let releaseMemory!: () => void;
      const memoryCanSave = new Promise<void>((resolve) => { releaseMemory = resolve; });
      let memoryEntered!: () => void;
      const memoryEnteredSave = new Promise<void>((resolve) => { memoryEntered = resolve; });
      (store as any).saveToDisk = async (target: "memory" | "user") => {
        if (target === "memory") {
          memoryEntered();
          await memoryCanSave;
        }
        await originalSave(target);
      };

      const memoryWrite = store.add("memory", `${TEST_MARKER} blocked memory writer`);
      await memoryEnteredSave;
      const userWrite = store.add("user", `${TEST_MARKER} independent user writer`);
      const outcome = await Promise.race([
        userWrite.then(() => "completed" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
      ]);
      releaseMemory();
      const [, userResult] = await Promise.all([memoryWrite, userWrite]);

      assert.equal(outcome, "completed");
      assert.equal(userResult.success, true);
      assert.match(await readRaw(userPath), /independent user writer/);
    });

    it("reloads truncated disk before add and reports disk-backed usage", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 5000 }));
      await store.loadFromDisk();
      for (let i = 0; i < 5; i++) {
        await store.add("memory", `${TEST_MARKER} seed-${i}-${"x".repeat(40)}`);
      }
      assert.ok((await fs.stat(memoryPath)).size > 0);

      await writeRaw(memoryPath, "");
      const result = await store.add("memory", `${TEST_MARKER} after-truncate`);

      assert.equal(result.success, true);
      assert.equal(result.entry_count, 1);
      assert.match(result.usage ?? "", /^1% — \d+\/5000 chars$/);
      assert.equal(await readRaw(memoryPath), `${TEST_MARKER} after-truncate <!-- created=${new Date().toISOString().split("T")[0]}, last=${new Date().toISOString().split("T")[0]} -->`);
    });

    it("retries when an external truncate lands immediately after publish", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);

      const originalSave = (store as any).saveToDisk.bind(store);
      let injected = false;
      (store as any).saveToDisk = async (target: "memory") => {
        await originalSave(target);
        if (!injected) {
          injected = true;
          await writeRaw(memoryPath, "");
        }
      };

      const observed: number[] = [];
      store.setMutationObserver(async (_target, entries) => {
        observed.push(entries.length);
        return null;
      });

      const result = await store.add("memory", `${TEST_MARKER} post-race`);

      assert.equal(result.success, true);
      assert.equal(injected, true);
      assert.equal(result.entry_count, 1);
      assert.match(await readRaw(memoryPath), /post-race/);
      assert.doesNotMatch(await readRaw(memoryPath), /existing/);
      assert.deepEqual(observed.at(-1), 1);
    });

    it("reconciles the mutation observer from disk even when add fails", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 300, autoConsolidate: false }));
      await store.loadFromDisk();
      for (let i = 0; i < 20; i++) {
        const fill = await store.add("memory", `${TEST_MARKER} fill-${i}-${"x".repeat(50)}`);
        if (!fill.success) break;
      }
      assert.ok((store as any).memoryEntries.length >= 2, "expected the store to be near capacity");

      const staleEntries = [...(store as any).memoryEntries];
      await writeRaw(memoryPath, "");

      const originalSync = (store as any).syncTargetFromDiskIfChanged.bind(store);
      let restaleOnce = true;
      (store as any).syncTargetFromDiskIfChanged = async (target: "memory") => {
        await originalSync(target);
        if (restaleOnce) {
          restaleOnce = false;
          (store as any).setEntries("memory", staleEntries);
        }
      };

      const observed: number[] = [];
      store.setMutationObserver(async (_target, entries) => {
        observed.push(entries.length);
        return null;
      });

      const result = await store.add("memory", `${TEST_MARKER} nope`);

      assert.equal(result.success, false);
      assert.match(result.error ?? "", /would exceed the limit/);
      assert.equal(await readRaw(memoryPath), "");
      assert.deepEqual((store as any).memoryEntries, []);
      assert.deepEqual(observed, [0]);
    });

    it("reconciles observer after exhausted external-write retries", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);

      const originalRead = (store as any).readFileState.bind(store);
      const canonicalMemoryPath = await fs.realpath(memoryPath);
      let lieCounter = 0;
      (store as any).readFileState = async (filePath: string) => {
        const state = await originalRead(filePath);
        // Rotate MEMORY.md fingerprint on every read so saveToDisk always
        // mismatches the fingerprint stamped by the previous sync/retry.
        if (filePath === canonicalMemoryPath) {
          lieCounter += 1;
          return { ...state, fingerprint: `mismatch-${lieCounter}-${state.fingerprint}` };
        }
        return state;
      };

      const observed: string[][] = [];
      store.setMutationObserver(async (_target, entries) => {
        observed.push([...entries]);
        return null;
      });

      const result = await store.add("memory", `${TEST_MARKER} local add`);

      assert.equal(result.success, false);
      assert.match(result.error ?? "", /changed repeatedly/);
      assert.match(result.error ?? "", /memory-sync-markdown/);
      assert.ok(observed.length >= 1);
      // Finalize reads through the spy; use the unspy path for disk truth.
      const diskEntries = (await originalRead(canonicalMemoryPath)).entries;
      assert.deepEqual(observed[observed.length - 1], diskEntries);
      assert.deepEqual((store as any).memoryEntries, diskEntries);
    });

  });
});
