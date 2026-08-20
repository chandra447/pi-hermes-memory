import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { registerPreviewContextCommand } from "../../src/handlers/preview-context.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT, DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";

describe("registerPreviewContextCommand", () => {
  function setup(opts: {
    memoryBlock?: string;
    projectBlock?: string;
    projectName?: string;
    withProjectStore?: boolean;
    memoryMode?: "policy-only" | "legacy-inject";
    memoryPolicyStyle?: "full" | "compact" | "custom" | "none";
    memoryPolicyCustomText?: string;
  }) {
    const commands: { name: string; handler: Function }[] = [];
    const notifyCalls: { message: string; severity: string }[] = [];

    const mockPi = {
      registerCommand: (name: string, conf: any) => {
        commands.push({ name, handler: conf.handler });
      },
    } as any;

    const store = {
      formatForSystemPrompt: () => opts.memoryBlock ?? "",
    } as any;

    const projectStore = opts.withProjectStore
      ? ({ formatProjectBlock: () => opts.projectBlock ?? "" } as any)
      : null;

    registerPreviewContextCommand(
      mockPi,
      store,
      projectStore,
      opts.projectName ?? "demo-project",
      {
        memoryMode: opts.memoryMode ?? "policy-only",
        memoryPolicyStyle: opts.memoryPolicyStyle,
        memoryPolicyCustomText: opts.memoryPolicyCustomText,
      },
    );

    return {
      handler: commands[0].handler,
      notifyCalls,
      ctx: {
        ui: {
          notify: (message: string, severity: string) => {
            notifyCalls.push({ message, severity });
          },
        },
      },
    };
  }

  it("registers /memory-preview-context", () => {
    const { handler } = setup({});
    assert.ok(typeof handler === "function");
  });

  it("shows policy-only context by default", async () => {
    const { handler, ctx, notifyCalls } = setup({
      memoryBlock: "<memory-context>MEM</memory-context>",
      projectBlock: "<memory-context>PROJECT</memory-context>",
      withProjectStore: true,
    });

    await handler({}, ctx);
    assert.strictEqual(notifyCalls.length, 1);
    const out = notifyCalls[0].message;
    assert.match(out, /Mode: policy-only/);
    assert.match(out, /Policy style: full/);
    assert.match(out, /Full Markdown memories are NOT injected/);
    assert.match(out, /memory_search/);
    assert.match(out, /target="failure"/);
    assert.ok(out.includes(MEMORY_POLICY_PROMPT));
    assert.match(out, /Blocks shown: 1/);
  });

  it("shows compact policy context when configured", async () => {
    const { handler, ctx, notifyCalls } = setup({
      memoryPolicyStyle: "compact",
    });

    await handler({}, ctx);
    const out = notifyCalls[0].message;
    assert.match(out, /Policy style: compact/);
    assert.ok(out.includes(MEMORY_POLICY_PROMPT_COMPACT));
    assert.match(out, /Blocks shown: 1/);
  });

  it("shows custom policy context when configured", async () => {
    const customText = "<memory-policy>Custom preview policy.</memory-policy>";
    const { handler, ctx, notifyCalls } = setup({
      memoryPolicyStyle: "custom",
      memoryPolicyCustomText: customText,
    });

    await handler({}, ctx);
    const out = notifyCalls[0].message;
    assert.match(out, /Policy style: custom/);
    assert.ok(out.includes(customText));
    assert.match(out, /Blocks shown: 1/);
  });

  it("shows no injected policy context when policy style is none", async () => {
    const { handler, ctx, notifyCalls } = setup({
      memoryPolicyStyle: "none",
    });

    await handler({}, ctx);
    const out = notifyCalls[0].message;
    assert.match(out, /Policy style: none/);
    assert.match(out, /No memory policy context is injected/);
    assert.doesNotMatch(out, /<memory-policy>/);
    assert.match(out, /Blocks shown: 0/);
  });

  it("shows all available blocks in legacy mode", async () => {
    const { handler, ctx, notifyCalls } = setup({
      memoryBlock: "<memory-context>MEM</memory-context>",
      projectBlock: "<memory-context>PROJECT</memory-context>",
      withProjectStore: true,
      projectName: "pi-hermes-memory",
      memoryMode: "legacy-inject",
    });

    await handler({}, ctx);
    assert.strictEqual(notifyCalls.length, 1);
    const out = notifyCalls[0].message;
    assert.match(out, /Injected Context Preview/);
    assert.match(out, /MEMORY \+ USER \+ RECENT FAILURES/);
    assert.match(out, /PROJECT MEMORY \(pi-hermes-memory\)/);
    assert.match(out, /Blocks shown: 2/);
  });

  it("shows empty-state guidance when no blocks exist", async () => {
    const { handler, ctx, notifyCalls } = setup({
      memoryBlock: "",
      projectBlock: "",
      withProjectStore: false,
      memoryMode: "legacy-inject",
    });

    await handler({}, ctx);
    const out = notifyCalls[0].message;
    assert.match(out, /No memory context blocks are currently injected/);
    assert.match(out, /Blocks shown: 0/);
  });

  it("reflects mid-session memory additions, replacements, and removals in legacy preview", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-preview-test-"));
    try {
      const store = new MemoryStore({
        memoryMode: "legacy-inject",
        memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
        userCharLimit: DEFAULT_USER_CHAR_LIMIT,
        projectCharLimit: 5000,
        nudgeInterval: 10,
        reviewEnabled: false,
        flushOnCompact: false,
        flushOnShutdown: false,
        flushMinTurns: 6,
        autoConsolidate: false,
        correctionDetection: false,
        failureInjectionEnabled: true,
        failureInjectionMaxAgeDays: 7,
        failureInjectionMaxEntries: 5,
        nudgeToolCalls: 15,
        memoryDir: tempDir,
      });
      await store.loadFromDisk();

      const commands: { name: string; handler: Function }[] = [];
      const notifyCalls: { message: string; severity: string }[] = [];
      const mockPi = {
        registerCommand: (name: string, conf: any) => {
          commands.push({ name, handler: conf.handler });
        },
      } as any;
      const ctx = {
        ui: {
          notify: (message: string, severity: string) => {
            notifyCalls.push({ message, severity });
          },
        },
      };

      registerPreviewContextCommand(mockPi, store, null, "test-proj", {
        memoryMode: "legacy-inject",
      });
      const handler = commands[0].handler;

      // 1. Initial state (empty)
      await handler({}, ctx);
      assert.strictEqual(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /No memory context blocks are currently injected/);

      // 2. Add entry mid-session
      await store.add("memory", "mid-session fact alpha");
      notifyCalls.length = 0;
      await handler({}, ctx);
      assert.strictEqual(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /mid-session fact alpha/);
      assert.match(notifyCalls[0].message, /Blocks shown: 1/);

      // 3. Replace entry mid-session
      await store.replace("memory", "mid-session fact alpha", "mid-session fact beta");
      notifyCalls.length = 0;
      await handler({}, ctx);
      assert.strictEqual(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /mid-session fact beta/);
      assert.doesNotMatch(notifyCalls[0].message, /mid-session fact alpha/);
      assert.match(notifyCalls[0].message, /Blocks shown: 1/);

      // 4. Remove entry mid-session
      await store.remove("memory", "mid-session fact beta");
      notifyCalls.length = 0;
      await handler({}, ctx);
      assert.strictEqual(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /No memory context blocks are currently injected/);
      assert.match(notifyCalls[0].message, /Blocks shown: 0/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reflects mid-session user and failure updates in legacy preview", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-preview-test-"));
    try {
      const store = new MemoryStore({
        memoryMode: "legacy-inject",
        memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
        userCharLimit: DEFAULT_USER_CHAR_LIMIT,
        projectCharLimit: 5000,
        nudgeInterval: 10,
        reviewEnabled: false,
        flushOnCompact: false,
        flushOnShutdown: false,
        flushMinTurns: 6,
        autoConsolidate: false,
        correctionDetection: false,
        failureInjectionEnabled: true,
        failureInjectionMaxAgeDays: 7,
        failureInjectionMaxEntries: 5,
        nudgeToolCalls: 15,
        memoryDir: tempDir,
      });
      await store.loadFromDisk();

      const commands: { name: string; handler: Function }[] = [];
      const notifyCalls: { message: string; severity: string }[] = [];
      const mockPi = {
        registerCommand: (name: string, conf: any) => {
          commands.push({ name, handler: conf.handler });
        },
      } as any;
      const ctx = {
        ui: {
          notify: (message: string, severity: string) => {
            notifyCalls.push({ message, severity });
          },
        },
      };

      registerPreviewContextCommand(mockPi, store, null, "test-proj", {
        memoryMode: "legacy-inject",
      });
      const handler = commands[0].handler;

      await store.add("user", "user prefers typescript");
      await store.addFailure("build failed due to missing dep", { category: "tool-quirk" });

      await handler({}, ctx);
      assert.strictEqual(notifyCalls.length, 1);
      const out = notifyCalls[0].message;
      assert.match(out, /USER PROFILE/);
      assert.match(out, /user prefers typescript/);
      assert.match(out, /RECENT FAILURES & LESSONS/);
      assert.match(out, /build failed due to missing dep/);
      assert.match(out, /Blocks shown: 1/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
