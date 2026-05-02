/**
 * Unit tests for memory tool registration and execute function.
 *
 * Mocks ExtensionAPI to verify registerTool is called with correct parameters
 * and execute returns the expected JSON format.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

describe("registerMemoryTool", () => {
  it("registers tool with name 'memory' and correct parameters", () => {
    const registeredTools: any[] = [];

    const mockPi = {
      registerTool: (def: any) => {
        registeredTools.push(def);
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({ success: true, target: "memory", entries: ["test"], usage: "10% — 10/100 chars", entry_count: 1 }),
      replace: () => ({ success: true, target: "memory", entries: [], usage: "0% — 0/100 chars", entry_count: 0 }),
      remove: () => ({ success: true, target: "memory", entries: [], usage: "0% — 0/100 chars", entry_count: 0 }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);

    assert.strictEqual(registeredTools.length, 1, "should register exactly one tool");
    const tool = registeredTools[0];
    assert.strictEqual(tool.name, "memory", "tool name should be 'memory'");
    assert.strictEqual(tool.label, "Memory", "tool label should be 'Memory'");
    assert.ok(tool.description.length > 0, "description should not be empty");
    assert.ok(tool.promptSnippet.length > 0, "promptSnippet should not be empty");
    assert.ok(Array.isArray(tool.promptGuidelines), "promptGuidelines should be an array");
    assert.ok(tool.parameters, "parameters schema should be defined");
  });

  it("execute add returns JSON with usage field", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        usage: "5% — 110/2200 chars",
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    assert.strictEqual(result.content[0].type, "text", "content should be text type");
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true, "result should be success");
    assert.ok(parsed.usage.includes("chars"), "usage should contain 'chars'");
    assert.ok(parsed.usage.includes("2200"), "usage should show total limit");
    assert.strictEqual(parsed.entry_count, 1, "entry_count should be 1");
    assert.strictEqual(result.details.success, true, "details should mirror result");
  });

  it("execute add without content returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false, "should fail without content");
    assert.ok(parsed.error.includes("required"), "error should mention required content");
  });

  it("execute replace without old_text returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "replace", target: "memory", content: "new" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false, "should fail without old_text");
    assert.ok(parsed.error.includes("old_text"), "error should mention old_text");
  });

  it("execute remove without old_text returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "remove", target: "memory" }, undefined as any, undefined as any, undefined as any);

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false, "should fail without old_text");
    assert.ok(parsed.error.includes("old_text"), "error should mention old_text");
  });

  it("execute delegates replace to store.replace", async () => {
    let capturedResult: any;
    let replaceArgs: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      replace: (...args: any[]) => {
        replaceArgs = args;
        return { success: true, target: "memory", entries: ["new"], usage: "5% — 110/2200 chars", entry_count: 1 };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    await capturedResult.execute("tc-1", { action: "replace", target: "memory", content: "new", old_text: "old" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(replaceArgs, ["memory", "old", "new"], "should pass target, old_text, content to store.replace");
  });

  it("execute delegates remove to store.remove", async () => {
    let capturedResult: any;
    let removeArgs: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      remove: (...args: any[]) => {
        removeArgs = args;
        return { success: true, target: "memory", entries: [], usage: "0% — 0/2200 chars", entry_count: 0 };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    await capturedResult.execute("tc-1", { action: "remove", target: "memory", old_text: "old entry" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(removeArgs, ["memory", "old entry"], "should pass target, old_text to store.remove");
  });
});
