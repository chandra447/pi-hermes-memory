/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Default transport: in-process direct completion (same mechanism as
 * background review — see review-memory-ops.ts), used only when a caller
 * supplies model/modelRegistry access (the manual `/memory-consolidate`
 * command has it; the automatic over-capacity consolidator registered on
 * MemoryStore does not, since MemoryStore itself has no extension-runtime
 * access, so that path stays subprocess-only). Falls back to a `pi -p`
 * subprocess when direct mode is unavailable, declines, or fails.
 *
 * The subprocess child process modifies files on disk, so the parent MUST
 * reload from disk after a subprocess-based consolidation completes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  CONSOLIDATION_PROMPT,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
} from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";
import { AGENT_ROOT } from "../paths.js";
import { execChildPrompt } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport } from "./review-memory-ops.js";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";
type ConsolidationLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride" | "reviewTransport">;

// staleMs is deliberately decoupled from the consolidation timeout. The holder
// beats every CONSOLIDATION_LOCK_HEARTBEAT_MS while its child runs, so a
// legitimately slow consolidation (up to 2x timeoutMs once retryWithoutOverrides
// fires) never loses its lease, while a holder that stops making progress is
// reclaimable after seconds instead of after its worst-case runtime (#144).
const CONSOLIDATION_LOCK_STALE_MS = 45_000;
const CONSOLIDATION_LOCK_HEARTBEAT_MS = 10_000;
// Contention is usually transient. Poll for the lock the way
// acquireMarkdownMutationLock does instead of hard-failing the memory write
// that triggered auto-consolidation on the very first collision.
const CONSOLIDATION_LOCK_WAIT_MS = 5_000;
const CONSOLIDATION_LOCK_POLL_MS = 50;
const CONSOLIDATION_LOCK_ENV = "PI_HERMES_CONSOLIDATION_LOCK_DIR";
const CONSOLIDATION_LOCK_WAIT_ENV = "PI_HERMES_CONSOLIDATION_LOCK_WAIT_MS";

interface ConsolidationLock {
  release: () => Promise<void>;
}

interface ConsolidationLockAttempt {
  lock: ConsolidationLock | null;
  /** True when the lock was held by someone else on the first attempt. */
  contended: boolean;
  waitedMs: number;
}

function consolidationLockRoot(): string {
  return process.env[CONSOLIDATION_LOCK_ENV]?.trim()
    || path.join(AGENT_ROOT, "pi-hermes-memory", ".consolidation-locks");
}

function sanitizeLockPart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) || "unknown";
}

function consolidationLockKey(target: MemoryTarget, toolTarget: ToolMemoryTarget, storageIdentity: string): string {
  const storageHash = createHash("sha256").update(storageIdentity).digest("hex");
  return `${sanitizeLockPart(toolTarget)}:${sanitizeLockPart(target)}:${storageHash}`;
}

function consolidationLockWaitMs(): number {
  const configured = Number(process.env[CONSOLIDATION_LOCK_WAIT_ENV]);
  return Number.isFinite(configured) && configured >= 0 ? configured : CONSOLIDATION_LOCK_WAIT_MS;
}

async function acquireConsolidationLock(
  store: MemoryStore,
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
): Promise<ConsolidationLockAttempt> {
  const storageIdentity = await store.getStorageIdentity(target);
  const root = consolidationLockRoot();
  await fs.mkdir(root, { recursive: true });
  const coordinator = AtomicLockCoordinator.shared(path.join(root, "locks.sqlite"));
  const key = consolidationLockKey(target, toolTarget, storageIdentity);
  const lockOptions = { staleMs: CONSOLIDATION_LOCK_STALE_MS };

  const startedAt = Date.now();
  let lease = coordinator.tryAcquire(key, lockOptions);
  const contended = !lease;
  if (contended) {
    const deadline = startedAt + consolidationLockWaitMs();
    while (!lease && Date.now() < deadline) {
      // Same shape as acquireMarkdownMutationLock; Promise.withResolvers would
      // need an ES2024 lib this project does not target.
      await new Promise((resolve) => setTimeout(resolve, CONSOLIDATION_LOCK_POLL_MS));
      lease = coordinator.tryAcquire(key, lockOptions);
    }
  }

  const waitedMs = Date.now() - startedAt;
  if (!lease) return { lock: null, contended, waitedMs };

  const held = lease;
  const heartbeat = setInterval(() => {
    try {
      held.renew();
    } catch {
      // A missed beat only moves the lease closer to staleMs; the next beat
      // recovers, and a permanently broken lock DB should not crash the run.
    }
  }, CONSOLIDATION_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    lock: {
      release: async () => {
        clearInterval(heartbeat);
        held.release();
      },
    },
    contended,
    waitedMs,
  };
}

function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  if (target === "user") return store.getUserEntries();
  if (target === "failure") return store.getAllFailureEntries();
  return store.getMemoryEntries();
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === "project") return "Project Memory";
  if (target === "user") return "User Profile";
  if (target === "failure") return "Failure Memory";
  return "Memory";
}

function describeConsolidationFailure(
  result: { code: number; stderr?: string; killed?: boolean },
  timeoutMs: number,
): string {
  const stderr = result.stderr?.trim();
  const terminated = result.killed || result.code === 124 || result.code === 143;

  if (terminated) {
    return `Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: ${timeoutMs}ms. Raise consolidationTimeoutMs if consolidation legitimately needs longer.`;
  }

  return `Consolidation process exited with code ${result.code}: ${stderr?.slice(0, 200) || "unknown error"}`;
}

