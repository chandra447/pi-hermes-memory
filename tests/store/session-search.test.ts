import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession } from '../../src/store/session-indexer.js';
import { searchSessions, getIndexedMessageCount } from '../../src/store/session-search.js';
import type { ParsedSession } from '../../src/store/session-parser.js';

describe('session-search', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTestSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
    const id = overrides.id ?? 'session-1';
    return {
      id,
      project: 'test-project',
      cwd: '/test',
      startedAt: '2026-05-03T00:00:00Z',
      endedAt: null,
      messages: [
        { id: `${id}-msg-1`, role: 'user', content: 'How do I set up Prisma with PostgreSQL?', timestamp: '2026-05-03T00:01:00Z' },
        { id: `${id}-msg-2`, role: 'assistant', content: 'To set up Prisma, install the package and run prisma init. Then configure your DATABASE_URL in .env', timestamp: '2026-05-03T00:01:30Z' },
        { id: `${id}-msg-3`, role: 'user', content: 'What about database migrations?', timestamp: '2026-05-03T00:02:00Z' },
        { id: `${id}-msg-4`, role: 'assistant', content: 'Use prisma migrate dev to create migrations. This generates SQL files and applies them.', timestamp: '2026-05-03T00:02:30Z' },
        { id: `${id}-msg-5`, role: 'user', content: 'What about gpu timeout issue debugging?', timestamp: '2026-05-03T00:03:00Z' },
        { id: `${id}-msg-6`, role: 'assistant', content: 'This exact phrase memory search example helps verify phrase queries.', timestamp: '2026-05-03T00:03:30Z' },
      ],
      ...overrides,
    };
  }

  describe('searchSessions', () => {
    it('should find messages matching a search query', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma');
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.content.includes('Prisma')));
    });

    it('should return results with snippets', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'migrations');
      assert.ok(results.length > 0);
      assert.ok(results[0].snippet.length > 0);
    });

    it('should return results with session metadata', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma');
      assert.ok(results.length > 0);
      assert.strictEqual(results[0].sessionId, 'session-1');
      assert.strictEqual(results[0].project, 'test-project');
      assert.ok(results[0].timestamp.length > 0);
    });

    it('should limit results', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma', { limit: 1 });
      assert.strictEqual(results.length, 1);
    });

    it('should filter by role', () => {
      indexSession(dbManager, createTestSession());

      const userResults = searchSessions(dbManager, 'Prisma', { role: 'user' });
      const assistantResults = searchSessions(dbManager, 'Prisma', { role: 'assistant' });

      // User asked about Prisma, assistant answered about Prisma
      assert.ok(userResults.length > 0);
      assert.ok(assistantResults.length > 0);
      assert.ok(userResults.every(r => r.role === 'user'));
      assert.ok(assistantResults.every(r => r.role === 'assistant'));
    });

    it('should filter by project', () => {
      indexSession(dbManager, createTestSession({ id: 's1', project: 'project-a' }));
      indexSession(dbManager, createTestSession({ id: 's2', project: 'project-b', messages: [
        { id: 's2-m1', role: 'user', content: 'Different topic entirely', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'Prisma', { project: 'project-a' });
      assert.ok(results.length > 0);
      assert.ok(results.every(r => r.project === 'project-a'));
    });

    it('should return empty for no matches', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'nonexistent-topic-xyz');
      assert.strictEqual(results.length, 0);
    });

    it('should return empty for empty database', () => {
      const results = searchSessions(dbManager, 'anything');
      assert.strictEqual(results.length, 0);
    });

    it('should match multi-word queries without requiring an exact phrase', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'gpu issue');
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should ignore lowercase connector words in natural-language queries', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'gpu and issue');
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should preserve explicit quoted phrase searches', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, '"memory search"');
      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.content.includes('memory search')));
    });

    it('should preserve valid operator queries', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma OR gpu');
      assert.ok(results.length >= 2);
      assert.ok(results.some((r) => r.content.includes('Prisma')));
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should fall back to broader natural-language FTS matching when strict term matching misses', () => {
      indexSession(dbManager, createTestSession({ id: 'fallback-session', messages: [
        { id: 'fallback-session-msg-1', role: 'assistant', content: "The user's name is Naruto", timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'name identity Naruto');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('Naruto')));
    });

    it('should find mixed Chinese/English queries via fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'mixed-cjk-session', messages: [
        { id: 'mixed-cjk-session-msg-1', role: 'assistant', content: 'codex 已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'codex 执行 任务');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('codex 已经开始执行探索任务了')));
    });

    it('should find Chinese-only substrings via LIKE fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'cjk-only-session', messages: [
        { id: 'cjk-only-session-msg-1', role: 'assistant', content: '已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, '执行');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('已经开始执行探索任务了')));
    });

    it('should preserve filters, ordering, and limit during LIKE fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'cjk-filter-a', project: 'project-a', messages: [
        { id: 'cjk-filter-a-msg-1', role: 'user', content: '早期已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
        { id: 'cjk-filter-a-msg-2', role: 'user', content: '后续继续执行更多任务', timestamp: '2026-05-03T00:03:00Z' },
      ] }));
      indexSession(dbManager, createTestSession({ id: 'cjk-filter-b', project: 'project-b', messages: [
        { id: 'cjk-filter-b-msg-1', role: 'assistant', content: '另一个项目也执行任务', timestamp: '2026-05-03T00:04:00Z' },
      ] }));

      const results = searchSessions(dbManager, '执行', {
        project: 'project-a',
        role: 'user',
        since: '2026-05-03T00:02:00Z',
        limit: 1,
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].project, 'project-a');
      assert.strictEqual(results[0].role, 'user');
      assert.strictEqual(results[0].timestamp, '2026-05-03T00:03:00Z');
      assert.ok(results[0].content.includes('后续继续执行更多任务'));
    });

    it('should escape LIKE wildcard characters during fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'like-escape-session', messages: [
        { id: 'like-escape-session-msg-1', role: 'user', content: 'Progress reached 100% today', timestamp: '2026-05-03T00:01:00Z' },
        { id: 'like-escape-session-msg-2', role: 'user', content: 'A plain message without the wildcard character', timestamp: '2026-05-03T00:02:00Z' },
      ] }));

      const results = searchSessions(dbManager, '%');

      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.content.includes('%')));
    });

    it('should not broaden explicit operator queries', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma AND nonexistent');

      assert.strictEqual(results.length, 0);
    });

    it('should handle malformed FTS5 queries gracefully', () => {
      indexSession(dbManager, createTestSession());

      // Malformed FTS5 query should not throw
      const results = searchSessions(dbManager, 'AND OR NOT');
      assert.ok(Array.isArray(results));
    });

    it('should handle unmatched quotes gracefully', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'issue "timeout');
      assert.ok(Array.isArray(results));
    });

    it('should return empty for blank queries', () => {
      assert.deepStrictEqual(searchSessions(dbManager, '   '), []);
    });
  });

  describe('getIndexedMessageCount', () => {
    it('should return 0 for empty database', () => {
      assert.strictEqual(getIndexedMessageCount(dbManager), 0);
    });

    it('should return correct count after indexing', () => {
      indexSession(dbManager, createTestSession());
      assert.strictEqual(getIndexedMessageCount(dbManager), 6);
    });
  });
});
