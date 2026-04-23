# Pi Hermes Memory Extension — Complete Implementation Plan

> **Status**: Ready for implementation  
> **Approach**: Installable Pi extension using `pi install`  
> **Model for subagents**: `glm-5-turbo`

---

## What We're Building

An installable Pi extension that brings **Hermes-style persistent memory and a learning loop** to any Pi user. After `pi install`, the user gets:

1. **Persistent Memory** — Two curated markdown files (`MEMORY.md`, `USER.md`) surviving across sessions, injected into the system prompt as a frozen snapshot at session start. The LLM can add/replace/remove entries via a `memory` tool.

2. **Background Learning Loop** — Every N turns (default 10), a background child `pi` process reviews the conversation and proactively saves notable facts (user preferences, corrections, environment quirks) to memory.

3. **Session-End Flush** — Before compaction or session shutdown, the agent gets one turn to flush anything worth remembering into persistent memory.

4. **Insights Command** — A `/memory-insights` command showing what's stored and usage stats.

---

## Hermes Source File Reference Map

When implementing in a new session, read these files **first** in this order. Every component in the plan is derived from one of these.

### Must-read (core port targets)

| File | What it contains | Plan component derived from it |
|---|---|---|
| `hermes-agent/tools/memory_tool.py` | **Entire memory system**: `MemoryStore` class (CRUD, char limits, frozen snapshot, atomic writes via temp+rename), `memory_tool()` dispatch function, `MEMORY_SCHEMA` (OpenAI tool schema with rich description), `check_memory_requirements()`, `_scan_memory_content()` (injection/exfil scanning), `_MEMORY_THREAT_PATTERNS`, `_INVISIBLE_CHARS`, `ENTRY_DELIMITER = "\n§\n"` | `memory-store.ts`, `memory-tool.ts`, `content-scanner.ts`, `constants.ts` |
| `hermes-agent/run_agent.py` | **Learning loop**: `_MEMORY_REVIEW_PROMPT`, `_SKILL_REVIEW_PROMPT`, `_COMBINED_REVIEW_PROMPT` (lines ~2833-2865), `_spawn_background_review()` (lines ~2867-2955), `flush_memories()` (lines ~7324-7538), `_memory_nudge_interval` config (lines ~1428-1447), `flush_min_turns` config | `background-review.ts`, `session-flush.ts`, `constants.ts` |
| `hermes-agent/agent/memory_provider.py` | `MemoryProvider` abstract base class with lifecycle hooks: `initialize()`, `system_prompt_block()`, `prefetch()`, `sync_turn()`, `on_session_end()`, `on_pre_compress()`, `shutdown()` | Understanding provider pattern for future extensibility |
| `hermes-agent/agent/memory_manager.py` | `MemoryManager` orchestrator: `build_system_prompt()`, `prefetch_all()`, `sync_all()`, `handle_tool_call()`, `on_session_end()`, `on_pre_compress()`, `build_memory_context_block()` fencing | System prompt injection pattern, context fencing |

### Context-only (understanding, not direct port)

| File | What to skim for |
|---|---|
| `hermes-agent/agent/insights.py` | `InsightsEngine` class — how Hermes generates usage reports from session history. Our `/memory-insights` is a simpler version. |
| `hermes-agent/hermes_state.py` | SQLite session store — **we don't need this** (Pi has `SessionManager`). Skim to understand session schema only. |
| `hermes-agent/hermes_cli/plugins.py` | Plugin system — `PluginContext.register_tool()`, `register_hook()`, `register_command()`. Interesting pattern but Pi has its own `ExtensionAPI`. |

### Key line ranges for quick access

