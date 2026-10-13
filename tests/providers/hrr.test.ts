import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
} from "../../src/providers/holographic/hrr.js";

const DIM = 256;
const isFloat64 = (v: unknown): v is Float64Array => Float64Array.prototype.isPrototypeOf(v as object);

describe("HRR math port", () => {
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

  it("blob round-trips preserve the vector", () => {
    const v = encodeAtom("roundtrip", DIM);
    const bytes = phasesToBytes(v, DIM);
    assert.ok(bytes.slice(0, 4).equals(Buffer.from("HRR1")));
    const back = bytesToPhases(bytes, DIM);
    assert.ok(isFloat64(back));
    assert.ok(Math.abs(similarity(v, back) - 1) < 1e-4, `blob round-trip similarity ${similarity(v, back)}`);
  });

  it("rejects dim<=1 on write (ambiguous + meaningless)", () => {
    assert.throws(() => phasesToBytes(new Float64Array([1.5]), 1), /dim must be > 1/);
  });

  it("rejects dim<=1 blobs on read", () => {
    const blob = Buffer.concat([Buffer.from("HRR1"), Buffer.alloc(4)]); // payload 4 bytes == dim 1
    assert.throws(() => bytesToPhases(blob, 1), /dim must be > 1/);
  });

  it("rejects blobs without the HRR1 prefix (legacy raw-f64 no longer supported)", () => {
    const raw = Buffer.alloc(2 * 8); // what the old legacy f64 format looked like
    assert.throws(() => bytesToPhases(raw, 2), /missing the "HRR1" prefix/);
  });

  it("rejects a payload whose length does not match the declared dim", () => {
    const bytes = phasesToBytes(encodeAtom("len", DIM), DIM);
    assert.throws(() => bytesToPhases(bytes, DIM - 1), /payload bytes; expected/);
  });
});
