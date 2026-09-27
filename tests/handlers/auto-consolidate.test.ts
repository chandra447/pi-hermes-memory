/**
 * Unit tests for auto-consolidation — triggerConsolidation and /memory-consolidate command.
 */

import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { registerConsolidateCommand, triggerConsolidation } from "../../src/handlers/auto-consolidate.js";
import { resolveWatchedChildPiInvocation } from "../../src/handlers/pi-child-process.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import { DatabaseManager } from "../../src/store/db.js";
import { addMemory, recordSearchHits } from "../../src/store/sqlite-memory-store.js";
import {
  DEFAULT_CONSOLIDATION_CHUNK_CHARS,
  MAX_CONSOLIDATION_ROUNDS,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  ENTRY_DELIMITER,
} from "../../src/constants.js";
import { takeChunk } from "../../src/handlers/auto-consolidate.js";

// ─── Mock infrastructure ───

let execCalls: any[];
let directCalls: unknown[][];

const directTransportLlmConfig = { reviewTransport: "direct" as const, consolidationChunking: true };

function createDirectCtx(): { model: unknown; modelRegistry: unknown; _tag: string } {
  return { model: {}, modelRegistry: {}, _tag: "consolidation-direct-ctx" };
}

function makeDirectDeps(
  result: { ok: boolean; appliedCount: number; fallbackReason?: string } | "throw",
): { runDirectMemoryCompletion: (...args: unknown[]) => Promise<{ ok: boolean; appliedCount: number; fallbackReason?: string }> } {
  return {
    runDirectMemoryCompletion: async (...args: unknown[]) => {
      directCalls.push(args);
      if (result === "throw") throw new Error("injected direct consolidation failure");
      return result;
    },
  };
}
let LOCK_DIR = "";
const OLD_LOCK_DIR = process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR;

function captureExecArgs(args: any[]): any[] {
  const [command, childArgs, options] = args;
  const capturedArgs = [...childArgs];
  const promptReference = capturedArgs.at(-1);
  if (typeof promptReference === "string" && promptReference.startsWith("@")) {
    capturedArgs[capturedArgs.length - 1] = readFileSync(promptReference.slice(1), "utf-8");
  }
  return [command, capturedArgs, options];
}
before(async () => {
  LOCK_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-lock-"));
  process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = LOCK_DIR;
});

after(async () => {
  if (OLD_LOCK_DIR === undefined) {
    delete process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR;
  } else {
    process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = OLD_LOCK_DIR;
  }
  try { await fs.rm(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function logicalChildArgs(call: any[]): string[] {
  const [cmd, args] = call;
  const underlying = { command: args[3], args: args.slice(4) };
  const expected = resolveWatchedChildPiInvocation(underlying, Number(args[1]), args[2]);
  assert.deepStrictEqual({ command: cmd, args }, expected);
  return underlying.command === "pi" ? underlying.args : underlying.args.slice(1);
}

function childPrompt(call: any[]): string {
  const args = logicalChildArgs(call);
  return args[args.length - 1];
}

function createMockPi(execReturn?: { code: number; stdout: string; stderr: string }) {
  const ret = execReturn ?? { code: 0, stdout: "Consolidated", stderr: "" };
  return {
    on: () => {},
    exec: async (...args: any[]) => {
      execCalls.push(captureExecArgs(args));
      return ret;
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as any;
}

const mockStore = {
  getMemoryEntries: () => ["old entry 1", "old entry 2"],
  getUserEntries: () => ["user fact 1"],
  getAllFailureEntries: () => ["failure lesson 1", "failure lesson 2"],
  getStorageIdentity: async (target: string) => path.join("mock-store", target),
  loadFromDisk: async () => {},
  // Mechanics tests exercise the subprocess handshake, so the fixture store
  // reports itself over its capacity goal — a healthy store would clean-no-op
  // before spawning a child.
  capacityGoal: () => 10,
  capacityUsage: () => 1000,
} as any;

async function settle(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Scope the contended-lock poll window so contention tests stay fast. */
async function withLockWait(waitMs: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PI_HERMES_CONSOLIDATION_LOCK_WAIT_MS;
  process.env.PI_HERMES_CONSOLIDATION_LOCK_WAIT_MS = waitMs;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.PI_HERMES_CONSOLIDATION_LOCK_WAIT_MS;
    } else {
      process.env.PI_HERMES_CONSOLIDATION_LOCK_WAIT_MS = previous;
    }
  }
}

type ManualCommandHandler = (args: unknown, ctx: unknown) => Promise<void>;

async function runManualConsolidate(timeoutMs?: number): Promise<void> {
  let handler: ManualCommandHandler | undefined;
  const pi = {
    on: () => {},
    exec: async (...args: unknown[]) => {
      execCalls.push(captureExecArgs(args as Parameters<typeof captureExecArgs>[0]));
      return { code: 0, stdout: "Done", stderr: "" };
    },
    registerTool: () => {},
    registerCommand: (_name: string, command: { handler: ManualCommandHandler }) => {
      handler = command.handler;
    },
  } as unknown as Parameters<typeof registerConsolidateCommand>[0];

  registerConsolidateCommand(pi, mockStore, timeoutMs);
  assert.ok(handler, "command handler should be registered");
  await handler({}, { signal: undefined, ui: { notify: () => {} } });
}

// ─── Tests ───

describe("triggerConsolidation", () => {
  beforeEach(async () => {
    execCalls = [];
    // Fresh lock dir per test: the shared lock file couples otherwise
    // independent tests through lease-release timing on Windows.
    process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-consolidation-locks-"),
    );
  });

  it("builds prompt with current entries and calls pi.exec", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(execCalls.length, 1, "should call pi.exec once");
    const args = logicalChildArgs(execCalls[0]);
    assert.ok(args[0] === "-p", "should use -p flag");
    assert.ok(args.includes("--no-session"), "should include --no-session");

    const prompt = args[args.length - 1];
    assert.ok(prompt.includes("old entry 1"), "prompt should include current memory entries");
    assert.ok(prompt.includes("memory"), "prompt should reference target");
  });

  it("reports an honest no-shrink result when the child exits 0 without shrinking", async () => {
    const pi = createMockPi({ code: 0, stdout: "Done", stderr: "" });
    const result = await triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(result.consolidated, false, "exit 0 without shrinking is not success");
    assert.ok(result.error?.includes("could not shrink the remaining"), result.error);
  });

  it("clears a failed release before the next consolidation", async () => {
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalDeleteOwnedLock = prototype.deleteOwnedLock;
    let deleteAttempts = 0;
    prototype.deleteOwnedLock = function (key: string, token: string): void {
      deleteAttempts++;
      if (deleteAttempts <= 3) throw new Error("injected consolidation release failure");
      return originalDeleteOwnedLock.call(this, key, token);
    };

    try {
      const pi = createMockPi();
      const first = await triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });
      const second = await triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

      assert.strictEqual(first.consolidated, false, "a no-shrink child is honestly reported");
      assert.strictEqual(second.consolidated, false);
      assert.strictEqual(execCalls.length, 2, "release clearing must not block the next consolidation");
      assert.ok(deleteAttempts >= 4);
    } finally {
      prototype.deleteOwnedLock = originalDeleteOwnedLock;
    }
  });

  it("defers a duplicate subprocess while the same target is consolidating", async () => {
    const releaseExecs: Array<() => void> = [];
    let markExecStarted!: () => void;
    const execStarted = new Promise<void>((resolve) => { markExecStarted = resolve; });
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        markExecStarted();
        await new Promise<void>((resolve) => { releaseExecs.push(resolve); });
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    await withLockWait("0", async () => {
      const first = triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });
      await execStarted;
      const second = triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });
      const raced = await Promise.race([
        second.then((result) => ({ result })),
        settle(100).then(() => ({ timeout: true as const })),
      ]);

      releaseExecs.forEach((release) => release());
      await Promise.allSettled([first, second]);

      assert.ok("result" in raced, "duplicate consolidation should return without spawning another child");
      assert.strictEqual(raced.result.consolidated, false);
      assert.strictEqual(raced.result.deferred, true, "contention is deferral, not failure");
      assert.match(raced.result.error!, /already in progress/i);
      assert.strictEqual(execCalls.length, 1, "only one child Pi process should be spawned");
    });
  });

  it("waits out transient contention instead of failing the caller", async () => {
    const releaseExecs: Array<() => void> = [];
    let markFirstExecStarted!: () => void;
    const firstExecStarted = new Promise<void>((resolve) => { markFirstExecStarted = resolve; });
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        if (execCalls.length === 1) {
          markFirstExecStarted();
          await new Promise<void>((resolve) => { releaseExecs.push(resolve); });
        }
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    await withLockWait("2000", async () => {
      const first = triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });
      await firstExecStarted;
      const second = triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });
      await settle(20);
      releaseExecs.forEach((release) => release());

      const [firstResult, secondResult] = await Promise.all([first, second]);
      // The mock children never shrink the store, so both runs honestly
      // report a no-shrink partial — the mechanic under test is that the
      // queued caller WAITS and runs its own child instead of hard-failing.
      assert.strictEqual(firstResult.consolidated, false);
      assert.strictEqual(secondResult.consolidated, false, "the queued caller should run its own round, not hard-fail");
      assert.strictEqual(secondResult.deferred, undefined);
      assert.ok(secondResult.error?.includes("could not shrink the remaining"), secondResult.error);
      assert.strictEqual(execCalls.length, 2);
    });
  });

  it("skips its own child when the session it queued behind already freed space", async () => {
    let entries = ["old entry 1", "old entry 2"];
    const shrinkingStore = {
      getMemoryEntries: () => entries,
      getUserEntries: () => [],
      getAllFailureEntries: () => [],
      getStorageIdentity: async (target: string) => path.join("shrinking-store", target),
      loadFromDisk: async () => { entries = ["merged"]; },
      capacityGoal: () => 10,
      capacityUsage: () => entries.join(ENTRY_DELIMITER).length,
    } as any;

    const releaseExecs: Array<() => void> = [];
    let markFirstExecStarted!: () => void;
    const firstExecStarted = new Promise<void>((resolve) => { markFirstExecStarted = resolve; });
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        markFirstExecStarted();
        await new Promise<void>((resolve) => { releaseExecs.push(resolve); });
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    await withLockWait("2000", async () => {
      const first = triggerConsolidation(pi, shrinkingStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });
      await firstExecStarted;
      const second = triggerConsolidation(pi, shrinkingStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });
      await settle(20);
      releaseExecs.forEach((release) => release());

      const [, secondResult] = await Promise.all([first, second]);
      assert.strictEqual(secondResult.consolidated, true);
      assert.strictEqual(execCalls.length, 1, "a second LLM pass is pure cost once space is already free");
    });
  });

  it("allows the same project target to consolidate concurrently in distinct stores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-stores-"));
    const stores = ["project-a", "project-b"].map((name) => new MemoryStore({
      memoryDir: path.join(root, name),
      memoryCharLimit: 5_000,
      userCharLimit: 5_000,
      memoryMode: "policy-only",
    } as any));
    await Promise.all(stores.map((store) => store.loadFromDisk()));
    // Seed both stores over their capacity goal — a healthy store is a clean
    // no-op and would never reach the concurrent-children mechanic under test.
    for (const store of stores) {
      for (let i = 0; i < 10; i++) {
        const r = await store.add("memory", `concurrent-store-entry-${i}-${"x".repeat(580)}`);
        assert.ok(r.success, `seed ${i} should succeed`);
      }
    }

    let started = 0;
    let markFirstStarted!: () => void;
    let markBothStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
    const releases: Array<() => void> = [];
    const pi = {
      exec: async () => {
        started++;
        if (started === 1) markFirstStarted();
        if (started === 2) markBothStarted();
        if (started <= 2) {
          // Round 1 of each store hangs until both children have started.
          await new Promise<void>((resolve) => { releases.push(resolve); });
        }
        return { code: 0, stdout: "Done", stderr: "" };
      },
    } as any;

    try {
      const first = triggerConsolidation(pi, stores[0], "memory", undefined, 60_000, "project");
      await firstStarted;
      const second = triggerConsolidation(pi, stores[1], "memory", undefined, 60_000, "project");
      const raced = await Promise.race([
        bothStarted.then(() => "both-started" as const),
        settle(100).then(() => "timeout" as const),
      ]);

      releases.forEach((release) => release());
      await Promise.allSettled([first, second]);

      assert.strictEqual(raced, "both-started");
      assert.ok(started >= 2, "both distinct stores must run their own child");
    } finally {
      releases.forEach((release) => release());
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns { consolidated: false } on failure (non-zero exit code)", async () => {
    const pi = createMockPi({ code: 1, stdout: "", stderr: "some error" });
    const result = await triggerConsolidation(pi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error, "should have error message");
    assert.ok(result.error!.includes("exit"), "error should mention exit code");
  });

  it("surfaces timeout-style child termination clearly", async () => {
    const pi = createMockPi({ code: 143, stdout: "", stderr: "", killed: true } as any);
    const result = await triggerConsolidation(pi, mockStore, "memory", undefined, 60000);

    assert.strictEqual(result.consolidated, false);
    assert.match(result.error!, /terminated/i);
    assert.match(result.error!, /60000ms/);
  });

