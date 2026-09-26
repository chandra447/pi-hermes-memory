import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import registerExtension from "../src/index.js";
import { loadConfig } from "../src/config.js";

const TOOL_NAMES = [
  "memory_add", "memory_replace", "memory_remove", "skill_manage", "memory_search", "session_search",
];
const COMMAND_NAMES = [
  "memory-insights", "memory-consolidate", "learn-memory-tool", "memory-preview-context",
  "memory-skills", "memory-interview", "memory-sync-markdown", "memory-index-sessions",
  "memory-pin", "memory-switch-project",
];

function capture(register: (pi: any) => void) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  register({
    on(name: string, handler: Function) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
  });
  return { tools, commands, handlers };
}

function runModuleProbe(config: Record<string, unknown>, body: string): any {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-thin-probe-"));
  fs.writeFileSync(path.join(root, "hermes-memory-config.json"), JSON.stringify({
    lazyInitialization: true,
    memoryMode: "policy-only",
    reviewEnabled: false,
    correctionDetection: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    ...config,
  }));
  const source = `
    import { registerHooks } from "node:module";
    import { pathToFileURL } from "node:url";
    let runtimeLoads = 0;
    registerHooks({ load(url, context, nextLoad) {
      if (url.endsWith("/src/runtime.ts")) runtimeLoads++;
      return nextLoad(url, context);
    }});
    const { default: registerExtension } = await import(pathToFileURL(${JSON.stringify(path.join(process.cwd(), "src/index.ts"))}).href);
    const handlers = new Map(), tools = new Map(), commands = new Map();
    const pi = {
      on(name, handler) { const values = handlers.get(name) ?? []; values.push(handler); handlers.set(name, values); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      exec: async () => ({ code: 0 }),
    };
    const ctx = {
      cwd: process.cwd(), signal: new AbortController().signal,
      sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
      ui: { notify() {} },
    };
    const emit = async (name, event = {}, eventCtx = ctx) => {
      let result;
      for (const handler of handlers.get(name) ?? []) result = (await handler(event, eventCtx)) ?? result;
      return result;
    };
    ${body}
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env, PI_CODING_AGENT_DIR: root },
    encoding: "utf8",
  });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.trim().split("\n").at(-1);
  return JSON.parse(line ?? "null");
}

function publicToolMetadata(tool: any) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
    hasRenderer: typeof tool.renderResult === "function",
  };
}

describe("thin entrypoint", () => {
  it("registers the complete public tool and command surface synchronously", () => {
    const thin = capture(registerExtension);
    assert.deepEqual([...thin.tools.keys()].sort(), [...TOOL_NAMES].sort());
    assert.deepEqual([...thin.commands.keys()].sort(), [...COMMAND_NAMES].sort());
    assert.ok(thin.handlers.has("session_start"));
    assert.ok(thin.handlers.has("before_agent_start"));
    assert.ok(thin.handlers.has("resources_discover"));
    assert.ok(thin.handlers.has("session_shutdown"));
  });

  it("keeps thin tool metadata and command descriptions identical to the runtime", async () => {
    const thin = capture(registerExtension);
    const { default: registerRuntime } = await import("../src/runtime.js");
    const full = capture((pi) => registerRuntime(pi, loadConfig("/nonexistent/thin-entrypoint-config.json")));
    for (const name of TOOL_NAMES) {
      assert.deepEqual(publicToolMetadata(thin.tools.get(name)), publicToolMetadata(full.tools.get(name)), name);
    }
    for (const name of COMMAND_NAMES) {
      assert.equal(thin.commands.get(name).description, full.commands.get(name).description, name);
    }
    assert.deepEqual(thin.commands.get("memory-pin").getArgumentCompletions("r"),
      full.commands.get("memory-pin").getArgumentCompletions("r"));
  });

  it("does not statically import persistence, indexing, or background-handler modules", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    for (const denied of [
      "./store/memory-store.js", "./store/db.js", "./store/session-indexer.js",
      "./handlers/background-review.js", "./handlers/correction-detector.js",
      "./handlers/session-flush.js", "./runtime.js\";",
    ]) {
      assert.equal(source.includes(`from \"${denied}`), false, denied);
    }
    assert.match(source, /import\("\.\/runtime\.js"\)/);
  });

  it("does not register tool_result and leaves generic lazy lifecycle events cold", () => {
    const thin = capture(registerExtension);
    assert.equal(thin.handlers.has("tool_result"), false);
    const result = runModuleProbe({}, `
      registerExtension(pi);
      await emit("session_start");
      await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "hello" }] } });
      await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
      console.log(JSON.stringify({ runtimeLoads }));
    `);
    assert.deepEqual(result, { runtimeLoads: 0 });
  });

  it("retires an ineligible cold shutdown before a later command can replay session_start", () => {
    const result = runModuleProbe({}, `
      let imports = 0;
      const seen = [];
      registerExtension(pi, { importRuntime: async () => ({ default(runtimePi) {
        imports++;
        runtimePi.on("session_start", () => { seen.push("stale-start"); });
        runtimePi.registerCommand("memory-insights", { handler: () => { seen.push("command"); } });
      } }) });
      await emit("session_start", {}, { ...ctx, marker: "old" });
      await emit("session_shutdown", { reason: "quit" });
      let rejected = false;
      try { await commands.get("memory-insights").handler("", ctx); } catch { rejected = true; }
      console.log(JSON.stringify({ runtimeLoads, imports, rejected, seen }));
    `);
    assert.deepEqual(result, { runtimeLoads: 0, imports: 0, rejected: true, seen: [] });
  });

  it("cancels an eager never-settling import on shutdown and fences its late completion", () => {
    const result = runModuleProbe({ lazyInitialization: false }, `
      const importStarted = Promise.withResolvers();
      const release = Promise.withResolvers();
      let imports = 0;
      let registered = 0;
      const seen = [];
      registerExtension(pi, { importRuntime: async () => {
        imports++;
        importStarted.resolve();
        await release.promise;
        return { default(runtimePi) {
          registered++;
          runtimePi.on("session_start", () => { seen.push("late-start"); });
        }};
      }});
      const start = emit("session_start");
      await importStarted.promise;
      await emit("session_shutdown", { reason: "quit" });
      await start;
      release.resolve();
      await new Promise(setImmediate);
      await emit("session_start", {}, { ...ctx, marker: "replacement" });
      console.log(JSON.stringify({ runtimeLoads, imports, registered, seen }));
    `);
    assert.deepEqual(result, { runtimeLoads: 0, imports: 2, registered: 1, seen: ["late-start"] });
  });

  it("preserves an eligible lazy shutdown flush trigger", () => {
    const result = runModuleProbe({ flushOnShutdown: true, flushMinTurns: 2 }, `
      let imports = 0;
      const seen = [];
      registerExtension(pi, { importRuntime: async () => ({ default(runtimePi) {
        imports++;
        runtimePi.on("session_start", () => { seen.push("start"); });
        runtimePi.on("session_shutdown", () => { seen.push("shutdown"); });
      } }) });
      await emit("session_start");
      await emit("message_end", { message: { role: "user", content: "ordinary" } });
      await emit("message_end", { message: { role: "user", content: "ordinary" } });
      await emit("session_shutdown", { reason: "quit" });
      console.log(JSON.stringify({ runtimeLoads, imports, seen }));
    `);
    assert.deepEqual(result, { runtimeLoads: 0, imports: 1, seen: ["start", "shutdown"] });
  });

  it("does not retain large lifecycle objects when all cold operations are disabled", () => {
    const result = runModuleProbe({}, `
      registerExtension(pi);
      let eventRef, contextRef;
      await (async () => {
        let event = { message: { role: "user", content: "x".repeat(2_000_000) } };
        let eventContext = { marker: "large-context" };
        eventRef = new WeakRef(event);
        contextRef = new WeakRef(eventContext);
        await emit("message_end", event, eventContext);
        event = null;
        eventContext = null;
      })();
      await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 8; i++) {
        global.gc();
        new Array(100_000).fill(0);
      }
      console.log(JSON.stringify({ runtimeLoads, eventCollected: !eventRef.deref(), contextCollected: !contextRef.deref() }));
    `);
    assert.deepEqual(result, { runtimeLoads: 0, eventCollected: true, contextCollected: true });
  });

  it("does not retain large events while an enabled threshold remains unmet", () => {
    const result = runModuleProbe({ reviewEnabled: true, nudgeInterval: 1_000_000, nudgeToolCalls: 1_000_000 }, `
      registerExtension(pi);
      let eventRef;
      await (async () => {
        let event = { message: { role: "user", content: "x".repeat(2_000_000) } };
        eventRef = new WeakRef(event);
        for (let i = 0; i < 20; i++) await emit("message_end", event);
        await emit("turn_end", { message: { role: "assistant", content: [] } });
        event = null;
      })();
      await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 8; i++) {
        global.gc();
        new Array(100_000).fill(0);
      }
      console.log(JSON.stringify({ runtimeLoads, eventCollected: !eventRef.deref() }));
    `);
    assert.deepEqual(result, { runtimeLoads: 0, eventCollected: true });
  });

  it("seeds exact pre-trigger counters instead of replaying every prior event", () => {
    const result = runModuleProbe({ reviewEnabled: true, nudgeInterval: 100, nudgeToolCalls: 1_000_000 }, `
      let seeded;
      let imports = 0;
      registerExtension(pi, { importRuntime: async () => ({ default(runtimePi, _config, options) {
        imports++;
        seeded = options.lazyState;
        runtimePi.on("turn_end", () => {});
      } }) });
      await emit("session_start");
      for (let i = 0; i < 3; i++) await emit("message_end", { message: { role: "user", content: "ordinary" } });
      for (let i = 0; i < 99; i++) await emit("turn_end", { message: { role: "assistant", content: [] } });
      assert.equal(runtimeLoads, 0);
      await emit("turn_end", { message: { role: "assistant", content: [] } });
      console.log(JSON.stringify({ runtimeLoads: imports, seeded }));
    `);
    assert.deepEqual(result, {
      runtimeLoads: 1,
      seeded: { userTurnCount: 3, turnsSinceReview: 99, toolCallsSinceReview: 0 },
    });
  });

  it("keeps omitted events counted while the first runtime load is pending", () => {
    const result = runModuleProbe({ reviewEnabled: true, nudgeInterval: 2, nudgeToolCalls: 1_000_000 }, `
      const importStarted = Promise.withResolvers();
      const release = Promise.withResolvers();
      const seeds = [];
      registerExtension(pi, { importRuntime: async () => {
        importStarted.resolve();
        await release.promise;
        return { default(runtimePi) {
          runtimePi.on("turn_end", () => {});
          return { seedLazyState(state) { seeds.push({ ...state }); } };
        }};
      }});
      await emit("session_start");
      for (let i = 0; i < 3; i++) await emit("message_end", { message: { role: "user", content: "ordinary" } });
      await emit("turn_end", { message: { role: "assistant", content: [] } });
      const trigger = emit("turn_end", { message: { role: "assistant", content: [] } });
      await importStarted.promise;
      const omitted = emit("turn_end", { message: { role: "assistant", content: [] } });
      const nextTrigger = emit("turn_end", { message: { role: "assistant", content: [] } });
      release.resolve();
      await Promise.all([trigger, omitted, nextTrigger]);
      console.log(JSON.stringify({ seeds }));
    `);
    assert.deepEqual(result.seeds, [
      { userTurnCount: 3, turnsSinceReview: 1, toolCallsSinceReview: 0 },
      { userTurnCount: 3, turnsSinceReview: 1, toolCallsSinceReview: 0 },
    ]);
  });

  it("loads runtime once when background review qualifies", () => {
    const result = runModuleProbe({ reviewEnabled: true, nudgeInterval: 1 }, `
      registerExtension(pi);
      await emit("session_start");
      for (let i = 0; i < 3; i++) {
        await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "ordinary" }] } });
      }
      await emit("turn_end", { message: { role: "assistant", content: [] } });
      await emit("turn_end", { message: { role: "assistant", content: [] } });
      console.log(JSON.stringify({ runtimeLoads }));
    `);
    assert.deepEqual(result, { runtimeLoads: 1 });
  });

  it("replays qualifying events serially in arrival order", () => {
    const result = runModuleProbe({ correctionDetection: true, correctionStrongPatterns: ["QUALIFY"] }, `
      const seen = [];
      registerExtension(pi, { importRuntime: async () => ({ default(runtimePi) {
        runtimePi.on("session_start", () => { seen.push("start"); });
        runtimePi.on("message_end", async (event) => { await Promise.resolve(); seen.push(event.message.content[0].text); });
        runtimePi.on("turn_end", () => { seen.push("turn"); });
      } }) });
      await emit("session_start");
      const first = emit("message_end", { message: { role: "user", content: [{ type: "text", text: "first" }] } });
      const trigger = emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY" }] } });
      const turn = emit("turn_end", { message: { role: "assistant", content: [] } });
      await Promise.all([first, trigger, turn]);
      console.log(JSON.stringify({ seen, runtimeLoads }));
    `);
    assert.deepEqual(result, { seen: ["start", "QUALIFY", "turn"], runtimeLoads: 0 });
  });

  it("invalidates an in-flight generation on shutdown and fences late completion", () => {
    const result = runModuleProbe({ correctionDetection: true, correctionStrongPatterns: ["QUALIFY"] }, `
      const seen = [];
      const importStarted = Promise.withResolvers();
      const release = Promise.withResolvers();
      registerExtension(pi, { importRuntime: async () => {
        importStarted.resolve();
        await release.promise;
        return { default(runtimePi) {
          seen.push("registered");
          runtimePi.on("session_start", () => { seen.push("start"); });
          runtimePi.on("message_end", () => { seen.push("message"); });
          runtimePi.on("session_shutdown", () => { seen.push("shutdown"); });
        }};
      }});
      await emit("session_start");
      const trigger = emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY" }] } });
      await importStarted.promise;
      await emit("session_shutdown", { reason: "quit" });
      await trigger;
      release.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      console.log(JSON.stringify({ seen }));
    `);
    assert.deepEqual(result.seen, []);
  });

  it("releases queued lifecycle objects without waiting for a stalled import", () => {
    const result = runModuleProbe({ correctionDetection: true, correctionStrongPatterns: ["QUALIFY"] }, `
      const importStarted = Promise.withResolvers();
      registerExtension(pi, { importRuntime: async () => {
        importStarted.resolve();
        await new Promise(() => {});
        throw new Error("unreachable");
      }});
      let eventRef, contextRef, startEventRef, startContextRef;
      let trigger;
      await (async () => {
        let startEvent = { marker: "old-start-event" };
        let startContext = { ...ctx, marker: "old-start-context" };
        let event = { message: { role: "user", content: [{ type: "text", text: "QUALIFY" }] } };
        let eventContext = { ...ctx, marker: "old-event-context" };
        startEventRef = new WeakRef(startEvent);
        startContextRef = new WeakRef(startContext);
        eventRef = new WeakRef(event);
        contextRef = new WeakRef(eventContext);
        await emit("session_start", startEvent, startContext);
        trigger = emit("message_end", event, eventContext);
        await importStarted.promise;
        startEvent = startContext = event = eventContext = null;
      })();
      await emit("session_shutdown", { reason: "quit" });
      await trigger;
      trigger = null;
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        global.gc();
        new Array(100_000).fill(0);
      }
      console.log(JSON.stringify({
        startEventCollected: !startEventRef.deref(),
        startContextCollected: !startContextRef.deref(),
        eventCollected: !eventRef.deref(),
        contextCollected: !contextRef.deref(),
      }));
    `);
    assert.deepEqual(result, {
      startEventCollected: true,
      startContextCollected: true,
      eventCollected: true,
      contextCollected: true,
    });
  });

  it("lets a replacement generation load independently and replay only its own events", () => {
    const result = runModuleProbe({ correctionDetection: true, correctionStrongPatterns: ["QUALIFY"] }, `
      const seen = [];
      const starts = [Promise.withResolvers(), Promise.withResolvers()];
      const releases = [Promise.withResolvers(), Promise.withResolvers()];
      let imports = 0;
      registerExtension(pi, { importRuntime: async () => {
        const attempt = imports++;
        starts[attempt].resolve();
        await releases[attempt].promise;
        return { default(runtimePi) {
          seen.push("registered-" + attempt);
          runtimePi.on("session_start", (_event, eventCtx) => { seen.push("start-" + eventCtx.marker); });
          runtimePi.on("message_end", (event) => { seen.push(event.message.content[0].text); });
          runtimePi.on("turn_end", () => { seen.push("turn-new"); });
        }};
      }});

      await emit("session_start", {}, { ...ctx, marker: "old" });
      const oldTrigger = emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY-old" }] } });
      await starts[0].promise;

      await emit("session_start", {}, { ...ctx, marker: "new" });
      await oldTrigger;
      const newTrigger = emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY-new" }] } });
      await starts[1].promise;
      const newFollowup = emit("turn_end", { message: { role: "assistant", content: [] } });
      releases[1].resolve();
      await Promise.all([newTrigger, newFollowup]);

      releases[0].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      console.log(JSON.stringify({ imports, seen }));
    `);
    assert.deepEqual(result, {
      imports: 2,
      seen: ["registered-1", "start-new", "QUALIFY-new", "turn-new"],
    });
  });

  it("appends events arriving during replay without reordering them", () => {
    const result = runModuleProbe({ correctionDetection: true, correctionStrongPatterns: ["QUALIFY"] }, `
      const seen = [];
      const replayStarted = Promise.withResolvers();
      const releaseReplay = Promise.withResolvers();
      let replayHeld = false;
      registerExtension(pi, { importRuntime: async () => ({ default(runtimePi) {
        runtimePi.on("session_start", () => { seen.push("start"); });
        runtimePi.on("message_end", async (event) => {
          const text = event.message.content?.[0]?.text ?? event.message.role;
          seen.push("begin-" + text);
          if (!replayHeld) { replayHeld = true; replayStarted.resolve(); await releaseReplay.promise; }
          seen.push("end-" + text);
        });
      } }) });
      await emit("session_start");
      const first = emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY" }] } });
      await replayStarted.promise;
      const trigger = emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY" }] } });
      const late = emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY" }] } });
      releaseReplay.resolve();
      await Promise.all([first, trigger, late]);
      console.log(JSON.stringify({ seen }));
    `);
    assert.deepEqual(result.seen, [
      "start", "begin-QUALIFY", "end-QUALIFY", "begin-QUALIFY", "end-QUALIFY", "begin-QUALIFY", "end-QUALIFY",
    ]);
  });

  it("isolates handler failures so shutdown reaches later cleanup handlers", () => {
    const result = runModuleProbe({ flushOnShutdown: true, flushMinTurns: 1, correctionDetection: true, correctionStrongPatterns: ["QUALIFY"] }, `
      const seen = [];
      registerExtension(pi, { importRuntime: async () => ({ default(runtimePi) {
        runtimePi.on("session_start", () => { seen.push("start"); });
        runtimePi.on("message_end", () => { seen.push("message"); });
        runtimePi.on("session_shutdown", () => { seen.push("flush"); throw new Error("flush failed"); });
        runtimePi.on("session_shutdown", () => { seen.push("final-index"); });
        runtimePi.on("session_shutdown", () => { seen.push("database-close"); });
      } }) });
      await emit("session_start");
      await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY" }] } });
      await emit("session_shutdown", { reason: "quit" });
      console.log(JSON.stringify({ seen }));
    `);
    assert.deepEqual(result.seen, ["start", "message", "flush", "final-index", "database-close"]);
  });

  it("cleans a failed session_start candidate before retrying its queued events", () => {
    const result = runModuleProbe({ correctionDetection: true, correctionStrongPatterns: ["QUALIFY"] }, `
      const seen = [];
      let attempts = 0;
      registerExtension(pi, { importRuntime: async () => ({ default(runtimePi) {
        const attempt = ++attempts;
        runtimePi.on("session_start", () => {
          seen.push("start-" + attempt);
          if (attempt === 1) throw new Error("startup failed");
        });
        runtimePi.on("message_end", (event) => { seen.push("message-" + attempt + ":" + event.message.content[0].text); });
        runtimePi.on("session_shutdown", () => { seen.push("cleanup-" + attempt); throw new Error("cleanup failed"); });
        runtimePi.on("session_shutdown", () => { seen.push("close-" + attempt); });
      } }) });
      await emit("session_start");
      try {
        await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "QUALIFY" }] } });
      } catch {}
      await emit("turn_end", { message: { role: "assistant", content: [] } });
      console.log(JSON.stringify({ attempts, seen }));
    `);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.seen, [
      "start-1", "cleanup-1", "close-1", "start-2", "message-2:QUALIFY",
    ]);
  });
});
