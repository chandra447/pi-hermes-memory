import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession } from '../../src/store/session-indexer.js';
import { searchSessions } from '../../src/store/session-search.js';
import { normalizeFts5Query, buildFallbackFts5Query } from '../../src/store/fts-query.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FTS5 query improvements integration', () => {
  it('filters stop words and preserves meaningful terms', () => {
    const q1 = normalizeFts5Query('how to fix the authentication bug');
    assert.ok(q1.includes('"authentication"'), 'should keep meaningful terms');
    assert.ok(q1.includes('"bug"'), 'should keep meaningful terms');
    assert.ok(!q1.includes('"how"'), 'should filter stop word');
    assert.ok(!q1.includes('"to"'), 'should filter stop word');
    assert.ok(!q1.includes('"the"'), 'should filter stop word');
    
    const q2 = normalizeFts5Query('user preference for dark theme');
    assert.ok(q2.includes('"user"'), 'should keep meaningful terms');
    assert.ok(!q2.includes('"for"'), 'should filter stop word');
    
    const q3 = normalizeFts5Query('the a is was were');
    assert.strictEqual(q3, '', 'empty query when all stop words');
  });

  it('preserves explicit FTS5 operators and quoted phrases', () => {
    const q1 = normalizeFts5Query('"authentication bug" AND database');
    assert.ok(q1.includes('"authentication bug"'), 'should preserve quoted phrase');
    assert.ok(q1.includes('AND'), 'should preserve operator');
    
    const q2 = normalizeFts5Query('auth OR database');
    assert.ok(q2.includes('OR'), 'should preserve OR operator');
  });

  it('builds fallback OR queries for multi-term searches', () => {
    const fb = buildFallbackFts5Query('authentication bug fix');
    assert.ok(fb?.includes('OR'), 'should use OR in fallback');
    assert.ok(fb?.includes('"authentication"'), 'should include first term');
    assert.ok(fb?.includes('"bug"'), 'should include second term');
    
    const fbNull = buildFallbackFts5Query('auth');
    assert.strictEqual(fbNull, null, 'no fallback for single term');
  });

  it('indexes and searches sessions with stop word filtered queries', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-test-'));
    const dbManager = new DatabaseManager(tmpDir);
    
    try {
      indexSession(dbManager, {
        id: 'test-session-1',
        project: 'test-project',
        cwd: '/tmp/test',
        startedAt: '2026-08-15T10:00:00.000Z',
        endedAt: null,
        messages: [
          { id: 'msg-1', role: 'user', content: 'How do I fix the authentication bug?', timestamp: '2026-08-15T10:00:01.000Z' },
          { id: 'msg-2', role: 'assistant', content: 'The authentication bug is caused by a race condition in the database connection pool.', timestamp: '2026-08-15T10:00:02.000Z' },
        ],
      });

      const r1 = searchSessions(dbManager, 'authentication bug fix', { limit: 5 });
      assert.ok(r1.length > 0, 'should find results with stop words filtered');
      
      const r2 = searchSessions(dbManager, 'database connection pool', { limit: 5 });
      assert.ok(r2.length > 0, 'should find results for technical terms');
      
      const r3 = searchSessions(dbManager, 'how to fix the authentication bug', { limit: 5 });
      assert.ok(r3.length > 0, 'should find results even with many stop words');
    } finally {
      dbManager.close();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
