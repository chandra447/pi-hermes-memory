/**
 * Hub client — the box's single network surface to the shared store
 * (spine AD-11: probe ≤ 500 ms; the network never blocks a turn).
 *
 * - TLS pinned to the CA embedded in the enrollment client file (AD-4):
 *   `https.Agent({ ca })` — the hub's self-signed cert verifies against
 *   exactly that CA (hostname checks run normally; the hub cert carries the
 *   LAN IP in its SAN).
 * - Auth = the bearer token from the same file (AD-5: the hub is the sole
 *   credential authority; the file is local, non-chezmoi, 0600).
 * - Provenance is never supplied here (AD-8) — the client sends content and
 *   (for the replace procedure) an `inherits_from` pointer only.
 *
 * Degraded mode (AD-11): `probe()` caches up/down with a short TTL and
 * backoff; a failed probe means "run v1 + say so", never "wait".
 */

import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import type {
  MemoryOpRequest,
  SearchHit,
  SearchRequest,
  SharedEntry,
  StatusResponse,
} from '../shared/wire.js';

export interface HubClientConfig {
  hubUrl: string;
  machine: string;
  caCertPem: string;
  token: string;
}

/** The hub could not be reached (DNS/refused/timeout/TLS) — degraded mode. */
export class HubUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUnreachableError';
  }
}

/** The hub answered with an error status — an explicit failure, not degrade. */
export class HubHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubHttpError';
  }
}

export const PROBE_TIMEOUT_MS = 500;
export const CALL_TIMEOUT_MS = 1000;
/**
 * Session-start budget for the shared user-profile fetch (story 4). The
 * export is the whole store in NDJSON — bigger than a turn-path op, and it
 * happens OFF the turn path (session start, once per session), so it gets
 * its own, larger bound. It must still be bounded: the network may never
 * hold a session hostage (AD-11).
 */
export const EXPORT_TIMEOUT_MS = 5000;
const PROBE_TTL_MS = 30_000; // a successful probe is trusted for 30 s
const DOWN_BACKOFF_MS = 30_000; // a failed probe is re-tried after 30 s

interface ProbeState {
  up: boolean;
  expiresAt: number;
}

const DEFAULT_CLIENT_FILE = resolvePath(homedir(), '.config/pi-hermes-memory/hub-client.json');

/** Default enrollment client file path (local, secret, non-chezmoi). */
export function defaultClientFilePath(): string {
  return DEFAULT_CLIENT_FILE;
}

/**
 * Load + validate the enrollment client file. Missing → null (shared memory
 * simply not configured — silent v1). Corrupt/invalid → null + ONE console
 * warning (the enroll CLI is the repair path; tool results must not spam).
 */
export function loadClientFile(path: string = DEFAULT_CLIENT_FILE): HubClientConfig | null {
  let raw: string;
  try {
    if (!existsSync(path)) return null;
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.warn(`pi-hermes-memory: cannot read hub client file at ${path}: ${String(err)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cfg: HubClientConfig = {
      hubUrl: String(parsed.hub_url),
      machine: String(parsed.machine),
      caCertPem: String(parsed.ca_cert_pem),
      token: String(parsed.token),
    };
    if (!/^https:\/\//.test(cfg.hubUrl) || !cfg.hubUrl || !cfg.machine || !cfg.token || !cfg.caCertPem.includes('BEGIN CERTIFICATE')) {
      throw new Error('missing or malformed fields (need hub_url, machine, ca_cert_pem, token)');
    }
    const url = new URL(cfg.hubUrl); // must parse
    // A path in hub_url is a config error, not hub-down: /healthz would 404
    // forever and the box would sit in degraded mode with misleading banners
    // (EC-11). Reject it explicitly at load time instead.
    if (url.pathname !== '/' && url.pathname !== '') {
      throw new Error(`hub_url must be scheme://host[:port] with no path (got ${cfg.hubUrl})`);
    }
    return cfg;
  } catch (err) {
    console.warn(`pi-hermes-memory: hub client file at ${path} is invalid: ${String(err)} — shared memory disabled (re-enroll to repair).`);
    return null;
  }
}

export class HubClient {
  private readonly agent: https.Agent;
  private probeState: ProbeState = { up: false, expiresAt: 0 };
  /** One-shot CONSOLE warning (probe failures). */
  private consoleWarned = false;
  /** One-shot TOOL-RESULT banner budget (consumed by the tools' state lines). */
  private toolSignalled = false;

  constructor(private readonly cfg: HubClientConfig) {
    this.agent = new https.Agent({
      ca: cfg.caCertPem,
      rejectUnauthorized: true,
      keepAlive: true,
      maxSockets: 4,
    });
  }

  /** The box name from the enrollment file (used as `machine` on local hits). */
  get machine(): string {
    return this.cfg.machine;
  }

  /**
   * Probe `GET /healthz` (≤ 500 ms) with a short cache. Cached states are
   * free; a live probe failure flips the cache to down with backoff. Any
   * successful call (search/op) also refreshes the cache to up.
   */
  async probe(): Promise<boolean> {
    const now = Date.now();
    if (now < this.probeState.expiresAt) return this.probeState.up;
    try {
      await this.request('/healthz', 'GET', undefined, PROBE_TIMEOUT_MS);
      this.setProbe(true, now + PROBE_TTL_MS);
      return true;
    } catch {
      this.setProbe(false, now + DOWN_BACKOFF_MS);
      if (!this.consoleWarned) {
        this.consoleWarned = true;
        console.warn(`pi-hermes-memory: hub at ${this.cfg.hubUrl} unreachable — degraded (local-only) mode.`);
      }
      return false;
    }
  }