it("returns { consolidated: false } when pi.exec throws", async () => {
    const crashPi = {
      on: () => {},
      exec: async () => { throw new Error("network failure"); },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(crashPi, mockStore, "memory");

    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error!.includes("Consolidation failed"), "should mention failure");
    assert.ok(result.error!.includes("network failure"), "should include original error");
  });

  it("defers instead of failing when pi.exec throws a stale extension ctx error", async () => {
    const stalePi = {
      on: () => {},
      exec: async () => { throw new Error("This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession()"); },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(stalePi, mockStore, "memory");

    assert.strictEqual(result.consolidated, false);
    assert.strictEqual(result.deferred, true, "stale ctx should defer, not fail");
    assert.ok(!result.error!.includes("Consolidation failed"), "should not report a failure");
    assert.ok(result.error!.includes("session replaced or reloaded"), "should explain the skip");
  });

  it("includes user profile entries when target is 'user'", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "user");

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("user fact 1"), "prompt should include user entries");
    assert.ok(prompt.includes("User Profile"), "prompt should reference user profile");
  });

  it("includes failure entries when target is 'failure'", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "failure");

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("failure lesson 1"), "prompt should include failure entries");
    assert.ok(prompt.includes("Failure Memory"), "prompt should reference failure memory");
    assert.ok(prompt.includes("Target: 'failure'"), "prompt should tell the child agent to use target='failure'");
  });

  it("can consolidate project memory using the project tool target", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "memory", undefined, 60000, "project");

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("old entry 1"), "prompt should include project memory entries");
    assert.ok(prompt.includes("Project Memory"), "prompt should label project memory");
    assert.ok(prompt.includes("Target: 'project'"), "prompt should tell the child agent to use target='project'");
  });

  it("retries once without overrides when the override subprocess fails for model resolution reasons", async () => {
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        if (execCalls.length === 1) {
          return { code: 1, stdout: "", stderr: "model not found" };
        }
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(
      pi,
      mockStore,
      "memory",
      undefined,
      60000,
      "memory",
      { llmModelOverride: "openrouter/deepseek/deepseek-v4-flash", consolidationChunking: true },
    );

    assert.strictEqual(result.consolidated, false, "the mock child shrinks nothing — reported honestly");
    assert.strictEqual(execCalls.length, 2, "should retry once without overrides");
    assert.deepStrictEqual(logicalChildArgs(execCalls[0]).slice(0, 6), [
      "-p",
      "--no-session",
      "--model",
      "openrouter/deepseek/deepseek-v4-flash",
      "--thinking",
      "off",
    ]);
    const retryArgs = logicalChildArgs(execCalls[1]);
    assert.deepStrictEqual(retryArgs.slice(0, 2), ["-p", "--no-session"]);
    assert.ok(!retryArgs.includes("--model"), "fallback retry should drop model override");
    assert.ok(!retryArgs.includes("--thinking"), "fallback retry should drop thinking override");
    assert.strictEqual(typeof retryArgs[retryArgs.length - 1], "string", "fallback retry should keep prompt as final arg");
  });

  it("does not retry generic consolidation failures that are unrelated to override resolution", async () => {
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 1, stdout: "", stderr: "memory tool returned no changes" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(
      pi,
      mockStore,
      "memory",
      undefined,
      60000,
      "memory",
      { llmModelOverride: "openrouter/deepseek/deepseek-v4-flash", consolidationChunking: true },
    );

    assert.strictEqual(result.consolidated, false);
    assert.strictEqual(execCalls.length, 1, "should not retry generic consolidation failures");
  });

  it("handles empty entries as a clean no-op", async () => {
    const emptyStore = {
      getMemoryEntries: () => [],
      getUserEntries: () => [],
      getStorageIdentity: async (target: string) => path.join("empty-store", target),
      loadFromDisk: async () => {},
    } as any;

    const pi = createMockPi();
    const result = await triggerConsolidation(pi, emptyStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(execCalls.length, 0, "an empty store spawns no child");
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.rounds, 0);
  });

  describe("direct transport", () => {
    beforeEach(() => {
      directCalls = [];
    });

    it("returns consolidated true via direct transport without calling subprocess when appliedCount is positive", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 3 }),
      );

      assert.strictEqual(result.consolidated, true);
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 0, "subprocess must not run on successful direct consolidation");
      const directOptions = directCalls[0]?.[3] as {
        requireAtomicShrink?: boolean;
        expectedTarget?: string;
      };
      assert.strictEqual(directOptions.requireAtomicShrink, true);
      assert.strictEqual(directOptions.expectedTarget, "memory");
    });

    it("falls back to subprocess when direct transport succeeds with appliedCount 0", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 0 }),
      );

      assert.strictEqual(result.consolidated, false, "the fallback child shrank nothing — reported honestly");
      assert.ok(result.error?.includes("could not shrink the remaining"), result.error);
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 1, "empty direct result must fall back to subprocess");
    });

    it("returns terminal on empty_response without acquiring the lock or spawning a child (#235)", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 0, fallbackReason: "empty_response" }),
      );

      // An empty completion is terminal: the subprocess child would run the
      // same model against the same server-side thinking default and fail
      // the same way (#197), so it must not even be attempted.
      assert.strictEqual(result.consolidated, false);
      assert.match(result.error ?? "", /returned an empty completion; no consolidation attempted/);
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 0, "empty completion is terminal — no subprocess");
    });

    it("falls back to subprocess when direct transport returns ok false", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps({ ok: false, appliedCount: 0 }),
      );

      assert.strictEqual(result.consolidated, false, "the fallback child shrank nothing — reported honestly");
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 1, "failed direct result must fall back to subprocess");
    });

    it("falls back to subprocess when direct transport throws without propagating", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps("throw"),
      );

      assert.strictEqual(result.consolidated, false, "the fallback child shrank nothing — reported honestly");
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 1, "thrown direct error must fall back to subprocess");
    });

    it("does not attempt direct transport when directCtx is null", async () => {
      const pi = createMockPi();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        null,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 3 }),
      );

      assert.strictEqual(result.consolidated, false, "the fallback child shrank nothing — reported honestly");
      assert.strictEqual(directCalls.length, 0, "direct path must be skipped without directCtx");
      assert.strictEqual(execCalls.length, 1, "subprocess-only path must still consolidate");
    });
  });
});

