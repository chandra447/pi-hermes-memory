import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectSkillDiscovery, registerProjectSkillDiscoveryHandler } from "../../src/index.js";
import { AGENT_ROOT } from "../../src/paths.js";
import { SkillStore } from "../../src/store/skill-store.js";

describe("resources_discover skill path resolution", () => {
  it("registers resources_discover and returns skillPaths from handler", async () => {
    const store = new SkillStore({
      globalSkillsDir: "/tmp/global-skills",
      projectSkillsDir: null,
      projectName: null,
      legacySkillsDir: "/tmp/legacy-skills",
      migrationSentinelPath: "/tmp/.skills-migrated",
    });

    const handlers: Record<string, Function> = {};
    const pi = {
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
      },
    } as any;

    registerProjectSkillDiscoveryHandler(pi, store, "projects-memory");
    assert.ok(typeof handlers.resources_discover === "function");

    const result = await handlers.resources_discover({ cwd: "/tmp/demo-repo" }, {});
    const expectedPath = path.join(AGENT_ROOT, "projects-memory", "demo-repo", "skills");

    assert.deepStrictEqual(result, { skillPaths: [expectedPath] });
  });

  it("returns project skillPaths and updates skill store context", () => {
    const store = new SkillStore({
      globalSkillsDir: "/tmp/global-skills",
      projectSkillsDir: null,
      projectName: null,
      legacySkillsDir: "/tmp/legacy-skills",
      migrationSentinelPath: "/tmp/.skills-migrated",
    });

    const cwd = "/tmp/demo-repo";
    const resource = resolveProjectSkillDiscovery(store, "projects-memory", cwd);
    const expectedPath = path.join(AGENT_ROOT, "projects-memory", "demo-repo", "skills");

    assert.deepStrictEqual(resource, { skillPaths: [expectedPath] });
    assert.strictEqual(store.getProjectName(), "demo-repo");
    assert.strictEqual(store.getProjectSkillsDir(), expectedPath);
  });

  it("contributes no skill path when cwd is not a project", () => {
    const store = new SkillStore({
      globalSkillsDir: "/tmp/global-skills",
      projectSkillsDir: "/tmp/old-project",
      projectName: "old-project",
      legacySkillsDir: "/tmp/legacy-skills",
      migrationSentinelPath: "/tmp/.skills-migrated",
    });

    const resource = resolveProjectSkillDiscovery(store, "projects-memory", os.homedir());

    // The global root is Pi's own `~/.pi/agent/skills/`, which Pi already
    // auto-discovers — contributing it again would make our copy of any
    // same-named skill a permanent collision loser (#125, #126).
    assert.deepStrictEqual(resource, { skillPaths: [] });
    assert.strictEqual(store.getProjectName(), null);
    assert.strictEqual(store.getProjectSkillsDir(), null);
  });
});
