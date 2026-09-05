import fs from 'node:fs';
import { DEFAULT_MAX_MESSAGE_CONTENT_LENGTH } from '../constants.js';
import { DatabaseManager } from './db.js';
import { parseSessionFile, getSessionFiles, isSessionFile, type ParsedSession } from './session-parser.js';

export const LAST_SESSION_BACKFILL_KEY = 'last_session_backfill';
export const SESSION_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Index result for a single session.
 */
export interface IndexResult {
  sessionId: string;
  messagesIndexed: number;
  skipped: boolean; // true if the session already existed and no new messages were indexed
}

/**
 * Bulk index result.
 */
export interface BulkIndexResult {
  sessionsProcessed: number;
  sessionsIndexed: number;
  sessionsSkipped: number;
  messagesIndexed: number;
  errors: string[];
  reachedLimit?: boolean;
  /** Session files skipped because their mtime is outside the retention window. */
  expiredSkipped?: number;
  /**
   * JSONL files skipped because their first line is not a `{"type":"session"}`
   * header (see isSessionFile). Non-session extension artifacts living in the
   * shared sessions directory land here instead of surfacing as parse errors.
   */
  nonSessionSkipped?: number;
}

interface SessionFileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface IncrementalIndexOptions {
  projectDir?: string;
  maxFilesToIndex?: number;
  /**
   * Optional retention cutoff (ms epoch). JSONL session files whose mtime is
   * strictly older than this cutoff are considered outside the retained window
   * and are skipped entirely (not queued for indexing or counted as changed).
   * This keeps incremental backfill aligned with session retention pruning:
   * sessions pruned by pruneOldSessions() are never re-indexed on a later
   * startup. Omit/0 to index every file (backwards-compatible default).
   */
  retentionCutoffMs?: number;
  /**
   * First-level directory names (exact or `*` globs) under the sessions root
   * to skip entirely, from the `sessionIndexExclude` config. Applies only to
   * the all-projects scan; an explicit projectDir is never filtered.
   */
  excludeDirs?: string[];
}

/**
 * True when a session JSONL file's last-modified time falls within the
 * retention window (mtime >= cutoff). Files older than the cutoff are treated
 * as expired and are ineligible for backfill/indexing so that pruned sessions
 * are not re-surfaced.
 */
function isWithinRetention(mtimeMs: number, retentionCutoffMs: number | undefined): boolean {
  return !retentionCutoffMs || mtimeMs >= retentionCutoffMs;
}

export function truncateMessageContent(
  content: string,
  maxLength = DEFAULT_MAX_MESSAGE_CONTENT_LENGTH,
): string {
  if (content.length <= maxLength) return content;

  const notice = `\n... (truncated, ${content.length} chars total)\n`;
  const retainedLength = Math.max(0, maxLength - notice.length);
  const prefixLength = Math.ceil(retainedLength / 2);
  const suffixLength = Math.floor(retainedLength / 2);
  const suffix = suffixLength > 0 ? content.slice(-suffixLength) : '';
  return `${content.slice(0, prefixLength)}${notice}${suffix}`;
}

/**
 * Index a single session into the database.
 *
 * @returns IndexResult with count of messages indexed
 */
export function indexSession(dbManager: DatabaseManager, session: ParsedSession): IndexResult {
  return dbManager.withCorruptionRecovery(() => indexSessionOnce(dbManager, session));
}

function indexSessionOnce(dbManager: DatabaseManager, session: ParsedSession): IndexResult {
  const db = dbManager.getDb();

  const existingSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id) as { id: string } | undefined;
  const before = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };

  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, project, cwd, started_at, ended_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const updateSession = db.prepare(`
    UPDATE sessions
    SET project = ?,
        cwd = ?,
        ended_at = COALESCE(?, ended_at),
        message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?)
    WHERE id = ?
  `);

  const writeSession = () => {
    insertSession.run(
      session.id,
      session.project,
      session.cwd,
      session.startedAt,
      session.endedAt,
      session.messages.length
    );

    for (const msg of session.messages) {
      insertMsg.run(
        msg.id,
        session.id,
        msg.role,
        truncateMessageContent(msg.content),
        msg.timestamp,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null
      );
    }

    updateSession.run(session.project, session.cwd, session.endedAt, session.id, session.id);
  };

  if (db.transaction) {
    const tx = db.transaction(writeSession);
    tx();
  } else {
    writeSession();
  }

  const after = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };
  const messagesIndexed = after.count - before.count;

  return { sessionId: session.id, messagesIndexed, skipped: Boolean(existingSession) && messagesIndexed === 0 };
}

