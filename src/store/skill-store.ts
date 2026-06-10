/**
 * SkillStore — procedural memory stored as Pi-native skills.
 *
 * Global skills live in ~/.pi/agent/pi-hermes-memory/skills/<slug>/SKILL.md.
 * Project skills live in ~/.pi/agent/<projectsMemoryDir>/<project>/skills/<slug>/SKILL.md.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanContent } from "./content-scanner.js";
import {
  buildSkillId,
  exists,
  formatFrontmatter,
  jaccardSimilarity,
  parseFrontmatter,
  parseSkillId,
  slugify,
  today,
  tokenizeForSimilarity,
} from "./skill-utils.js";
import type { SkillDocument, SkillIndex, SkillResult, SkillScope } from "../types.js";
import { AGENT_ROOT } from "../paths.js";

interface SkillStoreOptions {
  globalSkillsDir?: string;
  projectSkillsDir?: string | null;
  projectName?: string | null;
  legacySkillsDir?: string;
  legacyPiGlobalSkillsDir?: string;
  migrationSentinelPath?: string;
}

interface SkillLocation {
  skillId: string;
  scope: SkillScope;
  slug: string;
  fileName: string;
  path: string;
  projectName?: string;
}

export interface LegacySkillMigrationResult {
  migrated: number;
  skipped: number;
  warnings: string[];
}

export class SkillStore {
  private globalSkillsDir: string;
  private projectSkillsDir: string | null;
  private projectName: string | null;
  private legacySkillsDir: string;
  private legacyPiGlobalSkillsDir: string;
  private migrationSentinelPath: string;

  constructor(options: SkillStoreOptions = {}) {
    const agentRoot = AGENT_ROOT;
    this.globalSkillsDir = options.globalSkillsDir ?? path.join(agentRoot, "skills");
    this.projectSkillsDir = options.projectSkillsDir ?? null;
    this.projectName = options.projectName ?? null;
    this.legacySkillsDir = options.legacySkillsDir ?? path.join(agentRoot, "memory", "skills");
    this.legacyPiGlobalSkillsDir = options.legacyPiGlobalSkillsDir ?? path.join(agentRoot, "skills");
    this.migrationSentinelPath = options.migrationSentinelPath
      ?? path.join(agentRoot, "pi-hermes-memory", ".skills-migrated-to-extension-storage");
  }

  getGlobalSkillsDir(): string {
    return this.globalSkillsDir;
  }

  getProjectSkillsDir(): string | null {
    return this.projectSkillsDir;
  }

  getProjectName(): string | null {
    return this.projectName;
  }

  setProjectContext(projectName: string | null, projectSkillsDir: string | null): void {
    this.projectName = projectName;
    this.projectSkillsDir = projectSkillsDir;
  }

  async ensureDiscoveredRoots(): Promise<void> {
    await fs.mkdir(this.globalSkillsDir, { recursive: true });
    if (this.projectSkillsDir) {
      await fs.mkdir(this.projectSkillsDir, { recursive: true });
    }
  }

  async migrateLegacySkills(): Promise<LegacySkillMigrationResult> {
    const result: LegacySkillMigrationResult = { migrated: 0, skipped: 0, warnings: [] };

    // Always normalize flat markdown files under the global skills root,
    // even when a previous migration sentinel already exists.
    await this.migrateFlatMarkdownInGlobalSkillsDir(result);

    if (await exists(this.migrationSentinelPath)) return result;

    await fs.mkdir(path.dirname(this.migrationSentinelPath), { recursive: true });

    try {
      await this.migrateLegacyMarkdownSkills(result);
      await this.migrateLegacyPiGlobalSkillDirs(result);
    } finally {
      if (result.warnings.length === 0) {
        await fs.writeFile(this.migrationSentinelPath, `${new Date().toISOString()}\n`, "utf-8");
      }
    }

    return result;
  }

  private async migrateLegacyMarkdownSkills(result: LegacySkillMigrationResult): Promise<void> {
    if (!await exists(this.legacySkillsDir)) return;

    const files = (await fs.readdir(this.legacySkillsDir))
      .filter((file) => file.endsWith(".md"))
      .sort();

    for (const file of files) {
      const legacyPath = path.join(this.legacySkillsDir, file);
      try {
        const raw = await fs.readFile(legacyPath, "utf-8");
        const parsed = parseFrontmatter(raw);
        const fallbackSlug = slugify(path.basename(file, ".md"));
        const slug = slugify(parsed.meta.name || fallbackSlug);
        if (!slug) {
          result.skipped++;
          continue;
        }

        const targetPath = path.join(this.globalSkillsDir, slug, "SKILL.md");
        if (await exists(targetPath)) {
          result.skipped++;
          continue;
        }

        const skillDoc = {
          name: slug,
          displayName: parsed.meta.display_name?.trim() || parsed.meta.name?.trim() || undefined,
          description: parsed.meta.description?.trim() || `Migrated legacy skill: ${slug}`,
          version: Number.parseInt(parsed.meta.version || "1", 10) || 1,
          created: parsed.meta.created || today(),
          updated: parsed.meta.updated || today(),
          body: parsed.body || `# ${slug}\n`,
        };

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await this.atomicWrite(targetPath, formatFrontmatter(skillDoc));
        result.migrated++;
      } catch (error) {
        result.warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async migrateFlatMarkdownInGlobalSkillsDir(result: LegacySkillMigrationResult): Promise<void> {
    if (!await exists(this.globalSkillsDir)) return;

    const files = (await fs.readdir(this.globalSkillsDir))
      .filter((file) => file.endsWith(".md") && file !== "SKILL.md")
      .sort();

    for (const file of files) {
      const legacyPath = path.join(this.globalSkillsDir, file);
      try {
        const raw = await fs.readFile(legacyPath, "utf-8");
        const parsed = parseFrontmatter(raw);
        const fallbackSlug = slugify(path.basename(file, ".md"));
        const slug = slugify(parsed.meta.name || fallbackSlug);
        if (!slug) {
          result.skipped++;
          continue;
        }

        const targetPath = path.join(this.globalSkillsDir, slug, "SKILL.md");
        if (await exists(targetPath)) {
          await fs.rm(legacyPath, { force: true });
          result.skipped++;
          continue;
        }

        const skillDoc = {
          name: slug,
          displayName: parsed.meta.display_name?.trim() || parsed.meta.name?.trim() || undefined,
          description: parsed.meta.description?.trim() || `Migrated legacy skill: ${slug}`,
          version: Number.parseInt(parsed.meta.version || "1", 10) || 1,
          created: parsed.meta.created || today(),
          updated: parsed.meta.updated || today(),
          body: parsed.body || `# ${slug}\n`,
        };

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await this.atomicWrite(targetPath, formatFrontmatter(skillDoc));
        await fs.rm(legacyPath, { force: true });
        result.migrated++;
      } catch (error) {
        result.warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async migrateLegacyPiGlobalSkillDirs(result: LegacySkillMigrationResult): Promise<void> {
    if (path.resolve(this.legacyPiGlobalSkillsDir) === path.resolve(this.globalSkillsDir)) return;
    if (!await exists(this.legacyPiGlobalSkillsDir)) return;

    const entries = await fs.readdir(this.legacyPiGlobalSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const sourceDir = path.join(this.legacyPiGlobalSkillsDir, entry.name);
      const sourceSkill = path.join(sourceDir, "SKILL.md");
      if (!await exists(sourceSkill)) continue;

      const targetDir = path.join(this.globalSkillsDir, entry.name);
      const targetSkill = path.join(targetDir, "SKILL.md");
      if (await exists(targetSkill)) {
        result.skipped++;
        continue;
      }

      try {
        const raw = await fs.readFile(sourceSkill, "utf-8");
        const parsed = parseFrontmatter(raw);
        const hasExtensionManagedMeta = Boolean(parsed.meta.display_name)
          && Boolean(parsed.meta.created)
          && Boolean(parsed.meta.updated)
          && /^\d+$/.test(parsed.meta.version ?? "");

        if (!hasExtensionManagedMeta) {
          result.skipped++;
          continue;
        }

        await fs.mkdir(path.dirname(targetDir), { recursive: true });
        await fs.rename(sourceDir, targetDir);
        result.migrated++;
      } catch (error) {
        result.warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async loadIndex(scope?: SkillScope): Promise<SkillIndex[]> {
    const locations = await this.collectLocations(scope);
    const skills: SkillIndex[] = [];

    for (const location of locations) {
      const doc = await this.readLocation(location);
      if (doc) skills.push(this.toIndex(doc));
    }

    return skills.sort((a, b) => {
      if (a.updated !== b.updated) return b.updated.localeCompare(a.updated);
      if (a.created !== b.created) return b.created.localeCompare(a.created);
      if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
      return (a.displayName || a.name).localeCompare(b.displayName || b.name);
    });
  }

  async loadSkill(skillId: string): Promise<SkillDocument | null> {
    const location = await this.findLocationById(skillId);
    if (!location) return null;
    return this.readLocation(location);
  }

  async create(name: string, description: string, body: string, scope?: SkillScope): Promise<SkillResult> {
    name = name.trim();
    description = description.trim();
    body = body.trim();

    if (!name) return { success: false, error: "Skill name is required." };
    if (!description) return { success: false, error: "Skill description is required." };
    if (!body) return { success: false, error: "Skill body is required." };

    const scanError = scanContent(`${name} ${description} ${body}`);
    if (scanError) return { success: false, error: scanError };

    const slug = slugify(name);
    if (!slug) return { success: false, error: "Skill name produces empty slug." };

    const resolvedScope = this.resolveScope(scope, name, description, body);
    const root = this.getScopeRoot(resolvedScope);
    if (!root) {
      return { success: false, error: "Project skills require an active project." };
    }

    const skillId = buildSkillId(resolvedScope, slug, this.projectName);
    const existing = await this.findLocationById(skillId);
    if (existing) {
      return {
        success: false,
        error: `Skill '${slug}' already exists (${skillId}). Use 'patch' or 'update' to update it.`,
        conflictType: "duplicate",
        similarSkillIds: [skillId],
        suggestedAction: "patch",
      };
    }

    if (resolvedScope === "global") {
      const similarSkillIds = await this.findSimilarGlobalSkillIds(slug, description);
      if (similarSkillIds.length > 0) {
        const targetId = similarSkillIds[0];
        return {
          success: false,
          error: `A similar global skill already exists (${targetId}). Enhance the existing skill with new learnings/failures using 'patch' or 'update' instead of creating a duplicate.`,
          conflictType: "similar",
          similarSkillIds,
          suggestedAction: "patch",
        };
      }

      const collidingNameSkillIds = await this.findNameCollisionGlobalSkillIds(slug, description);
      if (collidingNameSkillIds.length > 0) {
        const targetId = collidingNameSkillIds[0];
        return {
          success: false,
          error: `A near-name global skill already exists (${targetId}) but with different intent. Use a clearer differentiated name for the new skill, or patch/update the existing skill if the intent is actually the same.`,
          conflictType: "name-collision",
          similarSkillIds: collidingNameSkillIds,
          suggestedAction: "rename",
        };
      }
    }

    const filePath = path.join(root, slug, "SKILL.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const displayName = name;
    const storedName = slug;
    const stamp = today();
    await this.atomicWrite(filePath, formatFrontmatter({
      name: storedName,
      displayName,
      description,
      version: 1,
      created: stamp,
      updated: stamp,
      body,
    }));

    return {
      success: true,
      message: `Skill '${displayName}' created as a ${resolvedScope} skill.`,
      fileName: path.basename(filePath),
      skillId,
      scope: resolvedScope,
      path: filePath,
    };
  }

  async patch(skillId: string, section: string, newContent: string): Promise<SkillResult> {
    newContent = newContent.trim();
    if (!newContent) return { success: false, error: "New content is required for patch." };

    const scanError = scanContent(newContent);
    if (scanError) return { success: false, error: scanError };

    const doc = await this.loadSkill(skillId);
    if (!doc) return { success: false, error: `Skill '${skillId}' not found.` };

    const sectionHeader = `## ${section}`;
    const lines = doc.body.split("\n");
    let found = false;
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(sectionHeader)) {
        result.push(sectionHeader);
        result.push(newContent);
        found = true;
        i++;
        while (i < lines.length && !lines[i].startsWith("## ")) i++;
        if (i < lines.length) result.push(lines[i]);
      } else {
        result.push(lines[i]);
      }
    }

    if (!found) result.push("", sectionHeader, newContent);

    await this.atomicWrite(doc.path, formatFrontmatter({
      name: doc.name,
      displayName: doc.displayName,
      description: doc.description,
      version: doc.version + 1,
      created: doc.created,
      updated: today(),
      body: result.join("\n").trim(),
    }));

    return {
      success: true,
      message: `Skill '${doc.displayName || doc.name}' section '${section}' updated.`,
      fileName: doc.fileName,
      skillId: doc.skillId,
      scope: doc.scope,
      path: doc.path,
    };
  }

  async edit(skillId: string, description: string, body: string): Promise<SkillResult> {
    description = description.trim();
    body = body.trim();

    if (!description && !body) {
      return { success: false, error: "At least one of description or body is required." };
    }

    const doc = await this.loadSkill(skillId);
    if (!doc) return { success: false, error: `Skill '${skillId}' not found.` };

    const newDescription = description || doc.description;
    const newBody = body || doc.body;
    const scanError = scanContent(`${newDescription} ${newBody}`);
    if (scanError) return { success: false, error: scanError };

    await this.atomicWrite(doc.path, formatFrontmatter({
      name: doc.name,
      displayName: doc.displayName,
      description: newDescription,
      version: doc.version + 1,
      created: doc.created,
      updated: today(),
      body: newBody,
    }));

    return {
      success: true,
      message: `Skill '${doc.displayName || doc.name}' updated.`,
      fileName: doc.fileName,
      skillId: doc.skillId,
      scope: doc.scope,
      path: doc.path,
    };
  }

  async move(skillId: string, targetScope: SkillScope): Promise<SkillResult> {
    const doc = await this.loadSkill(skillId);
    if (!doc) return { success: false, error: `Skill '${skillId}' not found.` };

    const parsed = parseSkillId(skillId);
    if (!parsed) return { success: false, error: `Skill '${skillId}' is invalid.` };

    if (doc.scope === targetScope) {
      return {
        success: true,
        message: `Skill '${doc.displayName || doc.name}' is already ${targetScope}.`,
        fileName: doc.fileName,
        skillId: doc.skillId,
        scope: doc.scope,
        path: doc.path,
      };
    }

    const targetRoot = this.getScopeRoot(targetScope);
    if (!targetRoot) {
      return { success: false, error: "Project skills require an active project." };
    }

    const targetSkillId = buildSkillId(targetScope, parsed.slug, this.projectName);
    const targetPath = path.join(targetRoot, parsed.slug, "SKILL.md");
    if (await exists(targetPath)) {
      return {
        success: false,
        error: `Cannot move '${doc.displayName || doc.name}' to ${targetScope}: ${targetSkillId} already exists.`,
        conflictType: "scope-conflict",
        similarSkillIds: [targetSkillId],
        suggestedAction: "rename",
      };
    }

    if (targetScope === "global") {
      const similarSkillIds = await this.findSimilarGlobalSkillIds(parsed.slug, doc.description);
      if (similarSkillIds.length > 0) {
        const targetId = similarSkillIds[0];
        return {
          success: false,
          error: `Cannot move '${doc.displayName || doc.name}' to global: a similar global skill already exists (${targetId}).`,
          conflictType: "similar",
          similarSkillIds,
          suggestedAction: "patch",
        };
      }

      const collidingNameSkillIds = await this.findNameCollisionGlobalSkillIds(parsed.slug, doc.description);
      if (collidingNameSkillIds.length > 0) {
        const targetId = collidingNameSkillIds[0];
        return {
          success: false,
          error: `Cannot move '${doc.displayName || doc.name}' to global: a near-name global skill already exists (${targetId}) with different intent.`,
          conflictType: "name-collision",
          similarSkillIds: collidingNameSkillIds,
          suggestedAction: "rename",
        };
      }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Same-filesystem move: use rename first for atomicity and to avoid duplicate windows.
    try {
      await fs.rename(doc.path, targetPath);

      if (path.basename(doc.path) === "SKILL.md") {
        await this.removeEmptyParents(path.dirname(doc.path), this.getScopeRoot(doc.scope));
      }

      return {
        success: true,
        message: `Skill '${doc.displayName || doc.name}' moved to ${targetScope}.`,
        fileName: path.basename(targetPath),
        skillId: targetSkillId,
        scope: targetScope,
        path: targetPath,
      };
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException)?.code;
      if (code !== "EXDEV") {
        return {
          success: false,
          error: `Move to ${targetScope} failed before copy for skill '${skillId}'. Source path: ${doc.path}. Destination path: ${targetPath}. Error: ${renameError instanceof Error ? renameError.message : String(renameError)}`,
        };
      }
      // Cross-device fallback below.
    }

    // Cross-device fallback: copy then remove source.
    await this.atomicWrite(targetPath, formatFrontmatter({
      name: parsed.slug,
      displayName: doc.displayName,
      description: doc.description,
      version: doc.version,
      created: doc.created,
      updated: doc.updated,
      body: doc.body,
    }));

    try {
      await fs.unlink(doc.path);
      if (path.basename(doc.path) === "SKILL.md") {
        await this.removeEmptyParents(path.dirname(doc.path), this.getScopeRoot(doc.scope));
      }
    } catch (error) {
      // Best-effort rollback: remove the destination copy if source removal fails,
      // so we do not silently leave duplicate skills across scopes.
      let rollbackFailed = false;
      try {
        await fs.unlink(targetPath);
        if (path.basename(targetPath) === "SKILL.md") {
          await this.removeEmptyParents(path.dirname(targetPath), this.getScopeRoot(targetScope));
        }
      } catch {
        rollbackFailed = true;
      }

      return {
        success: false,
        error: rollbackFailed
          ? `Move to ${targetScope} failed while removing source skill '${skillId}', and rollback also failed. Source path: ${doc.path}. Destination path: ${targetPath}. Error: ${error instanceof Error ? error.message : String(error)}`
          : `Move to ${targetScope} failed while removing source skill '${skillId}'. Rolled back destination copy. Source path: ${doc.path}. Destination path: ${targetPath}. Error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return {
      success: true,
      message: `Skill '${doc.displayName || doc.name}' moved to ${targetScope}.`,
      fileName: path.basename(targetPath),
      skillId: targetSkillId,
      scope: targetScope,
      path: targetPath,
    };
  }

  async delete(skillId: string): Promise<SkillResult> {
    const doc = await this.loadSkill(skillId);
    if (!doc) return { success: false, error: `Skill '${skillId}' not found.` };

    await fs.unlink(doc.path);
    if (path.basename(doc.path) === "SKILL.md") {
      await this.removeEmptyParents(path.dirname(doc.path), this.getScopeRoot(doc.scope));
    }

    return {
      success: true,
      message: `Skill '${doc.displayName || doc.name}' deleted.`,
      fileName: doc.fileName,
      skillId: doc.skillId,
      scope: doc.scope,
      path: doc.path,
    };
  }

  private resolveScope(scope: SkillScope | undefined, name: string, description: string, body: string): SkillScope {
    if (scope) return scope;
    if (!this.projectSkillsDir || !this.projectName) return "global";

    const haystack = `${name}\n${description}\n${body}`.toLowerCase();
    const projectLower = this.projectName.toLowerCase();

    const strongSignals = [
      haystack.includes(projectLower),
      /\bthis repo\b|\bthis repository\b|\bthis project\b|\bour codebase\b|\bour app\b/.test(haystack),
      /\bpackage\.json\b|\bpnpm-lock\.yaml\b|\byarn\.lock\b|\btsconfig\.json\b|\bdocker-compose(\.ya?ml)?\b|\b\.env(\.[a-z0-9._-]+)?\b/.test(haystack),
      /(^|\s)(src|app|apps|packages|services|scripts|tests|docs|infra|migrations|db|api|web|frontend|backend)\/[a-z0-9._/-]+/m.test(haystack),
      /\b(npm|pnpm|yarn|bun)\s+(run|test|build|dev|lint|deploy)\b/.test(haystack),
    ].filter(Boolean).length;

    const weakerSignals = [
      /\bdeploy\b|\brelease\b|\bmigrate\b|\bmonorepo\b|\bworkspace\b|\bstaging\b|\bproduction\b/.test(haystack),
      /\bteam convention\b|\bcodebase convention\b|\brepo convention\b/.test(haystack),
    ].filter(Boolean).length;

    return strongSignals >= 2 || (strongSignals >= 1 && weakerSignals >= 1) ? "project" : "global";
  }

  private getScopeRoot(scope: SkillScope): string | null {
    return scope === "global" ? this.globalSkillsDir : this.projectSkillsDir;
  }

  private async findSimilarGlobalSkillIds(candidateSlug: string, candidateDescription: string): Promise<string[]> {
    const NAME_SIMILARITY_THRESHOLD = 0.7;
    const DESCRIPTION_SIMILARITY_THRESHOLD = 0.75;

    const scored = await this.scoreGlobalSimilarity(candidateSlug, candidateDescription);

    return scored
      .filter((entry) => entry.nameSimilarity > NAME_SIMILARITY_THRESHOLD
        && entry.descriptionSimilarity > DESCRIPTION_SIMILARITY_THRESHOLD)
      .map((entry) => entry.skillId);
  }

  private async findNameCollisionGlobalSkillIds(candidateSlug: string, candidateDescription: string): Promise<string[]> {
    const NAME_SIMILARITY_THRESHOLD = 0.7;
    const DESCRIPTION_SIMILARITY_THRESHOLD = 0.75;

    const scored = await this.scoreGlobalSimilarity(candidateSlug, candidateDescription);

    return scored
      .filter((entry) => entry.nameSimilarity > NAME_SIMILARITY_THRESHOLD
        && entry.descriptionSimilarity <= DESCRIPTION_SIMILARITY_THRESHOLD)
      .map((entry) => entry.skillId);
  }

  private async scoreGlobalSimilarity(
    candidateSlug: string,
    candidateDescription: string,
  ): Promise<Array<{ skillId: string; nameSimilarity: number; descriptionSimilarity: number }>> {
    const globals = await this.loadIndex("global");
    const candidateNameTokens = tokenizeForSimilarity(candidateSlug.replace(/-/g, " "));
    const candidateDescriptionTokens = tokenizeForSimilarity(candidateDescription);

    return globals
      .map((skill) => {
        const nameTokens = tokenizeForSimilarity((skill.displayName || skill.name).replace(/-/g, " "));
        const descriptionTokens = tokenizeForSimilarity(skill.description || "");
        const nameSimilarity = jaccardSimilarity(candidateNameTokens, nameTokens);
        const descriptionSimilarity = jaccardSimilarity(candidateDescriptionTokens, descriptionTokens);

        return {
          skillId: skill.skillId,
          nameSimilarity,
          descriptionSimilarity,
        };
      })
      .sort((a, b) => {
        const byName = b.nameSimilarity - a.nameSimilarity;
        if (Math.abs(byName) > 0.0001) return byName;
        return b.descriptionSimilarity - a.descriptionSimilarity;
      });
  }

  private async collectLocations(scope?: SkillScope): Promise<SkillLocation[]> {
    const locations: SkillLocation[] = [];
    const seen = new Set<string>();

    if (!scope || scope === "global") {
      const globalLocations = await this.scanScope(this.globalSkillsDir, "global", true, this.projectName ?? undefined);
      for (const location of globalLocations) {
        if (seen.has(location.skillId)) continue;
        seen.add(location.skillId);
        locations.push(location);
      }
    }

    if ((!scope || scope === "project") && this.projectSkillsDir && this.projectName) {
      const projectLocations = await this.scanScope(this.projectSkillsDir, "project", false, this.projectName);
      for (const location of projectLocations) {
        if (seen.has(location.skillId)) continue;
        seen.add(location.skillId);
        locations.push(location);
      }
    }

    return locations;
  }

  private async scanScope(
    root: string,
    scope: SkillScope,
    allowRootMarkdown: boolean,
    projectName?: string,
  ): Promise<SkillLocation[]> {
    if (!await exists(root)) return [];
    const results: SkillLocation[] = [];

    const walk = async (dir: string, isRoot: boolean): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of dirs) {
        if (entry.name.startsWith(".")) continue;
        const childDir = path.join(dir, entry.name);
        const skillFile = path.join(childDir, "SKILL.md");
        if (await exists(skillFile)) {
          results.push({
            skillId: buildSkillId(scope, entry.name, projectName),
            scope,
            slug: entry.name,
            fileName: "SKILL.md",
            path: skillFile,
            projectName,
          });
        }
        await walk(childDir, false);
      }

      if (!isRoot || !allowRootMarkdown) return;

      for (const entry of files) {
        if (!entry.name.endsWith(".md") || entry.name === "SKILL.md") continue;
        const slug = slugify(path.basename(entry.name, ".md"));
        if (!slug) continue;
        results.push({
          skillId: buildSkillId(scope, slug, projectName),
          scope,
          slug,
          fileName: entry.name,
          path: path.join(dir, entry.name),
          projectName,
        });
      }
    };

    await walk(root, true);
    return results;
  }

  private async findLocationById(skillId: string): Promise<SkillLocation | null> {
    const parsed = parseSkillId(skillId);
    if (!parsed) return null;

    const locations = await this.collectLocations(parsed.scope);
    return locations.find((location) => location.skillId === skillId) ?? null;
  }

  private async readLocation(location: SkillLocation): Promise<SkillDocument | null> {
    try {
      const raw = await fs.readFile(location.path, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      const skillName = meta.name?.trim() || location.slug;
      const displayName = meta.display_name?.trim() || undefined;
      return {
        skillId: location.skillId,
        scope: location.scope,
        fileName: location.fileName,
        path: location.path,
        projectName: location.projectName,
        name: skillName,
        displayName,
        description: meta.description?.trim() || "",
        version: Number.parseInt(meta.version || "1", 10) || 1,
        created: meta.created || today(),
        updated: meta.updated || today(),
        body,
      };
    } catch {
      return null;
    }
  }

  private toIndex(doc: SkillDocument): SkillIndex {
    return {
      skillId: doc.skillId,
      scope: doc.scope,
      fileName: doc.fileName,
      path: doc.path,
      projectName: doc.projectName,
      name: doc.name,
      displayName: doc.displayName,
      description: doc.description,
      created: doc.created,
      updated: doc.updated,
    };
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tempFile = path.join(
      dir,
      `.${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    await fs.writeFile(tempFile, content, "utf-8");
    await fs.rename(tempFile, filePath);
  }

  private async removeEmptyParents(startDir: string, stopDir: string | null): Promise<void> {
    if (!stopDir) return;

    let current = startDir;
    while (current.startsWith(stopDir) && current !== stopDir) {
      try {
        const entries = await fs.readdir(current);
        if (entries.length > 0) return;
        await fs.rmdir(current);
        current = path.dirname(current);
      } catch {
        return;
      }
    }
  }
}
