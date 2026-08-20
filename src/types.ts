/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

import type { TextContent } from "@earendil-works/pi-ai";

export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict";

export type SessionSearchVariant = "legacy" | "anchors";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ReviewTransport = "direct" | "subprocess";

export interface SessionSearchConfig {
  /** Session search implementation variant. Default: legacy */
  variant: SessionSearchVariant;
}

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
  /** How background review invokes the LLM. Default: direct */
  reviewTransport?: ReviewTransport;
  /** Flush memories before compaction. Default: true */
  flushOnCompact: boolean;
  /** Flush memories on session shutdown. Default: true */
  flushOnShutdown: boolean;
  /** Minimum user turns before flush triggers. Default: 6 */
  flushMinTurns: number;
  /** Recent conversation messages included in session flush. 0 = all. Default: 0 */
  flushRecentMessages?: number;
  /** Override extension storage directory. Default: ~/.pi/agent/pi-hermes-memory */
  memoryDir?: string;
  /** Directory for project-scoped memory (relative to ~/.pi/agent). Default: "projects-memory" */
  projectsMemoryDir?: string;
  /** Session search configuration. Default: { variant: "legacy" } */
  sessionSearch?: SessionSearchConfig;
  /** Override model used for child pi -p subprocess LLM calls. Default: unset */
  llmModelOverride?: string;
  /** Override thinking level used for child pi -p subprocess LLM calls. Default: unset */
  llmThinkingOverride?: ThinkingLevel;
  /** Trusted Pi extension sources required by child processes, such as custom providers or auth adapters. */
  childExtensionPaths?: string[];
  /** Strategy when memory is full. Default: auto-consolidate */
  memoryOverflowStrategy?: MemoryOverflowStrategy;
  /** Wall-clock grace after overflow before automatic consolidation. Default: 180000 */
  overflowGraceMs?: number;
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
  /** Maximum time in milliseconds for a consolidation run, auto or manual. Default: 180000 */
  consolidationTimeoutMs: number;
  /** Log failed auto-consolidation attempts to the session console. Default: true */
  autoConsolidationWarnOnFailure: boolean;
  /** Inject pinned STANDING.md instructions into every session. Default: true */
  standingInstructionsEnabled: boolean;
}

export type MemoryCategory =
  | "failure"
  | "correction"
  | "insight"
  | "preference"
  | "convention"
  | "tool-quirk";

export interface SqliteMemoryRemoveOptions {
  target: "memory" | "user" | "failure" | "project";
  project?: string | null;
}

export interface SqliteMemoryReplaceOptions {
  target: "memory" | "user" | "failure" | "project";
  project?: string | null;
  category?: MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  lastReferenced?: string | null;
}

export interface ValidatedCorrectionResult {
  hasActionableCorrection: boolean;
  directive: string;
  category: MemoryCategory;
  failureReason: string;
}

export interface CorrectionCandidate {
  rawText: string;
  matchedPattern: string;
  extractedDirective: string;
  timestamp: number;
  validated: boolean;
  validationReason?: string;
}

export interface CorrectionDetectionResult {
  isCandidate: boolean;
  matchedPattern?: string;
  directiveText?: string;
}

export interface SessionContextMetadata {
  sessionId: string;
  cwd: string;
  /** True if the session was spawned as an ephemeral sub-agent or worker */
  isSubagent: boolean;
  /** Parent session ID if this session was launched by another agent */
  parentSessionId?: string | null;
  /** Execution purpose or subagent type */
  subagentType?: string | null;
}

export interface SubagentSessionDetector {
  /**
   * Determine if the current execution context represents an ephemeral subagent.
   * Checks sessionManager entries, process environment flags, and caller metadata.
   */
  isSubagentSession(ctx: unknown): boolean;
}

export interface IndexedSessionRecord {
  id: string;
  project: string | null;
  path: string;
  isSubagent: boolean;
}

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
  /** Targets that contain old_text when a replace/remove was sent to the wrong one. */
  matching_targets?: Array<"memory" | "user" | "failure" | "project">;
}

export interface MemoryMutationOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  oldText?: string;
  category?: MemoryCategory;
  failureReason?: string;
  project?: string;
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
  /**
   * Set when another session already holds the consolidation lock for this
   * target. Nothing is broken — the work is happening elsewhere — so callers
   * should tell the user to retry rather than report a failed consolidation.
   */
  deferred?: boolean;
}

export type SkillScope = "global" | "project";

export interface SkillIndex {
  /** Stable id for read/update/delete operations */
  skillId: string;
  /** Whether the skill is global or project-scoped */
  scope: SkillScope;
  /** File name on disk (usually SKILL.md) */
  fileName: string;
  /** Absolute path to the skill file */
  path: string;
  /** Active project name for project-scoped skills */
  projectName?: string;
  /** Pi skill slug stored in frontmatter and folder name */
  name: string;
  /** Optional human-friendly title preserved for UI output */
  displayName?: string;
  /** Short description shown in skill listings */
  description: string;
  /** ISO date created */
  created: string;
  /** ISO date last updated */
  updated: string;
}

export interface SkillDocument extends SkillIndex {
  /** Full markdown body (after frontmatter) */
  body: string;
  /** Version number */
  version: number;
}

export interface SkillResult {
  success: boolean;
  error?: string;
  message?: string;
  fileName?: string;
  skillId?: string;
  scope?: SkillScope;
  path?: string;
  conflictType?: "duplicate" | "similar" | "name-collision" | "scope-conflict";
  similarSkillIds?: string[];
  suggestedAction?: "patch" | "update" | "rename";
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
