import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptContext, resolveMemoryPolicyPrompt } from "../../src/prompt-context.js";
import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT, MEMORY_WRITE_TOOL_NAMES } from "../../src/constants.js";

describe("buildPromptContext", () => {
  const store = {
    formatForSystemPrompt: () => "<memory-context>MEMORY</memory-context>",
  } as any;

  const projectStore = {
    formatProjectBlock: (projectName: string) => `<memory-context>PROJECT ${projectName}</memory-context>`,
  } as any;

  it("returns policy only in policy-only mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT);
    assert.match(result, /memory_search/);
    assert.match(result, /Accepted memory categories/);
    assert.match(result, /category filters categorized failure\/lesson memories only/);
    assert.match(result, /Use category only for categorized failure\/lesson searches/);
    assert.match(result, /session_search: search indexed past conversation messages/);
    assert.match(result, /skill_manage: list, view, create, patch, update, and delete procedural skills/);
    assert.match(result, /Always pass scope explicitly on create/);
    assert.match(result, /Do not create skills for one-off task state/);
    assert.doesNotMatch(result, /category="preference"/);
    assert.doesNotMatch(result, /inspect, and update procedural skills/);
    assert.doesNotMatch(result, /memory_search: search relevant user, project, session, failure, and skill memories/);
    assert.doesNotMatch(result, /MEMORY<\/memory-context>/);
    assert.doesNotMatch(result, /PROJECT demo/);
    assert.doesNotMatch(result, /SKILLS/);
  });

  it("returns the full policy prompt when policy style is full", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "full" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT);
  });

  it("returns the compact policy prompt when policy style is compact", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "compact" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT_COMPACT);
    assert.match(result, /category filters categorized failure\/lesson memories only/);
    assert.match(result, /scope is required: global for transferable workflows, project for repo-specific ones/);
    assert.match(result, /Do not use memory_search for generic questions/);
    assert.doesNotMatch(result, /MEMORY<\/memory-context>/);
    assert.doesNotMatch(result, /PROJECT demo/);
    assert.doesNotMatch(result, /SKILLS/);
  });

  it("returns custom policy text when policy style is custom", async () => {
    const customText = "<memory-policy>Use local custom policy.</memory-policy>";
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "custom", memoryPolicyCustomText: customText },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, customText);
  });

  it("falls back to compact policy when custom policy text is blank", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "custom", memoryPolicyCustomText: "  \n\t  " },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT_COMPACT);
  });

  it("returns empty context when policy style is none", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "none" },
      store,
      projectStore,
      "demo",
    );

    assert.strictEqual(result, "");
  });

  it("returns legacy memory blocks in legacy-inject mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject", memoryPolicyStyle: "compact" },
      store,
      projectStore,
      "demo",
    );

    assert.match(result, /MEMORY/);
    assert.match(result, /PROJECT demo/);
    assert.doesNotMatch(result, /<memory-policy>/);
  });

  const standing = {
    formatForSystemPrompt: () => "<standing-instructions>\n1. never run find /\n</standing-instructions>",
  } as any;

  it("appends standing instructions after the policy in policy-only mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only" },
      store,
      projectStore,
      "demo",
      standing,
    );

    assert.ok(result.startsWith(MEMORY_POLICY_PROMPT), "the policy still leads");
    assert.match(result, /<standing-instructions>/);
    assert.match(result, /never run find \//);
    assert.doesNotMatch(result, /MEMORY<\/memory-context>/, "stored memories stay out of policy-only");
  });

  it("injects standing instructions even when the policy style is none", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only", memoryPolicyStyle: "none" },
      store,
      projectStore,
      "demo",
      standing,
    );

    assert.strictEqual(result, "<standing-instructions>\n1. never run find /\n</standing-instructions>");
  });

  it("puts standing instructions last in legacy-inject mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      store,
      projectStore,
      "demo",
      standing,
    );

    assert.ok(
      result.indexOf("<standing-instructions>") > result.indexOf("PROJECT demo"),
      "user directives read last, closest to the task",
    );
  });

  it("injects nothing extra when no standing store is wired", async () => {
    const result = await buildPromptContext({ memoryMode: "policy-only" }, store, projectStore, "demo");

    assert.strictEqual(result, MEMORY_POLICY_PROMPT);
  });

  it("omits the memory policy for child sessions and keeps standing instructions", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only" },
      store,
      projectStore,
      "demo",
      standing,
      true,
    );

    assert.strictEqual(result, "<standing-instructions>\n1. never run find /\n</standing-instructions>");
    assert.doesNotMatch(result, /memory_search/);
  });

  it("skips custom policy text for child sessions", async () => {
    const result = await buildPromptContext(
      {
        memoryMode: "policy-only",
        memoryPolicyStyle: "custom",
        memoryPolicyCustomText: "<memory-policy>Use local custom policy.</memory-policy>",
      },
      store,
      projectStore,
      "demo",
      null,
      true,
    );

    assert.strictEqual(result, "");
  });

  it("keeps legacy-inject output unchanged for child sessions", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      store,
      projectStore,
      "demo",
      null,
      true,
    );

    assert.strictEqual(result, "<memory-context>MEMORY</memory-context>\n\n<memory-context>PROJECT demo</memory-context>");
  });
});

describe("skillsEnabled in the memory policy", () => {
  it("drops the skill guidance from both built-in policies when skills are disabled", () => {
    for (const memoryPolicyStyle of ["full", "compact"] as const) {
      const prompt = resolveMemoryPolicyPrompt({ memoryPolicyStyle, skillsEnabled: false });
      assert.doesNotMatch(prompt, /skill/i);
      assert.match(prompt, /- memory_search:/);
      assert.match(prompt, /<\/available-memory-tools>$/);
    }
  });

  it("keeps the built-in policies unchanged when skills are enabled or unset", () => {
    assert.strictEqual(resolveMemoryPolicyPrompt({ memoryPolicyStyle: "full" }), MEMORY_POLICY_PROMPT);
    assert.strictEqual(resolveMemoryPolicyPrompt({ memoryPolicyStyle: "compact", skillsEnabled: true }), MEMORY_POLICY_PROMPT_COMPACT);
  });

  it("leaves custom policy text alone", () => {
    const memoryPolicyCustomText = "Use skill_manage for procedures.";
    assert.strictEqual(
      resolveMemoryPolicyPrompt({ memoryPolicyStyle: "custom", memoryPolicyCustomText, skillsEnabled: false }),
      memoryPolicyCustomText,
    );
  });
});

describe("memory policy text", () => {
  it("advertises every child write tool in both policy texts", () => {
    for (const name of MEMORY_WRITE_TOOL_NAMES) {
      assert.ok(MEMORY_POLICY_PROMPT.includes(`- ${name}:`), `MEMORY_POLICY_PROMPT lacks "- ${name}:"`);
      assert.ok(MEMORY_POLICY_PROMPT_COMPACT.includes(`- ${name}:`), `MEMORY_POLICY_PROMPT_COMPACT lacks "- ${name}:"`);
    }
  });
});
