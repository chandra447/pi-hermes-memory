import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "./constants.js";
import type { MemoryConfig } from "./types.js";
import type { MemoryStore } from "./store/memory-store.js";
import type { StandingInstructions } from "./store/standing-instructions.js";

type MemoryPolicyConfig = Pick<MemoryConfig, "memoryPolicyStyle" | "memoryPolicyCustomText"> & { skillsEnabled?: boolean };

/** A built-in policy without its skill guidance: the skill paragraph and the skill_manage tool line. */
function withoutSkillGuidance(prompt: string): string {
  return prompt
    .split("\n\n")
    .filter((block) => !/^(Procedural skills:|Use the skill_manage tool)/.test(block))
    .map((block) => block.split("\n").filter((line) => !line.startsWith("- skill_manage:")).join("\n"))
    .join("\n\n");
}

export function resolveMemoryPolicyPrompt(config: MemoryPolicyConfig): string {
  const style = config.memoryPolicyStyle ?? "full";
  const builtIn = (prompt: string) => (config.skillsEnabled === false ? withoutSkillGuidance(prompt) : prompt);

  switch (style) {
    case "compact":
      return builtIn(MEMORY_POLICY_PROMPT_COMPACT);
    case "custom":
      return config.memoryPolicyCustomText && config.memoryPolicyCustomText.trim().length > 0
        ? config.memoryPolicyCustomText
        : builtIn(MEMORY_POLICY_PROMPT_COMPACT);
    case "none":
      return "";
    case "full":
    default:
      return builtIn(MEMORY_POLICY_PROMPT);
  }
}

/**
 * Standing instructions are appended in *every* mode, including policy-only
 * and policy style "none". That is the whole point of the store: a rule the
 * user pinned must not depend on the model choosing to run memory_search
 * before the action it forbids (#121). They go last so they read as the
 * operative directive rather than as recalled context.
 */
export async function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText"> & { skillsEnabled?: boolean },
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
  standing: StandingInstructions | null = null,
  forChild = false,
): Promise<string> {
  const standingBlock = standing?.formatForSystemPrompt() ?? "";

  if (config.memoryMode === "policy-only") {
    // Children run with only the memory write tools, so the policy would advertise
    // tools they cannot call (memory_search, session_search, skill_manage).
    // Standing instructions still apply.
    if (forChild) return standingBlock;
    return [resolveMemoryPolicyPrompt(config), standingBlock].filter(Boolean).join("\n\n");
  }

  // Legacy blocks are memory data, not policy, so children keep them.
  const memoryBlock = store.formatForSystemPrompt();
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (projectBlock) parts.push(projectBlock);
  if (standingBlock) parts.push(standingBlock);

  return parts.join("\n\n");
}
