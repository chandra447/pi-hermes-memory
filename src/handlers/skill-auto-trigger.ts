/**
 * Skill auto-trigger — after complex tasks (8+ tool calls, 2+ distinct tool types),
 * trigger automatic skill extraction via pi.exec().
 *
 * This implements Hermes' "self-evaluation checkpoint" pattern.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { SkillStore } from "../store/skill-store.js";
import { COMBINED_REVIEW_PROMPT, DEFAULT_SKILL_TRIGGER_TOOL_CALLS, ENTRY_DELIMITER } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { getMessageText } from "../types.js";

export function setupSkillAutoTrigger(
  pi: ExtensionAPI,
  store: MemoryStore,
  skillStore: SkillStore,
  config: MemoryConfig,
): void {
  let triggeredThisSession = false;

  pi.on("turn_end", async (event, ctx) => {
    if (triggeredThisSession) return;

    // Count tool-use entries from this turn's branch
    let toolCallCount = 0;
    const toolTypes = new Set<string>();

    try {
      const branch = ctx.sessionManager.getBranch();
      for (const entry of branch) {
        if (entry.type === "message" && entry.message?.role === "assistant") {
          const content = entry.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && block.type === "toolCall") {
                toolCallCount++;
                if ((block as { name?: string }).name) toolTypes.add((block as { name: string }).name);
              }
            }
          }
        }
      }
    } catch {
      return;
    }

    // Require 8+ tool calls AND 2+ distinct tool types
    if (toolCallCount < DEFAULT_SKILL_TRIGGER_TOOL_CALLS) return;
    if (toolTypes.size < 2) return;

    triggeredThisSession = true;

    try {
      // Build conversation context
      const branch = ctx.sessionManager.getBranch();
      const parts: string[] = [];

      for (const entry of branch) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        const text = getMessageText(msg);
        if (!text) continue;
        const prefix = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
        parts.push(`${prefix}: ${text}`);
      }

      // Only include recent context
      const recentParts = parts.slice(-10);

      const currentMemory = store.getMemoryEntries().join(ENTRY_DELIMITER);
      const skillIndex = await skillStore.loadIndex();
      const skillSummary = skillIndex.map((s) => `${s.fileName}: ${s.name} - ${s.description}`).join("\n");

      const prompt = [
        "This was a complex task that required multiple tool calls. Extract any reusable procedures as skills.",
        "",
        "--- Existing Skills ---",
        skillSummary || "(none)",
        "",
        "--- Current Memory ---",
        currentMemory || "(empty)",
        "",
        "--- Recent Conversation ---",
        recentParts.join("\n\n"),
        "",
        "If a skill should be created, use the skill tool with action 'create'.",
        "If a related skill already exists, use 'patch' to update it.",
        "If nothing reusable happened, say 'Nothing to extract.' and stop.",
      ].join("\n");

      const result = await pi.exec("pi", ["-p", "--no-session", prompt], {
        signal: ctx.signal,
        timeout: 60000,
      });

      if (result.code === 0 && result.stdout) {
        const output = result.stdout.trim();
        if (output && !output.toLowerCase().includes("nothing to extract")) {
          ctx.ui.notify("🧠 Complex task detected — skill extracted", "info");
        }
      }
    } catch {
      // Best-effort — don't block
    }
  });
}
