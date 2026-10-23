import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptContext } from "../../src/prompt-context.js";
import type { SharedProfileState } from "../../src/hub-client/shared-profile.js";
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
});


describe("story 4 — shared user profile composition (CAP-5 / FR-14/FR-15)", () => {
  const localUser = "prefers terse answers over long explanations";

  const makeStore = (userEntries: string[]) => ({
    formatForSystemPrompt: () =>
      `<memory-context>\nlocal block\n${userEntries.join("\n")}\n</memory-context>`,
    getSnapshotUserEntries: () => userEntries,
  }) as any;

  it("renders the shared block after the local block, entries joined with the delimiter", async () => {
    const profile: SharedProfileState = {
      kind: "up",
      entries: ["works in the evening", "background: systems + AI"],
    };
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      makeStore([]),
      null,
      "demo",
      null,
      profile,
    );
    assert.match(result, /local block/);
    assert.match(result, /SHARED user profile from the LAN memory hub/);
    assert.match(result, /USER PROFILE \(shared across the LAN[^\n]*\) \[2 entries\]/);
    assert.match(result, /works in the evening\n§\nbackground: systems \+ AI/);
    // The shared block comes AFTER the local block.
    assert.ok(result.indexOf("local block") < result.indexOf("SHARED user profile"));
  });

  it("local wins on conflict: a shared entry duplicating a local one renders exactly once", async () => {
    const profile: SharedProfileState = {
      kind: "up",
      entries: [localUser, "background: systems + AI"],
    };
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      makeStore([localUser]),
      null,
      "demo",
      null,
      profile,
    );
    const count = result.split(localUser).length - 1;
    assert.strictEqual(count, 1, `the conflicted entry must appear exactly once, got ${count}`);
    assert.match(result, /background: systems \+ AI/);
    assert.match(result, /\[1 entry\]/);
  });

  it("diverged entries both render (local augments shared — the union)", async () => {
    const profile: SharedProfileState = {
      kind: "up",
      entries: ["prefers terse answers over long explanations (v2)"],
    };
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      makeStore(["prefers terse answers over long explanations"]),
      null,
      "demo",
      null,
      profile,
    );
    assert.match(result, /prefers terse answers over long explanations\n/);
    assert.match(result, /prefers terse answers over long explanations \(v2\)/);
  });

  it("down renders the explicit degraded line with the local block intact (FR-16)", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      makeStore([localUser]),
      null,
      "demo",
      null,
      { kind: "down", entries: [] },
    );
    assert.match(result, /local block/);
    assert.match(result, /SHARED USER PROFILE — degraded/);
    assert.match(result, /hub was unreachable at session start/);
    assert.doesNotMatch(result, /works in the evening/);
  });

  it("an empty up-profile renders nothing (no empty block)", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      makeStore([]),
      null,
      "demo",
      null,
      { kind: "up", entries: [] },
    );
    assert.doesNotMatch(result, /SHARED/);
  });

  it("whitespace-only shared entries are filtered out", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      makeStore([]),
      null,
      "demo",
      null,
      { kind: "up", entries: ["   ", "real entry"] },
    );
    assert.match(result, /real entry/);
    assert.match(result, /\[1 entry\]/);
  });

  it("no client file (null profile) ⇒ byte-identical to the v1 prompt (M4)", async () => {
    const store = makeStore([localUser]);
    const v1 = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      store,
      null,
      "demo",
      null,
    );
    const explicit = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      store,
      null,
      "demo",
      null,
      null,
    );
    assert.strictEqual(explicit, v1);
  });

  it("policy-only mode excludes the shared profile, exactly like the local block", async () => {
    const profile: SharedProfileState = { kind: "up", entries: ["works in the evening"] };
    const result = await buildPromptContext(
      { memoryMode: "policy-only" },
      makeStore([]),
      null,
      "demo",
      null,
      profile,
    );
    assert.doesNotMatch(result, /SHARED/);
    assert.doesNotMatch(result, /works in the evening/);
    assert.match(result, /Use memory_search/);
  });
});
