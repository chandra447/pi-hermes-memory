import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSkillRows,
  buildUnifiedSkillRows,
  collectLoadedSkillsFromCommands,
  confirmDeleteSelectedSkills,
  deleteSelectedSkills,
  filterSkillRows,
  moveSelectedSkills,
  registerSkillsCommand,
  SkillsManagerModal,
  type SkillBatchActionResult,
} from "../../src/handlers/skills-command.js";
import type { SkillIndex, SkillResult } from "../../src/types.js";

const SAMPLE_SKILLS: SkillIndex[] = [
  {
    skillId: "global:debug-typescript-errors",
    scope: "global",
    fileName: "SKILL.md",
    path: "/tmp/global/debug-typescript-errors/SKILL.md",
    name: "debug-typescript-errors",
    displayName: "Debug TypeScript Errors",
    description: "Trace compiler issues step by step",
    created: "2026-05-19",
    updated: "2026-05-21",
  },
  {
    skillId: "project:demo-project:deploy-checklist",
    scope: "project",
    fileName: "SKILL.md",
    path: "/tmp/project/deploy-checklist/SKILL.md",
    projectName: "demo-project",
    name: "deploy-checklist",
    displayName: "Deploy Checklist",
    description: "Project release checklist",
    created: "2026-05-18",
    updated: "2026-05-20",
  },
];

const SORT_MODE_SKILLS: SkillIndex[] = [
  {
    skillId: "global:zebra-runbook",
    scope: "global",
    fileName: "SKILL.md",
    path: "/tmp/global/zebra-runbook/SKILL.md",
    name: "zebra-runbook",
    displayName: "Zebra Runbook",
    description: "Older creation date, newer update date",
    created: "2026-05-18",
    updated: "2026-05-21",
  },
  {
    skillId: "project:demo-project:alpha-checklist",
    scope: "project",
    fileName: "SKILL.md",
    path: "/tmp/project/alpha-checklist/SKILL.md",
    projectName: "demo-project",
    name: "alpha-checklist",
    displayName: "Alpha Checklist",
    description: "Newer creation date, older update date",
    created: "2026-05-22",
    updated: "2026-05-20",
  },
];

const LOADED_SKILL_COMMANDS = [
  {
    name: "skill:debug-typescript-errors",
    description: "Trace compiler issues step by step",
    source: "skill",
    sourceInfo: { path: "/tmp/global/debug-typescript-errors/SKILL.md" },
  },
  {
    name: "skill:langgraph-fundamentals",
    description: "LangGraph patterns",
    source: "skill",
    sourceInfo: { path: "/Users/demo/.agents/skills/langgraph-fundamentals/SKILL.md" },
  },
  {
    name: "memory-skills",
    description: "not a skill command",
    source: "extension",
    sourceInfo: { path: "/tmp/ignore" },
  },
] as const;

