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
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "./store/memory-store.js";
import { SkillStore } from "./store/skill-store.js";
import { DatabaseManager } from "./store/db.js";
import { indexSession, upsertSessionFileMetadata } from "./store/session-indexer.js";
import { scheduleSessionBackfill, waitForSessionBackfill, SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-backfill.js";
import { scheduleLiveSessionIndex, waitForLiveSessionIndex, SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS } from "./handlers/session-live-index.js";
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
import { registerSkillsCommand } from "./handlers/skills-command.js";
import { registerInterviewCommand } from "./handlers/interview.js";
import { registerSwitchProjectCommand } from "./handlers/switch-project.js";
import { registerIndexSessionsCommand } from "./handlers/index-sessions.js";
import { registerLearnMemoryCommand } from "./handlers/learn-memory.js";
import { migrateThenSyncMarkdownMemories, registerSyncMarkdownMemoriesCommand } from "./handlers/sync-markdown-memories.js";
import { registerPreviewContextCommand } from "./handlers/preview-context.js";
import { loadConfig } from "./config.js";
import { detectProject, detectProjectSkills } from "./project.js";
import { buildPromptContext } from "./prompt-context.js";
import { migrateLegacyProjectMemoryDirs } from "./project-memory-migration.js";
import { AGENT_ROOT } from "./paths.js";
import { isDatabaseMigrationPending } from "./extension-root-migration.js";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);

  return { skillPaths };
}

