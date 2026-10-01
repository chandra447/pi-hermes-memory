import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexLiveSessionAsync, pruneOldSessions } from '../../src/store/session-indexer.js';
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
  pruneOldSessions(db, 30);
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
  assert.ok(bytes < 64 * 1024, `read ${bytes} bytes for a small append`);
  assert.equal(db.getStats().messages, 2);
});

for (const mode of ['initial', 'resumed', 'partial-tail']) {
  test(`preserves committed progress when a file grows during a real async ${mode} scan`, async t => {
    const { file, db, manager } = fixture(t);
    if (mode === 'resumed') await indexLiveSessionAsync(db, manager);
    fs.appendFileSync(file, JSON.stringify(message('large', 'x'.repeat(8 * 1024 * 1024))) + '\n');
    const committed = fs.statSync(file).size;
    const tail = JSON.stringify(message('tail', 'appended while scanning')) + '\n';
    const partial = mode === 'partial-tail' ? tail.slice(0, -10) : '';
    fs.appendFileSync(file, partial);
    const read = fs.readSync;
    let scheduled = false;
    let appended = false;
    const spy = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
      const n = (read as Function)(...args) as number;
      if (!scheduled && n === 64 * 1024) {
        scheduled = true;
        // Runs only when the actual async scanner yields, not before it starts.
        setImmediate(() => {
          fs.appendFileSync(file, tail.slice(partial.length));
          appended = true;
        });
      }
      return n;
    });
    assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1);
    spy.mock.restore();
    assert.ok(appended, 'append must occur during the asynchronous scan');
    const row = db.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(`session-index-v1:${file}`) as { value: string };
    assert.equal(JSON.parse(row.value).offset, committed);
    assert.equal(JSON.parse(row.value).size, committed);
    const metadata = db.getDb().prepare('SELECT size FROM session_files WHERE path = ?').get(file) as { size: number };
    assert.equal(metadata.size, committed);
    let bytes = 0;
    const resumeSpy = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
      const n = (read as Function)(...args) as number;
      bytes += n;
      return n;
    });
    assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1);
    resumeSpy.mock.restore();
    assert.ok(bytes < 64 * 1024, `resume read ${bytes} bytes instead of just samples and tail`);
    assert.equal(db.getStats().messages, 2);
    assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 0);
  });
}

test('rejects an in-place rewrite plus append during the async scan despite unchanged inode', async t => {
  const { file, db, manager } = fixture(t);
  for (let i = 0; i < 64; i++) fs.appendFileSync(file, JSON.stringify(message(`old-${i}`, 'old content')) + '\n');
  await indexLiveSessionAsync(db, manager);
  fs.appendFileSync(file, JSON.stringify(message('large', 'x'.repeat(8 * 1024 * 1024))) + '\n');
  const ino = fs.statSync(file).ino;
  const read = fs.readSync;
  let scheduled = false;
  let rewritten = false;
  const spy = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const n = (read as Function)(...args) as number;
    if (!scheduled && n === 64 * 1024) {
      scheduled = true;
      setImmediate(() => {
        const position = Buffer.byteLength(JSON.stringify(header) + '\n') + JSON.stringify(message('old-0', 'old content')).indexOf('old content');
        const fd = fs.openSync(file, 'r+');
        try { fs.writeSync(fd, Buffer.from('new content'), 0, 11, position); }
        finally { fs.closeSync(fd); }
        fs.appendFileSync(file, JSON.stringify(message('tail', 'new tail')) + '\n');
        rewritten = true;
      });
    }
    return n;
  });
  assert.equal(await indexLiveSessionAsync(db, manager), null);
  spy.mock.restore();
  assert.ok(rewritten);
  assert.equal(fs.statSync(file).ino, ino);
  assert.equal(db.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(`session-index-v1:${file}`), undefined);
  assert.equal(db.getDb().prepare('SELECT path FROM session_files WHERE path = ?').get(file), undefined);
  assert.equal(db.getStats().messages, 0, 'discard committed stale rows along with the cursor');
  await indexLiveSessionAsync(db, manager);
  assert.equal((db.getDb().prepare('SELECT content FROM messages WHERE id = ?').get('old-0') as { content: string }).content, 'new content');
  assert.equal(db.getStats().messages, 66);
});