describe("skills command helpers", () => {
  it("buildSkillRows preserves selected ids", () => {
    const rows = buildSkillRows(SAMPLE_SKILLS, new Set(["project:demo-project:deploy-checklist"]));

    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].selected, false);
    assert.strictEqual(rows[1].selected, true);
    assert.strictEqual(rows[0].searchText.includes("Debug TypeScript Errors"), true);
  });

  it("filterSkillRows uses fuzzy skill-name matching", () => {
    const rows = buildSkillRows(SAMPLE_SKILLS);
    const filtered = filterSkillRows(rows, "dbg ts err");

    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].skillId, "global:debug-typescript-errors");
  });

  it("collectLoadedSkillsFromCommands returns loaded runtime skills only", () => {
    const loaded = collectLoadedSkillsFromCommands(LOADED_SKILL_COMMANDS as any);

    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[0]?.name, "debug-typescript-errors");
    assert.strictEqual(loaded[1]?.name, "langgraph-fundamentals");
  });

  it("collectLoadedSkillsFromCommands ignores malformed and pathless commands", () => {
    const loaded = collectLoadedSkillsFromCommands([
      { source: "skill", name: "skill:valid", sourceInfo: { path: "/tmp/valid/SKILL.md" } },
      { source: "skill", name: "skill:no-path", sourceInfo: {} },
      { source: "skill", name: "skill:blank-path", sourceInfo: { path: "   " } },
      { source: "skill", name: "   ", sourceInfo: { path: "/tmp/blank-name/SKILL.md" } },
      { source: "skill", sourceInfo: { path: "/tmp/missing-name/SKILL.md" } },
      { source: "skill", name: 123, sourceInfo: { path: "/tmp/invalid-name/SKILL.md" } },
      { source: "extension", name: "memory-skills", sourceInfo: { path: "/tmp/ignore/SKILL.md" } },
      null as any,
    ] as any);

    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0]?.name, "valid");
    assert.strictEqual(loaded[0]?.path, "/tmp/valid/SKILL.md");
  });

  it("buildUnifiedSkillRows merges managed and external skills", () => {
    const loaded = collectLoadedSkillsFromCommands(LOADED_SKILL_COMMANDS as any);
    const rows = buildUnifiedSkillRows(SAMPLE_SKILLS, loaded);

    assert.strictEqual(rows.length, 3);
    const external = rows.find((row) => row.category === "E");
    assert.ok(external);
    assert.strictEqual(external?.mutable, false);
    assert.ok(external?.displayPath.includes(".agents"));
  });

  it("buildUnifiedSkillRows keeps managed skills sorted by updated recency", () => {
    const loaded = collectLoadedSkillsFromCommands(LOADED_SKILL_COMMANDS as any);
    const rows = buildUnifiedSkillRows(SAMPLE_SKILLS, loaded);

    assert.strictEqual(rows[0]?.skillId, "global:debug-typescript-errors");
    assert.strictEqual(rows[1]?.skillId, "project:demo-project:deploy-checklist");
    assert.strictEqual(rows[2]?.category, "E");
  });

  it("buildUnifiedSkillRows can sort by created date or name", () => {
    const loaded = collectLoadedSkillsFromCommands(LOADED_SKILL_COMMANDS as any);

    const createdRows = buildUnifiedSkillRows(SORT_MODE_SKILLS, loaded, new Set<string>(), "created");
    assert.strictEqual(createdRows[0]?.skillId, "project:demo-project:alpha-checklist");
    assert.strictEqual(createdRows[1]?.skillId, "global:zebra-runbook");

    const nameRows = buildUnifiedSkillRows(SORT_MODE_SKILLS, loaded, new Set<string>(), "name");
    assert.strictEqual(nameRows[0]?.skillId, "project:demo-project:alpha-checklist");
    assert.strictEqual(nameRows[1]?.displayName, "debug-typescript-errors");
    assert.strictEqual(nameRows[2]?.displayName, "langgraph-fundamentals");
    assert.strictEqual(nameRows[3]?.skillId, "global:zebra-runbook");
  });

  it("moveSelectedSkills blocks project moves without an active project", async () => {
    const store = {
      getProjectName: () => null,
      loadIndex: async () => SAMPLE_SKILLS,
      move: async () => ({ success: true } as SkillResult),
    };

    const result = await moveSelectedSkills(store as any, ["global:debug-typescript-errors"], "project");

    assert.strictEqual(result.summaryLines[0], "Move to project is unavailable: no active project detected.");
    assert.deepStrictEqual(result.retainSelectedSkillIds, ["global:debug-typescript-errors"]);
  });

  it("moveSelectedSkills keeps partial successes and retains blocked selection", async () => {
    const moves = new Map<string, SkillResult>([
      [
        "global:debug-typescript-errors",
        {
          success: true,
          skillId: "project:demo-project:debug-typescript-errors",
          scope: "project",
          message: "Skill 'Debug TypeScript Errors' moved to project.",
        },
      ],
      [
        "project:demo-project:deploy-checklist",
        {
          success: false,
          error: "Destination already exists.",
          conflictType: "scope-conflict",
        },
      ],
    ]);

    const refreshed: SkillIndex[] = [
      {
        ...SAMPLE_SKILLS[1],
        skillId: "project:demo-project:debug-typescript-errors",
        name: "debug-typescript-errors",
        displayName: "Debug TypeScript Errors",
        path: "/tmp/project/debug-typescript-errors/SKILL.md",
        description: "Trace compiler issues step by step",
      },
      SAMPLE_SKILLS[1],
    ];

    const store = {
      getProjectName: () => "demo-project",
      loadIndex: async () => refreshed,
      move: async (skillId: string) => moves.get(skillId)!,
    };

    const result = await moveSelectedSkills(
      store as any,
      ["global:debug-typescript-errors", "project:demo-project:deploy-checklist"],
      "project",
    );

    assert.ok(result.summaryLines[0].includes("Moved 1 skill"));
    assert.ok(result.summaryLines.some((line) => line.includes("Blocked 1 skill")));
    assert.deepStrictEqual(result.retainSelectedSkillIds, ["project:demo-project:deploy-checklist"]);
    assert.strictEqual(result.focusSkillId, "project:demo-project:deploy-checklist");
    assert.strictEqual(result.skills.length, 2);
  });

  it("deleteSelectedSkills reports blocked deletes and refreshes skills", async () => {
    const store = {
      loadIndex: async () => [SAMPLE_SKILLS[1]],
      delete: async (skillId: string) => skillId === SAMPLE_SKILLS[0].skillId
        ? { success: true, skillId, scope: "global" as const }
        : { success: false, error: "Skill missing." },
    };

    const result = await deleteSelectedSkills(
      store as any,
      [SAMPLE_SKILLS[0].skillId, SAMPLE_SKILLS[1].skillId],
    );

    assert.ok(result.summaryLines[0].includes("Deleted 1 skill"));
    assert.ok(result.summaryLines.some((line) => line.includes("Blocked 1 skill")));
    assert.deepStrictEqual(result.retainSelectedSkillIds, [SAMPLE_SKILLS[1].skillId]);
  });

  it("moveSelectedSkills treats thrown move errors as blocked items", async () => {
    const store = {
      getProjectName: () => "demo-project",
      loadIndex: async () => SAMPLE_SKILLS,
      move: async (skillId: string) => {
        if (skillId === SAMPLE_SKILLS[0].skillId) {
          throw new Error("permission denied");
        }
        return { success: true, skillId: "global:deploy-checklist", scope: "global" as const };
      },
    };

    const result = await moveSelectedSkills(store as any, [SAMPLE_SKILLS[0].skillId, SAMPLE_SKILLS[1].skillId], "global");

    assert.ok(result.summaryLines.some((line) => line.includes("Blocked 1 skill")));
    assert.ok(result.summaryLines.some((line) => line.includes("permission denied")));
    assert.deepStrictEqual(result.retainSelectedSkillIds, [SAMPLE_SKILLS[0].skillId]);
  });

  it("deleteSelectedSkills treats thrown delete errors as blocked items", async () => {
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      delete: async (skillId: string) => {
        if (skillId === SAMPLE_SKILLS[1].skillId) {
          throw new Error("unlink denied");
        }
        return { success: true, skillId, scope: "global" as const };
      },
    };

    const result = await deleteSelectedSkills(store as any, [SAMPLE_SKILLS[0].skillId, SAMPLE_SKILLS[1].skillId]);

    assert.ok(result.summaryLines.some((line) => line.includes("Blocked 1 skill")));
    assert.ok(result.summaryLines.some((line) => line.includes("unlink denied")));
    assert.deepStrictEqual(result.retainSelectedSkillIds, [SAMPLE_SKILLS[1].skillId]);
  });

  it("confirmDeleteSelectedSkills keeps selection when user cancels", async () => {
    let prompts = 0;
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      delete: async () => ({ success: true }),
    };

    const result = await confirmDeleteSelectedSkills(
      async () => {
        prompts++;
        return false;
      },
      store as any,
      [SAMPLE_SKILLS[0].skillId],
    );

    assert.strictEqual(prompts, 1);
    assert.deepStrictEqual(result.retainSelectedSkillIds, [SAMPLE_SKILLS[0].skillId]);
    assert.strictEqual(result.summaryLines[0], "Delete cancelled.");
  });
});

