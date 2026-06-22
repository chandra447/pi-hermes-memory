import type { DatabaseManager } from '../store/db.js';
import {
  indexChangedSessions,
  needsBackfill,
  touchBackfillTimestamp,
  type BulkIndexResult,
} from '../store/session-indexer.js';

export const SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS = 5000;
export const SESSION_BACKFILL_MAX_FILES = 50;

type NotifyLevel = 'info' | 'warning' | 'error';
type NotifyFn = (message: string, level: NotifyLevel) => void;

type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

export interface SessionBackfillState {
  inProgress: boolean;
  promise: Promise<void> | null;
}

export const sessionBackfillState: SessionBackfillState = {
  inProgress: false,
  promise: null,
};

export interface ScheduleSessionBackfillOptions {
  notify?: NotifyFn;
  state?: SessionBackfillState;
  setTimeoutFn?: SetTimeoutFn;
  needsBackfillFn?: typeof needsBackfill;
  indexSessionsFn?: typeof indexChangedSessions;
  maxFilesToIndex?: number;
  touchBackfillTimestampFn?: typeof touchBackfillTimestamp;
}

function formatBackfillResult(result: BulkIndexResult): string {
  const errorSuffix = result.errors.length > 0 ? ` (${result.errors.length} file error${result.errors.length === 1 ? '' : 's'})` : '';
  const limitSuffix = result.reachedLimit ? ' (startup limit reached)' : '';
  return `🧠 Session backfill complete: ${result.sessionsIndexed} indexed, ${result.sessionsSkipped} skipped, ${result.messagesIndexed} messages${errorSuffix}${limitSuffix}.`;
}

function notifyBestEffort(notify: NotifyFn | undefined, message: string, level: NotifyLevel): void {
  try {
    notify?.(message, level);
  } catch {
    // Notification failures must never affect backfill.
  }
}

/**
 * Schedule a best-effort, bounded incremental backfill of unindexed Pi sessions.
 *
 * The JSONL parsing work is deferred with setTimeout(0) so session_start can
 * resolve first. The scheduled pass only parses files without matching stored
 * metadata and caps the number of files parsed per startup.
 *
 * @returns true when a backfill task was scheduled; false when it was skipped.
 */
export function scheduleSessionBackfill(
  dbManager: DatabaseManager,
  sessionsDir: string,
  options: ScheduleSessionBackfillOptions = {},
): boolean {
  const state = options.state ?? sessionBackfillState;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const needsBackfillFn = options.needsBackfillFn ?? needsBackfill;
  const indexSessionsFn = options.indexSessionsFn ?? indexChangedSessions;
  const maxFilesToIndex = options.maxFilesToIndex ?? SESSION_BACKFILL_MAX_FILES;
  const touchBackfillTimestampFn = options.touchBackfillTimestampFn ?? touchBackfillTimestamp;

  if (state.inProgress) {
    return false;
  }

  try {
    if (!needsBackfillFn(dbManager, sessionsDir)) {
      return false;
    }
  } catch (err) {
    notifyBestEffort(
      options.notify,
      `⚠️ Session backfill check failed: ${err instanceof Error ? err.message : String(err)}`,
      'warning',
    );
    return false;
  }

  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(() => {
      try {
        const result = indexSessionsFn(dbManager, sessionsDir, { maxFilesToIndex });
        if (!result.reachedLimit) touchBackfillTimestampFn(dbManager);
        notifyBestEffort(options.notify, formatBackfillResult(result), result.errors.length > 0 || result.reachedLimit ? 'warning' : 'info');
      } catch (err) {
        notifyBestEffort(
          options.notify,
          `⚠️ Session backfill failed: ${err instanceof Error ? err.message : String(err)}`,
          'warning',
        );
      } finally {
        state.inProgress = false;
        state.promise = null;
        resolve();
      }
    }, 0);
  });

  return true;
}

/**
 * Wait briefly for an in-progress backfill before shutdown closes SQLite.
 *
 * @returns true if no backfill was running or it completed before the timeout;
 * false if the timeout elapsed first.
 */
export async function waitForSessionBackfill(
  timeoutMs = SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS,
  state: SessionBackfillState = sessionBackfillState,
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
