/**
 * Holographic memory provider (structured facts, entity resolution, trust
 * scoring, HRR retrieval). Faithful port of Hermes's
 * `plugins/memory/holographic/__init__.py` `HolographicMemoryProvider`.
 *
 * Adaptations from the Hermes plugin:
 *  - Config is passed in via the constructor (the host wires it), rather than
 *    reading `hermes_cli.config` at construction.
 *  - The dashboard `save_config` writer (Hermes core) is not ported; config is
 *    read-only here.
 *  - `on_session_end` keeps the truthy-extract gate and the extraction patterns,
 *    but drops the compaction-handoff machinery (Hermes-core, `context_compressor`).
 *  - Tool/command registration goes through the host's `registerTool` idiom
 *    (Phase 4 wiring), not Hermes's `ctx.register_memory_provider`.
 */

import { MemoryStore } from "./store.js";
import { FactRetriever } from "./retrieval.js";
import { MemoryProvider, type ToolSchema } from "./memory-provider.js";
import { cleanHit } from "../mneme/clean-hit.js";
import type { ProviderSearchHit, ProviderSearchOptions } from "../mneme/clean-hit.js";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

export interface HolographicConfig {
  db_path?: string;
  auto_extract?: boolean | string;
  default_trust?: number | string;
  min_trust_threshold?: number | string;
  temporal_decay_half_life?: number | string;
  hrr_dim?: number | string;
  hrr_weight?: number | string;
}

export interface ToolResult {
  [key: string]: unknown;
  count: number;
}

// The Holographic tool schemas were plain OpenAI-style JSON in Hermes; Pi's
// `registerTool` wants a TypeBox `TSchema` for its `parameters`, so these are
// expressed with TypeBox. Required-ness is positional: a property is required
// unless wrapped in `Type.Optional()`, so only `action` (and, for feedback, the
// `fact_id`) is required — mirroring the original `required` arrays.
const FACT_STORE_PARAMETERS: TSchema = Type.Object({
  action: StringEnum(
    ["add", "search", "probe", "related", "reason", "contradict", "update", "remove", "list"] as const,
  ),
  content: Type.Optional(Type.String({ description: "Fact content (required for 'add')."})),
  query: Type.Optional(Type.String({ description: "Search query (required for 'search')."})),
  entity: Type.Optional(Type.String({ description: "Entity name for 'probe'/'related'."})),
  entities: Type.Optional(Type.Array(Type.String({ description: "Entity names for 'reason'."}))),
  fact_id: Type.Optional(Type.Number({ description: "Fact ID for 'update'/'remove'."})),
  category: Type.Optional(StringEnum(["user_pref", "project", "tool", "general"] as const)),
  tags: Type.Optional(Type.String({ description: "Comma-separated tags."})),
  trust_delta: Type.Optional(Type.Number({ description: "Trust adjustment for 'update'."})),
  min_trust: Type.Optional(Type.Number({ description: "Minimum trust filter (default: 0.3)."})),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 10)."})),
});

export const FACT_STORE_SCHEMA: ToolSchema = {
  name: "fact_store",
  description:
    "Deep structured memory with algebraic reasoning. Use alongside the memory tool — memory for always-on " +
    "context, fact_store for deep recall and compositional queries.\n\nACTIONS (simple → powerful):\n" +
    "• add — Store a fact the user would expect you to remember.\n• search — Keyword lookup ('editor config', 'deploy process').\n" +
    "• probe — Entity recall: ALL facts about a person/thing.\n• related — What connects to an entity? Structural adjacency.\n" +
    "• reason — Compositional: facts connected to MULTIPLE entities simultaneously.\n" +
    "• contradict — Memory hygiene: find facts making conflicting claims.\n• update/remove/list — CRUD operations.\n\n" +
    "IMPORTANT: Before answering questions about the user, ALWAYS probe or reason first.",
  parameters: FACT_STORE_PARAMETERS,
};

