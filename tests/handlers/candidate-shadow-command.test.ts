import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { registerCandidateShadowRunCommand } from "../../src/handlers/candidate-shadow-command.js";

let handlers: Record<string, { handler: Function; description: string }>;
let notifyCalls: Array<{ msg: string; level: string }>;

function createMockPi() {
  return {
    on: () => {},
    registerTool: () => {},
    registerCommand: (name: string, def: { description: string; handler: Function }) => {
      handlers[name] = { handler: def.handler, description: def.description };
    },
  } as any;
}

function createMockCtx() {
  return {
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  } as any;
}

async function writeSessionFile(projectDir: string, name: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(projectDir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await fs.writeFile(path.join(projectDir, name), body, "utf-8");
}

describe("candidate shadow command", () => {
  beforeEach(() => {
    handlers = {};
    notifyCalls = [];
  });

  it("registers /memory-candidates-shadow-run command", () => {
    const pi = createMockPi();
    registerCandidateShadowRunCommand(pi, { candidateShadowMode: true } as any);

    assert.ok(handlers["memory-candidates-shadow-run"]);
    assert.ok(handlers["memory-candidates-shadow-run"].description.includes("read-only"));
  });

  it("warns and exits when candidateShadowMode is disabled", async () => {
    const pi = createMockPi();
    registerCandidateShadowRunCommand(pi, { candidateShadowMode: false } as any);

    const ctx = createMockCtx();
    await handlers["memory-candidates-shadow-run"].handler(undefined, ctx);

    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0].level, "warning");
    assert.ok(notifyCalls[0].msg.includes("disabled"));
  });

  it("prints report metrics in read-only mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-shadow-cmd-"));
    const sessionsDir = path.join(root, "sessions");
    const projectDir = path.join(sessionsDir, "--tmp-project--");

    await writeSessionFile(projectDir, "session.jsonl", [
      { type: "session", id: "s-1", cwd: "/tmp/project", timestamp: "2026-05-06T00:00:00.000Z" },
      { type: "message", id: "m-1", timestamp: "2026-05-06T00:00:01.000Z", message: { role: "user", content: "#learn add tests" } },
    ]);

    const pi = createMockPi();
    registerCandidateShadowRunCommand(pi, { candidateShadowMode: true } as any, { sessionsDir });

    const ctx = createMockCtx();
    await handlers["memory-candidates-shadow-run"].handler(undefined, ctx);

    assert.ok(notifyCalls.length >= 2, "should emit progress + report");

    const report = notifyCalls[notifyCalls.length - 1];
    assert.strictEqual(report.level, "info");
    assert.ok(report.msg.includes("Candidate Shadow Report"));
    assert.ok(report.msg.includes("Files scanned: 1"));
    assert.ok(report.msg.includes("No writes performed"));

    await fs.rm(root, { recursive: true, force: true });
  });
});
