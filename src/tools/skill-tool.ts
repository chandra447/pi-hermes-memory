/**
 * Skill tool — registers the LLM-callable `skill` tool for procedural memory.
 * Complements the `memory` tool (declarative knowledge) with procedural knowledge.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { SkillStore } from "../store/skill-store.js";
import { SKILL_TOOL_DESCRIPTION } from "../constants.js";

export function registerSkillTool(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerTool({
    name: "skill",
    label: "Skill",
    description: SKILL_TOOL_DESCRIPTION,
    promptSnippet: "Save or manage reusable procedures and patterns",
    promptGuidelines: [
      "Use the skill tool after completing complex tasks that required trial and error or multiple tool calls.",
      "Use 'create' to save a new reusable procedure, 'patch' to update a section of an existing skill.",
      "Do NOT use skills for temporary task state — only for durable, reusable procedures.",
    ],
    parameters: Type.Object({
      action: StringEnum(["create", "view", "patch", "edit", "delete"] as const),
      name: Type.Optional(
        Type.String({ description: "Skill name (for create). e.g., 'debug-typescript-errors'" })
      ),
      file_name: Type.Optional(
        Type.String({ description: "Skill file name (for view/patch/edit/delete). e.g., 'debug-typescript-errors.md'" })
      ),
      description: Type.Optional(
        Type.String({ description: "One-line description of when to use this skill (for create/edit)" })
      ),
      section: Type.Optional(
        Type.String({ description: "Section header to patch (for patch action). e.g., 'Procedure', 'Pitfalls'" })
      ),
      content: Type.Optional(
        Type.String({ description: "Body content for create, new section content for patch, or new body for edit" })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { action, name, file_name, description, section, content } = params;

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
          if (!content) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "content (skill body) is required for 'create' action." }) }],
              details: {},
            };
          }
          result = await store.create(name, description, content);
          break;

        case "view":
          if (!file_name) {
            // List all skills
            const index = await store.loadIndex();
            return {
              content: [{ type: "text", text: JSON.stringify({ success: true, skills: index }) }],
              details: { skills: index },
            };
          }
          const doc = await store.loadSkill(file_name);
          if (!doc) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `Skill '${file_name}' not found.` }) }],
              details: {},
            };
          }
          result = { success: true, ...doc };
          break;

        case "patch":
          if (!file_name) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "file_name is required for 'patch' action." }) }],
              details: {},
            };
          }
          if (!section) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "section is required for 'patch' action." }) }],
              details: {},
            };
          }
          if (!content) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "content is required for 'patch' action." }) }],
              details: {},
            };
          }
          result = await store.patch(file_name, section, content);
          break;

        case "edit":
          if (!file_name) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "file_name is required for 'edit' action." }) }],
              details: {},
            };
          }
          result = await store.edit(file_name, description || "", content || "");
          break;

        case "delete":
          if (!file_name) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "file_name is required for 'delete' action." }) }],
              details: {},
            };
          }
          result = await store.delete(file_name);
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: create, view, patch, edit, delete`,
          };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
