/**
 * Session flush — gives the agent one turn to save memories before context is lost.
 * Ported from hermes-agent/run_agent.py (flush_memories).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Default transport: in-process direct completion (same mechanism as
 * background review — see review-memory-ops.ts). Falls back to a `pi -p`
 * subprocess only if direct mode fails or reviewTransport forces subprocess.
 *
 * Compact flush spends at most `flushCompactTimeoutMs` across both transports
 * (one shared window). Direct runs first; the `pi -p` fallback gets only the
 * remainder, never a second copy of the budget. Shutdown stays a hardcoded
 * 10s cap and is silent. `pi.exec` resolves (never rejects) on timeout/kill,
 * so a non-zero child exit notifies the same way an exhaust does.
 *
 * Access pattern (remaining × session-signal × notify):
 * | Event                                         | leftover                         | session signal | notify                          |
 * | Direct ok                                     | n/a (return)                     | live           | none                            |
 * | Direct `no_model` / `parse_error` with time   | subprocess leftover, not budget  | live           | none unless child fails/exits   |
 * | Direct internal timeout at ceiling            | leftover < floor → skip child    | live           | warning, once                   |
 * | Esc during compact (`event.signal`)           | skip even if leftover ≫ 0        | aborted        | silent                          |
 * | `reviewTransport: "subprocess"`               | one child, leftover = budget     | as above       | warn on nonzero exit / throw    |
 * | Shutdown                                      | budget 10000, no session signal  | n/a            | never                           |
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  buildMemoryTargetRoutingGuidance,
  DEFAULT_FLUSH_COMPACT_TIMEOUT_MS,
  DEFAULT_FLUSH_SHUTDOWN_TIMEOUT_MS,
  DIRECT_FLUSH_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
  FLUSH_PROMPT,
} from "../constants.js";
import type { MemoryConfig } from "../types.js";
import type { EnsureMemoryReady } from "../memory-initialization.js";
import { measureLifecycle } from "../lifecycle-timing.js";
import { collectMessageParts } from "./message-parts.js";
import { execChildPrompt, resolveChildPiModel } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport } from "./review-memory-ops.js";
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";

/** Do not spawn pi -p when leftover time is below this, floored by the budget itself. */
const FLUSH_SUBPROCESS_MIN_REMAINING_MS = 5_000;

export type FlushKind = "compact" | "shutdown";

export type FlushHandoff =
  | { skip: "session_aborted" }
  | { skip: "budget_exhausted" }
  | { timeoutMs: number };

type FlushContext = Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "cwd"> & {
  ui?: Pick<ExtensionContext["ui"], "notify">;
};

/** Remaining subprocess budget. null = skip (spent, below spawn floor, or non-positive). */
export function remainingFlushTimeoutMs(budgetMs: number, elapsedMs: number): number | null {
  if (budgetMs <= 0) return null;
  const elapsed = Math.max(0, elapsedMs);
  const remaining = budgetMs - elapsed;
  const floor = Math.min(FLUSH_SUBPROCESS_MIN_REMAINING_MS, budgetMs);
  if (remaining < floor) return null;
  return remaining;
}

export function resolveFlushHandoff(
  sessionAborted: boolean,
  budgetMs: number,
  elapsedMs: number,
): FlushHandoff {
  if (sessionAborted) return { skip: "session_aborted" };
  const leftover = remainingFlushTimeoutMs(budgetMs, elapsedMs);
  if (leftover === null) return { skip: "budget_exhausted" };
  return { timeoutMs: leftover };
}

