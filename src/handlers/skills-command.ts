/**
 * Skills command — /memory-skills lists all agent-created skills.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SkillStore } from "../store/skill-store.js";

export function registerSkillsCommand(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerCommand("memory-skills", {
    description: "List all agent-created skills (procedural memory)",
    handler: async (_args, ctx) => {
      const skills = await store.loadIndex();

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║            🧠 Procedural Skills             ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");

      if (skills.length === 0) {
        lines.push("  (no skills created yet)");
        lines.push("");
        lines.push("  Skills are auto-created after complex tasks,");
        lines.push("  or you can ask the agent to create one.");
      } else {
        for (const skill of skills) {
          lines.push(`  📄 ${skill.name}`);
          lines.push(`     ${skill.description}`);
          lines.push(`     file: ${skill.fileName}`);
          lines.push("");
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
