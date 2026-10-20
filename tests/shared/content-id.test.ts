import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contentIdInput, deterministicEntryId } from '../../src/shared/content-id.js';

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('content-id (frozen deterministic identity, story 2 Q1=B)', () => {
  it('is deterministic: same fields, same id (the cross-box dedup property)', () => {
    const a = deterministicEntryId('the deploy target is stable-cluster', 'memory', null, null);
    const b = deterministicEntryId('the deploy target is stable-cluster', 'memory', null, null);
    assert.equal(a, b);
  });

  it('is stable under surrounding whitespace (trim is part of the frozen input)', () => {
    const a = deterministicEntryId('  padded content  ', 'memory', null, null);
    const b = deterministicEntryId('padded content', 'memory', null, null);
    assert.equal(a, b);
  });

  it('produces a syntactically valid UUIDv7 (the wire Uuid7 pattern)', () => {
    const id = deterministicEntryId('some content', 'failure', 'https://github.com/jan/repo', 'tool-quirk');
    assert.match(id, UUID_V7_PATTERN);
  });

  it('differs when ANY field differs (content, scope, project, category)', () => {
    const base = deterministicEntryId('content', 'memory', null, null);
    assert.notEqual(base, deterministicEntryId('content!', 'memory', null, null));
    assert.notEqual(base, deterministicEntryId('content', 'user', null, null));
    assert.notEqual(base, deterministicEntryId('content', 'memory', 'https://h/p', null));
    assert.notEqual(base, deterministicEntryId('content', 'memory', null, 'insight'));
  });

  it('treats absent project/category as empty (distinct from real values, no NUL ambiguity)', () => {
    const noProject = deterministicEntryId('c', 'memory', null, null);
    const emptyProject = deterministicEntryId('c', 'memory', '', null);
    assert.equal(noProject, emptyProject); // null ≡ '' — both mean "global"
    assert.notEqual(noProject, deterministicEntryId('c', 'memory', 'x', null));
  });

  it('joins fields with NUL so field boundaries are unambiguous', () => {
    // 'a' + scope 'memory' must not collide with content 'a' in a scope named…
    // (no scope can contain NUL, but the join must still be canonical):
    assert.equal(
      contentIdInput('ab', 'memory', null, null),
      'ab\u0000memory\u0000\u0000',
    );
    assert.notEqual(
      contentIdInput('ab', 'memory', null, null),
      contentIdInput('abm', 'emo', null, null),
    );
  });

  it('is stable across calls (pure function)', () => {
    const id = deterministicEntryId('x', 'user', 'https://h/p', 'preference');
    for (let i = 0; i < 5; i++) {
      assert.equal(deterministicEntryId('x', 'user', 'https://h/p', 'preference'), id);
    }
  });
});
