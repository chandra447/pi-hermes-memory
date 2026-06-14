import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptContext } from "../../src/prompt-context.js";
import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "../../src/constants.js";

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
});
