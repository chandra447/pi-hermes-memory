/**
 * Abstract base class for pluggable memory providers.
 *
 * Faithful port of Hermes's `agent/memory_provider.py`. The lifecycle, driven by
 * the host (MemoryManager in Hermes, the extension host here) is:
 *   initialize -> system_prompt_block / prefetch / sync_turn per turn -> tool
 *   dispatch -> shutdown, plus optional `on_*` hooks.
 *
 * Only `name`, `is_available`, `initialize`, and `get_tool_schemas` are abstract;
 * everything else has a permissive default so a provider opts in by overriding.
 */

/** What the last prefetch injected, for a deterministic recall indicator. */
export interface RecallStatus {
  /** Provider label. */
  providerLabel: string;
  /** Number of injected entries (0 = a synthesized/generic count). */
  count: number;
  /** Glyph for the recall indicator. */
  glyph: string;
}

/** OpenAI function-calling schema. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Prompts with no semantic signal; single source of truth for the core prefetch
 * gate. Anchored and followed only by whitespace/punctuation, so "k8s"/"yolo"/
 * "note" do NOT match while "hi!"/"thanks :)"/"done???" do.
 */
export const TRIVIAL_PROMPT_RE =
  /^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k)[\s!?::;,"'~\u2018\u2019\u201c\u201d\u2014\u2013\u2026()\[\]{}<>*&^%$#@!+=`\u00a0]*$/i;

/** True for empty input, slash commands and bare greetings/acknowledgements. */
export function isTrivialPrompt(text: string | null | undefined): boolean {
  const stripped = (text ?? "").trim();
  if (!stripped || stripped.startsWith("/")) return true;
  return TRIVIAL_PROMPT_RE.test(stripped);
}

/** Providers that durably checkpoint every successful `on_pre_compress()` set this. */
export const PRE_COMPRESS_CHECKPOINT_API_VERSION = 2;

/** Default glyph for recall indicators; providers may use their own brand mark. */
export const INDICATOR_GLYPH = "\u{1F9E0}"; // 🧠

export abstract class MemoryProvider {
  /** See {@link PRE_COMPRESS_CHECKPOINT_API_VERSION}; 1 = best-effort legacy. */
  precompressCheckpointApiVersion = 1;

  /** Short identifier for this provider (e.g. 'holographic'). */
  abstract get name(): string;

  /** Configured, credentialed and ready? Gates activation; check config/deps only, no network. */
  abstract isAvailable(): boolean;

  /** Initialize once at agent startup (connections, resources, threads). */
  abstract initialize(sessionId: string, config?: Record<string, unknown>): void;

  /** User-facing hint for the "provider unavailable" warning. */
  unavailableReason(): string {
    return "";
  }

  /** STATIC system-prompt text; "" to skip. Recalled context goes through `prefetch`, not here. */
  systemPromptBlock(): string {
    return "";
  }

  /** Formatted recall context for the upcoming turn ("" if none). Must be fast. */
  prefetch(query: string, sessionId = ""): string {
    return "";
  }

  /** Queue a background recall after each turn; `prefetch` consumes it next turn. */
  queuePrefetch(_query: string, _sessionId = ""): void {}

  /** What the most recent `prefetch` injected (`null` = no indicator). */
  recallStatus(): RecallStatus | null {
    return null;
  }

  /** Persist a completed turn (non-blocking). */
  syncTurn(
    _userContent: string,
    _assistantContent: string,
    _sessionId = "",
    _messages?: Array<Record<string, unknown>>,
    _turnAuthor?: Record<string, unknown>,
  ): void {}

  /** OpenAI function-calling schemas ({"name", "description", "parameters"}); [] if none. */
  abstract getToolSchemas(): ToolSchema[];

  /** Handle one of this provider's tools; must return a JSON string. */
  handleToolCall(toolName: string, _args: Record<string, unknown>): string {
    throw new Error(`Provider ${this.name} does not handle tool ${toolName}`);
  }

  /** Clean shutdown — flush queues, close connections. */
  shutdown(): void {}

  // -- Optional hooks (override to opt in) ---------------------------------

  onTurnStart(_turnNumber: number, _message: string, _kwargs?: Record<string, unknown>): void {}

  /** Identity-mapping values that must bust a cached gateway agent when they change. */
  identitySignature(): Record<string, unknown> {
    return {};
  }

  /** End-of-session extraction; fires only at real session boundaries, never per-turn. */
  onSessionEnd(_messages: Array<Record<string, unknown>>): void {}

  /** session_id reassigned mid-process: rebind per-session state. */
  onSessionSwitch(
    _newSessionId: string,
    _opts: { parentId?: string; reset?: boolean; rewound?: boolean } = {},
  ): void {}

  /** Extract insights from messages about to be compressed, fed into the summary prompt. */
  onPreCompression(_messages: Array<Record<string, unknown>>): string {
    return "";
  }

  /** PARENT-side observation of a completed delegation. */
  onDelegation(_task: string, _result: string, _opts: { childSessionId?: string } = {}): void {}

  /** Setup fields for provider config ([] if none). */
  getConfigSchema(): Array<Record<string, unknown>> {
    return [];
  }

  /** Write non-secret setup values to the provider's native config. */
  saveConfig(_values: Record<string, unknown>, _home: string): void {}

  /** Mirror a built-in memory-tool write (`action`: add|replace|remove; `target`: memory|user). */
  onMemoryWrite(_action: "add" | "replace" | "remove", _target: string, _content: string): void {}

  /** Absolute paths of provider state outside the home dir for backup. */
  backupPaths(): string[] {
    return [];
  }
}
