import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runDirectMemoryCompletion } from "../../src/handlers/review-memory-ops.js";
import {
  buildChildPiPromptArgs,
  detectAuthAdapterExtensionPaths,
} from "../../src/handlers/pi-child-process.js";

function mockModel(reasoning: boolean): Model<Api> {
  return {
    id: "test-model",
    provider: "test",
    api: "openai-completions",
    reasoning,
  } as Model<Api>;
}

const OWN_EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/index.ts",
);
const DETECTED_ADAPTER_ARGS = detectAuthAdapterExtensionPaths().flatMap((p) => ["-e", p]);
const EXT_ARGS = ["--no-extensions", "-e", OWN_EXTENSION_PATH, ...DETECTED_ADAPTER_ARGS];

describe("llmThinkingOverride max", () => {
  it("forwards llmThinkingOverride max as the direct completion reasoning option", async () => {
    const modelRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "sk-test" }),
      getAll: () => [mockModel(true)],
      getAvailable: () => [mockModel(true)],
    };
    let reasoning: unknown;
    const complete = async (_model: unknown, _request: unknown, options: { reasoning?: string }) => {
      reasoning = options.reasoning;
      return {
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({ operations: [] }) }],
      };
    };

    const result = await runDirectMemoryCompletion(
      { model: mockModel(true), modelRegistry } as never,
      null as never,
      null,
      { userPrompt: "u", systemPrompt: "s", config: { llmThinkingOverride: "max" } },
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(reasoning, "max");
  });

  it("forwards llmThinkingOverride max as --thinking max", () => {
    assert.deepStrictEqual(
      buildChildPiPromptArgs("hello", { llmThinkingOverride: "max" }, []),
      ["-p", "--no-session", "--thinking", "max", ...EXT_ARGS, "hello"],
    );
  });
});
