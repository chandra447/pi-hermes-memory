/**
 * Correction detection — detects user corrections in real-time and triggers
 * an immediate memory save instead of waiting for the next nudge interval.
 *
 * Uses a two-pass filter:
 * - Strong patterns: always trigger (high confidence)
 * - Weak patterns: only trigger if followed by a directive clause
 * - Negative patterns: suppress even if a positive pattern matched
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import {
  CORRECTION_SAVE_PROMPT,
  CORRECTION_STRONG_PATTERNS,
  CORRECTION_WEAK_PATTERNS,
  CORRECTION_NEGATIVE_PATTERNS,
  ENTRY_DELIMITER,
} from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { getMessageText } from "../types.js";

/**
 * Check if a user message is a correction using the two-pass filter.
 * Returns true if the message should trigger an immediate save.
 */
export function isCorrection(text: string): boolean {
  // Check negative patterns first — suppress even if positive matches
  for (const pattern of CORRECTION_NEGATIVE_PATTERNS) {
    if (pattern.test(text)) return false;
  }

  // Check strong patterns — always trigger
  for (const pattern of CORRECTION_STRONG_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  // Check weak patterns — only trigger if followed by a directive clause
  for (const pattern of CORRECTION_WEAK_PATTERNS) {
    if (pattern.test(text)) {
      // Look for a directive after the weak pattern match
      // Directive = a verb or "the/that/this" in the remainder of the text
      const match = pattern.exec(text);
      if (match && match.index === 0) {
        const remainder = text.slice(match[0].length).trim();
        // Simple heuristic: remainder contains something directive-ish
        if (/\b(use|don'?t|do|try|make|run|install|add|remove|delete|change|fix|put|set|write|go|stop|start|the|that|this|it)\b/i.test(remainder)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function setupCorrectionDetector(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
): void {
  if (!config.correctionDetection) return;

  let pendingCorrection = false;
  let turnsSinceLastCorrection = 3; // Start at threshold so first correction can fire immediately
  let correctionInProgress = false;

  // Flag on message_end (user role)
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "user") return;
    const text = getMessageText(event.message);
    if (!text) return;
    if (isCorrection(text)) {
      pendingCorrection = true;
    }
  });

  // Trigger on turn_end (we need full context: user correction + what agent said)
  pi.on("turn_end", async (event, ctx) => {
    if (!pendingCorrection) {
      turnsSinceLastCorrection++;
      return;
    }
    pendingCorrection = false;

    // Rate limit: max 1 correction save per 3 turns
    if (turnsSinceLastCorrection < 3) return;
    if (correctionInProgress) return;

    turnsSinceLastCorrection = 0;
    correctionInProgress = true;

    try {
      // Build conversation snapshot
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

      // Only include last few exchanges (correction context is recent)
      const recentParts = parts.slice(-6);

      const currentMemory = store.getMemoryEntries().join(ENTRY_DELIMITER);
      const currentUser = store.getUserEntries().join(ENTRY_DELIMITER);
      const currentProject = projectStore ? projectStore.getMemoryEntries().join(ENTRY_DELIMITER) : null;

      const prompt = [
        CORRECTION_SAVE_PROMPT,
        "",
        "--- Current Memory ---",
        currentMemory || "(empty)",
        "",
        "--- Current User Profile ---",
        currentUser || "(empty)",
      ];

      if (currentProject !== null) {
        prompt.push(
          "",
          "--- Current Project Memory ---",
          currentProject || "(empty)",
        );
      }

      prompt.push(
        "",
        "--- Recent Conversation ---",
        recentParts.join("\n\n"),
      );

      const result = await pi.exec("pi", ["-p", "--no-session", prompt.join("\n")], {
        signal: ctx.signal,
        timeout: 30000,
      });

      if (result.code === 0 && result.stdout) {
        const output = result.stdout.trim();
        if (output && !output.toLowerCase().includes("nothing to save")) {
          ctx.ui.notify("🔧 Correction detected — memory updated", "info");
        }
      }
    } catch {
      // Best-effort — don't block the session
    } finally {
      correctionInProgress = false;
    }
  });
}
