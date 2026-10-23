/**
 * Shared-store mutation helpers (story 2). All mutations go through the hub
 * as idempotent ops; the entry id is the deterministic content hash, so no
 * lookup state is needed — replace/remove resolve by SEARCHING the hub (the
 * search hit carries the id) and filtering on the exact substring, mirroring
 * v1's local matching semantics (`normalizeMemoryLookupText` + includes).
 *
 * Replace procedure (decision Q1=B): add-first then remove —
 * `add(new_id, inherits_from = old_id)` then `remove(old_id)`. A crash or
 * timeout between the two leaves BOTH versions visible (the new one is safe;
 * the old one is removable) and is reported explicitly. Hash-equal "replace"
 * (same content) is a pure upsert — no remove (self-destruction guard).
 */

import {
  HubClient,
  HubUnreachableError,
} from './client.js';
import { deterministicEntryId } from '../shared/content-id.js';
import { normalizeMemoryLookupText } from '../store/memory-lookup.js';
import type { MemoryCategory, StatusWord } from '../shared/vocabulary.js';
import type { MemoryOpRequest, SearchHit } from '../shared/wire.js';

export interface SharedMutationTarget {
  client: HubClient;
  /** Wire `session` field (the pi session id, fallback "unknown"). */
  sessionId: string;
  /** Wire scope (the v1 target mapping: project → memory). */
  scope: 'memory' | 'user' | 'failure';
  /** Normalized project key (project-scoped mutations only). */
  projectKey?: string;
  /** Entry category (failure memories; undefined for the others). */
  category?: MemoryCategory;
}

/**
 * Search the hub for entries whose content contains `oldText` (v1 semantics).
 * Literal containment (`contains: true` — one escaped LIKE), NOT the FTS
 * relevance ladder: short terms (<3 chars, no trigram) and label-prefixed
 * text must match by containment or the shared op silently no-ops while the
 * local op succeeds (EC-5). The label is stripped before the hub call so the
 * LIKE matches the STORED content (the hub never stored the label).
 */
export async function findSharedMatches(target: SharedMutationTarget, oldText: string): Promise<SearchHit[]> {
  const lookup = normalizeMemoryLookupText(oldText);
  if (!lookup) return [];
  const hits = await target.client.search({
    query: lookup,
    contains: true,
    ...(target.projectKey !== undefined ? { project: target.projectKey } : {}),
    // ALWAYS scope-filtered (EC-1): a `target="memory"` mutation must never
    // op user/failure-scope entries just because their content contains the
    // substring — v1's local replace/remove matches memory rows only.
    scope: target.scope,
    limit: 50,
  });
  return hits.filter((hit) => hit.content.includes(lookup));
}

/**
 * One shared add (deterministic id; the hub upserts + merges provenance).
 * `categoryOverride` lets a replace write the HIT's category instead of the
 * target default — the id hash and the stored category must agree, or the
 * hash-equal guard and the upsert land on different identities (EC-3).
 */
export async function sharedAdd(
  target: SharedMutationTarget,
  content: string,
  inheritsFrom?: string,
  categoryOverride?: MemoryCategory | null,
): Promise<{ action: string; entry: unknown }> {
  const category = categoryOverride !== undefined ? categoryOverride : target.category ?? null;
  const id = deterministicEntryId(content, target.scope, target.projectKey ?? null, category);
  const op: MemoryOpRequest = {
    op: 'add',
    id,
    scope: target.scope,
    session: target.sessionId,
    content,
    ...(target.projectKey !== undefined ? { project_key: target.projectKey } : {}),
    ...(category !== null && category !== undefined ? { category } : {}),
    ...(inheritsFrom !== undefined ? { inherits_from: inheritsFrom } : {}),
  };
  const res = await target.client.memory(op);
  return { action: String(res.action ?? 'unknown'), entry: res.entry };
}

export interface SharedReplaceOutcome {
  replaced: number;
  /** Hash-equal replaces: the content was unchanged — pure upsert, no remove. */
  unchanged: number;
  /** Adds landed but their remove did not (hub dropped mid-procedure). */
  leftoverOldIds: string[];
  /** True when the procedure stopped early on a hub failure. */
  failed: boolean;
  error?: string;
}

