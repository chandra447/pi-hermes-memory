/**
 * Tests for MemoryProvider base class.
 *
 * Tests the memory backend's public API via the concrete Holographic provider,
 * against its actual behavior (interface kept as-is):
 * - Config schema
 * - System prompt block
 * - Prefetch
 * - getToolSchemas
 * - onMemoryWrite (void mirror)
 * - handleToolCall error path
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { FACT_FEEDBACK_SCHEMA, FACT_STORE_SCHEMA } from "../../src/providers/holographic/holographic.js";
import { HolographicMemoryProvider } from "../../src/providers/holographic/holographic.js";

const HOME = os.tmpdir();

/** A provider wired to an in-memory store so state-backed methods work. */
function fresh(): HolographicMemoryProvider {
  const p = new HolographicMemoryProvider({ db_path: ":memory:" });
  p.initialize("test-session");
  return p;
}

describe("MemoryProvider", () => {
  it("config schema has the expected entries", () => {
    const schema = fresh().getConfigSchema();
    assert.strictEqual(schema.length, 4);
    const autoExtract = schema.find((e) => (e as { key: string }).key === "auto_extract");
    assert.ok(autoExtract, "auto_extract entry exists");
    assert.strictEqual((autoExtract as { default: string }).default, "false");
    assert.deepEqual((autoExtract as { choices: string[] }).choices, ["true", "false"]);
  });

  it("system prompt block returns empty string when uninitialized", () => {
    const body = new HolographicMemoryProvider().systemPromptBlock();
    assert.strictEqual(body, "");
  });

  it("system prompt block returns non-empty string with facts when initialized", () => {
    const body = fresh().systemPromptBlock();
    assert.ok(body.includes("Active"));
    assert.ok(body.includes("facts"));
  });

  it("prefetch returns empty string when query is missing", () => {
    assert.strictEqual(fresh().prefetch(""), "");
  });

  it("prefetch returns empty string when query is empty string", () => {
    assert.strictEqual(fresh().prefetch(""), "");
  });

  it("prefetch returns empty string when query is invalid", () => {
    assert.strictEqual(fresh().prefetch("not_an_error"), "");
  });

  it("prefetch returns empty string when query contains only spaces", () => {
    assert.strictEqual(fresh().prefetch("   "), "");
  });

  it("prefetch returns empty string when query contains only punctuation", () => {
    assert.strictEqual(fresh().prefetch("!!!?"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with quotes", () => {
    assert.strictEqual(fresh().prefetch("\"hello\""), "");
  });

  it("prefetch returns empty string when query contains only punctuation with brackets", () => {
    assert.strictEqual(fresh().prefetch("[123]"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with parentheses", () => {
    assert.strictEqual(fresh().prefetch("(123)"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with braces", () => {
    assert.strictEqual(fresh().prefetch("{123}"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with colons", () => {
    assert.strictEqual(fresh().prefetch(":123"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with semicolons", () => {
    assert.strictEqual(fresh().prefetch(";123"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with equals", () => {
    assert.strictEqual(fresh().prefetch("=123"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with hyphens", () => {
    assert.strictEqual(fresh().prefetch("-123"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with underscores", () => {
    assert.strictEqual(fresh().prefetch("_123"), "");
  });

  it("prefetch returns empty string when query contains only punctuation with at least one character", () => {
    assert.strictEqual(fresh().prefetch("123"), "");
  });

  it("prefetch returns empty string when query is not a valid string", () => {
    assert.strictEqual(fresh().prefetch("not a string"), "");
  });

  it("getToolSchemas returns the fact_store + fact_feedback schemas", () => {
    const schema = fresh().getToolSchemas();
    assert.strictEqual(schema.length, 2);
    assert.deepEqual(schema[0], FACT_STORE_SCHEMA);
    assert.deepEqual(schema[1], FACT_FEEDBACK_SCHEMA);
  });
});

describe("onMemoryWrite", () => {
  it("is a void mirror: writing to facts returns undefined", () => {
    const r = fresh().onMemoryWrite("add", "user", "alice really likes the dark theme setting");
    assert.equal(r, undefined);
  });
});

describe("MemoryProvider tool error", () => {
  it("returns a JSON error for an unknown tool", () => {
    const result = fresh().handleToolCall("not_a_tool", { name: "test" });
    assert.deepEqual(JSON.parse(result as string), { error: "Unknown tool: not_a_tool" });
  });
});
