/**
 * Insights command — /memory-insights shows what's stored in persistent memory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import { getMemoryUsageSignals, type MemoryUsageSignal } from "../store/sqlite-memory-store.js";
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";

/** Entries shown in the usage section's top-recalled list. */
const USAGE_TOP_ENTRIES = 5;
/** Character cap for entry excerpts in the usage section. */
const USAGE_EXCERPT_CHARS = 70;

interface UsageScopeStats {
  total: number;
  tracked: number;
  top: Array<{ content: string; signal: MemoryUsageSignal }>;
}

function usageExcerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > USAGE_EXCERPT_CHARS
    ? `${flat.slice(0, USAGE_EXCERPT_CHARS - 3)}...`
    : flat;
}

/**
 * Recall stats for one store scope. Fail-open: a null dbManager or any lookup
 * error renders the insights command without the usage section.
 */
function usageScopeStats(dbManager: DatabaseManager | null, target: "memory" | "user" | "failure", project: string | null): UsageScopeStats | null {
  if (!dbManager) return null;
  try {
    const signals = getMemoryUsageSignals(dbManager, { target, project });
    const total = (dbManager.getDb().prepare(
      "SELECT COUNT(*) as count FROM memories WHERE target = ? AND project IS ?",
    ).get(target, project) as { count: number | bigint }).count;
    const top = [...signals.entries()]
      .sort((a, b) => b[1].hits - a[1].hits)
      .slice(0, USAGE_TOP_ENTRIES)
      .map(([content, signal]) => ({ content, signal }));
    const numTotal = typeof total === "bigint" ? Number(total) : total;
    return { total: numTotal, tracked: signals.size, top };
  } catch {
    return null;
  }
}

function renderUsageScope(label: string, stats: UsageScopeStats | null): string[] {
  if (!stats || stats.total === 0) return [];
  const lines = [`  🔍 USAGE — ${label}: ${stats.tracked} of ${stats.total} entries recalled via memory_search`];
  if (stats.top.length === 0) {
    lines.push("  (no recorded recalls yet — usage accrues as memory_search runs)");
  } else {
    stats.top.forEach((entry, i) => {
      lines.push(`  ${i + 1}. ${entry.signal.hits}x (last ${entry.signal.lastHit}) — ${usageExcerpt(entry.content)}`);
    });
  }
  return lines;
}

export function registerInsightsCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  projectName: ProjectNameRef,
  dbManager: DatabaseManager | null = null,
): void {
  pi.registerCommand("memory-insights", {
    description: "Show what's stored in persistent memory",
    handler: async (_args, ctx) => {
      const memoryEntries = store.getMemoryEntries();
      const userEntries = store.getUserEntries();
      const activeProjectStore = resolveProjectStore(projectStore);
      const activeProjectName = resolveProjectName(projectName);
      const projectEntries = activeProjectStore ? activeProjectStore.getMemoryEntries() : null;

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║            🧠 Memory Insights                ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");

      // Memory section
      lines.push("  📋 MEMORY (your personal notes)");
      lines.push("  " + "─".repeat(44));
      if (memoryEntries.length === 0) {
        lines.push("  (empty)");
      } else {
        for (let i = 0; i < memoryEntries.length; i++) {
          const preview =
            memoryEntries[i].length > 100
              ? memoryEntries[i].slice(0, 100) + "..."
              : memoryEntries[i];
          lines.push(`  ${i + 1}. ${preview}`);
        }
      }
      lines.push("");

      // User section
      lines.push("  👤 USER PROFILE");
      lines.push("  " + "─".repeat(44));
      if (userEntries.length === 0) {
        lines.push("  (empty)");
      } else {
        for (let i = 0; i < userEntries.length; i++) {
          const preview =
            userEntries[i].length > 100
              ? userEntries[i].slice(0, 100) + "..."
              : userEntries[i];
          lines.push(`  ${i + 1}. ${preview}`);
        }
      }
      lines.push("");

      if (projectEntries !== null) {
        lines.push(`  📁 PROJECT MEMORY: ${activeProjectName ?? ""}`);
        lines.push("  " + "─".repeat(44));
        if (projectEntries.length === 0) {
          lines.push("  (empty)");
        } else {
          for (let i = 0; i < projectEntries.length; i++) {
            const preview =
              projectEntries[i].length > 100
                ? projectEntries[i].slice(0, 100) + "..."
                : projectEntries[i];
            lines.push(`  ${i + 1}. ${preview}`);
          }
        }
        lines.push("");
      }

      // Usage section (promotion-gate data: which entries actually get recalled)
      const usageLines = [
        ...renderUsageScope("global memory", usageScopeStats(dbManager, "memory", null)),
        ...renderUsageScope(
          `project:${activeProjectName ?? ""}`,
          activeProjectStore && activeProjectName ? usageScopeStats(dbManager, "memory", activeProjectName) : null,
        ),
      ];
      if (usageLines.length > 0) {
        lines.push(...usageLines);
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
