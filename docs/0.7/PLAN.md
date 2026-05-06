# v0.7 Plan: Tagged Session Review → Skill Creation

## Problem

v0.6 captures memory/failures well, but durable behavior learning is still mostly implicit.
We need an explicit bridge from raw session learnings to reusable skills, with review gates.

## Goal

Ship a deterministic, user-reviewable pipeline:
1. stage candidate learnings from session history,
2. review/triage candidates,
3. promote selected candidates into skill drafts,
4. save via existing `skill` tool.

## Design Principles

- **Stage first, promote later** (no direct auto-skill creation)
- **Human review required** before durable skill writes
- **Provenance on every candidate** (session/message/time/project/tool context)
- **Deterministic extraction first** (LLM optional in later tuning)
- **No git dependency** (session-indexed behavior only)

---

## Architecture

### New SQLite table: `memory_candidates`

Columns:
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `session_id` TEXT NOT NULL
- `message_id` TEXT
- `project` TEXT
- `tag` TEXT NOT NULL
- `snippet` TEXT NOT NULL
- `rationale` TEXT NOT NULL
- `confidence` REAL NOT NULL DEFAULT 0
- `status` TEXT NOT NULL CHECK (`pending`,`approved`,`rejected`,`promoted`) DEFAULT `pending`
- `source_type` TEXT NOT NULL CHECK (`correction`,`failure`,`tool_sequence`,`explicit_tag`) DEFAULT `failure`
- `tool_state` TEXT
- `timestamp` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- `promoted_skill` TEXT
- `dedupe_key` TEXT UNIQUE

Indexes:
- `idx_candidates_status_created(status, created_at DESC)`
- `idx_candidates_project_status(project, status)`
- `idx_candidates_session(session_id)`
- `idx_candidates_tag_status(tag, status)`

### New modules

- `src/store/candidate-store.ts`
  - CRUD + status transitions + dedupe checks
- `src/store/candidate-extractor.ts`
  - deterministic heuristics from indexed sessions
- `src/handlers/review-candidates.ts`
  - `/memory-candidates` + approve/reject/promote commands
- `src/handlers/review-candidates-modal.ts`
  - TUI triage flow (phase 2)
- `src/skills/skill-draft-composer.ts`
  - converts approved candidates into skill sections

### Reused modules

- `session-indexer` + `session_search`
- `SkillStore` + `skill` tool
- correction/failure capture pipeline from v0.6

---

## Candidate Lifecycle

`pending` → (`approved` | `rejected`) → `promoted`

Rules:
- only `approved` candidates can be promoted
- `promoted` candidates are immutable
- duplicate candidates (same dedupe_key) are ignored

---

## Extraction Strategy (Deterministic)

Priority order:
1. explicit tagged messages (`#learn`, `#skill`)
2. repeated corrections
3. resolved failures with clear fix
4. repeated successful tool sequences

Candidate output:
- `tag` (e.g. `testing`, `migration`, `typescript`)
- `snippet` (short source text)
- `rationale` (why reusable)
- `confidence` (0–1)
- provenance (`session_id`, `message_id`, `timestamp`, `source_type`, optional `tool_state`)

Confidence policy:
- `>= 0.75`: auto-stage as `pending`
- `0.55–0.74`: stage if user opts into “include medium confidence”
- `< 0.55`: hidden by default

---

## UX Design

### Phase 1 (CLI-first)

Commands:
- `/memory-candidates` (list pending; filters: project/tag/status/confidence)
- `/memory-candidates-approve <id...>`
- `/memory-candidates-reject <id...>`
- `/memory-candidates-promote <id...>`
- `/memory-candidates-stats`

### Phase 2 (TUI modal)

Primary command:
- `/memory-review-candidates`

Flow:
1. candidate list with provenance (project/tag/source/confidence/time)
2. triage actions: approve/reject/edit/merge
3. multi-select → “Create skill draft”
4. draft preview with required sections:
   - `## When to Use`
   - `## Procedure`
   - `## Pitfalls`
   - `## Verification`
5. save via `skill.create`

---

## Promotion Quality Controls

Before `skill.create`:
- minimum 2 approved candidates OR one high-confidence failure+fix pair
- ensure all 4 sections are non-empty (fallback templates when sparse)
- prevent near-duplicate skill names (slug collision + similarity check)
- require preview/confirm step

---

## Rollout Plan

### Epic 1 — Schema + Candidate Store
- DB schema/migrations
- candidate CRUD + status transitions

### Epic 2 — Extractor + Staging
- deterministic extractor from indexed sessions
- dedupe and confidence thresholds

### Epic 3 — CLI Review Commands
- list/approve/reject/promote/stats

### Epic 4 — Skill Draft Composer
- deterministic section generation
- validate and persist via `skill` tool

### Epic 5 — TUI Modal Review
- interactive triage and batch promotion

### Epic 6 — Quality Controls + Docs
- duplicate suppression, stale reminders, docs + release

---

## Success Metrics

- ≥30% reduction in repeated corrections on same topic
- ≥2 promoted skills/week for active users
- lower raw MEMORY.md growth after candidate triage
- user feedback: “learning feels intentional, not noisy”

---

## Risks & Mitigations

- **Candidate noise** → conservative thresholds + fast reject path
- **UX complexity** → CLI-first before modal
- **Weak drafts** → mandatory preview + section validation
- **Schema drift** → migration coverage + regression tests

---

## Dependencies

- existing SQLite infra (`DatabaseManager`, migration path)
- indexed session availability (`/memory-index-sessions`)
- existing `skill` tool contract + tests
