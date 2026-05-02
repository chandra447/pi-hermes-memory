import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import {
  addMemory,
  searchMemories,
  getMemories,
  removeMemory,
  touchMemory,
  getMemoryStats,
} from '../../src/store/sqlite-memory-store.js';

describe('sqlite-memory-store', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('addMemory', () => {
    it('should add a memory entry', () => {
      const entry = addMemory(dbManager, 'prefers pnpm over npm');
      assert.ok(entry.id > 0);
      assert.strictEqual(entry.target, 'memory');
      assert.strictEqual(entry.content, 'prefers pnpm over npm');
      assert.ok(entry.created.length > 0);
      assert.ok(entry.lastReferenced.length > 0);
    });

    it('should add a user entry', () => {
      const entry = addMemory(dbManager, 'name: Chandrateja', 'user');
      assert.strictEqual(entry.target, 'user');
    });

    it('should add a project-specific entry', () => {
      const entry = addMemory(dbManager, 'uses Prisma', 'memory', 'my-project');
      assert.strictEqual(entry.project, 'my-project');
    });

    it('should add a global entry (null project)', () => {
      const entry = addMemory(dbManager, 'timezone: AEST');
      assert.strictEqual(entry.project, null);
    });
  });

  describe('searchMemories', () => {
    beforeEach(() => {
      addMemory(dbManager, 'prefers pnpm over npm');
      addMemory(dbManager, 'uses Prisma with PostgreSQL', 'memory', 'project-a');
      addMemory(dbManager, 'name: Chandrateja', 'user');
      addMemory(dbManager, 'timezone: AEST', 'user');
    });

    it('should find memories by keyword', () => {
      const results = searchMemories(dbManager, 'pnpm');
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.content.includes('pnpm')));
    });

    it('should find memories by partial content', () => {
      const results = searchMemories(dbManager, 'Prisma');
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.content.includes('Prisma')));
    });

    it('should limit results', () => {
      const results = searchMemories(dbManager, 'pnpm OR Prisma OR AEST', { limit: 2 });
      assert.ok(results.length <= 2);
    });

    it('should filter by project', () => {
      const results = searchMemories(dbManager, 'Prisma', { project: 'project-a' });
      assert.ok(results.length > 0);
      assert.ok(results.every(r => r.project === 'project-a'));
    });

    it('should filter by target', () => {
      const results = searchMemories(dbManager, 'Chandrateja OR AEST', { target: 'user' });
      assert.ok(results.length > 0);
      assert.ok(results.every(r => r.target === 'user'));
    });

    it('should return empty for no matches', () => {
      const results = searchMemories(dbManager, 'nonexistent-xyz');
      assert.strictEqual(results.length, 0);
    });
  });

  describe('getMemories', () => {
    beforeEach(() => {
      addMemory(dbManager, 'global memory 1');
      addMemory(dbManager, 'global memory 2');
      addMemory(dbManager, 'project memory', 'memory', 'project-a');
      addMemory(dbManager, 'user preference', 'user');
    });

    it('should return all memories', () => {
      const results = getMemories(dbManager);
      assert.strictEqual(results.length, 4);
    });

    it('should filter by project', () => {
      const results = getMemories(dbManager, { project: 'project-a' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].content, 'project memory');
    });

    it('should filter by null project (global)', () => {
      const results = getMemories(dbManager, { project: null });
      assert.strictEqual(results.length, 3);
    });

    it('should filter by target', () => {
      const results = getMemories(dbManager, { target: 'user' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].content, 'user preference');
    });
  });

  describe('removeMemory', () => {
    it('should remove a memory by id', () => {
      const entry = addMemory(dbManager, 'to be removed');
      const removed = removeMemory(dbManager, entry.id);
      assert.strictEqual(removed, true);

      const all = getMemories(dbManager);
      assert.strictEqual(all.length, 0);
    });

    it('should return false for non-existent id', () => {
      const removed = removeMemory(dbManager, 99999);
      assert.strictEqual(removed, false);
    });
  });

  describe('touchMemory', () => {
    it('should update last_referenced date', () => {
      const entry = addMemory(dbManager, 'old memory');
      // Manually set an old date
      const db = dbManager.getDb();
      db.prepare('UPDATE memories SET last_referenced = ? WHERE id = ?').run('2020-01-01', entry.id);

      touchMemory(dbManager, entry.id);

      const updated = db.prepare('SELECT last_referenced FROM memories WHERE id = ?').get(entry.id) as { last_referenced: string };
      const today = new Date().toISOString().split('T')[0];
      assert.strictEqual(updated.last_referenced, today);
    });
  });

  describe('getMemoryStats', () => {
    it('should return zero stats for empty database', () => {
      const stats = getMemoryStats(dbManager);
      assert.strictEqual(stats.total, 0);
      assert.deepStrictEqual(stats.byProject, []);
      assert.deepStrictEqual(stats.byTarget, []);
    });

    it('should return correct stats', () => {
      addMemory(dbManager, 'global 1');
      addMemory(dbManager, 'global 2');
      addMemory(dbManager, 'project memory', 'memory', 'project-a');
      addMemory(dbManager, 'user pref', 'user');

      const stats = getMemoryStats(dbManager);
      assert.strictEqual(stats.total, 4);
      assert.strictEqual(stats.byTarget.length, 2);
      assert.ok(stats.byProject.length > 0);
    });
  });
});
