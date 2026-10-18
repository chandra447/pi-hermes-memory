/**
 * Regression test for the production entry point: the systemd unit execs
 * `tsx src/hub/server.ts` DIRECTLY (not the CLI `serve`). The first version
 * of server.ts had no main entry — the process exited 0 with an empty event
 * loop ~650 ms after start ("active" in systemctl, dead in reality).
 *
 * This test spawns the real entry under tsx and proves: it serves /healthz
 * over pinned TLS, stays alive past the original failure window, and shuts
 * down cleanly (exit 0) on SIGTERM — what `systemctl stop` sends.
 */

import { spawn } from 'node:child_process';
import https from 'node:https';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tlsFixture, tlsFixtureCleanup } from './tls-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(new URL(import.meta.url))), '..', '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || addr === null) return reject(new Error('no port'));
      srv.close(() => resolve(addr.port));
    });
  });
}

function healthz(port: number, caPem: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: '127.0.0.1', port, path: '/healthz', ca: caPem, rejectUnauthorized: true },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
  });
}

test('server.ts (unit entry): serves /healthz, stays alive, exits 0 on SIGTERM', async (t) => {
  const tls = tlsFixture();
  const port = await freePort();
  const dbDir = mkdtempSync(path.join(tmpdir(), 'pi-hub-entry-'));
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'node_modules', '.bin', 'tsx'), 'src/hub/server.ts'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PI_MEMORY_HUB_DIR: dbDir,
        PI_MEMORY_HUB_HOST: '127.0.0.1',
        PI_MEMORY_HUB_PORT: String(port),
        PI_MEMORY_HUB_CERT: tls.hubCrt,
        PI_MEMORY_HUB_KEY: tls.hubKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  t.after(() => {
    if (child.exitCode === null && child.signal === null) child.kill('SIGKILL');
    rmSync(dbDir, { recursive: true, force: true });
    tlsFixtureCleanup();
  });

  // Poll /healthz until it answers (tsx cold start is a couple of seconds).
  let code = 0;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      code = await healthz(port, readFileSync(tls.caCrt));
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`healthz never answered (stderr: ${stderr})`);
      if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode} (stderr: ${stderr})`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert.equal(code, 200);

  // The original defect: the process exited 0 with an empty event loop
  // ~650 ms after start. Assert it is still serving well past that window.
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(child.exitCode, null, `server exited too early (code ${child.exitCode}): ${stderr}`);
  assert.equal(await healthz(port, readFileSync(tls.caCrt)), 200);

  // systemctl stop sends SIGTERM → clean exit 0 (store closed first).
  child.kill('SIGTERM');
  const [signal, exitCode] = await new Promise<[(string | null), (number | null)]>((resolve) => {
    child.once('exit', (code, sig) => resolve([sig, code])); // exit event: (code, signal)
  });
  assert.equal(exitCode, 0, `expected a clean SIGTERM exit 0 (signal=${signal}, stderr: ${stderr})`);
});
