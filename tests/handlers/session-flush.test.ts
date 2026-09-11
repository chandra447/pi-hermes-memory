import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupSessionFlush, remainingFlushTimeoutMs, resolveFlushHandoff } from "../../src/handlers/session-flush.js";
import { resolveWatchedChildPiInvocation } from "../../src/handlers/pi-child-process.js";
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

function flushCtxWithNotify() {
  const notifications: { message: string; kind?: string }[] = [];
  return {
    notifications,
    ctx: {
      sessionManager: { getBranch: () => mockBranch(8) },
      ui: {
        notify(message: string, kind?: string) {
          notifications.push({ message, kind });
        },
      },
    },
  };
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
  await emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
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
    flushCompactTimeoutMs: 60_000,
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
  const underlying = { command: args[3], args: args.slice(4) };
  const expected = resolveWatchedChildPiInvocation(underlying, Number(args[1]), args[2]);
  assert.equal(cmd, expected.command);
  assert.deepEqual(args, expected.args);
  return underlying.command === "pi" ? underlying.args : underlying.args.slice(1);
}

function flushMessage(call: { args: any[] }): string {
  const args = logicalChildArgs(call);
  return args[args.length - 1];
}

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("remainingFlushTimeoutMs", () => {
  it("gives the full ceiling when nothing has elapsed", () => {
    assert.equal(remainingFlushTimeoutMs(60_000, 0), 60_000);
  });

  it("returns leftover after a fast miss, not a second copy of the budget", () => {
    assert.equal(remainingFlushTimeoutMs(60_000, 2_000), 58_000);
  });

  it("skips when leftover is below the 5s spawn floor", () => {
    assert.equal(remainingFlushTimeoutMs(60_000, 56_000), null);
  });

  it("keeps leftover when it equals the spawn floor", () => {
    assert.equal(remainingFlushTimeoutMs(60_000, 55_000), 5_000);
  });

  it("skips when the ceiling is fully spent or overshot", () => {
    assert.equal(remainingFlushTimeoutMs(60_000, 60_000), null);
    assert.equal(remainingFlushTimeoutMs(60_000, 65_000), null);
  });

  it("floors the spawn threshold by the budget so a tiny knob still runs one shot", () => {
    assert.equal(remainingFlushTimeoutMs(3_000, 0), 3_000);
  });

  it("does not spawn a doomed child after any spend of a tiny budget", () => {
    assert.equal(remainingFlushTimeoutMs(3_000, 1), null);
  });

  it("treats a non-positive budget as exhausted", () => {
    assert.equal(remainingFlushTimeoutMs(0, 0), null);
    assert.equal(remainingFlushTimeoutMs(-1, 0), null);
  });
});

describe("resolveFlushHandoff", () => {
  it("skips as session_aborted even when leftover budget remains", () => {
    assert.deepEqual(resolveFlushHandoff(true, 60_000, 0), { skip: "session_aborted" });
    assert.deepEqual(resolveFlushHandoff(true, 0, 0), { skip: "session_aborted" });
  });

  it("skips as budget_exhausted when leftover is below the spawn floor", () => {
    assert.deepEqual(resolveFlushHandoff(false, 60_000, 56_000), { skip: "budget_exhausted" });
  });

  it("returns leftover timeoutMs, never a second copy of the budget", () => {
    assert.deepEqual(resolveFlushHandoff(false, 60_000, 2_000), { timeoutMs: 58_000 });
  });

  it("treats a non-positive budget as immediately exhausted", () => {
    assert.deepEqual(resolveFlushHandoff(false, 0, 0), { skip: "budget_exhausted" });
    assert.deepEqual(resolveFlushHandoff(false, -5, 0), { skip: "budget_exhausted" });
  });
});


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

  it("awaits the bounded flush before session_shutdown resolves", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const { promise: execStarted, resolve: markExecStarted } = Promise.withResolvers<void>();
    const { promise: releaseExec, resolve: release } = Promise.withResolvers<void>();
    mockPi.pi.exec = async (...args: unknown[]) => {
      markExecStarted();
      await releaseExec;
      return { code: 0, stdout: "", stderr: "" };
    };

    const ctx = {
      sessionManager: { getBranch: () => mockBranch(8) },
      cwd: "/tmp/active-project",
      model: undefined,
      modelRegistry: {},
    };
    const shutdown = mockPi.handlers["session_shutdown"][0]({}, ctx);
    await execStarted;

    let settled = false;
    void shutdown.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "shutdown handler must await the flush");

    release();
    await shutdown;
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
    assert.equal(opts.timeout, 65000);
  });

  it("forwards active cwd and model to flush subprocesses", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const ctx = {
      sessionManager: { getBranch: () => mockBranch(4) },
      cwd: "/tmp/active-project",
      model: { provider: "local-llama", id: "local-9b" },
      modelRegistry: {},
    };
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    const [, , opts] = mockPi.execCalls[0].args;
    assert.equal(opts.cwd, "/tmp/active-project");
    const args = logicalChildArgs(mockPi.execCalls[0]);
    assert.deepStrictEqual(args.slice(0, 4), [
      "-p", "--no-session", "--model", "local-llama/local-9b",
    ]);
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

  it("Routes compact cancellation through the watchdog", async () => {
    const config = defaultConfig();
    setupSessionFlush(mockPi.pi, mockStore, null, config);

    await emitUserTurns(mockPi.handlers, 8);

    const abortController = new AbortController();
    const signal = abortController.signal;
    const ctx = { sessionManager: { getBranch: () => mockBranch(8) } };

    await emit(mockPi.handlers, "session_before_compact", { signal }, ctx);

    assert.equal(mockPi.execCalls.length, 1);
    const opts = mockPi.execCalls[0].args[2];
    assert.strictEqual(opts.signal, undefined, "the watchdog, not pi.exec, owns compact cancellation");
  });
});

