import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

interface MockPi {
  handlers: Record<string, Array<(event: any, ctx: any) => unknown>>;
  tools: Record<string, { execute: (...args: any[]) => Promise<any> }>;
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
  registerTool(def: { name: string; execute: (...args: any[]) => Promise<any> }): void;
  registerCommand(): void;
}

describe("session project memory rebinding", () => {
  it("writes project memory using session cwd when factory cwd differs", async () => {
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
      const launchMemoryDir = path.join(agentRoot, "projects-memory", path.basename(launchDir));
      const sessionMemoryDir = path.join(agentRoot, "projects-memory", path.basename(targetDir));
      await fs.mkdir(launchMemoryDir, { recursive: true });
      await fs.mkdir(sessionMemoryDir, { recursive: true });
      await fs.writeFile(
        path.join(launchMemoryDir, "MEMORY.md"),
        "launch-directory memory",
      );
      await fs.writeFile(
        path.join(sessionMemoryDir, "MEMORY.md"),
        "active-session memory",
      );

      process.env.PI_CODING_AGENT_DIR = agentRoot;
      process.chdir(launchDir);
      // Import after setting PI_CODING_AGENT_DIR so AGENT_ROOT is test-local.
      const { default: registerExtension } = await import("../src/index.js");
      const mockPi: MockPi = {
        handlers: {},
        tools: {},
        on(event, handler) {
          (this.handlers[event] ??= []).push(handler);
        },
        registerTool(def) {
          this.tools[def.name] = def;
        },
        registerCommand() {},
      };
      registerExtension(mockPi as any);

      const sessionStart = mockPi.handlers.session_start?.[0];
      const resourcesDiscover = mockPi.handlers.resources_discover?.[0];
      const beforeAgentStart = mockPi.handlers.before_agent_start?.[0];
      assert.ok(sessionStart);
      assert.ok(resourcesDiscover);
      assert.ok(beforeAgentStart);
      assert.ok(mockPi.tools.memory_add);

      const sessionCtx = {
        cwd: targetDir,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
      };

      // Pi lifecycle: session_start, then resources_discover, then tool execute.
      await sessionStart({}, sessionCtx);
      await resourcesDiscover({ cwd: targetDir, reason: "startup" }, sessionCtx);

      const result = await beforeAgentStart({ systemPrompt: "base" }, sessionCtx) as { systemPrompt: string };
      assert.match(result.systemPrompt, /active-session memory/);
      assert.doesNotMatch(result.systemPrompt, /launch-directory memory/);

      const writeResult = await mockPi.tools.memory_add.execute(
        "tc-session-cwd",
        { target: "project", content: "session-cwd write" },
        undefined,
        undefined,
        { cwd: targetDir },
      );
      assert.equal(writeResult.details.success, true);

      const sessionMemory = await fs.readFile(path.join(sessionMemoryDir, "MEMORY.md"), "utf-8");
      const launchMemory = await fs.readFile(path.join(launchMemoryDir, "MEMORY.md"), "utf-8");
      assert.match(sessionMemory, /session-cwd write/);
      assert.doesNotMatch(launchMemory, /session-cwd write/);
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
