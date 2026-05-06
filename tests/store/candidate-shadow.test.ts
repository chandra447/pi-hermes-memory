import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildCandidateShadowReport, extractShadowCandidatesFromSession } from "../../src/store/candidate-shadow.js";
import type { ParsedSession } from "../../src/store/session-parser.js";

function writeSessionFile(dir: string, fileName: string, lines: unknown[]): string {
  const filePath = path.join(dir, fileName);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("candidate-shadow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-shadow-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractShadowCandidatesFromSession finds explicit tags, failure-fix, and repeated tool sequence", () => {
    const session: ParsedSession = {
      id: "s-1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-05-06T00:00:00.000Z",
      endedAt: null,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "#learn use dedicated migration scripts",
          timestamp: "2026-05-06T00:00:01.000Z",
        },
        {
          id: "m2",
          role: "user",
          content: "tests are failing with sqlite error",
          timestamp: "2026-05-06T00:00:02.000Z",
        },
        {
          id: "m3",
          role: "assistant",
          content: "fixed and tests passed",
          timestamp: "2026-05-06T00:00:03.000Z",
          toolCalls: ["read", "edit", "bash"],
        },
        {
          id: "m4",
          role: "assistant",
          content: "updated, now working",
          timestamp: "2026-05-06T00:00:04.000Z",
          toolCalls: ["read", "edit", "bash"],
        },
      ],
    };

    const candidates = extractShadowCandidatesFromSession(session);
    const rules = candidates.map((c) => c.extractorRule);

    assert.ok(rules.includes("explicit_tag"));
    assert.ok(rules.includes("failure_fix_pair"));
    assert.ok(rules.includes("repeated_tool_sequence"));
  });

  it("normalizes repeated corrections and avoids reusing one assistant fix for multiple failures", () => {
    const session: ParsedSession = {
      id: "s-2",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-05-06T00:00:00.000Z",
      endedAt: null,
      messages: [
        { id: "u1", role: "user", content: "Don't use Teal for branding.", timestamp: "2026-05-06T00:00:01.000Z" },
        { id: "u2", role: "user", content: "dont use teal for branding!", timestamp: "2026-05-06T00:00:02.000Z" },
        { id: "u3", role: "user", content: "build failed with sqlite issue", timestamp: "2026-05-06T00:00:03.000Z" },
        { id: "u4", role: "user", content: "tests failing with migration error", timestamp: "2026-05-06T00:00:04.000Z" },
        { id: "a1", role: "assistant", content: "fixed and tests passed", timestamp: "2026-05-06T00:00:05.000Z" },
      ],
    };

    const candidates = extractShadowCandidatesFromSession(session);
    const corrections = candidates.filter((c) => c.extractorRule === "repeated_correction");
    const failureFix = candidates.filter((c) => c.extractorRule === "failure_fix_pair");

    assert.equal(corrections.length, 1);
    assert.equal(failureFix.length, 1);
  });

  it("buildCandidateShadowReport scans files, dedupes candidates, and returns top rules", () => {
    const projectDirA = path.join(tmpDir, "--Users-test-project-a--");
    const projectDirB = path.join(tmpDir, "--Users-test-project-b--");
    fs.mkdirSync(projectDirA, { recursive: true });
    fs.mkdirSync(projectDirB, { recursive: true });

    const sharedLines = [
      { type: "session", id: "session-1", timestamp: "2026-05-06T00:00:00.000Z", cwd: "/Users/test/project-a" },
      {
        type: "message",
        id: "msg-1",
        timestamp: "2026-05-06T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "#learn prefer pnpm lockfile checks" }] },
      },
      {
        type: "message",
        id: "msg-2",
        timestamp: "2026-05-06T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    ];

    // duplicate candidate across files (same session/message/rule)
    writeSessionFile(projectDirA, "a.jsonl", sharedLines);
    writeSessionFile(projectDirB, "b.jsonl", sharedLines);

    const report = buildCandidateShadowReport(tmpDir);

    assert.equal(report.filesScanned, 2);
    assert.equal(report.sessionsScanned, 2);
    assert.equal(report.rawCandidateCount, 2);
    assert.equal(report.candidateCount, 1);
    assert.equal(report.duplicateCount, 1);
    assert.ok(report.duplicateRate > 0);
    assert.equal(report.lowConfidenceCount, 0);
    assert.ok(report.topRules.some((r) => r.rule === "explicit_tag" && r.count >= 1));
    assert.equal(report.errors.length, 0);
  });

  it("is read-only and does not mutate session files", () => {
    const projectDir = path.join(tmpDir, "--Users-test-project-a--");
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = writeSessionFile(projectDir, "a.jsonl", [
      { type: "session", id: "session-1", timestamp: "2026-05-06T00:00:00.000Z", cwd: "/Users/test/project-a" },
      {
        type: "message",
        id: "msg-1",
        timestamp: "2026-05-06T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "#skill capture this" }] },
      },
    ]);

    const before = fs.readFileSync(filePath, "utf-8");
    const beforeStat = fs.statSync(filePath).mtimeMs;

    const report = buildCandidateShadowReport(tmpDir);

    const after = fs.readFileSync(filePath, "utf-8");
    const afterStat = fs.statSync(filePath).mtimeMs;

    assert.equal(report.candidateCount, 1);
    assert.equal(before, after);
    assert.equal(afterStat, beforeStat);
  });
});
