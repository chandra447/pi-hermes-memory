/**
 * Unit tests for auto-consolidation — triggerConsolidation and /memory-consolidate command.
 */

import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { registerConsolidateCommand, triggerConsolidation } from "../../src/handlers/auto-consolidate.js";
import { resolveWatchedChildPiInvocation } from "../../src/handlers/pi-child-process.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { runDirectMemoryCompletion } from "../../src/handlers/review-memory-ops.js";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import { DEFAULT_CONSOLIDATION_TIMEOUT_MS, ENTRY_DELIMITER } from "../../src/constants.js";

// ─── Mock infrastructure ───

let execCalls: any[];
let directCalls: unknown[][];

// Opt-in product evidence: command notifications, transport attempts, and disk state.
async function recordEvidence(name: string, data: unknown): Promise<void> {
  const directory = process.env.PI_HERMES_TEST_EVIDENCE_DIR;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}

const directTransportLlmConfig = { reviewTransport: "direct" as const };

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
  beforeEach(() => {
    execCalls = [];
  });

  it("builds prompt with current entries and calls pi.exec", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "memory");

    assert.strictEqual(execCalls.length, 1, "should call pi.exec once");
    const args = logicalChildArgs(execCalls[0]);
    assert.ok(args[0] === "-p", "should use -p flag");
    assert.ok(args.includes("--no-session"), "should include --no-session");

    const prompt = args[args.length - 1];
    assert.ok(prompt.includes("old entry 1"), "prompt should include current memory entries");
    assert.ok(prompt.includes("memory"), "prompt should reference target");
  });

  it("returns { consolidated: true } on success (exit code 0)", async () => {
    const pi = createMockPi({ code: 0, stdout: "Done", stderr: "" });
    const result = await triggerConsolidation(pi, mockStore, "memory");

    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.error, undefined);
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
      const first = await triggerConsolidation(pi, mockStore, "memory");
      const second = await triggerConsolidation(pi, mockStore, "memory");

      assert.strictEqual(first.consolidated, true);
      assert.strictEqual(second.consolidated, true);
      assert.strictEqual(execCalls.length, 2);
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
      const first = triggerConsolidation(pi, mockStore, "memory");
      await execStarted;
      const second = triggerConsolidation(pi, mockStore, "memory");
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
      const first = triggerConsolidation(pi, mockStore, "memory");
      await firstExecStarted;
      const second = triggerConsolidation(pi, mockStore, "memory");
      await settle(20);
      releaseExecs.forEach((release) => release());

      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.strictEqual(firstResult.consolidated, true);
      assert.strictEqual(secondResult.consolidated, true, "the queued caller should consolidate, not hard-fail");
      assert.strictEqual(secondResult.deferred, undefined);
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
      const first = triggerConsolidation(pi, shrinkingStore, "memory");
      await firstExecStarted;
      const second = triggerConsolidation(pi, shrinkingStore, "memory");
      await settle(20);
      releaseExecs.forEach((release) => release());

      const [, secondResult] = await Promise.all([first, second]);
      assert.strictEqual(secondResult.consolidated, true);
      assert.strictEqual(execCalls.length, 1, "a second LLM pass is pure cost once space is already free");
    });
  });

  it("does not retry after shrinking the larger snapshot loaded following contention", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-growth-"));
    const config = { memoryDir: root, memoryCharLimit: 5000, userCharLimit: 5000 };
    const writer = new MemoryStore(config);
    const waitingStore = new MemoryStore(config);
    const prototype = AtomicLockCoordinator.prototype;
    const originalTryAcquire = prototype.tryAcquire;
    let markContended!: () => void;
    const contended = new Promise<void>((resolve) => { markContended = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    prototype.tryAcquire = function (...args) {
      const lease = originalTryAcquire.apply(this, args);
      if (!lease) markContended();
      return lease;
    };
    try {
      await writer.loadFromDisk();
      await writer.add("memory", "a".repeat(100));
      await waitingStore.loadFromDisk();
      const initialLength = waitingStore.getMemoryEntries().join(ENTRY_DELIMITER).length;
      let grownLength = 0;
      let calls = 0;
      const pi = {
        exec: async (...args: any[]) => {
          calls++;
          if (calls === 1) {
            markStarted();
            await contended;
            await writer.add("memory", "b".repeat(200));
            grownLength = writer.getMemoryEntries().join(ENTRY_DELIMITER).length;
            return { code: 0, stdout: "", stderr: "" };
          }
          if (calls === 2) {
            assert.ok(childPrompt(captureExecArgs(args)).includes("b".repeat(200)));
            const childStore = new MemoryStore(config);
            await childStore.loadFromDisk();
            await childStore.replace("memory", "b".repeat(200), "c".repeat(100));
          }
          return { code: 1, stdout: "", stderr: "provider overloaded" };
        },
      } as any;
      await withLockWait("2000", async () => {
        const first = triggerConsolidation(pi, writer, "memory");
        await started;
        const second = triggerConsolidation(pi, waitingStore, "memory", undefined, 60_000, "memory", {
          llmModelOverride: "test/primary", llmFallbackModels: ["test/fallback"],
        });
        const results = await Promise.all([first, second]);
        assert.ok(results.every((result) => result.consolidated));
      });
      assert.equal(calls, 2);
      await waitingStore.loadFromDisk();
      const finalLength = waitingStore.getMemoryEntries().join(ENTRY_DELIMITER).length;
      assert.ok(finalLength > initialLength);
      assert.ok(finalLength < grownLength);
      await recordEvidence("contention-growth-no-double-spend", {
        initialLength, grownLength, finalLength, childAttempts: calls,
        persisted: waitingStore.getMemoryEntries(),
      });
    } finally {
      prototype.tryAcquire = originalTryAcquire;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows the same project target to consolidate concurrently in distinct stores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-stores-"));
    const stores = ["project-a", "project-b"].map((name) => new MemoryStore({
      memoryDir: path.join(root, name),
      memoryCharLimit: 5_000,
      userCharLimit: 5_000,
    } as any));
    await Promise.all(stores.map((store) => store.loadFromDisk()));

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
        await new Promise<void>((resolve) => { releases.push(resolve); });
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
      assert.strictEqual(started, 2);
    } finally {
      releases.forEach((release) => release());
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns { consolidated: false } on failure (non-zero exit code)", async () => {
    const pi = createMockPi({ code: 1, stdout: "", stderr: "some error" });
    const result = await triggerConsolidation(pi, mockStore, "memory");

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
      { llmModelOverride: "openrouter/deepseek/deepseek-v4-flash" },
    );

    assert.strictEqual(result.consolidated, true);
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

  it("uses a configured fallback model when the primary subprocess provider is overloaded", async () => {
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return execCalls.length === 1
          ? { code: 1, stdout: "", stderr: "Codex error: Our servers are currently overloaded. Please try again later." }
          : { code: 0, stdout: "Consolidated", stderr: "" };
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
      {
        llmModelOverride: "openai-codex/gpt-5.3-codex",
        llmFallbackModels: ["anthropic/claude-sonnet-4-5"],
      },
    );

    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(execCalls.length, 2);
    assert.ok(logicalChildArgs(execCalls[0]).includes("openai-codex/gpt-5.3-codex"));
    assert.ok(logicalChildArgs(execCalls[1]).includes("anthropic/claude-sonnet-4-5"));
  });

  for (const failure of ["HTTP 429 too many requests", "HTTP 503 service unavailable", "ECONNRESET", "request timed out"]) {
    it(`recovers project consolidation after ${failure}`, async () => {
      const pi = {
        exec: async (...args: any[]) => {
          execCalls.push(captureExecArgs(args));
          if (execCalls.length === 1) throw new Error(failure);
          return { code: 0, stdout: "Consolidated", stderr: "" };
        },
      } as any;
      const result = await triggerConsolidation(pi, mockStore, "memory", undefined, 60000, "project", {
        llmModelOverride: "test/primary", llmFallbackModels: ["test/primary", " ", "test/fallback", "test/fallback"],
      });
      assert.equal(result.consolidated, true);
      assert.equal(execCalls.length, 2);
      assert.ok(logicalChildArgs(execCalls[1]).includes("test/fallback"));
      assert.equal(childPrompt(execCalls[0]), childPrompt(execCalls[1]));
      assert.match(childPrompt(execCalls[1]), /project/);
    });
  }

  it("does not launch a fallback after cancellation during an overloaded primary", async () => {
    const controller = new AbortController();
    const pi = {
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        controller.abort();
        return { code: 1, stdout: "", stderr: "provider overloaded" };
      },
    } as any;
    const result = await triggerConsolidation(pi, mockStore, "memory", controller.signal, 60000, "memory", {
      llmModelOverride: "test/primary", llmFallbackModels: ["test/fallback"],
    });
    assert.equal(result.consolidated, false);
    assert.equal(execCalls.length, 1);
    await recordEvidence("cancelled-fallback", { result, attempts: execCalls.length });
  });

  it("reports the final provider error when every configured consolidation model is overloaded", async () => {
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const model = execCalls.length === 1 ? "primary" : "fallback";
        return { code: 1, stdout: "", stderr: `${model} provider overloaded` };
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
      {
        llmModelOverride: "openai-codex/gpt-5.3-codex",
        llmFallbackModels: ["anthropic/claude-sonnet-4-5"],
      },
    );

    assert.strictEqual(result.consolidated, false);
    assert.strictEqual(execCalls.length, 2);
    assert.match(result.error!, /fallback provider overloaded/);
    await recordEvidence("all-models-failed", { result, attempts: execCalls.map(logicalChildArgs) });
  });

  it("does not try configured fallbacks for a non-retryable consolidation failure", async () => {
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
      {
        llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
        llmFallbackModels: ["anthropic/claude-sonnet-4-5"],
      },
    );

    assert.strictEqual(result.consolidated, false);
    assert.match(result.error!, /memory tool returned no changes/);
    assert.strictEqual(execCalls.length, 1, "should not retry non-retryable consolidation failures");
    await recordEvidence("non-retryable-failure", { result, attempts: execCalls.map(logicalChildArgs) });
  });

  it("handles empty entries gracefully", async () => {
    const emptyStore = {
      getMemoryEntries: () => [],
      getUserEntries: () => [],
      getStorageIdentity: async (target: string) => path.join("empty-store", target),
      loadFromDisk: async () => {},
    } as any;

    const pi = createMockPi();
    await triggerConsolidation(pi, emptyStore, "memory");

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("(empty)"), "prompt should show (empty) for empty entries");
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

      assert.strictEqual(result.consolidated, true);
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

      assert.strictEqual(result.consolidated, true);
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

      assert.strictEqual(result.consolidated, true);
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

      assert.strictEqual(result.consolidated, true);
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
    } as any;

    registerConsolidateCommand(pi, mockStore, 60000, projectStore, "demo-project");
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
    assert.ok(finalNotification.includes("failure: ✅ consolidated"), "final notification should include failure result");
    assert.ok(finalNotification.includes("project:demo-project: ✅ consolidated"), "final notification should include project result");
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
      {
        ...directTransportLlmConfig,
        llmModelOverride: "openai-codex/gpt-5.3-codex",
        llmFallbackModels: ["anthropic/claude-sonnet-4-5"],
      },
      null,
      makeDirectDeps({ ok: true, appliedCount: 2 }),
    );

    assert.ok(handler, "command handler should be registered");
    await handler!({}, commandCtx);

    assert.strictEqual(directCalls.length, 3, "memory, user, and failure targets should use direct transport");
    assert.strictEqual(execCalls.length, 0, "successful direct consolidation should not spawn subprocess");
    for (const call of directCalls) {
      assert.strictEqual(call[0], commandCtx, "runDirectMemoryCompletion must receive the command ctx");
      const options = call[3] as { config: { llmFallbackModels?: string[] } };
      assert.deepStrictEqual(
        options.config.llmFallbackModels,
        ["anthropic/claude-sonnet-4-5"],
        "manual direct consolidation must receive the configured fallback chain",
      );
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

  it("add() completes automatic over-capacity consolidation through a configured fallback model", async () => {
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
      memoryDir: path.join(MEMORY_DIR, "provider-fallback"),
    } as any);
    await store.loadFromDisk();

    const calls: any[][] = [];
    const pi = {
      exec: async (...args: any[]) => {
        calls.push(captureExecArgs(args));
        if (calls.length === 1) {
          return { code: 1, stdout: "", stderr: "Codex error: Our servers are currently overloaded. Please try again later." };
        }
        for (const entry of [...store.getMemoryEntries()]) {
          await store.remove("memory", entry);
        }
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
    } as any;

    store.setConsolidator((target, signal) => triggerConsolidation(
      pi,
      store,
      target,
      signal,
      60_000,
      target,
      {
        llmModelOverride: "openai-codex/gpt-5.3-codex",
        llmFallbackModels: ["anthropic/claude-sonnet-4-5"],
      },
    ));

    await store.add("memory", "a".repeat(60));
    const before = [...store.getMemoryEntries()];
    const result = await store.add("memory", "b".repeat(20));

    assert.strictEqual(result.success, true);
    assert.strictEqual(calls.length, 2);
    assert.ok(logicalChildArgs(calls[1]).includes("anthropic/claude-sonnet-4-5"));
    const persisted = new MemoryStore({
      memoryDir: path.join(MEMORY_DIR, "provider-fallback"), memoryCharLimit: 120, userCharLimit: 120,
    });
    await persisted.loadFromDisk();
    assert.equal(persisted.getMemoryEntries().length, 1);
    assert.ok(persisted.getMemoryEntries()[0].includes("b".repeat(20)));
    await recordEvidence("automatic-over-capacity", {
      surface: "MemoryStore.add after capacity overflow", transport: "isolated fake pi.exec",
      primaryError: "Codex error: Our servers are currently overloaded. Please try again later.",
      before, result, attempts: calls.map(logicalChildArgs), persisted: persisted.getMemoryEntries(),
    });
  });

  for (const failure of ["overload", "timeout", "throw"] as const) {
    it(`does not replay consolidation after persisted shrink followed by ${failure}`, async () => {
      const config = {
        memoryDir: path.join(MEMORY_DIR, `persisted-${failure}`),
        memoryCharLimit: 120,
        userCharLimit: 120,
        autoConsolidate: true,
        overflowGraceMs: 0,
      };
      const store = new MemoryStore(config);
      await store.loadFromDisk();
      await store.add("memory", "a".repeat(60));
      let calls = 0;
      const pi = {
        exec: async () => {
          calls++;
          const childStore = new MemoryStore(config);
          await childStore.loadFromDisk();
          for (const entry of childStore.getMemoryEntries()) {
            await childStore.remove("memory", entry);
          }
          if (failure === "throw") throw new Error("provider overloaded");
          return { code: failure === "timeout" ? 124 : 1, stdout: "", stderr: failure === "timeout" ? "request timed out" : "provider overloaded" };
        },
      } as any;
      store.setConsolidator((target, signal) => triggerConsolidation(
        pi, store, target, signal, 60_000, target,
        { llmModelOverride: "test/primary", llmFallbackModels: ["test/fallback"] },
      ));
      const result = await store.add("memory", "b".repeat(20));
      assert.equal(result.success, true);
      assert.equal(calls, 1);
      await store.loadFromDisk();
      assert.equal(store.getMemoryEntries().length, 1);
      assert.ok(store.getMemoryEntries()[0].includes("b".repeat(20)));
      await recordEvidence(`no-double-spend-${failure}`, { failureAfterPersistedShrink: failure, attempts: calls, result, persisted: store.getMemoryEntries() });
    });
  }

  it("manual consolidation applies atomic shrink through the real direct fallback chain", async () => {
    const config = { memoryDir: path.join(MEMORY_DIR, "manual-fallback"), memoryCharLimit: 5000, userCharLimit: 5000 };
    const store = new MemoryStore(config);
    await store.loadFromDisk();
    await store.add("memory", "A durable preference with a unnecessarily verbose description".repeat(3));
    const before = store.getMemoryEntries().join(ENTRY_DELIMITER).length;
    const models = ["primary", "fallback"].map((id) => ({ provider: "test", id, reasoning: false }));
    const calls: string[] = [];
    const authCalls: string[] = [];
    const notifications: string[] = [];
    let handler: any;
    let subprocessCalls = 0;
    const pi = {
      registerCommand: (_name: string, command: any) => { handler = command.handler; },
      exec: async () => { subprocessCalls++; throw new Error("unexpected subprocess"); },
    } as any;
    registerConsolidateCommand(pi, store, 60_000, null, null, {
      reviewTransport: "direct",
      llmModelOverride: "test/primary",
      llmFallbackModels: ["test/fallback"],
    }, null, {
      runDirectMemoryCompletion: (...args) => runDirectMemoryCompletion(...args, {
        completeSimple: (async (model: { id: string }) => {
          calls.push(model.id);
          if (model.id === "primary") throw new Error("provider overloaded");
          assert.equal(store.getMemoryEntries().join(ENTRY_DELIMITER).length, before);
          return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ operations: [
            { action: "replace", target: "memory", old_text: store.getMemoryEntries()[0], content: "Durable preference" },
          ] }) }] };
        }) as never,
      }),
    });
    await handler({}, {
      model: models[0],
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => models,
        getApiKeyAndHeaders: async (model: { id: string }) => {
          authCalls.push(model.id);
          return { ok: true, apiKey: "isolated-test-key" };
        },
      },
      ui: { notify: (message: string) => notifications.push(message) },
    });
    assert.deepEqual(calls, ["primary", "fallback"]);
    assert.deepEqual(authCalls, ["primary", "fallback"]);
    assert.equal(subprocessCalls, 0);
    const persisted = new MemoryStore(config);
    await persisted.loadFromDisk();
    assert.ok(persisted.getMemoryEntries().join(ENTRY_DELIMITER).length < before);
    assert.ok(persisted.getMemoryEntries()[0].includes("Durable preference"));
    assert.ok(notifications.at(-1)?.includes("memory: ✅ consolidated"));
    await recordEvidence("manual-direct-fallback", {
      surface: "/memory-consolidate", transport: "real direct completion helper with isolated fake completion/auth",
      primaryError: "provider overloaded", models: calls, authCalls, subprocessCalls,
      beforeCharacters: before, persisted: persisted.getMemoryEntries(), notifications,
    });
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
});
