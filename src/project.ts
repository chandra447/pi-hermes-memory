/**
 * Project detection — determines whether the current working directory
 * represents a project and resolves its name.
 */

import * as path from "node:path";
import * as os from "node:os";

export interface ProjectInfo {
  /** Project name (directory basename), or null if not in a project. */
  name: string | null;
  /** Path to the project-scoped memory directory, or null. */
  memoryDir: string | null;
}

/**
 * Detect project from the current working directory.
 *
 * A "project" is any directory that is not the user's home directory.
 * The project name is the directory's basename.
 * Project-scoped memory is stored at ~/.pi/agent/<projectName>/.
 */
export function detectProject(cwd?: string): ProjectInfo {
  const dir = cwd ?? process.cwd();
  const homeDir = os.homedir();

  // Normalize paths for comparison
  const resolved = path.resolve(dir);
  const resolvedHome = path.resolve(homeDir);

  if (resolved === resolvedHome || resolved === "/" || !resolved || resolved === resolvedHome + "/") {
    return { name: null, memoryDir: null };
  }

  const name = path.basename(resolved);
  if (!name || name === "." || name === "..") {
    return { name: null, memoryDir: null };
  }

  return {
    name,
    memoryDir: path.join(homeDir, ".pi", "agent", name),
  };
}
