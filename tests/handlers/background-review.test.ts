import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildDirectReviewContextParts,
  buildDirectReviewSessionContext,
  buildDirectReviewUserPrompt,
  buildSubprocessReviewPrompt,
  setupBackgroundReview,
  type BackgroundReviewDeps,
} from "../../src/handlers/background-review.js";
import { resolveWatchedChildPiInvocation } from "../../src/handlers/pi-child-process.js";
import type { DirectReviewResult } from "../../src/handlers/review-memory-ops.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Mock infrastructure ───

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
    deps: {
      onReviewSettled: () => reviewSettledSignal.resolve(),
      ...extraDeps,
    },
  });
}

function captureExecArgs(args: any[]): any[] {
  const [command, childArgs, options] = args;
  const capturedArgs = [...childArgs];
  const promptReference = capturedArgs.at(-1);
  if (typeof promptReference === "string" && promptReference.startsWith("@")) {
    capturedArgs[capturedArgs.length - 1] = readFileSync(
      promptReference.slice(1),
      "utf-8",
    );
  }
  return [command, capturedArgs, options];
}

function createMockPi(execReturn?: {
  code: number;
  stdout: string;
  stderr: string;
}) {
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
      content: [
        {
          type: "text",
          text: `Message number ${i} with some real content here`,
        },
      ],
      timestamp: i,
    },
  }));
}

function makeCtx(branch: any[] = [], overrides: Record<string, unknown> = {}) {
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
    fn(
      { message: { role, content: [{ type: "text", text: "hi" }] } },
      makeCtx(),
    );
  }
}

function fireTurnEnd(
  branch: any[] = makeBranch(10),
  ctxOverrides: Record<string, unknown> = {},
) {
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
  const expected = resolveWatchedChildPiInvocation(
    underlying,
    Number(args[1]),
    args[2],
  );
  assert.strictEqual(cmd, expected.command);
  assert.deepStrictEqual(args, expected.args);
  return underlying.command === "pi"
    ? underlying.args
    : underlying.args.slice(1);
}

function reviewPrompt(index = execCalls.length - 1): string {
  const args = logicalChildArgs(index);
  return args[args.length - 1];
}

// ─── Tests ───

