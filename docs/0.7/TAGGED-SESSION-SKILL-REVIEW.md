# v0.7 Proposal: Tagged Session Review → Skill Creation

## Why

Community feedback highlighted a real gap:
- quick correction capture is useful,
- but **durable behavior should be promoted to skills intentionally**,
- and that flow should be reviewable in the TUI.

## Goal

Add a deterministic review workflow:
1. collect candidate learnings from session messages,
2. review them in a TUI modal,
3. promote selected items into a draft skill,
4. save via existing `skill` tool.

## Non-goals

- Auto-creating skills without user review.
- Replacing core memory entirely.
- Requiring git history for extraction.

## UX (Target)

### Command
- `/memory-review-candidates`

### Modal flow
1. **Candidate list** (tag, source session, snippet, confidence)
2. Actions per candidate: `approve`, `reject`, `edit`, `merge with...`
3. Multi-select candidates and choose `Create skill draft`
4. Draft editor with sections:
   - `## When to Use`
   - `## Procedure`
   - `## Pitfalls`
   - `## Verification`
5. Save with `skill.create`

## Candidate Sources

Priority order:
1. Explicit message tags from Pi sessions (when available)
2. Heuristic extraction from conversation patterns:
   - repeated corrections,
   - multi-step successful runs,
   - repeated tool sequences,
   - resolved failures with clear fix.

## Data Model (SQLite)

New table (proposal): `memory_candidates`

Columns:
- `id` INTEGER PK
- `session_id` TEXT
- `message_id` TEXT
- `project` TEXT
- `tag` TEXT
- `snippet` TEXT
- `rationale` TEXT
- `status` TEXT CHECK (`pending`,`approved`,`rejected`,`promoted`)
- `created_at` TEXT
- `updated_at` TEXT
- `promoted_skill` TEXT NULL

## Integration with Existing System

- Keep current memory + failure capture.
- Add a **promotion path** from memory/candidates to skills.
- Use existing `skill` tool as persistence layer.
- Use existing `session_search`/indexing infra for candidate discovery context.

## Rollout Plan

### Phase 1: Candidate staging (no modal)
- Create `memory_candidates` table
- Add extraction + `/memory-candidates` list command
- Add approve/reject commands

### Phase 2: TUI review modal
- Interactive candidate triage in one place
- Batch select + merge + edit

### Phase 3: Skill draft + save
- Generate skill draft from approved candidates
- Edit + save with `skill.create`

### Phase 4: Quality controls
- duplicate candidate suppression
- confidence thresholds
- weekly reminder: pending candidates review

## Success Criteria

- Lower noisy memory growth in `MEMORY.md`
- Higher percentage of reusable knowledge landing in `skills/`
- Fewer repeated correction loops across sessions
- Users report that learning feels intentional, not "whack-a-mole"

## Open Questions

1. Should candidates be extracted turn-by-turn or session-end only?
2. Should approved candidates auto-expire if not promoted in N days?
3. Should skill drafts include linked source message IDs for traceability?
4. Should project scope be default-on with optional cross-project merge mode?

## Notes

This proposal complements (not replaces) core memory.
Memory remains fast capture; skills remain durable procedure.
The new modal creates the missing bridge between them.
