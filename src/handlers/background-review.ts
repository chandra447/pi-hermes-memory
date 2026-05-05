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
  projectStore: MemoryStore | null,
  config: MemoryConfig,
): void {
  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
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

    // Count tool calls from this turn's message only (not cumulative branch scan —
    // otherwise the counter resets to 0 at review, then immediately re-counts all
    // historical tool calls and re-triggers on every subsequent turn).
    try {
      const msg = event.message;
      if (msg?.role === "assistant") {
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && block.type === "toolCall") {
              toolCallsSinceReview++;
            }
          }
        }
      }
    } catch {
      // If we can't count tool calls, fall back to turn-based only
    }

    // Trigger on EITHER turn count OR tool call count
    const turnThresholdMet = turnsSinceReview >= config.nudgeInterval;
    const toolCallThresholdMet = toolCallsSinceReview >= config.nudgeToolCalls;

    if (!turnThresholdMet && !toolCallThresholdMet) return;
    if (userTurnCount < 3) return;

    turnsSinceReview = 0;
    toolCallsSinceReview = 0;
    reviewInProgress = true;

    // Build conversation snapshot from session entries (crash-safe)
    let parts: string[] = [];
    try {
      const entries = ctx.sessionManager.getBranch();

      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        const text = getMessageText(msg);
        if (!text) continue;
        const prefix = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
        parts.push(`${prefix}: ${text}`);
      }
    } catch {
      reviewInProgress = false;
      return; // Session expired or empty — nothing to review
    }
    if (parts.length < 4) {
      reviewInProgress = false;
      return; // Not enough conversation to review
    }

    const currentMemory = store.getMemoryEntries().join("\n§\n");
    const currentUser = store.getUserEntries().join("\n§\n");
    const currentProject = projectStore ? projectStore.getMemoryEntries().join("\n§\n") : null;

    const reviewPrompt = [
      COMBINED_REVIEW_PROMPT,
      "",
      "--- Current Memory ---",
      currentMemory || "(empty)",
      "",
      "--- Current User Profile ---",
      currentUser || "(empty)",
    ];

    if (currentProject !== null) {
      reviewPrompt.push(
        "",
        "--- Current Project Memory ---",
        currentProject || "(empty)",
      );
    }

    reviewPrompt.push(
      "",
      "--- Conversation to Review ---",
      parts.join("\n\n"),
    );

    // Fire-and-forget: do NOT await. The review runs in a subprocess;
    // blocking turn_end would freeze the interactive chat.
    // Notifications are delivered via .then() once the subprocess completes.
    //
    // We intentionally omit ctx.signal — the signal is tied to the turn
    // lifetime and would abort the subprocess before it finishes now that
    // we're not awaiting. The timeout (120s) provides its own safety net.
    const reviewPromise = pi.exec("pi", ["-p", "--no-session", reviewPrompt.join("\n")], {
      signal: undefined,
      timeout: 120000,
    });

    reviewPromise
      .then((result) => {
        reviewInProgress = false;
        if (result.code === 0 && result.stdout) {
          const output = result.stdout.trim();
          if (output && !output.toLowerCase().includes("nothing to save")) {
            ctx.ui.notify("💾 Memory auto-reviewed and updated", "info");
          }
        }
        // Auto-review is best-effort. Non-zero exits are silently skipped —
        // common on Windows where pi CLI may resolve differently. The next
        // review cycle will retry.
      })
      .catch(() => {
        // Best-effort: subprocess failures (timeout, signal, spawn errors)
        // are silently ignored. The next review cycle will retry.
        reviewInProgress = false;
      });
  });
}
