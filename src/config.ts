import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { MemoryConfig } from "./types.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_FLUSH_MIN_TURNS,
} from "./constants.js";

const DEFAULT_CONFIG: MemoryConfig = {
  memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
  userCharLimit: DEFAULT_USER_CHAR_LIMIT,
  nudgeInterval: DEFAULT_NUDGE_INTERVAL,
  reviewEnabled: true,
  flushOnCompact: true,
  flushOnShutdown: true,
  flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
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
      return config;
    }
  } catch {
    // Fall back to defaults on parse error or access issues
  }
  return { ...DEFAULT_CONFIG };
}
