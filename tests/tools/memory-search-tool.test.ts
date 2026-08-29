import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { addMemory } from "../../src/store/sqlite-memory-store.js";
import { normalizeMemoryLookupText } from "../../src/store/memory-lookup.js";
import { registerMemorySearchTool } from "../../src/tools/memory-search-tool.js";

let ROOT_DIR = "";

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = "";
});

function makeDbManager(): DatabaseManager {
  ROOT_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-memory-search-tool-test-"),
  );
  return new DatabaseManager(ROOT_DIR);
}

describe("registerMemorySearchTool", () => {
  it("returns a broader natural-language match when strict term matching misses", async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "user's name is Naruto", "user");

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;

    registerMemorySearchTool(mockPi, dbManager);

    const result = await captured.execute("tc-1", {
      query: "name identity Naruto",
      target: "user",
    });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /Naruto/);

    dbManager.close();
  });

  it("labels every result with its mutation target and unambiguous scope", async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "global deployment convention");
    addMemory(dbManager, "user deployment preference", "user");
    addMemory(dbManager, "failure deployment lesson", "failure");
    addMemory(
      dbManager,
      "project deployment convention",
      "memory",
      "project-a",
    );
    addMemory(
      dbManager,
      "project failure deployment lesson",
      "failure",
      "project-a",
    );

    let captured: any;
    registerMemorySearchTool(
      {
        registerTool: (def: any) => {
          captured = def;
        },
      } as any,
      dbManager,
    );

    const result = await captured.execute("tc-1", { query: "deployment" });
    const text = result.content[0].text;

    assert.match(
      text,
      /scope=global \[target=memory\] global deployment convention/,
    );
    assert.match(
      text,
      /scope=global \[target=user\] user deployment preference/,
    );
    assert.match(
      text,
      /scope=global \[target=failure\] failure deployment lesson/,
    );
    assert.match(
      text,
      /scope=project:project-a \[target=project\] project deployment convention/,
    );
    assert.match(
      text,
      /scope=project:project-a \[target=failure\] project failure deployment lesson/,
    );

    dbManager.close();
  });

  it("keeps copied results reversible when a project name contains brackets", async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "literal project entry", "memory", "foo] bar");

    let captured: any;
    registerMemorySearchTool(
      {
        registerTool: (def: any) => {
          captured = def;
        },
      } as any,
      dbManager,
    );

    const result = await captured.execute("tc-1", { query: "literal" });
    const firstResultLine = result.content[0].text
      .split("\n")
      .find((line: string) => line.startsWith("🧠"))!;

    assert.match(
      firstResultLine,
      /scope=project:foo%5D%20bar \[target=project\]/,
    );
    assert.equal(
      normalizeMemoryLookupText(firstResultLine),
      "literal project entry",
    );

    dbManager.close();
  });

  it("recovers from a corrupt database during a search read", async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "auth setup note");
    const dbPath = path.join(ROOT_DIR, "sessions.db");
    dbManager.close();

    // Corrupt the leaf page of the memories table: open() succeeds (header
    // intact), but the stats/search reads fail with SQLITE_CORRUPT — exactly
    // the operation-time read gap this test covers.
    const probe = new DatabaseManager(ROOT_DIR);
    const row = probe
      .getDb()
      .prepare(
        "SELECT pageno FROM dbstat WHERE name = 'memories' AND pagetype = 'leaf' ORDER BY pageno DESC LIMIT 1",
      )
      .get() as { pageno: number } | undefined;
    probe.close();
    if (!row) throw new Error("dbstat found no leaf page for memories table");
    const pageOffset = (row.pageno - 1) * 4096;
    const fd = fs.openSync(dbPath, "r+");
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, pageOffset + 16);
    buf[0] = 0;
    fs.writeSync(fd, buf, 0, 4096, pageOffset);
    fs.closeSync(fd);

    const dbManager2 = new DatabaseManager(ROOT_DIR);
    let captured: any;
    registerMemorySearchTool(
      {
        registerTool: (def: any) => {
          captured = def;
        },
      } as any,
      dbManager2,
    );

    const result = await captured.execute("tc-1", { query: "auth" });
    // After read-time recovery rebuilds the database, the store is empty:
    // either the "no store yet" or the "no results" message must appear.
    assert.match(result.content[0].text, /No memories/);
    dbManager2.close();
  });
});
