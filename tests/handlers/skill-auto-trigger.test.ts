/**
 * Unit tests for skill auto-trigger — fires after complex tasks (8+ tool calls, 2+ distinct types).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupSkillAutoTrigger } from "../../src/handlers/skill-auto-trigger.js";

// ─── Mock infrastructure ───

let handlers: Record<string, Function[]>;
let execCalls: any[];
let notifyCalls: any[];

function createMockPi(execReturn?: { code: number; stdout: string; stderr: string }) {
  const ret = execReturn ?? { code: 0, stdout: "Skill extracted", stderr: "" };
  return {
    on: (event: string, handler: Function) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    },
    exec: async (...args: any[]) => {
      execCalls.push(args);
      return ret;
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as any;
}

const mockStore = {
  getMemoryEntries: () => ["existing entry"],
  getUserEntries: () => [],
} as any;

const mockSkillStore = {
  loadIndex: async () => [] as any[],
} as any;

const config = {
  correctionDetection: false,
  nudgeInterval: 10,
  reviewEnabled: false,
  memoryCharLimit: 5000,
  userCharLimit: 5000,
  projectCharLimit: 5000,
  flushOnCompact: false,
  flushOnShutdown: false,
  flushMinTurns: 6,
  autoConsolidate: false,
  nudgeToolCalls: 15,
  candidateShadowMode: true,
};

function makeBranchWithToolCalls(toolCallCount: number, distinctTools: string[]): any[] {
  const messages: any[] = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "fix the bug" }] } },
  ];

  // Create assistant messages with tool calls
  const toolCallBlocks = [];
  for (let i = 0; i < toolCallCount; i++) {
    toolCallBlocks.push({
      type: "toolCall",
      id: `tc-${i}`,
      name: distinctTools[i % distinctTools.length],
      arguments: {},
    });
  }

  messages.push({
    type: "message",
    message: {
      role: "assistant",
      content: toolCallBlocks,
      timestamp: 1,
    },
  });

  // Add some more messages to fill out the branch
  messages.push(
    { type: "message", message: { role: "user", content: [{ type: "text", text: "ok now check tests" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "running tests..." }] } },
  );

  return messages;
}

function makeCtx(branch: any[]) {
  return {
    sessionManager: { getBranch: () => branch },
    signal: undefined as any,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  };
}

function fireTurnEnd(branch: any[]) {
  const h = handlers["turn_end"];
  if (!h) throw new Error("No turn_end handler registered");
  const ctx = makeCtx(branch);
  // Extract the first assistant message with tool calls to pass as event.message
  // In a real Pi session, turn_end fires with the assistant message just generated
  let assistantMessage = undefined;
  for (const entry of branch) {
    if (entry?.message?.role === "assistant") {
      const content = entry.message.content;
      if (Array.isArray(content) && content.some((b: any) => b?.type === "toolCall")) {
        assistantMessage = entry.message;
        break;
      }
    }
  }
  // Fall back to last assistant message if no tool-call message found
  if (!assistantMessage) {
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i]?.message?.role === "assistant") {
        assistantMessage = branch[i].message;
        break;
      }
    }
  }
  const event = assistantMessage ? { message: assistantMessage } : {};
  for (const fn of h) {
    fn(event, ctx);
  }
  return ctx;
}

async function settle(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ───

describe("setupSkillAutoTrigger", () => {
  beforeEach(() => {
    handlers = {};
    execCalls = [];
    notifyCalls = [];
  });

  it("triggers at 8+ tool calls with 2+ distinct tool types", async () => {
    const pi = createMockPi();
    setupSkillAutoTrigger(pi, mockStore, mockSkillStore, config);

    const branch = makeBranchWithToolCalls(9, ["read", "bash", "edit"]);
    fireTurnEnd(branch);
    await settle();

    assert.ok(execCalls.length >= 1, "pi.exec should be called with 8+ tool calls and 3 distinct tools");
  });

  it("does NOT trigger below 8 tool calls", async () => {
    const pi = createMockPi();
    setupSkillAutoTrigger(pi, mockStore, mockSkillStore, config);

    const branch = makeBranchWithToolCalls(7, ["read", "bash"]);
    fireTurnEnd(branch);
    await settle();

    assert.strictEqual(execCalls.length, 0, "should NOT trigger with < 8 tool calls");
  });

  it("does NOT trigger with only 1 distinct tool type", async () => {
    const pi = createMockPi();
    setupSkillAutoTrigger(pi, mockStore, mockSkillStore, config);

    // 10 tool calls but all "read" — only 1 distinct type
    const branch = makeBranchWithToolCalls(10, ["read"]);
    fireTurnEnd(branch);
    await settle();

    assert.strictEqual(execCalls.length, 0, "should NOT trigger with only 1 tool type");
  });

  it("triggers with exactly 2 distinct tool types", async () => {
    const pi = createMockPi();
    setupSkillAutoTrigger(pi, mockStore, mockSkillStore, config);

    const branch = makeBranchWithToolCalls(8, ["read", "bash"]);
    fireTurnEnd(branch);
    await settle();

    assert.ok(execCalls.length >= 1, "should trigger with exactly 2 distinct tool types");
  });

  it("only triggers once per session", async () => {
    const pi = createMockPi();
    setupSkillAutoTrigger(pi, mockStore, mockSkillStore, config);

    const branch = makeBranchWithToolCalls(9, ["read", "bash", "edit"]);

    // First trigger
    fireTurnEnd(branch);
    await settle();

    const firstCallCount = execCalls.length;
    assert.ok(firstCallCount >= 1, "first trigger should fire");

    // Second turn_end — should NOT trigger again
    fireTurnEnd(branch);
    await settle();

    assert.strictEqual(execCalls.length, firstCallCount, "should only trigger once per session");
  });

  it("handles branch access failure gracefully", async () => {
    const pi = createMockPi();
    setupSkillAutoTrigger(pi, mockStore, mockSkillStore, config);

    const crashCtx = {
      sessionManager: { getBranch: () => { throw new Error("session expired"); } },
      signal: undefined as any,
      ui: { notify: () => {} },
    };

    const h = handlers["turn_end"];
    for (const fn of h) {
      fn({}, crashCtx);
    }
    await settle();

    // Should not throw — we got here = test passed
    assert.strictEqual(execCalls.length, 0, "should not trigger when branch access fails");
    assert.ok(true, "no crash when getBranch throws");
  });
});
