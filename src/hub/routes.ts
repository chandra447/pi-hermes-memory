/**
 * Hub route handlers — the five-endpoint capability surface (spine AD-3), no
 * more: `GET /healthz` · `POST /search` · `POST /memory` (add|replace|remove)
 * · `GET /status?project=<key>` · `GET /export`.
 *
 * Rules enforced here (spine):
 * - Bearer-token auth on every endpoint except `/healthz` (AD-5).
 * - typebox validation of every request body (wire contract, `src/shared/wire.ts`).
 * - Errors = HTTP status + `{"error":{"code","message"}}`.
 * - The content gate runs in the hub BEFORE persisting (AD-12, C9).
 * - Provenance is stamped by the hub: machine/identity from the verified
 *   token, session from the request, timestamps = now; an unstampable write
 *   is rejected (AD-8, fail-closed).
 * - All mutations go through the store API — never raw SQL in a route.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import {
  MemoryOpRequest,
  SearchHit,
  SearchRequest,
  type SharedEntry,
} from '../shared/wire.js';
import { scanContent } from '../shared/content-scanner.js';
import type { HubStore } from './hub-store.js';
import type { TokenStore } from './tokens.js';

export interface HubRouteContext {
  store: HubStore;
  tokens: TokenStore;
}

const MAX_BODY_BYTES = 256 * 1024;

function nowIsoMs(): string {
  return new Date().toISOString();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: { code, message } });
}

/** `Authorization: Bearer <token>` → verified machine identity, or null. */
function authenticate(req: IncomingMessage, tokens: TokenStore): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  return tokens.verify(match[1]);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

