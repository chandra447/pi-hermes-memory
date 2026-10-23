/**
 * `memory_status` — the live project-status rollup (story 3, SPEC CAP-2,
 * FR-11). The static `discoveries-status.yaml` is retired: the rollup is a
 * LIVE QUERY on the shared store (latest status-kind entry per project by
 * `updated_at`), never a stored aggregate.
 *
 * Query: `memory_status { project? }` → `GET /status` (the hub's
 * `latestStatus` derivation). Set: `memory_status { project?, state,
 * content? }` → upsert a status-kind entry with the frozen deterministic
 * id (AD-9); the hub stamps machine/session/times (AD-8).
 *
 * Degraded mode (AD-11): probe ≤ 500 ms + call ≤ ~1 s — the network never
 * blocks a turn. Hub down ⇒ the explicit signal (the one-shot banner/tag
 * budget SHARED with `memory_search` — one clear signal per down-window,
 * not spam) and: a query reports live status unavailable (there is no
 * local status source — the YAML is retired); a set lands in the bound
 * local project store when the target project has one on this box
 * (FR-17), else it is reported not-recorded — never silent.
 *
 * The six status words come from the shared vocabulary (`STATUS_WORDS`) —
 * a status entry is identified by its `kind`/`state` wire fields, never by
 * content parsing (spine "Status entries").
 *
 * Registered ONLY when shared memory is configured: no client file ⇒ the
 * tool does not exist and the v1 tool surface is byte-identical (M4).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from "../store/db.js";
import type { MemoryStore } from "../store/memory-store.js";
import {
  removeExactSyncedMemories,
  syncMemoryEntry,
} from "../store/sqlite-memory-store.js";
import {
  resolveProjectName,
  resolveProjectStore,
  type ProjectNameRef,
  type ProjectStoreRef,
} from "../project-context.js";
import { STATUS_WORDS, type StatusWord } from "../shared/vocabulary.js";
import type { SharedMemoryOptions } from "../hub-client/context.js";
import { sharedResolve } from "../hub-client/context.js";
import {
  degradedBanner,
  degradedTag,
  unresolvedProjectNote,
} from "../hub-client/merge.js";
import { defaultStatusContent, sharedStatusSet } from "../hub-client/mutations.js";
import { HubUnreachableError } from "../hub-client/client.js";
import type { StatusResponse } from "../shared/wire.js";

/**
 * Options for {@link registerMemoryStatusTool}. `shared` is non-null — the
 * tool is only registered when shared memory is configured (M4).
 */
export interface MemoryStatusToolOptions {
  shared: SharedMemoryOptions;
  projectStoreRef: ProjectStoreRef;
  projectNameRef: ProjectNameRef;
  bindProjectFromCwd?: (cwd?: string) => void | Promise<void>;
}

interface StatusToolArgs {
  project?: string;
  state?: string;
  content?: string;
}

interface StatusDetails {
  success: boolean;
  project?: string;
  /** Query: the current status word; null = no status recorded. */
  state?: StatusWord | null;
  content?: string;
  updated_at?: string;
  machine?: string;
  session?: string;
  /** The hub answered; false/absent on degraded outcomes. */
  shared?: 'up' | 'down' | 'error';
  error?: string;
}

function truncatedSession(session: string): string {
  return session.length > 13 ? `${session.slice(0, 13)}…` : session;
}

/** The one-shot down signal: full banner the first call of a window, compact tag after. */
function downSignalLine(client: SharedMemoryOptions['client']): string {
  if (client.hasSignalledDown) return degradedTag();
  client.markDownSignalled();
  return degradedBanner();
}

/**
 * The hub-down local fallback for a SET (FR-17): the bound local project
 * store, but only when the target project IS a project this box has a local
 * store for. A named project without a matching bound store has no local
 * tier on this box — the fact is project-scoped, so it must not land under
 * a different project.
 */
function localProjectWrite(
  requestedName: string | undefined,
  projectStoreRef: ProjectStoreRef,
  projectNameRef: ProjectNameRef,
): { ok: true; store: MemoryStore; boundName: string | null } | { ok: false; boundName: string | null } {
  const boundName = resolveProjectName(projectNameRef);
  const store = resolveProjectStore(projectStoreRef);
  if (store === null) {
    return { ok: false, boundName };
  }
  if (requestedName === undefined) {
    // Nameless call ⇒ the cwd-bound project IS the target (both derive from
    // the same cwd).
    return { ok: true, store, boundName };
  }
  if (boundName !== null && requestedName.trim().toLowerCase() === boundName.toLowerCase()) {
    return { ok: true, store, boundName };
  }
  return { ok: false, boundName };
}

