import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { DatabaseManager } from '../../src/store/db.js';
import { searchSessionAnchors } from '../../src/store/session-anchor-search.js';
import { indexChangedSessions, needsBackfill, parseSessionManagerSnapshot, touchBackfillTimestamp } from '../../src/store/session-indexer.js';
import { parseSessionFile } from '../../src/store/session-parser.js';

describe('Pi custom user input', () => {
  const timestamp = '2026-11-11T00:00:00.000Z';
  const header = { type: 'session', id: 'session', cwd: '/example', timestamp };
  const input = {
    type: 'custom_message', id: 'input', timestamp, customType: 'example.input', display: false,
    content: [{ type: 'text', text: 'nativeinput' }, { type: 'image', data: 'imagepayload', mimeType: 'image/png' }],
    details: { source: 'privatemetadata' },
  };
  const entries = [
    { type: 'message', id: 'plain', timestamp, message: { role: 'user', content: 'ordinary' } },
    input,
    { ...input, id: 'background', customType: 'example.background', content: 'background', details: {} },
    { ...input, id: 'data', type: 'custom', content: 'state', details: {} },
  ];
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-input-'));
    file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, [header, ...entries].map(entry => JSON.stringify(entry)).join('\n'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('projects the same user text from disk and live snapshots', () => {
    const types = ['example.input'];
    const snapshot = { getHeader: () => header, getEntries: () => entries };
    const session = parseSessionFile(file, types);
    assert.deepEqual(session, parseSessionManagerSnapshot(snapshot, types));
    assert.deepEqual(session?.messages.map(({ id, role, content }) => [id, role, content]), [
      ['plain', 'user', 'ordinary'], ['input', 'user', 'nativeinput'],
    ]);
    assert.deepEqual(parseSessionFile(file)?.messages.map(m => m.id), ['plain']);
    const search = (term: string) => searchSessionAnchors('any:\n- ' + term, { sessionsDir: dir, userMessageCustomTypes: types });
    assert.equal(search('nativeinput').ranges.length, 1);
    assert.equal(search('privatemetadata').ranges.length, 0);
    assert.equal(search('imagepayload').ranges.length, 0);
  });

  it('upgrades existing indexes without invalidating the default projection', () => {
    const legacy = new DatabaseManager(dir);
    try {
      indexChangedSessions(legacy, dir);
      touchBackfillTimestamp(legacy);
      legacy.getDb().exec('ALTER TABLE messages DROP COLUMN custom_type');
      legacy.getDb().exec('ALTER TABLE session_files DROP COLUMN projection');
    } finally {
      legacy.close();
    }
    const upgraded = new DatabaseManager(dir);
    try {
      assert.equal(needsBackfill(upgraded, dir), false);
      assert.deepEqual(upgraded.getDb().prepare('SELECT id, custom_type FROM messages').all(),
        [{ id: 'plain', custom_type: null }]);
    } finally {
      upgraded.close();
    }
  });

  it('reconciles unchanged files and FTS when a type is enabled, removed and enabled again', () => {
    const configPath = path.join(dir, 'config.json');
    assert.deepEqual(loadConfig(configPath).userMessageCustomTypes, []);
    for (const [step, enabled] of [false, true, false, true].entries()) {
      fs.writeFileSync(configPath, JSON.stringify({ userMessageCustomTypes: enabled ? ['example.input', 'example.input'] : [] }));
      const db = new DatabaseManager(dir, { userMessageCustomTypes: loadConfig(configPath).userMessageCustomTypes });
      try {
        assert.equal(needsBackfill(db, dir), true);
        const result = indexChangedSessions(db, dir);
        assert.deepEqual(result.errors, []);
        assert.equal(result.sessionsIndexed, 1, 'policy change at step ' + step);
        touchBackfillTimestamp(db);
        assert.equal(needsBackfill(db, dir), false);
        const matches = (word: string) => db.getDb().prepare('SELECT rowid FROM message_fts WHERE message_fts MATCH ?').all(word).length;
        assert.equal(matches('ordinary'), 1);
        assert.equal(matches('nativeinput'), enabled ? 1 : 0);
        assert.equal(matches('background'), 0);
      } finally {
        db.close();
      }
    }
  });
});
