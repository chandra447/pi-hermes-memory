import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AtomicLockCoordinator } from '../../src/store/atomic-lock-coordinator.js';

describe('AtomicLockCoordinator', () => {
  it('cannot release a successor with a stale ownership token', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    const dbPath = path.join(tmpDir, 'locks.sqlite');
    const moduleUrl = new URL('../../src/store/atomic-lock-coordinator.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { AtomicLockCoordinator } from ${JSON.stringify(moduleUrl)};
       const coordinator = new AtomicLockCoordinator(process.argv[1]);
       const lease = coordinator.tryAcquire('shared-target', { staleMs: 60_000 });
       if (!lease) process.exit(2);
       process.stdout.write(lease.token);`,
      dbPath,
    ], { encoding: 'utf-8' });

    try {
      assert.strictEqual(child.status, 0, child.stderr);
      const coordinator = new AtomicLockCoordinator(dbPath);
      const successor = coordinator.tryAcquire('shared-target', { staleMs: 60_000 });
      assert.ok(successor, 'dead owner should be replaced atomically');

      coordinator.release('shared-target', child.stdout);

      assert.strictEqual(
        coordinator.tryAcquire('shared-target', { staleMs: 0 }),
        null,
        'stale release must not delete the successor',
      );
      successor.release();
      assert.ok(coordinator.tryAcquire('shared-target', { staleMs: 0 }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps live owners and distinct keys independent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    try {
      const coordinator = new AtomicLockCoordinator(path.join(tmpDir, 'locks.sqlite'));
      const first = coordinator.tryAcquire('first', { staleMs: 0 });
      assert.ok(first);
      assert.strictEqual(coordinator.tryAcquire('first', { staleMs: 0 }), null);
      assert.ok(coordinator.tryAcquire('second', { staleMs: 0 }));
      first.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('takes over a reused PID without taking over the original incarnation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    try {
      const dbPath = path.join(tmpDir, 'locks.sqlite');
      let observedIncarnation = 'owner-start';
      const owner = new AtomicLockCoordinator(dbPath, {
        pid: 4242,
        incarnation: 'owner-start',
        probeIncarnation: () => observedIncarnation,
      });
      assert.ok(owner.tryAcquire('shared', { staleMs: 0 }));

      const contender = new AtomicLockCoordinator(dbPath, {
        pid: 4242,
        incarnation: 'successor-start',
        probeIncarnation: () => observedIncarnation,
      });
      assert.strictEqual(contender.tryAcquire('shared', { staleMs: 0 }), null);

      observedIncarnation = 'successor-start';
      assert.ok(contender.tryAcquire('shared', { staleMs: 0 }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps a live owner when either incarnation probe is unavailable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    try {
      const dbPath = path.join(tmpDir, 'locks.sqlite');
      const owner = new AtomicLockCoordinator(dbPath, {
        pid: process.pid,
        probeIncarnation: () => null,
      });
      const lease = owner.tryAcquire('shared', { staleMs: 0 });
      assert.ok(lease);

      const contender = new AtomicLockCoordinator(dbPath, {
        pid: process.pid,
        incarnation: 'known-later',
        probeIncarnation: () => 'known-later',
      });
      assert.strictEqual(contender.tryAcquire('shared', { staleMs: 0 }), null);

      lease.release();
      assert.ok(contender.tryAcquire('shared', { staleMs: 0 }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retries a failed owner release before the next same-process acquisition', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalDeleteOwnedLock = prototype.deleteOwnedLock;
    let deleteAttempts = 0;
    prototype.deleteOwnedLock = function (key: string, token: string): void {
      deleteAttempts++;
      if (deleteAttempts <= 3) throw new Error('injected release failure');
      return originalDeleteOwnedLock.call(this, key, token);
    };

    try {
      const coordinator = new AtomicLockCoordinator(path.join(tmpDir, 'locks.sqlite'));
      const first = coordinator.tryAcquire('shared', { staleMs: 60_000 });
      assert.ok(first);
      assert.doesNotThrow(() => first.release());

      const second = coordinator.tryAcquire('shared', { staleMs: 60_000 });
      assert.ok(second);
      assert.equal(deleteAttempts, 4);
      second.release();
    } finally {
      prototype.deleteOwnedLock = originalDeleteOwnedLock;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
