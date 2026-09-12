import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../src/store/memory-store.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  applyReviewOperations,
  buildDirectReviewCompletionOptions,
  isAuthRejection,
  parseReviewOperations,
  runDirectMemoryCompletion,
} from "../../src/handlers/review-memory-ops.js";
import { DatabaseManager } from "../../src/store/db.js";
import { getMemories, reconcileMarkdownMemoryScope } from "../../src/store/sqlite-memory-store.js";
import { acquireMarkdownMutationLock } from "../../src/store/markdown-mutation-lock.js";
import {
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
  DIRECT_CORRECTION_SYSTEM_PROMPT,
  DIRECT_FLUSH_SYSTEM_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
  MEMORY_FILE,
} from "../../src/constants.js";

function mockModel(reasoning: boolean): Model<Api> {
  return {
    id: "test-model",
    provider: "test",
    api: "openai-completions",
    reasoning,
  } as Model<Api>;
}

describe("buildDirectReviewCompletionOptions", () => {
  it("forwards auth env and preserves reasoning level", () => {
    const signal = new AbortController().signal;
    const options = buildDirectReviewCompletionOptions(
      mockModel(true),
      {
        apiKey: "sk-test",
        headers: { "X-Test": "1" },
        env: { CUSTOM_BASE_URL: "https://proxy.example" },
      },
      "minimal",
      signal,
    );

    assert.strictEqual(options.apiKey, "sk-test");
    assert.deepStrictEqual(options.headers, { "X-Test": "1" });
    assert.deepStrictEqual(options.env, { CUSTOM_BASE_URL: "https://proxy.example" });
    assert.strictEqual(options.reasoning, "minimal");
    assert.strictEqual(options.signal, signal);
  });

  it("omits reasoning when thinking is off or model does not support it", () => {
    const signal = new AbortController().signal;
    const off = buildDirectReviewCompletionOptions(
      mockModel(true),
      { apiKey: "sk-test" },
      "off",
      signal,
    );
    const nonReasoning = buildDirectReviewCompletionOptions(
      mockModel(false),
      { apiKey: "sk-test" },
      "high",
      signal,
    );

    assert.strictEqual(off.reasoning, undefined);
    assert.strictEqual(nonReasoning.reasoning, undefined);
  });
});

