import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

interface MockPi {
  handlers: Record<string, Array<(event: any, ctx: any) => unknown>>;
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
  registerTool(): void;
  registerCommand(): void;
}

describe("session project memory rebinding", () => {
  it("loads project memory from the active session cwd after a switch", async () => {
    const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-project-rebind-agent-"));
    const launchDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-project-rebind-launch-"));
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-project-rebind-target-"));
    const previousAgentRoot = process.env.PI_CODING_AGENT_DIR;
    const previousCwd = process.cwd();
    try {
      await fs.writeFile(
        path.join(agentRoot, "hermes-memory-config.json"),
        JSON.stringify({
          memoryMode: "legacy-inject",
          reviewEnabled: false,
          flushOnCompact: false,
          flushOnShutdown: false,
          autoConsolidate: false,
          correctionDetection: false,
          standingInstructionsEnabled: false,
        }),
      );
      await fs.mkdir(path.join(agentRoot, "projects-memory", path.basename(launchDir)), { recursive: true });
      await fs.mkdir(path.join(agentRoot, "projects-memory", path.basename(targetDir)), { recursive: true });
      await fs.writeFile(
        path.join(agentRoot, "projects-memory", path.basename(launchDir), "MEMORY.md"),
        "launch-directory memory",
      );
      await fs.writeFile(
        path.join(agentRoot, "projects-memory", path.basename(targetDir), "MEMORY.md"),
        "active-session memory",
      );

      process.env.PI_CODING_AGENT_DIR = agentRoot;
      process.chdir(launchDir);
      // Import after setting PI_CODING_AGENT_DIR so AGENT_ROOT is test-local.
      const { default: registerExtension } = await import("../src/index.js");
      const mockPi: MockPi = {
        handlers: {},
        on(event, handler) {
          (this.handlers[event] ??= []).push(handler);
        },
        registerTool() {},
        registerCommand() {},
      };
      registerExtension(mockPi as any);

      const sessionStart = mockPi.handlers.session_start?.[0];
      const beforeAgentStart = mockPi.handlers.before_agent_start?.[0];
      assert.ok(sessionStart);
      assert.ok(beforeAgentStart);

      await sessionStart(
        {},
        {
          cwd: targetDir,
          sessionManager: { getBranch: () => [] },
          ui: { notify() {} },
        },
      );
      const result = await beforeAgentStart({ systemPrompt: "base" }, {}) as { systemPrompt: string };
      assert.match(result.systemPrompt, /active-session memory/);
      assert.doesNotMatch(result.systemPrompt, /launch-directory memory/);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentRoot;
      await fs.rm(agentRoot, { recursive: true, force: true });
      await fs.rm(launchDir, { recursive: true, force: true });
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});
