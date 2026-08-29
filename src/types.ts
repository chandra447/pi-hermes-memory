/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

import type { ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";

export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict";

export type SessionSearchVariant = "legacy" | "anchors";

export type ThinkingLevel = ModelThinkingLevel;

export type ReviewTransport = "direct" | "subprocess";
