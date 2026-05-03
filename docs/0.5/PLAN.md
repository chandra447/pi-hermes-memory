# v0.5 Plan: Failure Memory + Categories + Provenance

## Overview

Track **failures, corrections, and insights** as first-class memories with full provenance and category labels. Learn from failures like humans do.

## Motivation

From X/Twitter feedback:
> "Memory gets much more useful when it stores failures, not just conversations. I'd want every recalled session to carry provenance: source, timestamp, tool state, and whether the old answer survived contact with reality."

## Key Features

### 1. Memory Categories

Add category labels to differentiate memory types:

| Category | What It Is | Example |
|---|---|---|
| `failure` | What didn't work | "Tried localStorage for tokens — XSS risk" |
| `correction` | User corrected the agent | "Use pnpm, not npm" |
| `insight` | Learning from experience | "Auth0 SDK handles refresh tokens automatically" |
| `preference` | User preference | "Prefers dark theme" |
| `convention` | Project convention | "Monorepo uses turborepo" |
| `tool-quirk` | Tool-specific knowledge | "CI needs --frozen-lockfile" |

### 2. Failure Memory Structure

```typescript
interface FailureMemory {
  category: 'failure' | 'correction' | 'insight' | 'preference' | 'convention' | 'tool-quirk';
  content: string;           // What was tried / what happened
  failure_reason?: string;   // Why it failed (for failures)
  tool_state?: string;       // Relevant tool state (error message, output)
  corrected_to?: string;     // What worked instead (if known)
  project: string;           // Which project
  session_id?: string;       // Which session
  timestamp: string;         // When it happened
}
```

### 3. Auto-Detect Failures

Detect failures from:
- **Explicit corrections**: "that didn't work", "use X instead", "no, do it this way"
- **Error messages**: stderr output, test failures, build errors
- **Agent retries**: When the agent tries multiple approaches
- **User feedback**: "this is wrong", "that's not right"

### 4. Failure Injection into System Prompt

Inject relevant recent failures into the system prompt at session start:

```
<memory-context>
RECENT FAILURES & LESSONS (learn from these):
• [failure] Tried: localStorage for JWT tokens — Failed: XSS vulnerability
  → Corrected to: httpOnly cookies with SameSite=Strict
• [correction] Use pnpm, not npm (corrected 2 days ago)
• [insight] Auth0 SDK handles refresh tokens automatically — no manual implementation needed
═══ END MEMORY ═══
</memory-context>
```

**Injection rules:**
- Only inject failures from last 7 days
- Only inject failures relevant to current project (or global)
- Max 5 failure entries to avoid prompt bloat
- Separate `<memory-context>` block from regular memory

### 5. Search with Categories

Update `memory_search` tool to support category filtering:

```
memory_search("auth", category: "failure")   → Past auth failures
memory_search("deploy", category: "convention") → Deploy conventions
memory_search("typescript", category: "tool-quirk") → TS tool quirks
```

### 6. Store Failures in SQLite

Failures stored in `memories` table with `target: 'failure'`:

```sql
-- New target type
target TEXT CHECK (target IN ('memory', 'user', 'failure'))

-- Content stored as JSON with category
{
  "category": "failure",
  "content": "Tried localStorage for JWT tokens",
  "failure_reason": "XSS vulnerability - tokens accessible via JS",
  "tool_state": "Error: Token exposed in browser console",
  "corrected_to": "httpOnly cookies with SameSite=Strict",
  "project": "my-app",
  "timestamp": "2026-05-03T10:30:00Z"
}
```

### 7. Update Background Review Prompt

Enhance the background review prompt to extract failures:

```
Review this conversation and extract:

1. FAILURES: What was tried but didn't work?
   - What was attempted
   - Why it failed
   - What error occurred
   - What worked instead (if found)

2. CORRECTIONS: Did the user correct the agent?
   - What was wrong
   - What is correct

3. INSIGHTS: What was learned?
   - New knowledge about tools, APIs, patterns
   - Project-specific learnings

4. CONVENTIONS: Any project conventions discovered?
   - Coding style, naming, patterns
   - Tool preferences
```

## Architecture Changes

### Memory Store (`src/store/memory-store.ts`)

```typescript
// Add to MemoryStore class
addFailure(content: string, options: {
  category: MemoryCategory;
  failureReason?: string;
  toolState?: string;
  correctedTo?: string;
}): void;

getFailureEntries(): string[];  // Returns recent failures for injection
```

### SQLite Memory Store (`src/store/sqlite-memory-store.ts`)

```typescript
// Update searchMemories to support category filter
searchMemories(db, query, { project, target, category, limit })
```

### Memory Search Tool (`src/tools/memory-search-tool.ts`)

```typescript
// Add category parameter
category: Type.Optional(StringEnum([
  'failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'
] as const, { description: 'Filter by memory category.' }))
```

### Background Review (`src/handlers/background-review.ts`)

- Extract failures during review
- Store with category labels
- Include failure context in review prompt

### Correction Detector (`src/handlers/correction-detector.ts`)

- Extract failure context when correction detected
- Store what was wrong + what is correct

### System Prompt Injection (`src/index.ts`)

- Add separate `<memory-context>` block for failures
- Inject only recent (7 days) and relevant (project match)
- Max 5 entries

## Files to Change

| File | Change |
|---|---|
| `src/types.ts` | Add `MemoryCategory` type |
| `src/constants.ts` | Update review prompt for failure extraction |
| `src/store/memory-store.ts` | Add `addFailure()`, `getFailureEntries()` |
| `src/store/sqlite-memory-store.ts` | Add category support to search |
| `src/tools/memory-search-tool.ts` | Add category parameter |
| `src/handlers/background-review.ts` | Extract failures during review |
| `src/handlers/correction-detector.ts` | Store failure context on corrections |
| `src/index.ts` | Inject failure memories into system prompt |
| `tests/store/memory-store.test.ts` | Test failure storage |
| `tests/store/sqlite-memory-store.test.ts` | Test category search |
| `tests/tools/memory-search-tool.test.ts` | Test category parameter |

## Complexity Assessment

- **Effort**: Medium (2-3 hours)
- **Risk**: Low (additive, no breaking changes)
- **Tests**: ~15 new tests

## Migration

- Existing memories get `category: null` (no migration needed)
- New memories get category assigned
- Search works with or without category filter
