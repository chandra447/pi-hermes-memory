import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canPromoteToSkill, composeSkillDraft } from '../../src/skills/skill-draft-composer.js';
import type { MemoryCandidate } from '../../src/store/candidate-store.js';

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 1,
    sessionId: 's1',
    messageId: 'm1',
    project: 'proj',
    tag: 'testing',
    snippet: 'Run tests per file',
    rationale: 'Avoid hangs',
    confidence: 0.8,
    status: 'approved',
    sourceType: 'failure',
    extractorRule: 'failure_fix_pair',
    evidenceCount: 2,
    toolState: null,
    timestamp: '2026-05-06T00:00:00.000Z',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    promotedSkill: null,
    dedupeKey: null,
    ...overrides,
  };
}

describe('skill-draft-composer', () => {
  it('blocks non-approved candidates', () => {
    const result = canPromoteToSkill([candidate({ status: 'pending' })]);
    assert.equal(result.ok, false);
  });

  it('allows promotion when approved candidate has evidence_count >= 2', () => {
    const result = canPromoteToSkill([candidate({ evidenceCount: 2 })]);
    assert.equal(result.ok, true);
  });

  it('rejects promotion when evidence_count is below threshold', () => {
    const result = canPromoteToSkill([
      candidate({ id: 1, evidenceCount: 1 }),
      candidate({ id: 2, sourceType: 'tool_sequence', evidenceCount: 1 }),
    ]);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /evidence_count >= 2/i);
  });

  it('composes required sections', () => {
    const draft = composeSkillDraft([candidate(), candidate({ id: 2, snippet: 'Run npm check first', rationale: 'Catch type errors early' })], 'test-workflow');
    assert.equal(draft.name, 'test-workflow');
    assert.match(draft.body, /## When to Use/);
    assert.match(draft.body, /## Procedure/);
    assert.match(draft.body, /## Pitfalls/);
    assert.match(draft.body, /## Verification/);
    assert.equal(draft.warnings.length, 0);
  });

  it('adds sparse warnings and fallback for empty pitfalls', () => {
    const draft = composeSkillDraft([candidate({ snippet: 'one step only', rationale: '' })], 'single-step');
    assert.ok(draft.warnings.length >= 1);
    assert.match(draft.body, /Watch for edge cases and regressions/);
  });
});
