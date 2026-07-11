import fs from "node:fs";
import path from "node:path";

const MAX_SYMLINK_DEPTH = 40;

function pathParts(absolutePath: string): { root: string; parts: string[] } {
  const root = path.parse(absolutePath).root;
  return {
    root,
    parts: absolutePath.slice(root.length).split(path.sep).filter(Boolean),
  };
}

export function canonicalStoragePathSync(filePath: string): string {
  const input = path.resolve(filePath);
  let { root, parts } = pathParts(input);
  let current = root;
  let depth = 0;

  while (parts.length > 0) {
    const part = parts.shift()!;
    const candidate = path.join(current, part);
    let state: fs.Stats;
    try {
      state = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path.join(fs.realpathSync.native(current), part, ...parts);
    }

    if (!state.isSymbolicLink()) {
      current = candidate;
      continue;
    }

    if (depth++ >= MAX_SYMLINK_DEPTH) {
      const error = new Error(`Symbolic link loop detected while resolving ${input}`) as NodeJS.ErrnoException;
      error.code = "ELOOP";
      throw error;
    }
    const target = fs.readlinkSync(candidate);
    const targetPath = path.resolve(path.dirname(candidate), target);
    const targetParts = pathParts(targetPath);
    root = targetParts.root;
    current = root;
    parts = [...targetParts.parts, ...parts];
  }

  return fs.realpathSync.native(current);
}

export async function canonicalStoragePath(filePath: string): Promise<string> {
  return canonicalStoragePathSync(filePath);
}
