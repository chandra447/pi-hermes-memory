# Failure Provenance — v0.5.5 Plan

## What We're Adding

Track **failures and corrections** as first-class memories with full provenance.

## Current State

We already have:
- ✅ Timestamps (created, last referenced) via memory aging
- ✅ Correction detection (saves on "don't do that")
- ✅ Session history (raw data in SQLite)

We're missing:
- ❌ Failure outcomes (what was tried, why it failed)
- ❌ Tool state at failure time
- ❌ Answer validity tracking

## Proposed Changes

### 1. Failure Memory Type with Categories

Add category labels to differentiate memory types:

| Category | What It Is | Example |
|---|---|---|
| `failure` | What didn't work | "Tried localStorage for tokens — XSS risk" |
| `correction` | User corrected the agent | "Use pnpm, not npm" |
| `insight` | Learning from experience | "Auth0 SDK handles refresh tokens automatically" |
| `preference` | User preference | "Prefers dark theme" |
| `convention` | Project convention | "Monorepo uses turborepo" |
| `tool-quirk` | Tool-specific knowledge | "CI needs --frozen-lockfile" |

Memory structure:
```typescript
interface FailureMemory {
  type: 'failure';
  category: 'failure' | 'correction' | 'insight' | 'preference' | 'convention' | 'tool-quirk';
  content: string;           // What was tried
  failure_reason?: string;   // Why it failed (for failures)
  tool_state?: string;       // Relevant tool state (e.g., error message)
  timestamp: string;         // When it happened
  session_id: string;        // Which session
  project: string;           // Which project
  corrected_to?: string;     // What worked instead (if known)
}
```

This makes search much more powerful:
```
memory_search("auth", category: "failure")   → Past auth failures
memory_search("deploy", category: "convention") → Deploy conventions
```

### 2. Auto-Detect Failures

Detect failures from:
- **Explicit corrections**: "that didn't work", "use X instead"
- **Error messages**: stderr output, test failures, build errors
- **Agent retries**: When the agent tries multiple approaches

### 3. Store in Extended Memory

Failures stored in SQLite `memories` table with `target: 'failure'`:
```sql
INSERT INTO memories (target, project, content, created, last_referenced)
VALUES ('failure', 'my-project', '{"tried":"...", "failed_because":"...", "tool_state":"..."}', ...);
```

### 4. Search Failures

New `memory_search` option:
```
memory_search("auth flow", target: "failure")
→ Returns past failures related to auth
```

### 5. Inject Relevant Failures

On session start, inject recent failures relevant to the current project:
```
<memory-context>
RECENT FAILURES (learn from these):
• Tried: using localStorage for tokens — Failed: XSS vulnerability
• Tried: bcrypt in browser — Failed: not available, use Web Crypto API
═══ END MEMORY ═══
</memory-context>
```

## Files to Change

| File | Change |
|---|---|
| `src/store/memory-store.ts` | Add `addFailure()` method |
| `src/store/sqlite-memory-store.ts` | Add failure target support |
| `src/handlers/background-review.ts` | Detect failures during review |
| `src/handlers/correction-detector.ts` | Extract failure context on corrections |
| `src/constants.ts` | Add failure detection prompt |
| `tests/store/memory-store.test.ts` | Test failure storage |
| `tests/store/sqlite-memory-store.test.ts` | Test failure search |

## Complexity Assessment

- **Effort**: Small (1-2 hours)
- **Risk**: Low (additive, no breaking changes)
- **Tests**: ~10 new tests

## Questions for Review

1. Should failures be in `MEMORY.md` or only in SQLite?
   - Recommendation: SQLite only (keeps core memory clean)

2. Should we auto-inject failures into system prompt?
   - Recommendation: Yes, but only recent (last 7 days) and relevant (project match)

3. Should `memory_search` default to including failures?
   - Recommendation: Yes, but allow filtering with `target: "failure"`

---

**Ready to implement?** Let me know and I'll start.
