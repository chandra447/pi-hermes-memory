/**
 * Unit tests for correction detection — isCorrection() pattern matching
 * and handler behavior (rate limiting, pi.exec trigger).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isCorrection, setupCorrectionDetector } from "../../src/handlers/correction-detector.js";

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
});

// ─── Handler behavior tests ───

describe("setupCorrectionDetector handler", () => {
  let handlers: Record<string, Function[]>;
  let execCalls: any[];
  let notifyCalls: any[];

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
    autoConsolidate: false,
    nudgeToolCalls: 15,
    candidateShadowMode: true,
  };

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

  function fireTurnEnd(branch: any[] = []) {
    const h = handlers["turn_end"];
    if (!h) throw new Error("No turn_end handler registered");
    const ctx = makeCtx(branch);
    for (const fn of h) {
      fn({}, ctx);
    }
    return ctx;
  }

  async function settle(ms = 10) {
    await new Promise((r) => setTimeout(r, ms));
  }

  beforeEach(() => {
    handlers = {};
    execCalls = [];
    notifyCalls = [];
  });

  it("triggers pi.exec when correction detected", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "don't do that" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    fireMessageEnd("user", "don't do that");
    fireTurnEnd(branch);
    await settle();

    assert.ok(execCalls.length >= 1, "pi.exec should be called on correction");
  });

  it("does NOT trigger on normal messages", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config);

    fireMessageEnd("user", "looks good");
    fireTurnEnd([]);
    await settle();

    assert.strictEqual(execCalls.length, 0, "pi.exec should NOT be called for normal messages");
  });

  it("rate limits: does not trigger on consecutive corrections within 3 turns", async () => {
    const pi = createMockPi();
    setupCorrectionDetector(pi, mockStore, null, config);

    // First correction
    fireMessageEnd("user", "don't do that");
    fireTurnEnd([]);
    await settle();

    const firstCallCount = execCalls.length;
    assert.ok(firstCallCount >= 1, "first correction should trigger");

    // Second correction within 3 turns — should be rate-limited
    fireMessageEnd("user", "not like that");
    fireTurnEnd([]);
    await settle();

    assert.strictEqual(execCalls.length, firstCallCount, "second correction should be rate-limited");
  });

  it("does not register handlers when correctionDetection is false", () => {
    const pi = createMockPi();
    const disabledConfig = { ...config, correctionDetection: false };
    setupCorrectionDetector(pi, mockStore, null, disabledConfig);

    assert.strictEqual(Object.keys(handlers).length, 0, "no handlers should be registered when disabled");
  });
});
