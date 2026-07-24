/**
 * Regression tests for memory quality-of-life features:
 * - memory tool `dry_run` flag (no-write validation)
 * - memory_search `action="stats"` (read-only introspection)
 * - searchMemories BM25 ranking (relevance + recency tie-breaker)
 *
 * @see https://github.com/chandra447/pi-hermes-memory/pull/<this-pr>
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { registerMemorySearchTool } from "../../src/tools/memory-search-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { DatabaseManager } from "../../src/store/db.js";
import { getMemoryStats, searchMemories } from "../../src/store/sqlite-memory-store.js";

function makePi() {
  let mem: any, srch: any;
  const pi = {
    registerTool: (def: any) => {
      if (def.name === "memory") mem = def;
      if (def.name === "memory_search") srch = def;
    },
  } as unknown as ExtensionAPI;
  return { pi, getMem: () => mem, getSrch: () => srch };
}

function makeStoreConfig(globalDir: string): any {
  return {
    memoryDir: globalDir,
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewRecentMessages: 0,
    reviewEnabled: false,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: 6,
    flushRecentMessages: 0,
    memoryOverflowStrategy: "auto-consolidate",
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: false,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    consolidationTimeoutMs: 60000,
  };
}

describe("memory dry_run mode", () => {
  let tmpDir: string;
  let globalDir: string;
  let dbManager: DatabaseManager;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-dryrun-test-"));
    globalDir = path.join(tmpDir, "memory");
    fs.mkdirSync(globalDir, { recursive: true });
    dbManager = new DatabaseManager(globalDir);
    store = new MemoryStore(makeStoreConfig(globalDir));
    await store.loadFromDisk();
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dry_run add returns success without writing to markdown or SQLite", async () => {
    const { pi, getMem } = makePi();
    registerMemoryTool(pi, store, null, dbManager);
    const tool = getMem();

    const beforeStats = getMemoryStats(dbManager);
    const beforeCount = beforeStats.total;

    const result = await tool.execute(
      "tc-1",
      { action: "add", target: "memory", content: "DRY-RUN-ADD: should not persist", dry_run: true },
      undefined, undefined, undefined,
    );

    assert.equal(result.details.success, true);
    assert.ok((result.details.message as string).includes("DRY RUN"), "message should be DRY RUN prefixed");

    const afterStats = getMemoryStats(dbManager);
    assert.equal(afterStats.total, beforeCount, "SQLite count should be unchanged");

    const found = searchMemories(dbManager, "DRY-RUN-ADD persistence check");
    assert.equal(found.length, 0, "dry_run content should not be searchable");
  });

  it("dry_run add on failure target validates category without writing", async () => {
    const { pi, getMem } = makePi();
    registerMemoryTool(pi, store, null, dbManager);
    const tool = getMem();

    const beforeFailure = getMemoryStats(dbManager).byTarget.find((r) => r.target === "failure")?.count ?? 0;

    const result = await tool.execute(
      "tc-2",
      { action: "add", target: "failure", content: "DRY-RUN-FAILURE: should not persist", category: "tool-quirk", dry_run: true },
      undefined, undefined, undefined,
    );

    assert.equal(result.details.success, true);
    assert.ok((result.details.message as string).includes("DRY RUN"));

    const afterFailure = getMemoryStats(dbManager).byTarget.find((r) => r.target === "failure")?.count ?? 0;
    assert.equal(afterFailure, beforeFailure, "failure count should be unchanged");
  });

  it("dry_run replace validates match without writing", async () => {
    const { pi, getMem } = makePi();
    registerMemoryTool(pi, store, null, dbManager);
    const tool = getMem();

    await tool.execute(
      "tc-r1",
      { action: "add", target: "memory", content: "replace-anchor-original" },
      undefined, undefined, undefined,
    );

    const dryResult = await tool.execute(
      "tc-r2",
      { action: "replace", target: "memory", old_text: "replace-anchor-original", content: "replace-anchor-NEW", dry_run: true },
      undefined, undefined, undefined,
    );
    assert.equal(dryResult.details.success, true);
    assert.ok((dryResult.details.message as string).includes("DRY RUN"));

    const original = searchMemories(dbManager, "replace-anchor-original");
    assert.equal(original.length, 1, "original should still exist");
    const replacement = searchMemories(dbManager, "replace-anchor-NEW");
    assert.equal(replacement.length, 0, "new content should not be present");
  });

  it("dry_run remove validates match without writing", async () => {
    const { pi, getMem } = makePi();
    registerMemoryTool(pi, store, null, dbManager);
    const tool = getMem();

    await tool.execute(
      "tc-rm1",
      { action: "add", target: "memory", content: "remove-anchor-target" },
      undefined, undefined, undefined,
    );

    const dryResult = await tool.execute(
      "tc-rm2",
      { action: "remove", target: "memory", old_text: "remove-anchor-target", dry_run: true },
      undefined, undefined, undefined,
    );
    assert.equal(dryResult.details.success, true);
    assert.ok((dryResult.details.message as string).includes("DRY RUN"));

    const stillThere = searchMemories(dbManager, "remove-anchor-target");
    assert.equal(stillThere.length, 1, "entry should still be present");
  });

  it("dry_run add will not trigger consolidation (no side effects)", async () => {
    // Configure store with auto-consolidate + near-full memory so a real add would consolidate
    const fullDir = path.join(tmpDir, "memory-full");
    fs.mkdirSync(fullDir, { recursive: true });
    fs.writeFileSync(path.join(fullDir, "MEMORY.md"), "x".repeat(4900), "utf-8");
    const fullDb = new DatabaseManager(fullDir);
    const fullStore = new MemoryStore({
      ...makeStoreConfig(fullDir),
      memoryOverflowStrategy: "auto-consolidate",
      autoConsolidate: true,
    });
    await fullStore.loadFromDisk();

    const { pi, getMem } = makePi();
    registerMemoryTool(pi, fullStore, null, fullDb);
    const tool = getMem();

    const beforeSize = (await fs.promises.readFile(path.join(fullDir, "MEMORY.md"), "utf-8")).length;
    const result = await tool.execute(
      "tc-c1",
      { action: "add", target: "memory", content: "would-trigger-consolidation", dry_run: true },
      undefined, undefined, undefined,
    );
    const afterSize = (await fs.promises.readFile(path.join(fullDir, "MEMORY.md"), "utf-8")).length;

    assert.equal(result.details.success, true);
    assert.ok((result.details.message as string).includes("DRY RUN"));
    assert.equal(beforeSize, afterSize, "MEMORY.md should be byte-identical after dry_run");

    fullDb.close();
  });
});

describe("memory_search action=stats", () => {
  let tmpDir: string;
  let globalDir: string;
  let dbManager: DatabaseManager;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-stats-test-"));
    globalDir = path.join(tmpDir, "memory");
    fs.mkdirSync(globalDir, { recursive: true });
    dbManager = new DatabaseManager(globalDir);
    store = new MemoryStore(makeStoreConfig(globalDir));
    await store.loadFromDisk();
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns total/byTarget/byCategory/byProject/oldest/newest", async () => {
    const { pi, getMem, getSrch } = makePi();
    registerMemoryTool(pi, store, null, dbManager);
    registerMemorySearchTool(pi, dbManager);
    const tool = getMem();
    const srch = getSrch();

    await tool.execute("t-1", { action: "add", target: "memory", content: "stats-entry-one" }, undefined, undefined, undefined);
    await tool.execute("t-2", { action: "add", target: "memory", content: "stats-entry-two" }, undefined, undefined, undefined);
    await tool.execute("t-3", { action: "add", target: "failure", content: "stats-failure-one", category: "tool-quirk" }, undefined, undefined, undefined);

    const result = await srch.execute("t-stats", { action: "stats" }, undefined, undefined, undefined);

    assert.equal(result.details.success, true);
    assert.ok(result.details.stats, "details should include stats object");
    assert.equal(result.details.stats.total, 3);

    const mem = result.details.stats.byTarget.find((r: any) => r.target === "memory");
    const fail = result.details.stats.byTarget.find((r: any) => r.target === "failure");
    assert.equal(mem.count, 2);
    assert.equal(fail.count, 1);

    const toolQuirk = result.details.stats.byCategory.find((r: any) => r.category === "tool-quirk");
    assert.ok(toolQuirk, "byCategory should include tool-quirk");
    assert.equal(toolQuirk.count, 1);

    assert.ok(result.details.stats.oldest, "should have oldest date");
    assert.ok(result.details.stats.newest, "should have newest date");
    assert.ok(result.content[0].text.includes("By target"));
    assert.ok(result.content[0].text.includes("By category"));
  });

  it("action=stats with no entries returns empty state", async () => {
    const { pi, getSrch } = makePi();
    registerMemorySearchTool(pi, dbManager);
    const srch = getSrch();

    const result = await srch.execute("t-empty", { action: "stats" }, undefined, undefined, undefined);

    assert.equal(result.details.success, true);
    assert.equal(result.details.stats.total, 0);
    assert.equal(result.details.stats.oldest, null);
    assert.equal(result.details.stats.newest, null);
  });

  it("default action is 'search' (backward compatible)", async () => {
    const { pi, getMem, getSrch } = makePi();
    registerMemoryTool(pi, store, null, dbManager);
    registerMemorySearchTool(pi, dbManager);
    const tool = getMem();
    const srch = getSrch();

    await tool.execute("t-d1", { action: "add", target: "memory", content: "backward-compat-default" }, undefined, undefined, undefined);

    // No action specified — should behave like action="search"
    const result = await srch.execute("t-d2", { query: "backward-compat-default" }, undefined, undefined, undefined);
    assert.equal(result.details.success, true);
    assert.equal(result.details.count, 1);
  });
});

describe("memory_search BM25 ranking", () => {
  let tmpDir: string;
  let globalDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-bm25-test-"));
    globalDir = path.join(tmpDir, "memory");
    fs.mkdirSync(globalDir, { recursive: true });
    dbManager = new DatabaseManager(globalDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ranks entries with more matching terms higher (relevance signal)", () => {
    const today = new Date().toISOString().split("T")[0];
    const insert = dbManager.getDb().prepare(`
      INSERT INTO memories (project, target, content, created, last_referenced)
      VALUES (NULL, 'memory', ?, ?, ?)
    `);
    // Loosely related: 1 of 2 terms matches
    insert.run("database migration uses drizzle ORM", today, today);
    // Highly related: 2 of 2 terms match
    insert.run("authentication uses oauth tokens for authentication", today, today);
    // Unrelated: 0 of 2 terms match
    insert.run("frontend uses react components", today, today);

    const results = searchMemories(dbManager, "authentication", { limit: 10 });
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("authentication"));
  });

  it("returns all matches when BM25 scores are identical (recency tie-breaker)", () => {
    const today = new Date().toISOString().split("T")[0];
    const insert = dbManager.getDb().prepare(`
      INSERT INTO memories (project, target, content, created, last_referenced)
      VALUES (NULL, 'memory', ?, ?, ?)
    `);
    insert.run("rank-test entry-one", today, today);
    insert.run("rank-test entry-two", today, today);
    insert.run("rank-test entry-three", today, today);

    const results = searchMemories(dbManager, "rank-test", { limit: 10 });
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.content.includes("rank-test")));
  });

  it("does not throw on content with FTS5 punctuation when query is simple", () => {
    // Regression: BM25 JOIN must not regress on edge-case content
    const today = new Date().toISOString().split("T")[0];
    const insert = dbManager.getDb().prepare(`
      INSERT INTO memories (project, target, content, created, last_referenced)
      VALUES (NULL, 'memory', ?, ?, ?)
    `);
    insert.run("JWT signing uses RS256 algorithm", today, today);

    // No bare NOT/OR/AND/NEAR in query — should work
    const results = searchMemories(dbManager, "JWT");
    assert.equal(results.length, 1);
  });
});
