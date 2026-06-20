import { DatabaseManager } from './db.js';
import { buildFallbackFts5Query, hasExplicitFts5Operator, isFts5QueryError, normalizeFts5Query } from './fts-query.js';

/**
 * Search result from session history.
 */
export interface SessionSearchResult {
  sessionId: string;
  project: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
}

/**
 * Search options for session search.
 */
export interface SessionSearchOptions {
  /** Maximum number of results (default: 10) */
  limit?: number;
  /** Filter by project name */
  project?: string;
  /** Filter by role: 'user', 'assistant', 'system' */
  role?: string;
  /** Only return messages after this date (ISO string) */
  since?: string;
}

type SearchMatch =
  | { type: 'fts'; query: string }
  | { type: 'like'; terms: string[] };

const QUERY_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(['and', 'or', 'not', 'near']);

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function collectLikeTerms(query: string): string[] {
  const terms: string[] = [];

  for (const match of query.matchAll(QUERY_TOKEN_PATTERN)) {
    const phrase = match[1];
    const term = match[2];
    if (phrase === undefined && term && NATURAL_LANGUAGE_CONNECTORS.has(term.toLowerCase())) {
      continue;
    }

    const rawValue = phrase ?? term ?? '';
    if (rawValue.length > 0) terms.push(rawValue);
  }

  return terms;
}

function mapRows(rows: Array<{
  session_id: string;
  project: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
}>): SessionSearchResult[] {
  return rows.map(row => ({
    sessionId: row.session_id,
    project: row.project,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    snippet: row.snippet,
  }));
}

/**
 * Search across indexed session messages using FTS5.
 *
 * @param dbManager — Database manager instance
 * @param query — FTS5 search query
 * @param options — Search options
 * @returns Array of search results with snippets
 */
export function searchSessions(
  dbManager: DatabaseManager,
  query: string,
  options: SessionSearchOptions = {}
): SessionSearchResult[] {
  if (query.trim().length === 0) {
    return [];
  }

  const db = dbManager.getDb();
  const { limit = 10, project, role, since } = options;

  const executeSearch = (match: SearchMatch): SessionSearchResult[] => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (match.type === 'fts') {
      // FTS5 match condition — use subquery for reliable rowid matching
      conditions.push('m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)');
      params.push(match.query);
    } else {
      if (match.terms.length === 0) {
        return [];
      }
      const likeConditions = match.terms.map(() => `m.content LIKE ? ESCAPE '\\'`);
      conditions.push(`(${likeConditions.join(' OR ')})`);
      for (const term of match.terms) {
        params.push(`%${escapeLikePattern(term)}%`);
      }
    }

    // Project filter
    if (project) {
      conditions.push('s.project = ?');
      params.push(project);
    }

    // Role filter
    if (role) {
      conditions.push('m.role = ?');
      params.push(role);
    }

    // Date filter
    if (since) {
      conditions.push('m.timestamp >= ?');
      params.push(since);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT
        m.session_id,
        s.project,
        m.role,
        m.content,
        m.timestamp,
        m.content as snippet
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      ${whereClause}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `;

    try {
      const rows = db.prepare(sql).all(...params, limit) as Array<{
        session_id: string;
        project: string;
        role: string;
        content: string;
        timestamp: string;
        snippet: string;
      }>;

      return mapRows(rows);
    } catch (err) {
      if (match.type === 'fts' && isFts5QueryError(err)) {
        return [];
      }
      throw err;
    }
  };

  const normalizedQuery = normalizeFts5Query(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const exactResults = executeSearch({ type: 'fts', query: normalizedQuery });
  if (exactResults.length > 0) {
    return exactResults;
  }

  const explicitOperatorQuery = hasExplicitFts5Operator(query);
  if (explicitOperatorQuery) {
    return exactResults;
  }

  const fallbackQuery = buildFallbackFts5Query(query);
  if (fallbackQuery && fallbackQuery !== normalizedQuery) {
    const fallbackResults = executeSearch({ type: 'fts', query: fallbackQuery });
    if (fallbackResults.length > 0) {
      return fallbackResults;
    }
  }

  const likeTerms = collectLikeTerms(query);
  return executeSearch({ type: 'like', terms: likeTerms });
}

/**
 * Get the total number of indexed messages.
 */
export function getIndexedMessageCount(dbManager: DatabaseManager): number {
  const db = dbManager.getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}
