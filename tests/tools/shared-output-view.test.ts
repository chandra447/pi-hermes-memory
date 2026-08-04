import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  createSharedToolResultRenderer,
  type SharedOutputView,
} from "../../src/tools/shared-output-view.js";
import {
  memoryResultView,
  searchResultView,
  skillResultView,
} from "../../src/tools/tool-result-views.js";

initTheme();

function fakeTheme() {
  return {
    fg: (_color: string, text: string): string => text,
    getBgAnsi: (_color: string): string => "",
  } as any;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*m/g, "");
}

function renderPlain(component: Component, width = 120): string {
  return component.render(width).map((row) => stripAnsi(row).trimEnd()).join("\n");
}

function result(text: string, details: Record<string, unknown> = { success: true }) {
  return { content: [{ type: "text", text }], details };
}

function renderToolResult(
  toolResult: ReturnType<typeof result>,
  expanded: boolean,
  width = 120,
): string {
  return renderPlain(
    createSharedToolResultRenderer()(
      toolResult,
      { expanded, isPartial: false },
      fakeTheme(),
      { isError: false },
    ),
    width,
  );
}

function renderView(view: SharedOutputView, expanded: boolean, width = 120): string {
  return renderPlain(
    createSharedToolResultRenderer(() => view)(
      result(view.expandedText),
      { expanded, isPartial: false },
      fakeTheme(),
      { isError: false },
    ),
    width,
  );
}

