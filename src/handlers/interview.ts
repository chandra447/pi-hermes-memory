/**
 * Interview command — /memory-interview guides new users through a brief
 * onboarding interview to pre-fill their USER.md profile.
 *
 * This eliminates the "empty memory cold start" problem where users get
 * zero value until multiple sessions accumulate facts organically.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { INTERVIEW_PROMPT } from "../constants.js";

export function registerInterviewCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
): void {
  pi.registerCommand("memory-interview", {
    description: "Answer a few questions to pre-fill your user profile so the agent remembers you across sessions",
    handler: async (_args, ctx) => {
      const userEntries = store.getUserEntries();

      if (userEntries.length > 0) {
        // User already has profile entries — acknowledge and offer choices
        ctx.ui.notify(
          `\n  🧠 You already have ${userEntries.length} profile entr${userEntries.length === 1 ? "y" : "ies"}:\n` +
            userEntries.map((e) => `     • ${e.slice(0, 80)}${e.length > 80 ? "..." : ""}`).join("\n") +
            "\n\n  Starting the interview will add to or update these.\n",
          "info",
        );
      }

      // Send the interview prompt as a user message to trigger the agent turn
      await ctx.waitForIdle();
      pi.sendUserMessage(INTERVIEW_PROMPT);
    },
  });
}