type SessionManagerSnapshot = {
  getHeader: () => { id: string; timestamp: string; cwd: string } | null;
  getEntries: () => unknown[];
  getSessionFile?: () => string | undefined;
};

type SessionMessageEntryLike = {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') parts.push(b.text);
        break;
      case 'tool_result':
        // Tool results can contain unbounded file or command output. Tool
        // calls are indexed separately, so retaining their output adds bloat
        // without improving session search.
        break;
    }
  }

  return parts.join('\n').trim();
}

function extractToolCalls(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const toolNames: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if ((b.type === 'toolCall' || b.type === 'tool_use') && typeof b.name === 'string') {
      toolNames.push(b.name);
    }
  }
  return toolNames.length > 0 ? toolNames : undefined;
}

function parseMessageEntry(entry: unknown): ParsedSession['messages'][number] | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as SessionMessageEntryLike;
  if (e.type !== 'message' || typeof e.id !== 'string' || typeof e.timestamp !== 'string' || !e.message) return null;

  const role = e.message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;

  const content = extractTextContent(e.message.content);
  if (!content) return null;

  return {
    id: e.id,
    role,
    content,
    timestamp: e.timestamp,
    toolCalls: role === 'assistant' ? extractToolCalls(e.message.content) : undefined,
  };
}

export function parseSessionManagerSnapshot(sessionManager: SessionManagerSnapshot): ParsedSession | null {
  const header = sessionManager.getHeader();
  if (!header?.id || !header.cwd || !header.timestamp) return null;

  const messages = sessionManager.getEntries()
    .map(parseMessageEntry)
    .filter((msg): msg is ParsedSession['messages'][number] => msg !== null);

  return {
    id: header.id,
    project: header.cwd.split('/').pop() ?? header.cwd,
    cwd: header.cwd,
    startedAt: header.timestamp,
    endedAt: null,
    messages,
  };
}

export function indexCurrentSession(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  const session = parseSessionManagerSnapshot(sessionManager);
  if (!session) return null;
  return indexSession(dbManager, session);
}

export function indexLiveSession(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  return dbManager.withCorruptionRecovery(() => indexLiveSessionOnce(dbManager, sessionManager));
}

function indexLiveSessionOnce(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  const sessionFile = sessionManager.getSessionFile?.();
  if (sessionManager.getSessionFile && !sessionFile) return null;
  if (sessionFile && fs.existsSync(sessionFile)) {
    const session = parseSessionFile(sessionFile);
    if (session) {
      const result = indexSession(dbManager, session);
      upsertSessionFileMetadata(dbManager, sessionFile, session.id);
      return result;
    }
  }

  return indexCurrentSession(dbManager, sessionManager);
}

/**
 * Remove rows created by background review subprocesses that ran with
 * `--no-session` before live indexing rejected ephemeral sessions.
 */
export function pruneEphemeralReviewSessions(dbManager: DatabaseManager): number {
  return dbManager.withCorruptionRecovery(() => {
    const db = dbManager.getDb();
    const candidates = db.prepare(`
      SELECT s.id
      FROM sessions s
      WHERE NOT EXISTS (
        SELECT 1 FROM session_files sf WHERE sf.session_id = s.id
      )
        AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) = 1
        AND EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.session_id = s.id
            AND m.content LIKE ?
        )
    `).all('<file name="/tmp/pi-hermes-prompt-%') as Array<{ id: string }>;

    if (candidates.length === 0) return 0;

    const placeholders = candidates.map(() => '?').join(', ');
    const ids = candidates.map(({ id }) => id);
    const remove = () => {
      db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
      return db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids).changes;
    };

    return db.transaction ? db.transaction(remove)() : remove();
  });
}

