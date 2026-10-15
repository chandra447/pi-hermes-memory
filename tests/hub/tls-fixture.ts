/**
 * Test-time TLS fixture for the hub tests — a local CA + a CA-signed
 * localhost server cert, generated with openssl (the same commands the
 * deployment run script uses). Generated at test time (not committed) so no
 * private keys ever enter the repo — this repo runs secret scanning.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TlsFixture {
  dir: string;
  caCrt: string;
  hubCrt: string;
  hubKey: string;
}

let fixture: TlsFixture | null = null;

/** Generate (once per process) and return the test TLS material. */
export function tlsFixture(): TlsFixture {
  if (fixture) return fixture;
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-hub-tls-'));
  const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });

  run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'ca.key'),
    '-out', path.join(dir, 'ca.crt'), '-days', '3650', '-nodes',
    '-subj', '/CN=pi-hermes-memory-test-CA']);
  run(['req', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'hub.key'),
    '-out', path.join(dir, 'hub.csr'), '-nodes', '-subj', '/CN=localhost']);
  const sanCnf = path.join(dir, 'san.cnf');
  writeFileSync(sanCnf, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run(['x509', '-req', '-in', path.join(dir, 'hub.csr'), '-CA', path.join(dir, 'ca.crt'),
    '-CAkey', path.join(dir, 'ca.key'), '-CAcreateserial', '-out', path.join(dir, 'hub.crt'),
    '-days', '3650', '-extfile', sanCnf]);

  fixture = {
    dir,
    caCrt: path.join(dir, 'ca.crt'),
    hubCrt: path.join(dir, 'hub.crt'),
    hubKey: path.join(dir, 'hub.key'),
  };
  return fixture;
}

/** Drop the fixture (call from a top-level after() if you want cleanup). */
export function tlsFixtureCleanup(): void {
  if (fixture) {
    rmSync(fixture.dir, { recursive: true, force: true });
    fixture = null;
  }
}
