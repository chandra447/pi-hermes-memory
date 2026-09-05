import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSessionFile, getSessionFiles, isSessionFile, decodeProjectDir } from '../../src/store/session-parser.js';

describe('session-parser', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-parser-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseSessionFile', () => {
    it('should parse a valid session JSONL file', () => {
      const filePath = path.join(tmpDir, 'test-session.jsonl');
      const lines = [
        JSON.stringify({
          type: 'session',
          id: 'session-123',
          timestamp: '2026-05-03T00:00:00Z',
          cwd: '/Users/test/Documents/my-project',
        }),
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Hello, how are you?' }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'msg-2',
          parentId: 'msg-1',
          timestamp: '2026-05-03T00:01:30Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'The user said hello' },
              { type: 'text', text: 'I am doing well, thank you!' },
            ],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = parseSessionFile(filePath);
      assert.ok(result);
      assert.strictEqual(result.id, 'session-123');
      assert.strictEqual(result.project, 'my-project');
      assert.strictEqual(result.cwd, '/Users/test/Documents/my-project');
      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(result.messages[0].role, 'user');
      assert.strictEqual(result.messages[0].content, 'Hello, how are you?');
      assert.strictEqual(result.messages[1].role, 'assistant');
      assert.strictEqual(result.messages[1].content, 'I am doing well, thank you!');
    });

    it('should skip thinking blocks in assistant messages', () => {
      const filePath = path.join(tmpDir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Internal reasoning...' },
              { type: 'text', text: 'Actual response' },
            ],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = parseSessionFile(filePath);
      assert.ok(result);
      assert.strictEqual(result.messages[0].content, 'Actual response');
    });

    it('should extract tool call names from assistant messages', () => {
      const filePath = path.join(tmpDir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check...' },
              { type: 'tool_use', name: 'read', input: {} },
              { type: 'tool_use', name: 'bash', input: {} },
            ],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = parseSessionFile(filePath);
      assert.ok(result);
      assert.deepStrictEqual(result.messages[0].toolCalls, ['read', 'bash']);
    });

    it('should skip empty messages', () => {
      const filePath = path.join(tmpDir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [], timestamp: Date.now() },
        }),
        JSON.stringify({
          type: 'message',
          id: 'msg-2',
          parentId: null,
          timestamp: '2026-05-03T00:02:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = parseSessionFile(filePath);
      assert.ok(result);
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].content, 'Hello');
    });

    it('should skip non-message entry types', () => {
      const filePath = path.join(tmpDir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({ type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-05-03T00:00:01Z' }),
        JSON.stringify({ type: 'thinking_level_change', id: 'tl1', parentId: null, timestamp: '2026-05-03T00:00:02Z' }),
        JSON.stringify({ type: 'custom', id: 'c1', parentId: null, timestamp: '2026-05-03T00:00:03Z' }),
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = parseSessionFile(filePath);
      assert.ok(result);
      assert.strictEqual(result.messages.length, 1);
    });

    it('should handle malformed JSONL lines gracefully', () => {
      const filePath = path.join(tmpDir, 'test.jsonl');
      const content = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        'not valid json',
        '',
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(filePath, content.join('\n'));

      const result = parseSessionFile(filePath);
      assert.ok(result);
      assert.strictEqual(result.messages.length, 1);
    });

    it('should return null for empty file', () => {
      const filePath = path.join(tmpDir, 'empty.jsonl');
      fs.writeFileSync(filePath, '');

      const result = parseSessionFile(filePath);
      assert.strictEqual(result, null);
    });

    it('should return null if no session entry found', () => {
      const filePath = path.join(tmpDir, 'no-session.jsonl');
      fs.writeFileSync(filePath, JSON.stringify({ type: 'message', id: 'm1' }));

      const result = parseSessionFile(filePath);
      assert.strictEqual(result, null);
    });

    it('should skip tool_result content while retaining assistant text', () => {
      const filePath = path.join(tmpDir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I inspected the file.' },
              {
                type: 'tool_result',
                content: [{ type: 'text', text: 'large file contents must not be indexed' }],
              },
            ],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = parseSessionFile(filePath);
      assert.ok(result);
      assert.strictEqual(result.messages[0].content, 'I inspected the file.');
    });
  });

  describe('getSessionFiles', () => {
    it('should return empty array if directory does not exist', () => {
      const result = getSessionFiles('/nonexistent/path');
      assert.deepStrictEqual(result, []);
    });

    it('should find all JSONL files across projects', () => {
      // Create project directories with JSONL files
      const proj1 = path.join(tmpDir, 'project-a');
      const proj2 = path.join(tmpDir, 'project-b');
      fs.mkdirSync(proj1);
      fs.mkdirSync(proj2);
      fs.writeFileSync(path.join(proj1, 'session1.jsonl'), '{}');
      fs.writeFileSync(path.join(proj1, 'session2.jsonl'), '{}');
      fs.writeFileSync(path.join(proj2, 'session3.jsonl'), '{}');
      fs.writeFileSync(path.join(proj1, 'not-jsonl.txt'), '{}');

      const result = getSessionFiles(tmpDir);
      assert.strictEqual(result.length, 3);
    });

    it('should filter by project directory if specified', () => {
      const proj1 = path.join(tmpDir, 'project-a');
      const proj2 = path.join(tmpDir, 'project-b');
      fs.mkdirSync(proj1);
      fs.mkdirSync(proj2);
      fs.writeFileSync(path.join(proj1, 'session1.jsonl'), '{}');
      fs.writeFileSync(path.join(proj2, 'session2.jsonl'), '{}');

      const result = getSessionFiles(tmpDir, 'project-a');
      assert.strictEqual(result.length, 1);
      assert.ok(result[0].includes('session1.jsonl'));
    });
  });

  describe('decodeProjectDir', () => {
    it('should decode project name from directory format', () => {
      assert.strictEqual(decodeProjectDir('--Users-chandrateja-Documents-pi-hermes-memory--'), 'memory');
    });

    it('should handle simple directory names', () => {
      assert.strictEqual(decodeProjectDir('my-project'), 'project');
    });
  });
});


