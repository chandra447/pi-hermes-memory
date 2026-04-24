/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

import type { TextContent } from "@mariozechner/pi-ai";

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
  /** Override memory directory. Default: ~/.pi/agent/memory */
  memoryDir?: string;
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
