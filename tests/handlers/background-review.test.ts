import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildDirectReviewUserPrompt,
  buildSubprocessReviewPrompt,
  setupBackgroundReview,
  type BackgroundReviewDeps,
} from "../../src/handlers/background-review.js";
import { resolveWatchedChildPiInvocation } from "../../src/handlers/pi-child-process.js";
import type { DirectReviewResult } from "../../src/handlers/review-memory-ops.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Mock infrastructure ───

interface CallLog {
  handler: string;
  args: any[];
}

let handlers: Record<string, Function[]>;
let execCalls: any[];
let directCalls: any[];
let notifyCalls: any[];

// The turn_end handler intentionally does not await its review work
// (fire-and-forget, so background review never blocks interactive chat —
// see #10 in CHANGELOG.md). Tests can't just await fireTurnEnd(), so setup()
// below wires the production-side onReviewSettled test hook (fired once
// runReview() and its .finally() cleanup fully complete, regardless of
// outcome) instead of racing exec-call timing or a fixed sleep.
let reviewSettledSignal: PromiseWithResolvers<void>;

function resetReviewSettledSignal(): void {
  reviewSettledSignal = Promise.withResolvers<void>();
}

function setup(
  pi: ExtensionAPI,
  config: MemoryConfig = defaultConfig as MemoryConfig,
  extraDeps: BackgroundReviewDeps = {},
): void {
  setupBackgroundReview(pi, mockStore, null, config, {
    deps: { onReviewSettled: () => reviewSettledSignal.resolve(), ...extraDeps },
  });
}

function captureExecArgs(args: any[]): any[] {
  const [command, childArgs, options] = args;
  const capturedArgs = [...childArgs];
  const promptReference = capturedArgs.at(-1);
  if (typeof promptReference === "string" && promptReference.startsWith("@")) {
    capturedArgs[capturedArgs.length - 1] = readFileSync(promptReference.slice(1), "utf-8");
  }
  return [command, capturedArgs, options];
}

function createMockPi(execReturn?: { code: number; stdout: string; stderr: string }) {
  const defaultReturn = { code: 0, stdout: "Saved memory", stderr: "" };
  const ret = execReturn ?? defaultReturn;

  return {
    on: (event: string, handler: Function) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    },
    exec: async (...args: any[]) => {
      execCalls.push(captureExecArgs(args));
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
  reviewTransport: "subprocess" as const,
  nudgeInterval: 10,
  reviewRecentMessages: 0,
  flushMinTurns: 6,
  flushRecentMessages: 0,
  flushOnCompact: true,
  flushOnShutdown: true,
  memoryCharLimit: 5000,
  userCharLimit: 5000,
  projectCharLimit: 5000,
  autoConsolidate: true,
  correctionDetection: true,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: 7,
  failureInjectionMaxEntries: 5,
  nudgeToolCalls: 15,
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
  // Extract the last assistant message from the branch to pass as event.message
  // (the handler now reads tool calls from event.message, not from the branch)
  let assistantMessage = undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.message?.role === "assistant") {
      assistantMessage = branch[i].message;
      break;
    }
  }
  const event = assistantMessage ? { message: assistantMessage } : {};
  for (const fn of h) {
    fn(event, ctx);
  }
  return ctx;
}

// Only for genuinely negative assertions (nothing should have happened),
// where there is no positive side effect to await instead.
async function settle(ms = 10): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

function logicalChildArgs(index = execCalls.length - 1): string[] {
  const [cmd, args] = execCalls[index];
  const underlying = { command: args[3], args: args.slice(4) };
  const expected = resolveWatchedChildPiInvocation(underlying, Number(args[1]), args[2]);
  assert.strictEqual(cmd, expected.command);
  assert.deepStrictEqual(args, expected.args);
  return underlying.command === "pi" ? underlying.args : underlying.args.slice(1);
}

