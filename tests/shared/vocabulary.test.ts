import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_KINDS,
  HIT_SOURCES,
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  STATUS_WORDS,
} from '../../src/shared/vocabulary.js';

describe('shared vocabulary', () => {
  it('keeps the six canonical categories (v1 parity)', () => {
    assert.deepEqual(
      [...MEMORY_CATEGORIES].sort(),
      ['correction', 'convention', 'failure', 'insight', 'preference', 'tool-quirk'].sort(),
    );
  });

  it('keeps the v1 scope set (global memory, user profile, failure)', () => {
    assert.deepEqual([...MEMORY_SCOPES], ['memory', 'user', 'failure']);
  });

  it('carries the six project-status words (spine "Status entries")', () => {
    assert.deepEqual(
      [...STATUS_WORDS].sort(),
      ['abandoned', 'active', 'done', 'dormant', 'hardening', 'held'].sort(),
    );
  });

  it('reserves the memory|status entry kinds', () => {
    assert.deepEqual([...ENTRY_KINDS], ['memory', 'status']);
  });

  it('defines the shared|local source tags (AD-15)', () => {
    assert.deepEqual([...HIT_SOURCES], ['shared', 'local']);
  });

  it('has no duplicates in any vocabulary set', () => {
    for (const set of [MEMORY_CATEGORIES, MEMORY_SCOPES, STATUS_WORDS, ENTRY_KINDS, HIT_SOURCES]) {
      assert.equal(new Set(set).size, set.length, `duplicate in ${set.join(',')}`);
    }
  });
});
