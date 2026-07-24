/**
 * Unit tests for memory tool registration and execute function.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { DatabaseManager } from "../../src/store/db.js";
import { getMemories, syncMemoryEntry } from "../../src/store/sqlite-memory-store.js";
import { ENTRY_DELIMITER, MEMORY_FILE } from "../../src/constants.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("registerMemoryTool", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tool-test-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers tool with name 'memory' and correct parameters", () => {
    const registeredTools: any[] = [];

    const mockPi = {
      registerTool: (def: any) => {
        registeredTools.push(def);
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({ success: true, target: "memory", entries: ["test"], usage: "10% — 10/100 chars", entry_count: 1 }),
      replace: () => ({ success: true, target: "memory", entries: [], usage: "0% — 0/100 chars", entry_count: 0 }),
      remove: () => ({ success: true, target: "memory", entries: [], usage: "0% — 0/100 chars", entry_count: 0 }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);

    assert.strictEqual(registeredTools.length, 1, "should register exactly one tool");
    const tool = registeredTools[0];
    assert.strictEqual(tool.name, "memory", "tool name should be 'memory'");
    assert.strictEqual(tool.label, "Memory", "tool label should be 'Memory'");
    assert.ok(tool.description.length > 0, "description should not be empty");
    assert.ok(tool.promptSnippet.length > 0, "promptSnippet should not be empty");
    assert.ok(Array.isArray(tool.promptGuidelines), "promptGuidelines should be an array");
    assert.ok(tool.parameters, "parameters schema should be defined");
  });

  it("execute add returns JSON with usage field", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        usage: "5% — 110/5000 chars",
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    assert.strictEqual(result.content[0].type, "text", "content should be text type");
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true, "result should be success");
    assert.ok(parsed.usage.includes("chars"), "usage should contain 'chars'");
    assert.ok(parsed.usage.includes("5000"), "usage should show total limit");
    assert.strictEqual(parsed.entry_count, 1, "entry_count should be 1");
    assert.strictEqual(result.details.success, true, "details should mirror result");
  });

  it("execute add with FIFO evictions returns normal text with full rotated entries", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const evictedOne = "First rotated entry with full detail.";
    const evictedTwo = "Second rotated entry with\nmultiple lines preserved.";
    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["New entry"],
        usage: "90% — 4500/5000 chars",
        entry_count: 1,
        message: "Memory updated. Rotated 2 older entries to stay within the limit.",
        evicted_entries: [evictedOne, evictedTwo],
        evicted_count: 2,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "New entry" }, undefined as any, undefined as any, undefined as any);

    const text = result.content[0].text;
    assert.throws(() => JSON.parse(text));
    assert.match(text, /Memory updated\. Rotated 2 older entries/);
    assert.match(text, /Rotated active memory entries:/);
    assert.ok(text.includes(`1. ${evictedOne}`));
    assert.ok(text.includes(`2. ${evictedTwo}`));
    assert.match(text, /If one of these entries should stay active, add it again\./);
    assert.match(text, /Usage: 90%/);
    assert.deepStrictEqual(result.details.evicted_entries, [evictedOne, evictedTwo]);
  });

  it("syncs successful adds into SQLite", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        usage: "5% — 110/5000 chars",
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    const results = getMemories(dbManager, { target: 'memory', project: null });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'Entry one');
  });

  it("prunes same-scope SQLite orphans after a Markdown mutation", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (definition: any) => { capturedResult = definition; },
    } as unknown as ExtensionAPI;
    const store = new MemoryStore({
      memoryMode: "policy-only",
      memoryCharLimit: 5000,
      userCharLimit: 5000,
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
      consolidationTimeoutMs: 60000,
      memoryDir: tmpDir,
    });
    await store.loadFromDisk();
    syncMemoryEntry(dbManager, { content: "orphaned row", target: "memory", project: null });

    registerMemoryTool(mockPi, store, null, dbManager);
    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "authoritative Markdown row" },
      undefined,
      undefined,
      undefined,
    );

    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: null }).map((entry) => entry.content),
      ["authoritative Markdown row"],
    );
  });

  it("reconciles SQLite from fresh authoritative Markdown state", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (definition: any) => { capturedResult = definition; },
    } as unknown as ExtensionAPI;
    const store = new MemoryStore({
      memoryMode: "policy-only",
      memoryCharLimit: 5000,
      userCharLimit: 5000,
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
      consolidationTimeoutMs: 60000,
      memoryDir: tmpDir,
    });
    await store.loadFromDisk();

    const originalSave = (store as any).saveToDisk.bind(store);
    (store as any).saveToDisk = async (target: "memory") => {
      await originalSave(target);
      const markdownPath = path.join(tmpDir, MEMORY_FILE);
      const existing = fs.readFileSync(markdownPath, "utf-8");
      const date = new Date().toISOString().split("T")[0];
      fs.writeFileSync(markdownPath, `${existing}${ENTRY_DELIMITER}newer writer <!-- created=${date}, last=${date} -->`);
      syncMemoryEntry(dbManager, { content: "newer writer", target: "memory", project: null });
    };

    registerMemoryTool(mockPi, store, null, dbManager);
    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "first writer" },
      undefined,
      undefined,
      undefined,
    );

    assert.deepStrictEqual(
      getMemories(dbManager, { target: "memory", project: null }).map((entry) => entry.content).sort(),
      ["first writer", "newer writer"],
    );
  });

  it("removes FIFO-evicted entries from the SQLite mirror", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    syncMemoryEntry(dbManager, {
      content: "Older entry",
      target: "memory",
      project: null,
    });
    syncMemoryEntry(dbManager, {
      content: "Older entry with extra detail",
      target: "memory",
      project: null,
    });

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["New entry"],
        usage: "90% — 4500/5000 chars",
        entry_count: 1,
        message: "Memory updated. Rotated 1 older entry to stay within the limit.",
        evicted_entries: ["Older entry"],
        evicted_count: 1,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "New entry" }, undefined as any, undefined as any, undefined as any);

    assert.match(result.content[0].text, /Rotated active memory entries:/);
    const rows = getMemories(dbManager, { target: "memory", project: null });
    assert.deepStrictEqual(rows.map((row) => row.content).sort(), ["New entry", "Older entry with extra detail"].sort());
  });

  it("uses project scope when removing FIFO-evicted SQLite entries", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    syncMemoryEntry(dbManager, {
      content: "Shared wording",
      target: "memory",
      project: null,
    });
    syncMemoryEntry(dbManager, {
      content: "Shared wording",
      target: "memory",
      project: "project-a",
    });

    const mockProjectStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Project replacement"],
        usage: "90% — 4500/5000 chars",
        entry_count: 1,
        message: "Memory updated. Rotated 1 older entry to stay within the limit.",
        evicted_entries: ["Shared wording"],
        evicted_count: 1,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, {} as MemoryStore, mockProjectStore, dbManager, "project-a");
    await capturedResult.execute("tc-1", { action: "add", target: "project", content: "Project replacement" }, undefined as any, undefined as any, undefined as any);

    const globalRows = getMemories(dbManager, { target: "memory", project: null });
    const projectRows = getMemories(dbManager, { target: "memory", project: "project-a" });
    assert.deepStrictEqual(globalRows.map((row) => row.content), ["Shared wording"]);
    assert.deepStrictEqual(projectRows.map((row) => row.content), ["Project replacement"]);
  });

  it("maps project target to SQLite project scope", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const addTargets: string[] = [];
    const mockProjectStore = {
      add: (target: string) => {
        addTargets.push(target);
        return {
          success: true,
          target,
          entries: ["Project entry"],
          usage: "2% — 20/5000 chars",
          entry_count: 1,
          message: "Entry added.",
        };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, {} as MemoryStore, mockProjectStore, dbManager, 'project-a');
    const result = await capturedResult.execute("tc-1", { action: "add", target: "project", content: "Project entry" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.target, 'project');
    assert.strictEqual(result.details.target, 'project');
    assert.deepStrictEqual(addTargets, ['memory']);

    const results = getMemories(dbManager, { project: 'project-a', target: 'memory' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'Project entry');
  });

  it("returns a warning instead of failing when SQLite sync errors", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        usage: "5% — 110/5000 chars",
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    const failingDbManager = {
      getDb: () => {
        throw new Error('sqlite unavailable');
      },
    } as unknown as DatabaseManager;

    registerMemoryTool(mockPi, mockStore, null, failingDbManager);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.match(parsed.message, /SQLite search sync failed/);
    assert.match(parsed.warning, /sqlite unavailable/);
  });

  it("does not sync to SQLite when core Markdown add fails", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: false,
        error: "Memory at 5000/5000 chars. Adding this entry would exceed the limit.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, dbManager);
    const result = await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "overflow entry" },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);

    const rows = getMemories(dbManager, { target: "memory", project: null });
    assert.strictEqual(rows.length, 0, "SQLite should stay unchanged when core add fails");
  });

  it("execute add without content returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false, "should fail without content");
    assert.ok(parsed.error.includes("required"), "error should mention required content");
  });

  it("execute replace without old_text returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "replace", target: "memory", content: "new" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false, "should fail without old_text");
    assert.ok(parsed.error.includes("old_text"), "error should mention old_text");
  });

  it("execute remove without old_text returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "remove", target: "memory" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false, "should fail without old_text");
    assert.ok(parsed.error.includes("old_text"), "error should mention old_text");
  });

  it("execute delegates replace to store.replace", async () => {
    let capturedResult: any;
    let replaceArgs: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      replace: (...args: any[]) => {
        replaceArgs = args;
        return { success: true, target: "memory", entries: ["new"], usage: "5% — 110/5000 chars", entry_count: 1 };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    await capturedResult.execute("tc-1", { action: "replace", target: "memory", content: "new", old_text: "old" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(replaceArgs, ["memory", "old", "new", { dryRun: false }], "should pass target, old_text, content, options to store.replace");
  });

  it("execute delegates remove to store.remove", async () => {
    let capturedResult: any;
    let removeArgs: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      remove: (...args: any[]) => {
        removeArgs = args;
        return { success: true, target: "memory", entries: [], usage: "0% — 0/5000 chars", entry_count: 0 };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    await capturedResult.execute("tc-1", { action: "remove", target: "memory", old_text: "old entry" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(removeArgs, ["memory", "old entry", { dryRun: false }], "should pass target, old_text, options to store.remove");
  });
});
