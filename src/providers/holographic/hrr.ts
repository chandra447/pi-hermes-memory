/**
 * Holographic Reduced Representations (HRR) — TypeScript port of Hermes's
 * `plugins/memory/holographic/holographic.py`.
 *
 * Each concept is a vector of angles in [0, 2π). bind = circular convolution
 * (phase addition), unbind = circular correlation (phase subtraction), bundle =
 * superposition (circular mean). Phase encoding avoids the magnitude collapse
 * of complex-number HRRs and maps cleanly to cosine similarity. Atoms derive
 * deterministically from SHA-256 so representations are identical across
 * processes, machines, and runtimes.
 *
 * References: Plate (1995) HRRs; Gayler (2004) Vector Symbolic Architectures.
 */

import { createHash } from "node:crypto";

export type PhaseVector = Float64Array;

export const _TWO_PI = 2.0 * Math.PI;
export const _FLOAT32_BLOB_PREFIX = "HRR1";
const _F32 = 4;
const _F64 = 8;
const _ROLE_CONTENT = "__hrr_role_content__";
const _ROLE_ENTITY = "__hrr_role_entity__";

export { _ROLE_CONTENT, _ROLE_ENTITY };

export function hasNumpy(): boolean {
  // HRR algebra is pure math here; numpy is treated as always-available in TS.
  return true;
}

/**
 * Deterministic phase vector: SHA-256 counter blocks of `word:i` -> uint16 ->
 * [0, 2π). hashlib rather than an RNG so atoms are reproducible across
 * platforms and runtimes (matching the Python reference).
 */
export function encodeAtom(word: string, dim: number = 1024): PhaseVector {
  const ceilBlocks = Math.ceil(dim / 16); // 32-byte digest = 16 uint16 values per block
  const uint16Values: number[] = [];
  for (let i = 0; i < ceilBlocks; i++) {
    const digest = createHash("sha256").update(`${word}:${i}`).digest();
    // struct.unpack("<16H", digest): all 16 little-endian uint16s from the 32 bytes.
    for (let k = 0; k < 16; k++) uint16Values.push((digest[k] << 8) | digest[k + 1]);
  }
  return new Float64Array(uint16Values.slice(0, dim).map((v) => (v / 65536.0) * _TWO_PI));
}

/** Circular convolution = phase addition; quasi-orthogonal to both inputs. */
export function bind(a: PhaseVector, b: PhaseVector): PhaseVector {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) % _TWO_PI;
  return out;
}

/** Circular correlation = phase subtraction; unbind(bind(a, b), a) ≈ b. */
export function unbind(memory: PhaseVector, key: PhaseVector): PhaseVector {
  const out = new Float64Array(memory.length);
  for (let i = 0; i < memory.length; i++) out[i] = (memory[i] - key[i]) % _TWO_PI;
  return out;
}

/** Superposition via circular mean; holds O(sqrt(dim)) items before degrading. */
export function bundle(vectors: PhaseVector[]): PhaseVector {
  if (vectors.length === 0) return encodeAtom("__hrr_empty__");
  const dim = vectors[0].length;
  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    let sx = 0;
    let sy = 0;
    for (const v of vectors) {
      sx += Math.cos(v[i]);
      sy += Math.sin(v[i]);
    }
    out[i] = Math.atan2(sy, sx) % _TWO_PI;
  }
  return out;
}

/** Phase cosine similarity in [-1, 1]; ~0 for unrelated vectors. */
export function similarity(a: PhaseVector, b: PhaseVector): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.cos(a[i] - b[i]);
  return sum / a.length;
}

/** Bag-of-words bundle of token atoms; empty text -> encode_atom("__hrr_empty__"). */
const PUNCT = new Set(",.!?:;\"'()[]{}".split(""));

function stripPunct(s: string): string {
  let out = "";
  for (const ch of s) if (!PUNCT.has(ch)) out += ch;
  return out;
}

export function encodeText(text: string, dim: number = 1024): PhaseVector {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map(stripPunct)
    .filter((t) => t.length > 0);
  return tokens.length > 0
    ? bundle(tokens.map((token) => encodeAtom(token, dim)))
    : encodeAtom("__hrr_empty__", dim);
}

/**
 * bundle(bind(text, ROLE_CONTENT), bind(entity_i, ROLE_ENTITY)...) so that
 * unbind(fact, bind(entity, ROLE_ENTITY)) ≈ content_vector.
 */
export function encodeFact(content: string, entities: string[], dim: number = 1024): PhaseVector {
  const roleContent = encodeAtom(_ROLE_CONTENT, dim);
  const roleEntity = encodeAtom(_ROLE_ENTITY, dim);
  const entityVectors = entities.map((entity) => bind(encodeAtom(entity.toLowerCase(), dim), roleEntity));
  return bundle([bind(encodeText(content, dim), roleContent), entityVectors]);
}

/** Serialize as prefixed float32 (half the size of legacy float64 blobs). */
export function phasesToBytes(phases: PhaseVector, dim?: number): Buffer {
  const d = dim ?? phases.length;
  if (4 + d * _F32 === d * _F64) return Buffer.from(phases); // dim == 1 collision case
  const f32 = new Float32Array(phases.length);
  for (let i = 0; i < phases.length; i++) f32[i] = phases[i];
  return Buffer.concat([Buffer.from(_FLOAT32_BLOB_PREFIX), Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)]);
}

/** Deserialize prefixed float32 or legacy raw float64 blobs (always returns float64). */
function byteEquals(buf: Buffer, offset: number, value: string): boolean {
  for (let i = 0; i < value.length; i++) if (buf[offset + i] !== value.charCodeAt(i)) return false;
  return true;
}

export function bytesToPhases(data: Buffer, dim?: number): PhaseVector {

  const d = dim ?? data.length;
  const plen = _FLOAT32_BLOB_PREFIX.length;
  const prefixed = byteEquals(data, 0, _FLOAT32_BLOB_PREFIX);

  if (dim === undefined) {
    if (prefixed) return fromF32Payload(data.subarray(plen));
    return fromF64Payload(data);
  }

  const float32BlobBytes = plen + d * _F32;
  const float64Bytes = d * _F64;
  const collides = float32BlobBytes === float64Bytes; // dim == 1
  if (!collides && prefixed && data.length === float32BlobBytes) return fromF32Payload(data.subarray(plen));
  if (data.length === float64Bytes) return fromF64Payload(data);
  if (!prefixed) throw new Error(`HRR legacy vector blob has ${data.length} bytes; expected ${float64Bytes} (float64) for dim=${d}`);
  throw new Error(`HRR vector blob has ${data.length} bytes; expected ${float64Bytes} (legacy float64) for dim=${d}`);
}

function fromF32Payload(payload: Buffer): PhaseVector {
  // Copy bytes into a fresh array (subarray views can omit typed-read methods) and read LE float32s.
  const count = payload.length / 4;
  const bytes = new Uint8Array(count * 4);
  payload.copy(bytes);
  const f32 = new Float32Array(bytes.buffer);
  return new Float64Array(f32);
}

function fromF64Payload(payload: Buffer): PhaseVector {
  return new Float64Array(payload);
}

/** SNR = sqrt(dim / n_items) (inf when empty); warns below 2.0. */
export function snrEstimate(dim: number, nItems: number): number {
  const snr = nItems > 0 ? Math.sqrt(dim / nItems) : Infinity;
  if (snr < 2.0) {
    // eslint-disable-next-line no-console
    console.warn(`HRR storage near capacity: SNR=${snr.toFixed(2)} (dim=${dim}, n_items=${nItems}). Retrieval accuracy may degrade.`);
  }
  return snr;
}
