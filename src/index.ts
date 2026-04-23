/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Background Learning Loop — auto-saves notable facts every N turns
 * 3. Session-End Flush — saves memories before compaction/shutdown
 * 4. /memory-insights — shows what's stored
 *
 * See PLAN.md for full architecture and Hermes source references.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "./memory-store.js";
import { registerMemoryTool } from "./memory-tool.js";
import { setupBackgroundReview } from "./background-review.js";
import { setupSessionFlush } from "./session-flush.js";
import { registerInsightsCommand } from "./insights.js";
import type { MemoryConfig } from "./types.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_FLUSH_MIN_TURNS,
} from "./constants.js";

export default function (pi: ExtensionAPI) {
  // Configuration (future: read from Pi settings.json)
  const config: MemoryConfig = {
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    nudgeInterval: DEFAULT_NUDGE_INTERVAL,
    reviewEnabled: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
  };

  const store = new MemoryStore(config);

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, _ctx) => {
    await store.loadFromDisk();
  });

  // ── 2. Inject frozen snapshot into system prompt ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const memoryBlock = store.formatForSystemPrompt();
    if (memoryBlock) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + memoryBlock,
      };
    }
  });

  // ── 3. Register the memory tool ──
  registerMemoryTool(pi, store);

  // ── 4. Setup background learning loop ──
  setupBackgroundReview(pi, store, config);

  // ── 5. Setup session-end flush ──
  setupSessionFlush(pi, store, config);

  // ── 6. Register insights command ──
  registerInsightsCommand(pi, store);
}
