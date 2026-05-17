import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSessionSearchTool } from "../../src/tools/session-search-tool.js";

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
