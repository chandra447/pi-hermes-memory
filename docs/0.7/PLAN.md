# v0.7 Plan: Tagged Session Review → Skill Creation

## Problem

v0.6 captures memory/failures well, but durable behavior learning is still mostly implicit. We need an explicit bridge from raw session learnings to reusable skills.

## Goal

Ship a deterministic, user-reviewable flow:
1. extract candidate learnings from session history,
2. review/triage candidates,
3. generate a skill draft from approved candidates,
4. save via existing `skill` tool.

## Scope

### In scope
- Candidate extraction + persistence
- Candidate review commands (phase 1)
- Interactive review modal (phase 2)
- Skill draft generation + save (phase 3)
- Basic quality controls (phase 4)

### Out of scope
- Auto-publishing skills without review
- Replacing memory/failure stores
- Git-based mining requirements

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
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- `promoted_skill` TEXT

Indexes:
- `idx_candidates_status_created(status, created_at DESC)`
- `idx_candidates_project_status(project, status)`
- `idx_candidates_session(session_id)`

### New modules
- `src/store/candidate-store.ts`
  - CRUD + status transitions + dedupe checks
- `src/store/candidate-extractor.ts`
  - Heuristics from messages/session chunks
- `src/handlers/review-candidates.ts`
  - `/memory-candidates`, approve/reject/promote commands
- `src/handlers/review-candidates-modal.ts`
  - TUI modal flow for triage (phase 2)
- `src/skills/` (reuse existing `skill` tool for persistence)

### Reused modules
- `session-indexer` + `session_search`
- `SkillStore` + `skill` tool
- Existing correction/failure capture pipeline

---

## UX Design

### Commands (phase 1)
- `/memory-candidates` → list pending candidates
- `/memory-candidates-approve <id...>`
- `/memory-candidates-reject <id...>`
- `/memory-candidates-promote <id...>` → create skill draft

### Modal (phase 2)
Primary command:
- `/memory-review-candidates`

Flow:
1. Candidate list (tag/project/confidence/snippet)
2. Triage actions: approve/reject/edit/merge
3. Multi-select → “Create skill draft”
4. Draft preview with sections:
   - `## When to Use`
   - `## Procedure`
   - `## Pitfalls`
   - `## Verification`
5. Save through `skill.create`

---

## Extraction Strategy

Priority order:
1. explicit tagged messages (if present),
2. repeated corrections,
3. resolved failures with clear fix,
4. repeated tool sequences ending in success.

Output candidate shape:
- tag (e.g., `testing`, `migration`, `typescript`)
- snippet (short source text)
- rationale (why this is reusable)
- confidence (0-1)

Initial thresholds:
- auto-stage candidates with confidence >= 0.65
- lower confidence only visible in modal “include low confidence” toggle

---

## Rollout

### Phase 1 (CLI-first)
- schema + store + extractor + non-modal review commands

### Phase 2 (TUI review)
- modal triage + batch actions + merge/edit

### Phase 3 (Skill promotion)
- deterministic skill draft composer + `skill.create`

### Phase 4 (Quality controls)
- dedupe suppression
- stale pending reminders
- promotion metrics

---

## Success Metrics

- ≥30% reduction in repeated corrections for same topic
- ≥2 promoted skills/week for active users
- lower MEMORY.md growth rate after enabling candidate triage
- user feedback: “learning is intentional and reviewable”

---

## Risks & Mitigations

- **Noise in candidates** → conservative thresholds + easy reject
- **Over-complex UX** → phase 1 command-based first
- **Bad skill drafts** → always editable before save
- **Schema drift** → migration coverage + regression tests

---

## Dependencies

- Existing SQLite infra (`DatabaseManager`, migrations)
- Existing session indexing coverage
- Existing `skill` tool contract and tests
