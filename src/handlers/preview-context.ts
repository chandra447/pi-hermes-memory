/**
 * Preview context command — /memory-preview-context shows the policy-only prompt
 * or legacy memory blocks appended to the system prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import type { StandingInstructions } from "../store/standing-instructions.js";
import { resolveMemoryPolicyPrompt } from "../prompt-context.js";
import type { MemoryConfig } from "../types.js";
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";

function appendStandingBlock(lines: string[], standing: StandingInstructions | null): number {
  const rendered = standing?.render();
  if (!rendered?.block) return 0;
  lines.push("  ── STANDING INSTRUCTIONS (always injected) ─────────────────");
  lines.push(rendered.block);
  if (rendered.omittedCount > 0) {
    lines.push(`  ⚠️ ${rendered.omittedCount} pinned instruction(s) exceed the budget and are NOT injected.`);
  }
  lines.push("");
  return 1;
}

export function registerPreviewContextCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  projectName: ProjectNameRef,
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText"> = { memoryMode: "policy-only" },
  standing: StandingInstructions | null = null,
): void {
  pi.registerCommand("memory-preview-context", {
    description: "Preview the memory policy or legacy memory context blocks",
    handler: async (_args, ctx) => {
      if (config.memoryMode === "policy-only") {
        const policyPrompt = resolveMemoryPolicyPrompt(config);
        const lines: string[] = [];
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║        Injected Context Preview             ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  Mode: policy-only");
        lines.push(`  Policy style: ${config.memoryPolicyStyle ?? "full"}`);
        lines.push("  This is the memory policy appended to the system prompt.");
        lines.push("  Full Markdown memories are NOT injected in this mode.");
        lines.push("");
        let blockCount = 0;
        if (policyPrompt) {
          blockCount++;
          lines.push(policyPrompt);
          lines.push("");
        } else {
          lines.push("  No memory policy context is injected for this policy style.");
          lines.push("");
        }
        blockCount += appendStandingBlock(lines, standing);
        lines.push(`  Blocks shown: ${blockCount}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const activeProjectStore = resolveProjectStore(projectStore);
      const activeProjectName = resolveProjectName(projectName);
      const memoryBlock = store.formatForSystemPrompt();
      const projectBlock = activeProjectStore ? activeProjectStore.formatProjectBlock(activeProjectName ?? "") : "";

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║        Injected Context Preview             ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");
      lines.push("  This is the memory context appended to the system prompt.");
      lines.push("  (Core hidden system instructions are NOT shown.)");
      lines.push("");

      let blockCount = 0;

      if (memoryBlock) {
        blockCount++;
        lines.push("  ── MEMORY + USER + RECENT FAILURES ─────────────────────────");
        lines.push(memoryBlock);
        lines.push("");
      }
      if (projectBlock) {
        blockCount++;
        lines.push(`  ── PROJECT MEMORY (${activeProjectName ?? ""}) ─────────────────────────`);
        lines.push(projectBlock);
        lines.push("");
      }

      blockCount += appendStandingBlock(lines, standing);

      if (blockCount === 0) {
        lines.push("  No memory context blocks are currently injected.");
        lines.push("  Add memory entries, then run this command again.");
        lines.push("");
      }

      lines.push(`  Blocks shown: ${blockCount}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
