/**
 * /memory-pin — the only writer of STANDING.md besides the user's own editor.
 *
 * Deliberately not a tool: background review, consolidation and the correction
 * detector must have no path into the always-injected block (#121). Keeping it
 * a slash command makes model-authored standing instructions structurally
 * impossible rather than merely forbidden by prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STANDING_MAX_CHARS, STANDING_MAX_ENTRIES } from "../constants.js";
import type { StandingInstructions } from "../store/standing-instructions.js";

const SUBCOMMANDS = ["list", "remove", "clear"] as const;

function formatList(store: StandingInstructions): string[] {
  const instructions = store.list();
  const lines: string[] = [];
  lines.push("");
  lines.push("  ╔══════════════════════════════════════════════╗");
  lines.push("  ║          📌 Standing Instructions            ║");
  lines.push("  ╚══════════════════════════════════════════════╝");
  lines.push("");

  if (instructions.length === 0) {
    lines.push("  (none pinned)");
    lines.push("");
    lines.push("  Pin a rule that must hold in every session:");
    lines.push("    /memory-pin never run find / or other root-wide searches");
    lines.push("");
    return lines;
  }

  const { injectedCount, omittedCount } = store.render();
  const used = instructions.join("\n").length;
  for (const [index, instruction] of instructions.entries()) {
    lines.push(`  ${index + 1}. ${instruction}`);
  }
  lines.push("");
  lines.push(`  ${instructions.length}/${STANDING_MAX_ENTRIES} entries · ${used}/${STANDING_MAX_CHARS} chars`);
  lines.push(`  Injected into every session: ${injectedCount}`);
  if (omittedCount > 0) {
    lines.push(`  ⚠️ ${omittedCount} over budget and NOT injected — remove or shorten entries.`);
  }
  lines.push(`  File: ${store.getFilePath()}`);
  lines.push("");
  lines.push("  /memory-pin remove <n> · /memory-pin clear");
  lines.push("");
  return lines;
}

export function registerStandingPinCommand(pi: ExtensionAPI, store: StandingInstructions): void {
  pi.registerCommand("memory-pin", {
    description: "Pin a standing instruction that is injected into every session",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      if (trimmed.includes(" ")) return null;
      return SUBCOMMANDS
        .filter((name) => name.startsWith(trimmed))
        .map((name) => ({ value: name, label: name }));
    },
    handler: async (args, ctx) => {
      if (!store.isLoaded()) await store.load();

      const input = (args ?? "").trim();
      const [head, ...rest] = input.split(/\s+/);
      const subcommand = head?.toLowerCase();

      if (input === "" || subcommand === "list") {
        ctx.ui.notify(formatList(store).join("\n"), "info");
        return;
      }

      if (subcommand === "clear") {
        const result = await store.clear();
        ctx.ui.notify(result.success ? `📌 ${result.message}` : `❌ ${result.error}`, result.success ? "info" : "warning");
        return;
      }

      if (subcommand === "remove") {
        const position = Number(rest[0]);
        const result = await store.remove(position);
        if (!result.success) {
          ctx.ui.notify(`❌ ${result.error}`, "warning");
          return;
        }
        ctx.ui.notify([`📌 ${result.message}`, "", ...formatList(store)].join("\n"), "info");
        return;
      }

      const result = await store.add(input);
      if (!result.success) {
        ctx.ui.notify(`❌ ${result.error}`, "warning");
        return;
      }

      // Echo exactly what will be injected, so the user can see the stored text
      // rather than trusting that their phrasing survived normalization.
      ctx.ui.notify(
        [
          `📌 ${result.message}`,
          "",
          "  This is now injected into every session, in all memory modes.",
          "  It takes effect from your next message.",
          "",
        ].join("\n"),
        "info",
      );
    },
  });
}