function assertRowKeepsBackground(row: string): void {
  let backgroundActive = false;
  for (let index = 0; index < row.length;) {
    const sgr = row.slice(index).match(/^\x1b\[([0-9;]*)m/);
    if (sgr) {
      const parameters = sgr[1];
      if (parameters === "" || parameters === "0" || parameters === "49") {
        backgroundActive = false;
      } else if (parameters.split(";")[0] === "48") {
        backgroundActive = true;
      }
      index += sgr[0].length;
      continue;
    }
    assert.equal(backgroundActive, true, `background cleared before ${JSON.stringify(row.slice(index))}`);
    index += 1;
  }
}

describe("shared tool-result view", () => {
  it("collapses to one concise line and expands to the full bounded result", () => {
    const toolResult = result("Found 2 memories matching auth:\n\nfirst\nsecond", {
      success: true,
      count: 2,
    });

    const collapsed = renderToolResult(toolResult, false);
    assert.equal(collapsed.split("\n").length, 1);
    assert.match(collapsed, /Found 2 memories matching auth/);
    assert.doesNotMatch(collapsed, /second/);
    assert.match(collapsed, /expand/);

    const expanded = renderToolResult(toolResult, true);
    assert.equal(expanded, toolResult.content[0].text);
  });

  it("does not mutate model-visible content or details", () => {
    const toolResult = result("immutable\nfull output", {
      success: true,
      nested: { keep: true },
    });
    const before = structuredClone(toolResult);

    renderToolResult(toolResult, false);
    renderToolResult(toolResult, true);

    assert.deepEqual(toolResult, before);
  });

  it("keeps textual failure and warning reasons in collapsed output", () => {
    const failure = renderToolResult(
      result("query is required", { success: false, message: "query is required" }),
      false,
    );
    assert.match(failure, /query is required/);

    const warningView = memoryResultView(result(JSON.stringify({
      success: true,
      message: "Entry added. Warning: SQLite mirror unavailable",
      warning: "SQLite mirror unavailable",
      warnings: ["SQLite mirror unavailable"],
      target: "memory",
      entry_count: 1,
    }), {
      success: true,
      message: "Entry added. Warning: SQLite mirror unavailable",
      warning: "SQLite mirror unavailable",
      warnings: ["SQLite mirror unavailable"],
      target: "memory",
      entry_count: 1,
    }));
    assert.match(renderView(warningView, false), /SQLite mirror unavailable/);
  });

  it("fits ANSI, CJK, and partial rows while preserving the outer tool-card background", () => {
    const width = 34;
    const backgroundOpen = "\x1b[48;2;40;50;40m";
    const ansiTheme = {
      fg: (_color: string, text: string): string => `\x1b[38;2;145;148;145m${text}\x1b[39m`,
      getBgAnsi: (_color: string): string => backgroundOpen,
    } as any;
    const box = new Box(1, 1, (text: string) => `${backgroundOpen}${text}\x1b[49m`);
    box.addChild(createSharedToolResultRenderer()(
      result("处理中 世界世界世界世界 \x1b[1mvery long partial output\x1b[0m"),
      { expanded: false, isPartial: true },
      ansiTheme,
      { isError: false },
    ));

    const rows = box.render(width);
    assert.equal(rows.length, 3);
    assert.equal(visibleWidth(rows[1]), width);
    assert.match(stripAnsi(rows[1]), /处理中|In progress/);

    assertRowKeepsBackground(rows[1]);
  });

  it("keeps the tool-card background across expanded Text rows with ANSI resets and CJK wrapping", () => {
    const width = 18;
    const backgroundOpen = "\x1b[48;2;40;50;40m";
    const ansiTheme = {
      fg: (_color: string, text: string): string => text,
      getBgAnsi: (_color: string): string => backgroundOpen,
    } as any;
    const expandedText = "第一行 世界世界世界\x1b[0m继续\n第二行 \x1b[49m背景保留";
    const box = new Box(1, 1, (text: string) => `${backgroundOpen}${text}\x1b[49m`);
    box.addChild(createSharedToolResultRenderer()(
      result(expandedText),
      { expanded: true, isPartial: false },
      ansiTheme,
      { isError: false },
    ));

    const rows = box.render(width);
    assert.ok(rows.length > 4);
    for (const row of rows) {
      assert.equal(visibleWidth(row), width);
      assertRowKeepsBackground(row);
    }
    const expandedRows = rows.slice(1, -1).map((row) => stripAnsi(row).trim());
    assert.deepEqual(expandedRows, ["第一行 世界世界", "世界继续", "第二行 背景保留"]);
  });
});

describe("tool-specific summaries", () => {
  it("summarizes memory, search/session, and skill results without changing expanded text", () => {
    const memoryText = JSON.stringify({
      success: true,
      message: "Entry added.",
      target: "failure",
      category: "tool-quirk",
      entry_count: 2,
      usage: "120 / 5,000 chars",
    });
    const memory = memoryResultView(result(memoryText, JSON.parse(memoryText)));
    assert.match(memory.summary, /Saved/);
    assert.match(memory.summary, /target: failure/);
    assert.match(memory.summary, /category: tool-quirk/);
    assert.equal(memory.expandedText, memoryText);

    const searchText = "Found 3 memories matching auth:\n\nfirst\nsecond\nthird";
    const search = searchResultView(result(searchText, { success: true, count: 3 }));
    assert.match(search.summary, /3/);
    assert.equal(search.expandedText, searchText);

    const skillText = JSON.stringify({ success: true, skillId: "global:deploy", name: "deploy" });
    const skill = skillResultView(result(skillText, JSON.parse(skillText)));
    assert.match(skill.summary, /deploy/i);
    assert.equal(skill.expandedText, skillText);
  });

  it("renders a real skill-tool JSON failure as an actionable failure", () => {
    const error = "Skill 'global:missing' not found.";
    const skillText = JSON.stringify({ success: false, error });
    const toolResult = result(skillText, {});
    const skill = skillResultView(toolResult);

    assert.equal(skill.status, "failure");
    assert.equal(skill.summary, `Error · ${error}`);
    assert.equal(skill.expandedText, skillText);
    assert.match(renderPlain(
      createSharedToolResultRenderer(skillResultView)(
        toolResult,
        { expanded: false, isPartial: false },
        fakeTheme(),
        { isError: false },
      ),
    ), new RegExp(error.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
