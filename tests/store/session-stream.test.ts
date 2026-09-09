import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexLiveSessionAsync } from '../../src/store/session-indexer.js';
import { parseSessionFile } from '../../src/store/session-parser.js';
import { DEFAULT_MAX_MESSAGE_CONTENT_LENGTH } from '../../src/constants.js';

const header = { type: 'session', id: 'stream-session', cwd: '/test/project', timestamp: '2026-09-08T00:00:00Z' };
const message = (id: string, content: unknown) => ({ type: 'message', id, timestamp: header.timestamp, message: { role: 'user', content } });

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-stream-'));
  const file = path.join(dir, 'session.jsonl');
  const db = new DatabaseManager(path.join(dir, 'db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const manager = { getSessionFile: () => file, getHeader: () => header, getEntries: () => [] };
  fs.writeFileSync(file, JSON.stringify(header) + '\n');
  return { file, db, manager };
}

test('streams a giant media record without dropping adjacent searchable text and yields to timers', async t => {
  const { file, db, manager } = fixture(t);
  fs.appendFileSync(file, '{"type":"message","id":"media","timestamp":"now","message":{"role":"user","content":[{"type":"image","data":"');
  const chunk = 'a'.repeat(1024 * 1024);
  for (let i = 0; i < 32; i++) fs.appendFileSync(file, chunk);
  fs.appendFileSync(file, '"},{"text":"searchable after media","type":"text"}]}}\n');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try { assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'a large scan must let other work run');
  const row = db.getDb().prepare('SELECT content FROM messages WHERE id = ?').get('media') as { content: string };
  assert.equal(row.content, 'searchable after media');
});

test('bounds oversized text while retaining both ends and correctly decoding split UTF-8', t => {
  const { file } = fixture(t);
  const text = 'start-' + '\u00e9'.repeat(200000) + '-end';
  fs.appendFileSync(file, JSON.stringify(message('text', [{ text, type: 'text' }])) + '\n');
  const parsed = parseSessionFile(file)!;
  assert.equal(parsed.messages.length, 1);
  assert.ok(parsed.messages[0].content.length <= DEFAULT_MAX_MESSAGE_CONTENT_LENGTH);
  assert.ok(parsed.messages[0].content.startsWith('start-'));
  assert.ok(parsed.messages[0].content.endsWith('-end'));
  assert.ok(!parsed.messages[0].content.includes('\ufffd'));
});

test('appended messages use a bounded checkpoint read, not a whole-history rescan', async t => {
  const { file, db, manager } = fixture(t);
  fs.appendFileSync(file, JSON.stringify(message('first', 'x'.repeat(2 * 1024 * 1024))) + '\n');
  await indexLiveSessionAsync(db, manager);
  fs.appendFileSync(file, JSON.stringify(message('second', 'new text')) + '\n');
  let bytes = 0;
  const read = fs.readSync;
  // Account for both checkpoint fingerprint reads and the appended JSONL read.
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const n = (read as Function)(...args) as number;
    bytes += n;
    return n;
  }) as typeof fs.readSync;
  try { assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1); }
  finally { fs.readSync = read; }
  assert.ok(bytes < 32 * 1024, `read ${bytes} bytes for a small append`);
  assert.equal(db.getStats().messages, 2);
});

test('retries a partially written trailing record and skips malformed completed lines', async t => {
  const { file, db, manager } = fixture(t);
  const line = JSON.stringify(message('partial', 'eventually complete'));
  fs.appendFileSync(file, '{bad}\n' + line.slice(0, -5));
  assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 0);
  fs.appendFileSync(file, line.slice(-5) + '\n');
  assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1);
  assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 0);
});

test('detects truncation and replacement and rebuilds searchable rows', async t => {
  const { file, db, manager } = fixture(t);
  fs.appendFileSync(file, JSON.stringify(message('old', 'old '.repeat(100))) + '\n');
  await indexLiveSessionAsync(db, manager);
  fs.writeFileSync(file, JSON.stringify(header) + '\n' + JSON.stringify(message('new', 'new')) + '\n');
  await indexLiveSessionAsync(db, manager);
  assert.equal(db.getStats().messages, 1);
  assert.ok(db.getDb().prepare('SELECT id FROM messages WHERE id = ?').get('new'));
  const replacement = file + '.replacement';
  fs.writeFileSync(replacement, JSON.stringify(header) + '\n' + JSON.stringify(message('replaced', 'replacement')) + '\n');
  fs.renameSync(replacement, file);
  await indexLiveSessionAsync(db, manager);
  assert.equal(db.getStats().messages, 1);
  assert.ok(db.getDb().prepare('SELECT id FROM messages WHERE id = ?').get('replaced'));
});

test('reindexes after indexed rows were pruned instead of trusting an orphan cursor', async t => {
  const { file, db, manager } = fixture(t);
  fs.appendFileSync(file, JSON.stringify(message('restored', 'retained')) + '\n');
  await indexLiveSessionAsync(db, manager);
  db.getDb().prepare('DELETE FROM messages').run();
  db.getDb().prepare('DELETE FROM sessions').run();
  assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1);
});