function createModalHarness() {
  let renderCount = 0;
  return {
    tui: {
      requestRender: () => {
        renderCount++;
      },
      terminal: { rows: 42 },
    },
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    getRenderCount: () => renderCount,
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SkillsManagerModal", () => {
  it("toggles selection and sends selected ids for move action", async () => {
    const harness = createModalHarness();
    const captured: Array<{ scope: string; skillIds: string[] }> = [];

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async (scope, skillIds) => {
          captured.push({ scope, skillIds });
          return { skills: SAMPLE_SKILLS, summaryLines: ["done"] };
        },
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput(" ");
    modal.handleInput("g");
    await nextTick();

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].scope, "global");
    assert.deepStrictEqual(captured[0].skillIds, ["global:debug-typescript-errors"]);
  });

  it("supports slash search and typed filtering", () => {
    const harness = createModalHarness();
    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput("/");
    modal.handleInput("z");
    modal.handleInput("z");

    const output = modal.render(100).join("\n");
    assert.ok(output.includes("No skills match the current filters/search."));
  });

  it("redirects printable keys to search from list focus", () => {
    const harness = createModalHarness();
    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput("z");
    const output = modal.render(100).join("\n");
    assert.ok(output.includes("No skills match the current filters/search."));
  });

  it("uses in-modal delete confirmation and cancels with n", () => {
    const harness = createModalHarness();
    let deleteCalls = 0;

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async () => {
          deleteCalls++;
          return { skills: SAMPLE_SKILLS, summaryLines: ["deleted"] };
        },
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput(" ");
    modal.handleInput("d");
    let output = modal.render(100).join("\n");
    assert.ok(output.includes("Press y to confirm or n to cancel"));

    modal.handleInput("n");
    output = modal.render(100).join("\n");
    assert.ok(output.includes("Delete cancelled."));
    assert.strictEqual(deleteCalls, 0);
  });

  it("confirms delete in-modal with y", async () => {
    const harness = createModalHarness();
    const capturedDeletes: string[][] = [];

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async (skillIds) => {
          capturedDeletes.push(skillIds);
          return { skills: [SAMPLE_SKILLS[1]], summaryLines: ["deleted"] };
        },
        close: () => undefined,
        projectName: "demo-project",
      },
    );

    modal.handleInput(" ");
    modal.handleInput("d");
    modal.handleInput("y");
    await nextTick();

    assert.strictEqual(capturedDeletes.length, 1);
    assert.deepStrictEqual(capturedDeletes[0], ["global:debug-typescript-errors"]);
  });

  it("stops rendering updates after close during async actions", async () => {
    const harness = createModalHarness();
    let resolveMove: ((result: SkillBatchActionResult) => void) | null = null;
    let closeCount = 0;

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      buildSkillRows(SAMPLE_SKILLS),
      {
        moveSelected: async () => {
          return await new Promise<SkillBatchActionResult>((resolve) => {
            resolveMove = resolve;
          });
        },
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => {
          closeCount++;
        },
        projectName: "demo-project",
      },
    );

    modal.handleInput("g");
    modal.handleInput("\u001b");
    assert.strictEqual(closeCount, 1);

    const renderCountBeforeResolve = harness.getRenderCount();
    resolveMove?.({ skills: SAMPLE_SKILLS, summaryLines: ["moved"] });
    await nextTick();

    assert.strictEqual(harness.getRenderCount(), renderCountBeforeResolve);
  });

  it("supports in-modal category filters", () => {
    const harness = createModalHarness();
    const loaded = collectLoadedSkillsFromCommands(LOADED_SKILL_COMMANDS as any);
    const rows = buildUnifiedSkillRows(SAMPLE_SKILLS, loaded);

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      rows,
      {
        moveSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
      { managedSkills: SAMPLE_SKILLS, loadedSkills: loaded },
    );

    modal.handleInput("f");
    modal.handleInput(" "); // disable global
    modal.handleInput("\u001b[B");
    modal.handleInput(" "); // disable project
    modal.handleInput("\r"); // apply

    const output = modal.render(120).join("\n");
    assert.ok(output.includes("langgraph-fundamentals"));
    assert.ok(!output.includes("Deploy Checklist"));
  });

  it("cycles sort mode with s and shows the active mode in the modal", () => {
    const harness = createModalHarness();
    const loaded = collectLoadedSkillsFromCommands(LOADED_SKILL_COMMANDS as any);
    const rows = buildUnifiedSkillRows(SORT_MODE_SKILLS, loaded);

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      rows,
      {
        moveSelected: async () => ({ skills: SORT_MODE_SKILLS, summaryLines: ["done"] }),
        deleteSelected: async () => ({ skills: SORT_MODE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
      { managedSkills: SORT_MODE_SKILLS, loadedSkills: loaded },
    );

    let output = modal.render(120).join("\n");
    assert.ok(output.includes("sort: Updated"));
    assert.ok(output.includes("Zebra Runbook"));

    modal.handleInput("s");
    output = modal.render(120).join("\n");
    assert.ok(output.includes("sort: Created"));
    assert.ok(output.includes("Sort mode: Created."));

    modal.handleInput("s");
    output = modal.render(120).join("\n");
    assert.ok(output.includes("sort: Name"));
    assert.ok(output.includes("Alpha Checklist"));
  });

  it("blocks external skill mutations as read-only", async () => {
    const harness = createModalHarness();
    const loaded = collectLoadedSkillsFromCommands(LOADED_SKILL_COMMANDS as any);
    const rows = buildUnifiedSkillRows(SAMPLE_SKILLS, loaded);
    let moveCalls = 0;

    const modal = new SkillsManagerModal(
      harness.tui as any,
      harness.theme as any,
      rows,
      {
        moveSelected: async () => {
          moveCalls++;
          return { skills: SAMPLE_SKILLS, summaryLines: ["done"] };
        },
        deleteSelected: async () => ({ skills: SAMPLE_SKILLS, summaryLines: ["done"] }),
        close: () => undefined,
        projectName: "demo-project",
      },
      { managedSkills: SAMPLE_SKILLS, loadedSkills: loaded },
    );

    modal.handleInput("f");
    modal.handleInput(" ");
    modal.handleInput("\u001b[B");
    modal.handleInput(" ");
    modal.handleInput("\r");

    modal.handleInput(" ");
    modal.handleInput("g");
    await nextTick();

    const output = modal.render(120).join("\n");
    assert.strictEqual(moveCalls, 0);
    assert.ok(output.includes("read-only"));
  });
});