function getSessionFileMetadata(filePath: string): SessionFileMetadata {
  const stat = fs.statSync(filePath);
  return { path: filePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function getStoredSessionFileMetadata(dbManager: DatabaseManager, filePath: string): { size: number; mtime_ms: number } | undefined {
  return dbManager.getDb().prepare('SELECT size, mtime_ms FROM session_files WHERE path = ?').get(filePath) as { size: number; mtime_ms: number } | undefined;
}

function storedSessionFileMatches(dbManager: DatabaseManager, metadata: SessionFileMetadata): boolean {
  const row = getStoredSessionFileMetadata(dbManager, metadata.path);
  return Boolean(row && row.size === metadata.size && row.mtime_ms === metadata.mtimeMs);
}

export function upsertSessionFileMetadata(
  dbManager: DatabaseManager,
  filePath: string,
  sessionId: string,
  metadata = getSessionFileMetadata(filePath),
  indexedAt = new Date(),
): void {
  const db = dbManager.getDb();
  db.prepare(`
    INSERT INTO session_files (path, session_id, size, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      session_id = excluded.session_id,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      indexed_at = excluded.indexed_at
  `).run(metadata.path, sessionId, metadata.size, metadata.mtimeMs, indexedAt.toISOString());
}

function emptyBulkIndexResult(): BulkIndexResult {
  return {
    sessionsProcessed: 0,
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    messagesIndexed: 0,
    errors: [],
  };
}

function indexSessionFile(dbManager: DatabaseManager, file: string, result: BulkIndexResult): void {
  if (!isSessionFile(file)) {
    // Not a session JSONL (extension artifact in the shared sessions dir):
    // skip silently — this is expected content, not an indexing failure, and
    // not even a "processed" candidate file.
    result.nonSessionSkipped = (result.nonSessionSkipped ?? 0) + 1;
    return;
  }

  result.sessionsProcessed++;

  const session = parseSessionFile(file);
  if (!session) {
    result.errors.push(`Failed to parse: ${file}`);
    return;
  }

  const indexResult = indexSession(dbManager, session);
  upsertSessionFileMetadata(dbManager, file, session.id);
  if (indexResult.skipped) {
    result.sessionsSkipped++;
  } else {
    result.sessionsIndexed++;
    result.messagesIndexed += indexResult.messagesIndexed;
  }
}

/**
 * Index all sessions from disk.
 * With retentionCutoffMs > 0, files whose mtime falls outside the window are
 * skipped (counted in expiredSkipped) so a manual reindex honors the same
 * retention policy the auto pruning enforces, instead of re-adding expired
 * sessions that pruning just deleted.
 *
 * @param dbManager — Database manager instance
 * @param sessionsDir — Path to ~/.pi/agent/sessions/
 * @param projectDir — Optional: specific project directory to index
 * @param retentionCutoffMs — Optional: epoch ms; files modified before it are skipped
 * @returns Bulk index result
 */
export function indexAllSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  projectDir?: string,
  retentionCutoffMs = 0,
  excludeDirs: string[] = [],
): BulkIndexResult {
  const files = getSessionFiles(sessionsDir, projectDir, excludeDirs);
  const result = emptyBulkIndexResult();
  let expiredSkipped = 0;

  for (const file of files) {
    if (retentionCutoffMs > 0) {
      try {
        if (!isWithinRetention(getSessionFileMetadata(file).mtimeMs, retentionCutoffMs)) {
          expiredSkipped++;
          continue;
        }
      } catch {
        // Unreadable metadata: let indexSessionFile report the real error.
      }
    }

    try {
      indexSessionFile(dbManager, file, result);
    } catch (err) {
      result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (expiredSkipped > 0) {
    result.expiredSkipped = expiredSkipped;
  }

  return result;
}

/**
 * Incrementally index session JSONL files without matching stored metadata.
 *
 * This is intentionally cheaper than indexAllSessions() for startup backfill:
 * files with matching stored size/mtime metadata are skipped, and all other
 * files are parsed under the startup cap.
 */
export function indexChangedSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  options: IncrementalIndexOptions = {},
): BulkIndexResult {
  const files = getSessionFiles(sessionsDir, options.projectDir, options.excludeDirs);
  const maxFilesToIndex = options.maxFilesToIndex ?? 50;
  const result = emptyBulkIndexResult();

  // Gather the changed set first, then sort newest-first before applying the
  // cap. Crash recovery is the primary value of startup backfill (the live
  // message_end path missed the session's final state), and crashed sessions
  // are the most recently modified files. Sorting newest-first ensures they
  // are indexed on the very next startup instead of waiting behind old
  // historical files that fill the per-startup cap in filesystem order.
  const changed: SessionFileMetadata[] = [];
  for (const file of files) {
    try {
      if (!isSessionFile(file)) {
        // Extension artifacts in the shared sessions dir: never queued, never
        // counted against the per-startup cap, never surfaced as errors.
        result.nonSessionSkipped = (result.nonSessionSkipped ?? 0) + 1;
        continue;
      }
      const metadata = getSessionFileMetadata(file);
      if (!isWithinRetention(metadata.mtimeMs, options.retentionCutoffMs)) {
        // Outside the retained window (e.g. pruned by pruneOldSessions):
        // never re-queue it for indexing, so a pruned session does not come
        // back on the next startup backfill.
        continue;
      }
      if (storedSessionFileMatches(dbManager, metadata)) {
        result.sessionsSkipped++;
        continue;
      }
      changed.push(metadata);
    } catch (err) {
      result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  changed.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const metadata of changed) {
    if (result.sessionsProcessed >= maxFilesToIndex) {
      result.reachedLimit = true;
      break;
    }
    try {
      indexSessionFile(dbManager, metadata.path, result);
    } catch (err) {
      result.errors.push(`Error indexing ${metadata.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Cheaply count session JSONL files in the same scope indexAllSessions scans.
 */
export function countSessionFiles(sessionsDir: string): number {
  return getSessionFiles(sessionsDir).length;
}

function getLastBackfillTimestamp(dbManager: DatabaseManager): string | null {
  const db = dbManager.getDb();
  const row = db.prepare('SELECT value FROM extension_metadata WHERE key = ?').get(LAST_SESSION_BACKFILL_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function isRecentBackfillTimestamp(value: string | null, nowMs: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed < SESSION_BACKFILL_INTERVAL_MS;
}

/**
 * Determine whether a background session backfill should run.
 *
 * The check stays cheap: it compares file counts and stored file size/mtime
 * metadata. Full JSONL parsing is left to the scheduled incremental backfill.
 */
export function needsBackfill(
  dbManager: DatabaseManager,
  sessionsDir: string,
  now = new Date(),
  retentionCutoffMs = 0,
): boolean {
  const db = dbManager.getDb();
  const files = getSessionFiles(sessionsDir);
  const indexed = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };

  if (retentionCutoffMs <= 0) {
    // Retention disabled: keep the historical cheap path — a plain file-count
    // vs row-count comparison decides before any per-file stat work, so
    // large session directories stay fast on startup.
    if (files.length > indexed.count) {
      return true;
    }

    for (const file of files) {
      try {
        const metadata = getSessionFileMetadata(file);
        if (storedSessionFileMatches(dbManager, metadata)) continue;
        return true;
      } catch {
        // An unreadable or malformed session file still needs indexing.
        return true;
      }
    }

    return !isRecentBackfillTimestamp(getLastBackfillTimestamp(dbManager), now.getTime());
  }

  // Retention enabled: one metadata pass decides everything — a retained file
  // with stale stored metadata demands a backfill, and when no file is inside
  // the window there is no work at all. Returning here (instead of falling
  // through to the periodic timestamp check) keeps an all-expired store from
  // scheduling an empty backfill on every startup before a timestamp is ever
  // written.
  let hasRetainedFile = false;
  for (const file of files) {
    try {
      const metadata = getSessionFileMetadata(file);
      if (!isWithinRetention(metadata.mtimeMs, retentionCutoffMs)) continue;
      hasRetainedFile = true;
      if (!storedSessionFileMatches(dbManager, metadata)) return true;
    } catch {
      return true;
    }
  }
  if (!hasRetainedFile) {
    return false;
  }
  return !isRecentBackfillTimestamp(getLastBackfillTimestamp(dbManager), now.getTime());
}

/**
 * Record a successful session backfill completion timestamp.
 */
export function touchBackfillTimestamp(dbManager: DatabaseManager, timestamp = new Date()): void {
  const db = dbManager.getDb();
  db.prepare(`
    INSERT INTO extension_metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(LAST_SESSION_BACKFILL_KEY, timestamp.toISOString());
}

/**
 * Get statistics about indexed sessions.
 */
export function getSessionStats(dbManager: DatabaseManager): {
  totalSessions: number;
  totalMessages: number;
  projects: { project: string; sessions: number; messages: number }[];
} {
  const db = dbManager.getDb();

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) as sessions,
      (SELECT COUNT(*) FROM messages) as messages
  `).get() as { sessions: number; messages: number };

  const projects = db.prepare(`
    SELECT
      project,
      COUNT(*) as sessions,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id IN (SELECT id FROM sessions s2 WHERE s2.project = s.project)) as messages
    FROM sessions s
    GROUP BY project
    ORDER BY sessions DESC
  `).all() as { project: string; sessions: number; messages: number }[];

  return {
    totalSessions: totals.sessions,
    totalMessages: totals.messages,
    projects,
  };
}

/**
 * Compute the retention cutoff (ms epoch) from a retention window in days.
 * Returns 0 (no cutoff) when retention is undefined/zero/disabled.
 */
export function retentionCutoffMs(retentionDays: number | undefined): number {
  if (!retentionDays || retentionDays <= 0) return 0;
  return Date.now() - retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * Delete sessions outside the retention window, along with their messages,
 * to bound the growth of the session index database (see #183).
 *
 * A session is eligible for pruning when its session file's last-mod time is
 * older than the window (falling back to started_at when no file metadata
 * exists). This deliberately mirrors the backfill eligibility check in
 * `needsBackfill`/`indexChangedSessions` (also keyed to file mtime), so a
 * pruned session's on-disk JSONL file is never re-indexed by a later startup
 * and never re-triggers a backfill. Retention and backfill therefore agree on
 * the same eligible file set.
 *
 * `messages` and `session_files` reference `sessions`, but only `session_files`
 * is declared `ON DELETE CASCADE`. Orphaned `messages` rows are deleted
 * explicitly first so a `PRAGMA foreign_keys`-enabled delete never trips a
 * FK constraint, and so an accurate `messagesRemoved` count is reported.
 *
 * Returns the number of sessions and messages removed.
 */
export function pruneOldSessions(
  dbManager: DatabaseManager,
  retentionDays: number,
): { sessionsRemoved: number; messagesRemoved: number } {
  const db = dbManager.getDb();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // A session is pruned when it falls outside the retention window. We use the
  // same signal the backfill eligibility uses -- the session file's last-mod
  // time -- so that a pruned session's on-disk JSONL file is not re-indexed on
  // a later startup. Sessions without file metadata (e.g. indexed before files
  // were tracked) fall back to started_at. Both must be strictly older than
  // the cutoff.
  const eligibleSessionIds = db.prepare(`
    SELECT s.id
    FROM sessions s
    LEFT JOIN session_files sf ON sf.session_id = s.id
    WHERE
      (sf.path IS NOT NULL AND sf.mtime_ms < ?)
      OR (sf.path IS NULL AND s.started_at < ?)
  `).all(cutoffMs, cutoffIso) as Array<{ id: string }>;

  if (eligibleSessionIds.length === 0) {
    return { sessionsRemoved: 0, messagesRemoved: 0 };
  }

  // Count messages upfront because SQLite does not surface cascade/orphan
  // counts from DELETE ... RETURNING across tables.
  const messageCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM messages WHERE session_id IN (${eligibleSessionIds.map(() => '?').join(',')})`,
  ).get(...eligibleSessionIds.map((r) => r.id)) as { cnt: number };

  const prune = () => {
    const delMessages = db.prepare(
      `DELETE FROM messages WHERE session_id IN (${eligibleSessionIds.map(() => '?').join(',')})`,
    ).run(...eligibleSessionIds.map((r) => r.id));
    const delSessions = db.prepare(
      `DELETE FROM sessions WHERE id IN (${eligibleSessionIds.map(() => '?').join(',')})`,
    ).run(...eligibleSessionIds.map((r) => r.id));
    return { messagesRemoved: delMessages.changes, sessionsRemoved: delSessions.changes };
  };

  const result = db.transaction ? db.transaction(prune)() : prune();
  // Fall back to the pre-counted values if the transaction changed nothing
  // unexpectedly (defensive; DELETE should always affect the counted rows).
  return {
    sessionsRemoved: result.sessionsRemoved || eligibleSessionIds.length,
    messagesRemoved: result.messagesRemoved || messageCount.cnt,
  };
}
