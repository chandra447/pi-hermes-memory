/**
 * Hybrid keyword/BM25 retrieval for the memory store: FTS5 candidates reranked
 * with Jaccard similarity and HRR vector similarity, trust-weighted. Faithful
 * port of Hermes's `plugins/memory/holographic/retrieval.py`.
 *
 * The pipeline (per `search`):
 *   FTS5 candidates (limit*3) -> Jaccard + HRR rerank -> trust weighting ->
 *   optional temporal decay 0.5^(age_days / half_life).
 *
 * Numpy is treated as always-available in TypeScript (the HRR algebra in hrr.ts
 * is pure math), so the `if not numpy: fall back to FTS5` branches never fire
 * here; they are kept for parity with the Python reference.
 */

import { bind, bytesToPhases, encodeAtom, encodeText, hasNumpy, similarity, unbind, _ROLE_CONTENT, _ROLE_ENTITY, type PhaseVector } from "./hrr.js";

// Re-export the HRR surface the retrieval pipeline (and tests) consume in one place.
export { bind, unbind, bundle, encodeAtom, encodeText, encodeFact, similarity, phasesToBytes, bytesToPhases } from "./hrr.js";

import type { MemoryStore } from "./store.js";

const _FACT_COLUMNS = "fact_id, content, category, tags, trust_score, retrieval_count, helpful_count, created_at, updated_at";
// Stopwords dropped before FTS5 OR-expansion: short English function words that
// carry no retrieval signal and force false-negative AND matches.
const _FTS_STOPWORDS = new Set(
  `
    a about above after again all am an and any are as at be because been before being between both but by can could
    did do does doing don down during each few for from further had has have having he her here hers himself him himself
    his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our
    ours ourselves out over own same she should so some such than that the their theirs them themselves then there these
    they this those through to too under until up very was we were what when where which while who whom why will with
    would you your yours yourself yourselves`.split(/\s+/),
);

/**
 * Tokens as FTS5's default (unicode61) tokenizer stores them: maximal runs of
 * Unicode letters/digits. Punctuation — `-`, `_`, `'`, … — is a separator, so
 * "E2E-LIVE" -> ["e2e","live"] exactly as the facts_fts index holds it.
 * Shared by _tokenize (Jaccard) and _sanitizeFtsQuery (MATCH) so query-side
 * tokenization always matches index-side tokenization.
 */
function indexTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Cosine similarity [-1, 1] -> [0, 1]. */
function _shift(sim: number): number {
  return (sim + 1.0) / 2.0;
}

/** Round to 3 decimal places (matching Python's `round(x, 3)`). */
function _round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** |A ∩ B| / |A ∪ B|. */
export function _setJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0.0;
  const intersection = [...a].filter((x) => b.has(x));
  const union = new Set([...a, ...b]);
  return intersection.length / union.size;
}

export class FactRetriever {
  constructor(
    private readonly store: MemoryStore,
    private readonly halfLife: number = 0, // days, 0 = disabled
    private readonly ftsWeight: number = 0.4,
    private readonly jaccardWeight: number = 0.3,
    private readonly hrrWeight: number = 0.3,
    private readonly hrrDim: number = 1024,
  ) {
    // Redistribute weights without numpy — never triggers in TS (numpy is
    // always-available), kept for parity with the Python reference.
    if (hrrWeight > 0 && !hasNumpy()) {
      this.ftsWeight = 0.6;
      this.jaccardWeight = 0.4;
      this.hrrWeight = 0.0;
    }
  }

  private _atom(word: string): PhaseVector {
    return encodeAtom(word, this.hrrDim);
  }

  private _phases(blob: Buffer): PhaseVector {
    return bytesToPhases(blob, this.hrrDim);
  }

