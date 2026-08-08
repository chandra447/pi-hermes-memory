# v0.7 Tasks: Token-Aware Graph-Based Memory Retrieval

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done

## Epic 1: Stop Prompt Bloat

Done when full Markdown memory is no longer injected by default.

- [x] `src/types.ts` — add `memoryMode: "policy-only" | "legacy-inject"`
- [x] `src/config.ts` — parse `memoryMode` with `policy-only` default
- [x] `src/constants.ts` — add expanded `MEMORY_POLICY_PROMPT` with accepted targets/categories
- [x] `src/index.ts` — replace full memory block injection with memory policy by default
- [x] Legacy compatibility — support `memoryMode: "legacy-inject"` for old behavior
- [x] `/memory-preview-context` — show policy-only prompt in default mode and full blocks in legacy mode
- [x] Tests — system prompt contains policy only in retrieval mode
- [x] Tests — legacy mode still injects current blocks

## Epic 2: Memory Router

Future phase. Do not start until policy-only mode is shipped and measured.

- [ ] `src/handlers/memory-router.ts` — inspect user message, recent context, project, repo/tool/error signals
- [ ] Router rules — retrieve for prior-context phrases, repo tasks, failures, preferences, conventions
- [ ] Router rules — skip generic explanation and one-off examples
- [ ] Query builder — produce compact search query from message + signals
- [ ] Debug record — persist last router decision in memory for `/memory-debug-last`
- [ ] Tests — retrieve/skip decisions for representative coding and generic prompts

## Epic 3: Memory Ranking + Packing

Future phase. Depends on a working runtime injection hook and router.

- [ ] `src/store/memory-ranker.ts` — score candidates by FTS relevance, project match, category, recency, confidence
- [ ] `src/store/memory-eligibility.ts` — exclude wrong-scope, stale, superseded, low-confidence, and irrelevant memories
- [ ] `src/store/memory-pack.ts` — build `<retrieved-memory security="untrusted-context">` block
- [ ] Read-time scanner — run `scanContent()` or equivalent before injection
- [ ] Token estimate helper — approximate budget with chars/4 and hard cap
- [ ] Tests — ranking favors project corrections/failures/conventions
- [ ] Tests — packer respects `maxRetrievedTokens`

## Epic 4: Runtime Injection

Future phase. Do not start until the policy-only default proves insufficient.

- [ ] Identify GSD Pi hook/API for per-turn context injection or closest supported equivalent
- [ ] `src/index.ts` — wire router/search/ranker/packer into the selected hook
- [ ] No-memory path — inject nothing when router skips retrieval
- [ ] Retrieved-memory path — inject small block when router finds eligible memories
- [ ] Tests — no retrieved block for generic prompt
- [ ] Tests — retrieved block appears for project/debugging prompt

## Epic 5: SQLite Graph Tables

Done when graph relationships exist in SQLite and can boost retrieval.

- [ ] `src/store/schema.ts` — add `memory_nodes`, `memory_edges`, `memory_node_links`
- [ ] `src/store/memory-graph-store.ts` — CRUD for nodes, edges, memory links
- [ ] `src/store/memory-graph-extractor.ts` — extract project/file/tool/error/decision/failure entities from memory text
- [ ] Sync path — link new/updated memories to graph nodes
- [ ] Graph lookup — retrieve 1-2 hop related memory IDs for current turn signals
- [ ] Ranking integration — add `graph_distance_score`
- [ ] Tests — graph tables migrate cleanly
- [ ] Tests — graph-linked memory outranks unrelated FTS match

## Epic 6: Conflict + Staleness

Done when stale or conflicting memory is not blindly injected.

- [ ] Schema migration — add `confidence`, `status`, `supersedes_id`, `valid_from`, `valid_to`, `last_accessed_at`, `access_count`
- [ ] `src/store/memory-conflict-detector.ts` — mark superseded/conflicting memories where deterministic
- [ ] Update write path — support status/confidence updates
- [ ] Update search path — exclude `superseded` and expired rows by default
- [ ] Tests — superseded memory is not injected
- [ ] Tests — current project evidence wins over memory conflict

## Epic 7: Debug Commands

Done when users can see what memory did and why.

- [ ] `/memory-status` — mode, config, DB counts, prompt injection mode
- [ ] `/memory-debug-last` — router decision, query, candidates, injected count, skipped reasons, token estimate
- [ ] `/memory-graph-status` — graph backend, nodes, edges, links, traversal depth
- [ ] `/memory-doctor` — stale schema, FTS consistency, orphan graph links, oversized prompt warnings
- [ ] Tests — commands render useful output with empty and populated DBs

## Epic 8: Documentation + Release

- [ ] README — document policy-only mode and legacy mode
- [ ] README — add memory policy and retrieved-memory examples
- [ ] ROADMAP — mark frozen full injection as legacy, not the future default
- [ ] Migration notes — explain how Markdown remains readable/syncable
- [ ] `npm run check`
- [ ] `npm test`
- [ ] Version bump
- [ ] Tag release

## Implementation Order

1. Epic 1 — remove token tax first.
2. Epic 2 — route retrieval cheaply.
3. Epic 3 — rank/filter/pack safely.
4. Epic 4 — wire runtime injection.
5. Epic 7 — expose behavior for debugging.
6. Epic 5 — add graph booster after baseline retrieval works.
7. Epic 6 — harden conflict/staleness.
8. Epic 8 — docs and release.
