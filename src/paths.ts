import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECTS_MEMORY_DIR } from "./constants.js";

function findPiDir(startDir: string): string | null {
  let dir = path.dirname(startDir);
  while (dir !== path.dirname(dir)) {
    const piDir = path.join(dir, ".pi");
    if (existsSync(piDir)) return piDir;
    dir = path.dirname(dir);
  }
  return null;
}

export function detectAgentRoot(entryFile: string): string {
  const piDir = findPiDir(entryFile);
  if (!piDir) return path.join(os.homedir(), ".pi", "agent");
  // ~/.pi has agent/ subdirectory; project .pi does not
  if (existsSync(path.join(piDir, "agent"))) {
    return path.join(piDir, "agent");
  }
  return piDir;
}

/** Pi agent root directory. Global: ~/.pi/agent, project-local: <proj>/.pi */
export const AGENT_ROOT = detectAgentRoot(fileURLToPath(import.meta.url));

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function normalizeConfiguredMemoryDir(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const expanded = expandHome(trimmed);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(AGENT_ROOT, expanded);
}

function isSafeRelativeDirectory(input: string): boolean {
  const segments = input.split(/[\\/]+/).filter(Boolean);
  return segments.length === 1 && segments[0] !== "." && segments[0] !== "..";
}

export function normalizeProjectsMemoryDir(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const expanded = expandHome(trimmed);
  let relative = expanded;

  if (path.isAbsolute(expanded)) {
    const resolved = path.resolve(expanded);
    const relativeToAgentRoot = path.relative(AGENT_ROOT, resolved);
    if (
      relativeToAgentRoot === ""
      || relativeToAgentRoot.startsWith("..")
      || path.isAbsolute(relativeToAgentRoot)
    ) {
      return undefined;
    }
    relative = relativeToAgentRoot;
  }

  const normalized = path.normalize(relative).replace(/^[\\/]+|[\\/]+$/g, "");
  if (!isSafeRelativeDirectory(normalized)) return undefined;
  return normalized;
}

export function resolveProjectsRoot(projectsMemoryDir = DEFAULT_PROJECTS_MEMORY_DIR): string {
  const normalized = normalizeProjectsMemoryDir(projectsMemoryDir) ?? DEFAULT_PROJECTS_MEMORY_DIR;
  return path.join(AGENT_ROOT, normalized);
}

/**
 * Detect memory root directory from the extension entry file path.
 *
 * Global install: ~/.pi/agent/extensions/.../index.ts
 *   → ~/.pi/agent/pi-hermes-memory/
 * Project-local install: <proj>/.pi/extensions/.../index.ts
 *   → <proj>/.pi/hermes-memory/
 */
export function detectMemoryRoot(entryFile: string): string {
  const piDir = findPiDir(entryFile);
  if (!piDir) return path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory");
  if (existsSync(path.join(piDir, "agent"))) {
    return path.join(piDir, "agent", "pi-hermes-memory");
  }
  return path.join(piDir, "hermes-memory");
}
