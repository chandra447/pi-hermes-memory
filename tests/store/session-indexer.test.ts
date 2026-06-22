import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import {
  indexSession,
  indexAllSessions,
  indexChangedSessions,
  getSessionStats,
  countSessionFiles,
  needsBackfill,
  touchBackfillTimestamp,
  LAST_SESSION_BACKFILL_KEY,
  indexCurrentSession,
  indexLiveSession,
  parseSessionManagerSnapshot,
  upsertSessionFileMetadata,
} from '../../src/store/session-indexer.js';
import { parseSessionFile, type ParsedSession } from '../../src/store/session-parser.js';

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

    it('should skip already-indexed sessions with no new messages', () => {
      const session = createTestSession();

      const result1 = indexSession(dbManager, session);
      assert.strictEqual(result1.skipped, false);

      const result2 = indexSession(dbManager, session);
      assert.strictEqual(result2.skipped, true);
      assert.strictEqual(result2.messagesIndexed, 0);
    });

    it('should append missing messages for an already-indexed resumed session', () => {
      const session = createTestSession();
      indexSession(dbManager, session);

      const resumed = createTestSession({
        messages: [
          ...session.messages,
          { id: 'session-1-msg-3', role: 'user', content: 'Resumed later', timestamp: '2026-05-03T00:02:00Z' },
        ],
      });
      const result = indexSession(dbManager, resumed);

      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().sessions, 1);
      assert.strictEqual(dbManager.getStats().messages, 3);

      const dbSession = dbManager.getDb().prepare('SELECT message_count FROM sessions WHERE id = ?').get('session-1') as { message_count: number };
      assert.strictEqual(dbSession.message_count, 3);
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

  describe('indexChangedSessions', () => {
    function writeJsonlSession(filePath: string, sessionId: string, messageIds = [`${sessionId}-m1`]): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session', id: sessionId, timestamp: '2026-05-03T00:00:00Z', cwd: `/test/${sessionId}` }),
        ...messageIds.map((id, index) => JSON.stringify({
          type: 'message',
          id,
          parentId: null,
          timestamp: `2026-05-03T00:0${index + 1}:00Z`,
          message: { role: 'user', content: [{ type: 'text', text: `Hello ${id}` }], timestamp: Date.now() },
        })),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));
    }

    it('skips unchanged files using stored size and mtime metadata without parsing them', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project-a', 's1.jsonl');
      writeJsonlSession(filePath, 's1');
      indexAllSessions(dbManager, sessionsDir);

      const result = indexChangedSessions(dbManager, sessionsDir);

      assert.strictEqual(result.sessionsProcessed, 0);
      assert.strictEqual(result.sessionsSkipped, 1);
      assert.strictEqual(result.errors.length, 0);
    });

    it('indexes changed files and appends newly persisted messages', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project-a', 's1.jsonl');
      writeJsonlSession(filePath, 's1', ['s1-m1']);
      indexAllSessions(dbManager, sessionsDir);

      writeJsonlSession(filePath, 's1', ['s1-m1', 's1-m2']);
      const result = indexChangedSessions(dbManager, sessionsDir);

      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.sessionsIndexed, 1);
      assert.strictEqual(result.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().messages, 2);
    });

    it('parses existing sessions without file metadata and appends missed messages', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project-a', 's1.jsonl');
      indexSession(dbManager, createTestSession({
        id: 's1',
        messages: [
          { id: 's1-m1', role: 'user', content: 'Hello s1-m1', timestamp: '2026-05-03T00:01:00Z' },
        ],
      }));
      writeJsonlSession(filePath, 's1', ['s1-m1', 's1-m2']);

      const result = indexChangedSessions(dbManager, sessionsDir);

      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.sessionsIndexed, 1);
      assert.strictEqual(result.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().messages, 2);
    });

    it('caps parsed files during startup incremental backfill', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(path.join(sessionsDir, 'project-a', 's1.jsonl'), 's1');
      writeJsonlSession(path.join(sessionsDir, 'project-a', 's2.jsonl'), 's2');

      const result = indexChangedSessions(dbManager, sessionsDir, { maxFilesToIndex: 1 });

      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.reachedLimit, true);
      assert.strictEqual(dbManager.getStats().sessions, 1);
    });

    it('processes the most recently modified changed files first when the cap is reached', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      // Write an older file first, then a newer one. With newest-first ordering
      // the newer file must be indexed even when the cap only allows one file.
      const olderPath = path.join(sessionsDir, 'project-a', 'older.jsonl');
      const newerPath = path.join(sessionsDir, 'project-a', 'newer.jsonl');
      writeJsonlSession(olderPath, 'older');
      // Ensure a measurable mtime gap (some filesystems have coarse mtime resolution).
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(olderPath, past, past);
      writeJsonlSession(newerPath, 'newer');

      const result = indexChangedSessions(dbManager, sessionsDir, { maxFilesToIndex: 1 });

      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.reachedLimit, true);
      assert.strictEqual(dbManager.getStats().sessions, 1);
      // The newer file should be the one indexed.
      const indexed = dbManager.getDb().prepare('SELECT id FROM sessions').all() as { id: string }[];
      assert.deepStrictEqual(indexed.map((r) => r.id), ['newer']);
    });
  });

  describe('current session indexing helpers', () => {
    function writeSessionFile(filePath: string): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session', id: 'file-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/file-project' }),
        JSON.stringify({
          type: 'message',
          id: 'file-entry-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'from persisted file' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));
    }

    function createSessionManagerSnapshot(entries: unknown[] = []) {
      return {
        getHeader: () => ({ id: 'live-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/live-project' }),
        getEntries: () => entries,
      };
    }

    it('parseSessionManagerSnapshot converts current session entries into ParsedSession', () => {
      const snapshot = createSessionManagerSnapshot([
        {
          type: 'message',
          id: 'entry-1',
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: 'Hello live session' },
        },
        {
          type: 'message',
          id: 'entry-2',
          timestamp: '2026-05-03T00:02:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }, { type: 'toolCall', name: 'read' }] },
        },
        {
          type: 'message',
          id: 'entry-3',
          timestamp: '2026-05-03T00:03:00Z',
          message: { role: 'toolResult', content: [{ type: 'text', text: 'tool output is not indexed by current schema' }] },
        },
      ]);

      const parsed = parseSessionManagerSnapshot(snapshot);

      assert.ok(parsed);
      assert.strictEqual(parsed.id, 'live-session-1');
      assert.strictEqual(parsed.project, 'live-project');
      assert.strictEqual(parsed.messages.length, 2);
      assert.deepStrictEqual(parsed.messages[1].toolCalls, ['read']);
    });

    it('indexLiveSession prefers the persisted JSONL file when available', () => {
      const filePath = path.join(tmpDir, 'sessions', 'project', 'file-session.jsonl');
      writeSessionFile(filePath);
      const snapshot = {
        getHeader: () => ({ id: 'stale-memory-session', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/stale' }),
        getEntries: () => [],
        getSessionFile: () => filePath,
      };

      const result = indexLiveSession(dbManager, snapshot);

      assert.ok(result);
      assert.strictEqual(result.sessionId, 'file-session-1');
      assert.strictEqual(result.messagesIndexed, 1);
      const indexed = dbManager.getDb().prepare('SELECT id, cwd FROM sessions WHERE id = ?').get('file-session-1') as { id: string; cwd: string };
      assert.strictEqual(indexed.cwd, '/work/file-project');
    });

    it('indexCurrentSession indexes missing live messages idempotently', () => {
      const entries = [
        {
          type: 'message',
          id: 'entry-1',
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: 'Hello live session' },
        },
      ];
      const snapshot = createSessionManagerSnapshot(entries);

      const result1 = indexCurrentSession(dbManager, snapshot);
      assert.ok(result1);
      assert.strictEqual(result1.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().sessions, 1);
      assert.strictEqual(dbManager.getStats().messages, 1);

      entries.push({
        type: 'message',
        id: 'entry-2',
        timestamp: '2026-05-03T00:02:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi again' }] },
      });
      const result2 = indexCurrentSession(dbManager, snapshot);
      assert.ok(result2);
      assert.strictEqual(result2.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().sessions, 1);
      assert.strictEqual(dbManager.getStats().messages, 2);

      const result3 = indexCurrentSession(dbManager, snapshot);
      assert.ok(result3);
      assert.strictEqual(result3.skipped, true);
      assert.strictEqual(result3.messagesIndexed, 0);
    });
  });

  describe('backfill metadata helpers', () => {
    function writeJsonlSession(sessionsDir: string, projectDir: string, sessionId: string): void {
      const projDir = path.join(sessionsDir, projectDir);
      fs.mkdirSync(projDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session', id: sessionId, timestamp: '2026-05-03T00:00:00Z', cwd: `/test/${projectDir}` }),
        JSON.stringify({
          type: 'message',
          id: `${sessionId}-m1`,
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n'));
    }

    it('countSessionFiles counts JSONL files in session project directories', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      writeJsonlSession(sessionsDir, 'project-b', 's2');
      fs.writeFileSync(path.join(sessionsDir, 'project-b', 'notes.txt'), 'not a session');

      assert.strictEqual(countSessionFiles(sessionsDir), 2);
    });

    it('needsBackfill is true when session file count exceeds indexed sessions', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);
    });

    it('needsBackfill is false when counts match and timestamp is recent', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      indexAllSessions(dbManager, sessionsDir);
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T00:30:00Z'));

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), false);
    });

    it('needsBackfill is true when file metadata changes even with a recent timestamp', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      indexAllSessions(dbManager, sessionsDir);
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T00:30:00Z'));

      fs.appendFileSync(path.join(sessionsDir, 'project-a', 's1.jsonl'), '\n' + JSON.stringify({
        type: 'message',
        id: 's1-m2',
        parentId: null,
        timestamp: '2026-05-03T00:02:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello again' }], timestamp: Date.now() },
      }));

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);
    });

    it('needsBackfill is true for existing sessions without file metadata even with a recent timestamp', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      indexSession(dbManager, createTestSession({ id: 's1', messages: [] }));
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T00:30:00Z'));

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);
    });

    it('needsBackfill is true when timestamp is missing or older than 24 hours', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      indexAllSessions(dbManager, sessionsDir);

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);

      touchBackfillTimestamp(dbManager, new Date('2026-05-01T00:00:00Z'));
      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);
    });

    it('touchBackfillTimestamp upserts the metadata row', () => {
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T00:00:00Z'));
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T01:00:00Z'));

      const row = dbManager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(LAST_SESSION_BACKFILL_KEY) as { value: string };
      assert.strictEqual(row.value, '2026-05-03T01:00:00.000Z');
    });

    it('upsertSessionFileMetadata keeps stored metadata in sync after a session file is appended', () => {
      // Mirrors the session_shutdown path: index the session, then upsert the
      // file metadata for the final on-disk state. A subsequent
      // indexChangedSessions pass must skip the file instead of re-parsing it.
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      const filePath = path.join(sessionsDir, 'project-a', 's1.jsonl');

      indexAllSessions(dbManager, sessionsDir);
      // Simulate Pi appending the closing entry on shutdown.
      fs.appendFileSync(filePath, '\n' + JSON.stringify({
        type: 'message',
        id: 's1-m2',
        parentId: null,
        timestamp: '2026-05-03T00:02:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello again' }], timestamp: Date.now() },
      }));
      const session = parseSessionFile(filePath);
      indexSession(dbManager, session);
      upsertSessionFileMetadata(dbManager, filePath, session.id);

      const result = indexChangedSessions(dbManager, sessionsDir);

      assert.strictEqual(result.sessionsProcessed, 0);
      assert.strictEqual(result.sessionsSkipped, 1);
      assert.strictEqual(result.reachedLimit, undefined);
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
