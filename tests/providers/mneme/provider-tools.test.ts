/**
 * Tests for provider tool registration.
 *
 * Verifies that a provider's declared schemas become Pi tools whose execute
 * dispatches back through `handleToolCall`, and that labels are derived from the
 * tool name.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HolographicMemoryProvider, FACT_STORE_SCHEMA } from "../../../src/providers/holographic/holographic.js";
import { registerProviderTool, registerProviderTools } from "../../../src/providers/mneme/provider-tools.js";

function fresh(): HolographicMemoryProvider {
  const p = new HolographicMemoryProvider({ db_path: ":memory:" });
  p.initialize("test-session");
  return p;
}

function mockPi(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

describe("registerProviderTool", () => {
  it("registers name, derived label, description and the TypeBox parameters", () => {
    const { pi, tools } = mockPi();
    registerProviderTool(pi, fresh(), FACT_STORE_SCHEMA);
    assert.equal(tools[0].name, "fact_store");
    assert.equal(tools[0].label, "Fact Store");
    assert.equal(tools[0].description, FACT_STORE_SCHEMA.description);
    assert.equal(tools[0].parameters, FACT_STORE_SCHEMA.parameters);
  });

  it("returns the JSON result as a single text content with the parsed details", async () => {
    const { pi, tools } = mockPi();
    registerProviderTool(pi, fresh(), FACT_STORE_SCHEMA);
    const result = await tools[0].execute("tool-1", { action: "list" } as never, undefined, undefined, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const parsed = JSON.parse(result.content[0].text as string);
    assert.equal(parsed.count, 0);
    assert.deepEqual(result.details, parsed);
  });

  it("surfaces a tool error as text plus an error detail", async () => {
    const { pi, tools } = mockPi();
    registerProviderTool(pi, fresh(), FACT_STORE_SCHEMA);
    const result = await tools[0].execute("tool-1", { action: "no_such" } as never, undefined, undefined, undefined);
    assert.match(result.content[0].text as string, /Unknown action/);
    // handleToolCall catches with String(e), which keeps the Error: prefix.
    assert.deepEqual(result.details, { error: "Error: Unknown action: no_such" });
  });
});

describe("registerProviderTools", () => {
  it("registers one tool per declared schema", () => {
    const { pi, tools } = mockPi();
    registerProviderTools(pi, fresh());
    assert.equal(tools.length, 2);
    assert.deepEqual(tools.map((t) => t.name), ["fact_store", "fact_feedback"]);
  });
});
