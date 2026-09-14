import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { MEMORY_TOOL_DESCRIPTION, SKILL_TOOL_DESCRIPTION } from "./constants.js";
import { createSharedToolResultRenderer } from "./tools/shared-output-view.js";
import { memoryResultView, searchResultView, skillResultView } from "./tools/tool-result-views.js";
import type { SessionSearchVariant } from "./types.js";

type LoadTool = (name: string) => Promise<{ execute: (...args: any[]) => any }>;

function deferredExecute(name: string, loadTool: LoadTool) {
  return async (...args: any[]) => (await loadTool(name)).execute(...args);
}

export function registerThinTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  sessionSearchVariant: SessionSearchVariant,
  loadTool: LoadTool,
): void {
  registerMemoryTools(pi, loadTool);
  registerSkillTool(pi, loadTool);
  registerMemorySearchTool(pi, loadTool);
  registerSessionSearchTool(pi, sessionSearchVariant, loadTool);
}

function registerMemoryTools(pi: Pick<ExtensionAPI, "registerTool">, loadTool: LoadTool): void {
  const commonDescription = `${MEMORY_TOOL_DESCRIPTION}\n\nThis action-specific tool accepts only the parameters listed in its schema.`;
  const target = StringEnum(["memory", "user", "project", "failure"] as const, {
    description: "Memory scope. Use failure for failures, corrections, insights, and tool quirks.",
  });
  const category = StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, {
    description: "Category for failure memories.",
  });
  const definitions: Array<[string, string, string, TSchema]> = [
    ["memory_add", "Memory Add", `${commonDescription}\n\nAdd one durable entry. The target and content fields are required.`, Type.Object({
      target,
      content: Type.String({ description: "Entry content to save." }),
      category: Type.Optional(category),
      failure_reason: Type.Optional(Type.String({ description: "Why a failure occurred." })),
    })],
    ["memory_replace", "Memory Replace", `${commonDescription}\n\nReplace one existing entry. The target, old_text, and content fields are required.`, Type.Object({
      target,
      old_text: Type.String({ description: "Substring identifying the entry to replace." }),
      content: Type.String({ description: "Replacement entry content." }),
    })],
    ["memory_remove", "Memory Remove", `${commonDescription}\n\nRemove one existing entry. The target and old_text fields are required.`, Type.Object({
      target,
      old_text: Type.String({ description: "Substring identifying the entry to remove." }),
    })],
  ];
  for (const [name, label, description, parameters] of definitions) {
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet: `${label}: persistent memory that survives across sessions`,
      promptGuidelines: [
        "Use this tool proactively when the user corrects you, shares a preference, or reveals durable environment or project facts.",
        "Do not use memory tools for temporary task state, TODO items, or session progress.",
      ],
      renderResult: createSharedToolResultRenderer(memoryResultView),
      parameters,
      execute: deferredExecute(name, loadTool),
    } as any);
  }
}

function registerSkillTool(pi: Pick<ExtensionAPI, "registerTool">, loadTool: LoadTool): void {
  const skillId = Type.String({
    description: "Stable skill id for view/patch/update/delete. e.g., 'global:debug-typescript-errors' or 'project:my-repo:release-app'. Legacy alias 'edit' also accepts this field.",
  });
  pi.registerTool({
    name: "skill_manage",
    label: "Skill Manager",
    description: SKILL_TOOL_DESCRIPTION,
    promptSnippet: "Create, inspect, and update reusable procedures and patterns",
    promptGuidelines: [
      "Use the skill_manage tool after completing complex tasks that required trial and error or multiple tool calls.",
      "Use 'create' to save a new reusable procedure, 'patch' to update a section of an existing skill by skill_id, and 'update' for a full rewrite.",
      "Scope is required on create: choose scope='global' for transferable procedures and scope='project' when the workflow depends on this repo's paths, scripts, conventions, or deploy steps.",
      "Prefer structured fields for create/update/patch: when_to_use, procedure_steps, pitfalls, and verification_steps. The tool renders valid SKILL.md sections for you.",
      "For patch, pass section plus the matching structured field (e.g. section='Procedure' with procedure_steps). Avoid free-form content that is a JSON array/object string.",
      "Prefer 'update' for multi-section rewrites when patch content would be large or format-unstable.",
      "Use 'view' before patching or updating when you need to inspect an existing skill.",
      "Do NOT use skills for temporary task state — only for durable, reusable procedures.",
    ],
    renderResult: createSharedToolResultRenderer(skillResultView),
    parameters: Type.Object({
      action: StringEnum(["create", "view", "patch", "update", "edit", "delete"] as const, { description: "The skill action to perform." }),
      name: Type.Optional(Type.String({ description: "Skill name for create. e.g., 'debug-typescript-errors'." })),
      skill_id: Type.Optional(skillId),
      description: Type.Optional(Type.String({ description: "One-line description of when to use this skill. Required for create; optional for update/edit." })),
      scope: Type.Optional(StringEnum(["global", "project"] as const, { description: "Required for create. Use 'global' for portable procedures and 'project' for repo-specific workflows." })),
      section: Type.Optional(Type.String({ description: "Required for patch. Section header to patch. e.g., 'Procedure', 'Pitfalls', 'Verification', 'When to Use'." })),
      content: Type.Optional(Type.String({ description: "Raw markdown body for create/update/edit, or Markdown section body for patch. Prefer structured fields over free-form content when possible. For patch, JSON arrays are auto-coerced for list sections; JSON objects are rejected." })),
      when_to_use: Type.Optional(Type.String({ description: "Structured create/update/edit field, or structured patch body when section is 'When to Use'." })),
      procedure_steps: Type.Optional(Type.Array(Type.String(), { description: "Structured create/update/edit field, or structured patch body when section is 'Procedure'. Ordered concrete steps." })),
      pitfalls: Type.Optional(Type.Array(Type.String(), { description: "Structured create/update/edit field, or structured patch body when section is 'Pitfalls'." })),
      verification_steps: Type.Optional(Type.Array(Type.String(), { description: "Structured create/update/edit field, or structured patch body when section is 'Verification'." })),
    }, { additionalProperties: false }),
    execute: deferredExecute("skill_manage", loadTool),
  } as any);
}

