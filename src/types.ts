/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

export interface MemoryConfig {
  /** Max chars for MEMORY.md (agent notes). Default: 2200 */
  memoryCharLimit: number;
  /** Max chars for USER.md (user profile). Default: 1375 */
  userCharLimit: number;
  /** Turns between background auto-reviews. Default: 10 */
  nudgeInterval: number;
  /** Enable background learning loop. Default: true */
  reviewEnabled: boolean;
  /** Flush memories before compaction. Default: true */
  flushOnCompact: boolean;
  /** Flush memories on session shutdown. Default: true */
  flushOnShutdown: boolean;
  /** Minimum user turns before flush triggers. Default: 6 */
  flushMinTurns: number;
}

export interface MemoryResult {
  success: boolean;
  error?: string;
  message?: string;
  target?: "memory" | "user";
  entries?: string[];
  usage?: string;
  entry_count?: number;
  matches?: string[];
}

export interface MemorySnapshot {
  memory: string;
  user: string;
}
