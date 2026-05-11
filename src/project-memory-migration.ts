import fs from "node:fs";
import path from "node:path";
import { ENTRY_DELIMITER, MEMORY_FILE } from "./constants.js";

export interface ProjectMemoryMigrationResult {
  scanned: number;
  copied: number;
  merged: number;
  skipped: number;
  warnings: string[];
}

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];
  return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

function writeEntries(filePath: string, entries: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.join(ENTRY_DELIMITER), "utf-8");
}

function isLegacyProjectDir(agentRoot: string, projectsMemoryDir: string, name: string): boolean {
  if (name === "memory" || name === "skills" || name === projectsMemoryDir) return false;
  if (name.startsWith(".")) return false;

  const dir = path.join(agentRoot, name);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, MEMORY_FILE));
}

export function migrateLegacyProjectMemoryDirs(
  globalDir: string,
  projectsMemoryDir = "projects-memory",
): ProjectMemoryMigrationResult {
  const result: ProjectMemoryMigrationResult = {
    scanned: 0,
    copied: 0,
    merged: 0,
    skipped: 0,
    warnings: [],
  };

  const agentRoot = path.dirname(globalDir);
  if (!fs.existsSync(agentRoot)) return result;

  const projectsRoot = path.join(agentRoot, projectsMemoryDir);

  for (const name of fs.readdirSync(agentRoot)) {
    if (!isLegacyProjectDir(agentRoot, projectsMemoryDir, name)) continue;
    result.scanned++;

    const legacyFile = path.join(agentRoot, name, MEMORY_FILE);
    const targetFile = path.join(projectsRoot, name, MEMORY_FILE);

    try {
      const legacyEntries = readEntries(legacyFile);
      if (legacyEntries.length === 0) {
        result.skipped++;
        continue;
      }

      if (!fs.existsSync(targetFile)) {
        writeEntries(targetFile, legacyEntries);
        result.copied++;
        continue;
      }

      const targetEntries = readEntries(targetFile);
      const mergedEntries = [...targetEntries];
      const seen = new Set(targetEntries);

      for (const entry of legacyEntries) {
        if (!seen.has(entry)) {
          seen.add(entry);
          mergedEntries.push(entry);
        }
      }

      if (mergedEntries.length === targetEntries.length) {
        result.skipped++;
        continue;
      }

      writeEntries(targetFile, mergedEntries);
      result.merged++;
    } catch (err) {
      result.warnings.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