/**
 * Replace every hub entry matching `oldText` with `newContent` (add-first,
 * remove-second, per matched entry). `newContent` is the FINAL content
 * (already formatted, exactly what v1 would store).
 */
export async function sharedReplace(
  target: SharedMutationTarget,
  oldText: string,
  newContent: string,
): Promise<SharedReplaceOutcome> {
  const outcome: SharedReplaceOutcome = { replaced: 0, unchanged: 0, leftoverOldIds: [], failed: false };
  const matches = await findSharedMatches(target, oldText);
  for (const hit of matches) {
    const oldId = hit.id;
    // The HIT's category is the identity: v1's local replace preserves the
    // row's category, so the new entry's id (and the stored category) must
    // both use it — a target-default category here would hash a different id
    // than the guard computed and duplicate the entry (EC-3).
    const hitCategory = (hit.category as MemoryCategory | undefined) ?? null;
    const newId = deterministicEntryId(newContent, target.scope, target.projectKey ?? null, hitCategory);
    let addLanded = false;
    try {
      if (newId === oldId) {
        // Same content (modulo trim): pure upsert — provenance extends,
        // nothing is removed (self-destruction guard).
        await sharedAdd(target, newContent, undefined, hitCategory);
        outcome.unchanged += 1;
        continue;
      }
      await sharedAdd(target, newContent, oldId, hitCategory);
      addLanded = true;
      await target.client.memory({ op: 'remove', id: oldId });
      outcome.replaced += 1;
    } catch (err) {
      outcome.failed = true;
      outcome.error = err instanceof Error ? err.message : String(err);
      // Any failure AFTER the add landed leaves BOTH versions visible
      // (unreachable AND http-error classes — a 500 on the remove is the
      // spec's partial-failure case too). The old id is actionable
      // cleanup: name it.
      if (addLanded) outcome.leftoverOldIds.push(oldId);
      break; // stop the procedure; report what happened
    }
  }
  return outcome;
}

/**
 * The deterministic content a status entry carries when the caller gives no
 * note (story 3). One rule, shared by every box: identical state transitions
 * with no note hash to the SAME id on every machine (cross-box dedup), so
 * the default lives next to the mutation helpers, not in the tool.
 */
export function defaultStatusContent(state: StatusWord): string {
  return `status: ${state}`;
}

/**
 * Record a project status change (story 3, FR-11). A status entry is the
 * RESERVED KIND: scope `memory`, category null, project_key = the resolved
 * key, `kind: "status"` + `state` = one of the six shared-vocabulary words.
 * The id is the frozen deterministic content hash — same note + state
 * convention ⇒ same id on every box, so the hub upserts instead of
 * duplicating. Provenance is stamped by the hub (AD-8): this sends only
 * content + key + state + session pointer.
 */
export async function sharedStatusSet(
  target: SharedMutationTarget,
  state: StatusWord,
  content: string,
): Promise<{ action: string; entry: unknown }> {
  // Status entries are memory-scoped, project-attributed, un-categorized —
  // the id hash and the stored fields must agree on all three (EC-3 rule).
  const id = deterministicEntryId(content, 'memory', target.projectKey ?? null, null);
  const op: MemoryOpRequest = {
    op: 'add',
    id,
    scope: 'memory',
    session: target.sessionId,
    content,
    ...(target.projectKey !== undefined ? { project_key: target.projectKey } : {}),
    kind: 'status',
    state,
  };
  const res = await target.client.memory(op);
  return { action: String(res.action ?? 'unknown'), entry: res.entry };
}

export interface SharedRemoveOutcome {
  removed: number;
  failed: boolean;
  error?: string;
}

/** Remove every hub entry matching `oldText` (delete by id, one op each). */
export async function sharedRemove(target: SharedMutationTarget, oldText: string): Promise<SharedRemoveOutcome> {
  const outcome: SharedRemoveOutcome = { removed: 0, failed: false };
  const matches = await findSharedMatches(target, oldText);
  for (const hit of matches) {
    try {
      // Delete-by-id is idempotent on the hub: `removed: true` for a real
      // deletion AND for an already-gone entry (concurrent op) — both count
      // as "the match is no longer there".
      await target.client.memory({ op: 'remove', id: hit.id });
      outcome.removed += 1;
    } catch (err) {
      outcome.failed = true;
      outcome.error = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  return outcome;
}
