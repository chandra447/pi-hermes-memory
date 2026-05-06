import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addCandidate, listCandidates } from '../../src/store/candidate-store.js';
import { registerMemoryReviewCandidatesCommand } from '../../src/handlers/memory-review-candidates.js';

function setupMockPi() {
  const handlers = new Map<string, Function>();
  const pi = {
    registerCommand: (name: string, opts: { handler: Function }) => {
      handlers.set(name, opts.handler);
    },
  } as any;
  return { pi, handlers };
}

describe('memory-review-candidates command', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-review-candidates-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers memory-review-candidates command', () => {
    const { pi, handlers } = setupMockPi();
    registerMemoryReviewCandidatesCommand(pi, dbManager);
    assert.ok(handlers.has('memory-review-candidates'));
  });

  it('approves selected candidates via TUI flow', async () => {
    const c = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj',
      tag: 'testing',
      snippet: 'run tests per-file',
      rationale: 'stable pattern',
      confidence: 0.9,
      sourceType: 'tool_sequence',
      extractorRule: 'repeated_tool_sequence',
      timestamp: '2026-05-06T00:00:00.000Z',
    })!;

    const { pi, handlers } = setupMockPi();
    registerMemoryReviewCandidatesCommand(pi, dbManager);

    const queue = [
      `[#] #${c.id}`,
      '✅ Approve selected',
      '✅ Done',
    ];

    const ctx = {
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = queue.shift();
          if (!next) return '✅ Done';
          if (next.startsWith('[#]')) {
            const id = next.match(/#(\d+)/)![1];
            return options.find((o) => o.includes(`#${id} `)) ?? options[0];
          }
          return next;
        },
        input: async () => undefined,
        notify: () => {},
      },
    } as any;

    await handlers.get('memory-review-candidates')('', ctx);

    const row = listCandidates(dbManager).find((r) => r.id === c.id)!;
    assert.equal(row.status, 'approved');
  });

  it('edits selected candidate fields', async () => {
    const c = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj',
      tag: 'testing',
      snippet: 'old snippet',
      rationale: 'old rationale',
      confidence: 0.92,
      sourceType: 'explicit_tag',
      extractorRule: 'explicit_tag',
      timestamp: '2026-05-06T00:00:00.000Z',
    })!;

    const { pi, handlers } = setupMockPi();
    registerMemoryReviewCandidatesCommand(pi, dbManager);

    const queue = [
      `[#] #${c.id}`,
      '✏️ Edit selected (single)',
      '✅ Done',
    ];
    const inputQueue = ['workflow', 'new snippet', 'new rationale'];

    const ctx = {
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = queue.shift();
          if (!next) return '✅ Done';
          if (next.startsWith('[#]')) {
            const id = next.match(/#(\d+)/)![1];
            return options.find((o) => o.includes(`#${id} `)) ?? options[0];
          }
          return next;
        },
        input: async () => inputQueue.shift(),
        notify: () => {},
      },
    } as any;

    await handlers.get('memory-review-candidates')('', ctx);

    const row = listCandidates(dbManager).find((r) => r.id === c.id)!;
    assert.equal(row.tag, 'workflow');
    assert.equal(row.snippet, 'new snippet');
    assert.equal(row.rationale, 'new rationale');
  });

  it('merges two selected candidates', async () => {
    const a = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj',
      tag: 'testing',
      snippet: 'first snippet',
      rationale: 'first rationale',
      confidence: 0.6,
      sourceType: 'failure',
      extractorRule: 'failure_fix',
      timestamp: '2026-05-06T00:00:00.000Z',
    })!;

    const b = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm2',
      project: 'proj',
      tag: 'testing',
      snippet: 'second snippet',
      rationale: 'second rationale',
      confidence: 0.9,
      sourceType: 'failure',
      extractorRule: 'failure_fix',
      timestamp: '2026-05-06T00:01:00.000Z',
    })!;

    const { pi, handlers } = setupMockPi();
    registerMemoryReviewCandidatesCommand(pi, dbManager);

    const queue = [
      `[#] #${a.id}`,
      `[#] #${b.id}`,
      '🔀 Merge selected (pick primary)',
      `#${a.id} testing`,
      '✅ Done',
    ];

    const ctx = {
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = queue.shift();
          if (!next) return '✅ Done';
          if (next.startsWith('[#]')) {
            const id = next.match(/#(\d+)/)![1];
            return options.find((o) => o.includes(`#${id} `)) ?? options[0];
          }
          if (next.startsWith('#')) {
            const id = next.match(/#(\d+)/)![1];
            return options.find((o) => o.includes(`#${id} `)) ?? options[0];
          }
          return next;
        },
        input: async () => undefined,
        notify: () => {},
      },
    } as any;

    await handlers.get('memory-review-candidates')('', ctx);

    const rows = listCandidates(dbManager);
    const primary = rows.find((r) => r.id === a.id)!;
    const secondary = rows.find((r) => r.id === b.id)!;
    assert.equal(primary.status, 'pending');
    assert.equal(secondary.status, 'rejected');
    assert.ok(primary.snippet.includes('second snippet'));
  });

  it('bulk-approves multiple selected candidates', async () => {
    const a = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj',
      tag: 'testing',
      snippet: 'snippet a',
      rationale: 'rationale a',
      confidence: 0.8,
      sourceType: 'failure',
      extractorRule: 'failure_fix',
      timestamp: '2026-05-06T00:00:00.000Z',
    })!;

    const b = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm2',
      project: 'proj',
      tag: 'workflow',
      snippet: 'snippet b',
      rationale: 'rationale b',
      confidence: 0.85,
      sourceType: 'correction',
      extractorRule: 'repeated_correction',
      timestamp: '2026-05-06T00:01:00.000Z',
    })!;

    const { pi, handlers } = setupMockPi();
    registerMemoryReviewCandidatesCommand(pi, dbManager);

    const queue = [`[#] #${a.id}`, `[#] #${b.id}`, '✅ Approve selected', '✅ Done'];

    const ctx = {
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = queue.shift();
          if (!next) return '✅ Done';
          if (next.startsWith('[#]')) {
            const id = next.match(/#(\d+)/)![1];
            return options.find((o) => o.includes(`#${id} `)) ?? options[0];
          }
          return next;
        },
        input: async () => undefined,
        notify: () => {},
      },
    } as any;

    await handlers.get('memory-review-candidates')('', ctx);

    const rows = listCandidates(dbManager);
    assert.equal(rows.find((r) => r.id === a.id)?.status, 'approved');
    assert.equal(rows.find((r) => r.id === b.id)?.status, 'approved');
  });

  it('enforces approval gate before promotion', async () => {
    const c = addCandidate(dbManager, {
      sessionId: 's1',
      messageId: 'm1',
      project: 'proj',
      tag: 'workflow',
      snippet: 'commit only after tests pass',
      rationale: 'repeated user preference',
      confidence: 0.92,
      sourceType: 'explicit_tag',
      extractorRule: 'explicit_tag',
      timestamp: '2026-05-06T00:00:00.000Z',
    })!;

    const { pi, handlers } = setupMockPi();
    registerMemoryReviewCandidatesCommand(pi, dbManager);

    const notifications: string[] = [];
    let inputCalls = 0;
    const queue = [
      `[#] #${c.id}`,
      '🚀 Promote selected (approved only)',
      '✅ Done',
    ];

    const ctx = {
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = queue.shift();
          if (!next) return '✅ Done';
          if (next.startsWith('[#]')) {
            const id = next.match(/#(\d+)/)![1];
            return options.find((o) => o.includes(`#${id} `)) ?? options[0];
          }
          return next;
        },
        input: async () => {
          inputCalls++;
          return 'test-skill';
        },
        notify: (m: string) => notifications.push(m),
      },
    } as any;

    await handlers.get('memory-review-candidates')('', ctx);

    const row = listCandidates(dbManager).find((r) => r.id === c.id)!;
    assert.equal(row.status, 'pending');
    assert.ok(notifications.some((m) => m.includes('No approved candidates selected')));
    assert.equal(inputCalls, 0);
  });
});
