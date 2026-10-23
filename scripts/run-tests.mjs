#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 * Replaces `tests/run-all.sh`. `npm test` shells out to `cmd.exe` on Windows,
 * which cannot execute a `.sh` file at all (`'tests' is not recognized`), so the
 * shell runner made the suite unrunnable for Windows contributors even though
 * the extension itself supports Windows.
 *
 * One process per test file, same as the shell runner: `node:test` hangs when
 * many files share a single process.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT ?? 120) * 1000;
// Spawn the tsx CLI through node directly: Windows refuses to spawn .cmd shims
// without `shell: true` (EINVAL), and shell mode would reintroduce quoting bugs.
const TSX_CLI = join(root, "node_modules", "tsx", "dist", "cli.mjs");

if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS < 0) {
  console.error(`Invalid TEST_TIMEOUT: ${process.env.TEST_TIMEOUT} (expected a non-negative number of seconds)`);
  process.exit(2);
}

/** Collect every *.test.ts under a directory, sorted for stable output. */
function collectTests(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTests(full));
    else if (entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

/** Kill the child and anything it spawned (npx wraps node on both platforms). */
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

function runTestFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, "--test", file], { cwd: root, stdio: "inherit" });
    let timedOut = false;
    const timer = TIMEOUT_MS > 0
      ? setTimeout(() => { timedOut = true; killTree(child); }, TIMEOUT_MS)
      : null;
    const finish = (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, timedOut });
    };
    child.on("error", (error) => {
      console.error(`Failed to start test runner for ${file}: ${error.message}`);
      finish(1);
    });
    child.on("exit", (code) => finish(code ?? 1));
  });
}

const tests = collectTests(join(root, "tests"));
const failures = [];
let passed = 0;

for (const file of tests) {
  const label = relative(root, file);
  console.log(`--- ${label} ---`);
  const { code, timedOut } = await runTestFile(file);
  if (code === 0) {
    passed++;
    continue;
  }
  failures.push(label);
  console.log(timedOut
    ? `TIMEOUT (>${TIMEOUT_MS / 1000}s): ${label}`
    : `FAILED (exit ${code}): ${label}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${tests.length} test files failed:`);
  for (const label of failures) console.error(`  - ${label}`);
  process.exit(1);
}

console.log(`\nAll ${passed} test files passed`);
