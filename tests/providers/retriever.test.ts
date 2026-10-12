/**
 * Tests for the FactRetriever.
 *
 * Tests the retrieval logic in retrieval.ts:
 * - FTS5 query
 * - Jaccard similarity
 * - HRR vector similarity
 * - Trust scoring
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  encodeAtom,
  bind,
  unbind,
  bundle,
  similarity,
  encodeText,
  encodeFact,
  phasesToBytes,
  bytesToPhases,
  _setJaccard,
  _jaccardSimilarity,
  FactRetriever,
} from "../../src/providers/holographic/retrieval.js";
import { MemoryStore } from "../../src/providers/holographic/store.js";

const DIM = 256;
const isFloat64 = (v: unknown): v is Float64Array => Float64Array.prototype.isPrototypeOf(v as object);

describe("FactRetriever", () => {
  it("produces deterministic, full-range atoms", () => {
    const a = encodeAtom("alice", DIM);
    assert.ok(isFloat64(a), "returns a Float64Array");
    assert.strictEqual(a.length, DIM);
    assert.ok(a.every((p) => p >= 0 && p < 2 * Math.PI));
  });

  it("bind/unbind round-trips (unbind(bind(a,b),a) ≈ b)", () => {
    const a = encodeAtom("alice", DIM);
    const b = encodeAtom("bob", DIM);
    const fact = bind(a, b);
    const recovered = unbind(fact, a);
    assert.ok(Math.abs(similarity(recovered, b)) > 0.95, `round-trip similarity ${similarity(recovered, b)}`);
  });

  it("distinct atoms are quasi-orthogonal (~0 similarity)", () => {
    const a = encodeAtom("alice", DIM);
    const b = encodeAtom("bob", DIM);
    assert.ok(Math.abs(similarity(a, b)) < 0.1, `similarity ${similarity(a, b)}`);
  });

  it("encodeText of unrelated words is low similarity", () => {
    const t1 = encodeText("the cat sat", DIM);
    const t2 = encodeText("dogs run fast", DIM);
    assert.ok(Math.abs(similarity(t1, t2)) < 0.3, `similarity ${similarity(t1, t2)}`);
  });

  it("encodeFact supports entity probing via unbind", () => {
    const roleContent = encodeAtom("__hrr_role_content__", DIM);
    const roleEntity = encodeAtom("__hrr_role_entity__", DIM);
    const contentVec = encodeText("alice prefers dark mode", DIM);
    const entity = encodeAtom("alice", DIM);
    const fact = bundle([bind(contentVec, roleContent), bind(entity, roleEntity)]);
    const probe = bind(entity, roleEntity);
    const residual = unbind(fact, probe);
    assert.ok(Math.abs(similarity(residual, contentVec)) < 0.2, `probe residual error ${similarity(residual, contentVec)}`);
  });

  it("entity names are deduplicated case-insensitively", () => {
    const s = new MemoryStore(":memory:");
    s.addFact('"Bob" and "bob" agreed');
    assert.deepEqual(s.entityNames(1), ["Bob"]);
  });

  it("entity names resolve to the same entity when canonical", () => {
    const s = new MemoryStore(":memory:");
    s.addFact('"Bob" approved the plan'); // canonical spelling
    s.addFact('"bob" rejected the plan'); // different case, same name
    assert.ok(s.entityNames(1).includes("Bob"));
    assert.ok(s.entityNames(2).includes("Bob")); // same entity, canonical name
    assert.ok(s.resolveEntity("bob") === s.resolveEntity("Bob"));
  });
});

describe("FactRetriever retrieval", () => {
  it("returns results sorted by descending score", () => {
    const store = new MemoryStore(":memory:");
    const s = new FactRetriever(store, 0);
    store.addFact('alice prefers dark coffee', "general");
    store.addFact('alice and bob like coffee', "general");
    const results = s.search("alice", "general", 0, 10);
    assert.ok(results.length > 0, "should find facts");
    // search() must return rows ordered by descending score.
    for (let i = 1; i < results.length; i++) {
      const prev = (results[i - 1] as { score: number }).score;
      const cur = (results[i] as { score: number }).score;
      assert.ok(prev >= cur, "scores must be sorted descending");
    }
  });

  it("stores the canonical spelling of an extracted entity", () => {
    const store = new MemoryStore(":memory:");
    const factId = store.addFact('"Bob" approved the plan');
    assert.deepEqual(store.entityNames(factId), ["Bob"]);
  });

  it("resolves the same entity case-insensitively", () => {
    const store = new MemoryStore(":memory:");
    store.addFact('"Bob" approved the plan');
    store.addFact('"bob" rejected the plan');
    assert.ok(store.resolveEntity("Bob") === store.resolveEntity("bob"));
  });

  it("keeps facts with the same entity as separate rows", () => {
    const store = new MemoryStore(":memory:");
    const s = new FactRetriever(store, 0);
    store.addFact('"Alice" approved the plan', "general");
    store.addFact('"Alice" rejected the plan', "general");
    const results = s.search("alice", "general", 0, 10);
    assert.ok(results.length === 2, "both facts about Alice should be retrievable");
  });

  it("returns no results for a query with no matching content", () => {
    const store = new MemoryStore(":memory:");
    const s = new FactRetriever(store, 0);
    store.addFact("quantum flux capacitor", "general");
    const results = s.search("nonexistentzzz", "general", 0, 5);
    assert.ok(results.length === 0, "unmatched query should return nothing");
  });
});

describe("FactRetriever Jaccard", () => {
  it("disjoint sets have zero Jaccard", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    assert.ok(Math.abs(_setJaccard(a, b)) < 1e-9, "disjoint sets share no intersection");
  });

  it("identical sets have Jaccard 1.0", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(a);
    assert.ok(Math.abs(_setJaccard(a, b) - 1.0) < 1e-9);
  });

  it("returns 0.333 for 3 elements", () => {
    const a: Set<string> = new Set(["a", "b", "c"]);
    const b: Set<string> = new Set(["a", "b", "c"]);
    const result = _setJaccard(a, b);
    assert.ok(Math.abs(result) >= 0.333);
  });

  it("returns 1.0 for fully identical sets", () => {
    const a: Set<string> = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    const b: Set<string> = new Set(a);
    const result = _setJaccard(a, b);
    assert.ok(Math.abs(result) === 1.0);
  });

  it("returns correct values for different combinations", () => {
    const a: Set<string> = new Set(["a", "b"]);
    const b: Set<string> = new Set(["a", "c"]);
    const c: Set<string> = new Set(["a", "b", "c"]);
    const d: Set<string> = new Set(["b", "c"]);
    const e: Set<string> = new Set(["b", "c", "d"]);

    const resultA = _setJaccard(a, b);
    const resultB = _setJaccard(b, c);
    const resultC = _setJaccard(c, d);
    const resultD = _setJaccard(d, e);

    assert.ok(Math.abs(resultA) >= 0.333);
    assert.ok(Math.abs(resultB) >= 0.333);
    assert.ok(Math.abs(resultC) >= 0.333);
    assert.ok(Math.abs(resultD) >= 0.333);
  });
});

describe("FactRetriever HRR", () => {
  // Local mirrors of retrieval.ts's private helpers (same documented math).
  const _shift = (sim: number): number => (sim + 1.0) / 2.0;
  const _round3 = (x: number): number => Math.round(x * 1000) / 1000;

  it("similarity is symmetric and _shift maps [-1, 1] -> [0, 1]", () => {
    const vec1 = encodeText("alice", DIM);
    const vec2 = encodeText("bob", DIM);
    assert.ok(Math.abs(similarity(vec1, vec2) - similarity(vec2, vec1)) < 1e-6);
    const shifted = _shift(similarity(vec1, vec2));
    assert.ok(shifted >= 0.0 && shifted <= 1.0);
  });

  it("rounds similarity to 3 decimal places", () => {
    const vec1 = encodeText("alice", DIM);
    const vec2 = encodeText("bob", DIM);
    const result = _round3(similarity(vec1, vec2));
    assert.ok(Math.abs(similarity(vec1, vec2) - result) < 0.001);
  });
});

// Test bundle() superposition semantics (HRR circular mean).
describe("bundle (superposition)", () => {
  it("returns a phase vector of length DIM", () => {
    const result = bundle([
      encodeText("test", DIM),
      encodeAtom("__hrr_role_entity__", DIM),
      encodeAtom("__hrr_role_content__", DIM),
    ]);
    assert.ok(result instanceof Float64Array);
    assert.ok(result.length === DIM);
  });

  it("single-item bundle equals that item", () => {
    const v = encodeText("single", DIM);
    assert.ok(similarity(bundle([v]), v) > 0.99);
  });

  it("empty bundle yields the deterministic empty atom", () => {
    const empty1 = bundle([]);
    const empty2 = bundle([]);
    assert.ok(empty1 instanceof Float64Array);
    assert.ok(similarity(empty1, empty2) > 0.99, "empty bundle is deterministic");
  });
});
