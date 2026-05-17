import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { searchSessionAnchors } from "../../src/store/session-anchor-search.js";

let ROOT_DIR = "";

function makeSessionsDir(): string {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-anchor-search-test-"));
  return ROOT_DIR;
}

function writeJsonl(relativePath: string, events: unknown[]): string {
  const filePath = path.join(ROOT_DIR, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return filePath;
}

function message(timestamp: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "message",
    timestamp,
    sessionId: "session-1",
    cwd: "/work/project",
    message: { role: "user", content: text },
    ...extra,
  };
}

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = "";
});

describe("searchSessionAnchors", () => {
  it("accepts a minimal time window and caps limit", () => {
    const sessionsDir = makeSessionsDir();
    const events = Array.from({ length: 210 }, (_, index) => (
      index % 2 === 0
        ? message(`2026-05-15T12:${String(index % 60).padStart(2, "0")}:00.000Z`, `event ${index}`)
        : message(`2026-05-14T12:${String(index % 60).padStart(2, "0")}:00.000Z`, `outside ${index}`)
    ));
    writeJsonl("session.jsonl", events);

    const result = searchSessionAnchors("from: 2026-05-15\nto: 2026-05-15\nlimit: 200", { sessionsDir });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ranges.length, 100);
    assert.strictEqual(result.ranges[0].startLine, 1);
    assert.strictEqual(result.ranges[0].reason, "time window");
  });

  it("returns diagnostics for duplicate, unknown, empty, and unconstrained requests", () => {
    const sessionsDir = makeSessionsDir();

    assert.match(searchSessionAnchors("", { sessionsDir }).message ?? "", /markdown is required/);
    assert.match(searchSessionAnchors("since: 2026-05-15", { sessionsDir }).message ?? "", /Invalid field 'since'/);
    assert.match(searchSessionAnchors("from: 2026-05-15\nfrom: 2026-05-16", { sessionsDir }).message ?? "", /Duplicate field 'from'/);
    assert.match(searchSessionAnchors("limit: 0", { sessionsDir }).message ?? "", /Invalid limit/);
    assert.match(searchSessionAnchors("all:\n- ", { sessionsDir }).message ?? "", /Invalid markdown line|Empty term/);
    assert.match(searchSessionAnchors("limit: 10", { sessionsDir }).message ?? "", /needs at least one constraint/);
  });

  it("measures broadness with scan caps instead of rejecting request shape", () => {
    const sessionsDir = makeSessionsDir();
    writeJsonl("one.jsonl", [
      message("2026-05-15T10:00:00.000Z", "a"),
      message("2026-05-15T11:00:00.000Z", "b"),
    ]);
    writeJsonl("two.jsonl", [message("2026-05-15T12:00:00.000Z", "a")]);

    const shortTerm = searchSessionAnchors("any:\n- a", { sessionsDir });
    assert.strictEqual(shortTerm.success, true);
    assert.strictEqual(shortTerm.ranges.length, 2);

    const fileCap = searchSessionAnchors("any:\n- a", { sessionsDir, maxFiles: 1 });
    assert.strictEqual(fileCap.success, false);
    assert.match(fileCap.message ?? "", /2 session files exceed/);

    const lineCap = searchSessionAnchors("any:\n- a", { sessionsDir, maxLines: 1 });
    assert.strictEqual(lineCap.success, false);
    assert.match(lineCap.message ?? "", /scan cap/);
  });

  it("allows cwd-only requests as bounded source anchors", () => {
    const sessionsDir = makeSessionsDir();
    writeJsonl("session.jsonl", [
      message("2026-05-15T10:00:00.000Z", "inside cwd"),
      message("2026-05-15T11:00:00.000Z", "outside cwd", { cwd: "/other/project" }),
    ]);

    const result = searchSessionAnchors("cwd: /work/project", { sessionsDir });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ranges.length, 1);
    assert.strictEqual(result.ranges[0].startLine, 1);
    assert.strictEqual(result.ranges[0].reason, "cwd");
  });

  it("carries the real session event id onto matching message ranges", () => {
    const sessionsDir = makeSessionsDir();
    writeJsonl("session.jsonl", [
      { type: "session", version: 1, id: "session-real", timestamp: "2026-05-15T09:00:00.000Z", cwd: "/work/project" },
      { type: "message", id: "message-1", parentId: "session-real", timestamp: "2026-05-15T10:00:00.000Z", message: { role: "user", content: "needle" } },
    ]);

    const result = searchSessionAnchors("any:\n- needle", { sessionsDir });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ranges.length, 1);
    assert.strictEqual(result.ranges[0].sessionId, "session-real");
    assert.strictEqual(result.ranges[0].startLine, 2);
  });

  it("does not match metadata fields as text", () => {
    const sessionsDir = makeSessionsDir();
    writeJsonl("session.jsonl", [
      message("2026-05-15T10:00:00.000Z", "actual content"),
    ]);

    const result = searchSessionAnchors("any:\n- /work/project", { sessionsDir });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ranges.length, 0);
  });

  it("returns contiguous timestamped ranges for time-window-only queries", () => {
    const sessionsDir = makeSessionsDir();
    const filePath = writeJsonl("session.jsonl", [
      message("2026-05-14T12:00:00.000Z", "before"),
      message("2026-05-15T10:00:00.000Z", "inside one"),
      message("2026-05-15T11:00:00.000Z", "inside two"),
      message("2026-05-16T12:00:00.000Z", "after"),
    ]);

    const result = searchSessionAnchors("from: 2026-05-15\nto: 2026-05-15", { sessionsDir });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.ranges.map((range) => ({ path: range.path, startLine: range.startLine, endLine: range.endLine })), [
      { path: filePath, startLine: 2, endLine: 3 },
    ]);
    assert.strictEqual(result.ranges[0].startTime, "2026-05-15T10:00:00.000Z");
    assert.strictEqual(result.ranges[0].endTime, "2026-05-15T11:00:00.000Z");
  });

  it("matches all and any terms as case-insensitive literal substrings", () => {
    const sessionsDir = makeSessionsDir();
    writeJsonl("session.jsonl", [
      message("2026-05-15T10:00:00.000Z", "Alpha beta phrase"),
      message("2026-05-15T11:00:00.000Z", "Contains GAMMA only"),
      message("2026-05-15T12:00:00.000Z", "nothing useful"),
    ]);

    const allResult = searchSessionAnchors("all:\n- alpha beta", { sessionsDir });
    assert.strictEqual(allResult.success, true);
    assert.strictEqual(allResult.ranges.length, 1);
    assert.strictEqual(allResult.ranges[0].startLine, 1);
    assert.strictEqual(allResult.ranges[0].reason, "matched all: alpha beta");

    const anyResult = searchSessionAnchors("any:\n- gamma\n- delta", { sessionsDir });
    assert.strictEqual(anyResult.success, true);
    assert.strictEqual(anyResult.ranges.length, 1);
    assert.strictEqual(anyResult.ranges[0].startLine, 2);
    assert.strictEqual(anyResult.ranges[0].reason, "matched any: gamma");
  });

  it("removes ranges containing exclude terms", () => {
    const sessionsDir = makeSessionsDir();
    writeJsonl("session.jsonl", [
      message("2026-05-15T10:00:00.000Z", "alpha keep"),
      message("2026-05-15T10:30:00.000Z", "separator"),
      message("2026-05-15T11:00:00.000Z", "alpha secret drop"),
    ]);

    const result = searchSessionAnchors("any:\n- alpha\nexclude:\n- secret", { sessionsDir });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ranges.length, 1);
    assert.strictEqual(result.ranges[0].startLine, 1);
  });

  it("returns single-line hits as startLine equal to endLine", () => {
    const sessionsDir = makeSessionsDir();
    writeJsonl("nested/session.jsonl", [
      message("2026-05-15T10:00:00.000Z", "first"),
      message("2026-05-15T11:00:00.000Z", "needle"),
    ]);

    const result = searchSessionAnchors("any:\n- needle", { sessionsDir });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ranges.length, 1);
    assert.strictEqual(result.ranges[0].startLine, 2);
    assert.strictEqual(result.ranges[0].endLine, 2);
  });

  it("fails on invalid JSON lines with path and line", () => {
    const sessionsDir = makeSessionsDir();
    const filePath = path.join(sessionsDir, "bad.jsonl");
    fs.writeFileSync(filePath, `${JSON.stringify(message("2026-05-15T10:00:00.000Z", "ok"))}\n{bad json}\n`);

    const result = searchSessionAnchors("from: 2026-05-15", { sessionsDir });

    assert.strictEqual(result.success, false);
    assert.match(result.message ?? "", new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2`));
  });
});
