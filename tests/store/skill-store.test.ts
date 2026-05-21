/**
 * Unit tests for SkillStore — scoped CRUD, migration, and Pi-native file layout.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { SkillStore } from "../../src/store/skill-store.js";

let ROOT_DIR = "";
let GLOBAL_SKILLS_DIR = "";
let PROJECT_SKILLS_DIR = "";
let LEGACY_SKILLS_DIR = "";
let LEGACY_PI_GLOBAL_SKILLS_DIR = "";
let MIGRATION_SENTINEL = "";

async function makeStore(withProject = true): Promise<SkillStore> {
  return new SkillStore({
    globalSkillsDir: GLOBAL_SKILLS_DIR,
    projectSkillsDir: withProject ? PROJECT_SKILLS_DIR : null,
    projectName: withProject ? "demo-project" : null,
    legacySkillsDir: LEGACY_SKILLS_DIR,
    legacyPiGlobalSkillsDir: LEGACY_PI_GLOBAL_SKILLS_DIR,
    migrationSentinelPath: MIGRATION_SENTINEL,
  });
}

async function cleanSlate(): Promise<void> {
  try {
    await fs.rm(ROOT_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
  await fs.mkdir(GLOBAL_SKILLS_DIR, { recursive: true });
  await fs.mkdir(PROJECT_SKILLS_DIR, { recursive: true });
  await fs.mkdir(LEGACY_SKILLS_DIR, { recursive: true });
  await fs.mkdir(LEGACY_PI_GLOBAL_SKILLS_DIR, { recursive: true });
}

async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

describe("SkillStore", { concurrency: 1 }, () => {
  before(async () => {
    ROOT_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-test-"));
    GLOBAL_SKILLS_DIR = path.join(ROOT_DIR, "global-skills");
    PROJECT_SKILLS_DIR = path.join(ROOT_DIR, "project-skills");
    LEGACY_SKILLS_DIR = path.join(ROOT_DIR, "legacy-skills");
    LEGACY_PI_GLOBAL_SKILLS_DIR = path.join(ROOT_DIR, "legacy-pi-global-skills");
    MIGRATION_SENTINEL = path.join(ROOT_DIR, ".skill-migration");
  });

  after(async () => {
    try {
      await fs.rm(ROOT_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await cleanSlate();
  });

  afterEach(async () => {
    await cleanSlate();
  });

  describe("create()", () => {
    it("writes global skills to <slug>/SKILL.md", async () => {
      const store = await makeStore();
      const result = await store.create(
        "Debug TypeScript Errors",
        "Step-by-step approach to debugging TS errors",
        "## Procedure\n1. Read the error\n2. Check types",
      );

      assert.ok(result.success, `create failed: ${result.error}`);
      assert.strictEqual(result.skillId, "global:debug-typescript-errors");
      const filePath = path.join(GLOBAL_SKILLS_DIR, "debug-typescript-errors", "SKILL.md");
      const raw = await readFile(filePath);
      assert.ok(raw.includes('name: "debug-typescript-errors"'));
      assert.ok(raw.includes('display_name: "Debug TypeScript Errors"'));
      assert.ok(raw.includes('description: "Step-by-step approach to debugging TS errors"'));
      assert.ok(raw.includes("version: 1"));
      assert.ok(raw.includes("## Procedure"));
    });

    it("writes explicit project skills to projects-memory/<project>/skills/<slug>/SKILL.md", async () => {
      const store = await makeStore();
      const result = await store.create(
        "Release App",
        "Release this repository",
        "## Procedure\n1. Run pnpm build\n2. Run pnpm deploy",
        "project",
      );

      assert.ok(result.success, `create failed: ${result.error}`);
      assert.strictEqual(result.skillId, "project:demo-project:release-app");
      const filePath = path.join(PROJECT_SKILLS_DIR, "release-app", "SKILL.md");
      const raw = await readFile(filePath);
      assert.ok(raw.includes('name: "release-app"'));
      assert.ok(raw.includes('display_name: "Release App"'));
      assert.ok(raw.includes("Run pnpm deploy"));
    });

    it("classifies transferable procedures as global by default", async () => {
      const store = await makeStore();
      const result = await store.create(
        "debug-fetch-errors",
        "Reusable workflow for tracing fetch failures",
        "## Procedure\n1. Reproduce the request\n2. Check the network trace\n3. Compare status codes",
      );

      assert.ok(result.success, `create failed: ${result.error}`);
      assert.strictEqual(result.scope, "global");
      assert.strictEqual(result.skillId, "global:debug-fetch-errors");
    });

    it("classifies repo-specific procedures as project by default", async () => {
      const store = await makeStore();
      const result = await store.create(
        "release-demo-project",
        "How to release this repo",
        "## Procedure\n1. In this repo, run pnpm build\n2. Check package.json scripts\n3. Deploy from src/server",
      );

      assert.ok(result.success, `create failed: ${result.error}`);
      assert.strictEqual(result.scope, "project");
      assert.strictEqual(result.skillId, "project:demo-project:release-demo-project");
    });

    it("returns error for empty name", async () => {
      const store = await makeStore();
      const result = await store.create("", "desc", "body");
      assert.ok(!result.success);
      assert.ok(result.error!.includes("name is required"));
    });

    it("returns error for duplicate slug in same scope", async () => {
      const store = await makeStore();
      await store.create("my-skill", "desc", "body");

      const result = await store.create("my skill", "new desc", "new body");
      assert.ok(!result.success);
      assert.ok(result.error!.includes("already exists"));
      assert.strictEqual(result.conflictType, "duplicate");
      assert.deepStrictEqual(result.similarSkillIds, ["global:my-skill"]);
      assert.strictEqual(result.suggestedAction, "patch");
    });

    it("blocks creating a similar global skill and suggests patching", async () => {
      const store = await makeStore();
      await store.create(
        "debug-typescript-errors",
        "Step-by-step workflow for debugging TypeScript compiler errors, type mismatches, and incorrect type assumptions",
        "## Procedure\n1. Reproduce\n2. Inspect inferred types",
      );

      const result = await store.create(
        "debug-typescript-errors-fast",
        "Step-by-step workflow for debugging TypeScript compiler errors, type mismatches, and incorrect type assumptions",
        "## Procedure\n1. Reproduce\n2. Narrow the failing type",
      );

      assert.ok(!result.success);
      assert.strictEqual(result.conflictType, "similar");
      assert.strictEqual(result.suggestedAction, "patch");
      assert.ok(result.similarSkillIds?.includes("global:debug-typescript-errors"));
      assert.ok(result.error?.includes("similar global skill already exists"));

      const index = await store.loadIndex("global");
      assert.strictEqual(index.length, 1);
    });

    it("blocks near-name global collisions even when descriptions diverge", async () => {
      const store = await makeStore();
      await store.create(
        "debug-typescript-errors",
        "Step-by-step workflow for debugging TypeScript compiler errors",
        "## Procedure\n1. Reproduce\n2. Inspect types",
      );

      const result = await store.create(
        "debug-typescript-errors-runtime",
        "Incident-response runbook for on-call paging, service alerts, and runtime triage escalation",
        "## Procedure\n1. Acknowledge page\n2. Escalate and contain",
      );

      assert.ok(!result.success);
      assert.strictEqual(result.conflictType, "name-collision");
      assert.strictEqual(result.suggestedAction, "rename");
      assert.ok(result.similarSkillIds?.includes("global:debug-typescript-errors"));
      assert.ok(result.error?.includes("near-name global skill already exists"));

      const index = await store.loadIndex("global");
      assert.strictEqual(index.length, 1);
    });

    it("allows creating distinct global skills", async () => {
      const store = await makeStore();
      await store.create(
        "debug-typescript-errors",
        "Step-by-step workflow for debugging TypeScript compiler errors",
        "## Procedure\n1. Reproduce\n2. Inspect types",
      );

      const result = await store.create(
        "optimize-postgres-indexes",
        "How to profile slow PostgreSQL queries and add safe indexes",
        "## Procedure\n1. Capture EXPLAIN ANALYZE\n2. Evaluate index options",
      );

      assert.ok(result.success, `create failed unexpectedly: ${result.error}`);
      assert.strictEqual(result.skillId, "global:optimize-postgres-indexes");

      const index = await store.loadIndex("global");
      assert.strictEqual(index.length, 2);
    });

    it("does not allow project scope without an active project", async () => {
      const store = await makeStore(false);
      const result = await store.create("repo-only", "desc", "body", "project");
      assert.ok(!result.success);
      assert.ok(result.error!.includes("active project"));
    });
  });

  describe("loadIndex()", () => {
    it("returns both global and project skills", async () => {
      const store = await makeStore();
      await store.create("skill-a", "First skill", "body a");
      await store.create("skill-b", "Second skill", "body b", "project");

      const index = await store.loadIndex();
      assert.strictEqual(index.length, 2);
      assert.ok(index.some((skill) => skill.skillId === "global:skill-a"));
      assert.ok(index.some((skill) => skill.skillId === "project:demo-project:skill-b"));
    });

    it("includes existing user-managed global Pi skills", async () => {
      const store = await makeStore();
      const customDir = path.join(GLOBAL_SKILLS_DIR, "manual-skill");
      await fs.mkdir(customDir, { recursive: true });
      await fs.writeFile(path.join(customDir, "SKILL.md"), [
        "---",
        "name: manual-skill",
        "description: A manually created Pi skill",
        "---",
        "# Manual Skill",
      ].join("\n"), "utf-8");

      const index = await store.loadIndex();
      assert.strictEqual(index.length, 1);
      assert.strictEqual(index[0].skillId, "global:manual-skill");
      assert.strictEqual(index[0].scope, "global");
    });

    it("returns empty array when no skills exist", async () => {
      const store = await makeStore();
      const index = await store.loadIndex();
      assert.deepStrictEqual(index, []);
    });

    it("sorts skills by updated date descending, then created date descending", async () => {
      const store = await makeStore();
      const olderDir = path.join(GLOBAL_SKILLS_DIR, "older-skill");
      const newerDir = path.join(GLOBAL_SKILLS_DIR, "newer-skill");
      await fs.mkdir(olderDir, { recursive: true });
      await fs.mkdir(newerDir, { recursive: true });
      await fs.writeFile(path.join(olderDir, "SKILL.md"), [
        "---",
        'name: "older-skill"',
        'description: "Older skill"',
        "version: 2",
        'created: "2026-05-18"',
        'updated: "2026-05-20"',
        "---",
        "## Procedure",
        "1. Old",
      ].join("\n"), "utf-8");
      await fs.writeFile(path.join(newerDir, "SKILL.md"), [
        "---",
        'name: "newer-skill"',
        'description: "Newer skill"',
        "version: 1",
        'created: "2026-05-19"',
        'updated: "2026-05-21"',
        "---",
        "## Procedure",
        "1. New",
      ].join("\n"), "utf-8");

      const index = await store.loadIndex("global");
      assert.strictEqual(index[0]?.skillId, "global:newer-skill");
      assert.strictEqual(index[1]?.skillId, "global:older-skill");
      assert.ok(index[0]!.updated >= index[1]!.updated);
    });
  });

  describe("loadSkill()", () => {
    it("returns full document with scope and skill id", async () => {
      const store = await makeStore();
      const created = await store.create("My Skill", "A test skill", "## Procedure\n1. Do it");

      const doc = await store.loadSkill(created.skillId!);

      assert.ok(doc);
      assert.strictEqual(doc!.skillId, "global:my-skill");
      assert.strictEqual(doc!.scope, "global");
      assert.strictEqual(doc!.name, "my-skill");
      assert.strictEqual(doc!.displayName, "My Skill");
      assert.strictEqual(doc!.description, "A test skill");
      assert.strictEqual(doc!.version, 1);
      assert.ok(doc!.body.includes("## Procedure"));
    });

    it("returns null for missing skill id", async () => {
      const store = await makeStore();
      const doc = await store.loadSkill("global:missing");
      assert.strictEqual(doc, null);
    });
  });

  describe("patch()", () => {
    it("replaces an existing section by skill id", async () => {
      const store = await makeStore();
      const created = await store.create("test", "desc", "## Procedure\n1. Old way\n\n## Pitfalls\nWatch out");

      const result = await store.patch(created.skillId!, "Procedure", "1. New way\n2. Better way");
      assert.ok(result.success, `patch failed: ${result.error}`);

      const doc = await store.loadSkill(created.skillId!);
      assert.ok(doc!.body.includes("1. New way"));
      assert.ok(!doc!.body.includes("1. Old way"));
      assert.ok(doc!.body.includes("## Pitfalls"));
    });

    it("appends a missing section", async () => {
      const store = await makeStore();
      const created = await store.create("test", "desc", "## Procedure\n1. Do it");

      const result = await store.patch(created.skillId!, "Verification", "Run the tests");
      assert.ok(result.success, `patch failed: ${result.error}`);

      const doc = await store.loadSkill(created.skillId!);
      assert.ok(doc!.body.includes("## Verification"));
      assert.ok(doc!.body.includes("Run the tests"));
      assert.strictEqual(doc!.version, 2);
    });
  });

  describe("edit()", () => {
    it("replaces description and body", async () => {
      const store = await makeStore();
      const created = await store.create("test", "old desc", "## Old Body");

      const result = await store.edit(created.skillId!, "new desc", "## New Body");
      assert.ok(result.success, `edit failed: ${result.error}`);

      const doc = await store.loadSkill(created.skillId!);
      assert.strictEqual(doc!.description, "new desc");
      assert.ok(doc!.body.includes("## New Body"));
      assert.ok(!doc!.body.includes("## Old Body"));
      assert.strictEqual(doc!.version, 2);
    });
  });

  describe("move()", () => {
    it("moves a global skill into the active project scope", async () => {
      const store = await makeStore();
      const created = await store.create("move-me", "Reusable process", "## Procedure\n1. Do it", "global");

      const result = await store.move(created.skillId!, "project");
      assert.ok(result.success, `move failed: ${result.error}`);
      assert.strictEqual(result.skillId, "project:demo-project:move-me");
      await assert.rejects(fs.access(path.join(GLOBAL_SKILLS_DIR, "move-me", "SKILL.md")));
      await fs.access(path.join(PROJECT_SKILLS_DIR, "move-me", "SKILL.md"));
    });

    it("moves a project skill into global scope", async () => {
      const store = await makeStore();
      const created = await store.create("repo-runbook", "Project process", "## Procedure\n1. Run it", "project");

      const result = await store.move(created.skillId!, "global");
      assert.ok(result.success, `move failed: ${result.error}`);
      assert.strictEqual(result.skillId, "global:repo-runbook");
      await assert.rejects(fs.access(path.join(PROJECT_SKILLS_DIR, "repo-runbook", "SKILL.md")));
      await fs.access(path.join(GLOBAL_SKILLS_DIR, "repo-runbook", "SKILL.md"));
    });

    it("blocks move when destination scope already has the same slug", async () => {
      const store = await makeStore();
      const globalSkill = await store.create("same-name", "global skill", "body", "global");
      const projectSkill = await store.create("same-name", "project skill", "body", "project");

      const result = await store.move(globalSkill.skillId!, "project");
      assert.ok(!result.success);
      assert.strictEqual(result.conflictType, "scope-conflict");
      assert.ok(result.error?.includes("already exists"));

      const globalDoc = await store.loadSkill(globalSkill.skillId!);
      const projectDoc = await store.loadSkill(projectSkill.skillId!);
      assert.ok(globalDoc);
      assert.ok(projectDoc);
    });

    it("returns an error when moving to project scope without an active project", async () => {
      const store = await makeStore(false);
      const created = await store.create("global-skill", "desc", "body", "global");

      const result = await store.move(created.skillId!, "project");
      assert.ok(!result.success);
      assert.ok(result.error?.includes("active project"));
    });
  });

  describe("delete()", () => {
    it("removes the skill file from disk", async () => {
      const store = await makeStore();
      const created = await store.create("to-delete", "desc", "body");

      const result = await store.delete(created.skillId!);
      assert.ok(result.success, `delete failed: ${result.error}`);

      const index = await store.loadIndex();
      assert.strictEqual(index.length, 0);
    });

    it("keeps duplicate slugs across scopes safe because ids differ", async () => {
      const store = await makeStore();
      const globalSkill = await store.create("same-name", "global", "body");
      const projectSkill = await store.create("same-name", "project", "body", "project");

      assert.ok(globalSkill.success);
      assert.ok(projectSkill.success);
      assert.notStrictEqual(globalSkill.skillId, projectSkill.skillId);

      const index = await store.loadIndex();
      assert.strictEqual(index.length, 2);
    });
  });

  describe("migration", () => {
    it("migrates legacy memory/skills/*.md files into global Pi skills", async () => {
      const legacyFile = path.join(LEGACY_SKILLS_DIR, "legacy-skill.md");
      await fs.writeFile(legacyFile, [
        "---",
        "name: Legacy Skill",
        "description: Legacy migrated skill",
        "version: 2",
        "created: 2026-01-01",
        "updated: 2026-01-02",
        "---",
        "## Procedure",
        "1. Do the legacy thing",
      ].join("\n"), "utf-8");

      const store = await makeStore();
      const result = await store.migrateLegacySkills();

      assert.strictEqual(result.migrated, 1);
      const migratedPath = path.join(GLOBAL_SKILLS_DIR, "legacy-skill", "SKILL.md");
      const raw = await readFile(migratedPath);
      assert.ok(raw.includes('name: "legacy-skill"'));
      assert.ok(raw.includes('display_name: "Legacy Skill"'));
      assert.ok(raw.includes('description: "Legacy migrated skill"'));
      assert.ok(raw.includes("1. Do the legacy thing"));
    });

    it("does not rerun after the sentinel is created", async () => {
      const legacyFile = path.join(LEGACY_SKILLS_DIR, "legacy-skill.md");
      await fs.writeFile(legacyFile, [
        "---",
        "name: legacy-skill",
        "description: Legacy migrated skill",
        "---",
        "body",
      ].join("\n"), "utf-8");

      const store = await makeStore();
      const first = await store.migrateLegacySkills();
      const second = await store.migrateLegacySkills();

      assert.strictEqual(first.migrated, 1);
      assert.strictEqual(second.migrated, 0);
    });

    it("does not overwrite an existing global skill unexpectedly", async () => {
      const existingDir = path.join(GLOBAL_SKILLS_DIR, "legacy-skill");
      await fs.mkdir(existingDir, { recursive: true });
      await fs.writeFile(path.join(existingDir, "SKILL.md"), [
        "---",
        "name: legacy-skill",
        "description: Existing global skill",
        "---",
        "# Existing",
      ].join("\n"), "utf-8");
      await fs.writeFile(path.join(LEGACY_SKILLS_DIR, "legacy-skill.md"), [
        "---",
        "name: legacy-skill",
        "description: Legacy version",
        "---",
        "# Legacy",
      ].join("\n"), "utf-8");

      const store = await makeStore();
      const result = await store.migrateLegacySkills();

      assert.strictEqual(result.migrated, 0);
      assert.strictEqual(result.skipped, 1);

      const raw = await readFile(path.join(existingDir, "SKILL.md"));
      assert.ok(raw.includes("Existing global skill"));
      assert.ok(!raw.includes("Legacy version"));
    });

    it("migrates flat markdown files under global skills root into SKILL.md folders", async () => {
      await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, "flat-legacy.md"), [
        "---",
        "name: flat-legacy",
        "description: Flat legacy skill",
        "---",
        "# Flat Body",
      ].join("\n"), "utf-8");

      const store = await makeStore();
      const result = await store.migrateLegacySkills();

      assert.strictEqual(result.migrated, 1);
      await assert.rejects(fs.access(path.join(GLOBAL_SKILLS_DIR, "flat-legacy.md")));
      const migrated = await readFile(path.join(GLOBAL_SKILLS_DIR, "flat-legacy", "SKILL.md"));
      assert.ok(migrated.includes('description: "Flat legacy skill"'));
    });

    it("does not write the sentinel when warnings occur, so migration can retry", async () => {
      await fs.mkdir(path.join(LEGACY_SKILLS_DIR, "broken.md"), { recursive: true });
      const legacyFile = path.join(LEGACY_SKILLS_DIR, "legacy-skill.md");
      await fs.writeFile(legacyFile, [
        "---",
        "name: legacy-skill",
        "description: Legacy migrated skill",
        "---",
        "body",
      ].join("\n"), "utf-8");

      const store = await makeStore();
      const first = await store.migrateLegacySkills();

      assert.ok(first.warnings.length >= 1);
      await assert.rejects(fs.access(MIGRATION_SENTINEL));

      await fs.rm(path.join(LEGACY_SKILLS_DIR, "broken.md"), { recursive: true, force: true });
      const second = await store.migrateLegacySkills();
      assert.strictEqual(second.migrated, 0);
      await fs.access(MIGRATION_SENTINEL);
    });
  });

  describe("dynamic project context", () => {
    it("can retarget project skill creation to a new project directory", async () => {
      const store = await makeStore();
      const altProjectDir = path.join(ROOT_DIR, "another-project-skills");
      store.setProjectContext("another-project", altProjectDir);

      const result = await store.create(
        "Deploy Another Project",
        "Project-specific deploy flow",
        "## Procedure\n1. Run npm run deploy",
        "project",
      );

      assert.ok(result.success, `create failed: ${result.error}`);
      assert.strictEqual(result.skillId, "project:another-project:deploy-another-project");
      await fs.access(path.join(altProjectDir, "deploy-another-project", "SKILL.md"));
    });
  });
});