  /**
   * FTS5 candidates (limit*3) -> Jaccard + HRR rerank -> trust weighting ->
   * optional temporal decay. Returns fact dicts with `score`, sorted desc.
   */
  search(
    query: string,
    category: string | null | undefined = undefined,
    minTrust: number = 0.3,
    limit: number = 10,
  ): Record<string, unknown>[] {
    const candidates = this._ftsCandidates(query, category ?? null, minTrust, limit * 3);
    const queryTokens = FactRetriever._tokenize(query);
    // Query vector is loop-invariant; encode lazily on the first candidate that
    // carries an HRR vector, so stores whose hrr_vector was never backfilled
    // don't pay for it.
    let queryVec: PhaseVector | null = null;
    for (const fact of candidates) {
      const contentTokens = FactRetriever._tokenize(String(fact["content"]));
      const tagsTokens = FactRetriever._tokenize(String(fact["tags"] ?? ""));
      const union = new Set([...contentTokens, ...tagsTokens]);
      const jaccard = FactRetriever._jaccardSimilarity(queryTokens, union);
      let hrrSim = 0.5; // neutral
      const hrrVec = fact["hrr_vector"];
      if (this.hrrWeight > 0 && hrrVec) {
        const factVec = this._phases(hrrVec as Buffer);
        if (queryVec === null) queryVec = encodeText(query, this.hrrDim);
        hrrSim = _shift(similarity(queryVec, factVec));
      }
      const ftsRank = (fact["fts_rank"] as number | undefined) ?? 0;
      const trustScore = (fact["trust_score"] as number | undefined) ?? 0;
      const relevance = this.ftsWeight * ftsRank + this.jaccardWeight * jaccard + this.hrrWeight * hrrSim;
      const score = relevance * trustScore;
      fact["score"] = this.halfLife > 0 ? score * this._temporalDecay((fact["updated_at"] as string | undefined) ?? (fact["created_at"] as string | undefined)) : score;
    }
    const results = candidates
      .sort((a, b) => ((b["score"] as number) ?? 0) - ((a["score"] as number) ?? 0))
      .slice(0, limit);
    for (const fact of results) delete fact["hrr_vector"]; // callers expect JSON-serializable dicts
    return results;
  }

  /**
   * Rank every fact vector (optionally per category) by `simFn`; FTS5 fallback
   * when no vectors exist.
   */
  private _vectorQuery(
    fallback: string,
    category: string | null | undefined,
    limit: number,
    simFn: (fact: Record<string, unknown>, factVec: PhaseVector) => number,
  ): Record<string, unknown>[] {
    const rows = this._vectorRows(category ?? null);
    return rows.length > 0 ? this._rankByVector(rows, simFn, limit) : this.search(fallback, category ?? undefined, limit);
  }

  private _vectorRows(category: string | null, columns: string = _FACT_COLUMNS + ", hrr_vector"): Record<string, unknown>[] {
    const where = "WHERE hrr_vector IS NOT NULL" + (category ? " AND category = ?" : "");
    return this.store.query<Record<string, unknown>>(`SELECT ${columns} FROM facts ${where}`, category ? [category] : []);
  }

  private _rankByVector(
    rows: Record<string, unknown>[],
    simFn: (fact: Record<string, unknown>, factVec: PhaseVector) => number,
    limit: number,
  ): Record<string, unknown>[] {
    const scored = rows.map((row) => ({ ...row }));
    for (const fact of scored) {
      const vec = fact["hrr_vector"] as Buffer;
      delete fact["hrr_vector"];
      fact["score"] = _shift(simFn(fact, this._phases(vec))) * (fact["trust_score"] as number ?? 0);
    }
    return scored.sort((a, b) => ((b["score"] as number) ?? 0) - ((a["score"] as number) ?? 0)).slice(0, limit);
  }

  /**
   * Compositional entity query: unbind `bind(entity, ROLE_ENTITY)` from the
   * category bank (or each fact vector) to find facts where the entity plays a
   * structural role. Not keyword search.
   */
  probe(
    entity: string,
    category: string | null | undefined = undefined,
    limit: number = 10,
  ): Record<string, unknown>[] {
    if (!hasNumpy()) return this.search(entity, category ?? undefined, limit);
    const probeKey = bind(this._atom(entity.toLowerCase()), this._atom(_ROLE_ENTITY));
    if (category) {
      // Category bank first, then individual fact vectors.
      const bankRow = this.store.queryOne<Record<string, unknown>>("SELECT vector FROM memory_banks WHERE bank_name = ?", [`cat:${category}`]);
      if (bankRow) {
        const extracted = unbind(this._phases(bankRow["vector"] as Buffer), probeKey);
        return this._rankByVector(this._vectorRows(category), (_f, factVec) => similarity(extracted, factVec), limit);
      }
    }
    const roleContent = this._atom(_ROLE_CONTENT); // loop-invariant: encode once, not per row
    // Does unbinding the probe key leave the fact's content signal?
    return this._vectorQuery(
      entity,
      category,
      limit,
      (fact, factVec) => similarity(unbind(factVec, probeKey), bind(encodeText(String(fact["content"]), this.hrrDim), roleContent)),
  )
  }

