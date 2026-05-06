import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { indexSession } from "../../src/store/session-indexer.js";
import { extractCandidatesFromIndexedMessages } from "../../src/store/candidate-extractor.js";
import { listCandidates } from "../../src/store/candidate-store.js";
import type { ParsedSession } from "../../src/store/session-parser.js";

function makeSession(id: string, project: string, messages: ParsedSession["messages"]): ParsedSession {
  return {
    id,
    project,
    cwd: `/tmp/${project}`,
    startedAt: "2026-05-06T00:00:00Z",
    endedAt: null,
    messages,
  };
}

describe("candidate-extractor", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-extractor-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts repeated corrections, failure-fix pairs, and repeated tool sequences", () => {
    const session = makeSession("s1", "pi-hermes-memory", [
      { id: "m1", role: "user", content: "no, use yarn instead", timestamp: "2026-05-06T00:00:01Z" },
      { id: "m2", role: "assistant", content: "updated package manager", timestamp: "2026-05-06T00:00:02Z", toolCalls: ["edit"] },
      { id: "m3", role: "user", content: "no, use yarn instead", timestamp: "2026-05-06T00:00:03Z" },
      { id: "m4", role: "user", content: "tests are failing with an error", timestamp: "2026-05-06T00:00:04Z" },
      { id: "m5", role: "assistant", content: "fixed, tests passed", timestamp: "2026-05-06T00:00:05Z", toolCalls: ["read", "edit", "bash"] },
      { id: "m6", role: "assistant", content: "done, tests passed", timestamp: "2026-05-06T00:00:06Z", toolCalls: ["read", "edit", "bash"] },
    ]);

    indexSession(dbManager, session);

    const result = extractCandidatesFromIndexedMessages(dbManager);
    assert.equal(result.sessionsScanned, 1);
    assert.equal(result.messagesScanned, 6);
    assert.equal(result.candidatesAdded, 3);
    assert.equal(result.duplicatesSkipped, 0);
    assert.equal(result.byRule.repeated_correction, 1);
    assert.equal(result.byRule.failure_fix_pair, 1);
    assert.equal(result.byRule.repeated_tool_sequence, 1);

    const candidates = listCandidates(dbManager);
    assert.equal(candidates.length, 3);
    assert.ok(candidates.some(c => c.extractorRule === "repeated_correction"));
    assert.ok(candidates.some(c => c.extractorRule === "failure_fix_pair"));
    assert.ok(candidates.some(c => c.extractorRule === "repeated_tool_sequence"));
  });

  it("skips duplicates on repeat extraction runs", () => {
    const session = makeSession("s2", "repo-x", [
      { id: "u1", role: "user", content: "i said use pnpm", timestamp: "2026-05-06T00:00:01Z" },
      { id: "a1", role: "assistant", content: "updated", timestamp: "2026-05-06T00:00:02Z" },
      { id: "u2", role: "user", content: "i said use pnpm", timestamp: "2026-05-06T00:00:03Z" },
    ]);

    indexSession(dbManager, session);

    const first = extractCandidatesFromIndexedMessages(dbManager);
    const second = extractCandidatesFromIndexedMessages(dbManager);

    assert.equal(first.candidatesAdded, 1);
    assert.equal(second.candidatesAdded, 0);
    assert.ok(second.duplicatesSkipped >= 1);
  });

  it("uses deterministic fallback message hash when message_id is missing", () => {
    const db = dbManager.getDb();

    db.prepare(`
      INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("s3", "repo-y", "/tmp/repo-y", "2026-05-06T00:00:00Z", null, 2);

    db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(null, "s3", "user", "wrong, use strict mode", "2026-05-06T00:00:01Z", null);

    db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(null, "s3", "user", "wrong, use strict mode", "2026-05-06T00:00:02Z", null);

    const result = extractCandidatesFromIndexedMessages(dbManager);
    assert.equal(result.candidatesAdded, 1);

    const [candidate] = listCandidates(dbManager, { project: "repo-y" });
    assert.ok(candidate);
    assert.ok(candidate.messageId?.startsWith("hash:"));
  });
});
