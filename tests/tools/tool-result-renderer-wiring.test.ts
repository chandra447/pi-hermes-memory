import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { registerMemorySearchTool } from "../../src/tools/memory-search-tool.js";
import { registerSessionSearchTool } from "../../src/tools/session-search-tool.js";
import { registerSkillTool } from "../../src/tools/skill-tool.js";

function capture(register: (pi: any) => void): any {
  let definition: any;
  register({ registerTool(value: any) { definition = value; } });
  return definition;
}

describe("tool result renderer wiring", () => {
  it("registers renderResult on memory and memory_search", () => {
    const memory = capture((pi) => registerMemoryTool(pi, {} as any, null));
    const memorySearch = capture((pi) => registerMemorySearchTool(pi, {} as any));

    assert.equal(typeof memory.renderResult, "function");
    assert.equal(typeof memorySearch.renderResult, "function");
  });

  it("registers renderResult on both session_search variants", () => {
    const legacy = capture((pi) => registerSessionSearchTool(pi, {} as any));
    const anchors = capture((pi) => registerSessionSearchTool(
      pi,
      {} as any,
      { variant: "anchors" },
      { sessionsDir: "/path-independent-sessions" },
    ));

    assert.equal(typeof legacy.renderResult, "function");
    assert.equal(typeof anchors.renderResult, "function");
  });

  it("registers renderResult on skill_manage", () => {
    const skill = capture((pi) => registerSkillTool(pi, {} as any));
    assert.equal(typeof skill.renderResult, "function");
  });
});
