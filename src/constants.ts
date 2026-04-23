/**
 * Constants — prompts, defaults, and delimiter.
 * Ported from hermes-agent/tools/memory_tool.py and hermes-agent/run_agent.py.
 * See PLAN.md → "Hermes Source File Reference Map" for exact source lines.
 */

// ─── Entry delimiter (same as Hermes) ───
export const ENTRY_DELIMITER = "\n§\n";

// ─── Character limits (not tokens — model-independent) ───
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_USER_CHAR_LIMIT = 1375;

// ─── Learning loop defaults ───
export const DEFAULT_NUDGE_INTERVAL = 10;
export const DEFAULT_FLUSH_MIN_TURNS = 6;

// ─── File names ───
export const MEMORY_FILE = "MEMORY.md";
export const USER_FILE = "USER.md";

// ─── Tool description (ported from MEMORY_SCHEMA in hermes-agent/tools/memory_tool.py) ───
export const MEMORY_TOOL_DESCRIPTION = `Save durable information to persistent memory that survives across sessions. Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says 'remember this' / 'don't do that again'
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover something about the environment (OS, installed tools, project structure)
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge.

Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state.

TWO TARGETS:
- 'user': who the user is -- name, role, preferences, communication style, pet peeves
- 'memory': your notes -- environment facts, project conventions, tool quirks, lessons learned

ACTIONS: add (new entry), replace (update existing -- old_text identifies it), remove (delete -- old_text identifies it).`;

// ─── Background review prompt (ported from _COMBINED_REVIEW_PROMPT in run_agent.py ~L2855) ───
export const COMBINED_REVIEW_PROMPT = `Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — their persona, desires, preferences, or personal details? Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate? If so, save using the memory tool.

**Skills**: Was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome?

Only act if there's something genuinely worth saving. If nothing stands out, just say 'Nothing to save.' and stop.`;

// ─── Flush prompt (ported from flush_memories() in run_agent.py ~L7379) ───
export const FLUSH_PROMPT = `[System: The session is being compressed. Save anything worth remembering — prioritize user preferences, corrections, and recurring patterns over task-specific details.]`;
