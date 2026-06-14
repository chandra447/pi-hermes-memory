/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Uses pi.exec() to spawn a one-shot consolidation process.
 * The child process modifies files on disk, so the parent MUST reload
 * from disk after consolidation completes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { CONSOLIDATION_PROMPT, ENTRY_DELIMITER } from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";
import { execChildPrompt } from "./pi-child-process.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";

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
  const terminated = result.killed || result.code === 143;

  if (terminated) {
    return `Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: ${timeoutMs}ms. Consider increasing consolidationTimeoutMs if this is a manual run.`;
  }

  return `Consolidation process exited with code ${result.code}: ${stderr?.slice(0, 200) || "unknown error"}`;
}

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = 60000,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
): Promise<ConsolidationResult> {
  const entries = entriesForTarget(store, target);
  const currentContent = entries.join(ENTRY_DELIMITER);

  const prompt = [
    CONSOLIDATION_PROMPT,
    "",
    `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
    currentContent || "(empty)",
    "",
    `Use the memory tool to consolidate. Target: '${toolTarget}'`,
  ].join("\n");

  try {
    const result = await execChildPrompt(pi, prompt, llmConfig, {
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
  }
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  timeoutMs: number = 60000,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const manualTimeoutMs = Math.max(timeoutMs, 180000);
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
          manualTimeoutMs,
          item.toolTarget,
          llmConfig,
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
