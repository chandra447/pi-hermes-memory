#!/usr/bin/env node
/**
 * Extract one version's section from CHANGELOG.md, for GitHub Release notes.
 *
 * The CHANGELOG is hand-written, so it stays the source of truth for release
 * notes. The publish workflow calls this and falls back to GitHub's generated
 * notes only when a section is missing.
 *
 * Usage: node scripts/release-notes.mjs <version> [output-file]
 *
 * Exit codes:
 *   0  section found and written
 *   2  bad usage
 *   3  no section for that version (or the section is empty)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2]?.replace(/^v/, "");
const outputFile = process.argv[3];

if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version> [output-file]");
  process.exit(2);
}

const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");
const heading = new RegExp(`^## \\[v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](\\s|$)`);

const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  console.error(`[release-notes] CHANGELOG.md has no "## [${version}]" section.`);
  process.exit(3);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  .join("\n")
  .replace(/\n+---\s*$/, "")
  .trim();

if (!body) {
  console.error(`[release-notes] The "## [${version}]" CHANGELOG section is empty.`);
  process.exit(3);
}

const notes = `${body}\n`;
if (outputFile) writeFileSync(outputFile, notes);
else process.stdout.write(notes);