const FACT_FEEDBACK_PARAMETERS: TSchema = Type.Object({
  action: StringEnum(["helpful", "unhelpful"] as const),
  fact_id: Type.Number({ description: "The fact ID to rate."}),
});

export const FACT_FEEDBACK_SCHEMA: ToolSchema = {
  name: "fact_feedback",
  description: "Rate a fact after using it. Mark 'helpful' if accurate, 'unhelpful' if outdated. This trains the memory — good facts rise, bad facts sink.",
  parameters: FACT_FEEDBACK_PARAMETERS,
};

// Auto-extraction patterns: (patterns, category). User preferences -> user_pref,
// decisions -> project.
interface ExtractPattern {
  regex: RegExp;
  category: string;
}
const EXTRACT_PATTERNS: ExtractPattern[] = [
  {regex: /\bI\s+(?:prefer|like|love|use|want|need)\s+(.+)/i, category: "user_pref"},
  {regex: /\bmy\s+(?:favorite|preferred|default)\s+\w+\s+is\s+(.+)/i, category: "user_pref"},
  {regex: /\bI\s+(?:always|never|usually)\s+(.+)/i, category: "user_pref"},
  {regex: /\bwe\s+(?:decided|agreed|chose)\s+(?:to\s+)?(.+)/i, category: "project"},
  {regex: /\bthe\s+project\s+(?:uses|needs|requires)\s+(.+)/i, category: "project"},
];

/** Coerce the `auto_extract` config (a string enum in Hermes) into a boolean. */
export function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "t" || v === "y";
  }
  return Boolean(value);
}

export class HolographicMemoryProvider extends MemoryProvider {
  private readonly config: HolographicConfig;
  private readonly minTrust: number;
  private _store?: MemoryStore;
  private _retriever?: FactRetriever;
  private sessionId = "";

  constructor(config: HolographicConfig | null | undefined = undefined) {
    super();
    this.config = config ?? {};
    this.minTrust = parseFloat((this.config.min_trust_threshold ?? "0.3") as string);
  }

  override get name(): string {
    return "holographic";
  }

  override isAvailable(): boolean {
    // SQLite is always available; numpy is optional (pure-math in TS).
    return true;
  }

  override initialize(sessionId: string, config?: HolographicConfig): void {
    const cfg = config ?? this.config;
    const dbPath = (cfg.db_path ?? "").replace(/\$\{?HERMES_HOME\}?/g, this.homeDir());
    const hrrDim = parseInt((cfg.hrr_dim ?? "1024") as string, 10);
    this._store = new MemoryStore(dbPath, parseFloat((cfg.default_trust ?? "0.5") as string), hrrDim);
    this._retriever = new FactRetriever(
      this._store,
      parseInt((cfg.temporal_decay_half_life ?? "0") as string, 10),
      0.4,
      0.3,
      parseFloat((cfg.hrr_weight ?? "0.3") as string),
      hrrDim,
    );
    this.sessionId = sessionId;
  }

  private homeDir(): string {
    return (process.env.HERMES_HOME ?? process.env.HOME ?? ".").replace(/\/$/, "");
  }

  /** Guard access to the store; handlers throw a clear error before initialization. */
  private get store(): MemoryStore {
    if (!this._store) throw new Error("Holographic provider not initialized");
    return this._store;
  }

  private get retriever(): FactRetriever {
    if (!this._retriever) throw new Error("Holographic provider not initialized");
    return this._retriever;
  }

  override getConfigSchema(): Array<Record<string, unknown>> {
    return [
      {key: "db_path", description: "SQLite database path", default: "$HERMES_HOME/memory_store.db"},
      {key: "auto_extract", description: "Auto-extract facts at session end", default: "false", choices: ["true", "false"]},
      {key: "default_trust", description: "Default trust score for new facts", default: "0.5"},
      {key: "hrr_dim", description: "HRR vector dimensions", default: "1024"},
    ];
  }

