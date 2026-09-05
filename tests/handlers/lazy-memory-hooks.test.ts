import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setupBackgroundReview } from "../../src/handlers/background-review.js";
import { setupCorrectionDetector } from "../../src/handlers/correction-detector.js";
import { setupSessionFlush } from "../../src/handlers/session-flush.js";
import { loadConfig } from "../../src/config.js";

function fixture() {
  const config = { ...loadConfig("/nonexistent/pi-memory-hook-test.json"), nudgeInterval: 1, flushMinTurns: 2 };
  const handlers: Record<string, Function[]> = {};
  const pi = { on(name: string, fn: Function) { (handlers[name] ??= []).push(fn); } } as any;
  let ready = false;
  let loads = 0;
  let calls = 0;
  const store = {
    getMemoryEntries() { assert.ok(ready); return ["existing fact"]; },
    getUserEntries() { assert.ok(ready); return []; },
    async addFailure() { assert.ok(ready); return { success: true }; },
  } as any;
  const ctx = {
    cwd: "/project",
    sessionManager: {
      getBranch: () => Array.from({ length: 8 }, (_, i) => ({
        type: "message", message: { role: i % 2 ? "assistant" : "user", content: "no, use pnpm" },
      })),
    },
    ui: { notify() {} },
  };
  const ensureMemoryReady = async (context: { cwd: string }) => {
    assert.equal(context.cwd, ctx.cwd);
    loads++;
    ready = true;
  };
  const runDirectMemoryCompletion = async () => {
    assert.ok(ready);
    calls++;
    return { ok: true, appliedCount: 0 };
  };
  const emit = async (name: string, event: any = {}) => {
    for (const handler of handlers[name] ?? []) await handler(event, ctx);
  };
  return { pi, config, store, emit, ensureMemoryReady, runDirectMemoryCompletion,
    loads: () => loads, calls: () => calls };
}

describe("lazy memory automatic operations", () => {
  it("initializes only after a background review actually becomes due", async () => {
    const f = fixture();
    const settled = Promise.withResolvers<void>();
    setupBackgroundReview(f.pi, f.store, null, f.config, {
      ensureMemoryReady: f.ensureMemoryReady,
      deps: { runDirectReview: f.runDirectMemoryCompletion, onReviewSettled: settled.resolve },
    });
    await f.emit("message_end", { message: { role: "user" } });
    await f.emit("turn_end");
    assert.equal(f.loads(), 0);
    await f.emit("message_end", { message: { role: "user" } });
    await f.emit("message_end", { message: { role: "user" } });
    await f.emit("turn_end");
    await settled.promise;
    assert.equal(f.loads(), 1);
    assert.equal(f.calls(), 1);
    await f.emit("session_shutdown");
  });

  it("initializes before correction capture, not on ordinary messages", async () => {
    const f = fixture();
    setupCorrectionDetector(f.pi, f.store, null, f.config, null, null, {
      ensureMemoryReady: f.ensureMemoryReady, runDirectMemoryCompletion: f.runDirectMemoryCompletion,
    });
    await f.emit("message_end", { message: { role: "user", content: "hello" } });
    await f.emit("turn_end");
    assert.equal(f.loads(), 0);
    await f.emit("message_end", { message: { role: "user", content: "no, use pnpm" } });
    await f.emit("turn_end");
    assert.equal(f.loads(), 1);
    assert.equal(f.calls(), 1);
  });

  it("initializes for a qualifying flush, not a short session or reload", async () => {
    const f = fixture();
    setupSessionFlush(f.pi, f.store, null, f.config, null, null, {
      ensureMemoryReady: f.ensureMemoryReady, runDirectMemoryCompletion: f.runDirectMemoryCompletion,
    });
    await f.emit("message_end", { message: { role: "user" } });
    await f.emit("session_before_compact");
    assert.equal(f.loads(), 0);
    await f.emit("message_end", { message: { role: "user" } });
    await f.emit("session_shutdown", { reason: "reload" });
    assert.equal(f.loads(), 0);
    await f.emit("session_before_compact");
    assert.equal(f.loads(), 1);
    assert.equal(f.calls(), 1);
  });

  it("does not flush against unloaded memory after an initialization error", async () => {
    const f = fixture();
    setupSessionFlush(f.pi, f.store, null, { ...f.config, flushMinTurns: 0 }, null, null, {
      ensureMemoryReady: async () => { throw new Error("load failed"); },
      runDirectMemoryCompletion: f.runDirectMemoryCompletion,
    });
    await f.emit("session_before_compact");
    assert.equal(f.calls(), 0);
  });
});
