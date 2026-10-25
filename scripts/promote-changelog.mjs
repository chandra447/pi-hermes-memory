#!/usr/bin/env node
/**
 * Promote the CHANGELOG's [Unreleased] section into a release section.
 *
 * Turns:
 *   ## [Unreleased]
 *   <entries>
 * into:
 *   ## [Unreleased]
 *
 *   ## [0.9.11] - 2026-10-11
 *   <entries>
 *
 * The entries themselves are never rewritten — they stay hand-written.
 *
 * Usage: node scripts/promote-changelog.mjs <version> [--date YYYY-MM-DD] [--check]
 *   --check  verify the promotion would succeed, print the result, write nothing
 *
 * Exit codes:
 *   0  promoted (or --check passed)
 *   2  bad usage
 *   3  no [Unreleased] section
 *   4  the [Unreleased] section has no entries
 *   5  the version already has a section
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = join(root, "CHANGELOG.md");

const args = process.argv.slice(2);
let check = false;
let version = "";
let date = "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--check") check = true;
  else if (arg === "--date") date = args[++i] ?? "";
  else version = arg;
}
version = version.replace(/^v/, "");
if (!date) date = new Date().toISOString().slice(0, 10);

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/promote-changelog.mjs <version> [--date YYYY-MM-DD] [--check]");
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`[promote-changelog] Invalid --date "${date}". Expected YYYY-MM-DD.`);
  process.exit(2);
}

const lines = readFileSync(changelogPath, "utf8").split("\n");
const unreleased = lines.findIndex((line) => /^## \[Unreleased\]\s*$/.test(line));

if (unreleased === -1) {
  console.error('[promote-changelog] CHANGELOG.md has no "## [Unreleased]" heading.');
  process.exit(3);
}
if (lines.some((line) => new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`).test(line))) {
  console.error(`[promote-changelog] CHANGELOG.md already has a "## [${version}]" section.`);
  process.exit(5);
}

// The released section is everything between [Unreleased] and the next heading.
let end = lines.length;
for (let i = unreleased + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i])) {
    end = i;
    break;
  }
}
const entries = lines
  .slice(unreleased + 1, end)
  .filter((line) => line.trim() !== "" && line.trim() !== "---");

if (entries.length === 0) {
  console.error(`[promote-changelog] The [Unreleased] section has no entries to release as ${version}.`);
  process.exit(4);
}

const promoted = [
  ...lines.slice(0, unreleased + 1),
  "",
  `## [${version}] - ${date}`,
  ...lines.slice(unreleased + 1),
];

if (check) {
  console.log(`[promote-changelog] Would insert "## [${version}] - ${date}" below [Unreleased] (${entries.length} entries).`);
  process.exit(0);
}

writeFileSync(changelogPath, promoted.join("\n"));
console.log(`[promote-changelog] Promoted ${entries.length} entries to "## [${version}] - ${date}".`);
