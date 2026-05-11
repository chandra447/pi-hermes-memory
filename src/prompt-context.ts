import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "./constants.js";
import type { MemoryConfig } from "./types.js";
import type { MemoryStore } from "./store/memory-store.js";
import type { SkillStore } from "./store/skill-store.js";

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

export async function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  skillStore: SkillStore,
  projectName: string,
): Promise<string> {
  if (config.memoryMode === "policy-only") {
    return resolveMemoryPolicyPrompt(config);
  }

  const memoryBlock = store.formatForSystemPrompt();
  const skillIndex = await skillStore.formatIndexForSystemPrompt();
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (projectBlock) parts.push(projectBlock);
  if (skillIndex) parts.push(skillIndex);

  return parts.join("\n\n");
}
