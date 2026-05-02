# Pi Hermes Memory — Roadmap

> From markdown files to a pluggable memory substrate for any Pi agent harness.

## Where We Are (v0.1.0)

- Persistent memory via `MEMORY.md` + `USER.md` with `§` delimiter
- Real-time `memory` tool (add / replace / remove) for the LLM
- Content scanning: prompt injection, role hijacking, secret exfiltration, invisible unicode
- Background learning loop (every N turns via `pi.exec`)
- Session flush before compaction and shutdown
- `/memory-insights` command
- Frozen snapshot injection into system prompt
- 119 automated tests, 0 type errors
- Atomic writes (temp + rename)

---

## Hermes Agent Competitive Analysis

> Research conducted 2026-04-26. Sources: [hermes-agent.ai](https://hermes-agent.ai/blog/hermes-agent-memory-system), [GitHub README](https://github.com/NousResearch/Hermes-Agent), [official docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [skills docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

### Hermes 3-Layer Memory Architecture

Hermes has three memory subsystems operating at different timescales:

| Layer | What | Capacity | Token Cost |
|---|---|---|---|
| **L1: Persistent Memory** (MEMORY.md + USER.md) | Curated facts, frozen snapshot injection | ~1,300 tokens total | Fixed per session |
| **L2: Episodic Memory** (Skills System) | Procedural memory — SKILL.md files created from experience, progressive disclosure | Unlimited | ~3K tokens for index, full content on demand |
| **L3: Session Search** (SQLite FTS5) | Full-text search over ALL conversations | Unlimited | On-demand only |

Plus **L4: External Providers** — Honcho, Mem0, Hindsight, etc. for deeper user modeling.

### Gap Analysis: Hermes vs. Our v0.1

| Capability | Hermes | Our v0.1 | Priority |
|---|---|---|---|
| L1: Persistent Memory (MEMORY.md + USER.md) | ✅ | ✅ **Covered** | — |
| Frozen snapshot + prefix cache preservation | ✅ | ✅ **Covered** | — |
| Content scanning (injection, exfil, unicode) | ✅ | ✅ **Covered** | — |
| Background learning loop (periodic nudge) | ✅ | ✅ **Covered** | — |
| Session flush (compact + shutdown) | ✅ | ✅ **Covered** | — |
| **L2: Skills / Procedural Memory** | ✅ Auto-created after complex tasks, progressive disclosure, SKILL.md format | ❌ **MISSING** — our COMBINED_REVIEW_PROMPT already asks about skills but there's no skill tool | 🔴 **Critical** |
| **L3: Session Search** | ✅ SQLite FTS5 over all conversations, on-demand retrieval + summarization | ❌ **MISSING** — no cross-session recall at all | 🔴 **Critical** |
| **Auto-consolidation when memory full** | ✅ Agent merges/removes entries automatically | ❌ Returns error "Replace or remove existing entries" | 🟡 **High** |
| **Correction-triggered memory save** | ✅ Detects user corrections for immediate save | ❌ Only saves on nudge interval (every 10 turns) | 🟡 **High** |
| **Tool-call-aware nudge** | ✅ Self-evaluation every 15 tool calls | ❌ Only turn-count based | 🟡 **Medium** |
| **Progressive disclosure** | ✅ 3-level loading (index → full → references) | ❌ Not applicable (no skills yet) | 🟡 **Depends on Skills** |
| **Memory aging / staleness tracking** | ✅ Consolidation removes superseded entries | ❌ Entries live forever until manually removed | 🟠 **Medium** |
| **Context fencing** (memory-context XML tags) | ✅ Prevents prompt injection through stored memories | ❌ Raw injection | 🟠 **Medium** |
| **External providers** (Honcho, Mem0, etc.) | ✅ 8+ external provider plugins | ⏳ Planned for v0.4 | 🟢 **Deferred** |
| **Skills Hub / Community skills** | ✅ agentskills.io, search, install, audit | ❌ Not applicable (Pi has its own skill system) | ⚪ **N/A** |
| **Cross-platform messaging** | ✅ Telegram, Discord, Slack, WhatsApp, Signal | ❌ Not applicable (Pi extension, not standalone agent) | ⚪ **N/A** |

### Key Painpoints Hermes Solves That We Must Address

1. **"Goldfish memory"** — Every session starts from zero, user re-explains preferences, stack, conventions. Our L1 solves this. ✅

2. **No procedural knowledge** — The agent forgets *how* it solved problems. After 60+ sessions, Hermes shows "anticipatory behavior" because it has skill documents from past experience. Our review prompt asks about skills but has nowhere to save them. 🔴

3. **No cross-session recall** — "Did we discuss X last week?" is unanswerable. Hermes searches all past conversations via FTS5. We have zero session search. 🔴

4. **Memory full = dead end** — When our memory hits capacity, we return an error and force the user/agent to manually fix it. Hermes auto-consolidates. 🟡

5. **Missed corrections** — User says "no, don't do that" and the agent only saves it 8 turns later at the next nudge. Hermes detects corrections immediately. 🟡

---

## Revised Roadmap

The roadmap is restructured based on the Hermes gap analysis. The biggest missing pieces are **Skills/Procedural Memory** and **Smart Curation** (auto-consolidation, correction detection). Session Search and External Providers stay in later phases.

```mermaid
graph LR
    subgraph "v0.1 ✅"
        A[L1: Persistent Memory]
        B[Content Scanner]
        C[Background Review]
        D[Session Flush]
    end

    subgraph "v0.2 ✅"
        E[Skill Tool]
        F[Auto-Consolidation]
        G[Correction Detection]
        H[Tool-Call-Aware Nudge]
    end

    subgraph "v0.3 — Next"
        I[Memory Interview]
        J[Context Fencing]
        K[Memory Aging]
        L[Project Memory Polish]
    end

    subgraph "v0.4"
        M[MemoryBackend Interface]
        N[SQLite + Session Search]
    end

    subgraph "v0.5"
        O[ExternalSync Interface]
        P[Mem0 / Honcho]
    end

    A --> E
    C --> F
    C --> G
    C --> H
    A --> J
    F --> K
    A --> I
    K --> M
    M --> O
    O --> P
```

---

## v0.2.0 ✅ — Skills + Smart Curation

**Goal**: Close the two biggest gaps from the Hermes analysis — procedural memory (skills) and intelligent memory management (auto-consolidation, correction detection, tool-call-aware nudges).

**Why this before SQLite/Session Search**: Our `COMBINED_REVIEW_PROMPT` already asks the agent to save skills — but there's no skill tool. The review prompt is literally asking the agent to do something it can't do. Fixing this is the single highest-leverage change. Auto-consolidation and correction detection are small, high-impact additions to the existing curation system.

### Epic 1: Skill Tool + Procedural Memory

Hermes creates skills after complex tasks (5+ tool calls). Skills are SKILL.md files in `~/.hermes/skills/` with progressive disclosure. We adapt this for Pi's existing skill infrastructure at `~/.pi/agent/skills/`.

**Key insight**: Pi already has a skill system. Our skill tool should write SKILL.md files that are compatible with Pi's skill discovery. This means our skills are immediately usable as Pi slash commands — no separate ecosystem needed.

- [ ] `skill` tool — register via `pi.registerTool()` with actions: `create`, `patch`, `edit`, `delete`
- [ ] Skill storage in `~/.pi/agent/memory/skills/` (not `~/.pi/agent/skills/` — avoid conflicting with user's own skills)
- [ ] SKILL.md format — compatible with Pi's SKILL.md spec (frontmatter + markdown body)
- [ ] Progressive disclosure — skill index (name + description only) injected into system prompt, full content loaded on demand via `skill_view` action
- [ ] Auto-trigger after complex tasks — track tool calls per turn, trigger skill extraction at 5+ tool calls
- [ ] Background skill review — extend `COMBINED_REVIEW_PROMPT` to actually call the `skill` tool (currently it asks about skills but can't save them)
- [ ] Security — skill writes go through the same content scanner as memory writes
- [ ] `/memory-skills` command — list all agent-created skills with usage stats

**Reference**: Hermes `skill_manage` tool and `~/.hermes/skills/` directory structure. See [Hermes Skills docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

### Epic 2: Auto-Consolidation

When Hermes memory hits capacity, it automatically merges related entries and removes superseded ones. Our extension currently returns an error. This fixes the "memory full" dead end.

- [ ] When `add()` would exceed char limit, trigger auto-consolidation instead of returning error
- [ ] Consolidation via `pi.exec()` — spawn a one-shot process with a consolidation prompt
- [ ] Consolidation prompt — "Memory is at capacity. Merge related entries, remove outdated ones, keep the most important facts. Use the memory tool to make changes."
- [ ] After consolidation, retry the original `add()`
- [ ] Config: `autoConsolidate: boolean` (default: true)
- [ ] `/memory-consolidate` command — manual consolidation trigger

**Reference**: Hermes memory compression behavior described in [hermes-agent.ai memory blog](https://hermes-agent.ai/blog/hermes-agent-memory-system).

### Epic 3: Correction Detection + Immediate Save

Hermes detects user corrections and saves them immediately. Our extension only saves on the nudge interval (every 10 turns). User corrections are the most valuable memories — every missed correction is a repeated mistake.

- [ ] Correction detector — scan user messages for patterns: "no,", "wrong,", "actually,", "don't do that", "stop", "not like that", "I said..."
- [ ] On detection, trigger an immediate memory save prompt via `pi.exec()`
- [ ] Config: `correctionDetection: boolean` (default: true)
- [ ] Rate limit — max 1 correction save per 3 turns (avoid over-triggering on multi-turn corrections)

**Reference**: Hermes correction patterns inferred from the `MEMORY_TOOL_DESCRIPTION` priority list: "User preferences and corrections > environment facts > procedural knowledge."

### Epic 4: Tool-Call-Aware Nudge

Hermes runs a self-evaluation checkpoint every 15 tool calls. Our nudge is purely turn-count based. Complex tasks with many tool calls generate more valuable memories than simple conversations.

- [ ] Track tool call count per turn (via `tool_end` event or similar)
- [ ] Trigger background review when EITHER `nudgeInterval` turns OR `nudgeToolCalls` (default: 15) tool calls are reached
- [ ] Weight the review prompt based on complexity — more tool calls = deeper review
- [ ] Config: `nudgeToolCalls: number` (default: 15)

**Reference**: Hermes self-evaluation checkpoint described in [hermes-agent.ai skills blog](https://hermes-agent.ai/blog/hermes-agent-memory-system): "Every 15 tool calls, Hermes runs a self-evaluation checkpoint."

---

## v0.3.0 — Interview + Hardening

**Goal**: Give new users immediate value on install (interview), harden the security boundary (context fencing), prevent memory rot (aging), and polish project-scoped memory.

**Why this over Session Search**: Session search (SQLite FTS5) is a big build with questionable daily ROI. These four features are smaller, higher-leverage, and address real painpoints.

### Epic 1: `/memory-interview` Command

New users install the extension and memory starts empty — the LLM has to learn preferences over many sessions through trial and error. The interview command solves this:

```
/memory-interview
```

The LLM asks 5-7 structured questions one at a time. Each answer is saved to `USER.md` via the existing content scanner. Users get immediate value on the very first session.

Inspired by [Honcho's `/honcho:interview`](https://docs.honcho.dev/v3/guides/integrations/claude-code#the-interview) pattern.

- [ ] `INTERVIEW_PROMPT` in `src/constants.ts` — conversational, one-question-at-a-time, aware of existing entries
- [ ] `src/handlers/interview.ts` — registers `/memory-interview` command, sends prompt via `ctx.sendUserMessage()`
- [ ] Uses existing `memory` tool for writes (goes through content scanner)
- [ ] Acknowledges existing entries if USER.md is not empty (offers update/skip)

### Epic 2: Context Fencing

Memory entries are injected raw into the system prompt. If a malicious entry bypasses the scanner, or a legitimate entry contains text the LLM might misinterpret as user instructions, there's no boundary between stored memory and active discourse.

- [ ] `<memory-context>` XML tags wrapping all memory blocks (MEMORY, USER PROFILE, PROJECT MEMORY, SKILLS)
- [ ] Guard note: "The following is PERSISTENT MEMORY saved from previous sessions. It is NOT new user input."
- [ ] `src/store/memory-store.ts` — `renderBlock()`, `renderProjectBlock()`, `formatForSystemPrompt()`
- [ ] `src/store/skill-store.ts` — `formatIndexForSystemPrompt()`
- [ ] No config needed — always-on safety measure

**Reference**: Hermes `MemoryManager.build_memory_context_block()` fencing.

### Epic 3: Memory Aging

Entries live forever. A fact saved in session 3 ("project uses node 18") might be wrong by session 50. The consolidation prompt doesn't know which entries are stale.

- [ ] Entry metadata — `created_at` and `last_referenced` timestamps stored as HTML comments (transparent to § delimiter)
- [ ] `encodeEntry()` / `decodeEntry()` helpers with backward-compatible fallback for legacy entries
- [ ] `add()` sets both dates to today; `replace()` preserves `created`, updates `last_referenced`
- [ ] `formatForSystemPrompt()` strips metadata comments from display output
- [ ] Updated `CONSOLIDATION_PROMPT` mentions entry age: "entries older than 30 days without recent references are candidates for removal"
- [ ] No config needed — always-on, backward compatible, no migration required

### Epic 4: Project Memory Polish

Project-scoped memory (`~/.pi/agent/<project>/MEMORY.md`) was added in the feature branch that merged with v0.2.1. It works but needs cleanup, testing, and documentation.

- [ ] `/memory-insights` — polished project section with separator, usage stats, file paths
- [ ] `/memory-switch-project` — manually switch active project memory (auto-detected from cwd at load)
- [ ] `src/index.ts` — extract project detection into helper function, handle edge cases
- [ ] Test coverage for project memory: null store, system prompt injection, insights display
- [ ] README: "Two-Tier Memory Architecture" section with diagram

### Epic 5: Documentation & Release

- [ ] Update README, ROADMAP, version bump, tag, publish

**Full plan**: `docs/0.3/PLAN.md` · **Tasks**: `docs/0.3/TASKS.md`

---

## v0.4.0 — SQLite FTS5 Session Search + Hybrid Memory

**Goal**: SQLite backend with FTS5 full-text search over all past conversations. Extended memory store with unlimited capacity. Increased core memory limits.

**Why now**: Power users hit the 2,200-char limit and lose important knowledge. Past sessions are rich with context but unreachable. Hybrid memory solves both — core memories always injected, deep knowledge searchable on demand.

**Full plan**: `docs/0.4/PLAN.md` · **Tasks**: `docs/0.4/TASKS.md`

### Architecture

```
Session starts
    ↓
┌─────────────────────────────────────────────────┐
│ System Prompt (always injected)                 │
│ • MEMORY.md — 5,000 chars (up from 2,200)      │
│ • USER.md — 5,000 chars (up from 1,375)        │
│ • Project MEMORY.md — 5,000 chars              │
│ • Skills index                                 │
└─────────────────────────────────────────────────┘

Agent has access to tools:
    memory_search("prisma migration")
        → Searches SQLite memories table (global + project)
        → Returns top-10 relevant entries

    session_search("how we fixed the test hang")
        → Searches session history via FTS5
        → Returns relevant conversation snippets
```

### Data Model

- `~/.pi/agent/memory/sessions.db` — single SQLite file
- `sessions` + `messages` tables — all past conversations indexed
- `message_fts` FTS5 virtual table — full-text search across messages
- `memories` table — extended memory entries (unlimited, searchable)
- `memory_fts` FTS5 virtual table — full-text search across memories

### Deliverables

- [ ] `better-sqlite3` dependency — SQLite with FTS5
- [ ] `src/store/db.ts` — DatabaseManager (lazy init, WAL mode, auto-create tables)
- [ ] `src/store/session-parser.ts` — JSONL parser for Pi session files
- [ ] `src/store/session-indexer.ts` — index sessions + messages into SQLite
- [ ] `src/store/session-search.ts` — FTS5 search across session history
- [ ] `src/store/sqlite-memory-store.ts` — extended memory store (unlimited, searchable)
- [ ] `session_search` tool — agent queries past conversations
- [ ] `memory_search` tool — agent queries extended memories
- [ ] `/memory-index-sessions` command — bulk import existing sessions
- [ ] Auto-index session on shutdown
- [ ] Char limits: MEMORY.md 2,200 → 5,000, USER.md 1,375 → 5,000, project 2,200 → 5,000
- [ ] Config: `sessionSearchEnabled: boolean` (default: true)
- [ ] Config: `sessionRetentionDays: number` (default: 90)

### What Does NOT Change

- Content scanner (guards all writes)
- Memory tool interface (add/replace/remove actions)
- System prompt injection (frozen snapshot pattern)
- Skills system (unchanged)
- Background review, correction detection, auto-consolidation (unchanged)

---

## v0.5.0 — External Sync

**Goal**: Run a local backend (SQLite) as the source of truth, with optional external sync (Mem0 or Honcho) that mirrors writes and supplements search. Based on the [Hermes MemoryManager pattern](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_manager.py).

### Architecture: Orchestrator + Sync Mirror

```
memory tool call (add/replace/remove/search)
    ↓
Content Scanner (always runs first, local)
    ↓ blocked? → return error to LLM
    ↓ passed
MemoryOrchestrator.write()
    ↓
    ├── BuiltinBackend.add()          ← always runs (source of truth)
    │
    └── ExternalSync.onWrite()        ← if configured (Mem0 or Honcho)
          ├── Mirror the write to external API
          └── If external fails → log warning, don't block

MemoryOrchestrator.search()
    ↓
    ├── BuiltinBackend.search()       ← always runs
    └── ExternalSync.search()         ← supplementary results (if configured)
    ↓
    Merge + deduplicate → return to LLM
```

### Deliverables

- [ ] `MemoryOrchestrator` — wraps `MemoryBackend` + optional `ExternalSync`
- [ ] `ExternalSync` interface in `src/types.ts`
- [ ] `Mem0Sync` — implements `ExternalSync` using Mem0 Node.js SDK
- [ ] `HonchoSync` — implements `ExternalSync` using Honcho API
- [ ] `onWrite()` mirroring — builtin writes propagate to external sync
- [ ] One-external-only enforcement — same as Hermes, prevents conflicts
- [ ] Offline fallback — if external sync `isAvailable()` returns false, skip silently
- [ ] Config: `"externalSync": "mem0" | "honcho" | "none"` with credentials
- [ ] Data export — `memory export` command to dump all entries as JSON

---

## v1.0.0 — Production Memory Substrate

**Goal**: The memory layer that any Pi agent harness can build on top of.

### Deliverables

- [ ] Smart consolidation — structured extraction with typed output (preferences, patterns, corrections, tool prefs)
- [ ] Confidence scoring — entries gain confidence over time as they're referenced, decay if never used
- [ ] Multi-agent memory — shared context between agents, scoping rules (per-user, per-project, global)
- [ ] Extensible scanner rules — users can add custom patterns to the content scanner
- [ ] `/memory-insights` upgrade — show backend type, entry count, storage stats, last sync time
- [ ] Audit log — track all memory operations with timestamps
- [ ] Import/export — migrate between backends without data loss
- [ ] Benchmarks — context injection latency, search relevance, token budget utilization

---

## Design Principles (Unchanging)

These hold across all versions:

1. **Security first** — Content scanning before any write, regardless of backend. No exceptions.
2. **Real-time saves** — The LLM can save memories mid-conversation via tool calls, not just at session end.
3. **Frozen snapshot** — Memory is injected into the system prompt once at session start. Never mutated mid-session.
4. **Crash safety** — Atomic writes for markdown, WAL mode for SQLite, graceful degradation for external backends.
5. **Zero-config start** — Install and it works with sensible defaults. Configuration is for power users.
6. **Backwards compatible** — Every new version is a drop-in upgrade. No breaking changes to the tool interface or config format without a major version bump.
7. **Hermes-compatible data format** — `§` delimiter, MEMORY.md/USER.md structure, so users migrating from Hermes keep their data.

---

## Version Timeline

```mermaid
gantt
    title Pi Hermes Memory — Release Timeline
    dateFormat YYYY-MM-DD
    axisFormat %b %Y

    section v0.1.0 ✅
    Core memory + scanner + tool + review + flush    :done, v01, 2026-04-20, 5d

    section v0.2.0 ✅
    Skill tool + procedural memory                   :done, v02a, 2026-04-27, 5d
    Auto-consolidation                               :done, v02b, after v02a, 3d
    Correction detection + immediate save            :done, v02c, after v02b, 3d
    Tool-call-aware nudge                            :done, v02d, after v02c, 2d
    Project memory + review fixes                    :done, v02e, after v02d, 2d

    section v0.3.0 — Next
    Memory interview command                         :v03a, after v02e, 2d
    Context fencing                                  :v03b, after v03a, 2d
    Memory aging                                     :v03c, after v03b, 3d
    Project memory polish                            :v03d, after v03c, 2d

    section v0.4.0
    SQLite FTS5 + session search + hybrid memory    :v04a, after v03d, 10d

    section v0.5.0
    ExternalSync + Mem0 / Honcho                     :v05a, after v04b, 10d

    section v1.0.0
    Smart consolidation + confidence                 :v1a, after v05a, 10d
    Multi-agent memory + audit log                   :v1b, after v1a, 10d
```

---

## How to Contribute

See [TASKS.md](0.1/TASKS.md) for current v0.1 work. Pick an unchecked item, mark it `[~]`, implement, mark it `[x]` with the commit hash.

For v0.2+ items, see [v0.2/TASKS.md](0.2/TASKS.md) once created. Open an issue with the version tag and describe what you want to work on.
