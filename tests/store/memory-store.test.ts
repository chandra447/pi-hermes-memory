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
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
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

// ─── Tests ───

describe("MemoryStore", { concurrency: 1 }, () => {
  let memoryPath = "";
  let userPath = "";

  before(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-test-"));
    memoryPath = path.join(MEMORY_DIR, MEMORY_FILE);
    userPath = path.join(MEMORY_DIR, USER_FILE);
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
    await new Promise((r) => setTimeout(r, 250));
    // Remove again in case a pending write sneaked in during the wait
    await removeFile(memoryPath);
    await removeFile(userPath);
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
      const result = await await store.add("memory", entry);
      await settle();

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
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
      const limit = 200;
      const store = new MemoryStore(makeConfig({ memoryCharLimit: limit }));
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} ${"a".repeat(limit - 50)}`;
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

  // ─── replace() tests ───

  describe("replace()", () => {
    it("updates entry in file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} uses vim`);
      await settle();

      const result = store.replace("memory", `${TEST_MARKER} uses vim`, `${TEST_MARKER} uses neovim`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.message, "Entry replaced.");

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} uses vim`));
      assert.ok(raw.includes(`${TEST_MARKER} uses neovim`));
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} some entry`);
      await settle();

      const result = store.replace("memory", "nonexistent substring", "new content");
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

      const result = store.replace("memory", "config:", `${TEST_MARKER} unified config`);
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("Multiple entries matched"));
      assert.ok(result.matches);
      assert.equal(result.matches!.length, 2);
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = store.replace("memory", "  ", "new content");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });

    it("returns error for empty new_content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = store.replace("memory", `${TEST_MARKER} some entry`, "   ");

      assert.ok(!result.success);
      assert.equal(result.error, "new_content cannot be empty. Use 'remove' to delete entries.");
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

      const result = store.remove("memory", `${TEST_MARKER} to be removed`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.message, "Entry removed.");
      assert.equal(result.entry_count, 1);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} to be removed`));
      assert.ok(raw.includes(`${TEST_MARKER} to keep`));
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} existing`);
      await settle();

      const result = store.remove("memory", "nonexistent");
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = store.remove("memory", "  ");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
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

    it("includes both memory and user blocks when both have entries", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} mem data`);
      await writeRaw(userPath, `${TEST_MARKER} user data`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes("MEMORY"));
      assert.ok(result.includes("USER PROFILE"));
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

      assert.deepEqual(parsed, entries);
    });

    it("file is empty after all entries are removed", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} temporary entry`);
      await settle();

      let raw = await readRaw(memoryPath);
      assert.ok(raw.length > 0);

      store.remove("memory", `${TEST_MARKER} temporary entry`);
      await settle();

      raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
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
});