describe("provider auth resolution", () => {
  function registryWithAuthResponses(...keys: string[]) {
    let authCalls = 0;
    const modelRegistry = {
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: keys[Math.min(authCalls++, keys.length - 1)],
      }),
      getAll: () => [mockModel(false)],
      getAvailable: () => [mockModel(false)],
    };
    return { get authCalls() { return authCalls; }, modelRegistry };
  }

  function completionStub(behaviour: (apiKey: string | undefined, attempt: number) => unknown) {
    const usedKeys: Array<string | undefined> = [];
    const complete = async (_model: unknown, _request: unknown, options: { apiKey?: string }) => {
      usedKeys.push(options.apiKey);
      const outcome = behaviour(options.apiKey, usedKeys.length);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    return { usedKeys, complete };
  }

  function registryWithHeaderAuth(...headers: Array<Record<string, string | null>>) {
    let authCalls = 0;
    return {
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        headers: headers[Math.min(authCalls++, headers.length - 1)],
      }),
      getAll: () => [mockModel(false)],
      getAvailable: () => [mockModel(false)],
      get authCalls() { return authCalls; },
    };
  }

  const emptyOperations = {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ operations: [] }) }],
  };

  function directOptions() {
    return { userPrompt: "u", systemPrompt: "s", config: {} };
  }

  async function runReview(modelRegistry: unknown, complete: unknown) {
    return runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );
  }

  it("resolves credentials through the public registry API", async () => {
    const registry = registryWithAuthResponses("current-key");
    const { usedKeys, complete } = completionStub(() => emptyOperations);

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry: registry.modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(registry.authCalls, 1);
    assert.deepStrictEqual(usedKeys, ["current-key"]);
  });

  it("runs direct review with header-only OAuth request auth", async () => {
    const headers = {
      Authorization: "Bearer kimi-oauth-token",
      "User-Agent": "pi-coding-agent",
      "X-Drop": null,
    };
    const usedHeaders: Array<Record<string, string | null> | undefined> = [];
    const complete = async (_model: unknown, _request: unknown, options: { headers?: Record<string, string | null> }) => {
      usedHeaders.push(options.headers);
      return emptyOperations;
    };

    const result = await runReview(registryWithHeaderAuth(headers), complete);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(usedHeaders, [headers]);
  });

  for (const { name, headers } of [
    { name: "empty headers", headers: {} },
    { name: "User-Agent-only headers", headers: { "User-Agent": "pi-coding-agent" } },
    { name: "null credential headers", headers: { Authorization: null, "x-api-key": null } },
  ]) {
    it(`rejects ${name} as missing request authentication`, async () => {
      let completionCalls = 0;
      const complete = async () => {
        completionCalls++;
        return emptyOperations;
      };

      const result = await runReview(registryWithHeaderAuth(headers), complete);

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.fallbackReason, "no_auth");
      assert.strictEqual(completionCalls, 0);
    });
  }

  it("re-resolves credentials after a provider auth rejection", async () => {
    const { modelRegistry } = registryWithAuthResponses("revoked-key", "rotated-key");
    const { usedKeys, complete } = completionStub((_key, attempt) => {
      if (attempt > 1) return emptyOperations;
      return new Error("HTTP 401 Unauthorized: invalid api key");
    });

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(usedKeys, ["revoked-key", "rotated-key"]);
  });

  it("re-resolves rotated header-only OAuth credentials after rejection", async () => {
    const usedHeaders: Array<Record<string, string> | undefined> = [];
    const complete = async (_model: unknown, _request: unknown, options: { headers?: Record<string, string> }) => {
      usedHeaders.push(options.headers);
      if (usedHeaders.length === 1) throw new Error("HTTP 401 Unauthorized: token expired");
      return emptyOperations;
    };
    const modelRegistry = registryWithHeaderAuth(
      { Authorization: "Bearer stale-token" },
      { Authorization: "Bearer fresh-token" },
    );

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(usedHeaders, [
      { Authorization: "Bearer stale-token" },
      { Authorization: "Bearer fresh-token" },
    ]);
  });

  it("does not retry when the refreshed key is the same one the provider rejected", async () => {
    const { modelRegistry } = registryWithAuthResponses("only-key");
    const { usedKeys, complete } = completionStub(() => new Error("HTTP 401 Unauthorized"));

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.fallbackReason, "provider_error");
    assert.strictEqual(usedKeys.length, 1, "an unchanged key means a real auth problem, not a rotation race");
  });

  it("does not retry an unchanged header-only OAuth credential", async () => {
    let completionCalls = 0;
    const complete = async () => {
      completionCalls++;
      throw new Error("HTTP 401 Unauthorized");
    };
    const modelRegistry = registryWithHeaderAuth({ Authorization: "Bearer unchanged-token" });

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.fallbackReason, "provider_error");
    assert.strictEqual(completionCalls, 1);
  });

  it("rotates header-only auth after an error assistant 401 response", async () => {
    const usedHeaders: Array<Record<string, string | null> | undefined> = [];
    const complete = async (_model: unknown, _request: unknown, options: { headers?: Record<string, string | null> }) => {
      usedHeaders.push(options.headers);
      if (usedHeaders.length === 1) {
        return { stopReason: "error", errorMessage: "HTTP 401 Unauthorized: token expired" };
      }
      return emptyOperations;
    };
    const modelRegistry = registryWithHeaderAuth(
      { Authorization: "Bearer stale-token" },
      { Authorization: "Bearer fresh-token" },
    );

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(usedHeaders, [
      { Authorization: "Bearer stale-token" },
      { Authorization: "Bearer fresh-token" },
    ]);
  });

  it("does not retry when only the credential header name casing changed", async () => {
    let completionCalls = 0;
    const complete = async () => {
      completionCalls++;
      throw new Error("HTTP 401 Unauthorized");
    };
    const modelRegistry = registryWithHeaderAuth(
      { Authorization: "Bearer same-token" },
      { authorization: "Bearer same-token" },
    );

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.fallbackReason, "provider_error");
    assert.strictEqual(completionCalls, 1);
  });

  it("retries once when a duplicate-case credential header value changes", async () => {
    const stale = { Authorization: "Bearer stale", authorization: "Bearer shared" };
    const fresh = { Authorization: "Bearer fresh", authorization: "Bearer shared" };
    const usedHeaders: Array<Record<string, string | null> | undefined> = [];
    const complete = async (_model: unknown, _request: unknown, options: { headers?: Record<string, string | null> }) => {
      usedHeaders.push(options.headers);
      if (usedHeaders.length === 1) {
        return { stopReason: "error", errorMessage: "HTTP 401 Unauthorized: token expired" };
      }
      return emptyOperations;
    };
    const modelRegistry = registryWithHeaderAuth(stale, fresh);

    const result = await runReview(modelRegistry, complete);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(modelRegistry.authCalls, 2);
    assert.deepStrictEqual(usedHeaders, [stale, fresh]);
  });

  it("returns provider_error after a second auth failure without a third completion", async () => {
    let completionCalls = 0;
    const complete = async () => {
      completionCalls++;
      if (completionCalls <= 2) {
        return { stopReason: "error", errorMessage: "HTTP 401 Unauthorized" };
      }
      return emptyOperations;
    };
    const modelRegistry = registryWithHeaderAuth(
      { Authorization: "Bearer stale-token" },
      { Authorization: "Bearer still-bad-token" },
      { Authorization: "Bearer should-not-be-used" },
    );

    const result = await runReview(modelRegistry, complete);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.fallbackReason, "provider_error");
    assert.strictEqual(completionCalls, 2);
    assert.strictEqual(modelRegistry.authCalls, 2);
  });

  it("classifies provider auth rejections without swallowing other failures", () => {
    for (const message of [
      "HTTP 401 Unauthorized",
      "403 Forbidden",
      "invalid_api_key",
      "Invalid API key provided",
      "authentication failed",
      "token expired",
      "subscription key revoked",
    ]) {
      assert.strictEqual(isAuthRejection(message), true, message);
    }

    for (const message of [
      "HTTP 500 Internal Server Error",
      "429 rate limit exceeded",
      "socket hang up",
      "context length exceeded",
    ]) {
      assert.strictEqual(isAuthRejection(message), false, message);
    }
  });
});

