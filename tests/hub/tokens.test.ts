import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TokenStore } from '../../src/hub/tokens.js';

let dir: string;
let tokens: TokenStore;
let tokenPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pi-hub-tokens-'));
  tokenPath = path.join(dir, 'tokens.json');
  tokens = new TokenStore(tokenPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TokenStore (AD-5)', () => {
  it('enrolls a machine and verifies its token', () => {
    const { machine, token } = tokens.enroll('lincopta');
    assert.equal(machine, 'lincopta');
    assert.match(token, /^pmh_/);
    assert.equal(tokens.verify(token), 'lincopta');
  });

  it('rejects unknown and empty tokens', () => {
    tokens.enroll('lincopta');
    assert.equal(tokens.verify('pmh_not-a-real-token'), null);
    assert.equal(tokens.verify(''), null);
  });

  it('stores only the hash, never the plaintext token', () => {
    const { token } = tokens.enroll('lincopta');
    const raw = readFileSync(tokenPath, 'utf8');
    assert.ok(!raw.includes(token), 'plaintext token must not be persisted');
    assert.ok(raw.includes('token_sha256'));
  });

  it('revoke removes the machine and its token stops verifying (no restart needed)', () => {
    const { token } = tokens.enroll('no5');
    assert.equal(tokens.verify(token), 'no5');
    assert.equal(tokens.revoke('no5'), true);
    assert.equal(tokens.verify(token), null);
    assert.equal(tokens.revoke('no5'), false);
  });

  it('re-enroll (rotation) issues a new token and invalidates the old one', () => {
    const first = tokens.enroll('peacewagon');
    const second = tokens.enroll('peacewagon');
    assert.notEqual(first.token, second.token);
    assert.equal(tokens.verify(first.token), null, 'old token is dead after rotation');
    assert.equal(tokens.verify(second.token), 'peacewagon');
  });

  it('re-reads the file per call — external edits apply immediately', () => {
    // Simulate a second hub CLI process writing the store (e.g. revoke from
    // the CLI while the server instance is alive): the SAME instance must see
    // it on the next verify without any reload call.
    const { token } = tokens.enroll('cyberkleiber');
    const other = new TokenStore(tokenPath);
    assert.equal(other.revoke('cyberkleiber'), true);
    assert.equal(tokens.verify(token), null);
  });

  it('lists enrolled machines sorted', () => {
    tokens.enroll('b');
    tokens.enroll('a');
    assert.deepEqual(
      tokens.listMachines().map((m) => m.machine),
      ['a', 'b'],
    );
  });

  it('rejects invalid machine names', () => {
    assert.throws(() => tokens.enroll(''));
    assert.throws(() => tokens.enroll('has space'));
    assert.throws(() => tokens.enroll('-leading-dash'));
  });

  it('normalizes machine case (identity is case-insensitive)', () => {
    const { machine } = tokens.enroll('Lincopta');
    assert.equal(machine, 'lincopta');
  });
});

