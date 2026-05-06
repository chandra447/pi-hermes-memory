import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { registerMemoryCandidatesRebuildCommand, registerMemoryCandidatesStatsCommand } from '../../src/handlers/candidate-observability.js';
import { indexSession } from '../../src/store/session-indexer.js';
import { addCandidate, listCandidates } from '../../src/store/candidate-store.js';
import type { ParsedSession } from '../../src/store/session-parser.js';

function setupMockPi() {
  const handlers = new Map<string, Function>();
  const pi = {
    registerCommand: (name: string, opts: { handler: Function }) => handlers.set(name, opts.handler),
  } as any;
  return { pi, handlers };
}

function makeSession(id: string, project: string, messages: ParsedSession['messages']): ParsedSession {
  return { id, project, cwd: `/tmp/${project}`, startedAt: '2026-05-06T00:00:00Z', endedAt: null, messages };
}

describe('candidate observability commands', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-observability-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers candidate stats and rebuild commands', () => {
    const { pi, handlers } = setupMockPi();
    registerMemoryCandidatesStatsCommand(pi, dbManager);
    registerMemoryCandidatesRebuildCommand(pi, dbManager, { candidateConfidenceThreshold: 0.75 } as any);
    assert.ok(handlers.has('memory-candidates-stats'));
    assert.ok(handlers.has('memory-candidates-rebuild'));
  });

  it('shows candidate stats', async () => {
    addCandidate(dbManager, {
      sessionId: 's1', messageId: 'm1', project: 'proj', tag: 'testing', snippet: 'A', rationale: 'A', confidence: 0.9,
      sourceType: 'explicit_tag', extractorRule: 'explicit_tag', timestamp: '2026-05-06T00:00:00.000Z',
    });

    const { pi, handlers } = setupMockPi();
    registerMemoryCandidatesStatsCommand(pi, dbManager);

    const notifications: string[] = [];
    const ctx = { ui: { notify: (m: string) => notifications.push(m) } } as any;
    await handlers.get('memory-candidates-stats')('', ctx);

    const merged = notifications.join('\n');
    assert.ok(merged.includes('Memory Candidate Stats'));
    assert.ok(merged.includes('Total:'));
    assert.ok(merged.includes('Pending:'));
    assert.ok(merged.includes('Approved:'));
    assert.ok(merged.includes('Rejected:'));
    assert.ok(merged.includes('Promoted:'));
  });

  it('rebuilds candidates from indexed sessions with threshold', async () => {
    const session = makeSession('s1', 'proj', [
      { id: 'm1', role: 'user', content: 'no, use yarn instead', timestamp: '2026-05-06T00:00:01Z' },
      { id: 'm2', role: 'assistant', content: 'updated package manager', timestamp: '2026-05-06T00:00:02Z' },
      { id: 'm3', role: 'user', content: 'no, use yarn instead', timestamp: '2026-05-06T00:00:03Z' },
      { id: 'm4', role: 'assistant', content: 'done', timestamp: '2026-05-06T00:00:04Z', toolCalls: ['read', 'edit'] },
      { id: 'm5', role: 'assistant', content: 'done', timestamp: '2026-05-06T00:00:05Z', toolCalls: ['read', 'edit'] },
    ]);
    indexSession(dbManager, session);

    addCandidate(dbManager, {
      sessionId: 'old', messageId: 'old-1', project: 'proj', tag: 'workflow', snippet: 'legacy', rationale: 'legacy', confidence: 0.9,
      sourceType: 'explicit_tag', extractorRule: 'explicit_tag', timestamp: '2026-05-05T00:00:00.000Z',
    });

    const { pi, handlers } = setupMockPi();
    registerMemoryCandidatesRebuildCommand(pi, dbManager, { candidateConfidenceThreshold: 0.8 } as any);

    const notifications: string[] = [];
    const ctx = {
      ui: {
        confirm: async () => true,
        notify: (m: string) => notifications.push(m),
      },
    } as any;

    await handlers.get('memory-candidates-rebuild')('', ctx);

    const rows = listCandidates(dbManager);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.confidence >= 0.8));
    assert.ok(notifications.some((m) => m.includes('Rebuilt candidates')));
  });

  it('rolls back rebuild when extractor fails', async () => {
    addCandidate(dbManager, {
      sessionId: 'old', messageId: 'old-1', project: 'proj', tag: 'workflow', snippet: 'legacy', rationale: 'legacy', confidence: 0.9,
      sourceType: 'explicit_tag', extractorRule: 'explicit_tag', timestamp: '2026-05-05T00:00:00.000Z',
    });

    const { pi, handlers } = setupMockPi();
    registerMemoryCandidatesRebuildCommand(
      pi,
      dbManager,
      { candidateConfidenceThreshold: 0.75 } as any,
      { extract: () => { throw new Error('boom'); } },
    );

    const notifications: string[] = [];
    const ctx = {
      ui: {
        confirm: async () => true,
        notify: (m: string) => notifications.push(m),
      },
    } as any;

    await handlers.get('memory-candidates-rebuild')('', ctx);

    const rows = listCandidates(dbManager);
    assert.equal(rows.length, 1);
    assert.ok(notifications.some((m) => m.includes('failed')));
  });

  it('cancels rebuild when confirmation denied', async () => {
    const { pi, handlers } = setupMockPi();
    registerMemoryCandidatesRebuildCommand(pi, dbManager, { candidateConfidenceThreshold: 0.75 } as any);

    const notifications: string[] = [];
    const ctx = {
      ui: {
        confirm: async () => false,
        notify: (m: string) => notifications.push(m),
      },
    } as any;

    await handlers.get('memory-candidates-rebuild')('', ctx);
    assert.ok(notifications.some((m) => m.includes('cancelled')));
  });
});
