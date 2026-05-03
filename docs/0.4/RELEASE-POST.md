# Your AI Agent Just Got a Brain Upgrade: Pi Hermes Memory v0.4

**TL;DR**: Your coding agent can now remember every conversation you've ever had with it. Search through weeks of context in milliseconds. Never lose an insight again.

---

## The Problem

Every time you start a new session with an AI coding agent, it forgets everything. That debugging session from last Tuesday? Gone. The architecture decision you discussed for 2 hours? Vanished. The user preferences you explained 5 times? You'll explain them a 6th.

You're not just losing context — you're losing **hours of accumulated knowledge**.

## The Solution: Persistent Memory + Session Search

Pi Hermes Memory v0.4 introduces **SQLite-powered session history** with full-text search. Your agent now has:

- 🧠 **Persistent memory** that survives across sessions (MEMORY.md + USER.md)
- 🔍 **Full-text search** across every conversation you've ever had
- 📦 **Unlimited extended memory** via SQLite — no more "memory is full" errors
- 🔎 **Two search tools** — `session_search` for conversations, `memory_search` for facts
- 📊 **5,000 character limits** (up from 2,200) — more room for context

## What Changed: Before vs After

### Before v0.4
```
You: "What did we discuss about the auth flow last week?"
Agent: "I don't have access to previous sessions."
You: *sighs, re-explains everything*
```

### After v0.4
```
You: "What did we discuss about the auth flow last week?"
Agent: *searches session history*
       "Last Tuesday we discussed implementing JWT with refresh tokens.
        You preferred httpOnly cookies over localStorage. We also decided
        to use the auth0 SDK. Want me to continue from there?"
You: *continues where you left off*
```

## New Capabilities Deep Dive

### 1. Session History Search

Every conversation is automatically indexed into SQLite with FTS5 (full-text search 5). When you ask about something from the past, your agent searches across all sessions instantly.

**How it works:**
- Sessions are indexed on shutdown (automatic)
- Full-text search via FTS5 — fast, keyword-based
- Filter by project, role (user/assistant), or date

**Try it:**
```
"What was that error we fixed with the database connection?"
"Find the PR where we added the secret scanning feature"
"What testing approach did we use for the memory store?"
```

### 2. Extended Memory Store

The old memory had a 2,200 character limit. Now it's 5,000 — but more importantly, there's an **unlimited extended store** in SQLite. When core memory fills up, entries are preserved in the extended store and remain searchable.

**What this means:**
- Core memory (MEMORY.md): 5,000 chars — always in context
- Extended memory (SQLite): Unlimited — searchable on demand
- No more losing memories to consolidation

### 3. Two-Tier Search Architecture

| Tool | What It Searches | When to Use |
|---|---|---|
| `session_search` | Past conversations | "What did we discuss about X?" |
| `memory_search` | Extended memory store | "What do I know about X?" |

The agent decides which tool to use based on your question. But you can also invoke them directly.

### 4. Hybrid Memory Design

```
Always in Context (5,000 chars each)
┌─────────────────────────────────────┐
│ MEMORY.md — Facts, conventions      │
│ USER.md   — Who you are             │
│ Project memory — When cwd matches   │
└─────────────────────────────────────┘

Searchable on Demand (Unlimited)
┌─────────────────────────────────────┐
│ session_search("auth flow")         │
│ memory_search("testing patterns")   │
└─────────────────────────────────────┘
```

Your agent always knows who you are and what you prefer (core memory). When it needs deeper context, it searches.

## How to Test Your Memory

### Step 1: Index Your Past Sessions

```bash
/memory-index-sessions
```

This imports all your existing Pi sessions into the search database. You'll see:

```
🔍 Scanning session directories...
📁 Found 36 session files across 5 projects
⏳ Indexing...

✅ Session indexing complete!

📊 Results:
├─ Sessions processed: 36
├─ Sessions indexed: 36
├─ Messages indexed: 1,247

📁 Projects indexed:
├─ pi-hermes-memory: 12 sessions, 856 messages
├─ my-other-project: 8 sessions, 234 messages
└─ ...
```

### Step 2: Explore Your Memory

```bash
/memory-insights
```

Shows everything stored in your memory — facts, user profile, and project-specific memories.

### Step 3: Search Your History

Ask your agent to search:

```
"Search my sessions for discussions about TypeScript configuration"
"What do I know about the user's testing preferences?"
"Find conversations about database migrations"
```

### Step 4: Query the Database Directly

For the curious, your data lives in `~/.pi/agent/memory/sessions.db`:

```bash
# Sessions overview
sqlite3 -header -column ~/.pi/agent/memory/sessions.db \
  "SELECT project, COUNT(*) as sessions, SUM(message_count) as messages 
   FROM sessions GROUP BY project;"

# Full-text search
sqlite3 -header -column ~/.pi/agent/memory/sessions.db \
  "SELECT s.project, substr(m.content, 1, 100) as snippet
   FROM messages m JOIN sessions s ON s.id = m.session_id
   WHERE m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH 'SQLite')
   LIMIT 5;"

# Messages by role
sqlite3 ~/.pi/agent/memory/sessions.db \
  "SELECT role, COUNT(*) FROM messages GROUP BY role;"
```

## Real-World Impact

### For Individual Developers
- **Context continuity**: Pick up where you left off, even days later
- **No more re-explaining**: Your preferences and setup are remembered
- **Institutional memory**: Your debugging insights persist

