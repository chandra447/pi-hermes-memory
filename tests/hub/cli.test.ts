import { after, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHubCli, type CliIo } from '../../src/hub/cli.js';
import { tlsFixture, tlsFixtureCleanup } from './tls-fixture.js';

interface Captured {
  out: string[];
  err: string[];
  io: CliIo;
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { out, err, io };
}

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pi-hub-cli-'));
  savedEnv = { ...process.env };
  process.env.PI_MEMORY_HUB_TOKENS = path.join(dir, 'tokens.json');
  process.env.PI_MEMORY_HUB_DB = path.join(dir, 'shared.sqlite');
  process.env.PI_MEMORY_HUB_CA = tlsFixture().caCrt;
});

afterEach(() => {
  process.env = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

after(() => {
  tlsFixtureCleanup();
});

describe('pi-memory-hub CLI (AD-5 enrollment UX)', () => {
  it('no command → usage + exit 2', async () => {
    const c = capture();
    const code = await runHubCli([], c.io);
    assert.equal(code, 2);
    assert.match(c.out.join(' '), /usage: pi-memory-hub/);
  });

  it('unknown command → exit 2', async () => {
    const c = capture();
    const code = await runHubCli(['frobnicate'], c.io);
    assert.equal(code, 2);
  });

  it('enroll prints the client file with token, machine, hub_url and CA pin', async () => {
    const c = capture();
    const code = await runHubCli(['enroll', 'lincopta'], c.io);
    assert.equal(code, 0);
    const json = c.out.find((l) => l.trimStart().startsWith('{'));
    assert.ok(json, 'a JSON client file must be printed');
    const file = JSON.parse(json!) as {
      hub_url: string;
      ca_cert_pem: string;
      token: string;
      machine: string;
    };
    assert.equal(file.machine, 'lincopta');
    assert.match(file.token, /^pmh_/);
    assert.match(file.hub_url, /^https:\/\/[\d.]+:\d+$/);
    assert.ok(file.ca_cert_pem.includes('BEGIN CERTIFICATE'), 'CA pin (public cert) is embedded');
    // The token is NOT persisted in plaintext (hash only).
    const raw = readFileSync(process.env.PI_MEMORY_HUB_TOKENS!, 'utf8');
    assert.ok(!raw.includes(file.token));
    // Hint for the human operator goes to stderr, keeping stdout pipeable.
    assert.match(c.err.join(' '), /hub-client\.json/);
  });

  it('revoke removes the machine (exit 0) / missing machine (exit 1)', async () => {
    await runHubCli(['enroll', 'no5'], capture().io);
    const ok = capture();
    assert.equal(await runHubCli(['revoke', 'no5'], ok.io), 0);
    assert.match(ok.out.join(' '), /revoked no5/);
    const missing = capture();
    assert.equal(await runHubCli(['revoke', 'no5'], missing.io), 1);
  });

  it('list shows enrolled machines', async () => {
    await runHubCli(['enroll', 'peacewagon'], capture().io);
    const c = capture();
    assert.equal(await runHubCli(['list'], c.io), 0);
    assert.match(c.out.join('\n'), /peacewagon/);
  });

  it('enroll: invalid machine name → clean named error + exit 1 (no stack trace)', async () => {
    const c = capture();
    const code = await runHubCli(['enroll', 'bad machine!'], c.io);
    assert.equal(code, 1);
    assert.match(c.err.join(' '), /invalid machine name/);
    assert.ok(!/\n\s+at /.test(c.err.join('\n')), 'no stack frames may reach the human');
    assert.ok(!c.out.some((l) => l.trimStart().startsWith('{')), 'no client file on failure');
  });

  it('enroll: missing CA → exit 1 + named error, no client file printed (review: silent trust-anchor gap)', async () => {
    process.env.PI_MEMORY_HUB_CA = path.join(dir, 'no-such-ca.crt');
    const c = capture();
    assert.equal(await runHubCli(['enroll', 'lincopta'], c.io), 1);
    assert.match(c.err.join(' '), /CA cert not found/);
    assert.ok(!c.out.some((l) => l.trimStart().startsWith('{')), 'a client file without its CA pin is not a working trust anchor');
  });

  it('enroll: PI_MEMORY_HUB_DIR steers the CA pin (no silent default-dir pinning)', async () => {
    const customDir = path.join(dir, 'custom-hub');
    mkdirSync(path.join(customDir, 'tls'), { recursive: true });
    writeFileSync(path.join(customDir, 'tls', 'ca.crt'), 'FAKE-CUSTOM-CA-PEM\n');
    process.env.PI_MEMORY_HUB_DIR = customDir;
    delete process.env.PI_MEMORY_HUB_CA; // the default-dir CA must NOT win
    const c = capture();
    assert.equal(await runHubCli(['enroll', 'no5'], c.io), 0);
    const json = c.out.find((l) => l.trimStart().startsWith('{'));
    assert.ok(json);
    assert.equal((JSON.parse(json!) as { ca_cert_pem: string }).ca_cert_pem, 'FAKE-CUSTOM-CA-PEM\n');
  });

  it('export: fresh hub dir without a db file → empty export, exit 0 (no crash)', async () => {
    process.env.PI_MEMORY_HUB_DB = path.join(dir, 'does-not-exist-yet', 'shared.sqlite');
    const c = capture();
    assert.equal(await runHubCli(['export'], c.io), 0, c.err.join(' '));
  });

  it('serve: missing cert file → clean named error + exit 1 (no raw crash)', async () => {
    process.env.PI_MEMORY_HUB_CERT = path.join(dir, 'no-such-cert.crt');
    const c = capture();
    const code = await runHubCli(['serve'], c.io);
    assert.equal(code, 1, c.err.join(' '));
    assert.ok(!/\n\s+at /.test(c.err.join('\n')), 'no stack frames may reach the human');
  });

  it('export writes JSONL to --out', async () => {
    // Seed one entry directly through the store (CLI export reads the DB).
    const { HubStore } = await import('../../src/hub/hub-store.js');
    const store = new HubStore(process.env.PI_MEMORY_HUB_DB!);
    store.upsert({
      id: '01999999-0000-7000-8000-000000000042',
      content: 'cli export target',
      scope: 'memory',
      machine: 'lincopta',
      session: 's',
      identity: 'lincopta',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    });
    store.close();

    const outFile = path.join(dir, 'dump.jsonl');
    const c = capture();
    assert.equal(await runHubCli(['export', '--out', outFile], c.io), 0);
    assert.ok(existsSync(outFile));
    const lines = readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]) as { content: string }).content, 'cli export target');
  });
});
