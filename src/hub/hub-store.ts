/**
 * Hub shared store — new minimal single-writer module (spine AD-7).
 *
 * The hub is the sole writer of the shared store (AD-3/C3): one process, one
 * better-sqlite3 writer, no file locks, no markdown mirroring, no legacy
 * migrations — deliberately NOT the local `DatabaseManager`. What carries
 * over from v1: the data model (six categories, scopes, FTS5 trigram pattern)
 * and the pure gate functions (lifted to `src/shared/`).
 *
 * Identity: client-generated UUIDv7 primary keys; every mutation is an
 * idempotent upsert, last-writer-wins by `updated_at` (AD-9 — the exact
 * property the v2.1 op-log seam needs).
 *
 * Provenance (`machine`, `session`, `identity`, `created_at`, `updated_at`)
 * is mandatory on every row (AD-8/AD-13) — the schema enforces NOT NULL.
 */

import { loadBetterSqlite3 } from '../store/sqlite-native.js';
import {
  buildFallbackFts5Query,
  buildNaturalLanguageFallbackQuery,
  collectLikeTerms,
  isFts5QueryError,
  normalizeFts5Query,
  normalizeNaturalLanguageFts5Query,
} from '../store/fts-query.js';
import {
  cleanHit,
  type ProviderSearchHit,
  type RecallableProvider,
} from '../shared/clean-hit.js';
import type {
  EntryKind,
  MemoryCategory,
  MemoryScope,
  StatusWord,
} from '../shared/vocabulary.js';
import type { ProvenanceTouch, SharedEntry } from '../shared/wire.js';

/**
 * Hub schema. Columns mirror the v1 `memories` data model (same categories,
 * scopes, FTS5 trigram + sync triggers) plus the mandatory provenance block.
 * `state` is reserved for `kind = 'status'` entries (spine "Status entries").
 */
export const HUB_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    project_key TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('memory', 'user', 'failure')),
    category TEXT CHECK (category IS NULL OR category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
    kind TEXT NOT NULL DEFAULT 'memory' CHECK (kind IN ('memory', 'status')),
    state TEXT CHECK (state IS NULL OR state IN ('active', 'done', 'hardening', 'held', 'dormant', 'abandoned')),
    content TEXT NOT NULL,
    failure_reason TEXT,
    tool_state TEXT,
    corrected_to TEXT,
    machine TEXT NOT NULL,
    session TEXT NOT NULL,
    identity TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    provenance TEXT NOT NULL DEFAULT '[]'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
    content,
    content='entries',
    content_rowid='rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entry_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entry_fts(entry_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entry_fts(entry_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO entry_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE INDEX IF NOT EXISTS idx_entries_project_key ON entries(project_key);
  CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope);
  CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
  CREATE INDEX IF NOT EXISTS idx_entries_updated_at ON entries(updated_at);
`;

/**
 * Additive migrations for stores created before story 2. Checked by
 * PRAGMA table_info so re-opening an existing store is idempotent.
 */
const ADDITIVE_MIGRATIONS: Array<{ column: string; alter: string }> = [
  { column: 'provenance', alter: "ALTER TABLE entries ADD COLUMN provenance TEXT NOT NULL DEFAULT '[]'" },
];

interface EntryRow {
  id: string;
  project_key: string | null;
  scope: string;
  category: string | null;
  kind: string;
  state: string | null;
  content: string;
  failure_reason: string | null;
  tool_state: string | null;
  corrected_to: string | null;
  machine: string;
  session: string;
  identity: string;
  created_at: string;
  updated_at: string;
  provenance: string | null;
}

const SELECT_COLUMNS = `
  id, project_key, scope, category, kind, state, content,
  failure_reason, tool_state, corrected_to,
  machine, session, identity, created_at, updated_at, provenance
