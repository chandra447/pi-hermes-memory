/**
 * One-shot snapshot retention sweep across every memory store on disk (#202).
 *
 * Snapshot pruning normally runs inside saveToDisk(), so a store that stops
 * being written keeps its .recovery-* and .retired-* artifacts forever. This
 * sweep applies the identical per-file policy to dormant stores once per
 * session start. Enumeration never follows symlinks and never enters hidden
 * or nested directories.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveProjectsRoot } from "../paths.js";
import { MemoryStore } from "./memory-store.js";
import type { MemoryConfig } from "../types.js";

export interface RecoveryMaintenanceOptions {
  config: MemoryConfig;
  globalDir: string;
}

export interface RecoveryMaintenanceResult {
  storesMaintained: number;
  failedStores: string[];
}

// loadConfig only ever stores a single AGENT_ROOT-relative segment here; an
// absolute value is a direct-injection seam for tests and embedding hosts.
function resolveProjectsRootFor(projectsMemoryDir: MemoryConfig["projectsMemoryDir"]): string {
  return projectsMemoryDir && path.isAbsolute(projectsMemoryDir)
    ? projectsMemoryDir
    : resolveProjectsRoot(projectsMemoryDir);
}

export async function listMemoryStoreDirs(options: RecoveryMaintenanceOptions): Promise<string[]> {
  const dirs = [options.globalDir];
  const projectsRoot = resolveProjectsRootFor(options.config.projectsMemoryDir);
  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "skills") continue;
    dirs.push(path.join(projectsRoot, entry.name));
  }
  return dirs;
}

export async function runRecoveryMaintenance(options: RecoveryMaintenanceOptions): Promise<RecoveryMaintenanceResult> {
  const result: RecoveryMaintenanceResult = { storesMaintained: 0, failedStores: [] };
  for (const memoryDir of await listMemoryStoreDirs(options)) {
    // The constructor only assigns config; maintainRecoveryFiles touches
    // sidecar files without loading or writing MEMORY.md/USER.md/failures.md.
    const store = new MemoryStore({ ...options.config, memoryDir });
    try {
      await store.maintainRecoveryFiles();
      result.storesMaintained++;
    } catch {
      result.failedStores.push(memoryDir);
    }
  }
  return result;
}
