/**
 * Unit tests for correction detection — isCorrection() pattern matching
 * and handler behavior (rate limiting, pi.exec trigger).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { getMemories } from "../../src/store/sqlite-memory-store.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { isCorrection, setupCorrectionDetector } from "../../src/handlers/correction-detector.js";
import { resolveChildPiInvocation } from "../../src/handlers/pi-child-process.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../../src/types.js";

// ─── Pattern matching tests ───

describe("isCorrection", () => {
  // ── Strong patterns (always trigger) ──

  describe("strong patterns (always trigger)", () => {
    it("matches 'don't do that'", () => {
      assert.strictEqual(isCorrection("don't do that"), true);
    });

    it("matches 'not like that'", () => {
      assert.strictEqual(isCorrection("not like that"), true);
    });

    it("matches 'I said use yarn'", () => {
      assert.strictEqual(isCorrection("I said use yarn"), true);
    });

    it("matches 'I told you already'", () => {
      assert.strictEqual(isCorrection("I told you already"), true);
    });

    it("matches 'we already discussed this'", () => {
      assert.strictEqual(isCorrection("we already discussed this"), true);
    });

    it("matches 'please don't commit yet'", () => {
      assert.strictEqual(isCorrection("please don't commit yet"), true);
    });

    it("matches \"that's not what I asked for\"", () => {
      assert.strictEqual(isCorrection("that's not what I asked for"), true);
    });
  });

  // ── Weak patterns (need directive clause) ──

  describe("weak patterns (need directive clause)", () => {
    it("matches 'no, use yarn instead' (has directive 'use')", () => {
      assert.strictEqual(isCorrection("no, use yarn instead"), true);
    });

    it("matches 'wrong, the file is in src/' (has directive 'the')", () => {
      assert.strictEqual(isCorrection("wrong, the file is in src/"), true);
    });

    it("matches 'actually, don't use that' (has directive 'don't')", () => {
      assert.strictEqual(isCorrection("actually, don't use that"), true);
    });

    it("matches 'stop, fix the test first' (has directive 'fix')", () => {
      assert.strictEqual(isCorrection("stop, fix the test first"), true);
    });

    it("matches 'no! delete that file' (has directive 'delete')", () => {
      assert.strictEqual(isCorrection("no! delete that file"), true);
    });

    it("does NOT match 'no just kidding' (no directive clause)", () => {
      assert.strictEqual(isCorrection("no just kidding"), false);
    });
  });

  // ── Negative patterns (suppress even if positive matches) ──

  describe("negative patterns (suppress false positives)", () => {
    it("suppresses 'no worries, I'll handle it'", () => {
      assert.strictEqual(isCorrection("no worries, I'll handle it"), false);
    });

    it("suppresses 'no problem'", () => {
      assert.strictEqual(isCorrection("no problem"), false);
    });

    it("suppresses 'no thanks'", () => {
      assert.strictEqual(isCorrection("no thanks"), false);
    });

    it("suppresses 'no need to change that'", () => {
      assert.strictEqual(isCorrection("no need to change that"), false);
    });

    it("suppresses 'actually, that looks great'", () => {
      assert.strictEqual(isCorrection("actually, that looks great"), false);
    });

    it("suppresses 'actually, perfect'", () => {
      assert.strictEqual(isCorrection("actually, perfect"), false);
    });

    it("suppresses 'actually, that's correct'", () => {
      assert.strictEqual(isCorrection("actually, that's correct"), false);
    });

    it("suppresses 'stop there'", () => {
      assert.strictEqual(isCorrection("stop there"), false);
    });

    it("suppresses 'stop here'", () => {
      assert.strictEqual(isCorrection("stop here"), false);
    });

    it("suppresses 'stop for now'", () => {
      assert.strictEqual(isCorrection("stop for now"), false);
    });
  });

  // ── Non-corrections (should NOT trigger) ──

  describe("non-corrections (should NOT trigger)", () => {
    it("does NOT match 'yes, do that'", () => {
      assert.strictEqual(isCorrection("yes, do that"), false);
    });

    it("does NOT match 'looks good'", () => {
      assert.strictEqual(isCorrection("looks good"), false);
    });

    it("does NOT match 'can you also check the tests?'", () => {
      assert.strictEqual(isCorrection("can you also check the tests?"), false);
    });

    it("does NOT match empty string", () => {
      assert.strictEqual(isCorrection(""), false);
    });

    it("does NOT match 'thanks'", () => {
      assert.strictEqual(isCorrection("thanks"), false);
    });

    it("does NOT match 'great, that works'", () => {
      assert.strictEqual(isCorrection("great, that works"), false);
    });

    it("does NOT match 'please continue'", () => {
      assert.strictEqual(isCorrection("please continue"), false);
    });
  });

  // ── Case insensitivity ──

  describe("case insensitivity", () => {
    it("matches 'DON'T DO THAT' (uppercase)", () => {
      assert.strictEqual(isCorrection("DON'T DO THAT"), true);
    });

    it("matches 'I Told You Already' (mixed case)", () => {
      assert.strictEqual(isCorrection("I Told You Already"), true);
    });

    it("suppresses 'No Worries' (uppercase negative)", () => {
      assert.strictEqual(isCorrection("No Worries"), false);
    });
  });

  describe("custom pattern config", () => {
    it("matches custom strong patterns", () => {
      assert.strictEqual(
        isCorrection("custom correction", { correctionStrongPatterns: ["^custom correction$"] }),
        true,
      );
    });

    it("uses custom negative patterns to suppress matches", () => {
      assert.strictEqual(
        isCorrection("custom correction", {
          correctionStrongPatterns: ["^custom"],
          correctionNegativePatterns: ["^custom correction$"],
        }),
        false,
      );
    });

    it("uses custom directive words for weak patterns", () => {
      assert.strictEqual(
        isCorrection("no, shipit now", { correctionDirectiveWords: ["shipit"] }),
        true,
      );
      assert.strictEqual(
        isCorrection("no, use yarn", { correctionDirectiveWords: ["shipit"] }),
        false,
      );
    });

    it("ignores invalid custom regex entries and keeps valid entries", () => {
      assert.strictEqual(
        isCorrection("custom correction", { correctionStrongPatterns: ["bad(", "^custom"] }),
        true,
      );
    });

    it("treats explicit empty or all-invalid pattern arrays as empty", () => {
      assert.strictEqual(
        isCorrection("don't do that", { correctionStrongPatterns: [] }),
        false,
      );
      assert.strictEqual(
        isCorrection("don't do that", { correctionStrongPatterns: ["bad("] }),
        false,
      );
    });
  });
});

// ─── Handler behavior tests ───

describe("setupCorrectionDetector handler", () => {
  let handlers: Record<string, Function[]>;
  let execCalls: any[];
  let notifyCalls: any[];
  let tmpDir: string;
  let dbManager: DatabaseManager;

  function createMockPi(execReturn?: { code: number; stdout: string; stderr: string }) {
    const ret = execReturn ?? { code: 0, stdout: "Saved correction", stderr: "" };
    return {
      on: (event: string, handler: Function) => {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
      },
      exec: async (...args: any[]) => {
        execCalls.push(args);
        return ret;
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;
  }

  let directCalls: unknown[][];

  function makeDirectDeps(
    result: { ok: boolean; appliedCount: number } | "throw",
  ): { runDirectMemoryCompletion: (...args: unknown[]) => Promise<{ ok: boolean; appliedCount: number }> } {
    return {
      runDirectMemoryCompletion: async (...args: unknown[]) => {
        directCalls.push(args);
        if (result === "throw") throw new Error("injected direct correction failure");
        return result;
      },
    };
  }


  function correctionBranch(userText = "don't do that") {
    return [
      { type: "message", message: { role: "user", content: [{ type: "text", text: userText }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I used npm" }] } },
    ];
  }

  function storeWithFailureTracking() {
    let failureCount = 0;
    return {
      store: {
        getMemoryEntries: () => ["existing entry"],
        getUserEntries: () => [],
        addFailure: async () => {
          failureCount += 1;
        },
        getFailureCount: () => failureCount,
      },
    };
  }

  function logicalChildArgs(call: any[]): string[] {
    const [cmd, args] = call;
    const logicalArgs = cmd === "pi" ? args : args.slice(1);
    const expected = resolveChildPiInvocation(logicalArgs);
    assert.strictEqual(cmd, expected.command);
    assert.deepStrictEqual(args, expected.args);
    return logicalArgs;
  }

  const mockStore = {
    getMemoryEntries: () => ["existing entry"],
    getUserEntries: () => [],
  } as any;

  const config = {
    correctionDetection: true,
    nudgeInterval: 10,
    reviewEnabled: false,
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    nudgeToolCalls: 15,
    consolidationTimeoutMs: 60_000,
  };

  const directTransportConfig: MemoryConfig = { ...config, reviewTransport: "direct" };

  function makeCtx(branch: any[] = []) {
    return {
      sessionManager: { getBranch: () => branch },
      signal: undefined as any,
      ui: {
        notify: (msg: string, level: string) => {
          notifyCalls.push({ msg, level });
        },
      },
    };
  }

  function fireMessageEnd(role: string, text: string) {
    const h = handlers["message_end"];
    if (!h) throw new Error("No message_end handler registered");
    for (const fn of h) {
      fn({ message: { role, content: [{ type: "text", text }] } }, makeCtx());
    }
  }

  function fireTurnEnd(branch: any[] = []): Promise<unknown> {
    const h = handlers["turn_end"];
    if (!h) throw new Error("No turn_end handler registered");
    const ctx = makeCtx(branch);
    return Promise.all(h.map((fn) => fn({}, ctx)));
  }

  beforeEach(() => {
    handlers = {};
    execCalls = [];
    notifyCalls = [];
    directCalls = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-detector-test-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("triggers pi.exec when correction detected", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "don't do that" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "don't do that");
    await fireTurnEnd(branch);

    assert.ok(execCalls.length >= 1, "pi.exec should be called on correction");
  });

  it("passes child LLM override args and defaults thinking to off when only a model override is set", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, {
      ...config,
      llmModelOverride: "openrouter/deepseek/deepseek-v4-flash",
    });

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "don't do that" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "don't do that");
    await fireTurnEnd(branch);

    const cmdArgs = logicalChildArgs(execCalls[0]);
    assert.deepStrictEqual(
      cmdArgs.slice(0, 6),
      ["-p", "--no-session", "--model", "openrouter/deepseek/deepseek-v4-flash", "--thinking", "off"],
    );
  });

  it("does NOT trigger on normal messages", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config);

    fireMessageEnd("user", "looks good");
    await fireTurnEnd([]);

    assert.strictEqual(execCalls.length, 0, "pi.exec should NOT be called for normal messages");
  });

  it("rate limits: does not trigger on consecutive corrections within 3 turns", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config);

    // First correction
    fireMessageEnd("user", "don't do that");
    await fireTurnEnd([]);

    const firstCallCount = execCalls.length;
    assert.ok(firstCallCount >= 1, "first correction should trigger");

    // Second correction within 3 turns — should be rate-limited
    fireMessageEnd("user", "not like that");
    await fireTurnEnd([]);

    assert.strictEqual(execCalls.length, firstCallCount, "second correction should be rate-limited");
  });

  it("syncs direct correction saves into SQLite", async () => {
    const pi = createMockPi();
    const correctionStore = new MemoryStore({ ...config, memoryDir: tmpDir } as any);
    await correctionStore.loadFromDisk();
    registerMemoryTool(pi, correctionStore, null, dbManager);

    setupCorrectionDetector(pi, correctionStore, null, config, dbManager);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use pnpm instead" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use pnpm instead");
    await fireTurnEnd(branch);

    const failures = getMemories(dbManager, { target: 'failure' });
    assert.strictEqual(failures.length, 1);
    assert.match(failures[0].content, /use pnpm instead/);
    assert.strictEqual(failures[0].category, 'correction');
    assert.strictEqual(failures[0].project, null);
  });

  it("syncs project correction saves into SQLite with project scope", async () => {
    const pi = createMockPi();
    const correctionStore = new MemoryStore({ ...config, memoryDir: tmpDir } as any);
    await correctionStore.loadFromDisk();
    const projectStore = {
      getMemoryEntries: () => [],
    } as any;
    registerMemoryTool(pi, correctionStore, projectStore, dbManager, 'project-a');

    setupCorrectionDetector(pi, correctionStore, projectStore, config, dbManager, 'project-a');

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use pnpm in this repo" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use pnpm in this repo");
    await fireTurnEnd(branch);

    const projectFailures = getMemories(dbManager, { target: 'failure', project: 'project-a' });
    assert.strictEqual(projectFailures.length, 1);
    assert.match(projectFailures[0].content, /use pnpm in this repo/);
    assert.doesNotMatch(projectFailures[0].content, /Project: project-a/);
    assert.strictEqual(projectFailures[0].category, 'correction');
    assert.strictEqual(getMemories(dbManager, { target: 'failure', project: null }).length, 0);
  });

  it("does not break correction handling when SQLite sync fails", async () => {
    const pi = createMockPi();
    const correctionStore = new MemoryStore({ ...config, memoryDir: tmpDir } as any);
    await correctionStore.loadFromDisk();

    const failingDbManager = {
      getDb: () => {
        throw new Error('sqlite unavailable');
      },
    } as unknown as DatabaseManager;

    registerMemoryTool(pi, correctionStore, null, failingDbManager);
    setupCorrectionDetector(pi, correctionStore, null, config, failingDbManager);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "no, use yarn instead" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "no, use yarn instead");
    await fireTurnEnd(branch);

    assert.ok(execCalls.length >= 1, 'correction review should still run');
    assert.strictEqual(correctionStore.getFailureEntries().length, 1, 'Markdown correction save should still happen');
  });

  describe("direct memory completion transport", () => {
    it("skips subprocess and notifies when direct succeeds with applied memories", async () => {
      const pi = createMockPi();
      const { store } = storeWithFailureTracking();
      setupCorrectionDetector(
        pi,
        store as unknown as MemoryStore,
        null,
        directTransportConfig,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 1 }),
      );

      fireMessageEnd("user", "don't do that");
      await fireTurnEnd(correctionBranch());

      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 0, "subprocess must not run on successful direct correction");
      assert.deepStrictEqual(
        notifyCalls.filter((n) => n.msg === "🔧 Correction detected — memory updated"),
        [{ msg: "🔧 Correction detected — memory updated", level: "info" }],
      );
    });

    it("skips subprocess and omits memory-updated notify when direct ok with zero applied", async () => {
      const pi = createMockPi();
      const { store } = storeWithFailureTracking();
      setupCorrectionDetector(
        pi,
        store as unknown as MemoryStore,
        null,
        directTransportConfig,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 0 }),
      );

      fireMessageEnd("user", "don't do that");
      await fireTurnEnd(correctionBranch());

      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 0, "ok:true with appliedCount 0 still completes via direct transport");
      assert.strictEqual(
        notifyCalls.some((n) => n.msg === "🔧 Correction detected — memory updated"),
        false,
      );
    });

    it("falls back to subprocess when direct returns ok false", async () => {
      const pi = createMockPi();
      const { store } = storeWithFailureTracking();
      setupCorrectionDetector(
        pi,
        store as unknown as MemoryStore,
        null,
        directTransportConfig,
        null,
        null,
        makeDirectDeps({ ok: false, appliedCount: 0 }),
      );

      fireMessageEnd("user", "don't do that");
      await fireTurnEnd(correctionBranch());

      assert.strictEqual(directCalls.length, 1);
      assert.ok(execCalls.length >= 1, "failed direct result must fall back to subprocess");
    });

    it("falls back to subprocess when direct throws without propagating", async () => {
      const pi = createMockPi();
      const { store } = storeWithFailureTracking();
      setupCorrectionDetector(
        pi,
        store as unknown as MemoryStore,
        null,
        directTransportConfig,
        null,
        null,
        makeDirectDeps("throw"),
      );

      fireMessageEnd("user", "don't do that");
      await fireTurnEnd(correctionBranch());

      assert.strictEqual(directCalls.length, 1);
      assert.ok(execCalls.length >= 1, "thrown direct error must fall back to subprocess");
    });

    it("uses subprocess only when reviewTransport is subprocess", async () => {
      const pi = createMockPi();
      const { store } = storeWithFailureTracking();
      const subprocessConfig: MemoryConfig = { ...config, reviewTransport: "subprocess" };
      setupCorrectionDetector(
        pi,
        store as unknown as MemoryStore,
        null,
        subprocessConfig,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 1 }),
      );

      fireMessageEnd("user", "don't do that");
      await fireTurnEnd(correctionBranch());

      assert.strictEqual(directCalls.length, 0, "direct transport must be skipped for subprocess config");
      assert.ok(execCalls.length >= 1, "subprocess must run when direct transport is disabled");
    });
  });

  it("does not register handlers when correctionDetection is false", () => {
    const pi = createMockPi();
    const disabledConfig = { ...config, correctionDetection: false };
    setupCorrectionDetector(pi, mockStore, null, disabledConfig);

    assert.strictEqual(Object.keys(handlers).length, 0, "no handlers should be registered when disabled");
  });
});
