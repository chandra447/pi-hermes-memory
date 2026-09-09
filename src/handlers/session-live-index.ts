import { measureLifecycle } from '../lifecycle-timing.js';
import type { DatabaseManager } from '../store/db.js';
import { indexLiveSession, indexLiveSessionAsync } from '../store/session-indexer.js';

export const SESSION_LIVE_INDEX_DELAY_MS = 50;
export const SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS = 5000;

type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

type SessionManagerSnapshot = Parameters<typeof indexLiveSession>[1];

export interface SessionLiveIndexState {
  inProgress: boolean;
  promise: Promise<void> | null;
  pending?: Map<string, () => Promise<void>>;
}

export const sessionLiveIndexState: SessionLiveIndexState = {
  inProgress: false,
  promise: null,
};

export interface ScheduleLiveSessionIndexOptions {
  state?: SessionLiveIndexState;
  setTimeoutFn?: SetTimeoutFn;
  indexLiveSessionFn?: typeof indexLiveSession | typeof indexLiveSessionAsync;
  delayMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Schedule non-blocking indexing of the current live session.
 *
 * Pi emits message_end before it appends the finalized message to the JSONL
 * session file/session manager. Deferring briefly lets Pi persist the entry
 * first, then we index any message ids not already present in SQLite. Multiple
 * message_end events in the same window coalesce into one all-missing sync.
 */
export function scheduleLiveSessionIndex(
  dbManager: DatabaseManager,
  sessionManager: SessionManagerSnapshot,
  options: ScheduleLiveSessionIndexOptions = {},
): boolean {
  const state = options.state ?? sessionLiveIndexState;
  const pending = state.pending ??= new Map();
  const key = sessionManager.getSessionFile?.() ?? sessionManager.getHeader()?.id ?? 'ephemeral';
  if (!pending.has(key)) pending.set(key, async () => {
    try {
      await dbManager.withCorruptionRecovery(() => (options.indexLiveSessionFn ?? indexLiveSessionAsync)(dbManager, sessionManager));
    } catch (err) {
      try { options.onError?.(err); } catch { /* best effort */ }
    }
  });
  if (state.inProgress) {
    return false;
  }

  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const delayMs = options.delayMs ?? SESSION_LIVE_INDEX_DELAY_MS;

  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(() => {
      void measureLifecycle('live-index.callback', async () => {
        try {
          while (pending.size) {
            const [nextKey, run] = pending.entries().next().value!;
            pending.delete(nextKey);
            await run();
          }
        } finally {
          state.inProgress = false;
          state.promise = null;
          resolve();
        }
      });
    }, delayMs);
  });

  return true;
}

export async function waitForLiveSessionIndex(
  timeoutMs = SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS,
  state: SessionLiveIndexState = sessionLiveIndexState,
): Promise<boolean> {
  const promise = state.promise;
  if (!state.inProgress || !promise) {
    return true;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