describe("direct transport", () => {
  let mockPi: MockSessionFlushPi;

  beforeEach(() => {
    mockPi = createMockPi();
    directCalls = [];
  });

  it("session_shutdown skips direct and subprocess flush on reload", async () => {
    const config = defaultConfig({ reviewTransport: "direct" });
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      config,
      null,
      null,
      makeDirectDeps({ ok: true, appliedCount: 1 }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(
      mockPi.handlers,
      "session_shutdown",
      { type: "session_shutdown", reason: "reload" },
      defaultFlushCtx(),
    );

    assert.equal(directCalls.length, 0, "reload must not use direct completion");
    assert.equal(mockPi.execCalls.length, 0, "reload must not spawn a subprocess");
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
    assert.match(options.systemPrompt, /target routing/i);
    assert.match(options.systemPrompt, /use target "memory"/i);
    assert.match(options.systemPrompt, /do not emit target "project"/i);
    assert.match(options.userPrompt, /--- Conversation ---/);
    assert.match(options.userPrompt, /msg 0/);
  });

  it("routes project facts to project target when a project store is available", async () => {
    const config = defaultConfig({ reviewTransport: "direct" });
    const projectStore = { getMemoryEntries: () => ["existing project fact"] } as unknown as Parameters<typeof setupSessionFlush>[2];
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      projectStore,
      config,
      null,
      "project-a",
      makeDirectDeps({ ok: true, appliedCount: 1 }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, defaultFlushCtx());

    const options = directCalls[0][3] as { systemPrompt: string; userPrompt: string };
    assert.match(options.systemPrompt, /project-specific facts.*target "project"/i);
    assert.match(options.userPrompt, /--- Current Project Memory ---/);
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

describe("compact flush budget", () => {
  let mockPi: MockSessionFlushPi;

  beforeEach(() => {
    mockPi = createMockPi();
    directCalls = [];
  });

  it("direct ok uses the compact ceiling and does not exec or notify", async () => {
    const { ctx, notifications } = flushCtxWithNotify();
    const config = defaultConfig({ flushCompactTimeoutMs: 120_000 });
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      config,
      null,
      null,
      makeDirectDeps({ ok: true, appliedCount: 1 }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(directCalls.length, 1);
    const options = directCalls[0][3];
    assert.ok(options && typeof options === "object" && "timeoutMs" in options);
    assert.equal(options.timeoutMs, 120_000);
    assert.equal(mockPi.execCalls.length, 0);
    assert.equal(notifications.length, 0);
  });

  it("fast parse_error hands the child leftover, not a second copy of the budget", async () => {
    const clock = { t: 0 };
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig(),
      null,
      null,
      {
        now: () => clock.t,
        runDirectMemoryCompletion: async (...args: unknown[]) => {
          directCalls.push(args);
          clock.t += 2_000;
          return { ok: false, appliedCount: 0, fallbackReason: "parse_error" };
        },
      },
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 1);
    assert.equal(mockPi.execCalls[0].args[2].timeout, 58_000 + 5_000);
    assert.equal(notifications.length, 0);
  });

  it("internal timeout at the ceiling skips the child and notifies once", async () => {
    const clock = { t: 0 };
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig(),
      null,
      null,
      {
        now: () => clock.t,
        runDirectMemoryCompletion: async (...args: unknown[]) => {
          directCalls.push(args);
          clock.t += 60_000;
          return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
        },
      },
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].kind, "warning");
    assert.match(notifications[0].message, /flushCompactTimeoutMs/);
    assert.match(notifications[0].message, /timed out after 60000ms/);
  });

  it("reports the leftover, not a timeout, when the direct call leaves too little budget", async () => {
    const clock = { t: 0 };
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig(),
      null,
      null,
      {
        now: () => clock.t,
        runDirectMemoryCompletion: async (...args: unknown[]) => {
          directCalls.push(args);
          clock.t += 58_000;
          return { ok: false, appliedCount: 0, fallbackReason: "parse_error" };
        },
      },
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 0, "2s of leftover is below the spawn floor");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /only 2000ms left of the 60000ms budget/);
    assert.doesNotMatch(notifications[0].message, /timed out after/);
  });

  it("Esc during compact skips the child silently", async () => {
    const abort = new AbortController();
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig(),
      null,
      null,
      {
        runDirectMemoryCompletion: async (...args: unknown[]) => {
          directCalls.push(args);
          abort.abort();
          return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
        },
      },
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: abort.signal }, ctx);

    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 0);
    assert.equal(notifications.length, 0);
  });

  it("already-aborted session signal skips without an LLM call or notify", async () => {
    const abort = new AbortController();
    abort.abort();
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig(),
      null,
      null,
      makeDirectDeps({ ok: false, appliedCount: 0, fallbackReason: "aborted" }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: abort.signal }, ctx);

    assert.equal(directCalls.length, 0);
    assert.equal(mockPi.execCalls.length, 0);
    assert.equal(notifications.length, 0);
  });

  it("direct throw still falls through with leftover", async () => {
    const clock = { t: 0 };
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig(),
      null,
      null,
      {
        now: () => clock.t,
        runDirectMemoryCompletion: async (...args: unknown[]) => {
          directCalls.push(args);
          clock.t += 2_000;
          throw new Error("injected direct flush failure");
        },
      },
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 1);
    assert.equal(mockPi.execCalls[0].args[2].timeout, 58_000 + 5_000);
    assert.equal(notifications.length, 0);
  });

  it("non-positive compact budget skips without an LLM call and stays silent", async () => {
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig({ flushCompactTimeoutMs: 0 }),
      null,
      null,
      makeDirectDeps({ ok: true, appliedCount: 1 }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(directCalls.length, 0);
    assert.equal(mockPi.execCalls.length, 0);
    assert.equal(notifications.length, 0);
  });

  it("subprocess transport takes one child at the full compact ceiling", async () => {
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig({ reviewTransport: "subprocess" }),
      null,
      null,
      makeDirectDeps({ ok: true, appliedCount: 99 }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(directCalls.length, 0);
    assert.equal(mockPi.execCalls.length, 1);
    assert.equal(mockPi.execCalls[0].args[2].timeout, 60_000 + 5_000);
    assert.equal(notifications.length, 0);
  });

  it("compact exec throw does not reject and notifies once", async () => {
    const failingPi = createMockPi();
    failingPi.pi.exec = async () => {
      throw new Error("exec failed");
    };
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      failingPi.pi,
      mockStore,
      null,
      defaultConfig({ reviewTransport: "subprocess" }),
    );

    await primeFlushReady(failingPi.handlers);
    await assert.doesNotReject(async () => {
      await emit(failingPi.handlers, "session_before_compact", { signal: undefined }, ctx);
    });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /flushCompactTimeoutMs/);
  });

  it("default compact ceiling is 60000, not 30000", async () => {
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig(),
      null,
      null,
      makeDirectDeps({ ok: true, appliedCount: 1 }),
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: undefined }, defaultFlushCtx());

    const options = directCalls[0][3];
    assert.ok(options && typeof options === "object" && "timeoutMs" in options);
    assert.equal(options.timeoutMs, 60_000);
  });
  it("child killed by the watchdog (non-zero exit) notifies once", async () => {
    const failingPi = createMockPi();
    failingPi.pi.exec = async () => ({ code: 124, killed: true, stdout: "", stderr: "" });
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      failingPi.pi,
      mockStore,
      null,
      defaultConfig({ reviewTransport: "subprocess" }),
    );

    await primeFlushReady(failingPi.handlers);
    await emit(failingPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /child exited with code 124/);
    assert.match(notifications[0].message, /flushCompactTimeoutMs/);
  });

  it("child killed with a zero exit code still notifies", async () => {
    const failingPi = createMockPi();
    // The signal-kill shape pi.exec resolves: Node reports no exit code for a
    // signalled child, so the flag is the only evidence of the kill.
    failingPi.pi.exec = async () => ({ code: 0, killed: true, stdout: "", stderr: "" });
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      failingPi.pi,
      mockStore,
      null,
      defaultConfig({ reviewTransport: "subprocess" }),
    );

    await primeFlushReady(failingPi.handlers);
    await emit(failingPi.handlers, "session_before_compact", { signal: undefined }, ctx);

    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /child was killed before it saved/);
    assert.match(notifications[0].message, /flushCompactTimeoutMs/);
  });

  it("direct receives the linked budget signal, not the raw session signal", async () => {
    const { ctx } = flushCtxWithNotify();
    const sessionController = new AbortController();
    const seen: AbortSignal[] = [];
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig(),
      null,
      null,
      {
        runDirectMemoryCompletion: async (...args: unknown[]) => {
          const options = args[3] as { signal?: AbortSignal };
          const linked = options.signal;
          seen.push(linked as AbortSignal);
          const { promise, resolve } = Promise.withResolvers<{ ok: boolean; appliedCount: number; fallbackReason: string }>();
          linked?.addEventListener("abort", () => resolve({ ok: false, appliedCount: 0, fallbackReason: "aborted" }), { once: true });
          sessionController.abort(); // synchronous dispatch forwards through linkBudget
          return promise;
        },
      },
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_before_compact", { signal: sessionController.signal }, ctx);

    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], sessionController.signal);
    assert.equal(seen[0].aborted, true);
    assert.equal(mockPi.execCalls.length, 0);
  });
});


