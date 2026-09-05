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
import { indexSession, upsertSessionFileMetadata, pruneEphemeralReviewSessions, pruneOldSessions, retentionCutoffMs } from "./store/session-indexer.js";
import { runRecoveryMaintenance } from "./store/recovery-maintenance.js";
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
import { registerStandingPinCommand } from "./handlers/standing-pin.js";
import { StandingInstructions } from "./store/standing-instructions.js";
import { STANDING_FILE } from "./constants.js";
import { loadConfig } from "./config.js";
import { shouldWarnAutoConsolidationFailure } from "./auto-consolidation-warning.js";
import { detectProject, detectProjectSkills } from "./project.js";
import { buildPromptContext } from "./prompt-context.js";
import { migrateLegacyProjectMemoryDirs } from "./project-memory-migration.js";
import { AGENT_ROOT } from "./paths.js";
import { isDatabaseMigrationPending } from "./extension-root-migration.js";
import { measureLifecycle, measureLifecycleSync } from "./lifecycle-timing.js";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  // Pi auto-discovers its own `~/.pi/agent/skills/`, but this extension keeps
  // its generated skills in a directory of its own so users can audit, wipe, or
  // ignore them without touching skills they installed themselves (#126). Both
  // of ours must therefore be contributed here.
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
  // Factory may run with no session (Pi public contract). Do not snapshot
  // project identity from process.cwd() here — bind from session_start ctx.cwd
  // and from tool execute ctx.cwd.
  let projectName = "";
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(globalDir, "skills"),
    piGlobalSkillsDir: path.join(agentRoot, "skills"),
    projectSkillsDir: null,
    projectName: null,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    migrationSentinelPath: path.join(globalDir, ".skills-migrated-to-extension-storage"),
  });
  const dbManager = new DatabaseManager(globalDir);
  dbManager.setQuickCheckOnOpen(config.quickCheckOnOpen ?? true);
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
  // Project-scoped store: ~/.pi/agent/<projectsMemoryDir>/<project_name>/
  // Bound from session/tool ctx.cwd, never from factory process.cwd().
  const createProjectStore = (projectInfo: ReturnType<typeof detectProject>): MemoryStore | null => {
    if (!projectInfo.memoryDir) return null;
    return new MemoryStore({
      ...config,
      memoryCharLimit: config.projectCharLimit,
      memoryDir: projectInfo.memoryDir,
    });
  };
  let projectMemoryDir: string | null = null;
  let projectStore: MemoryStore | null = null;
  const projectStoreRef = () => projectStore;
  const projectNameRef = () => projectName;
  let configureProjectStore: (candidate: MemoryStore | null) => void = () => {};
  let configureMemoryToolProjectStore: (candidate: MemoryStore | null) => void = () => {};
  const bindProjectFromCwd = async (cwd?: string): Promise<void> => {
    if (!cwd) return;
    const nextProject = detectProject(config.projectsMemoryDir, cwd);
    const nextProjectMemoryDir = nextProject.memoryDir ?? null;
    if (nextProjectMemoryDir !== projectMemoryDir) {
      projectMemoryDir = nextProjectMemoryDir;
      projectStore = createProjectStore(nextProject);
      configureProjectStore(projectStore);
      configureMemoryToolProjectStore(projectStore);
      if (projectStore) await projectStore.loadFromDisk();
    }
    projectName = nextProject.name ?? "";
  };
  // Never written by review, consolidation or the correction detector — see
  // store/standing-instructions.ts for why provenance has to be structural.
  const standingStore = config.standingInstructionsEnabled !== false
    ? new StandingInstructions(path.join(globalDir, STANDING_FILE))
    : null;

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, ctx) => {
    if (!persistenceInitialized) {
      try {
        await measureLifecycle("session-start.persistence-sync", async () => {
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
        });
        persistenceInitialized = true;
      } catch {
        // Best-effort only: migration or SQLite backfill must not block startup.
      }
    }

    await measureLifecycle("session-start.load", async () => {
      await bindProjectFromCwd(ctx.cwd);
      refreshSkillProjectContext(ctx.cwd);
      await skillStore.migrateLegacySkills();
      await skillStore.ensureDiscoveredRoots();
      await store.loadFromDisk();
      if (projectStore) await projectStore.loadFromDisk();
      if (standingStore) await standingStore.load();
    });

    if (persistenceInitialized) {
      try {
        pruneEphemeralReviewSessions(dbManager);
      } catch (err) {
        console.warn(`⚠️ Ephemeral session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Prune sessions older than the configured retention window to bound the
      // size of the session index database (see #183). Runs before
      // scheduleSessionBackfill so pruned sessions are never re-indexed by a
      // backfill started in the same startup.
      if (config.sessionRetentionDays && config.sessionRetentionDays > 0) {
        try {
          const pruneResult = pruneOldSessions(dbManager, config.sessionRetentionDays);
          if (pruneResult.sessionsRemoved > 0) {
            console.info(
              `🧠 Pruned ${pruneResult.sessionsRemoved} old session(s) (> ${config.sessionRetentionDays} days old)`,
            );
          }
        } catch (err) {
          console.warn(`⚠️ Session pruning failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        await runRecoveryMaintenance({ config, globalDir });
      } catch (err) {
        console.warn(`⚠️ Snapshot retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      scheduleSessionBackfill(dbManager, sessionsDir, {
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
        // Exclude files older than the retention cutoff so sessions pruned by
        // retention are never re-indexed and never schedule another backfill.
        retentionCutoffMs: retentionCutoffMs(config.sessionRetentionDays),
      });
    }
  });

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject memory policy by default; legacy mode keeps full frozen memory blocks ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptContext = await buildPromptContext(config, store, projectStoreRef(), projectNameRef(), standingStore);

    if (promptContext) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + promptContext,
      };
    }
  });

  // ── 3. Register action-specific memory write tools with SQLite sync ──
  configureMemoryToolProjectStore = registerMemoryTool(pi, store, projectStoreRef, dbManager, projectNameRef, bindProjectFromCwd);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStoreRef, config, {
    dbManager,
    projectName: projectNameRef,
  });

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, projectStoreRef, config, dbManager, projectNameRef);

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  // Keep the failure in the tool result regardless; session-console logging is
  // separately configurable for users who already monitor tool results (#135).
  const runAutoConsolidation = async (
    target: "memory" | "user" | "failure",
    targetStore: MemoryStore,
    toolTarget: "memory" | "user" | "failure" | "project",
    signal?: AbortSignal,
  ) => {
    const result = await triggerConsolidation(
      pi,
      targetStore,
      target,
      signal,
      config.consolidationTimeoutMs,
      toolTarget,
      config,
    );
    if (result.deferred) {
      console.info(`⏳ Auto-consolidation for '${toolTarget}' deferred: ${result.error ?? "another session holds the consolidation lock"}`);
    } else if (shouldWarnAutoConsolidationFailure(config.autoConsolidationWarnOnFailure, result.consolidated)) {
      console.warn(`⚠️ Auto-consolidation failed for '${toolTarget}': ${result.error ?? "no reason reported"}`);
    }
    return result;
  };

  store.setConsolidator((target, signal) => runAutoConsolidation(target, store, target, signal));
  configureProjectStore = (candidate) => {
    if (!candidate) return;
    candidate.setConsolidator((target, signal) =>
      runAutoConsolidation(target, candidate, target === "memory" ? "project" : target, signal),
    );
  };
  configureProjectStore(projectStore);
  registerConsolidateCommand(pi, store, config.consolidationTimeoutMs, projectStoreRef, projectNameRef, config, dbManager);

  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, projectStoreRef, config, dbManager, projectNameRef);

  // ── 9. Register commands ──
  registerInsightsCommand(pi, store, projectStoreRef, projectNameRef);
  registerSkillsCommand(pi, skillStore);
  registerInterviewCommand(pi, store);
  registerSwitchProjectCommand(pi, config);
  registerLearnMemoryCommand(pi);
  registerSyncMarkdownMemoriesCommand(pi, dbManager, globalDir, config.projectsMemoryDir, agentRoot);
  registerPreviewContextCommand(pi, store, projectStoreRef, projectNameRef, config, standingStore);
  if (standingStore) registerStandingPinCommand(pi, standingStore);

  // ── 10. Live session indexing ──
  pi.on("message_end", async (_event, ctx) => {
    scheduleLiveSessionIndex(dbManager, ctx.sessionManager, {
      onError: (err) => console.warn(`⚠️ Live session indexing failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  });

  // ── 11. SQLite session search + extended memory ──
  registerSessionSearchTool(pi, dbManager, config.sessionSearch ?? { variant: "legacy" });
  registerMemorySearchTool(pi, dbManager);
  registerIndexSessionsCommand(pi, config);

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
      measureLifecycleSync("shutdown.active-index", () => {
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
      });
    } catch {
      // Silent fail — don't block shutdown
    } finally {
      try {
        await measureLifecycle("shutdown.index-waits", () => Promise.all([
          waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
          waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
        ]));
      } catch {
        // Best effort only — shutdown should not be held up by indexing errors.
      }
      try {
        measureLifecycleSync("shutdown.database-close", () => dbManager.close());
      } catch { /* best effort — never block shutdown */ }
    }
  });
}
