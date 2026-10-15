/**
 * Hub server — HTTP/1.1 + JSON over TLS on `node:http`/`node:https`, no
 * framework (spine AD-3: "five endpoints don't earn one").
 *
 * Operational envelope (spine AD-14): a `User=jan` systemd boot unit on
 * cyberkleiber; store under `~/.local/share/pi-hermes-memory/hub/`; journal
 * logging. TLS trust = a local CA (AD-4) — the server presents a cert signed
 * by it; clients pin the CA at enrollment.
 *
 * The hub is a SEPARATE boot service from the AI backend (AD-2): its own
 * lifecycle, own port [8083], so llama-cuda handovers never darken memory.
 */

import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleHubRequest } from './routes.js';
import { HubStore } from './hub-store.js';
import { TokenStore } from './tokens.js';

export interface HubServerConfig {
  host: string;
  port: number;
  certPath: string;
  keyPath: string;
  dbPath: string;
  tokenStorePath: string;
}

/** Default hub directory (AD-14): `~/.local/share/pi-hermes-memory/hub/`. */
export function defaultHubDir(): string {
  return join(homedir(), '.local', 'share', 'pi-hermes-memory', 'hub');
}

/**
 * Resolve server config from environment (the systemd unit sets these).
 * Defaults match AD-14; port 8083 (8081 = llama-cuda, 8082 = llama-sycl).
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): HubServerConfig {
  const hubDir = env.PI_MEMORY_HUB_DIR ?? defaultHubDir();
  return {
    host: env.PI_MEMORY_HUB_HOST ?? '0.0.0.0',
    port: Number(env.PI_MEMORY_HUB_PORT ?? '8083'),
    certPath: env.PI_MEMORY_HUB_CERT ?? join(hubDir, 'tls', 'hub.crt'),
    keyPath: env.PI_MEMORY_HUB_KEY ?? join(hubDir, 'tls', 'hub.key'),
    dbPath: env.PI_MEMORY_HUB_DB ?? join(hubDir, 'shared.sqlite'),
    tokenStorePath: env.PI_MEMORY_HUB_TOKENS ?? join(hubDir, 'tokens.json'),
  };
}

export interface HubServer {
  server: https.Server;
  store: HubStore;
  tokens: TokenStore;
  config: HubServerConfig;
  close: () => Promise<void>;
}

/** Build the hub (store + tokens + TLS server) without listening. */
export function createHubServer(config: HubServerConfig): HubServer {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = new HubStore(config.dbPath);
  const tokens = new TokenStore(config.tokenStorePath);

  const server = https.createServer(
    {
      key: readFileSync(config.keyPath),
      cert: readFileSync(config.certPath),
    },
    (req, res) => {
      handleHubRequest(req, res, { store, tokens }).catch((err) => {
        console.error('[pi-memory-hub] unhandled route error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: 'internal_error', message: 'internal hub error' } }));
        } else {
          res.end();
        }
      });
    },
  );

  return {
    server,
    store,
    tokens,
    config,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeAllConnections();
        server.on('error', reject);
      }),
  };
}

/** Start the hub and resolve once it is listening. */
export function startHubServer(config: HubServerConfig): Promise<HubServer> {
  const hub = createHubServer(config);
  return new Promise((resolve, reject) => {
    hub.server.once('error', reject);
    hub.server.listen(config.port, config.host, () => {
      hub.server.removeListener('error', reject);
      console.log(`[pi-memory-hub] listening on https://${config.host}:${config.port} (db: ${config.dbPath})`);
      resolve(hub);
    });
  });
}

// Server entry point: the systemd unit (and `tsx src/hub/server.ts`) execs
// this file directly. Config comes from the environment (see configFromEnv).
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '__none__').href;
  } catch {
    return false;
  }
})();

if (isMain) {
  startHubServer(configFromEnv()).catch((err) => {
    console.error('[pi-memory-hub] failed to start:', err);
    process.exit(1);
  });
}
