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

  it("sanitizes only the rendered copy of hostile tool text and failure details", () => {
    const hostileText = [
      "safe 世界 \x1b]52;c;YXR0YWNr\x07 after OSC",
      "styled \x1b[31mred\x1b[0m moved \x1b[2J after CSI",
      "private \x1bPdanger\x1b\\ after DCS",
      "linked \x1b]8;;https://evil.example\x1b\\label\x1b]8;;\x1b\\ after ST",
      "carriage\rreturn binary\x00\x08\x7f end",
    ].join("\n");
    const hostileReason = "query \x1b]52;c;YXR0YWNr\x07 is required\x00";
    const toolResult = result(hostileText, {
      success: false,
      message: hostileReason,
      nested: { keep: true },
    });
    const before = structuredClone(toolResult);

    const collapsed = renderToolResult(toolResult, false);
    const expanded = renderToolResult(toolResult, true);

    for (const rendered of [collapsed, expanded]) {
      assert.doesNotMatch(rendered, /\x1b|\x07|\x00|\x08|\x7f|\r/);
    }
    assert.match(collapsed, /query .* is required/);
    assert.match(expanded, /safe 世界/);
    assert.match(expanded, /styled red moved  after CSI/);
    assert.match(expanded, /private danger\\ after DCS/);
    assert.match(expanded, /linked label after ST/);
    assert.match(expanded, /carriagereturn binary end/);
    assert.deepEqual(toolResult, before);

    const adapterResult = result("safe", {
      success: true,
      message: "Entry added.",
      target: "memory\x1b[2J",
      usage: "1 entry\x00",
    });
    const adapterBefore = structuredClone(adapterResult);
    const adapterRendered = renderPlain(createSharedToolResultRenderer(memoryResultView)(
      adapterResult,
      { expanded: false, isPartial: false },
      fakeTheme(),
      { isError: false },
    ));
    assert.doesNotMatch(adapterRendered, /\x1b|\x00/);
    assert.deepEqual(adapterResult, adapterBefore);
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

  it("keeps the tool-card background after sanitizing expanded ANSI and CJK text", () => {
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

  it("uses Pi shell state for the card background and logical status for foreground", () => {
    const scenarios = [
      { partial: true, isError: false, success: false, background: "toolPendingBg", foreground: "warning" },
      { partial: false, isError: true, success: true, background: "toolErrorBg", foreground: "error" },
      { partial: false, isError: false, success: true, background: "toolSuccessBg", foreground: "toolOutput" },
      { partial: false, isError: false, success: false, background: "toolSuccessBg", foreground: "error" },
    ] as const;

    for (const scenario of scenarios) {
      const backgrounds: string[] = [];
      const foregrounds: string[] = [];
      const theme = {
        fg: (color: string, text: string): string => {
          foregrounds.push(color);
          return text;
        },
        getBgAnsi: (color: string): string => {
          backgrounds.push(color);
          return "";
        },
      } as any;
      const message = scenario.success ? "done" : "query is required";
      const toolResult = result(message, { success: scenario.success, message });

      const renderer = createSharedToolResultRenderer();
      const rendered = renderPlain(renderer(
        toolResult,
        { expanded: false, isPartial: scenario.partial },
        theme,
        { isError: scenario.isError },
      ));
      renderPlain(renderer(
        toolResult,
        { expanded: true, isPartial: scenario.partial },
        theme,
        { isError: scenario.isError },
      ));

      assert.deepEqual(backgrounds, [scenario.background, scenario.background]);
      assert.deepEqual(foregrounds, [scenario.foreground]);
      if (!scenario.success) assert.match(rendered, /query is required/);
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

  it("summarizes successful failure memory from the real producer result shape", () => {
    // MemoryResult has no category field; producers encode it only in message.
    const details = {
      success: true,
      target: "failure",
      message: "Failure memory saved: tool-quirk",
      entry_count: 16,
      usage: "92% — 9271/10000 chars",
    };
    const fullText = JSON.stringify(details);
    const toolResult = result(fullText, details);
    const before = structuredClone(toolResult);
    const view = memoryResultView(toolResult);

    assert.equal(view.status, "success");
    assert.equal(
      view.summary,
      "Saved · target: failure · category: tool-quirk · 16 entries · 92% — 9271/10000 chars",
    );
    assert.doesNotMatch(view.summary, /^failure:/);
    assert.equal(view.expandedText, fullText);
    assert.deepEqual(toolResult, before);

    const collapsed = renderPlain(
      createSharedToolResultRenderer(memoryResultView)(
        toolResult,
        { expanded: false, isPartial: false },
        fakeTheme(),
        { isError: false },
      ),
    );
    assert.match(
      collapsed,
      /Saved · target: failure · category: tool-quirk · 16 entries · 92% — 9271\/10000 chars/,
    );
    assert.doesNotMatch(collapsed, /^failure:/);
  });
});
