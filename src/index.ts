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
 * 11. /memory-interview — onboarding interview to pre-fill user profile
 * 12. /memory-switch-project — list project memories
 * 13. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 14. Memory Aging — entry timestamps guide consolidation
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "./store/memory-store.js";
import { SkillStore } from "./store/skill-store.js";
import { DatabaseManager } from "./store/db.js";
import { indexSession } from "./store/session-indexer.js";
import { parseSessionFile } from "./store/session-parser.js";
import { registerMemoryTool } from "./tools/memory-tool.js";
import { registerSkillTool } from "./tools/skill-tool.js";
import { registerSessionSearchTool } from "./tools/session-search-tool.js";
import { registerMemorySearchTool } from "./tools/memory-search-tool.js";
import { setupBackgroundReview } from "./handlers/background-review.js";
import { setupSessionFlush } from "./handlers/session-flush.js";
import { registerInsightsCommand } from "./handlers/insights.js";
import { triggerConsolidation, registerConsolidateCommand } from "./handlers/auto-consolidate.js";
import { setupCorrectionDetector } from "./handlers/correction-detector.js";
import { setupSkillAutoTrigger } from "./handlers/skill-auto-trigger.js";
import { registerSkillsCommand } from "./handlers/skills-command.js";
import { registerInterviewCommand } from "./handlers/interview.js";
import { registerSwitchProjectCommand } from "./handlers/switch-project.js";
import { registerIndexSessionsCommand } from "./handlers/index-sessions.js";
import { registerLearnMemoryCommand } from "./handlers/learn-memory.js";
import { registerCandidateShadowRunCommand } from "./handlers/candidate-shadow-command.js";
import { registerMemoryReviewCandidatesCommand } from "./handlers/memory-review-candidates.js";
import { loadConfig } from "./config.js";
import { detectProject } from "./project.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const globalDir = config.memoryDir ?? path.join(os.homedir(), ".pi", "agent", "memory");
  const store = new MemoryStore(config);
  const skillStore = new SkillStore(path.join(globalDir, "skills"));
  const dbManager = new DatabaseManager(globalDir);

  // Detect project from cwd using shared helper
  const project = detectProject();

  // Project-scoped store: ~/.pi/agent/<project_name>/
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir ? new MemoryStore(projectConfig) : null;
  const projectName = project.name ?? "";

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, _ctx) => {
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();
  });

  // ── 2. Inject frozen snapshot + skill index + project memory into system prompt ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const memoryBlock = store.formatForSystemPrompt();
    const skillIndex = await skillStore.formatIndexForSystemPrompt();
    const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

    const parts: string[] = [];
    if (memoryBlock) parts.push(memoryBlock);
    if (projectBlock) parts.push(projectBlock);
    if (skillIndex) parts.push(skillIndex);

    if (parts.length > 0) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + parts.join("\n\n"),
      };
    }
  });

  // ── 3. Register the memory tool (with project store) ──
  registerMemoryTool(pi, store, projectStore);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStore, config);

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, projectStore, config);

  // ── 7. Setup auto-consolidation (inject consolidator into store) ──
  store.setConsolidator(async (target, signal) => {
    return triggerConsolidation(pi, store, target, signal);
  });
  registerConsolidateCommand(pi, store);

  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, projectStore, config);

  // ── 9. Setup skill auto-trigger ──
  setupSkillAutoTrigger(pi, store, skillStore, config);

  // ── 10. Register commands ──
  registerInsightsCommand(pi, store, projectStore, projectName);
  registerSkillsCommand(pi, skillStore);
  registerInterviewCommand(pi, store);
  registerSwitchProjectCommand(pi);
  registerLearnMemoryCommand(pi);
  registerCandidateShadowRunCommand(pi, config);
  registerMemoryReviewCandidatesCommand(pi, dbManager, skillStore);

  // ── 11. SQLite session search + extended memory ──
  registerSessionSearchTool(pi, dbManager);
  registerMemorySearchTool(pi, dbManager);
  registerIndexSessionsCommand(pi);

  // ── 12. Auto-index session on shutdown ──
  pi.on("session_shutdown", async (_event, _ctx) => {
    try {
      const fs = require("node:fs");
      const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
      const cwd = process.cwd();
      const encodedCwd = cwd.replace(/\//g, "-");
      const sessionDir = path.join(sessionsDir, encodedCwd);

      if (fs.existsSync(sessionDir)) {
        // Find the most recent JSONL file (the one we just finished)
        const files = fs.readdirSync(sessionDir)
          .filter((f: string) => f.endsWith(".jsonl"))
          .sort()
          .reverse();
        if (files.length > 0) {
          const sessionData = parseSessionFile(path.join(sessionDir, files[0]));
          if (sessionData) {
            indexSession(dbManager, sessionData);
          }
        }
      }
    } catch {
      // Silent fail — don't block shutdown
    }
  });
}
