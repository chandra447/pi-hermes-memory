/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Background Learning Loop — auto-saves notable facts every N turns
 * 3. Session-End Flush — saves memories before compaction/shutdown
 * 4. Auto-Consolidation — merges memory when full instead of erroring
 * 5. Correction Detection — immediate save on user corrections
 * 6. Procedural Skills — SKILL.md files for reusable procedures
 * 7. Tool-Call-Aware Nudge — review triggers on tool call count too
 * 8. /memory-insights — shows what's stored
 * 9. /memory-skills — lists procedural skills
 * 10. /memory-consolidate — manual consolidation trigger
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "./store/memory-store.js";
import { SkillStore } from "./store/skill-store.js";
import { registerMemoryTool } from "./tools/memory-tool.js";
import { registerSkillTool } from "./tools/skill-tool.js";
import { setupBackgroundReview } from "./handlers/background-review.js";
import { setupSessionFlush } from "./handlers/session-flush.js";
import { registerInsightsCommand } from "./handlers/insights.js";
import { triggerConsolidation, registerConsolidateCommand } from "./handlers/auto-consolidate.js";
import { setupCorrectionDetector } from "./handlers/correction-detector.js";
import { setupSkillAutoTrigger } from "./handlers/skill-auto-trigger.js";
import { registerSkillsCommand } from "./handlers/skills-command.js";
import { loadConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const memoryDir = config.memoryDir ?? path.join(os.homedir(), ".pi", "agent", "memory");
  const store = new MemoryStore(config);
  const skillStore = new SkillStore(path.join(memoryDir, "skills"));

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, _ctx) => {
    await store.loadFromDisk();
  });

  // ── 2. Inject frozen snapshot + skill index into system prompt ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const memoryBlock = store.formatForSystemPrompt();
    const skillIndex = await skillStore.formatIndexForSystemPrompt();

    const parts: string[] = [];
    if (memoryBlock) parts.push(memoryBlock);
    if (skillIndex) parts.push(skillIndex);

    if (parts.length > 0) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + parts.join("\n\n"),
      };
    }
  });

  // ── 3. Register the memory tool ──
  registerMemoryTool(pi, store);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, config);

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, config);

  // ── 7. Setup auto-consolidation (inject consolidator into store) ──
  store.setConsolidator(async (target, signal) => {
    return triggerConsolidation(pi, store, target, signal);
  });
  registerConsolidateCommand(pi, store);

  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, config);

  // ── 9. Setup skill auto-trigger ──
  setupSkillAutoTrigger(pi, store, skillStore, config);

  // ── 10. Register commands ──
  registerInsightsCommand(pi, store);
  registerSkillsCommand(pi, skillStore);
}
