/**
 * Skill manager tool — registers the LLM-callable `skill_manage` tool for procedural memory.
 * Complements the `memory` tool (declarative knowledge) with procedural knowledge.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { SkillStore } from "../store/skill-store.js";
import { SKILL_TOOL_DESCRIPTION } from "../constants.js";

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatOrderedList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function formatBulletList(items: string[], fallback: string): string {
  if (items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function buildStructuredSkillBody(
  whenToUse: string,
  procedureSteps: string[],
  pitfalls: string[],
  verificationSteps: string[],
): string {
  return [
    "## When to Use",
    whenToUse,
    "",
    "## Procedure",
    formatOrderedList(procedureSteps),
    "",
    "## Pitfalls",
    formatBulletList(pitfalls, "No notable pitfalls recorded yet."),
    "",
    "## Verification",
    formatOrderedList(verificationSteps),
  ].join("\n");
}

const SKILL_ID_PARAM = Type.String({
  description: "Stable skill id for view/patch/update/delete. e.g., 'global:debug-typescript-errors' or 'project:my-repo:release-app'. Legacy alias 'edit' also accepts this field.",
});

const SKILL_TOOL_PARAMETERS = Type.Object({
  action: StringEnum(["create", "view", "patch", "update", "edit", "delete"] as const, {
    description: "The skill action to perform.",
  }),
  name: Type.Optional(Type.String({
    description: "Skill name for create. e.g., 'debug-typescript-errors'.",
  })),
  skill_id: Type.Optional(SKILL_ID_PARAM),
  description: Type.Optional(Type.String({
    description: "One-line description of when to use this skill. Required for create; optional for update/edit.",
  })),
  scope: Type.Optional(StringEnum(["global", "project"] as const, {
    description: "Required for create. Use 'global' for portable procedures and 'project' for repo-specific workflows.",
  })),
  section: Type.Optional(Type.String({
    description: "Required for patch. Section header to patch. e.g., 'Procedure', 'Pitfalls', 'Verification', 'When to Use'.",
  })),
  content: Type.Optional(Type.String({
    description: "Raw markdown body for create/update/edit, or Markdown section body for patch. Prefer structured fields over free-form content when possible. For patch, JSON arrays are auto-coerced for list sections; JSON objects are rejected.",
  })),
  when_to_use: Type.Optional(Type.String({
    description: "Structured create/update/edit field, or structured patch body when section is 'When to Use'.",
  })),
  procedure_steps: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field, or structured patch body when section is 'Procedure'. Ordered concrete steps.",
  })),
  pitfalls: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field, or structured patch body when section is 'Pitfalls'.",
  })),
  verification_steps: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field, or structured patch body when section is 'Verification'.",
  })),
}, { additionalProperties: false });

export const SKILL_MANAGE_TOOL_NAME = "skill_manage";

export function registerSkillTool(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerTool({
    name: SKILL_MANAGE_TOOL_NAME,
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
    parameters: SKILL_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const skillParams = params as {
        action: "create" | "view" | "patch" | "update" | "edit" | "delete";
        name?: string;
        skill_id?: string;
        description?: string;
        scope?: "global" | "project";
        section?: string;
        content?: string;
        when_to_use?: string;
        procedure_steps?: unknown;
        pitfalls?: unknown;
        verification_steps?: unknown;
      };
      const {
        action,
        name,
        skill_id,
        description,
        scope,
        section,
        content,
        when_to_use,
        procedure_steps,
        pitfalls,
        verification_steps,
      } = skillParams;

      const whenToUse = typeof when_to_use === "string" ? when_to_use.trim() : "";
      const procedureSteps = normalizeTextList(procedure_steps);
      const pitfallItems = normalizeTextList(pitfalls);
      const verificationSteps = normalizeTextList(verification_steps);
      const hasStructuredBody = Boolean(whenToUse) || procedureSteps.length > 0 || pitfallItems.length > 0 || verificationSteps.length > 0;

      const buildBodyOrError = () => {
        if (content?.trim()) return { body: content.trim() };
        if (!hasStructuredBody) {
          return {
            error: "Either content or structured fields are required. Prefer when_to_use, procedure_steps, pitfalls, and verification_steps for create/update.",
          };
        }
        if (!whenToUse) {
          return { error: "when_to_use is required when content is omitted." };
        }
        if (procedureSteps.length === 0) {
          return { error: "procedure_steps is required when content is omitted." };
        }
        if (verificationSteps.length === 0) {
          return { error: "verification_steps is required when content is omitted." };
        }
        return {
          body: buildStructuredSkillBody(whenToUse, procedureSteps, pitfallItems, verificationSteps),
        };
      };

      let result;
      switch (action) {
        case "create":
          if (!name) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "name is required for 'create' action." }) }],
              details: {},
            };
          }
          if (!description) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "description is required for 'create' action." }) }],
              details: {},
            };
          }
          const createBodyResult = buildBodyOrError();
          if (!createBodyResult.body) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: createBodyResult.error }) }],
              details: {},
            };
          }
          if (!scope) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "scope is required for 'create' action. Use 'global' or 'project'." }) }],
              details: {},
            };
          }
          result = await store.create(name, description, createBodyResult.body, scope);
          break;

        case "view":
          if (!skill_id) {
            const index = await store.loadIndex();
            return {
              content: [{ type: "text", text: JSON.stringify({ success: true, skills: index }) }],
              details: { skills: index },
            };
          }
          const doc = await store.loadSkill(skill_id);
          if (!doc) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `Skill '${skill_id}' not found.` }) }],
              details: {},
            };
          }
          result = { success: true, ...doc };
          break;

        case "patch": {
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "skill_id is required for 'patch' action." }) }],
              details: {},
            };
          }
          if (!section) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "section is required for 'patch' action." }) }],
              details: {},
            };
          }

          const sectionKey = section.replace(/^#+\s*/, "").trim().toLowerCase();
          let patchContent = content?.trim() ?? "";

          // Prefer structured fields matching the target section so the LLM
          // does not have to invent Markdown list formatting.
          if (sectionKey === "procedure" && procedureSteps.length > 0) {
            patchContent = formatOrderedList(procedureSteps);
          } else if (sectionKey === "pitfalls" && pitfallItems.length > 0) {
            patchContent = formatBulletList(pitfallItems, "No notable pitfalls recorded yet.");
          } else if (sectionKey === "verification" && verificationSteps.length > 0) {
            patchContent = formatOrderedList(verificationSteps);
          } else if ((sectionKey === "when to use" || sectionKey === "when_to_use") && whenToUse) {
            patchContent = whenToUse;
          } else if (!patchContent && hasStructuredBody) {
            // Allow a single structured field even if section name is non-standard.
            if (procedureSteps.length > 0 && pitfallItems.length === 0 && verificationSteps.length === 0 && !whenToUse) {
              patchContent = formatOrderedList(procedureSteps);
            } else if (pitfallItems.length > 0 && procedureSteps.length === 0 && verificationSteps.length === 0 && !whenToUse) {
              patchContent = formatBulletList(pitfallItems, "No notable pitfalls recorded yet.");
            } else if (verificationSteps.length > 0 && procedureSteps.length === 0 && pitfallItems.length === 0 && !whenToUse) {
              patchContent = formatOrderedList(verificationSteps);
            } else if (whenToUse && procedureSteps.length === 0 && pitfallItems.length === 0 && verificationSteps.length === 0) {
              patchContent = whenToUse;
            } else {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "For patch, provide content or exactly one structured field matching the target section (procedure_steps, pitfalls, verification_steps, or when_to_use). Use update for multi-section rewrites.",
                  }),
                }],
                details: {},
              };
            }
          }

          if (!patchContent) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: "content or a matching structured field is required for 'patch' action. Prefer procedure_steps/pitfalls/verification_steps/when_to_use.",
                }),
              }],
              details: {},
            };
          }

          result = await store.patch(skill_id, section, patchContent);
          break;
        }

        case "update":
        case "edit": {
          const updateActionLabel = action === "edit" ? "edit" : "update";
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `skill_id is required for '${updateActionLabel}' action.` }) }],
              details: {},
            };
          }
          const updateBodyResult = buildBodyOrError();
          const nextDescription = description?.trim() || "";
          const nextBody = updateBodyResult.body ?? content?.trim() ?? "";
          if (!nextDescription && !nextBody) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `Provide description, content, or structured fields for '${updateActionLabel}'.` }) }],
              details: {},
            };
          }
          if (hasStructuredBody && !updateBodyResult.body) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: updateBodyResult.error }) }],
              details: {},
            };
          }
          result = await store.edit(skill_id, nextDescription, nextBody);
          break;
        }

        case "delete":
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "skill_id is required for 'delete' action." }) }],
              details: {},
            };
          }
          result = await store.delete(skill_id);
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: create, view, patch, update, delete`,
          };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
