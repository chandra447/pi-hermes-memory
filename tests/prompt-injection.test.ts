/**
 * `before_agent_start` prompt injection (#251).
 *
 * pi 0.86+ passes a normalized *clone* of the prompt options and re-renders the
 * prompt from it, so appending the memory context through `appendSystemPrompt`
 * keeps the prompt a set of named sections for later handlers and section-aware
 * providers; returning `systemPrompt` forces the rendered text instead.
 *
 * 0.80.6-0.85.x put `systemPromptOptions` on the event too, but they pass the raw
 * long-lived base options and only apply a returned `systemPrompt` — a mutation
 * there reaches no prompt and leaks into `ctx.getSystemPromptOptions()`. The two
 * shapes below are the ones `agent-session.js` actually builds on each side of
 * that boundary, so the branch is tested against the real inputs rather than a
 * hand-built `{}` that no SDK version produces.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Bind the entry point to a disposable agent root, never the user's memory.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-prompt-injection-"));
const previousRoot = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { default: registerExtension } = await import("../src/index.js");
const globalDir = path.join(root, "pi-hermes-memory");
const cwd = path.join(root, "workspace");

/** Options as 0.86+ normalizes them: `sections` and `forceSystemPrompt` always present. */
function structuredOptions(overrides: Record<string, unknown> = {}) {
  return {
    customPrompt: undefined,
    forceSystemPrompt: undefined,
    selectedTools: ["read"],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    cwd,
    contextFiles: [],
    skills: [],
    ...overrides,
  };
}

/** Options as 0.80.x-0.85.x build them: the raw base object, no `sections`. */
function legacyOptions(overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    skills: [],
    contextFiles: [],
    customPrompt: undefined,
    appendSystemPrompt: "",
    selectedTools: ["read"],
    toolSnippets: {},
    promptGuidelines: [],
    ...overrides,
  };
}

let handlers: Record<string, Array<(event: any, ctx: any) => any>>;
let ctx: any;

async function configure(overrides: Record<string, unknown> = {}) {
  await fs.writeFile(path.join(root, "hermes-memory-config.json"), JSON.stringify({
    memoryMode: "policy-only",
    memoryPolicyStyle: "full",
    lazyInitialization: true,
    reviewEnabled: false,
    correctionDetection: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    ...overrides,
  }));
}

function register() {
  registerExtension({
    on(event: string, handler: any) { (handlers[event] ??= []).push(handler); },
    registerTool() {},
    registerCommand() {},
  } as any);
}

async function emit(event: string, data: any = {}) {
  let result: any;
  for (const handler of handlers[event] ?? []) result = (await handler(data, ctx)) ?? result;
  return result;
}

async function registerWith(overrides: Record<string, unknown> = {}) {
  handlers = {};
  await configure(overrides);
  register();
  await emit("session_start");
}

beforeEach(async () => {
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    ui: { notify: () => {} },
  };
});

after(async () => {
  if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousRoot;
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch {
    // Windows may keep the directory busy briefly; the temp dir is disposable.
  }
});

describe("before_agent_start prompt injection", () => {
  it("appends through structured prompt options instead of forcing the prompt", async () => {
    await registerWith();
    const event = { systemPrompt: "base prompt", systemPromptOptions: structuredOptions() };

    const result = await emit("before_agent_start", event);

    assert.equal(result, undefined, "structured events must not force a full prompt replacement");
    assert.match(event.systemPromptOptions.appendSystemPrompt, /memory-policy/);
  });

  it("appends after an earlier handler's appendSystemPrompt", async () => {
    await registerWith();
    const event = {
      systemPrompt: "base prompt",
      systemPromptOptions: structuredOptions({ appendSystemPrompt: "earlier handler text" }),
    };

    await emit("before_agent_start", event);

    const appended = event.systemPromptOptions.appendSystemPrompt;
    assert.match(appended, /earlier handler text/);
    assert.match(appended, /memory-policy/);
    assert.ok(
      appended.indexOf("earlier handler text") < appended.indexOf("memory-policy"),
      "the policy goes after earlier contributions",
    );
  });

  it("reaches the 0.80.x session through the returned prompt, not the options object", async () => {
    await registerWith();
    const options = legacyOptions();
    const event = { systemPrompt: "base prompt", systemPromptOptions: options };

    const result = await emit("before_agent_start", event);

    // 0.80.x-0.85.x apply `result.systemPrompt` or reset to the base prompt
    // (agent-session.js); the options object is never rendered, and it is the one
    // `ctx.getSystemPromptOptions()` hands to other extensions.
    const applied = result?.systemPrompt ?? event.systemPrompt;
    assert.match(applied, /memory-policy/, "the policy must reach a prompt the session applies");
    assert.equal(options.appendSystemPrompt, "", "a legacy event must not accumulate into the exposed options");
  });

  it("keeps the replacement path when the event carries no options at all", async () => {
    await registerWith();
    const result = await emit("before_agent_start", { systemPrompt: "base prompt" });

    assert.match(result.systemPrompt, /base prompt/);
    assert.match(result.systemPrompt, /memory-policy/);
  });

  it("leaves the options untouched when there is no context to inject", async () => {
    await registerWith({ memoryPolicyStyle: "none" });
    const options = structuredOptions();
    const snapshot = structuredClone(options);
    const event = { systemPrompt: "base prompt", systemPromptOptions: options };

    const result = await emit("before_agent_start", event);

    assert.equal(result, undefined);
    assert.deepEqual(event.systemPromptOptions, snapshot);
  });
});
