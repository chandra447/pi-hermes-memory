/**
 * Deterministic shared entry ids (story 2, decision Q1=B — human-approved).
 *
 * The entry id IS a content hash: `sha256(trim(content) \u0000 scope \u0000
 * project_key \u0000 category)`, first 128 bits shaped to UUIDv7 form
 * (version nibble forced to 7, variant to 10xx). Consequences:
 *
 * - Same content + scope + project + category ⇒ same id on EVERY box ⇒
 *   structural cross-box dedup (the hub's upsert merges provenance instead
 *   of creating a duplicate).
 * - Identity is a pure function of the entry's fields — no lookup tables,
 *   no export refreshes, no coordination.
 *
 * FROZEN INPUT FORM: the hash input is `trim(content)` plus the scope,
 * project key, and category joined by NUL. Any future normalization change
 * (whitespace folding, case folding, …) would re-hash every existing entry
 * and orphan them, so this input form lives in exactly one function — this
 * one. Do not add a second hash path.
 *
 * The resulting string is a syntactically valid UUIDv7 (the wire's
 * `Uuid7` pattern), satisfying AD-9's client-generated-UUIDv7 contract; the
 * time-ordering property of v7 is intentionally not used (ordering is by
 * hub-stamped `updated_at`, never by id).
 */

import { createHash } from 'node:crypto';
import type { MemoryScope } from './vocabulary.js';

const NUL = '\u0000';

/**
 * The frozen hash input. `projectKey`/`category` may be null/absent (global
 * memory, unscoped entries) — they normalize to the empty string, which is
 * distinct from any real value (no field can contain NUL).
 */
export function contentIdInput(
  content: string,
  scope: MemoryScope,
  projectKey: string | null | undefined,
  category: string | null | undefined,
): string {
  return [content.trim(), scope, projectKey ?? '', category ?? ''].join(NUL);
}

/**
 * Deterministic entry id for shared memory content. Pure, synchronous,
 * stable across boxes and process restarts.
 */
export function deterministicEntryId(
  content: string,
  scope: MemoryScope,
  projectKey: string | null | undefined,
  category: string | null | undefined,
): string {
  const digest = createHash('sha256').update(contentIdInput(content, scope, projectKey, category), 'utf8').digest();
  const bytes = new Uint8Array(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
