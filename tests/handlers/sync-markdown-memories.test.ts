import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { DatabaseManager } from '../../src/store/db.js';
import { registerMemoryTool } from '../../src/tools/memory-tool.js';
import {
  registerSyncMarkdownMemoriesCommand,
  syncMarkdownMemoriesToSqlite,
} from '../../src/handlers/sync-markdown-memories.js';
import { ENTRY_DELIMITER } from '../../src/constants.js';
import { getMemories, searchMemories } from '../../src/store/sqlite-memory-store.js';

describe('memory sqlite sync + markdown backfill', () => {
  let tmpDir: string;
  let agentRoot: string;
  let globalDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sync-command-test-'));
    agentRoot = path.join(tmpDir, 'agent');
    globalDir = path.join(agentRoot, 'memory');
    fs.mkdirSync(globalDir, { recursive: true });
    dbManager = new DatabaseManager(globalDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('memory tool writes are immediately searchable in SQLite', async () => {
    let capturedTool: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedTool = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: async () => ({
        success: true,
        target: 'memory',
        entries: ['sync token 2026-05-09'],
        usage: '1% — 20/5000 chars',
        entry_count: 1,
        message: 'Entry added.',
      }),
    } as any;

    registerMemoryTool(mockPi, mockStore, null, dbManager);

    await capturedTool.execute(
      'tc-1',
      { action: 'add', target: 'memory', content: 'sync token 2026-05-09' },
      undefined,
      undefined,
      undefined,
    );

    const results = searchMemories(dbManager, 'sync token 2026-05-09', { target: 'memory' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'sync token 2026-05-09');
  });

  it('backfill command is idempotent across repeated runs', async () => {
    const memoryEntries = [
      'global memory one <!-- created=2026-05-08, last=2026-05-08 -->',
      'global memory two <!-- created=2026-05-08, last=2026-05-09 -->',
    ];
    const userEntries = [
      'name: Chandra <!-- created=2026-05-08, last=2026-05-08 -->',
    ];
    const failureEntries = [
      '[tool-quirk] npm cache stale — Failed: clear .cache/tsx <!-- created=2026-05-08, last=2026-05-09 -->',
    ];

    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), memoryEntries.join(ENTRY_DELIMITER), 'utf-8');
    fs.writeFileSync(path.join(globalDir, 'USER.md'), userEntries.join(ENTRY_DELIMITER), 'utf-8');
    fs.writeFileSync(path.join(globalDir, 'failures.md'), failureEntries.join(ENTRY_DELIMITER), 'utf-8');

    const projectDir = path.join(agentRoot, 'projects-memory', 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'MEMORY.md'),
      'project memory entry <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    let handler: any;
    const mockPi = {
      registerCommand: (_name: string, opts: any) => {
        handler = opts.handler;
      },
    } as unknown as ExtensionAPI;

    const notifications: Array<{ message: string; severity: string }> = [];
    const ctx = {
      ui: {
        notify: (message: string, severity: string) => {
          notifications.push({ message, severity });
        },
      },
    } as any;

    registerSyncMarkdownMemoriesCommand(mockPi, dbManager, globalDir);

    await handler({}, ctx);
    const afterFirst = getMemories(dbManager);

    await handler({}, ctx);
    const afterSecond = getMemories(dbManager);

    assert.strictEqual(afterFirst.length, 5, 'first run should import all unique entries');
    assert.strictEqual(afterSecond.length, 5, 'second run should not create duplicates');

    const projectRows = getMemories(dbManager, { project: 'project-a', target: 'memory' });
    assert.strictEqual(projectRows.length, 1);

    const failureRows = getMemories(dbManager, { target: 'failure', category: 'tool-quirk' });
    assert.strictEqual(failureRows.length, 1);

    assert.ok(
      notifications.some((n) => n.message.includes('SQLite sync complete')),
      'command should report completion',
    );
  });

  it('backfills legacy project memory directories from the old ~/.pi/agent/<project> layout', async () => {
    const legacyProjectDir = path.join(agentRoot, 'legacy-project');
    fs.mkdirSync(legacyProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyProjectDir, 'MEMORY.md'),
      'legacy project entry <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    let handler: any;
    const mockPi = {
      registerCommand: (_name: string, opts: any) => {
        handler = opts.handler;
      },
    } as unknown as ExtensionAPI;

    const ctx = {
      ui: {
        notify: () => {},
      },
    } as any;

    registerSyncMarkdownMemoriesCommand(mockPi, dbManager, globalDir);
    await handler({}, ctx);

    const projectRows = getMemories(dbManager, { project: 'legacy-project', target: 'memory' });
    assert.strictEqual(projectRows.length, 1);
    assert.strictEqual(projectRows[0].content, 'legacy project entry');
  });

  it('makes new-layout project markdown searchable when startup sync runs', () => {
    const projectDir = path.join(agentRoot, 'projects-memory', 'latest-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'MEMORY.md'),
      'latest path searchable entry <!-- created=2026-05-11, last=2026-05-11 -->',
      'utf-8',
    );

    const counters = syncMarkdownMemoriesToSqlite(dbManager, globalDir);

    assert.strictEqual(counters.projectCount, 1);
    assert.strictEqual(counters.imported, 1);

    const results = searchMemories(dbManager, 'latest path searchable entry', {
      project: 'latest-project',
      target: 'memory',
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'latest path searchable entry');
  });
});