describe("registerConsolidateCommand", () => {
  beforeEach(() => {
    execCalls = [];
  });

  it("includes project memory when a project store is available", async () => {
    let handler: any;
    const notifications: string[] = [];
    let projectReloaded = false;

    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: (_name: string, command: any) => {
        handler = command.handler;
      },
    } as any;

    const projectStore = {
      getMemoryEntries: () => ["project fact"],
      getUserEntries: () => [],
      getStorageIdentity: async (target: string) => path.join("project-store", target),
      loadFromDisk: async () => { projectReloaded = true; },
      capacityGoal: () => 10,
      capacityUsage: () => 100,
    } as any;

    registerConsolidateCommand(pi, mockStore, 60000, projectStore, "demo-project", { consolidationChunking: true });
    await handler({}, {
      signal: undefined,
      ui: { notify: (message: string) => { notifications.push(message); } },
    });

    assert.strictEqual(execCalls.length, 4, "should consolidate memory, user, failure, and project stores");
    const failurePrompt = childPrompt(execCalls[2]);
    assert.ok(failurePrompt.includes("Failure Memory"), "failure prompt should be labeled");
    assert.ok(failurePrompt.includes("failure lesson 1"), "failure prompt should include failure entries");
    assert.ok(failurePrompt.includes("Target: 'failure'"), "failure prompt should use target='failure'");
    const projectPrompt = childPrompt(execCalls[3]);
    assert.ok(projectPrompt.includes("Project Memory"), "project prompt should be labeled");
    assert.ok(projectPrompt.includes("project fact"), "project prompt should include project entries");
    assert.ok(projectPrompt.includes("Target: 'project'"), "project prompt should use target='project'");
    assert.ok(projectReloaded, "project store should reload after consolidation");
    assert.ok(notifications.some((message) => message.includes("Starting memory consolidation")), "should show an initial progress notification");
    assert.ok(notifications.some((message) => message.includes("⏳ Consolidating memory")), "should show per-target progress");
    const finalNotification = notifications[notifications.length - 1] ?? "";
    assert.ok(finalNotification.includes("failure: ❌"), "final notification should include the failure result");
    assert.ok(finalNotification.includes("project:demo-project: ❌"), "final notification should include the project result");
  });

  it("passes the configured timeout through to the manual consolidate child", async () => {
    await runManualConsolidate(240000);

    assert.ok(execCalls.length > 0, "manual consolidation should spawn children");
    for (const call of execCalls) {
      assert.strictEqual(call[1][1], "240000");
      assert.strictEqual(call[2]?.timeout, 245000);
    }
  });

  it("defaults the manual consolidate command to the shared consolidation timeout", async () => {
    await runManualConsolidate();

    assert.ok(execCalls.length > 0, "manual consolidation should spawn children");
    for (const call of execCalls) {
      assert.strictEqual(call[1][1], String(DEFAULT_CONSOLIDATION_TIMEOUT_MS));
    }
  });

  it("does not throw if the command ctx becomes stale before the final summary notify", async () => {
    let handler: any;

    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: (_name: string, command: any) => {
        handler = command.handler;
      },
    } as any;

    registerConsolidateCommand(pi, mockStore, 60000);

    await assert.doesNotReject(async () => {
      await handler({}, {
        signal: undefined,
        ui: {
          notify: () => {
            throw new Error("This extension ctx is stale after session replacement or reload.");
          },
        },
      });
    });
  });

  it("passes command ctx to direct consolidation and reflects success in the summary", async () => {
    directCalls = [];
    let handler: ((_args: unknown, ctx: unknown) => Promise<void>) | undefined;
    const notifications: string[] = [];
    const commandCtx = {
      model: {},
      modelRegistry: {},
      signal: undefined,
      ui: { notify: (message: string) => { notifications.push(message); } },
      _tag: "manual-consolidate-ctx",
    };

    const pi = {
      on: () => {},
      exec: async (...args: unknown[]) => {
        execCalls.push(captureExecArgs(args as Parameters<typeof captureExecArgs>[0]));
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
    } as unknown as Parameters<typeof registerConsolidateCommand>[0];

    registerConsolidateCommand(
      pi,
      mockStore,
      60000,
      null,
      null,
      directTransportLlmConfig,
      null,
      makeDirectDeps({ ok: true, appliedCount: 2 }),
    );

    assert.ok(handler, "command handler should be registered");
    await handler!({}, commandCtx);

    assert.strictEqual(directCalls.length, 3, "memory, user, and failure targets should use direct transport");
    assert.strictEqual(execCalls.length, 0, "successful direct consolidation should not spawn subprocess");
    for (const call of directCalls) {
      assert.strictEqual(call[0], commandCtx, "runDirectMemoryCompletion must receive the command ctx");
    }

    const finalNotification = notifications[notifications.length - 1] ?? "";
    assert.ok(finalNotification.includes("memory: ✅ consolidated"), "summary should show memory consolidated");
    assert.ok(finalNotification.includes("user: ✅ consolidated"), "summary should show user consolidated");
    assert.ok(finalNotification.includes("failure: ✅ consolidated"), "summary should show failure consolidated");
  });
});

