/**
 * Consolidation llmFallbackModels subprocess path — focused coverage for the
 * #241/#242 landing (stderr-only classifier, abort, overload fallback).
 */
import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { triggerConsolidation } from "../../src/handlers/auto-consolidate.js";
import { resolveWatchedChildPiInvocation } from "../../src/handlers/pi-child-process.js";

let execCalls: any[];
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
  LOCK_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-fallback-lock-"));
  process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = LOCK_DIR;
});

after(async () => {
  if (OLD_LOCK_DIR === undefined) delete process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR;
  else process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = OLD_LOCK_DIR;
  try { await fs.rm(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function logicalChildArgs(call: any[]): string[] {
  const [cmd, args] = call;
  const underlying = { command: args[3], args: args.slice(4) };
  const expected = resolveWatchedChildPiInvocation(underlying, Number(args[1]), args[2]);
  assert.deepStrictEqual({ command: cmd, args }, expected);
  return underlying.command === "pi" ? underlying.args : underlying.args.slice(1);
}

const mockStore = {
  getMemoryEntries: () => ["old entry 1", "old entry 2"],
  getUserEntries: () => ["user fact 1"],
  getAllFailureEntries: () => ["failure lesson 1"],
  getStorageIdentity: async (target: string) => path.join("mock-store", target),
  loadFromDisk: async () => {},
} as any;

describe("consolidation llmFallbackModels (subprocess)", () => {
  beforeEach(() => { execCalls = []; });

  it("uses a configured fallback model when the primary subprocess provider is overloaded", async () => {
    const pi = {
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return execCalls.length === 1
          ? { code: 1, stdout: "", stderr: "Codex error: Our servers are currently overloaded. Please try again later." }
          : { code: 0, stdout: "Consolidated", stderr: "" };
      },
    } as any;
    const result = await triggerConsolidation(pi, mockStore, "memory", undefined, 60000, "memory", {
      llmModelOverride: "openai-codex/gpt-5.3-codex",
      llmFallbackModels: ["anthropic/claude-sonnet-4-5"],
    });
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(execCalls.length, 2);
    assert.ok(logicalChildArgs(execCalls[0]).includes("openai-codex/gpt-5.3-codex"));
    assert.ok(logicalChildArgs(execCalls[1]).includes("anthropic/claude-sonnet-4-5"));
  });

  it("does not treat matching corpus on stdout as a retryable provider failure", async () => {
    const pi = {
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return {
          code: 1,
          stdout: "memory mentions provider overloaded and HTTP 503 in a past failure lesson",
          stderr: "memory tool returned no changes",
        };
      },
    } as any;
    const result = await triggerConsolidation(pi, mockStore, "memory", undefined, 60000, "memory", {
      llmModelOverride: "test/primary",
      llmFallbackModels: ["test/fallback"],
    });
    assert.strictEqual(result.consolidated, false);
    assert.strictEqual(execCalls.length, 1, "stdout corpus must not trigger fallback");
    assert.match(result.error!, /memory tool returned no changes/);
  });

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
      llmModelOverride: "test/primary",
      llmFallbackModels: ["test/fallback"],
    });
    assert.equal(result.consolidated, false);
    assert.equal(execCalls.length, 1);
  });

  it("does not try configured fallbacks for a non-retryable consolidation failure", async () => {
    const pi = {
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 1, stdout: "", stderr: "memory tool returned no changes" };
      },
    } as any;
    const result = await triggerConsolidation(pi, mockStore, "memory", undefined, 60000, "memory", {
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
      llmFallbackModels: ["anthropic/claude-sonnet-4-5"],
    });
    assert.strictEqual(result.consolidated, false);
    assert.strictEqual(execCalls.length, 1);
  });
});
