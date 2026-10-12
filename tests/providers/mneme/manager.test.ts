import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMneme } from "../../../src/providers/mneme/manager.js";
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

describe("buildMneme", () => {
  it("returns null when Mneme is not enabled", () => {
    assert.equal(buildMneme(enabled({ enabled: false })), null);
  });

  it("instantiates Holographic and registers it as local when enabled", () => {
    const { registry, providers } = buildMneme(enabled());
    assert.equal(providers.length, 1);
    assert.equal(providers[0].registered.id, "holographic");
    assert.equal(providers[0].registered.is_local, true);
    assert.equal(providers[0].registered.kind, "hybrid");
    assert.equal(providers[0].provider.name, "holographic");
  });

  it("defaults provider selection to Holographic when mneme.providers is undefined", () => {
    const { providers } = buildMneme(enabled());
    assert.deepEqual(providers.map((p) => p.provider.name), ["holographic"]);
  });

  it("honors an explicit mneme.providers selection", () => {
    const { providers } = buildMneme(enabled({ providers: ["holographic"] }));
    assert.deepEqual(providers.map((p) => p.provider.name), ["holographic"]);
  });

  it("throws on an unknown provider id", () => {
    assert.throws(() => buildMneme(enabled({ providers: ["no-such-provider"] })), /Unknown Mneme provider/);
  });
});
