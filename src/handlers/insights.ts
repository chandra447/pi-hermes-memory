/**
 * Insights command — /memory-insights shows what's stored in persistent memory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";

export function registerInsightsCommand(pi: ExtensionAPI, store: MemoryStore, projectStore: ProjectStoreRef, projectName: ProjectNameRef): void {
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

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
