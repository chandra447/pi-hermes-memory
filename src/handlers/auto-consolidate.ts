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
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import { getMemoryUsageSignals, type MemoryUsageSignal } from "../store/sqlite-memory-store.js";
import {
  CONSOLIDATION_PROMPT,
  CONSOLIDATION_CHUNK_CHARS_MIN,
  DEFAULT_CONSOLIDATION_CHUNK_CHARS,
  MAX_CONSOLIDATION_ROUNDS,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
} from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";
import { AGENT_ROOT } from "../paths.js";
import { execChildPrompt } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport, type DirectReviewContext } from "./review-memory-ops.js";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";
type ConsolidationLlmConfig = Pick<
  MemoryConfig,
  "llmModelOverride" | "llmThinkingOverride" | "reviewTransport"
  | "consolidationChunking" | "consolidationChunkChars" | "consolidationUsageSignals"
>;

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
  scoped = false,
  usageSignals: Map<string, MemoryUsageSignal> | null = null,
): string {
  const lines = [
    CONSOLIDATION_PROMPT,
    "",
    `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
    entries.join(ENTRY_DELIMITER) || "(empty)",
  ];
  const signalsSection = usageSignalsSectionText(usageSignals, entries);
  if (signalsSection) {
    lines.push("", signalsSection);
  }
  lines.push(
    "",
    `Use memory_add, memory_replace, or memory_remove to consolidate. Target: '${toolTarget}'`,
  );
  if (scoped) {
    // Chunked rounds present a slice of the store, but the child's memory tools
    // can see everything. Without an explicit scope the model may modify entries
    // it was never shown — observed in real runs (a round wiped 11 out-of-scope
    // entries). Real runs 2026-09-10.
    lines.push(
      "This pass covers ONLY the entries listed above — they are one slice of a larger store being consolidated in rounds.",
      "Do NOT add, modify, or remove any entry that is not listed above.",
    );
  }
  return lines.join("\n");
}

/** Longest entry excerpt shown in a usage-signals line. */
const USAGE_SIGNAL_EXCERPT_CHARS = 80;
/** Caps per half (tracked / never-recalled) so a chunk of many small entries —
 *  or a mature store where everything has been recalled — cannot balloon a
 *  round's prompt past its bounded budget. Both halves fold their remainder
 *  into one summary line. */
const USAGE_SIGNAL_TRACKED_MAX_LINES = 20;
const USAGE_SIGNAL_NEVER_RECALLED_MAX_LINES = 20;

function usageSignalExcerpt(entry: string): string {
  const flat = entry.replace(/\s+/g, " ").trim();
  return flat.length > USAGE_SIGNAL_EXCERPT_CHARS
    ? `${flat.slice(0, USAGE_SIGNAL_EXCERPT_CHARS - 3)}...`
    : flat;
}

/**
 * Per-entry recall counts from the memory_search read path — the promotion-gate
 * data telling the model which entries are load-bearing and which have never
 * earned their place. Null (and therefore absent from prompts) until at least
 * one presented entry has actually been recalled, so stores without tracking
 * history keep byte-identical prompts.
 */
function usageSignalsSectionText(
  usageSignals: Map<string, MemoryUsageSignal> | null,
  entries: string[],
): string | null {
  if (!usageSignals || usageSignals.size === 0 || entries.length === 0) return null;

  const tracked: Array<{ entry: string; signal: MemoryUsageSignal }> = [];
  const neverRecalledLines: string[] = [];
  for (const entry of entries) {
    const signal = usageSignals.get(entry.trim());
    const excerpt = usageSignalExcerpt(entry);
    if (signal) {
      tracked.push({ entry, signal });
    } else {
      neverRecalledLines.push(`- never recalled: "${excerpt}"`);
    }
  }
  if (tracked.length === 0) return null;

  // Both halves are capped with a summary line for the remainder: a chunk of
  // many small entries — or a mature store where every entry has been recalled
  // — must not balloon a chunked round's prompt past its bounded budget.
  // Tracked entries are ranked by recall count so the most load-bearing ones
  // survive the cut.
  tracked.sort((a, b) => b.signal.hits - a.signal.hits);
  const trackedLines = tracked
    .slice(0, USAGE_SIGNAL_TRACKED_MAX_LINES)
    .map(({ signal, entry }) => `- recalled ${signal.hits}x, last ${signal.lastHit}: "${usageSignalExcerpt(entry)}"`);
  const lines = [
    "--- Usage Signals (memory_search recall tracking) ---",
    ...trackedLines,
  ];
  if (tracked.length > USAGE_SIGNAL_TRACKED_MAX_LINES) {
    lines.push(`- (+${tracked.length - USAGE_SIGNAL_TRACKED_MAX_LINES} more recalled entries omitted — showing the top ${USAGE_SIGNAL_TRACKED_MAX_LINES} by recall count)`);
  }
  lines.push(...neverRecalledLines.slice(0, USAGE_SIGNAL_NEVER_RECALLED_MAX_LINES));
  if (neverRecalledLines.length > USAGE_SIGNAL_NEVER_RECALLED_MAX_LINES) {
    lines.push(`- (+${neverRecalledLines.length - USAGE_SIGNAL_NEVER_RECALLED_MAX_LINES} more listed entries have no recorded recalls)`);
  }
  lines.push(
    "Treat these as tie-breakers, not removal orders: well-recalled entries are load-bearing (prefer keeping or merging them); never-recalled entries are weaker keep candidates.",
  );
  return lines.join("\n");
}

/**
 * Scoped recall stats for the store being consolidated, or null when tracking
 * is off, no database is available, or the lookup fails (fail-open).
 */
function loadUsageSignals(
  dbManager: DatabaseManager | null,
  llmConfig: ConsolidationLlmConfig,
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  projectName: string | null | undefined,
): Map<string, MemoryUsageSignal> | null {
  if (!dbManager || llmConfig.consolidationUsageSignals === false) return null;
  try {
    return getMemoryUsageSignals(dbManager, {
      target,
      project: toolTarget === "project" ? (projectName ?? null) : null,
    });
  } catch {
    return null;
  }
}

function chunkCharsFor(config: ConsolidationLlmConfig): number {
  const value = config.consolidationChunkChars;
  return typeof value === "number" && Number.isFinite(value) && value >= CONSOLIDATION_CHUNK_CHARS_MIN
    ? value
    : DEFAULT_CONSOLIDATION_CHUNK_CHARS;
}

/** A round shorter than this cannot plausibly boot a child and merge anything. */
const MIN_ROUND_MS = 10_000;

/**
 * Head entries worth up to chunkChars of prompt text. Whole entries only; an
 * entry larger than chunkChars travels alone so the loop always makes progress.
 */
export function takeChunk(entries: string[], chunkChars: number): string[] {
  const batch: string[] = [];
  let length = 0;
  for (const entry of entries) {
    const entryLength = entry.length + ENTRY_DELIMITER.length;
    if (batch.length > 0 && length + entryLength > chunkChars) break;
    batch.push(entry);
    length += entryLength;
  }
  return batch;
}

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: ConsolidationLlmConfig = {},
  directCtx: DirectReviewContext | null = null,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion } = {},
): Promise<ConsolidationResult> {
  const entries = entriesForTarget(store, target);
  const currentContent = entries.join(ENTRY_DELIMITER);
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;
  const usageSignals = loadUsageSignals(dbManager, llmConfig, target, toolTarget, projectName);

  if (directCtx && usesDirectTransport(llmConfig)) {
    try {
      const directEntriesHeader = `--- Current ${labelForTarget(target, toolTarget)} Entries (target: '${toolTarget}') ---`;
      const directSignalsSection = usageSignalsSectionText(usageSignals, entries);
      const directResult = await runDirect(
        directCtx,
        store,
        toolTarget === "project" ? store : null,
        {
          systemPrompt: DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
          userPrompt: [
            directEntriesHeader,
            currentContent || "(empty)",
            ...(directSignalsSection ? ["", directSignalsSection] : []),
            "",
            `Only emit operations with "target": "${toolTarget}".`,
          ].join("\n"),
          config: llmConfig,
          timeoutMs,
          signal,
          requireAtomicShrink: true,
          expectedTarget: toolTarget,
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
      // An empty completion is terminal (#235): the direct model answered
      // with nothing in either channel, so the subprocess child would run
      // the same model against the same server-side thinking default and
      // fail the same way (#197). The success criterion is unchanged — it
      // must actually shrink — but this case reports instead of acquiring
      // the consolidation lock and spawning the child.
      if (directResult.ok && directResult.fallbackReason === "empty_response") {
        const modelRef = directCtx.model?.provider
          ? `${directCtx.model.provider}/${directCtx.model.id}`
          : "model";
        return {
          consolidated: false,
          error: `${modelRef} returned an empty completion; no consolidation attempted`,
        };
      }
    } catch {
      // Fall through to subprocess below.
    }
  }

    const chunkChars = chunkCharsFor(llmConfig);
    const chunkingEnabled = llmConfig.consolidationChunking === true;
    const hasUsage = typeof (store as any).capacityUsage === "function";
    const usageOf = (list: string[]): number =>
      hasUsage ? (store as any).capacityUsage(target) : list.join(ENTRY_DELIMITER).length;
    const goal = typeof store.capacityGoal === "function" ? store.capacityGoal(target) : chunkChars;

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
          error: `Consolidation already in progress for target '${toolTarget}' in another session — nothing was consolidated here; retry shortly.`,
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

      if (!chunkingEnabled) {
        // Legacy single-shot path — the flag default. Byte-identical to
        // pre-chunking releases for stores of any size (usage signals are the
        // one additive prompt section, and only once tracking data exists).
        // When an oversized store times out, the error below names the remedy
        // keys so the failure teaches the fix.
        const result = await execChildPrompt(pi, buildConsolidationPrompt(target, toolTarget, promptEntries, false, usageSignals), llmConfig, {
          signal,
          timeoutMs,
          retryWithoutOverrides: true,
        }) as { code: number; stdout?: string; stderr?: string; killed?: boolean };

        if (result.code === 0) {
          return { consolidated: true };
        }
        let error = describeConsolidationFailure(result, timeoutMs);
        const terminated = result.killed || result.code === 124 || result.code === 143;
        if (terminated && promptEntries.join(ENTRY_DELIMITER).length > chunkChars) {
          error += ` This store exceeds consolidationChunkChars (${chunkChars}) — enabling consolidationChunking splits consolidation into bounded rounds.`;
        }
        return { consolidated: false, error };
      }

      if (promptEntries.length === 0 || usageOf(promptEntries) <= goal) {
        // Within the target's capacity goal (encoded units, same as the cap):
        // nothing needs to shrink toward the goal — a clean no-op, not a
        // failure. Covers healthy stores of any size, the failure tier, and
        // manual triggers on stores that do not need consolidation.
        return { consolidated: true, rounds: 0 };
      }

      const deadline = Date.now() + timeoutMs;

      // Chunked path — the store exceeds one child run's prompt budget, and a
      // single whole-store LLM merge is what produced the observed "subprocess
      // terminated (likely timeout)" failures at cap scale. Rounds share the
      // overall budget (deadline): each consolidates a slice, then reloads from
      // disk (the child modified files) and re-evaluates. A store that fits one
      // prompt runs a single UNSCOPED decisive round — the legacy single-shot
      // call, same prompt, same timeout, one invocation. Resume needs no
      // cursor: partial progress is already on disk.
      let completedRounds = 0;
      let progressRounds = 0;
      const notes: string[] = [];
      let offset = 0;

      while (completedRounds < MAX_CONSOLIDATION_ROUNDS) {
        if (promptEntries.length === 0) break; // everything merged away
        const promptTotal = promptEntries.join(ENTRY_DELIMITER).length;
        if (promptTotal <= chunkChars && usageOf(promptEntries) <= goal) break; // capacity goal met
        if (signal?.aborted) {
          notes.push("aborted between consolidation rounds");
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining < MIN_ROUND_MS) {
          notes.push(`consolidation time budget (${timeoutMs}ms) exhausted; retrigger consolidation to continue from current state`);
          break;
        }

        // Removals in earlier rounds shift indices left; the walk offset may
        // point past the (now shorter) store — wrap it instead of slicing an
        // empty batch.
        if (offset >= promptEntries.length) offset = 0;

        const fitsOneChunk = promptTotal <= chunkChars;
        const usageBefore = usageOf(promptEntries);
        const batch = fitsOneChunk
          ? promptEntries // decisive round: whole remaining store, full context
          : takeChunk(promptEntries.slice(offset), chunkChars);
        const batchSet = new Set(batch);
        const beforeRound = promptEntries;
        const result = await execChildPrompt(pi, buildConsolidationPrompt(target, toolTarget, batch, !fitsOneChunk, usageSignals), llmConfig, {
          signal,
          timeoutMs: Math.min(timeoutMs, remaining),
          retryWithoutOverrides: true,
        }) as { code: number; stdout?: string; stderr?: string; killed?: boolean };

        // Reload FIRST — even a failed round may have shrunk the store before
        // dying, and the recount below decides how the failure is reported.
        try {
          await store.loadFromDisk();
          promptEntries = entriesForTarget(store, target);
        } catch {
          notes.push("could not reload memory after a consolidation round");
          break;
        }

        const currentRound = completedRounds + 1;

        // Out-of-scope changes: entries that vanished this round without being
        // part of the presented slice. The child can see the whole store through
        // its tools, and a concurrent session may delete entries in this window
        // too — the parent cannot tell a rogue deletion from a legitimate
        // cross-slice dedup or a concurrent one, so out-of-scope disappearances
        // are REPORTED, never resurrected (resurrection would fight legitimate
        // dedup and ping-pong across triggers; the store's recovery snapshots
        // remain the repair path for real damage).
        const outOfScope = beforeRound.filter(
          (entry) => !batchSet.has(entry) && !promptEntries.includes(entry),
        );
        if (outOfScope.length > 0) {
          notes.push(`round ${currentRound} coincided with ${outOfScope.length} out-of-scope entr${outOfScope.length === 1 ? "y" : "ies"} disappearing (by the child or a concurrent writer) — inspect memory if that was not intended`);
        }

        const usageAfter = usageOf(promptEntries);
        const shrank = usageAfter < usageBefore;

        if (result.code !== 0) {
          if (shrank) {
            // The round shrank the store and THEN died (killed mid-merge). The
            // shrink is real and on disk — report it as partial progress instead
            // of a total failure, and let the next trigger resume.
            progressRounds++;
            notes.push(describeConsolidationFailure(result, Math.min(timeoutMs, remaining))
              + ` The failing round still shrank the store by ${usageBefore - usageAfter} chars; retrigger consolidation to continue.`);
          } else {
            notes.push(describeConsolidationFailure(result, Math.min(timeoutMs, remaining))
              + (completedRounds > 0
                ? ` ${completedRounds} earlier round${completedRounds === 1 ? "" : "s"} shrank the store; retrigger consolidation to continue.`
                : ""));
          }
          break;
        }

        completedRounds++;

        if (!shrank) {
          // This round shrank nothing. Walk to the next slice rather than
          // repeating it; when nothing in the walk yields, the round-cap exit
          // below reports the store as still over its goal.
          if (fitsOneChunk) {
            notes.push(`consolidation could not shrink the remaining ${promptTotal} chars (capacity goal ${goal}); entries may be distinct facts worth keeping — consider manual pruning`);
            break;
          }
          offset = (offset + batch.length) % Math.max(promptEntries.length, 1);
          continue;
        }

        progressRounds++;
        // Progress: keep walking forward past the slice this round consumed
        // (removals shift indices left, so this is approximate) — resetting to
        // the top would let a store whose head always yields a little progress
        // starve the tail forever.
        offset = (offset + batch.length) % Math.max(promptEntries.length, 1);
        if (usageAfter <= goal) break; // capacity goal met
        if (fitsOneChunk) break; // decisive round done; the next trigger starts a fresh pass
      }

      if (progressRounds > 0) {
        const roundNotes = [...notes];
        const usageEnd = usageOf(promptEntries);
        if (usageEnd > goal) {
          roundNotes.push(`store still ${usageEnd - goal} chars over its ${goal}-char capacity goal; entries may be distinct facts worth keeping — consider manual pruning or raising the limit`);
        }
        return {
          consolidated: true,
          partial: roundNotes.length > 0,
          rounds: completedRounds,
          ...(roundNotes.length ? { error: roundNotes.join("; ") } : {}),
        };
      }
      notes.push(`consolidation could not shrink the store toward its ${goal}-char capacity goal (${usageOf(promptEntries)} chars); entries may be distinct facts worth keeping — consider manual pruning or raising the limit`);
      return {
        consolidated: false,
        error: notes.join("; "),
      };
  } catch (err) {
    const message = String(err);
    if (message.includes("extension ctx is stale")) {
      // Session replaced/reloaded while consolidation was running. The new
      // session re-initializes the store and will consolidate on its own next
      // write, so this is a skip, not a failure — report it as deferred so the
      // caller asks for a retry instead of surfacing a stale-ctx error.
      return {
        consolidated: false,
        deferred: true,
        error: "session replaced or reloaded during consolidation — will consolidate on next write",
      };
    }
    return {
      consolidated: false,
      error: `Consolidation failed: ${message.slice(0, 200)}`,
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
  projectStore: ProjectStoreRef = null,
  projectName: ProjectNameRef = null,
  llmConfig: ConsolidationLlmConfig = {},
  dbManager: DatabaseManager | null = null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion } = {},
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const results: string[] = [];
      const activeProjectStore = resolveProjectStore(projectStore);
      const activeProjectName = resolveProjectName(projectName);
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

      if (activeProjectStore) {
        targets.push({
          label: activeProjectName ? `project:${activeProjectName}` : "project",
          store: activeProjectStore,
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
          activeProjectName,
          deps,
        );

        if (result.consolidated) {
          await item.store.loadFromDisk();
          const roundsNote = result.rounds ? ` (${result.rounds} round${result.rounds === 1 ? "" : "s"})` : "";
          const partialNote = result.partial ? ` ⚠️ partial: ${result.error ?? "incomplete"}` : "";
          results.push(`${item.label}: ✅ consolidated${roundsNote}${partialNote}`);
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
