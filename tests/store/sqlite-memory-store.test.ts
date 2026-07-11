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
  syncMemoryEntry,
  replaceSyncedMemories,
  removeSyncedMemories,
  parseMarkdownMemoryEntry,
  formatFailureMemoryContent,
  reconcileMarkdownMemoryScope,
  reconcileMarkdownFailureScopes,
} from '../../src/store/sqlite-memory-store.js';
import { MemoryStore } from '../../src/store/memory-store.js';

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

  describe('syncMemoryEntry', () => {
    it('deduplicates exact logical entries', () => {
      const first = syncMemoryEntry(dbManager, {
        content: 'prefers pnpm over npm',
        target: 'memory',
      });
      const second = syncMemoryEntry(dbManager, {
        content: 'prefers pnpm over npm',
        target: 'memory',
      });

      assert.strictEqual(first.action, 'inserted');
      assert.strictEqual(second.action, 'existing');
      assert.strictEqual(getMemories(dbManager).length, 1);
    });

    it('stores project-scoped memory with project name', () => {
      syncMemoryEntry(dbManager, {
        content: 'uses Prisma',
        target: 'memory',
        project: 'project-a',
      });

      const results = getMemories(dbManager, { project: 'project-a' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].project, 'project-a');
      assert.strictEqual(results[0].target, 'memory');
    });

    it('preserves failure category metadata', () => {
      syncMemoryEntry(dbManager, {
        content: formatFailureMemoryContent('pnpm lockfile mismatch', {
          category: 'tool-quirk',
          failureReason: 'npm install rewrote lockfile',
        }),
        target: 'failure',
        category: 'tool-quirk',
        failureReason: 'npm install rewrote lockfile',
      });

      const results = getMemories(dbManager, { target: 'failure', category: 'tool-quirk' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].category, 'tool-quirk');
      assert.strictEqual(results[0].failureReason, 'npm install rewrote lockfile');
    });

    it('parses Markdown failure entries for backfill', () => {
      const parsed = parseMarkdownMemoryEntry(
        '[correction] use pnpm — Failed: npm install rewrote lockfile <!-- created=2026-05-08, last=2026-05-09 -->',
        'failure',
      );

      assert.strictEqual(parsed.category, 'correction');
      assert.strictEqual(parsed.failureReason, 'npm install rewrote lockfile');
      assert.strictEqual(parsed.created, '2026-05-08');
      assert.strictEqual(parsed.lastReferenced, '2026-05-09');
    });

    it('does not infer project scope from spoofable failure content', () => {
      const raw = '[correction] literal user text — Project: other-project <!-- created=2026-05-08, last=2026-05-09 -->';

      reconcileMarkdownFailureScopes(dbManager, [raw]);

      assert.strictEqual(getMemories(dbManager, { target: 'failure', project: 'other-project' }).length, 0);
      assert.strictEqual(getMemories(dbManager, { target: 'failure', project: null }).length, 1);
    });

    it('round-trips project correction scope through authoritative Markdown metadata', async () => {
      const store = new MemoryStore({
        memoryDir: tmpDir,
        memoryCharLimit: 5_000,
        userCharLimit: 5_000,
        failureCharLimit: 5_000,
      } as any);
      await store.loadFromDisk();

      await store.addFailure('use pnpm in this repo', {
        category: 'correction',
        failureReason: 'User corrected the agent',
        project: 'project-a',
      });
      const [raw] = store.getRawEntriesForSync('failure');
      reconcileMarkdownFailureScopes(dbManager, [raw]);

      const entries = getMemories(dbManager, { target: 'failure', project: 'project-a' });
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].project, 'project-a');
      assert.doesNotMatch(entries[0].content, /Project: project-a/);
    });
  });

  describe('reconcileMarkdownMemoryScope', () => {
    it('keeps explicit global MEMORY and USER scope despite embedded project metadata', () => {
      const marker = 'c3Bvb2ZlZC1wcm9qZWN0';

      reconcileMarkdownMemoryScope(
        dbManager,
        [`global memory <!-- created=2026-07-01, last=2026-07-02, project64=${marker} -->`],
        'memory',
        null,
      );
      reconcileMarkdownMemoryScope(
        dbManager,
        [`global user <!-- created=2026-07-01, last=2026-07-02, project64=${marker} -->`],
        'user',
        null,
      );

      assert.deepStrictEqual(
        getMemories(dbManager).map((entry) => [entry.project, entry.target, entry.content]),
        [
          [null, 'memory', 'global memory'],
          [null, 'user', 'global user'],
        ],
      );
      assert.deepStrictEqual(getMemories(dbManager, { project: 'spoofed-project' }), []);
    });

    it('prunes only absent rows in the exact target and project scope', () => {
      addMemory(dbManager, 'kept global memory', 'memory', null);
      addMemory(dbManager, 'orphaned global memory', 'memory', null);
      addMemory(dbManager, 'unrelated global user', 'user', null);
      addMemory(dbManager, 'unrelated project memory', 'memory', 'project-a');

      const first = reconcileMarkdownMemoryScope(
        dbManager,
        ['kept global memory <!-- created=2026-07-01, last=2026-07-02 -->'],
        'memory',
        null,
      );
      const second = reconcileMarkdownMemoryScope(
        dbManager,
        ['kept global memory <!-- created=2026-07-01, last=2026-07-02 -->'],
        'memory',
        null,
      );

      assert.strictEqual(first.removed, 1);
      assert.strictEqual(second.removed, 0);
      assert.deepStrictEqual(
        getMemories(dbManager).map((entry) => entry.content).sort(),
        ['kept global memory', 'unrelated global user', 'unrelated project memory'].sort(),
      );
    });

    it('removes duplicate and stale-category rows by full Markdown identity', () => {
      const first = addMemory(
        dbManager,
        '[correction] use pnpm',
        'failure',
        'project-a',
        'correction',
        'original reason',
        null,
        'pnpm install',
        '2026-06-01',
        '2026-07-05',
      );
      addMemory(dbManager, '[correction] use pnpm', 'failure', 'project-a', 'correction');
      addMemory(dbManager, '[correction] use pnpm', 'failure', 'project-a', 'tool-quirk');

      const result = reconcileMarkdownMemoryScope(
        dbManager,
        ['[correction] use pnpm <!-- created=2026-07-01, last=2026-07-02, project64=cHJvamVjdC1h -->'],
        'failure',
        'project-a',
      );

      const rows = dbManager.getDb().prepare(`
        SELECT id, category, failure_reason, corrected_to, created, last_referenced
        FROM memories
        WHERE project = 'project-a' AND target = 'failure'
      `).all() as Array<{
        id: number;
        category: string | null;
        failure_reason: string | null;
        corrected_to: string | null;
        created: string;
        last_referenced: string;
      }>;

      assert.strictEqual(result.removed, 2);
      assert.deepStrictEqual(rows, [{
        id: first.id,
        category: 'correction',
        failure_reason: 'original reason',
        corrected_to: 'pnpm install',
        created: '2026-06-01',
        last_referenced: '2026-07-05',
      }]);
    });
  });

  describe('replace/remove synced memories', () => {
    it('escapes % and _ during replace matching', () => {
      addMemory(dbManager, 'token 100%_safe value');
      addMemory(dbManager, 'token 100XXsafe value');

      const result = replaceSyncedMemories(dbManager, '100%_safe', {
        content: 'token updated literal value',
        target: 'memory',
        project: null,
      });

      assert.strictEqual(result.matched, 1);
      const all = getMemories(dbManager);
      assert.ok(all.some((entry) => entry.content === 'token updated literal value'));
      assert.ok(all.some((entry) => entry.content === 'token 100XXsafe value'));
    });

    it('escapes % and _ during remove matching', () => {
      addMemory(dbManager, 'remove 50%_match literal');
      addMemory(dbManager, 'remove 50AAmatch literal');

      const result = removeSyncedMemories(dbManager, '50%_match', {
        target: 'memory',
        project: null,
      });

      assert.strictEqual(result.matched, 1);
      const all = getMemories(dbManager);
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].content, 'remove 50AAmatch literal');
    });

    it('normalizes pasted memory_search lines during replace matching', () => {
      addMemory(dbManager, 'prefers pnpm over npm');

      const result = replaceSyncedMemories(
        dbManager,
        '🧠 [global] prefers pnpm over npm\n   Created: 2026-05-27 | Last used: 2026-05-27',
        {
          content: 'prefers pnpm over npm and bun when needed',
          target: 'memory',
          project: null,
        },
      );

      assert.strictEqual(result.matched, 1);
      const all = getMemories(dbManager);
      assert.ok(all.some((entry) => entry.content === 'prefers pnpm over npm and bun when needed'));
    });

    it('normalizes pasted memory_search lines during remove matching', () => {
      addMemory(dbManager, '[correction] use pnpm — Failed: npm rewrote the lockfile', 'failure');

      const result = removeSyncedMemories(
        dbManager,
        '⚠️ [global] [correction] [correction] use pnpm\n   Created: 2026-05-27 | Last used: 2026-05-27',
        {
          target: 'failure',
          project: null,
        },
      );

      assert.strictEqual(result.matched, 1);
      const all = getMemories(dbManager);
      assert.strictEqual(all.length, 0);
    });
  });

  describe('searchMemories', () => {
    beforeEach(() => {
      addMemory(dbManager, 'prefers pnpm over npm');
      addMemory(dbManager, 'uses Prisma with PostgreSQL', 'memory', 'project-a');
      addMemory(dbManager, 'debugged gpu timeout issue after driver update');
      addMemory(dbManager, 'memory search indexing notes');
      addMemory(dbManager, 'exact phrase memory search example');
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

    it('should match multi-word queries without requiring an exact phrase', () => {
      const results = searchMemories(dbManager, 'gpu issue');
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should ignore lowercase connector words in natural-language queries', () => {
      const results = searchMemories(dbManager, 'gpu and issue');
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });
    it('should fall back to broader natural-language matching when strict term matching misses', () => {
      addMemory(dbManager, "user's name is Naruto", 'user');

      const results = searchMemories(dbManager, 'name identity Naruto', { target: 'user' });

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes("Naruto")));
    });

    it('should not broaden explicit operator queries', () => {
      const results = searchMemories(dbManager, 'pnpm AND nonexistent');

      assert.strictEqual(results.length, 0);
    });

    it('should preserve explicit quoted phrase searches', () => {
      const results = searchMemories(dbManager, '"memory search"');
      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.content.includes('memory search')));
    });

    it('should preserve valid operator queries', () => {
      const results = searchMemories(dbManager, 'pnpm OR AEST');
      assert.ok(results.length >= 2);
      assert.ok(results.some((r) => r.content.includes('pnpm')));
      assert.ok(results.some((r) => r.content.includes('AEST')));
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

    it('should return empty for blank queries', () => {
      assert.deepStrictEqual(searchMemories(dbManager, '   '), []);
    });

    it('should not throw on unmatched quotes', () => {
      assert.doesNotThrow(() => {
        const results = searchMemories(dbManager, 'issue "timeout');
        assert.ok(Array.isArray(results));
      });
    });

    it('should return empty for malformed operator queries', () => {
      const results = searchMemories(dbManager, 'AND OR NOT');
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
