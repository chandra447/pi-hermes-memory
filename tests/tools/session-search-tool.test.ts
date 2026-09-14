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
    assert.match(schema, /"minimum":1/);
    assert.match(schema, /"maximum":20/);
  });

  it("clamps negative and fractional legacy limits before querying", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "bounded-limit-session",
        project: "bounded-project",
        cwd: "/work/bounded",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: Array.from({ length: 25 }, (_, index) => ({
          id: `bounded-limit-message-${index}`,
          role: "assistant",
          content: `bounded-limit-needle ${index}`,
          timestamp: `2026-07-11T00:${String(index).padStart(2, "0")}:00.000Z`,
        })),
      });
      registerSessionSearchTool(mockPi, dbManager);

      const negative = await captured.execute("tc-negative-limit", {
        query: "bounded-limit-needle",
        limit: -1,
      });
      const fractional = await captured.execute("tc-fractional-limit", {
        query: "bounded-limit-needle",
        limit: 2.9,
      });

      assert.strictEqual(negative.details.count, 1);
      assert.strictEqual(fractional.details.count, 2);
      assert.ok(negative.content[0].text.length < 2_000);
      assert.ok(fractional.content[0].text.length < 4_000);
    } finally {
      dbManager.close();
    }
  });

  it("clamps non-finite snippetChars values instead of propagating NaN", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "nan-snippet-session",
        project: "nan-snippet-project",
        cwd: "/work/nan-snippet",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "nan-snippet-message",
          role: "assistant",
          content: `needle ${"a".repeat(500)}`,
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);

      const nanResult = await captured.execute("tc-nan-snippet", {
        query: "needle",
        snippetChars: NaN,
      });
      const infinityResult = await captured.execute("tc-infinity-snippet", {
        query: "needle",
        snippetChars: Infinity,
      });
      const largeResult = await captured.execute("tc-large-snippet", {
        query: "needle",
        snippetChars: 999_999_999,
      });

      assert.strictEqual(nanResult.details.snippetChars, 1_200);
      assert.strictEqual(infinityResult.details.snippetChars, 1_200);
      assert.strictEqual(largeResult.details.snippetChars, 4_000);
      assert.ok(Number.isFinite(nanResult.details.snippetChars));
      assert.match(nanResult.content[0].text, /needle a+/);
    } finally {
      dbManager.close();
    }
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
      // Seed a pre-cap database row directly. New ingestion paths must cap
      // message content, but search output still needs to stay bounded for
      // oversized rows written by older extension versions.
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "oversized-session",
        "oversized-project",
        "/work/oversized",
        "2026-07-11T00:00:00.000Z",
        null,
        1,
      );
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        "oversized-message",
        "oversized-session",
        "assistant",
        oversizedContent,
        "2026-07-11T00:01:00.000Z",
      );
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

  it("windows an oversized legacy snippet around the first effective term hit, not the head", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);
    // 'the' lands near the head, the real needle ~4 KB deep: a window anchored
    // on raw tokens (stop words kept) would show the head; the effective term
    // set must anchor the window on the needle's region.
    const windowedContent =
      `the preamble filler. ${"a".repeat(4_000)} ` +
      `zz-camera-restart-marker zz-restart ` +
      `${"b".repeat(4_000)}`;

    try {
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "windowed-session",
        "windowed-project",
        "/work/windowed",
        "2026-07-11T00:00:00.000Z",
        null,
        1,
      );
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        "windowed-message",
        "windowed-session",
        "assistant",
        windowedContent,
        "2026-07-11T00:01:00.000Z",
      );
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-windowed", {
        query: "the camera restart",
      });
      const output = result.content[0].text as string;

      assert.ok(output.includes("zz-camera-restart-marker"), "window must include the anchor hit region");
      assert.ok(output.startsWith("Found 1 results"));
      const snippetLine = output.split("\n").find((line: string) => line.startsWith("… "));
      assert.ok(snippetLine, "a mid-body window must be marked as elided");
      assert.ok(!snippetLine.includes("camera preamble filler"), "window must not start at the message head");
      assert.match(output, /truncated/);
      assert.match(output, /chars total/);
      assert.strictEqual(result.details.truncatedCount, 1);
      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
    } finally {
      dbManager.close();
    }
  });

  it("keeps surrogate pairs whole at window edges", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);
    // The needle sits just past a long emoji run: hit - LEAD lands mid-run,
    // on an odd UTF-16 offset — inside a surrogate pair unless the window is
    // nudged. Each emoji is 2 UTF-16 units; 3_999 emojis end at an odd offset.
    const emojiRun = "\u{1F600}".repeat(3_999);
    // One filler unit after the run puts the needle on an odd offset, so the
    // window start (hit - 200) lands on the LOW half of an emoji pair, and an
    // odd snippetChars puts the window end on a LOW half too — both edge
    // nudges must fire for the sliced text to contain only whole code points.
    const surrogateContent = `needl ${emojiRun} x tail-needle`;

    try {
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "surrogate-session",
        "surrogate-project",
        "/work/surrogate",
        "2026-07-11T00:00:00.000Z",
        null,
        1,
      );
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        "surrogate-message",
        "surrogate-session",
        "assistant",
        surrogateContent,
        "2026-07-11T00:01:00.000Z",
      );
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-surrogate", {
        query: "tail-needle",
        snippetChars: 101,
      });
      const output = result.content[0].text as string;

      const snippetLine = output.split("\n").find((line: string) => line.startsWith("… "))!;
      // The elided prefix means the window started mid-body; after it every
      // character must be a complete code point — no lone surrogate halves.
      const windowText = snippetLine.slice(2).split("\n...")[0];
      assert.ok(windowText.length > 0);
      const completeUnits = /^(?:[\u0000-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(windowText);
      assert.ok(completeUnits, "window edge must not split a surrogate pair");
      assert.match(output, /truncated/);
    } finally {
      dbManager.close();
    }
  });

  it("bounds the zero-result response without echoing an oversized query", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "zero-result-session",
        project: "zero-result-project",
        cwd: "/work/zero-result",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "zero-result-message",
          role: "assistant",
          content: "indexed haystack",
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);
      const query = `${" ".repeat(60_000)}missing`;

      const result = await captured.execute("tc-zero-result", { query });
      const output = result.content[0].text as string;

      assert.strictEqual(result.details.count, 0);
      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.strictEqual(output.includes(query), false);
      assert.ok(JSON.stringify(result.details).length < 1_000);
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