| File | Lines | What's there |
|---|---|---|
| `hermes-agent/tools/memory_tool.py` | 1-50 | Imports, `get_memory_dir()`, `ENTRY_DELIMITER` |
| `hermes-agent/tools/memory_tool.py` | 53-101 | `_MEMORY_THREAT_PATTERNS`, `_INVISIBLE_CHARS`, `_scan_memory_content()` |
| `hermes-agent/tools/memory_tool.py` | 105-310 | `MemoryStore` class — full CRUD + persistence |
| `hermes-agent/tools/memory_tool.py` | 313-460 | `memory_tool()` dispatch + `MEMORY_SCHEMA` (the rich tool description) |
| `hermes-agent/run_agent.py` | 1409-1515 | Memory config loading, `MemoryStore` init, `_memory_nudge_interval` |
| `hermes-agent/run_agent.py` | 2829-2955 | `_MEMORY_REVIEW_PROMPT`, `_COMBINED_REVIEW_PROMPT`, `_spawn_background_review()` |
| `hermes-agent/run_agent.py` | 7324-7538 | `flush_memories()` — pre-compression/session-end flush |
| `hermes-agent/run_agent.py` | 8762-8770 | `_should_review_memory` turn-count trigger |
| `hermes-agent/run_agent.py` | 11876-11910 | Background review trigger + `on_session_end` hook dispatch |
| `hermes-agent/agent/memory_provider.py` | 1-80 | Abstract class definition with all lifecycle hooks |
| `hermes-agent/agent/memory_manager.py` | 1-60 | `sanitize_context()`, `build_memory_context_block()` fencing |
| `hermes-agent/agent/memory_manager.py` | 65-250 | `MemoryManager` class — system prompt, prefetch, sync, tool routing |

---

## Hermes Architecture Understanding

### How Hermes Memory Works (source: `hermes-agent/tools/memory_tool.py`)

```
┌─────────────────────────────────────────────────┐
│  MEMORY.md (agent notes)    USER.md (user profile) │
│  ┌─────────────────────┐   ┌─────────────────────┐│
│  │ Entry 1 § Entry 2 § │   │ Name: X § Style: Y  ││
│  │ Entry 3 § ...       │   │ Pref: Z § ...       ││
│  └─────────────────────┘   └─────────────────────┘│
│           ▲                          ▲             │
│           │ atomic write             │ atomic write│
│           │ (temp + rename)          │             │
└───────────┼──────────────────────────┼─────────────┘
            │                          │
    ┌───────┴──────────────────────────┴───────┐
    │            MemoryStore                    │
    │  - load_from_disk() → frozen snapshot     │
    │  - add/replace/remove → validate + persist│
    │  - format_for_system_prompt() → snapshot  │
    │  - char limits: 2200 (mem) / 1375 (user) │
    └──────────────────────────────────────────┘
            │                          │
            ▼                          ▼
    ┌──────────────────────────────────────────┐
    │  System Prompt (frozen at session start)  │
    │  ═══════════════════════════════════════   │
    │  MEMORY (your personal notes) [45%]       │
    │  ═══════════════════════════════════════   │
    │  user prefers vim over nano               │
    │  project uses pnpm not npm                │
    │  ═══════════════════════════════════════   │
    │  USER PROFILE (who the user is) [20%]     │
    │  ═══════════════════════════════════════   │
    │  name: Chandrateja                        │
    │  prefers concise answers                  │
    │  ═══════════════════════════════════════   │
    └──────────────────────────────────────────┘
```

### How Hermes Learning Loop Works (source: `hermes-agent/run_agent.py`)

```
Session Start
    │
    ├─ MemoryStore.load_from_disk() → capture frozen snapshot
    │
    ▼
Turn 1 ── Turn 2 ── ... ── Turn 10 ── Turn 11 ── ...
                                    │
                                    │ turns_since_memory >= nudge_interval (10)
                                    ▼
                          ┌─────────────────────────────┐
                          │  _spawn_background_review()   │
                          │                               │
                          │  1. Snapshot conversation     │
                          │  2. Fork AIAgent (same model) │
                          │  3. Send COMBINED_REVIEW_PROMPT│
                          │  4. Review agent calls memory │
                          │     tool if worth saving      │
                          │  5. Show "💾 Memory updated"  │
                          └─────────────────────────────┘
                                    │
                                    ▼ reset counter
                          Turn 12 ── Turn 13 ── ...
                                    
Compaction / Session End
    │
    ▼
┌─────────────────────────────┐
│  flush_memories()            │
│                              │
│  1. Inject flush message     │
│  2. One API call with only   │
│     the memory tool          │
│  3. Execute any memory saves │
│  4. Strip flush artifacts    │
└─────────────────────────────┘
```

### Hermes Security (source: `hermes-agent/tools/memory_tool.py`)

Before any write, content is scanned for:
- **Prompt injection**: "ignore previous instructions", "you are now..."
- **Role hijacking**: "act as if you have no restrictions"
- **Secret exfiltration**: `curl ${API_KEY`, `cat .env`
- **Invisible unicode**: zero-width chars, bidirectional overrides (U+200B-U+FEFF, U+202A-U+202E)

