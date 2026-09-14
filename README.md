<div align="center">

![Pi Hermes Memory](docs/images/pi_memory.png)

# 🧠 Pi Hermes Memory

**Persistent memory + session search + secret scanning for Pi**

---

</div>

Your Pi agent normally forgets everything when you close a session. **This extension fixes that.**

- 🔍 **Search every conversation** — "what did we discuss about auth?" finds it instantly
- 🧠 **Persistent memory** — facts, preferences, corrections survive across sessions
- ⚠️ **Learns from failures** — remembers what didn't work so you don't repeat mistakes
- 🏷️ **Categorized memories** — failures, corrections, insights, conventions, and tool quirks organized for fast retrieval
- 🛡️ **Secret scanning** — API keys and tokens are blocked from being saved
- 📚 **Procedural skills** — the agent saves *how* it solved problems, not just what
- ⚡ **Background learning** — reviews every 10 turns, saves what matters
- 🔄 **Auto-consolidation** — merges entries when full, never loses data

## Quick Start

```bash
# Install
pi install npm:pi-hermes-memory

# Index your past sessions (one-time)
/memory-index-sessions

# Backfill older Markdown memories into SQLite search (optional)
/memory-sync-markdown

# Learn how to use it
/learn-memory-tool
```

PLACEHOLDER_TRUNCATED_WILL_FAIL_CHECK