function registerMemorySearchTool(pi: Pick<ExtensionAPI, "registerTool">, loadTool: LoadTool): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.\n\nUse cases:\n- Find memories about a specific topic: "What do I know about auth setup?"\n- Search project-specific memories: "What conventions does project X follow?"\n- Find user preferences: "What are the user's testing preferences?"\n- Search for past failures: "memory_search('auth', category='failure')"\n\ntarget="project" returns only project-attributed memory entries (the ones labeled [target=project]); combine with project to search a named project.\n\nReturns matching memory entries with their mutation target, scope, and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    promptSnippet: "Search extended memory store (unlimited capacity)",
    promptGuidelines: [
      "Use memory_search when you need context beyond what is in the system prompt.",
      "Use memory_search to find project-specific memories or user preferences.",
      "Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).",
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: "Search query. Use natural language or specific terms." }),
      project: Type.Optional(Type.String({ description: "Filter by project name. Pass null for global memories only." })),
      target: Type.Optional(StringEnum(["memory", "user", "failure", "project"] as const, { description: "Filter by target type: memory, user, failure, or project-attributed memories." })),
      category: Type.Optional(StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, { description: "Filter by memory category." })),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 10, max: 20)." })),
    }),
    execute: deferredExecute("memory_search", loadTool),
  } as any);
}

function registerSessionSearchTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  variant: SessionSearchVariant,
  loadTool: LoadTool,
): void {
  const anchor = variant === "anchors";
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: anchor
      ? `Search Pi session JSONL files in the opt-in anchor mode using a Markdown request.\n\nThis mode accepts only a markdown request. Supported scalar fields are from, to, cwd, and limit. Supported list sections are all, any, and exclude: all terms must match, any requires at least one listed term, and exclude removes matching ranges. It returns compact JSONL line-range anchors, not summaries or previews. Output is plain text: count, optional message, then anchors as path:startLine-endLine with a short reason.\n\nExample:\nfrom: 2026-05-14\nto: 2026-05-15\ncwd: /path/to/project\nlimit: 20\n\nall:\n- alpha\n\nany:\n- beta\n- gamma\n\nexclude:\n- delta`
      : `Search across past Pi coding sessions for relevant conversation context. Use this when the user asks about previous discussions, past work, or when you need context from earlier sessions.\n\nExamples:\n- "What did we discuss about auth last week?"\n- "Find the PR where we fixed the test hang"\n- "What approach did we take for the database migration?"\n\nReturns bounded conversation snippets with session dates and project context. Large messages are truncated with their original character count.`,
    promptSnippet: anchor ? "Search past session JSONL files for compact source anchors" : "Search past conversations for relevant context",
    promptGuidelines: anchor ? [
      "Use session_search with markdown only when the session search anchor mode is configured.",
      "Request source anchors, not summaries or previews.",
      "Use all for required terms, any for alternatives, and exclude for terms that must not appear in a returned range.",
    ] : [
      "Use session_search when the user asks about previous discussions or past work.",
      "Use session_search when you need context from earlier sessions.",
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: anchor ? Type.Object({
      markdown: Type.String({ description: "Markdown request with optional from/to/cwd/limit fields and all/any/exclude lists." }),
    }) : Type.Object({
      query: Type.String({ description: "Search query. Use natural language or specific terms." }),
      project: Type.Optional(Type.String({ description: "Filter by project name (optional)." })),
      role: Type.Optional(StringEnum(["user", "assistant"] as const, { description: "Filter by message role (optional)." })),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 10, min: 1, max: 20).", minimum: 1, maximum: 20 })),
      snippetChars: Type.Optional(Type.Number({ description: "Maximum characters per result snippet (default: 1200, max: 4000).", minimum: 100, maximum: 4000 })),
    }),
    execute: deferredExecute("session_search", loadTool),
  } as any);
}
