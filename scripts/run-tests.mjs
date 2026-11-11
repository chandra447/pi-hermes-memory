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
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = join(root, "tests");
// Spawn the tsx CLI through node directly: Windows refuses to spawn .cmd shims
// without `shell: true` (EINVAL), and shell mode would reintroduce quoting bugs.
const TSX_CLI = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const DEFAULT_TIMEOUT_SECONDS = "120";

const requestedTimeout = (process.env.TEST_TIMEOUT ?? "").trim();
const timeoutSeconds = requestedTimeout === "" ? DEFAULT_TIMEOUT_SECONDS : requestedTimeout;
// Same grammar as the shell runner it replaces: whole or fractional seconds.
if (!/^[0-9]+([.][0-9]+)?$/.test(timeoutSeconds)) {
  console.error(`Invalid TEST_TIMEOUT: ${process.env.TEST_TIMEOUT} (expected a non-negative number of seconds)`);
  process.exit(2);
}
const TIMEOUT_MS = Number(timeoutSeconds) * 1000;

for (const [label, target] of [
  ["tests directory", TESTS_DIR],
  ["tsx CLI", TSX_CLI],
]) {
  if (existsSync(target)) continue;
  console.error(`Cannot run the suite: missing ${label} at ${target}. Run \`npm install\` first.`);
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
  return files.sort();
}

/**
 * Kill the child and anything it spawned.
 *
 * On POSIX the child is the tsx CLI, and the real `node --test` process (plus
 * its isolation worker) are its descendants, so signalling the child alone
 * leaves the test running: the whole process group the detached spawn created
 * has to be signalled, which is what `timeout --kill-after` used to do. Windows
 * has no process groups; `taskkill /T` walks the tree instead.
 */
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runTestFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, "--test", file], {
      cwd: root,
      stdio: "inherit",
      // Detach on POSIX so the timeout can signal the whole tree, not just tsx.
      detached: process.platform !== "win32",
    });
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

const tests = collectTests(TESTS_DIR);
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