describe("MemoryStore auto-consolidation integration", () => {
  let MEMORY_DIR = "";

  before(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-test-"));
  });

  after(async () => {
    try { await fs.rm(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("add() triggers consolidation when over limit with consolidator", async () => {
    let consolidatorCalled = false;
    let consolidatorTarget: string | undefined;

    const { MemoryStore } = await import("../../src/store/memory-store.js");
    const store = new MemoryStore({
      memoryCharLimit: 120,
      userCharLimit: 120,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      overflowGraceMs: 0,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    // Mock consolidator that actually frees space by removing all entries
    store.setConsolidator(async (target, signal) => {
      consolidatorCalled = true;
      consolidatorTarget = target;
      // Remove all entries to simulate consolidation freeing space
      const entries = target === "memory" ? store.getMemoryEntries() : store.getUserEntries();
      for (const entry of [...entries]) {
        await store.remove(target, entry);
      }
      return { consolidated: true };
    });

    await store.loadFromDisk();

    // Fill up memory to near limit (each entry gets ~44 chars of metadata)
    const smallEntry = "a".repeat(60);
    await store.add("memory", smallEntry);

    // This add should exceed limit and trigger consolidation
    const result = await store.add("memory", "b".repeat(20));

    assert.ok(consolidatorCalled, "consolidator should have been called");
    assert.strictEqual(consolidatorTarget, "memory");
    // After consolidation removes entries, the new entry should fit
    assert.ok(result.success, "add should succeed after consolidation");
  });

  it("add() skips consolidation when autoConsolidate is false", async () => {
    let consolidatorCalled = false;
    const { MemoryStore } = await import("../../src/store/memory-store.js");

    const store = new MemoryStore({
      memoryCharLimit: 50,
      userCharLimit: 50,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    store.setConsolidator(async () => {
      consolidatorCalled = true;
      return { consolidated: true };
    });

    await store.loadFromDisk();

    const result = await store.add("memory", "x".repeat(60));
    assert.ok(!consolidatorCalled, "consolidator should NOT be called when autoConsolidate is false");
    assert.ok(!result.success, "should return error");
    assert.ok(result.error!.includes("exceed"), "should mention exceeding limit");
  });

  it("add() skips consolidation when no consolidator set", async () => {
    const { MemoryStore } = await import("../../src/store/memory-store.js");

    const store = new MemoryStore({
      memoryCharLimit: 50,
      userCharLimit: 50,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    // Intentionally NOT calling setConsolidator
    await store.loadFromDisk();

    const result = await store.add("memory", "x".repeat(60));
    assert.ok(!result.success, "should return error");
    assert.ok(result.error!.includes("exceed"), "should mention exceeding limit");
  });

  async function storeWithConsolidator(
    dirName: string,
    consolidator: () => Promise<{ consolidated: boolean; error?: string }>,
  ): Promise<MemoryStore> {
    const store = new MemoryStore({
      memoryCharLimit: 120,
      userCharLimit: 120,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      overflowGraceMs: 0,
      autoConsolidate: true,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: path.join(MEMORY_DIR, dirName),
    });
    store.setConsolidator(consolidator);
    await store.loadFromDisk();
    await store.add("memory", "a".repeat(60));
    return store;
  }

  it("add() surfaces the reason a failed auto-consolidation reported", async () => {
    const store = await storeWithConsolidator("reason", async () => ({
      consolidated: false,
      error: "Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: 180000ms.",
    }));

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(!result.success, "over-capacity add should still fail");
    assert.ok(result.error!.startsWith("Memory at "), "original capacity error must be preserved");
    assert.ok(
      result.error!.includes("Auto-consolidation attempted but failed: Consolidation subprocess was terminated"),
      `expected the consolidation reason to be appended, got: ${result.error}`,
    );
  });

  it("add() reports a reasonless consolidation failure instead of staying silent", async () => {
    const store = await storeWithConsolidator("reasonless", async () => ({ consolidated: false }));

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(result.error!.includes("Auto-consolidation attempted but failed: no reason reported"), result.error);
  });

  it("add() asks for a retry instead of reporting failure when consolidation is deferred", async () => {
    const store = await storeWithConsolidator("deferred", async () => ({
      consolidated: false,
      deferred: true,
      error: "Consolidation already in progress for target 'memory' in another session (waited 5000ms).",
    }));

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(!result.success, "the entry genuinely was not saved");
    assert.ok(result.error!.startsWith("Memory at "), "original capacity error must be preserved");
    assert.ok(result.error!.includes("retry in a moment"), result.error);
    assert.ok(
      !result.error!.includes("Auto-consolidation attempted but failed"),
      `lock contention must not read as a broken consolidation, got: ${result.error}`,
    );
  });

  it("add() surfaces a consolidator that throws", async () => {
    const store = await storeWithConsolidator("throws", async () => {
      throw new Error("spawn ENOENT");
    });

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(!result.success, "a thrown consolidator must not surface as success");
    assert.ok(result.error!.includes("consolidator threw"), result.error);
    assert.ok(result.error!.includes("spawn ENOENT"), result.error);
  });

  it("add() distinguishes a consolidation that ran but freed nothing", async () => {
    const store = await storeWithConsolidator("no-space", async () => ({ consolidated: true }));

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(!result.success, "add should still fail when nothing was freed");
    assert.ok(
      result.error!.includes("Auto-consolidation ran but did not free enough space."),
      result.error,
    );
    assert.ok(
      !result.error!.includes("attempted but failed"),
      "a successful-but-ineffective consolidation is not a consolidation failure",
    );
  });

  it("add() surfaces a partial consolidation note when the retry still fails", async () => {
    const store = await storeWithConsolidator("partial", async () => (
      { consolidated: true, partial: true, rounds: 1, error: "time budget exhausted" } as any
    ));

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(!result.success, "add should still fail when nothing was freed");
    assert.ok(
      result.error!.includes("Consolidation is incomplete: time budget exhausted"),
      result.error,
    );
    assert.ok(
      !result.error!.includes("attempted but failed"),
      "partial progress is not a consolidation failure",
    );
  });
});


/** Simulate the child by rewriting the store markdown file directly. */
async function removeEntryFromDisk(store: MemoryStore, strippedText: string): Promise<void> {
  const filePath = path.join((store as any).memoryDir, "MEMORY.md");
  const raw = await fs.readFile(filePath, "utf-8");
  const blocks = raw.split(ENTRY_DELIMITER);
  const marker = strippedText.slice(0, 40);
  const kept = blocks.filter((block) => !block.includes(marker));
  assert.ok(kept.length < blocks.length, `child should find entry '${marker}' in the store file`);
  await fs.writeFile(filePath, kept.join(ENTRY_DELIMITER), "utf-8");
}

function parsePromptBatch(prompt: string): string[] {
  const marker = "--- Current Memory Entries ---";
  const start = prompt.indexOf(marker);
  assert.ok(start >= 0, "prompt should contain the entries section");
  const end = prompt.indexOf("Use memory_add", start);
  const body = prompt.slice(start + marker.length, end);
  return body
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "(empty)");
}


// ─── Chunked subprocess consolidation ───

describe("chunked subprocess consolidation", () => {
  let MEMORY_ROOT = "";
  let storeSeq = 0;

  before(async () => {
    MEMORY_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-chunk-"));
  });

  after(async () => {
    try { await fs.rm(MEMORY_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    execCalls = [];
  });

  /**
   * A real on-disk store in its OWN fresh directory (shared dirs leak entries
   * between tests and change the batch math), with a realistic 5000-char
   * capacity goal. policy-only lets seeds exceed the cap so the chunked path
   * has work to do. Entries are uniquely marked because memory-tool removal
   * matches by normalized substring — look-alike filler would cross-match.
   */
  async function makeOverChunkStore(entryCount: number, entryChars = 600, memoryCharLimit = 5000): Promise<MemoryStore> {
    const memoryDir = path.join(MEMORY_ROOT, `store-${++storeSeq}`);
    const store = new MemoryStore({
      memoryCharLimit,
      userCharLimit: 100,
      memoryMode: "policy-only",
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir,
    });
    await store.loadFromDisk();
    for (let i = 0; i < entryCount; i++) {
      const filler = "y".repeat(Math.max(0, entryChars - `chunk-entry-${i}-`.length));
      const result = await store.add("memory", `chunk-entry-${i}-${filler}`);
      assert.ok(result.success, `seed add #${i} should succeed`);
    }
    return store;
  }

  /**
   * Mock child that behaves like a real `pi -p` consolidation subprocess: it
   * reads its prompt, edits the store FILE on disk (not the parent's memory —
   * the parent's reload must observe what a separate process wrote), and
   * exits. Scripted per round.
   */
  function createChunkedChildPi(
    store: MemoryStore,
    script: Array<"shrink" | "noop" | "fail">,
  ) {
    let round = 0;
    return {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const action = script[Math.min(round, script.length - 1)];
        round++;
        if (action === "fail") {
          return { code: 124, stdout: "", stderr: "", killed: true };
        }
        if (action === "shrink") {
          const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
          const batch = parsePromptBatch(prompt);
          assert.ok(batch.length > 0, "child prompt should contain at least one entry");
          await removeEntryFromDisk(store, batch[0]);
        }
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;
  }

  function batchFromExecCall(call: any[]): string[] {
    return parsePromptBatch(call[1].at(-1) as string);
  }

  it("treats a small healthy store as a clean no-op", async () => {
    // Tiny store, well under its capacity goal: nothing to shrink, no child
    // spawned, clean success (rounds: 0) — not a ❌ failure.
    const store = await makeOverChunkStore(2, 20);
    const pi = createMockPi();

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(execCalls.length, 0, "a healthy store spawns no child");
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.rounds, 0);
    assert.strictEqual(result.error, undefined);
  });

  it("runs small over-goal stores as one unscoped decisive round", async () => {
    // 6 entries ≈ 3879 encoded chars: under the 4000 chunk size (one prompt)
    // but over the 3000 capacity goal — the legacy single-shot call, unscoped.
    const store = await makeOverChunkStore(6, 600, 3000);
    const pi = createChunkedChildPi(store, ["shrink"]);

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(execCalls.length, 1, "a store that fits one prompt gets exactly one child");
    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("chunk-entry-0") && prompt.includes("chunk-entry-5"), "decisive prompt carries the whole store");
    assert.ok(!prompt.includes("covers ONLY the entries listed above"), "decisive round is unscoped");
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.rounds, 1);
    assert.strictEqual(result.partial, true, "still over the goal after one round — visible, not silent");
  });

  it("reports a clean single-round run when the decisive round reaches the goal", async () => {
    const store = await makeOverChunkStore(6, 600, 3000);
    // Decisive round merges two entries away → 4 entries ≈ 2585 chars ≤ goal.
    const pi: any = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        await removeEntryFromDisk(store, batch[0]);
        await removeEntryFromDisk(store, batch[1]);
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    };

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(execCalls.length, 1);
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.partial, false, "goal met, no failure — a clean run");
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(store.getMemoryEntries().length, 4);
  });

  it("treats an over-chunk but under-goal store as a clean no-op (cap units, not prompt units)", async () => {
    // 7 entries ≈ 4526 ENCODED chars: over the 4000-char prompt budget but
    // UNDER the 5000-char capacity goal measured in cap units (encoded
    // entries). 8 entries (≈ 5173) would cross the goal and run rounds.
    const store = await makeOverChunkStore(7);
    const pi = createChunkedChildPi(store, ["shrink"]);

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(execCalls.length, 0, "nothing needs to shrink toward the capacity goal");
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.rounds, 0);
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(store.getMemoryEntries().length, 7);
  });

  it("completes an over-goal store in bounded rounds with the default per-round timeout", async () => {
    const store = await makeOverChunkStore(10); // ≈ 6367 encoded chars > 5000 goal
    const pi = createChunkedChildPi(store, ["shrink", "shrink", "shrink"]);

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    // Each round removes one entry (−647 encoded chars): 6367 → 5730 → 5093 →
    // 4456 ≤ goal. The walk advances past each consumed slice.
    assert.strictEqual(execCalls.length, 3);
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.rounds, 3);
    assert.ok(!result.partial, "goal met with no failure is a clean run");
    assert.strictEqual(result.error, undefined, "goal met with no failure carries no error");
    assert.strictEqual(store.getMemoryEntries().length, 7);
    for (const call of execCalls) {
      const batch = batchFromExecCall(call);
      const batchChars = batch.join(ENTRY_DELIMITER).length;
      assert.ok(batchChars <= DEFAULT_CONSOLIDATION_CHUNK_CHARS, `round prompt ${batchChars} must fit one chunk`);
      // Rounds share the trigger budget: round 1 gets the full per-round
      // timeout, later rounds get what remains (still ≥ the round floor).
      const roundTimeout = Number(call[1][1]);
      assert.ok(roundTimeout > 0 && roundTimeout <= DEFAULT_CONSOLIDATION_TIMEOUT_MS, `round timeout ${roundTimeout}`);
      assert.strictEqual(call[2].timeout, roundTimeout + 5000);
    }
  });

  it("keeps walking forward: round 2 slices after round 1's slice, not from the top", async () => {
    const store = await makeOverChunkStore(10);
    const batches: string[][] = [];
    const pi: any = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        batches.push(batch);
        await removeEntryFromDisk(store, batch[0]);
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    };

    await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.ok(batches.length >= 2, "expected multiple rounds");
    // The discriminating check vs an offset-reset mutant: the walk must move
    // FORWARD — round 2 starts after round 1's slice. Later rounds may revisit
    // entries after index shifts (documented approximation).
    const overlap = batches[1].filter((entry) => batches[0].includes(entry));
    assert.strictEqual(overlap.length, 0, `round 2 re-processed ${overlap.length} entries from round 1 — the walk must advance`);
  });

  it("resumes after a killed round: partial progress persists and a second trigger finishes", async () => {
    const store = await makeOverChunkStore(11); // ≈ 6663 chars > 5000 goal
    const originalEntries = [...store.getMemoryEntries()];
    const pi = createChunkedChildPi(store, ["shrink", "fail"]);

    const first = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(execCalls.length, 2, "round 1 succeeds, round 2 is killed");
    assert.strictEqual(first.consolidated, true, "one completed round is real progress on disk");
    assert.strictEqual(first.partial, true, "a killed run must not read as a clean success");
    assert.strictEqual(first.rounds, 1);
    assert.ok(first.error?.includes("terminated"), first.error);
    assert.ok(first.error?.includes("1 earlier round shrank the store"), first.error);
    assert.ok(first.error?.includes("chars over its 5000-char capacity goal"), first.error);
    assert.strictEqual(store.getMemoryEntries().length, 10);

    // The retried add / next trigger resumes from current disk state and
    // finishes the job.
    execCalls = [];
    const second = await triggerConsolidation(
      createChunkedChildPi(store, ["shrink", "shrink"]),
      store,
      "memory",
      undefined,
      DEFAULT_CONSOLIDATION_TIMEOUT_MS,
      "memory",
      { consolidationChunkChars: 2500, consolidationChunking: true },
    );

    assert.strictEqual(second.consolidated, true);
    assert.strictEqual(second.error, undefined);
    assert.ok(!second.partial);
    assert.strictEqual(second.rounds, 3);
    const survivors = store.getMemoryEntries();
    assert.strictEqual(survivors.length, 7, "resume finishes the shrink below the capacity goal");
    const removed = originalEntries.filter((entry) => !survivors.includes(entry));
    assert.ok(
      originalEntries.every((entry) => survivors.includes(entry) || removed.includes(entry)),
      "no entry may vanish or be invented by chunking",
    );
  });

  it("walks unshrinkable slices and reports the store still over its goal", async () => {
    const store = await makeOverChunkStore(9); // ≈ 5733 encoded chars > 5000 goal
    const pi = createChunkedChildPi(store, ["noop"]);

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(execCalls.length, MAX_CONSOLIDATION_ROUNDS, "the round cap fires on a store that never shrinks");
    assert.strictEqual(result.consolidated, false, "nothing shrank — success must not be claimed");
    assert.ok(result.error?.includes("could not shrink the store toward its 5000-char capacity goal"), result.error);
    assert.ok(result.error?.includes("distinct facts"), result.error);
    assert.strictEqual(store.getMemoryEntries().length, 9, "a noop child must not lose entries");
  });

  it("reports a first-round kill exactly like the single-shot path", async () => {
    const store = await makeOverChunkStore(9);
    const pi = createChunkedChildPi(store, ["fail"]);

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(execCalls.length, 1);
    assert.strictEqual(result.consolidated, false);
    assert.strictEqual(result.partial, undefined);
    assert.ok(result.error?.includes("terminated"), result.error);
  });

  it("reports out-of-scope deletions without resurrecting them", async () => {
    // The parent cannot tell a rogue child deletion from a legitimate
    // cross-slice dedup or a concurrent writer — so deletions outside the
    // slice are reported, never re-added (resurrection would ping-pong across
    // triggers and fights legitimate dedup, the #226 class).
    const store = await makeOverChunkStore(9); // ≈ 5451 chars
    const seeds = store.getMemoryEntries();
    const outOfScopeEntry = seeds[6];
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        // The rogue child removes its own head AND an entry it was never shown.
        await removeEntryFromDisk(store, batch[0]);
        await removeEntryFromDisk(store, outOfScopeEntry);
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(execCalls.length, 1);
    const survivors = store.getMemoryEntries();
    assert.ok(!survivors.includes(outOfScopeEntry), "out-of-scope deletions are reported, never resurrected");
    assert.ok(result.error?.includes("out-of-scope entr"), result.error);
    assert.ok(result.error?.includes("concurrent writer"), result.error);
    assert.strictEqual(result.partial, true, "a scope deviation keeps the run partial");
  });

  it("stops before the first round when the time budget cannot fit a round", async () => {
    const store = await makeOverChunkStore(9);
    const pi = createChunkedChildPi(store, ["shrink"]);

    const result = await triggerConsolidation(pi, store, "memory", undefined, 5, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(execCalls.length, 0, "a budget that cannot fit a round spawns no child");
    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error?.includes("time budget (5ms) exhausted"), result.error);
  });

  describe("takeChunk", () => {
    it("packs whole entries up to the char budget", () => {
      const entries = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
      const batch = takeChunk(entries, 70); // each entry costs 30 + delimiter
      assert.strictEqual(batch.length, 2);
      assert.strictEqual(batch.join(ENTRY_DELIMITER).length <= 70, true);
    });

    it("lets an oversized entry travel alone", () => {
      const oversized = "x".repeat(3000);
      assert.deepStrictEqual(takeChunk([oversized, "small"], 2500), [oversized]);
    });

    it("keeps an exactly-fitting entry", () => {
      const exact = "y".repeat(2497); // 2497 + 3 delimiter chars = 2500
      assert.deepStrictEqual(takeChunk([exact], 2500), [exact]);
    });
  });

  it("gives the decisive final round the whole remaining store, unscoped", async () => {
    // Small cap: goal (3000) < chunk (4000), so the loop reaches a state where
    // the remaining store fits one prompt while still over the goal — that
    // decisive round must run unscoped, with full context.
    const store = await makeOverChunkStore(8, 600, 3000); // ≈ 4845 chars > 3000 goal
    let sawUnscopedFullPrompt = false;
    const pi: any = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        const scoped = prompt.includes("covers ONLY the entries listed above");
        if (batch.length === store.getMemoryEntries().length && !scoped) {
          sawUnscopedFullPrompt = true;
          return { code: 0, stdout: "Consolidated", stderr: "" }; // decisive round may decline
        }
        await removeEntryFromDisk(store, batch[0]);
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    };

    await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.ok(sawUnscopedFullPrompt, "once the remaining store fits one prompt, the round must be unscoped and whole");
  });
});

// ─── Chunked prompt scoping ───

describe("chunked prompt scoping", () => {
  let MEMORY_DIR = "";

  before(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-scope-"));
  });

  after(async () => {
    try { await fs.rm(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    execCalls = [];
  });

  it("adds the scope guard only to chunked-round prompts", async () => {
    const store = new MemoryStore({
      memoryCharLimit: 5000,
      userCharLimit: 100,
      memoryMode: "policy-only",
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });
    await store.loadFromDisk();
    for (let i = 0; i < 9; i++) {
      await store.add("memory", `scope-entry-${i}-${"z".repeat(580)}`); // ≈ 5382 chars > 5000 goal
    }

    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 0, stdout: "done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    const prompts = execCalls.map((call) => call[1].at(-1) as string);
    assert.ok(prompts.length >= 1, "over-chunk store should run at least one chunked round");
    for (const prompt of prompts) {
      assert.ok(
        prompt.includes("covers ONLY the entries listed above"),
        "every chunked-round prompt must carry the scope guard",
      );
      assert.ok(
        prompt.includes("Do NOT add, modify, or remove any entry that is not listed above"),
        "chunked-round prompt must forbid out-of-scope mutations",
      );
    }

    execCalls = [];
    // Same store, now under one chunk (chunkChars raised): single-shot keeps
    // the unscoped wording.
    await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 100_000,
    });
    assert.strictEqual(execCalls.length, 1);
    const singleShotPrompt = execCalls[0][1].at(-1) as string;
    assert.ok(
      !singleShotPrompt.includes("covers ONLY the entries listed above"),
      "single-shot prompt must stay unchanged",
    );
  });
});

// ─── Legacy-inject (cap-enforced) chunked path ───

describe("chunked consolidation in legacy-inject mode", () => {
  let MEMORY_ROOT = "";
  let seq = 0;

  before(async () => {
    MEMORY_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-legacy-"));
  });

  after(async () => {
    try { await fs.rm(MEMORY_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    execCalls = [];
  });

  it("runs the chunked loop against a cap-enforced over-limit store without re-entering caps", async () => {
    // Auto-consolidation only auto-runs in legacy-inject mode, and only when
    // the store is over its limit — so this is the mode the loop must be
    // proven in. A policy-only seed store fills the directory past the
    // smaller legacy cap; a second legacy-mode instance over the same
    // directory then consolidates an over-limit store. The loop mutates
    // nothing through store.add(), so no cap rejection and no nested
    // consolidation trigger can occur (previously the out-of-scope restore
    // re-entered exactly that path from inside the held lease).
    const memoryDir = path.join(MEMORY_ROOT, `legacy-${++seq}`);
    const seeder = new MemoryStore({
      memoryCharLimit: 5000,
      userCharLimit: 100,
      memoryMode: "policy-only",
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir,
    });
    await seeder.loadFromDisk();
    for (let i = 0; i < 8; i++) {
      const r = await seeder.add("memory", `seed-${i}-${"x".repeat(72)}`);
      assert.ok(r.success, `seed ${i} should succeed`);
    }

    // Legacy-inject view of the same directory: cap 300, store now over it.
    const store = new MemoryStore({
      memoryCharLimit: 300,
      userCharLimit: 100,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir,
    });
    await store.loadFromDisk();
    const before = store.getMemoryEntries();
    assert.strictEqual(before.length, 8);
    assert.ok(before.join(ENTRY_DELIMITER).length > 300, "store must be over the legacy cap");

    const pi = (() => {
      let round = 0;
      const script = ["shrink", "shrink", "noop"];
      return {
        on: () => {},
        exec: async (...args: any[]) => {
          execCalls.push(captureExecArgs(args));
          const action = script[Math.min(round, script.length - 1)];
          round++;
          if (action === "shrink") {
            const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
            const marker = "--- Current Memory Entries ---";
            const start = prompt.indexOf(marker);
            const body = prompt.slice(start + marker.length, prompt.indexOf("Use memory_add", start));
            const batch = body.split(ENTRY_DELIMITER).map((e) => e.trim()).filter((e) => e && e !== "(empty)");
            await removeEntryFromDisk(store, batch[0]);
          }
          return { code: 0, stdout: "Consolidated", stderr: "" };
        },
        registerTool: () => {},
        registerCommand: () => {},
      } as any;
    })();
    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 500,
      consolidationChunking: true,
    });

    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.partial, true, "still over the 300-char goal after the walk");
    assert.ok(result.error?.includes("could not shrink the remaining"), result.error);
    assert.ok(!result.error?.includes("another session is consolidating"), "no nested-consolidation stall may surface");
    const survivors = store.getMemoryEntries();
    assert.strictEqual(survivors.length, 6, "rounds shrank the store through the child's file edits");
    const removed = before.filter((entry) => !survivors.includes(entry));
    assert.strictEqual(removed.length, 2);
  });
});

