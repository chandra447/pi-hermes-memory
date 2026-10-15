import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configFromEnv, startHubServer } from '../../src/hub/server.js';
import { tlsFixture, tlsFixtureCleanup } from './tls-fixture.js';

function get(pathname: string, baseUrl: string, ca: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.get(`${baseUrl}${pathname}`, { ca }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
  });
}

describe('hub server (AD-3/AD-14)', () => {
  it('serves TLS with the local-CA-signed cert and answers healthz', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-hub-server-'));
    const tls = tlsFixture();
    const hub = await startHubServer({
      host: '127.0.0.1',
      port: 0,
      certPath: tls.hubCrt,
      keyPath: tls.hubKey,
      dbPath: path.join(dir, 'shared.sqlite'),
      tokenStorePath: path.join(dir, 'tokens.json'),
    });
    try {
      const addr = hub.server.address();
      assert.equal(typeof addr, 'object');
      const a = addr as { port: number };
      const status = await get('/healthz', `https://127.0.0.1:${a.port}`, readFileSync(tls.caCrt));
      assert.equal(status, 200);
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
      tlsFixtureCleanup();
    }
  });

  it('configFromEnv: defaults match AD-14 (port 8083, user-owned hub dir)', () => {
    const cfg = configFromEnv({ HOME: '/home/jan' });
    assert.equal(cfg.port, 8083);
    assert.equal(cfg.host, '0.0.0.0');
    assert.ok(cfg.dbPath.endsWith(path.join('.local', 'share', 'pi-hermes-memory', 'hub', 'shared.sqlite')));
    assert.ok(cfg.certPath.includes(path.join('hub', 'tls', 'hub.crt')));
  });

  it('configFromEnv: env overrides win', () => {
    const cfg = configFromEnv({ PI_MEMORY_HUB_PORT: '9999', PI_MEMORY_HUB_HOST: '127.0.0.1' });
    assert.equal(cfg.port, 9999);
    assert.equal(cfg.host, '127.0.0.1');
  });
});
