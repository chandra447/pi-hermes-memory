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
import type { ConsolidationResult } from "../types.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";

function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  return target === "user" ? store.getUserEntries() : store.getMemoryEntries();
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === "project") return "Project Memory";
  if (target === "user") return "User Profile";
  if (target === "failure") return "Failure Memory";
  return "Memory";
}

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = 60000,
  toolTarget: ToolMemoryTarget = target,
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
    const result = await pi.exec("pi", ["-p", "--no-session", prompt], {
      signal,
      timeout: timeoutMs,
    });

    if (result.code === 0) {
      return { consolidated: true };
    }
    return {
      consolidated: false,
      error: `Consolidation process exited with code ${result.code}: ${result.stderr?.slice(0, 200) || "unknown error"}`,
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
      ];

      if (projectStore) {
        targets.push({
          label: projectName ? `project:${projectName}` : "project",
          store: projectStore,
          target: "memory",
          toolTarget: "project",
        });
      }

      for (const item of targets) {
        const entries = entriesForTarget(item.store, item.target);

        if (entries.length === 0) {
          results.push(`${item.label}: (empty, nothing to consolidate)`);
          continue;
        }

        const result = await triggerConsolidation(pi, item.store, item.target, ctx.signal, timeoutMs, item.toolTarget);

        if (result.consolidated) {
          await item.store.loadFromDisk();
          results.push(`${item.label}: ✅ consolidated`);
        } else {
          results.push(`${item.label}: ❌ ${result.error}`);
        }
      }

      ctx.ui.notify(
        `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`,
        "info",
      );
    },
  });
}
