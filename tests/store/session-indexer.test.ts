import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession, indexAllSessions, getSessionStats } from '../../src/store/session-indexer.js';
import type { ParsedSession } from '../../src/store/session-parser.js';

describe('session-indexer', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-test-'));
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
        { id: `${id}-msg-1`, role: 'user', content: 'Hello', timestamp: '2026-05-03T00:01:00Z' },
        { id: `${id}-msg-2`, role: 'assistant', content: 'Hi there!', timestamp: '2026-05-03T00:01:30Z', toolCalls: ['read'] },
      ],
      ...overrides,
    };
  }

  describe('indexSession', () => {
    it('should index a session and its messages', () => {
      const session = createTestSession();
      const result = indexSession(dbManager, session);

      assert.strictEqual(result.sessionId, 'session-1');
      assert.strictEqual(result.messagesIndexed, 2);
      assert.strictEqual(result.skipped, false);

      // Verify in database
      const db = dbManager.getDb();
      const dbSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-1') as Record<string, unknown>;
      assert.strictEqual(dbSession.project, 'test-project');
      assert.strictEqual(dbSession.message_count, 2);

      const messages = db.prepare('SELECT * FROM messages WHERE session_id = ?').all('session-1') as Record<string, unknown>[];
      assert.strictEqual(messages.length, 2);
      assert.strictEqual(messages[0].role, 'user');
      assert.strictEqual(messages[1].role, 'assistant');
    });

    it('should store tool_calls as JSON', () => {
      const session = createTestSession();
      indexSession(dbManager, session);

      const db = dbManager.getDb();
      const msg = db.prepare('SELECT tool_calls FROM messages WHERE id = ?').get('session-1-msg-2') as { tool_calls: string | null };
      assert.ok(msg.tool_calls);
      assert.deepStrictEqual(JSON.parse(msg.tool_calls), ['read']);
    });

    it('should skip already-indexed sessions', () => {
      const session = createTestSession();

      const result1 = indexSession(dbManager, session);
      assert.strictEqual(result1.skipped, false);

      const result2 = indexSession(dbManager, session);
      assert.strictEqual(result2.skipped, true);
      assert.strictEqual(result2.messagesIndexed, 0);
    });

    it('should handle sessions with no messages', () => {
      const session = createTestSession({ messages: [] });
      const result = indexSession(dbManager, session);

      assert.strictEqual(result.messagesIndexed, 0);
      assert.strictEqual(result.skipped, false);
    });
  });

  describe('indexAllSessions', () => {
    it('should index all JSONL files from disk', () => {
      // Create mock session directory structure
      const sessionsDir = path.join(tmpDir, 'sessions');
      const projDir = path.join(sessionsDir, 'test-project');
      fs.mkdirSync(projDir, { recursive: true });

      // Write a valid JSONL file
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(path.join(projDir, 'session1.jsonl'), lines.join('\n'));

      const result = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.sessionsIndexed, 1);
      assert.strictEqual(result.messagesIndexed, 1);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should skip already-indexed sessions on re-run', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const projDir = path.join(sessionsDir, 'test-project');
      fs.mkdirSync(projDir, { recursive: true });

      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(path.join(projDir, 'session1.jsonl'), lines.join('\n'));

      // First run
      const result1 = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result1.sessionsIndexed, 1);

      // Second run — should skip
      const result2 = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result2.sessionsSkipped, 1);
      assert.strictEqual(result2.sessionsIndexed, 0);
    });

    it('should handle invalid JSONL files gracefully', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const projDir = path.join(sessionsDir, 'test-project');
      fs.mkdirSync(projDir, { recursive: true });

      // Invalid file (no session entry)
      fs.writeFileSync(path.join(projDir, 'invalid.jsonl'), '{"type":"message","id":"m1"}');

      const result = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.errors.length, 1);
    });

    it('should handle empty sessions directory', () => {
      const sessionsDir = path.join(tmpDir, 'empty-sessions');
      fs.mkdirSync(sessionsDir);

      const result = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.sessionsProcessed, 0);
      assert.strictEqual(result.sessionsIndexed, 0);
    });

    it('should handle non-existent sessions directory', () => {
      const result = indexAllSessions(dbManager, '/nonexistent/path');
      assert.strictEqual(result.sessionsProcessed, 0);
    });
  });

  describe('getSessionStats', () => {
    it('should return zero counts for empty database', () => {
      const stats = getSessionStats(dbManager);
      assert.strictEqual(stats.totalSessions, 0);
      assert.strictEqual(stats.totalMessages, 0);
      assert.deepStrictEqual(stats.projects, []);
    });

    it('should return correct stats after indexing', () => {
      const session = createTestSession();
      indexSession(dbManager, session);

      const stats = getSessionStats(dbManager);
      assert.strictEqual(stats.totalSessions, 1);
      assert.strictEqual(stats.totalMessages, 2);
      assert.strictEqual(stats.projects.length, 1);
      assert.strictEqual(stats.projects[0].project, 'test-project');
      assert.strictEqual(stats.projects[0].sessions, 1);
      assert.strictEqual(stats.projects[0].messages, 2);
    });

    it('should group by project', () => {
      indexSession(dbManager, createTestSession({ id: 's1', project: 'project-a' }));
      indexSession(dbManager, createTestSession({ id: 's2', project: 'project-a' }));
      indexSession(dbManager, createTestSession({ id: 's3', project: 'project-b' }));

      const stats = getSessionStats(dbManager);
      assert.strictEqual(stats.totalSessions, 3);
      assert.strictEqual(stats.projects.length, 2);

      const projA = stats.projects.find(p => p.project === 'project-a');
      const projB = stats.projects.find(p => p.project === 'project-b');
      assert.ok(projA);
      assert.ok(projB);
      assert.strictEqual(projA.sessions, 2);
      assert.strictEqual(projB.sessions, 1);
    });
  });
});
