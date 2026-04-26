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
export const DEFAULT_NUDGE_TOOL_CALLS = 15;
export const DEFAULT_SKILL_TRIGGER_TOOL_CALLS = 8;

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

**Skills**: Was a complex, non-trivial approach used to complete a task — one that required trial and error, multiple tool calls, or changing course? If so, save a reusable procedure using the skill tool with action 'create'. Include: when to use it, step-by-step procedure, pitfalls to avoid, and how to verify success. If a related skill already exists, use action 'patch' to update it instead of creating a duplicate.

Only act if there's something genuinely worth saving. If nothing stands out, just say 'Nothing to save.' and stop.`;

// ─── Flush prompt (ported from flush_memories() in run_agent.py ~L7379) ───
export const FLUSH_PROMPT = `[System: The session is being compressed. Save anything worth remembering — prioritize user preferences, corrections, and recurring patterns over task-specific details.]`;

// ─── Auto-consolidation prompt ───
export const CONSOLIDATION_PROMPT = `The memory is at capacity. Review the current entries and consolidate them:
- Merge related entries into a single, concise entry
- Remove outdated or superseded entries
- Keep the most important and frequently-referenced facts
- Preserve user preferences and corrections (highest priority)

Use the memory tool to make changes. Be aggressive about merging — less is more.`;

// ─── Correction detection patterns (two-pass filter) ───

/** Strong patterns — always trigger (high confidence these are corrections) */
export const CORRECTION_STRONG_PATTERNS: RegExp[] = [
  /don'?t do that/i,
  /not like that/i,
  /^I said\b/i,
  /^I told you\b/i,
  /we already discussed/i,
  /^please don'?t/i,
  /^that'?s not what I/i,
];

/** Weak patterns — only trigger if followed by a directive (verb or "the/that/this") */
export const CORRECTION_WEAK_PATTERNS: RegExp[] = [
  /^no[,\.\s!]/i,
  /^wrong[,\.\s!]/i,
  /^actually[,\.\s]/i,
  /^stop[,\.\s!]/i,
];

/** Negative patterns — suppress trigger even if a positive pattern matches */
export const CORRECTION_NEGATIVE_PATTERNS: RegExp[] = [
  /^no worries/i,
  /^no problem/i,
  /^no thanks/i,
  /^no need/i,
  /^actually.{0,10}(looks? great|perfect|good|correct|right)/i,
  /^stop.{0,5}(there|here|for now)/i,
];

// ─── Correction save prompt ───
export const CORRECTION_SAVE_PROMPT = `The user just corrected you. Review what went wrong and save the correction to persistent memory.

Priority:
1. User preference ("don't do X", "always use Y instead")
2. Wrong assumption you made
3. Environment fact you got wrong

Use the memory tool to save. If this contradicts an existing entry, use 'replace' to update it.`;

// ─── Skill tool description ───
export const SKILL_TOOL_DESCRIPTION = `Save reusable procedures and patterns as skills that survive across sessions. Skills are procedural memory — they capture HOW to do something, not just what happened.

WHEN TO CREATE A SKILL:
- After completing a complex task that required trial and error or multiple tool calls
- When you discover a non-obvious approach that could be reused
- When the user teaches you a specific workflow or procedure

WHEN TO UPDATE A SKILL (use 'patch'):
- You discover a better approach for an existing skill
- A pitfall or edge case not covered by the skill
- A step in the procedure changed

SKILL FORMAT:
- name: short, descriptive (e.g., "debug-typescript-errors")
- description: one-line summary of when to use it
- body: structured with sections — ## When to Use, ## Procedure, ## Pitfalls, ## Verification

ACTIONS: create (new skill), view (read full content), patch (update a section), edit (replace description + body), delete (remove skill).`;
