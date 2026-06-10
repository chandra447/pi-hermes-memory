/**
 * Switch project command — /memory-switch-project lets users manually
 * set the active project for project-scoped memory.
 *
 * Normally, the project is auto-detected from cwd at extension load.
 * This command is useful when the user wants to view or manage memory
 * for a project they're not currently in.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveProjectsRoot } from "../paths.js";

export function registerSwitchProjectCommand(pi: ExtensionAPI, config?: MemoryConfig): void {
  const projectsMemoryDir = config?.projectsMemoryDir ?? "projects-memory";
  pi.registerCommand("memory-switch-project", {
    description: "Switch the active project for project-scoped memory",

    async handler(_args, ctx) {
      const projectsDir = resolveProjectsRoot(projectsMemoryDir);

      // Discover all project directories (subdirectories of projects-memory/ that have MEMORY.md)
      let projects: string[] = [];
      try {
        const entries = await fs.readdir(projectsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          try {
            await fs.access(path.join(projectsDir, entry.name, "MEMORY.md"));
            projects.push(entry.name);
          } catch { /* no MEMORY.md — skip */ }
        }
      } catch {
        // Directory doesn't exist — no projects
      }

      if (projects.length === 0) {
        ctx.ui.notify(
          "\n  📁 No project memories found.\n\n  Project memory is automatically created when you use the memory tool with\n  target 'project' while working in a project directory.\n",
          "info",
        );
        return;
      }

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║        📁 Project Memory — Switch           ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");
      lines.push("  Available project memories:");
      lines.push("");

      for (const proj of projects.sort()) {
        // Read entry count
        let entryCount = 0;
        try {
          const raw = await fs.readFile(path.join(projectsDir, proj, "MEMORY.md"), "utf-8");
          entryCount = raw.split("\n§\n").filter(Boolean).length;
        } catch { /* ignore */ }

        lines.push(`  📁 ${proj} (${entryCount} ${entryCount === 1 ? "entry" : "entries"})`);
      }

      lines.push("");
      lines.push("  Use the memory tool with target 'project' to manage");
      lines.push("  project-scoped memory. Project is auto-detected from");
      lines.push(`  your current directory: ${process.cwd()}`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
