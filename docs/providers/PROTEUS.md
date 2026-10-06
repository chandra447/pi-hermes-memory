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

## Proteus interface (TS)

Adapted from Hermes's `agent/memory_provider.py` `MemoryProvider` ABC to Pi's
tool/context conventions. Abstract members a provider must implement:

- `name: string`
- `isAvailable(): boolean` — config/deps only, no network
- `initialize(params): void` — open the DB, build store + retriever
- `getToolSchemas(): ToolSchema[]` — OpenAI function-calling schemas
- `handleToolCall(toolName, args): string` — return JSON

Optional (override to opt in):

- `systemPromptBlock(): string` — static injection ("# Holographic Memory …")
- `prefetch(query, params?): string` — formatted recall for the next turn
- `onMemoryWrite(action, target, content): void` — mirror built-in writes as facts
- `shutdown(): void` — close the shared connection

## Scope

| Phase | Deliverable |
|---|---|
| 0 | Proteus types (`types.ts`) + design doc |
| 1 | HRR math port (SHA-256 atoms, bind/unbind/bundle/similarity, blob (de)ser) |
| 2 | Holographic store port: SQLite schema + FTS5 + trust + N-gram dedup + entities + relationship graph + time decay |
| 3 | Holographic provider: tools (`fact_store`, `fact_feedback`), system block, prefetch |
| 4 | Wiring: provider registry + config (`db_path`, `default_trust`, `hrr_dim`) |
| 5 | Tests (store, HRR, provider, config) |

The store port is direction-independent (Phase 0–2), so it is built and tested
first; wiring (Phase 4) is the only part that depends on the integration model.
