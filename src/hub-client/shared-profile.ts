/**
 * The shared user profile for session-start prompt composition (story 4,
 * CAP-5 / FR-14/FR-15).
 *
 * The profile is the shared store's GLOBAL user scope (`scope: 'user'`, no
 * project key) — the shared counterpart of the local `USER.md`. It is
 * fetched once per session via `GET /export` (the five-endpoint surface is
 * frozen — there is no scope-listing endpoint, and `/search` cannot
 * enumerate a scope: it needs a query and caps at 100 hits).
 *
 * The fetch is BEST-EFFORT by design: it is bounded (probe ≤ 500 ms + export
 * ≤ EXPORT_TIMEOUT_MS) and any failure — unreachable, HTTP error, malformed
 * NDJSON — resolves to `{ kind: 'down' }`, never a throw. A down profile
 * means "compose the local profile only, and say so in the prompt" (FR-16:
 * degradation is never silently hidden) — it must never take down the
 * session start.
 */

import { HubHttpError, HubUnreachableError } from './client.js';
import type { HubClient } from './client.js';

/**
 * The settled state of the session's shared profile fetch. Frozen for the
 * session once resolved — the prompt snapshot must be cache-stable, so this
 * is captured once (at session start) and never re-fetched mid-session.
 */
export interface SharedProfileState {
  /** 'up' = fetched (entries may legitimately be empty); 'down' = unavailable. */
  kind: 'up' | 'down';
  /** The shared global user-scope entry contents, in hub export order. */
  entries: string[];
}

/**
 * Fetch the shared user profile for one session. See the module doc for the
 * best-effort contract: this NEVER throws.
 */
export async function fetchSharedProfile(client: HubClient): Promise<SharedProfileState> {
  if (!(await client.probe())) {
    return { kind: 'down', entries: [] };
  }
  try {
    const rows = await client.export();
    // Global user scope ONLY: the profile is who the user IS, not facts
    // about a project (those carry a project key) and not memory/status
    // entries (other scopes).
    const entries = rows
      .filter((row) => row.scope === 'user' && !row.project_key)
      .map((row) => row.content);
    return { kind: 'up', entries };
  } catch (err) {
    if (err instanceof HubUnreachableError || err instanceof HubHttpError) {
      return { kind: 'down', entries: [] };
    }
    // Anything else (e.g. malformed NDJSON from the hub): same outcome —
    // a profile fetch is best-effort, and the degraded line in the prompt
    // makes the gap explicit. Re-throwing would take down session start.
    return { kind: 'down', entries: [] };
  }
}