describe("fallback model chain", () => {
  function twoModelRegistry() {
    const m1 = { id: "m1", provider: "p1", api: "openai-completions", reasoning: false } as Model<Api>;
    const m2 = { id: "m2", provider: "p2", api: "openai-completions", reasoning: false } as Model<Api>;
    let authCalls = 0;
    const registry = {
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return { ok: true as const, apiKey: "k" };
      },
      getAll: () => [m1, m2],
      getAvailable: () => [m1, m2],
    };
    return { registry, get authCalls() { return authCalls; } };
  }

  function chainOptions(signal?: AbortSignal) {
    return {
      userPrompt: "u",
      systemPrompt: "s",
      config: { llmModelOverride: "p1/m1", llmFallbackModels: ["p2/m2"] },
      ...(signal ? { signal } : {}),
    };
  }

  const emptyReview = {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ operations: [] }) }],
  };

  it("stops the chain when the caller aborts instead of trying the next model", async () => {
    const caller = new AbortController();
    const attempted: string[] = [];
    const complete = async (model: Model<Api>) => {
      attempted.push(model.id);
      caller.abort();
      return { stopReason: "aborted" };
    };
    const chain = twoModelRegistry();

    const result = await runDirectMemoryCompletion(
      { model: undefined, modelRegistry: chain.registry } as never,
      null as never,
      null,
      chainOptions(caller.signal),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.fallbackReason, "aborted");
    assert.deepStrictEqual(attempted, ["m1"]);
    assert.strictEqual(chain.authCalls, 1);
  });

  it("still tries the next model after a per-model timeout while the caller is alive", async () => {
    const caller = new AbortController();
    const attempted: string[] = [];
    const complete = async (model: Model<Api>) => {
      attempted.push(model.id);
      if (attempted.length === 1) return { stopReason: "aborted" };
      return emptyReview;
    };

    const chain = twoModelRegistry();
    const result = await runDirectMemoryCompletion(
      { model: undefined, modelRegistry: chain.registry } as never,
      null as never,
      null,
      chainOptions(caller.signal),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.deepStrictEqual(attempted, ["m1", "m2"]);
    assert.strictEqual(result.ok, true);
  });
});

describe("parseReviewOperations", () => {
  it("parses valid JSON operations", () => {
    const parsed = parseReviewOperations(JSON.stringify({
      operations: [
        { action: "add", target: "memory", content: "uses pnpm" },
      ],
    }));

    assert.deepStrictEqual(parsed, [
      { action: "add", target: "memory", content: "uses pnpm" },
    ]);
  });

  it("returns empty array for nothing-to-save text", () => {
    assert.deepStrictEqual(parseReviewOperations("Nothing to save."), []);
  });

  it("returns null for invalid JSON", () => {
    assert.strictEqual(parseReviewOperations("not json at all"), null);
  });

  it("extracts JSON from fenced blocks", () => {
    const parsed = parseReviewOperations("```json\n{\"operations\":[{\"action\":\"add\",\"target\":\"user\",\"content\":\"prefers dark mode\"}]}\n```");
    assert.deepStrictEqual(parsed, [
      { action: "add", target: "user", content: "prefers dark mode" },
    ]);
  });

  it("prefers the last operations object when CoT restates the schema first (#197)", () => {
    const parsed = parseReviewOperations(
      'The schema is {"operations":[]} but I will save:\n{"operations":[{"action":"add","target":"user","content":"prefers dark mode"}]}',
    );

    assert.deepStrictEqual(parsed, [
      { action: "add", target: "user", content: "prefers dark mode" },
    ]);
  });

  it("still parses a single object surrounded by prose via the first-to-last slice", () => {
    const parsed = parseReviewOperations(
      'Sure — here it is:\n{"operations":[{"action":"add","target":"user","content":"prefers dark mode"}]}\nDone.',
    );

    assert.deepStrictEqual(parsed, [
      { action: "add", target: "user", content: "prefers dark mode" },
    ]);
  });

  it("returns null when no candidate object carries an operations array", () => {
    assert.strictEqual(parseReviewOperations("checked {\"a\":1} and {\"b\":2} — nothing worth saving"), null);
  });

  it("does not parse live operations out of any direct prompt (schema echo, #197)", () => {
    for (const prompt of [
      DIRECT_REVIEW_SYSTEM_PROMPT,
      DIRECT_FLUSH_SYSTEM_PROMPT,
      DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
      DIRECT_CORRECTION_SYSTEM_PROMPT,
    ]) {
      const parsed = parseReviewOperations(prompt);
      assert.ok(
        parsed === null || parsed.length === 0,
        `direct prompt must not contain a parseable operations example, got ${JSON.stringify(parsed)}`,
      );
    }
  });

  it("parses a trailing answer when a fenced non-ops object comes first (#235)", () => {
    // The fence holds a well-formed object without an `operations` array. It
    // must be declined so the slice/scan paths can reach the real answer —
    // claiming it here would recreate the parse_error → subprocess
    // double-spend on a response that contains a valid answer.
    const parsed = parseReviewOperations(
      '```json\n{"note":"no ops here"}\n```\nFinal:\n{"operations":[{"action":"add","target":"user","content":"real answer"}]}',
    );

    assert.deepStrictEqual(parsed, [
      { action: "add", target: "user", content: "real answer" },
    ]);
  });
});

