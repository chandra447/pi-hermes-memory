import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join("scripts", "run-tests.mjs");
const FAKE_TSX = path.join("node_modules", "tsx", "dist", "cli.mjs");

interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Copy the runner into a fixture root with a fake tsx CLI. The runner resolves
 * tsx relative to its own root, so the fixture's stub is what actually runs —
 * no real tests are executed and no network/npx shim is involved.
 */
async function createRunnerFixture(fakeTsxBody: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-tests-"));
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.copyFile(path.join(REPO_ROOT, RUNNER), path.join(root, RUNNER));
  await fs.mkdir(path.join(root, "tests"));
  await fs.writeFile(path.join(root, "tests", "sample.test.ts"), "// executed by the fake tsx\n");
  await fs.mkdir(path.dirname(path.join(root, FAKE_TSX)), { recursive: true });
  await fs.writeFile(path.join(root, FAKE_TSX), fakeTsxBody);
  return root;
}

function runRunner(root: string, env: Record<string, string>): Promise<RunnerResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunnerResult>();
  const child = spawn(process.execPath, [RUNNER], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
  return promise;
}

describe("scripts/run-tests.mjs", () => {
  it("runs every test file and reports success", async () => {
    const root = await createRunnerFixture("process.exit(0);\n");
    try {
      const result = await runRunner(root, { TEST_TIMEOUT: "0" });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /--- tests[\\/]sample\.test\.ts ---/);
      assert.match(result.stdout, /All 1 test files passed/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports a failing file and exits non-zero", async () => {
    const root = await createRunnerFixture("process.exit(3);\n");
    try {
      const result = await runRunner(root, { TEST_TIMEOUT: "0" });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /FAILED \(exit 3\): tests[\\/]sample\.test\.ts/);
      assert.match(result.stderr, /1 of 1 test files failed/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("kills a hung file at TEST_TIMEOUT and names it", async () => {
    const root = await createRunnerFixture("setTimeout(() => process.exit(0), 60_000);\n");
    try {
      const result = await runRunner(root, { TEST_TIMEOUT: "1" });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /TIMEOUT \(>1s\): tests[\\/]sample\.test\.ts/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid and negative timeout values before running tests", async () => {
    const root = await createRunnerFixture("process.exit(0);\n");
    try {
      for (const value of ["-1", "not-a-number"]) {
        const result = await runRunner(root, { TEST_TIMEOUT: value });
        assert.equal(result.code, 2);
        assert.match(result.stderr, new RegExp(`Invalid TEST_TIMEOUT: ${value}`));
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
