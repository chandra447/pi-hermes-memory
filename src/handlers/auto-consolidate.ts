/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Uses pi.exec() to spawn a one-shot consolidation process.
 * The child process modifies files on disk, so the parent MUST reload
 * from disk after consolidation completes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { CONSOLIDATION_PROMPT, ENTRY_DELIMITER } from "../constants.js";
import type { ConsolidationResult } from "../types.js";

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: "memory" | "user" | "failure",
  signal?: AbortSignal,
): Promise<ConsolidationResult> {
  const entries =
    target === "memory" ? store.getMemoryEntries() : store.getUserEntries();
  const currentContent = entries.join(ENTRY_DELIMITER);

  const prompt = [
    CONSOLIDATION_PROMPT,
    "",
    `--- Current ${target === "user" ? "User Profile" : "Memory"} Entries ---`,
    currentContent || "(empty)",
    "",
    `Use the memory tool to consolidate. Target: '${target}'`,
  ].join("\n");

  try {
    const result = await pi.exec("pi", ["-p", "--no-session", prompt], {
      signal,
      timeout: 60000,
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
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const results: string[] = [];

      for (const target of ["memory", "user"] as const) {
        const entries =
          target === "memory"
            ? store.getMemoryEntries()
            : store.getUserEntries();

        if (entries.length === 0) {
          results.push(`${target}: (empty, nothing to consolidate)`);
          continue;
        }

        const result = await triggerConsolidation(pi, store, target, ctx.signal);

        if (result.consolidated) {
          await store.loadFromDisk();
          results.push(`${target}: ✅ consolidated`);
        } else {
          results.push(`${target}: ❌ ${result.error}`);
        }
      }

      ctx.ui.notify(
        `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`,
        "info",
      );
    },
  });
}