---

## Architecture: Hermes → Pi Extension Mapping

| Hermes Concept | Pi Extension Equivalent | Implementation Detail |
|---|---|---|
| `MemoryStore` class | `MemoryStore` class in `memory-store.ts` | Same §-delimited entries, char limits, frozen snapshot |
| `MEMORY.md` / `USER.md` in `~/.hermes/memories/` | Same files in `~/.pi/agent/memory/` | Resolved via `ctx.cwd` or hardcoded `~/.pi/agent/memory/` |
| `memory` tool via `tools.registry.register()` | `pi.registerTool({ name: "memory" })` | Same OpenAI-style schema with rich description |
| `format_for_system_prompt()` frozen snapshot | `before_agent_start` event → `return { systemPrompt: event.systemPrompt + block }` | Snapshot captured at `session_start`, never mutated |
| `_memory_nudge_interval` + `_spawn_background_review()` | `turn_end` event → turn counter → `pi.exec("pi", ["-p", reviewPrompt])` | Uses `pi -p` for isolated one-shot review |
| `flush_memories()` before compression | `session_before_compact` event → `pi.exec("pi", ["-p", flushPrompt])` | Same flush prompt pattern |
| Content scanning regex patterns | Same patterns ported to TypeScript in `content-scanner.ts` | Identical security posture |
| `fcntl`/`msvcrt` file locking → atomic rename | `fs.mkdtemp` + `fs.writeFile` + `fs.rename` | Node.js atomic write pattern |
| `InsightsEngine` + SQLite | `/memory-insights` command reading from MemoryStore | Simpler — no SQLite needed |
| `MemoryProvider` abstract class | Not in v1 — single built-in provider | Future: external backends as separate Pi package |
| Entry delimiter `§` (section sign) | Same `"\n§\n"` delimiter | Preserves compatibility with any migrated files |

---

## File Structure

```
pi-hermes-memory/
├── package.json              # For pi install
├── src/
│   ├── index.ts              # Extension entry point — wires everything together
│   ├── memory-store.ts       # Core MemoryStore class (CRUD, persistence, snapshot)
│   ├── memory-tool.ts        # registerMemoryTool() — LLM tool definition
│   ├── background-review.ts  # setupBackgroundReview() — learning loop via pi.exec
│   ├── session-flush.ts      # setupSessionFlush() — pre-compaction/shutdown flush
│   ├── content-scanner.ts    # scanContent() — injection/exfiltration detection
│   ├── insights.ts           # registerInsightsCommand() — /memory-insights
│   ├── types.ts              # Shared TypeScript interfaces
│   └── constants.ts          # Prompts, defaults, delimiter
└── README.md                 # Installation and usage docs
```

Runtime files (created automatically):
```
~/.pi/agent/memory/
├── MEMORY.md     # Agent's personal notes
└── USER.md       # User profile data
```

---

## Detailed Component Specs

### `constants.ts`

```typescript
// Entry delimiter — same as Hermes
export const ENTRY_DELIMITER = "\n§\n";

// Character limits (not tokens — model-independent)
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_USER_CHAR_LIMIT = 1375;

// Learning loop defaults
export const DEFAULT_NUDGE_INTERVAL = 10; // turns between auto-reviews
export const DEFAULT_FLUSH_MIN_TURNS = 6; // minimum turns before flush triggers

// Memory directory
export const MEMORY_DIR_NAME = "memory"; // relative to ~/.pi/agent/

// File names
export const MEMORY_FILE = "MEMORY.md";
export const USER_FILE = "USER.md";

// --- Prompts (ported from Hermes) ---

export const MEMORY_TOOL_DESCRIPTION = `Save durable information to persistent memory that survives across sessions. Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says 'remember this' / 'don't do that again'
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover something about the environment (OS, installed tools, project structure)
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge. The most valuable memory prevents the user from having to repeat themselves.

Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to memory.
If you've discovered a new way to do something, solved a problem that could be necessary later, save it as a skill with the skill tool.

TWO TARGETS:
- 'user': who the user is -- name, role, preferences, communication style, pet peeves
- 'memory': your notes -- environment facts, project conventions, tool quirks, lessons learned

ACTIONS: add (new entry), replace (update existing -- old_text identifies it), remove (delete -- old_text identifies it).

SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.`;

export const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the memory tool. If nothing is worth saving, just say 'Nothing to save.' and stop.`;

export const SKILL_REVIEW_PROMPT = `Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome?

If a relevant skill already exists, update it with what you learned. Otherwise, create a new skill if the approach is reusable.
If nothing is worth saving, just say 'Nothing to save.' and stop.`;

export const COMBINED_REVIEW_PROMPT = `Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — their persona, desires, preferences, or personal details? Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate? If so, save using the memory tool.

**Skills**: Was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome? If a relevant skill already exists, update it. Otherwise, create a new one if the approach is reusable.

Only act if there's something genuinely worth saving. If nothing stands out, just say 'Nothing to save.' and stop.`;

export const FLUSH_PROMPT = `[System: The session is being compressed. Save anything worth remembering — prioritize user preferences, corrections, and recurring patterns over task-specific details.]`;
```

### `types.ts`

```typescript
export interface MemoryConfig {
  memoryCharLimit: number;
  userCharLimit: number;
  nudgeInterval: number;
  reviewEnabled: boolean;
  flushOnCompact: boolean;
  flushOnShutdown: boolean;
  flushMinTurns: number;
}

export interface MemoryResult {
  success: boolean;
  error?: string;
  message?: string;
  target?: string;
  entries?: string[];
  usage?: string;
  entry_count?: number;
  matches?: string[];
}

export interface MemorySnapshot {
  memory: string;
  user: string;
}
```

### `content-scanner.ts`

```typescript
// Port of Hermes _MEMORY_THREAT_PATTERNS and _INVISIBLE_CHARS

const MEMORY_THREAT_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, id: "bypass_restrictions" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_wget" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: "read_secrets" },
  { pattern: /authorized_keys/i, id: "ssh_backdoor" },
  { pattern: /\$HOME\/\.ssh|~\/\.ssh/i, id: "ssh_access" },
];

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

