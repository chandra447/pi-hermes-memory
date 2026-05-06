import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import {
  addCandidate,
  listCandidates,
  markPromoted,
  updateCandidateStatus,
} from '../../src/store/candidate-store.js';

describe('candidate-store', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-store-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds and lists candidates', () => {
    const created = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj-a',
      tag: 'testing',
      snippet: 'Run tests per file with tsx --test',
      rationale: 'Avoids hangs in test runner',
      confidence: 0.85,
      sourceType: 'explicit_tag',
      extractorRule: 'tag_learn',
      evidenceCount: 2,
      timestamp: '2026-05-06T00:00:00.000Z',
      dedupeKey: 's1:m1:testing:tag_learn',
    });

    assert.ok(created);
    assert.strictEqual(created?.status, 'pending');

    const all = listCandidates(dbManager);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].sessionId, 's1');
    assert.strictEqual(all[0].extractorRule, 'tag_learn');
    assert.strictEqual(all[0].evidenceCount, 2);
  });

  it('filters by status/project/tag', () => {
    addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj-a',
      tag: 'testing',
      snippet: 'A',
      rationale: 'A',
      confidence: 0.8,
      sourceType: 'failure',
      extractorRule: 'failure_fix',
      timestamp: '2026-05-06T00:00:00.000Z',
      dedupeKey: 'k1',
    });
    const b = addCandidate(dbManager, {
      sessionId: 's2',
      messageId: 'm2',
      project: 'proj-b',
      tag: 'typescript',
      snippet: 'B',
      rationale: 'B',
      confidence: 0.7,
      sourceType: 'correction',
      extractorRule: 'repeated_correction',
      timestamp: '2026-05-06T00:01:00.000Z',
      dedupeKey: 'k2',
    });
    assert.ok(b);
    updateCandidateStatus(dbManager, b!.id, 'approved');

    assert.strictEqual(listCandidates(dbManager, { status: 'approved' }).length, 1);
    assert.strictEqual(listCandidates(dbManager, { project: 'proj-a' }).length, 1);
    assert.strictEqual(listCandidates(dbManager, { tag: 'typescript' }).length, 1);
  });

  it('enforces status transitions and promotion rules', () => {
    const created = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj-a',
      tag: 'testing',
      snippet: 'A',
      rationale: 'A',
      confidence: 0.8,
      sourceType: 'failure',
      extractorRule: 'failure_fix',
      timestamp: '2026-05-06T00:00:00.000Z',
      dedupeKey: 'k3',
    });

    assert.ok(created);
    assert.strictEqual(markPromoted(dbManager, created!.id, 'node-test-runner-per-file'), false);

    assert.strictEqual(updateCandidateStatus(dbManager, created!.id, 'approved'), true);
    assert.strictEqual(markPromoted(dbManager, created!.id, 'node-test-runner-per-file'), true);

    const promoted = listCandidates(dbManager, { status: 'promoted' });
    assert.strictEqual(promoted.length, 1);
    assert.strictEqual(promoted[0].promotedSkill, 'node-test-runner-per-file');

    assert.strictEqual(updateCandidateStatus(dbManager, created!.id, 'rejected'), false);
  });

  it('suppresses duplicates via dedupe constraints', () => {
    const first = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj-a',
      tag: 'testing',
      snippet: 'A',
      rationale: 'A',
      confidence: 0.8,
      sourceType: 'failure',
      extractorRule: 'failure_fix',
      timestamp: '2026-05-06T00:00:00.000Z',
      dedupeKey: 'same-key',
    });

    const duplicateByKey = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm2',
      project: 'proj-a',
      tag: 'testing',
      snippet: 'B',
      rationale: 'B',
      confidence: 0.6,
      sourceType: 'failure',
      extractorRule: 'failure_fix',
      timestamp: '2026-05-06T00:01:00.000Z',
      dedupeKey: 'same-key',
    });

    const duplicateByTuple = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj-a',
      tag: 'testing',
      snippet: 'C',
      rationale: 'C',
      confidence: 0.6,
      sourceType: 'failure',
      extractorRule: 'failure_fix',
      timestamp: '2026-05-06T00:01:00.000Z',
      dedupeKey: 'different-key',
    });

    assert.ok(first);
    assert.strictEqual(duplicateByKey, null);
    assert.strictEqual(duplicateByTuple, null);
    assert.strictEqual(listCandidates(dbManager).length, 1);
  });
});
