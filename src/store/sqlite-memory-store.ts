import { DatabaseManager } from './db.js';
import {
  buildFallbackFts5Query,
  collectSignificantSearchTerms,
  isFts5QueryError,
  normalizeFts5Query,
  passesTermHitFilter,
} from './fts-query.js';
import { normalizeMemoryLookupText } from './memory-lookup.js';
import type { MemoryCategory } from '../types.js';

const MEMORY_SELECT_COLUMNS = `
  id,
  project,
  target,
  category,
  content,
  failure_reason,
  tool_state,
  corrected_to,
  created,
  last_referenced
`;

const FAILURE_CATEGORY_SET = new Set<MemoryCategory>([
  'failure',
  'correction',
  'insight',
  'preference',
  'convention',
  'tool-quirk',
]);

/**
 * A memory entry stored in SQLite.
 */
export interface SqliteMemoryEntry {
  id: number;
  project: string | null;
  target: 'memory' | 'user' | 'failure';
  category: MemoryCategory | null;
  content: string;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;
  lastReferenced: string;
}

export interface SqliteMemorySyncInput {
  content: string;
  target: 'memory' | 'user' | 'failure';
  project?: string | null;
  category?: MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
}

export interface SqliteMemorySyncResult {
  action: 'inserted' | 'existing';
  entry: SqliteMemoryEntry;
}

export interface SqliteMemoryUpdateResult {
  matched: number;
  updated: number;
  entries: SqliteMemoryEntry[];
}

export interface SqliteMemoryRemoveResult {
  matched: number;
  removed: number;
}

export interface SqliteMemoryRemoveOptions {
  target: 'memory' | 'user' | 'failure';
  project?: string | null;
}

export interface MarkdownMemoryReconcileResult {
  inserted: number;
  existing: number;
  removed: number;
}

export interface ParsedMarkdownMemoryEntry extends SqliteMemorySyncInput {}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function normalizeNullable(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCategory(value?: MemoryCategory | null): MemoryCategory | null {
  return value ?? null;
}

function mapRow(row: {
  id: number;
  project: string | null;
  target: string;
  category: string | null;
  content: string;
  failure_reason: string | null;
  tool_state: string | null;
  corrected_to: string | null;
  created: string;
  last_referenced: string;
}): SqliteMemoryEntry {
  return {
    id: row.id,
    project: row.project,
    target: row.target as 'memory' | 'user' | 'failure',
    category: row.category as MemoryCategory | null,
    content: row.content,
    failureReason: row.failure_reason,
    toolState: row.tool_state,
    correctedTo: row.corrected_to,
    created: row.created,
    lastReferenced: row.last_referenced,
  };
}

function buildScopeConditions(params: unknown[], target?: string, project?: string | null, category?: MemoryCategory | null): string[] {
  const conditions: string[] = [];

  if (target) {
    conditions.push('target = ?');
    params.push(target);
  }

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('project = ?');
      params.push(project);
    }
  }

  if (category !== undefined) {
    if (category === null) {
      conditions.push('category IS NULL');
    } else {
      conditions.push('category = ?');
      params.push(category);
    }
  }

  return conditions;
}

function getMemoryById(dbManager: DatabaseManager, id: number): SqliteMemoryEntry | null {
  const db = dbManager.getDb();
  const row = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE id = ?
  `).get(id) as {
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  } | undefined;

  return row ? mapRow(row) : null;
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function parseMetadataComment(raw: string): { text: string; created: string; lastReferenced: string; project: string | null } {
  const match = raw.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/);
  if (match) {
    let project: string | null = null;
    if (match[4]) {
      try { project = Buffer.from(match[4], 'base64url').toString('utf-8').trim() || null; } catch {}
    }
    return {
      text: match[1].trim(),
      created: match[2].trim(),
      lastReferenced: match[3].trim(),
      project,
    };
  }

  const fallback = today();
  return {
    text: raw.trim(),
    created: fallback,
    lastReferenced: fallback,
    project: null,
  };
}

/**
 * Add a memory entry to the SQLite store.
 */
export function addMemory(
  dbManager: DatabaseManager,
  content: string,
  target: 'memory' | 'user' | 'failure' = 'memory',
  project: string | null = null,
  category: MemoryCategory | null = null,
  failureReason: string | null = null,
  toolState: string | null = null,
  correctedTo: string | null = null,
  created = today(),
  lastReferenced = created
): SqliteMemoryEntry {
  const db = dbManager.getDb();

  const result = db.prepare(`
    INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced);

  return {
    id: Number(result.lastInsertRowid),
    project,
    target,
    category,
    content,
    failureReason,
    toolState,
    correctedTo,
    created,
    lastReferenced,
  };
}