async function parseJson<T>(res: ServerResponse, req: IncomingMessage, schema: TSchema): Promise<T | null> {
  const body = await readBody(req);
  if (body === null) {
    sendError(res, 413, 'payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
  } catch {
    sendError(res, 400, 'invalid_request', 'request body is not valid JSON');
    return null;
  }
  if (!Value.Check(schema, parsed)) {
    const issues = Value.Errors(schema, parsed).map((e) => {
      const err = e as { path?: string; message?: string };
      return `${err.path ?? '/'}: ${err.message ?? 'invalid'}`;
    }).join('; ');
    sendError(res, 400, 'invalid_request', `request body failed validation — ${issues}`);
    return null;
  }
  return parsed as T;
}

/** Wire hit = v1 shape + mandatory provenance + `source` tag (AD-15). */
function toSearchHit(entry: SharedEntry): SearchHit {
  const hit: Record<string, unknown> = {
    id: entry.id,
    target: entry.scope,
    content: entry.content,
    created: entry.created_at,
    lastReferenced: entry.updated_at,
    machine: entry.machine,
    session: entry.session,
    identity: entry.identity,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    provenance: entry.provenance,
    source: 'shared',
  };
  if (entry.project_key !== undefined) hit.project = entry.project_key;
  if (entry.category !== undefined) hit.category = entry.category;
  if (entry.failure_reason !== undefined) hit.failureReason = entry.failure_reason;
  if (entry.tool_state !== undefined) hit.toolState = entry.tool_state;
  if (entry.corrected_to !== undefined) hit.correctedTo = entry.corrected_to;
  return hit as unknown as SearchHit;
}

async function handleSearch(req: IncomingMessage, res: ServerResponse, ctx: HubRouteContext): Promise<void> {
  const body = await parseJson<SearchRequest>(res, req, SearchRequest);
  if (body === null) return;
  const { query, project, project_any, scope, category, limit } = body;
  const { hits, raw_matches } = ctx.store.search(query, {
    project,
    ...(project_any !== undefined ? { projectAny: project_any } : {}),
    scope,
    category,
    limit,
  });
  sendJson(res, 200, { hits: hits.map(toSearchHit), raw_matches });
}

async function handleMemory(req: IncomingMessage, res: ServerResponse, ctx: HubRouteContext): Promise<void> {
  // Authentication already ran at the route boundary (401 above).
  const machine = authenticate(req, ctx.tokens)!;
  const body = await parseJson<MemoryOpRequest>(res, req, MemoryOpRequest);
  if (body === null) return;

  if (body.op === 'remove') {
    // remove deletes by id alone — the state/kind cross-field rule below
    // (which concerns entries being WRITTEN) does not apply to it.
    const removed = ctx.store.remove(body.id);
    sendJson(res, 200, { id: body.id, removed });
    return;
  }

  // Cross-field rule: `state` belongs to status-kind entries only (spine
  // "Status entries" — the six words live in the vocabulary, never in
  // content). Absent `kind` means the store default, `memory`.
  const kind = body.kind ?? 'memory';
  if ((kind === 'status') !== (body.state !== undefined)) {
    sendError(
      res,
      400,
      'invalid_request',
      kind === 'status'
        ? 'kind "status" requires a "state" field (one of the six status words)'
        : 'a "state" field is only valid for kind "status"',
    );
    return;
  }

  // op = add | replace — the content gate runs in the hub, before persisting.
  const blocked = scanContent(body.content);
  if (blocked !== null) {
    sendError(res, 400, 'blocked_content', blocked);
    return;
  }

  // Hub-stamped provenance (AD-8): machine/identity from the verified token,
  // session from the request, timestamps = now. Fail-closed — `session` is a
  // required field, so an unstampable write is rejected by validation above.
  const now = nowIsoMs();
  const createdAt = body.op === 'replace' ? (ctx.store.getEntry(body.id)?.created_at ?? now) : now;
  const action = ctx.store.upsert({
    id: body.id,
    content: body.content,
    project_key: body.project_key,
    scope: body.scope,
    category: body.category,
    kind,
    state: body.state,
    failure_reason: body.failure_reason,
    tool_state: body.tool_state,
    corrected_to: body.corrected_to,
    machine,
    identity: machine,
    session: body.session,
    created_at: createdAt,
    updated_at: now,
    // Replace procedure (story 2): pointer only — the hub resolves the
    // referenced entry's provenance server-side (AD-8).
    ...(body.inherits_from !== undefined ? { inherits_from: body.inherits_from } : {}),
  });

  const entry = ctx.store.getEntry(body.id)!;
  sendJson(res, action === 'inserted' ? 201 : 200, { action, entry });
}

async function handleStatus(req: IncomingMessage, res: ServerResponse, ctx: HubRouteContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  const project = url.searchParams.get('project');
  if (project === null || project.length === 0) {
    sendError(res, 400, 'invalid_request', 'query parameter "project" is required');
    return;
  }
  const latest = ctx.store.latestStatus(project);
  if (latest === null) {
    sendJson(res, 200, { project, status: null });
    return;
  }
  sendJson(res, 200, {
    project,
    status: {
      state: latest.state!,
      content: latest.content,
      updated_at: latest.updated_at,
      machine: latest.machine,
      session: latest.session,
    },
  });
}

async function handleExport(req: IncomingMessage, res: ServerResponse, ctx: HubRouteContext): Promise<void> {
  const rows = ctx.store.exportRows();
  const payload = rows.map((entry) => JSON.stringify(entry)).join('\n') + (rows.length > 0 ? '\n' : '');
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Route one request. Exported for the server and for tests; errors that
 * escape become 500s at the server boundary.
 */
export async function handleHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HubRouteContext,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://internal');
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  const machine = authenticate(req, ctx.tokens);
  if (machine === null) {
    sendError(res, 401, 'unauthorized', 'missing or invalid bearer token');
    return;
  }

  if (method === 'POST' && path === '/search') {
    await handleSearch(req, res, ctx);
    return;
  }
  if (method === 'POST' && path === '/memory') {
    await handleMemory(req, res, ctx);
    return;
  }
  if (method === 'GET' && path === '/status') {
    await handleStatus(req, res, ctx);
    return;
  }
  if (method === 'GET' && path === '/export') {
    await handleExport(req, res, ctx);
    return;
  }

  sendError(res, 404, 'not_found', `no route for ${method} ${path}`);
}
