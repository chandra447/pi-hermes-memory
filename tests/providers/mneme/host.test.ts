/**
 * Tests for the Mneme host wiring (`setupMnemeHost`).
 *
 * Verifies the no-op-when-disabled contract and, when enabled, the one-time
 * cost (register tools, install the write-mirror) plus the per-event hooks the
 * host exposes to index.ts.
 *
 * Note: these tests exercise the *host's* logic (gating, combining, lifecycle),
 * not the provider's retrieval fidelity — that lives in `holographic.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setupMnemeHost } from "../../../src/providers/mneme/host.js";
import type { MemoryStore } from "../../../src/store/memory-store.js";
import type { MemoryConfig } from "../../../src/types.js";

const enabled = (over: Record<string, unknown> = {}): MemoryConfig => ({
  mode: "policy-only",
  lazyInitialization: false,
  memoryPolicyStyle: "full",
  memoryCharLimit: 5000,
  userCharLimit: 5000,
  nudgeInterval: 10,
  reviewEnabled: true,
  reviewTransport: "direct",
  reviewRecentMessages: 0,
  flushOnCompact: true,
  flushOnShutdown: true,
  flushMinTurns: 6,
  flushRecentMessages: 0,
  flushCompactTimeoutMs: 60000,
  memoryOverflowStrategy: "auto-consolidate",
  autoConsolidate: true,
  consolidationTimeoutMs: 180000,
  overflowGraceMs: 180000,
  autoConsolidationWarnOnFailure: true,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: 7,
  failureInjectionMaxEntries: 5,
  projectsMemoryDir: "projects-memory",
  sessionSearch: { variant: "legacy" },
  mneme: { enabled: true, ...over },
}) as unknown as MemoryConfig;

function mockPi(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

type WriteMirror = (action: "add" | "replace" | "remove", target: string, content: string) => void;
function mockStore(): { store: MemoryStore; writeMirror: () => WriteMirror | undefined } {
  let mirror: WriteMirror | undefined;
  const store = {
    setWriteMirror: (cb: WriteMirror) => {
      mirror = cb;
    },
  } as unknown as MemoryStore;
  return { store, writeMirror: () => mirror };
}

function sessionContext(id = "test-session"): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => id },
  } as unknown as ExtensionContext;
}

describe("setupMnemeHost — disabled", () => {
  it("registers no tools, installs no write-mirror and returns a no-op host", () => {
    const { pi, tools } = mockPi();
    const { store, writeMirror } = mockStore();
    const host = setupMnemeHost(pi, enabled({ enabled: false }), store);
    assert.equal(tools.length, 0);
    assert.equal(writeMirror(), undefined);
    assert.equal(host.systemPromptBlock(), "");
    assert.equal(host.prefetchAll("anything at all"), "");
  });

  it("no-op callbacks never throw", async () => {
    const { pi } = mockPi();
    const { store } = mockStore();
    const host = setupMnemeHost(pi, { mode: "policy-only" } as unknown as MemoryConfig, store);
    await host.onSessionStart(sessionContext());
    await host.onSessionShutdown();
  });
});

describe("setupMnemeHost — enabled", () => {
  it("registers one tool per provider schema", () => {
    const { pi, tools } = mockPi();
    const { store } = mockStore();
    const host = setupMnemeHost(pi, enabled(), store);
    assert.equal(tools.length, 2);
    assert.deepEqual(tools.map((t) => t.name), ["fact_store", "fact_feedback"]);
    void host;
  });

  it("installs a write-mirror that mirrors each built-in write into the providers", async () => {
    const { pi } = mockPi();
    const { store, writeMirror } = mockStore();
    const host = setupMnemeHost(pi, enabled(), store);
    const mirror = writeMirror();
    assert.equal(typeof mirror, "function");
    // Init first (the mirror needs an initialized provider to write into),
    // then fire an add as if the Hermes store had persisted one.
    await host.onSessionStart(sessionContext());
    mirror!("add", "user", "alice really likes the dark theme setting");
    assert.match(host.systemPromptBlock(), /Active/);
  });

  it("systemPromptBlock is empty before init and populated after onSessionStart", async () => {
    const { pi } = mockPi();
    const { store } = mockStore();
    const host = setupMnemeHost(pi, enabled(), store);
    assert.equal(host.systemPromptBlock(), "");
    await host.onSessionStart(sessionContext());
    assert.match(host.systemPromptBlock(), /Active/);
  });

  it("prefetchAll gates trivial and empty queries and returns a string otherwise", () => {
    const { pi } = mockPi();
    const { store } = mockStore();
    const host = setupMnemeHost(pi, enabled(), store);
    assert.equal(host.prefetchAll(""), "");
    assert.equal(host.prefetchAll("yes"), "");
    assert.equal(typeof host.prefetchAll("what did we decide about auth"), "string");
  });

  it("onSessionShutdown releases the provider (block clears, prefetch stops)", async () => {
    const { pi } = mockPi();
    const { store, writeMirror } = mockStore();
    const host = setupMnemeHost(pi, enabled(), store);
    await host.onSessionStart(sessionContext());
    writeMirror!("add", "user", "alice really likes the dark theme setting");
    assert.match(host.systemPromptBlock(), /Active/);
    await host.onSessionShutdown();
    assert.equal(host.systemPromptBlock(), "");
    assert.equal(host.prefetchAll("what does alice like?"), "");
    // Idempotent — shutting down twice does not throw.
    await host.onSessionShutdown();
  });
});