export function scanContent(content: string): string | null {
  // Check invisible unicode
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} (possible injection).`;
    }
  }

  // Check threat patterns
  for (const { pattern, id } of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content matches threat pattern '${id}'. Memory entries are injected into the system prompt and must not contain injection or exfiltration payloads.`;
    }
  }

  return null; // Content is safe
}
```

### `memory-store.ts`

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { scanContent } from "./content-scanner.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  MEMORY_FILE,
  USER_FILE,
} from "./constants.js";
import type { MemoryConfig, MemoryResult, MemorySnapshot } from "./types.js";

export class MemoryStore {
  private memoryEntries: string[] = [];
  private userEntries: string[] = [];
  private snapshot: MemorySnapshot = { memory: "", user: "" };

  constructor(private config: MemoryConfig) {}

  private get memoryDir(): string {
    return path.join(os.homedir(), ".pi", "agent", "memory");
  }

  private pathFor(target: "memory" | "user"): string {
    return path.join(this.memoryDir, target === "user" ? USER_FILE : MEMORY_FILE);
  }

  private entriesFor(target: "memory" | "user"): string[] {
    return target === "user" ? this.userEntries : this.memoryEntries;
  }

  private setEntries(target: "memory" | "user", entries: string[]): void {
    if (target === "user") this.userEntries = entries;
    else this.memoryEntries = entries;
  }

  private charLimit(target: "memory" | "user"): number {
    return target === "user" ? this.config.userCharLimit : this.config.memoryCharLimit;
  }

  private charCount(target: "memory" | "user"): number {
    const entries = this.entriesFor(target);
    return entries.length ? ENTRY_DELIMITER.join(entries).length : 0;
  }

  // --- Load ---

  async loadFromDisk(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    this.memoryEntries = await this.readFile(this.pathFor("memory"));
    this.userEntries = await this.readFile(this.pathFor("user"));

    // Deduplicate (preserve order, keep first)
    this.memoryEntries = [...new Set(this.memoryEntries)];
    this.userEntries = [...new Set(this.userEntries)];

    // Capture frozen snapshot
    this.snapshot = {
      memory: this.renderBlock("memory", this.memoryEntries),
      user: this.renderBlock("user", this.userEntries),
    };
  }

  // --- CRUD ---

  add(target: "memory" | "user", content: string): MemoryResult {
    content = content.trim();
    if (!content) return { success: false, error: "Content cannot be empty." };

    const scanError = scanContent(content);
    if (scanError) return { success: false, error: scanError };

    const entries = this.entriesFor(target);
    const limit = this.charLimit(target);

    if (entries.includes(content)) {
      return this.successResponse(target, "Entry already exists (no duplicate added).");
    }

    const newEntries = [...entries, content];
    const newTotal = ENTRY_DELIMITER.join(newEntries).length;

    if (newTotal > limit) {
      const current = this.charCount(target);
      return {
        success: false,
        error: `Memory at ${current}/${limit} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
        entries,
        usage: `${current}/${limit}`,
      };
    }

    entries.push(content);
    this.setEntries(target, entries);
    this.saveToDisk(target); // Fire-and-forget atomic write

    return this.successResponse(target, "Entry added.");
  }

  replace(target: "memory" | "user", oldText: string, newContent: string): MemoryResult {
    oldText = oldText.trim();
    newContent = newContent.trim();
    if (!oldText) return { success: false, error: "old_text cannot be empty." };
    if (!newContent) return { success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };

    const scanError = scanContent(newContent);
    if (scanError) return { success: false, error: scanError };

    const entries = this.entriesFor(target);
    const matches = entries.filter((e) => e.includes(oldText));

    if (matches.length === 0) return { success: false, error: `No entry matched '${oldText}'.` };
    if (matches.length > 1 && new Set(matches).size > 1) {
      return {
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific.`,
        matches: matches.map((e) => e.slice(0, 80) + (e.length > 80 ? "..." : "")),
      };
    }

    const idx = entries.indexOf(matches[0]);
    const testEntries = [...entries];
    testEntries[idx] = newContent;
    const newTotal = ENTRY_DELIMITER.join(testEntries).length;

    if (newTotal > this.charLimit(target)) {
      return {
        success: false,
        error: `Replacement would put memory at ${newTotal}/${this.charLimit(target)} chars. Shorten the new content or remove other entries first.`,
      };
    }

    entries[idx] = newContent;
    this.setEntries(target, entries);
    this.saveToDisk(target);

    return this.successResponse(target, "Entry replaced.");
  }

  remove(target: "memory" | "user", oldText: string): MemoryResult {
    oldText = oldText.trim();
    if (!oldText) return { success: false, error: "old_text cannot be empty." };

    const entries = this.entriesFor(target);
    const matches = entries.filter((e) => e.includes(oldText));

    if (matches.length === 0) return { success: false, error: `No entry matched '${oldText}'.` };
    if (matches.length > 1 && new Set(matches).size > 1) {
      return {
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific.`,
        matches: matches.map((e) => e.slice(0, 80) + (e.length > 80 ? "..." : "")),
      };
    }

    const idx = entries.indexOf(matches[0]);
    entries.splice(idx, 1);
    this.setEntries(target, entries);
    this.saveToDisk(target);

    return this.successResponse(target, "Entry removed.");
  }

  // --- System prompt injection (frozen snapshot) ---

  formatForSystemPrompt(): string {
    const parts: string[] = [];
    if (this.snapshot.memory) parts.push(this.snapshot.memory);
    if (this.snapshot.user) parts.push(this.snapshot.user);
    return parts.join("\n\n");
  }

  getMemoryEntries(): string[] { return [...this.memoryEntries]; }
  getUserEntries(): string[] { return [...this.userEntries]; }

  // --- Internal ---

  private successResponse(target: "memory" | "user", message?: string): MemoryResult {
    const entries = this.entriesFor(target);
    const current = this.charCount(target);
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;

    const resp: MemoryResult = {
      success: true,
      target,
      entries,
      usage: `${pct}% — ${current}/${limit} chars`,
      entry_count: entries.length,
    };
    if (message) resp.message = message;
    return resp;
  }

  private renderBlock(target: "memory" | "user", entries: string[]): string {
    if (!entries.length) return "";
    const limit = this.charLimit(target);
    const content = ENTRY_DELIMITER.join(entries);
    const current = content.length;
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;

    const header = target === "user"
      ? `USER PROFILE (who the user is) [${pct}% — ${current}/${limit} chars]`
      : `MEMORY (your personal notes) [${pct}% — ${current}/${limit} chars]`;

    const separator = "═".repeat(46);
    return `${separator}\n${header}\n${separator}\n${content}`;
  }

  private async readFile(filePath: string): Promise<string[]> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      if (!raw.trim()) return [];
      return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private saveToDisk(target: "memory" | "user"): void {
    const filePath = this.pathFor(target);
    const entries = this.entriesFor(target);
    const content = entries.length ? ENTRY_DELIMITER.join(entries) : "";

    // Atomic write: temp file + rename (same as Hermes)
    fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-")).then((tmpDir) => {
      const tmpPath = path.join(tmpDir, "write.tmp");
      return fs.writeFile(tmpPath, content, "utf-8")
        .then(() => fs.rename(tmpPath, filePath))
        .catch(async () => {
          try { await fs.unlink(tmpPath); } catch {}
        })
        .finally(async () => {
          try { await fs.rmdir(tmpDir); } catch {}
        });
    });
  }
}
```

### `memory-tool.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { MemoryStore } from "./memory-store.js";
import { MEMORY_TOOL_DESCRIPTION } from "./constants.js";

