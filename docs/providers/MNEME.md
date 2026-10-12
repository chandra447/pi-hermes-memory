# Proteus — pluggable memory providers

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

Concretely, **Proteus** is the `MemoryProvider` contract a provider implements;
`index.ts` loads registered providers and drives them through the lifecycle:

```
initialize → systemPromptBlock/prefetch → tool dispatch → shutdown
```

This is the least invasive wiring: `MemoryStore` and its consolidation/locking
stay untouched. Swapping the model later (making the file store *implement*
Proteus and become the default provider) is a separate refactor — noted, not done.

## "Clean hit" is the first-class operation

This is the point of the whole extension, and it is what the benchmark proves.
The article's headline finding is **raw recall ≠ useful recall**: Mem0/Supermemory
have higher recall but leak 19–20 stale/forbidden hits per 36 questions; the
local providers (Holographic, RetainDB) score 0 bad hits. A "clean hit" is a
provider result that has passed **three gates before it is ever returned**:

1. **Scope** — the hit matches the requested `category` (e.g. a personal query
   only returns personal-scoped facts; cross-category leakage is dropped).
2. **Recency** — the hit is not past its effective-decay cutoff. Holographic's
   Ebbinghaus time decay already ages trust toward 0.5; the gate drops facts
   whose `updated_at` is older than the configured half-life window.
3. **Source of truth** — the hit survives the same `scanContent` write gate the
   local store uses (no injection/exfiltration/secret patterns). Retrieval does
   **not** just strip patterns from a match; it refuses the whole fact. This is
   why the built-in `MemoryStore` is the source of truth and providers are gated
   mirrors: anything that would fail a write never becomes a retrievable hit.

A provider implements raw recall, then `cleanHit()` runs that pipeline:

```ts
async function cleanHit(provider, query, options): Promise<ProviderSearchResult> {
  const raw = await provider.search(query, options);       // provider's own recall
  const clean = raw.hits.filter(h =>
    h.category === options.category                       // gate 1: scope
      && h.updated_at > options.minRecencyAt               // gate 2: recency
      && !scanContent(h.content)                           // gate 3: source of truth
  );
  return { hits: clean, raw_matches: raw.hits.length };
}
```

Holographic's own retrieval (`retrieval.py`) already does this in spirit: FTS +
Jaccard + HRR rerank, then trust-scores and temporal decay prune the result
before it hits the system prompt. The port preserves that ordering. `cleanHit`
merges the explicit gates onto the interface so every future provider is held to
the same bar the article validated.

## Proteus interface (TS)

Adapted from Hermes's `agent/memory_provider.py` `MemoryProvider` ABC to Pi's
tool/context conventions. Abstract members a provider must implement:

- `id: string` — stable, provider-unique registration id
- `kind: "vector" | "document" | "hybrid"` — retrieval strategy shape
- `isAvailable(): Promise<boolean>` — config/deps only, no network
- `add(entries: string[]): Promise<void>` — mirror built-in writes
- `replace(content: string): Promise<void>` — full-store rewrite
- `remove(match: string | string[]): Promise<void>` — delete by text
- `snapshot(): Promise<MemorySnapshot>` — return every entry (consolidation)
- `search(query, options?): Promise<ProviderSearchResult>` — raw provider recall
- `cleanHit(query, options?): Promise<ProviderSearchResult>` — search gated by
  scope + recency + source-of-truth (the operation above)
- `sync(localEntries, options?): Promise<ProviderSyncResult>` — one direction per
  provider (see registry `is_bidirectional`)
- `close(signal?): Promise<void>` — close the connection

Result/options shapes:

```ts
interface ProviderSearchOptions { limit?: number; category?: MemoryCategory; minRecencyAt?: string; }
interface ProviderSearchHit { id: string; content: string; trust?: number; updated_at?: string; }
interface ProviderSearchResult { hits: ProviderSearchHit[]; raw_matches: number; }
interface ProviderSyncResult { synced: boolean; error?: string; added?: number; removed?: number; }
```

Abstract members a provider may opt into (override to enable):

