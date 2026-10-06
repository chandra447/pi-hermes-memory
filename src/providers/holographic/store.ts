/**
 * SQLite-backed fact store with entity resolution, trust scoring and category
 * memory banks (single-user Hermes memory plugin).
 *
 * Ported from Hermes's plugins/memory/holographic/store.py. The Python version
 * keeps one shared SQLite connection across every provider instance in a process
 * behind a threading RLock (SQLite is one-writer + several readers, and multiple
 * Hermes providers coexist per process). Node is single-threaded and
 * better-sqlite3 is already thread-safe and synchronous, so this port gives each
 * MemoryStore its own connection — the schema, entity resolution, trust scoring,
 * HRR vector / bank logic and retrieval hooks port verbatim.
 *
 * better-sqlite3 is autocommit (no isolation_level), so the explicit commit()
 * calls in the Python writer are dropped: a raise mid-method can't leave a
 * dangling transaction or write-lock the way it could in the Python driver.
 */

import Database from "better-sqlite3";

import { bundle, bytesToPhases, encodeFact, phasesToBytes } from "./hrr.js";

interface FactRow {
  fact_id: number;
  content: string;
  category: string;
  tags: string;
  trust_score: number;
  retrieval_count: number;
  helpful_count: number;
  created_at: string;
  updated_at: string;
  hrr_vector: Buffer | null;
}

interface EntityRow {
  entity_id: number;
  name: string;
  entity_type?: string;
  aliases?: string;
  created_at?: string;
}

const _HELPFUL_DELTA = 0.05;
const _UNHELPFUL_DELTA = -0.10;

// Entity extraction patterns, applied in order: capitalized multi-word phrases
// ("John Doe"), double-quoted terms, single-quoted terms, then "X aka Y" (both sides).
const _RE_SINGLE_ENTITY = [
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
  /"([^"]+)"/g,
  /'([^'])+'/g,
];
const _RE_AKA = /(\w+(?:\s+\w+)*)\s+(?:aka|also known as)\s+(\w+(?:\s+\w+)*)/gi;
// Entity lookup order: exact name, then aliases (comma-wrapped for whole-alias matching).
const _ENTITY_NAMES_SQL =
  "SELECT e.name FROM entities e JOIN fact_entities fe ON fe.entity_id = e.entity_id WHERE fe.fact_id = ?";
const _ENTITY_LOOKUPS = [
  "SELECT entity_id FROM entities WHERE name LIKE ?",
  "SELECT entity_id FROM entities WHERE ',' || aliases || ',' LIKE '%,' || ? || ',%'",
];

const _SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
    fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content         TEXT NOT NULL UNIQUE,
    category        TEXT DEFAULT 'general',
    tags            TEXT DEFAULT '',
    trust_score     REAL DEFAULT 0.5,
    retrieval_count INTEGER DEFAULT 0,
    helpful_count   INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    hrr_vector      BLOB
);