describe("registerSkillsCommand", () => {
  it("falls back to notify output when custom UI is unavailable", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const notifications: Array<{ message: string; severity: string }> = [];
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
    };

    registerSkillsCommand(pi as any, store as any);
    assert.strictEqual(commands.length, 1);

    await commands[0].handler({}, {
      hasUI: false,
      ui: {
        notify: (message: string, severity: string) => notifications.push({ message, severity }),
      },
    });

    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].severity, "info");
    assert.ok(notifications[0].message.includes("Procedural Skills"));
  });

  it("uses pi.getCommands runtime inventory for external skills", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const notifications: Array<{ message: string; severity: string }> = [];
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
      getCommands: () => LOADED_SKILL_COMMANDS,
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
    };

    registerSkillsCommand(pi as any, store as any);

    await commands[0].handler({}, {
      hasUI: false,
      ui: {
        notify: (message: string, severity: string) => notifications.push({ message, severity }),
      },
    });

    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].severity, "info");
    assert.ok(notifications[0].message.includes("[E] External Skills"));
    assert.ok(notifications[0].message.includes("langgraph-fundamentals"));
  });

  it("gracefully handles getCommands errors without custom UI", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const notifications: Array<{ message: string; severity: string }> = [];
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
    };

    registerSkillsCommand(pi as any, store as any);
    assert.strictEqual(commands.length, 1);

    await commands[0].handler({}, {
      hasUI: false,
      getCommands: () => {
        throw new Error("command registry unavailable");
      },
      ui: {
        notify: (message: string, severity: string) => notifications.push({ message, severity }),
      },
    });

    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].severity, "info");
    assert.ok(notifications[0].message.includes("Procedural Skills"));
  });

  it("opens a custom modal when interactive UI is available", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    let customInvoked = false;
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
      move: async () => ({ success: true } as SkillResult),
      delete: async () => ({ success: true } as SkillResult),
    };

    registerSkillsCommand(pi as any, store as any);

    await commands[0].handler({}, {
      hasUI: true,
      ui: {
        custom: async (
          factory: Function,
          options: { overlay?: boolean },
        ) => {
          customInvoked = true;
          assert.strictEqual(options.overlay, true);
          // factory invocation is unnecessary for this contract-level test
          return undefined;
        },
        confirm: async () => true,
        notify: () => undefined,
      },
    });

    assert.strictEqual(customInvoked, true);
  });

  it("opens custom modal even when getCommands throws", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    let customInvoked = false;
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
      move: async () => ({ success: true } as SkillResult),
      delete: async () => ({ success: true } as SkillResult),
    };

    registerSkillsCommand(pi as any, store as any);

    await commands[0].handler({}, {
      hasUI: true,
      getCommands: () => {
        throw new Error("command registry unavailable");
      },
      ui: {
        custom: async (factory: Function, options: { overlay?: boolean }) => {
          customInvoked = true;
          assert.strictEqual(options.overlay, true);
          return undefined;
        },
        confirm: async () => true,
        notify: () => undefined,
      },
    });

    assert.strictEqual(customInvoked, true);
  });

  it("falls back to read-only notify output when custom modal throws", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const notifications: Array<{ message: string; severity: string }> = [];
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
      move: async () => ({ success: true } as SkillResult),
      delete: async () => ({ success: true } as SkillResult),
    };

    registerSkillsCommand(pi as any, store as any);

    await commands[0].handler({}, {
      hasUI: true,
      ui: {
        custom: async () => {
          throw new Error("UI backend unavailable");
        },
        confirm: async () => true,
        notify: (message: string, severity: string) => notifications.push({ message, severity }),
      },
    });

    assert.strictEqual(notifications.length, 2);
    assert.strictEqual(notifications[0].severity, "warning");
    assert.ok(notifications[0].message.includes("read-only list fallback"));
    assert.strictEqual(notifications[1].severity, "info");
    assert.ok(notifications[1].message.includes("Procedural Skills"));
  });

  it("falls back to read-only list when both custom modal and getCommands fail", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const notifications: Array<{ message: string; severity: string }> = [];
    const pi = {
      registerCommand: (name: string, opts: { handler: Function }) => {
        commands.push({ name, handler: opts.handler });
      },
    };
    const store = {
      loadIndex: async () => SAMPLE_SKILLS,
      getProjectName: () => "demo-project",
      move: async () => ({ success: true } as SkillResult),
      delete: async () => ({ success: true } as SkillResult),
    };

    registerSkillsCommand(pi as any, store as any);

    await commands[0].handler({}, {
      hasUI: true,
      getCommands: () => {
        throw new Error("command registry unavailable");
      },
      ui: {
        custom: async () => {
          throw new Error("UI backend unavailable");
        },
        confirm: async () => true,
        notify: (message: string, severity: string) => notifications.push({ message, severity }),
      },
    });

    assert.strictEqual(notifications.length, 2);
    assert.strictEqual(notifications[0].severity, "warning");
    assert.ok(notifications[0].message.includes("read-only list fallback"));
    assert.strictEqual(notifications[1].severity, "info");
    assert.ok(notifications[1].message.includes("Procedural Skills"));
  });
});
