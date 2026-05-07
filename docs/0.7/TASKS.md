# Tasks — v0.7: Tagged Session Review → Skill Creation

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Done (include commit hash)

---

## Epic 0: Shadow Mode Validation (pre-write)

### Done when
Extractor runs on session history and outputs quality reports without mutating candidate tables.

- [x] Add shadow-mode flag in config (`candidateShadowMode: true` default for initial rollout) (`03ba2e1`)
- [x] Add read-only extractor + metrics report (`src/store/candidate-shadow.ts`) (`03ba2e1`)
- [x] Add `/memory-candidates-shadow-run` command (`03ba2e1`)
- [x] Wire command in `src/index.ts` (`03ba2e1`)
- [x] Add tests for no-write guarantee and report metrics (`03ba2e1`)

---

## Epic 1: Candidate Schema + Store

### Done when
`memory_candidates` exists with migrations and tested status transitions.

- [x] Add schema for `memory_candidates` in `src/store/schema.ts` with provenance fields: (`9f2d2a6`)
  - [x] `source_type` (`9f2d2a6`)
  - [x] `extractor_rule` (`9f2d2a6`)
  - [x] `evidence_count` (`9f2d2a6`)
- [x] Add legacy migration path in `src/store/db.ts` (`9f2d2a6`)
- [x] Add deterministic unique dedupe index: `(session_id, message_id, tag, extractor_rule)` (`9f2d2a6`)
- [x] Create `src/store/candidate-store.ts`: (`9f2d2a6`)
  - [x] `addCandidate()` (`9f2d2a6`)
  - [x] `listCandidates()` with filters (status/project/tag) (`9f2d2a6`)
  - [x] `updateCandidateStatus()` (`9f2d2a6`)
  - [x] `markPromoted()` (`9f2d2a6`)
- [x] Add tests: `tests/store/candidate-store.test.ts` (`9f2d2a6`)

---

## Epic 2: Candidate Extraction Pipeline

### Done when
We can stage candidates from indexed session messages using deterministic heuristics.

- [x] Create `src/store/candidate-extractor.ts` (`cc7f187`)
- [x] Implement extraction heuristics: (`cc7f187`)
  - [x] repeated corrections (`cc7f187`)
  - [x] resolved failure + fix pair (`cc7f187`)
  - [x] repeated successful tool sequences (`cc7f187`)
- [x] Add provenance + dedupe key strategy (session_id/message_id/tag/extractor_rule) (`cc7f187`)
- [x] Add fallback deterministic message hash when `message_id` is missing (`cc7f187`)
- [x] Add tests: `tests/store/candidate-extractor.test.ts` (`cc7f187`)

---

## Epic 3: TUI Review Flow (Primary UX)

### Done when
`/memory-review-candidates` provides interactive review/triage/promote flow so users never need to remember IDs.

- [x] Add command: `/memory-review-candidates` (`1f32134`)
- [x] Build modal/list view with metadata (project/tag/confidence/status/snippet) (`1f32134`)
- [x] Add row actions: approve/reject/promote/edit/merge (`1f32134`)
- [x] Add multi-select + bulk actions (`1f32134`)
- [x] Enforce approval gate before promotion (`1f32134`)
- [x] Wire command in `src/index.ts` (`1f32134`)
- [x] Add handler tests in `tests/handlers/` (`1f32134`)

---

## Epic 4: Skill Draft Composer + Save

### Done when
Approved candidates can be converted into a draft skill and saved via `skill.create`, never auto-created silently.

- [x] Create `src/skills/skill-draft-composer.ts` (`24daeee`)
- [x] Map candidates into required sections: (`24daeee`)
  - [x] `When to Use` (`24daeee`)
  - [x] `Procedure` (`24daeee`)
  - [x] `Pitfalls` (`24daeee`)
  - [x] `Verification` (`24daeee`)
- [x] Add validation/fallback when sections are sparse (`24daeee`)
- [x] Add promotion guardrail: require all selected candidates to be approved, with at least one approved candidate having `evidence_count >= 2` (`24daeee`)
- [x] Persist via existing `skill` tool interface (`24daeee`)
- [x] Add tests: `tests/skills/skill-draft-composer.test.ts` (`24daeee`)

---

## Epic 5: Quality Controls + Observability

### Done when
Noise is controlled and users get visibility into pending/promoted candidates.

- [x] Add duplicate suppression guard (`e68365d`)
- [x] Add confidence threshold config (`09506fc`)
- [x] Add source-of-truth rebuild command from indexed session messages (`/memory-candidates-rebuild`) (`e68365d`)
- [ ] Add optional stale pending reminder command (weekly)
- [x] Add stats output (pending/approved/rejected/promoted counts) (`e68365d`)
- [x] Extend `/learn-memory-tool` with candidate-review flow docs (`e68365d`)

---

## Epic 6: Docs + Release

### Done when
Docs updated and release is shippable.

- [x] Update `README.md` with v0.7 workflow
- [x] Add `docs/0.7/CHANGELOG.md`
- [x] Run full test suite + typecheck
- [x] Bump version
- [ ] Publish npm (deferred for this prep pass)

---

## Suggested Commit Strategy

- One commit per epic (`feat(epic-X): ...`)
- Separate follow-up commit for test fixes if needed
- UX order: TUI review → skill draft/save → quality/observability
- Keep docs/release updates in final epic commits
