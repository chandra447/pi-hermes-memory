import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { MemoryConfig } from "./types.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_PROJECT_CHAR_LIMIT,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_FLUSH_MIN_TURNS,
  DEFAULT_NUDGE_TOOL_CALLS,
} from "./constants.js";

const DEFAULT_CONFIG: MemoryConfig = {
  memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
  userCharLimit: DEFAULT_USER_CHAR_LIMIT,
  projectCharLimit: DEFAULT_PROJECT_CHAR_LIMIT,
  nudgeInterval: DEFAULT_NUDGE_INTERVAL,
  reviewEnabled: true,
  flushOnCompact: true,
  flushOnShutdown: true,
  flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
  autoConsolidate: true,
  correctionDetection: true,
  nudgeToolCalls: DEFAULT_NUDGE_TOOL_CALLS,
  candidateShadowMode: true,
  candidateConfidenceThreshold: 0.75,
};

export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "hermes-memory-config.json",
);

export function loadConfig(): MemoryConfig {
  try {
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      const raw = fs.readFileSync(DEFAULT_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      // Merge: override defaults with user config
      const config: MemoryConfig = { ...DEFAULT_CONFIG };
      if (typeof parsed.memoryCharLimit === "number") config.memoryCharLimit = parsed.memoryCharLimit;
      if (typeof parsed.userCharLimit === "number") config.userCharLimit = parsed.userCharLimit;
      if (typeof parsed.nudgeInterval === "number") config.nudgeInterval = parsed.nudgeInterval;
      if (typeof parsed.reviewEnabled === "boolean") config.reviewEnabled = parsed.reviewEnabled;
      if (typeof parsed.flushOnCompact === "boolean") config.flushOnCompact = parsed.flushOnCompact;
      if (typeof parsed.flushOnShutdown === "boolean") config.flushOnShutdown = parsed.flushOnShutdown;
      if (typeof parsed.flushMinTurns === "number") config.flushMinTurns = parsed.flushMinTurns;
      if (typeof parsed.autoConsolidate === "boolean") config.autoConsolidate = parsed.autoConsolidate;
      if (typeof parsed.correctionDetection === "boolean") config.correctionDetection = parsed.correctionDetection;
      if (typeof parsed.nudgeToolCalls === "number") config.nudgeToolCalls = parsed.nudgeToolCalls;
      if (typeof parsed.candidateShadowMode === "boolean") config.candidateShadowMode = parsed.candidateShadowMode;
      if (typeof parsed.candidateConfidenceThreshold === "number") config.candidateConfidenceThreshold = parsed.candidateConfidenceThreshold;
      if (typeof parsed.projectCharLimit === "number") config.projectCharLimit = parsed.projectCharLimit;
      if (typeof parsed.memoryDir === "string") config.memoryDir = parsed.memoryDir;
      return config;
    }
  } catch {
    // Fall back to defaults on parse error or access issues
  }
  return { ...DEFAULT_CONFIG };
}