describe("applyReviewOperations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-ops-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies add operations to memory store", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const result = await applyReviewOperations(store, null, [
      { action: "add", target: "memory", content: "prefers biome over eslint" },
    ]);

    assert.strictEqual(result.appliedCount, 1);
    assert.strictEqual(result.skippedCount, 0);
    assert.ok(store.getMemoryEntries().some((entry) => entry.includes("prefers biome over eslint")));
  });

  it("skips project operations when project store is unavailable", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const result = await applyReviewOperations(store, null, [
      { action: "add", target: "project", content: "api uses /v2" },
    ]);

    assert.strictEqual(result.appliedCount, 0);
    assert.strictEqual(result.skippedCount, 1);
  });

  it("rolls back the entire atomic plan when a later operation fails", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    await store.add("memory", "keep this original entry");
    const memoryPath = path.join(tmpDir, "MEMORY.md");
    const beforeEntries = store.getMemoryEntries();
    const beforeDisk = await fs.readFile(memoryPath, "utf8");

    const result = await applyReviewOperations(
      store,
      null,
      [
        { action: "remove", target: "memory", old_text: "keep this" },
        { action: "remove", target: "memory", old_text: "missing later entry" },
      ],
      null,
      null,
      { requireAtomicShrink: true, expectedTarget: "memory" },
    );

    assert.strictEqual(result.appliedCount, 0);
    assert.strictEqual(result.skippedCount, 2);
    assert.match(result.error ?? "", /No entry matched 'missing later entry'/);
    assert.deepStrictEqual(store.getMemoryEntries(), beforeEntries);
    assert.strictEqual(await fs.readFile(memoryPath, "utf8"), beforeDisk);
  });

  it("refuses an atomic review replacement that would discard sibling facts", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    await store.add("user", "Name: Cataldo\nOS: Arch Linux\nPreference: concise replies");
    const beforeDisk = await fs.readFile(path.join(tmpDir, "USER.md"), "utf8");

    const result = await applyReviewOperations(
      store,
      null,
      [{ action: "replace", target: "user", old_text: "Name: Cataldo", content: "Name: Aldo" }],
      null,
      null,
      { requireAtomicShrink: true, expectedTarget: "user" },
    );

    assert.deepStrictEqual(
      { appliedCount: result.appliedCount, skippedCount: result.skippedCount },
      { appliedCount: 0, skippedCount: 1 },
    );
    assert.match(result.error ?? "", /Refusing replace/);
    assert.strictEqual(await fs.readFile(path.join(tmpDir, "USER.md"), "utf8"), beforeDisk);
  });

  it("rejects mixed and unexpected atomic targets before mutation", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    await store.add("memory", "global source entry");

    const mixed = await applyReviewOperations(
      store,
      null,
      [
        { action: "remove", target: "memory", old_text: "global source" },
        { action: "remove", target: "user", old_text: "anything" },
      ],
      null,
      null,
      { requireAtomicShrink: true, expectedTarget: "memory" },
    );
    const unexpected = await applyReviewOperations(
      store,
      null,
      [{ action: "remove", target: "memory", old_text: "global source" }],
      null,
      null,
      { requireAtomicShrink: true, expectedTarget: "user" },
    );

    assert.deepStrictEqual(
      { appliedCount: mixed.appliedCount, skippedCount: mixed.skippedCount },
      { appliedCount: 0, skippedCount: 2 },
    );
    assert.match(mixed.error ?? "", /exactly one target/);
    assert.deepStrictEqual(
      { appliedCount: unexpected.appliedCount, skippedCount: unexpected.skippedCount },
      { appliedCount: 0, skippedCount: 1 },
    );
    assert.match(unexpected.error ?? "", /targeted 'memory', expected 'user'/);
    assert.deepStrictEqual(store.getMemoryEntries().map((entry) => entry.replace(/\s*<!--.*$/, "")), [
      "global source entry",
    ]);
  });

  it("rejects an empty atomic plan and an unavailable atomic project store", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const empty = await applyReviewOperations(
      store,
      null,
      [],
      null,
      "project-a",
      { requireAtomicShrink: true, expectedTarget: "project" },
    );
    const unavailable = await applyReviewOperations(
      store,
      null,
      [{ action: "remove", target: "project", old_text: "project source" }],
      null,
      "project-a",
      { requireAtomicShrink: true, expectedTarget: "project" },
    );

    assert.deepStrictEqual(
      { appliedCount: empty.appliedCount, skippedCount: empty.skippedCount },
      { appliedCount: 0, skippedCount: 0 },
    );
    assert.match(empty.error ?? "", /requires at least one operation/i);
    assert.deepStrictEqual(
      { appliedCount: unavailable.appliedCount, skippedCount: unavailable.skippedCount },
      { appliedCount: 0, skippedCount: 1 },
    );
    assert.match(unavailable.error ?? "", /project memory is unavailable/i);
    assert.deepStrictEqual(store.getMemoryEntries(), []);
  });

  it("applies an atomic project plan only to the isolated project store", async () => {
    const globalDir = path.join(tmpDir, "global");
    const projectDir = path.join(tmpDir, "project");
    const store = new MemoryStore({
      memoryDir: globalDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    const projectStore = new MemoryStore({
      memoryDir: projectDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await Promise.all([store.loadFromDisk(), projectStore.loadFromDisk()]);
    await store.add("memory", "global source stays intact");
    await projectStore.add("memory", "project source has a long implementation detail");

    const result = await applyReviewOperations(
      store,
      projectStore,
      [
        { action: "remove", target: "project", old_text: "project source" },
        { action: "add", target: "project", content: "project rule" },
      ],
      null,
      "project-a",
      { requireAtomicShrink: true, expectedTarget: "project" },
    );

    assert.deepStrictEqual(result, { appliedCount: 2, skippedCount: 0 });
    assert.deepStrictEqual(store.getMemoryEntries().map((entry) => entry.replace(/\s*<!--.*$/, "")), [
      "global source stays intact",
    ]);
    assert.deepStrictEqual(projectStore.getMemoryEntries().map((entry) => entry.replace(/\s*<!--.*$/, "")), [
      "project rule",
    ]);
    assert.doesNotMatch(projectStore.getRawEntriesForSync("memory")[0] ?? "", /project64=/);
  });

  it("defaults failure formatting and preserves project attribution in atomic plans", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      failureCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    await store.addFailure("obsolete failure detail that is intentionally long", {
      category: "failure",
      project: "project-a",
    });

    const result = await applyReviewOperations(
      store,
      null,
      [
        { action: "remove", target: "failure", old_text: "obsolete failure detail" },
        {
          action: "add",
          target: "failure",
          content: "concise lesson",
          failure_reason: "tool used stale state",
        },
      ],
      null,
      "project-a",
      { requireAtomicShrink: true, expectedTarget: "failure" },
    );

    assert.deepStrictEqual(result, { appliedCount: 2, skippedCount: 0 });
    assert.deepStrictEqual(store.getFailureEntries(), [
      "[failure] concise lesson — Failed: tool used stale state",
    ]);
    assert.match(store.getRawEntriesForSync("failure")[0] ?? "", /project64=cHJvamVjdC1h/);
  });

  it("attributes ordinary non-atomic failures to the current project", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      failureCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    const dbManager = new DatabaseManager(path.join(tmpDir, "db"));
    store.setMutationObserver((target, entries) => {
      reconcileMarkdownMemoryScope(dbManager, entries, target, target === "failure" ? "project-a" : null);
      return null;
    });

    try {
      const result = await applyReviewOperations(
        store,
        null,
        [{
          action: "add",
          target: "failure",
          content: "ordinary scoped lesson",
          category: "correction",
          failure_reason: "user corrected the command",
        }],
        dbManager,
        "project-a",
      );

      assert.deepStrictEqual(result, { appliedCount: 1, skippedCount: 0 });
      assert.deepStrictEqual(store.getFailureEntries(), [
        "[correction] ordinary scoped lesson — Failed: user corrected the command",
      ]);
      const memories = getMemories(dbManager, { target: "failure", project: "project-a" });
      assert.strictEqual(memories.length, 1);
      assert.strictEqual(getMemories(dbManager, { target: "failure", project: null }).length, 0);
      assert.strictEqual(memories[0].category, "correction");
      assert.match(memories[0].content, /ordinary scoped lesson/);
    } finally {
      dbManager.close();
    }
  });

  it("returns an actionable direct-completion error without partial atomic changes", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    await store.add("memory", "keep this direct-review source");
    const beforeEntries = store.getMemoryEntries();
    const modelRegistry = {
      authStorage: { reload: () => undefined },
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
      getAll: () => [mockModel(false)],
      getAvailable: () => [mockModel(false)],
    };
    const complete = async () => ({
      stopReason: "stop",
      content: [{
        type: "text",
        text: JSON.stringify({
          operations: [
            { action: "remove", target: "memory", old_text: "keep this" },
            { action: "remove", target: "memory", old_text: "missing later entry" },
          ],
        }),
      }],
    });

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      store,
      null,
      {
        userPrompt: "consolidate",
        systemPrompt: "return operations",
        config: {},
        requireAtomicShrink: true,
        expectedTarget: "memory",
      },
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.appliedCount, 0);
    assert.match(result.error ?? "", /No entry matched 'missing later entry'/);
    assert.deepStrictEqual(store.getMemoryEntries(), beforeEntries);
  });

  it("skips auth, provider, and store work when the external signal is already aborted", async () => {
    let authCalls = 0;
    let completeCalls = 0;
    let mutated = false;
    const controller = new AbortController();
    controller.abort();
    const store = {
      add: async () => {
        mutated = true;
        return { success: true };
      },
    };
    const modelRegistry = {
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return { ok: true as const, apiKey: "test-key" };
      },
      getAll: () => [mockModel(false)],
      getAvailable: () => [mockModel(false)],
    };

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      store as never,
      null,
      {
        userPrompt: "u",
        systemPrompt: "s",
        config: {},
        signal: controller.signal,
      },
      null,
      null,
      {
        completeSimple: (async () => {
          completeCalls++;
          return {
            stopReason: "stop",
            content: [{ type: "text", text: JSON.stringify({ operations: [{ action: "add", target: "memory", content: "late" }] }) }],
          };
        }) as never,
      },
    );

    assert.deepStrictEqual(result, { ok: false, appliedCount: 0, fallbackReason: "aborted" });
    assert.equal(authCalls, 0);
    assert.equal(completeCalls, 0);
    assert.equal(mutated, false);
  });

  it("does not apply operations when the provider ignores abort and returns success", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    const controller = new AbortController();
    const modelRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
      getAll: () => [mockModel(false)],
      getAvailable: () => [mockModel(false)],
    };
    const complete = async () => {
      controller.abort();
      return {
        stopReason: "stop",
        content: [{
          type: "text",
          text: JSON.stringify({
            operations: [{ action: "add", target: "memory", content: "should not persist after cancel" }],
          }),
        }],
      };
    };

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      store,
      null,
      {
        userPrompt: "u",
        systemPrompt: "s",
        config: {},
        signal: controller.signal,
      },
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.deepStrictEqual(result, { ok: false, appliedCount: 0, fallbackReason: "aborted" });
    assert.equal(store.getMemoryEntries().some((entry) => entry.includes("should not persist after cancel")), false);
  });

  it("does not write after abort while waiting for the markdown mutation lock", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    const controller = new AbortController();
    const modelRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
      getAll: () => [mockModel(false)],
      getAvailable: () => [mockModel(false)],
    };
    const completeEntered = Promise.withResolvers<void>();
    const continueComplete = Promise.withResolvers<void>();
    const complete = async () => {
      completeEntered.resolve();
      await continueComplete.promise;
      return {
        stopReason: "stop",
        content: [{
          type: "text",
          text: JSON.stringify({
            operations: [{ action: "add", target: "memory", content: "late-after-shutdown" }],
          }),
        }],
      };
    };
    const lease = await acquireMarkdownMutationLock(path.join(tmpDir, MEMORY_FILE));
    try {
      const completion = runDirectMemoryCompletion(
        { model: mockModel(false), modelRegistry } as never,
        store,
        null,
        {
          userPrompt: "u",
          systemPrompt: "s",
          config: {},
          signal: controller.signal,
        },
        null,
        null,
        { completeSimple: complete as never },
      );
      await completeEntered.promise;
      continueComplete.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      lease.release();
      const result = await completion;
      assert.deepStrictEqual(result, { ok: false, appliedCount: 0, fallbackReason: "aborted" });
      assert.equal(store.getMemoryEntries().some((entry) => entry.includes("late-after-shutdown")), false);
    } finally {
      lease.release();
    }
  });

  it("uses the in-lock mutation observer as the sole SQLite reconciliation path", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const dbManager = new DatabaseManager(path.join(tmpDir, "db"));
    const originalGetDb = dbManager.getDb.bind(dbManager);
    let insideObserver = false;
    (dbManager as any).getDb = () => {
      if (!insideObserver) throw new Error("out-of-lock SQLite access");
      return originalGetDb();
    };
    store.setMutationObserver((_target, entries) => {
      insideObserver = true;
      try {
        reconcileMarkdownMemoryScope(dbManager, entries, "memory", null);
      } finally {
        insideObserver = false;
      }
      return null;
    });

    try {
      const result = await applyReviewOperations(store, null, [
        { action: "add", target: "memory", content: "observer owns reconciliation" },
      ], dbManager);

      assert.strictEqual(result.appliedCount, 1);
    } finally {
      dbManager.close();
    }
  });
});

