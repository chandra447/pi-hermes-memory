import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { setupBackgroundReview } from "../../src/handlers/background-review.js";

// ─── Mock infrastructure ───

interface CallLog {
  handler: string;
  args: any[];
}

let handlers: Record<string, Function[]>;
let execCalls: any[];
let notifyCalls: any[];

function createMockPi(execReturn?: { code: number; stdout: string; stderr: string }) {
  const defaultReturn = { code: 0, stdout: "Saved memory", stderr: "" };
  const ret = execReturn ?? defaultReturn;

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

function makeBranch(numMessages: number) {
  return Array.from({ length: numMessages }, (_, i) => ({
    type: "message",
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Message number ${i} with some real content here` }],
      timestamp: i,
    },
  }));
}

function makeCtx(branch: any[] = [], overrides: Record<string, any> = {}) {
  return {
    sessionManager: { getBranch: () => branch },
    signal: undefined as any,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
    ...overrides,
  };
}

const defaultConfig = {
  reviewEnabled: true,
  nudgeInterval: 10,
  flushMinTurns: 6,
  flushOnCompact: true,
  flushOnShutdown: true,
  memoryCharLimit: 2200,
  userCharLimit: 1375,
};

const mockStore = {
  getMemoryEntries: () => ["existing memory entry"],
  getUserEntries: () => ["existing user entry"],
} as any;

function fireMessageEnd(role: string) {
  const h = handlers["message_end"];
  if (!h) throw new Error("No message_end handler registered");
  for (const fn of h) {
    fn({ message: { role, content: [{ type: "text", text: "hi" }] } }, makeCtx());
  }
}

function fireTurnEnd(branch: any[] = makeBranch(10), ctxOverrides: Record<string, any> = {}) {
  const h = handlers["turn_end"];
  if (!h) throw new Error("No turn_end handler registered");
  const ctx = makeCtx(branch, ctxOverrides);
  for (const fn of h) {
    fn({}, ctx);
  }
  return ctx;
}

// Allow async handlers to settle
async function settle(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ───

describe("setupBackgroundReview", () => {
  beforeEach(() => {
    handlers = {};
    execCalls = [];
    notifyCalls = [];
  });

  it("increments user turn count on message_end for user messages", () => {
    const pi = createMockPi();
    setupBackgroundReview(pi, mockStore, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Verify by checking that 3 user turns is enough to allow review
    // (userTurnCount >= 3 check passes after 3 user message_end events)
    // Fire 10 turn_end events — should trigger review since userTurnCount is 3
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }

    // exec should have been called since we have 3 user turns and 10 turn_end events
    assert.ok(execCalls.length > 0, "exec should be called with 3 user turns and 10 turn_end events");
  });

  it("triggers review at nudgeInterval (10) turns", async () => {
    const pi = createMockPi();
    setupBackgroundReview(pi, mockStore, defaultConfig);

    // Register 3 user messages first
    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Fire 9 turn_end events — not enough
    for (let i = 0; i < 9; i++) {
      fireTurnEnd();
    }
    assert.strictEqual(execCalls.length, 0, "exec should NOT be called at 9 turns");

    // 10th turn_end triggers review
    fireTurnEnd();
    await settle();

    assert.strictEqual(execCalls.length, 1, "exec should be called once at turn 10");
    // Verify it calls pi.exec with review prompt
    const execArgs = execCalls[0];
    assert.strictEqual(execArgs[0], "pi", "exec first arg should be 'pi'");
    const cmdArgs: string[] = execArgs[1];
    assert.ok(cmdArgs[0] === "-p", "should use -p flag");
    assert.ok(cmdArgs.includes("--no-session"), "should include --no-session");
  });

  it("does NOT trigger review when reviewEnabled is false", async () => {
    const config = { ...defaultConfig, reviewEnabled: false };
    const pi = createMockPi();
    setupBackgroundReview(pi, mockStore, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(execCalls.length, 0, "exec should NOT be called when reviewEnabled is false");
  });

  it("does NOT trigger review with fewer than 3 user turns", async () => {
    const pi = createMockPi();
    setupBackgroundReview(pi, mockStore, defaultConfig);

    // Only 2 user messages
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(execCalls.length, 0, "exec should NOT be called with only 2 user turns");
  });

  it("reviewInProgress guard prevents double-trigger", async () => {
    // Use a slow exec that never resolves to keep reviewInProgress true
    let resolveExec: () => void;
    const slowPi = {
      on: (event: string, handler: Function) => {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
      },
      exec: async (...args: any[]) => {
        execCalls.push(args);
        await new Promise<void>((r) => { resolveExec = r; });
        return { code: 0, stdout: "Saved", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    setupBackgroundReview(slowPi, mockStore, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Fire 10 turn_end events — first triggers review (slow, won't resolve)
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle(5);

    assert.strictEqual(execCalls.length, 1, "exec should be called once for first trigger");

    // Fire more turn_end events — should be blocked by reviewInProgress
    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle(5);

    assert.strictEqual(execCalls.length, 1, "exec should still only be called once — reviewInProgress guard");

    // Resolve the pending exec to clean up
    resolveExec!();
    await settle();
  });

  it("does NOT trigger for short conversations (< 4 message parts)", async () => {
    const pi = createMockPi();
    setupBackgroundReview(pi, mockStore, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Branch with only 2 message entries (< 4 parts)
    const shortBranch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(shortBranch);
    }
    await settle();

    assert.strictEqual(execCalls.length, 0, "exec should NOT be called for short conversations");
  });

  it("resets turn counter after review triggers", async () => {
    const pi = createMockPi();
    setupBackgroundReview(pi, mockStore, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Fire 10 turns — triggers review
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(execCalls.length, 1, "first review triggered");

    // Fire 10 more turns — should trigger again (counter was reset)
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(execCalls.length, 2, "second review should trigger after counter reset");
  });

  it("shows notification only when review saves something", async () => {
    const pi = createMockPi({ code: 0, stdout: "Saved new memory about user preferences", stderr: "" });
    setupBackgroundReview(pi, mockStore, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(notifyCalls.length, 1, "notification should be shown when something is saved");
    assert.ok(
      notifyCalls[0].msg.includes("Memory auto-reviewed"),
      "notification should mention auto-review",
    );

    // Reset and test "nothing to save" case
    handlers = {};
    execCalls = [];
    notifyCalls = [];

    const nothingPi = createMockPi({ code: 0, stdout: "Nothing to save.", stderr: "" });
    setupBackgroundReview(nothingPi, mockStore, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(notifyCalls.length, 0, "notification should NOT be shown for 'nothing to save'");
  });

  it("does NOT crash agent when exec throws", async () => {
    const crashPi = {
      on: (event: string, handler: Function) => {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
      },
      exec: async (...args: any[]) => {
        execCalls.push(args);
        throw new Error("exec crashed");
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    setupBackgroundReview(crashPi, mockStore, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // This should NOT throw
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(execCalls.length, 1, "exec was attempted");
    // If we get here without an unhandled rejection, the error was caught
    assert.ok(true, "background review failure was caught silently");
  });

  it("assistant message_end does NOT increment user turn count", async () => {
    const pi = createMockPi();
    setupBackgroundReview(pi, mockStore, defaultConfig);

    // Only assistant messages — userTurnCount stays 0
    fireMessageEnd("assistant");
    fireMessageEnd("assistant");
    fireMessageEnd("assistant");

    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle();

    assert.strictEqual(execCalls.length, 0, "exec should NOT be called — no user messages");
  });
});
