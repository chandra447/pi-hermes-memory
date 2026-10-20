/**
 * Unified search merge (story 2, AD-15): local and shared hits flow through
 * ONE shape and ONE renderer. Shared hits carry hub-stamped provenance and
 * `source: shared`; local hits carry the box name as `machine` and
 * `source: local`.
 *
 * Dedup: content-hash identity (the same frozen function that produces the
 * shared entry ids). A local entry whose content matches a shared hit is
 * local RESIDUE (a hub-down write of the same fact) — the shared hit wins
 * (it carries provenance); the local copy never shadows it.
 */

import type { SqliteMemoryEntry } from '../store/sqlite-memory-store.js';
import type { ProvenanceTouch, SearchHit } from '../shared/wire.js';
import { contentIdInput } from '../shared/content-id.js';

export interface UnifiedHit {
  id: string;
  project?: string;
  target: string;
  category?: string;
  content: string;
  failureReason?: string;
  toolState?: string;
  correctedTo?: string;
  created: string;
  lastReferenced: string;
  // Provenance + source (AD-15).
  machine: string;
  session: string;
  /** Shared hits: the hub's per-machine first-touch list. */
  provenance?: ProvenanceTouch[];
  source: 'local' | 'shared';
}

/** v1 local row → unified hit (`machine` = this box's name from the client file). */
export function mapLocalHit(entry: SqliteMemoryEntry, machine: string): UnifiedHit {
  return {
    id: String(entry.id),
    ...(entry.project !== null ? { project: entry.project } : {}),
    target: entry.target,
    ...(entry.category !== null ? { category: entry.category } : {}),
    content: entry.content,
    ...(entry.failureReason !== null ? { failureReason: entry.failureReason } : {}),
    ...(entry.toolState !== null ? { toolState: entry.toolState } : {}),
    ...(entry.correctedTo !== null ? { correctedTo: entry.correctedTo } : {}),
    created: entry.created,
    lastReferenced: entry.lastReferenced,
    machine,
    session: 'local',
    source: 'local',
  };
}

/** Wire hit → unified hit (already carries everything, incl. provenance). */
export function mapSharedHit(hit: SearchHit): UnifiedHit {
  return {
    id: hit.id,
    ...(hit.project !== undefined ? { project: hit.project } : {}),
    target: hit.target,
    ...(hit.category !== undefined ? { category: hit.category } : {}),
    content: hit.content,
    ...(hit.failureReason !== undefined ? { failureReason: hit.failureReason } : {}),
    ...(hit.toolState !== undefined ? { toolState: hit.toolState } : {}),
    ...(hit.correctedTo !== undefined ? { correctedTo: hit.correctedTo } : {}),
    created: hit.created,
    lastReferenced: hit.lastReferenced,
    machine: hit.machine,
    session: hit.session,
    provenance: hit.provenance,
    source: 'shared',
  };
}

/**
 * Merge local + shared hits: content-hash dedup (shared wins), then
 * rank-interleave (local #1, shared #1, local #2, …) capped at `limit`.
 *
 * `localProjectKey` maps a local hit's project NAME to its normalized key
 * (registry resolution) so the dedup identity matches the shared side;
 * unresolvable names keep the raw name (such content cannot have a shared
 * counterpart in this query — the shared project search was skipped).
 */
export function mergeHits(
  local: UnifiedHit[],
  shared: UnifiedHit[],
  limit: number,
  localProjectKey: (projectName: string) => string | null,
): UnifiedHit[] {
  const dedupKey = (hit: UnifiedHit): string => {
    const project = hit.project === undefined ? null : hit.source === 'shared' ? hit.project : localProjectKey(hit.project);
    // `target` is the v1 scope word (memory|user|failure) on both hit kinds.
    return contentIdInput(hit.content, hit.target as 'memory' | 'user' | 'failure', project, (hit.category ?? null) as Parameters<typeof contentIdInput>[3]);
  };

  // Shared wins on a content-hash collision: a local RESIDUE whose content
  // matches a shared hit is dropped BEFORE interleave, so it can never
  // shadow the shared hit (which carries provenance).
  const sharedKeys = new Set(shared.map(dedupKey));
  const localOnly = local.filter((h) => !sharedKeys.has(dedupKey(h)));

  const seen = new Set<string>();
  const merged: UnifiedHit[] = [];
  const take = (hit: UnifiedHit): void => {
    if (merged.length >= limit) return;
    const key = dedupKey(hit);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(hit);
  };

  const maxRank = Math.max(localOnly.length, shared.length);
  for (let rank = 0; rank < maxRank; rank++) {
    if (localOnly[rank]) take(localOnly[rank]);
    if (shared[rank]) take(shared[rank]);
    if (merged.length >= limit) break;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Shared-state / degraded signal lines (FR-16/FR-18 — the explicit surface).
// ---------------------------------------------------------------------------

/** Search header when the hub is up: the recall/status surface (FR-18). */
export function upStateLine(sharedCount: number): string {
  return `shared: up (${sharedCount} shared hit${sharedCount === 1 ? '' : 's'})`;
}

/** First shared-scope call of a down-window: the full explicit signal. */
export function degradedBanner(): string {
  return '⚠️ shared memory unavailable (hub unreachable) — local-only; cross-box facts not visible. If shared memory is required for this task, say so and ask the human.';
}

/** Later calls in the same window: compact tag. */
export function degradedTag(): string {
  return 'shared: degraded (local only)';
}

/** AD-10 client error surfaced in the result (unresolvable project name). */
export function unresolvedProjectNote(projectName: string, detail?: string): string {
  const suffix = detail ? ` — ${detail}` : '';
  return `note: project "${projectName}" not resolvable to a project key${suffix} — shared project search skipped (local results only).`;
}