describe("buildDirectReviewSessionContext", () => {
  it("keeps only the active branch and preserves custom/tool messages", () => {
    const entries = [
      {
        type: "message",
        id: "root",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "root" }],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "sibling",
        parentId: "root",
        message: {
          role: "user",
          content: [{ type: "text", text: "sibling" }],
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "assistant",
        parentId: "root",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "memory_search",
              arguments: "{}",
            },
          ],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          usage: {},
          stopReason: "toolUse",
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "tool-result",
        parentId: "assistant",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "memory_search",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 4,
        },
      },
      {
        type: "custom_message",
        id: "custom",
        parentId: "tool-result",
        customType: "extension-note",
        content: "custom context",
        display: true,
        details: { source: "test" },
        timestamp: "2026-01-01T00:00:05.000Z",
      },
      {
        type: "message",
        id: "leaf",
        parentId: "custom",
        message: {
          role: "user",
          content: [{ type: "text", text: "leaf" }],
          timestamp: 6,
        },
      },
    ];

    const context = buildDirectReviewSessionContext({
      getSystemPrompt: () => "parent system",
      sessionManager: {
        getBranch: () => entries,
        getLeafId: () => "leaf",
      },
    } as any);

    assert.strictEqual(context?.systemPrompt, "parent system");
    assert.deepStrictEqual(
      context?.messages.map((message) => message.role),
      ["user", "assistant", "toolResult", "user", "user"],
    );
    assert.strictEqual(
      context?.messages.some((message) =>
        message.content?.some(
          (block: any) => block.type === "text" && block.text === "sibling",
        ),
      ),
      false,
    );
    assert.ok(context, "session context expected");
    assert.strictEqual(context.messages[1].content[0].name, "memory_search");
    assert.strictEqual(context.messages[2].content[0].text, "result");
    assert.strictEqual(context.messages[3].content[0].text, "custom context");
  });

  it("preserves an explicit empty leaf instead of falling back to the last entry", () => {
    const context = buildDirectReviewSessionContext({
      getSystemPrompt: () => "parent system",
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            id: "stale",
            parentId: null,
            message: {
              role: "user",
              content: [{ type: "text", text: "stale" }],
              timestamp: 1,
            },
          },
        ],
        getLeafId: () => null,
      },
    } as any);

    assert.deepStrictEqual(context?.messages, []);
  });

  it("formats the SDK context for subprocess prompts", () => {
    const entries = [
      {
        type: "message",
        id: "before",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "before compaction" }],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "kept",
        parentId: "before",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "kept message" }],
          timestamp: 2,
        },
      },
      {
        type: "compaction",
        id: "compact",
        parentId: "kept",
        summary: "compacted history",
        firstKeptEntryId: "kept",
        tokensBefore: 100,
        timestamp: "2026-01-01T00:00:03.000Z",
      },
      {
        type: "branch_summary",
        id: "branch",
        parentId: "compact",
        summary: "returned branch summary",
        fromId: "other-leaf",
        timestamp: "2026-01-01T00:00:04.000Z",
      },
      {
        type: "custom_message",
        id: "custom",
        parentId: "branch",
        customType: "extension-note",
        content: "custom context",
        display: true,
        details: { source: "test" },
        timestamp: "2026-01-01T00:00:05.000Z",
      },
      {
        type: "message",
        id: "after",
        parentId: "custom",
        message: {
          role: "user",
          content: [{ type: "text", text: "after compaction" }],
          timestamp: 6,
        },
      },
    ];

    const parts = buildDirectReviewContextParts({
      sessionManager: {
        getBranch: () => entries,
        getLeafId: () => "after",
      },
    } as any);

    assert.ok(parts);
    assert.ok(parts.some((part) => part.includes("compacted history")));
    assert.ok(parts.some((part) => part.includes("returned branch summary")));
    assert.ok(parts.some((part) => part.includes("custom context")));
    assert.ok(parts.some((part) => part.includes("after compaction")));
    assert.ok(!parts.some((part) => part.includes("before compaction")));
  });

  it("represents the active compaction summary and kept message window", () => {
    const entries = [
      {
        type: "message",
        id: "before",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "before" }],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "kept",
        parentId: "before",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "kept" }],
          timestamp: 2,
        },
      },
      {
        type: "compaction",
        id: "compact",
        parentId: "kept",
        summary: "older context summary",
        firstKeptEntryId: "kept",
        tokensBefore: 100,
        timestamp: "2026-01-01T00:00:03.000Z",
      },
      {
        type: "message",
        id: "after",
        parentId: "compact",
        message: {
          role: "user",
          content: [{ type: "text", text: "after" }],
          timestamp: 4,
        },
      },
    ];

    const context = buildDirectReviewSessionContext({
      getSystemPrompt: () => "parent system",
      sessionManager: {
        getBranch: () => entries,
        getLeafId: () => "after",
      },
    } as any);

    assert.deepStrictEqual(
      context?.messages.map((message) => message.content?.[0]?.text),
      [
        "The conversation history before this point was compacted into the following summary:\n\n<summary>\nolder context summary\n</summary>",
        "kept",
        "after",
      ],
    );
  });
});

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
    config: MemoryConfig = {
      ...defaultConfig,
      reviewTransport: "direct" as const,
    } as MemoryConfig,
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
    assert.ok(
      execCalls.length > 0,
      "exec should be called with 3 user turns and 10 turn_end events",
    );
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
    assert.strictEqual(
      execCalls.length,
      0,
      "exec should NOT be called at 9 turns",
    );

    // 10th turn_end triggers review
    fireTurnEnd();
    await reviewSettledSignal.promise;

    assert.strictEqual(
      execCalls.length,
      1,
      "exec should be called once at turn 10",
    );
    // Verify it calls pi.exec with review prompt
    const cmdArgs = logicalChildArgs(0);
    assert.ok(cmdArgs[0] === "-p", "should use -p flag");
    assert.ok(cmdArgs.includes("--no-session"), "should include --no-session");
    const prompt = reviewPrompt(0);
    assert.match(
      prompt,
      /Do NOT create or modify skills in this background review/i,
    );
    assert.doesNotMatch(
      prompt,
      /save a reusable procedure using the skill tool/i,
    );
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
    assert.deepStrictEqual(cmdArgs.slice(0, 6), [
      "-p",
      "--no-session",
      "--model",
      "openrouter/deepseek/deepseek-v4-flash",
      "--thinking",
      "minimal",
    ]);
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

    assert.strictEqual(
      execCalls.length,
      0,
      "exec should NOT be called when reviewEnabled is false",
    );
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

    assert.strictEqual(
      execCalls.length,
      0,
      "exec should NOT be called with only 2 user turns",
    );
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
        await new Promise<void>((r) => {
          resolveExec = r;
        });
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

    assert.strictEqual(
      execCalls.length,
      1,
      "exec should be called once for first trigger",
    );

    // Fire more turn_end events — should be blocked by reviewInProgress
    for (let i = 0; i < 15; i++) {
      fireTurnEnd();
    }
    await settle(5);

    assert.strictEqual(
      execCalls.length,
      1,
      "exec should still only be called once — reviewInProgress guard",
    );

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
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ];

    for (let i = 0; i < 10; i++) {
      fireTurnEnd(shortBranch);
    }
    await settle();

    assert.strictEqual(
      execCalls.length,
      0,
      "exec should NOT be called for short conversations",
    );
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
    assert.ok(
      prompt.includes("Message number 0"),
      "default should include older messages",
    );
    assert.ok(
      prompt.includes("Message number 9"),
      "default should include latest messages",
    );
  });

  it("uses compaction and branch-aware context in subprocess prompts", async () => {
    const pi = createMockPi();
    setup(pi, defaultConfig);

    const branch = [
      {
        type: "message",
        id: "before",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "before compaction" }],
        },
      },
      {
        type: "message",
        id: "kept",
        parentId: "before",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "kept message" }],
        },
      },
      {
        type: "compaction",
        id: "compact",
        parentId: "kept",
        summary: "compacted history",
        firstKeptEntryId: "kept",
        tokensBefore: 100,
        timestamp: "2026-01-01T00:00:03.000Z",
      },
      {
        type: "branch_summary",
        id: "branch",
        parentId: "compact",
        summary: "returned branch summary",
        fromId: "other-leaf",
        timestamp: "2026-01-01T00:00:04.000Z",
      },
      {
        type: "custom_message",
        id: "custom",
        parentId: "branch",
        customType: "extension-note",
        content: "custom context",
        display: true,
        details: { source: "test" },
        timestamp: "2026-01-01T00:00:05.000Z",
      },
      {
        type: "message",
        id: "after",
        parentId: "custom",
        message: {
          role: "user",
          content: [{ type: "text", text: "after compaction" }],
        },
      },
      {
        type: "message",
        id: "final",
        parentId: "after",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final message" }],
        },
      },
    ];

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(branch, {
        sessionManager: {
          getBranch: () => branch,
          getLeafId: () => "final",
        },
      });
    }
    await reviewSettledSignal.promise;

    const prompt = reviewPrompt();
    assert.match(prompt, /compacted history/);
    assert.match(prompt, /returned branch summary/);
    assert.match(prompt, /custom context/);
    assert.match(prompt, /after compaction/);
    assert.match(prompt, /final message/);
    assert.doesNotMatch(prompt, /before compaction/);
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
    assert.ok(
      !prompt.includes("Message number 6"),
      "window should exclude older messages",
    );
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

    assert.ok(
      reviewPrompt().includes("Message number 0"),
      "flush limit must not affect review",
    );
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

    assert.strictEqual(
      execCalls.length,
      1,
      "full conversation has enough parts to review",
    );
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

    assert.strictEqual(
      execCalls.length,
      2,
      "second review should trigger after counter reset",
    );
  });

  it("shows notification only when review saves something", async () => {
    const pi = createMockPi({
      code: 0,
      stdout: "Saved new memory about user preferences",
      stderr: "",
    });
    setup(pi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    // 10 diagnostic notifications + 1 auto-review notification
    const reviewNotify = notifyCalls.find((n) =>
      n.msg.includes("Memory auto-reviewed"),
    );
    assert.ok(
      reviewNotify,
      "should have a 'Memory auto-reviewed' notification",
    );

    // Reset and test "nothing to save" case
    handlers = {};
    execCalls = [];
    notifyCalls = [];
    resetReviewSettledSignal();

    const nothingPi = createMockPi({
      code: 0,
      stdout: "Nothing to save.",
      stderr: "",
    });
    setup(nothingPi, defaultConfig);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    const reviewNotify2 = notifyCalls.find((n) =>
      n.msg.includes("Memory auto-reviewed"),
    );
    assert.strictEqual(
      reviewNotify2,
      undefined,
      "no 'Memory auto-reviewed' notification for 'nothing to save'",
    );
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

    assert.strictEqual(
      execCalls.length,
      0,
      "exec should NOT be called — no user messages",
    );
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

    assert.ok(
      execCalls.length >= 1,
      "exec should be called due to tool call threshold",
    );
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

    assert.ok(
      execCalls.length >= 1,
      "exec should be called when either threshold is met",
    );
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
    assert.strictEqual(
      execCalls.length,
      2,
      "second review should trigger after counter reset",
    );
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

    assert.strictEqual(
      execCalls.length,
      0,
      "exec should NOT be called when neither threshold met",
    );
  });

  it("ignores text blocks when counting tool calls", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // Branch with text-only messages (no toolCall blocks)
    const branchWithTextOnly = [...makeBranch(10)];

    // Fire enough turns but no tool calls
    for (let i = 0; i < 5; i++) {
      fireTurnEnd(branchWithTextOnly);
    }
    await settle();

    assert.strictEqual(
      execCalls.length,
      0,
      "exec should NOT be called — no toolCall blocks, turn threshold not met",
    );
  });

  it("uses direct review by default and does not call subprocess", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(
      pi,
      { ok: true, appliedCount: 1 },
      {
        ...defaultConfig,
        reviewTransport: "direct",
      },
    );

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(directCalls.length, 1, "direct review should run once");
    assert.strictEqual(
      execCalls.length,
      0,
      "subprocess should not run on successful direct review",
    );
    const directOptions = directCalls[0][3] as { systemPrompt: string };
    assert.match(directOptions.systemPrompt, /target routing/i);
    assert.match(directOptions.systemPrompt, /use target "memory"/i);
    assert.match(directOptions.systemPrompt, /do not emit target "project"/i);
    const reviewNotify = notifyCalls.find((n) =>
      n.msg.includes("Memory auto-reviewed"),
    );
    assert.ok(reviewNotify, "should notify when direct review applies memory");
  });

  it("passes the active session context and thinking level to direct review", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(
      pi,
      { ok: true, appliedCount: 0 },
      {
        ...defaultConfig,
        reviewTransport: "direct",
      },
    );

    const branch = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Message number 0" }],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Message number 1" }],
          timestamp: 2,
        },
      },
      {
        type: "thinking_level_change",
        id: "thinking-1",
        parentId: "assistant-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        thinkingLevel: "high",
      },
      {
        type: "message",
        id: "user-2",
        parentId: "thinking-1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Message number 2" }],
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "user-2",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Message number 3" }],
          timestamp: 4,
        },
      },
    ];

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(branch, {
        sessionManager: {
          getBranch: () => branch,
          getEntries: () => branch,
          getLeafId: () => "assistant-2",
        },
        getSystemPrompt: () => "main-system-prompt",
        model: { provider: "local", id: "qwen" },
      });
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(directCalls.length, 1);
    const options = directCalls[0][3] as {
      systemPrompt: string;
      userPrompt: string;
      context?: {
        systemPrompt: string;
        thinkingLevel: string;
        messages: any[];
      };
    };
    assert.strictEqual(options.context?.systemPrompt, "main-system-prompt");
    assert.strictEqual(options.context?.thinkingLevel, "high");
    assert.deepStrictEqual(
      options.context?.messages.map((message) => message.content?.[0]?.text),
      [
        "Message number 0",
        "Message number 1",
        "Message number 2",
        "Message number 3",
      ],
    );
    assert.ok(!options.userPrompt.includes("Message number 0"));
    assert.strictEqual(options.systemPrompt, "main-system-prompt");
  });

  it("falls back to subprocess when direct review cannot run", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(
      pi,
      { ok: false, appliedCount: 0, fallbackReason: "no_model" },
      {
        ...defaultConfig,
        reviewTransport: "direct",
      },
    );

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(
      directCalls.length,
      1,
      "direct review should be attempted first",
    );
    assert.strictEqual(
      execCalls.length,
      1,
      "subprocess should run as fallback",
    );
  });

  it("falls back to subprocess when direct review returns no_content", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(
      pi,
      { ok: false, appliedCount: 0, fallbackReason: "no_content" },
      {
        ...defaultConfig,
        reviewTransport: "direct",
      },
    );

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    assert.strictEqual(
      directCalls.length,
      1,
      "direct review should be attempted first",
    );
    assert.strictEqual(
      execCalls.length,
      1,
      "subprocess should run as fallback for no_content",
    );
  });

  it("does not inherit active thinking when subprocess transport is forced", async () => {
    const pi = createMockPi();
    setup(pi, {
      ...defaultConfig,
      reviewTransport: "subprocess",
    } as MemoryConfig);

    const branch = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "first" }] },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
        },
      },
      {
        type: "thinking_level_change",
        id: "thinking-1",
        parentId: "assistant-1",
        thinkingLevel: "high",
      },
      {
        type: "message",
        id: "user-2",
        parentId: "thinking-1",
        message: { role: "user", content: [{ type: "text", text: "third" }] },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "user-2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fourth" }],
        },
      },
    ];

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(branch, {
        sessionManager: {
          getBranch: () => branch,
          getLeafId: () => "assistant-2",
        },
        model: { provider: "local-llama", id: "local-9b" },
      });
    }
    await reviewSettledSignal.promise;

    assert.deepStrictEqual(logicalChildArgs(0).slice(0, 5), [
      "-p",
      "--no-session",
      "--model",
      "local-llama/local-9b",
      "--no-extensions",
    ]);
  });

  it("inherits the active thinking level for subprocess fallback", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(
      pi,
      { ok: false, appliedCount: 0, fallbackReason: "no_auth" },
      {
        ...defaultConfig,
        reviewTransport: "direct",
      },
    );

    const messageBranch = makeBranch(4).map((entry, index) => ({
      ...entry,
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
    }));
    const branch = [
      ...messageBranch,
      {
        type: "thinking_level_change",
        id: "thinking-1",
        parentId: "message-3",
        timestamp: "2026-01-01T00:00:04.000Z",
        thinkingLevel: "high",
      },
    ];
    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(branch, {
        sessionManager: {
          getBranch: () => branch,
          getLeafId: () => "thinking-1",
        },
        getSystemPrompt: () => "main-system-prompt",
        model: { provider: "local-llama", id: "local-9b" },
      });
    }
    await reviewSettledSignal.promise;

    assert.deepStrictEqual(logicalChildArgs(0).slice(0, 7), [
      "-p",
      "--no-session",
      "--model",
      "local-llama/local-9b",
      "--thinking",
      "high",
      "--no-extensions",
    ]);
  });

  it("inherits the active session model and execution context for subprocess fallback", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(
      pi,
      { ok: false, appliedCount: 0, fallbackReason: "no_auth" },
      {
        ...defaultConfig,
        reviewTransport: "direct",
      },
    );

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");
    const signal = new AbortController().signal;
    for (let i = 0; i < 10; i++) {
      fireTurnEnd(makeBranch(10), {
        cwd: "/tmp/local-session",
        model: { provider: "local-llama", id: "local-9b" },
        signal,
      });
    }
    await reviewSettledSignal.promise;

    assert.deepStrictEqual(logicalChildArgs(0).slice(0, 5), [
      "-p",
      "--no-session",
      "--model",
      "local-llama/local-9b",
      "--no-extensions",
    ]);
    assert.deepStrictEqual(execCalls[0][2], {
      cwd: "/tmp/local-session",
      timeout: 125000,
    });
  });

  it("surfaces one actionable diagnostic when direct and subprocess review both fail", async () => {
    const pi = createMockPi({
      code: 1,
      stdout: "",
      stderr: "No API key for local-llama/local-9b",
    });
    setupWithDirectDeps(
      pi,
      {
        ok: false,
        appliedCount: 0,
        fallbackReason: "no_auth",
        error: "No API key for local-llama",
      },
      {
        ...defaultConfig,
        reviewTransport: "direct",
      },
    );

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

    assert.strictEqual(
      directCalls.length,
      1,
      "direct review should be attempted first",
    );
    assert.strictEqual(
      execCalls.length,
      1,
      "subprocess should run as fallback when direct review throws",
    );
  });

  it("does not notify when direct review returns no operations", async () => {
    const pi = createMockPi();
    setupWithDirectDeps(
      pi,
      { ok: true, appliedCount: 0, fallbackReason: "empty" },
      {
        ...defaultConfig,
        reviewTransport: "direct",
      },
    );

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    for (let i = 0; i < 10; i++) {
      fireTurnEnd();
    }
    await reviewSettledSignal.promise;

    const reviewNotify = notifyCalls.find((n) =>
      n.msg.includes("Memory auto-reviewed"),
    );
    assert.strictEqual(
      reviewNotify,
      undefined,
      "empty direct review should not notify",
    );
    assert.strictEqual(
      execCalls.length,
      0,
      "empty direct review should not fall back",
    );
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

  it("falls back gracefully if getBranch throws", async () => {
    const config = { ...defaultConfig, nudgeToolCalls: 3 };
    const pi = createMockPi();
    setup(pi, config);

    fireMessageEnd("user");
    fireMessageEnd("user");
    fireMessageEnd("user");

    // getBranch throws — should not crash
    const crashCtx = {
      sessionManager: {
        getBranch: () => {
          throw new Error("session expired");
        },
      },
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