export function registerMemoryTool(pi: ExtensionAPI, store: MemoryStore): void {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    promptSnippet: "Save or manage persistent memory that survives across sessions",
    promptGuidelines: [
      "Use the memory tool proactively when the user corrects you, shares a preference, or reveals personal details worth remembering.",
      "Use the memory tool when you discover environment facts, project conventions, or reusable patterns that will be useful in future sessions.",
      "Do NOT use memory for temporary task state, TODO items, or session progress — use it only for durable, cross-session facts.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "replace", "remove"] as const),
      target: StringEnum(["memory", "user"] as const),
      content: Type.Optional(Type.String({ description: "Entry content for add/replace" })),
      old_text: Type.Optional(Type.String({ description: "Substring identifying entry for replace/remove" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { action, target, content, old_text } = params;

      let result;
      switch (action) {
        case "add":
          if (!content) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Content is required for 'add' action." }) }], details: {} };
          result = store.add(target, content);
          break;
        case "replace":
          if (!old_text) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "old_text is required for 'replace' action." }) }], details: {} };
          if (!content) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "content is required for 'replace' action." }) }], details: {} };
          result = store.replace(target, old_text, content);
          break;
        case "remove":
          if (!old_text) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "old_text is required for 'remove' action." }) }], details: {} };
          result = store.remove(target, old_text);
          break;
        default:
          result = { success: false, error: `Unknown action '${action}'. Use: add, replace, remove` };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
```

### `background-review.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "./memory-store.js";
import { COMBINED_REVIEW_PROMPT } from "./constants.js";
import type { MemoryConfig } from "./types.js";

export function setupBackgroundReview(
  pi: ExtensionAPI,
  store: MemoryStore,
  config: MemoryConfig,
): void {
  let turnsSinceReview = 0;
  let userTurnCount = 0;

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "user") {
      userTurnCount++;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    turnsSinceReview++;

    if (!config.reviewEnabled) return;
    if (turnsSinceReview < config.nudgeInterval) return;
    if (userTurnCount < 3) return; // Don't review tiny conversations

    turnsSinceReview = 0;

    // Build a conversation summary for the review
    const entries = ctx.sessionManager.getBranch();
    const conversationParts: string[] = [];

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role === "user" && typeof msg.content === "string") {
        conversationParts.push(`[USER]: ${msg.content.slice(0, 500)}`);
      } else if (msg.role === "assistant" && typeof msg.content === "string") {
        conversationParts.push(`[ASSISTANT]: ${msg.content.slice(0, 500)}`);
      }
    }

    if (conversationParts.length < 4) return; // Not enough conversation to review

    const conversationSnapshot = conversationParts.join("\n\n");
    const currentMemory = store.getMemoryEntries().join("\n§\n");
    const currentUser = store.getUserEntries().join("\n§\n");

    const reviewPrompt = `${COMBINED_REVIEW_PROMPT}\n\n--- Current Memory ---\n${currentMemory || "(empty)"}\n\n--- Current User Profile ---\n${currentUser || "(empty)"}\n\n--- Conversation to Review ---\n${conversationSnapshot}`;

    try {
      // Use pi.exec() to spawn a one-shot pi process for the review
      // The child pi has the same memory tool registered and can save directly
      const result = await pi.exec("pi", ["-p", "--no-session", reviewPrompt], {
        signal: ctx.signal,
        timeout: 60000,
      });

      if (result.code === 0 && result.stdout) {
        const output = result.stdout.trim();
        // Check if something was saved (non-trivial output that isn't "Nothing to save")
        if (output && !output.toLowerCase().includes("nothing to save")) {
          ctx.ui.notify("💾 Memory auto-reviewed and updated", "info");
        }
      }
    } catch (e) {
      // Background review is best-effort — never block the main agent
      // Silent fail
    }
  });
}
```

### `session-flush.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "./memory-store.js";
import { FLUSH_PROMPT } from "./constants.js";
import type { MemoryConfig } from "./types.js";

