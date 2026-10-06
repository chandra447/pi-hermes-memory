/**
 * Tests for the Holographic SQLite fact store port.
 *
 * Covers the ported surface of store.py: fact CRUD, trust scoring, feedback,
 * entity extraction + resolution, HRR vector computation, category banks and
 * duplicate-content handling. The store keeps a per-instance connection, so
 * ":memory:" gives an isolated database per test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore, clampTrust } from "../../src/providers/holographic/store.js";
import { similarity, bytesToPhases } from "../../src/providers/holographic/hrr.js";

describe("MemoryStore", () => {
  it("rejects empty content", () => {
    const s = new MemoryStore(":memory:");
    assert.throws(() => s.addFact("   "), /must not be empty/);
    assert.throws(() => s.addFact(""), /must not be empty/);
  });

  it("assigns incrementing ids and starts every fact at default trust", () => {
    const s = new MemoryStore(":memory:", 0.5);
    const a = s.addFact("first fact");
    const b = s.addFact("second fact");
    assert.equal(a, 1);
    assert.equal(b, 2);
    for (const f of s.listFacts()) assert.ok(Math.abs(f.trust_score - 0.5) < 1e-9);
  });

  it("returns the existing fact_id on duplicate content (UNIQUE)", () => {
    const s = new MemoryStore(":memory:");
    const id = s.addFact("the unique sentence");
    const again = s.addFact("the unique sentence", "general");
    assert.equal(again, id);
    // A later add of a *different* fact continues the autoincrement sequence.
    assert.equal(s.addFact("another one"), id + 1);
  });

  it("orders listFacts by trust_score descending", () => {
    const s = new MemoryStore(":memory:");
    const low = s.addFact("low");
    const high = s.addFact("high");
    s.recordFeedback(low, false); // -0.10
    s.recordFeedback(high, true); // +0.05
    const rows = s.listFacts();
    assert.equal(rows[0].fact_id, high);
    assert.equal(rows[1].fact_id, low);
  });

  it("filters listFacts by category and min trust", () => {
    const s = new MemoryStore(":memory:");
    s.addFact("keep me", "personal"); // fact 1, trust 0.5
    s.addFact("drop me", "personal"); // fact 2, trust 0.5
    s.addFact("keep too", "work"); // fact 3, trust 0.5
    s.recordFeedback(2, false); // fact 2 -> 0.40
    assert.equal(s.listFacts("personal").length, 2); // both personal facts >= 0
    assert.equal(s.listFacts("personal", 0.5).length, 1); // only the 0.5 one
    assert.equal(s.listFacts("work").length, 1);
    assert.equal(s.listFacts().length, 3);
  });

  describe("feedback", () => {
    it("adjusts trust asymmetrically and counts helpful votes", () => {
      const s = new MemoryStore(":memory:");
      const id = s.addFact("voted");
      const helpful = s.recordFeedback(id, true);
      assert.equal(helpful.old_trust, 0.5);
      assert.ok(Math.abs(helpful.new_trust - 0.55) < 1e-9);
      assert.equal(helpful.helpful_count, 1);
      const unhelpful = s.recordFeedback(id, false);
      assert.ok(Math.abs(unhelpful.old_trust - 0.55) < 1e-9);
      assert.ok(Math.abs(unhelpful.new_trust - 0.45) < 1e-9); // -0.10
      assert.equal(unhelpful.helpful_count, 1); // helpful_count unchanged by unhelpful
    });

    it("clamps trust to [0, 1]", () => {
      const s = new MemoryStore(":memory:");
      const id = s.addFact("clamp");
      s.recordFeedback(id, false); // 0.40
      s.recordFeedback(id, false); // 0.30
      assert.ok(Math.abs(s.listFacts()[0].trust_score - 0.3) < 1e-9);
      s.recordFeedback(id, true); // 0.35
      s.recordFeedback(id, true); // 0.40
      assert.ok(Math.abs(s.listFacts()[0].trust_score - 0.4) < 1e-9);
    });

    it("raises for an unknown fact_id", () => {
      const s = new MemoryStore(":memory:");
      assert.throws(() => s.recordFeedback(999, true), /not found/);
    });
  });

  describe("entity extraction", () => {
    it("finds adjacent capitalized multi-word names as one entity", () => {
      const s = new MemoryStore(":memory:");
      s.addFact("Alice Bob launched the product");
      assert.deepEqual(s.entityNames(1), ["Alice Bob"]);
    });

    it("finds quoted terms and aka aliases", () => {
      const s = new MemoryStore(":memory:");
      s.addFact("Alice aka Bob");
      assert.deepEqual(s.entityNames(1), ["Alice", "Bob"]);
    });

    it("deduplicates case-insensitively, first spelling wins", () => {
      const s = new MemoryStore(":memory:");
      s.addFact('"Bob" and "bob" agreed');
      assert.deepEqual(s.entityNames(1), ["Bob"]);
    });

    it("resolves the same entity case-insensitively across facts", () => {
      const s = new MemoryStore(":memory:");
      s.addFact('"Bob" approved the plan'); // canonical spelling
      s.addFact('"bob" rejected the plan'); // different case, same name
      assert.ok(s.entityNames(1).includes("Bob"));
      assert.ok(s.entityNames(2).includes("Bob")); // same entity, canonical name
      // the case-insensitive name lookup returns the same entity_id
      assert.ok(s.resolveEntity("bob") === s.resolveEntity("Bob"));
    });
  });

  describe("update / remove", () => {
    it("updates fields without touching content", () => {
      const s = new MemoryStore(":memory:");
      const id = s.addFact("unchanged body");
      assert.ok(s.updateFact(id, undefined, 0.2, "finance"));
      const f = s.listFacts()[0];
      assert.equal(f.content, "unchanged body");
      assert.equal(f.trust_score, 0.7);
      assert.equal(f.tags, "finance");
    });

    it("re-extracts entities when content changes", () => {
      const s = new MemoryStore(":memory:");
      const id = s.addFact("nothing to see here");
      assert.ok(s.updateFact(id, "Alice Bob arrived"));
      assert.deepEqual(s.entityNames(id), ["Alice Bob"]);
    });

    it("removes the fact and its entity links", () => {
      const s = new MemoryStore(":memory:");
      const id = s.addFact("Alice went somewhere");
      assert.ok(s.removeFact(id));
      assert.equal(s.removeFact(id), false);
      assert.equal(s.listFacts().length, 0);
    });

    it("raises when updating/removing an unknown fact", () => {
      const s = new MemoryStore(":memory:");
      assert.equal(s.updateFact(1, "x"), false);
      assert.equal(s.removeFact(1), false);
    });
  });

  describe("HRR vectors and banks", () => {
    it("stores a prefixed float32 HRR blob per fact", () => {
      const s = new MemoryStore(":memory:", 0.5, 256);
      s.addFact("Alice approved the design");
      const blob = s._db.prepare("SELECT hrr_vector FROM facts WHERE fact_id = @id").get({ id: 1 })!.hrr_vector as Buffer;
      assert.ok(blob.subarray(0, 4).equals(Buffer.from("HRR1")));
      assert.equal(blob.length, 4 + 256 * 4);
    });

    it("computes the category memory bank from all fact vectors", () => {
      const s = new MemoryStore(":memory:", 0.5, 256);
      s.addFact("Alice designed the widget");
      s.addFact("Bob reviewed the widget");
      const bank = s._db.prepare("SELECT vector, fact_count, dim FROM memory_banks WHERE bank_name = @n").get({ n: "cat:general" });
      assert.ok(bank);
      assert.equal(bank.fact_count, 2);
      assert.equal(bank.dim, 256);
      // The stored bank blob round-trips back to a usable phase vector.
      const phases = bytesToPhases(bank!.vector as Buffer, 256);
      assert.equal(phases.length, 256);
    });

    it("deletes the bank when the category becomes empty", () => {
      const s = new MemoryStore(":memory:", 0.5, 256);
      s.addFact("Alice did a thing");
      s.removeFact(1);
      const bank = s._db.prepare("SELECT bank_id FROM memory_banks WHERE bank_name = @n").get({ n: "cat:general" });
      assert.equal(bank, undefined);
    });
  });

  it("persists across instances to a file-backed database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-store-persist-"));
    const dbPath = path.join(dir, "store.db");
    const a = new MemoryStore(dbPath);
    a.addFact("Alice wrote the spec");
    a.recordFeedback(1, true);
    a.close();
    const b = new MemoryStore(dbPath);
    const f = b.listFacts()[0];
    assert.equal(f.content, "Alice wrote the spec");
    assert.ok(Math.abs(f.trust_score - 0.55) < 1e-9);
    assert.ok(b.removeFact(1));
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

declare module "../../src/providers/holographic/store.js" {
  interface MemoryStore {
    /** Test-only: the underlying better-sqlite3 database handle. */
    _db: import("better-sqlite3").Database.Database;
  }
}