describe("/memory-consolidate partial display", () => {
  it("shows ⚠️ partial with the reason when a round fails after earlier progress", async () => {
    const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-partial-ui-"));
    try {
      const store = new MemoryStore({
        memoryCharLimit: 5000,
        userCharLimit: 100,
        memoryMode: "policy-only",
        nudgeInterval: 10,
        reviewEnabled: false,
        flushOnCompact: false,
        flushOnShutdown: false,
        flushMinTurns: 6,
        autoConsolidate: false,
        correctionDetection: false,
        nudgeToolCalls: 15,
        memoryDir,
      });
      await store.loadFromDisk();
      for (let i = 0; i < 11; i++) {
        await store.add("memory", `partial-ui-${i}-${"x".repeat(580)}`); // ≈ 6663 chars > 5000 goal
      }

      execCalls = [];
      let handler: ManualCommandHandler | undefined;
      const pi = {
        on: () => {},
        exec: async (...args: any[]) => {
          execCalls.push(captureExecArgs(args));
          const round = execCalls.length;
          if (round === 1) {
            const prompt = execCalls[0][1].at(-1) as string;
            const batch = parsePromptBatch(prompt);
            await removeEntryFromDisk(store, batch[0]);
            return { code: 0, stdout: "ok", stderr: "" };
          }
          return { code: 124, stdout: "", stderr: "", killed: true };
        },
        registerTool: () => {},
        registerCommand: (_name: string, command: { handler: ManualCommandHandler }) => {
          handler = command.handler;
        },
      } as unknown as Parameters<typeof registerConsolidateCommand>[0];

      registerConsolidateCommand(pi, store, DEFAULT_CONSOLIDATION_TIMEOUT_MS, null, null, {
        consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
      });
      assert.ok(handler, "command handler should be registered");

      const notifications: string[] = [];
      await handler!({}, { signal: undefined, ui: { notify: (msg: string) => notifications.push(msg) } });

      const summary = notifications[notifications.length - 1] ?? "";
      assert.ok(summary.includes("memory: ✅ consolidated (1 round) ⚠️ partial:"), summary);
      assert.ok(summary.includes("terminated"), summary);
    } finally {
      await fs.rm(memoryDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ─── Third-review follow-ups: budget starvation, slice growth, reload throw, abort, shrink-then-fail ───

describe("chunked consolidation edge behavior", () => {
  let MEMORY_ROOT = "";
  let seq = 0;

  before(async () => {
    MEMORY_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-edge-"));
  });

  after(async () => {
    try { await fs.rm(MEMORY_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    execCalls = [];
  });

  function fileChild(store: MemoryStore, onRound: (batch: string[], round: number) => Promise<"shrink" | "grow" | "noop" | "fail">) {
    let round = 0;
    return {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        round++;
        const action = onRound(batch, round);
        return action.then((a: string) => (a === "fail" ? { code: 124, stdout: "", stderr: "", killed: true } : { code: 0, stdout: "ok", stderr: "" }));
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;
  }

  async function makeStore(entryCount: number, cap = 5000): Promise<MemoryStore> {
    const memoryDir = path.join(MEMORY_ROOT, `edge-${++seq}`);
    const store = new MemoryStore({
      memoryCharLimit: cap, userCharLimit: 100, memoryMode: "policy-only", nudgeInterval: 10,
      reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false, flushMinTurns: 6,
      autoConsolidate: false, correctionDetection: false, nudgeToolCalls: 15, memoryDir,
    } as any);
    await store.loadFromDisk();
    for (let i = 0; i < entryCount; i++) {
      const r = await store.add("memory", `edge-entry-${i}-` + "y".repeat(580));
      if (!r.success) throw new Error(`seed ${i}`);
    }
    return store;
  }

  it("a growing round is walked past, not rewarded", async () => {
    const store = await makeStore(9); // ≈ 5820 encoded chars > 5000 goal
    const pi: any = {
      on: () => {}, registerTool: () => {}, registerCommand: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        if (batch.length > 0) await store.remove("memory", batch[0]);
        // ...and the rogue/growing child also adds a fresh entry.
        await store.add("memory", `grown-entry-${roundCounter}-` + "z".repeat(580));
        return { code: 0, stdout: "ok", stderr: "" };
      },
      registerTool: () => {}, registerCommand: () => {},
    };
    let roundCounter = 0;
    // NOTE: roundCounter is captured by the closure above via hoisting of let.
    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(result.consolidated, true);
    assert.ok(store.getMemoryEntries().length <= 9, "a growing round must not grow the store: removal offsets its addition");
    assert.ok(result.rounds !== undefined && result.rounds <= MAX_CONSOLIDATION_ROUNDS, "bounded rounds");
  });

  it("loadFromDisk failure between rounds is reported and stops the walk", async () => {
    const store = await makeStore(9);
    const pi: any = {
      on: () => {}, registerTool: () => {}, registerCommand: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 0, stdout: "ok", stderr: "" };
      },
      registerTool: () => {}, registerCommand: () => {},
    };
    (store as any).loadFromDisk = async () => {
      throw new Error("injected reload failure");
    };

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error?.includes("could not reload memory after a consolidation round"), result.error);
    assert.strictEqual(execCalls.length, 1);
  });

  it("abort landing between rounds stops the walk with an honest note", async () => {
    const store = await makeStore(9);
    const controller = new AbortController();
    const pi: any = {
      on: () => {}, registerTool: () => {}, registerCommand: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        controller.abort(); // abort lands between rounds, not during a child
        return { code: 0, stdout: "ok", stderr: "" };
      },
      registerTool: () => {}, registerCommand: () => {},
    };

    const result = await triggerConsolidation(pi, store, "memory", controller.signal, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(execCalls.length, 1, "abort between rounds must stop the walk");
    assert.strictEqual(result.consolidated, false, "nothing completed before the abort");
    assert.ok(result.error?.includes("aborted between consolidation rounds"), result.error);
  });

  it("a round that shrinks on disk and then fails reports partial, not total failure", async () => {
    const store = await makeStore(9);
    const pi: any = {
      on: () => {}, registerTool: () => {}, registerCommand: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        // The child merges its slice, THEN dies — the shrink is real and on disk.
        await store.remove("memory", batch[0]);
        return { code: 124, stdout: "", stderr: "", killed: true };
      },
      registerTool: () => {}, registerCommand: () => {},
    };

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.strictEqual(result.consolidated, true, "the on-disk shrink is real progress");
    assert.strictEqual(result.partial, true, "…but the run ended in failure and must say so");
    assert.strictEqual(result.rounds, 0, "no round completed successfully");
    assert.ok(result.error?.includes("The failing round still shrank the store by"), result.error);
    assert.ok(store.getMemoryEntries().length < 9, "the shrink persisted");
  });

  it("starving rounds share the budget: per-round timeouts shrink until the gate trips", { timeout: 60000 }, async () => {
    const store = await makeStore(17); // ≈ 11K encoded chars, needs several rounds
    const watchdogTimeouts: number[] = [];
    const pi: any = {
      on: () => {}, registerTool: () => {}, registerCommand: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const call = execCalls[execCalls.length - 1];
        watchdogTimeouts.push(Number(call[1][1]));
        const prompt = call[1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        await new Promise((r) => setTimeout(r, 800)); // child works for 0.8s per round
        if (batch.length > 0) await store.remove("memory", batch[0]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
      registerTool: () => {}, registerCommand: () => {},
    };

    const result = await triggerConsolidation(pi, store, "memory", undefined, 11500, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
      consolidationChunking: true,
    });

    assert.ok(watchdogTimeouts.length >= 2, "multiple rounds before the budget gate");
    for (let i = 1; i < watchdogTimeouts.length; i++) {
      assert.ok(
        watchdogTimeouts[i] < watchdogTimeouts[i - 1],
        `round ${i + 1} must get a STRICTLY SMALLER share of the shared budget (got ${watchdogTimeouts[i - 1]} → ${watchdogTimeouts[i]}) — a mutant passing the full timeout every round fails here`,
      );
    }
    assert.ok(result.error?.includes("time budget (11500ms) exhausted"), result.error);
  });
});

// ─── Usage signals (PR-2 promotion gate) ───

const SIGNAL_ENTRY_RECALLED = "usage-signal entry alpha — recalled by search often";
const SIGNAL_ENTRY_NEVER = "usage-signal entry beta — never recalled by search";
const SIGNALS_HEADER = "--- Usage Signals (memory_search recall tracking) ---";
const SIGNALS_GUIDANCE = "Treat these as tie-breakers, not removal orders";

function makeUsageStore(entries: string[]) {
  return {
    getMemoryEntries: () => [...entries],
    getUserEntries: () => [],
    getAllFailureEntries: () => [],
    getStorageIdentity: async (target: string) => path.join("usage-store", target),
    loadFromDisk: async () => {},
    capacityGoal: () => 10,
    capacityUsage: () => 1000,
  } as any;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

describe("consolidation usage signals", () => {
  let usageDb: DatabaseManager;
  let usageDir = "";

  beforeEach(async () => {
    // This describe is top-level (appended after the others), so the
    // triggerConsolidation describe's beforeEach does not apply: reset the
    // shared exec capture and lock dir here too.
    execCalls = [];
    process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-consolidation-locks-"),
    );
    usageDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-usage-signal-consolidation-"));
    usageDb = new DatabaseManager(usageDir);
  });

  afterEach(() => {
    try { usageDb.close(); } catch { /* already closed by the test */ }
    try { fs.rmSync(usageDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("keeps the subprocess prompt byte-identical when the database has no tracking data", async () => {
    addMemory(usageDb, SIGNAL_ENTRY_NEVER, "memory"); // zero hits → no signals
    const store = makeUsageStore([SIGNAL_ENTRY_NEVER]);

    const piWithDb = createMockPi();
    await triggerConsolidation(piWithDb, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true }, null, usageDb);
    const withDbPrompt = childPrompt(execCalls[0]);

    execCalls = [];
    const piNoDb = createMockPi();
    await triggerConsolidation(piNoDb, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });
    const noDbPrompt = childPrompt(execCalls[0]);

    assert.strictEqual(withDbPrompt, noDbPrompt, "prompt must be identical with a dataless database attached");
    assert.ok(!withDbPrompt.includes(SIGNALS_HEADER));

  });

  it("annotates recalled and never-recalled entries once tracking data exists", async () => {
    const recalledRow = addMemory(usageDb, SIGNAL_ENTRY_RECALLED, "memory");
    addMemory(usageDb, SIGNAL_ENTRY_NEVER, "memory");
    recordSearchHits(usageDb, [recalledRow.id]);
    const store = makeUsageStore([SIGNAL_ENTRY_RECALLED, SIGNAL_ENTRY_NEVER]);

    const pi = createMockPi();
    await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true }, null, usageDb);

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes(SIGNALS_HEADER), "usage signals header present");
    assert.ok(prompt.includes(`recalled 1x, last ${todayStr()}: "${SIGNAL_ENTRY_RECALLED}"`), "recalled entry annotated with count + date");
    assert.ok(prompt.includes(`never recalled: "${SIGNAL_ENTRY_NEVER}"`), "never-recalled entry annotated");
    assert.ok(prompt.includes(SIGNALS_GUIDANCE), "tie-breaker guidance present");
    // The real entry list stays untouched (child copies entry text from there).
    assert.ok(prompt.includes(`--- Current Memory Entries ---\n${SIGNAL_ENTRY_RECALLED}\n§\n${SIGNAL_ENTRY_NEVER}\n\n${SIGNALS_HEADER}`));

  });

  it("omits the section when consolidationUsageSignals is off even with data", async () => {
    const recalledRow = addMemory(usageDb, SIGNAL_ENTRY_RECALLED, "memory");
    recordSearchHits(usageDb, [recalledRow.id]);
    const store = makeUsageStore([SIGNAL_ENTRY_RECALLED]);

    const pi = createMockPi();
    await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true, consolidationUsageSignals: false }, null, usageDb);

    const prompt = childPrompt(execCalls[0]);
    assert.ok(!prompt.includes(SIGNALS_HEADER), "kill-switch must suppress the section");

  });

  it("annotates only the presented batch in chunked rounds", async () => {
    const entries: string[] = [];
    for (let i = 0; i < 12; i++) {
      entries.push(`usage chunk entry ${String(i).padStart(2, "0")} — ${"filler prose for sizing ".repeat(3)}end-${i}`);
    }
    const store = makeUsageStore(entries);
    const rows = entries.map((entry) => addMemory(usageDb, entry, "memory"));
    recordSearchHits(usageDb, [rows[10].id]); // only a TAIL entry has usage data

    const pi = createMockPi();
    await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunking: true,
      consolidationChunkChars: 500,
    }, null, usageDb);

    assert.ok(execCalls.length >= 3, `expected multiple rounds, got ${execCalls.length}`);
    const firstPrompt = childPrompt(execCalls[0]);
    assert.ok(!firstPrompt.includes(SIGNALS_HEADER), "a batch with no tracked entries gets no section");
    const annotatedAt = execCalls.findIndex((_, i) => childPrompt(execCalls[i]).includes("recalled 1x"));
    assert.ok(annotatedAt > 0, "the round containing the tracked entry carries the section");
    const annotatedPrompt = childPrompt(execCalls[annotatedAt]);
    assert.ok(annotatedPrompt.includes(`recalled 1x, last ${todayStr()}: "${entries[10].slice(0, 77)}...`), "tail entry annotated when it reaches a batch");

  });

  it("embeds the same section in the direct-transport userPrompt", async () => {
    const recalledRow = addMemory(usageDb, SIGNAL_ENTRY_RECALLED, "memory");
    recordSearchHits(usageDb, [recalledRow.id]);
    const store = makeUsageStore([SIGNAL_ENTRY_RECALLED]);

    directCalls = [];
    const pi = createMockPi();
    const deps = makeDirectDeps({ ok: true, appliedCount: 1 });
    const result = await triggerConsolidation(
      pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory",
      directTransportLlmConfig, createDirectCtx() as any, usageDb, null, deps,
    );

    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(directCalls.length, 1, "direct transport used, no subprocess needed");
    const options = (directCalls[0][3] ?? directCalls[0][directCalls[0].length - 1]) as { userPrompt: string };
    assert.ok(options.userPrompt.includes(SIGNALS_HEADER), "direct prompt carries the section");
    assert.ok(options.userPrompt.includes(`recalled 1x, last ${todayStr()}: "${SIGNAL_ENTRY_RECALLED}"`));

  });
});

