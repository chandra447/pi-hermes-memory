/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

import type { TextContent } from "@mariozechner/pi-ai";

export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict";

export interface MemoryConfig {
  /** Prompt memory mode. Default: policy-only */
  memoryMode: "policy-only" | "legacy-inject";
  /** Policy prompt style used when memoryMode is policy-only. Default: full */
  memoryPolicyStyle?: "full" | "compact" | "custom" | "none";
  /** Custom policy prompt text used when memoryPolicyStyle is custom */
  memoryPolicyCustomText?: string;
  /** Max chars for MEMORY.md (agent notes). Default: 5000 */
  memoryCharLimit: number;
  /** Max chars for USER.md (user profile). Default: 5000 */
  userCharLimit: number;
  /** Max chars for project-level MEMORY.md. Default: 5000 */
  projectCharLimit: number;
  /** Turns between background auto-reviews. Default: 10 */
  nudgeInterval: number;
  /** Recent conversation messages included in background review. 0 = all. Default: 0 */
  reviewRecentMessages?: number;
  /** Enable background learning loop. Default: true */
  reviewEnabled: boolean;
  /** Flush memories before compaction. Default: true */
  flushOnCompact: boolean;
  /** Flush memories on session shutdown. Default: true */
  flushOnShutdown: boolean;
  /** Minimum user turns before flush triggers. Default: 6 */
  flushMinTurns: number;
  /** Recent conversation messages included in session flush. 0 = all. Default: 0 */
  flushRecentMessages?: number;
  /** Override memory directory. Default: ~/.pi/agent/memory */
  memoryDir?: string;
  /** Directory for project-scoped memory (relative to ~/.pi/agent). Default: "projects-memory" */
  projectsMemoryDir?: string;
  /** Strategy when memory is full. Default: auto-consolidate */
  memoryOverflowStrategy?: MemoryOverflowStrategy;
  /** Legacy alias for memoryOverflowStrategy. Default: true */
  autoConsolidate: boolean;
  /** Detect user corrections and trigger immediate memory save. Default: true */
  correctionDetection: boolean;
  /** Override strong correction regex sources. Missing = defaults; [] = none. */
  correctionStrongPatterns?: string[];
  /** Override weak correction regex sources. Missing = defaults; [] = none. */
  correctionWeakPatterns?: string[];
  /** Override negative correction regex sources. Missing = defaults; [] = none. */
  correctionNegativePatterns?: string[];
  /** Override directive words used after weak correction patterns. Missing = defaults; [] = none. */
  correctionDirectiveWords?: string[];
  /** Inject recent failure memories into the system prompt. Default: true */
  failureInjectionEnabled: boolean;
  /** Maximum age in days for injected failure memories. Default: 7 */
  failureInjectionMaxAgeDays: number;
  /** Maximum number of failure memories to inject. Default: 5 */
  failureInjectionMaxEntries: number;
  /** Tool calls before triggering background review (in addition to turn count). Default: 15 */
  nudgeToolCalls: number;
  /** Maximum time in milliseconds for auto-consolidation to complete. Default: 60000 */
  consolidationTimeoutMs: number;
  /** Enable session history search via SQLite FTS5. Default: true */
  sessionSearchEnabled?: boolean;
  /** Days to retain session history. Default: 90 */
  sessionRetentionDays?: number;
}

export type MemoryCategory =
  | "failure"
  | "correction"
  | "insight"
  | "preference"
  | "convention"
  | "tool-quirk";

export interface MemoryResult {
  success: boolean;
  error?: string;
  message?: string;
  warning?: string;
  warnings?: string[];
  target?: "memory" | "user" | "failure" | "project";
  entries?: string[];
  usage?: string;
  entry_count?: number;
  evicted_entries?: string[];
  evicted_count?: number;
  matches?: string[];
}

export interface MemorySnapshot {
  memory: string;
  user: string;
}

export interface ConsolidationResult {
  /** Whether consolidation succeeded */
  consolidated: boolean;
  /** Error message if consolidation failed */
  error?: string;
}

export interface SkillIndex {
  /** File name (slug.md) */
  fileName: string;
  /** Human-readable name */
  name: string;
  /** Short description for system prompt index */
  description: string;
}

export interface SkillDocument extends SkillIndex {
  /** Full markdown body (after frontmatter) */
  body: string;
  /** Version number */
  version: number;
  /** ISO date created */
  created: string;
  /** ISO date last updated */
  updated: string;
}

export interface SkillResult {
  success: boolean;
  error?: string;
  message?: string;
  fileName?: string;
}

/**
 * Extract displayable text from a Pi session entry message.
 *
 * Accepts any value — returns null for non-message entries (BashExecutionMessage,
 * NotificationMessage, etc.) that lack a `content` property.
 *
 * Returns the concatenated text, truncated to `maxLength` chars.
 */
export function getMessageText(msg: unknown, maxLength = 500): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const { role, content } = msg as Record<string, unknown>;
  if (typeof role !== "string") return null;

  if (typeof content === "string") {
    return content.slice(0, maxLength);
  }
  if (Array.isArray(content)) {
    const text = (content as TextContent[])
      .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return text.length > 0 ? text.slice(0, maxLength) : null;
  }
  return null;
}
