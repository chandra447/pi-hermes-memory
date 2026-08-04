import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Box, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  createSharedToolResultRenderer,
  renderSharedToolResult,
  type SharedOutputView,
} from "../../src/tools/shared-output-view.js";
import {
  memoryResultView,
  searchResultView,
  skillResultView,
} from "../../src/tools/tool-result-views.js";

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
  return component.render(width).map(stripAnsi).join("\n");
}

function result(text: string, details: Record<string, unknown> = { success: true }) {
  return { content: [{ type: "text", text }], details };
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

describe("shared tool-result view", () => {
  it("collapses to one concise line and expands to the full bounded result", () => {
    const toolResult = result("Found 2 memories matching auth:\n\nfirst\nsecond", {
      success: true,
      count: 2,
    });

    const collapsed = renderPlain(
      renderSharedToolResult(toolResult, { expanded: false }, fakeTheme()),
    );
    assert.equal(collapsed.split("\n").length, 1);
    assert.match(collapsed, /Found 2 memories matching auth/);
    assert.doesNotMatch(collapsed, /second/);
    assert.match(collapsed, /expand/);

    const expanded = renderPlain(
      renderSharedToolResult(toolResult, { expanded: true }, fakeTheme()),
    );
    assert.equal(expanded, toolResult.content[0].text);
  });

  it("does not mutate model-visible content or details", () => {
    const toolResult = result("immutable\nfull output", {
      success: true,
      nested: { keep: true },
    });
    const before = structuredClone(toolResult);

    renderPlain(renderSharedToolResult(toolResult, { expanded: false }, fakeTheme()));
    renderPlain(renderSharedToolResult(toolResult, { expanded: true }, fakeTheme()));

    assert.deepEqual(toolResult, before);
  });

  it("keeps failure reasons and warning-bearing success reasons in NO_COLOR", () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const failure = renderPlain(
        renderSharedToolResult(
          result("query is required", { success: false, message: "query is required" }),
          { expanded: false },
          fakeTheme(),
        ),
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
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
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

    let backgroundActive = false;
    for (let index = 0; index < rows[1].length;) {
      const sgr = rows[1].slice(index).match(/^\x1b\[([0-9;]*)m/);
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
      assert.equal(backgroundActive, true);
      index += 1;
    }
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
});