  /** True once the tool-result banner has been shown (budget consumed). */
  get hasSignalledDown(): boolean {
    return this.toolSignalled;
  }

  /** Consume the one-shot down-signal budget (the tool shows the full banner). */
  markDownSignalled(): void {
    this.toolSignalled = true;
  }

  /** Clear the down-signal budget (e.g. when the hub comes back up). */
  clearDownSignal(): void {
    this.toolSignalled = false;
  }

  private setProbe(up: boolean, expiresAt: number): void {
    this.probeState = { up, expiresAt };
  }

  async search(req: SearchRequest): Promise<SearchHit[]> {
    const body = await this.request<{ hits: SearchHit[]; raw_matches: number }>(
      '/search',
      'POST',
      req,
      CALL_TIMEOUT_MS,
    );
    return body.hits;
  }

  /** One add/replace/remove op. Returns the hub's response body. */
  async memory(op: MemoryOpRequest): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>('/memory', 'POST', op, CALL_TIMEOUT_MS);
  }

  /** `GET /status?project=<key>` (story 3's rollup surface). */
  async status(projectKey: string): Promise<StatusResponse> {
    return await this.request<StatusResponse>(`/status?project=${encodeURIComponent(projectKey)}`, 'GET', undefined, CALL_TIMEOUT_MS);
  }

  /**
   * `GET /export` — the NDJSON dump of the whole shared store (NFR-13).
   * Session-start surface (the story-4 profile fetch), never turn-path:
   * one call per session, bounded by EXPORT_TIMEOUT_MS. The body is
   * newline-delimited JSON, so this parses line-by-line instead of going
   * through the generic JSON `request()`.
   */
  async export(): Promise<SharedEntry[]> {
    let result: { status: number; text: string };
    try {
      result = await this.rawRequest('/export', 'GET', undefined, EXPORT_TIMEOUT_MS);
    } catch (err) {
      // Liveness contract identical to request(): a failed call is liveness
      // evidence — flip the probe so the next call takes the degraded path.
      this.setProbe(false, Date.now() + DOWN_BACKOFF_MS);
      throw err;
    }
    if (result.status < 200 || result.status >= 300) {
      let code = 'http_error';
      let message = `hub returned HTTP ${result.status}`;
      try {
        const errBody = JSON.parse(result.text) as { error?: { code?: string; message?: string } };
        if (errBody?.error?.code) code = errBody.error.code;
        if (errBody?.error?.message) message = errBody.error.message;
      } catch { /* non-JSON error body — keep the generic message */ }
      throw new HubHttpError(result.status, code, message);
    }
    // A live answer refreshes the probe cache (the call itself is liveness).
    this.setProbe(true, Date.now() + PROBE_TTL_MS);
    return result.text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SharedEntry);
  }

  /** Release sockets (extension shutdown). */
  close(): void {
    this.agent.destroy();
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    let result: { status: number; text: string };
    try {
      result = await this.rawRequest(path, method, body, timeoutMs);
    } catch (err) {
      // A failed CALL is liveness evidence too: flip the probe state to
      // down so the NEXT call takes the degraded path instead of trusting
      // a stale up-cache (review fix — otherwise a hub that dies inside the
      // up-TTL mislabels hub-down writes as content rejections).
      this.setProbe(false, Date.now() + DOWN_BACKOFF_MS);
      throw err;
    }
    if (result.status < 200 || result.status >= 300) {
      let errBody: { error?: { code?: string; message?: string } } | undefined;
      try {
        errBody = JSON.parse(result.text) as { error?: { code?: string; message?: string } };
      } catch {
        // non-JSON error body — surface the generic message.
      }
      throw new HubHttpError(
        result.status,
        errBody?.error?.code ?? 'http_error',
        errBody?.error?.message ?? `hub returned HTTP ${result.status}`,
      );
    }
    // A live answer refreshes the probe cache (the call itself is liveness).
    this.setProbe(true, Date.now() + PROBE_TTL_MS);
    let json: unknown = null;
    try {
      json = result.text.length > 0 ? JSON.parse(result.text) : null;
    } catch {
      // non-JSON body (shouldn't happen) — surface as null, as before.
    }
    return json as T;
  }

  private rawRequest(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const url = new URL(path, this.cfg.hubUrl);
      const data = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method,
          agent: this.agent,
          headers: {
            authorization: `Bearer ${this.cfg.token}`,
            ...(data
              ? { 'content-type': 'application/json', 'content-length': String(data.length) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            settle(() => resolvePromise({ status: res.statusCode ?? 0, text }));
          });
        },
      );
      req.setTimeout(timeoutMs);
      req.on('error', (err: Error) =>
        settle(() => rejectPromise(new HubUnreachableError(err.message))),
      );
      req.on('timeout', () => {
        settle(() =>
          rejectPromise(new HubUnreachableError(`timed out after ${timeoutMs} ms`)),
        );
        req.destroy();
      });
      if (data) req.write(data);
      req.end();
    });
  }
}

/**
 * Construct a client from a client file (path overridable for tests/config).
 * Null when shared memory is not configured or the file is invalid.
 */
export function createHubClient(clientFilePath?: string): HubClient | null {
  const cfg = loadClientFile(clientFilePath);
  return cfg ? new HubClient(cfg) : null;
}