  override systemPromptBlock(): string {
    if (!this._store) return "";
    let total = 0;
    try {
      total = Number(this.store.queryOne<{c: number}>("SELECT COUNT(*) AS c FROM facts")?.c ?? 0);
    } catch {
      total = 0;
    }
    const body =
      total === 0
        ? "Active. Empty fact store — proactively add facts the user would expect you to remember.\nUse fact_store(action='add') to store durable structured facts about people, projects, preferences, decisions.\n"
        : `Active. ${total} facts stored with entity resolution and trust scoring.\nUse fact_store to search, probe entities, reason across entities, or add facts.\n`;
    return "# Holographic Memory\n" + body + "Use fact_feedback to rate facts after using them (trains trust scores).";
  }

  override prefetch(query: string, _sessionId = ""): string {
    if (!this._retriever || !query) return "";
    try {
      // Clean recall only: gate by scope/recency/source-of-truth (the Mneme layer).
      const { hits } = cleanHit(this, query, { limit: 5 });
      const lines = hits.map((h) => `- [${(h.trust ?? 0).toFixed(1)}] ${h.content}`);
      return lines.length > 0 ? "## Holographic Memory\n" + lines.join("\n") : "";
    } catch (e) {
      console.debug(`Holographic prefetch failed: ${e}`);
      return "";
    }
  }

  /**
   * Raw recall, shaped for the Mneme clean-hit layer. Additive — the base
   * `MemoryProvider` is left untouched. Maps `FactRetriever.search` rows onto
   * `ProviderSearchHit`; the Mneme layer applies scope/recency/source-of-truth.
   */
  recall(query: string, options: ProviderSearchOptions = {}): ProviderSearchHit[] {
    if (!this._retriever) throw new Error("Holographic provider not initialized");
    const rows = this.retriever.search(
      query,
      options.category,
      this.minTrust,
      options.limit ?? 10,
    );
    return rows.map((r) => ({
      id: String(r.fact_id),
      content: String(r.content),
      trust: typeof r.trust_score === "number" ? r.trust_score : undefined,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      category: typeof r.category === "string" ? r.category : undefined,
      raw_match: r,
    }));
  }

  override getToolSchemas(): ToolSchema[] {
    return [FACT_STORE_SCHEMA, FACT_FEEDBACK_SCHEMA];
  }

  override handleToolCall(toolName: string, args: Record<string, unknown>): string {
    if (toolName !== "fact_store" && toolName !== "fact_feedback") {
      return this.toolError(`Unknown tool: ${toolName}`);
    }
    try {
      if (toolName === "fact_store") return this.dispatchFactStore(args);
      return this.dispatchFactFeedback(args);
    } catch (e) {
      if (e instanceof TypeError) return this.toolError(`Missing required argument: ${e.message}`);
      return this.toolError(String(e));
    }
  }

  private dispatchFactStore(a: Record<string, unknown>): string {
    switch (a.action) {
      case "add": {
        const fact_id = this.store.addFact(String(a.content), this.str(a, "category", "general"), this.str(a, "tags", ""));
        return JSON.stringify({fact_id, status: "added"});
      }
      case "search":
        return this.results(
          this.retriever.search(String(a.query), this.cat(a), this.minTrustA(a, this.minTrust), this.limit(a)),
        );
      case "probe":
        return this.entityQuery("probe", a);
      case "related":
        return this.entityQuery("related", a);
      case "reason":
        if (!a.entities) throw new Error("reason requires 'entities' list");
        return this.results(this.retriever.reason(this.ents(a), this.cat(a), this.limit(a)));
      case "contradict":
        return this.results(this.retriever.contradict(this.cat(a), undefined, this.limit(a)));
      case "update":
        return JSON.stringify({
          updated: this.store.updateFact(
            parseInt(String(a.fact_id), 10),
            a.content !== undefined ? String(a.content) : undefined,
            "trust_delta" in a && a.trust_delta !== undefined ? parseFloat(String(a.trust_delta)) : undefined,
            a.tags !== undefined ? String(a.tags) : undefined,
            a.category !== undefined ? String(a.category) : undefined,
          ),
        });
      case "remove":
        return JSON.stringify({removed: this.store.removeFact(parseInt(String(a.fact_id), 10))});
      case "list":
        return this.results(this.store.listFacts(this.cat(a), this.minTrustA(a, 0.0), this.limit(a)), "facts");
      default:
        throw new Error(`Unknown action: ${String(a.action)}`);
    }
  }

