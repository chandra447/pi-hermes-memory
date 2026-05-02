/**
 * Switch project command — /memory-switch-project lets users manually
 * set the active project for project-scoped memory.
 *
 * Normally, the project is auto-detected from cwd at extension load.
 * This command is useful when the user wants to view or manage memory
 * for a project they're not currently in.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export function registerSwitchProjectCommand(pi: ExtensionAPI): void {
  pi.registerCommand("memory-switch-project", {
    description: "Switch the active project for project-scoped memory",

    async handler(_args, ctx) {
      const homeDir = os.homedir();
      const agentDir = path.join(homeDir, ".pi", "agent");

      // Discover all project directories (subdirectories of ~/.pi/agent/ that have MEMORY.md)
      let projects: string[] = [];
      try {
        const entries = await fs.readdir(agentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name === "memory" || entry.name === "skills") continue; // skip core dirs
          try {
            await fs.access(path.join(agentDir, entry.name, "MEMORY.md"));
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
          const raw = await fs.readFile(path.join(agentDir, proj, "MEMORY.md"), "utf-8");
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
