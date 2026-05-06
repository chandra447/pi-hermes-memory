import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupSessionFlush } from "../../src/handlers/session-flush.js";
import { FLUSH_PROMPT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Event-name → handler[] registry built by mock pi.on() */
function createMockPi() {
  const handlers: Record<string, Function[]> = {};
  const execCalls: { args: any[] }[] = [];

  const pi = {
    on(event: string, handler: Function) {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    },
    async exec(...args: any[]) {
      execCalls.push({ args });
      return { code: 0, stdout: "", stderr: "" };
    },
    registerTool() {},
    registerCommand() {},
  };

  return { pi: pi as any, handlers, execCalls };
}

/** Build N messages alternating user/assistant */
function mockBranch(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "message",
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `msg ${i}` }],
      timestamp: i,
    },
  }));
}

function defaultConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: 6,
    candidateShadowMode: true,
    ...overrides,
  };
}

/** Emit message_end N times (simulates user turns) */
async function emitUserTurns(handlers: Record<string, Function[]>, count: number) {
  const hs = handlers["message_end"] || [];
  for (let i = 0; i < count; i++) {
    for (const h of hs) {
      await h({ message: { role: "user" } }, {});
    }
  }
}

/** Emit a single event with optional ctx */
async function emit(
  handlers: Record<string, Function[]>,
  event: string,
  eventObj: any = {},
  ctx: any = {},
) {
  const hs = handlers[event] || [];
  for (const h of hs) {
    await h(eventObj, ctx);
  }
}

const mockStore = { getMemoryEntries: () => [], getUserEntries: () => [] } as any;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("setupSessionFlush", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  // ── Compact flush ───────────────────────────────────────────────────

  it("session_before_compact triggers flush when flushOnCompact is true", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    // Simulate enough user turns
    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(mockPi.execCalls.length, 1, "exec should be called once");
  });

  it("session_before_compact does NOT trigger when flushOnCompact is false", async () => {
    const config = defaultConfig({ flushOnCompact: false });
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(mockPi.execCalls.length, 0, "exec should NOT be called");
  });

  // ── Shutdown flush ──────────────────────────────────────────────────

  it("session_shutdown triggers flush when flushOnShutdown is true", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_shutdown", {}, ctx);

    // Shutdown flush is fire-and-forget — wait for microtask queue to settle
    await new Promise(r => setTimeout(r, 10));
    assert.equal(mockPi.execCalls.length, 1, "exec should be called once");
  });

  it("session_shutdown does NOT trigger when flushOnShutdown is false", async () => {
    const config = defaultConfig({ flushOnShutdown: false });
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_shutdown", {}, ctx);

    assert.equal(mockPi.execCalls.length, 0, "exec should NOT be called");
  });

  // ── Minimum turns gate ──────────────────────────────────────────────

  it("Flush skips if userTurnCount < flushMinTurns", async () => {
    const config = defaultConfig({ flushMinTurns: 6 });
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    // Only 3 user turns — below threshold
    await emitUserTurns(mockPi.handlers, 3);

    const ctx = { sessionManager: { getBranch: () => mockBranch(3) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(mockPi.execCalls.length, 0, "exec should NOT be called with too few turns");
  });

  // ── getBranch usage ─────────────────────────────────────────────────

  it("Flush builds conversation from sessionManager.getBranch()", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    let branchCalled = false;
    const ctx = {
      sessionManager: {
        getBranch: () => {
          branchCalled = true;
          return mockBranch(8);
        },
      },
    };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.ok(branchCalled, "getBranch should be called");
    assert.equal(mockPi.execCalls.length, 1);
  });

  // ── Exec args verification ──────────────────────────────────────────

  it("Flush uses pi.exec with correct args", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const branch = mockBranch(4);
    const ctx = { sessionManager: { getBranch: () => branch } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(mockPi.execCalls.length, 1);

    const [cmd, args, opts] = mockPi.execCalls[0].args;
    assert.equal(cmd, "pi");
    assert.ok(Array.isArray(args));
    assert.equal(args[0], "-p");
    assert.equal(args[1], "--no-session");

    // The third arg is the flush message containing the prompt + conversation
    const flushMessage = args[2];
    assert.ok(flushMessage.includes(FLUSH_PROMPT), "flush message should contain FLUSH_PROMPT");
    assert.ok(flushMessage.includes("[USER]"), "flush message should contain [USER] prefix");
    assert.ok(
      flushMessage.includes("[ASSISTANT]"),
      "flush message should contain [ASSISTANT] prefix",
    );
    assert.ok(flushMessage.includes("msg 0"), "flush message should contain conversation text");

    // Options should include timeout
    assert.ok(opts, "options should be passed");
    assert.equal(opts.timeout, 30000);
  });

  // ── Error resilience ────────────────────────────────────────────────

  it("Flush failure does NOT prevent compaction", async () => {
    // Make exec throw
    const failingPi = createMockPi();
    failingPi.pi.exec = async () => {
      throw new Error("exec failed");
    };

    const config = defaultConfig();
    setupSessionFlush(failingPi.pi, mockStore, null, config);

    await emitUserTurns(failingPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    // Should not throw — error is swallowed for best-effort flush
    await assert.doesNotReject(async () => {
      await emit(failingPi.handlers, "session_before_compact", { signal: undefined }, ctx);
    });
  });

  it("Flush failure does NOT prevent shutdown", async () => {
    const failingPi = createMockPi();
    failingPi.pi.exec = async () => {
      throw new Error("exec failed");
    };

    const config = defaultConfig();
    setupSessionFlush(failingPi.pi, mockStore, null, config);

    await emitUserTurns(failingPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    await assert.doesNotReject(async () => {
      await emit(failingPi.handlers, "session_shutdown", {}, ctx);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  it("Handles empty branch (no messages)", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => [] } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    // exec is still called (flush message just has no conversation lines)
    assert.equal(mockPi.execCalls.length, 1);

    const flushMessage = mockPi.execCalls[0].args[1][2];
    assert.ok(flushMessage.includes(FLUSH_PROMPT));
    // No [USER]/[ASSISTANT] prefixes in empty conversation
    assert.ok(!flushMessage.includes("[USER]"), "empty branch should have no [USER]");
  });

  it("Concurrent compact + shutdown both flush", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    // Fire both events
    await Promise.all([
      emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx),
      emit(mockPi.handlers, "session_shutdown", {}, ctx),
    ]);

    await new Promise(r => setTimeout(r, 10));
    assert.equal(mockPi.execCalls.length, 2, "both events should trigger flush");
  });

  it("Passes signal from compact event to exec", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const abortController = new AbortController();
    const signal = abortController.signal;
    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    await emit(mockPi.handlers, "session_before_compact", { signal }, ctx);

    assert.equal(mockPi.execCalls.length, 1);
    const opts = mockPi.execCalls[0].args[2];
    assert.equal(opts.signal, signal, "signal should be forwarded to exec");
  });
});
