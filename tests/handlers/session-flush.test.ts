import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupSessionFlush } from "../../src/handlers/session-flush.js";
import { resolveChildPiInvocation } from "../../src/handlers/pi-child-process.js";
import { DIRECT_FLUSH_SYSTEM_PROMPT, FLUSH_PROMPT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";
import type { DirectReviewResult } from "../../src/handlers/review-memory-ops.js";

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
      const [command, childArgs, options] = args;
      const capturedArgs = [...childArgs];
      const promptReference = capturedArgs.at(-1);
      if (typeof promptReference === "string" && promptReference.startsWith("@")) {
        capturedArgs[capturedArgs.length - 1] = readFileSync(promptReference.slice(1), "utf-8");
      }
      execCalls.push({ args: [command, capturedArgs, options] });
      return { code: 0, stdout: "", stderr: "" };
    },
    registerTool() {},
    registerCommand() {},
  };

  return { pi: pi as any, handlers, execCalls };
}
interface MockSessionFlushPi {
  pi: {
    on(event: string, handler: Function): void;
    exec(...args: unknown[]): Promise<{ code: number; stdout: string; stderr: string }>;
    registerTool(): void;
    registerCommand(): void;
  };
  handlers: Record<string, Function[]>;
  execCalls: { args: unknown[] }[];
}

let directCalls: unknown[][];

function makeDirectDeps(
  result: DirectReviewResult | "throw",
): { runDirectMemoryCompletion: (...args: unknown[]) => Promise<DirectReviewResult> } {
  return {
    runDirectMemoryCompletion: async (...args: unknown[]) => {
      directCalls.push(args);
      if (result === "throw") throw new Error("injected direct flush failure");
      return result;
    },
  };
}

function defaultFlushCtx() {
  return { sessionManager: { getBranch: () => mockBranch(8) } };
}

async function primeFlushReady(handlers: Record<string, Function[]>) {
  await emitUserTurns(handlers, 8);
}

/** Emit session_shutdown and await fire-and-forget flush without wall-clock sleep. */
async function emitShutdownAndAwaitFlush(
  pi: MockSessionFlushPi,
  handlers: Record<string, Function[]>,
  ctx: { sessionManager: { getBranch: () => unknown[] } },
) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const originalExec = pi.pi.exec;
  pi.pi.exec = async (...args: unknown[]) => {
    try {
      return await originalExec(...args);
    } finally {
      resolve();
    }
  };
  await emit(handlers, "session_shutdown", {}, ctx);
  await promise;
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
    memoryMode: "policy-only",
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewRecentMessages: 0,
    reviewEnabled: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: 6,
    flushRecentMessages: 0,
    autoConsolidate: true,
    correctionDetection: true,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
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

function logicalChildArgs(call: { args: any[] }): string[] {
  const [cmd, args] = call.args;
  const logicalArgs = cmd === "pi" ? args : args.slice(1);
  const expected = resolveChildPiInvocation(logicalArgs);
  assert.equal(cmd, expected.command);
  assert.deepEqual(args, expected.args);
  return logicalArgs;
}

