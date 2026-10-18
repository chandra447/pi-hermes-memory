/**
 * Regression tests for the bin shim (bin/pi-memory-hub.mjs). The shim
 * re-execs itself under the repo's local tsx; the PI_MEMORY_HUB_TSX_CHILD
 * guard makes the re-exec idempotent. Without a test here, deleting the
 * guard re-execs forever (a fork bomb) and no suite catches it.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(path.dirname(fileURLToPath(new URL(import.meta.url))), '..', '..');

test('bin shim: re-execs under tsx and forwards argv + exit code', (t) => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'pi-hub-bin-'));
  t.after(() => rmSync(dbDir, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'bin', 'pi-memory-hub.mjs'), 'list'],
    {
      cwd: repoRoot,
      env: { ...process.env, PI_MEMORY_HUB_DIR: dbDir },
      encoding: 'utf8',
      timeout: 60_000, // tsx cold start
    },
  );
  assert.equal(res.status, 0, `shim exited ${res.status}: ${res.stderr}`);
  assert.match(res.stdout, /no machines enrolled/);
});

test('bin shim: unknown subcommand forwards the exit code (2)', (t) => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'pi-hub-bin-'));
  t.after(() => rmSync(dbDir, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'bin', 'pi-memory-hub.mjs'), 'frobnicate'],
    {
      cwd: repoRoot,
      env: { ...process.env, PI_MEMORY_HUB_DIR: dbDir },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.equal(res.status, 2, `expected the CLI's exit 2 to be forwarded, got ${res.status}: ${res.stderr}`);
});

test('bin shim: missing tsx fails loudly with a named error (no re-exec loop)', (t) => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'pi-hub-bin-sandbox-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  mkdirSync(path.join(sandbox, 'bin'));
  copyFileSync(path.join(repoRoot, 'bin', 'pi-memory-hub.mjs'), path.join(sandbox, 'bin', 'pi-memory-hub.mjs'));
  const res = spawnSync(process.execPath, [path.join(sandbox, 'bin', 'pi-memory-hub.mjs'), 'list'], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.notEqual(res.status, 0, 'shim must fail when tsx is missing');
  assert.match(`${res.stderr}${res.stdout}`, /tsx not found/);
});
