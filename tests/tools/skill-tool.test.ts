/**
 * Unit tests for skill tool registration and execute function.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { registerSkillTool } from "../../src/tools/skill-tool.js";
import { SkillStore } from "../../src/store/skill-store.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

// ─── Helpers ───

let SKILLS_DIR = "";

async function makeStore(): Promise<SkillStore> {
  SKILLS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-tool-test-"));
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  return new SkillStore(SKILLS_DIR);
}

async function cleanup(): Promise<void> {
  try {
    await fs.rm(SKILLS_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ─── Tests ───

describe("registerSkillTool", () => {
  it("registers tool with name 'skill'", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);
    await cleanup();

    assert.strictEqual(captured.name, "skill");
    assert.strictEqual(captured.label, "Skill");
    assert.ok(captured.description.length > 0);
    assert.ok(captured.promptSnippet.length > 0);
    assert.ok(Array.isArray(captured.promptGuidelines));
    assert.ok(captured.parameters);
  });

  it("create requires name, description, content", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    // Missing name
    let result = await captured.execute("tc-1", { action: "create", description: "desc", content: "body" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    // Missing description
    result = await captured.execute("tc-1", { action: "create", name: "test", content: "body" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    // Missing content
    result = await captured.execute("tc-1", { action: "create", name: "test", description: "desc" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    await cleanup();
  });

  it("create succeeds with all params", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", {
      action: "create",
      name: "test-skill",
      description: "A test skill",
      content: "## Procedure\n1. Do it",
    }, undefined, undefined, undefined);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.ok(parsed.fileName);

    await cleanup();
  });

  it("view without file_name lists all skills", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    await store.create("skill-a", "First", "body a");
    await store.create("skill-b", "Second", "body b");
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "view" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.skills.length, 2);

    await cleanup();
  });

  it("view with file_name returns full document", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    await store.create("my-skill", "A skill", "## Body content here");
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "view", file_name: "my-skill.md" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.name, "my-skill");
    assert.ok(parsed.body.includes("## Body content here"));

    await cleanup();
  });

  it("view with invalid file_name returns error", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "view", file_name: "missing.md" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes("not found"));

    await cleanup();
  });

  it("patch requires file_name, section, content", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    // Missing file_name
    let result = await captured.execute("tc-1", { action: "patch", section: "Procedure", content: "new" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    // Missing section
    result = await captured.execute("tc-1", { action: "patch", file_name: "test.md", content: "new" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    // Missing content
    result = await captured.execute("tc-1", { action: "patch", file_name: "test.md", section: "Procedure" }, undefined, undefined, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).success, false);

    await cleanup();
  });

  it("edit requires file_name", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "edit", description: "new desc" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes("file_name"));

    await cleanup();
  });

  it("delete requires file_name", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "delete" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes("file_name"));

    await cleanup();
  });

  it("unknown action returns error", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    const store = await makeStore();
    registerSkillTool(mockPi, store);

    const result = await captured.execute("tc-1", { action: "explode" }, undefined, undefined, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes("Unknown action"));

    await cleanup();
  });
});