function linkBudget(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParent = () => controller.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  if (parent?.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

function notifyCompactFailure(
  ctx: FlushContext,
  kind: FlushKind,
  detail: string,
): void {
  if (kind !== "compact") return;
  try {
    ctx.ui?.notify(
      `Memory flush before compact did not save (${detail}). Compaction continues. Raise flushCompactTimeoutMs for slow/local models.`,
      "warning",
    );
  } catch {
    // compact ctx can go stale; never throw into session_before_compact
  }
}

function buildDirectFlushUserPrompt(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  parts: string[],
): string {
  const sections = [
    "--- Current Memory ---",
    store.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
    "",
    "--- Current User Profile ---",
    store.getUserEntries().join(ENTRY_DELIMITER) || "(empty)",
  ];

  if (projectStore) {
    sections.push(
      "",
      "--- Current Project Memory ---",
      projectStore.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
    );
  }

  sections.push(
    "",
    "--- Conversation ---",
    parts.join("\n\n"),
  );

  return sections.join("\n");
}

export function setupSessionFlush(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  config: MemoryConfig,
  dbManager: DatabaseManager | null = null,
  projectName: ProjectNameRef = null,
  deps: {
    runDirectMemoryCompletion?: typeof runDirectMemoryCompletion;
    now?: () => number;
    ensureMemoryReady?: EnsureMemoryReady;
  } = {},
): void {
  let userTurnCount = 0;
  const now = deps.now ?? Date.now;
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") userTurnCount++;
  });

  /** Shared flush logic — builds conversation snapshot and saves memories */
  async function flush(
    ctx: FlushContext,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    kind: FlushKind,
  ): Promise<void> {
    try {
      if (userTurnCount < config.flushMinTurns) return;

      let entries;
      try {
        entries = ctx.sessionManager.getBranch();
      } catch {
        return; // Context already stale
      }

      const parts = collectMessageParts(entries, config.flushRecentMessages);
      try {
        await deps.ensureMemoryReady?.(ctx);
      } catch {
        return; // Do not flush against an unloaded or partially migrated store.
      }
      const activeProjectStore = resolveProjectStore(projectStore);
      const activeProjectName = resolveProjectName(projectName);
      if (signal?.aborted) return;
      if (timeoutMs <= 0) return; // explicit disable or degenerate config: silent

      const started = now();

      const budget = linkBudget(signal, timeoutMs);
      try {
        if (usesDirectTransport(config)) {
          try {
            const directResult = await runDirect(
              ctx,
              store,
              activeProjectStore,
              {
                systemPrompt: [
                  DIRECT_FLUSH_SYSTEM_PROMPT,
                  "",
                  buildMemoryTargetRoutingGuidance(activeProjectStore !== null),
                ].join("\n"),
                userPrompt: buildDirectFlushUserPrompt(store, activeProjectStore, parts),
                config,
                timeoutMs,
                signal: budget.signal,
              },
              dbManager,
              activeProjectName,
            );
            if (directResult.ok) return;
          } catch {
            // Fall through with leftover, not a copied ceiling.
          }
        }

        const handoff = resolveFlushHandoff(Boolean(signal?.aborted), timeoutMs, now() - started);
        if ("skip" in handoff) {
          if (handoff.skip === "budget_exhausted") {
            const elapsed = Math.max(0, now() - started);
            notifyCompactFailure(
              ctx,
              kind,
              elapsed >= timeoutMs
                ? `timed out after ${timeoutMs}ms`
                : `only ${Math.max(0, timeoutMs - elapsed)}ms left of the ${timeoutMs}ms budget, too little to spawn the fallback`,
            );
          }
          return;
        }

        const flushMessage = [
          FLUSH_PROMPT,
          "",
          buildMemoryTargetRoutingGuidance(activeProjectStore !== null),
          "",
          "--- Conversation ---",
          parts.join("\n\n"),
        ].join("\n");

        try {
          const childResult = await execChildPrompt(pi, flushMessage, config, {
            cwd: ctx.cwd,
            model: resolveChildPiModel(ctx.model),
            signal,
            timeoutMs: handoff.timeoutMs,
          });
          // pi.exec resolves {code, killed} on timeout/kill instead of rejecting.
          // A signal kill can arrive as code 0 with killed true, so both shapes
          // are misses worth surfacing; a non-zero code is the more specific
          // report when the child did exit on its own.
          if (!signal?.aborted) {
            if (typeof childResult?.code === "number" && childResult.code !== 0) {
              notifyCompactFailure(ctx, kind, `child exited with code ${childResult.code}`);
            } else if (childResult?.killed === true) {
              notifyCompactFailure(ctx, kind, "child was killed before it saved");
            }
          }
        } catch (err) {
          if (!signal?.aborted) {
            const detail = err instanceof Error ? err.message : String(err);
            notifyCompactFailure(ctx, kind, `child error: ${detail}`);
          }
        }
      } finally {
        budget.dispose();
      }
    } catch {
      // Best-effort flush — never throw into compaction or shutdown.
    }
  }

  // Flush before compaction (can afford to wait)
  pi.on("session_before_compact", async (event, ctx) => {
    if (!config.flushOnCompact) return;
    await flush(ctx, event.signal, config.flushCompactTimeoutMs ?? DEFAULT_FLUSH_COMPACT_TIMEOUT_MS, "compact");
  });

  // Flush before session shutdown. Pi awaits async session_shutdown handlers
  // before invalidating the session, so await the bounded flush here.
  pi.on("session_shutdown", async (event, ctx) => {
    if (!config.flushOnShutdown || event.reason === "reload") return;
    await measureLifecycle("shutdown.flush", () =>
      flush(ctx, undefined, DEFAULT_FLUSH_SHUTDOWN_TIMEOUT_MS, "shutdown"),
    );
  });
}
