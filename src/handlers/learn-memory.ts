/**
 * Learn memory tool command — /learn-memory-tool teaches users about the memory system.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const LEARN_MEMORY_CONTENT = `# Pi Hermes Memory — Quick Guide

## What Gets Saved

| Type | File | What Goes Here | Limit |
|---|---|---|---|
| **Memory** | MEMORY.md | Facts — env details, project conventions, tool quirks | 5,000 chars |
| **User Profile** | USER.md | Who you are — name, preferences, communication style | 5,000 chars |
| **Skills** | skills/*.md | Procedures — how to debug, deploy, test | Unlimited |
| **Extended Memory** | sessions.db | Searchable memories beyond the core limit | Unlimited |

## Tools Available

| Tool | What It Does |
|---|---|
| memory (add/replace/remove) | Save, update, or delete memories |
| skill (create/view/patch/edit/delete) | Save reusable procedures |
| session_search | Search past conversations across all sessions |
| memory_search | Search extended memory store (unlimited) |

## Commands

| Command | What It Does |
|---|---|
| /memory-insights | Shows everything stored in memory |
| /memory-skills | Lists all saved skills |
| /memory-consolidate | Manually trigger memory cleanup |
| /memory-interview | Answer questions to pre-fill your profile |
| /memory-switch-project | List all project memories |
| /memory-index-sessions | Import past sessions for search |

## Best Practices

**DO save:**
- User preferences ("prefers pnpm", "uses vim", "likes concise answers")
- Environment facts ("macOS M1", "Node 20", "project uses Prisma")
- Corrections ("don't use npm — use pnpm", "always run tests first")
- Project conventions ("monorepo with turborepo", "conventional commits")

**DON'T save:**
- Task progress ("finished implementing auth") — temporary
- Session outcomes ("PR #42 was merged") — belongs in git history
- Temporary state ("currently debugging X") — will be irrelevant soon

## How Memory Flows

1. Session starts → Core memory injected into system prompt
2. During conversation → Agent saves via memory tool
3. Every 10 turns → Background review saves noteworthy items
4. On correction → Immediate save
5. When full → Auto-consolidation merges entries
6. Session ends → Final flush

## Two-Tier Architecture

- Global (always injected): ~/.pi/agent/memory/ — your name, preferences, tools
- Project (when cwd matches): ~/.pi/agent/<project>/ — project-specific facts

## Troubleshooting

- "Memory is full" → /memory-consolidate to merge entries
- "Can't find something" → memory_search to search extended store
- "Agent forgot something" → Check /memory-insights, tell agent "remember that X"
- "Want to edit manually" → Files are plain markdown at ~/.pi/agent/memory/`;

export function registerLearnMemoryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("learn-memory-tool", {
    description: "Learn how to use the pi-hermes-memory extension effectively",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(LEARN_MEMORY_CONTENT, 'info');
    },
  });
}
