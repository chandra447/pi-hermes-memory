import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildChildPiPromptArgs,
  detectClaudeOAuthAdapterPaths,
  execChildPrompt,
  inheritedExtensionArgs,
  resolveChildPiInvocation,
} from "../../src/handlers/pi-child-process.js";

function logicalChildArgs(call: { cmd: string; args: string[] }): string[] {
  const expected = resolveChildPiInvocation(call.cmd === "pi" ? call.args : call.args.slice(1));
  assert.strictEqual(call.cmd, expected.command);
  assert.deepStrictEqual(call.args, expected.args);
  return call.cmd === "pi" ? call.args : call.args.slice(1);
}

// Compute the expected OWN_EXTENSION_PATH same logic as pi-child-process.ts
const OWN_EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/index.ts",
);

const EXT_ARGS = ["--no-extensions", "-e", OWN_EXTENSION_PATH];

describe("inheritedExtensionArgs", () => {
  it("captures explicit -e and --extension parent args", () => {
    assert.deepStrictEqual(
      inheritedExtensionArgs(["-e", "src/index.ts", "--extension", "/tmp/other.ts"]),
      ["-e", "src/index.ts", "--extension", "/tmp/other.ts"],
    );
  });

  it("captures --extension=... parent args", () => {
    assert.deepStrictEqual(
      inheritedExtensionArgs(["--extension=src/index.ts"]),
      ["--extension=src/index.ts"],
    );
  });
});

describe("buildChildPiPromptArgs", () => {
  it("uses --no-extensions and only passes hermes-memory extension", () => {
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", {}, []),
      ["-p", "--no-session", ...EXT_ARGS, "hello"],
    );
  });

  it("adds a model override and defaults thinking to off", () => {
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", { llmModelOverride: "openrouter/deepseek/deepseek-v4-flash" }, []),
      ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "off", ...EXT_ARGS, "hello"],
    );
  });

  it("allows thinking overrides without a model override", () => {
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", { llmThinkingOverride: "low" }, []),
      ["-p", "--no-session", "--thinking", "low", ...EXT_ARGS, "hello"],
    );
  });

  it("ignores missing inherited extension paths", () => {
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", {}, ["-e", "src/index.ts"]),
      ["-p", "--no-session", ...EXT_ARGS, "hello"],
    );
  });

  it("passes configured extensions but excludes unrelated inherited extensions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-child-extensions-"));
    const configured = path.join(dir, "configured.ts");
    const inherited = path.join(dir, "inherited.ts");
    await fs.writeFile(configured, "export default () => {};");
    await fs.writeFile(inherited, "export default () => {};");
    try {
      assert.deepStrictEqual(
        buildChildPiPromptArgs("hello", {
          childExtensionPaths: [configured, configured, "/missing/adapter.ts", OWN_EXTENSION_PATH],
        }, ["-e", inherited, `--extension=${configured}`]),
        [
          "-p", "--no-session", "--no-extensions",
          "-e", OWN_EXTENSION_PATH,
          "-e", configured,
          "hello",
        ],
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects a sibling pi-claude-oauth-adapter extension", async () => {
    const nodeModules = await fs.mkdtemp(path.join(os.tmpdir(), "pi-node-modules-"));
    const ownPath = path.join(nodeModules, "pi-hermes-memory", "src", "index.ts");
    const adapterPath = path.join(nodeModules, "pi-claude-oauth-adapter", "extensions", "index.ts");
    await fs.mkdir(path.dirname(ownPath), { recursive: true });
    await fs.mkdir(path.dirname(adapterPath), { recursive: true });
    await fs.writeFile(ownPath, "export default () => {};");
    await fs.writeFile(adapterPath, "export default () => {};");
    try {
      assert.deepStrictEqual(detectClaudeOAuthAdapterPaths(ownPath), [adapterPath]);
    } finally {
      await fs.rm(nodeModules, { recursive: true, force: true });
    }
  });
});