/** The v1 local project-memory write (markdown store + SQLite search mirror). */
async function writeLocalProjectStatus(
  store: MemoryStore,
  boundName: string | null,
  dbManager: DatabaseManager | null,
  content: string,
  signal?: AbortSignal,
): Promise<{ result: Awaited<ReturnType<MemoryStore['add']>>; warning: string | null }> {
  const result = await store.add('memory', content, signal);
  let warning: string | null = null;
  if (result.success && dbManager) {
    try {
      for (const entry of result.evicted_entries ?? []) {
        removeExactSyncedMemories(dbManager, entry, { target: 'memory', project: boundName });
      }
      syncMemoryEntry(dbManager, { content, target: 'memory', project: boundName });
    } catch (err) {
      warning = `Saved to the local project store, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { result, warning };
}

function toolResult(text: string, details: StatusDetails) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

/** Render the query answer (FR-11: current status, last state change, which machine made it). */
function renderQuery(projectDisplay: string, resp: StatusResponse): string {
  if (resp.status === null) {
    return [
      `${projectDisplay}: no status recorded.`,
      'shared: up',
    ].join('\n');
  }
  const s = resp.status;
  return [
    `${projectDisplay}: ${s.state}`,
    `  note: ${s.content}`,
    `  last state change: ${s.updated_at} — made by ${s.machine} (session ${truncatedSession(s.session)})`,
    'shared: up',
  ].join('\n');
}

/** The hub-down query answer: the explicit signal IS the answer (AD-11). */
function renderDownQuery(projectDisplay: string, client: SharedMemoryOptions['client']): string {
  return [
    `${projectDisplay}: live status unavailable — the hub is down (there is no local status source; the static rollup is retired).`,
    downSignalLine(client),
  ].join('\n');
}

export function registerMemoryStatusTool(
  pi: ExtensionAPI,
  dbManager: DatabaseManager | null,
  options: MemoryStatusToolOptions,
): void {
  const { shared, projectStoreRef, projectNameRef, bindProjectFromCwd } = options;

  pi.registerTool({
    name: 'memory_status',
    label: 'Memory Status',
    description: `Query or set a project's LIVE status in shared memory (the status rollup — the static discoveries-status.yaml is retired; there is no file to keep in sync).

Query (omit state): current status, the note, the last state change, and which machine made it.
Set (state = one of the six words, plus a short note on why / what's next): records the change in shared memory, visible from every box.

Use this whenever a project's state changes (a story completes, work is parked, a project is abandoned) or when asked where a project stands — even on a box without the project checked out. When the hub is down the tool says so explicitly: a query reports live status unavailable, and a set lands in the local project store (this box only) when possible.`,
    promptSnippet: 'Query or set a project\'s live status (shared memory rollup)',
    promptGuidelines: [
      'Use memory_status to record a project state change instead of editing any status file.',
      'Use memory_status (query) to check where a project stands, even without a local checkout.',
    ],
    parameters: Type.Object({
      project: Type.Optional(Type.String({
        description: 'Project name (a registry entry). Omit inside a project checkout for the current project.',
      })),
      state: Type.Optional(StringEnum(STATUS_WORDS as readonly [string, ...string[]], {
        description: `Set the project status to one of: ${STATUS_WORDS.join(', ')}. Omit to query the current status.`,
      })),
      content: Type.Optional(Type.String({
        description: 'Note about the state (why it changed / what is next). Defaults to "status: <state>" when omitted.',
      })),
    }),
    execute: async (_toolCallId, args: StatusToolArgs, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string | undefined } }) => {
      if (bindProjectFromCwd && ctx?.cwd) {
        await bindProjectFromCwd(ctx.cwd);
      }
      const { project, state, content } = args;
      const isSet = state !== undefined;
      const stateWord = state as StatusWord | undefined;

      // `content` without `state` has nowhere to attach — a user error, not
      // a query-with-extra (explicit, per NFR-4).
      if (!isSet && content !== undefined && content.trim().length > 0) {
        return toolResult(
          'content requires state — set a status to attach a note (or drop content to query).',
          { success: false, error: 'content requires state' },
        );
      }

      // AD-10: resolve the project BEFORE any network. Named → registry
      // (name authoritative); nameless → cwd git remote / advisory paths.
      const resolved = await sharedResolve(shared, project ?? undefined, ctx?.cwd);
      if (!resolved.key) {
        const note = unresolvedProjectNote(project ?? 'project', resolved.note);
        const text = isSet ? `${note} Status NOT recorded.` : note;
        return toolResult(text, { success: false, project: project ?? undefined, error: note });
      }
      // Display name: the given name, else the bound name (nameless cwd
      // calls), else the key (a repo with no registry entry — still a valid
      // identity, AD-10).
      const boundName = resolveProjectName(projectNameRef);
      const display = project?.trim() || (project === undefined && boundName ? boundName : resolved.key);

      // Probe (≤ 500 ms, cached + backoff) — the turn-budget gate.
      const up = await shared.client.probe();

      if (!isSet) {
        // ── QUERY: GET /status (live derivation, FR-11) ──
        if (!up) {
          // No local status source exists (the YAML is retired) — the
          // explicit signal IS the answer (AD-11).
          return toolResult(renderDownQuery(display, shared.client), { success: true, project: display, state: null, shared: 'down' });
        }
        try {
          const resp = await shared.client.status(resolved.key);
          shared.client.clearDownSignal();
          return toolResult(renderQuery(display, resp), {
            success: true,
            project: display,
            state: resp.status ? (resp.status.state as StatusWord) : null,
            ...(resp.status ? {
              content: resp.status.content,
              updated_at: resp.status.updated_at,
              machine: resp.status.machine,
              session: resp.status.session,
            } : {}),
            shared: 'up',
          });
        } catch (err) {
          if (err instanceof HubUnreachableError) {
            // The hub died inside the up-cache window — down, not an error.
            return toolResult(renderDownQuery(display, shared.client), { success: true, project: display, state: null, shared: 'down' });
          }
          const detail = err instanceof Error ? err.message : String(err);
          return toolResult(`${display}: shared: error — ${detail}`, { success: false, project: display, shared: 'error', error: detail });
        }
      }

      // ── SET: upsert a status-kind entry ──
      const finalContent = content !== undefined && content.trim().length > 0
        ? content.trim()
        : defaultStatusContent(stateWord!);
      const sessionId = ctx?.sessionManager?.getSessionId?.() ?? 'unknown';

      const runLocalFallback = async (): Promise<ReturnType<typeof toolResult>> => {
        const write = localProjectWrite(project, projectStoreRef, projectNameRef);
        if (!write.ok) {
          const bound = write.boundName ?? 'none';
          return toolResult(
            [
              downSignalLine(shared.client),
              `Status NOT recorded: no local project store for "${display}" on this box (bound project: ${bound}). Retry when the hub is up.`,
            ].join('\n'),
            { success: false, project: display, state: stateWord!, shared: 'down', error: 'not recorded (hub down, no local store for this project)' },
          );
        }
        const { result, warning } = await writeLocalProjectStatus(write.store, write.boundName, dbManager, finalContent, signal);
        if (!result.success) {
          return toolResult(
            [
              downSignalLine(shared.client),
              `Status NOT recorded: the local project store rejected the entry (${result.error ?? 'unknown error'}). Retry when the hub is up.`,
            ].join('\n'),
            { success: false, project: display, state: stateWord!, shared: 'down', error: result.error },
          );
        }
        const note = warning ? ` Warning: ${warning}` : '';
        return toolResult(
          [
            `Status set locally: ${display} → ${stateWord} — ${JSON.stringify(finalContent)}${note}`,
            '(shared memory unavailable — saved in the local project store; visible on this box only while the hub is down)',
          ].join('\n'),
          { success: true, project: display, state: stateWord!, content: finalContent, shared: 'down' },
        );
      };

      if (!up) {
        // Hub down ⇒ FR-17: the write stays local when this box has a store
        // for the target project; the signal is explicit either way.
        return await runLocalFallback();
      }

      try {
        const { action } = await sharedStatusSet(
          { client: shared.client, sessionId, scope: 'memory', projectKey: resolved.key },
          stateWord!,
          finalContent,
        );
        shared.client.clearDownSignal();
        const suffix = action === 'inserted'
          ? `recorded in shared memory by ${shared.client.machine}`
          : 'already present — provenance extended';
        return toolResult(
          `Status set: ${display} → ${stateWord} — ${JSON.stringify(finalContent)} (${suffix}).`,
          { success: true, project: display, state: stateWord!, content: finalContent, machine: shared.client.machine, shared: 'up' },
        );
      } catch (err) {
        if (err instanceof HubUnreachableError) {
          // The hub died inside the up-cache window (probe said up, the
          // call failed) — that is the DOWN case (FR-17), not a rejection
          // (same split as the memory_add path).
          return await runLocalFallback();
        }
        // HubHttpError (e.g. blocked content 400): explicit — a blocked
        // status note must not silently land in the local tier (NFR-4).
        const detail = err instanceof Error ? err.message : String(err);
        return toolResult(
          `Shared store rejected the status update: ${detail}`,
          { success: false, project: display, state: stateWord!, shared: 'error', error: detail },
        );
      }
    },
  });
}