describe('isSessionFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-session-file-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a file whose first line is a session header', () => {
    const filePath = path.join(tmpDir, 'real.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
      JSON.stringify({ type: 'message', id: 'm1' }),
    ].join('\n'));
    assert.strictEqual(isSessionFile(filePath), true);
  });

  it('rejects non-session JSONL (extension artifacts)', () => {
    const filePath = path.join(tmpDir, 'artifact.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ type: 'transcript', events: [] }) + '\n');
    assert.strictEqual(isSessionFile(filePath), false);
  });

  it('rejects empty files and files without a parseable first line', () => {
    const empty = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    assert.strictEqual(isSessionFile(empty), false);
    const garbage = path.join(tmpDir, 'garbage.jsonl');
    fs.writeFileSync(garbage, 'not json at all\n');
    assert.strictEqual(isSessionFile(garbage), false);
    const blank = path.join(tmpDir, 'blank.jsonl');
    fs.writeFileSync(blank, '\n\n' + JSON.stringify({ type: 'session' }));
    assert.strictEqual(isSessionFile(blank), false);
  });

  it('rejects JSON first lines that are not objects or not session-typed', () => {
    const arr = path.join(tmpDir, 'arr.jsonl');
    fs.writeFileSync(arr, '[1,2,3]\n');
    assert.strictEqual(isSessionFile(arr), false);
    const nul = path.join(tmpDir, 'nul.jsonl');
    fs.writeFileSync(nul, 'null\n');
    assert.strictEqual(isSessionFile(nul), false);
  });
});

describe('getSessionFiles excludeDirs', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exclude-dirs-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function touchSessionFile(dir: string, name: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ type: 'session', id: name, timestamp: '2026-05-03T00:00:00Z', cwd: '/t' }) + '\n');
  }

  it('skips first-level directories matched exactly', () => {
    const root = path.join(tmpDir, 'sessions');
    touchSessionFile(path.join(root, 'keep'), 'a.jsonl');
    touchSessionFile(path.join(root, 'drop'), 'b.jsonl');
    const files = getSessionFiles(root, undefined, ['drop']);
    assert.ok(files.every(f => !f.includes(`${path.sep}drop${path.sep}`)));
    assert.strictEqual(files.length, 1);
  });

  it('supports * globs and does not match nested levels', () => {
    const root = path.join(tmpDir, 'sessions');
    touchSessionFile(path.join(root, 'artifacts-x'), 'a.jsonl');
    touchSessionFile(path.join(root, 'project-a'), 'b.jsonl');
    const files = getSessionFiles(root, undefined, ['artifacts-*']);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].includes('project-a'));
  });

  it('an explicit projectDir is never filtered by excludeDirs', () => {
    const root = path.join(tmpDir, 'sessions');
    touchSessionFile(path.join(root, 'drop'), 'a.jsonl');
    const files = getSessionFiles(root, 'drop', ['drop']);
    assert.strictEqual(files.length, 1);
  });
});
