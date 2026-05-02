/**
 * Unit tests for /memory-interview command.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerInterviewCommand } from "../../src/handlers/interview.js";

// ─── Mock infrastructure ───

let handlers: Record<string, Function[]>;
let notifyCalls: Array<{ msg: string; level: string }>;
let sentMessages: string[];

function createMockPi() {
  const pi = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (_name: string, opts: { description: string; handler: Function }) => {
      handlers[_name] = [{ fn: opts.handler, desc: opts.description }];
    },
    sendUserMessage: (text: string) => {
      sentMessages.push(text);
    },
  };
  return pi;
}

function makeMockCtx() {
  return {
    sessionManager: { getBranch: () => [] },
    signal: undefined as any,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
    waitForIdle: async () => {},
  } as any;
}

const mockStore = (entries: string[]) => ({
  getUserEntries: () => entries,
  getMemoryEntries: () => [],
} as any);

// ─── Tests ───

describe("registerInterviewCommand", () => {
  beforeEach(() => {
    handlers = {};
    notifyCalls = [];
    sentMessages = [];
  });

  it("registers the /memory-interview command", () => {
    const pi = createMockPi();
    registerInterviewCommand(pi as any, mockStore([]));

    const cmd = handlers["memory-interview"];
    assert.ok(cmd, "command should be registered");
    assert.ok(cmd.length === 1, "should have one handler");
  });

  it("command description mentions onboarding", () => {
    const pi = createMockPi();
    registerInterviewCommand(pi as any, mockStore([]));

    const cmd = handlers["memory-interview"][0];
    assert.ok(cmd.desc.includes("user profile"), "description should mention user profile");
  });

  it("sends interview prompt as user message when USER.md is empty", async () => {
    const pi = createMockPi();
    registerInterviewCommand(pi as any, mockStore([]));

    const ctx = makeMockCtx();
    await handlers["memory-interview"][0].fn(undefined, ctx);

    assert.strictEqual(sentMessages.length, 1, "should send one user message");
    assert.ok(sentMessages[0].includes("onboarding interview"), "message should be the interview prompt");
    assert.ok(sentMessages[0].includes("timezone"), "prompt should ask about timezone");
    assert.ok(sentMessages[0].includes("work style"), "prompt should ask about work style");
  });

  it("shows notification when USER.md already has entries", async () => {
    const pi = createMockPi();
    const store = mockStore(["name: Chandrateja", "prefers concise answers"]);
    registerInterviewCommand(pi as any, store);

    const ctx = makeMockCtx();
    await handlers["memory-interview"][0].fn(undefined, ctx);

    assert.ok(notifyCalls.length >= 1, "should show notification for existing entries");
    assert.ok(
      notifyCalls[0].msg.includes("2 profile entries"),
      "notification should mention entry count",
    );
    assert.ok(
      notifyCalls[0].msg.includes("Chandrateja"),
      "notification should show existing entry preview",
    );
  });

  it("still sends interview prompt even when entries exist", async () => {
    const pi = createMockPi();
    const store = mockStore(["existing entry"]);
    registerInterviewCommand(pi as any, store);

    const ctx = makeMockCtx();
    await handlers["memory-interview"][0].fn(undefined, ctx);

    assert.strictEqual(sentMessages.length, 1, "should still send interview prompt");
  });

  it("uses correct message count grammar (1 entry)", async () => {
    const pi = createMockPi();
    const store = mockStore(["one entry only"]);
    registerInterviewCommand(pi as any, store);

    const ctx = makeMockCtx();
    await handlers["memory-interview"][0].fn(undefined, ctx);

    assert.ok(notifyCalls[0].msg.includes("1 profile entry"), "should use singular");
    assert.ok(!notifyCalls[0].msg.includes("entries"), "should NOT use plural for 1 entry");
  });
});