  private dispatchFactFeedback(a: Record<string, unknown>): string {
    return JSON.stringify(
      this.store.recordFeedback(
        parseInt(String(a.fact_id), 10),
        String(a.action) === "helpful",
      ),
    );
  }

  private entityQuery(method: string, a: Record<string, unknown>): string {
    return this.results(
      method === "probe"
        ? this.retriever.probe(String(a.entity), this.cat(a), this.limit(a))
        : this.retriever.related(String(a.entity), this.cat(a), this.limit(a)),
    );
  }

  // --- small helpers mirroring the Python handlers' coercions ---

  private results(items: unknown[], key = "results"): string {
    return JSON.stringify({key, items, count: items.length});
  }

  private toolError(message: string): string {
    return JSON.stringify({error: message});
  }

  private str(a: Record<string, unknown>, field: string, fallback: string): string {
    return a[field] !== undefined && a[field] !== null ? String(a[field]) : fallback;
  }

  private limit(a: Record<string, unknown>): number {
    return parseInt(this.str(a, "limit", "10"), 10);
  }

  private minTrustA(a: Record<string, unknown>, fallback: number): number {
    return parseFloat(this.str(a, "min_trust", String(fallback)));
  }

  private cat(a: Record<string, unknown>): string | undefined {
    return a.category !== undefined && a.category !== null ? String(a.category) : undefined;
  }

  private ents(a: Record<string, unknown>): string[] {
    const v = a.entities;
    if (!Array.isArray(v)) throw new Error("reason requires 'entities' list");
    return v.map((e) => String(e));
  }

  override onMemoryWrite(action: "add" | "replace" | "remove", target: string, content: string): void {
    // Mirror built-in memory writes as facts.
    if (action === "add" && this._store && content) {
      try {
        this.store.addFact(content, target === "user" ? "user_pref" : "general");
      } catch (e) {
        console.debug(`Holographic memory_write mirror failed: ${e}`);
      }
    }
  }

  override onSessionEnd(messages: Array<Record<string, unknown>>): void {
    // is_truthy: auto_extract is a string enum ("false"/"true"); plain truthiness
    // would treat "false" as on.
    if (!isTruthy(this.config.auto_extract) || !this._store || !messages) return;
    const extracted = this.autoExtractFacts(messages);
    if (extracted) console.debug(`Holographic auto-extracted ${extracted} facts from conversation`);
  }

  private autoExtractFacts(messages: Array<Record<string, unknown>>): number {
    let extracted = 0;
    for (const msg of messages) {
      if (!msg || msg.role !== "user") continue;
      const content = (msg as {content?: unknown}).content;
      if (typeof content !== "string" || content.length < 10) continue;
      for (const {regex, category} of EXTRACT_PATTERNS) {
        const m = content.match(regex);
        if (m) {
          try {
            this.store.addFact(m[1].slice(0, 400), category);
            extracted++;
          } catch {
            /* ignore extraction failures */
          }
        }
      }
    }
    return extracted;
  }

  override shutdown(): void {
    // Close the connection; Node is single-threaded so no thread join is needed.
    if (this._store) {
      try {
        this._store.close();
      } catch (e) {
        console.debug(`Holographic shutdown close() failed: ${e}`);
      }
    }
    this._store = undefined;
    this._retriever = undefined;
  }
}