  /**
   * Facts structurally connected to an entity (shared context), not just facts
   * *about* it as in `probe`.
   */
  related(
    entity: string,
    category: string | null | undefined = undefined,
    limit: number = 10,
  ): Record<string, unknown>[] {
    if (!hasNumpy()) return this.search(entity, category ?? undefined, limit);
    const entityVec = this._atom(entity.toLowerCase()); // bare atom, not role-bound: ANY structural match
    const roles = [this._atom(_ROLE_ENTITY), this._atom(_ROLE_CONTENT)]; // loop-invariant: encode once
    // A residual similar to ANY role vector means the entity plays a structural role in the fact.
    return this._vectorQuery(
      entity,
      category,
      limit,
      (_f, factVec) => Math.max(...roles.map((role) => similarity(unbind(factVec, entityVec), role))),
  )
  }

  /**
   * Multi-entity compositional query (vector-space JOIN): facts where ALL
   * entities play structural roles (AND semantics via `min`).
   */
  reason(
    entities: string[],
    category: string | null | undefined = undefined,
    limit: number = 10,
  ): Record<string, unknown>[] {
    if (!hasNumpy() || !entities) return this.search(entities.join(" "), category ?? undefined, limit);
    const roleEntity = this._atom(_ROLE_ENTITY);
    const roleContent = this._atom(_ROLE_CONTENT);
    const probeKeys = entities.map((entity) => bind(this._atom(entity.toLowerCase()), roleEntity));
    // AND semantics via min: high only if EVERY entity is structurally present.
    return this._vectorQuery(
      entities.join(" "),
      category,
      limit,
      (_f, factVec) => Math.min(...probeKeys.map((key) => similarity(unbind(factVec, key), roleContent))),
  )
  }

  /**
   * Pairs of facts sharing entities (same subject) with low content-vector
   * similarity (different claims). Empty without numpy.
   */
  contradict(
    category: string | null | undefined = undefined,
    threshold: number = 0.3,
    limit: number = 10,
  ): Record<string, unknown>[] {
    if (!hasNumpy()) return [];
    const rows = this._vectorRows(
      category ?? null,
      "fact_id, content, category, tags, trust_score, created_at, updated_at, hrr_vector",
  )
    if (rows.length < 2) return [];
    if (rows.length > 500) {
      // O(n^2) guard: only compare the most recently updated facts.
      rows.sort((a, b) => {
        const bKey = (b["updated_at"] as string) ?? (b["created_at"] as string) ?? "";
        const aKey = (a["updated_at"] as string) ?? (a["created_at"] as string) ?? "";
        return bKey < aKey ? 1 : -1;
      }).slice(0, 500);
    }
    const facts: Array<[Record<string, unknown>, Set<string>, PhaseVector]> = [];
    for (const row of rows) {
      const fact = { ...row };
      const entityRows = this.store.query<{ name: string }>(
        "SELECT e.name FROM entities e JOIN fact_entities fe ON fe.entity_id = e.entity_id WHERE fe.fact_id = ?",
        [fact["fact_id"]],
    )
      const lowerNames = new Set(entityRows.map((r) => r.name.toLowerCase()));
      delete fact["hrr_vector"];
      const vec = row["hrr_vector"] as Buffer | undefined;
      facts.push([fact, lowerNames, vec ? this._phases(vec) : this._atom("__hrr_empty__")]);
    }
    const contradictions: Record<string, unknown>[] = [];
    for (let i = 0; i < facts.length; i++) {
      const [f1, ents1, vec1] = facts[i];
      for (let j = i + 1; j < facts.length; j++) {
        const [f2, ents2, vec2] = facts[j];
        if (ents1.size === 0 || ents2.size === 0) continue;
        const entityOverlap = _setJaccard(ents1, ents2);
        if (entityOverlap < 0.3) continue; // not enough shared subject to be contradictory
        const contentSim = similarity(vec1, vec2);
        const contradictionScore = entityOverlap * (1.0 - _shift(contentSim)); // high overlap + low similarity
        if (contradictionScore >= threshold) {
          contradictions.push({
            fact_a: f1,
            fact_b: f2,
            entity_overlap: _round3(entityOverlap),
            content_similarity: _round3(contentSim),
            contradiction_score: _round3(contradictionScore),
            shared_entities: [...ents1].filter((x) => ents2.has(x)).sort(),
          });
        }
      }
    }
    return contradictions
      .sort((a, b) => ((b["contradiction_score"] as number) ?? 0) - ((a["contradiction_score"] as number) ?? 0))
      .slice(0, limit);
  }

