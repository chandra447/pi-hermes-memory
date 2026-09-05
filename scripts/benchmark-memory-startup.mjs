// Run from a development checkout: node --import tsx scripts/benchmark-memory-startup.mjs [--lazy] [entry.ts]
// Measures the extension lifecycle, not Pi's TUI. No model calls or user data.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const lazy = process.argv.includes("--lazy");
const entry = process.argv.slice(2).find((arg) => arg !== "--lazy")
  ?? join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
const root = await mkdtemp(join(tmpdir(), "pi-memory-startup-bench-"));
const globalDir = join(root, "pi-hermes-memory");
const handlers = new Map();
const tools = new Map();
const ctx = {
  cwd: join(root, "workspace"), hasUI: false,
  sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
  ui: { notify() {} },
};
const emit = async (event, data = {}) => {
  for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
};

try {
  process.env.PI_CODING_AGENT_DIR = root;
  await mkdir(globalDir);
  await mkdir(ctx.cwd);
  await writeFile(join(root, "hermes-memory-config.json"), JSON.stringify({
    lazyInitialization: lazy, memoryMode: "policy-only",
    reviewEnabled: false, correctionDetection: false,
    flushOnShutdown: false, flushOnCompact: false,
  }));
  await writeFile(join(globalDir, "MEMORY.md"), "durable global preference");
  for (let i = 0; i < 20; i++) {
    const dir = join(root, "projects-memory", `project-${i}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "MEMORY.md"), `durable project ${i} convention`);
  }

  const started = performance.now();
  const { default: register } = await import(pathToFileURL(resolve(entry)).href);
  const imported = performance.now();
  register({
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
  });
  const registered = performance.now();
  await emit("session_start");
  await emit("resources_discover", { cwd: ctx.cwd, reason: "startup" });
  const ready = performance.now();
  const databaseAtStartup = existsSync(join(globalDir, "sessions.db"));
  const search = await tools.get("memory_search").execute("bench", { query: "durable" }, undefined, undefined, ctx);
  const searched = performance.now();
  if (!search.details.success || search.details.count === 0) throw new Error("First-use search failed");
  console.log(JSON.stringify({
    lazy, entry: resolve(entry),
    importMs: Math.round(imported - started),
    registrationMs: Math.round(registered - imported),
    sessionStartMs: Math.round(ready - registered),
    totalStartupMs: Math.round(ready - started),
    firstSearchMs: Math.round(searched - ready),
    databaseAtStartup,
  }));
} finally {
  await emit("session_shutdown", { reason: "quit" });
  await rm(root, { recursive: true, force: true });
}
