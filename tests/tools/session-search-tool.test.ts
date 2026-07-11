import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSessionSearchTool } from "../../src/tools/session-search-tool.js";
import { DatabaseManager } from "../../src/store/db.js";
import { indexSession } from "../../src/store/session-indexer.js";

let ROOT_DIR = "";

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = "";
});

function makeSessionsDir(): string {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-tool-test-"));
  return ROOT_DIR;
}

describe("registerSessionSearchTool", () => {
  it("registers the legacy query schema by default", () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    registerSessionSearchTool(mockPi, {} as any);

    const schema = JSON.stringify(captured.parameters);
    assert.strictEqual(captured.name, "session_search");
    assert.match(schema, /query/);
    assert.doesNotMatch(schema, /markdown/);
  });

  it("bounds oversized legacy results and reports truncation without duplicating output in details", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);
    const oversizedContent = `needle ${"x".repeat(6_000_000)}`;

    try {
      indexSession(dbManager, {
        id: "oversized-session",
        project: "oversized-project",
        cwd: "/work/oversized",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "oversized-message",
          role: "assistant",
          content: oversizedContent,
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-oversized", { query: "needle" });
      const output = result.content[0].text as string;

      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.match(output, /truncated/);
      assert.match(output, /6000007 chars total/);
      assert.strictEqual(result.details.truncatedCount, 1);
      assert.strictEqual(result.details.outputChars, output.length);
      assert.strictEqual(result.details.output, undefined);
      assert.ok(JSON.stringify(result.details).length < 1_000);
    } finally {
      dbManager.close();
    }
  });

  it("offers a bounded snippetChars override for legacy searches", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "bounded-override-session",
        project: "bounded-project",
        cwd: "/work/bounded",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "bounded-override-message",
          role: "assistant",
          content: `needle ${"y".repeat(10_000)}`,
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);

      assert.match(JSON.stringify(captured.parameters), /snippetChars/);
      const result = await captured.execute("tc-bounded-override", {
        query: "needle",
        snippetChars: 2_000,
      });

      assert.strictEqual(result.details.snippetChars, 2_000);
      assert.strictEqual(result.details.truncatedCount, 1);
      assert.match(result.content[0].text, /10007 chars total/);
      assert.ok(result.content[0].text.length < 3_000);
    } finally {
      dbManager.close();
    }
  });

  it("enforces a hard 50 KiB ceiling across many large legacy results", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "aggregate-ceiling-session",
        project: "aggregate-project",
        cwd: "/work/aggregate",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: Array.from({ length: 20 }, (_, index) => ({
          id: `aggregate-message-${index}`,
          role: "assistant",
          content: `needle-${index} ${"z".repeat(10_000)}`,
          timestamp: `2026-07-11T00:${String(index).padStart(2, "0")}:00.000Z`,
        })),
      });
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-aggregate-ceiling", {
        query: "needle",
        limit: 20,
        snippetChars: 4_000,
      });
      const output = result.content[0].text as string;

      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.strictEqual(result.details.outputTruncated, true);
      assert.match(output, /output truncated/);
      assert.match(output, /refine the query or lower the result limit/);
    } finally {
      dbManager.close();
    }
  });

  it("registers and executes the anchor markdown-only schema when configured", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const sessionsDir = makeSessionsDir();
    const filePath = path.join(sessionsDir, "session.jsonl");
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: "message",
      timestamp: "2026-05-15T10:00:00.000Z",
      sessionId: "session-1",
      cwd: "/work/project",
      message: { role: "user", content: "needle" },
    })}\n`);

    registerSessionSearchTool(mockPi, {} as any, { variant: "anchors" }, { sessionsDir });

    const schema = JSON.stringify(captured.parameters);
    assert.strictEqual(captured.name, "session_search");
    assert.match(schema, /markdown/);
    assert.doesNotMatch(schema, /query/);
    assert.match(captured.description, /all terms must match/);
    assert.match(captured.description, /any requires at least one listed term/);
    assert.match(captured.description, /exclude removes matching ranges/);
    assert.match(captured.description, /Output is plain text: count, optional message/);
    assert.match(captured.description, /path:startLine-endLine with a short reason/);
    assert.match(captured.description, /Example:\nfrom: 2026-05-14/);
    assert.match(captured.promptGuidelines.join("\n"), /Use all for required terms/);

    const empty = await captured.execute("tc-1", { markdown: "" });
    assert.strictEqual(empty.details.success, false);
    assert.strictEqual(empty.details.message, "markdown is required");

    const result = await captured.execute("tc-2", { markdown: "any:\n- needle" });
    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.deepStrictEqual(result.details.ranges.map((range: any) => ({
      path: range.path,
      startLine: range.startLine,
      endLine: range.endLine,
      reason: range.reason,
    })), [{ path: filePath, startLine: 1, endLine: 1, reason: "matched any: needle" }]);
    assert.strictEqual(result.details.output, result.content[0].text);
    assert.match(result.content[0].text, /^count: 1\nanchors:\n-/);
    assert.match(result.content[0].text, new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1-1 — matched any: needle`));
    assert.doesNotMatch(result.content[0].text, /"ranges"/);
    assert.doesNotMatch(result.content[0].text, /"startLine"/);
    assert.doesNotMatch(result.content[0].text, /"sessionId"/);
  });
});