describe("resolveChildPiInvocation", () => {
  it("keeps non-Windows child pi invocations unchanged", () => {
    const args = ["-p", "--no-session", "hello"];

    assert.deepStrictEqual(
      resolveChildPiInvocation(args, { platform: "linux" }),
      { command: "pi", args },
    );
  });

  it("runs node.exe with cli.js first on Windows when a Pi CLI path is available", () => {
    assert.deepStrictEqual(
      resolveChildPiInvocation(["-p", "--no-session", "hello"], {
        platform: "win32",
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        piCliPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
      }),
      {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [
          "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
          "-p",
          "--no-session",
          "hello",
        ],
      },
    );
  });

  it("falls back to the existing pi invocation on Windows if cli.js cannot be resolved", () => {
    const args = ["-p", "--no-session", "hello"];

    assert.deepStrictEqual(
      resolveChildPiInvocation(args, { platform: "win32", piCliPath: null }),
      { command: "pi", args },
    );
  });
});

describe("execChildPrompt", () => {
  it("keeps a sensitive prompt out of argv and removes its mode-0600 temporary file", async () => {
    const secret = "PRIVATE-MEMORY-CONTENT";
    let promptPath = "";
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        assert.ok(args.every((arg) => !arg.includes(secret)), "child argv must not contain prompt content");
        const promptArg = args.at(-1)!;
        assert.match(promptArg, /^@/);
        promptPath = promptArg.slice(1);
        assert.equal(await fs.readFile(promptPath, "utf-8"), secret);
        assert.equal((await fs.stat(promptPath)).mode & 0o777, 0o600);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    };

    const result = await execChildPrompt(pi as any, secret, {}, { timeoutMs: 30000 });

    assert.equal(result.code, 0);
    await assert.rejects(fs.access(promptPath), { code: "ENOENT" });
    await assert.rejects(fs.access(path.dirname(promptPath)), { code: "ENOENT" });
  });

  it("removes the temporary prompt file when child execution throws", async () => {
    let promptPath = "";
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        promptPath = args.at(-1)!.slice(1);
        assert.equal(await fs.readFile(promptPath, "utf-8"), "secret failure prompt");
        throw new Error("child failed");
      },
    };

    await assert.rejects(
      execChildPrompt(pi as any, "secret failure prompt", {}, { timeoutMs: 30000 }),
      /child failed/,
    );

    assert.ok(promptPath.startsWith(os.tmpdir()));
    await assert.rejects(fs.access(promptPath), { code: "ENOENT" });
  });

  it("returns a successful child result when temporary cleanup fails", async () => {
    let cleanupCalls = 0;
    let promptDirectory = "";
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        promptDirectory = path.dirname(args.at(-1)!.slice(1));
        return { code: 0, stdout: "completed", stderr: "" };
      },
    };

    try {
      const result = await execChildPrompt(
        pi as any,
        "cleanup failure prompt",
        {},
        { timeoutMs: 30000 },
        {
          removeTemporaryDirectory: async () => {
            cleanupCalls++;
            throw new Error("cleanup denied");
          },
        },
      );

      assert.equal(result.code, 0);
      assert.equal(result.stdout, "completed");
      assert.equal(cleanupCalls, 1);
    } finally {
      if (promptDirectory) await fs.rm(promptDirectory, { recursive: true, force: true });
    }
  });

  it("passes configured auth adapters to both override attempts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-child-auth-"));
    const adapterPath = path.join(dir, "adapter.ts");
    await fs.writeFile(adapterPath, "export default () => {};");
    const calls: string[][] = [];
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        calls.push(args);
        return calls.length === 1
          ? { code: 1, stdout: "", stderr: "model not found" }
          : { code: 0, stdout: "ok", stderr: "" };
      },
    };
    try {
      await execChildPrompt(pi as any, "hello", {
        llmModelOverride: "missing/model",
        childExtensionPaths: [adapterPath],
      }, { timeoutMs: 30000, retryWithoutOverrides: true });

      assert.equal(calls.length, 2);
      for (const args of calls) {
        const index = args.indexOf(adapterPath);
        assert.ok(index > 0);
        assert.equal(args[index - 1], "-e");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes unrelated inherited extensions from primary and retry attempts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-child-untrusted-"));
    const inherited = path.join(dir, "unrelated-extension.ts");
    await fs.writeFile(inherited, "export default () => {};");
    const originalArgv = process.argv;
    const calls: string[][] = [];
    process.argv = [originalArgv[0], originalArgv[1], "-e", inherited];
    try {
      await execChildPrompt({
        exec: async (_cmd: string, args: string[]) => {
          calls.push(args);
          return calls.length === 1
            ? { code: 1, stderr: "model not found" }
            : { code: 0, stdout: "ok" };
        },
      } as any, "private review", {
        llmModelOverride: "missing/model",
      }, { timeoutMs: 30000, retryWithoutOverrides: true });

      assert.equal(calls.length, 2);
      for (const args of calls) {
        assert.equal(args.includes(inherited), false);
        assert.ok(args.includes("--no-extensions"));
      }
    } finally {
      process.argv = originalArgv;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retries once without overrides when requested and the override subprocess fails for model resolution reasons", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (calls.length === 1) {
          return { code: 1, stdout: "", stderr: "model not found" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      },
    };

    const result = await execChildPrompt(pi as any, "hello", {
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
    }, {
      timeoutMs: 30000,
      retryWithoutOverrides: true,
    });

    assert.strictEqual(result.code, 0);
    const logicalCalls = calls.map(logicalChildArgs);
    const promptReference = logicalCalls[0].at(-1)!;
    assert.match(promptReference, /^@/);
    assert.deepStrictEqual(logicalCalls, [
      ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "off", ...EXT_ARGS, promptReference],
      // Retry path (basePromptArgs) also passes --no-extensions + own path.
      ["-p", "--no-session", ...EXT_ARGS, promptReference],
    ]);
  });

  it("uses the resolved Windows node.exe invocation for both override retry attempts", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const pi = {
        exec: async (cmd: string, args: string[]) => {
          calls.push({ cmd, args });
          if (calls.length === 1) {
            return { code: 1, stdout: "", stderr: "model not found" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
      };

      const result = await execChildPrompt(pi as any, "hello", {
        llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
      }, {
        timeoutMs: 30000,
        retryWithoutOverrides: true,
      });

      assert.strictEqual(result.code, 0);
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0].cmd, process.execPath);
      assert.strictEqual(calls[1].cmd, process.execPath);
      assert.match(calls[0].args[0].replace(/\\/g, "/"), /\/cli\.js$/);
      assert.match(calls[1].args[0].replace(/\\/g, "/"), /\/cli\.js$/);
      const promptReference = calls[0].args.at(-1)!;
      assert.match(promptReference, /^@/);
      assert.deepStrictEqual(calls.map((call) => call.args.slice(1)), [
        ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "off", ...EXT_ARGS, promptReference],
        ["-p", "--no-session", ...EXT_ARGS, promptReference],
      ]);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("does not retry generic non-zero child failures that are unrelated to override resolution", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { code: 1, stdout: "", stderr: "memory tool returned no changes" };
      },
    };

    const result = await execChildPrompt(pi as any, "hello", {
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
    }, {
      timeoutMs: 30000,
      retryWithoutOverrides: true,
    });

    assert.strictEqual(result.code, 1);
    assert.strictEqual(calls.length, 1);
  });

  it("does not retry generic thrown errors that are unrelated to override resolution", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        throw new Error("timed out waiting for child process");
      },
    };

    await assert.rejects(
      () => execChildPrompt(pi as any, "hello", {
        llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
      }, {
        timeoutMs: 30000,
        retryWithoutOverrides: true,
      }),
      /timed out waiting for child process/,
    );

    assert.strictEqual(calls.length, 1);
  });

  it("does not retry when retryWithoutOverrides is false", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { code: 1, stdout: "", stderr: "model not found" };
      },
    };

    const result = await execChildPrompt(pi as any, "hello", {
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
    }, {
      timeoutMs: 30000,
      retryWithoutOverrides: false,
    });

    assert.strictEqual(result.code, 1);
    assert.strictEqual(calls.length, 1);
  });
});
