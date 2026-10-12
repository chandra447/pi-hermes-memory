# Mneme — pluggable additional memory providers

> Port Holographic (Hermes's first-party local memory provider) into
> pi-hermes-memory behind a `MemoryProvider` interface, keeping the existing
> `MemoryStore` public API untouched.

## Goal

Enable a wider range of memory providers than pi-hermes-memory ships today,
starting with **Holographic** — a local, SQLite-backed, trust-scorified,
compositional (HRR) fact store that the article *"I tested Hermes' third-party
memory providers"* found to be **local, fast, and clean** (passed every negative
control / privacy test).

## Why Holographic (v1)

From the enterprise-memory benchmark (36 hard questions):

| Provider | useful recall | bad/stale/forbidden hits |
|---|---|---|
| Holographic | 21/27 | **0** |
| RetainDB | 25/27 | 0 |
| Mem0 | 31/36 | 20/36 |
| Supermemory | 34/36 | 19/36 |
| OpenViking | 36/36 | 20/36 |
| SQLite FTS (builtin) | 36/36 | 19/36 |

Holographic is the only high-recall system that also stayed clean: local
SQLite + FTS5, trust scoring, N-gram Jaccard dedup, entity resolution,
relationship graph, Ebbinghaus time decay, privacy regexes — and **no external
dependencies** (NumPy is optional for the HRR algebra).

## Integration model (decision)

**Holographic is an *additional* provider, not a replacement for the file store.**

pi-hermes-memory's `MemoryStore` (MEMORY.md/USER.md/FAILURE.md, consolidation,
mutation locking) is a rich, working, *different* memory model. Hermes ships
Holographic as a **coexisting** provider — the agent uses both the built-in
`memory` tool and the `fact_store` tool. So we do the same: Holographic registers
its own tools + a recall block + lifecycle, and the existing `MemoryStore` keeps
doing exactly what it does.

Concretely, **Mneme** is the pluggable layer that loads providers and drives them
through the lifecycle:

```
initialize → systemPromptBlock/prefetch → tool dispatch → shutdown
```

This is the least invasive wiring: `MemoryStore` and its consolidation/locking
stay untouched. Swapping the model later (making the file store *implement*
the `MemoryProvider` base and become the default provider) is a separate refactor
— noted, not done.

### Two contract layers

Mneme sits on top of the provider contract in two layers:

1. **`MemoryProvider` — the Pi-convention base.** The host (the extension,
   mirroring Hermes's `MemoryManager`) drives it. This is the faithful port of
   Hermes's `agent/memory_provider.py` `MemoryProvider` ABC. What the host calls:

   - `get name(): string` — stable, provider-unique id (e.g. `"holographic"`)
   - `isAvailable(): boolean` — config/deps only, no network (sync)
   - `initialize(sessionId, config?)` — connections/resources per startup
   - `getToolSchemas(): ToolSchema[]` + `handleToolCall(name, args): string` —
     OpenAI function-calling dispatch; every tool returns a JSON string
   - `shutdown(): void` — flush queues, close connections
   - lifecycle hooks (opt in by overriding): `onTurnStart`, `onSessionEnd`
     (real session boundaries only), `onPreCompression` (feeds the summary
     prompt), `onSessionSwitch`, `onDelegation`
   - recall: `systemPromptBlock(): string`, `prefetch(query, sessionId): string`,
     `syncTurn(...): void`, `recallStatus(): RecallStatus | null`
   - `onMemoryWrite(action, target, content): void` — mirror built-in writes as
     facts (add|replace|remove; target memory|user)
   - static helpers: `getConfigSchema()`, `saveConfig()`, `backupPaths()`,
     `unavailableReason()`

   Only `name`, `isAvailable`, `initialize`, and `getToolSchemas` are abstract;
   everything else has a permissive default so a provider opts in by overriding.
   The base is generic — subclasses carry the specifics
   (`HolographicMemoryProvider`), so its name is intentionally not a capability
   hint. This base is **the frozen public interface**: `MemoryConfig`,
   `MemoryResult`, and `MemoryMutationOperation` are untouched.

2. **The Mneme layer — the clean-hit + registry + opt-in contract.** Built in a
   separate module (`src/providers/mneme/`) so providers don't subclass the
   extension: a registry that classifies providers (`is_local`/`is_bidirectional`),
   the `cleanHit` gating pipeline (the headline operation below), and the config
   surface that selects which providers load. This is the only layer that is
   Mneme-specific.

## "Clean hit" is the first-class operation

This is the point of the whole extension, and it is what the benchmark proves.
The article's headline finding is **raw recall ≠ useful recall**: Mem0/Supermemory
have higher recall but leak 19–20 stale/forbidden hits per 36 questions; the
local providers (Holographic, RetainDB) score 0 bad hits. A "clean hit" is a
provider result that has passed **three gates before it is ever returned**:

1. **Scope** — the hit matches the requested `category`. Mneme standardizes on
   the six Hermes memory scopes as the **single canonical category vocabulary**:
   `failure | correction | insight | preference | convention | tool-quirk` — the
   same set the built-in `MemoryStore` already uses. The scope gate drops anything
   outside the requested scope (cross-category leakage): a personal query only
   returns personal-scoped facts. There is **no** per-provider category namespace
   and **no** mapping layer — every provider's facts carry one of these six, so
   `category` is typed as `MemoryCategory` here, not a free string.
2. **Recency** — the hit is not past its effective-decay cutoff. Age
   (`created_at`) drives relevance; last-edit (`updated_at`) drives re-validation
   — so both timestamps are **mandatory**, and the gate uses the **older of the
   two** (strictest): a fresh edit can't rescue a fact created long ago. Missing
   either fails closed — without both timestamps the gate can't prove freshness.
3. **Source of truth** — the hit survives the same `scanContent` write gate the
   local store uses (no injection/exfiltration/secret patterns). Retrieval does
   **not** just strip patterns from a match; it refuses the whole fact. This is
   why the built-in `MemoryStore` is the source of truth and providers are gated
   mirrors: anything that would fail a write never becomes a retrievable hit.

`cleanHit` lives in the Mneme layer and adapts a provider's *raw recall*:

```ts
export interface ProviderSearchOptions {
  limit?: number;
  // Canonical Mneme category — one of the six Hermes memory scopes
  // (failure | correction | insight | preference | convention | tool-quirk).
  // Undefined = no scope filter.
  category?: MemoryCategory;
  minRecencyAt?: string; // ISO timestamp
}
export interface ProviderSearchHit {
  id: string;            // e.g. fact_id
  content: string;
  trust?: number;        // from trust_score
  created_at: string;    // mandatory — age drives relevance
  updated_at: string;    // mandatory — last re-validation feeds the gate
  category?: MemoryCategory; // one of the six canonical memory scopes
  raw_match: Record<string, unknown>; // the full provider row
}
export interface ProviderSearchResult {
  hits: ProviderSearchHit[];
  raw_matches: number;   // how many rows were considered before gating
}

export function cleanHit(
  provider: { recall(query, options?): ProviderSearchHit[] },
  query: string,
  options: ProviderSearchOptions,
): ProviderSearchResult {
  const raw = provider.recall(query, options);          // provider's own recall
  const minTs = options.minRecencyAt ? Date.parse(options.minRecencyAt) : undefined;
  const hits = raw.filter(h => {
    if (options.category !== undefined && h.category !== options.category) return false; // gate 1: scope
    // gate 2: recency — no updated_at ⇒ cannot prove freshness ⇒ drop (fail closed).
    if (minTs !== undefined) {
      const ts = h.updated_at ? Date.parse(h.updated_at) : Number.NaN;
      if (Number.isNaN(ts) || ts < minTs) return false;
    }
    return !scanContent(h.content);                                              // gate 3: source of truth
  });
  return { hits, raw_matches: raw.length };
}
```

Holographic's own retrieval (`retrieval.ts`) already does this in spirit: FTS +
Jaccard + HRR rerank, then trust-scores and temporal decay prune the result
before it hits the system prompt. The port preserves that ordering. `cleanHit`
merges the explicit gates onto the interface so every future provider is held to
the same bar the article validated.

## Registry

```ts
export interface RegisteredProvider {
  id: string;            // provider name
  name: string;          // human label
  kind: "vector" | "document" | "hybrid";
  is_local: boolean;    // embedded, no external auth/server — the v1 bar
  is_bidirectional: boolean; // whether sync pulls from the provider or pushes only
  config?: Record<string, unknown>;
}

// allowNonLocal=false is the v1 default: non-local providers are rejected
// until an operator opts in. Also has has(id) and clear().
class MnemeRegistry(allowNonLocal = false) {
  register(provider: RegisteredProvider): void { /* rejects is_local:false unless opted in */ }
  get(id: string): RegisteredProvider | undefined; ...
  list(): RegisteredProvider[]; ...
}
```

The registry rejects a provider whose `is_local === false` unless an operator has
explicitly opted in (the v1 bar: **embedded, no external auth, no running
server**). `is_bidirectional` is the one sanctioned pull path (`sync({ pull })`) —
push-only v1 providers (`is_bidirectional: false`) only accept writes.

The provider's own `recall(query, options)` (additive, on the concrete
`HolographicMemoryProvider` — the base is left untouched) returns the raw rows
that `cleanHit` gates; the base's `prefetch`/`handleToolCall` continue to drive the
agent's normal recall path.

## Integration seams

Wiring reuses the existing Pi seams rather than inventing new ones:

- **Write gate is shared, not duplicated.** `scanContent` in
  `store/content-scanner.ts` is the single injection/exfiltration/secret gate and
  runs **before any provider**. A provider's writes mirror built-in writes through
  the same gate as a defense-in-depth second check — a fact that would fail a
  write never becomes a retrievable hit, so `cleanHit`'s source-of-truth gate is
  airtight.
- **Providers inject, they don't subclass the extension.** Tool/command
  registration goes through the existing `registerTool`/`registerCommand` idiom
  (`memory-initialization.ts`), exactly as Holographic's `fact_store`/
  `fact_feedback` register. The local `MemoryStore` and its consolidation/
  mutation locking stay untouched.
- **Config.** `mneme?: { enabled: boolean; providers?: string[]; db_path?:
  string; default_trust?: number; min_trust_threshold?: number;
  temporal_decay_half_life?: number; hrr_dim?: number; hrr_weight?: number }` in
  `config.ts`, plus `mneme.providers?: string[]` to select which registered
  providers load. Default: **disabled until opted in** (`mneme.enabled`).
- **Source-of-truth discipline.** The built-in `MemoryStore` is the local source
  of truth. On a write, the provider's `onMemoryWrite` mirrors the fact into the
  store (push-only for v1); `sync({ pull })` is the one sanctioned pull path,
  gated by `is_bidirectional`. Local memory never depends on a provider being up.
- **Frozen public interface.** `MemoryConfig`, `MemoryResult`, and
  `MemoryMutationOperation` are untouched; Mneme lives in the extension's own
  namespace (`src/providers/mneme/`) and never changes their shapes.

## Holographic (v1) concretization

Holographic maps onto Mneme directly: its `store.ts` port is the local SQLite
source of truth (`is_local: true`); `add` = `addFact`, `recall` = FTS+Jaccard+HRR
rerank, `cleanHit` = that pipeline plus the three gates above, `remove` =
`removeFact`; `sync` = `db_path`-backed copy (push-only for v1, so
`is_bidirectional: false`). Config keys mirror the plugin's `plugin.yaml`
(`db_path`, `default_trust`, `min_trust_threshold`, `temporal_decay_half_life`,
`hrr_dim`, `hrr_weight`). Its tools (`fact_store`, `fact_feedback`) register via
the `registerTool` idiom.

Its facts carry a `category`, now **one of the six canonical memory scopes**
rather than Hermes's older `user_pref`/`project`/`tool`/`general` set — Mneme
standardizes on the memory-scope vocabulary everywhere, so no provider owns a
private category namespace and no mapping layer is needed. A provider tags a fact
with whatever scope fits (a user preference lands as `preference`, a project
decision as `convention`, a tool quirk as `tool-quirk`, …).

## Scope

| Phase | Deliverable |
|---|---|
| 0 | Mneme types + **clean-hit** design + integration-seam map (this doc) |
| 1 | HRR math port (SHA-256 atoms, bind/unbind/bundle/similarity, blob (de)ser) | ✅ `4c53fb3` |
| 2 | Holographic store port: SQLite schema + FTS5 + trust + N-gram dedup + entities + relationship graph + time decay | ✅ `ecd60ff` (20/20 tests) |
| 3 | Holographic provider: tools (`fact_store`, `fact_feedback`), system block, prefetch, `onMemoryWrite` mirror — HRR + store already in place | ✅ `672033a` (built + tested) |
| 4 | Mneme layer: registry (is_local bar + is_bidirectional) + config (`mneme.enabled`/`mneme.providers`, `mneme.db_path`, `default_trust`, `hrr_dim`) + provider selection (`buildMneme`) + `cleanHit` gating (all 3 gates incl. `scanContent`) + store write-mirror hook | ✅ `9284b42` (built + tested) |
| 5 | Tests (registry, config, all three clean-hit gates incl. `scanContent` source-of-truth) | ✅ |
| 6 | Host wiring in `index.ts`: initialize each provider + append `systemPromptBlock`/prefetch per turn, fire the write-mirror, and register `fact_store`/`fact_feedback` | held — see below |

Phases 0–4 are done. The remaining seam (Phase 6) is **tool + command
registration**: Holographic's schemas are plain JSON schemas, but Pi's
`registerTool` takes a TypeBox `TSchema`, so the two Holographic tools need a
TypeBox conversion before they can register. That conversion is a small, isolated
follow-up; the layer it plugs into (registry, config, selection, clean-hit) is
complete and tested.

**Category vocabulary (design decision).** The category field across all of Mneme
is the six Hermes memory scopes — `failure | correction | insight | preference |
convention | tool-quirk` — not a provider-agnostic string. This collapses the
clean-hit layer's `category` to `MemoryCategory` and moves Holographic's fact
categories off Hermes's `user_pref`/`project`/`tool`/`general` set onto the same
six. It is enforced everywhere with a single vocabulary — no per-provider
namespace and no mapping/migration layer, which is cheap because the software is
unreleased (nothing persisted to migrate).