function flushMessage(call: { args: any[] }): string {
  const args = logicalChildArgs(call);
  return args[args.length - 1];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("setupSessionFlush", () => {
  let mockPi: MockSessionFlushPi;

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
    await emitShutdownAndAwaitFlush(mockPi, mockPi.handlers, ctx);
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

    const [, , opts] = mockPi.execCalls[0].args;
    const args = logicalChildArgs(mockPi.execCalls[0]);
    assert.equal(args[0], "-p");
    assert.equal(args[1], "--no-session");

    // The final logical arg is the flush message containing the prompt + conversation
    const message = args[args.length - 1];
    assert.ok(message.includes(FLUSH_PROMPT), "flush message should contain FLUSH_PROMPT");
    assert.ok(message.includes("[USER]"), "flush message should contain [USER] prefix");
    assert.ok(
      message.includes("[ASSISTANT]"),
      "flush message should contain [ASSISTANT] prefix",
    );
    assert.ok(message.includes("msg 0"), "flush message should contain conversation text");

    // Options should include timeout
    assert.ok(opts, "options should be passed");
    assert.equal(opts.timeout, 30000);
  });

  it("passes child LLM override args to flush subprocesses", async () => {
    const config = defaultConfig({
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
      llmThinkingOverride: "low",
    });
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(4) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    const args = logicalChildArgs(mockPi.execCalls[0]);
    assert.deepStrictEqual(
      args.slice(0, 6),
      ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "low"],
    );
  });

  it("Flush includes the full conversation by default", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    const message = flushMessage(mockPi.execCalls[0]);
    assert.ok(message.includes("msg 0"), "default should include older messages");
    assert.ok(message.includes("msg 7"), "default should include latest messages");
  });

  it("Flush limits conversation to recent messages when configured", async () => {
    const config = defaultConfig({ flushRecentMessages: 3 });
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    const message = flushMessage(mockPi.execCalls[0]);
    assert.ok(!message.includes("msg 4"), "window should exclude older messages");
    assert.ok(message.includes("msg 5"));
    assert.ok(message.includes("msg 6"));
    assert.ok(message.includes("msg 7"));
  });

  it("Flush does not use the review recent-message limit", async () => {
    const config = defaultConfig({ reviewRecentMessages: 2 });
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    const message = flushMessage(mockPi.execCalls[0]);
    assert.ok(message.includes("msg 0"), "review limit must not affect flush");
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

    const message = flushMessage(mockPi.execCalls[0]);
    assert.ok(message.includes(FLUSH_PROMPT));
    // No [USER]/[ASSISTANT] prefixes in empty conversation
    assert.ok(!message.includes("[USER]"), "empty branch should have no [USER]");
  });

  it("Concurrent compact + shutdown both flush", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    const { promise, resolve } = Promise.withResolvers<void>();
    let execCount = 0;
    const originalExec = mockPi.pi.exec;
    mockPi.pi.exec = async (...args: unknown[]) => {
      const result = await originalExec(...args);
      execCount += 1;
      if (execCount === 2) resolve();
      return result;
    };

    await Promise.all([
      emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx),
      emit(mockPi.handlers, "session_shutdown", {}, ctx),
    ]);
    await promise;
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

describe("direct transport", () => {
  let mockPi: MockSessionFlushPi;

  beforeEach(() => {
    mockPi = createMockPi();
    directCalls = [];
  });

  it("session_before_compact uses direct transport without subprocess when direct returns ok", async () => {
    const config = defaultConfig({ reviewTransport: "direct" });
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      config,
      null,
      null,
      makeDirectDeps({ ok: true, appliedCount: 2 }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, defaultFlushCtx());

    assert.equal(directCalls.length, 1, "direct completion should run once");
    assert.equal(mockPi.execCalls.length, 0, "subprocess must not run on successful direct flush");

    const options = directCalls[0][3] as { systemPrompt: string; userPrompt: string };
    assert.equal(options.systemPrompt, DIRECT_FLUSH_SYSTEM_PROMPT);
    assert.match(options.userPrompt, /--- Conversation ---/);
    assert.match(options.userPrompt, /msg 0/);
  });

  it("falls back to subprocess with flush message shape when direct returns ok false", async () => {
    const config = defaultConfig({ reviewTransport: "direct" });
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      config,
      null,
      null,
      makeDirectDeps({ ok: false, appliedCount: 0, fallbackReason: "no_model" }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, defaultFlushCtx());

    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 1, "failed direct result must fall back to subprocess");

    const message = flushMessage(mockPi.execCalls[0]);
    assert.ok(message.includes(FLUSH_PROMPT), "fallback flush message should contain FLUSH_PROMPT");
    assert.ok(message.includes("--- Conversation ---"));
    assert.ok(message.includes("[USER]"));
    assert.ok(message.includes("msg 0"));
  });

  it("falls back to subprocess when direct throws without propagating on compact", async () => {
    const config = defaultConfig({ reviewTransport: "direct" });
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      config,
      null,
      null,
      makeDirectDeps("throw"),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, defaultFlushCtx());

    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 1, "thrown direct error must fall back to subprocess");
  });

  it("falls back to subprocess when direct throws without propagating on shutdown", async () => {
    const config = defaultConfig({ reviewTransport: "direct" });
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      config,
      null,
      null,
      makeDirectDeps("throw"),
    );

    await primeFlushReady(mockPi.handlers);
    await emitShutdownAndAwaitFlush(mockPi, mockPi.handlers, defaultFlushCtx());
    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 1, "shutdown flush must survive direct throw");
  });

  it("skips direct transport when reviewTransport is subprocess", async () => {
    const config = defaultConfig({ reviewTransport: "subprocess" });
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      config,
      null,
      null,
      makeDirectDeps({ ok: true, appliedCount: 99 }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, defaultFlushCtx());

    assert.equal(directCalls.length, 0, "subprocess transport must not invoke direct completion");
    assert.equal(mockPi.execCalls.length, 1);
  });
});