  private _ftsCandidates(
    query: string,
    category: string | null,
    minTrust: number,
    limit: number,
  ): Record<string, unknown>[] {
    /** Raw FTS5 MATCH candidates with rank normalized to [0, 1] as `fts_rank`. */
    // Clause is conditional to match the conditional param push: with no category
    // filter there is no `category = ?` placeholder, so the bound params must not
    // include one (otherwise better-sqlite3's param-count mismatch yields []).
    const categoryClause = category ? "AND f.category = ? " : "";
    const params: unknown[] = [FactRetriever._sanitizeFtsQuery(query)];
    if (category) params.push(category);
    params.push(minTrust, limit);
    const sql =
      "SELECT f.*, facts_fts.rank as fts_rank_raw FROM facts_fts JOIN facts f ON f.fact_id = facts_fts.rowid " +
      `WHERE facts_fts MATCH ? ${categoryClause}AND f.trust_score >= ? ORDER BY facts_fts.rank LIMIT ?`;
    let results: Record<string, unknown>[];
    try {
      results = this.store.query<Record<string, unknown>>(sql, params);
    } catch {
      return []; // FTS5 MATCH can fail on malformed queries
    }
    // FTS5 rank is negative (lower = better); normalize |rank| / max to [0, 1] (1e-6 floor avoids div by zero).
    const maxRank = Math.max(...results.map((f) => Math.abs((f["fts_rank_raw"] as number) ?? 0)), 1e-6);
    for (const fact of results) {
      const raw = (fact["fts_rank_raw"] as number) ?? 0;
      fact["fts_rank"] = Math.abs(raw) / maxRank;
      delete fact["fts_rank_raw"];
    }
    return results;
  }

  /**
   * Index-aligned lowercase tokens (no stemming): maximal Unicode-alphanumeric
   * runs, so "E2E-LIVE" -> {"e2e","live"} like the FTS5 index. The old
   * strip-surrounding-punctuation version kept "e2e-live" whole, which never
   * intersected the index tokens and zeroed the Jaccard term for hyphenated
   * queries.
   */
  static _tokenize(text: string): Set<string> {
    if (!text) return new Set();
    return new Set(indexTokens(text));
  }

  /**
   * Natural-language query -> FTS5-safe OR expression of quoted tokens. FTS5
   * AND-joins a multi-word MATCH by default, which tanks recall on prose: split
   * on the index tokenizer's boundaries (maximal Unicode-alphanumeric runs),
   * drop stopwords and <2-char tokens, phrase-quote each survivor. If nothing
   * survives, return the raw query (zero results, not a SQL error).
   */
  static _sanitizeFtsQuery(query: string): string {
    if (!query) return "";
    // Split on the same boundaries the FTS5 index uses: a hyphenated word like
    // "E2E-LIVE" becomes the sub-tokens e2e, live (OR-joined, matching the
    // multi-word OR semantics). The old remove-operator-chars path glued it
    // into "e2elive", which the index never contains -> guaranteed 0 hits; raw
    // unquoted hyphens are also an FTS5 syntax error ("no such column"), so
    // neutralizing `-` is required, but by splitting, not stripping.
    const tokens = indexTokens(query)
      .filter((c) => c.length >= 2 && !_FTS_STOPWORDS.has(c))
      .map((c) => `"${c}"`);
    return tokens.length > 0 ? tokens.join(" OR ") : query;
  }

  static _jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    return _setJaccard(setA, setB);
  }

  /** 0.5^(age_days / half_life); 1.0 if disabled, missing, unparseable, or future. */
  private _temporalDecay(timestampStr: string | undefined): number {
    if (!this.halfLife || !timestampStr) return 1.0;
    // SQLite CURRENT_TIMESTAMP is a naive UTC "YYYY-MM-DD HH:MM:SS"; treat as UTC
    // like the Python port's `datetime.fromisoformat(...).replace(tzinfo=utc)`.
    const asUtc = timestampStr
      .replace("Z", "+00:00")
      .replace(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/, "$1-$2-$3T$4:$5:$6Z");
    const ts = Date.parse(asUtc);
    if (Number.isNaN(ts)) return 1.0;
    const ageDays = (Date.now() - ts) / 86400000;
    return ageDays < 0 ? 1.0 : Math.pow(0.5, ageDays / this.halfLife);
  }
}

// Module-level alias so `_jaccardSimilarity` is importable by callers (and tests)
// that do not hold a `FactRetriever` instance. Pure function — no `this` needed.
export const _jaccardSimilarity = FactRetriever._jaccardSimilarity;
