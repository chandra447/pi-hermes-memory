import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MnemeRegistry, type RegisteredProvider } from "../../../src/providers/mneme/registry.js";

const fixture = (overrides: Partial<RegisteredProvider> = {}): RegisteredProvider => ({
  id: "holographic",
  name: "Holographic",
  kind: "hybrid",
  is_local: true,
  is_bidirectional: false,
  ...overrides,
});

describe("MnemeRegistry", () => {
  it("registers a local provider and lists it", () => {
    const reg = new MnemeRegistry();
    reg.register(fixture());
    assert.ok(reg.has("holographic"));
    assert.deepEqual(reg.get("holographic"), fixture());
    assert.equal(reg.list().length, 1);
  });

  it("rejects a non-local provider unless the operator opted in (v1 bar)", () => {
    const reg = new MnemeRegistry(false);
    assert.throws(() => reg.register(fixture({ id: "remote", is_local: false })), /non-local/);
  });

  it("allows a non-local provider only when allowNonLocal is set", () => {
    const reg = new MnemeRegistry(true);
    reg.register(fixture({ id: "remote", is_local: false }));
    assert.ok(reg.has("remote"));
  });

  it("records is_bidirectional as registered", () => {
    const reg = new MnemeRegistry();
    reg.register(fixture({ id: "bidir", is_bidirectional: true }));
    assert.equal(reg.get("bidir")?.is_bidirectional, true);
  });

  it("rejects a duplicate id", () => {
    const reg = new MnemeRegistry();
    reg.register(fixture());
    assert.throws(() => reg.register(fixture({ id: "holographic" })), /already registered/);
  });

  it("rejects a missing id", () => {
    const reg = new MnemeRegistry();
    assert.throws(() => reg.register(fixture({ id: "" })), /id is required/);
  });
});