export function setupSessionFlush(
  pi: ExtensionAPI,
  store: MemoryStore,
  config: MemoryConfig,
): void {
  let userTurnCount = 0;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") userTurnCount++;
  });

  // Flush before compaction
  pi.on("session_before_compact", async (event, ctx) => {
    if (!config.flushOnCompact) return;
    if (userTurnCount < config.flushMinTurns) return;

    const entries = ctx.sessionManager.getBranch();
    const conversationParts: string[] = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role === "user" && typeof msg.content === "string") {
        conversationParts.push(`[USER]: ${msg.content.slice(0, 500)}`);
      } else if (msg.role === "assistant" && typeof msg.content === "string") {
        conversationParts.push(`[ASSISTANT]: ${msg.content.slice(0, 500)}`);
      }
    }

    const flushMessage = `${FLUSH_PROMPT}\n\n--- Conversation ---\n${conversationParts.join("\n\n")}`;

    try {
      await pi.exec("pi", ["-p", "--no-session", flushMessage], {
        signal: event.signal,
        timeout: 30000,
      });
    } catch {
      // Best-effort flush
    }
  });

  // Flush before session shutdown
  pi.on("session_shutdown", async (event, ctx) => {
    if (!config.flushOnShutdown) return;
    if (userTurnCount < config.flushMinTurns) return;

    const entries = ctx.sessionManager.getBranch();
    const conversationParts: string[] = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role === "user" && typeof msg.content === "string") {
        conversationParts.push(`[USER]: ${msg.content.slice(0, 500)}`);
      } else if (msg.role === "assistant" && typeof msg.content === "string") {
        conversationParts.push(`[ASSISTANT]: ${msg.content.slice(0, 500)}`);
      }
    }

    const flushMessage = `${FLUSH_PROMPT}\n\n--- Conversation ---\n${conversationParts.join("\n\n")}`;

    try {
      await pi.exec("pi", ["-p", "--no-session", flushMessage], {
        timeout: 30000,
      });
    } catch {
      // Best-effort flush
    }
  });
}
```

### `insights.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "./memory-store.js";