function buildConsolidationPrompt(
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  entries: string[],
): string {
  return [
    CONSOLIDATION_PROMPT,
    "",
    `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
    entries.join(ENTRY_DELIMITER) || "(empty)",
    "",
    `Use the memory tool to consolidate. Target: '${toolTarget}'`,
  ].join("\n");
}

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: ConsolidationLlmConfig = {},
  directCtx: Pick<ExtensionContext, "model" | "modelRegistry"> | null = null,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion } = {},
): Promise<ConsolidationResult> {
  const entries = entriesForTarget(store, target);
  const currentContent = entries.join(ENTRY_DELIMITER);
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;

  if (directCtx && usesDirectTransport(llmConfig)) {
    try {
      const directResult = await runDirect(
        directCtx,
        store,
        toolTarget === "project" ? store : null,
        {
          systemPrompt: DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
          userPrompt: [
            `--- Current ${labelForTarget(target, toolTarget)} Entries (target: '${toolTarget}') ---`,
            currentContent || "(empty)",
            "",
            `Only emit operations with "target": "${toolTarget}".`,
          ].join("\n"),
          config: llmConfig,
          timeoutMs,
          signal,
        },
        dbManager,
        projectName,
      );
      // Consolidation only did its job if it actually freed space — unlike
      // review/flush/correction, an empty or fully-skipped result here is a
      // failure worth falling back to subprocess for, not a normal outcome.
      if (directResult.ok && directResult.appliedCount > 0) {
        return { consolidated: true };
      }
    } catch {
      // Fall through to subprocess below.
    }
  }

  let lock: ConsolidationLock | null = null;

  try {
    const attempt = await acquireConsolidationLock(store, target, toolTarget);
    lock = attempt.lock;
    if (!lock) {
      // Not a failure: the work is already running in another session. Say so
      // plainly so the memory-write path can ask for a retry instead of
      // reporting a broken consolidation mid-task (#144).
      return {
        consolidated: false,
        deferred: true,
        error: `Consolidation already in progress for target '${toolTarget}' in another session`
          + ` (waited ${attempt.waitedMs}ms). Nothing was consolidated here — retry shortly.`,
      };
    }

    let promptEntries = entries;
    if (attempt.contended) {
      // We queued behind another session's consolidation and it has now
      // finished. If it already freed space, running a second LLM pass here
      // costs a child turn and over-compresses memory for nothing — hand the
      // caller a reload-and-retry instead.
      try {
        await store.loadFromDisk();
        const refreshed = entriesForTarget(store, target);
        if (refreshed.join(ENTRY_DELIMITER).length < currentContent.length) {
          return { consolidated: true };
        }
        promptEntries = refreshed;
      } catch {
        // Reload failed — consolidate the entries we already read instead.
      }
    }

    const result = await execChildPrompt(pi, buildConsolidationPrompt(target, toolTarget, promptEntries), llmConfig, {
      signal,
      timeoutMs,
      retryWithoutOverrides: true,
    }) as { code: number; stdout?: string; stderr?: string; killed?: boolean };

    if (result.code === 0) {
      return { consolidated: true };
    }
    return {
      consolidated: false,
      error: describeConsolidationFailure(result, timeoutMs),
    };
  } catch (err) {
    return {
      consolidated: false,
      error: `Consolidation failed: ${String(err).slice(0, 200)}`,
    };
  } finally {
    if (lock) {
      try { await lock.release(); } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
  llmConfig: ConsolidationLlmConfig = {},
  dbManager: DatabaseManager | null = null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion } = {},
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const results: string[] = [];
      const targets: Array<{
        label: string;
        store: MemoryStore;
        target: MemoryTarget;
        toolTarget: ToolMemoryTarget;
      }> = [
        { label: "memory", store, target: "memory", toolTarget: "memory" },
        { label: "user", store, target: "user", toolTarget: "user" },
        { label: "failure", store, target: "failure", toolTarget: "failure" },
      ];

      if (projectStore) {
        targets.push({
          label: projectName ? `project:${projectName}` : "project",
          store: projectStore,
          target: "memory",
          toolTarget: "project",
        });
      }

      try {
        ctx.ui.notify(
          `🔄 Starting memory consolidation for ${targets.length} target${targets.length === 1 ? "" : "s"}...`,
          "info",
        );
      } catch {
        // Best-effort only. If the command context is already stale, continue
        // with the consolidation work rather than failing before it starts.
      }

      for (const item of targets) {
        const entries = entriesForTarget(item.store, item.target);

        if (entries.length === 0) {
          results.push(`${item.label}: (empty, nothing to consolidate)`);
          continue;
        }

        try {
          ctx.ui.notify(
            `⏳ Consolidating ${item.label}...`,
            "info",
          );
        } catch {
          // Best-effort progress feedback only.
        }

        const result = await triggerConsolidation(
          pi,
          item.store,
          item.target,
          ctx.signal,
          timeoutMs,
          item.toolTarget,
          llmConfig,
          ctx,
          dbManager,
          projectName,
          deps,
        );

        if (result.consolidated) {
          await item.store.loadFromDisk();
          results.push(`${item.label}: ✅ consolidated`);
        } else {
          results.push(`${item.label}: ❌ ${result.error}`);
        }
      }

      const summary = `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`;

      try {
        ctx.ui.notify(summary, "info");
      } catch {
        // Child consolidation can indirectly trigger a runtime reload/session
        // replacement. If that happens, the original command ctx is stale by
        // the time we reach the final summary, so the command should exit
        // quietly instead of surfacing a stale-ctx error.
      }
    },
  });
}