export function registerProjectSkillDiscoveryHandler(
  pi: Pick<ExtensionAPI, "on">,
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
): void {
  pi.on("resources_discover", async (event, _ctx) => {
    return resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd);
  });
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const agentRoot = AGENT_ROOT;
  const legacyGlobalDir = path.join(agentRoot, "memory");
  const defaultGlobalDir = path.join(agentRoot, "pi-hermes-memory");

  const configuredMemoryDir = config.memoryDir?.trim();
  const pointsToLegacyMemoryDir = configuredMemoryDir
    ? path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
    : false;

  const globalDir = !configuredMemoryDir || pointsToLegacyMemoryDir
    ? defaultGlobalDir
    : configuredMemoryDir;

  const shouldMigrateExtensionRoot = !configuredMemoryDir || pointsToLegacyMemoryDir;
  let persistenceInitialized = false;

  const store = new MemoryStore({ ...config, memoryDir: globalDir });
  const project = detectProject(config.projectsMemoryDir);
  const projectName = project.name ?? "";
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(globalDir, "skills"),
    projectSkillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
    projectName: project.name,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    legacyPiGlobalSkillsDir: path.join(agentRoot, "skills"),
    migrationSentinelPath: path.join(globalDir, ".skills-migrated-to-extension-storage"),
  });
  const dbManager = new DatabaseManager(globalDir);
  let databaseMigrationPending = shouldMigrateExtensionRoot
    && isDatabaseMigrationPending(legacyGlobalDir, globalDir);
  if (databaseMigrationPending) {
    dbManager.setOpenGuard(() => {
      if (databaseMigrationPending) {
        throw new Error("Legacy sessions.db migration is pending");
      }
    });
  }
  const sessionsDir = path.join(agentRoot, "sessions");

  const refreshSkillProjectContext = (cwd?: string) => {
    const resource = resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, cwd);
    return {
      name: skillStore.getProjectName(),
      skillsDir: skillStore.getProjectSkillsDir(),
      resource,
    };
  };

  // Keep project memory available for users upgrading from the old
  // ~/.pi/agent/<project>/ layout. This is non-destructive: legacy folders
  // remain in place while entries are copied/merged into projects-memory/.
  migrateLegacyProjectMemoryDirs(agentRoot, config.projectsMemoryDir);
  // Detect project from cwd using shared helper
  // Project-scoped store: ~/.pi/agent/<projectsMemoryDir>/<project_name>/
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir ? new MemoryStore(projectConfig) : null;

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, ctx) => {
    if (!persistenceInitialized) {
      try {
        await migrateThenSyncMarkdownMemories(
          dbManager,
          shouldMigrateExtensionRoot ? legacyGlobalDir : null,
          globalDir,
          config.projectsMemoryDir,
          agentRoot,
          {
            onMigrationSucceeded: () => {
              databaseMigrationPending = false;
              dbManager.setOpenGuard(null);
            },
          },
        );
        persistenceInitialized = true;
      } catch {
        // Best-effort only: migration or SQLite backfill must not block startup.
      }
    }

    refreshSkillProjectContext(ctx.cwd);
    await skillStore.migrateLegacySkills();
    await skillStore.ensureDiscoveredRoots();
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();

    if (persistenceInitialized) scheduleSessionBackfill(dbManager, sessionsDir, {
      notify: (message, level) => {
        const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
        if (ui?.notify) {
          ui.notify(message, level);
        } else if (level === "error" || level === "warning") {
          console.warn(message);
        } else {
          console.info(message);
        }
      },
    });
  });

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject memory policy by default; legacy mode keeps full frozen memory blocks ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptContext = await buildPromptContext(config, store, projectStore, projectName);

    if (promptContext) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + promptContext,
      };
    }
  });

  // ── 3. Register the memory tool (with project store + SQLite sync) ──
  registerMemoryTool(pi, store, projectStore, dbManager, projectName);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStore, config, {
    dbManager,
    projectName: projectName || null,
  });

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, projectStore, config, dbManager, projectName);

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  store.setConsolidator(async (target, signal) => {
    return triggerConsolidation(pi, store, target, signal, config.consolidationTimeoutMs, target, config);
  });
  if (projectStore) {
    projectStore.setConsolidator(async (target, signal) => {
      const toolTarget = target === "memory" ? "project" : target;
      return triggerConsolidation(pi, projectStore, target, signal, config.consolidationTimeoutMs, toolTarget, config);
    });
  }
  registerConsolidateCommand(pi, store, config.consolidationTimeoutMs, projectStore, projectName, config, dbManager);

  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, projectStore, config, dbManager, projectName);

  // ── 9. Register commands ──
  registerInsightsCommand(pi, store, projectStore, projectName);
  registerSkillsCommand(pi, skillStore);
  registerInterviewCommand(pi, store);
  registerSwitchProjectCommand(pi, config);
  registerLearnMemoryCommand(pi);
  registerSyncMarkdownMemoriesCommand(pi, dbManager, globalDir, config.projectsMemoryDir, agentRoot);
  registerPreviewContextCommand(pi, store, projectStore, projectName, config);

  // ── 10. Live session indexing ──
  pi.on("message_end", async (_event, ctx) => {
    scheduleLiveSessionIndex(dbManager, ctx.sessionManager, {
      onError: (err) => console.warn(`⚠️ Live session indexing failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  });

  // ── 11. SQLite session search + extended memory ──
  registerSessionSearchTool(pi, dbManager, config.sessionSearch ?? { variant: "legacy" });
  registerMemorySearchTool(pi, dbManager);
  registerIndexSessionsCommand(pi);

  // ── 12. Auto-index session on shutdown ──
  // Registered last, so this runs after the session-flush shutdown handler and
  // is the final DB activity. Closing here truncates the WAL via
  // PRAGMA wal_checkpoint(TRUNCATE); without it the WAL only grows to its
  // high-water mark and is never reclaimed across sessions.
  //
  // Ordering is safe: Pi's ExtensionRunner.emit() runs same-extension handlers
  // sequentially in registration order and awaits each one, so the flush above
  // fully completes before close() runs. WARNING: do not register another
  // DB-writing session_shutdown handler after this block — it would run after
  // close() and silently no-op.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile && require("node:fs").existsSync(sessionFile)) {
        const sessionData = parseSessionFile(sessionFile);
        if (sessionData) {
          dbManager.withCorruptionRecovery(() => {
            indexSession(dbManager, sessionData);
            // Keep session_files metadata in sync with the final on-disk state.
            // Pi appends the closing session entry on shutdown after the last
            // message_end, so without this upsert the stored size/mtime would be
            // stale and the next startup would re-parse this file unnecessarily.
            upsertSessionFileMetadata(dbManager, sessionFile, sessionData.id);
          });
        }
      }
    } catch {
      // Silent fail — don't block shutdown
    } finally {
      try {
        await Promise.all([
          waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
          waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
        ]);
      } catch {
        // Best effort only — shutdown should not be held up by indexing errors.
      }
      try { dbManager.close(); } catch { /* best effort — never block shutdown */ }
    }
  });
}