CREATE TABLE IF NOT EXISTS entities (
    entity_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    entity_type TEXT DEFAULT 'unknown',
    aliases     TEXT DEFAULT '',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fact_entities (
    fact_id   INTEGER REFERENCES facts(fact_id),
    entity_id INTEGER REFERENCES entities(entity_id),
    PRIMARY KEY (fact_id, entity_id)
);

CREATE TABLE IF NOT EXISTS memory_banks (
    bank_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_name  TEXT NOT NULL UNIQUE,
    vector     BLOB NOT NULL,
    dim        INTEGER NOT NULL,
    fact_count INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_facts_trust    ON facts(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
    USING fts5(content, tags, content=facts, content_rowid=fact_id);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, content, tags)
        VALUES (new.fact_id, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content, tags)
        VALUES ('delete', old.fact_id, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content, tags)
        VALUES ('delete', old.fact_id, old.content, old.tags);
    INSERT INTO facts_fts(rowid, content, tags)
        VALUES (new.fact_id, new.content, new.tags);
END;
`;

/** Clamp a trust value into [0, 1]. */
export function clampTrust(value: number): number {
  return Math.max(0.0, Math.min(1.0, value));
}

/**
 * SQLite-backed fact store with entity resolution and trust scoring.
 *
 * Each instance owns a connection. Writes go through prepared statements and
 * better-sqlite3 serializes them on the single event loop, so concurrent writes
 * never interleave.
 */
export class MemoryStore {
  private _dbPath: string;
  private _defaultTrust: number;
  private _hrrDim: number;

  private _db: Database.Database;
  private _prepared = new Map<string, Database.Statement>();

  constructor(dbPath: string, defaultTrust = 0.5, hrrDim = 1024) {
    this._dbPath = dbPath;
    this._defaultTrust = clampTrust(defaultTrust);
    this._hrrDim = hrrDim;
    this._db = new Database(dbPath, { fileMustExist: false });
    this._db.pragma("journal_mode = WAL");
    this._db.exec(_SCHEMA);
  }

  /** The on-disk database path. */
  get dbPath(): string {
    return this._dbPath;
  }

  private _prepare(sql: string): Database.Statement {
    if (!this._prepared.has(sql)) this._prepared.set(sql, this._db.prepare(sql));
    return this._prepared.get(sql)!;
  }

  private _one<T = any>(sql: string, params: any[] = []): T | undefined {
    return this._prepare(sql).get(...params);
  }

  private _run<T = any>(sql: string, params: any[] = []): T {
    return this._prepare(sql).run(...params) as unknown as T;
  }

  /**
   * Insert a fact and return its fact_id; on duplicate content (UNIQUE) return
   * the existing fact_id untouched. Links extracted entities and rebuilds the
   * category bank.
   */
  addFact(content: string, category = "general", tags = ""): number {
    content = content.trim();
    if (!content) throw new Error("content must not be empty");
    let info: { lastInsertRowid: number } | undefined;
    try {
      info = this._run<{ lastInsertRowid: number }>(
        "INSERT INTO facts (content, category, tags, trust_score) VALUES (?, ?, ?, ?)",
        [content, category, tags, this._defaultTrust],
      );
    } catch {
      // Duplicate content (UNIQUE): return the existing fact_id untouched, matching the Python driver.
      const existing = this._one<{ fact_id: number }>("SELECT fact_id FROM facts WHERE content = ?", [content]);
      if (!existing) throw new Error(`content must not be empty`);
      return Number(existing.fact_id);
    }
    const factId = Number(info!.lastInsertRowid);
    this._linkEntities(factId, content);
    this._computeHrrVector(factId, content);
    this._rebuildBank(category);
    return factId;
  }

  /**
   * Partially update a fact (trust clamped to [0, 1]). Returns true if the row
   * existed. Re-extracts entities and recomputes the HRR vector when content changes.
   */
  updateFact(
    factId: number,
    content?: string,
    trustDelta?: number,
    tags?: string | null,
    category?: string | null,
  ): boolean {
    const row = this._one<{ fact_id: number; trust_score: number }>(
      "SELECT fact_id, trust_score FROM facts WHERE fact_id = ?",
      [factId],
    );
    if (!row) return false;
    const changes: Record<string, any> = {};
    if (content !== undefined) changes.content = content.trim();
    if (tags !== undefined) changes.tags = tags;
    if (category !== undefined) changes.category = category;
    if (trustDelta !== undefined) changes.trust_score = clampTrust(row.trust_score + trustDelta);
    const keys = Object.keys(changes);
    const assignments = ["updated_at = CURRENT_TIMESTAMP", ...keys.map((k) => `${k} = ?`)].join(", ");
    this._run(`UPDATE facts SET ${assignments} WHERE fact_id = ?`, [...keys.map((k) => changes[k]), factId]);
    if (content !== undefined) {
      this._run("DELETE FROM fact_entities WHERE fact_id = ?", [factId]);
      this._linkEntities(factId, content);
      this._computeHrrVector(factId, content);
    }
    this._rebuildBank(category ?? this._one("SELECT category FROM facts WHERE fact_id = ?", [factId])!.category);
    return true;
  }

  /** Delete a fact and its entity links. Returns true if the row existed. */
  removeFact(factId: number): boolean {
    const row = this._one<{ category: string }>("SELECT category FROM facts WHERE fact_id = ?", [factId]);
    if (!row) return false;
    this._run("DELETE FROM fact_entities WHERE fact_id = ?", [factId]);
    this._run("DELETE FROM facts WHERE fact_id = ?", [factId]);
    this._rebuildBank(row.category);
    return true;
  }

  /** Browse facts ordered by trust_score descending, filtered by category / min trust. */
  listFacts(category?: string, minTrust = 0.0, limit = 50): FactRow[] {
    const categoryClause = category ? "AND category = ? " : "";
    const params: any[] = [minTrust, ...(category ? [category] : []), limit];
    const sql =
      "SELECT fact_id, content, category, tags, trust_score, retrieval_count, helpful_count, " +
      "created_at, updated_at FROM facts WHERE trust_score >= ? " +
      `${categoryClause}ORDER BY trust_score DESC LIMIT ?`;
    return this._prepare(sql).all(...params) as FactRow[];
  }

  /**
   * Adjust trust asymmetrically: helpful -> +0.05 and helpful_count += 1;
   * unhelpful -> -0.10. Returns {fact_id, old_trust, new_trust, helpful_count}.
   * Raises if fact_id is unknown.
   */
  recordFeedback(factId: number, helpful: boolean): { fact_id: number; old_trust: number; new_trust: number; helpful_count: number } {
    const row = this._one<{ fact_id: number; trust_score: number; helpful_count: number }>(
      "SELECT fact_id, trust_score, helpful_count FROM facts WHERE fact_id = ?",
      [factId],
    );
    if (!row) throw new Error(`fact_id ${factId} not found`);
    const oldTrust = row.trust_score;
    const newTrust = clampTrust(oldTrust + (helpful ? _HELPFUL_DELTA : _UNHELPFUL_DELTA));
    const increment = helpful ? 1 : 0;
    this._run(
      "UPDATE facts SET trust_score = ?, helpful_count = helpful_count + ?, updated_at = CURRENT_TIMESTAMP WHERE fact_id = ?",
      [newTrust, increment, factId],
    );
    return { fact_id: factId, old_trust: oldTrust, new_trust: newTrust, helpful_count: row.helpful_count + increment };
  }

  /**
   * Return the resolved entity names linked to a fact (exact + aliased).
   */
  entityNames(factId: number): string[] {
    return (this._prepare(_ENTITY_NAMES_SQL).all(factId) as EntityRow[]).map((r) => r.name);
  }

  /**
   * Extract entity candidates from content, resolve/create them, and link each
   * to the fact.
   */
  private _linkEntities(factId: number, content: string): void {
    for (const name of this._extractEntities(content)) {
      this._run("INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?, ?)", [factId, this.resolveEntity(name)]);
    }
  }

  /**
   * Return the entity_id for a case-insensitive name or alias match, creating the
   * entity if absent.
   */
  resolveEntity(name: string): number {
    for (const sql of _ENTITY_LOOKUPS) {
      const row = this._one<{ entity_id: number }>(sql, [name]);
      if (row) return Number(row.entity_id);
    }
    return Number(this._run("INSERT INTO entities (name) VALUES (?)", [name]).lastInsertRowid);
  }

  /**
   * Entity candidates: regex matches (capitalized multi-word phrases, quoted
   * terms), deduplicated case-insensitively in first-seen order, plus the two
   * sides of an "X aka Y" match.
   */
  private _extractEntities(text: string): string[] {
    const raw: string[] = [];
    for (const regex of _RE_SINGLE_ENTITY) {
      for (const m of text.matchAll(regex)) raw.push(m[1]);
    }
    for (const m of text.matchAll(_RE_AKA)) raw.push(m[1], m[2]);
    const uniq = new Map<string, string>(); // lower-cased key -> first-seen spelling
    for (const name of raw.filter((n) => n.trim())) {
      const key = name.trim().toLowerCase();
      if (!uniq.has(key)) uniq.set(key, name.trim());
    }
    return [...uniq.values()];
  }

  /** Compute and store the HRR vector for a fact (linked entities as roles). */
  private _computeHrrVector(factId: number, content: string): void {
    const entities = (this._prepare(_ENTITY_NAMES_SQL).all(factId) as EntityRow[]).map((r) => r.name);
    const blob = phasesToBytes(encodeFact(content, entities, this._hrrDim), this._hrrDim);
    this._run("UPDATE facts SET hrr_vector = ? WHERE fact_id = ?", [blob, factId]);
  }

  /** Full rebuild of a category's memory bank from all its fact vectors. */
  private _rebuildBank(category: string): void {
    const bankName = `cat:${category}`;
    const rows = this._prepare("SELECT hrr_vector FROM facts WHERE category = ? AND hrr_vector IS NOT NULL").all(category) as {
      hrr_vector: Buffer;
    }[];
    if (!rows.length) {
      this._run("DELETE FROM memory_banks WHERE bank_name = ?", [bankName]);
      return;
    }
    const bankVector = bundle(
      rows.map((r) => bytesToPhases(r.hrr_vector, this._hrrDim)),
      this._hrrDim,
    );
    this._run(
      "INSERT INTO memory_banks (bank_name, vector, dim, fact_count, updated_at) " +
        "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) " +
        "ON CONFLICT(bank_name) DO UPDATE SET vector = excluded.vector, dim = excluded.dim, fact_count = excluded.fact_count, updated_at = excluded.updated_at",
      [bankName, phasesToBytes(bankVector, this._hrrDim), this._hrrDim, rows.length],
    );
  }

  /** Force-close every connection whose database lives under `directory` (profile delete). */
  static releaseAllUnder(_directory: string): number {
    // Node has no process-wide shared-connection registry to drain; a profile
    // delete can't leave handles open, so this is a documented no-op.
    return 0;
  }

  /** Release this instance's connection. Idempotent. */
  close(): void {
    this._db.close();
    this._prepared.clear();
  }
}

export type { FactRow, EntityRow };