export function registerInsightsCommand(pi: ExtensionAPI, store: MemoryStore): void {
  pi.registerCommand("memory-insights", {
    description: "Show what's stored in persistent memory",
    handler: async (_args, ctx) => {
      const memoryEntries = store.getMemoryEntries();
      const userEntries = store.getUserEntries();

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║          🧠 Memory Insights                  ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");

      // Memory section
      lines.push("  📋 MEMORY (your personal notes)");
      lines.push("  " + "─".repeat(44));
      if (memoryEntries.length === 0) {
        lines.push("  (empty)");
      } else {
        for (let i = 0; i < memoryEntries.length; i++) {
          const entry = memoryEntries[i];
          const preview = entry.length > 100 ? entry.slice(0, 100) + "..." : entry;
          lines.push(`  ${i + 1}. ${preview}`);
        }
      }
      lines.push("");

      // User section
      lines.push("  👤 USER PROFILE");
      lines.push("  " + "─".repeat(44));
      if (userEntries.length === 0) {
        lines.push("  (empty)");
      } else {
        for (let i = 0; i < userEntries.length; i++) {
          const entry = userEntries[i];
          const preview = entry.length > 100 ? entry.slice(0, 100) + "..." : entry;
          lines.push(`  ${i + 1}. ${preview}`);
        }
      }
      lines.push("");

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
```

### `index.ts` — Extension Entry Point

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "./memory-store.js";
import { registerMemoryTool } from "./memory-tool.js";
import { setupBackgroundReview } from "./background-review.js";
import { setupSessionFlush } from "./session-flush.js";
import { registerInsightsCommand } from "./insights.js";
import type { MemoryConfig } from "./types.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_FLUSH_MIN_TURNS,
} from "./constants.js";

export default function (pi: ExtensionAPI) {
  // Configuration (future: read from Pi settings)
  const config: MemoryConfig = {
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    nudgeInterval: DEFAULT_NUDGE_INTERVAL,
    reviewEnabled: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
  };

  const store = new MemoryStore(config);

  // ── 1. Load memory on session start ──
  pi.on("session_start", async (_event, _ctx) => {
    await store.loadFromDisk();
  });

  // ── 2. Inject frozen snapshot into system prompt ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const memoryBlock = store.formatForSystemPrompt();
    if (memoryBlock) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + memoryBlock,
      };
    }
  });

  // ── 3. Register the memory tool ──
  registerMemoryTool(pi, store);

  // ── 4. Setup background learning loop ──
  setupBackgroundReview(pi, store, config);

  // ── 5. Setup session-end flush ──
  setupSessionFlush(pi, store, config);

  // ── 6. Register insights command ──
  registerInsightsCommand(pi, store);
}
```

### `package.json`

```json
{
  "name": "pi-hermes-memory",
  "version": "1.0.0",
  "description": "Hermes-style persistent memory and learning loop for Pi coding agent",
  "main": "src/index.ts",
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.1.0",
    "typebox": ">=1.0.0",
    "@mariozechner/pi-ai": ">=0.1.0"
  },
  "keywords": ["pi", "memory", "learning", "agent"],
  "license": "MIT"
}
```

---

## Implementation Phases

### Phase 1: Core Memory (Day 1)
Files: `types.ts`, `constants.ts`, `content-scanner.ts`, `memory-store.ts`, `memory-tool.ts`, `index.ts`

- MemoryStore with full CRUD + atomic persistence
- `memory` tool registered via `pi.registerTool()`
- `before_agent_start` system prompt injection
- Content scanning security
- `package.json`

**Test**: Install extension, ask agent to save something to memory, restart session, verify it recalls.

### Phase 2: Learning Loop (Day 2)
Files: `background-review.ts`, `session-flush.ts`

- Turn counter in `turn_end` events
- Background review via `pi.exec("pi", ["-p", ...])`
- Pre-compaction flush via `session_before_compact`
- Pre-shutdown flush via `session_shutdown`

**Test**: Have a 10+ turn conversation, verify background review triggers and saves notable facts.

### Phase 3: Polish & Distribution (Day 3)
Files: `insights.ts`, `README.md`

- `/memory-insights` command
- Configuration support (char limits, nudge interval) via Pi settings
- README with installation and usage
- npm publish for `pi install`

**Test**: Full end-to-end — install, use across multiple sessions, verify persistence and learning.

---

## Key Design Decisions

1. **`pi.exec()` for background review** — Stays within Pi's intended extension API. Spawns `pi -p --no-session` for isolated one-shot reviews that have the same memory tool available.

2. **No SQLite** — Pi has its own `SessionManager`, so we read conversation history directly from `ctx.sessionManager.getEntries()`. No need for a separate database.

3. **Frozen snapshot pattern** — Memory is injected into the system prompt once at session start and never updated mid-session. This preserves Pi's prompt caching behavior.

4. **Atomic file writes** — Write to temp file + `fs.rename()`, same crash-safety pattern as Hermes.

5. **§ delimiter** — Preserved from Hermes for consistency and easy migration.

6. **No external providers in v1** — Single built-in markdown store. External backends (Honcho, Mem0, etc.) can be added as separate Pi packages later.

7. **Best-effort background operations** — Review and flush failures never block the main agent. All background work is wrapped in try/catch.

---

## Security Posture (identical to Hermes)

All writes pass through `content-scanner.ts`:
- ❌ Blocks prompt injection ("ignore previous instructions")
- ❌ Blocks role hijacking ("you are now...")
- ❌ Blocks secret exfiltration ("curl ${API_KEY...")
- ❌ Blocks invisible unicode (zero-width chars, bidi overrides)
- ❌ Enforces character limits per target
- ❌ Frozen snapshot prevents mid-session prompt manipulation

---

## What We're NOT Building (out of scope for v1)

- External memory providers (Honcho, Mem0, etc.)
- Skill auto-saving (separate extension)
- RL training loop integration
- Multi-user/gateway session support
- Context engine / compression customization