describe("shutdown flush budget", () => {
  let mockPi: MockSessionFlushPi;

  beforeEach(() => {
    mockPi = createMockPi();
    directCalls = [];
  });

  it("uses 10s independent of flushCompactTimeoutMs and does not notify", async () => {
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig({
        flushCompactTimeoutMs: 120_000,
        reviewTransport: "subprocess",
      }),
    );

    await primeFlushReady(mockPi.handlers);
    await emitShutdownAndAwaitFlush(mockPi, mockPi.handlers, ctx);
    assert.equal(mockPi.execCalls.length, 1);
    assert.equal(mockPi.execCalls[0].args[2].timeout, 10_000 + 5_000);
    assert.equal(notifications.length, 0);
  });

  it("does not double-pay after a spent shutdown budget and stays silent", async () => {
    const clock = { t: 0 };
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      mockPi.pi,
      mockStore,
      null,
      defaultConfig({ flushCompactTimeoutMs: 120_000 }),
      null,
      null,
      {
        now: () => clock.t,
        runDirectMemoryCompletion: async (...args: unknown[]) => {
          directCalls.push(args);
          clock.t += 10_000;
          return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
        },
      },
    );

    await primeFlushReady(mockPi.handlers);
    await emit(mockPi.handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    assert.equal(directCalls.length, 1);
    assert.equal(mockPi.execCalls.length, 0);
    assert.equal(notifications.length, 0);
  });

  it("exec throw on shutdown does not notify", async () => {
    const failingPi = createMockPi();
    failingPi.pi.exec = async () => {
      throw new Error("exec failed");
    };
    const { ctx, notifications } = flushCtxWithNotify();
    setupSessionFlush(
      failingPi.pi,
      mockStore,
      null,
      defaultConfig({ reviewTransport: "subprocess" }),
    );

    await primeFlushReady(failingPi.handlers);
    await assert.doesNotReject(async () => {
      await emit(failingPi.handlers, "session_shutdown", {}, ctx);
    });
    assert.equal(notifications.length, 0);
  });
});

