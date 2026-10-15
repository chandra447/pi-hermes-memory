import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectKey } from '../../src/shared/project-key.js';

describe('normalizeProjectKey', () => {
  it('canonicalizes SSH SCP form to https', () => {
    assert.equal(normalizeProjectKey('git@github.com:janesser/pi-hermes-memory.git'), 'https://github.com/janesser/pi-hermes-memory');
  });

  it('canonicalizes SSH URL form to https', () => {
    assert.equal(normalizeProjectKey('ssh://git@github.com/janesser/pi-hermes-memory.git'), 'https://github.com/janesser/pi-hermes-memory');
  });

  it('keeps a non-default SSH port', () => {
    assert.equal(normalizeProjectKey('ssh://git@github.com:2222/jan/repo'), 'https://github.com:2222/jan/repo');
  });

  it('lowercases host and path', () => {
    assert.equal(normalizeProjectKey('https://GitHub.com/Jan/Repo.git'), 'https://github.com/jan/repo');
  });

  it('upgrades http to https', () => {
    assert.equal(normalizeProjectKey('http://github.com/jan/repo'), 'https://github.com/jan/repo');
  });

  it('strips trailing .git and slashes', () => {
    assert.equal(normalizeProjectKey('https://github.com/jan/repo.git/'), 'https://github.com/jan/repo');
  });

  it('accepts a bare host/path', () => {
    assert.equal(normalizeProjectKey('github.com/jan/repo'), 'https://github.com/jan/repo');
  });

  it('is idempotent on canonical input', () => {
    const once = normalizeProjectKey('https://github.com/jan/repo');
    assert.equal(normalizeProjectKey(once), once);
  });

  it('throws on empty input (missing registry entry is a client error, AD-10)', () => {
    assert.throws(() => normalizeProjectKey('   '));
  });
});