/**
 * Build the visible failure-memory text stored in Markdown.
 */
export function formatFailureMemoryContent(
  content: string,
  options: {
    category: MemoryCategory;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    project?: string | null;
  }
): string {
  const categoryTag = `[${options.category}]`;
  const parts = [`${categoryTag} ${content.trim()}`.trim()];
  if (options.failureReason) parts.push(`Failed: ${options.failureReason}`);
  if (options.toolState) parts.push(`Tool state: ${options.toolState}`);
  if (options.correctedTo) parts.push(`Corrected to: ${options.correctedTo}`);
  return parts.join(' — ');
}

/**
 * Parse a Markdown memory entry into SQLite sync fields.
 * Best-effort only: if failure metadata cannot be fully reconstructed,
 * content is still imported and available for search.
 */
export function parseMarkdownMemoryEntry(
  rawEntry: string,
  target: 'memory' | 'user' | 'failure',
  project: string | null = null,
): ParsedMarkdownMemoryEntry {
  const metadata = parseMetadataComment(rawEntry);
  const { text, created, lastReferenced } = metadata;
  const parsedProject = normalizeNullable(project);

  if (target !== 'failure') {
    return {
      content: text,
      target,
      project: parsedProject,
      created,
      lastReferenced,
    };
  }

  let category: MemoryCategory | null = null;
  let failureReason: string | null = null;
  let toolState: string | null = null;
  let correctedTo: string | null = null;

  const categoryMatch = text.match(/^\[([^\]]+)\]\s+/);
  if (categoryMatch && FAILURE_CATEGORY_SET.has(categoryMatch[1] as MemoryCategory)) {
    category = categoryMatch[1] as MemoryCategory;
  }

  const segments = text.split(' — ');
  for (const segment of segments.slice(1)) {
    if (segment.startsWith('Failed: ') && !failureReason) {
      failureReason = segment.slice('Failed: '.length).trim() || null;
      continue;
    }
    if (segment.startsWith('Tool state: ') && !toolState) {
      toolState = segment.slice('Tool state: '.length).trim() || null;
      continue;
    }
    if (segment.startsWith('Corrected to: ') && !correctedTo) {
      correctedTo = segment.slice('Corrected to: '.length).trim() || null;
    }
  }

  return {
    content: text,
    target: 'failure',
    project: parsedProject,
    category,
    failureReason,
    toolState,
    correctedTo,
    created,
    lastReferenced,
  };
}

/**
 * Idempotently sync a Markdown-backed memory entry into SQLite.
 * Duplicate identity is exact: project + target + category + content.
 */
