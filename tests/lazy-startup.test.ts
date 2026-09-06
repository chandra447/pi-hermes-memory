import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, afterEach, describe, it } from "node:test";

// Bind the entry point to a disposable agent root, never the user's memory.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-startup-"));
const previousRoot = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { default: registerExtension } = await import("../src/index.js");
const { MemoryStore } = await import("../src/store/memory-store.js");
const { DatabaseManager } = await import("../src/store/db.js");
const globalDir = path.join(root, "pi-hermes-memory");
const cwd = path.join(root, "workspace");
const projectDir = path.join(root, "projects-memory", "workspace");
let handlers: Record<string, Array<(event: any, ctx: any) => any>>;
let tools: Record<string, any>;
let commands: Record<string, any>;
let notifications: string[];
let ctx: any;

async function configure(overrides: Record<string, unknown> = {}) {
  await fs.writeFile(path.join(root, "hermes-memory-config.json"), JSON.stringify({
    lazyInitialization: true,
    reviewEnabled: false, correctionDetection: false,
    flushOnCompact: false, flushOnShutdown: false,
    ...overrides,
  }));
}

function register() {
  registerExtension({
    on(event: string, handler: any) { (handlers[event] ??= []).push(handler); },
    registerTool(tool: any) { tools[tool.name] = tool; },
    registerCommand(name: string, options: any) { commands[name] = options; },
  } as any);
}

async function emit(event: string, data: any = {}) {
  let result: any;
  for (const handler of handlers[event] ?? []) result = (await handler(data, ctx)) ?? result;
  return result;
}

async function search(query = "durable") {
  return tools.memory_search.execute("search", { query }, undefined, undefined, ctx);
}

async function writeSession() {
  const dir = path.join(root, "sessions", "workspace");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "history.jsonl");
  const timestamp = new Date().toISOString();
  await fs.writeFile(file, [
    { type: "session", id: "history", timestamp, cwd },
    { type: "message", id: "m1", parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: "historical deployment decision" }], timestamp: Date.now() } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  return file;
}

beforeEach(async () => {
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(globalDir, "MEMORY.md"), "durable global fact");
  await fs.writeFile(path.join(projectDir, "MEMORY.md"), "durable project fact");
  await fs.writeFile(path.join(globalDir, "STANDING.md"), "- Always ask before deployment.\n");
  await configure();
  handlers = {}; tools = {}; commands = {}; notifications = [];
  ctx = {
    cwd, hasUI: true,
    sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    ui: { notify: (text: string) => notifications.push(text) },
  };
});

afterEach(async () => {
  await emit("session_shutdown", { reason: "quit" });
  for (const name of await fs.readdir(root)) await fs.rm(path.join(root, name), { recursive: true, force: true });
});