describe("consolidation usage signals — large all-recalled store (review blocker)", () => {
  let usageDb: DatabaseManager;
  let usageDir = "";

  beforeEach(async () => {
    // Top-level describe: reset the shared exec capture and lock dir here too.
    execCalls = [];
    process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-consolidation-locks-"),
    );
    usageDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-usage-signal-cap-"));
    usageDb = new DatabaseManager(usageDir);
  });

  afterEach(() => {
    try { usageDb.close(); } catch { /* already closed by the test */ }
    try { fs.rmSync(usageDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("caps the tracked half, ranks by hits, and folds the remainder into a summary line", async () => {
    // 40 entries, EVERY one recalled (the mature-store shape where the old
    // uncapped tracked half grew with the store: 40 tracked lines). Each entry
    // ~120 chars so the whole store fits one decisive prompt (chunking off).
    const entries: string[] = [];
    for (let i = 0; i < 40; i++) {
      entries.push(`mature-store entry ${String(i).padStart(2, "0")} — ${"recalled prose for sizing ".repeat(3)}end-${i}`);
    }
    const store = makeUsageStore(entries);
    const rows = entries.map((entry) => addMemory(usageDb, entry, "memory"));
    for (const row of rows) {
      const hits = 1 + (rows.indexOf(row) % 5); // 1..5 hits, entry 39 has 5
      for (let i = 0; i < hits; i++) recordSearchHits(usageDb, [row.id]);
    }
    // Highest count is on the LAST store entry — sorting must still surface it.
    for (let i = 0; i < 95; i++) recordSearchHits(usageDb, [rows[39].id]);

    const pi = createMockPi();
    // One decisive whole-store round: all 40 tracked entries in ONE prompt —
    // the mature-store shape the owner measured at 270% of the chunk budget.
    await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true, consolidationChunkChars: 999999 }, null, usageDb);

    const prompt = childPrompt(execCalls[0]);
    const sectionStart = prompt.indexOf("--- Usage Signals (memory_search recall tracking) ---");
    assert.ok(sectionStart > 0, "signals section present");
    const section = prompt.slice(sectionStart, prompt.indexOf("Use memory_add", sectionStart));

    const trackedLines = section.split("\n").filter((l) => l.startsWith("- recalled "));
    assert.strictEqual(trackedLines.length, 20, `tracked half capped at 20 (got ${trackedLines.length})`);
    assert.match(section, /\(\+20 more recalled entries omitted — showing the top 20 by recall count\)/, "remainder folded into a summary line");
    // Ranked by hits: the 100-hit entry must top the kept half despite being
    // LAST in store order, and the kept half is non-increasing by count.
    assert.match(trackedLines[0], /- recalled 100x, last \d{4}-\d{2}-\d{2}: "mature-store entry 39/);
    const counts = trackedLines.map((l) => Number(l.match(/- recalled (\d+)x/)![1]));
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] <= counts[i - 1], `kept half must be sorted by hits desc (got ${counts[i - 1]} -> ${counts[i]})`);
    }
    // Never-recalled half is empty here — no never-recalled summary expected.
    assert.ok(!section.includes("have no recorded recalls"));
    // Bounded section: constant line count, not store-proportional.
    assert.ok(section.length < 4500, `section bounded (got ${section.length} chars)`);
    usageDb.close();
  });
});
