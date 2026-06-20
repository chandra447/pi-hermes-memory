import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChildPiPromptArgs, execChildPrompt, inheritedExtensionArgs, resolveChildPiInvocation } from "../../src/handlers/pi-child-process.js";

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

  it("ignores inherited extension args and always uses own path", () => {
    // The function no longer inherits parent -e flags; it always passes
    // --no-extensions and its own resolved path.
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", {}, ["-e", "src/index.ts"]),
      ["-p", "--no-session", ...EXT_ARGS, "hello"],
    );
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
    assert.deepStrictEqual(calls.map(logicalChildArgs), [
      ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "off", ...EXT_ARGS, "hello"],
      // Retry path (basePromptArgs) also passes --no-extensions + own path.
      ["-p", "--no-session", ...EXT_ARGS, "hello"],
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
      assert.deepStrictEqual(calls.map((call) => call.args.slice(1)), [
        ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "off", ...EXT_ARGS, "hello"],
        ["-p", "--no-session", ...EXT_ARGS, "hello"],
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
