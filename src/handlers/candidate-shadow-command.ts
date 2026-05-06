import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { MemoryConfig } from "../types.js";
import { buildCandidateShadowReport } from "../store/candidate-shadow.js";

interface CandidateShadowCommandOptions {
  sessionsDir?: string;
}

export function registerCandidateShadowRunCommand(
  pi: ExtensionAPI,
  config: MemoryConfig,
  options: CandidateShadowCommandOptions = {},
): void {
  pi.registerCommand("memory-candidates-shadow-run", {
    description: "Run read-only candidate extraction report from session history",
    handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
      if (!config.candidateShadowMode) {
        ctx.ui.notify("⚠️ candidateShadowMode is disabled in config. Enable it to run shadow reports.", "warning");
        return;
      }

      const sessionsDir = options.sessionsDir ?? path.join(os.homedir(), ".pi", "agent", "sessions");
      ctx.ui.notify("🔎 Running shadow candidate extraction (read-only)...", "info");

      const report = buildCandidateShadowReport(sessionsDir);
      const duplicatePct = (report.duplicateRate * 100).toFixed(1);
      const lowConfPct = (report.lowConfidenceRate * 100).toFixed(1);

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║     🧪 Candidate Shadow Report (Read-only)  ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");
      lines.push(`  📁 Files scanned: ${report.filesScanned}`);
      lines.push(`  🧵 Sessions parsed: ${report.sessionsScanned}`);
      lines.push(`  🧾 Raw candidates: ${report.rawCandidateCount}`);
      lines.push(`  ✅ Unique candidates: ${report.candidateCount}`);
      lines.push(`  ♻️ Duplicates: ${report.duplicateCount} (${duplicatePct}%)`);
      lines.push(`  ⚖️ Low confidence: ${report.lowConfidenceCount} (${lowConfPct}%)`);
      lines.push("");

      if (report.topRules.length === 0) {
        lines.push("  📌 Top rules: (none)");
      } else {
        lines.push("  📌 Top rules:");
        for (const rule of report.topRules) {
          lines.push(`     - ${rule.rule}: ${rule.count}`);
        }
      }

      if (report.errors.length > 0) {
        lines.push("");
        lines.push(`  ⚠️ Parse errors: ${report.errors.length}`);
        for (const err of report.errors.slice(0, 3)) {
          lines.push(`     - ${err}`);
        }
        if (report.errors.length > 3) {
          lines.push(`     - ... and ${report.errors.length - 3} more`);
        }
      }

      lines.push("");
      lines.push("  (No writes performed. Shadow mode is read-only.)");

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