test('midpoint fingerprint detects an edit with unchanged head, boundary, size, inode and mtime', async t => {
  const { file, db, manager } = fixture(t);
  fs.appendFileSync(file, JSON.stringify(message('middle', 'x'.repeat(32 * 1024))) + '\n');
  fs.utimesSync(file, 1700000000, 1700000000);
  await indexLiveSessionAsync(db, manager);
  const before = fs.statSync(file);
  const original = fs.readFileSync(file);
  const changed = Buffer.from(original);
  changed[Math.floor(changed.length / 2)] = 'y'.charCodeAt(0);
  fs.writeFileSync(file, changed);
  fs.utimesSync(file, before.atime, before.mtime);
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(changed.subarray(0, 4096), original.subarray(0, 4096));
  assert.deepEqual(changed.subarray(-4096), original.subarray(-4096));
  await indexLiveSessionAsync(db, manager);
  const content = (db.getDb().prepare('SELECT content FROM messages WHERE id = ?').get('middle') as { content: string }).content;
  assert.ok(content.includes('y'), 'middle edit must invalidate the checkpoint and replace the old row');
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

for (const field of ['header-id', 'header-timestamp', 'message-id', 'message-timestamp', 'all']) {
  test(`accepts numeric ${field} and normalizes index fields to strings`, async t => {
    const { file, db, manager } = fixture(t);
    const numeric = (name: string) => field === name || field === 'all';
    const session = { ...header, id: numeric('header-id') ? 42 : header.id, timestamp: numeric('header-timestamp') ? 1700000000000 : header.timestamp };
    const entry = { ...message('numeric', 'numeric searchable text'), id: numeric('message-id') ? 43 : 'numeric', timestamp: numeric('message-timestamp') ? 1700000000001 : header.timestamp };
    fs.writeFileSync(file, [session, entry].map(v => JSON.stringify(v)).join('\n') + '\n');
    const parsed = parseSessionFile(file)!;
    assert.equal(parsed.id, String(session.id));
    assert.equal(parsed.startedAt, String(session.timestamp));
    assert.equal(parsed.messages[0].id, String(entry.id));
    assert.equal(parsed.messages[0].timestamp, String(entry.timestamp));
    assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1);
    const row = db.getDb().prepare('SELECT id, timestamp FROM messages').get();
    assert.deepEqual(row, { id: String(entry.id), timestamp: String(entry.timestamp) });
    assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 0);
  });
}

test('normalizes negative and exponent numbers with JSON numeric semantics', async t => {
  const { file, db, manager } = fixture(t);
  fs.appendFileSync(file, '{"type":"message","id":-4.2e1,"timestamp":1.7e12,"message":{"role":"user","content":"exponent text"}}\n');
  const parsed = parseSessionFile(file)!;
  assert.equal(parsed.messages[0].id, '-42');
  assert.equal(parsed.messages[0].timestamp, '1700000000000');
  assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1);
});

for (const field of ['header-id', 'header-timestamp', 'message-id', 'message-timestamp']) {
  for (const zero of [0, -0, '0']) {
    test(`${field} preserves truthiness of ${typeof zero} ${Object.is(zero, -0) ? '-0' : zero}`, async t => {
      const { file, db, manager } = fixture(t);
      const session = { ...header, ...(field === 'header-id' ? { id: zero } : field === 'header-timestamp' ? { timestamp: zero } : {}) };
      const entry = { ...message('zero', 'zero text'), ...(field === 'message-id' ? { id: zero } : field === 'message-timestamp' ? { timestamp: zero } : {}) };
      // JSON.stringify converts -0 to 0; retain its spelling for the tokenizer.
      fs.writeFileSync(file, [session, entry].map(v => JSON.stringify(v)).join('\n').replace(/:0([,}])/g, Object.is(zero, -0) ? ':-0$1' : ':0$1') + '\n');
      const parsed = parseSessionFile(file);
      if (typeof zero === 'string') assert.equal(parsed?.messages.length, 1);
      else if (field.startsWith('header')) assert.equal(parsed, null);
      else assert.equal(parsed?.messages.length, 0);
      assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed ?? 0, typeof zero === 'string' ? 1 : 0);
    });
  }
}

test('does not interpret numeric content or a nested timestamp as searchable fields', async t => {
  const { file, db, manager } = fixture(t);
  fs.appendFileSync(file, [
    message('number-content', 123),
    message('number-text', [{ type: 'text', text: 456 }]),
    { type: 'message', id: 'nested-time', message: { role: 'user', content: 'ignored', timestamp: 1700000000000 } },
    message('valid', 'still searchable'),
  ].map(v => JSON.stringify(v)).join('\n') + '\n');
  assert.deepEqual(parseSessionFile(file)!.messages.map(m => m.id), ['valid']);
  assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1);
});

test('reindexes after indexed rows were pruned instead of trusting an orphan cursor', async t => {
  const { file, db, manager } = fixture(t);
  fs.appendFileSync(file, JSON.stringify(message('restored', 'retained')) + '\n');
  await indexLiveSessionAsync(db, manager);
  db.getDb().prepare('DELETE FROM messages').run();
  db.getDb().prepare('DELETE FROM sessions').run();
  assert.equal((await indexLiveSessionAsync(db, manager))?.messagesIndexed, 1);
});
