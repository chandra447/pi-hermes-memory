import { ENTRY_DELIMITER, MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "./constants.js";
import type { MemoryConfig } from "./types.js";
import type { MemoryStore } from "./store/memory-store.js";
import type { StandingInstructions } from "./store/standing-instructions.js";
import type { SharedProfileState } from "./hub-client/shared-profile.js";

type MemoryPolicyConfig = Pick<MemoryConfig, "memoryPolicyStyle" | "memoryPolicyCustomText">;

export function resolveMemoryPolicyPrompt(config: MemoryPolicyConfig): string {
  const style = config.memoryPolicyStyle ?? "full";

  switch (style) {
    case "compact":
      return MEMORY_POLICY_PROMPT_COMPACT;
    case "custom":
      return config.memoryPolicyCustomText && config.memoryPolicyCustomText.trim().length > 0
        ? config.memoryPolicyCustomText
        : MEMORY_POLICY_PROMPT_COMPACT;
    case "none":
      return "";
    case "full":
    default:
      return MEMORY_POLICY_PROMPT;
  }
}

/**
 * Standing instructions are appended in *every* mode, including policy-only
 * and policy style "none". That is the whole point of the store: a rule the
 * user pinned must not depend on the model choosing to run memory_search
 * before the action it forbids (#121). They go last so they read as the
 * operative directive rather than as recalled context.
 *
 * The shared user profile (story 4, CAP-5) composes through THIS path — it
 * is one more frozen block in the legacy-inject prompt, never a fork: passed
 * as `sharedProfile` (the settled, once-per-session state), rendered after
 * the local memory block. `null` (not configured) leaves the output
 * byte-identical to v1 (M4).
 */
export async function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
  standing: StandingInstructions | null = null,
  sharedProfile: SharedProfileState | null = null,
): Promise<string> {
  const standingBlock = standing?.formatForSystemPrompt() ?? "";

  if (config.memoryMode === "policy-only") {
    return [resolveMemoryPolicyPrompt(config), standingBlock].filter(Boolean).join("\n\n");
  }

  const memoryBlock = store.formatForSystemPrompt();
  // Dedup against the FROZEN snapshot's user entries (what the block above
  // renders), never the live entries — the prompt must be a pure function of
  // the frozen snapshot + the settled profile (prompt-cache invariant).
  const sharedBlock = sharedProfile
    ? renderSharedProfileBlock(sharedProfile, store.getSnapshotUserEntries())
    : "";
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (sharedBlock) parts.push(sharedBlock);
  if (projectBlock) parts.push(projectBlock);
  if (standingBlock) parts.push(standingBlock);

  return parts.join("\n\n");
}

/**
 * Render the shared user profile block (story 4). Local augments shared,
 * local wins on conflict — the only deterministic conflict is identical
 * content: a shared entry duplicating a local user entry (of the FROZEN
 * snapshot) is dropped from the shared block (the local copy renders above,
 * byte-identical to v1). Diverged entries both render — the union. `down`
 * renders the explicit degraded line (FR-16); an empty `up` profile renders
 * nothing.
 */
function renderSharedProfileBlock(profile: SharedProfileState, snapshotUserEntries: string[]): string {
  if (profile.kind === "down") {
    return [
      "<memory-context>",
      "SHARED USER PROFILE — degraded: the memory hub was unreachable at session start, so only THIS box's local profile is loaded. The shared profile (the one every box sees) reappears in a later session.",
      "</memory-context>",
    ].join("\n");
  }
  const local = new Set(snapshotUserEntries.map((e) => e.trim()));
  const shared = profile.entries.filter((e) => {
    const t = e.trim();
    return t.length > 0 && !local.has(t);
  });
  if (!shared.length) return "";
  const separator = "═".repeat(46);
  const count = `${shared.length} ${shared.length === 1 ? "entry" : "entries"}`;
  const header = `USER PROFILE (shared across the LAN — the same person everywhere) [${count}]`;
  return [
    "<memory-context>",
    "The following is the SHARED user profile from the LAN memory hub. Local entries above take precedence on conflict.",
    "",
    `${separator}\n${header}\n${separator}\n${shared.join(ENTRY_DELIMITER)}`,
    "</memory-context>",
  ].join("\n");
}
