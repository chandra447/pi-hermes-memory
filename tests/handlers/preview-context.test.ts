import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPreviewContextCommand } from "../../src/handlers/preview-context.js";
import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "../../src/constants.js";

describe("registerPreviewContextCommand", () => {
  function setup(opts: {
    memoryBlock?: string;
    projectBlock?: string;
    skillIndex?: string;
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

    const skillStore = {
      formatIndexForSystemPrompt: async () => opts.skillIndex ?? "",
    } as any;

    registerPreviewContextCommand(
      mockPi,
      store,
      projectStore,
      skillStore,
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
      skillIndex: "<memory-context>SKILLS</memory-context>",
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
      skillIndex: "<memory-context>SKILLS</memory-context>",
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
    assert.match(out, /SKILL INDEX/);
    assert.match(out, /Blocks shown: 3/);
  });

  it("shows empty-state guidance when no blocks exist", async () => {
    const { handler, ctx, notifyCalls } = setup({
      memoryBlock: "",
      projectBlock: "",
      skillIndex: "",
      withProjectStore: false,
      memoryMode: "legacy-inject",
    });

    await handler({}, ctx);
    const out = notifyCalls[0].message;
    assert.match(out, /No memory context blocks are currently injected/);
    assert.match(out, /Blocks shown: 0/);
  });
});