### For Teams
- **Shared knowledge**: Project conventions are stored and searchable
- **Onboarding**: New team members can search past discussions
- **Decision history**: Architecture decisions are preserved

### For Power Users
- **Pattern recognition**: Search for similar problems across projects
- **Learning retention**: Your coding learnings accumulate over time
- **Workflow optimization**: Discover what approaches worked before

## The Architecture (For the Technical)

```
┌─────────────────────────────────────────────────────────┐
│                    Pi Extension                          │
├─────────────────────────────────────────────────────────┤
│  Tools:                                                 │
│  ├── memory (add/replace/remove)                        │
│  ├── skill (create/view/patch/edit/delete)              │
│  ├── session_search (FTS5 across messages)              │
│  └── memory_search (FTS5 across extended memories)      │
├─────────────────────────────────────────────────────────┤
│  Storage:                                               │
│  ├── MEMORY.md / USER.md (core, always injected)        │
│  ├── skills/*.md (procedural, on-demand)                │
│  └── sessions.db (SQLite + FTS5, searchable)            │
├─────────────────────────────────────────────────────────┤
│  Events:                                                │
│  ├── session_start → Load core memory                   │
│  ├── context → Inject memory into system prompt         │
│  ├── session_shutdown → Auto-index session              │
│  └── turn_count ≥ 10 → Background review                │
└─────────────────────────────────────────────────────────┘
```

**Key technical decisions:**
- **better-sqlite3**: Native C++ addon, synchronous API, built-in FTS5
- **WAL mode**: Write-ahead logging for concurrent reads
- **Lazy initialization**: DB only opened when first needed
- **Single file**: `sessions.db` — easy to backup, easy to delete

## What's Next (v0.5+)

- **Semantic search**: Embedding-based search using local models (potion-base-4M)
- **Cross-project insights**: Find patterns across all your projects
- **Memory visualization**: Timeline view of your knowledge accumulation
- **Collaborative memory**: Share project memories with team members

## Get Started

```bash
# Install or update
pi install chandra447/pi-hermes-memory

# Index your past sessions
/memory-index-sessions

# Learn how to use it
/learn-memory-tool

# Check what's stored
/memory-insights
```

## Links

- **npm**: [pi-hermes-memory](https://www.npmjs.com/package/pi-hermes-memory)
- **GitHub**: [chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)
- **Pi**: [pi.dev](https://pi.dev)

---

*Your AI agent should remember as much as you do. Now it does.*

---

## Social Media Posts

### X/Twitter (Thread)

**Post 1:**
🚀 Just shipped v0.4 of Pi Hermes Memory — your AI coding agent can now search through every conversation you've ever had with it.

No more re-explaining context. No more lost debugging sessions.

Thread 🧵👇

**Post 2:**
The problem: Every AI session starts from zero. That 2-hour debugging session from Tuesday? Gone. The architecture decision you discussed? Vanished.

You're not just losing context — you're losing hours of accumulated knowledge.

**Post 3:**
The solution: SQLite-powered session history with full-text search.

Your agent now has:
• Persistent memory (survives across sessions)
• Full-text search across all conversations
• Unlimited extended memory
• 5,000 char limits (up from 2,200)

**Post 4:**
How it works:

1. Sessions auto-indexed on shutdown
2. FTS5 search finds relevant context in milliseconds
3. Agent decides when to search based on your question
4. Core memory always in context, extended memory searchable on demand

**Post 5:**
Try it yourself:

```
/memory-index-sessions  # Import past sessions
/memory-insights        # See what's stored
"Search my sessions for discussions about auth"  # Test it
```

**Post 6:**
Technical details:
• better-sqlite3 (native C++ addon)
• WAL mode for concurrent reads
• Single sessions.db file (easy backup)
• Lazy initialization (no startup cost)

**Post 7:**
Your AI agent should remember as much as you do. Now it does.

npm: npmjs.com/package/pi-hermes-memory
GitHub: github.com/chandra447/pi-hermes-memory

#AI #DevTools #CodingAgent #Pi #OpenSource

---

### LinkedIn Post

**Your AI Agent Just Got a Brain Upgrade**

Every time you start a new session with an AI coding agent, it forgets everything. That debugging session from last week? Gone. The architecture decision you discussed? Vanished.

Pi Hermes Memory v0.4 changes this.

Your agent now has:
✅ Persistent memory that survives across sessions
✅ Full-text search across every conversation
✅ Unlimited extended memory via SQLite
✅ Automatic session indexing

The result? Context continuity. No more re-explaining your preferences. No more lost debugging insights. Your accumulated knowledge persists.

I built this because I was tired of re-explaining context every session. Now my agent remembers what we discussed last week, last month, last year.

Key technical decisions:
• SQLite with FTS5 for fast full-text search
• Hybrid memory: core (always in context) + extended (searchable on demand)
• 5,000 character limits (up from 2,200)
• Auto-indexing on session shutdown

Try it:
```
pi install chandra447/pi-hermes-memory
/memory-index-sessions
```

Your AI agent should remember as much as you do. Now it does.

Open source: github.com/chandra447/pi-hermes-memory

#AI #DevTools #SoftwareEngineering #OpenSource #CodingAgent #DeveloperProductivity #MachineLearning #ArtificialIntelligence