describe("response channel fallbacks (#197)", () => {
  function registry() {
    return {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "sk-test" }),
      getAll: () => [mockModel(true)],
      getAvailable: () => [mockModel(true)],
    };
  }

  async function runReview(complete: unknown) {
    return runDirectMemoryCompletion(
      { model: mockModel(true), modelRegistry: registry() } as never,
      null as never,
      null,
      { userPrompt: "u", systemPrompt: "s", config: {} },
      null,
      null,
      { completeSimple: complete as never },
    );
  }

  it("parses ops from thinking blocks when content has no text blocks", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: JSON.stringify({ operations: [] }) },
      ],
    });

    const result = await runReview(complete);

    // "empty" (not "empty_response") proves the ops JSON inside the thinking
    // block reached the parser and parsed cleanly.
    assert.deepStrictEqual(result, { ok: true, appliedCount: 0, fallbackReason: "empty" });
  });

  it("prefers text blocks over thinking blocks when both are present", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [
        { type: "text", text: "not json at all" },
        { type: "thinking", thinking: JSON.stringify({ operations: [] }) },
      ],
    });

    const result = await runReview(complete);

    // Valid ops in thinking must not mask an unparseable text answer.
    assert.deepStrictEqual(result, { ok: false, appliedCount: 0, fallbackReason: "parse_error" });
  });

  it("returns empty_response on a clean stop with neither text nor thinking", async () => {
    const complete = async () => ({ stopReason: "stop", content: [] });

    const result = await runReview(complete);

    assert.deepStrictEqual(result, { ok: true, appliedCount: 0, fallbackReason: "empty_response" });
  });

  it("keeps parse_error when a truncated (length) response has no content", async () => {
    const complete = async () => ({ stopReason: "length", content: [] });

    const result = await runReview(complete);

    // Truncation means the model may not have finished; the fallback chain
    // (next model / subprocess) must still get a chance to retry.
    assert.deepStrictEqual(result, { ok: false, appliedCount: 0, fallbackReason: "parse_error" });
  });

  it("logs the provider-misconfiguration notice once per state for thinking-only answers", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [{ type: "thinking", thinking: JSON.stringify({ operations: [] }) }],
    });
    const lines: string[] = [];
    const state = { logged: false };
    const runWithDeps = (overrides: Record<string, unknown> = {}) =>
      runDirectMemoryCompletion(
        { model: mockModel(true), modelRegistry: registry() } as never,
        null as never,
        null,
        { userPrompt: "u", systemPrompt: "s", config: {} },
        null,
        null,
        {
          completeSimple: complete as never,
          onProviderNotice: (message: string) => lines.push(message),
          providerNoticeState: state,
          ...overrides,
        },
      );

    await runWithDeps();
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0]!, /Provider misconfiguration/);
    assert.match(lines[0]!, /thinking channel/);
    assert.match(lines[0]!, /Ask your Pi to fix this as well/);

    // A second review sharing the state stays silent: the notice is log-once.
    await runWithDeps();
    assert.strictEqual(lines.length, 1);

    // A fresh state (a new process or session) logs again.
    await runWithDeps({ providerNoticeState: { logged: false } });
    assert.strictEqual(lines.length, 2);
  });

  it("does not log the provider notice for a normal text-channel answer", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify({ operations: [] }) }],
    });
    const lines: string[] = [];

    await runDirectMemoryCompletion(
      { model: mockModel(true), modelRegistry: registry() } as never,
      null as never,
      null,
      { userPrompt: "u", systemPrompt: "s", config: {} },
      null,
      null,
      {
        completeSimple: complete as never,
        onProviderNotice: (message: string) => lines.push(message),
        providerNoticeState: { logged: false },
      },
    );

    assert.strictEqual(lines.length, 0);
  });

  it("treats a redacted-only completion as empty_response, not parse_error", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "encrypted redacted payload", redacted: true },
      ],
    });

    const result = await runReview(complete);

    // The redacted block is skipped — nothing parseable, nothing emitted in
    // the clear: same clean-stop empty_response as a silent model, rather
    // than a parse_error that would burn the subprocess fallback (#197).
    assert.deepStrictEqual(result, { ok: true, appliedCount: 0, fallbackReason: "empty_response" });
  });

  it("skips redacted thinking blocks but still recovers a clear one", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "encrypted redacted payload", redacted: true },
        { type: "thinking", thinking: JSON.stringify({ operations: [] }) },
      ],
    });

    const result = await runReview(complete);

    assert.deepStrictEqual(result, { ok: true, appliedCount: 0, fallbackReason: "empty" });
  });

  it("falls back to thinking when the text block is whitespace only", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [
        { type: "text", text: "   \n\t" },
        { type: "thinking", thinking: JSON.stringify({ operations: [] }) },
      ],
    });

    const result = await runReview(complete);

    // Whitespace-only text must not mask recoverable thinking output.
    assert.deepStrictEqual(result, { ok: true, appliedCount: 0, fallbackReason: "empty" });
  });

  it("settles empty_response when thinking output parses to nothing on a clean stop (#235)", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: 'reasoned about { braces } and "quotes" but produced no operations' },
      ],
    });

    const result = await runReview(complete);

    // Brace-heavy prose with no ops object: the answer never left the
    // reasoning channel, and a subprocess would run the same model against
    // the same server-side thinking default and fail the same way.
    assert.deepStrictEqual(result, { ok: true, appliedCount: 0, fallbackReason: "empty_response" });
  });

  it("keeps parse_error when unparseable thinking output is truncated (#235)", async () => {
    const complete = async () => ({
      stopReason: "length",
      content: [
        { type: "thinking", thinking: 'reasoned about { braces } and got cut off mid-obj' },
      ],
    });

    const result = await runReview(complete);

    // Truncation means the model may not have finished; the chain (next
    // model / subprocess) must still get a chance to retry.
    assert.deepStrictEqual(result, { ok: false, appliedCount: 0, fallbackReason: "parse_error" });
  });
});

