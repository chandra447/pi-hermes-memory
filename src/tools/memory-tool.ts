/**
 * Memory tool — registers the LLM-callable `memory` tool.
 * Ported from hermes-agent/tools/memory_tool.py (MEMORY_SCHEMA + memory_tool dispatch).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { MemoryStore } from "../store/memory-store.js";
import { MEMORY_TOOL_DESCRIPTION } from "../constants.js";

export function registerMemoryTool(pi: ExtensionAPI, store: MemoryStore): void {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    promptSnippet:
      "Save or manage persistent memory that survives across sessions",
    promptGuidelines: [
      "Use the memory tool proactively when the user corrects you, shares a preference, or reveals personal details worth remembering.",
      "Use the memory tool when you discover environment facts, project conventions, or reusable patterns useful in future sessions.",
      "Do NOT use memory for temporary task state, TODO items, or session progress — only for durable, cross-session facts.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "replace", "remove"] as const),
      target: StringEnum(["memory", "user"] as const),
      content: Type.Optional(
        Type.String({ description: "Entry content for add/replace" })
      ),
      old_text: Type.Optional(
        Type.String({
          description:
            "Substring identifying entry for replace/remove",
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { action, target, content, old_text } = params;

      let result;
      switch (action) {
        case "add":
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "Content is required for 'add' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = store.add(target, content);
          break;

        case "replace":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "content is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = store.replace(target, old_text, content);
          break;

        case "remove":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'remove' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = store.remove(target, old_text);
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: add, replace, remove`,
          };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