after(async () => {
  if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

describe("lazy startup lifecycle", () => {
  it("keeps generic conversation, skills, preview and cold shutdown free of memory/DB loading", async (t) => {
    const loads = t.mock.method(MemoryStore.prototype, "loadFromDisk");
    const opens = t.mock.method(DatabaseManager.prototype, "getDb");
    register();
    await emit("session_start");
    const resources = await emit("resources_discover", { cwd, reason: "startup" });
    assert.deepEqual(resources.skillPaths, [path.join(globalDir, "skills"), path.join(projectDir, "skills")]);
    const prompt = await emit("before_agent_start", { systemPrompt: "base" });
    assert.match(prompt.systemPrompt, /Always ask before deployment/);
    assert.match(prompt.systemPrompt, /memory-policy/);
    assert.doesNotMatch(prompt.systemPrompt, /durable global fact/);
    await emit("message_end", { message: { role: "user", content: "hello" } });
    await emit("turn_end", { message: { role: "assistant", content: [] } });
    await commands["memory-preview-context"].handler("", ctx);
    await commands["memory-switch-project"].handler("", ctx);
    assert.ok(notifications.some((text) => text.includes("workspace (1 entry)")));
    await emit("session_shutdown", { reason: "quit" });
    assert.equal(loads.mock.callCount(), 0);
    assert.equal(opens.mock.callCount(), 0);
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });

  it("loads and synchronizes once for concurrent first search and write", async (t) => {
    const loads = t.mock.method(MemoryStore.prototype, "loadFromDisk");
    register();
    await emit("session_start");
    const results = await Promise.all([
      search(), search(),
      tools.memory_add.execute("write", { target: "project", content: "new durable project fact" }, undefined, undefined, ctx),
    ]);
    assert.equal(results[0].details.count, 2);
    assert.equal(results[2].details.success, true);
    assert.equal(loads.mock.callCount(), 2, "one global and one project load");
    assert.equal((await search()).details.count, 3);
    assert.equal(loads.mock.callCount(), 2);
    assert.match(await fs.readFile(path.join(projectDir, "MEMORY.md"), "utf8"), /durable project fact/);
  });

  it("initializes from a command without a prior model turn", async () => {
    register();
    await emit("session_start");
    await commands["memory-insights"].handler("", ctx);
    assert.ok(notifications.some((text) => text.includes("durable global fact")));
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), true);
  });

  it("backfills JSONL history before the first SQLite session search returns", async () => {
    const file = await writeSession();
    ctx.sessionManager.getSessionFile = () => file;
    register();
    await emit("session_start");
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
    const result = await tools.session_search.execute("id", { query: "historical" }, undefined, undefined, ctx);
    assert.equal(result.details.count, 1);
    assert.match(result.content[0].text, /historical deployment decision/);
  });

  it("leaves an unused resumed session in JSONL without opening SQLite on exit", async () => {
    const file = await writeSession();
    ctx.sessionManager.getSessionFile = () => file;
    register();
    await emit("session_start");
    await emit("session_shutdown", { reason: "quit" });
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
    assert.match(await fs.readFile(file, "utf8"), /historical deployment decision/);
  });

  it("keeps anchor-only session search independent of the memory database", async () => {
    await configure({ sessionSearch: { variant: "anchors" } });
    await writeSession();
    register();
    await emit("session_start");
    const result = await tools.session_search.execute("id", { markdown: "all:\n- historical" }, undefined, undefined, ctx);
    assert.equal(result.details.count, 1);
    assert.equal(existsSync(path.join(globalDir, "sessions.db")), false);
  });

  it("supports a custom memory directory without waiting for a nonexistent migration", async () => {
    const custom = path.join(root, "custom", "store");
    await fs.mkdir(custom, { recursive: true });
    await fs.writeFile(path.join(custom, "MEMORY.md"), "custom durable fact");
    await configure({ memoryDir: custom });
    register();
    await emit("session_start");
    assert.equal(existsSync(path.join(custom, "sessions.db")), false);
    assert.equal((await search("custom")).details.count, 1);
    assert.equal(existsSync(path.join(custom, "sessions.db")), true);
  });

  it("retries a failed first load before allowing search", async (t) => {
    const original = MemoryStore.prototype.loadFromDisk;
    let fail = true;
    t.mock.method(MemoryStore.prototype, "loadFromDisk", async function (this: InstanceType<typeof MemoryStore>) {
      if (fail) { fail = false; throw new Error("transient read failure"); }
      return original.call(this);
    });
    register();
    await emit("session_start");
    await assert.rejects(search(), /transient read failure/);
    assert.equal((await search()).details.count, 2);
  });

  it("clears a rejected project load before switching to a non-project cwd or retrying", async (t) => {
    const original = MemoryStore.prototype.loadFromDisk;
    let loads = 0;
    t.mock.method(MemoryStore.prototype, "loadFromDisk", async function (this: InstanceType<typeof MemoryStore>) {
      if (++loads === 2) throw new Error("project load failed");
      return original.call(this);
    });
    register();
    await emit("session_start");
    await assert.rejects(search(), /project load failed/);
    ctx.cwd = os.homedir();
    assert.equal((await search()).details.count, 2);
    const unavailable = await tools.memory_add.execute("write", { target: "project", content: "not a project" }, undefined, undefined, ctx);
    assert.equal(unavailable.details.success, false);
    ctx.cwd = cwd;
    assert.equal((await search()).details.count, 2);
    assert.equal(loads, 3);
  });

  it("does not close or reopen SQLite beneath a first-use project bind", async (t) => {
    const originalLoad = MemoryStore.prototype.loadFromDisk;
    const binding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let loads = 0;
    t.mock.method(MemoryStore.prototype, "loadFromDisk", async function (this: InstanceType<typeof MemoryStore>) {
      if (++loads === 2) { binding.resolve(); await release.promise; }
      return originalLoad.call(this);
    });
    const getDb = t.mock.method(DatabaseManager.prototype, "getDb");
    const close = t.mock.method(DatabaseManager.prototype, "close");
    register();
    await emit("session_start");
    const first = search();
    await binding.promise;
    const rejected = assert.rejects(first, /shut down/);
    let shutDown = false;
    const shutdown = emit("session_shutdown", { reason: "quit" }).then(() => { shutDown = true; });
    try {
      await new Promise(setImmediate);
      assert.equal(shutDown, false);
      assert.equal(close.mock.callCount(), 0);
    } finally {
      release.resolve();
      await Promise.all([rejected, shutdown]);
    }
    const manager = getDb.mock.calls[0].this;
    assert.throws(() => manager.getDb(), /shut down/);
    assert.equal(close.mock.callCount(), 1);
  });

  it("waits for the full scheduled batch across forty multi-message history files", async (t) => {
    const dir = path.join(root, "sessions", "workspace");
    await fs.mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    for (let fileIndex = 0; fileIndex < 40; fileIndex++) {
      const id = `history-${fileIndex}`;
      const entries = [
        { type: "session", id, timestamp, cwd },
        ...Array.from({ length: 25 }, (_, i) => ({
          type: "message", id: `${id}-m${i}`, parentId: i ? `${id}-m${i - 1}` : null, timestamp,
          message: { role: "user", content: [{ type: "text", text: `historical decision ${fileIndex} ${i}` }], timestamp: Date.now() },
        })),
      ];
      await fs.writeFile(path.join(dir, `${id}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n"));
    }
    const getDb = t.mock.method(DatabaseManager.prototype, "getDb");
    register();
    await emit("session_start");
    await tools.session_search.execute("id", { query: "historical" }, undefined, undefined, ctx);
    const stats = getDb.mock.calls[0].this.getStats();
    assert.equal(stats.sessions, 40);
    assert.equal(stats.messages, 1000);
  });

  for (const overrides of [{ lazyInitialization: false }, { memoryMode: "legacy-inject" }]) {
    it(`preserves eager loading with ${JSON.stringify(overrides)}`, async (t) => {
      await configure(overrides);
      const loads = t.mock.method(MemoryStore.prototype, "loadFromDisk");
      register();
      await emit("session_start");
      assert.equal(loads.mock.callCount(), 2);
      assert.equal(existsSync(path.join(globalDir, "sessions.db")), true);
      if (overrides.memoryMode === "legacy-inject") {
        const before = await emit("before_agent_start", { systemPrompt: "base" });
        assert.match(before.systemPrompt, /durable global fact/);
        await tools.memory_add.execute("id", { target: "memory", content: "late addition" }, undefined, undefined, ctx);
        const after = await emit("before_agent_start", { systemPrompt: "base" });
        assert.equal(after.systemPrompt, before.systemPrompt);
      }
    });
  }

  it("migrates legacy memory on first use, not startup", async () => {
    const legacy = path.join(root, "memory");
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "USER.md"), "legacy durable preference");
    register();
    await emit("session_start");
    assert.equal(existsSync(path.join(globalDir, "USER.md")), false);
    assert.equal((await search("legacy")).details.count, 1);
    assert.match(await fs.readFile(path.join(globalDir, "USER.md"), "utf8"), /legacy durable preference/);
  });

  it("keeps legacy pins and skill discovery available even when memory initialization fails", async (t) => {
    const legacy = path.join(root, "memory");
    await fs.mkdir(legacy);
    await fs.rename(path.join(globalDir, "STANDING.md"), path.join(legacy, "STANDING.md"));
    const getDb = t.mock.method(DatabaseManager.prototype, "getDb", () => { throw new Error("database unavailable"); });
    register();
    await emit("session_start");
    const resources = await emit("resources_discover", { cwd, reason: "startup" });
    assert.equal(resources.skillPaths.length, 2);
    assert.equal(getDb.mock.callCount(), 0);
    const prompt = await emit("before_agent_start", { systemPrompt: "base" });
    assert.match(prompt.systemPrompt, /Always ask before deployment/);
    await assert.rejects(search(), /database unavailable/);
    const afterFailure = await emit("before_agent_start", { systemPrompt: "base" });
    assert.match(afterFailure.systemPrompt, /Always ask before deployment/);
  });
});
