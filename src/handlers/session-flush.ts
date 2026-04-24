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
  config: MemoryConfig,
): void {
  let userTurnCount = 0;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") userTurnCount++;
  });

  /** Shared flush logic — builds conversation snapshot and spawns pi -p */
  async function flush(ctx: any, signal?: AbortSignal): Promise<void> {
    if (userTurnCount < config.flushMinTurns) return;

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
    const flushMessage = [
      FLUSH_PROMPT,
      "",
      "--- Conversation ---",
      parts.join("\n\n"),
    ].join("\n");

    try {
      await pi.exec("pi", ["-p", "--no-session", flushMessage], {
        signal,
        timeout: 30000,
      });
    } catch {
      // Best-effort flush
    }
  }

  // Flush before compaction
  pi.on("session_before_compact", async (event, ctx) => {
    if (!config.flushOnCompact) return;
    await flush(ctx, event.signal);
  });

  // Flush before session shutdown
  pi.on("session_shutdown", async (event, ctx) => {
    if (!config.flushOnShutdown) return;
    await flush(ctx);
  });
}
