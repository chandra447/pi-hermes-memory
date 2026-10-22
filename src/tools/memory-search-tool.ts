import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats, recordSearchHits } from '../store/sqlite-memory-store.js';
import type { MemoryCategory } from '../types.js';
import type { SqliteMemoryEntry } from '../store/sqlite-memory-store.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';
import { HubUnreachableError } from '../hub-client/client.js';
import type { SharedMemoryOptions } from '../hub-client/context.js';
import { sharedRegistryEntries, sharedResolve } from '../hub-client/context.js';
import { resolveProjectKey } from '../hub-client/registry.js';
import { normalizeProjectKey } from '../shared/project-key.js';
import {
  degradedBanner,
  degradedTag,
  mapLocalHit,
  mapSharedHit,
  mergeHits,
  unresolvedProjectNote,
  upStateLine,
  type UnifiedHit,
} from '../hub-client/merge.js';
import type { SearchHit } from '../shared/wire.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

function mutationTarget(entry: { target: "memory" | "user" | "failure"; project: string | null }): "memory" | "user" | "failure" | "project" {
  // A project name scopes ordinary memory entries, but project-attributed
  // failures still live in (and must be mutated through) the failure store.
  return entry.target === "memory" && entry.project ? "project" : entry.target;
}

function scopeLabel(project: string | null): string {
  return project ? `project:${encodeURIComponent(project)}` : "global";
}

type SharedSearchOutcome =
  | { kind: "up"; hits: SearchHit[]; note?: string }
  | { kind: "down"; note?: string }
  | { kind: "skipped"; note?: string }
  | { kind: "error"; message: string; note?: string };

/**
 * The wire scope for a v1 target — the shared side must mirror the local
 * side's filter EXACTLY (review fix): v1's `target: "memory"` is
 * `target = 'memory'` (not "all scopes"), and `target: "project"` is
 * `target = 'memory' AND project IS NOT NULL`.
 */
function sharedScopeFor(target: 'memory' | 'user' | 'failure' | 'project' | undefined): 'memory' | 'user' | 'failure' | undefined {
  if (target === 'user' || target === 'failure') return target;
  if (target === 'memory' || target === 'project') return 'memory';
  return undefined; // no target filter = all scopes (both tiers)
}

