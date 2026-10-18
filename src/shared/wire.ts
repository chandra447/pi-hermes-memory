/**
 * Shared-memory wire contract (typebox) — the single typebox surface the hub
 * and the client share (spine: "Client code and hub code share only the wire
 * contract").
 *
 * Wire & data conventions (spine):
 * - IDs are UUIDv7 (client-generated, AD-9).
 * - Timestamps are ISO-8601 UTC with millisecond precision.
 * - Errors = HTTP status + `{"error":{"code","message"}}`.
 * - Search hits = the v1 memory hit shape + mandatory provenance + `source`
 *   tag (AD-15).
 *
 * Provenance (`machine`, `session`, `identity`, `created_at`, `updated_at`)
 * is stamped by the hub, never supplied by the client (AD-8). Client-facing
 * request types therefore carry no provenance fields.
 */

import { Type, type Static } from 'typebox';
// The runtime vocabulary arrays (`./vocabulary.js`) are the single source for
// runtime checks; the typebox literals below mirror them 1:1 (see the NOTE at
// the schema definitions).

const UUID_V7_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

const ISO_8601_MS =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';

export const Uuid7 = Type.String({ pattern: UUID_V7_PATTERN });
export const IsoTimestamp = Type.String({ pattern: ISO_8601_MS });

// NOTE: the literals are spelled out (not mapped from the runtime arrays) —
// typebox v1's `StaticUnion` recurses over TUPLES only; a mapped array is not
// a tuple and resolves to `never`. The runtime arrays in `vocabulary.ts`
// remain the single source for runtime checks; these mirror them 1:1.
const Scope = Type.Union([
  Type.Literal('memory'),
  Type.Literal('user'),
  Type.Literal('failure'),
]);
const Category = Type.Union([
  Type.Literal('failure'),
  Type.Literal('correction'),
  Type.Literal('insight'),
  Type.Literal('preference'),
  Type.Literal('convention'),
  Type.Literal('tool-quirk'),
]);
const State = Type.Union([
  Type.Literal('active'),
  Type.Literal('done'),
  Type.Literal('hardening'),
  Type.Literal('held'),
  Type.Literal('dormant'),
  Type.Literal('abandoned'),
]);
const Kind = Type.Union([
  Type.Literal('memory'),
  Type.Literal('status'),
]);

/**
 * A shared entry exactly as stored and stamped by the hub (AD-8, AD-9, AD-13,
 * AD-15). `machine`/`identity` are the token identity (in v2 they are the
 * machine name; the identity column is the multi-user seam, AD-13).
 */
export const SharedEntry = Type.Object({
  id: Uuid7,
  project_key: Type.Optional(Type.String({ minLength: 1 })),
  scope: Scope,
  category: Type.Optional(Category),
  kind: Kind,
  /** Status word — only for `kind: "status"` entries. */
  state: Type.Optional(State),
  content: Type.String({ minLength: 1 }),
  failure_reason: Type.Optional(Type.String()),
  tool_state: Type.Optional(Type.String()),
  corrected_to: Type.Optional(Type.String()),
  // Provenance — hub-stamped, mandatory, fail-closed.
  machine: Type.String({ minLength: 1 }),
  session: Type.String({ minLength: 1 }),
  identity: Type.String({ minLength: 1 }),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
});
export type SharedEntry = Static<typeof SharedEntry>;

/**
 * Wire search hit (AD-15): the v1 `memory_search` hit shape + mandatory
 * provenance + `source` tag. Local hits (story 2) carry the local box name as
 * `machine` and `source: "local"` — one rendering path on the client.
 */
export const SearchHit = Type.Object({
  // v1 shape
  id: Type.String(),
  project: Type.Optional(Type.String()),
  target: Type.String(),
  category: Type.Optional(Type.String()),
  content: Type.String(),
  failureReason: Type.Optional(Type.String()),
  toolState: Type.Optional(Type.String()),
  correctedTo: Type.Optional(Type.String()),
  created: Type.String(),
  lastReferenced: Type.String(),
  // Mandatory provenance (hub-stamped)
  machine: Type.String(),
  session: Type.String(),
  identity: Type.String(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
  // Source tag
  source: Type.Literal('shared'),
});
export type SearchHit = Static<typeof SearchHit>;

/** `POST /search` request. `project` is the normalized project key (AD-10). */
export const SearchRequest = Type.Object({
  query: Type.String({ minLength: 1 }),
  project: Type.Optional(Type.String({ minLength: 1 })),
  scope: Type.Optional(Scope),
  category: Type.Optional(Category),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type SearchRequest = Static<typeof SearchRequest>;

const MemoryOpCommon = {
  id: Uuid7,
  project_key: Type.Optional(Type.String({ minLength: 1 })),
  category: Type.Optional(Category),
  /** Absent = `memory` (the store default); only status entries say otherwise. */
  kind: Type.Optional(Kind),
  state: Type.Optional(State),
  failure_reason: Type.Optional(Type.String()),
  tool_state: Type.Optional(Type.String()),
  corrected_to: Type.Optional(Type.String()),
};

/**
 * `POST /memory` request — one of three ops. All mutations are idempotent
 * upserts keyed by the client-generated UUIDv7 `id` (AD-9). No provenance
 * fields: the hub stamps them (AD-8).
 *
 * `remove` deletes by `id` alone, so it does not require `scope`/`session`/
 * `state` (those describe the entry being written, not the deletion).
 */
export const MemoryOpRequest = Type.Union([
  Type.Object({ op: Type.Literal('add'), ...MemoryOpCommon, scope: Scope, session: Type.String({ minLength: 1 }), content: Type.String({ minLength: 1 }) }),
  Type.Object({ op: Type.Literal('replace'), ...MemoryOpCommon, scope: Scope, session: Type.String({ minLength: 1 }), content: Type.String({ minLength: 1 }) }),
  Type.Object({ op: Type.Literal('remove'), ...MemoryOpCommon, scope: Type.Optional(Scope), session: Type.Optional(Type.String({ minLength: 1 })) }),
]);
export type MemoryOpRequest = Static<typeof MemoryOpRequest>;

/**
 * `GET /status` response: the latest status-kind entry for a project.
 * No status entry exists → `status: null` (the spec's response matrix —
 * `null`, not an absent key).
 */
export const StatusResponse = Type.Object({
  project: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Null(),
    Type.Object({
      state: State,
      content: Type.String(),
      updated_at: IsoTimestamp,
      machine: Type.String(),
      session: Type.String(),
    }),
  ]),
});
export type StatusResponse = Static<typeof StatusResponse>;

/** Standard error body (spine error convention). */
export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  }),
});
export type ErrorResponse = Static<typeof ErrorResponse>;

/** `GET /healthz` response. */
export const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
});
export type HealthResponse = Static<typeof HealthResponse>;