export function syncMemoryEntry(
  dbManager: DatabaseManager,
  input: SqliteMemorySyncInput,
): SqliteMemorySyncResult {
  const db = dbManager.getDb();
  const content = input.content.trim();
  const project = normalizeNullable(input.project);
  const category = normalizeCategory(input.category);
  const failureReason = normalizeNullable(input.failureReason);
  const toolState = normalizeNullable(input.toolState);
  const correctedTo = normalizeNullable(input.correctedTo);
  const created = input.created?.trim() || today();
  const lastReferenced = input.lastReferenced?.trim() || created;

  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, input.target, project, category);
  conditions.push('content = ?');
  params.push(content);

  const existing = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY id ASC
    LIMIT 1
  `).get(...params) as {
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  } | undefined;

  if (!existing) {
    return {
      action: 'inserted',
      entry: addMemory(
        dbManager,
        content,
        input.target,
        project,
        category,
        failureReason,
        toolState,
        correctedTo,
        created,
        lastReferenced,
      ),
    };
  }

  const updatedCreated = minDate(existing.created, created);
  const updatedLastReferenced = maxDate(existing.last_referenced, lastReferenced);
  const updatedCategory = (existing.category as MemoryCategory | null) ?? category;
  const updatedFailureReason = existing.failure_reason ?? failureReason;
  const updatedToolState = existing.tool_state ?? toolState;
  const updatedCorrectedTo = existing.corrected_to ?? correctedTo;

  db.prepare(`
    UPDATE memories
    SET category = ?, failure_reason = ?, tool_state = ?, corrected_to = ?, created = ?, last_referenced = ?
    WHERE id = ?
  `).run(
    updatedCategory,
    updatedFailureReason,
    updatedToolState,
    updatedCorrectedTo,
    updatedCreated,
    updatedLastReferenced,
    existing.id,
  );

  return {
    action: 'existing',
    entry: getMemoryById(dbManager, existing.id)!,
  };
}

/**
 * Make one exact Markdown target/project scope authoritative in SQLite.
 * Upserts and orphan deletion are committed together when transactions are
 * supported by the active SQLite driver.
 */
export function reconcileMarkdownMemoryScope(
  dbManager: DatabaseManager,
  rawEntries: string[],
  target: 'memory' | 'user' | 'failure',
  project: string | null = null,
): MarkdownMemoryReconcileResult {
  const db = dbManager.getDb();
  const normalizedProject = normalizeNullable(project);

  const reconcile = (): MarkdownMemoryReconcileResult => {
    let inserted = 0;
    let existing = 0;
    const desiredIdentities = new Set<string>();

    for (const rawEntry of rawEntries) {
      const parsed = parseMarkdownMemoryEntry(rawEntry, target, normalizedProject);
      desiredIdentities.add(JSON.stringify([
        normalizeCategory(parsed.category),
        parsed.content.trim(),
      ]));
      const result = syncMemoryEntry(dbManager, parsed);
      if (result.action === 'inserted') inserted++;
      else existing++;
    }

    const params: unknown[] = [];
    const conditions = buildScopeConditions(params, target, normalizedProject);
    const scopedRows = db.prepare(`
      SELECT id, content, category
      FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY id ASC
    `).all(...params) as Array<{ id: number; content: string; category: MemoryCategory | null }>;
    const retainedIdentities = new Set<string>();
    const orphanIds: number[] = [];
    for (const row of scopedRows) {
      const identity = JSON.stringify([normalizeCategory(row.category), row.content.trim()]);
      if (!desiredIdentities.has(identity) || retainedIdentities.has(identity)) {
        orphanIds.push(row.id);
      } else {
        retainedIdentities.add(identity);
      }
    }

    let removed = 0;
    if (orphanIds.length > 0) {
      const placeholders = orphanIds.map(() => '?').join(', ');
      removed = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...orphanIds).changes;
    }

    return { inserted, existing, removed };
  };

  const transactional = db.transaction?.(reconcile);
  return transactional ? transactional() : reconcile();
}

function failureProject(rawEntry: string): string | null {
  return parseMetadataComment(rawEntry).project;
}

export function reconcileMarkdownFailureScopes(
  dbManager: DatabaseManager,
  rawEntries: string[],
): MarkdownMemoryReconcileResult {
  const entriesByProject = new Map<string | null, string[]>();
  for (const rawEntry of rawEntries) {
    const project = failureProject(rawEntry);
    const entries = entriesByProject.get(project) ?? [];
    entries.push(rawEntry);
    entriesByProject.set(project, entries);
  }

  const mirroredProjects = dbManager.getDb().prepare(`
    SELECT DISTINCT project
    FROM memories
    WHERE target = 'failure'
  `).all() as Array<{ project: string | null }>;
  const projects = new Set<string | null>([
    null,
    ...entriesByProject.keys(),
    ...mirroredProjects.map(({ project }) => normalizeNullable(project)),
  ]);
  const total: MarkdownMemoryReconcileResult = { inserted: 0, existing: 0, removed: 0 };

  for (const project of projects) {
    const result = reconcileMarkdownMemoryScope(
      dbManager,
      entriesByProject.get(project) ?? [],
      'failure',
      project,
    );
    total.inserted += result.inserted;
    total.existing += result.existing;
    total.removed += result.removed;
  }

  return total;
}

/**
 * Best-effort substring replacement for SQLite-backed memory sync.
 * Updates all matches in the scoped slice to recover from prior duplicate rows.
 */
export function replaceSyncedMemories(
  dbManager: DatabaseManager,
  oldText: string,
  updates: {
    content: string;
    target: 'memory' | 'user' | 'failure';
    project?: string | null;
    category?: MemoryCategory | null;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    lastReferenced?: string | null;
  },
): SqliteMemoryUpdateResult {
  const db = dbManager.getDb();
  const normalizedOldText = normalizeMemoryLookupText(oldText);
  if (!normalizedOldText) return { matched: 0, updated: 0, entries: [] };
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, updates.target, updates.project ?? undefined);
  conditions.push(`content LIKE ? ESCAPE '\\'`);
  params.push(`%${escapeLikePattern(normalizedOldText)}%`);

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY id ASC
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  }>;

  if (rows.length === 0) {
    return { matched: 0, updated: 0, entries: [] };
  }

  const nextLastReferenced = updates.lastReferenced?.trim() || today();

  for (const row of rows) {
    db.prepare(`
      UPDATE memories
      SET content = ?,
          category = ?,
          failure_reason = ?,
          tool_state = ?,
          corrected_to = ?,
          last_referenced = ?
      WHERE id = ?
    `).run(
      updates.content.trim(),
      updates.category === undefined ? row.category : updates.category,
      updates.failureReason === undefined ? row.failure_reason : normalizeNullable(updates.failureReason),
      updates.toolState === undefined ? row.tool_state : normalizeNullable(updates.toolState),
      updates.correctedTo === undefined ? row.corrected_to : normalizeNullable(updates.correctedTo),
      nextLastReferenced,
      row.id,
    );
  }

  return {
    matched: rows.length,
    updated: rows.length,
    entries: rows
      .map((row) => getMemoryById(dbManager, row.id))
      .filter((entry): entry is SqliteMemoryEntry => entry !== null),
  };
}

/**
 * Best-effort substring removal for SQLite-backed memory sync.
 * Deletes all matches in the scoped slice to recover from prior duplicate rows.
 */
export function removeSyncedMemories(
  dbManager: DatabaseManager,
  oldText: string,
  options: SqliteMemoryRemoveOptions,
): SqliteMemoryRemoveResult {
  const db = dbManager.getDb();
  const normalizedOldText = normalizeMemoryLookupText(oldText);
  if (!normalizedOldText) return { matched: 0, removed: 0 };
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
  conditions.push(`content LIKE ? ESCAPE '\\'`);
  params.push(`%${escapeLikePattern(normalizedOldText)}%`);

  const matchingIds = db.prepare(`
    SELECT id
    FROM memories
    WHERE ${conditions.join(' AND ')}
  `).all(...params) as Array<{ id: number }>;

  if (matchingIds.length === 0) {
    return { matched: 0, removed: 0 };
  }

  const deleteParams = matchingIds.map((row) => row.id);
  const placeholders = deleteParams.map(() => '?').join(', ');
  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteParams);

  return {
    matched: matchingIds.length,
    removed: result.changes,
  };
}

/**
 * Exact removal for Markdown entries whose full content is known.
 * Used for FIFO eviction cleanup, where substring matching could remove
 * unrelated SQLite mirror rows that merely contain the evicted text.
 */
export function removeExactSyncedMemories(
  dbManager: DatabaseManager,
  content: string,
  options: SqliteMemoryRemoveOptions,
): SqliteMemoryRemoveResult {
  const db = dbManager.getDb();
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
  conditions.push('content = ?');
  params.push(content.trim());

  const matchingIds = db.prepare(`
    SELECT id
    FROM memories
    WHERE ${conditions.join(' AND ')}
  `).all(...params) as Array<{ id: number }>;

  if (matchingIds.length === 0) {
    return { matched: 0, removed: 0 };
  }

  const deleteParams = matchingIds.map((row) => row.id);
  const placeholders = deleteParams.map(() => '?').join(', ');
  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteParams);

  return {
    matched: matchingIds.length,
    removed: result.changes,
  };
}

/**
 * Search memories using FTS5.
 *
 * Ranking: BM25 (lower is better) primary, last_referenced secondary.
 * OR fallback is tightened: only significant terms, and post-filtered by
 * term-hit ratio so a single common word cannot surface unrelated long memories.
 */
export function searchMemories(
  dbManager: DatabaseManager,
  query: string,
  options: { project?: string; target?: string; category?: MemoryCategory; limit?: number } = {}
): SqliteMemoryEntry[] {
  if (query.trim().length === 0) {
    return [];
  }

  const db = dbManager.getDb();
  const { project, target, category, limit = 10 } = options;

  // FTS5 match via JOIN with BM25 ranking
  const normalizedQuery = normalizeFts5Query(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const significantTerms = collectSignificantSearchTerms(query);

  const runSearch = (
    matchQuery: string,
    searchOpts: { requireTermHitFilter?: boolean; fetchMultiplier?: number } = {}
  ): SqliteMemoryEntry[] => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const requireTermHitFilter = searchOpts.requireTermHitFilter ?? false;
    const fetchMultiplier = searchOpts.fetchMultiplier ?? 1;

    conditions.push('memory_fts MATCH ?');
    params.push(matchQuery);

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

    if (category) {
      conditions.push('m.category = ?');
      params.push(category);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Over-fetch when we will post-filter OR hits by term coverage.
    const fetchLimit = Math.min(Math.max(limit * fetchMultiplier, limit), 100);

    const sql = `
      SELECT
        m.id,
        m.project,
        m.target,
        m.category,
        m.content,
        m.failure_reason,
        m.tool_state,
        m.corrected_to,
        m.created,
        m.last_referenced,
        bm25(memory_fts) AS rank_score
      FROM memories m
      JOIN memory_fts ON memory_fts.rowid = m.id
      ${whereClause}
      ORDER BY rank_score ASC, m.last_referenced DESC
      LIMIT ?
    `;

    try {
      const rows = db.prepare(sql).all(...params, fetchLimit) as Array<{
        id: number;
        project: string | null;
        target: string;
        category: string | null;
        content: string;
        failure_reason: string | null;
        tool_state: string | null;
        corrected_to: string | null;
        created: string;
        last_referenced: string;
        rank_score: number;
      }>;

      let mapped = rows.map(mapRow);
      if (requireTermHitFilter && significantTerms.length > 0) {
        mapped = mapped.filter((entry) => passesTermHitFilter(entry.content, significantTerms));
      }
      return mapped.slice(0, limit);
    } catch (err) {
      if (isFts5QueryError(err)) {
        return [];
      }
      throw err;
    }
  };

  const exactResults = runSearch(normalizedQuery);
  if (exactResults.length > 0) {
    return exactResults;
  }

  const fallbackQuery = buildFallbackFts5Query(query);
  if (!fallbackQuery || fallbackQuery === normalizedQuery) {
    return exactResults;
  }

  return runSearch(fallbackQuery, { requireTermHitFilter: true, fetchMultiplier: 4 });
}

/**
 * Get all memories, optionally filtered.
 */
export function getMemories(
  dbManager: DatabaseManager,
  options: { project?: string | null; target?: string; category?: MemoryCategory } = {}
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const { project, target, category } = options;

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

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    ${whereClause}
    ORDER BY last_referenced DESC
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  }>;

  return rows.map(mapRow);
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
 * Get recent failure memories (last N days).
 */
export function getRecentFailures(
  dbManager: DatabaseManager,
  maxAgeDays = 7,
  project?: string | null
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const conditions: string[] = ['target = ?', 'created >= ?'];
  const params: unknown[] = ['failure', cutoffStr];

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('(project = ? OR project IS NULL)');
      params.push(project);
    }
  }

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY created DESC
    LIMIT 5
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  }>;

  return rows.map(mapRow);
}

/**
 * Update a memory's last_referenced date.
 */
export function touchMemory(dbManager: DatabaseManager, id: number): void {
  const db = dbManager.getDb();
  db.prepare('UPDATE memories SET last_referenced = ? WHERE id = ?').run(today(), id);
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
