/**
 * Unit tests for usage-hit tracking (PR-2): recordSearchHits, getMemoryUsageSignals,
 * and the hit_count/last_hit_at schema migration coverage.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../../src/store/db.js';
import {
  addMemory,
  recordSearchHits,
  getMemoryUsageSignals,
  searchMemories,
} from '../../src/store/sqlite-memory-store.js';

let tmpDir = '';
let dbManager: DatabaseManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-tracking-test-'));
  dbManager = new DatabaseManager(tmpDir);
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('recordSearchHits', () => {
  it('increments hit_count and sets last_hit_at exactly once per call', () => {
    const a = addMemory(dbManager, 'entry about volcano monitoring', 'memory');
    const b = addMemory(dbManager, 'entry about tide tables', 'memory');

    recordSearchHits(dbManager, [a.id, b.id]);
    recordSearchHits(dbManager, [a.id]);

    const signals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.strictEqual(signals.get('entry about volcano monitoring')?.hits, 2);
    assert.strictEqual(signals.get('entry about tide tables')?.hits, 1);

    const today = new Date().toISOString().split('T')[0];
    assert.strictEqual(signals.get('entry about volcano monitoring')?.lastHit, today);
    assert.strictEqual(signals.get('entry about tide tables')?.lastHit, today);
  });

  it('is a no-op for an empty id list', () => {
    const a = addMemory(dbManager, 'untouched entry', 'memory');
    recordSearchHits(dbManager, []);
    const signals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.strictEqual(signals.size, 0);
    assert.ok(a.id > 0);
  });

  it('keeps per-scope counters independent (target and project)', () => {
    const globalEntry = addMemory(dbManager, 'shared deployment text', 'memory');
    addMemory(dbManager, 'shared deployment text', 'user');
    const projectEntry = addMemory(dbManager, 'shared deployment text', 'memory', 'proj-a');

    recordSearchHits(dbManager, [globalEntry.id, projectEntry.id]);

    const globalSignals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.strictEqual(globalSignals.get('shared deployment text')?.hits, 1);
    assert.ok(!getMemoryUsageSignals(dbManager, { target: 'user', project: null }).has('shared deployment text'));
    const projectSignals = getMemoryUsageSignals(dbManager, { target: 'memory', project: 'proj-a' });
    assert.strictEqual(projectSignals.get('shared deployment text')?.hits, 1);
  });

  it('drops counters when the entry row is deleted (columns die with the row)', () => {
    const a = addMemory(dbManager, 'ephemeral entry', 'memory');
    recordSearchHits(dbManager, [a.id]);
    dbManager.getDb().prepare('DELETE FROM memories WHERE id = ?').run(a.id);
    const signals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.strictEqual(signals.size, 0);
  });
});

describe('getMemoryUsageSignals', () => {
  it('omits entries with zero hits and keeps exact trimmed content keys', () => {
    const recalled = addMemory(dbManager, 'recalled entry text', 'memory');
    addMemory(dbManager, 'never recalled entry text', 'memory');
    recordSearchHits(dbManager, [recalled.id]);

    const signals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.deepStrictEqual([...signals.keys()], ['recalled entry text']);
    assert.strictEqual(signals.get('recalled entry text')?.hits, 1);
    assert.match(signals.get('recalled entry text')?.lastHit ?? '', /^\d{4}-\d{2}-\d{2}$/);
  });

  it('scopes failure lookups by project exactly like the consolidation scope', () => {
    const globalFailure = addMemory(dbManager, 'failure lesson text', 'failure');
    addMemory(dbManager, 'failure lesson text', 'failure', 'proj-b');
    recordSearchHits(dbManager, [globalFailure.id]);

    assert.strictEqual(getMemoryUsageSignals(dbManager, { target: 'failure', project: null }).size, 1);
    assert.strictEqual(getMemoryUsageSignals(dbManager, { target: 'failure', project: 'proj-b' }).size, 0);
  });
});

describe('hit tracking schema', () => {
  it('persists counters across a close/reopen cycle', () => {
    const a = addMemory(dbManager, 'durable entry', 'memory');
    recordSearchHits(dbManager, [a.id]);
    recordSearchHits(dbManager, [a.id]);
    dbManager.close();
    dbManager = new DatabaseManager(tmpDir);

    const signals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.strictEqual(signals.get('durable entry')?.hits, 2);
  });

  it('survives the legacy target-constraint rebuild migration with counters intact', () => {
    // Seed data + hits on the current schema, then force the legacy shape by
    // rebuilding the table through the same migration the manager runs for
    // CHECK (target IN ('memory','user')) tables. The migration must carry the
    // hit columns through its CREATE/INSERT/SELECT lists.
    const a = addMemory(dbManager, 'pre-migration entry', 'memory');
    recordSearchHits(dbManager, [a.id]);
    recordSearchHits(dbManager, [a.id]);
    dbManager.close();

    const raw = new Database(path.join(tmpDir, 'sessions.db'));
    raw.exec(`
      CREATE TABLE memories_legacy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT,
        target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
        category TEXT,
        content TEXT NOT NULL,
        failure_reason TEXT,
        tool_state TEXT,
        corrected_to TEXT,
        created DATE NOT NULL,
        last_referenced DATE NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at DATE
      );
    `);
    raw.exec(`
      INSERT INTO memories_legacy (id, project, target, content, created, last_referenced, hit_count, last_hit_at)
      SELECT id, project, target, content, created, last_referenced, hit_count, last_hit_at FROM memories;
    `);
    raw.exec('DROP TABLE memories');
    raw.exec('ALTER TABLE memories_legacy RENAME TO memories');
    raw.close();

    // Reopening runs ensureLegacySchemaColumns + the legacy CHECK migration;
    // the rebuilt table must keep the hit columns and the recorded counts.
    dbManager = new DatabaseManager(tmpDir);
    const names = (dbManager.getDb().prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(names.includes('hit_count'), 'hit_count must survive the legacy rebuild');
    assert.ok(names.includes('last_hit_at'), 'last_hit_at must survive the legacy rebuild');

    const signals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.strictEqual(signals.get('pre-migration entry')?.hits, 2);
  });

  it('search itself stays unchanged: results and order are not affected by recording', () => {
    const a = addMemory(dbManager, 'searchable volcano content', 'memory');
    const first = searchMemories(dbManager, 'volcano', {});
    assert.strictEqual(first.length, 1);
    recordSearchHits(dbManager, first.map((entry) => entry.id));
    const second = searchMemories(dbManager, 'volcano', {});
    assert.deepStrictEqual(second.map((entry) => entry.id), [a.id]);
  });
});
