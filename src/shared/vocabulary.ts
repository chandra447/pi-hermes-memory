/**
 * Shared memory vocabulary — defined ONCE (spine convention "Vocabulary
 * single-sourcing"). Hub and client import from here; there are no local
 * copies. The six categories mirror the v1 local-store vocabulary exactly so
 * a hit looks the same shared or local (AD-15).
 */

/** The six canonical Mneme memory categories. */
export const MEMORY_CATEGORIES = [
  'failure',
  'correction',
  'insight',
  'preference',
  'convention',
  'tool-quirk',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/**
 * Scope set = the v1 memory targets: global memory, user profile, failure
 * memory (per-project scoping rides on `project_key`, not the scope).
 */
export const MEMORY_SCOPES = ['memory', 'user', 'failure'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * The six project-status words (spine convention "Status entries"). They live
 * in the shared vocabulary, never in content parsing; status-kind entries
 * carry one of these in the dedicated `state` field.
 */
export const STATUS_WORDS = [
  'active',
  'done',
  'hardening',
  'held',
  'dormant',
  'abandoned',
] as const;
export type StatusWord = (typeof STATUS_WORDS)[number];

/** Reserved entry kinds in the shared store. */
export const ENTRY_KINDS = ['memory', 'status'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** Source tag on wire hits (AD-15): where the hit came from. */
export const HIT_SOURCES = ['shared', 'local'] as const;
export type HitSource = (typeof HIT_SOURCES)[number];