- `systemPromptBlock(): string` — static injection ("# Holographic Memory …")
- `prefetch(query, params?): string` — formatted clean recall for the next turn
- `onMemoryWrite(action, target, content): void` — mirror built-in writes as facts
- `refresh?(signal?): Promise<void>` — periodic background sync
- `shutdown(): Promise<void>` — close the shared connection

## Registry

```ts
export interface RegisteredProvider {
  id: string;
  name: string;
  kind: "vector" | "document" | "hybrid";
  is_local: boolean;    // embedded, no external auth/server — the v1 bar
  is_bidirectional: boolean; // whether sync pulls from the provider or pushes only
}
export interface ProteusRegistry {
  register(provider: ProteusProvider): void;
  get(id: string): ProteusProvider | undefined;
  list(): RegisteredProvider[];
}
```

The registry rejects a provider whose `is_local === false` unless an operator has
explicitly opted in (the v1 bar: **embedded, no external auth, no running server**).

## Integration seams

Wiring reuses the existing Pi seams rather than inventing new ones:

- **Write gate is shared, not duplicated.** `scanContent` in `store/content-scanner.ts`
  is the single injection/exfiltration/secret gate and runs **before any provider**.
  A provider's `add`/`replace` mirrors built-in writes through the same gate as a
  defense-in-depth second check — a fact that would fail a write never becomes a
  retrievable hit, so `cleanHit`'s source-of-truth gate is airtight.
- **Providers inject, they don't subclass the extension.** Tool/command registration
  goes through the existing `registerTool`/`registerCommand` idiom
  (`memory-initialization.ts`), exactly as Holographic's `fact_store`/`fact_feedback`
  would register. The local `MemoryStore` and its consolidation/mutation locking
  stay untouched.
- **Config.** `proteus?: { enabled: boolean; db_path?: string; default_trust?:
  number; min_trust_threshold?: number; temporal_decay_half_life?: number; hrr_dim?:
  number; hrr_weight?: number }` in `config.ts`, plus `proteus.providers?: string[]`
  to select which registered providers load. Default: disabled until opted in.
- **Source-of-truth discipline.** The built-in `MemoryStore` is the local source of
  truth. On a write, the provider's `onMemoryWrite` mirrors the fact into the store
  (push-only for v1); `sync({ pull })` is the one sanctioned pull path, gated by
  `is_bidirectional`. Local memory never depends on a provider being up.
- **Frozen public interface.** `MemoryConfig`, `MemoryResult`, and
  `MemoryMutationOperation` are untouched; Proteus lives in the extension's own
  namespace and never changes their shapes.

## Holographic (v1) concretization

Holographic maps onto Proteus directly: its `store.ts` port is the local SQLite
source of truth (`is_local: true`); `add` = `addFact`, `search` = FTS+Jaccard+HRR
rerank, `cleanHit` = that pipeline plus the three gates above, `remove` = `removeFact`;
`snapshot` = all facts; `sync` = `db_path`-backed copy (push-only for v1, so
`is_bidirectional: false`). Config keys mirror the plugin's `plugin.yaml`
(`db_path`, `default_trust`, `min_trust_threshold`, `temporal_decay_half_life`,
`hrr_dim`, `hrr_weight`). Its tools (`fact_store`, `fact_feedback`) register via the
`registerTool` idiom. Phase 3 builds on the committed store (Phase 2).

## Scope

| Phase | Deliverable |
|---|---|
| 0 | Proteus types + **clean-hit** design + integration-seam map (this doc) |
| 1 | HRR math port (SHA-256 atoms, bind/unbind/bundle/similarity, blob (de)ser) | ✅ `4c53fb3` |
| 2 | Holographic store port: SQLite schema + FTS5 + trust + N-gram dedup + entities + relationship graph + time decay | ✅ `ecd60ff` (20/20 tests) |
| 3 | Holographic provider: tools (`fact_store`, `fact_feedback`), system block, prefetch — HRR + store already in place |
| 4 | Wiring: provider registry + config (`proteus.db_path`, `default_trust`, `hrr_dim`, provider selection) |
| 5 | Tests (store, HRR, provider, config) + clean-hit gating tests |

Phases 0â2 (this doc, HRR, store) are direction-independent and are done. Phase 3
builds on the committed store; Phase 4 wiring is the only part that depends on the
integration model and is the next thing to implement.
