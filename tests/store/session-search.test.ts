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

    it('should handle malformed FTS5 queries gracefully', () => {
      indexSession(dbManager, createTestSession());

      // Malformed FTS5 query should not throw
      const results = searchSessions(dbManager, 'AND OR NOT');
      assert.ok(Array.isArray(results));
    });
  });

  describe('getIndexedMessageCount', () => {
    it('should return 0 for empty database', () => {
      assert.strictEqual(getIndexedMessageCount(dbManager), 0);
    });

    it('should return correct count after indexing', () => {
      indexSession(dbManager, createTestSession());
      assert.strictEqual(getIndexedMessageCount(dbManager), 4);
    });
  });
});