`;

// The FTS join query also sees entry_fts's `content` column, so that one
// needs the same list qualified with the `entries` alias (same trick as the
// v1 store's MEMORY_SELECT_COLUMNS_M).
const SELECT_COLUMNS_E = SELECT_COLUMNS
  .split(',')
  .map((column) => `e.${column.trim()}`)
  .join(', ');

/** Input to {@link HubStore.upsert}. Provenance fields are mandatory. */
export interface HubUpsertInput {
  id: string;
  content: string;
  project_key?: string | null;
  scope: MemoryScope;
  category?: MemoryCategory | null;
  kind?: EntryKind;
  state?: StatusWord | null;
  failure_reason?: string | null;
  tool_state?: string | null;
  corrected_to?: string | null;
  machine: string;
  session: string;
  identity: string;
  created_at: string;
  updated_at: string;
  /**
   * Replace-procedure pointer (story 2): seed this entry's provenance from
   * the referenced entry's list (plus the writing machine's touch). The
   * hub resolves it server-side — the client never supplies provenance
   * entries (AD-8). Absent reference / missing entry ⇒ seed empty.
   */
  inherits_from?: string;
}

export interface HubSearchOptions {
  project?: string | null;
  /** Project-ATTRIBUTED entries only (project_key IS NOT NULL). Ignored when `project` is present. */
  projectAny?: boolean;
  scope?: MemoryScope;
  category?: MemoryCategory;
  /** ISO timestamp; older hits are dropped by the recency gate. */
  minRecencyAt?: string;
  limit?: number;
}

/**
 * Parse a stored provenance list; legacy rows (pre-story-2) have NULL/'[]'
 * and backfill to a single touch from their existing stamps (the row's
 * machine/session/created_at describe that first write).
 */
function parseProvenance(row: EntryRow): ProvenanceTouch[] {
  if (row.provenance !== null && row.provenance.length > 0) {
    try {
      const parsed = JSON.parse(row.provenance) as ProvenanceTouch[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // fall through to the legacy backfill — a corrupt list must not 500 reads.
    }
  }
  return [{ machine: row.machine, session: row.session, at: row.created_at }];
}

/**
 * Merge one touch into a provenance list: set semantics keyed by machine —
 * a machine keeps its FIRST touch (earliest `at`), new machines append.
 * Result ordered by `at` (ties broken by machine for determinism).
 */
export function mergeProvenance(existing: ProvenanceTouch[], touch: ProvenanceTouch): ProvenanceTouch[] {
  const byMachine = new Map<string, ProvenanceTouch>();
  for (const t of existing) {
    const prev = byMachine.get(t.machine);
    if (prev === undefined || t.at < prev.at) byMachine.set(t.machine, t);
  }
  const prev = byMachine.get(touch.machine);
  if (prev === undefined || touch.at < prev.at) byMachine.set(touch.machine, touch);
  return [...byMachine.values()].sort((a, b) => (a.at === b.at ? a.machine.localeCompare(b.machine) : a.at < b.at ? -1 : 1));
}

function mapRow(row: EntryRow): SharedEntry {
  return {
    id: row.id,
    ...(row.project_key !== null ? { project_key: row.project_key } : {}),
    scope: row.scope as MemoryScope,
    ...(row.category !== null ? { category: row.category as MemoryCategory } : {}),
    kind: row.kind as EntryKind,
    ...(row.state !== null ? { state: row.state as StatusWord } : {}),
    content: row.content,
    ...(row.failure_reason !== null ? { failure_reason: row.failure_reason } : {}),
    ...(row.tool_state !== null ? { tool_state: row.tool_state } : {}),
    ...(row.corrected_to !== null ? { corrected_to: row.corrected_to } : {}),
    machine: row.machine,
    session: row.session,
    identity: row.identity,
    created_at: row.created_at,
    updated_at: row.updated_at,
    provenance: parseProvenance(row),
  };
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function isShortCjkLiteralQuery(query: string): boolean {
  const trimmed = query.trim();
  return [...trimmed].length <= 2
    && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(trimmed);
}

type Statement = {
  run: (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};
type Database = {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => void;
  close: () => void;
  pragma: (query: string) => unknown;
};

/**
 * The hub's single-writer shared store. One instance per hub process; all
 * mutations go through this API (spine: "never raw SQL in route handlers").
 */
export class HubStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    const Ctor = loadBetterSqlite3();
    this.db = new Ctor(dbPath) as unknown as Database;
    this.db.pragma('journal_mode = WAL');
    this.db.exec(HUB_SCHEMA_SQL);
    this.runAdditiveMigrations();
  }

  private runAdditiveMigrations(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(entries)')
      .all() as Array<{ name: string }>;
    const have = new Set(columns.map((c) => c.name));
    for (const { column, alter } of ADDITIVE_MIGRATIONS) {
      if (!have.has(column)) this.db.exec(alter);
    }
  }

  /**
   * Idempotent upsert, last-writer-wins by `updated_at` (AD-9).
   * - no existing row → insert, returns `'inserted'`
   * - existing row with `updated_at >=` the incoming one → no-op, returns `'kept'`
   * - existing row strictly older → replace, returns `'replaced'`
   *
   * On replace, the original `created_at` is preserved (an entry keeps its
   * birth time; `updated_at` moves).
   */
  upsert(input: HubUpsertInput): 'inserted' | 'replaced' | 'kept' {
    const existing = this.db
      .prepare('SELECT machine, session, created_at, updated_at, provenance FROM entries WHERE id = ?')
      .get(input.id) as { machine: string; session: string; created_at: string; updated_at: string; provenance: string | null } | undefined;

    if (existing && existing.updated_at >= input.updated_at) {
      return 'kept';
    }

    const createdAt = existing ? existing.created_at : input.created_at;

    // Provenance list (story 2, Q1=B): the writing machine's touch merges
    // into the existing list (set by machine, first-touch wins) — a
    // re-add from another box EXTENDS the list instead of overwriting.
    // The touch time is the arrival (`updated_at`), not the entry's birth —
    // a machine's first touch is when IT wrote the content.
    const touch: ProvenanceTouch = { machine: input.machine, session: input.session, at: input.updated_at };
    let base: ProvenanceTouch[];
    if (existing) {
      // A legacy existing row (NULL list) backfills to ITS OWN first touch —
      // select its real stamps, not the incoming ones.
      base = parseProvenance({
        id: input.id,
        project_key: null,
        scope: input.scope,
        category: null,
        kind: 'memory',
        state: null,
        content: input.content,
        failure_reason: null,
        tool_state: null,
        corrected_to: null,
        ...existing,
        identity: existing.machine,
        updated_at: input.updated_at,
      });
    } else if (input.inherits_from && input.inherits_from !== input.id) {
      // Replace procedure: inherit the old entry's contributor list. The
      // reference may already be gone (concurrent remove) — seed empty. A
      // legacy inherited row (NULL list) backfills to its own single touch
      // from its real stamps, so select those.
      const inherited = this.db
        .prepare('SELECT machine, session, created_at, provenance FROM entries WHERE id = ?')
        .get(input.inherits_from) as { machine: string; session: string; created_at: string; provenance: string | null } | undefined;
      base = inherited
        ? parseProvenance({
            id: input.inherits_from,
            project_key: null,
            scope: input.scope,
            category: null,
            kind: 'memory',
            state: null,
            content: input.content,
            failure_reason: null,
            tool_state: null,
            corrected_to: null,
            ...inherited,
            identity: inherited.machine,
            updated_at: input.updated_at,
          })
        : [];
    } else {
      base = [];
    }
    const provenance = mergeProvenance(base, touch);

    this.db
      .prepare(`
        INSERT INTO entries (
          id, project_key, scope, category, kind, state, content,
          failure_reason, tool_state, corrected_to,
          machine, session, identity, created_at, updated_at, provenance
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_key = excluded.project_key,
          scope = excluded.scope,
          category = excluded.category,
          kind = excluded.kind,
          state = excluded.state,
          content = excluded.content,
          failure_reason = excluded.failure_reason,
          tool_state = excluded.tool_state,
          corrected_to = excluded.corrected_to,
          machine = excluded.machine,
          session = excluded.session,
          identity = excluded.identity,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          provenance = excluded.provenance
      `)
      .run(
        input.id,
        input.project_key ?? null,
        input.scope,
        input.category ?? null,
        input.kind ?? 'memory',
        input.state ?? null,
        input.content,
        input.failure_reason ?? null,
        input.tool_state ?? null,
        input.corrected_to ?? null,
        input.machine,
        input.session,
        input.identity,
        createdAt,
        input.updated_at,
        JSON.stringify(provenance),
      );

    return existing ? 'replaced' : 'inserted';
  }

  getEntry(id: string): SharedEntry | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM entries WHERE id = ?`)
      .get(id) as EntryRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * FTS search with the v1 fallback ladder, then the shared clean-hit gates
   * (scope / recency / scanContent — the SAME lifted `cleanHit` the local
   * providers use, so parity holds by construction, C9/AD-12).
   */
  search(query: string, options: HubSearchOptions = {}): { hits: SharedEntry[]; raw_matches: number } {
    if (query.trim().length === 0) {
      return { hits: [], raw_matches: 0 };
    }
    const { project, projectAny, scope, category, minRecencyAt, limit = 10 } = options;

    const applyScopeFilters = (conditions: string[], params: unknown[], prefix = 'e'): void => {
      if (project !== undefined) {
        if (project === null) conditions.push(`${prefix}.project_key IS NULL`);
        else { conditions.push(`${prefix}.project_key = ?`); params.push(project); }
      } else if (projectAny) {
        conditions.push(`${prefix}.project_key IS NOT NULL`);
      }
      if (scope !== undefined) { conditions.push(`${prefix}.scope = ?`); params.push(scope); }
      if (category !== undefined) { conditions.push(`${prefix}.category = ?`); params.push(category); }
    };

    let ftsParseError = false;

    const runFts = (matchQuery: string): SharedEntry[] => {
      const conditions: string[] = ['entry_fts MATCH ?'];
      const params: unknown[] = [matchQuery];
      applyScopeFilters(conditions, params, 'e');
      try {
        const rows = this.db
          .prepare(`
            SELECT ${SELECT_COLUMNS_E}
            FROM entries e
            JOIN entry_fts ON entry_fts.rowid = e.rowid
            WHERE ${conditions.join(' AND ')}
            ORDER BY bm25(entry_fts) ASC, e.updated_at DESC
            LIMIT ?
          `)
          .all(...params, limit) as EntryRow[];
        return rows.map(mapRow);
      } catch (err) {
        if (isFts5QueryError(err)) {
          ftsParseError = true;
          return [];
        }
        throw err;
      }
    };

    const runLike = (terms: string[]): SharedEntry[] => {
      // Parity with v1 `runLiteralLikeFallback` (sqlite-memory-store.ts): a
      // connector/stopword-only query yields no LIKE terms — without this guard
      // the fallback builds `WHERE ()` and SQLite throws a syntax error (500).
      if (terms.length === 0) return [];
      const conditions: string[] = [
        `(${terms.map(() => "e.content LIKE ? ESCAPE '\\'").join(' OR ')})`,
      ];
      const params: unknown[] = terms.map((term) => `%${escapeLikePattern(term.trim())}%`);
      applyScopeFilters(conditions, params, 'e');
      const rows = this.db
        .prepare(`
          SELECT ${SELECT_COLUMNS}
          FROM entries e
          WHERE ${conditions.join(' AND ')}
          ORDER BY e.updated_at DESC
          LIMIT ?
        `)
        .all(...params, limit) as EntryRow[];
      return rows.map(mapRow);
    };

    let raw: SharedEntry[];
    const normalized = normalizeFts5Query(query);
    if (normalized.length === 0) {
      raw = runLike(collectLikeTerms(query));
    } else {
      raw = runFts(normalized);
      if (raw.length === 0 && isShortCjkLiteralQuery(query)) {
        raw = runLike([query]);
      } else if (raw.length === 0 && !ftsParseError) {
        const fallback = buildFallbackFts5Query(query);
        if (fallback && fallback !== normalized) {
          raw = runFts(fallback);
        }
      }
      // Parity with the v1 ladder (sqlite-memory-store.ts `ftsParseError`
      // branch): a query that passes through as raw FTS5 syntax (uppercase
      // operator words, stray operators) fails to parse. Retry it as natural
      // language instead of silently returning nothing — the local store
      // finds these, so the shared store must too (C9/AD-12).
      if (raw.length === 0 && ftsParseError) {
        const nlQuery = normalizeNaturalLanguageFts5Query(query);
        if (nlQuery.length > 0 && nlQuery !== normalized) {
          raw = runFts(nlQuery);
          if (raw.length === 0) {
            const nlFallback = buildNaturalLanguageFallbackQuery(query);
            if (nlFallback && nlFallback !== nlQuery) {
              raw = runFts(nlFallback);
            }
          }
        }
      }
    }

    // Gate the raw rows through the SAME lifted clean-hit layer the local
    // providers use (scope / recency / scanContent).
    const shaped: ProviderSearchHit[] = raw.map((entry) => ({
      id: entry.id,
      content: entry.content,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      category: entry.category,
      raw_match: entry as unknown as Record<string, unknown>,
    }));
    const provider: RecallableProvider = {
      recall: () => shaped,
    };
    const { hits } = cleanHit(provider, query, {
      category: category ?? undefined,
      minRecencyAt,
    });

    return {
      hits: hits.map((h) => h.raw_match as unknown as SharedEntry),
      raw_matches: shaped.length,
    };
  }

  /** Latest status-kind entry for a project by `updated_at` (spine "Status entries"). */
  latestStatus(projectKey: string): SharedEntry | null {
    const row = this.db
      .prepare(`
        SELECT ${SELECT_COLUMNS}
        FROM entries
        WHERE project_key = ? AND kind = 'status'
        ORDER BY updated_at DESC, id ASC
        LIMIT 1
      `)
      .get(projectKey) as EntryRow | undefined;
    return row ? mapRow(row) : null;
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /** Every entry, newest first (export path, AD-14). */
  exportRows(): SharedEntry[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM entries ORDER BY updated_at DESC, id ASC`)
      .all() as EntryRow[];
    return rows.map(mapRow);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM entries').get() as { count: number };
    return Number(row.count);
  }

  close(): void {
    this.db.close();
  }
}
