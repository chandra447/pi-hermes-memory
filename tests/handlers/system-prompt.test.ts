/**
 * Integration tests for system prompt injection behavior.
 *
 * Tests the frozen snapshot mechanism: MemoryStore.formatForSystemPrompt()
 * returns the state captured at loadFromDisk() time, not current in-memory state.
 * Also validates the block format (separator, header, usage percentage).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../src/store/memory-store.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Test config ───

const TEST_MEMORY_DIR = path.join(os.homedir(), ".pi", "agent", "memory");

const testConfig: MemoryConfig = {
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  nudgeInterval: 10,
  reviewEnabled: true,
  flushOnCompact: true,
  flushOnShutdown: true,
  flushMinTurns: 6,
};

// ─── Helpers ───

/** Unique test tag to avoid collisions with real memory files. */
const TEST_TAG = `__test_sp_${Date.now()}`;

let originalMemory = "";
let originalUser = "";

async function backupFiles(): Promise<void> {
  for (const [file, setter] of [
    ["MEMORY.md", (v: string) => { originalMemory = v; }],
    ["USER.md", (v: string) => { originalUser = v; }],
  ] as const) {
    try {
      const v = await fs.readFile(path.join(TEST_MEMORY_DIR, file), "utf-8");
      setter(v);
    } catch {
      setter("");
    }
  }
}

async function restoreFiles(): Promise<void> {
  const memoryPath = path.join(TEST_MEMORY_DIR, "MEMORY.md");
  const userPath = path.join(TEST_MEMORY_DIR, "USER.md");
  await fs.writeFile(memoryPath, originalMemory, "utf-8");
  await fs.writeFile(userPath, originalUser, "utf-8");
}

async function writeMemory(content: string): Promise<void> {
  await fs.writeFile(path.join(TEST_MEMORY_DIR, "MEMORY.md"), content, "utf-8");
}

async function writeUser(content: string): Promise<void> {
  await fs.writeFile(path.join(TEST_MEMORY_DIR, "USER.md"), content, "utf-8");
}

async function clearFiles(): Promise<void> {
  await writeMemory("");
  await writeUser("");
}

const SEPARATOR = "═".repeat(46);

// ─── Tests ───

describe("system prompt injection", () => {
  before(async () => {
    await fs.mkdir(TEST_MEMORY_DIR, { recursive: true });
    await backupFiles();
  });

  after(async () => {
    await restoreFiles();
  });

  it("before_agent_start appends memory block when memory has entries", async () => {
    await writeMemory("Project uses Bun runtime" + ENTRY_DELIMITER + "Prefers tabs over spaces");
    await writeUser("");

    const store = new MemoryStore(testConfig);
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();
    assert.ok(prompt.length > 0, "formatForSystemPrompt should return non-empty string when memory has entries");

    await clearFiles();
  });

  it("memory block includes header with usage percentage", async () => {
    const entry = "Test entry for header check";
    await writeMemory(entry);
    await writeUser("");

    const store = new MemoryStore(testConfig);
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();

    // Header format: MEMORY (your personal notes) [X% — Y/Z chars]
    const headerPattern = /MEMORY \(your personal notes\) \[\d+% — \d+\/\d+ chars\]/;
    assert.match(prompt, headerPattern, "should contain MEMORY header with usage percentage");

    await clearFiles();
  });

  it("frozen snapshot isolation — entries added after load are NOT in system prompt", async () => {
    await writeMemory("Original entry from disk");
    await writeUser("");

    const store = new MemoryStore(testConfig);
    await store.loadFromDisk();

    // Capture the frozen prompt
    const frozenPrompt = store.formatForSystemPrompt();

    // Write new content directly to disk (simulates an external change)
    await writeMemory("New entry written after snapshot was captured");

    // Create a SECOND store that loads the updated file
    const store2 = new MemoryStore(testConfig);
    await store2.loadFromDisk();
    const updatedPrompt = store2.formatForSystemPrompt();

    // The ORIGINAL store's snapshot should NOT reflect the disk change
    const originalPromptAgain = store.formatForSystemPrompt();
    assert.equal(originalPromptAgain, frozenPrompt, "original snapshot should be unchanged");
    assert.ok(!originalPromptAgain.includes("New entry written"), "frozen snapshot should not contain new entry");

    // The NEW store should see the updated content
    assert.ok(updatedPrompt.includes("New entry written"), "new store should see updated content");

    await clearFiles();
  });

  it("empty memory files produce no block", async () => {
    await clearFiles();

    const store = new MemoryStore(testConfig);
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();
    assert.equal(prompt, "", "formatForSystemPrompt should return empty string when both files are empty");

    await clearFiles();
  });

  it("memory block format matches Hermes — separator and header structure", async () => {
    const entry = "Entry for format validation";
    await writeMemory(entry);
    await writeUser("");

    const store = new MemoryStore(testConfig);
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();

    // Should start with separator line (46 ═ chars)
    assert.ok(prompt.startsWith(SEPARATOR), "should start with 46-char ═ separator");

    // Second line is the header
    const lines = prompt.split("\n");
    assert.equal(lines[0], SEPARATOR, "first line is separator");
    assert.match(lines[1], /^MEMORY \(your personal notes\) \[/, "second line is MEMORY header");
    assert.equal(lines[2], SEPARATOR, "third line is separator");

    // Fourth line onward is content
    assert.ok(lines[3].includes(entry), "content follows header block");

    await clearFiles();
  });

  it("user profile block included when USER.md has entries", async () => {
    await writeMemory("Agent note");
    await writeUser("User prefers dark mode");

    const store = new MemoryStore(testConfig);
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();

    // Should contain both MEMORY and USER blocks
    assert.match(prompt, /MEMORY \(your personal notes\)/, "should contain MEMORY header");
    assert.match(prompt, /USER PROFILE \(who the user is\)/, "should contain USER PROFILE header");

    await clearFiles();
  });

  it("both blocks separated by double newline", async () => {
    await writeMemory("Memory entry one");
    await writeUser("User profile entry");

    const store = new MemoryStore(testConfig);
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();

    // The MEMORY block and USER block should be separated by exactly \n\n
    const memoryIdx = prompt.indexOf("MEMORY");
    const userIdx = prompt.indexOf("USER PROFILE");
    assert.ok(memoryIdx < userIdx, "MEMORY block should come before USER PROFILE block");

    // Find where the memory block ends and user block begins
    // Memory block: separator\nheader\nseparator\ncontent
    // Then \n\n
    // Then user block: separator\nheader\nseparator\ncontent
    const separator = SEPARATOR;
    // After the content of memory block, there should be \n\n before the user separator
    assert.ok(prompt.includes("\n\n" + separator), "blocks should be separated by double newline");

    await clearFiles();
  });
});
