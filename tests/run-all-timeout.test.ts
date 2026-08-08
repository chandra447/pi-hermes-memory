import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function createRunnerFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-all-timeout-"));
  await fs.mkdir(path.join(root, "tests"));
  await fs.copyFile(
    path.join(REPO_ROOT, "tests/run-all.sh"),
    path.join(root, "tests/run-all.sh"),
  );
  await fs.writeFile(path.join(root, "tests/sample.test.ts"), "// executed by the test double\n");
  return root;
}

async function writeExecutable(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

function runRunner(root: string, env: Record<string, string>): Promise<RunnerResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunnerResult>();
  const child = spawn("bash", ["tests/run-all.sh"], {
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

describe("tests/run-all.sh timeout guard", () => {
  it("accepts TEST_TIMEOUT=0 and preserves the no-timeout fallback", async () => {
    const root = await createRunnerFixture();
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await writeExecutable(path.join(bin, "npx"), "#!/bin/sh\nexit 0\n");
    try {
      const result = await runRunner(root, {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TEST_TIMEOUT: "0",
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /All 1 test files passed/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports the timed-out file and requests forced process-tree cleanup", async () => {
    const root = await createRunnerFixture();
    const bin = path.join(root, "bin");
    const timeoutArgs = path.join(root, "timeout-args");
    await fs.mkdir(bin);
    await writeExecutable(path.join(bin, "npx"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(bin, "timeout"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${timeoutArgs}"\nexit 124\n`,
    );
    try {
      const result = await runRunner(root, {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TEST_TIMEOUT: "0.1",
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, />0\.1s\): tests\/sample\.test\.ts/);
      assert.deepEqual(
        (await fs.readFile(timeoutArgs, "utf8")).trim().split("\n").slice(0, 2),
        ["--kill-after=5s", "0.1"],
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid and negative timeout values before running tests", async () => {
    const root = await createRunnerFixture();
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
