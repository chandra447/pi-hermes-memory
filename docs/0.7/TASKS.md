# Tasks — v0.7: Tagged Session Review → Skill Creation

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Done (include commit hash)

---

## Epic 0: Shadow Mode Validation (pre-write)

### Done when
Extractor runs on session history and outputs quality reports without mutating candidate tables.

- [~] Add shadow-mode flag in config (`candidateShadowMode: true` default for initial rollout)
- [~] Add read-only extractor + metrics report (`src/store/candidate-shadow.ts`)
- [~] Add `/memory-candidates-shadow-run` command
- [~] Wire command in `src/index.ts`
- [~] Add tests for no-write guarantee and report metrics

---

## Epic 1: Candidate Schema + Store

### Done when
`memory_candidates` exists with migrations and tested status transitions.

- [ ] Add schema for `memory_candidates` in `src/store/schema.ts` with provenance fields:
  - [ ] `source_type`
  - [ ] `extractor_rule`
  - [ ] `evidence_count`
- [ ] Add legacy migration path in `src/store/db.ts`
- [ ] Add deterministic unique dedupe index: `(session_id, message_id, tag, extractor_rule)`
- [ ] Create `src/store/candidate-store.ts`:
  - [ ] `addCandidate()`
  - [ ] `listCandidates()` with filters (status/project/tag)
  - [ ] `updateCandidateStatus()`
  - [ ] `markPromoted()`
- [ ] Add tests: `tests/store/candidate-store.test.ts`

---

## Epic 2: Candidate Extraction Pipeline

### Done when
We can stage candidates from indexed session messages using deterministic heuristics.

- [ ] Create `src/store/candidate-extractor.ts`
- [ ] Implement extraction heuristics:
  - [ ] repeated corrections
  - [ ] resolved failure + fix pair
  - [ ] repeated successful tool sequences
- [ ] Add provenance + dedupe key strategy (session_id/message_id/tag/extractor_rule)
- [ ] Add fallback deterministic message hash when `message_id` is missing
- [ ] Add tests: `tests/store/candidate-extractor.test.ts`

---

## Epic 3: CLI Review Commands (Phase 1 UX)

### Done when
Users can review/triage/promote candidates without modal, with explicit approval before promotion.

- [ ] Add command: `/memory-candidates`
- [ ] Add command: `/memory-candidates-approve <id...>`
- [ ] Add command: `/memory-candidates-reject <id...>`
- [ ] Add command: `/memory-candidates-promote <id...>` (must enforce approval gate)
- [ ] Wire commands in `src/index.ts`
- [ ] Add command tests in `tests/handlers/`

---

## Epic 4: Skill Draft Composer + Save

### Done when
Approved candidates can be converted into a draft skill and saved via `skill.create`, never auto-created silently.

- [ ] Create `src/skills/skill-draft-composer.ts`
- [ ] Map candidates into required sections:
  - [ ] `When to Use`
  - [ ] `Procedure`
  - [ ] `Pitfalls`
  - [ ] `Verification`
- [ ] Add validation/fallback when sections are sparse
- [ ] Add promotion guardrail: require explicit approval OR repeated evidence (`evidence_count >= 2`) + approval
- [ ] Persist via existing `skill` tool interface
- [ ] Add tests: `tests/skills/skill-draft-composer.test.ts`

---

## Epic 5: TUI Modal Review (Phase 2 UX)

### Done when
`/memory-review-candidates` provides interactive review and promotion flow.

- [ ] Add command: `/memory-review-candidates`
- [ ] Build modal list view with metadata (project/tag/confidence)
- [ ] Add actions: approve/reject/edit/merge
- [ ] Add multi-select + “Create skill draft” action
- [ ] Add smoke test coverage for modal handler behavior

---

## Epic 6: Quality Controls + Observability

### Done when
Noise is controlled and users get visibility into pending/promoted candidates.

- [ ] Add duplicate suppression guard
- [ ] Add confidence threshold config
- [ ] Add source-of-truth rebuild command from session JSONL (`/memory-candidates-rebuild`)
- [ ] Add optional stale pending reminder command (weekly)
- [ ] Add stats output (pending/approved/rejected/promoted counts)
- [ ] Extend `/learn-memory-tool` with candidate-review flow docs

---

## Epic 7: Docs + Release

### Done when
Docs updated and release is shippable.

- [ ] Update `README.md` with v0.7 workflow
- [ ] Add `docs/0.7/CHANGELOG.md`
- [ ] Run full test suite + typecheck
- [ ] Bump version
- [ ] Publish npm

---

## Suggested Commit Strategy

- One commit per epic (`feat(epic-X): ...`)
- Separate follow-up commit for test fixes if needed
- Keep docs/release updates in final epic commits
