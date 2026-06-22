import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import {
  scheduleSessionBackfill,
  waitForSessionBackfill,
  type SessionBackfillState,
} from '../../src/handlers/session-backfill.js';
import { indexAllSessions, touchBackfillTimestamp } from '../../src/store/session-indexer.js';

function writeJsonlSession(sessionsDir: string, projectDir: string, sessionId: string, text = 'Hello from backfill'): void {
  const projDir = path.join(sessionsDir, projectDir);
  fs.mkdirSync(projDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', id: sessionId, timestamp: '2026-05-03T00:00:00Z', cwd: `/work/${projectDir}` }),
    JSON.stringify({
      type: 'message',
      id: `${sessionId}-m1`,
      parentId: null,
      timestamp: '2026-05-03T00:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
    }),
  ];
  fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n'));
}

describe('session backfill handler', () => {
  let tmpDir: string;
  let sessionsDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-backfill-test-'));
    sessionsDir = path.join(tmpDir, 'sessions');
    dbManager = new DatabaseManager(path.join(tmpDir, 'memory'));
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('schedules backfill without indexing synchronously, then indexes unindexed sessions', async () => {
    writeJsonlSession(sessionsDir, 'project-a', 's1');
    const callbacks: (() => void)[] = [];
    const state: SessionBackfillState = { inProgress: false, promise: null };

    const scheduled = scheduleSessionBackfill(dbManager, sessionsDir, {
      state,
      setTimeoutFn: (callback) => {
        callbacks.push(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    assert.equal(callbacks.length, 1);
    assert.equal(dbManager.getStats().sessions, 0, 'session_start should not index synchronously');

    const promise = state.promise;
    assert.ok(promise);
    callbacks[0]();
    await promise;

    assert.equal(dbManager.getStats().sessions, 1);
    assert.equal(dbManager.getStats().messages, 1);
  });

  it('does not schedule backfill when counts match and timestamp is recent', () => {
    writeJsonlSession(sessionsDir, 'project-a', 's1');
    indexAllSessions(dbManager, sessionsDir);
    touchBackfillTimestamp(dbManager);

    const callbacks: (() => void)[] = [];
    const state: SessionBackfillState = { inProgress: false, promise: null };
    const scheduled = scheduleSessionBackfill(dbManager, sessionsDir, {
      state,
      setTimeoutFn: (callback) => {
        callbacks.push(callback);
        return 0;
      },
    });

    assert.equal(scheduled, false);
    assert.equal(callbacks.length, 0);
    assert.equal(state.inProgress, false);
  });

  it('keeps manual indexAllSessions idempotent with auto-backfill', async () => {
    writeJsonlSession(sessionsDir, 'project-a', 's1');
    const state: SessionBackfillState = { inProgress: false, promise: null };

    const scheduled = scheduleSessionBackfill(dbManager, sessionsDir, {
      state,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });
    assert.equal(scheduled, true);
    await state.promise;

    const manualResult = indexAllSessions(dbManager, sessionsDir);
    assert.equal(manualResult.sessionsProcessed, 1);
    assert.equal(manualResult.sessionsSkipped, 1);
    assert.equal(manualResult.sessionsIndexed, 0);
  });

  it('does not mark backfill complete when startup parse limit is reached', async () => {
    const state: SessionBackfillState = { inProgress: false, promise: null };
    let touched = false;
    const notifications: { message: string; level: string }[] = [];

    const scheduled = scheduleSessionBackfill(dbManager, sessionsDir, {
      state,
      needsBackfillFn: () => true,
      indexSessionsFn: () => ({
        sessionsProcessed: 1,
        sessionsIndexed: 1,
        sessionsSkipped: 0,
        messagesIndexed: 1,
        errors: [],
        reachedLimit: true,
      }),
      touchBackfillTimestampFn: () => { touched = true; },
      notify: (message, level) => notifications.push({ message, level }),
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    await state.promise;
    assert.equal(touched, false);
    assert.equal(notifications[0].level, 'warning');
    assert.match(notifications[0].message, /startup limit reached/);
  });

  it('scheduled task is best-effort and does not reject when indexing throws', async () => {
    const state: SessionBackfillState = { inProgress: false, promise: null };
    const notifications: { message: string; level: string }[] = [];

    const scheduled = scheduleSessionBackfill(dbManager, sessionsDir, {
      state,
      needsBackfillFn: () => true,
      indexSessionsFn: () => {
        throw new Error('boom');
      },
      notify: (message, level) => notifications.push({ message, level }),
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    await state.promise;
    assert.equal(state.inProgress, false);
    assert.match(notifications[0].message, /Session backfill failed: boom/);
    assert.equal(notifications[0].level, 'warning');
  });

  it('shutdown wait resolves true when an in-progress backfill completes before timeout', async () => {
    let resolveBackfill!: () => void;
    const state: SessionBackfillState = {
      inProgress: true,
      promise: new Promise<void>((resolve) => {
        resolveBackfill = resolve;
      }),
    };

    setTimeout(resolveBackfill, 5);
    const completed = await waitForSessionBackfill(100, state);

    assert.equal(completed, true);
  });

  it('shutdown wait resolves false when an in-progress backfill exceeds timeout', async () => {
    const state: SessionBackfillState = {
      inProgress: true,
      promise: new Promise<void>(() => {}),
    };

    const completed = await waitForSessionBackfill(5, state);

    assert.equal(completed, false);
  });
});
