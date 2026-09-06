import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryInitializer, withMemoryInitialization } from "../src/memory-initialization.js";

describe("memory initialization", () => {
  it("does no work until used and shares initialization across callers", async () => {
    let calls = 0;
    const gate = Promise.withResolvers<void>();
    const init = createMemoryInitializer(async () => { calls++; await gate.promise; });
    assert.equal(calls, 0);
    assert.equal(init.isReady(), false);
    const first = init.ensure();
    const second = init.ensure();
    await Promise.resolve();
    assert.equal(calls, 1);
    gate.resolve();
    await Promise.all([first, second]);
    await init.ensure();
    assert.equal(calls, 1);
    assert.equal(init.isReady(), true);
    await init.close();
  });

  it("retries after failure instead of caching a rejected promise", async () => {
    let calls = 0;
    const init = createMemoryInitializer(async () => {
      if (++calls === 1) throw new Error("load failed");
    });
    await assert.rejects(init.ensure(), /load failed/);
    assert.equal(init.isReady(), false);
    await init.ensure();
    assert.equal(calls, 2);
    assert.equal(init.isReady(), true);
    await init.close();
  });

  it("closing an unused session does not initialize it", async () => {
    let calls = 0;
    const init = createMemoryInitializer(async () => { calls++; });
    await init.close();
    await init.close();
    await assert.rejects(init.ensure(), /shut down/);
    assert.equal(calls, 0);
  });

  it("joins an in-flight load on shutdown and rejects its waiting operation", async () => {
    const gate = Promise.withResolvers<void>();
    const init = createMemoryInitializer(() => gate.promise);
    const first = assert.rejects(init.ensure(), /shut down/);
    let closed = false;
    const closing = init.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    gate.resolve();
    await Promise.all([first, closing]);
    assert.equal(closed, true);
  });
});

describe("guarded memory entry points", () => {
  it("preserves metadata and waits for initialization before tools and commands", async () => {
    const tools: any[] = [];
    const commands: any[] = [];
    const events: string[] = [];
    const contexts: unknown[] = [];
    const init = createMemoryInitializer(async () => {}, async (ctx) => { contexts.push(ctx); events.push("ready"); });
    const pi = withMemoryInitialization({
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, options: any) => commands.push({ name, ...options }),
    } as any, init);
    const renderResult = () => undefined;
    const parameters = {} as any;
    const getArgumentCompletions = () => null;
    pi.registerTool({
      name: "memory_test", label: "Test", description: "Test", parameters, renderResult: renderResult as any,
      execute: async (...args) => { events.push("tool"); return { content: [], details: args }; },
    });
    pi.registerCommand("memory-test", {
      description: "Test", getArgumentCompletions,
      handler: async () => { events.push("command"); },
    });
    assert.deepEqual(events, []);
    assert.equal(tools[0].renderResult, renderResult);
    assert.equal(tools[0].parameters, parameters);
    assert.equal(commands[0].getArgumentCompletions, getArgumentCompletions);
    const ctx = { cwd: "/project" };
    const args = ["id", { query: "test" }, undefined, undefined, ctx];
    assert.deepEqual((await tools[0].execute(...args)).details, args);
    await commands[0].handler("test", ctx);
    assert.deepEqual(events, ["ready", "tool", "ready", "command"]);
    assert.deepEqual(contexts, [ctx, ctx]);
  });

  it("does not execute a cancelled tool or cancel initialization for sibling calls", async () => {
    let tool: any;
    let loads = 0;
    let executions = 0;
    const gate = Promise.withResolvers<void>();
    const init = createMemoryInitializer(async () => { loads++; await gate.promise; });
    withMemoryInitialization({ registerTool: (def: any) => { tool = def; } } as any, init)
      .registerTool({ name: "test", label: "Test", description: "Test", parameters: {} as any,
        execute: async () => { executions++; return { content: [], details: {} }; } });
    const aborted = AbortSignal.abort();
    await assert.rejects(tool.execute("id", {}, aborted, undefined, { cwd: "/project" }));
    assert.equal(loads, 0);
    const controller = new AbortController();
    const first = assert.rejects(tool.execute("id", {}, controller.signal, undefined, { cwd: "/project" }));
    const second = tool.execute("id2", {}, undefined, undefined, { cwd: "/project" });
    controller.abort();
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(loads, 1);
    assert.equal(executions, 1);
    await init.close();
  });

  it("keeps first use unready and shutdown waiting through project binding and backfill", async () => {
    const bind = Promise.withResolvers<void>();
    const backfill = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const init = createMemoryInitializer(async () => {}, async () => {
      started.resolve();
      await bind.promise;
      await backfill.promise;
    });
    const first = init.ensure({ cwd: "/project" });
    await started.promise;
    assert.equal(init.isReady(), false);
    const rejected = assert.rejects(first, /shut down/);
    let closed = false;
    const closing = init.close().then(() => { closed = true; });
    bind.resolve();
    await new Promise(setImmediate);
    assert.equal(init.isReady(), false);
    assert.equal(closed, false);
    backfill.resolve();
    await Promise.all([rejected, closing]);
    assert.equal(closed, true);
  });

  it("waits for tool execution, not just its preparation, before closing", async () => {
    const execution = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const init = createMemoryInitializer(async () => {});
    const running = init.run({ cwd: "/project" }, async () => {
      started.resolve();
      await execution.promise;
      return "written";
    });
    await started.promise;
    let closed = false;
    const closing = init.close().then(() => { closed = true; });
    await new Promise(setImmediate);
    assert.equal(closed, false);
    await assert.rejects(init.run({ cwd: "/project" }, async () => "late"), /shut down/);
    execution.resolve();
    assert.equal(await running, "written");
    await closing;
  });

  it("cancels a waiting tool immediately while retaining shared preparation for shutdown", { timeout: 2000 }, async () => {
    const preparation = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const init = createMemoryInitializer(async () => {}, async () => {
      started.resolve();
      await preparation.promise;
    });
    const controller = new AbortController();
    const cancelled = assert.rejects(init.run({ cwd: "/project" }, async () => {
      assert.fail("cancelled tool must not execute");
    }, controller.signal), /cancelled/);
    await started.promise;
    controller.abort(new Error("cancelled"));
    await cancelled;
    let closed = false;
    const closing = init.close().then(() => { closed = true; });
    await new Promise(setImmediate);
    assert.equal(closed, false);
    preparation.resolve();
    await closing;
  });
});
