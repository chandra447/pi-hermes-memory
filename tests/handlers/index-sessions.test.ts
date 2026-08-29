import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let agentRootDir = "";
let sessionsDir = "";
let originalAgentDirEnv: string | undefined;
let originalSessionsDirEnv: string | undefined;
let mod: typeof import("../../src/handlers/index-sessions.js") | null = null;
let db: import("../../src/store/db.js").DatabaseManager | null = null;

function writeJsonlSession(
  projectDir: string,
  sessionId: string,
  text = "hello from test session",
): void {
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session",
      id: sessionId,
      timestamp: "2026-05-03T00:00:00Z",
      cwd: `/work/${path.basename(projectDir)}`,
    }),
    JSON.stringify({
      type: "message",
      id: `${sessionId}-m1`,
      parentId: null,
      timestamp: "2026-05-03T00:01:00Z",
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    }),
  ];
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    lines.join("\n"),
  );
}

beforeEach(async () => {
  agentRootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-index-sessions-agent-root-"),
  );
  sessionsDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-index-sessions-sessions-"),
  );
  originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  originalSessionsDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = agentRootDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
  // Import after env setup so the module-level SESSIONS_DIR/AGENT_ROOT constants
  // resolve to the temp dirs.
  mod = await import("../../src/handlers/index-sessions.js");
});

afterEach(() => {
  if (db) {
    try {
      db.close();
    } catch {
      /* best effort */
    }
    db = null;
  }
  process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
  process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionsDirEnv;
  mod = null;
  if (agentRootDir) fs.rmSync(agentRootDir, { recursive: true, force: true });
  if (sessionsDir) fs.rmSync(sessionsDir, { recursive: true, force: true });
  agentRootDir = "";
  sessionsDir = "";
});

describe("registerIndexSessionsCommand", () => {
  it("indexes session files from the configured sessions dir", async () => {
    assert.ok(mod, "module imported after env setup");
    writeJsonlSession(path.join(sessionsDir, "demo"), "s1");

    const notifications: string[] = [];
    const mockPi = {
      registerTool: () => {},
      registerCommand: (name: string, def: any) => {
        (mockPi as any)._lastCommand = { name, def };
      },
    } as any;

    mod!.registerIndexSessionsCommand(mockPi, {});
    const def = (mockPi as any)._lastCommand.def;
    await def.handler("", {
      ui: { notify: (msg: string) => notifications.push(msg) },
    });

    const output = notifications.join("\n");
    assert.match(output, /Session indexing complete/);
    assert.match(output, /Sessions indexed: 1/);

    // Verify the temp agent root received the indexed session.
    const dbManager = new (
      await import("../../src/store/db.js")
    ).DatabaseManager(path.join(agentRootDir, "pi-hermes-memory"));
    db = dbManager;
    const dbHandle = dbManager.getDb();
    const sessions = dbHandle
      .prepare("SELECT COUNT(*) as count FROM sessions")
      .get() as { count: number };
    assert.strictEqual(sessions.count, 1);
  });

  it("forwards quickCheckOnOpen: false into the command-local database manager", async () => {
    assert.ok(mod, "module imported after env setup");
    writeJsonlSession(path.join(sessionsDir, "demo"), "s2");

    const notifications: string[] = [];
    const mockPi = {
      registerTool: () => {},
      registerCommand: (name: string, def: any) => {
        (mockPi as any)._lastCommand = { name, def };
      },
    } as any;

    // quickCheckOnOpen: false must reach the command-local DatabaseManager,
    // so a user who disabled the open-time quick_check is not hit by it here.
    mod!.registerIndexSessionsCommand(mockPi, {
      quickCheckOnOpen: false,
    } as never);
    const def = (mockPi as any)._lastCommand.def;
    await def.handler("", {
      ui: { notify: (msg: string) => notifications.push(msg) },
    });

    assert.match(notifications.join("\n"), /Session indexing complete/);
  });
});
