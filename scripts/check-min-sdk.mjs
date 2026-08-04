#!/usr/bin/env node
/**
 * Type-check the extension against the OLDEST Pi SDK we claim to support.
 *
 * Why this exists: `peerDependencies` is the only thing telling a user whether
 * this extension works on their Pi, and nothing verified it. The declared floor
 * had drifted to `>=0.74.0` while `src/handlers/review-memory-ops.ts` imports
 * `@earendil-works/pi-ai/compat`, a subpath that does not exist before 0.80.1 —
 * so anyone on 0.74-0.79.x got ERR_PACKAGE_PATH_NOT_EXPORTED and no extension
 * at all, with nothing in CI to catch it.
 *
 * The regular `check` job structurally cannot catch this: it installs whatever
 * the devDependency range resolves to, which is always new enough.
 *
 * Run: node scripts/check-min-sdk.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "@earendil-works";
// pi-tui is a direct dependency rather than a peer, but its types cross the
// boundary (ExtensionCommandContext.ui.custom takes a pi-tui TUI). Leaving it
// at a different version yields a duplicate-private-property error instead of
// a real finding, so it moves with the floor.
const FLOOR_PACKAGES = [`${SCOPE}/pi-coding-agent`, `${SCOPE}/pi-ai`, `${SCOPE}/pi-tui`];

const scopeDir = path.join(repoRoot, "node_modules", SCOPE);
const stashDir = path.join(repoRoot, "node_modules", `${SCOPE}.real`);

function restore() {
  // Idempotent: safe to call from the finally block and from signal handlers.
  try {
    if (existsSync(stashDir)) {
      if (existsSync(scopeDir)) unlinkSync(scopeDir);
      renameSync(stashDir, scopeDir);
    }
  } catch (error) {
    console.error(
      `\nFAILED TO RESTORE node_modules/${SCOPE}. Run: mv "${stashDir}" "${scopeDir}"\n`,
      error,
    );
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const range = pkg.peerDependencies?.[`${SCOPE}/pi-coding-agent`];
const floor = /(\d+\.\d+\.\d+)/.exec(range ?? "")?.[1];
if (!floor) {
  console.error(`peerDependencies range "${range}" has no explicit floor — pin one like ">=0.80.1"`);
  process.exit(1);
}

console.log(`Minimum supported ${SCOPE}/pi-coding-agent: ${floor}`);

const scratch = mkdtempSync(path.join(tmpdir(), "pi-hermes-min-sdk-"));
let failed = false;
try {
  writeFileSync(path.join(scratch, "package.json"), `${JSON.stringify({ name: "min-sdk-probe", private: true })}\n`);
  const specs = FLOOR_PACKAGES.map((name) => `${name}@${floor}`);
  console.log(`Installing ${specs.join(" ")} ...`);
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--no-package-lock", ...specs], {
    cwd: scratch,
    stdio: ["ignore", "ignore", "inherit"],
  });

  // Swap the scope in place so the project's own tsconfig applies unchanged —
  // no divergent probe config that could drift from what `npm run check` uses.
  renameSync(scopeDir, stashDir);
  symlinkSync(path.join(scratch, "node_modules", SCOPE), scopeDir);

  console.log("Type-checking src against the minimum SDK ...");
  execFileSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["--noEmit"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  console.log(`OK — src type-checks against ${SCOPE}/pi-coding-agent@${floor}`);
} catch (error) {
  failed = true;
  if (!/Command failed/.test(String(error?.message))) console.error(error);
  console.error(
    `\nsrc does NOT type-check against the declared minimum (${floor}).\n`
    + "Either raise the peerDependencies floor in package.json to a version that works,\n"
    + "or stop using the SDK API that is missing at that version.\n",
  );
} finally {
  restore();
  rmSync(scratch, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
