import { DatabaseManager } from './db.js';

/**
 * A memory entry stored in SQLite.
 */
export interface SqliteMemoryEntry {
  id: number;
  project: string | null;
  target: 'memory' | 'user';
  content: string;
  created: string;
  lastReferenced: string;
}

/**
 * Add a memory entry to the SQLite store.
 */
export function addMemory(
  dbManager: DatabaseManager,
  content: string,
  target: 'memory' | 'user' = 'memory',
  project: string | null = null
): SqliteMemoryEntry {
  const db = dbManager.getDb();
  const today = new Date().toISOString().split('T')[0];

  const result = db.prepare(`
    INSERT INTO memories (project, target, content, created, last_referenced)
    VALUES (?, ?, ?, ?, ?)
  `).run(project, target, content, today, today);

  return {
    id: Number(result.lastInsertRowid),
    project,
    target,
    content,
    created: today,
    lastReferenced: today,
  };
}

/**
 * Escape a string for FTS5 query syntax.
 * Wraps the query in double quotes to treat it as a literal phrase.
 */
function escapeFts5Query(query: string): string {
  // If the query already contains FTS5 operators (OR, AND, NOT, NEAR), leave it as-is
  if (/\b(OR|AND|NOT|NEAR)\b/.test(query)) {
    return query;
  }
  // Otherwise, wrap in double quotes to treat as literal phrase
  return `"${query.replace(/"/g, '""')}"`;
}

/**
 * Search memories using FTS5.
 */
export function searchMemories(
  dbManager: DatabaseManager,
  query: string,
  options: { project?: string; target?: string; limit?: number } = {}
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const { project, target, limit = 10 } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];

  // FTS5 match via subquery with escaped query
  conditions.push('m.id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?)');
  params.push(escapeFts5Query(query));

  if (project !== undefined) {
    if (project === null) {
      conditions.push('m.project IS NULL');
    } else {
      conditions.push('m.project = ?');
      params.push(project);
    }
  }

  if (target) {
    conditions.push('m.target = ?');
    params.push(target);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT id, project, target, content, created, last_referenced
    FROM memories m
    ${whereClause}
    ORDER BY m.last_referenced DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    content: string;
    created: string;
    last_referenced: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    project: row.project,
    target: row.target as 'memory' | 'user',
    content: row.content,
    created: row.created,
    lastReferenced: row.last_referenced,
  }));
}

/**
 * Get all memories, optionally filtered.
 */
export function getMemories(
  dbManager: DatabaseManager,
  options: { project?: string | null; target?: string } = {}
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const { project, target } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('project = ?');
      params.push(project);
    }
  }

  if (target) {
    conditions.push('target = ?');
    params.push(target);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT id, project, target, content, created, last_referenced
    FROM memories
    ${whereClause}
    ORDER BY last_referenced DESC
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    content: string;
    created: string;
    last_referenced: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    project: row.project,
    target: row.target as 'memory' | 'user',
    content: row.content,
    created: row.created,
    lastReferenced: row.last_referenced,
  }));
}

/**
 * Remove a memory by ID.
 */
export function removeMemory(dbManager: DatabaseManager, id: number): boolean {
  const db = dbManager.getDb();
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Update a memory's last_referenced date.
 */
export function touchMemory(dbManager: DatabaseManager, id: number): void {
  const db = dbManager.getDb();
  const today = new Date().toISOString().split('T')[0];
  db.prepare('UPDATE memories SET last_referenced = ? WHERE id = ?').run(today, id);
}

/**
 * Get memory statistics.
 */
export function getMemoryStats(dbManager: DatabaseManager): {
  total: number;
  byProject: { project: string | null; count: number }[];
  byTarget: { target: string; count: number }[];
} {
  const db = dbManager.getDb();

  const total = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;

  const byProject = db.prepare(`
    SELECT project, COUNT(*) as count
    FROM memories
    GROUP BY project
    ORDER BY count DESC
  `).all() as { project: string | null; count: number }[];

  const byTarget = db.prepare(`
    SELECT target, COUNT(*) as count
    FROM memories
    GROUP BY target
    ORDER BY count DESC
  `).all() as { target: string; count: number }[];

  return { total, byProject, byTarget };
}
