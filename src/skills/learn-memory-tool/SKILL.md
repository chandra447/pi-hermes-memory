---
name: learn-memory-tool
description: Learn how to use the pi-hermes-memory extension effectively — when to save memories, how to search, and best practices for persistent memory.
version: 1
created: 2026-05-03
updated: 2026-05-03
---

## When to Use

When a user asks about the memory system, how to use it, or when they seem confused about what gets remembered. Also useful for onboarding new users to the extension.

## Overview

Pi Hermes Memory gives your AI agent persistent memory across sessions. Here's what it does:

### What Gets Saved

| Type | File | What Goes Here | Limit |
|---|---|---|---|
| **Memory** | `MEMORY.md` | Facts — env details, project conventions, tool quirks | 5,000 chars |
| **User Profile** | `USER.md` | Who you are — name, preferences, communication style | 5,000 chars |
| **Skills** | `skills/*.md` | Procedures — *how* to debug, deploy, test | Unlimited |
| **Extended Memory** | `sessions.db` | Searchable memories beyond the core limit | Unlimited |

### The `memory` Tool

The agent has a `memory` tool with these actions:

| Action | Target | What It Does |
|---|---|---|
| `add` | `memory` or `user` | Append a new entry |
| `replace` | `memory` or `user` | Update an existing entry (matched by substring) |
| `remove` | `memory` or `user` | Delete an entry (matched by substring) |

### The `skill` Tool

For saving reusable procedures:

| Action | What It Does |
|---|---|
| `create` | Save a new skill |
| `view` | Read a skill or list all skills |
| `patch` | Update one section of a skill |
| `edit` | Replace description and/or body |
| `delete` | Remove a skill |

### Search Tools

| Tool | What It Does |
|---|---|
| `session_search` | Search past conversations across all sessions |
| `memory_search` | Search extended memory store (unlimited capacity) |

### Commands

| Command | What It Does |
|---|---|
| `/memory-insights` | Shows everything stored in memory and user profile |
| `/memory-skills` | Lists all agent-created skills |
| `/memory-consolidate` | Manually trigger memory consolidation |
| `/memory-interview` | Answer questions to pre-fill your user profile |
| `/memory-switch-project` | List all project memories |
| `/memory-index-sessions` | Import past sessions for search |

## Best Practices

### What TO Save

- **User preferences**: "prefers pnpm over npm", "uses vim", "likes concise answers"
- **Environment facts**: "macOS M1", "Node 20", "project uses Prisma"
- **Corrections**: "don't use npm — use pnpm", "always run tests first"
- **Project conventions**: "monorepo with turborepo", "conventional commits"
- **Tool quirks**: "CI needs `--frozen-lockfile`", "deploy script is in scripts/deploy.sh"

### What NOT to Save

- **Task progress**: "finished implementing auth" — this is temporary
- **Session outcomes**: "PR #42 was merged" — this belongs in git history
- **Temporary state**: "currently debugging the test failure" — will be irrelevant soon
- **Large code blocks**: Use skills instead for procedures

### How Memory Flows

1. **Session starts**: Core memory (MEMORY.md + USER.md) is injected into the system prompt
2. **During conversation**: Agent saves memories via the `memory` tool
3. **Every 10 turns or 15 tool calls**: Background review saves anything noteworthy
4. **When you correct the agent**: Immediate save — no waiting
5. **When memory is full**: Auto-consolidation merges and prunes entries
6. **Session ends**: One last flush before shutdown

### Two-Tier Architecture

- **Global memory** (`~/.pi/agent/memory/`): Always injected — your name, preferences, tools
- **Project memory** (`~/.pi/agent/<project>/`): Injected when cwd matches — project-specific facts

### Memory Aging

Entries carry timestamps. When consolidating, the agent knows which entries are stale (created long ago, never referenced) and which are fresh.

### Context Fencing

Memory is wrapped in `<memory-context>` XML tags so the LLM never treats stored facts as user instructions. This prevents injection attacks through stored memory.

## Troubleshooting

### "Memory is full"
Run `/memory-consolidate` to manually merge entries. Or let auto-consolidation handle it.

### "I can't find what I'm looking for"
Use `memory_search` to search the extended store, or `session_search` to search past conversations.

### "The agent forgot something"
Check `/memory-insights` to see what's stored. If it's not there, the agent may not have saved it yet. You can tell the agent: "remember that X".

### "I want to edit memory manually"
Memory files are plain markdown at `~/.pi/agent/memory/MEMORY.md` and `USER.md`. Edit them directly if you want.

## Verification

After reading this skill, the user should understand:
1. What the memory tool does and when to use it
2. The difference between memory, user profile, skills, and extended memory
3. How to search across sessions and extended memory
4. Best practices for what to save and what not to save
