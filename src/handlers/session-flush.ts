/**
 * Session flush — gives the agent one turn to save memories before context is lost.
 * Ported from hermes-agent/run_agent.py (flush_memories).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { FLUSH_PROMPT } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { getMessageText } from "../types.js";

export function setupSessionFlush(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
): void {
  let userTurnCount = 0;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") userTurnCount++;
  });

  /** Shared flush logic — builds conversation snapshot and spawns pi -p */
  async function flush(ctx: any, signal?: AbortSignal, timeoutMs = 30000): Promise<void> {
    if (userTurnCount < config.flushMinTurns) return;

    let entries;
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return; // Context already stale
    }

    const parts: string[] = [];

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      const text = getMessageText(msg);
      if (!text) continue;
      const prefix = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
      parts.push(`${prefix}: ${text}`);
    }
    const flushMessage = [
      FLUSH_PROMPT,
      "",
      "--- Conversation ---",
      parts.join("\n\n"),
    ].join("\n");

    try {
      await pi.exec("pi", ["-p", "--no-session", flushMessage], {
        signal,
        timeout: timeoutMs,
      });
    } catch {
      // Best-effort flush — never block shutdown
    }
  }

  // Flush before compaction (can afford to wait)
  pi.on("session_before_compact", async (event, ctx) => {
    if (!config.flushOnCompact) return;
    await flush(ctx, event.signal, 30000);
  });

  // Flush before session shutdown (must be fast, non-blocking)
  pi.on("session_shutdown", async (event, ctx) => {
    if (!config.flushOnShutdown) return;
    // Fire-and-forget with a short timeout so we don't block Pi's shutdown.
    // We intentionally do NOT await — Pi should not wait for the child process.
    flush(ctx, undefined, 10000).catch(() => {});
  });
}
