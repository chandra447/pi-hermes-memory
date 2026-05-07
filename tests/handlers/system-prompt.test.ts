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

let TEST_MEMORY_DIR = "";

const testConfig = (): MemoryConfig => ({
  memoryCharLimit: 5000,
  userCharLimit: 5000,
  projectCharLimit: 5000,
  nudgeInterval: 10,
  reviewEnabled: true,
  flushOnCompact: true,
  flushOnShutdown: true,
  flushMinTurns: 6,
  candidateShadowMode: true,
    candidateConfidenceThreshold: 0.75,
  memoryDir: TEST_MEMORY_DIR,
});

// ─── Helpers ───

async function writeMemory(content: string): Promise<void> {
  await fs.writeFile(path.join(TEST_MEMORY_DIR, "MEMORY.md"), content, "utf-8");
}

async function writeUser(content: string): Promise<void> {
  await fs.writeFile(path.join(TEST_MEMORY_DIR, "USER.md"), content, "utf-8");
}

async function clearFiles(): Promise<void> {
  try { await fs.unlink(path.join(TEST_MEMORY_DIR, "MEMORY.md")); } catch { /* ignore */ }
  try { await fs.unlink(path.join(TEST_MEMORY_DIR, "USER.md")); } catch { /* ignore */ }
}

const SEPARATOR = "═".repeat(46);

// ─── Tests ───

describe("system prompt injection", () => {
  before(async () => {
    TEST_MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sp-test-"));
    await fs.mkdir(TEST_MEMORY_DIR, { recursive: true });
  });

  after(async () => {
    try {
      await fs.rm(TEST_MEMORY_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("before_agent_start appends memory block when memory has entries", async () => {
    await writeMemory("Project uses Bun runtime" + ENTRY_DELIMITER + "Prefers tabs over spaces");
    await writeUser("");

    const store = new MemoryStore(testConfig());
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();
    assert.ok(prompt.length > 0, "formatForSystemPrompt should return non-empty string when memory has entries");

    await clearFiles();
  });

  it("memory block includes header with usage percentage", async () => {
    const entry = "Test entry for header check";
    await writeMemory(entry);
    await writeUser("");

    const store = new MemoryStore(testConfig());
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();

    assert.match(prompt, /MEMORY \(your personal notes\)/, "should contain MEMORY header");
    assert.match(prompt, /\d+% — \d+\/\d+ chars/, "should contain usage percentage and char count");

    await clearFiles();
  });

  it("frozen snapshot isolation — entries added after load are NOT in system prompt", async () => {
    await writeMemory("Original entry");
    await writeUser("");

    const store = new MemoryStore(testConfig());
    await store.loadFromDisk();

    const prompt1 = store.formatForSystemPrompt();
    assert.ok(prompt1.includes("Original entry"), "snapshot should contain original entry");

    // Add a new entry in-memory (simulating a tool call that adds memory mid-session)
    store.add("memory", "New entry after load");
    // Wait for async write
    await new Promise((r) => setTimeout(r, 250));

    // formatForSystemPrompt should still return the snapshot from load time
    const prompt2 = store.formatForSystemPrompt();
    assert.ok(!prompt2.includes("New entry after load"), "snapshot should NOT contain entry added after load");

    // Create a SECOND store that loads the updated file
    const store2 = new MemoryStore(testConfig());
    await store2.loadFromDisk();
    const prompt3 = store2.formatForSystemPrompt();
    assert.ok(prompt3.includes("New entry after load"), "fresh load should see the new entry");

    await clearFiles();
  });

  it("empty memory files produce no block", async () => {
    await clearFiles();

    const store = new MemoryStore(testConfig());
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();
    assert.strictEqual(prompt, "", "formatForSystemPrompt should return empty string when no entries");
  });

  it("memory block format matches Hermes — separator and header structure", async () => {
    const entry = "Uses Docker for local dev";
    await writeMemory(entry);
    await writeUser("");

    const store = new MemoryStore(testConfig());
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();

    // Should contain the exact separator line
    assert.ok(prompt.includes(SEPARATOR), "should contain separator line");

    // Should contain the MEMORY header
    assert.match(prompt, /MEMORY \(your personal notes\)/, "should contain MEMORY header");

    // Should contain the entry content
    assert.ok(prompt.includes(entry), "should contain the entry text");

    await clearFiles();
  });

  it("user profile block included when USER.md has entries", async () => {
    await writeMemory("");
    await writeUser("User prefers dark mode");

    const store = new MemoryStore(testConfig());
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();

    assert.match(prompt, /USER PROFILE \(who the user is\)/, "should contain USER PROFILE header");
    assert.ok(prompt.includes("User prefers dark mode"), "should contain user profile content");

    await clearFiles();
  });

  it("both blocks separated by double newline", async () => {
    await writeMemory("Memory entry one");
    await writeUser("User profile entry");

    const store = new MemoryStore(testConfig());
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