describe("thinking-channel CoT recovery (#197)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-cot-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function registry() {
    return {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "sk-test" }),
      getAll: () => [mockModel(true)],
      getAvailable: () => [mockModel(true)],
    };
  }

  it("applies the trailing answer when CoT restates the schema first", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const complete = async () => ({
      stopReason: "stop",
      content: [
        {
          type: "thinking",
          thinking:
            'The schema is {"operations":[]} but I will save:\n{"operations":[{"action":"add","target":"user","content":"prefers dark mode"}]}',
        },
      ],
    });

    const result = await runDirectMemoryCompletion(
      { model: mockModel(true), modelRegistry: registry() } as never,
      store,
      null,
      { userPrompt: "u", systemPrompt: "s", config: {} },
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.appliedCount, 1);
    assert.ok(store.getUserEntries().some((entry) => entry.includes("prefers dark mode")));
  });
});

describe("thinking-channel trust rules (#235)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-235-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function registry() {
    return {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "sk-test" }),
      getAll: () => [mockModel(true)],
      getAvailable: () => [mockModel(true)],
    };
  }

  const makeStore = async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();
    return store;
  };

  async function runThinking(thinking: string, store: MemoryStore) {
    const complete = async () => ({
      stopReason: "stop",
      content: [{ type: "thinking", thinking }],
    });
    return runDirectMemoryCompletion(
      { model: mockModel(true), modelRegistry: registry() } as never,
      store,
      null,
      { userPrompt: "u", systemPrompt: "s", config: {} },
      null,
      null,
      { completeSimple: complete as never },
    );
  }

  it("picks the trailing answer over an earlier fenced draft, and the draft's remove is not applied", async () => {
    const store = await makeStore();
    await applyReviewOperations(store, null, [
      { action: "add", target: "memory", content: "draft old entry" },
    ]);

    // The shared cascade would let the fenced draft (a remove) win before
    // the end-scan runs. The thinking path must pick the trailing answer,
    // and the draft's remove must never execute.
    const result = await runThinking(
      '```json\n{"operations":[{"action":"remove","target":"memory","old_text":"draft old entry"}]}\n```\nFinal answer:\n{"operations":[{"action":"add","target":"user","content":"prefers dark mode"}]}',
      store,
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.appliedCount, 1);
    assert.ok(store.getUserEntries().some((entry) => entry.includes("prefers dark mode")));
    assert.ok(store.getMemoryEntries().some((entry) => entry.includes("draft old entry")));
  });

  it("applies only adds from a non-trailing (draft-grade) candidate", async () => {
    const store = await makeStore();
    await applyReviewOperations(store, null, [
      { action: "add", target: "memory", content: "draft old entry" },
    ]);

    // The candidate is followed by more reasoning, so it is draft-grade:
    // the add is recovered, the remove is dropped.
    const result = await runThinking(
      '{"operations":[{"action":"add","target":"user","content":"prefers dark mode"},{"action":"remove","target":"memory","old_text":"draft old entry"}]}\nOn reflection, keep the store as it is.',
      store,
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.appliedCount, 1);
    assert.ok(store.getUserEntries().some((entry) => entry.includes("prefers dark mode")));
    assert.ok(store.getMemoryEntries().some((entry) => entry.includes("draft old entry")));
  });

  it("recovers the answer when an unbalanced brace in prose precedes it", async () => {
    const store = await makeStore();

    // A top-level-only scanner loses every object after an unclosed brace;
    // recording balanced regions at any depth still finds the answer.
    const result = await runThinking(
      'thinking about { this brace never closes\n{"operations":[{"action":"add","target":"user","content":"prefers dark mode"}]}',
      store,
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.appliedCount, 1);
    assert.ok(store.getUserEntries().some((entry) => entry.includes("prefers dark mode")));
  });

  it("settles empty when the trailing candidate is empty, without reaching back to an earlier draft", async () => {
    const store = await makeStore();

    const result = await runThinking(
      'draft {"operations":[{"action":"add","target":"user","content":"never applied"}]} but finally:\n{"operations":[]}',
      store,
    );

    // The trailing empty candidate is the model's final word: applying the
    // earlier draft would execute an operation it may have rejected.
    assert.deepStrictEqual(result, { ok: true, appliedCount: 0, fallbackReason: "empty" });
    assert.ok(!store.getUserEntries().some((entry) => entry.includes("never applied")));
  });

  it("walks to a healthy fallback model after a silent primary and applies its operations", async () => {
    const store = await makeStore();
    const m1 = { id: "m1", provider: "p1", api: "openai-completions", reasoning: true } as Model<Api>;
    const m2 = { id: "m2", provider: "p2", api: "openai-completions", reasoning: true } as Model<Api>;
    const chainRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "sk-test" }),
      getAll: () => [m1, m2],
      getAvailable: () => [m1, m2],
    };
    const attempted: string[] = [];
    const complete = async (model: Model<Api>) => {
      attempted.push(model.id);
      if (model.id === "m1") {
        // Silent primary: clean stop, nothing in either channel.
        return { stopReason: "stop", content: [] };
      }
      return {
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({ operations: [{ action: "add", target: "user", content: "prefers dark mode" }] }) }],
      };
    };

    const result = await runDirectMemoryCompletion(
      { model: m1, modelRegistry: chainRegistry } as never,
      store,
      null,
      { userPrompt: "u", systemPrompt: "s", config: { llmModelOverride: "p1/m1", llmFallbackModels: ["p2/m2"] } },
      null,
      null,
      { completeSimple: complete as never },
    );

    // empty_response walks llmFallbackModels like parse_error does: a silent
    // primary must not end the review while a configured fallback may answer.
    assert.deepStrictEqual(attempted, ["m1", "m2"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.appliedCount, 1);
    assert.ok(store.getUserEntries().some((entry) => entry.includes("prefers dark mode")));
  });
});
