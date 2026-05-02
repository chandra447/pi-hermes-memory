import { DatabaseManager } from './db.js';
import { parseSessionFile, getSessionFiles, type ParsedSession } from './session-parser.js';

/**
 * Index result for a single session.
 */
export interface IndexResult {
  sessionId: string;
  messagesIndexed: number;
  skipped: boolean; // true if already indexed
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
}

/**
 * Index a single session into the database.
 *
 * @returns IndexResult with count of messages indexed
 */
export function indexSession(dbManager: DatabaseManager, session: ParsedSession): IndexResult {
  const db = dbManager.getDb();

  // Check if already indexed
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id) as { id: string } | undefined;
  if (existing) {
    return { sessionId: session.id, messagesIndexed: 0, skipped: true };
  }

  // Insert session
  db.prepare(`
    INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.project,
    session.cwd,
    session.startedAt,
    session.endedAt,
    session.messages.length
  );

  // Insert messages in a transaction for performance
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((messages: ParsedSession['messages']) => {
    for (const msg of messages) {
      insertMsg.run(
        msg.id,
        session.id,
        msg.role,
        msg.content,
        msg.timestamp,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null
      );
    }
  });

  insertMany(session.messages);

  return { sessionId: session.id, messagesIndexed: session.messages.length, skipped: false };
}

/**
 * Index all sessions from disk.
 *
 * @param dbManager — Database manager instance
 * @param sessionsDir — Path to ~/.pi/agent/sessions/
 * @param projectDir — Optional: specific project directory to index
 * @returns Bulk index result
 */
export function indexAllSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  projectDir?: string
): BulkIndexResult {
  const files = getSessionFiles(sessionsDir, projectDir);
  const result: BulkIndexResult = {
    sessionsProcessed: 0,
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    messagesIndexed: 0,
    errors: [],
  };

  for (const file of files) {
    result.sessionsProcessed++;

    try {
      const session = parseSessionFile(file);
      if (!session) {
        result.errors.push(`Failed to parse: ${file}`);
        continue;
      }

      const indexResult = indexSession(dbManager, session);
      if (indexResult.skipped) {
        result.sessionsSkipped++;
      } else {
        result.sessionsIndexed++;
        result.messagesIndexed += indexResult.messagesIndexed;
      }
    } catch (err) {
      result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
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