/** Run the shared search (probe + call) and classify the outcome (AD-11). */
async function runSharedSearch(
  shared: SharedMemoryOptions,
  args: { query: string; project?: string; target?: 'memory' | 'user' | 'failure' | 'project'; category?: MemoryCategory; limit: number },
  cwd: string | undefined,
): Promise<SharedSearchOutcome> {
  // AD-10: an explicit project name must resolve to a normalized key; a
  // missing registry entry is a client error — the shared project search
  // is SKIPPED (not run unfiltered) and the result says so.
  if (args.project) {
    const resolved = await sharedResolve(shared, args.project, cwd);
    if (!resolved.key) return { kind: "skipped", note: unresolvedProjectNote(args.project, resolved.note) };
    const up = await shared.client.probe();
    // Down is down — the project resolved FINE, so no "unresolvable" note
    // may be attached (EC-7: a false claim would contradict the banner).
    if (!up) return { kind: "down" };
    try {
      const scope = sharedScopeFor(args.target);
      const hits = await shared.client.search({
        query: args.query,
        project: resolved.key,
        ...(scope !== undefined ? { scope } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        limit: args.limit,
      });
      shared.client.clearDownSignal();
      return { kind: "up", hits };
    } catch (err) {
      if (err instanceof HubUnreachableError) return { kind: "down" };
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  const up = await shared.client.probe();
  if (!up) return { kind: "down" };

  try {
    const scope = sharedScopeFor(args.target);
    const hits = await shared.client.search({
      query: args.query,
      // v1 `target: "project"` (no name) = project-ATTRIBUTED memory entries.
      ...(!args.project && args.target === 'project' ? { project_any: true } : {}),
      // v1 `project: null` = GLOBAL memories only (EC-2): the hub maps null
      // to `project_key IS NULL`; absent means unfiltered (local ∪ shared
      // parity). Undefined and null must NOT collapse.
      ...(args.project === null ? { project: null } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(args.category !== undefined ? { category: args.category } : {}),
      limit: args.limit,
    });
    shared.client.clearDownSignal();
    return { kind: "up", hits };
  } catch (err) {
    if (err instanceof HubUnreachableError) return { kind: "down" };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** One-line provenance footer for a shared hit (AD-15 — provenance is visible). */
function sharedHitFooter(hit: UnifiedHit): string {
  const contributors = (hit.provenance ?? [{ machine: hit.machine }])
    .map((t) => t.machine)
    .join(', ');
  const session = hit.session.length > 13 ? `${hit.session.slice(0, 13)}…` : hit.session;
  return `   Shared: ${hit.machine} (session ${session}) · contributors: ${contributors}`;
}

export function registerMemorySearchTool(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  options: { usageTrackingEnabled?: boolean; shared?: SharedMemoryOptions | null } = {},
): void {
  const shared = options.shared ?? null;
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

target="project" returns only project-attributed memory entries (the ones labeled [target=project]); combine with project to search a named project.

${shared ? 'When shared memory is configured, results include the shared LAN store (tagged "Shared:" with the contributing machines) alongside local entries, and the result header states the shared state (up / degraded).' : ''}Returns matching memory entries with their mutation target, scope, and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name. Pass null for global memories only.' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure', 'project'] as const, { description: 'Filter by target type: memory, user, failure, or project-attributed memories.' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; target?: 'memory' | 'user' | 'failure' | 'project'; category?: string; limit?: number }, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) => {
      const query = args.query;
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      // Clamp to [1, 20] (EC-10): a negative limit would hit SQLite as
      // "unlimited" locally, 400 on the wire, and merge to "no memories
      // found" despite local matches.
      const limit = Math.max(1, Math.min(Math.trunc(args.limit ?? 10) || 10, 20));

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      // The v1 "empty store" early return applies only when shared memory is
      // NOT active — with a client, shared hits can exist even on an empty
      // local store (I/O matrix: "search, local empty").
      if (stats.total === 0 && !shared) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use memory_add to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const localResults = searchMemories(dbManager, query, { project, target, category, limit });

      // ── Shared side (only when configured; bounded by probe + call timeouts) ──
      let outcome: SharedSearchOutcome | null = null;
      let merged: UnifiedHit[] | null = null;
      if (shared) {
        outcome = await runSharedSearch(shared, { query, project, target, category, limit }, ctx?.cwd);
        const sharedHits = outcome?.kind === 'up' ? outcome.hits.map(mapSharedHit) : [];
        // Pre-resolve the local hits' project names ONCE (async, cached) so
        // the merge's dedup identity matches the shared side's keys — no
        // per-name re-read of the registry file during the merge.
        const localProjectNames = [...new Set(localResults.map((e) => e.project).filter((p): p is string => p !== null))];
        const nameToKeyMap = new Map<string, string | null>();
        if (localProjectNames.length > 0) {
          const entries = sharedRegistryEntries(shared);
          await Promise.all(
            localProjectNames.map(async (n) => {
              nameToKeyMap.set(n, (await resolveProjectKey({ name: n }, entries)).key);
            }),
          );
        }
        const localProjectKey = (name: string): string | null => nameToKeyMap.get(name) ?? null;
        const localHits = localResults.map((e) => mapLocalHit(e, shared.client.machine));
        merged = mergeHits(localHits, sharedHits, limit, localProjectKey);
      }

      const hits = merged ?? localResults.map((e) => mapLocalHit(e, shared?.client.machine ?? 'local'));
      const count = hits.length;

      if (count === 0) {
        const base = `No memories found matching "${query}". Try a different search term or broader query.`;
        const lines = shared && outcome ? [base, ...stateLines(shared, outcome, 0)] : [base];
        const message = lines.join('\n');
        const result: SearchResult = { success: true, count: 0, message };
        return { content: [{ type: 'text' as const, text: message }], details: result };
      }

      // Usage-hit tracking (the promotion-gate data for consolidation): local
      // entries only — the shared store has no usage counter (hub is the
      // single writer; usage stays a local property).
      if (options.usageTrackingEnabled !== false) {
        try {
          recordSearchHits(dbManager, localResults.map((entry) => entry.id));
        } catch (err) {
          console.warn(`[pi-hermes-memory] usage-hit recording failed (search result unaffected): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      let output = `Found ${count} memories matching "${query}":`;
      if (shared && outcome) {
        output += '\n' + stateLines(shared, outcome, outcome.kind === 'up' ? outcome.hits.length : 0).join('\n');
      }
      output += '\n\n';

      // Display names for shared hits (EC-12): the hub stores the normalized
      // KEY (a URL); v1 local hits display the short project name. Map
      // key→name via the registry so the SAME project renders identically on
      // both sides (a copied shared line feeds the name, not the URL, into
      // later project ops). The "Last used" label is kept as-is: v1 renders
      // updated_at under that label too (parity, not a shared divergence).
      let keyToName = new Map<string, string>();
      if (shared) {
        for (const e of sharedRegistryEntries(shared)) {
          if (e.remote) {
            const key = normalizeProjectKey(e.remote);
            if (key && !keyToName.has(key)) keyToName.set(key, e.name);
          }
        }
      }
      for (const hit of hits) {
        const entry = hit as UnifiedHit;
        const t = mutationTarget({ target: entry.target as "memory" | "user" | "failure", project: entry.project ?? null });
        const projectDisplay = entry.project && entry.source === 'shared' ? (keyToName.get(entry.project) ?? entry.project) : entry.project;
        const projectLabel = `scope=${scopeLabel(projectDisplay ?? null)}`;
        const mutationTargetLabel = `[target=${t}]`;
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        output += `${targetLabel} ${projectLabel} ${mutationTargetLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n`;
        if (entry.source === 'shared') {
          output += sharedHitFooter(entry) + '\n';
        }
        output += '\n';
      }

      const finalResult: SearchResult = { success: true, count, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}

/**
 * The shared-state lines for a search result (FR-16/FR-18 — explicit, never
 * silent). Down outcome: the FULL banner on the first shared-scope call of
 * the window (one-shot budget on the client), the compact tag afterwards.
 * Skipped outcome (AD-10 unresolvable project): the note is the state line —
 * no "shared: up (0)" would misrepresent a search that never ran.
 */
function stateLines(shared: SharedMemoryOptions, outcome: SharedSearchOutcome, sharedCount: number): string[] {
  const lines: string[] = [];
  switch (outcome.kind) {
    case 'up':
      lines.push(upStateLine(sharedCount));
      break;
    case 'down':
      if (shared.client.hasSignalledDown) {
        lines.push(degradedTag());
      } else {
        shared.client.markDownSignalled();
        lines.push(degradedBanner());
      }
      break;
    case 'skipped':
      break; // the note (below) is the entire state line
    case 'error':
      lines.push(`shared: error — ${outcome.message} (local results only)`);
      break;
  }
  if (outcome.note) lines.push(outcome.note);
  return lines;
}

// Re-export for tests that build tool results directly.
export type { SqliteMemoryEntry };
