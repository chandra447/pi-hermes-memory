/**
 * Contract test for Pi's skill index (follow-up to #244 / #249).
 *
 * Pi discovers skills by the frontmatter `description` alone — the SKILL.md
 * body never reaches the rendered `<available_skills>` block. This test pins
 * that contract with Pi's own loader through the public API, so a change in
 * how Pi indexes skills fails here instead of silently degrading discovery.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";

async function writeSkill(dir: string, slug: string, description: string, whenToUse: string): Promise<void> {
  const skillDir = path.join(dir, slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: "${description}"\n---\n## When to Use\n${whenToUse}\n`,
    "utf-8",
  );
}

describe("Pi skill index contract", () => {
  it("surfaces description triggers in the index and never body-only triggers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-discovery-contract-"));
    try {
      const skillsDir = path.join(root, "skills");
      await writeSkill(
        skillsDir,
        "branch-check-description",
        "Check git branch state. Use when asked to check branches or which branches are unmerged.",
        "Use when the user asks to compare local and remote branch state.",
      );
      await writeSkill(
        skillsDir,
        "branch-check-body-only",
        "Check git branch state: local vs remote counts, unmerged branches.",
        "Triggered when asked to check branches. Keywords: branch check, unmerged.",
      );

      const result = loadSkills({ cwd: root, agentDir: root, skillPaths: [skillsDir], includeDefaults: false });
      const index = formatSkillsForPrompt(result.skills);

      assert.match(index, /<name>branch-check-description<\/name>/, "both skills are indexed by name");
      assert.match(index, /<name>branch-check-body-only<\/name>/, "both skills are indexed by name");
      assert.match(index, /Use when asked to check branches/, "description-carried triggers are discoverable");
      assert.doesNotMatch(index, /Keywords: branch check, unmerged/, "body-only triggers never reach the index");
    } finally {
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch {
        // Windows may keep the directory busy briefly; the temp dir is disposable.
      }
    }
  });
});
