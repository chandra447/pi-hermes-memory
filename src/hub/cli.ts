/**
 * pi-memory-hub CLI (spine AD-5/AD-14).
 *
 * Subcommands:
 * - `serve`            run the hub server (env-configured; the systemd unit
 *                      execs `src/hub/server.ts` directly — `serve` is the
 *                      interactive equivalent, e.g. `tsx src/hub/cli.ts serve`)
 * - `enroll <box>`     one-time human enrollment: issue a token for a machine
 *                      and print its client file (hub URL + CA pin + token).
 *                      Runs ON THE HUB BOX (same machine → direct token-store
 *                      write, no sixth endpoint — AD-3 caps the surface at
 *                      five). The human carries the printed file to the
 *                      enrolled box's `~/.config/pi-hermes-memory/`.
 * - `revoke <box>`     delete a machine's token (takes effect without restart)
 * - `list`             list enrolled machines
 * - `export [--out f]` JSONL dump of the shared store (AD-14 export path)
 */

import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configFromEnv, defaultHubDir, startHubServer } from './server.js';
import { HubStore } from './hub-store.js';
import { TokenStore } from './tokens.js';

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

function defaultIo(): CliIo {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
}

/** First non-internal IPv4 address (the LAN interface), or 127.0.0.1. */
function lanAddress(): string {
  const interfaces = networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function caCertPath(env: NodeJS.ProcessEnv): string {
  // Mirror configFromEnv: the CA lives under the (possibly overridden) hub
  // dir unless PI_MEMORY_HUB_CA says otherwise — a client file pinned to the
  // wrong CA would fail TLS on the enrolled box.
  const hubDir = env.PI_MEMORY_HUB_DIR ?? defaultHubDir();
  return env.PI_MEMORY_HUB_CA ?? `${hubDir}/tls/ca.crt`;
}

/** Print the client file. Returns false (and prints an error) if the CA pin
 *  cannot be read — a client file without its CA pin is not a working trust
 *  anchor, so enrollment must fail rather than continue. */
function printClientFile(io: CliIo, env: NodeJS.ProcessEnv, machine: string, token: string): boolean {
  const caPath = caCertPath(env);
  if (!existsSync(caPath)) {
    io.err(`error: CA cert not found at ${caPath} — generate the hub TLS material before enrolling (no client file printed).`);
    return false;
  }
  const caPem = readFileSync(caPath, 'utf8');
  const port = env.PI_MEMORY_HUB_PORT ?? '8083';
  const clientFile = {
    hub_url: `https://${lanAddress()}:${port}`,
    ca_cert_pem: caPem,
    token,
    machine,
  };
  io.out(JSON.stringify(clientFile, null, 2));
  io.err(`→ save this as ~/.config/pi-hermes-memory/hub-client.json on ${machine} (local file — never chezmoi).`);
  return true;
}

async function cmdServe(env: NodeJS.ProcessEnv): Promise<number> {
  const hub = await startHubServer(configFromEnv(env));
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off('SIGTERM', done);
      process.off('SIGINT', done);
      // Close the store (WAL checkpoint) before exiting so a service stop
      // never drops in-flight writes.
      void hub.close().then(resolve).catch(resolve);
    };
    process.on('SIGTERM', done);
    process.on('SIGINT', done);
  });
  return 0;
}

function cmdEnroll(env: NodeJS.ProcessEnv, io: CliIo, args: string[]): number {
  const box = args[0];
  if (!box) {
    io.err('usage: pi-memory-hub enroll <box>');
    return 2;
  }
  const tokens = new TokenStore(configFromEnv(env).tokenStorePath);
  const result = tokens.enroll(box);
  if (!printClientFile(io, env, result.machine, result.token)) {
    // The token exists now (enroll wrote it) but the client file could not be
    // completed — the human re-runs enrollment after generating the TLS
    // material (rotation = re-enroll, AD-5).
    return 1;
  }
  return 0;
}

function cmdRevoke(env: NodeJS.ProcessEnv, io: CliIo, args: string[]): number {
  const box = args[0];
  if (!box) {
    io.err('usage: pi-memory-hub revoke <box>');
    return 2;
  }
  const tokens = new TokenStore(configFromEnv(env).tokenStorePath);
  const removed = tokens.revoke(box);
  io.out(removed ? `revoked ${box}` : `${box}: no enrolled machine to revoke`);
  return removed ? 0 : 1;
}

function cmdList(env: NodeJS.ProcessEnv, io: CliIo): number {
  const tokens = new TokenStore(configFromEnv(env).tokenStorePath);
  const machines = tokens.listMachines();
  if (machines.length === 0) {
    io.out('(no machines enrolled)');
    return 0;
  }
  for (const m of machines) {
    io.out(`${m.machine}\t${m.enrolled_at}`);
  }
  return 0;
}

function cmdExport(env: NodeJS.ProcessEnv, io: CliIo, args: string[]): number {
  const outFlag = args.indexOf('--out');
  let outFile: string | undefined;
  if (outFlag !== -1) {
    outFile = args[outFlag + 1];
    if (!outFile) {
      io.err('usage: pi-memory-hub export [--out <file>]');
      return 2;
    }
  }
  const config = configFromEnv(env);
  // Mirror createHubServer: the store dir may not exist yet on a machine
  // that has never run the hub (a fresh, empty export is the right answer —
  // not a crash).
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = new HubStore(config.dbPath);
  try {
    const lines = store.exportRows().map((entry) => JSON.stringify(entry));
    const payload = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    if (outFile) {
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, payload);
      io.out(`exported ${lines.length} entries to ${outFile}`);
    } else {
      process.stdout.write(payload);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** CLI entry. Returns the process exit code. */
export async function runHubCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const [command, ...rest] = argv;
  try {
    return await dispatch(command, rest, io);
  } catch (err) {
    io.err(err instanceof Error ? `error: ${err.message}` : `error: ${String(err)}`);
    return 1;
  }
}

async function dispatch(command: string | undefined, rest: string[], io: CliIo): Promise<number> {
  switch (command) {
    case 'serve':
      return cmdServe(process.env);
    case 'enroll':
      return cmdEnroll(process.env, io, rest);
    case 'revoke':
      return cmdRevoke(process.env, io, rest);
    case 'list':
      return cmdList(process.env, io);
    case 'export':
      return cmdExport(process.env, io, rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out('pi-memory-hub — the shared-memory hub CLI\n\nusage: pi-memory-hub <serve|enroll <box>|revoke <box>|list|export [--out <file>]>');
      return command === undefined ? 2 : 0;
    default:
      io.err(`unknown command: ${command} (try --help)`);
      return 2;
  }
}

// Self-run when executed as the main module (via bin/pi-memory-hub.mjs).
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '__none__').href;
  } catch {
    return false;
  }
})();

if (isMain) {
  runHubCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
