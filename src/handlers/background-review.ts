/**
 * Background review — learning loop that auto-saves memory every N turns.
 * Ported from hermes-agent/run_agent.py (_spawn_background_review, _memory_nudge_interval).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Uses pi.exec("pi", ["-p", ...]) for isolated one-shot review,
 * keeping us within Pi's intended extension API.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { COMBINED_REVIEW_PROMPT } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { getMessageText } from "../types.js";

export function setupBackgroundReview(
  pi: ExtensionAPI,
  store: MemoryStore,
  config: MemoryConfig,
): void {
  let turnsSinceReview = 0;
  let userTurnCount = 0;
  let reviewInProgress = false;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") {
      userTurnCount++;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    turnsSinceReview++;

    if (!config.reviewEnabled) return;
    if (reviewInProgress) return;
    if (turnsSinceReview < config.nudgeInterval) return;
    if (userTurnCount < 3) return;

    turnsSinceReview = 0;
    reviewInProgress = true;

    try {
      // Build conversation snapshot from session entries
      const entries = ctx.sessionManager.getBranch();
      const parts: string[] = [];

      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        const text = getMessageText(msg);
        if (!text) continue;
        const prefix = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
        parts.push(`${prefix}: ${text}`);
      }
      if (parts.length < 4) return; // Not enough conversation to review

      const currentMemory = store.getMemoryEntries().join("\n§\n");
      const currentUser = store.getUserEntries().join("\n§\n");

      const reviewPrompt = [
        COMBINED_REVIEW_PROMPT,
        "",
        "--- Current Memory ---",
        currentMemory || "(empty)",
        "",
        "--- Current User Profile ---",
        currentUser || "(empty)",
        "",
        "--- Conversation to Review ---",
        parts.join("\n\n"),
      ].join("\n");

      const result = await pi.exec("pi", ["-p", "--no-session", reviewPrompt], {
        signal: ctx.signal,
        timeout: 60000,
      });

      if (result.code === 0 && result.stdout) {
        const output = result.stdout.trim();
        if (output && !output.toLowerCase().includes("nothing to save")) {
          ctx.ui.notify("💾 Memory auto-reviewed and updated", "info");
        }
      }
    } catch {
      // Background review is best-effort — never block the main agent
    } finally {
      reviewInProgress = false;
    }
  });
}
