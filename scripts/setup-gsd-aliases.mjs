#!/usr/bin/env node
/**
 * Setup `@gsd/pi-*` package aliases.
 *
 * The extension's source code imports `@gsd/pi-coding-agent`, `@gsd/pi-ai`,
 * `@gsd/pi-tui`, and `@gsd/pi-agent-core` for branding consistency with the
 * GSD fork of Pi. Those packages are not published to the public npm registry
 * yet; the implementation currently still lives at `@earendil-works/pi-*`.
 *
 * Until the `@gsd/pi-*` packages are published, this script creates symlinks
 * under `node_modules/@gsd/` pointing at the corresponding `@earendil-works/`
 * packages so that:
 *
 *   1. Node's CommonJS / ESM resolver finds the package at runtime.
 *   2. TypeScript can resolve the types via `tsconfig.json` `paths`.
 *
 * Run automatically as `postinstall`. Idempotent — re-running is a no-op if
 * the symlink already points at the right target.
 *
 * TODO: remove this script once `@gsd/pi-*` packages are published and
 * `@earendil-works/pi-*` is fully dropped.
 */

import { existsSync, mkdirSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = join(HERE, "..", "node_modules");

const ALIASES = [
  ["pi-coding-agent", "@earendil-works/pi-coding-agent"],
  ["pi-ai", "@earendil-works/pi-ai"],
  ["pi-tui", "@earendil-works/pi-tui"],
  ["pi-agent-core", "@earendil-works/pi-agent-core"],
];

function ensureSymlink(name, target) {
  const aliasDir = join(NODE_MODULES, "@gsd");
  const aliasPath = join(aliasDir, name);
  const targetPath = join(NODE_MODULES, target);

  if (!existsSync(NODE_MODULES)) {
    // Fresh checkout without npm install yet — nothing to do.
    return { skipped: true, reason: "node_modules missing" };
  }

  mkdirSync(aliasDir, { recursive: true });

  if (!existsSync(targetPath)) {
    // Target package isn't installed; skip silently. `npm install` may have
    // skipped optional dependencies or the user may have a custom setup.
    return { skipped: true, reason: `target ${target} not installed` };
  }

  if (existsSync(aliasPath)) {
    try {
      const stat = lstatSync(aliasPath);
      if (stat.isSymbolicLink()) {
        const existing = readlinkSync(aliasPath);
        const expected = join("..", target);
        if (existing === expected) {
          return { skipped: true, reason: "already linked" };
        }
      }
      unlinkSync(aliasPath);
    } catch {
      // fall through to recreate
    }
  }

  symlinkSync(join("..", target), aliasPath, "dir");
  return { linked: true, target };
}

let failed = 0;
for (const [name, target] of ALIASES) {
  try {
    const result = ensureSymlink(name, target);
    if (result.linked) {
      console.log(`[gsd-aliases] @gsd/${name} -> ${target}`);
    }
  } catch (err) {
    console.warn(`[gsd-aliases] failed to alias @gsd/${name}: ${err.message}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.warn(`[gsd-aliases] ${failed} alias(es) could not be set up; runtime may fail until they are created.`);
}