function reviewPrompt(index = execCalls.length - 1): string {
  const args = logicalChildArgs(index);
  return args[args.length - 1];
}

// ─── Tests ───

describe("setupBackgroundReview", () => {
  beforeEach(() => {
    handlers = {};
    execCalls = [];
    directCalls = [];
    notifyCalls = [];
    resetReviewSettledSignal();
  });

  function setupWithDirectDeps(
    pi: ExtensionAPI,
    directResult: DirectReviewResult,
    config: MemoryConfig = { ...defaultConfig, reviewTransport: "direct" as const } as MemoryConfig,
  ): void {
    setup(pi, config, {
      runDirectReview: async (...args: any[]) => {
        directCalls.push(args);
        return directResult;
      },
    });
  }

  it("increments user turn count on message_end for user messages", async () => {
    const pi = createMockPi();
    setup(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Verify by checking that 3 user turns is enough to allow review
    // (userTurnCount >= 3 check passes after 3 user message_end events)
    // Fire 10 turn_end events — should trigger review since userTurnCount is 3
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    // exec should have been called since we have 3 user turns and 10 turn_end events
    assert.ok(execCalls.length > 0, "exec should be called with 3 user turns and 10 turn_end events");
  });

  it("triggers review at nudgeInterval (10) turns", async () => {
    const pi = createMockPi();
    setup(pi, defaultConfig);

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
    await reviewSettledSignal.promise;

    assert.strictEqual(execCalls.length, 1, "exec should be called once at turn 10");
    // Verify it calls pi.exec with review prompt
    const cmdArgs = logicalChildArgs(0);
    assert.ok(cmdArgs[0] === "-p", "should use -p flag");
    assert.ok(cmdArgs.includes("--no-session"), "should include --no-session");
    const prompt = reviewPrompt(0);
    assert.match(prompt, /Do NOT create or modify skills in this background review/i);
    assert.doesNotMatch(prompt, /save a reusable procedure using the skill tool/i);
  });

  it("passes child LLM override args to the review subprocess", async () => {
    const pi = createMockPi();
    setup(pi, {
      ...defaultConfig,
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
      llmThinkingOverride: "minimal",
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    const cmdArgs = logicalChildArgs(0);
    assert.deepStrictEqual(
      cmdArgs.slice(0, 6),
      ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "minimal"],
    );
  });

  it("does NOT trigger review when reviewEnabled is false", async () => {
    const config = { ...defaultConfig, reviewEnabled: false };
    const pi = createMockPi();
    setup(pi, config);

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
    setup(pi, defaultConfig);

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
        execCalls.push(captureExecArgs(args));
        await new Promise<void>((r) => { resolveExec = r; });
        return { code: 0, stdout: "Saved", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    setup(slowPi, defaultConfig);

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
    setup(pi, defaultConfig);

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

  it("uses the full conversation by default", async () => {
    const pi = createMockPi();
    setup(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await reviewSettledSignal.promise;

    const prompt = reviewPrompt();
    assert.ok(prompt.includes("Message number 0"), "default should include older messages");
    assert.ok(prompt.includes("Message number 9"), "default should include latest messages");
  });

  it("limits background review to recent messages when configured", async () => {
    const config = { ...defaultConfig, reviewRecentMessages: 3 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await reviewSettledSignal.promise;

    const prompt = reviewPrompt();
    assert.ok(!prompt.includes("Message number 6"), "window should exclude older messages");
    assert.ok(prompt.includes("Message number 7"));
    assert.ok(prompt.includes("Message number 8"));
    assert.ok(prompt.includes("Message number 9"));
  });

  it("does not use the flush recent-message limit for background review", async () => {
    const config = { ...defaultConfig, flushRecentMessages: 2 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await reviewSettledSignal.promise;

    assert.ok(reviewPrompt().includes("Message number 0"), "flush limit must not affect review");
  });

  it("keeps the short conversation guard based on the full conversation", async () => {
    const config = { ...defaultConfig, reviewRecentMessages: 2 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(4));
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(execCalls.length, 1, "full conversation has enough parts to review");
    const prompt = reviewPrompt();
    assert.ok(!prompt.includes("Message number 0"));
    assert.ok(!prompt.includes("Message number 1"));
    assert.ok(prompt.includes("Message number 2"));
    assert.ok(prompt.includes("Message number 3"));
  });

  it("resets turn counter after review triggers", async () => {
    const pi = createMockPi();
    setup(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Fire 10 turns — triggers review
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(execCalls.length, 1, "first review triggered");

    // Fire 10 more turns — should trigger again (counter was reset)
    resetReviewSettledSignal();
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(execCalls.length, 2, "second review should trigger after counter reset");
  });

  it("shows notification only when review saves something", async () => {
    const pi = createMockPi({ code: 0, stdout: "Saved new memory about user preferences", stderr: "" });
    setup(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    // 10 diagnostic notifications + 1 auto-review notification
    const reviewNotify = notifyCalls.find(n => n.msg.includes("Memory auto-reviewed"));
    assert.ok(reviewNotify, "should have a 'Memory auto-reviewed' notification");

    // Reset and test "nothing to save" case
    handlers = {};
    execCalls = [];
    notifyCalls = [];
    resetReviewSettledSignal();

    const nothingPi = createMockPi({ code: 0, stdout: "Nothing to save.", stderr: "" });
    setup(nothingPi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    const reviewNotify2 = notifyCalls.find(n => n.msg.includes("Memory auto-reviewed"));
    assert.strictEqual(reviewNotify2, undefined, "no 'Memory auto-reviewed' notification for 'nothing to save'");
  });

  it("does NOT crash agent when exec throws", async () => {
    const crashPi = {
      on: (event: string, handler: Function) => {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
      },
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        throw new Error("exec crashed");
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    setup(crashPi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // This should NOT throw
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(execCalls.length, 1, "exec was attempted");
    // If we get here without an unhandled rejection, the error was caught
    assert.ok(true, "background review failure was caught silently");
  });

  it("assistant message_end does NOT increment user turn count", async () => {
    const pi = createMockPi();
    setup(pi, defaultConfig);

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

  // ─── Tool-call-aware nudge tests (Epic 4) ───

  it("triggers on tool call count threshold even with low turn count", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 5 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Branch with 5 toolCall blocks (meets tool call threshold)
    const branchWithToolCalls = [
      ...makeBranch(4),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
            { type: "toolCall", id: "tc3", name: "edit", arguments: {} },
            { type: "toolCall", id: "tc4", name: "read", arguments: {} },
            { type: "toolCall", id: "tc5", name: "bash", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    // Only 2 turn_end events (below turn threshold of 10)
    fireTurnEnd(branchWithToolCalls);
    fireTurnEnd(branchWithToolCalls);
    await reviewSettledSignal.promise;

    assert.ok(execCalls.length >= 1, "exec should be called due to tool call threshold");
  });

  it("triggers when both thresholds are met", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 5 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const branchWithToolCalls = [
      ...makeBranch(10),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    // Fire 10 turns (meets turn threshold) with tool calls (meets tool threshold)
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(branchWithToolCalls);
    }
    await reviewSettledSignal.promise;

    assert.ok(execCalls.length >= 1, "exec should be called when either threshold is met");
  });

  it("resets both counters after review", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    const branchWithToolCalls = [
      ...makeBranch(6),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
            { type: "toolCall", id: "tc3", name: "edit", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    // Trigger first review via tool calls
    fireTurnEnd(branchWithToolCalls);
    await reviewSettledSignal.promise;
    assert.strictEqual(execCalls.length, 1, "first review triggered");

    // Trigger second review via turn count
    resetReviewSettledSignal();
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10));
    }
    await reviewSettledSignal.promise;
    assert.strictEqual(execCalls.length, 2, "second review should trigger after counter reset");
  });

  it("does not trigger when neither threshold is met", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 15 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Only 2 tool calls (below 15 threshold) and 5 turns (below 10 threshold)
    const branchWithFewToolCalls = [
      ...makeBranch(4),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
            { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
          ],
          timestamp: 1,
        },
      },
    ];

    for (let i = 0; i < 5; i++) {
      fireTurnEnd(branchWithFewToolCalls);
    }
    await settle();

    assert.strictEqual(execCalls.length, 0, "exec should NOT be called when neither threshold met");
  });

  it("ignores text blocks when counting tool calls", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Branch with text-only messages (no toolCall blocks)
    const branchWithTextOnly = [
      ...makeBranch(10),
    ];

    // Fire enough turns but no tool calls
    for (let i = 0; i < 5; i++) {
      fireTurnEnd(branchWithTextOnly);
    }
    await settle();

    assert.strictEqual(execCalls.length, 0, "exec should NOT be called — no toolCall blocks, turn threshold not met");
  });

  it("uses direct review by default and does not call subprocess", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(pi, { ok: true, appliedCount: 1 }, {
      ...defaultConfig,
      reviewTransport: "direct",
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(directCalls.length, 1, "direct review should run once");
    assert.strictEqual(execCalls.length, 0, "subprocess should not run on successful direct review");
    const directOptions = directCalls[0][3] as { systemPrompt: string };
    assert.match(directOptions.systemPrompt, /target routing/i);
    assert.match(directOptions.systemPrompt, /use target "memory"/i);
    assert.match(directOptions.systemPrompt, /do not emit target "project"/i);
    const reviewNotify = notifyCalls.find((n) => n.msg.includes("Memory auto-reviewed"));
    assert.ok(reviewNotify, "should notify when direct review applies memory");
  });

  it("falls back to subprocess when direct review cannot run", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(pi, { ok: false, appliedCount: 0, fallbackReason: "no_model" }, {
      ...defaultConfig,
      reviewTransport: "direct",
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(directCalls.length, 1, "direct review should be attempted first");
    assert.strictEqual(execCalls.length, 1, "subprocess should run as fallback");
  });
  it("inherits the active session model and cwd without coupling fallback to the agent run signal", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(pi, { ok: false, appliedCount: 0, fallbackReason: "no_auth" }, {
      ...defaultConfig,
      reviewTransport: "direct",
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    const controller = new AbortController();
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10), {
        cwd: "/tmp/local-session",
        model: { provider: "local-llama", id: "local-9b" },
        signal: controller.signal,
      });
    }
    controller.abort();
    await reviewSettledSignal.promise;

    assert.deepStrictEqual(logicalChildArgs(0).slice(0, 5), [
      "-p", "--no-session", "--model", "local-llama/local-9b", "--no-extensions",
    ]);
    assert.deepStrictEqual(execCalls[0][2], {
      cwd: "/tmp/local-session",
      timeout: 125000,
    });
  });

  it("surfaces one actionable diagnostic when direct and subprocess review both fail", async () => {
    const pi = createMockPi({ code: 1, stdout: "", stderr: "No API key for local-llama/local-9b" });
    setupWithDirectDeps(pi, {
      ok: false,
      appliedCount: 0,
      fallbackReason: "no_auth",
      error: "No API key for local-llama",
    }, {
      ...defaultConfig,
      reviewTransport: "direct",
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10), {
        model: { provider: "local-llama", id: "local-9b" },
      });
    }
    await reviewSettledSignal.promise;

    const failures = notifyCalls.filter((n) => n.level === "warning");
    assert.equal(failures.length, 1);
    assert.match(failures[0].msg, /both transports/i);
    assert.match(failures[0].msg, /no_auth/i);
    assert.match(failures[0].msg, /No API key for local-llama\/local-9b/i);
    assert.match(failures[0].msg, /llmModelOverride/i);
  });


  it("falls back to subprocess when direct review throws", async () => {
    const pi = createMockPi();
    setup(pi, { ...defaultConfig, reviewTransport: "direct" } as MemoryConfig, {
      runDirectReview: async (...args: any[]) => {
        directCalls.push(args);
        throw new Error("direct transport exploded");
      },
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(directCalls.length, 1, "direct review should be attempted first");
    assert.strictEqual(execCalls.length, 1, "subprocess should run as fallback when direct review throws");
  });

  it("does not notify when direct review returns no operations", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(pi, { ok: true, appliedCount: 0, fallbackReason: "empty" }, {
      ...defaultConfig,
      reviewTransport: "direct",
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    const reviewNotify = notifyCalls.find((n) => n.msg.includes("Memory auto-reviewed"));
    assert.strictEqual(reviewNotify, undefined, "empty direct review should not notify");
    assert.strictEqual(execCalls.length, 0, "empty direct review should not fall back");
  });

  it("includes explicit target routing for an available project store", () => {
    const prompt = buildSubprocessReviewPrompt({
      parts: ["[USER] hello", "[ASSISTANT] hi"],
      currentMemory: "global fact",
      currentUser: "user preference",
      currentProject: "project convention",
    });

    assert.match(prompt, /project-specific facts.*target "project"/i);
    assert.match(prompt, /global or cross-project facts.*target "memory"/i);
    assert.match(prompt, /failures, corrections.*target "failure"/i);
  });

  it("keeps project target unavailable when no project store is present", () => {
    const prompt = buildSubprocessReviewPrompt({
      parts: ["[USER] hello", "[ASSISTANT] hi"],
      currentMemory: "global fact",
      currentUser: "user preference",
      currentProject: null,
    });

    assert.match(prompt, /do not emit target "project"/i);
    assert.match(prompt, /use target "memory"/i);
    assert.match(prompt, /target "failure"/i);
    assert.doesNotMatch(prompt, /--- Current Project Memory ---/i);
  });

  it("builds separate prompts for direct and subprocess transports", () => {
    const input = {
      parts: ["[USER] hello", "[ASSISTANT] hi"],
      currentMemory: "uses pnpm",
      currentUser: "likes TypeScript",
      currentProject: "monorepo layout",
    };

    const subprocessPrompt = buildSubprocessReviewPrompt(input);
    const directPrompt = buildDirectReviewUserPrompt(input);

    assert.match(subprocessPrompt, /save using memory_add/i);
    assert.match(directPrompt, /Conversation to Review/);
    assert.doesNotMatch(directPrompt, /save using memory_add/i);
    assert.ok(subprocessPrompt.includes("uses pnpm"));
    assert.ok(directPrompt.includes("monorepo layout"));
  });

  it("does not forward the turn abort signal to the child review", async () => {
    let capturedSignal: AbortSignal | undefined;
    const childGate = Promise.withResolvers<void>();
    const pi = createMockPi();
    setup(pi, defaultConfig, {
      execChildPrompt: async (_api, _prompt, _config, options) => {
        capturedSignal = options.signal;
        await childGate.promise;
        return { code: 0, stdout: "Saved memory", stderr: "" };
      },
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    const turnAbort = new AbortController();
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10), { signal: turnAbort.signal });
    }
    await settle(5);

    assert.ok(capturedSignal, "child review must receive a session signal");
    assert.notStrictEqual(capturedSignal, turnAbort.signal);
    turnAbort.abort();
    await settle(5);
    assert.equal(capturedSignal.aborted, false, "turn abort must not cancel session review");

    childGate.resolve();
    await reviewSettledSignal.promise;
  });

  it("session_shutdown aborts the child signal, waits for review, and stays silent", async () => {
    let capturedSignal: AbortSignal | undefined;
    const childGate = Promise.withResolvers<void>();
    let childStarted = 0;
    const pi = createMockPi();
    setup(pi, defaultConfig, {
      execChildPrompt: async (_api, _prompt, _config, options) => {
        childStarted++;
        capturedSignal = options.signal;
        await childGate.promise;
        return { code: 0, stdout: "Saved memory", stderr: "" };
      },
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle(5);
    assert.ok(capturedSignal);
    assert.equal(capturedSignal.aborted, false);

    const shutdownHandlers = handlers["session_shutdown"];
    assert.ok(shutdownHandlers?.length, "session_shutdown handler must be registered");
    const first = shutdownHandlers[0]({}, makeCtx());
    const second = shutdownHandlers[0]({}, makeCtx());
    assert.strictEqual(first, second, "repeated session_shutdown must reuse the same promise");
    assert.equal(capturedSignal.aborted, true);

    let shutdownDone = false;
    void Promise.resolve(first).then(() => {
      shutdownDone = true;
    });
    await settle(5);
    assert.equal(shutdownDone, false, "shutdown must wait for the in-flight review");

    childGate.resolve();
    await first;
    await reviewSettledSignal.promise;
    assert.equal(shutdownDone, true);
    assert.equal(
      notifyCalls.some((n) => n.msg.includes("Memory auto-reviewed") || n.level === "warning"),
      false,
      "cancelled review must not notify success or failure",
    );

    resetReviewSettledSignal();
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle(10);
    assert.equal(childStarted, 1, "cancelled session must not start another review");
  });

  it("does not start fallback after session cancellation", async () => {
    const directGate = Promise.withResolvers<void>();
    let childStarted = 0;
    const pi = createMockPi();
    setup(pi, { ...defaultConfig, reviewTransport: "direct" } as MemoryConfig, {
      runDirectReview: async () => {
        await directGate.promise;
        return { ok: true, appliedCount: 1 };
      },
      execChildPrompt: async () => {
        childStarted++;
        return { code: 0, stdout: "Saved memory", stderr: "" };
      },
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle(5);

    const shutdown = handlers["session_shutdown"][0]({}, makeCtx());
    directGate.resolve();
    await shutdown;
    await reviewSettledSignal.promise;

    assert.equal(childStarted, 0, "cancelled session must not start subprocess fallback");
    assert.equal(
      notifyCalls.some((n) => n.msg.includes("Memory auto-reviewed") || n.level === "warning"),
      false,
    );
  });

  it("session_shutdown resolves after the grace bound when review ignores abort", async () => {
    let started = false;
    const pi = createMockPi();
    setup(pi, { ...defaultConfig, reviewTransport: "direct" } as MemoryConfig, {
      shutdownGraceMs: 20,
      runDirectReview: async () => {
        started = true;
        await new Promise(() => {});
        return { ok: true, appliedCount: 1 };
      },
    });

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await settle(5);
    assert.equal(started, true);

    const first = handlers["session_shutdown"][0]({}, makeCtx());
    const second = handlers["session_shutdown"][0]({}, makeCtx());
    assert.strictEqual(first, second);
    const startedAt = Date.now();
    await first;
    assert.ok(Date.now() - startedAt < 200, "shutdown must not wait for a review that ignores abort");
    assert.equal(
      notifyCalls.some((n) => n.msg.includes("Memory auto-reviewed") || n.level === "warning"),
      false,
    );
  });

  it("falls back gracefully if getBranch throws", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // getBranch throws — should not crash
    const crashCtx = {
      sessionManager: { getBranch: () => { throw new Error("session expired"); } },
      signal: undefined as any,
      ui: { notify: () => {} },
    };

    const h = handlers["turn_end"];
    // Fire 10 turns with crashing getBranch
    for (let i = 0; i < 10; i++) {
      for (const fn of h) {
        fn({}, crashCtx);
      }
    }
    await settle();

    // Should not throw — we got here = test passed
    assert.ok(true, "no crash when getBranch throws");
  });
});
