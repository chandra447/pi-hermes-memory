# Changelog — v0.7.0

## Summary

v0.7 adds a safe pipeline for turning session history into reviewed reusable skills:

**session history → candidate extraction → TUI review → skill draft → explicit promotion**

This release adds a human-in-the-loop path for candidate-based skill creation. The earlier auto-skill nudge path for complex tasks still exists alongside it.

---

## Added

### Epic 0 — Shadow Mode Validation
- `candidateShadowMode` config flag for read-only rollout
- `src/store/candidate-shadow.ts` read-only extraction analysis
- `/memory-candidates-shadow-run` command
- Shadow metrics so extraction quality can be checked before writing candidates

### Epic 1 — Candidate Schema + Store
- `memory_candidates` SQLite table
- candidate provenance fields:
  - `source_type`
  - `extractor_rule`
  - `evidence_count`
- deterministic dedupe strategy for staged candidates
- candidate store APIs:
  - `addCandidate()`
  - `listCandidates()`
  - `updateCandidateStatus()`
  - `markPromoted()`
  - `updateCandidateDetails()`
  - `mergeCandidates()`

### Epic 2 — Candidate Extraction Pipeline
- deterministic candidate extraction from indexed session history
- extractors for:
  - repeated corrections
  - resolved failure + fix pairs
  - repeated successful tool sequences
- deterministic fallback message hash when `message_id` is missing
- per-rule extraction metrics

### Epic 3 — TUI Review Flow
- `/memory-review-candidates` command
- interactive review queue with metadata:
  - project
  - tag
  - confidence
  - status
  - snippet
- review actions:
  - approve
  - reject
  - edit
  - merge
  - promote
- multi-select and bulk triage actions

### Epic 4 — Skill Draft Composer + Save
- `src/skills/skill-draft-composer.ts`
- candidate-to-skill draft generation with required sections:
  - `When to Use`
  - `Procedure`
  - `Pitfalls`
  - `Verification`
- sparse-section warnings + fallback content
- explicit confirmation before skill save + promotion

### Epic 5 — Quality Controls + Observability
- duplicate suppression guard for near-identical candidate snippets
- `candidateConfidenceThreshold` config
- `/memory-candidates-stats` command
- `/memory-candidates-rebuild` command
- transactional candidate rebuild from indexed session source-of-truth
- `/learn-memory-tool` docs extended with candidate review commands

---

## Changed

- v0.7 adds **reviewed candidate promotion** as a new skill-creation path alongside the pre-existing auto-skill nudge flow
- candidate promotion requires:
  - all selected candidates must be approved
  - at least one selected approved candidate must have `evidence_count >= 2`
  - explicit user confirmation
- candidate rebuild uses indexed SQLite session messages as source-of-truth and candidate rows as a rebuildable projection
- README and diagrams now document the v0.7 reviewed-skill workflow

---

## Fixed

- promotion guardrail now matches the Epic 4 contract
- pitfalls section no longer treats empty rationale as valid content
- candidate rebuild now rolls back safely if extraction fails mid-run
- duplicate suppression now normalizes whitespace consistently for near-identical snippets

---

## New / Updated Commands

| Command | Purpose |
|---|---|
| `/memory-candidates-shadow-run` | Read-only extraction quality report |
| `/memory-review-candidates` | Review and promote extracted candidates |
| `/memory-candidates-stats` | Inspect pending / approved / rejected / promoted counts |
| `/memory-candidates-rebuild` | Rebuild candidate projection from indexed sessions |
| `/learn-memory-tool` | Now documents the candidate review workflow |

---

## Safety Model

v0.7 adds multiple gates before skills are created:

- candidate extraction is deterministic
- shadow mode exists for pre-write validation
- promotion requires review in TUI
- promotion requires approved candidates, with at least one approved candidate carrying `evidence_count >= 2`
- promotion requires explicit final confirmation
- rebuild is transactional
- content scanner still runs on memory writes and skill persistence

---

## Validation

Release prep validated with:

- `npm run check`
- targeted Epic 4 tests
- targeted Epic 5 tests
- full test run via `tests/run-all.sh`
- `pi -p` review passes during Epic 4 and Epic 5 hardening

---

## Deferred / Not Included

- npm publish is intentionally **not executed** as part of this prep pass
- optional stale pending reminder command remains deferred
